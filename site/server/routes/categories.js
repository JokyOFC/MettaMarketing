// Material categories (slice H). Everyone signed in reads the active ones;
// admins (categories.manage) create, rename, move between areas, reorder and
// archive. System categories keep their area and are never archived, because
// other slices reach them by slug.
import { Router } from "express";
import { logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { forbidden, notFound, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { can } from "../lib/permissions.js";
import { serializeCategory } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { parse, queryBool, schemas, z } from "../lib/validate.js";

export const AREAS = ["identity", "content", "other"];
const AREA_ORDER = { identity: 0, content: 1, other: 2 };
const AREA_LABELS = { identity: "Identidade visual", content: "Conteúdo", other: "Materiais" };

// Folder names become ZIP folders: no path separators or reserved characters.
const folderSchema = z
  .string()
  .trim()
  .min(1, "Informe o nome da pasta.")
  .max(80)
  .refine((value) => !/[\\/:*?"<>|]/.test(value), 'Use um nome de pasta sem / \\ : * ? " < > |.')
  .refine((value) => !/^\.+$/.test(value), "Use um nome de pasta válido.");

const createSchema = z.object({
  name: schemas.text(80),
  area: z.enum(AREAS),
  folder: folderSchema.optional().nullable(),
});

const patchSchema = z.object({
  name: schemas.text(80).optional(),
  area: z.enum(AREAS).optional(),
  folder: folderSchema.optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  archived: z.boolean().optional(),
});

const reorderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });

export function slugify(text) {
  return (
    String(text ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "categoria"
  );
}

async function uniqueSlug(db, base) {
  let slug = base;
  for (let n = 2; await db.get("SELECT 1 AS yes FROM categories WHERE slug = ?", [slug]); n += 1) slug = `${base.slice(0, 56)}-${n}`;
  return slug;
}

export default function categoriesRoutes(ctx) {
  const router = Router();
  const { db } = ctx;
  const canManage = requireCap("categories.manage");

  const counts = async () =>
    new Map(
      (await db
        .all("SELECT category_id, COUNT(*) AS n FROM materials WHERE archived_at IS NULL GROUP BY category_id"))
        .map((row) => [row.category_id, row.n]),
    );

  // Admin view adds how many active materials use each category.
  function serialize(req, row, materialCounts) {
    const category = serializeCategory(row);
    if (materialCounts) category.materialCount = materialCounts.get(row.id) ?? 0;
    return category;
  }

  async function assertCategory(id) {
    const row = typeof id === "string" ? await db.get("SELECT * FROM categories WHERE id = ?", [id]) : null;
    if (!row) throw notFound();
    return row;
  }

  async function nameTaken(name, exceptId = null) {
    return Boolean(
      await db.get("SELECT 1 AS yes FROM categories WHERE name = ? COLLATE utf8mb4_0900_as_ci AND archived_at IS NULL AND NOT (id <=> ?)", [name, exceptId]),
    );
  }

  // ?area=identity&archived=1 (archived only for staff) -> { items, total }
  router.get("/api/categories", requireAuth, async (req, res) => {
    const where = [];
    const params = [];
    const staff = req.user.role !== "client";
    if (!(staff && queryBool(req.query.archived))) where.push("archived_at IS NULL");
    if (AREAS.includes(req.query.area)) {
      where.push("area = ?");
      params.push(req.query.area);
    }
    const rows = await db.all(
      `SELECT * FROM categories ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY CASE area WHEN 'identity' THEN 0 WHEN 'content' THEN 1 ELSE 2 END, sort_order, name`,
      params,
    );
    const materialCounts = can(req.user, "categories.manage") ? await counts() : null;
    res.json({ items: rows.map((row) => serialize(req, row, materialCounts)), total: rows.length });
  });

  router.post("/api/categories", requireAuth, canManage, async (req, res) => {
    const input = parse(createSchema, req.body);
    if (await nameTaken(input.name)) throw validation({ name: "Já existe uma categoria ativa com este nome." });
    const folder = input.folder ?? input.name.replace(/[\\/:*?"<>|]/g, "-");
    const id = newId("cat");
    const at = now();
    await db.tx(async () => {
      const slug = await uniqueSlug(db, slugify(input.name));
      const last = (await db.get("SELECT MAX(sort_order) AS n FROM categories WHERE area = ?", [input.area])).n;
      const sortOrder = (last ?? (await db.get("SELECT MAX(sort_order) AS n FROM categories")).n ?? 0) + 10;
      await db.run(
        `INSERT INTO categories (id, slug, name, area, folder, sort_order, is_system, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [id, slug, input.name, input.area, folder, sortOrder, req.user.id, at, at],
      );
      await logActivity(req, {
        action: "category.created",
        entityType: "category",
        entityId: id,
        summary: `Categoria "${input.name}" criada em ${AREA_LABELS[input.area]}.`,
      });
    });
    res.status(201).json({ category: serialize(req, await db.get("SELECT * FROM categories WHERE id = ?", [id]), await counts()) });
  });

  // Sets sort_order following `ids`; categories left out keep their relative
  // order after the listed ones of the same area.
  router.post("/api/categories/reorder", requireAuth, canManage, async (req, res) => {
    const { ids } = parse(reorderSchema, req.body);
    const all = await db.all("SELECT id, area, sort_order, name FROM categories ORDER BY sort_order, name");
    const known = new Set(all.map((row) => row.id));
    const unknown = ids.find((id) => !known.has(id));
    if (unknown) throw validation({ ids: "A lista contém uma categoria que não existe mais. Atualize a página." });
    const listed = [...new Set(ids)];
    const rest = all.filter((row) => !listed.includes(row.id)).map((row) => row.id);
    const byId = new Map(all.map((row) => [row.id, row]));
    const ordered = [...listed, ...rest].sort((a, b) => AREA_ORDER[byId.get(a).area] - AREA_ORDER[byId.get(b).area]);
    const at = now();
    await db.tx(async () => {
      for (const [index, id] of ordered.entries()) {
        const sortOrder = (index + 1) * 10;
        await db.run("UPDATE categories SET sort_order = ?, updated_at = ? WHERE id = ? AND NOT (sort_order <=> ?)", [sortOrder, at, id, sortOrder]);
      }
      await logActivity(req, { action: "category.reordered", entityType: "category", summary: "Ordem das categorias atualizada." });
    });
    const rows = await db.all(
      `SELECT * FROM categories WHERE archived_at IS NULL OR ? ORDER BY CASE area WHEN 'identity' THEN 0 WHEN 'content' THEN 1 ELSE 2 END, sort_order, name`,
      [queryBool(req.query.archived)],
    );
    const materialCounts = await counts();
    res.json({ items: rows.map((row) => serialize(req, row, materialCounts)), total: rows.length });
  });

  router.patch("/api/categories/:id", requireAuth, canManage, async (req, res) => {
    const row = await assertCategory(req.params.id);
    const input = parse(patchSchema, req.body);
    const system = row.is_system === 1;
    if (system && input.area !== undefined && input.area !== row.area)
      throw forbidden("Categorias do sistema não podem mudar de área.");
    if (system && input.archived === true) throw forbidden("Categorias do sistema não podem ser arquivadas.");
    if (input.name !== undefined && input.name.toLowerCase() !== row.name.toLowerCase() && await nameTaken(input.name, row.id))
      throw validation({ name: "Já existe uma categoria ativa com este nome." });
    if (input.archived === false && row.archived_at && await nameTaken(input.name ?? row.name, row.id))
      throw validation({ name: "Já existe uma categoria ativa com este nome. Renomeie antes de restaurar." });

    const sets = [];
    const params = [];
    const notes = [];
    const set = (column, value) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (input.name !== undefined && input.name !== row.name) {
      set("name", input.name);
      notes.push(`renomeada para "${input.name}"`);
    }
    if (input.folder !== undefined && input.folder !== row.folder) {
      set("folder", input.folder);
      notes.push(`pasta "${input.folder}"`);
    }
    if (input.area !== undefined && input.area !== row.area) {
      set("area", input.area);
      notes.push(`movida para ${AREA_LABELS[input.area]}`);
    }
    if (input.sortOrder !== undefined && input.sortOrder !== row.sort_order) set("sort_order", input.sortOrder);
    if (input.archived === true && !row.archived_at) {
      set("archived_at", now());
      notes.push("arquivada");
    }
    if (input.archived === false && row.archived_at) {
      set("archived_at", null);
      notes.push("restaurada");
    }
    if (sets.length) {
      await db.tx(async () => {
        await db.run(`UPDATE categories SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, now(), row.id]);
        await logActivity(req, {
          action: input.archived === true ? "category.archived" : input.archived === false ? "category.restored" : "category.updated",
          entityType: "category",
          entityId: row.id,
          summary: `Categoria "${row.name}"${notes.length ? ` ${notes.join(", ")}` : " atualizada"}.`,
        });
      });
    }
    res.json({ category: serialize(req, await db.get("SELECT * FROM categories WHERE id = ?", [row.id]), await counts()) });
  });

  return router;
}

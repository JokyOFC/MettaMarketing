// Kits and delivery packages: CRUD, ordered items and release (reusing the
// release engine for the items not yet released). Clients see released kits
// with the items they can see.
import { Router } from "express";
import { assertBrand, assertMaterial, assertProject, scopeSql } from "../lib/access.js";
import { logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { conflict, HttpError, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { can } from "../lib/permissions.js";
import { isStaff } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { parse, schemas, z } from "../lib/validate.js";
import {
  assertKit,
  canWriteKit,
  KIT_SELECT,
  kitMaterialRows,
  previewRelease,
  releaseMaterials,
  serializeMaterials,
} from "../services/materials.js";

const KINDS = ["brand_kit", "project_package", "custom"];
const KIND_LABELS = { brand_kit: "kit de marca", project_package: "pacote de projeto", custom: "kit" };
const id = z.string().trim().min(1).max(64);

const createSchema = z.object({
  brandId: id,
  projectId: id.nullable().optional(),
  name: schemas.text(120),
  description: schemas.optionalText(2000),
  kind: z.enum(KINDS).default("custom"),
  materialIds: z.array(id).max(1000).default([]),
});
const patchSchema = z.object({
  name: schemas.text(120).optional(),
  description: schemas.optionalText(2000),
  kind: z.enum(KINDS).optional(),
  projectId: id.nullable().optional(),
  status: z.enum(["draft", "archived"]).optional(),
});
const itemsSchema = z.object({ materialIds: z.array(id).max(1000) });
const releaseSchema = z.object({
  downloadEnabled: z.union([z.boolean(), z.record(z.string(), z.boolean()), z.null()]).optional(),
  notifyEmail: z.boolean().default(false),
  notifyApp: z.boolean().default(true),
  message: schemas.optionalText(2000),
});

const FORMAT_ORDER = ["SVG", "PNG", "JPG", "WEBP", "PDF", "EPS", "AI", "MP4", "MOV", "WEBM"];
const sortFormats = (set) =>
  [...set].sort((a, b) => {
    const ia = FORMAT_ORDER.indexOf(a);
    const ib = FORMAT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

const quote = (text) => `“${text}”`;

export default function kitsRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  async function serializeKit(req, row, materials, { withItems = false } = {}) {
    const staff = isStaff(req);
    const kit = {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      kind: row.kind,
      status: row.status,
      brand: { id: row.brand_id, name: row.brand_name, slug: row.brand_slug, clientId: row.client_id },
      client: { id: row.client_id, name: row.client_name },
      project: row.project_id ? { id: row.project_id, name: row.project_name ?? null } : null,
      releasedAt: row.released_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      itemCount: materials.length,
      materialIds: materials.map((m) => m.id),
      fileCount: materials.reduce((sum, m) => sum + (m.fileCount ?? 0), 0),
      totalBytes: materials.reduce((sum, m) => sum + (m.totalBytes ?? 0), 0),
      formats: sortFormats(new Set(materials.flatMap((m) => m.formats ?? []))),
      cover: materials.find((m) => m.thumb?.url)?.thumb ?? null,
    };
    if (withItems) kit.items = materials;
    if (staff) {
      const writable = await canWriteKit(req, row);
      kit.unreleasedCount = materials.filter((m) => !m.releasedVersionId || m.releasedVersionId !== m.currentVersionId).length;
      kit.permissions = {
        canEdit: writable && can(req.user, "materials.edit"),
        canRelease: writable && can(req.user, "materials.release"),
      };
    }
    return kit;
  }

  const kitMaterials = async (req, kitId) =>
    await serializeMaterials(req, await kitMaterialRows(req, kitId, { includeArchived: isStaff(req) }));

  const loadKit = async (kitId) => await db.get(`${KIT_SELECT} WHERE k.id = ?`, [kitId]);

  // Materials for a kit: in scope, same brand, active; out-of-scope ids -> 422.
  async function checkItems(req, brandId, materialIds) {
    const unique = [...new Set(materialIds)];
    const fields = {};
    for (const [index, materialId] of unique.entries()) {
      try {
        const row = await assertMaterial(req, materialId);
        if (row.brand_id !== brandId) fields[`materialIds.${index}`] = "Este material é de outra marca.";
        else if (row.archived_at) fields[`materialIds.${index}`] = "Este material está arquivado.";
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 404) throw err;
        fields[`materialIds.${index}`] = "Material não encontrado.";
      }
    }
    if (Object.keys(fields).length) throw validation(fields, "Revise os materiais do kit.");
    return unique;
  }

  async function writeItems(kitId, materialIds) {
    await db.run("DELETE FROM kit_items WHERE kit_id = ?", [kitId]);
    for (const [index, materialId] of materialIds.entries())
      await db.run("INSERT INTO kit_items (kit_id, material_id, sort_order) VALUES (?, ?, ?)", [kitId, materialId, (index + 1) * 10]);
  }

  router.get("/api/kits", requireAuth, requireCap("materials.view", "portal.access"), async (req, res) => {
    const staff = isStaff(req);
    const scope = scopeSql.brands(req, "b");
    const where = [scope.sql];
    const params = [...scope.params];
    const filter = (key, column) => {
      const value = typeof req.query[key] === "string" ? req.query[key].trim() : "";
      if (!value) return;
      where.push(`${column} = ?`);
      params.push(value);
    };
    filter("brandId", "k.brand_id");
    filter("clientId", "b.client_id");
    filter("projectId", "k.project_id");
    filter("kind", "k.kind");
    if (staff) {
      if (typeof req.query.status === "string" && req.query.status) filter("status", "k.status");
      else where.push("k.status != 'archived'");
    } else {
      where.push("k.status = 'released'");
    }
    const rows = await db.all(`${KIT_SELECT} WHERE ${where.join(" AND ")} ORDER BY k.updated_at DESC, k.id`, params);
    const items = (await Promise.all(rows.map(async (row) => await serializeKit(req, row, await kitMaterials(req, row.id))))).filter(
      (kit) => staff || kit.itemCount > 0,
    );
    res.json({ items, total: items.length });
  });

  router.post("/api/kits", requireAuth, requireCap("materials.edit"), async (req, res) => {
    const body = parse(createSchema, req.body);
    const brand = await assertBrand(req, body.brandId);
    if (brand.status !== "active") throw validation({ brandId: "Esta marca está arquivada." });
    let project = null;
    if (body.projectId) {
      try {
        project = await assertProject(req, body.projectId);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) throw validation({ projectId: "Projeto não encontrado." });
        throw err;
      }
      if (project.brand_id !== brand.id) throw validation({ projectId: "O projeto precisa ser da mesma marca." });
    }
    const materialIds = await checkItems(req, brand.id, body.materialIds);
    const kitId = newId("kit");
    const at = now();
    await db.tx(async () => {
      await db.run(
        `INSERT INTO kits (id, brand_id, project_id, name, description, kind, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [kitId, brand.id, project?.id ?? null, body.name, body.description ?? null, body.kind, req.user.id, at, at],
      );
      await writeItems(kitId, materialIds);
      await logActivity(req, {
        action: "kit.created",
        entityType: "kit",
        entityId: kitId,
        brandId: brand.id,
        clientId: brand.client_id,
        projectId: project?.id ?? null,
        summary: `${req.user.name} montou o ${KIND_LABELS[body.kind]} ${quote(body.name)} com ${materialIds.length} ${materialIds.length === 1 ? "material" : "materiais"}.`,
        data: { materialIds },
      });
    });
    res.status(201).json({ kit: await serializeKit(req, await loadKit(kitId), await kitMaterials(req, kitId), { withItems: true }) });
  });

  router.get("/api/kits/:id", requireAuth, requireCap("materials.view", "portal.access"), async (req, res) => {
    const kit = await assertKit(req, req.params.id);
    res.json({ kit: await serializeKit(req, kit, await kitMaterials(req, kit.id), { withItems: true }) });
  });

  router.patch("/api/kits/:id", requireAuth, requireCap("materials.edit"), async (req, res) => {
    const kit = await assertKit(req, req.params.id, { write: true });
    const body = parse(patchSchema, req.body);
    const sets = [];
    const params = [];
    const set = (column, value) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (body.name !== undefined) set("name", body.name);
    if (body.description !== undefined) set("description", body.description);
    if (body.kind !== undefined) set("kind", body.kind);
    if (body.projectId !== undefined) {
      if (body.projectId === null) set("project_id", null);
      else {
        let project;
        try {
          project = await assertProject(req, body.projectId);
        } catch (err) {
          if (err instanceof HttpError && err.status === 404) throw validation({ projectId: "Projeto não encontrado." });
          throw err;
        }
        if (project.brand_id !== kit.brand_id) throw validation({ projectId: "O projeto precisa ser da mesma marca." });
        set("project_id", project.id);
      }
    }
    if (body.status !== undefined && body.status !== kit.status) {
      if (body.status === "draft" && kit.status !== "archived")
        throw conflict("Para voltar um kit liberado a rascunho, arquive-o primeiro.");
      set("status", body.status);
    }
    if (sets.length) {
      await db.tx(async () => {
        await db.run(`UPDATE kits SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, now(), kit.id]);
        await logActivity(req, {
          action: body.status === "archived" ? "kit.archived" : "kit.updated",
          entityType: "kit",
          entityId: kit.id,
          brandId: kit.brand_id,
          clientId: kit.client_id,
          summary:
            body.status === "archived"
              ? `${req.user.name} arquivou o kit ${quote(kit.name)}.`
              : `${req.user.name} editou o kit ${quote(body.name ?? kit.name)}.`,
          data: { fields: Object.keys(body).filter((key) => body[key] !== undefined) },
        });
      });
    }
    res.json({ kit: await serializeKit(req, await loadKit(kit.id), await kitMaterials(req, kit.id), { withItems: true }) });
  });

  router.delete("/api/kits/:id", requireAuth, requireCap("materials.edit"), async (req, res) => {
    const kit = await assertKit(req, req.params.id, { write: true });
    if (kit.status === "released")
      throw conflict("Kits liberados ficam no histórico do cliente. Arquive o kit em vez de excluir.");
    await db.tx(async () => {
      await db.run("DELETE FROM kits WHERE id = ?", [kit.id]);
      await logActivity(req, {
        action: "kit.deleted",
        entityType: "kit",
        entityId: kit.id,
        brandId: kit.brand_id,
        clientId: kit.client_id,
        summary: `${req.user.name} excluiu o kit ${quote(kit.name)}.`,
      });
    });
    res.status(204).end();
  });

  router.put("/api/kits/:id/items", requireAuth, requireCap("materials.edit"), async (req, res) => {
    const kit = await assertKit(req, req.params.id, { write: true });
    if (kit.status === "archived") throw conflict("Kit arquivado. Restaure-o para editar os itens.");
    const { materialIds } = parse(itemsSchema, req.body);
    const ids = await checkItems(req, kit.brand_id, materialIds);
    await db.tx(async () => {
      await writeItems(kit.id, ids);
      await db.run("UPDATE kits SET updated_at = ? WHERE id = ?", [now(), kit.id]);
      await logActivity(req, {
        action: "kit.items_updated",
        entityType: "kit",
        entityId: kit.id,
        brandId: kit.brand_id,
        clientId: kit.client_id,
        summary: `${req.user.name} atualizou os itens do kit ${quote(kit.name)} (${ids.length}).`,
        data: { materialIds: ids },
      });
    });
    res.json({ kit: await serializeKit(req, await loadKit(kit.id), await kitMaterials(req, kit.id), { withItems: true }) });
  });

  router.post("/api/kits/:id/release/preview", requireAuth, requireCap("materials.release"), async (req, res) => {
    res.json(await previewRelease(req, { kitId: req.params.id }));
  });

  router.post("/api/kits/:id/release", requireAuth, requireCap("materials.release"), async (req, res) => {
    const kit = await assertKit(req, req.params.id, { write: true });
    if (kit.status === "archived") throw conflict("Kit arquivado. Restaure-o antes de liberar.");
    const body = parse(releaseSchema, req.body ?? {});
    const result = await releaseMaterials(req, { ...body, kitId: kit.id });
    res.status(201).json({ ...result, kit: await serializeKit(req, await loadKit(kit.id), await kitMaterials(req, kit.id), { withItems: true }) });
  });

  return router;
}

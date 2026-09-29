// Brand library (docs/API.md "Biblioteca da marca"): the identity workspace of
// a brand — logos by variant, palette, typography, manual, identity sections,
// editables and kits — plus the colour/font/guideline editors and the identity
// release. Clients only ever receive released content.
import { Router } from "express";
import {
  assertBrand,
  assertMaterial,
  clientCanSeeFile,
  clientCanSeeMaterial,
  clientMaterialFilter,
} from "../lib/access.js";
import { logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { forbidden, notFound, validation } from "../lib/errors.js";
import { guidelineDraft, releaseGuidelines, saveGuidelineDraft } from "../lib/guidelines.js";
import { newId } from "../lib/ids.js";
import { clientUserIds, notify } from "../lib/notify.js";
import { can } from "../lib/permissions.js";
import { isStaff, serializeBrand, serializeCategory } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { parse, schemas, z } from "../lib/validate.js";
import { listMaterials, loadRenditions, serializeFile, sortFiles } from "../services/materials.js";

export const LOGO_VARIANTS = ["principal", "secundaria", "simbolo", "clara", "escura", "monocromatica"];
const FORMAT_ORDER = ["SVG", "PNG", "JPG", "WEBP", "PDF", "EPS", "AI", "MP4", "MOV", "WEBM"];

const EDIT_CAPS = ["brands.edit", "materials.edit"];
const placeholders = (list) => list.map(() => "?").join(", ");

// ------------------------------------------------------------------ schemas

const optionalText = (max) => schemas.optionalText(max);

const colorFields = {
  name: z.string().trim().min(1, "Dê um nome à cor.").max(80, "Use no máximo 80 caracteres."),
  hex: schemas.hex,
  rgb: optionalText(60),
  cmyk: optionalText(60),
  pantone: optionalText(60),
  role: optionalText(60),
  usage: optionalText(1000),
};
const colorCreate = z.object(colorFields);
const colorPatch = z.object({
  ...Object.fromEntries(Object.entries(colorFields).map(([key, schema]) => [key, schema.optional()])),
  visibility: z.enum(["draft", "released"]).optional(),
});

const weights = z
  .union([
    z.string().trim().max(200, "Use no máximo 200 caracteres."),
    z.array(z.string().trim().min(1).max(40)).max(20),
    z.null(),
  ])
  .optional()
  .transform((value) => {
    if (Array.isArray(value)) return value.join(", ") || null;
    return value === "" ? null : value;
  });
const sourceUrl = z
  .union([schemas.url, z.literal(""), z.null()])
  .optional()
  .transform((value) => (value === "" ? null : value));
const materialRef = z
  .union([z.string().trim().max(64), z.null()])
  .optional()
  .transform((value) => (value === "" ? null : value));
const distribution = z.enum(["allowed", "reference_only"]);

const fontCreate = z.object({
  family: z.string().trim().min(1, "Informe a família tipográfica.").max(120, "Use no máximo 120 caracteres."),
  role: optionalText(80),
  weights,
  usage: optionalText(1000),
  sourceUrl,
  license: optionalText(4000),
  distribution: distribution.optional(),
  materialId: materialRef,
});
const fontPatch = z.object({
  family: z
    .string()
    .trim()
    .min(1, "Informe a família tipográfica.")
    .max(120, "Use no máximo 120 caracteres.")
    .optional(),
  role: optionalText(80),
  weights,
  usage: optionalText(1000),
  sourceUrl,
  license: optionalText(4000),
  distribution: distribution.optional(),
  materialId: materialRef,
  visibility: z.enum(["draft", "released"]).optional(),
});

const reorderSchema = z.object({ ids: schemas.ids.min(1, "Envie a nova ordem.") });

const releaseSchema = z.object({
  colorIds: schemas.ids.optional(),
  fontIds: schemas.ids.optional(),
  guidelines: z.boolean().optional(),
  notify: z.boolean().optional(),
  notifyEmail: z.boolean().optional(),
  message: optionalText(1000),
});

const guidelinesSchema = z.object({
  usageGuidelines: optionalText(20000),
  typographyGuidelines: optionalText(20000),
});

// ------------------------------------------------------------ serializers

export function serializeColor(req, row) {
  const color = {
    id: row.id,
    brandId: row.brand_id,
    name: row.name,
    hex: row.hex,
    rgb: row.rgb ?? null,
    cmyk: row.cmyk ?? null,
    pantone: row.pantone ?? null,
    role: row.role ?? null,
    usage: row.usage ?? null,
    sortOrder: row.sort_order,
  };
  if (isStaff(req)) {
    color.visibility = row.visibility;
    color.createdAt = row.created_at;
    color.updatedAt = row.updated_at;
  }
  return color;
}

// Font files: staff always see the linked material's current files; clients
// only when the licence allows distribution and the material is released.
function fontFiles(req, rows) {
  const db = req.ctx.db;
  const staff = isStaff(req);
  const materialIds = [...new Set(rows.map((row) => row.material_id).filter(Boolean))];
  const materials = new Map();
  if (materialIds.length) {
    for (const m of db.all(
      `SELECT m.*, b.client_id AS client_id FROM materials m JOIN brands b ON b.id = m.brand_id
        WHERE m.id IN (${placeholders(materialIds)})`,
      materialIds,
    ))
      materials.set(m.id, m);
  }
  const versionOf = (material) =>
    staff ? material.current_version_id ?? material.released_version_id : material.released_version_id;

  const visible = new Map(); // fontId -> { material, files: rows }
  const versionIds = [];
  for (const row of rows) {
    const material = row.material_id ? materials.get(row.material_id) : null;
    if (!material || material.brand_id !== row.brand_id) continue;
    if (!staff && (!clientCanSeeMaterial(req.user, material) || row.distribution !== "allowed")) continue;
    if (staff && material.archived_at) continue;
    const versionId = versionOf(material);
    if (!versionId) continue;
    versionIds.push(versionId);
    visible.set(row.id, { material, versionId });
  }
  const filesByVersion = new Map();
  if (versionIds.length) {
    const unique = [...new Set(versionIds)];
    for (const file of db.all(
      `SELECT * FROM material_files WHERE version_id IN (${placeholders(unique)}) AND role != 'cover'`,
      unique,
    )) {
      if (!filesByVersion.has(file.version_id)) filesByVersion.set(file.version_id, []);
      filesByVersion.get(file.version_id).push(file);
    }
  }
  const allFiles = [...filesByVersion.values()].flat();
  const renditions = loadRenditions(db, allFiles.map((file) => file.id));
  const out = new Map();
  for (const [fontId, { material, versionId }] of visible) {
    let files = filesByVersion.get(versionId) ?? [];
    if (!staff) files = files.filter((file) => clientCanSeeFile(file, material));
    out.set(fontId, {
      material: { id: material.id, title: material.title, ...(staff ? { visibility: material.visibility } : {}) },
      files: sortFiles(files).map((file) => serializeFile(req, file, material, renditions.get(file.id) ?? {})),
    });
  }
  return out;
}

export function serializeFonts(req, rows) {
  const staff = isStaff(req);
  const linked = fontFiles(req, rows);
  return rows.map((row) => {
    const link = linked.get(row.id);
    const font = {
      id: row.id,
      brandId: row.brand_id,
      family: row.family,
      role: row.role ?? null,
      weights: row.weights ?? null,
      usage: row.usage ?? null,
      sourceUrl: row.source_url ?? null,
      license: row.license ?? null,
      distribution: row.distribution,
      sortOrder: row.sort_order,
      materialId: link?.material.id ?? (staff ? row.material_id ?? null : null),
      material: link?.material ?? null,
      files: link?.files ?? [],
    };
    if (staff) {
      font.visibility = row.visibility;
      font.createdAt = row.created_at;
      font.updatedAt = row.updated_at;
    }
    return font;
  });
}

// ------------------------------------------------------------------ helpers

function loadColors(req, brandId) {
  const client = !isStaff(req);
  return req.ctx.db.all(
    `SELECT * FROM brand_colors WHERE brand_id = ? ${client ? "AND visibility = 'released'" : ""}
      ORDER BY sort_order, created_at, id`,
    [brandId],
  );
}

function loadFonts(req, brandId) {
  const client = !isStaff(req);
  return req.ctx.db.all(
    `SELECT * FROM brand_fonts WHERE brand_id = ? ${client ? "AND visibility = 'released'" : ""}
      ORDER BY sort_order, created_at, id`,
    [brandId],
  );
}

// Kits of the brand. Clients: released kits with at least one visible item.
function loadKits(req, brandId) {
  const db = req.ctx.db;
  if (isStaff(req)) {
    return db
      .all(
        `SELECT k.*, (SELECT COUNT(*) FROM kit_items ki WHERE ki.kit_id = k.id) AS item_count
           FROM kits k WHERE k.brand_id = ? AND k.status != 'archived'
          ORDER BY k.kind = 'brand_kit' DESC, k.updated_at DESC`,
        [brandId],
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        status: row.status,
        projectId: row.project_id ?? null,
        itemCount: row.item_count,
        releasedAt: row.released_at ?? null,
        updatedAt: row.updated_at,
      }));
  }
  return db
    .all(
      `SELECT k.*, (SELECT COUNT(*) FROM kit_items ki JOIN materials m ON m.id = ki.material_id
                      WHERE ki.kit_id = k.id AND ${clientMaterialFilter("m")}) AS item_count
         FROM kits k WHERE k.brand_id = ? AND k.status = 'released'
        ORDER BY k.kind = 'brand_kit' DESC, k.released_at DESC`,
      [brandId],
    )
    .filter((row) => row.item_count > 0)
    .map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      projectId: row.project_id ?? null,
      itemCount: row.item_count,
      releasedAt: row.released_at ?? null,
    }));
}

const sortFormats = (formats) =>
  [...formats].sort((a, b) => {
    const ia = FORMAT_ORDER.indexOf(a);
    const ib = FORMAT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

const byPrimaryThenOrder = (a, b) =>
  Number(b.isPrimary) - Number(a.isPrimary) ||
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
  String(a.createdAt).localeCompare(String(b.createdAt));

// Brand for a read (clients never see archived brands).
function readableBrand(req, id) {
  const brand = assertBrand(req, id);
  if (!isStaff(req) && brand.status !== "active") throw notFound();
  return brand;
}

// Brand for identity writes: needs an editing capability and the brand in scope.
function writableBrand(req, id) {
  const brand = assertBrand(req, id);
  if (!EDIT_CAPS.some((cap) => can(req.user, cap))) throw forbidden();
  return brand;
}

// Released colours/fonts are visible to the client: removing them, hiding
// them again, changing what the client reads (name, codes, family, links,
// licence, linked files) needs the release capability (PLATFORM.md §2 rule 7).
function assertReleaseCap(req, message) {
  if (!can(req.user, "materials.release")) throw forbidden(message);
}

// Client-visible fields of released colours and fonts (input key -> column).
const COLOR_CLIENT_FIELDS = { name: "name", hex: "hex", rgb: "rgb", cmyk: "cmyk", pantone: "pantone", role: "role", usage: "usage" };
const FONT_CLIENT_FIELDS = {
  family: "family",
  role: "role",
  weights: "weights",
  usage: "usage",
  sourceUrl: "source_url",
  license: "license",
  materialId: "material_id",
};

// Keys of `input` whose value differs from the row.
const changedKeys = (input, row, columns) =>
  Object.entries(columns)
    .filter(([key, column]) => input[key] !== undefined && (input[key] ?? null) !== (row[column] ?? null))
    .map(([key]) => key);

// Linked font material: same brand, readable by the viewer.
function assertFontMaterial(req, brand, materialId) {
  if (!materialId) return null;
  let material;
  try {
    material = assertMaterial(req, materialId);
  } catch {
    throw validation({ materialId: "Escolha um material desta marca." });
  }
  if (material.brand_id !== brand.id) throw validation({ materialId: "Escolha um material desta marca." });
  return material;
}

/**
 * font_distributable of a material's font files follows the RELEASED brand
 * fonts linked to it: 1 when a released linked font allows distribution, else
 * 0. A draft font never makes files downloadable: the licence reaches the
 * client only through the identity release (materials.release). New files get
 * the same rule from the material_files_font_licence trigger (migration 010).
 */
export function syncFontDistribution(db, materialId) {
  if (!materialId) return;
  const allowed = db.get(
    "SELECT 1 AS ok FROM brand_fonts WHERE material_id = ? AND distribution = 'allowed' AND visibility = 'released' LIMIT 1",
    [materialId],
  )
    ? 1
    : 0;
  db.run("UPDATE material_files SET font_distributable = ? WHERE material_id = ? AND media_kind = 'font'", [
    allowed,
    materialId,
  ]);
}

function colorOr404(req, id) {
  const row = id ? req.ctx.db.get("SELECT * FROM brand_colors WHERE id = ?", [id]) : null;
  if (!row) throw notFound("Não encontramos esta cor.");
  const brand = writableBrand(req, row.brand_id);
  return { row, brand };
}

function fontOr404(req, id) {
  const row = id ? req.ctx.db.get("SELECT * FROM brand_fonts WHERE id = ?", [id]) : null;
  if (!row) throw notFound("Não encontramos esta tipografia.");
  const brand = writableBrand(req, row.brand_id);
  return { row, brand };
}

const touch = (db, brandId, at) => db.run("UPDATE brands SET updated_at = ? WHERE id = ?", [at, brandId]);

const brandRow = (db, id) =>
  db.get("SELECT b.*, c.name AS client_name FROM brands b JOIN clients c ON c.id = b.client_id WHERE b.id = ?", [id]);

const listText = (items) => {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
};

// ------------------------------------------------------------------ router

export default function brandlibRoutes() {
  const router = Router();

  // ---------------------------------------------------------------- library
  router.get("/api/brands/:id/library", requireAuth, requireCap("materials.view", "portal.access"), (req, res) => {
    const db = req.ctx.db;
    const staff = isStaff(req);
    const brand = readableBrand(req, req.params.id);

    const { items } = listMaterials(req, { brandId: brand.id, area: "identity" });
    const logos = Object.fromEntries([...LOGO_VARIANTS, "outros"].map((key) => [key, []]));
    const manual = [];
    const identity = [];
    const sectionMap = new Map();
    for (const material of items) {
      const slug = material.category.slug;
      if (slug === "logotipo") logos[LOGO_VARIANTS.includes(material.variant) ? material.variant : "outros"].push(material);
      else if (slug === "manual-da-marca") manual.push(material);
      else identity.push(material);
      if (!sectionMap.has(material.category.id)) sectionMap.set(material.category.id, { category: material.category, materials: [] });
      sectionMap.get(material.category.id).materials.push(material);
    }
    for (const key of Object.keys(logos)) logos[key].sort(byPrimaryThenOrder);
    const sections = [...sectionMap.values()].sort(
      (a, b) => (a.category.sortOrder ?? 0) - (b.category.sortOrder ?? 0) || a.category.name.localeCompare(b.category.name),
    );

    // Editable files in the visible version of each identity material.
    const editableVersions = items
      .filter((material) => material.version?.id && (staff || material.editableIncluded))
      .map((material) => material.version.id);
    let editables = { count: 0, materialCount: 0 };
    if (editableVersions.length) {
      const row = db.get(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT material_id) AS m FROM material_files
          WHERE role = 'editable' AND version_id IN (${placeholders(editableVersions)})`,
        editableVersions,
      );
      editables = { count: row.n, materialCount: row.m };
    }

    const formats = new Set();
    let files = 0;
    for (const material of items) {
      files += material.fileCount ?? 0;
      for (const format of material.formats ?? []) formats.add(format);
    }

    const categories = db
      .all("SELECT * FROM categories WHERE area = 'identity' AND archived_at IS NULL ORDER BY sort_order, name")
      .map(serializeCategory);

    res.json({
      brand: serializeBrand(req, brand),
      logos,
      colors: loadColors(req, brand.id).map((row) => serializeColor(req, row)),
      fonts: serializeFonts(req, loadFonts(req, brand.id)),
      manual,
      identity,
      sections,
      editables,
      kits: loadKits(req, brand.id),
      counts: { files, materials: items.length, formats: sortFormats(formats) },
      categories,
    });
  });

  // ---------------------------------------------------------------- colours
  router.post("/api/brands/:id/colors", requireAuth, requireCap(...EDIT_CAPS), (req, res) => {
    const db = req.ctx.db;
    const brand = writableBrand(req, req.params.id);
    const input = parse(colorCreate, req.body);
    const id = newId("col");
    const at = now();
    db.tx(() => {
      const next = (db.get("SELECT MAX(sort_order) AS n FROM brand_colors WHERE brand_id = ?", [brand.id])?.n ?? 0) + 10;
      db.run(
        `INSERT INTO brand_colors (id, brand_id, name, hex, rgb, cmyk, pantone, role, usage, sort_order, visibility,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [id, brand.id, input.name, input.hex, input.rgb ?? null, input.cmyk ?? null, input.pantone ?? null, input.role ?? null, input.usage ?? null, next, req.user.id, at, at],
      );
      touch(db, brand.id, at);
      logActivity(req, {
        action: "brand.color_created",
        entityType: "brand_color",
        entityId: id,
        brandId: brand.id,
        clientId: brand.client_id,
        summary: `${req.user.name} adicionou a cor “${input.name}” (${input.hex}) à paleta de ${brand.name}.`,
        data: { hex: input.hex },
      });
    });
    res.status(201).json({ color: serializeColor(req, db.get("SELECT * FROM brand_colors WHERE id = ?", [id])) });
  });

  router.patch("/api/colors/:id", requireAuth, requireCap(...EDIT_CAPS), (req, res) => {
    const db = req.ctx.db;
    const { row, brand } = colorOr404(req, req.params.id);
    const input = parse(colorPatch, req.body);
    if (input.visibility && input.visibility !== row.visibility)
      assertReleaseCap(req, "Somente gestores liberam ou ocultam cores para o cliente.");
    if (row.visibility === "released" && changedKeys(input, row, COLOR_CLIENT_FIELDS).length)
      assertReleaseCap(req, "Esta cor já está visível ao cliente. Peça a um gestor para alterá-la.");
    const columns = { name: "name", hex: "hex", rgb: "rgb", cmyk: "cmyk", pantone: "pantone", role: "role", usage: "usage", visibility: "visibility" };
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(columns)) {
      if (input[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(input[key]);
    }
    if (sets.length) {
      const at = now();
      db.tx(() => {
        db.run(`UPDATE brand_colors SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, at, row.id]);
        touch(db, brand.id, at);
        const hidden = input.visibility === "draft" && row.visibility === "released";
        logActivity(req, {
          action: hidden ? "brand.color_hidden" : "brand.color_updated",
          entityType: "brand_color",
          entityId: row.id,
          brandId: brand.id,
          clientId: brand.client_id,
          summary: hidden
            ? `${req.user.name} ocultou do cliente a cor “${input.name ?? row.name}”.`
            : `${req.user.name} atualizou a cor “${input.name ?? row.name}”.`,
          data: { fields: Object.keys(input).filter((key) => input[key] !== undefined) },
        });
      });
    }
    res.json({ color: serializeColor(req, db.get("SELECT * FROM brand_colors WHERE id = ?", [row.id])) });
  });

  router.delete("/api/colors/:id", requireAuth, requireCap(...EDIT_CAPS), (req, res) => {
    const db = req.ctx.db;
    const { row, brand } = colorOr404(req, req.params.id);
    if (row.visibility === "released")
      assertReleaseCap(req, "Esta cor já está visível ao cliente. Peça a um gestor para removê-la.");
    const at = now();
    db.tx(() => {
      db.run("DELETE FROM brand_colors WHERE id = ?", [row.id]);
      touch(db, brand.id, at);
      logActivity(req, {
        action: "brand.color_deleted",
        entityType: "brand_color",
        entityId: row.id,
        brandId: brand.id,
        clientId: brand.client_id,
        summary: `${req.user.name} removeu a cor “${row.name}” (${row.hex}) da paleta de ${brand.name}.`,
        data: { hex: row.hex, wasReleased: row.visibility === "released" },
      });
    });
    res.status(204).end();
  });

  router.post("/api/brands/:id/colors/reorder", requireAuth, requireCap(...EDIT_CAPS), (req, res) => {
    const db = req.ctx.db;
    const brand = writableBrand(req, req.params.id);
    const { ids } = parse(reorderSchema, req.body);
    const existing = db.all("SELECT id FROM brand_colors WHERE brand_id = ? ORDER BY sort_order, created_at, id", [brand.id]).map((r) => r.id);
    const known = new Set(existing);
    const wanted = [...new Set(ids)];
    if (wanted.some((id) => !known.has(id))) throw validation({ ids: "Algumas cores não pertencem a esta marca." });
    const order = [...wanted, ...existing.filter((id) => !wanted.includes(id))];
    const at = now();
    db.tx(() => {
      order.forEach((id, index) => db.run("UPDATE brand_colors SET sort_order = ?, updated_at = ? WHERE id = ?", [(index + 1) * 10, at, id]));
      touch(db, brand.id, at);
      logActivity(req, {
        action: "brand.colors_reordered",
        entityType: "brand",
        entityId: brand.id,
        brandId: brand.id,
        clientId: brand.client_id,
        summary: `${req.user.name} reorganizou a paleta de ${brand.name}.`,
      });
    });
    res.json({ items: loadColors(req, brand.id).map((row) => serializeColor(req, row)) });
  });

  // ---------------------------------------------------------------- fonts
  router.post("/api/brands/:id/fonts", requireAuth, requireCap(...EDIT_CAPS), (req, res) => {
    const db = req.ctx.db;
    const brand = writableBrand(req, req.params.id);
    const input = parse(fontCreate, req.body);
    const material = assertFontMaterial(req, brand, input.materialId);
    const id = newId("fnt");
    const at = now();
    db.tx(() => {
      const next = (db.get("SELECT MAX(sort_order) AS n FROM brand_fonts WHERE brand_id = ?", [brand.id])?.n ?? 0) + 10;
      db.run(
        `INSERT INTO brand_fonts (id, brand_id, family, role, weights, usage, source_url, license, distribution, material_id,
           sort_order, visibility, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [
          id,
          brand.id,
          input.family,
          input.role ?? null,
          input.weights ?? null,
          input.usage ?? null,
          input.sourceUrl ?? null,
          input.license ?? null,
          input.distribution ?? "reference_only",
          material?.id ?? null,
          next,
          req.user.id,
          at,
          at,
        ],
      );
      if (material) syncFontDistribution(db, material.id);
      touch(db, brand.id, at);
      logActivity(req, {
        action: "brand.font_created",
        entityType: "brand_font",
        entityId: id,
        brandId: brand.id,
        clientId: brand.client_id,
        materialId: material?.id ?? null,
        summary: `${req.user.name} adicionou a tipografia “${input.family}” a ${brand.name}.`,
        data: { distribution: input.distribution ?? "reference_only" },
      });
    });
    const [font] = serializeFonts(req, [db.get("SELECT * FROM brand_fonts WHERE id = ?", [id])]);
    res.status(201).json({ font });
  });

  router.patch("/api/fonts/:id", requireAuth, requireCap(...EDIT_CAPS), (req, res) => {
    const db = req.ctx.db;
    const { row, brand } = fontOr404(req, req.params.id);
    const input = parse(fontPatch, req.body);
    if (input.visibility && input.visibility !== row.visibility)
      assertReleaseCap(req, "Somente gestores liberam ou ocultam tipografias para o cliente.");
    if (input.distribution && input.distribution !== row.distribution && row.visibility === "released")
      assertReleaseCap(req, "Esta tipografia já está visível ao cliente. Peça a um gestor para mudar a licença.");
    if (row.visibility === "released" && changedKeys(input, row, FONT_CLIENT_FIELDS).length)
      assertReleaseCap(req, "Esta tipografia já está visível ao cliente. Peça a um gestor para alterá-la.");
    let material = null;
    if (input.materialId !== undefined && input.materialId !== row.material_id) material = assertFontMaterial(req, brand, input.materialId);

    const columns = {
      family: "family",
      role: "role",
      weights: "weights",
      usage: "usage",
      sourceUrl: "source_url",
      license: "license",
      distribution: "distribution",
      materialId: "material_id",
      visibility: "visibility",
    };
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(columns)) {
      if (input[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(key === "materialId" ? material?.id ?? null : input[key]);
    }
    if (sets.length) {
      const at = now();
      db.tx(() => {
        db.run(`UPDATE brand_fonts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, at, row.id]);
        const touched = new Set([row.material_id, input.materialId === undefined ? row.material_id : material?.id].filter(Boolean));
        for (const materialId of touched) syncFontDistribution(db, materialId);
        touch(db, brand.id, at);
        const licence = input.distribution && input.distribution !== row.distribution;
        const family = input.family ?? row.family;
        logActivity(req, {
          action: licence ? "brand.font_distribution" : "brand.font_updated",
          entityType: "brand_font",
          entityId: row.id,
          brandId: brand.id,
          clientId: brand.client_id,
          summary: licence
            ? `${req.user.name} marcou a tipografia “${family}” como ${input.distribution === "allowed" ? "distribuição permitida" : "somente referência"}.`
            : `${req.user.name} atualizou a tipografia “${family}”.`,
          data: { fields: Object.keys(input).filter((key) => input[key] !== undefined), distribution: input.distribution ?? row.distribution },
        });
      });
    }
    const [font] = serializeFonts(req, [db.get("SELECT * FROM brand_fonts WHERE id = ?", [row.id])]);
    res.json({ font });
  });

  router.delete("/api/fonts/:id", requireAuth, requireCap(...EDIT_CAPS), (req, res) => {
    const db = req.ctx.db;
    const { row, brand } = fontOr404(req, req.params.id);
    if (row.visibility === "released")
      assertReleaseCap(req, "Esta tipografia já está visível ao cliente. Peça a um gestor para removê-la.");
    const at = now();
    db.tx(() => {
      db.run("DELETE FROM brand_fonts WHERE id = ?", [row.id]);
      syncFontDistribution(db, row.material_id);
      touch(db, brand.id, at);
      logActivity(req, {
        action: "brand.font_deleted",
        entityType: "brand_font",
        entityId: row.id,
        brandId: brand.id,
        clientId: brand.client_id,
        summary: `${req.user.name} removeu a tipografia “${row.family}” de ${brand.name}.`,
        data: { wasReleased: row.visibility === "released" },
      });
    });
    res.status(204).end();
  });

  // ---------------------------------------------------------------- release
  router.post("/api/brands/:id/identity/release", requireAuth, requireCap("materials.release"), (req, res) => {
    const db = req.ctx.db;
    const brand = assertBrand(req, req.params.id);
    if (brand.status !== "active") throw validation({ brandId: "Esta marca está arquivada." });
    const input = parse(releaseSchema, req.body);

    const pick = (table, ids) => {
      if (ids === undefined)
        return db.all(`SELECT * FROM ${table} WHERE brand_id = ? AND visibility = 'draft' ORDER BY sort_order`, [brand.id]);
      const unique = [...new Set(ids)];
      if (!unique.length) return [];
      const rows = db.all(`SELECT * FROM ${table} WHERE brand_id = ? AND id IN (${placeholders(unique)})`, [brand.id, ...unique]);
      if (rows.length !== unique.length) return null;
      return rows.filter((row) => row.visibility === "draft");
    };
    const colors = pick("brand_colors", input.colorIds);
    if (!colors) throw validation({ colorIds: "Algumas cores não pertencem a esta marca." });
    const fonts = pick("brand_fonts", input.fontIds);
    if (!fonts) throw validation({ fontIds: "Algumas tipografias não pertencem a esta marca." });
    // Guidelines: only a draft that differs from the released text counts.
    // Omitted = release it when there is one (like colorIds/fontIds).
    const draft = guidelineDraft(brand);
    const guidelines = input.guidelines !== false && draft.pending;
    if (!colors.length && !fonts.length && !guidelines)
      throw validation({ _: "Não há cores, tipografias ou orientações novas para liberar." }, "Nada novo para liberar.");

    const parts = [];
    if (colors.length) parts.push(colors.length === 1 ? "1 cor" : `${colors.length} cores`);
    if (fonts.length) parts.push(fonts.length === 1 ? "1 tipografia" : `${fonts.length} tipografias`);
    if (guidelines)
      parts.push(
        draft.changed.usage && draft.changed.typography
          ? "as orientações de uso e de tipografia"
          : draft.changed.usage
            ? "as orientações de uso"
            : "as orientações de tipografia",
      );
    const what = listText(parts);
    const at = now();
    const recipients = clientUserIds(db, brand.client_id);
    const notifyApp = input.notify !== false;
    const notifyEmail = Boolean(input.notifyEmail);

    db.tx(() => {
      for (const row of colors)
        db.run("UPDATE brand_colors SET visibility = 'released', updated_at = ? WHERE id = ?", [at, row.id]);
      for (const row of fonts)
        db.run("UPDATE brand_fonts SET visibility = 'released', updated_at = ? WHERE id = ?", [at, row.id]);
      // the licence of a released font now applies to its linked files
      for (const materialId of new Set(fonts.map((row) => row.material_id).filter(Boolean))) syncFontDistribution(db, materialId);
      if (guidelines) releaseGuidelines(db, brand, { userId: req.user.id, at });
      touch(db, brand.id, at);
      logActivity(req, {
        action: "brand.identity_released",
        entityType: "brand",
        entityId: brand.id,
        brandId: brand.id,
        clientId: brand.client_id,
        summary: `A equipe Metta liberou ${what} da marca ${brand.name}.`,
        data: {
          colorIds: colors.map((row) => row.id),
          fontIds: fonts.map((row) => row.id),
          guidelines,
          guidelineFields: guidelines ? Object.keys(draft.changed).filter((key) => draft.changed[key]) : [],
          notifyApp,
          notifyEmail,
          recipients: recipients.length,
        },
        visibility: "client",
      });
      if (notifyApp || notifyEmail) {
        const lines = [
          ...colors.map((row) => `Cor ${row.name} (${row.hex})`),
          ...fonts.map((row) => `Tipografia ${row.family}`),
          ...(guidelines && draft.changed.usage ? ["Orientações de uso da marca"] : []),
          ...(guidelines && draft.changed.typography ? ["Orientações de tipografia"] : []),
        ];
        const ids = notify(req, recipients, {
          type: "identity_released",
          title: `Identidade visual atualizada: ${brand.name}`,
          body: input.message || `A equipe Metta liberou ${what} em Minha marca.`,
          link: "/painel/marca",
          entityType: "brand",
          entityId: brand.id,
          email: notifyEmail,
          emailLines: lines.slice(0, 12),
          actionLabel: "Abrir Minha marca",
        });
        // e-mail only: drop the in-app copies when the team unchecked them
        if (!notifyApp && ids.length) db.run(`DELETE FROM notifications WHERE id IN (${placeholders(ids)})`, ids);
      }
    });

    res.json({
      released: { colors: colors.length, fonts: fonts.length, guidelines },
      // people actually told (in the app or by e-mail); 0 when both were unchecked
      recipients: notifyApp || notifyEmail ? recipients.length : 0,
      brand: serializeBrand(req, brandRow(db, brand.id)),
      colors: loadColors(req, brand.id).map((row) => serializeColor(req, row)),
      fonts: serializeFonts(req, loadFonts(req, brand.id)),
    });
  });

  // ---------------------------------------------------------------- guidelines
  // Saves the team's DRAFT only (designers included). The client keeps the
  // released text until the identity release (materials.release) publishes it.
  router.patch("/api/brands/:id/guidelines", requireAuth, requireCap(...EDIT_CAPS), (req, res) => {
    const db = req.ctx.db;
    const brand = writableBrand(req, req.params.id);
    const input = parse(guidelinesSchema, req.body);
    const at = now();
    db.tx(() => {
      const saved = saveGuidelineDraft(
        db,
        brand,
        { usage: input.usageGuidelines, typography: input.typographyGuidelines },
        { userId: req.user.id, at },
      );
      if (!saved.changed) return;
      logActivity(req, {
        action: "brand.guidelines_updated",
        entityType: "brand",
        entityId: brand.id,
        brandId: brand.id,
        clientId: brand.client_id,
        summary: saved.pending
          ? `${req.user.name} atualizou o rascunho das orientações de ${brand.name}.`
          : `${req.user.name} descartou as alterações não liberadas nas orientações de ${brand.name}.`,
        data: { fields: saved.fields, draft: saved.pending },
      });
    });
    res.json({ brand: serializeBrand(req, brandRow(db, brand.id)) });
  });

  return router;
}


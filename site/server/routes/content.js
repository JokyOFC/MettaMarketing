// Content hub (docs/API.md "Conteúdo e revisão"): posts are materials with
// kind = 'post' plus a post_details row. Publication is always marked by hand
// by the team; nothing here ever flips a post to "published" on its own.
import { Router } from "express";
import { assertBrand, assertMaterial, assertProject, clientMaterialFilter, scopeSql } from "../lib/access.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { logActivity } from "../lib/audit.js";
import { conflict, forbidden, notFound, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { clientUserIds, notify } from "../lib/notify.js";
import { can } from "../lib/permissions.js";
import { isStaff } from "../lib/serialize.js";
import { isValidDate, now } from "../lib/time.js";
import { parse, schemas, z } from "../lib/validate.js";
import { assertAssignableOwner, createMaterial, getMaterialDetail, listMaterials } from "../services/materials.js";

export const NETWORKS = ["instagram", "facebook", "linkedin", "tiktok", "youtube", "x", "pinterest", "whatsapp", "outro"];
export const POST_FORMATS = ["estatico", "carrossel", "stories", "reels", "video", "outro"];
const PUBLICATION = ["not_scheduled", "scheduled", "published"];

// Default category by post format (docs/API.md).
const DEFAULT_CATEGORY = {
  estatico: "posts-carrosseis",
  carrossel: "posts-carrosseis",
  outro: "posts-carrosseis",
  stories: "stories",
  reels: "reels-videos",
  video: "reels-videos",
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const optionalTime = z
  .union([z.string().trim(), z.null()])
  .optional()
  .refine((value) => value == null || value === "" || TIME.test(value), "Use o formato HH:MM.")
  .transform((value) => (value === "" ? null : value));
const optionalId = z
  .union([z.string().trim().max(64), z.null()])
  .optional()
  .transform((value) => (value === "" ? null : value));
const isoDateTime = z
  .union([z.string().trim(), z.null()])
  .optional()
  .refine((value) => value == null || value === "" || !Number.isNaN(Date.parse(value)), "Use uma data e hora válidas.")
  .transform((value) => (value ? new Date(value).toISOString() : null));

const fileItem = z.object({
  uploadId: z.string().trim().min(1).max(64),
  role: z.enum(["original", "final", "editable", "cover"]).optional(),
  position: z.number().int().min(1).max(500).optional(),
});

const network = z.enum(NETWORKS, { error: "Escolha a rede social." });
const format = z.enum(POST_FORMATS, { error: "Escolha o formato." });

const createSchema = z.object({
  brandId: z.string({ error: "Escolha a marca." }).trim().min(1, "Escolha a marca."),
  projectId: optionalId,
  categoryId: optionalId,
  title: schemas.text(200),
  network,
  format,
  plannedDate: schemas.optionalDate,
  plannedTime: optionalTime,
  campaignId: optionalId,
  caption: schemas.optionalText(5000),
  hashtags: schemas.optionalText(2000),
  notes: schemas.optionalText(4000),
  internalNotes: schemas.optionalText(4000),
  description: schemas.optionalText(2000),
  ownerId: optionalId,
  files: z.array(fileItem).max(60).default([]),
});

const patchSchema = z.object({
  title: schemas.text(200).optional(),
  network: network.optional(),
  format: format.optional(),
  plannedDate: schemas.optionalDate,
  plannedTime: optionalTime,
  campaignId: optionalId,
  ownerId: optionalId,
  internalNotes: schemas.optionalText(4000),
  description: schemas.optionalText(2000),
  caption: schemas.optionalText(5000),
  hashtags: schemas.optionalText(2000),
  notes: schemas.optionalText(4000),
});

const publicationSchema = z.object({
  status: z.enum(PUBLICATION, { error: "Escolha a situação da publicação." }),
  scheduledAt: isoDateTime,
  publishedAt: isoDateTime,
  publishedUrl: z
    .union([z.string().trim(), z.null()])
    .optional()
    .transform((value) => (value ? value : null))
    .pipe(z.union([z.null(), z.url({ protocol: /^https?$/ }).max(2000)])),
  confirm: z.boolean().optional(),
});

const bulkPublicationSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
  status: z.enum(["scheduled", "not_scheduled"], {
    error: "Em lote só é possível agendar ou voltar para não agendado. Publicação é marcada post a post.",
  }),
});

const campaignSchema = z.object({
  brandId: z.string({ error: "Escolha a marca." }).trim().min(1, "Escolha a marca."),
  projectId: optionalId,
  name: schemas.text(120),
  description: schemas.optionalText(2000),
  startDate: schemas.optionalDate,
  endDate: schemas.optionalDate,
});
const campaignPatchSchema = z.object({
  name: schemas.text(120).optional(),
  description: schemas.optionalText(2000),
  startDate: schemas.optionalDate,
  endDate: schemas.optionalDate,
  projectId: optionalId,
});

// ------------------------------------------------------------------ helpers

const placeholders = (list) => list.map(() => "?").join(", ");

function selectIn(db, sql, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = [];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    out.push(...db.all(sql.replace("(?)", `(${placeholders(chunk)})`), chunk));
  }
  return out;
}

// Adds slide count, first media kind, duration and frame of the originals of
// each item's visible version (thumbnail badges on the grid).
export function decoratePosts(req, items) {
  const db = req.ctx.db;
  const rows = selectIn(
    db,
    `SELECT version_id, media_kind, duration_ms, width, height, position FROM material_files
      WHERE role = 'original' AND version_id IN (?) ORDER BY position, created_at`,
    items.map((item) => item.version?.id),
  );
  const byVersion = new Map();
  for (const row of rows) {
    if (!byVersion.has(row.version_id)) byVersion.set(row.version_id, []);
    byVersion.get(row.version_id).push(row);
  }
  return items.map((item) => {
    const files = byVersion.get(item.version?.id) ?? [];
    const first = files[0];
    const video = files.find((f) => f.media_kind === "video");
    return {
      ...item,
      slides: files.length,
      mediaKind: first?.media_kind ?? item.thumb?.mediaKind ?? null,
      durationMs: video?.duration_ms ?? null,
      frame: first?.width && first?.height ? { width: first.width, height: first.height } : null,
    };
  });
}

function assertPost(req, id, options) {
  const material = assertMaterial(req, id, options);
  if (material.kind !== "post") throw notFound();
  return material;
}

function detail(req, id) {
  const material = getMaterialDetail(req, id);
  const [decorated] = decoratePosts(req, [material]);
  if (isStaff(req) && decorated.post) {
    const row = req.ctx.db.get(
      `SELECT pd.scheduled_by, su.name AS scheduled_by_name, pd.published_by, pu.name AS published_by_name
         FROM post_details pd
         LEFT JOIN users su ON su.id = pd.scheduled_by
         LEFT JOIN users pu ON pu.id = pd.published_by
        WHERE pd.material_id = ?`,
      [id],
    );
    decorated.post.scheduledBy = row?.scheduled_by ? { id: row.scheduled_by, name: row.scheduled_by_name } : null;
    decorated.post.publishedBy = row?.published_by ? { id: row.published_by, name: row.published_by_name } : null;
  }
  return decorated;
}

function checkCampaign(db, campaignId, brandId) {
  if (!campaignId) return;
  const campaign = db.get("SELECT brand_id FROM campaigns WHERE id = ?", [campaignId]);
  if (!campaign || campaign.brand_id !== brandId) throw validation({ campaignId: "Campanha não encontrada nesta marca." });
}

// The owner gets write access to the post (lib/access.js, owner_id), so it
// must be someone who already works on this client: an admin, a manager with
// access to the client or a designer on a project of the brand. Same rule as
// the library (services/materials.js assertAssignableOwner) -> 422 otherwise.
function checkOwner(req, ownerId, target) {
  if (!ownerId) return;
  assertAssignableOwner(req, target, ownerId);
}

// Planned date and time are São Paulo wall-clock values (the agency's and its
// clients' time zone; Brazil has had no daylight saving since 2019), never the
// server's time zone.
const SAO_PAULO_OFFSET = "-03:00";
export const plannedInstant = (date, time) => new Date(`${date}T${time || "12:00"}:00${SAO_PAULO_OFFSET}`).toISOString();

const plannedLabel = (date, time) => {
  if (!date) return "";
  const [y, m, d] = date.split("-");
  return ` para ${d}/${m}/${y}${time ? ` às ${time}` : ""}`;
};

function serializeCampaign(req, row) {
  const campaign = {
    id: row.id,
    brandId: row.brand_id,
    name: row.name,
    description: row.description ?? null,
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null,
    postCount: Number(row.post_count ?? 0),
  };
  if (isStaff(req)) {
    campaign.projectId = row.project_id ?? null;
    campaign.createdAt = row.created_at;
  }
  return campaign;
}

function loadCampaign(req, id) {
  const row = id ? req.ctx.db.get("SELECT * FROM campaigns WHERE id = ?", [id]) : null;
  if (!row) throw notFound();
  assertBrand(req, row.brand_id);
  return row;
}

function checkRange(startDate, endDate) {
  if (startDate && endDate && endDate < startDate)
    throw validation({ endDate: "O fim precisa ser igual ou posterior ao início." });
}

// ------------------------------------------------------------------ router

export default function contentRoutes() {
  const router = Router();
  const viewers = [requireAuth, requireCap("content.view", "portal.access")];

  // Filter options for the content screens (brands, projects, campaigns,
  // owners and months with posts), always inside the viewer's scope.
  router.get("/api/content/options", ...viewers, (req, res) => {
    const db = req.ctx.db;
    const staff = isStaff(req);
    const brandId = typeof req.query.brandId === "string" && req.query.brandId ? req.query.brandId : null;
    const posts = scopeSql.materials(req, "m");
    const monthParams = [...posts.params];
    let monthSql = `SELECT DISTINCT substr(pd.planned_date, 1, 7) AS month
        FROM materials m JOIN post_details pd ON pd.material_id = m.id
       WHERE m.kind = 'post' AND pd.planned_date IS NOT NULL AND m.archived_at IS NULL AND ${posts.sql}`;
    if (brandId) {
      monthSql += " AND m.brand_id = ?";
      monthParams.push(brandId);
    }
    const months = db.all(`${monthSql} ORDER BY month DESC`, monthParams).map((row) => row.month);

    if (!staff) {
      const params = [req.user.client_id];
      let sql = `SELECT cmp.*, (SELECT COUNT(*) FROM post_details pd JOIN materials m ON m.id = pd.material_id
                   WHERE pd.campaign_id = cmp.id AND ${clientMaterialFilter("m")}) AS post_count
                 FROM campaigns cmp JOIN brands b ON b.id = cmp.brand_id
                WHERE b.client_id = ?`;
      if (brandId) {
        sql += " AND cmp.brand_id = ?";
        params.push(brandId);
      }
      const campaigns = db
        .all(`${sql} ORDER BY cmp.name COLLATE NOCASE`, params)
        .filter((row) => Number(row.post_count) > 0)
        .map((row) => serializeCampaign(req, row));
      return res.json({ campaigns, months });
    }

    const brandScope = scopeSql.brands(req, "b");
    const brands = db
      .all(
        `SELECT b.id, b.name, b.slug, b.client_id, c.name AS client_name FROM brands b JOIN clients c ON c.id = b.client_id
          WHERE b.status = 'active' AND c.status != 'archived' AND ${brandScope.sql}
          ORDER BY c.name COLLATE NOCASE, b.name COLLATE NOCASE`,
        brandScope.params,
      )
      .map((row) => ({ id: row.id, name: row.name, slug: row.slug, clientId: row.client_id, clientName: row.client_name }));
    const projectScope = scopeSql.projects(req, "p");
    const projects = db
      .all(
        `SELECT p.id, p.name, p.brand_id, p.status FROM projects p
          WHERE p.status != 'archived' AND ${projectScope.sql} ORDER BY p.name COLLATE NOCASE`,
        projectScope.params,
      )
      .map((row) => ({ id: row.id, name: row.name, brandId: row.brand_id, status: row.status }));
    const campaigns = db
      .all(
        `SELECT cmp.*, (SELECT COUNT(*) FROM post_details pd JOIN materials m ON m.id = pd.material_id
             WHERE pd.campaign_id = cmp.id AND m.archived_at IS NULL) AS post_count
           FROM campaigns cmp JOIN brands b ON b.id = cmp.brand_id
          WHERE ${brandScope.sql} ORDER BY cmp.name COLLATE NOCASE`,
        brandScope.params,
      )
      .map((row) => serializeCampaign(req, row));
    // Owners, each with the brands (in the viewer's scope) they may be made
    // responsible for — see checkOwner; null = every brand (admins).
    const scopedBrands = new Set(brands.map((brand) => brand.id));
    const brandsOf = new Map();
    const addBrand = (userId, brandId) => {
      if (!scopedBrands.has(brandId)) return;
      if (!brandsOf.has(userId)) brandsOf.set(userId, new Set());
      brandsOf.get(userId).add(brandId);
    };
    for (const row of db.all(
      `SELECT sca.user_id, b.id AS brand_id FROM staff_client_access sca JOIN brands b ON b.client_id = sca.client_id
        JOIN users u ON u.id = sca.user_id WHERE u.role = 'manager'`,
    ))
      addBrand(row.user_id, row.brand_id);
    for (const row of db.all(
      `SELECT pm.user_id, p.brand_id FROM project_members pm JOIN projects p ON p.id = pm.project_id
        JOIN users u ON u.id = pm.user_id WHERE u.role = 'designer'`,
    ))
      addBrand(row.user_id, row.brand_id);
    const owners = db
      .all(
        "SELECT id, name, role FROM users WHERE role IN ('admin', 'manager', 'designer') AND status = 'active' ORDER BY name COLLATE NOCASE",
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        brandIds: row.role === "admin" ? null : [...(brandsOf.get(row.id) ?? [])],
      }));
    res.json({ brands, projects, campaigns, owners, months });
  });

  // GET /api/content — posts in scope. Clients only see released posts.
  router.get("/api/content", ...viewers, (req, res) => {
    const q = req.query;
    const staff = isStaff(req);
    const str = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    const from = str(q.from);
    const to = str(q.to);
    const fields = {};
    if (from && !isValidDate(from)) fields.from = "Use uma data válida (AAAA-MM-DD).";
    if (to && !isValidDate(to)) fields.to = "Use uma data válida (AAAA-MM-DD).";
    if (Object.keys(fields).length) throw validation(fields);

    const calendar = q.view === "calendar";
    const filters = {
      kind: "post",
      brandId: str(q.brandId),
      clientId: staff ? str(q.clientId) : undefined,
      projectId: str(q.projectId),
      campaignId: str(q.campaignId),
      network: str(q.network),
      format: str(q.format),
      approval: str(q.approval),
      publication: str(q.publication),
      visibility: staff ? str(q.visibility) : undefined,
      ownerId: staff ? str(q.ownerId) : undefined,
      q: str(q.q),
      archived: staff ? str(q.archived) : undefined,
      sort: ["planned", "updated", "created", "title", "released", "due"].includes(q.sort) ? q.sort : "planned",
    };
    // Calendar: one request returns the dated posts in range plus the undated ones.
    if (!calendar) Object.assign(filters, { from, to });
    let { items } = listMaterials(req, filters);
    // Delivery is its own axis (materials.delivered_at: final files made
    // available), separate from approval and publication.
    const delivered = ["1", "true"].includes(q.delivered) ? true : ["0", "false"].includes(q.delivered) ? false : null;
    if (delivered !== null) items = items.filter((item) => Boolean(item.deliveredAt) === delivered);
    let undated;
    if (calendar) {
      undated = items.filter((item) => !item.post?.plannedDate);
      items = items.filter((item) => {
        const date = item.post?.plannedDate;
        return date && (!from || date >= from) && (!to || date <= to);
      });
    }
    if (q.sort === "planned_desc")
      items = [...items].sort(
        (a, b) =>
          String(b.post?.plannedDate ?? "9999").localeCompare(String(a.post?.plannedDate ?? "9999")) ||
          String(b.post?.plannedTime ?? "").localeCompare(String(a.post?.plannedTime ?? "")) ||
          String(b.createdAt).localeCompare(String(a.createdAt)),
      );
    const total = items.length;
    const pageSize = Number.parseInt(q.pageSize, 10);
    if (pageSize > 0) {
      const size = Math.min(200, pageSize);
      const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
      items = items.slice((page - 1) * size, page * size);
    }
    const body = { items: decoratePosts(req, items), total };
    if (undated) body.undated = decoratePosts(req, undated);
    res.json(body);
  });

  router.post("/api/content", requireAuth, requireCap("content.manage"), (req, res) => {
    const input = parse(createSchema, req.body);
    const db = req.ctx.db;
    let categoryId = input.categoryId;
    if (!categoryId) {
      categoryId = db.get("SELECT id FROM categories WHERE slug = ? AND archived_at IS NULL", [DEFAULT_CATEGORY[input.format]])?.id;
      if (!categoryId) throw validation({ categoryId: "Escolha uma categoria ativa." });
    } else {
      const category = db.get("SELECT area, archived_at FROM categories WHERE id = ?", [categoryId]);
      if (!category || category.archived_at) throw validation({ categoryId: "Escolha uma categoria ativa." });
    }
    if (input.ownerId) {
      const brand = assertBrand(req, input.brandId);
      checkOwner(req, input.ownerId, { clientId: brand.client_id, brandId: brand.id });
    }
    const id = createMaterial(req, {
      kind: "post",
      brandId: input.brandId,
      projectId: input.projectId ?? null,
      categoryId,
      title: input.title,
      description: input.description,
      ownerId: input.ownerId ?? undefined,
      internalNotes: input.internalNotes,
      caption: input.caption,
      hashtags: input.hashtags,
      notes: input.notes,
      post: {
        network: input.network,
        format: input.format,
        plannedDate: input.plannedDate ?? null,
        plannedTime: input.plannedTime ?? null,
        campaignId: input.campaignId ?? null,
      },
      files: input.files.map((file, index) => ({
        uploadId: file.uploadId,
        role: file.role ?? "original",
        position: file.position ?? (file.role === "cover" ? 1 : index + 1),
      })),
    });
    res.status(201).json({ material: detail(req, id) });
  });

  router.post("/api/content/bulk-publication", requireAuth, requireCap("content.publication"), (req, res) => {
    const { ids, status } = parse(bulkPublicationSchema, req.body);
    const db = req.ctx.db;
    const at = now();
    const updated = [];
    const skipped = [];
    db.tx(() => {
      for (const id of [...new Set(ids)]) {
        let material;
        try {
          material = assertPost(req, id, { write: true });
        } catch {
          skipped.push({ id, reason: "Não encontrado." });
          continue;
        }
        if (material.archived_at) {
          skipped.push({ id, reason: "Material arquivado." });
          continue;
        }
        const post = db.get("SELECT * FROM post_details WHERE material_id = ?", [id]);
        if (status === "scheduled") {
          if (material.visibility !== "released") {
            skipped.push({ id, reason: "Ainda não foi liberado ao cliente." });
            continue;
          }
          if (post.publication_status === "published") {
            skipped.push({ id, reason: "Já está marcado como publicado." });
            continue;
          }
          const scheduledAt = post.planned_date ? plannedInstant(post.planned_date, post.planned_time) : at;
          db.run(
            `UPDATE post_details SET publication_status = 'scheduled', scheduled_at = ?, scheduled_by = ?,
               published_at = NULL, published_by = NULL, published_url = NULL WHERE material_id = ?`,
            [scheduledAt, req.user.id, id],
          );
        } else {
          db.run(
            `UPDATE post_details SET publication_status = 'not_scheduled', scheduled_at = NULL, scheduled_by = NULL,
               published_at = NULL, published_by = NULL, published_url = NULL WHERE material_id = ?`,
            [id],
          );
        }
        db.run("UPDATE materials SET updated_at = ? WHERE id = ?", [at, id]);
        logActivity(req, {
          action: status === "scheduled" ? "content.scheduled" : "content.unscheduled",
          entityType: "material",
          entityId: id,
          materialId: id,
          summary:
            status === "scheduled"
              ? `${req.user.name} marcou “${material.title}” como agendado${plannedLabel(post.planned_date, post.planned_time)}.`
              : `${req.user.name} retirou o agendamento de “${material.title}”.`,
          visibility: status === "scheduled" ? "client" : "internal",
          data: { bulk: true },
        });
        updated.push(id);
      }
    });
    res.json({ updated: updated.length, ids: updated, skipped });
  });

  router.get("/api/content/:id", ...viewers, (req, res) => {
    assertPost(req, req.params.id);
    res.json({ material: detail(req, req.params.id) });
  });

  router.patch("/api/content/:id", requireAuth, requireCap("content.manage"), (req, res) => {
    const input = parse(patchSchema, req.body);
    const db = req.ctx.db;
    const material = assertPost(req, req.params.id, { write: true });
    if (material.archived_at) throw conflict("Material arquivado. Desarquive para editar.");
    const post = db.get("SELECT * FROM post_details WHERE material_id = ?", [material.id]);
    if ("campaignId" in input) checkCampaign(db, input.campaignId, material.brand_id);
    if ("ownerId" in input && input.ownerId !== material.owner_id)
      checkOwner(req, input.ownerId, material);

    const versionFields = ["caption", "hashtags", "notes"].filter((key) => key in input);
    const version = material.current_version_id
      ? db.get("SELECT * FROM material_versions WHERE id = ?", [material.current_version_id])
      : null;
    if (versionFields.length) {
      const editable = version && (version.status === "draft" || version.status === "internal_review");
      const same = version && versionFields.every((key) => (version[key] ?? null) === (input[key] ?? null));
      if (!editable && !same)
        throw conflict(
          "A versão atual já foi liberada ao cliente. Crie uma nova versão para alterar legenda, hashtags ou observações.",
        );
    }

    const at = now();
    const changed = [];
    db.tx(() => {
      const postSet = [];
      const postParams = [];
      const setPost = (column, key) => {
        if (!(key in input)) return;
        if ((post[column] ?? null) === (input[key] ?? null)) return;
        postSet.push(`${column} = ?`);
        postParams.push(input[key] ?? null);
        changed.push(key);
      };
      setPost("network", "network");
      setPost("format", "format");
      setPost("planned_date", "plannedDate");
      setPost("planned_time", "plannedTime");
      setPost("campaign_id", "campaignId");
      if (postSet.length) db.run(`UPDATE post_details SET ${postSet.join(", ")} WHERE material_id = ?`, [...postParams, material.id]);

      const matSet = [];
      const matParams = [];
      const setMat = (column, key) => {
        if (!(key in input)) return;
        if ((material[column] ?? null) === (input[key] ?? null)) return;
        matSet.push(`${column} = ?`);
        matParams.push(input[key] ?? null);
        changed.push(key);
      };
      setMat("title", "title");
      setMat("owner_id", "ownerId");
      setMat("internal_notes", "internalNotes");
      setMat("description", "description");
      // Moving between formats follows the default category when the post
      // still sits in the default category of its old format.
      if (input.format && input.format !== post.format) {
        const current = db.get("SELECT slug FROM categories WHERE id = ?", [material.category_id])?.slug;
        if (current === DEFAULT_CATEGORY[post.format] && DEFAULT_CATEGORY[input.format] !== current) {
          const next = db.get("SELECT id FROM categories WHERE slug = ? AND archived_at IS NULL", [DEFAULT_CATEGORY[input.format]]);
          if (next) {
            matSet.push("category_id = ?");
            matParams.push(next.id);
          }
        }
      }
      matSet.push("updated_at = ?");
      matParams.push(at);
      db.run(`UPDATE materials SET ${matSet.join(", ")} WHERE id = ?`, [...matParams, material.id]);

      const verSet = [];
      const verParams = [];
      for (const key of versionFields) {
        if ((version[key] ?? null) === (input[key] ?? null)) continue;
        verSet.push(`${key} = ?`);
        verParams.push(input[key] ?? null);
        changed.push(key);
      }
      if (verSet.length) db.run(`UPDATE material_versions SET ${verSet.join(", ")} WHERE id = ?`, [...verParams, version.id]);

      if (changed.length)
        logActivity(req, {
          action: "content.updated",
          entityType: "material",
          entityId: material.id,
          materialId: material.id,
          summary: `${req.user.name} atualizou os dados do post “${input.title ?? material.title}”.`,
          data: { fields: changed },
        });
    });
    res.json({ material: detail(req, material.id) });
  });

  router.patch("/api/content/:id/publication", requireAuth, requireCap("content.publication"), (req, res) => {
    const input = parse(publicationSchema, req.body);
    const db = req.ctx.db;
    const material = assertPost(req, req.params.id, { write: true });
    if (material.archived_at) throw conflict("Material arquivado. Desarquive para alterar a publicação.");
    if (input.status !== "not_scheduled" && material.visibility !== "released")
      throw conflict("Libere o post ao cliente antes de marcar agendamento ou publicação.");
    if (input.status === "published" && input.confirm !== true)
      throw validation({ confirm: "Confirme que a publicação foi feita manualmente na rede social." });
    if (input.publishedAt && Date.parse(input.publishedAt) > Date.now() + 5 * 60 * 1000)
      throw validation({ publishedAt: "A data de publicação não pode estar no futuro." });

    const post = db.get("SELECT * FROM post_details WHERE material_id = ?", [material.id]);
    const at = now();
    const user = req.user;
    let summary;
    db.tx(() => {
      if (input.status === "not_scheduled") {
        db.run(
          `UPDATE post_details SET publication_status = 'not_scheduled', scheduled_at = NULL, scheduled_by = NULL,
             published_at = NULL, published_by = NULL, published_url = NULL WHERE material_id = ?`,
          [material.id],
        );
        summary = `${user.name} voltou “${material.title}” para não agendado.`;
      } else if (input.status === "scheduled") {
        const scheduledAt = input.scheduledAt ?? (post.planned_date ? plannedInstant(post.planned_date, post.planned_time) : at);
        db.run(
          `UPDATE post_details SET publication_status = 'scheduled', scheduled_at = ?, scheduled_by = ?,
             published_at = NULL, published_by = NULL, published_url = NULL WHERE material_id = ?`,
          [scheduledAt, user.id, material.id],
        );
        summary = `${user.name} marcou “${material.title}” como agendado${plannedLabel(post.planned_date, post.planned_time)}.`;
      } else {
        db.run(
          `UPDATE post_details SET publication_status = 'published', published_at = ?, published_by = ?, published_url = ?
            WHERE material_id = ?`,
          [input.publishedAt ?? at, user.id, input.publishedUrl ?? null, material.id],
        );
        summary = `${user.name} marcou “${material.title}” como publicado manualmente.`;
      }
      db.run("UPDATE materials SET updated_at = ? WHERE id = ?", [at, material.id]);
      logActivity(req, {
        action: `content.${input.status === "not_scheduled" ? "unscheduled" : input.status}`,
        entityType: "material",
        entityId: material.id,
        materialId: material.id,
        summary,
        visibility: input.status === "not_scheduled" ? "internal" : "client",
        data: {
          status: input.status,
          previous: post.publication_status,
          scheduledAt: input.scheduledAt ?? null,
          publishedAt: input.publishedAt ?? null,
          publishedUrl: input.publishedUrl ?? null,
          manual: true,
        },
      });
      if (input.status === "published" && material.visibility === "released")
        notify(req, clientUserIds(db, material.client_id), {
          type: "content.published",
          title: `“${material.title}” foi publicado`,
          body: "A equipe Metta registrou a publicação deste post.",
          link: `/painel/conteudo/${material.id}`,
          entityType: "material",
          entityId: material.id,
        });
    });
    res.json({ material: detail(req, material.id) });
  });

  // ---------------------------------------------------------------- campaigns

  router.get("/api/campaigns", ...viewers, (req, res) => {
    const db = req.ctx.db;
    const brandId = typeof req.query.brandId === "string" && req.query.brandId ? req.query.brandId : null;
    if (!isStaff(req)) {
      const params = [req.user.client_id];
      let sql = `SELECT cmp.*, (SELECT COUNT(*) FROM post_details pd JOIN materials m ON m.id = pd.material_id
                   WHERE pd.campaign_id = cmp.id AND ${clientMaterialFilter("m")}) AS post_count
                 FROM campaigns cmp JOIN brands b ON b.id = cmp.brand_id WHERE b.client_id = ?`;
      if (brandId) {
        sql += " AND cmp.brand_id = ?";
        params.push(brandId);
      }
      const items = db
        .all(`${sql} ORDER BY cmp.start_date IS NULL, cmp.start_date DESC, cmp.name COLLATE NOCASE`, params)
        .filter((row) => Number(row.post_count) > 0)
        .map((row) => serializeCampaign(req, row));
      return res.json({ items, total: items.length });
    }
    const scope = scopeSql.brands(req, "b");
    const params = [...scope.params];
    let sql = `SELECT cmp.*, (SELECT COUNT(*) FROM post_details pd JOIN materials m ON m.id = pd.material_id
                 WHERE pd.campaign_id = cmp.id AND m.archived_at IS NULL) AS post_count
               FROM campaigns cmp JOIN brands b ON b.id = cmp.brand_id WHERE ${scope.sql}`;
    if (brandId) {
      sql += " AND cmp.brand_id = ?";
      params.push(brandId);
    }
    if (typeof req.query.projectId === "string" && req.query.projectId) {
      sql += " AND cmp.project_id = ?";
      params.push(req.query.projectId);
    }
    const items = db
      .all(`${sql} ORDER BY cmp.start_date IS NULL, cmp.start_date DESC, cmp.name COLLATE NOCASE`, params)
      .map((row) => serializeCampaign(req, row));
    res.json({ items, total: items.length });
  });

  router.post("/api/campaigns", requireAuth, requireCap("content.manage"), (req, res) => {
    const input = parse(campaignSchema, req.body);
    const db = req.ctx.db;
    const brand = assertBrand(req, input.brandId);
    if (input.projectId) {
      const project = assertProject(req, input.projectId);
      if (project.brand_id !== brand.id) throw validation({ projectId: "O projeto precisa ser da mesma marca." });
    }
    checkRange(input.startDate, input.endDate);
    const duplicate = db.get("SELECT id FROM campaigns WHERE brand_id = ? AND name = ? COLLATE NOCASE", [brand.id, input.name]);
    if (duplicate) throw validation({ name: "Já existe uma campanha com este nome nesta marca." });
    const id = newId("cmp");
    const at = now();
    db.tx(() => {
      db.run(
        `INSERT INTO campaigns (id, brand_id, project_id, name, description, start_date, end_date, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, brand.id, input.projectId ?? null, input.name, input.description ?? null, input.startDate ?? null, input.endDate ?? null, req.user.id, at, at],
      );
      logActivity(req, {
        action: "campaign.created",
        entityType: "campaign",
        entityId: id,
        brandId: brand.id,
        clientId: brand.client_id,
        projectId: input.projectId ?? null,
        summary: `${req.user.name} criou a campanha “${input.name}”.`,
      });
    });
    res.status(201).json({ campaign: serializeCampaign(req, db.get("SELECT *, 0 AS post_count FROM campaigns WHERE id = ?", [id])) });
  });

  router.patch("/api/campaigns/:id", requireAuth, requireCap("content.manage"), (req, res) => {
    const input = parse(campaignPatchSchema, req.body);
    const db = req.ctx.db;
    const campaign = loadCampaign(req, req.params.id);
    if (input.projectId) {
      const project = assertProject(req, input.projectId);
      if (project.brand_id !== campaign.brand_id) throw validation({ projectId: "O projeto precisa ser da mesma marca." });
    }
    const startDate = "startDate" in input ? input.startDate : campaign.start_date;
    const endDate = "endDate" in input ? input.endDate : campaign.end_date;
    checkRange(startDate, endDate);
    if (input.name && input.name.toLowerCase() !== campaign.name.toLowerCase()) {
      const duplicate = db.get("SELECT id FROM campaigns WHERE brand_id = ? AND name = ? COLLATE NOCASE AND id != ?", [
        campaign.brand_id,
        input.name,
        campaign.id,
      ]);
      if (duplicate) throw validation({ name: "Já existe uma campanha com este nome nesta marca." });
    }
    const columns = { name: "name", description: "description", startDate: "start_date", endDate: "end_date", projectId: "project_id" };
    const set = [];
    const params = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in input)) continue;
      set.push(`${column} = ?`);
      params.push(input[key] ?? null);
    }
    set.push("updated_at = ?");
    params.push(now());
    db.tx(() => {
      db.run(`UPDATE campaigns SET ${set.join(", ")} WHERE id = ?`, [...params, campaign.id]);
      logActivity(req, {
        action: "campaign.updated",
        entityType: "campaign",
        entityId: campaign.id,
        brandId: campaign.brand_id,
        summary: `${req.user.name} atualizou a campanha “${input.name ?? campaign.name}”.`,
      });
    });
    const row = db.get(
      `SELECT cmp.*, (SELECT COUNT(*) FROM post_details pd JOIN materials m ON m.id = pd.material_id
          WHERE pd.campaign_id = cmp.id AND m.archived_at IS NULL) AS post_count FROM campaigns cmp WHERE cmp.id = ?`,
      [campaign.id],
    );
    res.json({ campaign: serializeCampaign(req, row) });
  });

  router.delete("/api/campaigns/:id", requireAuth, requireCap("content.manage"), (req, res) => {
    const db = req.ctx.db;
    const campaign = loadCampaign(req, req.params.id);
    if (req.user.role === "designer" && campaign.created_by !== req.user.id && !can(req.user, "content.publication"))
      throw forbidden("Só quem criou a campanha ou a gestão pode removê-la.");
    db.tx(() => {
      db.run("DELETE FROM campaigns WHERE id = ?", [campaign.id]);
      logActivity(req, {
        action: "campaign.deleted",
        entityType: "campaign",
        entityId: campaign.id,
        brandId: campaign.brand_id,
        summary: `${req.user.name} removeu a campanha “${campaign.name}”. Os posts continuam, sem campanha.`,
      });
    });
    res.status(204).end();
  });

  return router;
}

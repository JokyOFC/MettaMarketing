// Shared material domain layer (lists, detail, versions, attaching uploads).
// Used by several routers; the exported names are a contract between slices.

import {
  assertBrand,
  assertMaterial,
  assertProject,
  canWriteMaterial,
  clientCanSeeFile,
  clientCanSeeMaterial,
  downloadRule,
  getScope,
  scopeSql,
} from "../lib/access.js";
import { logActivity } from "../lib/audit.js";
import { renderEmail } from "../lib/emails.js";
import { conflict, forbidden, notFound, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { COMPRESSED_EXTS, extOf, formatLabel, PREVIEWABLE_KINDS, safeSegment, sanitizeFilename } from "../lib/media.js";
import { clientUserIds, notify } from "../lib/notify.js";
import { can } from "../lib/permissions.js";
import { bool, isStaff, parseJson, personRef } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { queryList } from "../lib/validate.js";

// ------------------------------------------------------------------ SQL

const MATERIAL_FROM = `FROM materials m
  JOIN brands b ON b.id = m.brand_id
  JOIN clients cl ON cl.id = b.client_id
  JOIN categories cat ON cat.id = m.category_id
  LEFT JOIN projects p ON p.id = m.project_id
  LEFT JOIN users o ON o.id = m.owner_id
  LEFT JOIN post_details pd ON pd.material_id = m.id
  LEFT JOIN campaigns cmp ON cmp.id = pd.campaign_id`;

// Full material row: m.* plus brand/client/project/category/owner/post
// columns. Aliases: m, b (brands), cl (clients), cat, p, o (owner), pd, cmp.
export const MATERIAL_SELECT = `SELECT m.*, b.client_id AS client_id, b.name AS brand_name, b.slug AS brand_slug,
  cl.name AS client_name, p.name AS project_name,
  cat.slug AS cat_slug, cat.name AS cat_name, cat.area AS cat_area, cat.folder AS cat_folder,
  cat.sort_order AS cat_sort_order, cat.is_system AS cat_is_system, cat.archived_at AS cat_archived_at,
  o.name AS owner_name, o.role AS owner_role,
  pd.material_id AS pd_material_id, pd.campaign_id AS pd_campaign_id, pd.network AS pd_network,
  pd.format AS pd_format, pd.planned_date AS pd_planned_date, pd.planned_time AS pd_planned_time,
  pd.publication_status AS pd_publication_status, pd.scheduled_at AS pd_scheduled_at,
  pd.published_at AS pd_published_at, pd.published_url AS pd_published_url,
  cmp.name AS campaign_name
  ${MATERIAL_FROM}`;

export const FILE_ROLE_ORDER = { original: 1, final: 2, editable: 3, cover: 4 };
export const sortFiles = (files) =>
  [...files].sort(
    (a, b) =>
      (FILE_ROLE_ORDER[a.role] ?? 9) - (FILE_ROLE_ORDER[b.role] ?? 9) ||
      a.position - b.position ||
      String(a.created_at).localeCompare(String(b.created_at)) ||
      String(a.id).localeCompare(String(b.id)),
  );

const FORMAT_ORDER = ["SVG", "PNG", "JPG", "WEBP", "PDF", "EPS", "AI", "MP4", "MOV", "WEBM"];
const sortFormats = (formats) =>
  [...formats].sort((a, b) => {
    const ia = FORMAT_ORDER.indexOf(a);
    const ib = FORMAT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

const placeholders = (list) => list.map(() => "?").join(", ");

// Runs `SELECT … WHERE column IN (…)` in chunks.
async function selectIn(db, sql, ids, extra = []) {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = [];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    out.push(...await db.all(sql.replace("(?)", `(${placeholders(chunk)})`), [...chunk, ...extra]));
  }
  return out;
}

// Map<fileId, { thumb, preview, poster }> with rendition rows (no storage keys leave the server).
export async function loadRenditions(db, fileIds) {
  const map = new Map();
  for (const row of await selectIn(db, "SELECT file_id, kind, mime, width, height, size_bytes FROM file_renditions WHERE file_id IN (?)", fileIds)) {
    if (!map.has(row.file_id)) map.set(row.file_id, {});
    map.get(row.file_id)[row.kind] = row;
  }
  return map;
}

const renditionsOf = (renditions, fileId) =>
  (renditions instanceof Map ? renditions.get(fileId) : renditions?.[fileId]) ?? {};

// --------------------------------------------------------------- files

// { ok, reason } — reason: not_downloadable | download_disabled | font_license | not_found
export function isFileDownloadable(req, fileRow, materialRow) {
  if (!req?.user || !fileRow || !materialRow) return { ok: false, reason: "not_found" };
  if (req.user.role === "client" && !clientCanSeeFile(fileRow, materialRow)) return { ok: false, reason: "not_found" };
  return downloadRule(req.user, fileRow, materialRow);
}

// File (docs/API.md). previews point at /api/files/:id/preview/:kind only
// when that rendition exists; stream is offered for video/audio/pdf.
export function serializeFile(req, fileRow, materialRow, renditionsByKind = {}) {
  const r = renditionsByKind ?? {};
  const id = fileRow.id;
  const downloadable = isFileDownloadable(req, fileRow, materialRow).ok;
  // PDFs stream the original itself: offered only when it may be downloaded
  const streamable =
    fileRow.media_kind === "video" || fileRow.media_kind === "audio" || (fileRow.media_kind === "pdf" && downloadable);
  const file = {
    id,
    versionId: fileRow.version_id,
    role: fileRow.role,
    position: fileRow.position,
    name: fileRow.display_name,
    ext: fileRow.ext,
    format: formatLabel(fileRow.ext),
    mime: fileRow.mime,
    sizeBytes: fileRow.size_bytes,
    width: fileRow.width ?? null,
    height: fileRow.height ?? null,
    durationMs: fileRow.duration_ms ?? null,
    pages: fileRow.pages ?? null,
    mediaKind: fileRow.media_kind,
    previewStatus: fileRow.preview_status,
    previews: {
      thumb: r.thumb ? `/api/files/${id}/preview/thumb` : null,
      preview: r.preview ? `/api/files/${id}/preview/preview` : null,
      poster: r.poster ? `/api/files/${id}/preview/poster` : null,
      stream: streamable ? `/api/files/${id}/stream` : null,
    },
    downloadable,
    fontDistributable: fileRow.media_kind === "font" ? fileRow.font_distributable === 1 : null,
    createdAt: fileRow.created_at,
  };
  // staff: finals attached after the release wait for an explicit delivery
  if (isStaff(req)) file.published = isPublished(fileRow);
  return file;
}

export const isPublished = (fileRow) =>
  fileRow.published === undefined || fileRow.published === null || Number(fileRow.published) === 1;

// File rows a client may see (rule §2.4), ordered by role then position.
export function clientVisibleFiles(materialRow, fileRows) {
  return sortFiles(fileRows.filter((row) => clientCanSeeFile(row, materialRow)));
}

// File rows of a version the viewer may see, ordered by role then position.
export async function visibleFilesForVersion(req, materialRow, versionId) {
  const rows = await req.ctx.db.all("SELECT * FROM material_files WHERE version_id = ? AND material_id = ?", [
    versionId,
    materialRow.id,
  ]);
  const visible = req.user?.role === "client" ? rows.filter((row) => clientCanSeeFile(row, materialRow)) : rows;
  return sortFiles(visible);
}

// ------------------------------------------------------------- versions

const versionSummary = (row) =>
  row ? { id: row.id, number: row.number, status: row.status, releasedAt: row.released_at ?? null, createdAt: row.created_at } : null;

const VERSION_SELECT = `SELECT v.*, cu.name AS created_by_name, cu.role AS created_by_role,
  du.name AS decided_by_name, du.role AS decided_by_role
  FROM material_versions v
  LEFT JOIN users cu ON cu.id = v.created_by
  LEFT JOIN users du ON du.id = v.decided_by`;

/**
 * Version (docs/API.md). files: file rows already filtered for the viewer
 * (see visibleFilesForVersion); renditions: Map<fileId, {thumb, preview, poster}>.
 * materialRow is needed for download rules (falls back to a lookup).
 */
export async function serializeVersion(req, versionRow, files, renditions, materialRow) {
  const db = req.ctx.db;
  const material =
    materialRow ?? versionRow.material ?? await db.get("SELECT m.*, b.client_id AS client_id FROM materials m JOIN brands b ON b.id = m.brand_id WHERE m.id = ?", [versionRow.material_id]);
  let createdBy = versionRow.created_by_name !== undefined
    ? { id: versionRow.created_by, name: versionRow.created_by_name, role: versionRow.created_by_role }
    : await db.get("SELECT id, name, role FROM users WHERE id = ?", [versionRow.created_by]);
  let decidedBy = null;
  if (versionRow.decided_by) {
    decidedBy = versionRow.decided_by_name !== undefined
      ? { id: versionRow.decided_by, name: versionRow.decided_by_name, role: versionRow.decided_by_role }
      : await db.get("SELECT id, name, role FROM users WHERE id = ?", [versionRow.decided_by]);
  }
  const fileRows = sortFiles(files ?? await visibleFilesForVersion(req, material, versionRow.id));
  const renditionMap = renditions ?? await loadRenditions(db, fileRows.map((f) => f.id));
  return {
    id: versionRow.id,
    materialId: versionRow.material_id,
    number: versionRow.number,
    status: versionRow.status,
    caption: versionRow.caption ?? null,
    hashtags: versionRow.hashtags ?? null,
    notes: versionRow.notes ?? null,
    changeSummary: versionRow.change_summary ?? null,
    createdAt: versionRow.created_at,
    createdBy: personRef(req, createdBy),
    submittedAt: isStaff(req) ? versionRow.submitted_at ?? null : undefined,
    releasedAt: versionRow.released_at ?? null,
    decidedAt: versionRow.decided_at ?? null,
    decidedBy: personRef(req, decidedBy),
    files: fileRows.map((file) => serializeFile(req, file, material, renditionsOf(renditionMap, file.id))),
  };
}

// ------------------------------------------------------------- materials

function pickThumb(files, renditions) {
  const ordered = [
    ...files.filter((f) => f.role === "cover"),
    ...files.filter((f) => f.role === "original"),
    ...files.filter((f) => f.role === "final"),
  ];
  if (!ordered.length) return null;
  const withPreview = ordered.find((f) => {
    const r = renditionsOf(renditions, f.id);
    return r.thumb || r.poster;
  });
  const file = withPreview ?? ordered[0];
  const r = renditionsOf(renditions, file.id);
  const rendition = r.thumb ?? r.poster ?? null;
  const kind = r.thumb ? "thumb" : r.poster ? "poster" : null;
  return {
    fileId: file.id,
    url: kind ? `/api/files/${file.id}/preview/${kind}` : null,
    width: file.width ?? rendition?.width ?? null,
    height: file.height ?? rendition?.height ?? null,
    mediaKind: file.media_kind,
  };
}

function serializePost(row) {
  if (row.kind !== "post" || !row.pd_material_id) return null;
  return {
    network: row.pd_network,
    format: row.pd_format,
    plannedDate: row.pd_planned_date ?? null,
    plannedTime: row.pd_planned_time ?? null,
    campaign: row.pd_campaign_id ? { id: row.pd_campaign_id, name: row.campaign_name ?? null } : null,
    publicationStatus: row.pd_publication_status,
    scheduledAt: row.pd_scheduled_at ?? null,
    publishedAt: row.pd_published_at ?? null,
    publishedUrl: row.pd_published_url ?? null,
  };
}

/**
 * Material[] from MATERIAL_SELECT rows. Batch-loads the version summary
 * (staff: current version; client: latest released version), thumbnail,
 * real formats and file counts of that version.
 */
export async function serializeMaterials(req, rows) {
  if (!rows.length) return [];
  const db = req.ctx.db;
  const staff = isStaff(req);
  const versionIdOf = (row) => (staff ? row.current_version_id ?? row.released_version_id : row.released_version_id);

  const versions = new Map(
    (await selectIn(db, "SELECT id, material_id, number, status, released_at, created_at FROM material_versions WHERE id IN (?)", rows.map(versionIdOf))).map(
      (v) => [v.id, v],
    ),
  );
  const filesByVersion = new Map();
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const file of await selectIn(db, "SELECT * FROM material_files WHERE version_id IN (?)", [...versions.keys()])) {
    const material = rowById.get(file.material_id);
    if (!material) continue;
    if (!staff && !clientCanSeeFile(file, material)) continue;
    if (!filesByVersion.has(file.version_id)) filesByVersion.set(file.version_id, []);
    filesByVersion.get(file.version_id).push(file);
  }
  const allFiles = [...filesByVersion.values()].flat();
  const renditions = await loadRenditions(db, allFiles.map((f) => f.id));

  return rows.map((row) => {
    const version = versions.get(versionIdOf(row)) ?? null;
    const files = sortFiles(filesByVersion.get(version?.id) ?? []);
    const deliverable = files.filter((f) => f.role !== "cover");
    const material = {
      id: row.id,
      kind: row.kind,
      title: row.title,
      description: row.description ?? null,
      tags: parseJson(row.tags, []),
      brand: { id: row.brand_id, name: row.brand_name, slug: row.brand_slug, clientId: row.client_id },
      client: { id: row.client_id, name: row.client_name },
      project: row.project_id ? { id: row.project_id, name: row.project_name ?? null } : null,
      category: {
        id: row.category_id,
        slug: row.cat_slug,
        name: row.cat_name,
        area: row.cat_area,
        folder: row.cat_folder,
        sortOrder: row.cat_sort_order,
        isSystem: bool(row.cat_is_system),
        archivedAt: row.cat_archived_at ?? null,
      },
      owner: row.owner_id ? personRef(req, { id: row.owner_id, name: row.owner_name, role: row.owner_role }) : null,
      variant: row.variant ?? null,
      previewBg: row.preview_bg,
      isPrimary: bool(row.is_primary),
      sortOrder: row.sort_order,
      visibility: staff ? row.visibility : "released",
      downloadEnabled: bool(row.download_enabled),
      editableIncluded: bool(row.editable_included),
      requiresApproval: bool(row.requires_approval),
      approvalStatus: row.approval_status,
      approvedVersionId: row.approved_version_id ?? null,
      releasedVersionId: row.released_version_id ?? null,
      dueDate: row.due_date ?? null,
      releasedAt: row.released_at ?? null,
      deliveredAt: row.delivered_at ?? null,
      archivedAt: row.archived_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: versionSummary(version),
      thumb: pickThumb(files, renditions),
      formats: sortFormats(new Set(deliverable.map((f) => formatLabel(f.ext)))),
      fileCount: deliverable.length,
      totalBytes: deliverable.reduce((sum, f) => sum + (f.size_bytes ?? 0), 0),
      post: serializePost(row),
    };
    if (staff) {
      material.currentVersionId = row.current_version_id ?? null;
      material.internalNotes = row.internal_notes ?? null;
    }
    return material;
  });
}

const SORTS = {
  sortOrder: "cat.sort_order, m.sort_order, m.created_at",
  updated: "m.updated_at DESC",
  created: "m.created_at DESC",
  due: "COALESCE(pd.planned_date, m.due_date) IS NULL, COALESCE(pd.planned_date, m.due_date), pd.planned_time, m.created_at",
  planned: "pd.planned_date IS NULL, pd.planned_date, pd.planned_time, m.sort_order",
  title: "m.title COLLATE utf8mb4_0900_ai_ci",
  released: "m.released_at IS NULL, m.released_at DESC",
};

const escapeLike = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * listMaterials(req, filters, { page, pageSize }) -> { items: Material[], total }
 * filters: brandId, clientId, projectId ('none' = no project), unassigned
 * (true = no project or contracted service), categoryId, categorySlug, area, kind,
 * visibility, approval, ownerId ('me' allowed), tag, q, archived (true | 'all'),
 * ids, variant, from, to (post planned_date), campaignId, network, format,
 * publication, sort (sortOrder|updated|created|due|planned|title|released).
 * List filters accept arrays or comma-separated strings. Without pageSize
 * every match is returned.
 */
export async function listMaterials(req, filters = {}, { page, pageSize } = {}) {
  const db = req.ctx.db;
  const staff = isStaff(req);
  const scope = scopeSql.materials(req, "m", "b");
  const where = [scope.sql];
  const params = [...scope.params];
  const eq = (column, value) => {
    if (value === undefined || value === null || value === "") return;
    where.push(`${column} = ?`);
    params.push(value);
  };
  const oneOf = (column, value) => {
    const list = queryList(value);
    if (!list.length) return;
    where.push(`${column} IN (${placeholders(list)})`);
    params.push(...list);
  };

  eq("m.brand_id", filters.brandId);
  eq("b.client_id", filters.clientId);
  const unassigned = [true, 1, "1", "true"].includes(filters.unassigned);
  if (filters.projectId === "none" || (unassigned && !filters.projectId)) where.push("m.project_id IS NULL");
  else eq("m.project_id", filters.projectId);
  eq("m.category_id", filters.categoryId);
  oneOf("cat.slug", filters.categorySlug);
  oneOf("cat.area", filters.area);
  oneOf("m.kind", filters.kind);
  if (staff) oneOf("m.visibility", filters.visibility);
  oneOf("m.approval_status", filters.approval);
  eq("m.owner_id", filters.ownerId === "me" ? req.user.id : filters.ownerId);
  oneOf("m.variant", filters.variant);
  oneOf("m.id", filters.ids);
  eq("pd.campaign_id", filters.campaignId);
  oneOf("pd.network", filters.network);
  oneOf("pd.format", filters.format);
  oneOf("pd.publication_status", filters.publication);
  if (filters.from) {
    where.push("pd.planned_date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("pd.planned_date <= ?");
    params.push(filters.to);
  }
  if (filters.tag) {
    where.push("JSON_CONTAINS(m.tags, JSON_QUOTE(?))");
    params.push(String(filters.tag));
  }
  if (filters.q && String(filters.q).trim()) {
    const like = `%${escapeLike(String(filters.q).trim())}%`;
    where.push(
      "(m.title LIKE ? COLLATE utf8mb4_0900_ai_ci OR IFNULL(m.description, '') LIKE ? COLLATE utf8mb4_0900_ai_ci OR m.tags LIKE ? COLLATE utf8mb4_0900_ai_ci OR IFNULL(cmp.name, '') LIKE ? COLLATE utf8mb4_0900_ai_ci)",
    );
    params.push(like, like, like, like);
  }
  const archived = filters.archived;
  if (staff) {
    if (archived === "all") {
      // no filter
    } else if (archived === true || archived === "1" || archived === "true" || archived === 1) {
      where.push("m.archived_at IS NOT NULL");
    } else {
      where.push("m.archived_at IS NULL");
    }
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await db.get(`SELECT COUNT(*) AS n ${MATERIAL_FROM} ${whereSql}`, params)).n;
  const order = SORTS[filters.sort] ?? SORTS.sortOrder;
  let sql = `${MATERIAL_SELECT} ${whereSql} ORDER BY ${order}, m.id`;
  const listParams = [...params];
  if (pageSize) {
    const size = Math.max(1, Number(pageSize));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;
    sql += " LIMIT ? OFFSET ?";
    listParams.push(size, offset);
  }
  const rows = await db.all(sql, listParams);
  return { items: await serializeMaterials(req, rows), total };
}

// Loads full MATERIAL_SELECT rows by id (no access check — use after assert*).
export async function loadMaterialRows(db, ids) {
  return await selectIn(db, `${MATERIAL_SELECT} WHERE m.id IN (?)`, ids);
}

// MaterialDetail = Material & { versions, permissions }
export async function getMaterialDetail(req, id) {
  const db = req.ctx.db;
  await assertMaterial(req, id);
  const row = await db.get(`${MATERIAL_SELECT} WHERE m.id = ?`, [id]);
  if (!row) throw notFound();
  const [material] = await serializeMaterials(req, [row]);
  const staff = isStaff(req);
  const client = req.user.role === "client";

  const versionRows = await db.all(
    `${VERSION_SELECT} WHERE v.material_id = ? ${client ? "AND v.released_at IS NOT NULL" : ""} ORDER BY v.number DESC`,
    [id],
  );
  const fileRows = (await db.all("SELECT * FROM material_files WHERE material_id = ?", [id])).filter(
    (file) => !client || clientCanSeeFile(file, row),
  );
  const renditions = await loadRenditions(db, fileRows.map((f) => f.id));
  const byVersion = new Map();
  for (const file of fileRows) {
    if (!byVersion.has(file.version_id)) byVersion.set(file.version_id, []);
    byVersion.get(file.version_id).push(file);
  }
  material.versions = await Promise.all(versionRows.map((v) => serializeVersion(req, v, byVersion.get(v.id) ?? [], renditions, row)));

  const writable = staff && await canWriteMaterial(req, row);
  const active = !row.archived_at;
  const releasable = staff && active && writable && can(req.user, "materials.release");
  if (staff) {
    const releasedFiles = row.released_version_id ? fileRows.filter((f) => f.version_id === row.released_version_id) : [];
    // finals attached after the release that the client cannot see yet
    material.pendingDeliveryCount = releasedFiles.filter((f) => f.role === "final" && !isPublished(f)).length;
    // delivered as the released originals (no final files): the team can
    // mark it delivered (POST /api/materials/:id/deliver, mode 'originals')
    material.deliverableWithoutFinals =
      row.visibility === "released" &&
      !row.delivered_at &&
      !releasedFiles.some((f) => f.role === "final") &&
      releasedFiles.some((f) => f.role === "original");
  }
  material.permissions = {
    canEdit: writable && active && can(req.user, "materials.edit"),
    canRelease: releasable,
    canDeliver: releasable && row.visibility === "released" && Boolean(row.released_version_id),
    canArchive: writable && can(req.user, "materials.archive"),
    canApprove:
      client &&
      bool(row.requires_approval) &&
      row.approval_status === "pending" &&
      Boolean(row.released_version_id),
    canComment: client || can(req.user, "materials.view") || can(req.user, "content.view"),
    canCommentInternal: can(req.user, "comments.internal"),
    canDownload: client ? bool(row.download_enabled) : true,
    canUploadVersion: writable && active && can(req.user, "materials.upload"),
  };
  return material;
}

// ------------------------------------------------------------- writes

const VARIANTS = new Set(["principal", "secundaria", "simbolo", "clara", "escura", "monocromatica"]);
const PREVIEW_BGS = new Set(["auto", "light", "dark", "checker"]);
const NETWORKS = new Set(["instagram", "facebook", "linkedin", "tiktok", "youtube", "x", "pinterest", "whatsapp", "outro"]);
const POST_FORMATS = new Set(["estatico", "carrossel", "stories", "reels", "video", "outro"]);
const FILE_ROLES = new Set(["original", "final", "editable", "cover"]);

const text = (value) => (value === undefined || value === null ? null : String(value).trim() || null);

async function resolveCategory(db, input) {
  const row = input.categoryId
    ? await db.get("SELECT * FROM categories WHERE id = ?", [input.categoryId])
    : input.categorySlug
      ? await db.get("SELECT * FROM categories WHERE slug = ?", [input.categorySlug])
      : null;
  if (!row || row.archived_at) throw validation({ categoryId: "Escolha uma categoria ativa." });
  return row;
}

export const OWNER_OUT_OF_SCOPE = "Escolha alguém da equipe com acesso a este cliente.";

/**
 * assertAssignableOwner(req, target, userId, field = 'ownerId') -> { id, name, role }.
 * target: { clientId, brandId } or a material row (client_id, brand_id). The responsible person of a material gets read and
 * write access to it (lib/access.js), so only staff who already work on that
 * client qualify: an admin, a manager with staff_client_access to the client,
 * or a designer who is a member of a project of the material's brand.
 * Anybody else -> 422 on `field`.
 */
export async function assertAssignableOwner(req, target, userId, field = "ownerId") {
  const { db } = req.ctx;
  const clientId = target?.clientId ?? target?.client_id ?? null;
  const brandId = target?.brandId ?? target?.brand_id ?? null;
  const user = userId
    ? await db.get("SELECT id, name, role FROM users WHERE id = ? AND role != 'client' AND status = 'active'", [userId])
    : null;
  if (!user) throw validation({ [field]: "Escolha alguém da equipe." });
  let allowed = false;
  if (user.role === "admin") allowed = true;
  else if (user.role === "manager")
    allowed = Boolean(clientId && await db.get("SELECT 1 FROM staff_client_access WHERE user_id = ? AND client_id = ?", [user.id, clientId]));
  else if (user.role === "designer")
    allowed = Boolean(
      brandId &&
        await db.get(
          `SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
            WHERE pm.user_id = ? AND p.brand_id = ? LIMIT 1`,
          [user.id, brandId],
        ),
    );
  if (!allowed) throw validation({ [field]: OWNER_OUT_OF_SCOPE });
  return user;
}

/**
 * createMaterial(req, input) -> materialId. Creates the material as a draft
 * (visibility 'draft'), post_details when kind = 'post', version 1 'draft'
 * and attaches the uploads. Designers must use a project they belong to.
 */
export async function createMaterial(req, input) {
  const { db } = req.ctx;
  const user = req.user;
  const kind = input.kind === "post" ? "post" : "asset";
  const brand = await assertBrand(req, input.brandId);
  if (brand.status !== "active") throw validation({ brandId: "Esta marca está arquivada." });

  let project = null;
  if (input.projectId) {
    project = await assertProject(req, input.projectId);
    if (project.brand_id !== brand.id) throw validation({ projectId: "O projeto precisa ser da mesma marca." });
  } else if (user.role === "designer") {
    throw validation({ projectId: "Selecione um dos seus projetos." });
  }
  const category = await resolveCategory(db, input);
  const title = text(input.title);
  if (!title) throw validation({ title: "Dê um título ao material." });
  const ownerId = input.ownerId ?? user.id;
  if (input.ownerId && input.ownerId !== user.id)
    await assertAssignableOwner(req, { clientId: brand.client_id, brandId: brand.id }, ownerId);
  if (input.variant && !VARIANTS.has(input.variant)) throw validation({ variant: "Variação inválida." });
  if (input.previewBg && !PREVIEW_BGS.has(input.previewBg)) throw validation({ previewBg: "Fundo inválido." });

  let post = null;
  if (kind === "post") {
    const source = input.post ?? input;
    post = {
      network: source.network,
      format: source.format,
      plannedDate: source.plannedDate ?? null,
      plannedTime: source.plannedTime ?? null,
      campaignId: source.campaignId ?? null,
    };
    const fields = {};
    if (!NETWORKS.has(post.network)) fields.network = "Escolha a rede social.";
    if (!POST_FORMATS.has(post.format)) fields.format = "Escolha o formato.";
    if (post.campaignId) {
      const campaign = await db.get("SELECT brand_id FROM campaigns WHERE id = ?", [post.campaignId]);
      if (!campaign || campaign.brand_id !== brand.id) fields.campaignId = "Campanha não encontrada nesta marca.";
    }
    if (Object.keys(fields).length) throw validation(fields);
  }

  const id = newId("mat");
  const versionId = newId("ver");
  const at = now();
  const editableIncluded =
    input.editableIncluded === undefined ? (project ? project.includes_editables : 0) : input.editableIncluded ? 1 : 0;
  const nextSort =
    input.sortOrder ??
    ((await db.get("SELECT MAX(sort_order) AS n FROM materials WHERE brand_id = ? AND category_id = ?", [brand.id, category.id]))?.n ?? 0) + 10;

  await db.tx(async () => {
    await db.run(
      `INSERT INTO materials (id, kind, brand_id, project_id, category_id, title, description, tags, owner_id,
         variant, preview_bg, sort_order, visibility, download_enabled, editable_included, requires_approval,
         approval_status, current_version_id, due_date, internal_notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, 'none', NULL, ?, ?, ?, ?, ?)`,
      [
        id,
        kind,
        brand.id,
        project?.id ?? null,
        category.id,
        title,
        text(input.description),
        JSON.stringify(Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : []),
        ownerId,
        input.variant ?? null,
        input.previewBg ?? "auto",
        nextSort,
        input.downloadEnabled === false ? 0 : 1,
        editableIncluded,
        input.requiresApproval === false ? 0 : 1,
        input.dueDate ?? null,
        text(input.internalNotes),
        user.id,
        at,
        at,
      ],
    );
    if (post) {
      await db.run(
        `INSERT INTO post_details (material_id, campaign_id, network, format, planned_date, planned_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, post.campaignId, post.network, post.format, post.plannedDate, post.plannedTime],
      );
    }
    await db.run(
      `INSERT INTO material_versions (id, material_id, number, status, caption, hashtags, notes, change_summary, created_by, created_at)
       VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?)`,
      [versionId, id, text(input.caption), text(input.hashtags), text(input.notes), text(input.changeSummary), user.id, at],
    );
    await db.run("UPDATE materials SET current_version_id = ? WHERE id = ?", [versionId, id]);
    if (input.files?.length) await attachUploads(req, { materialId: id, versionId, files: input.files });
    await logActivity(req, {
      action: "material.created",
      entityType: "material",
      entityId: id,
      materialId: id,
      brandId: brand.id,
      clientId: brand.client_id,
      projectId: project?.id ?? null,
      summary: `${user.name} criou o material “${title}” como rascunho.`,
      data: { kind, categoryId: category.id, versionId, files: input.files?.length ?? 0 },
    });
  });
  return id;
}

/**
 * createVersion(req, materialId, input) -> versionId. New draft version
 * (number = max + 1); earlier versions stay untouched. input: { files,
 * copyFrom: 'current', caption, hashtags, notes, changeSummary }. copyFrom
 * copies the current version's originals, editables and cover — never its
 * final files. Refused (409) while the current version was never released.
 */
export async function createVersion(req, materialId, input = {}) {
  const { db } = req.ctx;
  const material = await assertMaterial(req, materialId, { write: true });
  if (material.archived_at) throw conflict("Material arquivado. Desarquive para enviar uma nova versão.");
  const current = material.current_version_id
    ? await db.get("SELECT * FROM material_versions WHERE id = ?", [material.current_version_id])
    : null;
  if (current && (current.status === "draft" || current.status === "internal_review"))
    throw conflict("A versão atual ainda não foi liberada. Atualize os arquivos dela antes de criar outra.");

  const versionId = newId("ver");
  const at = now();
  await db.tx(async () => {
    const number = ((await db.get("SELECT MAX(number) AS n FROM material_versions WHERE material_id = ?", [material.id]))?.n ?? 0) + 1;
    await db.run(
      `INSERT INTO material_versions (id, material_id, number, status, caption, hashtags, notes, change_summary, created_by, created_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      [
        versionId,
        material.id,
        number,
        input.caption === undefined ? current?.caption ?? null : text(input.caption),
        input.hashtags === undefined ? current?.hashtags ?? null : text(input.hashtags),
        text(input.notes),
        text(input.changeSummary),
        req.user.id,
        at,
      ],
    );
    if (input.copyFrom === "current" && current) {
      // Final files belong to the version the client approved and are
      // delivered after that approval; a new version starts from the working
      // files (originals, editables, cover) and gets its own finals later.
      const files = await db.all("SELECT * FROM material_files WHERE version_id = ? AND role != 'final'", [current.id]);
      const jobs = req.ctx.jobs;
      for (const file of files) {
        const fileId = newId("fil");
        await db.run(
          `INSERT INTO material_files (id, version_id, material_id, role, position, original_name, display_name, ext, mime,
             size_bytes, sha256, storage_key, media_kind, width, height, duration_ms, preview_status, font_distributable,
             created_by, created_at)
           SELECT ?, ?, material_id, role, position, original_name, display_name, ext, mime, size_bytes, sha256,
             storage_key, media_kind, width, height, duration_ms, preview_status, font_distributable, ?, ?
           FROM material_files WHERE id = ?`,
          [fileId, versionId, req.user.id, at, file.id],
        );
        await db.run(
          `INSERT INTO file_renditions (file_id, kind, storage_key, mime, width, height, size_bytes, created_at)
           SELECT ?, kind, storage_key, mime, width, height, size_bytes, ? FROM file_renditions WHERE file_id = ?`,
          [fileId, at, file.id],
        );
        // previews still being generated for the source: generate (or reuse) them for the copy too
        if (file.preview_status === "pending" && jobs) db.afterCommit(() => jobs.enqueue("renditions", { fileId }));
      }
      await enforceFontLicence(db, material.id, versionId);
    }
    await db.run("UPDATE materials SET current_version_id = ?, updated_at = ? WHERE id = ?", [versionId, at, material.id]);
    if (input.files?.length) await attachUploads(req, { materialId: material.id, versionId, files: input.files });
    await logActivity(req, {
      action: "version.created",
      entityType: "version",
      entityId: versionId,
      materialId: material.id,
      summary: `${req.user.name} criou a versão ${number} de “${material.title}”.`,
      data: { number, copyFrom: input.copyFrom ?? null, files: input.files?.length ?? 0 },
    });
  });
  return versionId;
}

/**
 * Copied font files keep their flag unless the material is linked to brand
 * fonts and none of them is released with distribution allowed: then they
 * are not distributable (the licence only reaches the client through a
 * released font entry).
 */
async function enforceFontLicence(db, materialId, versionId) {
  const fonts = await db.get(
    `SELECT COUNT(*) AS linked, SUM(distribution = 'allowed' AND visibility = 'released') AS allowed
       FROM brand_fonts WHERE material_id = ?`,
    [materialId],
  );
  if (fonts.linked > 0 && !fonts.allowed)
    await db.run("UPDATE material_files SET font_distributable = 0 WHERE version_id = ? AND media_kind = 'font' AND font_distributable = 1", [
      versionId,
    ]);
}

/**
 * attachUploads(req, { materialId, versionId, files: [{ uploadId, role, position }], published })
 * -> fileIds. Uploads must belong to req.user and still be 'uploaded'. The
 * material file reuses the upload's storage key; renditions are enqueued
 * after the transaction commits. published: false keeps the new files away
 * from the client until they are delivered (finals added after a release).
 */
export async function attachUploads(req, { materialId, versionId, files, published = true }) {
  const { db } = req.ctx;
  if (!Array.isArray(files) || !files.length) return [];
  const version = await db.get("SELECT * FROM material_versions WHERE id = ? AND material_id = ?", [versionId, materialId]);
  if (!version) throw notFound();
  const fontAllowed = await db.get(
    // Only a RELEASED font entry can open the file (same rule as brandlib's
    // syncFontDistribution and enforceFontLicence for version copies).
    "SELECT 1 AS ok FROM brand_fonts WHERE material_id = ? AND distribution = 'allowed' AND visibility = 'released' LIMIT 1",
    [materialId],
  )
    ? 1
    : 0;

  const fields = {};
  const uploads = [];
  for (const [index, item] of files.entries()) {
    const role = item.role ?? "original";
    if (!FILE_ROLES.has(role)) fields[`files.${index}.role`] = "Tipo de arquivo inválido.";
    const upload = item.uploadId
      ? await db.get("SELECT * FROM uploads WHERE id = ? AND user_id = ? AND status = 'uploaded'", [item.uploadId, req.user.id])
      : null;
    if (!upload) fields[`files.${index}.uploadId`] = "Envio não encontrado ou já utilizado. Envie o arquivo de novo.";
    else if (role === "cover" && upload.media_kind !== "image")
      fields[`files.${index}.role`] = "A capa precisa ser uma imagem (PNG, JPG ou WEBP).";
    uploads.push({ item, role, upload });
  }
  const seen = new Set();
  uploads.forEach(({ item }, index) => {
    if (seen.has(item.uploadId)) fields[`files.${index}.uploadId`] = "Arquivo repetido.";
    seen.add(item.uploadId);
  });
  if (Object.keys(fields).length) throw validation(fields, "Revise os arquivos enviados.");

  const at = now();
  const ids = [];
  await db.tx(async () => {
    for (const { item, role, upload } of uploads) {
      const position =
        Number.isInteger(item.position) && item.position > 0
          ? item.position
          : ((await db.get("SELECT MAX(position) AS n FROM material_files WHERE version_id = ? AND role = ?", [versionId, role]))?.n ?? 0) + 1;
      const fileId = newId("fil");
      await db.run(
        `INSERT INTO material_files (id, version_id, material_id, role, position, original_name, display_name, ext, mime,
           size_bytes, sha256, storage_key, media_kind, width, height, duration_ms, preview_status, font_distributable,
           created_by, created_at, published)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fileId,
          versionId,
          materialId,
          role,
          position,
          upload.original_name,
          upload.original_name,
          upload.ext,
          upload.mime,
          upload.size_bytes,
          upload.sha256,
          upload.storage_key,
          upload.media_kind,
          upload.width,
          upload.height,
          upload.duration_ms,
          PREVIEWABLE_KINDS.has(upload.media_kind) ? "pending" : "unsupported",
          upload.media_kind === "font" ? fontAllowed : null,
          req.user.id,
          at,
          published ? 1 : 0,
        ],
      );
      await db.run("UPDATE uploads SET status = 'attached', attached_at = ? WHERE id = ?", [at, upload.id]);
      ids.push(fileId);
    }
    await db.run("UPDATE materials SET updated_at = ? WHERE id = ?", [at, materialId]);
  });
  const jobs = req.ctx.jobs;
  if (jobs) db.afterCommit(() => ids.forEach((fileId) => jobs.enqueue("renditions", { fileId })));
  return ids;
}

// ------------------------------------------------------------- ZIP layout

const AREA_FOLDERS = { identity: "Identidade visual", content: "Conteúdo", other: "Materiais" };
const EDITABLES_FOLDER = "Editáveis";
const pad2 = (n) => String(n).padStart(2, "0");

// Dates people read in ZIP names and folders follow the Metta calendar
// (São Paulo), not UTC: 23:30 BRT on 28/09 is still "2026-09-28".
const LOCAL_TIME_ZONE = "America/Sao_Paulo";
const localDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: LOCAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * localDay(value) -> "AAAA-MM-DD" in America/Sao_Paulo. Accepts a Date or an
 * ISO timestamp; a plain "AAAA-MM-DD" (already a calendar date, e.g.
 * post_details.planned_date) is kept as is. -> null when unreadable.
 */
export function localDay(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(localDayFormat.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// "Nome (2).png" for the second entry that would land on the same path.
function uniquePath(taken, path) {
  let candidate = path;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * zipEntries(req, rows, { layout, root, includeEditables }) -> entries
 * Builds the ZIP layout of docs/PLATFORM.md §5 for material rows already
 * resolved through the viewer's scope (MATERIAL_SELECT rows, e.g. from
 * loadMaterialRows after assert*). Per material it takes the visible version
 * (client: released; staff: current, else released), its final files when
 * any exist (otherwise originals) and, with includeEditables, the editables
 * the viewer may see. Covers never enter; for clients only downloadable files
 * do (download_enabled, font licence).
 *   layout 'library'  <root>/Identidade visual/<pasta>/<FORMATO>/<arquivo>,
 *                     <root>/Conteúdo/<AAAA-MM>/<Campanha>/<título>/NN-<arquivo>,
 *                     <root>/Conteúdo/<pasta>/<arquivo>, <root>/Materiais/<pasta>/<arquivo>
 *   layout 'carousel' <root>/NN-<arquivo> in slide order (one material)
 * root defaults to the brand name. Entries: { fileId, materialId, versionId,
 * storageKey, path, sizeBytes, ext, role, store } in order; storageKey stays
 * on the server. `store` marks formats that are already compressed.
 */
export async function zipEntries(req, rows, { layout = "library", root, includeEditables = true, fileIds = null } = {}) {
  if (!rows.length) return [];
  const db = req.ctx.db;
  const client = req.user.role === "client";
  const versionIdOf = (row) => (client ? row.released_version_id : row.current_version_id ?? row.released_version_id);
  // selection mode: exactly the chosen files (already authorised with
  // assertFile(..., { download: true })), whatever version they belong to
  const selected = fileIds ? new Set(fileIds) : null;
  const byVersion = new Map();
  const fileRows = selected
    ? await selectIn(db, "SELECT * FROM material_files WHERE id IN (?)", [...selected])
    : await selectIn(db, "SELECT * FROM material_files WHERE version_id IN (?)", rows.map(versionIdOf));
  for (const file of fileRows) {
    const key = selected ? file.material_id : file.version_id;
    if (!byVersion.has(key)) byVersion.set(key, []);
    byVersion.get(key).push(file);
  }

  // Stable order (category, date, manual order) so names and " (2)" suffixes
  // do not depend on how the caller loaded the rows.
  const ordered = [...rows].sort(
    (a, b) =>
      (a.cat_sort_order ?? 0) - (b.cat_sort_order ?? 0) ||
      String(a.pd_planned_date ?? "").localeCompare(String(b.pd_planned_date ?? "")) ||
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      String(a.created_at).localeCompare(String(b.created_at)) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const taken = new Set();
  const entries = [];
  for (const row of ordered) {
    const versionId = versionIdOf(row);
    let files = sortFiles(byVersion.get(selected ? row.id : versionId) ?? []);
    if (!selected || client) files = files.filter((f) => f.role !== "cover");
    if (client) files = files.filter((f) => clientCanSeeFile(f, row) && downloadRule(req.user, f, row).ok);
    let main;
    let editables;
    if (selected) {
      main = files.filter((f) => f.role !== "editable");
      editables = files.filter((f) => f.role === "editable");
    } else {
      const finals = files.filter((f) => f.role === "final");
      main = finals.length ? finals : files.filter((f) => f.role === "original");
      editables = includeEditables ? files.filter((f) => f.role === "editable") : [];
    }

    const base = safeSegment(root ?? row.brand_name, "Marca");
    const folder = safeSegment(row.cat_folder ?? row.cat_name, "Outros");
    const area = row.cat_area;
    let dir;
    let numbered = false;
    let byFormat = false;
    if (layout === "carousel") {
      dir = base;
      numbered = true;
    } else if (area === "content" && row.kind === "post") {
      const month = (localDay(row.pd_planned_date ?? row.released_at ?? row.created_at) ?? "").slice(0, 7) || "Sem data";
      dir = [base, AREA_FOLDERS.content, month, safeSegment(row.campaign_name, "Sem campanha"), safeSegment(row.title)].join("/");
      numbered = true;
    } else if (area === "identity") {
      dir = [base, AREA_FOLDERS.identity, folder].join("/");
      byFormat = true;
    } else {
      dir = [base, AREA_FOLDERS[area] ?? AREA_FOLDERS.other, folder].join("/");
    }

    const push = (file, path) =>
      entries.push({
        fileId: file.id,
        materialId: row.id,
        versionId: file.version_id ?? versionId,
        storageKey: file.storage_key,
        path: uniquePath(taken, path),
        sizeBytes: file.size_bytes ?? 0,
        ext: file.ext,
        role: file.role,
        store: COMPRESSED_EXTS.has(String(file.ext).toLowerCase()),
      });
    main.forEach((file, index) => {
      const name = sanitizeFilename(file.display_name ?? file.original_name);
      if (numbered) push(file, `${dir}/${pad2(index + 1)}-${name}`);
      else if (byFormat) push(file, `${dir}/${safeSegment(formatLabel(file.ext || extOf(name)), "Outros")}/${name}`);
      else push(file, `${dir}/${name}`);
    });
    for (const file of editables)
      push(file, `${dir}/${EDITABLES_FOLDER}/${sanitizeFilename(file.display_name ?? file.original_name)}`);
  }
  return entries;
}

const slugify = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

// "<marca>-<escopo>-AAAA-MM-DD.zip", e.g. zipFilename("Aurora", "Kit de marca").
// The date is the São Paulo calendar day (see localDay).
export function zipFilename(brandName, scopeLabel, date = new Date()) {
  const day = localDay(date) ?? localDay(new Date());
  return `${[slugify(brandName) || "metta", slugify(scopeLabel)].filter(Boolean).join("-")}-${day}.zip`;
}

/**
 * Removes a stored object only when nothing references it any more
 * (material files, copies across versions, uploads, renditions, ZIPs).
 */
export async function removeStorageIfUnreferenced(ctx, key) {
  if (!key) return false;
  const { db } = ctx;
  const used =
    await db.get("SELECT 1 FROM material_files WHERE storage_key = ? LIMIT 1", [key]) ||
    await db.get("SELECT 1 FROM uploads WHERE storage_key = ? AND status != 'discarded' LIMIT 1", [key]) ||
    await db.get("SELECT 1 FROM file_renditions WHERE storage_key = ? LIMIT 1", [key]) ||
    await db.get("SELECT 1 FROM zip_jobs WHERE storage_key = ? LIMIT 1", [key]) ||
    await db.get("SELECT 1 FROM contracts WHERE ? IN (document_key, signed_key, evidence_key) LIMIT 1", [key]);
  if (used) return false;
  await ctx.storage.remove(key);
  return true;
}

/**
 * Frees stored objects after material files were removed: attached upload
 * rows pointing at a key no file uses any more become 'discarded', then the
 * object goes away when nothing else references it. Never throws.
 */
export async function releaseStorageKeys(ctx, keys) {
  for (const key of new Set((keys ?? []).filter(Boolean))) {
    try {
      if (!await ctx.db.get("SELECT 1 FROM material_files WHERE storage_key = ? LIMIT 1", [key]))
        await ctx.db.run("UPDATE uploads SET status = 'discarded' WHERE storage_key = ? AND status = 'attached'", [key]);
      await removeStorageIfUnreferenced(ctx, key);
    } catch (err) {
      ctx.log?.warn?.(`[storage] could not remove an object: ${err.message}`);
    }
  }
}

export const STALE_UPLOAD_HOURS = 48;

/**
 * Discards uploads never attached to a material after STALE_UPLOAD_HOURS and
 * frees their stored objects. -> number of uploads discarded.
 */
export async function cleanupStaleUploads(ctx, { olderThanHours = STALE_UPLOAD_HOURS } = {}) {
  const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000).toISOString();
  const rows = await ctx.db.all("SELECT id, storage_key FROM uploads WHERE status = 'uploaded' AND created_at < ?", [cutoff]);
  for (const row of rows) {
    await ctx.db.run("UPDATE uploads SET status = 'discarded' WHERE id = ? AND status = 'uploaded'", [row.id]);
    try {
      await removeStorageIfUnreferenced(ctx, row.storage_key);
    } catch (err) {
      ctx.log?.warn?.(`[uploads] could not remove a stale upload: ${err.message}`);
    }
  }
  return rows.length;
}

// ------------------------------------------------------- links & notices

// Where the client opens a material: posts in the content hub, assets in files.
export const clientMaterialLink = (row) =>
  row.kind === "post" ? `/painel/conteudo/${row.id}` : `/painel/arquivos?material=${row.id}`;
export const staffMaterialLink = (row) =>
  row.kind === "post" ? `/admin/conteudo/${row.id}` : `/admin/biblioteca/${row.id}`;

/**
 * sendNotice(req, userIds, payload, { app, email }) — in-app notification
 * when app (plus e-mail when email), or e-mail only when !app && email.
 * payload follows lib/notify.js.
 */
export async function sendNotice(req, userIds, payload, { app = true, email = false } = {}) {
  if (app) return await notify(req, userIds, { ...payload, email: Boolean(email) });
  if (!email) return [];
  const { db, mailer, config } = req.ctx;
  const ids = [...new Set((userIds ?? []).filter(Boolean))].filter((id) => payload.includeSelf || id !== req.user?.id);
  if (!ids.length || !mailer) return [];
  const users = await db.all(
    `SELECT id, email FROM users WHERE id IN (${placeholders(ids)}) AND status = 'active' AND notify_email = 1`,
    ids,
  );
  const actionUrl = payload.link ? `${config.appUrl}${payload.link}` : null;
  for (const user of users) {
    const message = renderEmail({
      title: payload.title,
      intro: payload.body ?? null,
      lines: payload.emailLines ?? [],
      actionLabel: payload.actionLabel ?? "Abrir na plataforma",
      actionUrl,
    });
    // recorded now (inside the caller's transaction); delivered after the commit
    await mailer.enqueue({ to: user.email, toUserId: user.id, ...message });
  }
  return [];
}

// ------------------------------------------------------------------ kits

// Kit row plus brand/client/project names. Aliases: k, b, cl, p.
export const KIT_SELECT = `SELECT k.*, b.client_id AS client_id, b.name AS brand_name, b.slug AS brand_slug,
  cl.name AS client_name, p.name AS project_name
  FROM kits k
  JOIN brands b ON b.id = k.brand_id
  JOIN clients cl ON cl.id = b.client_id
  LEFT JOIN projects p ON p.id = k.project_id`;

// Scope-level write check for kits (capabilities are checked by the route).
export async function canWriteKit(req, kit) {
  const scope = await getScope(req);
  const user = req.user;
  if (!kit || !scope.materials || user.role === "client" || user.role === "finance") return false;
  if (scope.all) return true;
  if (user.role === "manager") return scope.clientIds.has(kit.client_id);
  if (user.role === "designer")
    return Boolean(kit.project_id && scope.projectIds.has(kit.project_id)) || kit.created_by === user.id;
  return false;
}

/**
 * assertKit(req, id, { write }) -> KIT_SELECT row. Staff: the kit's brand in
 * scope. Clients: only released kits of their own client. Out of scope ->
 * 404; visible but not writable -> 403.
 */
export async function assertKit(req, id, { write = false } = {}) {
  const scope = await getScope(req);
  const kit = id ? await req.ctx.db.get(`${KIT_SELECT} WHERE k.id = ?`, [id]) : null;
  if (!kit || !scope.materials) throw notFound();
  if (req.user.role === "client") {
    if (kit.client_id !== req.user.client_id || kit.status !== "released") throw notFound();
  } else {
    await assertBrand(req, kit.brand_id);
  }
  if (write && !await canWriteKit(req, kit)) throw forbidden();
  return kit;
}

// MATERIAL_SELECT rows of a kit, in kit order, limited to what the viewer may see.
export async function kitMaterialRows(req, kitId, { includeArchived = false } = {}) {
  const s = scopeSql.materials(req, "m", "b");
  return await req.ctx.db.all(
    `${MATERIAL_SELECT}
       JOIN kit_items ki ON ki.material_id = m.id
      WHERE ki.kit_id = ? AND ${s.sql} ${includeArchived ? "" : "AND m.archived_at IS NULL"}
      ORDER BY ki.sort_order, m.sort_order, m.id`,
    [kitId, ...s.params],
  );
}
// ------------------------------------------------------------- releases

const RELEASE_DENIED = "Somente gestores e administradores liberam materiais ao cliente.";
const quote = (title) => `“${title}”`;
const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * Final files of `version` that are copies of an older version's finals (the
 * same stored object). They were approved and delivered for that older
 * version, so they must not reach the client as this version's finals.
 * (New versions no longer copy finals; this guards versions created before.)
 */
async function inheritedFinals(db, version, files) {
  if (!version) return [];
  const inherited = [];
  for (const file of files) {
    if (file.role !== "final") continue;
    const older = await db.get(
      `SELECT 1 FROM material_files o JOIN material_versions ov ON ov.id = o.version_id
        WHERE o.material_id = ? AND o.role = 'final' AND o.storage_key = ? AND ov.number < ? LIMIT 1`,
      [version.material_id, file.storage_key, version.number],
    );
    if (older) inherited.push(file);
  }
  return inherited;
}

/**
 * Who a client notice reached -> { emailConfigured, appRecipients,
 * emailRecipients }. sent = whether a notice went out at all. Counts active
 * client users (in-app) and those of them with e-mail notices on (e-mail).
 * emailConfigured false means the e-mails were only recorded as not sent.
 */
export async function clientNoticeOutcome(req, clientId, { app = false, email = false, sent = true } = {}) {
  const { db, mailer } = req.ctx;
  const users =
    sent && (app || email) && clientId
      ? await db.all("SELECT notify_email FROM users WHERE role = 'client' AND client_id = ? AND status = 'active'", [clientId])
      : [];
  return {
    emailConfigured: Boolean(mailer?.isConfigured?.()),
    appRecipients: app ? users.length : 0,
    emailRecipients: email ? users.filter((user) => user.notify_email === 1).length : 0,
  };
}

/**
 * Shared by previewRelease and releaseMaterials. Resolves the materials (and
 * kit), checks scope/capability and computes what the client will get.
 * -> { summary (API shape), internal: [{ row, version, files, ... }], kit, brand }
 */
async function releasePlan(req, { materialIds = [], kitId = null } = {}) {
  const { db } = req.ctx;
  if (!can(req.user, "materials.release")) throw forbidden(RELEASE_DENIED);
  let kit = null;
  let ids = [...new Set((Array.isArray(materialIds) ? materialIds : []).filter(Boolean))];
  if (kitId) {
    kit = await assertKit(req, kitId);
    if (!await canWriteKit(req, kit)) throw forbidden(RELEASE_DENIED);
    const kitIds = (await db
      .all("SELECT material_id FROM kit_items WHERE kit_id = ? ORDER BY sort_order, seq", [kit.id]))
      .map((row) => row.material_id);
    ids = [...new Set([...kitIds, ...ids])];
  }
  if (!ids.length)
    throw validation({ materialIds: kit ? "Adicione materiais ao kit antes de liberar." : "Selecione pelo menos um material." });
  if (ids.length > 500) throw validation({ materialIds: "Libere no máximo 500 materiais por vez." });
  for (const id of ids) await assertMaterial(req, id, { write: true });
  const byId = new Map((await loadMaterialRows(db, ids)).map((row) => [row.id, row]));
  const rows = ids.map((id) => byId.get(id)).filter(Boolean);

  const blockers = [];
  const warnings = [];
  const brandIds = new Set(rows.map((row) => row.brand_id));
  if (kit) brandIds.add(kit.brand_id);
  if (brandIds.size > 1) blockers.push("Os materiais selecionados são de marcas diferentes. Libere uma marca por vez.");
  const brand = await db.get(
    `SELECT b.*, c.name AS client_name, c.status AS client_status
       FROM brands b JOIN clients c ON c.id = b.client_id WHERE b.id = ?`,
    [kit?.brand_id ?? rows[0].brand_id],
  );
  if (kit?.status === "archived") blockers.push(`O kit ${quote(kit.name)} está arquivado. Restaure-o antes de liberar.`);
  if (brand.status !== "active") blockers.push(`A marca ${brand.name} está arquivada.`);
  if (brand.client_status === "archived") blockers.push(`O cliente ${brand.client_name} está arquivado.`);
  else if (brand.client_status === "paused") warnings.push(`A conta de ${brand.client_name} está pausada.`);

  const versions = new Map(
    (await selectIn(db, "SELECT * FROM material_versions WHERE id IN (?)", rows.map((row) => row.current_version_id))).map((v) => [v.id, v]),
  );
  const filesByVersion = new Map();
  for (const file of await selectIn(db, "SELECT * FROM material_files WHERE version_id IN (?)", [...versions.keys()])) {
    if (!filesByVersion.has(file.version_id)) filesByVersion.set(file.version_id, []);
    filesByVersion.get(file.version_id).push(file);
  }
  const renditions = await loadRenditions(db, [...filesByVersion.values()].flat().map((f) => f.id));
  const serialized = new Map((await serializeMaterials(req, rows)).map((m) => [m.id, m]));
  const clientViewer = { role: "client" };

  // Inherited finals need a lookup per file: resolved before building the items.
  const inheritedByMaterial = new Map();
  for (const row of rows) {
    const version = versions.get(row.current_version_id) ?? null;
    if (version && !(version.released_at && row.released_version_id === version.id))
      inheritedByMaterial.set(row.id, await inheritedFinals(db, version, sortFiles(filesByVersion.get(version.id) ?? [])));
  }

  const internal = [];
  const items = rows.map((row) => {
    const title = quote(row.title);
    const itemWarnings = [];
    if (row.archived_at) blockers.push(`${title} está arquivado. Desarquive antes de liberar.`);
    const version = versions.get(row.current_version_id) ?? null;
    if (!version) blockers.push(`${title} ainda não tem uma versão para liberar.`);
    const files = sortFiles(version ? filesByVersion.get(version.id) ?? [] : []);
    const alreadyReleased = Boolean(version?.released_at && row.released_version_id === version.id);
    const isNewVersion = Boolean(row.released_version_id) && !alreadyReleased;
    const deliverable = files.filter((f) => f.role === "original" || f.role === "final");
    if (!deliverable.length) itemWarnings.push(`${title} está sem arquivos.`);
    if (alreadyReleased) itemWarnings.push(`${title} já está liberado na versão ${version.number}; nada muda para o cliente.`);
    else if (version?.status === "draft") itemWarnings.push(`${title}: a versão ${version.number} não passou pela revisão interna.`);
    const hiddenEditables = files.filter((f) => f.role === "editable").length;
    if (hiddenEditables && row.editable_included !== 1)
      itemWarnings.push(
        `${title}: ${plural(hiddenEditables, "o arquivo editável não fica visível", `${hiddenEditables} arquivos editáveis não ficam visíveis`)} (editáveis não incluídos no serviço).`,
      );
    if (files.some((f) => f.media_kind === "font" && f.font_distributable !== 1 && clientCanSeeFile(f, row)))
      itemWarnings.push(`${title}: a licença da fonte não permite distribuição; o cliente verá só a referência.`);
    if (row.download_enabled !== 1) itemWarnings.push(`${title}: download desativado — o cliente verá apenas a prévia.`);
    const inherited = alreadyReleased ? [] : (inheritedByMaterial.get(row.id) ?? []);
    if (inherited.length)
      itemWarnings.push(
        `${title}: a versão ${version.number} traz ${plural(inherited.length, "1 arquivo final copiado", `${inherited.length} arquivos finais copiados`)} de uma versão anterior. ${plural(inherited.length, "Ele fica oculto", "Eles ficam ocultos")} para o cliente até uma nova entrega, depois da aprovação; remova se não fizer parte desta versão.`,
      );
    const missingProject = !row.project_id;
    if (missingProject) itemWarnings.push(`${title}: sem projeto ou serviço vinculado.`);
    warnings.push(...itemWarnings);
    internal.push({ row, version, files, alreadyReleased, isNewVersion, inheritedFinalIds: inherited.map((f) => f.id) });
    return {
      material: serialized.get(row.id),
      version: version
        ? {
            id: version.id,
            number: version.number,
            status: version.status,
            createdAt: version.created_at,
            changeSummary: version.change_summary ?? null,
            releasedAt: version.released_at ?? null,
          }
        : null,
      files: files.map((file) => ({
        ...serializeFile(req, file, row, renditionsOf(renditions, file.id)),
        clientVisible: clientCanSeeFile(file, row),
        clientDownloadable: clientCanSeeFile(file, row) && downloadRule(clientViewer, file, row).ok,
      })),
      formats: sortFormats(new Set(deliverable.map((f) => formatLabel(f.ext)))),
      fileCount: deliverable.length,
      downloadEnabled: bool(row.download_enabled),
      editableIncluded: bool(row.editable_included),
      isNewVersion,
      requiresApproval: bool(row.requires_approval),
      alreadyReleased,
      missingProject,
      inheritedFinalCount: inherited.length,
      warnings: itemWarnings,
    };
  });
  if (!kit && items.every((item) => item.alreadyReleased))
    blockers.push("Os materiais selecionados já estão liberados nas versões atuais.");

  const recipients = (await db
    .all(
      "SELECT id, name, email, notify_email FROM users WHERE role = 'client' AND client_id = ? AND status = 'active' ORDER BY name",
      [brand.client_id],
    ))
    .map((user) => ({ id: user.id, name: user.name, email: user.email, notifyEmail: bool(user.notify_email) }));
  if (!recipients.length) warnings.push("O cliente ainda não tem usuários ativos: ninguém será notificado agora.");

  const toRelease = items.filter((item) => !item.alreadyReleased);
  return {
    kit,
    brand,
    internal,
    summary: {
      client: { id: brand.client_id, name: brand.client_name, status: brand.client_status },
      brand: { id: brand.id, name: brand.name, slug: brand.slug, clientId: brand.client_id },
      kit: kit ? { id: kit.id, name: kit.name, kind: kit.kind, status: kit.status } : null,
      recipients,
      // false: e-mails are only recorded as not sent (docs/PLATFORM.md §6)
      emailConfigured: Boolean(req.ctx.mailer?.isConfigured?.()),
      items,
      counts: {
        materials: items.length,
        toRelease: toRelease.length,
        newVersions: toRelease.filter((item) => item.isNewVersion).length,
        requiresApproval: toRelease.filter((item) => item.requiresApproval).length,
        files: items.reduce((sum, item) => sum + item.files.filter((f) => f.clientVisible && f.role !== "cover").length, 0),
      },
      warnings: [...new Set(warnings)],
      blockers: [...new Set(blockers)],
    },
  };
}

/**
 * previewRelease(req, { materialIds, kitId }) -> the summary shown before a
 * release: { client, brand, kit, recipients, emailConfigured, items, counts,
 * warnings, blockers }. Items flag missingProject and inheritedFinalCount.
 * Requires materials.release and write scope on every material (else 403/404).
 */
export async function previewRelease(req, input = {}) {
  return (await releasePlan(req, input)).summary;
}

function releaseNotice(plan, changed) {
  const { kit, brand } = plan;
  const titles = changed.map(({ row }) => row.title);
  const approvals = changed.filter(({ row }) => row.requires_approval === 1).length;
  let title;
  let link;
  let entityType;
  let entityId;
  if (kit) {
    title = `Kit ${quote(kit.name)} disponível`;
    link = `/painel/arquivos?kit=${kit.id}`;
    entityType = "kit";
    entityId = kit.id;
  } else if (changed.length === 1) {
    const [{ row, isNewVersion, version }] = changed;
    title = isNewVersion ? `Nova versão de ${quote(row.title)} (versão ${version.number})` : `Novo material: ${quote(row.title)}`;
    link = clientMaterialLink(row);
    entityType = "material";
    entityId = row.id;
  } else {
    title = `${changed.length} novos materiais disponíveis`;
    link = changed.every(({ row }) => row.kind === "post") ? "/painel/conteudo" : "/painel/arquivos";
    entityType = "brand";
    entityId = brand.id;
  }
  let body;
  if (!approvals) body = changed.length > 1 || kit ? "Os arquivos já estão na sua área Metta." : "O material já está na sua área Metta.";
  else if (changed.length === 1 && !kit) body = "Confira e aprove a versão apresentada.";
  else body = `${approvals} ${plural(approvals, "material aguarda", "materiais aguardam")} sua aprovação.`;
  const listed = titles.slice(0, 8).join(", ") + (titles.length > 8 ? ` e mais ${titles.length - 8}` : "");
  const emailLines = [["Marca", brand.name]];
  if (listed) emailLines.push([plural(titles.length, "Material", "Materiais"), listed]);
  return { title, link, entityType, entityId, body, emailLines };
}

/**
 * releaseMaterials(req, { materialIds, kitId, downloadEnabled, notifyEmail,
 * notifyApp, message }) -> { release, items, materials, emailConfigured,
 * appRecipients, emailRecipients } (see clientNoticeOutcome)
 * Atomic: current version -> released (previous released one -> superseded),
 * material visibility released, approval_status pending/none, download per
 * item ({[materialId]: bool} or one bool for all), releases + release_items,
 * client-visible history and notifications. 409 when the preview has blockers.
 */
export async function releaseMaterials(req, input = {}) {
  const { db } = req.ctx;
  const user = req.user;
  const plan = await releasePlan(req, input);
  const { summary, kit, brand } = plan;
  if (summary.blockers.length) throw conflict(summary.blockers.join(" "));

  const notifyApp = input.notifyApp !== false;
  const notifyEmail = Boolean(input.notifyEmail);
  const message = text(input.message);
  const overrides = input.downloadEnabled;
  const downloadFor = (row) => {
    let value = null;
    if (typeof overrides === "boolean") value = overrides;
    else if (overrides && typeof overrides === "object" && Object.hasOwn(overrides, row.id)) value = Boolean(overrides[row.id]);
    return value === null ? row.download_enabled : value ? 1 : 0;
  };

  const at = now();
  const releaseId = newId("rel");
  const changed = [];
  const items = [];
  let noticeSent = false;
  await db.tx(async () => {
    await db.run(
      `INSERT INTO releases (id, client_id, brand_id, kit_id, actor_id, message, notify_email, notify_app, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [releaseId, brand.client_id, brand.id, kit?.id ?? null, user.id, message, notifyEmail ? 1 : 0, notifyApp ? 1 : 0, at],
    );
    for (const entry of plan.internal) {
      const { row, version, files, alreadyReleased, isNewVersion, inheritedFinalIds } = entry;
      const downloadEnabled = downloadFor(row);
      if (!alreadyReleased) {
        if (row.released_version_id && row.released_version_id !== version.id)
          await db.run("UPDATE material_versions SET status = 'superseded' WHERE id = ?", [row.released_version_id]);
        await db.run("UPDATE material_versions SET status = 'released', released_at = ?, released_by = ? WHERE id = ?", [
          at,
          user.id,
          version.id,
        ]);
        // finals copied from an older version wait for an explicit delivery
        // of this version instead of reaching the client as its finals
        const inherited = new Set(inheritedFinalIds ?? []);
        for (const fileId of inherited) await db.run("UPDATE material_files SET published = 0 WHERE id = ?", [fileId]);
        const hasFinals = files.some((f) => f.role === "final" && isPublished(f) && !inherited.has(f.id));
        await db.run(
          `UPDATE materials SET visibility = 'released', released_version_id = ?, released_at = ?, released_by = ?,
             approval_status = ?, download_enabled = ?, delivered_at = ?, updated_at = ?
           WHERE id = ?`,
          [version.id, at, user.id, row.requires_approval === 1 ? "pending" : "none", downloadEnabled, hasFinals ? at : null, at, row.id],
        );
        await logActivity(req, {
          action: "material.released",
          entityType: "material",
          entityId: row.id,
          materialId: row.id,
          brandId: row.brand_id,
          clientId: row.client_id,
          projectId: row.project_id,
          visibility: "client",
          summary: isNewVersion
            ? `Versão ${version.number} de ${quote(row.title)} disponibilizada.`
            : `${quote(row.title)} disponibilizado.`,
          data: {
            releaseId,
            versionId: version.id,
            versionNumber: version.number,
            previousVersionId: row.released_version_id ?? null,
            downloadEnabled: downloadEnabled === 1,
            requiresApproval: row.requires_approval === 1,
          },
        });
        changed.push(entry);
      } else if (downloadEnabled !== row.download_enabled) {
        await db.run("UPDATE materials SET download_enabled = ?, updated_at = ? WHERE id = ?", [downloadEnabled, at, row.id]);
        await logActivity(req, {
          action: downloadEnabled ? "material.download_enabled" : "material.download_disabled",
          entityType: "material",
          entityId: row.id,
          materialId: row.id,
          brandId: row.brand_id,
          clientId: row.client_id,
          projectId: row.project_id,
          visibility: "client",
          summary: `${user.name} ${downloadEnabled ? "liberou" : "bloqueou"} o download de ${quote(row.title)}.`,
          data: { releaseId, downloadEnabled: downloadEnabled === 1 },
        });
      }
      await db.run("INSERT INTO release_items (release_id, material_id, version_id, download_enabled) VALUES (?, ?, ?, ?)", [
        releaseId,
        row.id,
        version.id,
        downloadEnabled,
      ]);
      items.push({
        materialId: row.id,
        versionId: version.id,
        versionNumber: version.number,
        downloadEnabled: downloadEnabled === 1,
        changed: !alreadyReleased,
      });
    }
    if (kit) {
      await db.run("UPDATE kits SET status = 'released', released_at = ?, released_by = ?, updated_at = ? WHERE id = ?", [
        at,
        user.id,
        at,
        kit.id,
      ]);
      await logActivity(req, {
        action: "kit.released",
        entityType: "kit",
        entityId: kit.id,
        brandId: kit.brand_id,
        clientId: kit.client_id,
        projectId: kit.project_id,
        visibility: "client",
        summary: `Kit ${quote(kit.name)} disponibilizado.`,
        data: { releaseId, materials: items.length },
      });
    }
    await logActivity(req, {
      action: "release.created",
      entityType: "release",
      entityId: releaseId,
      brandId: brand.id,
      clientId: brand.client_id,
      summary: `${user.name} liberou ${items.length} ${plural(items.length, "material", "materiais")} para ${brand.client_name}${kit ? ` (kit ${quote(kit.name)})` : ""}.`,
      data: { kitId: kit?.id ?? null, materialIds: items.map((i) => i.materialId), notifyEmail, notifyApp, message },
    });
    noticeSent = (notifyApp || notifyEmail) && Boolean(changed.length || kit);
    if (noticeSent) {
      const notice = releaseNotice(plan, changed);
      await sendNotice(
        req,
        await clientUserIds(db, brand.client_id),
        {
          type: kit ? "kit.released" : "material.released",
          title: notice.title,
          body: message ? `${notice.body} ${message}` : notice.body,
          link: notice.link,
          entityType: notice.entityType,
          entityId: notice.entityId,
          emailLines: message ? [message, ...notice.emailLines] : notice.emailLines,
          actionLabel: "Ver na plataforma",
        },
        { app: notifyApp, email: notifyEmail },
      );
    }
  });

  return {
    release: {
      id: releaseId,
      createdAt: at,
      client: { id: brand.client_id, name: brand.client_name },
      brand: { id: brand.id, name: brand.name },
      kit: kit ? { id: kit.id, name: kit.name } : null,
      actor: personRef(req, { id: user.id, name: user.name, role: user.role }),
      message,
      notifyEmail,
      notifyApp,
      itemCount: items.length,
      releasedCount: changed.length,
    },
    items,
    materials: await serializeMaterials(req, await loadMaterialRows(db, items.map((i) => i.materialId))),
    // who was told: the UI never claims an e-mail that was not sent
    ...await clientNoticeOutcome(req, brand.client_id, { app: notifyApp, email: notifyEmail, sent: noticeSent }),
  };
}

// ------------------------------------------------------------- delivery

/**
 * deliverMaterial(req, materialId, { notifyEmail, notifyApp, message, downloadEnabled })
 * Marks the released version as delivered (delivered_at), logs a
 * client-visible, attributed event and notifies the client.
 *   mode 'finals'    the released version has final files: those attached
 *                    after the release (published = 0) become visible.
 *   mode 'originals' no final files: the released originals are the
 *                    deliverable (most posts and many logos); nothing new
 *                    is published, the material is only marked delivered.
 * 409 when there is nothing to deliver or it was already delivered.
 * -> { mode, published, files, emailConfigured, appRecipients, emailRecipients }
 */
export async function deliverMaterial(req, materialId, input = {}) {
  const { db } = req.ctx;
  const user = req.user;
  if (!can(user, "materials.release")) throw forbidden("Somente gestores e administradores entregam arquivos ao cliente.");
  const material = await assertMaterial(req, materialId, { write: true });
  if (material.archived_at) throw conflict("Material arquivado. Desarquive antes de entregar.");
  if (material.visibility !== "released" || !material.released_version_id)
    throw conflict("Libere o material ao cliente antes de entregar os arquivos.");
  const files = await db.all(
    "SELECT * FROM material_files WHERE version_id = ? AND role IN ('final', 'original') ORDER BY role, position",
    [material.released_version_id],
  );
  const finals = files.filter((file) => file.role === "final");
  const originals = files.filter((file) => file.role === "original");
  if (!finals.length && !originals.length)
    throw conflict("A versão liberada não tem arquivos para entregar. Anexe os arquivos finais antes de entregar.");
  const mode = finals.length ? "finals" : "originals";
  const pending = finals.filter((file) => !isPublished(file));
  if (material.delivered_at && !pending.length)
    throw conflict(
      mode === "finals" ? "Os arquivos finais desta versão já foram entregues." : "Este material já está marcado como entregue.",
    );

  const version = await db.get("SELECT id, number FROM material_versions WHERE id = ?", [material.released_version_id]);
  const delivered = mode === "finals" ? finals : originals;
  const notifyApp = input.notifyApp !== false;
  const notifyEmail = input.notifyEmail !== false;
  const message = text(input.message);
  const downloadEnabled =
    input.downloadEnabled === undefined || input.downloadEnabled === null ? material.download_enabled : input.downloadEnabled ? 1 : 0;
  const at = now();
  await db.tx(async () => {
    for (const file of pending) await db.run("UPDATE material_files SET published = 1 WHERE id = ?", [file.id]);
    await db.run("UPDATE materials SET delivered_at = ?, download_enabled = ?, updated_at = ? WHERE id = ?", [
      at,
      downloadEnabled,
      at,
      material.id,
    ]);
    await logActivity(req, {
      action: "material.delivered",
      entityType: "material",
      entityId: material.id,
      materialId: material.id,
      brandId: material.brand_id,
      clientId: material.client_id,
      projectId: material.project_id,
      visibility: "client",
      summary:
        mode === "finals"
          ? `${user.name} entregou os arquivos finais de ${quote(material.title)}.`
          : `${user.name} marcou ${quote(material.title)} como entregue (versão ${version.number}).`,
      data: {
        mode,
        versionId: version.id,
        versionNumber: version.number,
        files: delivered.length,
        published: pending.length,
        downloadEnabled: downloadEnabled === 1,
      },
    });
    if (notifyApp || notifyEmail) {
      const ready = downloadEnabled === 1;
      await sendNotice(
        req,
        await clientUserIds(db, material.client_id),
        {
          type: "material.delivered",
          title: mode === "finals" ? `Arquivos finais de ${quote(material.title)}` : `${quote(material.title)} entregue`,
          body:
            message ??
            (mode === "finals"
              ? ready
                ? "Os arquivos finais já estão disponíveis para download."
                : "Os arquivos finais já estão na sua área Metta."
              : ready
                ? "Os arquivos já estão disponíveis para download."
                : "Os arquivos já estão na sua área Metta."),
          link: clientMaterialLink(material),
          entityType: "material",
          entityId: material.id,
          emailLines: [
            [
              mode === "finals" ? plural(delivered.length, "Arquivo final", "Arquivos finais") : plural(delivered.length, "Arquivo", "Arquivos"),
              String(delivered.length),
            ],
          ],
          actionLabel: "Ver arquivos",
        },
        { app: notifyApp, email: notifyEmail },
      );
    }
  });
  return {
    mode,
    published: pending.length,
    files: delivered.length,
    ...await clientNoticeOutcome(req, material.client_id, { app: notifyApp, email: notifyEmail }),
  };
}

// Earlier name of deliverMaterial (routes and slices import either).
export const deliverFinals = deliverMaterial;

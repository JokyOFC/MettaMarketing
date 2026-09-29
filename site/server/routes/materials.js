// Materials: list/detail/create/edit, versions and their files, internal
// review, primary logo per slot, ordering, bulk actions, archive, delivery of
// final files and history (docs/API.md, slice A).
import { Router } from "express";
import { assertFile, assertMaterial, assertProject, assertVersion } from "../lib/access.js";
import { ACTIVITY_SELECT, logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { conflict, forbidden, HttpError, validation } from "../lib/errors.js";
import { adminIds, managerIdsForClient, notify } from "../lib/notify.js";
import { can } from "../lib/permissions.js";
import { isStaff, personRef, serializeActivity } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { paginate, parse, schemas, z } from "../lib/validate.js";
import {
  assertAssignableOwner,
  attachUploads,
  createMaterial,
  createVersion,
  deliverMaterial,
  getMaterialDetail,
  isPublished,
  listMaterials,
  releaseStorageKeys,
  serializeVersion,
  staffMaterialLink,
} from "../services/materials.js";

const VIEW = ["materials.view", "portal.access"];
const ROLES = ["original", "final", "editable", "cover"];
const VARIANTS = ["principal", "secundaria", "simbolo", "clara", "escura", "monocromatica"];
const PREVIEW_BGS = ["auto", "light", "dark", "checker"];
const BULK_ACTIONS = ["archive", "unarchive", "submit", "enable_download", "disable_download", "set_category", "set_owner", "set_project"];

const id = z.string().trim().min(1, "Campo obrigatório.").max(64);
const fileItem = z.object({
  uploadId: id,
  role: z.enum(ROLES).default("original"),
  position: z.number().int().min(1).max(10000).optional(),
});
const files = z.array(fileItem).max(300, "Envie no máximo 300 arquivos por vez.");

const createSchema = z.object({
  kind: z.enum(["asset", "post"]).default("asset"),
  brandId: id,
  projectId: id.nullable().optional(),
  categoryId: id.optional(),
  categorySlug: z.string().trim().max(80).optional(),
  title: schemas.text(160),
  description: schemas.optionalText(4000),
  tags: schemas.tags.optional(),
  ownerId: id.nullable().optional(),
  variant: z.enum(VARIANTS).nullable().optional(),
  previewBg: z.enum(PREVIEW_BGS).optional(),
  dueDate: schemas.optionalDate,
  downloadEnabled: z.boolean().optional(),
  editableIncluded: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  internalNotes: schemas.optionalText(4000),
  files: files.default([]),
  caption: schemas.optionalText(5000),
  hashtags: schemas.optionalText(2000),
  notes: schemas.optionalText(4000),
  changeSummary: schemas.optionalText(1000),
  // post fields (kind = 'post')
  network: z.string().max(20).optional(),
  format: z.string().max(20).optional(),
  plannedDate: schemas.optionalDate,
  plannedTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Use o formato HH:MM.")
    .nullable()
    .optional(),
  campaignId: id.nullable().optional(),
});

const patchSchema = z.object({
  title: schemas.text(160).optional(),
  description: schemas.optionalText(4000),
  tags: schemas.tags.optional(),
  categoryId: id.optional(),
  projectId: id.nullable().optional(),
  ownerId: id.nullable().optional(),
  variant: z.enum(VARIANTS).nullable().optional(),
  previewBg: z.enum(PREVIEW_BGS).optional(),
  dueDate: schemas.optionalDate,
  downloadEnabled: z.boolean().optional(),
  editableIncluded: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  internalNotes: schemas.optionalText(4000),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

const versionCreateSchema = z.object({
  files: files.default([]),
  copyFrom: z.enum(["current"]).optional(),
  caption: schemas.optionalText(5000),
  hashtags: schemas.optionalText(2000),
  notes: schemas.optionalText(4000),
  changeSummary: schemas.optionalText(1000),
});

const versionPatchSchema = z.object({
  caption: schemas.optionalText(5000),
  hashtags: schemas.optionalText(2000),
  notes: schemas.optionalText(4000),
  changeSummary: schemas.optionalText(1000),
  files: z
    .array(z.object({ id, position: z.number().int().min(1).max(10000).optional(), role: z.enum(ROLES).optional() }))
    .max(1000)
    .optional(),
});

const deliverSchema = z.object({
  notifyEmail: z.boolean().optional(),
  notifyApp: z.boolean().optional(),
  message: schemas.optionalText(2000),
  downloadEnabled: z.boolean().optional(),
});

const quote = (title) => `“${title}”`;
const first = (value) => (Array.isArray(value) ? value[0] : value);
const str = (value) => {
  const v = first(value);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

// Resolves a referenced record for a field; out-of-scope ids become a 422 on that field.
function fieldRef(field, message, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 403)) throw validation({ [field]: message });
    throw err;
  }
}

export default function materialsRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  const currentVersion = (material) =>
    material.current_version_id ? db.get("SELECT * FROM material_versions WHERE id = ?", [material.current_version_id]) : null;

  const activeCategory = (categoryId) => {
    const row = db.get("SELECT * FROM categories WHERE id = ?", [categoryId]);
    if (!row || row.archived_at) throw validation({ categoryId: "Escolha uma categoria ativa." });
    return row;
  };
  const staffMember = (userId, field = "ownerId") => {
    const row = db.get("SELECT id, name FROM users WHERE id = ? AND role != 'client' AND status = 'active'", [userId]);
    if (!row) throw validation({ [field]: "Escolha alguém da equipe." });
    return row;
  };
  // Another primary in the same brand + category + variant slot.
  const primaryTaken = (brandId, categoryId, variant, exceptId) =>
    db.get(
      `SELECT id, title FROM materials WHERE brand_id = ? AND category_id = ? AND COALESCE(variant, '') = COALESCE(?, '')
         AND is_primary = 1 AND archived_at IS NULL AND id != ?`,
      [brandId, categoryId, variant ?? null, exceptId],
    );

  // ---------------------------------------------------------- operations

  function assertEditable(material) {
    if (material.archived_at) throw conflict("Material arquivado. Desarquive para editar.");
  }

  /**
   * Applies a metadata patch to a writable material (PATCH and bulk set_*).
   * -> list of changed field names.
   */
  function updateMaterial(req, material, body) {
    const user = req.user;
    const sets = [];
    const params = [];
    const changed = [];
    const set = (column, value, field) => {
      sets.push(`${column} = ?`);
      params.push(value);
      changed.push(field);
    };
    const released = material.visibility === "released";
    const releaseOnly = ["downloadEnabled", "editableIncluded", "requiresApproval"].filter((key) => body[key] !== undefined);
    if (released && releaseOnly.length && !can(user, "materials.release"))
      throw forbidden("Somente gestores e administradores alteram download, editáveis e aprovação de um material já liberado.");

    if (body.title !== undefined && body.title !== material.title) set("title", body.title, "title");
    if (body.description !== undefined) set("description", body.description, "description");
    if (body.tags !== undefined) set("tags", JSON.stringify([...new Set(body.tags)]), "tags");
    let categoryId = material.category_id;
    if (body.categoryId !== undefined && body.categoryId !== material.category_id) {
      categoryId = activeCategory(body.categoryId).id;
      set("category_id", categoryId, "categoryId");
    }
    if (body.projectId !== undefined && body.projectId !== material.project_id) {
      if (body.projectId === null) {
        if (user.role === "designer") throw validation({ projectId: "Selecione um dos seus projetos." });
        set("project_id", null, "projectId");
      } else {
        const project = fieldRef("projectId", "Projeto não encontrado.", () => assertProject(req, body.projectId));
        if (project.brand_id !== material.brand_id) throw validation({ projectId: "O projeto precisa ser da mesma marca." });
        set("project_id", project.id, "projectId");
      }
    }
    if (body.ownerId !== undefined && body.ownerId !== material.owner_id) {
      // the responsible person reads and writes the material: only staff
      // who already work on this client qualify (never an outsider)
      if (body.ownerId !== null) assertAssignableOwner(req, material, body.ownerId);
      set("owner_id", body.ownerId, "ownerId");
    }
    let variant = material.variant;
    if (body.variant !== undefined && body.variant !== material.variant) {
      variant = body.variant;
      set("variant", variant, "variant");
    }
    if (body.previewBg !== undefined) set("preview_bg", body.previewBg, "previewBg");
    if (body.dueDate !== undefined) set("due_date", body.dueDate, "dueDate");
    if (body.internalNotes !== undefined) set("internal_notes", body.internalNotes, "internalNotes");
    if (body.sortOrder !== undefined) set("sort_order", body.sortOrder, "sortOrder");
    let downloadChanged = null;
    if (body.downloadEnabled !== undefined && (body.downloadEnabled ? 1 : 0) !== material.download_enabled) {
      set("download_enabled", body.downloadEnabled ? 1 : 0, "downloadEnabled");
      downloadChanged = body.downloadEnabled;
    }
    if (body.editableIncluded !== undefined && (body.editableIncluded ? 1 : 0) !== material.editable_included)
      set("editable_included", body.editableIncluded ? 1 : 0, "editableIncluded");
    if (body.requiresApproval !== undefined && (body.requiresApproval ? 1 : 0) !== material.requires_approval) {
      set("requires_approval", body.requiresApproval ? 1 : 0, "requiresApproval");
      // the approval axis follows the released version
      if (released && !body.requiresApproval && material.approval_status === "pending") set("approval_status", "none", "approvalStatus");
      if (released && body.requiresApproval && material.approval_status === "none") set("approval_status", "pending", "approvalStatus");
    }
    // leaving a primary slot for one that is taken drops the primary mark
    if (material.is_primary === 1 && (categoryId !== material.category_id || variant !== material.variant)) {
      if (primaryTaken(material.brand_id, categoryId, variant, material.id)) set("is_primary", 0, "isPrimary");
    }
    if (!sets.length) return [];

    // One attributed history entry per change: the download switch has its
    // own entry (client-visible once released, lead decision D2); the other
    // fields share one internal "editou" entry.
    const title = body.title ?? material.title;
    const otherFields = changed.filter((field) => field !== "downloadEnabled");
    db.tx(() => {
      db.run(`UPDATE materials SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, now(), material.id]);
      if (otherFields.length)
        logActivity(req, {
          action: "material.updated",
          entityType: "material",
          entityId: material.id,
          materialId: material.id,
          summary: `${user.name} editou ${quote(title)}.`,
          data: { fields: otherFields },
        });
      if (downloadChanged !== null)
        logActivity(req, {
          action: downloadChanged ? "material.download_enabled" : "material.download_disabled",
          entityType: "material",
          entityId: material.id,
          materialId: material.id,
          visibility: released ? "client" : "internal",
          summary: `${user.name} ${downloadChanged ? "liberou" : "bloqueou"} o download de ${quote(title)}.`,
          data: { downloadEnabled: downloadChanged },
        });
    });
    return changed;
  }

  function submitMaterial(req, material) {
    assertEditable(material);
    const version = currentVersion(material);
    if (!version) throw conflict("Este material ainda não tem uma versão.");
    if (version.status === "internal_review") throw conflict("Esta versão já está em revisão interna.");
    if (version.status !== "draft")
      throw conflict("A versão atual já foi liberada. Crie uma nova versão para enviar à revisão.");
    const count = db.get("SELECT COUNT(*) AS n FROM material_files WHERE version_id = ? AND role IN ('original', 'final')", [version.id]).n;
    if (!count) throw conflict("Anexe pelo menos um arquivo antes de enviar para revisão.");
    const at = now();
    db.tx(() => {
      db.run("UPDATE material_versions SET status = 'internal_review', submitted_at = ? WHERE id = ?", [at, version.id]);
      db.run(
        `UPDATE materials SET visibility = CASE WHEN visibility = 'draft' THEN 'internal_review' ELSE visibility END,
           updated_at = ? WHERE id = ?`,
        [at, material.id],
      );
      logActivity(req, {
        action: "material.submitted",
        entityType: "material",
        entityId: material.id,
        materialId: material.id,
        summary: `${req.user.name} enviou a versão ${version.number} de ${quote(material.title)} para revisão interna.`,
        data: { versionId: version.id, versionNumber: version.number },
      });
      let reviewers = managerIdsForClient(db, material.client_id);
      if (!reviewers.length) reviewers = adminIds(db);
      notify(req, reviewers, {
        type: "material.submitted",
        title: `${quote(material.title)} aguarda revisão`,
        body: `${req.user.name} enviou a versão ${version.number} para revisão interna.`,
        link: staffMaterialLink(material),
        entityType: "material",
        entityId: material.id,
      });
    });
  }

  function setDownload(req, material, enabled) {
    return updateMaterial(req, material, { downloadEnabled: enabled });
  }

  function archiveMaterial(req, material) {
    if (material.archived_at) throw conflict("Este material já está arquivado.");
    const at = now();
    db.tx(() => {
      db.run("UPDATE materials SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ?", [at, req.user.id, at, material.id]);
      logActivity(req, {
        action: "material.archived",
        entityType: "material",
        entityId: material.id,
        materialId: material.id,
        summary: `${req.user.name} arquivou ${quote(material.title)}.`,
        data: { wasReleased: material.visibility === "released" },
      });
    });
  }

  function unarchiveMaterial(req, material) {
    if (!material.archived_at) throw conflict("Este material não está arquivado.");
    const at = now();
    const clash = material.is_primary === 1 && primaryTaken(material.brand_id, material.category_id, material.variant, material.id);
    db.tx(() => {
      db.run(
        `UPDATE materials SET archived_at = NULL, archived_by = NULL, is_primary = ?, updated_at = ? WHERE id = ?`,
        [clash ? 0 : material.is_primary, at, material.id],
      );
      logActivity(req, {
        action: "material.unarchived",
        entityType: "material",
        entityId: material.id,
        materialId: material.id,
        summary: `${req.user.name} desarquivou ${quote(material.title)}.`,
        data: clash ? { primaryReplacedBy: clash.id } : null,
      });
    });
  }

  // ---------------------------------------------------------- list & create

  router.get("/api/materials", requireAuth, requireCap(...VIEW), (req, res) => {
    const q = req.query;
    const filters = {
      brandId: str(q.brandId),
      clientId: str(q.clientId),
      projectId: str(q.projectId),
      unassigned: str(q.unassigned),
      categoryId: str(q.categoryId),
      categorySlug: q.categorySlug,
      area: q.area,
      kind: q.kind,
      visibility: q.visibility,
      approval: q.approval,
      ownerId: str(q.ownerId),
      tag: str(q.tag),
      q: str(q.q),
      archived: str(q.archived),
      ids: q.ids,
      variant: q.variant,
      campaignId: str(q.campaignId),
      network: q.network,
      format: q.format,
      publication: q.publication,
      from: str(q.from),
      to: str(q.to),
      sort: str(q.sort),
    };
    const paging = q.page !== undefined || q.pageSize !== undefined ? paginate(q) : {};
    res.json(listMaterials(req, filters, paging));
  });

  router.post("/api/materials", requireAuth, requireCap("materials.upload"), (req, res) => {
    const body = parse(createSchema, req.body);
    const id = createMaterial(req, body);
    res.status(201).json({ material: getMaterialDetail(req, id) });
  });

  router.post("/api/materials/reorder", requireAuth, requireCap("materials.edit"), (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(id).min(1).max(1000) }), req.body);
    const unique = [...new Set(ids)];
    const rows = unique.map((materialId) => assertMaterial(req, materialId, { write: true }));
    const slot = `${rows[0].brand_id}:${rows[0].category_id}`;
    if (rows.some((row) => `${row.brand_id}:${row.category_id}` !== slot))
      throw validation({ ids: "Ordene materiais da mesma marca e categoria." });
    const at = now();
    db.tx(() => {
      unique.forEach((materialId, index) =>
        db.run("UPDATE materials SET sort_order = ?, updated_at = ? WHERE id = ?", [(index + 1) * 10, at, materialId]),
      );
      logActivity(req, {
        action: "materials.reordered",
        entityType: "category",
        entityId: rows[0].category_id,
        brandId: rows[0].brand_id,
        summary: `${req.user.name} reordenou ${unique.length} materiais.`,
        data: { ids: unique },
      });
    });
    res.json({ updated: unique.length, ids: unique });
  });

  const bulkSchema = z.object({
    ids: z.array(id).min(1).max(500),
    action: z.enum(BULK_ACTIONS),
    value: z.union([z.string().max(64), z.boolean(), z.null()]).optional(),
  });
  const BULK_CAPS = {
    archive: "materials.archive",
    unarchive: "materials.archive",
    submit: "materials.edit",
    enable_download: "materials.edit",
    disable_download: "materials.edit",
    set_category: "materials.edit",
    set_owner: "materials.edit",
    set_project: "materials.edit",
  };

  router.post("/api/materials/bulk", requireAuth, requireCap("materials.edit", "materials.archive"), (req, res) => {
    const { ids, action, value } = parse(bulkSchema, req.body);
    if (!can(req.user, BULK_CAPS[action])) throw forbidden();
    // validate the shared value once
    if (action === "set_category") {
      if (typeof value !== "string") throw validation({ value: "Escolha uma categoria." });
      activeCategory(value);
    }
    // set_owner: the person must be staff here; whether they may own each
    // material (access to its client) is checked per material and reported
    // in `skipped`
    if (action === "set_owner" && value !== null) {
      if (typeof value !== "string") throw validation({ value: "Escolha alguém da equipe." });
      staffMember(value, "value");
    }
    if (action === "set_project" && value !== null && typeof value !== "string") throw validation({ value: "Escolha um projeto." });

    let updated = 0;
    const updatedIds = [];
    const skipped = [];
    for (const materialId of [...new Set(ids)]) {
      try {
        const material = assertMaterial(req, materialId, { write: true });
        db.tx(() => {
          switch (action) {
            case "archive":
              archiveMaterial(req, material);
              break;
            case "unarchive":
              unarchiveMaterial(req, material);
              break;
            case "submit":
              submitMaterial(req, material);
              break;
            case "enable_download":
            case "disable_download": {
              assertEditable(material);
              const changed = setDownload(req, material, action === "enable_download");
              if (!changed.length) throw conflict(action === "enable_download" ? "O download já está liberado." : "O download já está desativado.");
              break;
            }
            case "set_category":
            case "set_owner":
            case "set_project": {
              assertEditable(material);
              const field = { set_category: "categoryId", set_owner: "ownerId", set_project: "projectId" }[action];
              const changed = updateMaterial(req, material, { [field]: value });
              if (!changed.length) throw conflict("Nada a alterar.");
              break;
            }
            default:
              break;
          }
        });
        updated += 1;
        updatedIds.push(materialId);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        const reason =
          err.status === 404
            ? "Material não encontrado."
            : err.status === 403
              ? err.message || "Sem permissão para este material."
              : err.status === 422
                ? Object.values(err.fields ?? {})[0] ?? err.message
                : err.message;
        skipped.push({ id: materialId, reason });
      }
    }
    res.json({ updated, updatedIds, skipped });
  });

  // ---------------------------------------------------------- one material

  router.get("/api/materials/:id", requireAuth, requireCap(...VIEW), (req, res) => {
    res.json({ material: getMaterialDetail(req, req.params.id) });
  });

  router.patch("/api/materials/:id", requireAuth, requireCap("materials.edit"), (req, res) => {
    const material = assertMaterial(req, req.params.id, { write: true });
    assertEditable(material);
    const body = parse(patchSchema, req.body);
    updateMaterial(req, material, body);
    res.json({ material: getMaterialDetail(req, material.id) });
  });

  router.post("/api/materials/:id/versions", requireAuth, requireCap("materials.upload"), (req, res) => {
    const body = parse(versionCreateSchema, req.body);
    const versionId = createVersion(req, req.params.id, body);
    const material = getMaterialDetail(req, req.params.id);
    res.status(201).json({ version: material.versions.find((v) => v.id === versionId) ?? null, material });
  });

  router.post("/api/materials/:id/submit", requireAuth, requireCap("materials.edit"), (req, res) => {
    const material = assertMaterial(req, req.params.id, { write: true });
    submitMaterial(req, material);
    res.json({ material: getMaterialDetail(req, material.id) });
  });

  router.post("/api/materials/:id/primary", requireAuth, requireCap("materials.edit"), (req, res) => {
    const { primary } = parse(z.object({ primary: z.boolean().default(true) }), req.body ?? {});
    const material = assertMaterial(req, req.params.id, { write: true });
    assertEditable(material);
    let previous = null;
    db.tx(() => {
      if (primary) {
        previous = primaryTaken(material.brand_id, material.category_id, material.variant, material.id) ?? null;
        if (previous) db.run("UPDATE materials SET is_primary = 0, updated_at = ? WHERE id = ?", [now(), previous.id]);
        db.run("UPDATE materials SET is_primary = 1, updated_at = ? WHERE id = ?", [now(), material.id]);
      } else {
        db.run("UPDATE materials SET is_primary = 0, updated_at = ? WHERE id = ?", [now(), material.id]);
      }
      logActivity(req, {
        action: primary ? "material.primary_set" : "material.primary_unset",
        entityType: "material",
        entityId: material.id,
        materialId: material.id,
        summary: primary
          ? `${req.user.name} definiu ${quote(material.title)} como principal${previous ? ` no lugar de ${quote(previous.title)}` : ""}.`
          : `${req.user.name} tirou ${quote(material.title)} de principal.`,
        data: { previousId: previous?.id ?? null, variant: material.variant ?? null },
      });
    });
    res.json({ material: getMaterialDetail(req, material.id), previousId: previous?.id ?? null });
  });

  router.post("/api/materials/:id/archive", requireAuth, requireCap("materials.archive"), (req, res) => {
    const material = assertMaterial(req, req.params.id, { write: true });
    archiveMaterial(req, material);
    res.json({ material: getMaterialDetail(req, material.id) });
  });

  router.post("/api/materials/:id/unarchive", requireAuth, requireCap("materials.archive"), (req, res) => {
    const material = assertMaterial(req, req.params.id, { write: true });
    unarchiveMaterial(req, material);
    res.json({ material: getMaterialDetail(req, material.id) });
  });

  router.post("/api/materials/:id/deliver", requireAuth, requireCap("materials.release"), (req, res) => {
    const body = parse(deliverSchema, req.body ?? {});
    const result = deliverMaterial(req, req.params.id, body);
    res.json({ ...result, material: getMaterialDetail(req, req.params.id) });
  });

  // History. Staff: every activity entry, versions, releases and downloads
  // (downloads are access records and never mean approval). Clients: only
  // the entries marked visible to them.
  router.get("/api/materials/:id/history", requireAuth, requireCap(...VIEW), (req, res) => {
    const material = assertMaterial(req, req.params.id);
    const staff = isStaff(req);
    const activity = db
      .all(
        `${ACTIVITY_SELECT} WHERE a.material_id = ? ${staff ? "" : "AND a.visibility = 'client'"}
          ORDER BY a.created_at DESC, a.id DESC LIMIT 500`,
        [material.id],
      )
      .map((row) => serializeActivity(req, row));
    if (!staff) {
      res.json({ items: activity.map((entry) => ({ type: "activity", ...entry })) });
      return;
    }

    const person = (idValue, name, role) => (idValue ? personRef(req, { id: idValue, name: name ?? "Usuário removido", role }) : null);
    const versions = db
      .all(
        `SELECT v.*, cu.name AS created_by_name, cu.role AS created_by_role, ru.name AS released_by_name, ru.role AS released_by_role,
            du.name AS decided_by_name, du.role AS decided_by_role,
            (SELECT COUNT(*) FROM material_files f WHERE f.version_id = v.id) AS file_count
           FROM material_versions v
           LEFT JOIN users cu ON cu.id = v.created_by
           LEFT JOIN users ru ON ru.id = v.released_by
           LEFT JOIN users du ON du.id = v.decided_by
          WHERE v.material_id = ? ORDER BY v.number DESC`,
        [material.id],
      )
      .map((v) => ({
        id: v.id,
        number: v.number,
        status: v.status,
        changeSummary: v.change_summary ?? null,
        fileCount: v.file_count,
        createdAt: v.created_at,
        createdBy: person(v.created_by, v.created_by_name, v.created_by_role),
        submittedAt: v.submitted_at ?? null,
        releasedAt: v.released_at ?? null,
        releasedBy: person(v.released_by, v.released_by_name, v.released_by_role),
        decidedAt: v.decided_at ?? null,
        decidedBy: person(v.decided_by, v.decided_by_name, v.decided_by_role),
      }));
    const releases = db
      .all(
        `SELECT r.*, ri.version_id, ri.download_enabled AS item_download, v.number AS version_number,
            u.name AS actor_name, u.role AS actor_role, k.name AS kit_name
           FROM release_items ri
           JOIN releases r ON r.id = ri.release_id
           LEFT JOIN material_versions v ON v.id = ri.version_id
           LEFT JOIN users u ON u.id = r.actor_id
           LEFT JOIN kits k ON k.id = r.kit_id
          WHERE ri.material_id = ? ORDER BY r.created_at DESC`,
        [material.id],
      )
      .map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        actor: person(r.actor_id, r.actor_name, r.actor_role),
        versionId: r.version_id,
        versionNumber: r.version_number ?? null,
        downloadEnabled: r.item_download === 1,
        notifyEmail: r.notify_email === 1,
        notifyApp: r.notify_app === 1,
        message: r.message ?? null,
        kit: r.kit_id ? { id: r.kit_id, name: r.kit_name ?? null } : null,
      }));
    const downloads = db
      .all(
        `SELECT d.*, u.name AS user_name, u.role AS user_role, f.display_name AS file_name, v.number AS version_number,
            z.label AS zip_label
           FROM download_events d
           LEFT JOIN users u ON u.id = d.user_id
           LEFT JOIN material_files f ON f.id = d.file_id
           LEFT JOIN material_versions v ON v.id = d.version_id
           LEFT JOIN zip_jobs z ON z.id = d.zip_job_id
          WHERE d.material_id = ?
             OR (d.kind = 'zip' AND d.zip_job_id IN (SELECT id FROM zip_jobs WHERE entries LIKE ? ESCAPE '\\'))
          ORDER BY d.created_at DESC LIMIT 500`,
        [material.id, `%"m":"${material.id.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`],
      )
      .map((d) => ({
        id: d.id,
        kind: d.kind,
        createdAt: d.created_at,
        user: person(d.user_id, d.user_name, d.user_role),
        fileId: d.file_id ?? null,
        fileName: d.file_name ?? null,
        versionNumber: d.version_number ?? null,
        zipLabel: d.zip_label ?? null,
        label: d.kind === "zip" ? "Download em ZIP" : "Download de arquivo",
        note: "Registro de acesso — não indica aprovação.",
        isApproval: false,
      }));

    const items = [
      ...activity.map((entry) => ({ type: "activity", ...entry })),
      ...downloads.map((d) => ({
        type: "download",
        id: d.id,
        action: d.kind === "zip" ? "download.zip" : "download.file",
        actor: d.user,
        summary: `${d.user?.name ?? "Alguém"} baixou ${d.kind === "zip" ? `um ZIP${d.zipLabel ? ` (${d.zipLabel})` : ""}` : quote(d.fileName ?? "arquivo")}${d.versionNumber ? ` · versão ${d.versionNumber}` : ""}. Registro de acesso, não é aprovação.`,
        createdAt: d.createdAt,
        isApproval: false,
      })),
    ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ items, activity, versions, releases, downloads });
  });

  // ---------------------------------------------------------- versions

  router.get("/api/versions/:id", requireAuth, requireCap(...VIEW), (req, res) => {
    const version = assertVersion(req, req.params.id);
    res.json({ version: serializeVersion(req, version, null, null, version.material) });
  });

  router.patch("/api/versions/:id", requireAuth, requireCap("materials.edit"), (req, res) => {
    const version = assertVersion(req, req.params.id, { write: true });
    const material = version.material;
    assertEditable(material);
    if (version.status !== "draft" && version.status !== "internal_review")
      throw conflict("Só é possível editar versões em rascunho ou em revisão interna.");
    const body = parse(versionPatchSchema, req.body);
    const rows = db.all("SELECT * FROM material_files WHERE version_id = ?", [version.id]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const fields = {};
    (body.files ?? []).forEach((item, index) => {
      const row = byId.get(item.id);
      if (!row) fields[`files.${index}.id`] = "Este arquivo não pertence a esta versão.";
      else if (item.role === "cover" && row.media_kind !== "image")
        fields[`files.${index}.role`] = "A capa precisa ser uma imagem (PNG, JPG ou WEBP).";
    });
    if (Object.keys(fields).length) throw validation(fields);

    const sets = [];
    const params = [];
    for (const [key, column] of [
      ["caption", "caption"],
      ["hashtags", "hashtags"],
      ["notes", "notes"],
      ["changeSummary", "change_summary"],
    ])
      if (body[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(body[key]);
      }
    const at = now();
    db.tx(() => {
      if (sets.length) db.run(`UPDATE material_versions SET ${sets.join(", ")} WHERE id = ?`, [...params, version.id]);
      if (body.files?.length) {
        const order = new Map(body.files.map((item, index) => [item.id, index]));
        for (const item of body.files) {
          const row = byId.get(item.id);
          if (item.role) row.role = item.role;
          if (item.position) row.position = item.position;
        }
        // renumber each role 1..n: requested position, then request order, then age
        const groups = new Map();
        for (const row of rows) {
          if (!groups.has(row.role)) groups.set(row.role, []);
          groups.get(row.role).push(row);
        }
        for (const group of groups.values()) {
          group.sort(
            (a, b) =>
              a.position - b.position ||
              (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) ||
              String(a.created_at).localeCompare(String(b.created_at)),
          );
          group.forEach((row, index) =>
            db.run("UPDATE material_files SET role = ?, position = ? WHERE id = ?", [row.role, index + 1, row.id]),
          );
        }
      }
      db.run("UPDATE materials SET updated_at = ? WHERE id = ?", [at, material.id]);
      logActivity(req, {
        action: "version.updated",
        entityType: "version",
        entityId: version.id,
        materialId: material.id,
        summary: body.files?.length
          ? `${req.user.name} reorganizou os arquivos da versão ${version.number} de ${quote(material.title)}.`
          : `${req.user.name} editou a versão ${version.number} de ${quote(material.title)}.`,
        data: { fields: Object.keys(body).filter((key) => body[key] !== undefined) },
      });
    });
    const fresh = db.get("SELECT * FROM material_versions WHERE id = ?", [version.id]);
    res.json({ version: serializeVersion(req, fresh, null, null, material), material: getMaterialDetail(req, material.id) });
  });

  router.post("/api/versions/:id/files", requireAuth, requireCap("materials.upload"), (req, res) => {
    const version = assertVersion(req, req.params.id, { write: true });
    const material = version.material;
    assertEditable(material);
    const body = parse(z.object({ files: files.min(1, "Envie pelo menos um arquivo.") }), req.body);
    if (version.status === "superseded")
      throw conflict("Esta versão foi substituída por uma mais nova. Envie os arquivos na versão atual.");
    const released = Boolean(version.released_at);
    if (released && body.files.some((file) => file.role !== "final"))
      throw validation({ files: "Depois da liberação, só é possível anexar arquivos finais a esta versão." });
    const fileIds = attachUploads(req, { materialId: material.id, versionId: version.id, files: body.files, published: !released });
    logActivity(req, {
      action: released ? "version.finals_added" : "version.files_added",
      entityType: "version",
      entityId: version.id,
      materialId: material.id,
      summary: released
        ? `${req.user.name} anexou ${fileIds.length} ${fileIds.length === 1 ? "arquivo final" : "arquivos finais"} à versão ${version.number} de ${quote(material.title)} (aguardando entrega).`
        : `${req.user.name} anexou ${fileIds.length} ${fileIds.length === 1 ? "arquivo" : "arquivos"} à versão ${version.number} de ${quote(material.title)}.`,
      data: { fileIds, published: !released },
    });
    const fresh = db.get("SELECT * FROM material_versions WHERE id = ?", [version.id]);
    res.status(201).json({
      fileIds,
      version: serializeVersion(req, fresh, null, null, material),
      material: getMaterialDetail(req, material.id),
    });
  });

  // Files of released versions stay in the history; finals still waiting for
  // delivery can be removed.
  router.delete("/api/files/:id", requireAuth, requireCap("materials.edit"), async (req, res) => {
    const file = assertFile(req, req.params.id, { write: true });
    const { version, material } = file;
    assertEditable(material);
    if (version.released_at && isPublished(file))
      throw conflict("Arquivos de versões liberadas ficam preservados no histórico.");
    const keys = [file.storage_key, ...db.all("SELECT storage_key FROM file_renditions WHERE file_id = ?", [file.id]).map((r) => r.storage_key)];
    db.tx(() => {
      db.run("DELETE FROM material_files WHERE id = ?", [file.id]);
      db.run("UPDATE materials SET updated_at = ? WHERE id = ?", [now(), material.id]);
      logActivity(req, {
        action: "file.deleted",
        entityType: "file",
        entityId: file.id,
        materialId: material.id,
        summary: `${req.user.name} removeu ${quote(file.display_name)} da versão ${version.number} de ${quote(material.title)}.`,
        data: { versionId: version.id, role: file.role },
      });
    });
    await releaseStorageKeys(ctx, keys);
    res.status(204).end();
  });

  return router;
}

// Review, comments and approvals (docs/API.md "Conteúdo e revisão").
// Internal notes are separated here, on the server: a client never receives an
// internal comment, nor a count of them. Approvals are an immutable log of who
// decided, when, on which version, from which IP and browser.
import { Router } from "express";
import { assertMaterial } from "../lib/access.js";
import { clientIp, requireAuth, requireCap, requireRole } from "../lib/auth.js";
import { logActivity } from "../lib/audit.js";
import { conflict, forbidden, notFound, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { clientUserIds, notify, staffIdsForMaterial } from "../lib/notify.js";
import { can } from "../lib/permissions.js";
import { isStaff } from "../lib/serialize.js";
import { now } from "../lib/time.js";
import { parse, z } from "../lib/validate.js";
import { clientMaterialLink, getMaterialDetail, listMaterials } from "../services/materials.js";

const APPROVAL_STATUSES = ["pending", "changes_requested", "approved"];

const bodyText = (max, message) =>
  z
    .string({ error: message })
    .trim()
    .min(1, message)
    .max(max, `Use no máximo ${max} caracteres.`);
const optionalId = z
  .union([z.string().trim().max(64), z.null()])
  .optional()
  .transform((value) => (value === "" ? null : value));
const slide = z.union([z.number().int().min(1).max(500), z.null()]).optional();

const commentSchema = z.object({
  body: bodyText(5000, "Escreva o comentário."),
  versionId: optionalId,
  slidePosition: slide,
  visibility: z.string().optional(),
  parentId: optionalId,
});
const commentPatchSchema = z.object({
  body: bodyText(5000, "Escreva o comentário.").optional(),
  resolved: z.boolean().optional(),
});
const approveSchema = z.object({
  versionId: z.string({ error: "Informe a versão aprovada." }).trim().min(1, "Informe a versão aprovada."),
  note: z
    .union([z.string().trim().max(2000), z.null()])
    .optional()
    .transform((value) => (value ? value : null)),
});
const changesSchema = z.object({
  versionId: z.string({ error: "Informe a versão." }).trim().min(1, "Informe a versão."),
  body: bodyText(5000, "Descreva os ajustes que você precisa."),
  slidePosition: slide,
});

const excerpt = (text, max = 140) => {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const userAgent = (req) => String(req.get?.("user-agent") ?? "").slice(0, 300) || null;
const adminLink = (material) => (material.kind === "post" ? `/admin/conteudo/${material.id}` : `/admin/biblioteca/${material.id}`);
// Posts open in the content hub; files open their drawer in Arquivos
// (/painel/arquivos?material=<id>), like releases and deliveries do, and a
// comment notice lands on the conversation (#comentarios scrolls to it).
const clientLink = (material) =>
  material.kind === "post" ? clientMaterialLink(material) : `${clientMaterialLink(material)}#comentarios`;

// ---------------------------------------------------------------- comments

const COMMENT_SELECT = `SELECT c.*, u.name AS author_name, u.role AS author_role,
    v.number AS version_number, v.released_at AS version_released_at, ru.name AS resolved_by_name
  FROM comments c
  JOIN users u ON u.id = c.author_id
  LEFT JOIN material_versions v ON v.id = c.version_id
  LEFT JOIN users ru ON ru.id = c.resolved_by`;

// Comment (docs/API.md). Team members appear to clients by name only;
// visibility and resolver are staff fields.
function serializeComment(req, row) {
  const staff = isStaff(req);
  const clientAuthor = row.author_role === "client";
  const author =
    staff || clientAuthor
      ? { id: row.author_id, name: row.author_name, role: row.author_role, isClient: clientAuthor }
      : { name: row.author_name, isClient: false };
  const comment = {
    id: row.id,
    materialId: row.material_id,
    versionId: row.version_id ?? null,
    versionNumber: row.version_number ?? null,
    parentId: row.parent_id ?? null,
    author,
    body: row.body,
    kind: row.kind,
    slidePosition: row.slide_position ?? null,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    mine: row.author_id === req.user.id,
  };
  if (staff) {
    comment.visibility = row.visibility;
    comment.resolvedBy = row.resolved_by ? { id: row.resolved_by, name: row.resolved_by_name } : null;
  }
  return comment;
}

// Comments the viewer may read: clients never get internal ones, nor
// comments tied to versions that were not released to them.
async function visibleComments(req, materialId, { visibility } = {}) {
  const db = req.ctx.db;
  const client = req.user.role === "client";
  const params = [materialId];
  let where = "c.material_id = ?";
  if (client) where += " AND c.visibility = 'client' AND (c.version_id IS NULL OR v.released_at IS NOT NULL)";
  else if (!can(req.user, "comments.internal")) where += " AND c.visibility = 'client'";
  else if (visibility === "client" || visibility === "internal") {
    where += " AND c.visibility = ?";
    params.push(visibility);
  }
  return await db.all(`${COMMENT_SELECT} WHERE ${where} ORDER BY c.created_at, c.seq`, params);
}

async function loadComment(req, id) {
  const row = id ? await req.ctx.db.get(`${COMMENT_SELECT} WHERE c.id = ?`, [id]) : null;
  if (!row) throw notFound();
  await assertMaterial(req, row.material_id);
  if (req.user.role === "client" && (row.visibility !== "client" || (row.version_id && !row.version_released_at)))
    throw notFound();
  if (row.visibility === "internal" && !can(req.user, "comments.internal")) throw notFound();
  return row;
}

// ---------------------------------------------------------------- approvals

async function decisionRows(db, materialIds) {
  if (!materialIds.length) return [];
  const out = [];
  for (let i = 0; i < materialIds.length; i += 500) {
    const chunk = materialIds.slice(i, i + 500);
    out.push(
      ...await db.all(
        `SELECT a.*, u.name AS user_name, u.role AS user_role, v.number AS version_number,
                c.body AS comment_body, c.slide_position AS comment_slide
           FROM approvals a
           JOIN users u ON u.id = a.user_id
           JOIN material_versions v ON v.id = a.version_id
           LEFT JOIN comments c ON c.id = a.comment_id
          WHERE a.material_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY a.created_at DESC, a.seq DESC`,
        chunk,
      ),
    );
  }
  return out;
}

function serializeDecision(req, row) {
  const decision = {
    id: row.id,
    materialId: row.material_id,
    versionId: row.version_id,
    versionNumber: row.version_number,
    decision: row.decision,
    user: { id: row.user_id, name: row.user_name },
    createdAt: row.created_at,
    comment: row.comment_body ?? null,
    slidePosition: row.comment_slide ?? null,
  };
  if (isStaff(req)) {
    decision.ip = row.ip ?? null;
    decision.userAgent = row.user_agent ?? null;
  }
  return decision;
}

// Re-reads the material inside the transaction and checks the decision rules.
async function lockForDecision(req, materialId, versionId, allowed) {
  const db = req.ctx.db;
  const material = await assertMaterial(req, materialId);
  if (!material.requires_approval) throw conflict("Este material não precisa de aprovação.", "conflict");
  if (!material.released_version_id || versionId !== material.released_version_id)
    throw conflict("Esta versão não é mais a que está em revisão. Atualize a página para ver a versão mais recente.");
  if (!allowed.includes(material.approval_status)) {
    if (material.approval_status === "approved") throw conflict("Esta versão já foi aprovada.");
    if (material.approval_status === "changes_requested")
      throw conflict("Você já pediu ajustes nesta versão. Use os comentários para complementar o pedido.");
    throw conflict("Esta versão não está aguardando aprovação.");
  }
  const version = await db.get("SELECT * FROM material_versions WHERE id = ? AND material_id = ?", [versionId, material.id]);
  if (!version || !version.released_at || version.status === "approved" || version.status === "superseded")
    throw conflict("Esta versão não está mais aberta para decisão. Atualize a página.");
  return { material, version };
}

// ---------------------------------------------------------------- router

export default function reviewsRoutes() {
  const router = Router();
  const readers = [requireAuth, requireCap("portal.access", "materials.view", "content.view")];

  router.get("/api/materials/:id/comments", ...readers, async (req, res) => {
    const material = await assertMaterial(req, req.params.id);
    const rows = await visibleComments(req, material.id, { visibility: req.query.visibility });
    const items = rows.map((row) => serializeComment(req, row));
    const body = { items, total: items.length };
    if (isStaff(req)) {
      const counts = { client: 0, internal: 0 };
      const all = can(req.user, "comments.internal") && req.query.visibility ? await visibleComments(req, material.id) : rows;
      for (const row of all) counts[row.visibility] += 1;
      if (!can(req.user, "comments.internal")) delete counts.internal;
      body.counts = counts;
    }
    res.json(body);
  });

  router.post("/api/materials/:id/comments", ...readers, async (req, res) => {
    const input = parse(commentSchema, req.body);
    const db = req.ctx.db;
    const material = await assertMaterial(req, req.params.id);
    if (material.archived_at) throw conflict("Material arquivado. Desarquive para comentar.");
    const client = req.user.role === "client";
    // Clients always write client-visible comments, whatever they send.
    const visibility = client ? "client" : input.visibility === "internal" ? "internal" : "client";
    if (visibility === "internal" && !can(req.user, "comments.internal"))
      throw forbidden("Você não pode escrever notas internas.");

    // Default version: clients talk about the version they see (the released
    // one); a team message meant for the client also belongs to the released
    // version (a draft in preparation is invisible to the client); internal
    // notes follow the version the team is working on.
    let versionId =
      input.versionId ??
      (client
        ? material.released_version_id
        : visibility === "client"
          ? material.released_version_id ?? material.current_version_id
          : material.current_version_id ?? material.released_version_id);
    let version = null;
    if (versionId) {
      version = await db.get("SELECT id, released_at FROM material_versions WHERE id = ? AND material_id = ?", [versionId, material.id]);
      if (!version || (client && !version.released_at)) throw validation({ versionId: "Versão inválida." });
    } else versionId = null;
    // The client only reads (and is only told about) client-visible comments
    // on a released, active material whose version was released to them.
    const reachesClient =
      visibility === "client" &&
      material.visibility === "released" &&
      !material.archived_at &&
      (!version || Boolean(version.released_at));
    if (input.parentId) {
      const parent = await db.get("SELECT id, visibility, material_id FROM comments WHERE id = ?", [input.parentId]);
      if (!parent || parent.material_id !== material.id || (client && parent.visibility !== "client"))
        throw validation({ parentId: "Comentário não encontrado." });
      if (visibility === "client" && parent.visibility === "internal")
        throw validation({ parentId: "Uma resposta visível ao cliente não pode responder a uma nota interna." });
    }

    const id = newId("cmt");
    const at = now();
    const user = req.user;
    await db.tx(async () => {
      await db.run(
        `INSERT INTO comments (id, material_id, version_id, parent_id, author_id, body, visibility, kind, slide_position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'comment', ?, ?)`,
        [id, material.id, versionId, input.parentId ?? null, user.id, input.body, visibility, input.slidePosition ?? null, at],
      );
      await db.run("UPDATE materials SET updated_at = ? WHERE id = ?", [at, material.id]);
      await logActivity(req, {
        action: visibility === "internal" ? "comment.internal" : "comment.created",
        entityType: "comment",
        entityId: id,
        materialId: material.id,
        summary:
          visibility === "internal"
            ? `${user.name} adicionou uma nota interna em “${material.title}”.`
            : `${user.name} comentou em “${material.title}”.`,
        visibility: client || reachesClient ? "client" : "internal",
        data: { commentId: id, versionId, slidePosition: input.slidePosition ?? null },
      });
      if (client) {
        await notify(req, await staffIdsForMaterial(db, material), {
          type: "comment.client",
          title: `${user.name} comentou em “${material.title}”`,
          body: excerpt(input.body),
          link: adminLink(material),
          entityType: "material",
          entityId: material.id,
          email: true,
          emailLines: [input.body],
          actionLabel: "Ver comentário",
        });
      } else if (reachesClient) {
        await notify(req, await clientUserIds(db, material.client_id), {
          type: "comment.team",
          title: `Novo comentário da equipe Metta em “${material.title}”`,
          body: excerpt(input.body),
          link: clientLink(material),
          entityType: "material",
          entityId: material.id,
          email: true,
          emailLines: [input.body],
          actionLabel: "Ver comentário",
        });
      }
    });
    res.status(201).json({ comment: serializeComment(req, await db.get(`${COMMENT_SELECT} WHERE c.id = ?`, [id])) });
  });

  router.patch("/api/comments/:id", ...readers, async (req, res) => {
    const input = parse(commentPatchSchema, req.body);
    const db = req.ctx.db;
    const row = await loadComment(req, req.params.id);
    if (input.body === undefined && input.resolved === undefined) throw validation({ body: "Nada para alterar." });
    const at = now();
    await db.tx(async () => {
      if (input.body !== undefined && input.body !== row.body) {
        if (row.author_id !== req.user.id) throw forbidden("Só quem escreveu pode editar este comentário.");
        if (row.kind !== "comment")
          throw conflict("Pedidos de ajuste e notas de aprovação fazem parte do histórico e não podem ser editados.");
        await db.run("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?", [input.body, at, row.id]);
      }
      if (input.resolved !== undefined) {
        if (!isStaff(req)) throw forbidden("Somente a equipe Metta marca comentários como resolvidos.");
        await db.run("UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?", [
          input.resolved ? at : null,
          input.resolved ? req.user.id : null,
          row.id,
        ]);
        await logActivity(req, {
          action: input.resolved ? "comment.resolved" : "comment.reopened",
          entityType: "comment",
          entityId: row.id,
          materialId: row.material_id,
          summary: `${req.user.name} ${input.resolved ? "marcou um comentário como resolvido" : "reabriu um comentário"}.`,
        });
      }
    });
    res.json({ comment: serializeComment(req, await db.get(`${COMMENT_SELECT} WHERE c.id = ?`, [row.id])) });
  });

  // Client approves the version under review (the released one).
  router.post("/api/materials/:id/approve", requireAuth, requireRole("client"), async (req, res) => {
    const input = parse(approveSchema, req.body);
    const db = req.ctx.db;
    const user = req.user;
    let decisionId;
    let number;
    let material;
    await db.tx(async () => {
      ({ material, version: { number } = {} } = await lockForDecision(req, req.params.id, input.versionId, ["pending", "changes_requested"]));
      const at = now();
      let commentId = null;
      if (input.note) {
        commentId = newId("cmt");
        await db.run(
          `INSERT INTO comments (id, material_id, version_id, author_id, body, visibility, kind, created_at)
           VALUES (?, ?, ?, ?, ?, 'client', 'approval_note', ?)`,
          [commentId, material.id, input.versionId, user.id, input.note, at],
        );
      }
      decisionId = newId("apr");
      await db.run(
        `INSERT INTO approvals (id, material_id, version_id, decision, user_id, comment_id, ip, user_agent, created_at)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
        [decisionId, material.id, input.versionId, user.id, commentId, clientIp(req), userAgent(req), at],
      );
      await db.run("UPDATE material_versions SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?", [
        at,
        user.id,
        input.versionId,
      ]);
      await db.run(
        "UPDATE materials SET approval_status = 'approved', approved_version_id = ?, updated_at = ? WHERE id = ?",
        [input.versionId, at, material.id],
      );
      await logActivity(req, {
        action: "material.approved",
        entityType: "material",
        entityId: material.id,
        materialId: material.id,
        summary: `${user.name} aprovou a versão ${number} de “${material.title}”.`,
        visibility: "client",
        data: { versionId: input.versionId, versionNumber: number, approvalId: decisionId, note: Boolean(input.note) },
      });
      await notify(req, await staffIdsForMaterial(db, material), {
        type: "approval.approved",
        title: `${user.name} aprovou “${material.title}”`,
        body: `Versão ${number} aprovada${input.note ? `: ${excerpt(input.note)}` : "."}`,
        link: adminLink(material),
        entityType: "material",
        entityId: material.id,
        email: true,
        emailLines: [`Versão ${number} aprovada por ${user.name}.`, ...(input.note ? [input.note] : [])],
        actionLabel: "Abrir material",
      });
    });
    const approval = serializeDecision(req, (await decisionRows(db, [material.id])).find((row) => row.id === decisionId));
    res.json({ material: await getMaterialDetail(req, material.id), approval });
  });

  // Client asks for changes on the version under review.
  router.post("/api/materials/:id/request-changes", requireAuth, requireRole("client"), async (req, res) => {
    const input = parse(changesSchema, req.body);
    const db = req.ctx.db;
    const user = req.user;
    let decisionId;
    let commentId;
    let material;
    await db.tx(async () => {
      const locked = await lockForDecision(req, req.params.id, input.versionId, ["pending"]);
      material = locked.material;
      const number = locked.version.number;
      const at = now();
      commentId = newId("cmt");
      await db.run(
        `INSERT INTO comments (id, material_id, version_id, author_id, body, visibility, kind, slide_position, created_at)
         VALUES (?, ?, ?, ?, ?, 'client', 'change_request', ?, ?)`,
        [commentId, material.id, input.versionId, user.id, input.body, input.slidePosition ?? null, at],
      );
      decisionId = newId("apr");
      await db.run(
        `INSERT INTO approvals (id, material_id, version_id, decision, user_id, comment_id, ip, user_agent, created_at)
         VALUES (?, ?, ?, 'changes_requested', ?, ?, ?, ?, ?)`,
        [decisionId, material.id, input.versionId, user.id, commentId, clientIp(req), userAgent(req), at],
      );
      await db.run("UPDATE material_versions SET status = 'changes_requested', decided_at = ?, decided_by = ? WHERE id = ?", [
        at,
        user.id,
        input.versionId,
      ]);
      await db.run("UPDATE materials SET approval_status = 'changes_requested', updated_at = ? WHERE id = ?", [at, material.id]);

      // A task for the material's owner when the material belongs to a project.
      let taskId = null;
      if (material.project_id) {
        const owner = material.owner_id
          ? await db.get("SELECT id FROM users WHERE id = ? AND role != 'client' AND status = 'active'", [material.owner_id])
          : null;
        const order = ((await db.get("SELECT MAX(sort_order) AS n FROM tasks WHERE project_id = ?", [material.project_id]))?.n ?? 0) + 10;
        taskId = newId("tsk");
        const where = input.slidePosition ? ` (slide ${input.slidePosition})` : "";
        await db.run(
          `INSERT INTO tasks (id, project_id, material_id, title, description, assignee_id, status, sort_order, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
          [
            taskId,
            material.project_id,
            material.id,
            `Ajustes: ${material.title} (v${number})`.slice(0, 200),
            `${user.name} solicitou ajustes na versão ${number}${where}:\n\n${input.body}`,
            owner?.id ?? null,
            order,
            user.id,
            at,
            at,
          ],
        );
      }
      await logActivity(req, {
        action: "material.changes_requested",
        entityType: "material",
        entityId: material.id,
        materialId: material.id,
        summary: `${user.name} solicitou ajustes na versão ${number} de “${material.title}”.`,
        visibility: "client",
        data: { versionId: input.versionId, versionNumber: number, approvalId: decisionId, commentId, taskId },
      });
      await notify(req, await staffIdsForMaterial(db, material), {
        type: "approval.changes_requested",
        title: `${user.name} pediu ajustes em “${material.title}”`,
        body: `Versão ${number}${input.slidePosition ? `, slide ${input.slidePosition}` : ""}: ${excerpt(input.body)}`,
        link: adminLink(material),
        entityType: "material",
        entityId: material.id,
        email: true,
        emailLines: [`Versão ${number}${input.slidePosition ? `, slide ${input.slidePosition}` : ""}.`, input.body],
        actionLabel: "Ver pedido de ajuste",
      });
    });
    const comment = serializeComment(req, await db.get(`${COMMENT_SELECT} WHERE c.id = ?`, [commentId]));
    const approval = serializeDecision(req, (await decisionRows(db, [material.id])).find((row) => row.id === decisionId));
    res.json({ material: await getMaterialDetail(req, material.id), comment, approval });
  });

  // Staff queue (approvals.view) or the client's own pending items.
  router.get("/api/approvals", requireAuth, requireCap("approvals.view", "portal.access"), async (req, res) => {
    const db = req.ctx.db;
    const q = req.query;
    const staff = isStaff(req);
    const status = APPROVAL_STATUSES.includes(q.status) ? q.status : "pending";
    const str = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    const { items } = await listMaterials(req, {
      approval: status,
      brandId: str(q.brandId),
      clientId: staff ? str(q.clientId) : undefined,
      kind: ["post", "asset"].includes(q.kind) ? q.kind : undefined,
      q: str(q.q),
      visibility: staff ? "released" : undefined,
      ownerId: staff ? str(q.ownerId) : undefined,
    });
    const ids = items.map((item) => item.id);
    const decisions = await decisionRows(db, ids);
    const lastDecision = new Map();
    for (const row of decisions) if (!lastDecision.has(row.material_id)) lastDecision.set(row.material_id, row);
    const released = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = items.slice(i, i + 500).map((item) => item.releasedVersionId).filter(Boolean);
      if (!chunk.length) continue;
      for (const row of await db.all(
        `SELECT id, material_id, number, released_at FROM material_versions WHERE id IN (${chunk.map(() => "?").join(", ")})`,
        chunk,
      ))
        released.set(row.material_id, row);
    }
    const lastRequest = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const row of await db.all(
        `SELECT c.material_id, c.body, c.slide_position, c.created_at, v.number AS version_number, u.name AS author_name
           FROM comments c JOIN material_versions v ON v.id = c.version_id JOIN users u ON u.id = c.author_id
          WHERE c.kind = 'change_request' AND c.visibility = 'client' AND c.material_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY c.created_at DESC, c.seq DESC`,
        chunk,
      ))
        if (!lastRequest.has(row.material_id)) lastRequest.set(row.material_id, row);
    }

    let out = items.map((item) => {
      const decision = lastDecision.get(item.id);
      const version = released.get(item.id);
      const request = lastRequest.get(item.id);
      const since = status === "pending" ? version?.released_at ?? item.releasedAt : decision?.created_at ?? item.updatedAt;
      return {
        ...item,
        reviewVersion: version ? { id: version.id, number: version.number, releasedAt: version.released_at } : null,
        lastDecision: decision ? serializeDecision(req, decision) : null,
        lastChangeRequest: request
          ? {
              body: excerpt(request.body, 240),
              slidePosition: request.slide_position ?? null,
              versionNumber: request.version_number,
              author: { name: request.author_name },
              createdAt: request.created_at,
            }
          : null,
        since: since ?? null,
      };
    });
    out.sort((a, b) =>
      status === "approved"
        ? String(b.since).localeCompare(String(a.since))
        : String(a.since).localeCompare(String(b.since)),
    );
    const total = out.length;
    const pageSize = Number.parseInt(q.pageSize, 10);
    if (pageSize > 0) {
      const size = Math.min(200, pageSize);
      const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
      out = out.slice((page - 1) * size, page * size);
    }
    res.json({ items: out, total, status });
  });

  router.get("/api/materials/:id/approvals", ...readers, async (req, res) => {
    const db = req.ctx.db;
    const material = await assertMaterial(req, req.params.id);
    const items = (await decisionRows(db, [material.id])).map((row) => serializeDecision(req, row));
    const staff = isStaff(req);
    const releases = (await db
      .all(
        `SELECT v.id, v.number, v.released_at, v.released_by, u.name AS released_by_name
           FROM material_versions v LEFT JOIN users u ON u.id = v.released_by
          WHERE v.material_id = ? AND v.released_at IS NOT NULL ORDER BY v.released_at DESC, v.number DESC`,
        [material.id],
      ))
      .map((row) => ({
        versionId: row.id,
        versionNumber: row.number,
        releasedAt: row.released_at,
        releasedBy: staff && row.released_by ? { id: row.released_by, name: row.released_by_name } : null,
      }));
    res.json({ items, total: items.length, releases });
  });

  return router;
}

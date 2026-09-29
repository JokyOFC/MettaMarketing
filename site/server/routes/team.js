// Team and permissions (docs/API.md "Clientes, marcas, equipe, projetos").
// Only team.manage (admin) invites staff, changes roles/status and grants
// client access; team.view (admin, manager) reads the team.
import { Router } from "express";
import { getScope } from "../lib/access.js";
import { logActivity } from "../lib/audit.js";
import { issueToken, requireAuth, requireCap, revokeUserSessions } from "../lib/auth.js";
import { renderEmail } from "../lib/emails.js";
import { conflict, forbidden, notFound, rateLimited, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { notify } from "../lib/notify.js";
import { can, capabilitiesFor, ROLE_LABELS, ROLES, STAFF_ROLES } from "../lib/permissions.js";
import { serializeUser } from "../lib/serialize.js";
import { getSetting } from "../lib/settings.js";
import { addMinutes, now } from "../lib/time.js";
import { parse, schemas, z } from "../lib/validate.js";

export const INVITE_HOURS = 72;
const EMAIL_WAIT_MS = 8000;

const placeholders = (list) => list.map(() => "?").join(", ");
const escapeLike = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);

// ------------------------------------------------------------------ invites

/**
 * Issues a fresh invite token (older unused ones stop working) and sends the
 * invitation e-mail. Call after the user row is committed.
 * -> { emailStatus: 'sent'|'queued'|'failed'|'not_configured', inviteUrl? }
 * inviteUrl is returned only when e-mail is not configured, so the team can
 * hand the link over; never when an e-mail can carry it.
 */
export async function deliverInvite(req, user, { clientName = null } = {}) {
  const ctx = req.ctx;
  const token = await issueToken(ctx, user.id, "invite", INVITE_HOURS, req.user?.id ?? null);
  const url = `${ctx.config.appUrl}/convite/${token}`;
  const inviter = req.user?.name ?? "A equipe Metta";
  const message =
    user.role === "client"
      ? renderEmail({
          title: "Seu acesso à plataforma da Metta",
          intro: `Olá, ${user.name}. ${inviter} convidou você para acessar a área${clientName ? ` de ${clientName}` : " do cliente"} na plataforma da Metta Marketing.`,
          lines: [
            "Lá você encontra os arquivos da sua marca, acompanha os projetos e aprova os conteúdos.",
            `Defina sua senha pelo link abaixo. Ele vale por ${INVITE_HOURS} horas e pode ser usado uma vez.`,
          ],
          actionLabel: "Definir senha e entrar",
          actionUrl: url,
        })
      : renderEmail({
          title: "Seu acesso à equipe Metta",
          intro: `Olá, ${user.name}. ${inviter} convidou você para a plataforma da Metta Marketing como ${ROLE_LABELS[user.role] ?? "integrante da equipe"}.`,
          lines: [`Defina sua senha pelo link abaixo. Ele vale por ${INVITE_HOURS} horas e pode ser usado uma vez.`],
          actionLabel: "Definir senha e entrar",
          actionUrl: url,
        });
  const configured = ctx.mailer.isConfigured();
  const sending = ctx.mailer.send({ to: user.email, toUserId: user.id, ...message });
  if (!configured) {
    await sending;
    return { emailStatus: "not_configured", inviteUrl: url };
  }
  let timer;
  const status = await Promise.race([
    sending.then((result) => result.status),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("queued"), EMAIL_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  return { emailStatus: status };
}

// Latest pending invitation of each user: Map<userId, {sentAt, expiresAt, expired}>.
export async function inviteInfo(db, userIds) {
  const map = new Map();
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return map;
  const rows = await db.all(
    `SELECT user_id, MAX(created_at) AS sent_at, MAX(expires_at) AS expires_at FROM auth_tokens
      WHERE purpose = 'invite' AND used_at IS NULL AND user_id IN (${placeholders(ids)})
      GROUP BY user_id`,
    ids,
  );
  const at = Date.now();
  for (const row of rows)
    map.set(row.user_id, {
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
      expired: new Date(row.expires_at).getTime() <= at,
    });
  return map;
}

// Guards resending: at most once a minute per person.
export async function assertResendAllowed(db, userId) {
  const recent = await db.get(
    "SELECT 1 AS yes FROM auth_tokens WHERE user_id = ? AND purpose = 'invite' AND created_at > ?",
    [userId, addMinutes(-1)],
  );
  if (recent) throw rateLimited("O convite acabou de ser enviado. Aguarde um minuto para reenviar.");
}

// Stops a user's access immediately (sessions and unused links).
export async function cutAccess(db, userId) {
  await revokeUserSessions(db, userId);
  await db.run("DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL", [userId]);
}

// Active administrators other than exceptId.
async function activeAdminCount(db, exceptId) {
  return (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?", [exceptId])).n;
}

// ------------------------------------------------------------------ serializers

async function staffAccess(req, rows) {
  const db = req.ctx.db;
  const ids = rows.map((row) => row.id);
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const scope = await getScope(req);
  const visible = (clientId) => scope.all || scope.clientIds?.has(clientId);
  for (const row of await db.all(
    `SELECT a.user_id, c.id, c.name FROM staff_client_access a JOIN clients c ON c.id = a.client_id
      WHERE a.user_id IN (${placeholders(ids)}) ORDER BY c.name COLLATE utf8mb4_0900_ai_ci`,
    ids,
  ))
    if (visible(row.id)) out.get(row.user_id)?.push({ id: row.id, name: row.name });
  // designers reach clients through their projects
  for (const row of await db.all(
    `SELECT DISTINCT pm.user_id, c.id, c.name FROM project_members pm
       JOIN projects p ON p.id = pm.project_id JOIN brands b ON b.id = p.brand_id
       JOIN clients c ON c.id = b.client_id JOIN users u ON u.id = pm.user_id
      WHERE u.role = 'designer' AND pm.user_id IN (${placeholders(ids)}) ORDER BY c.name COLLATE utf8mb4_0900_ai_ci`,
    ids,
  ))
    if (visible(row.id)) out.get(row.user_id)?.push({ id: row.id, name: row.name });
  return out;
}

export async function serializeStaff(req, rows) {
  const db = req.ctx.db;
  const ids = rows.map((row) => row.id);
  const clients = await staffAccess(req, rows);
  const invites = await inviteInfo(db, ids.filter((id, i) => rows[i].status === "invited"));
  const projectCounts = new Map(
    ids.length
      ? (await db
          .all(
            `SELECT pm.user_id, COUNT(*) AS n FROM project_members pm JOIN projects p ON p.id = pm.project_id
              WHERE p.status NOT IN ('archived', 'delivered') AND pm.user_id IN (${placeholders(ids)}) GROUP BY pm.user_id`,
            ids,
          ))
          .map((row) => [row.user_id, row.n])
      : [],
  );
  return rows.map((row) => ({
    ...serializeUser(req, row),
    access: {
      kind: row.role === "admin" || row.role === "finance" ? "all" : row.role === "manager" ? "clients" : "projects",
      clients: clients.get(row.id) ?? [],
    },
    activeProjects: projectCounts.get(row.id) ?? 0,
    invite: invites.get(row.id) ?? null,
    isSelf: row.id === req.user.id,
  }));
}

// ------------------------------------------------------------------ schemas

const staffRole = z.enum(STAFF_ROLES, { error: "Escolha um papel da equipe." });
const inviteSchema = z.object({
  name: schemas.text(120),
  email: schemas.email,
  role: staffRole,
  jobTitle: schemas.optionalText(120),
  clientIds: z.array(schemas.id).max(500).optional(),
});
const patchSchema = z
  .object({
    name: schemas.text(120).optional(),
    role: staffRole.optional(),
    status: z.enum(["active", "disabled"], { error: "Escolha ativo ou desativado." }).optional(),
    jobTitle: schemas.optionalText(120),
  })
  .strict();
const accessSchema = z.object({ clientIds: z.array(schemas.id).max(500) });

async function assertClientIds(db, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const found = await db.all(`SELECT id FROM clients WHERE id IN (${placeholders(unique)})`, unique);
  if (found.length !== unique.length) throw validation({ clientIds: "Algum cliente selecionado não existe mais." });
  return unique;
}

async function loadStaff(db, id) {
  const row = id ? await db.get("SELECT * FROM users WHERE id = ?", [id]) : null;
  if (!row || row.role === "client") throw notFound();
  return row;
}

// Replaces a manager's client access; returns { added, removed } client ids.
export async function replaceClientAccess(req, userId, clientIds) {
  const db = req.ctx.db;
  const current = (await db.all("SELECT client_id FROM staff_client_access WHERE user_id = ?", [userId])).map((r) => r.client_id);
  const next = new Set(clientIds);
  const added = clientIds.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !next.has(id));
  const at = now();
  for (const id of removed) await db.run("DELETE FROM staff_client_access WHERE user_id = ? AND client_id = ?", [userId, id]);
  for (const id of added)
    await db.run("INSERT IGNORE INTO staff_client_access (user_id, client_id, granted_by, granted_at) VALUES (?, ?, ?, ?)", [
      userId,
      id,
      req.user.id,
      at,
    ]);
  return { added, removed };
}

export async function notifyAccessGranted(req, user, clientIds) {
  if (!clientIds.length) return;
  const db = req.ctx.db;
  const names = (await db
    .all(`SELECT name FROM clients WHERE id IN (${placeholders(clientIds)}) ORDER BY name COLLATE utf8mb4_0900_ai_ci`, clientIds))
    .map((row) => row.name);
  await notify(req, [user.id], {
    type: "team.client_access",
    title: names.length === 1 ? `Acesso liberado: ${names[0]}` : `Acesso liberado a ${names.length} clientes`,
    body: names.length === 1 ? "Você agora gerencia este cliente, suas marcas e projetos." : names.join(", "),
    link: clientIds.length === 1 ? `/admin/clientes/${clientIds[0]}` : "/admin/clientes",
    entityType: "client",
    entityId: clientIds.length === 1 ? clientIds[0] : null,
  });
}

// ------------------------------------------------------------------ router

export default function teamRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  router.get("/api/team/users", requireCap("team.view"), async (req, res) => {
    const where = ["u.role != 'client'"];
    const params = [];
    const role = typeof req.query.role === "string" ? req.query.role : "";
    if (STAFF_ROLES.includes(role)) {
      where.push("u.role = ?");
      params.push(role);
    }
    const status = typeof req.query.status === "string" ? req.query.status : "";
    if (["invited", "active", "disabled"].includes(status)) {
      where.push("u.status = ?");
      params.push(status);
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      where.push("(u.name LIKE ? COLLATE utf8mb4_0900_ai_ci OR u.email LIKE ? COLLATE utf8mb4_0900_ai_ci OR u.job_title LIKE ? COLLATE utf8mb4_0900_ai_ci)");
      const like = `%${escapeLike(q)}%`;
      params.push(like, like, like);
    }
    const rows = await db.all(
      `SELECT u.* FROM users u WHERE ${where.join(" AND ")}
        ORDER BY u.status = 'disabled', CASE u.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 WHEN 'designer' THEN 2 ELSE 3 END,
                 u.name COLLATE utf8mb4_0900_ai_ci`,
      params,
    );
    res.json({
      items: await serializeStaff(req, rows),
      total: rows.length,
      permissions: { canManage: can(req.user, "team.manage") },
      email: { configured: ctx.mailer.isConfigured() },
    });
  });

  // Role -> capabilities straight from the server map (read-only matrix).
  router.get("/api/team/roles", requireCap("team.view"), (req, res) => {
    res.json({
      items: ROLES.map((role) => ({ role, label: ROLE_LABELS[role], capabilities: capabilitiesFor(role) })),
    });
  });

  router.post("/api/team/users", requireCap("team.manage"), async (req, res) => {
    const input = parse(inviteSchema, req.body);
    if (await db.get("SELECT id FROM users WHERE email = ?", [input.email]))
      throw validation({ email: "Já existe um acesso com este e-mail." });
    const clientIds = input.role === "manager" ? await assertClientIds(db, input.clientIds ?? []) : [];
    const id = newId("usr");
    const at = now();
    await db.tx(async () => {
      await db.run(
        `INSERT INTO users (id, email, name, role, status, job_title, notify_email, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'invited', ?, ?, ?, ?, ?)`,
        [id, input.email, input.name, input.role, input.jobTitle ?? null, await getSetting(db, "defaultNotifyEmail") === false ? 0 : 1, req.user.id, at, at],
      );
      if (clientIds.length) await replaceClientAccess(req, id, clientIds);
      await logActivity(req, {
        action: "user.invited",
        entityType: "user",
        entityId: id,
        summary: `${input.name} foi convidado para a equipe como ${ROLE_LABELS[input.role]}.`,
        data: { role: input.role, clientIds },
      });
    });
    const row = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    const invite = await deliverInvite(req, row);
    res.status(201).json({ user: (await serializeStaff(req, [await db.get("SELECT * FROM users WHERE id = ?", [id])]))[0], ...invite });
  });

  router.patch("/api/team/users/:id", requireCap("team.manage"), async (req, res) => {
    const target = await loadStaff(db, req.params.id);
    const input = parse(patchSchema, req.body);
    const self = target.id === req.user.id;
    const roleChange = input.role !== undefined && input.role !== target.role;
    let nextStatus = input.status;
    // someone who never set a password goes back to "invited", not "active"
    if (nextStatus === "active" && !target.password_hash) nextStatus = "invited";
    const statusChange = nextStatus !== undefined && nextStatus !== target.status;

    if (self && (roleChange || (statusChange && nextStatus === "disabled")))
      throw conflict("Você não pode alterar o próprio papel nem desativar o próprio acesso.", "self_change");
    const losesAdmin = target.role === "admin" && target.status === "active" && (roleChange || nextStatus === "disabled");
    if (losesAdmin && await activeAdminCount(db, target.id) === 0)
      throw conflict("É preciso manter pelo menos um administrador ativo.", "last_admin");

    const sets = [];
    const params = [];
    const set = (column, value) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (input.name !== undefined && input.name !== target.name) set("name", input.name);
    if (input.jobTitle !== undefined && input.jobTitle !== target.job_title) set("job_title", input.jobTitle);
    if (roleChange) set("role", input.role);
    if (statusChange) set("status", nextStatus);
    if (!sets.length) return res.json({ user: (await serializeStaff(req, [target]))[0] });

    await db.tx(async () => {
      set("updated_at", now());
      await db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...params, target.id]);
      if (statusChange && nextStatus === "disabled") await cutAccess(db, target.id);
      // client access only means something for managers
      if (roleChange && target.role === "manager") await db.run("DELETE FROM staff_client_access WHERE user_id = ?", [target.id]);
      const parts = [];
      if (roleChange) parts.push(`papel alterado de ${ROLE_LABELS[target.role]} para ${ROLE_LABELS[input.role]}`);
      if (statusChange)
        parts.push(nextStatus === "disabled" ? "acesso desativado" : nextStatus === "active" ? "acesso reativado" : "acesso reativado (convite pendente)");
      if (input.name !== undefined && input.name !== target.name) parts.push("nome atualizado");
      if (input.jobTitle !== undefined && input.jobTitle !== target.job_title) parts.push("cargo atualizado");
      await logActivity(req, {
        action: statusChange && nextStatus === "disabled" ? "user.disabled" : roleChange ? "user.role_changed" : "user.updated",
        entityType: "user",
        entityId: target.id,
        summary: `${target.name}: ${parts.join(", ")}.`,
        data: { role: roleChange ? { from: target.role, to: input.role } : undefined, status: statusChange ? { from: target.status, to: nextStatus } : undefined },
      });
    });
    res.json({ user: (await serializeStaff(req, [await db.get("SELECT * FROM users WHERE id = ?", [target.id])]))[0] });
  });

  router.put("/api/team/users/:id/clients", requireCap("team.manage"), async (req, res) => {
    const target = await loadStaff(db, req.params.id);
    if (target.role !== "manager")
      throw validation({ clientIds: "Somente gestores recebem acesso por cliente. Designers acessam pelos projetos atribuídos." });
    const { clientIds: raw } = parse(accessSchema, req.body);
    const clientIds = await assertClientIds(db, raw);
    let change;
    await db.tx(async () => {
      change = await replaceClientAccess(req, target.id, clientIds);
      if (change.added.length || change.removed.length)
        await logActivity(req, {
          action: "user.client_access",
          entityType: "user",
          entityId: target.id,
          summary: `Acesso de ${target.name} atualizado: ${change.added.length} cliente(s) adicionado(s), ${change.removed.length} removido(s).`,
          data: change,
        });
      if (target.status !== "disabled") await notifyAccessGranted(req, target, change.added);
    });
    res.json({ user: (await serializeStaff(req, [target]))[0], ...change });
  });

  // Resend an invitation: staff needs team.manage; client users follow the
  // client's managers (clients.edit or brands.edit within scope).
  router.post("/api/users/:id/invite", requireAuth, async (req, res) => {
    const target = req.params.id ? await db.get("SELECT * FROM users WHERE id = ?", [req.params.id]) : null;
    if (!target) throw notFound();
    let clientName = null;
    if (target.role === "client") {
      if (!can(req.user, "clients.edit") && !can(req.user, "brands.edit")) throw forbidden();
      const scope = await getScope(req);
      if (!(scope.all || (req.user.role === "manager" && scope.clientIds.has(target.client_id)))) throw notFound();
      clientName = (await db.get("SELECT name FROM clients WHERE id = ?", [target.client_id]))?.name ?? null;
    } else if (!can(req.user, "team.manage")) {
      throw can(req.user, "team.view") ? forbidden() : notFound();
    }
    if (target.status !== "invited")
      throw conflict(
        target.status === "active" ? "Esta pessoa já ativou o acesso." : "Este acesso está desativado. Reative antes de reenviar o convite.",
        "not_invited",
      );
    await assertResendAllowed(db, target.id);
    const invite = await deliverInvite(req, target, { clientName });
    await logActivity(req, {
      action: "user.invite_resent",
      entityType: "user",
      entityId: target.id,
      clientId: target.client_id ?? null,
      summary: `Convite reenviado para ${target.name}.`,
    });
    res.json({ user: serializeUser(req, target), invite: (await inviteInfo(db, [target.id])).get(target.id) ?? null, ...invite });
  });

  return router;
}

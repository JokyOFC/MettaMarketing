import { Router } from "express";
import {
  assertLoginAllowed,
  burnPasswordCheck,
  clearSessionCookie,
  clientIp,
  consumeToken,
  createSession,
  hashPassword,
  issueToken,
  passwordProblem,
  peekToken,
  recordLoginAttempt,
  requireAuth,
  revokeSession,
  revokeUserSessions,
  toRequestUser,
  verifyPassword,
} from "../lib/auth.js";
import { logActivity } from "../lib/audit.js";
import { renderEmail } from "../lib/emails.js";
import { expired, forbidden, HttpError, notFound, validation } from "../lib/errors.js";
import { serializeMe } from "../lib/serialize.js";
import { addMinutes, now } from "../lib/time.js";
import { parse, schemas, z } from "../lib/validate.js";

const INVALID_CREDENTIALS = "E-mail ou senha incorretos.";
const RESET_TTL_HOURS = 2;

const loginSchema = z.object({
  email: z.string().trim().min(1, "Informe seu e-mail.").max(254),
  password: z.string().min(1, "Informe sua senha.").max(256),
});
const acceptSchema = z.object({
  token: z.string().min(1).max(200),
  password: z.string().max(256),
  name: schemas.optionalText(120),
});
const forgotSchema = z.object({ email: z.string().trim().max(254) });
const resetSchema = z.object({ token: z.string().min(1).max(200), password: z.string().max(256) });
const changeSchema = z.object({
  currentPassword: z.string().min(1, "Informe a senha atual.").max(256),
  newPassword: z.string().max(256),
});
const profileSchema = z.object({
  name: schemas.text(120).optional(),
  jobTitle: schemas.optionalText(120),
  phone: schemas.optionalText(40),
  notifyEmail: z.boolean().optional(),
});

function checkPassword(password, email, field = "password") {
  const problem = passwordProblem(password, email);
  if (problem) throw validation({ [field]: problem });
}

async function freshUser(db, id) {
  return toRequestUser(await db.get("SELECT * FROM users WHERE id = ?", [id]));
}

export default function authRoutes(ctx) {
  const router = Router();
  const { db } = ctx;

  router.post("/api/auth/login", async (req, res) => {
    const { email: rawEmail, password } = parse(loginSchema, req.body);
    const email = rawEmail.toLowerCase();
    const ip = clientIp(req);
    await assertLoginAllowed(db, email, ip);

    const user = await db.get("SELECT * FROM users WHERE email = ?", [email]);
    const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : await burnPasswordCheck(password);
    if (!ok || !user || user.status === "invited") {
      await recordLoginAttempt(db, email, ip, false);
      throw new HttpError(401, "invalid_credentials", INVALID_CREDENTIALS);
    }
    if (user.status !== "active") {
      await recordLoginAttempt(db, email, ip, false);
      throw forbidden("Seu acesso está desativado. Fale com a equipe Metta.");
    }
    await recordLoginAttempt(db, email, ip, true);
    // a fresh session on every login (no fixation)
    if (req.session) await revokeSession(db, req.session.id);
    const at = now();
    await db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [at, user.id]);
    const session = await createSession(ctx, user, req);
    req.user = toRequestUser({ ...user, last_login_at: at });
    req.session = { id: session.id };
    res.json({ user: await serializeMe(req, req.user) });
  });

  router.post("/api/auth/logout", async (req, res) => {
    if (req.session) await revokeSession(db, req.session.id);
    clearSessionCookie(res, ctx.config);
    res.status(204).end();
  });

  router.get("/api/auth/me", requireAuth, async (req, res) => {
    res.json({ user: await serializeMe(req, req.user) });
  });

  // Validates an invitation or reset link before showing the form.
  router.get("/api/auth/invite/:token", async (req, res) => {
    const found = await peekToken(ctx, req.params.token);
    if (!found) throw expired("Este link expirou ou já foi usado. Peça um novo à equipe Metta.");
    res.json({ email: found.user.email, name: found.user.name, purpose: found.token.purpose });
  });

  router.post("/api/auth/invite/accept", async (req, res) => {
    const input = parse(acceptSchema, req.body);
    const found = await peekToken(ctx, input.token, "invite");
    if (!found) throw expired("Este convite expirou ou já foi usado. Peça um novo à equipe Metta.");
    checkPassword(input.password, found.user.email);
    const hash = await hashPassword(input.password);
    const user = await consumeToken(ctx, input.token, "invite");
    const at = now();
    await db.tx(async () => {
      await db.run(
        "UPDATE users SET password_hash = ?, status = 'active', name = COALESCE(?, name), last_login_at = ?, updated_at = ? WHERE id = ? AND status = 'invited'",
        [hash, input.name ?? null, at, at, user.id],
      );
      await db.run("DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL", [user.id]);
      await revokeUserSessions(db, user.id);
    });
    const active = await freshUser(db, user.id);
    if (!active || active.status !== "active") throw expired("Este convite não pode mais ser usado.");
    if (req.session) await revokeSession(db, req.session.id);
    const session = await createSession(ctx, active, req);
    req.user = active;
    req.session = { id: session.id };
    await logActivity(req, {
      action: "user.invite_accepted",
      entityType: "user",
      entityId: active.id,
      clientId: active.client_id ?? null,
      summary: `${active.name} aceitou o convite e ativou o acesso.`,
      visibility: active.role === "client" ? "client" : "internal",
    });
    res.json({ user: await serializeMe(req, active) });
  });

  router.post("/api/auth/password/forgot", async (req, res) => {
    const { email } = parse(forgotSchema, req.body);
    const user = email ? await db.get("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]) : null;
    if (user && user.status === "active") {
      const recent = await db.get(
        "SELECT 1 AS yes FROM auth_tokens WHERE user_id = ? AND purpose = 'reset' AND created_at > ?",
        [user.id, addMinutes(-1)],
      );
      if (!recent) {
        const token = await issueToken(ctx, user.id, "reset", RESET_TTL_HOURS);
        const message = renderEmail({
          title: "Redefinição de senha",
          intro: `Olá, ${user.name}. Recebemos um pedido para redefinir a senha do seu acesso à plataforma da Metta.`,
          lines: [`O link vale por ${RESET_TTL_HOURS} horas e pode ser usado uma vez. Se você não pediu, ignore este e-mail: sua senha continua a mesma.`],
          actionLabel: "Criar nova senha",
          actionUrl: `${ctx.config.appUrl}/redefinir-senha/${token}`,
        });
        // recorded before answering; the SMTP delivery does not delay the response
        await ctx.mailer.enqueue({ to: user.email, toUserId: user.id, ...message });
      }
    }
    res.status(204).end();
  });

  router.post("/api/auth/password/reset", async (req, res) => {
    const input = parse(resetSchema, req.body);
    const found = await peekToken(ctx, input.token, "reset");
    if (!found) throw expired("Este link expirou ou já foi usado. Peça uma nova redefinição.");
    checkPassword(input.password, found.user.email);
    const hash = await hashPassword(input.password);
    const user = await consumeToken(ctx, input.token, "reset");
    await db.tx(async () => {
      await db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [hash, now(), user.id]);
      await db.run("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'reset' AND used_at IS NULL", [user.id]);
      await revokeUserSessions(db, user.id);
    });
    await logActivity(ctx, {
      actorId: user.id,
      actorRole: user.role,
      action: "user.password_reset",
      entityType: "user",
      entityId: user.id,
      summary: `${user.name} redefiniu a senha por e-mail.`,
    });
    res.status(204).end();
  });

  router.post("/api/auth/password/change", requireAuth, async (req, res) => {
    const input = parse(changeSchema, req.body);
    const ip = clientIp(req);
    const row = await db.get("SELECT * FROM users WHERE id = ?", [req.user.id]);
    await assertLoginAllowed(db, row.email, ip);
    if (!(await verifyPassword(input.currentPassword, row.password_hash))) {
      await recordLoginAttempt(db, row.email, ip, false);
      throw validation({ currentPassword: "Senha atual incorreta." });
    }
    checkPassword(input.newPassword, row.email, "newPassword");
    if (input.newPassword === input.currentPassword)
      throw validation({ newPassword: "Escolha uma senha diferente da atual." });
    const hash = await hashPassword(input.newPassword);
    await db.tx(async () => {
      await db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [hash, now(), row.id]);
      await revokeUserSessions(db, row.id, { exceptId: req.session.id });
    });
    await logActivity(req, {
      action: "user.password_changed",
      entityType: "user",
      entityId: row.id,
      summary: `${row.name} alterou a senha e encerrou as outras sessões.`,
    });
    res.status(204).end();
  });

  router.patch("/api/auth/profile", requireAuth, async (req, res) => {
    const input = parse(profileSchema, req.body);
    const sets = [];
    const params = [];
    const set = (column, value) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (input.name !== undefined) set("name", input.name);
    if (input.jobTitle !== undefined) set("job_title", input.jobTitle);
    if (input.phone !== undefined) set("phone", input.phone);
    if (input.notifyEmail !== undefined) set("notify_email", input.notifyEmail ? 1 : 0);
    if (sets.length) {
      set("updated_at", now());
      await db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...params, req.user.id]);
    }
    req.user = await freshUser(db, req.user.id);
    res.json({ user: await serializeMe(req, req.user) });
  });

  router.get("/api/auth/sessions", requireAuth, async (req, res) => {
    const rows = await db.all(
      `SELECT id, created_at, last_seen_at, user_agent, ip FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY last_seen_at DESC`,
      [req.user.id, now()],
    );
    res.json({
      items: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        userAgent: row.user_agent,
        ip: row.ip,
        current: row.id === req.session.id,
      })),
    });
  });

  router.delete("/api/auth/sessions/:id", requireAuth, async (req, res) => {
    const row = await db.get("SELECT id FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL", [
      req.params.id,
      req.user.id,
    ]);
    if (!row) throw notFound();
    await revokeSession(db, row.id);
    if (row.id === req.session.id) clearSessionCookie(res, ctx.config);
    res.status(204).end();
  });

  return router;
}

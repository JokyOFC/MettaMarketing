// Self sign-up (docs/PLATFORM.md §2.5). A person creates the client account
// (company) and its first access at /cadastro. The access stays 'pending'
// until the e-mail link is opened (/confirmar-email/:token); then it logs in
// and the Metta admins are notified. Answers never reveal whether an e-mail
// already has an account, and the team can close sign-up in Configurações.
import { Router } from "express";
import {
  clientIp,
  consumeToken,
  createSession,
  hashPassword,
  issueToken,
  passwordProblem,
  peekToken,
  revokeSession,
  toRequestUser,
} from "../lib/auth.js";
import { logActivity } from "../lib/audit.js";
import { renderEmail } from "../lib/emails.js";
import { expired, forbidden, rateLimited, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { adminIds, notify } from "../lib/notify.js";
import { serializeMe } from "../lib/serialize.js";
import { getSetting } from "../lib/settings.js";
import { addMinutes, now } from "../lib/time.js";
import { parse, schemas, z } from "../lib/validate.js";

export const VERIFY_TTL_HOURS = 48;
const SIGNUPS_PER_IP = { max: 5, windowMs: 60 * 60 * 1000 };
const EXISTING_NOTICE_MS = 60 * 60 * 1000;

const signupSchema = z.object({
  name: schemas.text(120),
  email: schemas.email,
  company: schemas.text(160),
  phone: schemas.optionalText(40),
  document: schemas.optionalText(40),
  password: z.string().max(256),
  acceptTerms: z
    .boolean({ error: "Aceite os termos para criar a conta." })
    .refine((value) => value === true, "Aceite os termos para criar a conta."),
  // Honeypot: hidden from people, filled by bots.
  website: z.string().max(200).optional(),
});
const emailSchema = z.object({ email: z.string().trim().toLowerCase().max(254) });
const tokenSchema = z.object({ token: z.string().min(1).max(200) });

// CPF (11 digits) or CNPJ (14 digits), with or without punctuation.
function documentProblem(document) {
  if (!document) return null;
  const digits = document.replace(/\D/g, "");
  return digits.length === 11 || digits.length === 14 ? null : "Informe um CPF (11 dígitos) ou um CNPJ (14 dígitos).";
}

// In-memory counter per key within a window (one per app instance).
function windowLimiter({ max, windowMs }) {
  const hits = new Map();
  return function allow(key) {
    const at = Date.now();
    if (hits.size > 5000) for (const [k, entry] of hits) if (at - entry.start > windowMs) hits.delete(k);
    let entry = hits.get(key);
    if (!entry || at - entry.start > windowMs) {
      entry = { start: at, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

export async function signupOpen(db) {
  return (await getSetting(db, "signupEnabled", true)) !== false;
}

export default function signupRoutes(ctx) {
  const router = Router();
  const { db } = ctx;
  // Development and tests sign up many accounts from 127.0.0.1.
  const allowSignup = windowLimiter(ctx.config.isProduction ? SIGNUPS_PER_IP : { ...SIGNUPS_PER_IP, max: 200 });
  const existingNoticeSentAt = new Map();

  const confirmUrl = (token) => `${ctx.config.appUrl}/confirmar-email/${token}`;

  // New 'verify' link (older unused ones stop working), recorded in the outbox.
  async function sendConfirmation(user, company) {
    const token = await issueToken(ctx, user.id, "verify", VERIFY_TTL_HOURS);
    const message = renderEmail({
      title: "Confirme seu e-mail",
      intro: `Olá, ${user.name}. Recebemos o cadastro${company ? ` de ${company}` : ""} na plataforma da Metta Marketing.`,
      lines: [
        "Para ativar o acesso, confirme que este e-mail é seu pelo link abaixo.",
        `Ele vale por ${VERIFY_TTL_HOURS} horas e pode ser usado uma vez. Se você não fez este cadastro, ignore este e-mail: nenhum acesso será ativado.`,
      ],
      actionLabel: "Confirmar e-mail e entrar",
      actionUrl: confirmUrl(token),
    });
    await ctx.mailer.enqueue({ to: user.email, toUserId: user.id, ...message });
  }

  // Someone tried to sign up with an e-mail that already has an account: the
  // owner gets a heads-up (at most once an hour), the form gets the usual answer.
  async function noticeExistingAccount(user) {
    const last = existingNoticeSentAt.get(user.id) ?? 0;
    if (Date.now() - last < EXISTING_NOTICE_MS || user.status === "disabled") return;
    existingNoticeSentAt.set(user.id, Date.now());
    const message = renderEmail({
      title: "Tentativa de cadastro com o seu e-mail",
      intro: `Olá, ${user.name}. Alguém tentou criar uma conta na plataforma da Metta com este e-mail, que já tem um acesso.`,
      lines: [
        "Se foi você, entre com a sua senha. Se não lembrar dela, use “Esqueci minha senha” na tela de entrada.",
        "Se não foi você, nada muda: o seu acesso continua como estava.",
      ],
      actionLabel: "Entrar na plataforma",
      actionUrl: `${ctx.config.appUrl}/login`,
    });
    await ctx.mailer.enqueue({ to: user.email, toUserId: user.id, ...message });
  }

  // Whether /cadastro shows the form (public).
  router.get("/api/auth/signup", async (req, res) => {
    res.json({ enabled: await signupOpen(db) });
  });

  router.post("/api/auth/signup", async (req, res) => {
    if (!(await signupOpen(db)))
      throw forbidden("O cadastro pelo site está fechado no momento. Fale com a Metta para receber um convite.", "signup_closed");
    const input = parse(signupSchema, req.body);
    const accepted = () => res.status(202).json({ email: input.email });
    if (input.website) return accepted();
    if (!allowSignup(clientIp(req) ?? "unknown")) throw rateLimited("Muitos cadastros seguidos deste endereço. Tente de novo mais tarde.");
    const fields = {};
    const password = passwordProblem(input.password, input.email);
    if (password) fields.password = password;
    const document = documentProblem(input.document);
    if (document) fields.document = document;
    if (Object.keys(fields).length) throw validation(fields);

    const existing = await db.get("SELECT * FROM users WHERE email = ?", [input.email]);
    if (existing) {
      if (existing.status === "pending") {
        const recent = await db.get("SELECT 1 AS yes FROM auth_tokens WHERE user_id = ? AND purpose = 'verify' AND created_at > ?", [
          existing.id,
          addMinutes(-1),
        ]);
        if (!recent) await sendConfirmation(existing);
      } else await noticeExistingAccount(existing);
      return accepted();
    }

    const hash = await hashPassword(input.password);
    const notifyEmail = (await getSetting(db, "defaultNotifyEmail", true)) !== false;
    const at = now();
    const clientId = newId("cli");
    const userId = newId("usr");
    try {
      await db.tx(async () => {
        await db.run(
          `INSERT INTO clients (id, name, document, contact_name, contact_email, contact_phone, status, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 'signup', ?, ?)`,
          [clientId, input.company, input.document ?? null, input.name, input.email, input.phone ?? null, at, at],
        );
        await db.run(
          `INSERT INTO users (id, email, name, role, client_id, password_hash, status, phone, notify_email, terms_accepted_at,
             created_at, updated_at)
           VALUES (?, ?, ?, 'client', ?, ?, 'pending', ?, ?, ?, ?, ?)`,
          [userId, input.email, input.name, clientId, hash, input.phone ?? null, notifyEmail ? 1 : 0, at, at, at],
        );
        await logActivity(ctx, {
          actorId: userId,
          actorRole: "client",
          action: "client.signed_up",
          entityType: "client",
          entityId: clientId,
          clientId,
          summary: `${input.name} criou a conta de ${input.company} pelo site (aguardando a confirmação do e-mail).`,
          data: { email: input.email },
        });
        await sendConfirmation({ id: userId, email: input.email, name: input.name }, input.company);
      });
    } catch (err) {
      // Same e-mail sent twice at once: the second one gets the usual answer.
      if (err?.code === "ER_DUP_ENTRY") return accepted();
      throw err;
    }
    accepted();
  });

  // Sends a new confirmation link (the answer is the same for any e-mail).
  router.post("/api/auth/signup/resend", async (req, res) => {
    const { email } = parse(emailSchema, req.body);
    if (!allowSignup(`resend:${clientIp(req) ?? "unknown"}`)) throw rateLimited("Muitos pedidos seguidos. Aguarde alguns minutos.");
    const user = email ? await db.get("SELECT * FROM users WHERE email = ?", [email]) : null;
    if (user?.status === "pending") {
      const recent = await db.get("SELECT 1 AS yes FROM auth_tokens WHERE user_id = ? AND purpose = 'verify' AND created_at > ?", [
        user.id,
        addMinutes(-1),
      ]);
      if (!recent) {
        const client = await db.get("SELECT name FROM clients WHERE id = ?", [user.client_id]);
        await sendConfirmation(user, client?.name);
      }
    }
    res.status(202).end();
  });

  // Checks a confirmation link before showing the button (opening it with a
  // GET — e-mail scanners do — never activates anything).
  router.get("/api/auth/verify/:token", async (req, res) => {
    const found = await peekToken(ctx, req.params.token, "verify");
    if (!found) throw expired("Este link expirou ou já foi usado. Peça um novo na tela de entrada.");
    const client = await db.get("SELECT name FROM clients WHERE id = ?", [found.user.client_id]);
    res.json({ email: found.user.email, name: found.user.name, company: client?.name ?? null });
  });

  // Confirms the e-mail: activates the access, signs in and tells the team.
  router.post("/api/auth/verify", async (req, res) => {
    const { token } = parse(tokenSchema, req.body);
    const found = await peekToken(ctx, token, "verify");
    if (!found) throw expired("Este link expirou ou já foi usado. Peça um novo na tela de entrada.");
    const user = await consumeToken(ctx, token, "verify");
    const client = await db.get("SELECT * FROM clients WHERE id = ?", [user.client_id]);
    const at = now();
    await db.tx(async () => {
      const { changes } = await db.run(
        "UPDATE users SET status = 'active', last_login_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        [at, at, user.id],
      );
      if (!changes) throw expired("Este link não pode mais ser usado.");
      await db.run("DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL", [user.id]);
      await logActivity(ctx, {
        actorId: user.id,
        actorRole: "client",
        action: "client.email_confirmed",
        entityType: "user",
        entityId: user.id,
        clientId: user.client_id,
        summary: `${user.name} confirmou o e-mail e ativou o acesso de ${client?.name ?? "sua empresa"}.`,
        visibility: "client",
      });
      await notify(ctx, await adminIds(db), {
        type: "client.signed_up",
        title: "Novo cadastro pelo site",
        body: `${user.name} criou a conta de ${client?.name ?? "uma empresa"} e confirmou o e-mail (${user.email}).`,
        link: `/admin/clientes/${user.client_id}`,
        entityType: "client",
        entityId: user.client_id,
        email: true,
        emailLines: ["A conta ainda não tem marcas, projetos nem gestores: configure pelo painel."],
        actionLabel: "Abrir o cliente",
      });
    });
    const active = toRequestUser(await db.get("SELECT * FROM users WHERE id = ?", [user.id]));
    if (req.session) await revokeSession(db, req.session.id);
    const session = await createSession(ctx, active, req);
    req.user = active;
    req.session = { id: session.id };
    res.json({ user: await serializeMe(req, active) });
  });

  return router;
}

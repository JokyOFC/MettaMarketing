// Self sign-up (docs/PLATFORM.md §2.5). A person creates the client account
// (company) and its first access at /cadastro, and is signed in right away;
// the Metta admins are notified. The team can close sign-up in Configurações.
import { Router } from "express";
import { clientIp, createSession, hashPassword, passwordProblem, revokeSession, toRequestUser } from "../lib/auth.js";
import { logActivity } from "../lib/audit.js";
import { badRequest, forbidden, rateLimited, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { adminIds, notify } from "../lib/notify.js";
import { serializeMe } from "../lib/serialize.js";
import { getSetting } from "../lib/settings.js";
import { now } from "../lib/time.js";
import { parse, schemas, z } from "../lib/validate.js";

const SIGNUPS_PER_IP = { max: 5, windowMs: 60 * 60 * 1000 };
const EMAIL_TAKEN = "Este e-mail já tem um acesso. Entre com a sua senha ou use “Esqueci minha senha”.";

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

  // Whether /cadastro shows the form (public).
  router.get("/api/auth/signup", async (req, res) => {
    res.json({ enabled: await signupOpen(db) });
  });

  // Creates the company and an active client access, then signs in.
  router.post("/api/auth/signup", async (req, res) => {
    if (!(await signupOpen(db)))
      throw forbidden("O cadastro pelo site está fechado no momento. Fale com a Metta para receber um convite.", "signup_closed");
    const input = parse(signupSchema, req.body);
    if (input.website) throw badRequest("Não foi possível concluir o cadastro. Tente de novo.");
    if (!allowSignup(clientIp(req) ?? "unknown")) throw rateLimited("Muitos cadastros seguidos deste endereço. Tente de novo mais tarde.");
    const fields = {};
    const password = passwordProblem(input.password, input.email);
    if (password) fields.password = password;
    const document = documentProblem(input.document);
    if (document) fields.document = document;
    if (await db.get("SELECT id FROM users WHERE email = ?", [input.email])) fields.email = EMAIL_TAKEN;
    if (Object.keys(fields).length) throw validation(fields);

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
             last_login_at, created_at, updated_at)
           VALUES (?, ?, ?, 'client', ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
          [userId, input.email, input.name, clientId, hash, input.phone ?? null, notifyEmail ? 1 : 0, at, at, at, at],
        );
        await logActivity(ctx, {
          actorId: userId,
          actorRole: "client",
          action: "client.signed_up",
          entityType: "client",
          entityId: clientId,
          clientId,
          summary: `${input.name} criou a conta de ${input.company} pelo site.`,
          data: { email: input.email },
          visibility: "client",
        });
        await notify(ctx, await adminIds(db), {
          type: "client.signed_up",
          title: "Novo cadastro pelo site",
          body: `${input.name} criou a conta de ${input.company} (${input.email}).`,
          link: `/admin/clientes/${clientId}`,
          entityType: "client",
          entityId: clientId,
          email: true,
          emailLines: ["A conta ainda não tem marcas, projetos nem gestores: configure pelo painel."],
          actionLabel: "Abrir o cliente",
        });
      });
    } catch (err) {
      // Same e-mail sent twice at once.
      if (err?.code === "ER_DUP_ENTRY") throw validation({ email: EMAIL_TAKEN });
      throw err;
    }

    const user = toRequestUser(await db.get("SELECT * FROM users WHERE id = ?", [userId]));
    if (req.session) await revokeSession(db, req.session.id);
    const session = await createSession(ctx, user, req);
    req.user = user;
    req.session = { id: session.id };
    res.status(201).json({ user: await serializeMe(req, user) });
  });

  return router;
}

// Organization settings, integration status and the e-mail outbox (slice H).
// Admin only (settings.manage). Secrets never leave the server: the
// integrations answer says what is configured, not the credentials, and the
// outbox never returns bodies with invitation, reset or download links.
import { Router } from "express";
import { logActivity } from "../lib/audit.js";
import { requireAuth, requireCap } from "../lib/auth.js";
import { conflict, notConfigured, notFound } from "../lib/errors.js";
import { renderEmail } from "../lib/emails.js";
import { getSettings, setSetting } from "../lib/settings.js";
import { paginate, parse, queryList, schemas, z } from "../lib/validate.js";

const EMAIL_STATUSES = ["queued", "sent", "failed", "not_configured"];

const settingsSchema = z.object({
  orgName: schemas.text(120).optional(),
  supportEmail: schemas.email.optional(),
  defaultNotifyEmail: z.boolean().optional(),
  signupEnabled: z.boolean().optional(),
  zipRetentionHours: z
    .number({ error: "Informe um número de horas." })
    .int("Use um número inteiro de horas.")
    .min(1, "Use pelo menos 1 hora.")
    .max(720, "Use no máximo 720 horas (30 dias).")
    .optional(),
});

const SETTING_LABELS = {
  orgName: "nome da organização",
  supportEmail: "e-mail de suporte",
  defaultNotifyEmail: "avisos por e-mail para novos usuários",
  signupEnabled: "cadastro aberto no site",
  zipRetentionHours: "retenção dos ZIPs",
};

// One-time links (invites, password resets, downloads) are replaced before a
// message body leaves the server.
const TOKEN_LINK = /(\/(?:convite|redefinir-senha|dl)\/)[^\s"'<>)\]]+/gi;
export const redactLinks = (text) => String(text ?? "").replace(TOKEN_LINK, "$1[link oculto]");

export function mercadoPagoMode(token) {
  if (!token) return null;
  return String(token).startsWith("TEST-") ? "test" : "production";
}

async function publicSettings(db) {
  const all = await getSettings(db);
  return {
    orgName: all.orgName,
    supportEmail: all.supportEmail,
    defaultNotifyEmail: Boolean(all.defaultNotifyEmail),
    signupEnabled: all.signupEnabled !== false,
    zipRetentionHours: Number(all.zipRetentionHours) || 24,
  };
}

function serializeEmail(row) {
  const excerpt = redactLinks(row.text_body).replace(/\s+/g, " ").trim();
  return {
    id: row.id,
    to: row.to_email,
    toUser: row.to_user_id ? { id: row.to_user_id, name: row.user_name ?? null, role: row.user_role ?? null } : null,
    subject: row.subject,
    status: row.status,
    error: row.error ?? null,
    attempts: row.attempts,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? null,
    excerpt: excerpt.length > 600 ? `${excerpt.slice(0, 600).trimEnd()}…` : excerpt,
  };
}

const OUTBOX_SELECT = `SELECT o.*, u.name AS user_name, u.role AS user_role
  FROM email_outbox o LEFT JOIN users u ON u.id = o.to_user_id`;

export default function settingsRoutes(ctx) {
  const router = Router();
  const { db, config } = ctx;
  const admin = [requireAuth, requireCap("settings.manage")];

  router.get("/api/settings", ...admin, async (req, res) => {
    res.json({ settings: await publicSettings(db) });
  });

  router.patch("/api/settings", ...admin, async (req, res) => {
    const input = parse(settingsSchema, req.body);
    const before = await publicSettings(db);
    const changed = Object.keys(SETTING_LABELS).filter((key) => input[key] !== undefined && input[key] !== before[key]);
    if (changed.length) {
      await db.tx(async () => {
        for (const key of changed) await setSetting(db, key, input[key], req.user.id);
        await logActivity(req, {
          action: "settings.updated",
          entityType: "settings",
          summary: `Configurações atualizadas: ${changed.map((key) => SETTING_LABELS[key]).join(", ")}.`,
          data: { fields: changed },
        });
      });
    }
    res.json({ settings: await publicSettings(db) });
  });

  router.get("/api/settings/integrations", ...admin, async (req, res) => {
    const outbox = Object.fromEntries(EMAIL_STATUSES.map((status) => [status, 0]));
    for (const row of await db.all("SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status")) outbox[row.status] = row.n;
    let usage = null;
    try {
      usage = await ctx.storage.usage();
    } catch (err) {
      ctx.log?.warn?.("[settings] storage usage failed", err);
    }
    const smtpVia = config.mailTransport ? "custom" : config.smtp?.url ? "url" : config.smtp?.host ? "host" : null;
    res.json({
      appUrl: config.appUrl,
      email: {
        configured: ctx.mailer.isConfigured(),
        from: ctx.mailer.from ?? config.mailFrom,
        via: smtpVia,
        host: smtpVia === "host" ? config.smtp.host : null,
      },
      mercadopago: {
        configured: Boolean(config.mercadopago?.accessToken),
        mode: mercadoPagoMode(config.mercadopago?.accessToken),
        webhookSecret: Boolean(config.mercadopago?.webhookSecret),
        webhookUrl: `${config.appUrl}/api/webhooks/mercadopago`,
      },
      storage: {
        driver: ctx.storage.driver ?? "local",
        usedBytes: usage?.usedBytes ?? null,
        files: usage?.files ?? null,
      },
      ffmpeg: { available: Boolean(config.ffmpegPath), ffprobe: Boolean(config.ffprobePath) },
      outbox: {
        notConfigured: outbox.not_configured,
        failed: outbox.failed,
        queued: outbox.queued,
        sent: outbox.sent,
        total: EMAIL_STATUSES.reduce((sum, status) => sum + outbox[status], 0),
      },
    });
  });

  // ?status=failed,not_configured&page=&pageSize= -> { items, total, counts }
  router.get("/api/settings/outbox", ...admin, async (req, res) => {
    const { page, pageSize, limit, offset } = paginate(req.query, { defaultSize: 30, max: 100 });
    const statuses = queryList(req.query.status).filter((status) => EMAIL_STATUSES.includes(status));
    const where = statuses.length ? `WHERE o.status IN (${statuses.map(() => "?").join(", ")})` : "";
    const total = (await db.get(`SELECT COUNT(*) AS n FROM email_outbox o ${where}`, statuses)).n;
    const rows = await db.all(`${OUTBOX_SELECT} ${where} ORDER BY o.created_at DESC, o.seq DESC LIMIT ? OFFSET ?`, [...statuses, limit, offset]);
    const counts = Object.fromEntries(EMAIL_STATUSES.map((status) => [status, 0]));
    for (const row of await db.all("SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status")) counts[row.status] = row.n;
    res.json({ items: rows.map(serializeEmail), total, counts, page, pageSize, configured: ctx.mailer.isConfigured() });
  });

  router.post("/api/settings/outbox/:id/retry", ...admin, async (req, res) => {
    const row = await db.get("SELECT * FROM email_outbox WHERE id = ?", [String(req.params.id)]);
    if (!row) throw notFound();
    if (row.status === "sent") throw conflict("Este e-mail já foi enviado.");
    if (row.status === "queued") throw conflict("Este e-mail ainda está sendo enviado. Aguarde um instante.");
    if (!ctx.mailer.isConfigured())
      throw notConfigured("O envio de e-mails não está configurado no servidor. Configure o SMTP e tente de novo.");
    const result = await ctx.mailer.retry(row.id);
    await logActivity(req, {
      action: "email.retried",
      entityType: "email",
      entityId: row.id,
      summary: `Reenvio do e-mail "${row.subject}" para ${row.to_email}: ${result.status === "sent" ? "enviado" : "falhou"}.`,
    });
    res.json({ email: serializeEmail(await db.get(`${OUTBOX_SELECT} WHERE o.id = ?`, [row.id])) });
  });

  // Sends a test message to the signed-in admin.
  router.post("/api/settings/email/test", ...admin, async (req, res) => {
    if (!ctx.mailer.isConfigured())
      throw notConfigured("O envio de e-mails não está configurado no servidor. Defina SMTP_URL ou SMTP_HOST e reinicie.");
    const { orgName } = await publicSettings(db);
    const message = renderEmail({
      title: "E-mail de teste",
      intro: `Se você recebeu esta mensagem, o envio de e-mails da plataforma ${orgName} está funcionando.`,
      lines: ["Nenhuma ação é necessária."],
    });
    const result = await ctx.mailer.send({ to: req.user.email, toUserId: req.user.id, ...message });
    await logActivity(req, {
      action: "email.test",
      entityType: "email",
      entityId: result.id ?? null,
      summary: `E-mail de teste enviado para ${req.user.email}: ${result.status === "sent" ? "entregue ao servidor SMTP" : "falhou"}.`,
    });
    const row = result.id ? await db.get(`${OUTBOX_SELECT} WHERE o.id = ?`, [result.id]) : null;
    res.json({ status: result.status, error: result.error ?? null, email: row ? serializeEmail(row) : null });
  });

  return router;
}

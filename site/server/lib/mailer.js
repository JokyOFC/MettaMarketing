import nodemailer from "nodemailer";
import { newId } from "./ids.js";
import { now } from "./time.js";

/**
 * createMailer({ config, db, log }) -> { send, isConfigured, from, idle }
 *
 * send({ to, toUserId, subject, text, html }) always records the message in
 * email_outbox first. With SMTP configured it is sent and marked sent/failed;
 * without it the row is marked not_configured. Never pretends it was sent.
 * Resolves to { id, status, error? } and never rejects.
 */
export function createMailer({ config, db, log = console }) {
  let transport = null;
  if (config.mailTransport) {
    transport = nodemailer.createTransport(config.mailTransport);
  } else if (config.smtp?.url) {
    transport = nodemailer.createTransport(config.smtp.url);
  } else if (config.smtp?.host) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port ?? (config.smtp.secure ? 465 : 587),
      secure: Boolean(config.smtp.secure),
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass ?? "" } : undefined,
    });
  }
  const pending = new Set();

  function record({ to, toUserId, subject, text, html }) {
    const id = newId("eml");
    db.run(
      `INSERT INTO email_outbox (id, to_email, to_user_id, subject, text_body, html_body, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      [id, to, toUserId ?? null, subject, text, html ?? null, now()],
    );
    return id;
  }

  async function deliver(id, message) {
    try {
      await transport.sendMail({ from: config.mailFrom, ...message });
      db.run("UPDATE email_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?", [
        now(),
        id,
      ]);
      return { id, status: "sent" };
    } catch (err) {
      const error = String(err?.message ?? err).slice(0, 500);
      log.warn?.(`[mail] failed to send ${id}: ${error}`);
      db.run("UPDATE email_outbox SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?", [error, id]);
      return { id, status: "failed", error };
    }
  }

  return {
    get from() {
      return config.mailFrom;
    },
    isConfigured() {
      return Boolean(transport);
    },
    send(message) {
      const { to, subject, text } = message;
      if (!to || !subject || !text) return Promise.resolve({ id: null, status: "failed", error: "missing fields" });
      const id = record(message);
      if (!transport) {
        db.run("UPDATE email_outbox SET status = 'not_configured' WHERE id = ?", [id]);
        return Promise.resolve({ id, status: "not_configured" });
      }
      const promise = deliver(id, { to, subject, text, html: message.html ?? undefined });
      pending.add(promise);
      promise.finally(() => pending.delete(promise));
      return promise;
    },
    // Retries a failed/queued outbox row (settings screen may use it).
    async retry(id) {
      const row = db.get("SELECT * FROM email_outbox WHERE id = ?", [id]);
      if (!row) return { id, status: "failed", error: "not found" };
      if (!transport) return { id, status: "not_configured" };
      return deliver(id, { to: row.to_email, subject: row.subject, text: row.text_body, html: row.html_body ?? undefined });
    },
    // Resolves when every in-flight send has settled (tests, shutdown).
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

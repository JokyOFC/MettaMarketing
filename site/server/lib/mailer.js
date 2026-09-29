import nodemailer from "nodemailer";
import { newId } from "./ids.js";
import { now } from "./time.js";

/**
 * createMailer({ config, db, log }) -> { send, enqueue, retry, isConfigured, from, idle }
 *
 * Every message is recorded in email_outbox first. With SMTP configured it is
 * sent and marked sent/failed; without it the row is marked not_configured.
 * Never pretends it was sent.
 *
 * send({ to, toUserId, subject, text, html }) records and delivers; resolves to
 *   { id, status, error? } once delivered (or refused) and never rejects.
 * enqueue(message) records the message right away (inside the caller's
 *   transaction, if any) and delivers it after the commit, without waiting;
 *   resolves to the outbox id. For notices and links sent as a side effect.
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
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const complete = (message) => Boolean(message?.to && message?.subject && message?.text);

  // Inserts the outbox row; without SMTP it is final right away (not_configured).
  async function record({ to, toUserId, subject, text, html }) {
    const id = newId("eml");
    await db.run(
      `INSERT INTO email_outbox (id, to_email, to_user_id, subject, text_body, html_body, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, to, toUserId ?? null, subject, text, html ?? null, transport ? "queued" : "not_configured", now()],
    );
    return id;
  }

  async function deliver(id, message) {
    try {
      await transport.sendMail({ from: config.mailFrom, ...message });
      await db.run("UPDATE email_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?", [
        now(),
        id,
      ]);
      return { id, status: "sent" };
    } catch (err) {
      const error = String(err?.message ?? err).slice(0, 500);
      log.warn?.(`[mail] failed to send ${id}: ${error}`);
      await db
        .run("UPDATE email_outbox SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?", [error, id])
        .catch((dbErr) => log.error?.(`[mail] could not record the failure of ${id}:`, dbErr));
      return { id, status: "failed", error };
    }
  }

  const content = (message) => ({ to: message.to, subject: message.subject, text: message.text, html: message.html ?? undefined });

  return {
    get from() {
      return config.mailFrom;
    },
    isConfigured() {
      return Boolean(transport);
    },
    send(message) {
      if (!complete(message)) return Promise.resolve({ id: null, status: "failed", error: "missing fields" });
      return track(
        (async () => {
          const id = await record(message);
          if (!transport) return { id, status: "not_configured" };
          return deliver(id, content(message));
        })(),
      );
    },
    async enqueue(message) {
      if (!complete(message)) return null;
      const id = await record(message);
      if (transport) db.afterCommit(() => track(deliver(id, content(message))));
      return id;
    },
    // Retries a failed/queued outbox row (settings screen may use it).
    async retry(id) {
      const row = await db.get("SELECT * FROM email_outbox WHERE id = ?", [id]);
      if (!row) return { id, status: "failed", error: "not found" };
      if (!transport) return { id, status: "not_configured" };
      return track(deliver(id, { to: row.to_email, subject: row.subject, text: row.text_body, html: row.html_body ?? undefined }));
    },
    // Resolves when every in-flight message has settled (tests, shutdown).
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

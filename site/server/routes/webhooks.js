// Mercado Pago notifications. Mounted before the JSON parser (reads the raw
// body itself), no session and no CSRF. The signature is checked BEFORE
// anything is stored: signed deliveries are recorded in webhook_events with
// their payload; unsigned ones only as minimal metadata (no payload), limited
// per IP and pruned, so an anonymous caller cannot grow the database or bury
// real deliveries in the finance log. Nothing changes until the
// payment/preapproval is fetched from the API (services/mercadopago.js).
import { Router } from "express";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";
import { verifyWebhook } from "../services/assinavelox.js";
import { mpSettings, processWebhookEvent, topicKind, trackWork, verifySignature } from "../services/mercadopago.js";

const MAX_BODY = 256 * 1024;
const MAX_PAYLOAD = 20000;

// Retention of the delivery log (see pruneWebhookEvents).
export const WEBHOOK_RETENTION = {
  unsignedKeep: 200, // newest rejected deliveries kept for diagnosis
  unsignedDays: 30,
  signedDays: 365, // processed signed deliveries (payments keep their own history)
};
// Rejected deliveries recorded per IP and window; beyond it they are answered
// without being stored.
export const UNSIGNED_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve({ buffer: Buffer.concat(chunks), tooLarge }));
    req.on("error", reject);
  });
}

// "https://api.mercadopago.com/v1/payments/123" -> "123" (legacy IPN bodies).
const lastSegment = (value) => (value ? String(value).split("?")[0].split("/").filter(Boolean).pop() : null);

const SIGNATURE_ERRORS = {
  secret_missing: "Assinatura não verificada: MP_WEBHOOK_SECRET não está configurado no servidor.",
  missing: "Assinatura ausente ou malformada (x-signature).",
  mismatch: "Assinatura inválida: a notificação não foi gerada com a assinatura secreta configurada.",
};

const clip = (value, max) => (value === null || value === undefined ? null : String(value).slice(0, max));

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

/** Deletes old/overflowing log rows. Signed rows waiting for processing stay. */
export async function pruneWebhookEvents(db, retention = WEBHOOK_RETENTION) {
  await db.run(
    `DELETE FROM webhook_events
      WHERE provider = 'mercadopago' AND signature_valid = 0
        AND (received_at < ? OR id NOT IN (
              SELECT id FROM (SELECT id FROM webhook_events WHERE provider = 'mercadopago' AND signature_valid = 0
               ORDER BY received_at DESC, seq DESC LIMIT ?) AS kept))`,
    [daysAgo(retention.unsignedDays), retention.unsignedKeep],
  );
  await db.run(
    `DELETE FROM webhook_events
      WHERE provider = 'mercadopago' AND signature_valid = 1 AND processed_at IS NOT NULL AND received_at < ?`,
    [daysAgo(retention.signedDays)],
  );
}

// In-memory counter of rejected deliveries per IP (one per app instance).
function unsignedLimiter({ max, windowMs } = UNSIGNED_LIMIT) {
  const hits = new Map();
  return function allow(ip) {
    const at = Date.now();
    if (hits.size > 5000)
      for (const [key, entry] of hits) if (at - entry.start > windowMs) hits.delete(key);
    if (hits.size > 5000) hits.clear();
    const key = ip || "unknown";
    let entry = hits.get(key);
    if (!entry || at - entry.start > windowMs) {
      entry = { start: at, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

export default function webhooksRoutes(ctx) {
  const router = Router();
  const { db } = ctx;
  const allowUnsigned = unsignedLimiter();

  router.post("/api/webhooks/mercadopago", async (req, res) => {
    const { buffer, tooLarge } = await readRaw(req);
    const query = new URL(req.originalUrl, "http://localhost").searchParams;
    const requestId = clip(req.get("x-request-id"), 200) || null;

    let body = null;
    let parseError = null;
    if (tooLarge) parseError = "Corpo da notificação acima do limite.";
    else {
      try {
        body = buffer.length ? JSON.parse(buffer.toString("utf8")) : {};
      } catch {
        parseError = "Corpo da notificação não é um JSON válido.";
      }
    }

    const topic = clip(body?.type ?? body?.topic ?? query.get("type") ?? query.get("topic"), 80);
    const dataId = query.get("data.id") ?? (body?.data?.id !== undefined ? String(body.data.id) : null);
    const resourceId = clip(dataId ?? query.get("id") ?? lastSegment(body?.resource), 120);
    const signature = verifySignature({
      secret: mpSettings(ctx.config).secret,
      header: req.get("x-signature"),
      requestId,
      dataId,
    });

    // ------------------------------------------------ unsigned: minimal record
    if (!signature.valid) {
      const error = SIGNATURE_ERRORS[signature.reason] ?? SIGNATURE_ERRORS.mismatch;
      if (!allowUnsigned(req.ip))
        return res.status(429).json({ error: { code: "rate_limited", message: "Muitas notificações sem assinatura válida." } });
      await db.tx(async () => {
        await db.run(
          `INSERT IGNORE INTO webhook_events (id, provider, request_id, topic, resource_id, signature_valid, payload, received_at, error)
           VALUES (?, 'mercadopago', ?, ?, ?, 0, NULL, ?, ?)`,
          [newId("whk"), requestId, topic, resourceId, now(), parseError ?? error],
        );
        await pruneWebhookEvents(db);
      });
      if (parseError) return res.status(400).json({ error: { code: "bad_request", message: parseError } });
      return res.status(401).json({ error: { code: "invalid_signature", message: error } });
    }

    // ------------------------------------------------ signed delivery
    const payload = buffer.toString("utf8").slice(0, MAX_PAYLOAD);
    const eventId = newId("whk");
    let rowId = eventId;
    let duplicate = false;
    await db.tx(async () => {
      const inserted = (await db.run(
        `INSERT IGNORE INTO webhook_events (id, provider, request_id, topic, resource_id, signature_valid, payload, received_at, error)
         VALUES (?, 'mercadopago', ?, ?, ?, 1, ?, ?, ?)`,
        [eventId, requestId, topic, resourceId, payload, now(), parseError],
      )).changes;
      if (!inserted) {
        // Same x-request-id delivered again (or first seen without a valid signature).
        const existing = await db.get("SELECT * FROM webhook_events WHERE provider = 'mercadopago' AND request_id = ?", [requestId]);
        if (existing.signature_valid && existing.processed_at && !existing.error) {
          duplicate = true;
          return;
        }
        rowId = existing.id;
        await db.run(
          `UPDATE webhook_events SET signature_valid = 1, topic = ?, resource_id = ?, payload = ?, error = ?, processed_at = NULL
            WHERE id = ?`,
          [topic, resourceId, payload, parseError, rowId],
        );
      }
      await pruneWebhookEvents(db);
    });
    if (duplicate) return res.status(200).json({ received: true, duplicate: true });
    if (parseError) return res.status(400).json({ error: { code: "bad_request", message: parseError } });

    if (!mpSettings(ctx.config).token && topicKind(topic)) {
      // Mercado Pago retries later; by then the credentials may be in place.
      await db.run("UPDATE webhook_events SET error = ? WHERE id = ?", [
        "Mercado Pago não configurado: não foi possível confirmar a notificação na API.",
        rowId,
      ]);
      return res.status(503).json({ error: { code: "integration_not_configured", message: "Mercado Pago não configurado." } });
    }

    // Answer at once; confirmation against the API happens right after.
    res.status(200).json({ received: true });
    trackWork(ctx, processWebhookEvent(ctx, rowId, { topic, resourceId }));
  });

  // ------------------------------------------------------------------ AssinaVelox
  // Outgoing webhooks of AssinaVelox (contracts). HMAC-SHA256 over
  // "{timestamp}.{raw body}" with a 5-minute window, checked BEFORE anything
  // is stored. The payload only carries ids: the contract is re-read from the
  // API (services/contracts.js syncContract), never trusted from the body.
  const allowUnsignedAv = unsignedLimiter();
  const pruneAv = async () => {
    await db.run(
      `DELETE FROM webhook_events WHERE provider = 'assinavelox' AND signature_valid = 0
         AND (received_at < ? OR id NOT IN (SELECT id FROM (SELECT id FROM webhook_events WHERE provider = 'assinavelox' AND signature_valid = 0
                                           ORDER BY received_at DESC, seq DESC LIMIT ?) AS kept))`,
      [daysAgo(WEBHOOK_RETENTION.unsignedDays), WEBHOOK_RETENTION.unsignedKeep],
    );
    await db.run(
      `DELETE FROM webhook_events WHERE provider = 'assinavelox' AND signature_valid = 1 AND processed_at IS NOT NULL AND received_at < ?`,
      [daysAgo(WEBHOOK_RETENTION.signedDays)],
    );
  };

  router.post("/api/webhooks/assinavelox", async (req, res) => {
    const { buffer, tooLarge } = await readRaw(req);
    const deliveryId = clip(req.get("X-AssinaVelox-Delivery-Id"), 64) || null;
    const eventType = clip(req.get("X-AssinaVelox-Event"), 80);
    if (tooLarge) return res.status(413).json({ error: { code: "payload_too_large", message: "Corpo da notificação acima do limite." } });

    const check = await verifyWebhook(ctx, buffer, (name) => req.get(name));
    if (!check.valid) {
      if (!allowUnsignedAv(req.ip))
        return res.status(429).json({ error: { code: "rate_limited", message: "Muitas notificações sem assinatura válida." } });
      const error =
        check.reason === "secret_missing"
          ? "Assinatura não verificada: nenhum segredo de webhook da AssinaVelox está configurado."
          : check.reason === "bad_json"
            ? "Corpo da notificação não é um JSON válido."
            : "Assinatura inválida ou fora da janela de 5 minutos.";
      await db.tx(async () => {
        await db.run(
          `INSERT IGNORE INTO webhook_events (id, provider, request_id, topic, resource_id, signature_valid, payload, received_at, error)
           VALUES (?, 'assinavelox', ?, ?, NULL, 0, NULL, ?, ?)`,
          [newId("whk"), deliveryId, eventType, now(), error],
        );
        await pruneAv();
      });
      return res.status(check.reason === "bad_json" ? 400 : 401).json({ error: { code: "invalid_signature", message: error } });
    }

    const event = check.event ?? {};
    const envelopeId = clip(event?.data?.envelope?.id, 64);
    let duplicate = false;
    let rowId = newId("whk");
    await db.tx(async () => {
      const inserted = (await db.run(
        `INSERT IGNORE INTO webhook_events (id, provider, request_id, topic, resource_id, signature_valid, payload, received_at)
         VALUES (?, 'assinavelox', ?, ?, ?, 1, ?, ?)`,
        [rowId, deliveryId ?? rowId, clip(event.type ?? eventType, 80), envelopeId, buffer.toString("utf8").slice(0, MAX_PAYLOAD), now()],
      )).changes;
      if (!inserted) {
        const existing = await db.get("SELECT * FROM webhook_events WHERE provider = 'assinavelox' AND request_id = ?", [deliveryId]);
        if (existing?.signature_valid && existing.processed_at) duplicate = true;
        else if (existing) {
          rowId = existing.id;
          await db.run("UPDATE webhook_events SET signature_valid = 1, topic = ?, resource_id = ?, payload = ?, error = NULL WHERE id = ?", [
            clip(event.type ?? eventType, 80),
            envelopeId,
            buffer.toString("utf8").slice(0, MAX_PAYLOAD),
            rowId,
          ]);
        }
      }
      await pruneAv();
    });
    // 2xx quickly; AssinaVelox retries anything else.
    res.status(204).end();
    if (duplicate) return;

    const contract = envelopeId ? await db.get("SELECT id FROM contracts WHERE envelope_id = ?", [envelopeId]) : null;
    const done = async (error = null) =>
      await db.run("UPDATE webhook_events SET processed_at = ?, error = ? WHERE id = ?", [now(), error, rowId]);
    if (!contract) return await done(envelopeId ? "Nenhum contrato da Metta usa este documento." : null);
    const work = ctx.jobs?.enqueue("contracts.sync", { contractId: contract.id, source: "webhook" }) ?? Promise.resolve();
    trackWork(ctx, work.then(async () => await done(), async (err) => await done(err?.message ?? "Falha ao sincronizar.")));
  });

  return router;
}

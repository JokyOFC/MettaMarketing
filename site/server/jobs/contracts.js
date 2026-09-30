import { isConfigured, avSettings } from "../services/assinavelox.js";
import { ensureDefaultTemplates, runSend, sendContractAfterPayment, syncContract } from "../services/contracts.js";

const MINUTE = 60 * 1000;

// Contracts: the sending steps run in the background ("contracts.send"), and
// a periodic pass re-reads open envelopes from AssinaVelox ("contracts.sync")
// so a missed webhook (or a local install without a public URL) never leaves
// a contract stuck. ASSINAVELOX_SYNC_MINUTES = 0 turns the pass off.
// Purchases made on the site get their contract once paid
// ("contracts.after_payment", queued by the payment reconciliation); the same
// pass picks up any that a restart left behind.
export async function register(jobs, ctx) {
  const sending = new Set(); // contract ids with a send run in progress
  jobs.register(
    "contracts.send",
    (payload) => {
      const id = payload?.contractId;
      if (!id || sending.has(id)) return undefined;
      sending.add(id);
      return runSend(ctx, id).finally(() => sending.delete(id));
    },
    { concurrency: 2 },
  );
  const afterPayment = new Set(); // orders/subscriptions with a run in progress
  jobs.register(
    "contracts.after_payment",
    (payload) => {
      const key = payload?.orderId ? `order:${payload.orderId}` : payload?.subscriptionId ? `subscription:${payload.subscriptionId}` : null;
      if (!key || afterPayment.has(key)) return undefined;
      afterPayment.add(key);
      return sendContractAfterPayment(ctx, { orderId: payload.orderId ?? null, subscriptionId: payload.subscriptionId ?? null })
        .catch((err) => ctx.log?.warn?.(`[contracts] contract after payment failed: ${err.message}`))
        .finally(() => afterPayment.delete(key));
    },
    { concurrency: 1 },
  );
  jobs.register(
    "contracts.sync",
    (payload) =>
      syncContract(ctx, payload?.contractId, { source: payload?.source ?? "job" }).catch((err) => {
        ctx.log?.warn?.(`[contracts] sync failed: ${err.message}`);
      }),
    { concurrency: 2 },
  );

  try {
    await ensureDefaultTemplates(ctx.db);
  } catch (err) {
    ctx.log?.warn?.(`[contracts] default templates not seeded: ${err.message}`);
  }

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      // Paid site purchases whose contract step never ran (runs even without
      // AssinaVelox: the team is then told to arrange the contract).
      const before = new Date(Date.now() - 2 * MINUTE).toISOString();
      for (const row of await ctx.db.all(
        `SELECT id FROM orders
          WHERE contract_after_payment = 1 AND status = 'paid' AND contract_auto_at IS NULL
            AND contract_waived_at IS NULL AND updated_at < ?
          ORDER BY updated_at LIMIT 20`,
        [before],
      ))
        jobs.enqueue("contracts.after_payment", { orderId: row.id });
      for (const row of await ctx.db.all(
        `SELECT id FROM subscriptions
          WHERE contract_after_payment = 1 AND status IN ('active', 'paused') AND contract_auto_at IS NULL
            AND contract_waived_at IS NULL AND updated_at < ?
          ORDER BY updated_at LIMIT 20`,
        [before],
      ))
        jobs.enqueue("contracts.after_payment", { subscriptionId: row.id });
    } catch (err) {
      ctx.log?.warn?.(`[contracts] after-payment scan failed: ${err.message}`);
    }
    if (!isConfigured(ctx.config)) return;
    const minutes = avSettings(ctx.config).syncMinutes;
    try {
      // Sending interrupted by a restart: resume (idempotent steps).
      for (const row of await ctx.db.all(
        "SELECT id FROM contracts WHERE status = 'sending' AND updated_at < ?",
        [new Date(Date.now() - 2 * MINUTE).toISOString()],
      ))
        jobs.enqueue("contracts.send", { contractId: row.id });
      if (!minutes) return;
      const before = new Date(Date.now() - minutes * MINUTE).toISOString();
      const due = await ctx.db.all(
        `SELECT id FROM contracts
          WHERE envelope_id IS NOT NULL
            AND (status IN ('sent', 'failed')
                 OR (status = 'completed' AND (signed_key IS NULL OR evidence_key IS NULL)))
            AND (last_synced_at IS NULL OR last_synced_at < ?)
          ORDER BY last_synced_at LIMIT 50`,
        [before],
      );
      for (const row of due) jobs.enqueue("contracts.sync", { contractId: row.id, source: "schedule" });
    } catch (err) {
      ctx.log?.warn?.(`[contracts] scheduling failed: ${err.message}`);
    }
  };
  const first = setTimeout(tick, 5000);
  const every = setInterval(tick, MINUTE);
  first.unref?.();
  every.unref?.();

  const stop = jobs.stop.bind(jobs);
  jobs.stop = async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
    return stop();
  };
}

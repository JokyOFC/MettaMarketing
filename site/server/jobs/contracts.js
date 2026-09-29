import { isConfigured, avSettings } from "../services/assinavelox.js";
import { ensureDefaultTemplates, runSend, syncContract } from "../services/contracts.js";

const MINUTE = 60 * 1000;

// Contracts: the sending steps run in the background ("contracts.send"), and
// a periodic pass re-reads open envelopes from AssinaVelox ("contracts.sync")
// so a missed webhook (or a local install without a public URL) never leaves
// a contract stuck. ASSINAVELOX_SYNC_MINUTES = 0 turns the pass off.
export function register(jobs, ctx) {
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
  jobs.register(
    "contracts.sync",
    (payload) =>
      syncContract(ctx, payload?.contractId, { source: payload?.source ?? "job" }).catch((err) => {
        ctx.log?.warn?.(`[contracts] sync failed: ${err.message}`);
      }),
    { concurrency: 2 },
  );

  try {
    ensureDefaultTemplates(ctx.db);
  } catch (err) {
    ctx.log?.warn?.(`[contracts] default templates not seeded: ${err.message}`);
  }

  let stopped = false;
  const tick = () => {
    if (stopped || !isConfigured(ctx.config)) return;
    const minutes = avSettings(ctx.config).syncMinutes;
    try {
      // Sending interrupted by a restart: resume (idempotent steps).
      for (const row of ctx.db.all(
        "SELECT id FROM contracts WHERE status = 'sending' AND updated_at < ?",
        [new Date(Date.now() - 2 * MINUTE).toISOString()],
      ))
        jobs.enqueue("contracts.send", { contractId: row.id });
      if (!minutes) return;
      const before = new Date(Date.now() - minutes * MINUTE).toISOString();
      const due = ctx.db.all(
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

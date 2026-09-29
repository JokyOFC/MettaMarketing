// 'zips' queue (services/zips.js) plus the hourly storage maintenance:
// expired ZIPs, uploads never attached for 48 h and stale temporary files.
// On start, jobs interrupted by a restart are marked failed.
import { cleanupStaleUploads } from "../services/materials.js";
import { cleanupTmp, expireZips, failInterruptedZips, runZipJob } from "../services/zips.js";

const HOUR = 60 * 60 * 1000;

export async function runMaintenance(ctx) {
  const zips = await expireZips(ctx);
  const uploads = await cleanupStaleUploads(ctx);
  const tmp = await cleanupTmp(ctx);
  return { zips, uploads, tmp };
}

export function register(jobs, ctx) {
  jobs.register("zips", (payload) => runZipJob(ctx, payload?.jobId), { concurrency: 2 });

  try {
    const failed = failInterruptedZips(ctx);
    if (failed) ctx.log?.warn?.(`[zips] ${failed} job(s) interrupted by the restart were marked as failed.`);
  } catch (err) {
    ctx.log?.warn?.(`[zips] could not check interrupted jobs: ${err.message}`);
  }

  let stopped = false;
  let running = null;
  const tick = () => {
    if (stopped || running) return;
    running = runMaintenance(ctx)
      .catch((err) => {
        if (!stopped) ctx.log?.warn?.(`[maintenance] ${err.message}`);
      })
      .finally(() => {
        running = null;
      });
  };
  const first = setTimeout(tick, 1000);
  const hourly = setInterval(tick, HOUR);
  first.unref?.();
  hourly.unref?.();

  // stop the timers with the queues (and let a running pass finish)
  const stop = jobs.stop.bind(jobs);
  jobs.stop = async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(hourly);
    await running;
    return stop();
  };
}

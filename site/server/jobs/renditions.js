// 'renditions' queue: thumbnails/previews/posters for material files
// (services/renditions.js). Files left 'pending' by a restart are queued again.
import { generateRenditions } from "../services/renditions.js";

export async function register(jobs, ctx) {
  jobs.register("renditions", (payload) => generateRenditions(ctx, payload?.fileId), { concurrency: 2 });
  let pending = [];
  try {
    pending = await ctx.db.all("SELECT id FROM material_files WHERE preview_status = 'pending' ORDER BY created_at");
  } catch (err) {
    ctx.log?.warn?.(`[renditions] could not list pending files: ${err.message}`);
  }
  for (const row of pending) jobs.enqueue("renditions", { fileId: row.id });
}

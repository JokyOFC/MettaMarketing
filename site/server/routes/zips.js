// ZIP packages generated in the background with real progress.
// POST /api/zips validates the scope with access checks and queues the job;
// only the owner can follow it and get a temporary download link.
import { Router } from "express";
import { requireAuth, requireCap } from "../lib/auth.js";
import { expired } from "../lib/errors.js";
import { parse, z } from "../lib/validate.js";
import {
  assertZipJob,
  assertZipReady,
  createZipJob,
  retireZipJob,
  serializeZipJob,
  zipLabelSchema,
  zipLinkProblem,
  zipScopeSchema,
} from "../services/zips.js";
import { LINK_TTL_SECONDS } from "./files.js";

const VIEW = ["materials.view", "portal.access"];
const RECENT_DAYS = 7;

const createSchema = z.object({
  scope: zipScopeSchema,
  includeEditables: z.boolean().optional(),
  // name for a mixed selection (same as scope.label)
  label: zipLabelSchema,
});

export default function zipsRoutes(ctx) {
  const router = Router();
  const { db, signer } = ctx;

  router.post("/api/zips", requireAuth, requireCap(...VIEW), async (req, res) => {
    const body = parse(createSchema, req.body);
    const scope = { ...body.scope };
    if (scope.includeEditables === undefined && body.includeEditables !== undefined) scope.includeEditables = body.includeEditables;
    if (scope.type === "selection" && scope.label === undefined && body.label) scope.label = body.label;
    const job = await createZipJob(req, scope);
    res.status(202).json({ job: serializeZipJob(job) });
  });

  router.get("/api/zips", requireAuth, requireCap(...VIEW), async (req, res) => {
    const since = new Date(Date.now() - RECENT_DAYS * 24 * 3600 * 1000).toISOString();
    const rows = await db.all("SELECT * FROM zip_jobs WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20", [
      req.user.id,
      since,
    ]);
    const items = rows.map(serializeZipJob);
    res.json({ items, total: items.length });
  });

  router.get("/api/zips/:id", requireAuth, requireCap(...VIEW), async (req, res) => {
    res.json({ job: serializeZipJob(await assertZipJob(req, req.params.id)) });
  });

  // The /dl checks run here first: a package whose content is no longer
  // allowed (download disabled, material archived…) or whose stored file is
  // gone answers 410 with the reason and turns 'expired', so the tray shows
  // it instead of a silent failed browser download.
  router.post("/api/zips/:id/link", requireAuth, requireCap(...VIEW), async (req, res) => {
    const job = assertZipReady(await assertZipJob(req, req.params.id));
    const problem = await zipLinkProblem(req, job);
    if (problem) {
      await retireZipJob(ctx, job, problem);
      throw expired(problem);
    }
    const link = signer.issue({ t: "zip", id: job.id, u: req.user.id }, LINK_TTL_SECONDS);
    res.json({ url: link.url, expiresAt: link.expiresAt });
  });

  return router;
}

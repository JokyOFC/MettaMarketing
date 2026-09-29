// Previews, inline streaming and downloads. Access is checked on every
// request, including when a temporary link is redeemed (same session user +
// a fresh assertFile/zip check). Originals always keep their full quality.
import { Router } from "express";
import { assertFile, getScope } from "../lib/access.js";
import { clientIp, requireAuth, requireCap } from "../lib/auth.js";
import { expired, forbidden, HttpError, notFound, unauthenticated } from "../lib/errors.js";
import { sendStoredFile } from "../lib/http.js";
import { newId } from "../lib/ids.js";
import { baseName } from "../lib/media.js";
import { now } from "../lib/time.js";
import { parse, z } from "../lib/validate.js";
import { assertZipReady, retireZipJob, zipLinkProblem } from "../services/zips.js";

const VIEW = ["materials.view", "portal.access"];
const PREVIEW_KINDS = new Set(["thumb", "preview", "poster"]);
const STREAM_KINDS = new Set(["video", "audio", "pdf"]);
export const LINK_TTL_SECONDS = 300;
export const FILE_MISSING_MESSAGE = "O arquivo não está mais disponível no armazenamento.";

export default function filesRoutes(ctx) {
  const router = Router();
  const { db, storage, signer } = ctx;

  const userAgent = (req) => String(req.get("user-agent") ?? "").slice(0, 300) || null;

  async function recordDownload(req, entry) {
    await db.run(
      `INSERT INTO download_events (id, user_id, client_id, brand_id, material_id, version_id, file_id, zip_job_id, kind, scope, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId("dle"),
        req.user.id,
        entry.clientId ?? null,
        entry.brandId ?? null,
        entry.materialId ?? null,
        entry.versionId ?? null,
        entry.fileId ?? null,
        entry.zipJobId ?? null,
        entry.kind,
        entry.scope,
        clientIp(req),
        userAgent(req),
        now(),
      ],
    );
  }

  // Whether the viewer may see the records of another person's ZIP job
  // (its client is in their scope and their role sees materials).
  async function zipVisibleTo(req, jobId) {
    const job = await db.get("SELECT client_id FROM zip_jobs WHERE id = ?", [jobId]);
    if (!job) return false;
    const scope = await getScope(req);
    return scope.materials && (scope.all || Boolean(job.client_id && scope.clientIds?.has(job.client_id)));
  }

  // A resumed download (Range from a later byte) is the same download.
  const isFirstRequest = (req) => req.method === "GET" && (!req.headers.range || /^bytes=0-/.test(String(req.headers.range)));

  // ------------------------------------------------------------ previews

  router.get("/api/files/:id/preview/:kind", requireAuth, requireCap(...VIEW), async (req, res) => {
    const kind = req.params.kind;
    if (!PREVIEW_KINDS.has(kind)) throw notFound();
    const file = await assertFile(req, req.params.id);
    const rendition = await db.get("SELECT * FROM file_renditions WHERE file_id = ? AND kind = ?", [file.id, kind]);
    if (!rendition) throw notFound("A prévia deste arquivo ainda não está disponível.");
    await sendStoredFile(req, res, storage, rendition.storage_key, {
      mime: rendition.mime,
      size: rendition.size_bytes,
      filename: `${baseName(file.display_name) || "previa"}-${kind}.webp`,
      disposition: "inline",
      cache: "private, max-age=300",
    });
  });

  // Inline viewing of video, audio and PDF with Range (never SVG/HTML: those
  // are forced to attachment by lib/http.js and are not streamable here).
  // An inline PDF is the original document itself, so clients need the
  // download permission for it; videos and audio stay watchable.
  router.get("/api/files/:id/stream", requireAuth, requireCap(...VIEW), async (req, res) => {
    const peek = await assertFile(req, req.params.id);
    if (!STREAM_KINDS.has(peek.media_kind)) throw notFound("Este formato não tem visualização em fluxo.");
    const file = peek.media_kind === "pdf" ? await assertFile(req, req.params.id, { download: true }) : peek;
    await sendStoredFile(req, res, storage, file.storage_key, {
      mime: file.mime,
      size: file.size_bytes,
      filename: file.display_name,
      disposition: "inline",
      cache: "private, max-age=300",
    });
  });

  // ------------------------------------------------------------ downloads

  // The stored object is checked before a link is issued, so a missing file
  // reaches the page as a clear message instead of a failed browser download.
  router.post("/api/downloads/link", requireAuth, requireCap(...VIEW), async (req, res) => {
    const { fileId } = parse(z.object({ fileId: z.string().trim().min(1).max(64) }), req.body);
    const file = await assertFile(req, fileId, { download: true });
    if (!(await storage.stat(file.storage_key))) throw notFound(FILE_MISSING_MESSAGE);
    const link = signer.issue({ t: "file", id: file.id, u: req.user.id }, LINK_TTL_SECONDS);
    res.json({ url: link.url, expiresAt: link.expiresAt });
  });

  // Redeems a temporary link: same session user, fresh access check,
  // attachment with the original name, download_events row.
  router.get("/dl/:token", async (req, res) => {
    const payload = signer.verify(req.params.token);
    if (!payload || !["file", "zip"].includes(payload.t) || !payload.id) throw notFound("Link de download inválido.");
    if (payload.expired) throw expired("Este link de download expirou. Peça o download de novo.");
    if (!req.user) throw unauthenticated("Entre na plataforma para baixar este arquivo.");
    if (payload.u !== req.user.id) {
      // Someone outside the record's scope learns nothing (404, PLATFORM.md
      // §2 rule 2); a person who can see it is told the link is personal.
      if (payload.t === "file") await assertFile(req, payload.id);
      else if (!await zipVisibleTo(req, payload.id)) throw notFound();
      throw forbidden("Este link de download foi gerado para outra pessoa. Peça o seu pela plataforma.");
    }

    if (payload.t === "file") {
      const file = await assertFile(req, payload.id, { download: true });
      // only a download that can really be served is recorded
      if (!(await storage.stat(file.storage_key))) throw notFound(FILE_MISSING_MESSAGE);
      if (isFirstRequest(req))
        await recordDownload(req, {
          kind: "file",
          scope: "file",
          clientId: file.material.client_id,
          brandId: file.material.brand_id,
          materialId: file.material_id,
          versionId: file.version_id,
          fileId: file.id,
        });
      await sendStoredFile(req, res, storage, file.storage_key, {
        mime: file.mime,
        size: file.size_bytes,
        filename: file.display_name,
        disposition: "attachment",
        cache: "private, no-store",
      });
      return;
    }

    const job = await db.get("SELECT * FROM zip_jobs WHERE id = ? AND user_id = ?", [payload.id, req.user.id]);
    if (!job) throw notFound();
    try {
      assertZipReady(job);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) throw expired("Este ZIP não está mais disponível. Gere o pacote de novo.");
      throw err;
    }
    const problem = await zipLinkProblem(req, job);
    if (problem) {
      await retireZipJob(ctx, job, problem);
      throw expired(problem);
    }
    if (isFirstRequest(req))
      await recordDownload(req, {
        kind: "zip",
        scope: job.scope,
        clientId: job.client_id,
        brandId: job.brand_id,
        zipJobId: job.id,
      });
    await sendStoredFile(req, res, storage, job.storage_key, {
      mime: "application/zip",
      size: job.size_bytes,
      filename: job.filename,
      disposition: "attachment",
      cache: "private, no-store",
    });
  });

  return router;
}

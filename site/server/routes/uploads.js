// POST /api/uploads — one file per request, streamed straight into private
// storage (MAX_UPLOAD_MB enforced while streaming), extension allowlist plus
// signature check, metadata through lib/media.js. Uploads stay private to
// the uploader until attached to a material.
import busboy from "busboy";
import { Router } from "express";
import { requireAuth, requireCap } from "../lib/auth.js";
import { badRequest, conflict, notFound, payloadTooLarge, unsupportedMedia, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { extOf, formatLabel, inspect, isAllowedExt, checkSignature, sanitizeFilename } from "../lib/media.js";
import { now } from "../lib/time.js";
import { removeStorageIfUnreferenced } from "../services/materials.js";

// Multipart framing around a single file is well under this.
const MULTIPART_SLACK = 1024 * 1024;
// While draining a refused body we wait at most this long before answering.
const DRAIN_TIMEOUT_MS = 120000;
// A body refused up front (declared too large) is read for at most this long
// after the answer went out; then the connection is cut and the browser reads
// the 413 it already received instead of uploading for minutes.
const EARLY_REFUSAL_GRACE_MS = 2000;

const limitLabel = (mb) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);
const limitMessage = (mb) => `O arquivo ultrapassa o limite de ${limitLabel(mb)}.`;

// Answers 413 right away (the declared Content-Length is already too big),
// with the limit in the payload, then discards what is still arriving.
function refuseTooLarge(req, res, { maxBytes, maxMb }) {
  res.status(413).json({ error: { code: "payload_too_large", message: limitMessage(maxMb), maxBytes } });
  if (req.readableEnded || req.destroyed) return;
  const cut = setTimeout(() => req.socket?.destroy(), EARLY_REFUSAL_GRACE_MS);
  cut.unref?.();
  const stop = () => clearTimeout(cut);
  req.on("end", stop);
  req.on("close", stop);
  req.on("error", stop);
  req.resume();
}

// Reads the rest of a refused request so the browser receives our answer
// instead of a reset connection.
function drain(req) {
  return new Promise((resolve) => {
    if (req.readableEnded || req.destroyed) return resolve();
    const timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    req.on("end", done);
    req.on("close", done);
    req.on("error", done);
    req.resume();
  });
}

/**
 * Streams the single `file` field into storage.
 * -> { key, size, sha256, filename, ext }
 */
function receiveFile(req, { storage, maxBytes, maxMb }) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        limits: { files: 1, fields: 20, fieldSize: 16 * 1024, parts: 40, headerPairs: 50 },
      });
    } catch {
      drain(req).then(() => reject(badRequest("Envie o arquivo como formulário multipart (campo “file”).")));
      return;
    }

    let failure = null;
    let fileSeen = false;
    let storing = null;
    let stored = null;
    let settled = false;
    const fail = (err) => {
      failure ??= err;
    };

    parser.on("file", (field, stream, info) => {
      if (field !== "file" || fileSeen) {
        stream.resume();
        if (fileSeen) fail(validation({ file: "Envie um arquivo por vez." }));
        return;
      }
      fileSeen = true;
      const filename = sanitizeFilename(info?.filename, "");
      const ext = extOf(filename);
      if (!filename) {
        stream.resume();
        fail(validation({ file: "Selecione um arquivo para enviar." }));
        return;
      }
      if (!ext) {
        stream.resume();
        fail(unsupportedMedia("O arquivo precisa ter uma extensão reconhecida (por exemplo .png, .svg, .pdf)."));
        return;
      }
      if (!isAllowedExt(ext)) {
        stream.resume();
        fail(unsupportedMedia(`Arquivos .${ext} não são aceitos. Envie imagens, vetores, vídeos, PDFs, fontes ou arquivos editáveis.`));
        return;
      }
      storing = storage.putStream(stream, { maxBytes }).then(
        (result) => {
          stored = { ...result, filename, ext };
        },
        (err) => fail(err?.status === 413 ? payloadTooLarge(limitMessage(maxMb)) : err),
      );
    });
    parser.on("filesLimit", () => fail(validation({ file: "Envie um arquivo por vez." })));
    parser.on("error", () => {
      fail(badRequest("O envio foi interrompido. Tente de novo."));
      req.unpipe(parser);
      req.resume();
    });
    parser.on("close", async () => {
      await storing;
      if (settled) return;
      settled = true;
      if (!failure && !fileSeen) failure = validation({ file: "Selecione um arquivo para enviar." });
      if (failure) {
        if (stored) await storage.remove(stored.key).catch(() => {});
        await drain(req);
        reject(failure);
        return;
      }
      resolve(stored);
    });
    // client gave up: stop the parser (the partial file is removed by putStream)
    req.on("close", () => {
      if (req.complete || settled) return;
      fail(badRequest("O envio foi interrompido. Tente de novo."));
      parser.destroy(new Error("aborted"));
    });
    req.pipe(parser);
  });
}

export function serializeUpload(row) {
  return {
    id: row.id,
    name: row.original_name,
    ext: row.ext,
    format: formatLabel(row.ext),
    mime: row.mime,
    sizeBytes: row.size_bytes,
    mediaKind: row.media_kind,
    width: row.width ?? null,
    height: row.height ?? null,
    durationMs: row.duration_ms ?? null,
    status: row.status,
    createdAt: row.created_at,
  };
}

export default function uploadsRoutes(ctx) {
  const router = Router();
  const { db, storage, config } = ctx;

  router.post("/api/uploads", requireAuth, requireCap("materials.upload"), async (req, res) => {
    const maxBytes = config.maxUploadBytes;
    const type = String(req.headers["content-type"] ?? "");
    if (!/^multipart\/form-data/i.test(type)) {
      await drain(req);
      throw badRequest("Envie o arquivo como formulário multipart (campo “file”).");
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes + MULTIPART_SLACK) {
      refuseTooLarge(req, res, { maxBytes, maxMb: config.maxUploadMb });
      return;
    }

    const file = await receiveFile(req, { storage, maxBytes, maxMb: config.maxUploadMb });
    const path = storage.localPath(file.key);
    try {
      if (!file.size) throw validation({ file: "O arquivo está vazio." });
      if (!(await checkSignature(path, file.ext)))
        throw unsupportedMedia(`O conteúdo do arquivo não corresponde a um .${file.ext}. Exporte o arquivo de novo e tente outra vez.`);
    } catch (err) {
      await storage.remove(file.key).catch(() => {});
      throw err;
    }
    const info = await inspect(path, file.ext, { ffprobePath: config.ffprobePath });

    const id = newId("upl");
    await db.run(
      `INSERT INTO uploads (id, user_id, original_name, ext, mime, size_bytes, sha256, storage_key, media_kind,
         width, height, duration_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?)`,
      [
        id,
        req.user.id,
        file.filename,
        file.ext,
        info.mime,
        file.size,
        file.sha256,
        file.key,
        info.mediaKind,
        info.width,
        info.height,
        info.durationMs,
        now(),
      ],
    );
    res.status(201).json({ upload: serializeUpload(await db.get("SELECT * FROM uploads WHERE id = ?", [id])) });
  });

  // Upload limit for the pages' pickers (they refuse bigger files before
  // sending them). -> { maxUploadBytes, maxUploadMb, maxUploadLabel }
  router.get("/api/uploads/limits", requireAuth, requireCap("materials.upload"), (req, res) => {
    res.json({
      maxUploadBytes: config.maxUploadBytes,
      maxUploadMb: config.maxUploadMb,
      maxUploadLabel: limitLabel(config.maxUploadMb),
    });
  });

  // Only the uploader sees (and discards) an upload.
  router.get("/api/uploads/:id", requireAuth, requireCap("materials.upload"), async (req, res) => {
    const row = await db.get("SELECT * FROM uploads WHERE id = ? AND user_id = ? AND status != 'discarded'", [req.params.id, req.user.id]);
    if (!row) throw notFound();
    res.json({ upload: serializeUpload(row) });
  });

  router.delete("/api/uploads/:id", requireAuth, requireCap("materials.upload"), async (req, res) => {
    const row = await db.get("SELECT * FROM uploads WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (!row || row.status === "discarded") throw notFound();
    if (row.status === "attached") throw conflict("Este arquivo já foi anexado a um material. Remova-o pelo material.");
    await db.run("UPDATE uploads SET status = 'discarded' WHERE id = ? AND status = 'uploaded'", [row.id]);
    await removeStorageIfUnreferenced(ctx, row.storage_key);
    res.status(204).end();
  });

  return router;
}

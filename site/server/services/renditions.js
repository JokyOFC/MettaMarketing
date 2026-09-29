// Optimised previews, generated apart from the originals (which are never
// modified): thumb (480 px wide) and preview (1600 px) WebP for images and
// SVG (rasterised, transparency kept), poster + thumb for videos through
// ffmpeg when available. Everything else stays 'unsupported' and the
// interface shows a document card or the cover the team uploaded.
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import sharp from "sharp";
import { now } from "../lib/time.js";
import { removeStorageIfUnreferenced } from "./materials.js";

// libvips' operation cache keeps input files open after a job; with private
// storage that must delete files (and Windows refusing to delete open files)
// every file is processed once anyway, so the cache only gets in the way.
sharp.cache(false);

export const RENDITION_WIDTHS = { thumb: 480, preview: 1600, poster: 1600 };
// Tall artwork (infographics, stories) is limited to 4× its target width.
const MAX_ASPECT = 4;
// Pixel ceiling for decoding (sharp's default, ~16k × 16k); larger images fail
// gracefully instead of exhausting memory.
const MAX_INPUT_PIXELS = 268402689;
const MAX_SVG_BYTES = 25 * 1024 * 1024;
const RASTER_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "avif"]);

// 'image' | 'svg' | 'video' | null (no preview possible)
export function renditionPlan(file) {
  const ext = String(file.ext ?? "").toLowerCase();
  if (ext === "svg") return "svg";
  if (file.media_kind === "image" && RASTER_EXTS.has(ext)) return "image";
  if (file.media_kind === "video") return "video";
  return null;
}

const quality = (width) => (width <= 480 ? 76 : 84);

async function toWebp(input, inputOptions, width) {
  const { data, info } = await sharp(input, inputOptions)
    .rotate()
    .resize({ width, height: width * MAX_ASPECT, fit: "inside", withoutEnlargement: true })
    .webp({ quality: quality(width), alphaQuality: 90, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// SVG: rasterised at a density that reaches the preview size, so small
// artboards (e.g. 120×60) still give sharp previews. Read from memory so
// librsvg has no base path to resolve external references against.
async function svgRenditions(path) {
  const buffer = await readFile(path);
  if (buffer.length > MAX_SVG_BYTES) throw new Error("svg too large");
  const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const width = meta.width || 512;
  const height = meta.height || 512;
  const scale = Math.min(RENDITION_WIDTHS.preview / width, (RENDITION_WIDTHS.preview * MAX_ASPECT) / height);
  const density = Math.max(1, Math.min(72 * scale, 72 * 60));
  const options = { density, limitInputPixels: MAX_INPUT_PIXELS };
  return {
    size: { width, height },
    outputs: {
      thumb: await toWebp(buffer, options, RENDITION_WIDTHS.thumb),
      preview: await toWebp(buffer, options, RENDITION_WIDTHS.preview),
    },
  };
}

// Raster images (animated GIF/WebP: first frame only).
async function imageRenditions(path) {
  const options = { limitInputPixels: MAX_INPUT_PIXELS, pages: 1, sequentialRead: true, failOn: "none" };
  const meta = await sharp(path, options).metadata();
  let width = meta.width ?? null;
  let height = meta.pageHeight ?? meta.height ?? null;
  if (meta.orientation && meta.orientation >= 5) [width, height] = [height, width];
  return {
    size: { width, height },
    outputs: {
      thumb: await toWebp(path, options, RENDITION_WIDTHS.thumb),
      preview: await toWebp(path, options, RENDITION_WIDTHS.preview),
    },
  };
}

function runFfmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 90000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
  });
}

// Poster (1600) and thumb (480) from a frame near the start of the video.
async function videoRenditions(ctx, path, file) {
  const bin = ctx.config.ffmpegPath;
  const frame = ctx.storage.tmpFile("png");
  const at = file.duration_ms ? Math.min(1, file.duration_ms / 1000 / 3) : 0;
  try {
    const grab = (seconds) =>
      runFfmpeg(bin, ["-v", "error", "-ss", seconds.toFixed(2), "-i", path, "-frames:v", "1", "-an", "-y", frame]);
    try {
      await grab(at);
    } catch {
      await grab(0);
    }
    const options = { limitInputPixels: MAX_INPUT_PIXELS };
    const meta = await sharp(frame).metadata();
    return {
      size: { width: meta.width ?? null, height: meta.height ?? null },
      outputs: {
        thumb: await toWebp(frame, options, RENDITION_WIDTHS.thumb),
        poster: await toWebp(frame, options, RENDITION_WIDTHS.poster),
      },
    };
  } finally {
    await rm(frame, { force: true });
  }
}

async function setStatus(db, fileId, status) {
  await db.run("UPDATE material_files SET preview_status = ? WHERE id = ?", [status, fileId]);
}

// Reuses renditions of another file that shares the same stored object
// (copied versions, the same upload attached twice).
async function reuseFromTwin(db, file) {
  const twin = await db.get(
    `SELECT f.id FROM material_files f
      WHERE f.storage_key = ? AND f.id != ? AND f.preview_status = 'ready'
        AND EXISTS (SELECT 1 FROM file_renditions r WHERE r.file_id = f.id)
      LIMIT 1`,
    [file.storage_key, file.id],
  );
  if (!twin) return false;
  const at = now();
  await db.tx(async () => {
    await db.run("DELETE FROM file_renditions WHERE file_id = ?", [file.id]);
    await db.run(
      `INSERT INTO file_renditions (file_id, kind, storage_key, mime, width, height, size_bytes, created_at)
       SELECT ?, kind, storage_key, mime, width, height, size_bytes, ? FROM file_renditions WHERE file_id = ?`,
      [file.id, at, twin.id],
    );
    await setStatus(db, file.id, "ready");
  });
  return true;
}

/**
 * generateRenditions(ctx, fileId) -> 'ready' | 'unsupported' | 'failed' | null
 * Writes file_renditions rows and material_files.preview_status. Safe to run
 * again (old renditions are replaced and their objects freed).
 */
export async function generateRenditions(ctx, fileId) {
  const { db, storage } = ctx;
  const file = await db.get("SELECT * FROM material_files WHERE id = ?", [fileId]);
  if (!file) return null;
  if (await reuseFromTwin(db, file)) return "ready";

  const plan = renditionPlan(file);
  if (!plan || (plan === "video" && !ctx.config.ffmpegPath)) {
    await setStatus(db, file.id, "unsupported");
    return "unsupported";
  }

  const created = [];
  try {
    const path = storage.localPath(file.storage_key);
    const result =
      plan === "svg" ? await svgRenditions(path) : plan === "image" ? await imageRenditions(path) : await videoRenditions(ctx, path, file);
    for (const [kind, output] of Object.entries(result.outputs)) {
      const stored = await storage.putBuffer(output.data);
      created.push({ kind, key: stored.key, size: stored.size, width: output.width, height: output.height });
    }
    // the file may have been deleted while we worked
    if (!await db.get("SELECT 1 FROM material_files WHERE id = ?", [file.id])) {
      for (const item of created) await storage.remove(item.key);
      return null;
    }
    const at = now();
    let previous = [];
    await db.tx(async () => {
      previous = (await db.all("SELECT storage_key FROM file_renditions WHERE file_id = ?", [file.id])).map((row) => row.storage_key);
      await db.run("DELETE FROM file_renditions WHERE file_id = ?", [file.id]);
      for (const item of created)
        await db.run(
          `INSERT INTO file_renditions (file_id, kind, storage_key, mime, width, height, size_bytes, created_at)
           VALUES (?, ?, ?, 'image/webp', ?, ?, ?, ?)`,
          [file.id, item.kind, item.key, item.width, item.height, item.size, at],
        );
      await db.run(
        `UPDATE material_files SET preview_status = 'ready',
           width = COALESCE(width, ?), height = COALESCE(height, ?) WHERE id = ?`,
        [result.size.width, result.size.height, file.id],
      );
    });
    for (const key of previous) await removeStorageIfUnreferenced(ctx, key);
    return "ready";
  } catch (err) {
    for (const item of created) await storage.remove(item.key).catch(() => {});
    ctx.log?.warn?.(`[renditions] ${file.id} (${file.ext}): ${err.message}`);
    if (await db.get("SELECT 1 FROM material_files WHERE id = ?", [file.id])) await setStatus(db, file.id, "failed");
    return "failed";
  }
}

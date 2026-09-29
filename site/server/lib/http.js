import { pipeline } from "node:stream/promises";
import { HttpError } from "./errors.js";

// RFC 6266 / 5987: ASCII fallback plus UTF-8 filename*.
export function contentDisposition(filename, type = "attachment") {
  const name = String(filename ?? "arquivo").replace(/[\r\n]/g, " ") || "arquivo";
  const fallback =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\%;]/g, "_")
      .trim() || "arquivo";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type === "inline" ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Types a browser may render inline from our origin. Everything else
// (SVG, HTML, text…) is forced to attachment.
const INLINE_SAFE = /^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|quicktime|x-m4v)|audio\/(mpeg|wav|mp4|x-wav)|application\/pdf)$/;

/**
 * Safe headers for stored files. disposition 'inline' only for INLINE_SAFE
 * types. Inline PDFs keep frame-ancestors 'self' without sandbox, because
 * browser PDF viewers refuse to run in a sandboxed document.
 */
export function fileHeaders(res, { mime, size, filename, disposition = "attachment", cache = "private, no-store" }) {
  const type = String(mime || "application/octet-stream");
  const bare = type.split(";")[0].trim().toLowerCase();
  const inline = disposition === "inline" && INLINE_SAFE.test(bare);
  res.setHeader("Content-Type", type);
  if (Number.isFinite(size)) res.setHeader("Content-Length", String(size));
  res.setHeader("Content-Disposition", contentDisposition(filename, inline ? "inline" : "attachment"));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", cache);
  if (inline && bare === "application/pdf") {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
  } else {
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'self'");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
  }
}

// Parses a single "bytes=a-b" range. -> { start, end } | null (whole file) | 'invalid'
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null; // multi-range or other units: send the whole file
  const [, a, b] = match;
  if (a === "" && b === "") return "invalid";
  let start;
  let end;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/**
 * Streams a stored object with Range support (206/416). Resolves when the
 * response ends; client aborts are ignored.
 * opts: { mime, size, filename, disposition, cache }
 */
export async function sendStoredFile(req, res, storage, key, opts = {}) {
  let size = opts.size;
  const info = await storage.stat(key);
  if (!info) throw new HttpError(404, "not_found", "O arquivo não está mais disponível no armazenamento.");
  if (!Number.isFinite(size) || size !== info.size) size = info.size;

  const range = parseRange(req.headers.range, size);
  if (range === "invalid") {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }
  fileHeaders(res, { ...opts, size: range ? range.end - range.start + 1 : size });
  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  } else {
    res.status(200);
  }
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  const stream = storage.createReadStream(key, range ?? {});
  try {
    await pipeline(stream, res);
  } catch (err) {
    if (err?.code === "ERR_STREAM_PREMATURE_CLOSE" || res.destroyed) return;
    throw err;
  }
}

// Name used in docs/PLATFORM.md.
export const sendFileRange = sendStoredFile;

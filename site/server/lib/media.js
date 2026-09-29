import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import sharp from "sharp";
import { findOnPath } from "../config.js";

// Allowed extensions per media_kind. Anything else is rejected (415).
export const EXTENSIONS = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "avif"],
  vector: ["svg", "eps"],
  video: ["mp4", "mov", "webm", "m4v"],
  audio: ["mp3", "wav", "m4a"],
  pdf: ["pdf"],
  font: ["ttf", "otf", "woff", "woff2"],
  design: ["ai", "psd", "indd", "idml", "fig", "sketch", "xd", "afdesign", "aep", "prproj", "cdr"],
  document: ["pptx", "key", "docx", "xlsx", "txt"],
  archive: ["zip"],
};

const KIND_BY_EXT = new Map(
  Object.entries(EXTENSIONS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind])),
);

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  svg: "image/svg+xml",
  eps: "application/postscript",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  ai: "application/postscript",
  psd: "image/vnd.adobe.photoshop",
  indd: "application/x-indesign",
  idml: "application/vnd.adobe.indesign-idml-package",
  fig: "application/octet-stream",
  sketch: "application/octet-stream",
  xd: "application/octet-stream",
  afdesign: "application/octet-stream",
  aep: "application/octet-stream",
  prproj: "application/octet-stream",
  cdr: "application/octet-stream",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  key: "application/vnd.apple.keynote",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain; charset=utf-8",
  zip: "application/zip",
};

// Label shown to people ("PNG", "JPG", "Illustrator"…) and used for ZIP folders.
const FORMAT_LABELS = { jpeg: "JPG", tif: "TIFF", m4v: "MP4" };

export const extOf = (filename) => {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(String(filename ?? "").trim());
  return match ? match[1].toLowerCase() : "";
};
export const isAllowedExt = (ext) => KIND_BY_EXT.has(String(ext).toLowerCase());
export const kindForExt = (ext) => KIND_BY_EXT.get(String(ext).toLowerCase()) ?? null;
export const mimeFor = (ext) => MIME[String(ext).toLowerCase()] ?? "application/octet-stream";
export const formatLabel = (ext) => {
  const lower = String(ext ?? "").toLowerCase();
  return FORMAT_LABELS[lower] ?? lower.toUpperCase();
};
// Formats that are already compressed (ZIP entries can use store).
export const COMPRESSED_EXTS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "avif", "mp4", "mov", "webm", "m4v", "mp3", "m4a",
  "zip", "woff", "woff2", "pptx", "docx", "xlsx", "key", "idml", "sketch", "xd", "fig",
]);

// Kinds whose previews come from sharp/ffmpeg (others show a document card).
export const PREVIEWABLE_KINDS = new Set(["image", "vector", "video"]);

// ------------------------------------------------------------ signatures

const ascii = (buf, start, end) => buf.subarray(start, end).toString("latin1");
const startsWith = (buf, bytes, offset = 0) => bytes.every((byte, i) => buf[offset + i] === byte);
const isZip = (buf) => startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]);
const isFtyp = (buf) => ascii(buf, 4, 8) === "ftyp";
const isPdf = (buf) => ascii(buf, 0, 1024).includes("%PDF-");
const isPostScript = (buf) => ascii(buf, 0, 4) === "%!PS" || startsWith(buf, [0xc5, 0xd0, 0xd3, 0xc6]);

function looksLikeSvg(buf) {
  let text = buf.toString("utf8");
  if (text.includes("\u0000")) return false;
  text = text.replace(/^﻿/, "").trimStart();
  return /<svg[\s>]/i.test(text.slice(0, 8192)) && /^(<\?xml|<!--|<!doctype|<svg)/i.test(text);
}

const SIGNATURES = {
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  gif: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a",
  webp: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  tif: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  tiff: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  avif: (b) => isFtyp(b) && /avi[fs]/.test(ascii(b, 8, 32)),
  svg: looksLikeSvg,
  eps: isPostScript,
  ai: (b) => isPdf(b) || isPostScript(b),
  pdf: isPdf,
  mp4: isFtyp,
  m4v: isFtyp,
  m4a: isFtyp,
  mov: (b) => isFtyp(b) || ["moov", "mdat", "wide", "free", "skip", "pnot"].includes(ascii(b, 4, 8)),
  webm: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  mp3: (b) => ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  wav: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE",
  ttf: (b) => startsWith(b, [0x00, 0x01, 0x00, 0x00]) || ascii(b, 0, 4) === "true" || ascii(b, 0, 4) === "ttcf",
  otf: (b) => ascii(b, 0, 4) === "OTTO" || startsWith(b, [0x00, 0x01, 0x00, 0x00]),
  woff: (b) => ascii(b, 0, 4) === "wOFF",
  woff2: (b) => ascii(b, 0, 4) === "wOF2",
  psd: (b) => ascii(b, 0, 4) === "8BPS",
  zip: isZip,
  docx: isZip,
  xlsx: isZip,
  pptx: isZip,
  idml: isZip,
  sketch: isZip,
  xd: isZip,
  key: isZip,
  txt: (b) => !b.includes(0),
};

async function readHead(filePath, bytes = 8192) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// true when the content matches the extension (formats without a reliable
// signature pass). Accepts a Buffer (the first KB) or a file path.
export async function checkSignature(source, ext) {
  const check = SIGNATURES[String(ext).toLowerCase()];
  if (!check) return true;
  const head = Buffer.isBuffer(source) ? source : await readHead(source);
  if (!head.length) return false;
  return Boolean(check(head));
}

// ------------------------------------------------------------ inspection

let detectedFfprobe;
const defaultFfprobe = () => (detectedFfprobe === undefined ? (detectedFfprobe = findOnPath("ffprobe")) : detectedFfprobe);

function ffprobe(bin, filePath) {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * inspect(filePath, ext, { ffprobePath }) ->
 *   { mediaKind, mime, width, height, durationMs, pages }
 * Images/SVG use sharp metadata; video/audio use ffprobe when available.
 * Unreadable metadata leaves the fields null (the file is still accepted).
 */
export async function inspect(filePath, ext, { ffprobePath } = {}) {
  const lower = String(ext).toLowerCase();
  const mediaKind = kindForExt(lower) ?? "other";
  const info = { mediaKind, mime: mimeFor(lower), width: null, height: null, durationMs: null, pages: null };

  if (mediaKind === "image" || lower === "svg") {
    try {
      const meta = await sharp(filePath, { limitInputPixels: 268402689, pages: 1 }).metadata();
      let { width = null, height = null } = meta;
      if (meta.orientation && meta.orientation >= 5) [width, height] = [height, width];
      info.width = width ?? null;
      info.height = height ?? null;
      if (lower === "gif" && meta.pages > 1 && meta.pageHeight) info.height = meta.pageHeight;
    } catch {
      // keep nulls
    }
  } else if (mediaKind === "video" || mediaKind === "audio") {
    const bin = ffprobePath === undefined ? defaultFfprobe() : ffprobePath;
    if (bin) {
      const probe = await ffprobe(bin, filePath);
      const video = probe?.streams?.find((stream) => stream.codec_type === "video");
      if (video) {
        let width = Number(video.width) || null;
        let height = Number(video.height) || null;
        const rotation = Math.abs(Number(video.tags?.rotate ?? video.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0));
        if (rotation === 90 || rotation === 270) [width, height] = [height, width];
        info.width = width;
        info.height = height;
      }
      const seconds = Number(probe?.format?.duration);
      if (Number.isFinite(seconds) && seconds > 0) info.durationMs = Math.round(seconds * 1000);
    }
  }
  return info;
}

// ------------------------------------------------------------ file names

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Keeps accents and spaces; removes path separators, control characters and
 * characters Windows/macOS reject. Keeps the extension when truncating.
 */
export function sanitizeFilename(name, fallback = "arquivo") {
  let text = String(name ?? "").normalize("NFC");
  text = text.split(/[\\/]/).pop() ?? "";
  text = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .replace(/[​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!text) return fallback;
  if (WINDOWS_RESERVED.test(text)) text = `_${text}`;
  if (text.length > 180) {
    const ext = extOf(text);
    const keep = ext ? 180 - ext.length - 1 : 180;
    text = ext ? `${text.slice(0, keep).trim()}.${ext}` : text.slice(0, 180).trim();
  }
  return text;
}

// Folder names inside ZIPs (same rules, no extension handling).
// Titles such as "Dia/Noite" become "Dia-Noite" (never a nested folder).
export function safeSegment(name, fallback = "Sem nome") {
  const clean = sanitizeFilename(String(name ?? "").replace(/\s*[\\/]\s*/g, "-"), fallback);
  return clean.length > 100 ? clean.slice(0, 100).trim() : clean;
}

export const baseName = (name) => basename(String(name ?? "")).replace(/\.[^.]+$/, "");

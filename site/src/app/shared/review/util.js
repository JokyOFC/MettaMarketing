// Small helpers shared by the review components and the content pages.
import { api } from "../../api/client.js";

export const cx = (...parts) => parts.filter(Boolean).join(" ");

const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt));

// { originals, finals, editables, covers } of a version, each in slide order.
export function groupFiles(files = []) {
  const pick = (role) => files.filter((file) => file.role === role).sort(byPosition);
  return { originals: pick("original"), finals: pick("final"), editables: pick("editable"), covers: pick("cover") };
}

// Best image for a big stage / a small thumbnail (never the original bytes).
export const stageUrl = (file) => file?.previews?.preview || file?.previews?.thumb || file?.previews?.poster || null;
export const thumbUrl = (file) => file?.previews?.thumb || file?.previews?.poster || file?.previews?.preview || null;

export function ratioOf(source, fallback = 1) {
  const width = source?.width;
  const height = source?.height;
  if (width > 0 && height > 0) return width / height;
  return fallback;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Frame proportion of a post: stories/reels are vertical 9:16; otherwise the
// real proportion of the first slide (Instagram-like bounds), then 4:5.
export function postRatio(item) {
  const format = item?.post?.format;
  const frame = item?.frame || (item?.thumb?.width ? item.thumb : null);
  if (format === "stories" || format === "reels") return frame ? clamp(ratioOf(frame), 0.5, 0.8) : 9 / 16;
  if (frame) return clamp(ratioOf(frame), 0.5, 1.91);
  if (format === "video") return 16 / 9;
  return 4 / 5;
}

// Why a visible file cannot be downloaded (null when it can).
export function lockReason(file, material) {
  if (!file || file.downloadable) return null;
  if (file.role === "cover") return "A capa é usada só como prévia.";
  if (file.mediaKind === "font" && file.fontDistributable === false)
    return "A licença desta fonte não permite distribuir o arquivo.";
  if (material && material.downloadEnabled === false) return "Download ainda não liberado pela equipe Metta.";
  return "Disponível apenas para visualização.";
}

// Is this material a logo-like artwork (background switcher)?
export function isArtwork(material, file) {
  if (!material) return false;
  if (material.kind === "post") return false;
  if (material.category?.area === "identity" || material.variant) return true;
  return file?.mediaKind === "vector" || /^(png|svg|webp|gif)$/i.test(file?.ext ?? "");
}

export function initialBackground(material) {
  const bg = material?.previewBg;
  if (bg && bg !== "auto") return bg;
  if (material?.variant === "clara") return "dark";
  if (material?.variant === "escura") return "light";
  return "checker";
}

// Latest detail of a material (content endpoint for posts, else materials).
export async function fetchMaterial(material) {
  const id = material?.id;
  if (!id) return null;
  const data = await api.get(material.kind === "post" ? `/content/${id}` : `/materials/${id}`);
  return data?.material ?? null;
}

export const versionOf = (material, id) => material?.versions?.find((version) => version.id === id) ?? null;

// Hashtags typed as "#a #b, c" -> ["#a", "#b", "#c"].
export function parseHashtags(text) {
  if (!text) return [];
  const seen = new Set();
  return String(text)
    .split(/[\s,;]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .filter((tag) => tag.length > 1 && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
}

// "Chrome no Windows" from a user agent (audit lines for the team).
export function browserLabel(userAgent) {
  if (!userAgent) return "";
  const ua = String(userAgent);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (!browser && !os) return ua.slice(0, 40);
  return [browser, os].filter(Boolean).join(" no ");
}

// Local storage that never throws (private mode, blocked storage).
export const storage = {
  get(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* the choice lasts until reload */
    }
  },
};

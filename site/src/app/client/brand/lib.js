// Helpers shared by "Minha marca" and "Arquivos" (slice C).
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { useDownloads } from "../../api/downloads.js";

export const cx = (...parts) => parts.filter(Boolean).join(" ");

// ------------------------------------------------------------ material detail cache

// Lists (library, /materials) carry no files; format chips, sizes and single
// downloads need GET /api/materials/:id. Details are cached per material and
// version, and fetched at most four at a time so a large library does not
// flood the API.
const details = new Map();
const queue = [];
const MAX_PARALLEL = 4;
let active = 0;

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active += 1;
    task()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

const schedule = (task) =>
  new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });

export const stampOf = (material) =>
  material ? `${material.id}|${material.version?.id ?? ""}|${material.updatedAt ?? ""}` : "";

// A library payload may already embed the files (versions or files); then no
// request is needed.
export function embeddedDetail(material) {
  if (!material) return null;
  if (Array.isArray(material.versions)) return material;
  const files = material.files ?? material.version?.files;
  if (!Array.isArray(files)) return null;
  return { ...material, versions: [{ ...(material.version || {}), files }] };
}

export function loadMaterialDetail(material) {
  const embedded = embeddedDetail(material);
  if (embedded) return Promise.resolve(embedded);
  const key = stampOf(material);
  let entry = details.get(key);
  if (!entry) {
    entry = { data: null };
    entry.promise = schedule(() => api.get(`/materials/${material.id}`)).then(
      (res) => {
        entry.data = res?.material ?? null;
        return entry.data;
      },
      (error) => {
        details.delete(key);
        throw error;
      },
    );
    details.set(key, entry);
  }
  return entry.promise;
}

export const peekMaterialDetail = (material) =>
  embeddedDetail(material) || details.get(stampOf(material))?.data || null;

// Replaces the cached detail (after an approval, for example).
export function primeMaterialDetail(detail) {
  if (!detail?.id) return;
  const entry = { data: detail, promise: Promise.resolve(detail) };
  details.set(stampOf(detail), entry);
}

// { map: {id: MaterialDetail}, errors: {id: ApiError} } for a list of materials.
export function useMaterialDetails(materials) {
  const list = (materials || []).filter(Boolean);
  const key = list.map(stampOf).join(",");
  const [state, setState] = useState({ key: null, map: {}, errors: {} });

  useEffect(() => {
    let alive = true;
    const map = {};
    for (const material of list) {
      const known = peekMaterialDetail(material);
      if (known) map[material.id] = known;
    }
    setState({ key, map, errors: {} });
    for (const material of list) {
      if (map[material.id]) continue;
      loadMaterialDetail(material).then(
        (detail) => {
          if (!alive) return;
          setState((s) =>
            s.key === key ? { ...s, map: { ...s.map, [material.id]: detail } } : s,
          );
        },
        (error) => {
          if (!alive) return;
          setState((s) =>
            s.key === key ? { ...s, errors: { ...s.errors, [material.id]: error } } : s,
          );
        },
      );
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (state.key === key) return state;
  const map = {};
  for (const material of list) {
    const known = peekMaterialDetail(material);
    if (known) map[material.id] = known;
  }
  return { key, map, errors: {} };
}

// ------------------------------------------------------------ files

// The version a viewer sees: the one the list summarised (client: latest
// released), falling back to the newest listed.
export function visibleVersion(detail, versionId) {
  const versions = detail?.versions || [];
  const wanted = versionId ?? detail?.version?.id;
  return versions.find((v) => v.id === wanted) || versions[0] || null;
}

export const filesOf = (detail, versionId) => visibleVersion(detail, versionId)?.files || [];

export const byRole = (files, role) => files.filter((f) => f.role === role);

// Ready-to-use files follow the ZIP rule: final exports when they exist,
// otherwise the originals. Covers are previews, never deliveries.
export function readyFiles(files) {
  const finals = byRole(files, "final");
  return finals.length ? finals : byRole(files, "original");
}

export const editableFiles = (files) => byRole(files, "editable");

export const deliverableFiles = (files) => files.filter((f) => f.role !== "cover");

// What a material ZIP holds for the client, mirroring the server rule
// (services/materials.js zipEntries): the final exports when they exist,
// otherwise the originals, plus the editables the client may download.
export const packageFiles = (files) =>
  [...readyFiles(files), ...editableFiles(files)].filter((f) => f.downloadable);

// ------------------------------------------------------------ ZIP progress

const ACTIVE_ZIP = new Set(["queued", "running"]);

function zipPercent(job) {
  if (!job) return null;
  const value = Number.isFinite(job.progress)
    ? job.progress
    : job.totalBytes > 0
      ? (job.processedBytes || 0) / job.totalBytes
      : null;
  return value === null ? null : Math.round(Math.max(0, Math.min(1, value)) * 100);
}

// One ZIP started from a button: run(start) calls start() (which returns the
// tray job, as startZip does) and follows that job in useDownloads().jobs, so
// the button can say "Preparando ZIP… 40%" with the server's real progress
// until the file is ready (the tray keeps the details and the retry).
export function useZipJob() {
  const { jobs } = useDownloads();
  const [track, setTrack] = useState({ id: null, starting: false });
  const busyRef = useRef(false);
  const job = track.id ? (jobs || []).find((j) => j.id === track.id) || null : null;
  const preparing = Boolean(job && ACTIVE_ZIP.has(job.status));
  const linking = Boolean(job?.linking);
  const busy = track.starting || preparing || linking;
  busyRef.current = busy;

  const run = useCallback(async (start) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setTrack({ id: null, starting: true });
    let started = null;
    try {
      started = await start();
    } finally {
      setTrack({ id: started?.id ?? null, starting: false });
    }
    return started;
  }, []);

  const percent = preparing ? zipPercent(job) : null;
  const text = linking
    ? "Baixando o ZIP…"
    : preparing && job.status === "queued"
      ? "ZIP na fila…"
      : percent !== null && percent > 0
        ? `Preparando ZIP… ${percent}%`
        : "Preparando ZIP…";
  return { run, busy, percent, text: busy ? text : null, job };
}

// The file behind the list thumbnail (for the larger preview rendition).
export function previewFile(detail, material) {
  const files = filesOf(detail);
  const thumbId = material?.thumb?.fileId;
  return (
    files.find((f) => f.id === thumbId) ||
    files.find((f) => f.role === "cover") ||
    readyFiles(files).find((f) => f.previews?.preview || f.previews?.thumb) ||
    null
  );
}

// Why a file cannot be downloaded, in words the client understands.
export function downloadBlock(file, material) {
  if (!file || file.downloadable) return null;
  if (file.mediaKind === "font" && file.fontDistributable === false)
    return "A licença desta fonte não permite distribuir o arquivo.";
  if (material && material.downloadEnabled === false)
    return "Download ainda não liberado pela equipe Metta.";
  if (file.role === "cover") return "Imagem de capa, apenas para visualização.";
  return "Arquivo indisponível para download.";
}

// ------------------------------------------------------------ colors

export function normalizeHex(hex) {
  const raw = String(hex || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw))
    return `#${raw
      .split("")
      .map((c) => c + c)
      .join("")}`.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`.toUpperCase();
  return null;
}

function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex) {
  const value = normalizeHex(hex);
  if (!value) return 1;
  const n = parseInt(value.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const INK = luminance("#252a20");
const PAPER = luminance("#f4f1e9");

// "dark" text or "light" text, whichever reads better on the swatch.
export function readableTone(hex) {
  const l = luminance(hex);
  return contrast(l, INK) >= contrast(l, PAPER) ? "dark" : "light";
}

// ------------------------------------------------------------ text & links

// Only http(s) links leave the portal (no javascript: or data: URLs).
export function safeUrl(url) {
  try {
    const parsed = new URL(String(url || ""), window.location.origin);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

// Plain text written by the team -> blocks: paragraphs and bullet lists.
export function textBlocks(text) {
  const blocks = [];
  for (const chunk of String(text || "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const bullet = /^([-•*–])\s+/;
    if (lines.every((l) => bullet.test(l)))
      blocks.push({ type: "list", items: lines.map((l) => l.replace(bullet, "")) });
    else blocks.push({ type: "p", lines });
  }
  return blocks;
}

export const splitList = (value) =>
  Array.isArray(value)
    ? value.filter(Boolean).map(String)
    : String(value || "")
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);

// ------------------------------------------------------------ misc

const PREVIEW_BGS = new Set(["light", "dark", "checker"]);
const VARIANT_BG = { clara: "dark", escura: "light", monocromatica: "checker" };

// Background a logo deserves: the team's choice, else the variant's rule.
export function defaultBg(material) {
  if (PREVIEW_BGS.has(material?.previewBg)) return material.previewBg;
  return VARIANT_BG[material?.variant] || "light";
}

// Thumbnail ground in lists: logos follow the variant rule, the rest
// keep the team's choice or the neutral surface.
export function thumbBg(material) {
  const logo = material?.variant || material?.category?.slug === "logotipo";
  if (logo && ["image", "vector"].includes(material?.thumb?.mediaKind)) return defaultBg(material);
  return PREVIEW_BGS.has(material?.previewBg) ? material.previewBg : "auto";
}

export function readStored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference lasts for this visit */
  }
}

export function scrollToId(id, reduced) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  el.focus?.({ preventScroll: true });
}

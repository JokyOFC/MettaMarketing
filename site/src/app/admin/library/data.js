// Reference data and small helpers shared by the library pages (slice B).
// Lists come from other slices' endpoints; every reader tolerates the
// {items} and bare-array shapes so a page never breaks on an empty answer.
import { useEffect, useMemo, useState } from "react";
import { useApi } from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";

export const itemsOf = (data) =>
  Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];

const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), "pt-BR");

// Clients in the viewer's scope (for filters and cascades).
export function useClients() {
  const res = useApi("/clients", { params: { pageSize: 200 } });
  const items = useMemo(() => itemsOf(res.data).slice().sort(byName), [res.data]);
  return { ...res, items };
}

// Brands in scope; with clientId only that client's brands.
export function useBrands(clientId) {
  const res = useApi("/brands", { params: clientId ? { clientId } : undefined });
  const items = useMemo(() => itemsOf(res.data).slice().sort(byName), [res.data]);
  return { ...res, items };
}

export const brandClientId = (brand) => brand?.clientId ?? brand?.client?.id ?? null;
export const projectBrandId = (project) => project?.brandId ?? project?.brand?.id ?? null;

// Projects of a brand (null brand: nothing is requested).
export function useProjects(brandId) {
  const res = useApi(brandId ? "/projects" : null, { params: brandId ? { brandId } : undefined });
  const items = useMemo(
    () =>
      itemsOf(res.data)
        .filter((project) => !brandId || !projectBrandId(project) || projectBrandId(project) === brandId)
        .filter((project) => project.status !== "archived")
        .sort(byName),
    [res.data, brandId],
  );
  return { ...res, items };
}

// Material categories, ordered; `active` drops archived ones.
export function useCategories() {
  const res = useApi("/categories");
  const all = useMemo(
    () =>
      itemsOf(res.data)
        .slice()
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || byName(a, b)),
    [res.data],
  );
  const active = useMemo(() => all.filter((category) => !category.archivedAt), [all]);
  return { ...res, items: all, active };
}

// Team members for "Responsável". Needs team.view; otherwise the members of
// the selected project (always readable by people working on it).
export function useOwners(projectId) {
  const { user, can } = useAuth();
  const canTeam = can("team.view");
  const team = useApi(canTeam ? "/team/users" : null, { params: { status: "active" } });
  const project = useApi(!canTeam && projectId ? `/projects/${projectId}` : null);
  const items = useMemo(() => {
    let people = [];
    if (canTeam) people = itemsOf(team.data).filter((person) => person.role !== "client" && person.status !== "disabled");
    else {
      const data = project.data;
      const members = data?.project?.members ?? data?.members ?? [];
      people = members.map((member) => ({
        id: member.userId ?? member.user?.id ?? member.id,
        name: member.name ?? member.user?.name ?? "Pessoa da equipe",
        role: member.user?.role ?? member.userRole ?? "designer",
      }));
    }
    if (user && !people.some((person) => person.id === user.id))
      people.unshift({ id: user.id, name: user.name, role: user.role });
    const seen = new Set();
    return people.filter((person) => person.id && !seen.has(person.id) && seen.add(person.id)).sort(byName);
  }, [canTeam, team.data, project.data, user]);
  return { items, loading: team.loading || project.loading, canTeam };
}

// Allowed upload extensions (mirror of server/lib/media.js; the server stays
// the authority and answers 415 for anything else).
export const ALLOWED_EXTS = [
  "png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "avif",
  "svg", "eps",
  "mp4", "mov", "webm", "m4v",
  "mp3", "wav", "m4a",
  "pdf",
  "ttf", "otf", "woff", "woff2",
  "ai", "psd", "indd", "idml", "fig", "sketch", "xd", "afdesign", "aep", "prproj", "cdr",
  "pptx", "key", "docx", "xlsx", "txt",
  "zip",
];
export const ACCEPT = ALLOWED_EXTS.map((ext) => `.${ext}`).join(",");
const EDITABLE_EXTS = new Set(["ai", "psd", "indd", "idml", "fig", "sketch", "xd", "afdesign", "aep", "prproj", "cdr", "eps"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);

export const extOf = (name) => {
  const text = String(name ?? "");
  const dot = text.lastIndexOf(".");
  return dot > 0 ? text.slice(dot + 1).toLowerCase() : "";
};
export const isEditableExt = (ext) => EDITABLE_EXTS.has(ext);
export const isImageExt = (ext) => IMAGE_EXTS.has(ext);

// "logo-principal_v2.png" -> "Logo principal v2"
export function titleFromFilename(name) {
  const stem = String(name ?? "").replace(/\.[^.]+$/, "");
  const text = stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Material sem título";
}

// Background used to present a material's artwork.
export function artBackground(material) {
  if (!material) return "auto";
  if (material.previewBg && material.previewBg !== "auto") return material.previewBg;
  if (material.category?.slug === "logotipo") return "checker";
  if (material.thumb?.mediaKind === "vector") return "light";
  return "auto";
}

export const isLogo = (material) => material?.category?.slug === "logotipo";

export const LOGO_VARIANTS = ["principal", "secundaria", "simbolo", "clara", "escura", "monocromatica"];

export function groupBy(list, keyOf) {
  const map = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Tolerant reader for GET /materials/:id/history (Activity[] plus versions and
// downloads) -> [{id, kind, at, actor, summary, data}] newest first.
export function historyEvents(data) {
  if (!data) return [];
  const list = [];
  const merged = Array.isArray(data) ? data : data.items ?? null;
  const activity = merged ?? data.activity ?? data.events ?? [];
  for (const entry of activity) {
    const download = entry.type === "download";
    list.push({
      id: `${download ? "d" : "a"}-${entry.id}`,
      kind: download ? "download" : kindOfAction(entry.action),
      at: entry.createdAt ?? entry.at,
      actor: entry.actor ?? null,
      summary: entry.summary ?? entry.action,
      visibility: entry.visibility ?? null,
      action: entry.action,
    });
  }
  // Downloads arrive inside `items` (slice A) or separately.
  for (const entry of merged ? [] : data.downloads ?? []) {
    list.push({
      id: `d-${entry.id}`,
      kind: "download",
      at: entry.createdAt ?? entry.at,
      actor: entry.user ?? entry.actor ?? null,
      summary:
        entry.summary ??
        `${entry.user?.name ?? "Alguém"} baixou ${entry.kind === "zip" ? "um pacote ZIP" : entry.fileName ? `“${entry.fileName}”` : "um arquivo"}${entry.versionNumber ? ` (v${entry.versionNumber})` : ""}.`,
      action: "download",
    });
  }
  const seen = new Set();
  return list
    .filter((event) => event.at && !seen.has(event.id) && seen.add(event.id))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function kindOfAction(action = "") {
  if (action.startsWith("download") || action.includes(".download")) return "download";
  if (action.includes("release")) return "release";
  if (action.includes("approv") || action.includes("changes") || action.includes("decision")) return "approval";
  if (action.includes("version")) return "version";
  if (action.includes("comment")) return "comment";
  if (action.includes("archiv")) return "archive";
  if (action.includes("deliver")) return "delivery";
  return "edit";
}

export const materialsLabel = (n) => (n === 1 ? "1 material" : `${n} materiais`);

// Number of slides of a version for the comment composer: only real
// sequences (a post carousel, or grouped pieces with different file names).
// An asset delivered in several formats of the same artwork (logo.svg +
// logo.png) is one piece: same rule as the shared MaterialViewer. Identity
// materials (logos, palettes, manuals) are never sequences.
export function sequenceLength(material, version) {
  const originals = (version?.files ?? []).filter((file) => file.role === "original");
  if (originals.length < 2) return 0;
  if (material?.kind === "post") return originals.length;
  if (material?.category?.area === "identity") return 0;
  const stems = new Set(originals.map((file) => String(file.name ?? "").replace(/\.[^.]+$/, "").trim().toLowerCase() || file.id));
  return stems.size > 1 ? stems.size : 0;
}

// Upload size limit from the server (GET /api/uploads/limits ->
// {maxUploadBytes}); fetched once per page load. null while unknown or when
// the server does not expose it: the server still answers 413.
let uploadLimit;
let uploadLimitRequest = null;
export function useUploadLimit() {
  const [limit, setLimit] = useState(uploadLimit ?? null);
  useEffect(() => {
    if (uploadLimit !== undefined) return undefined;
    let alive = true;
    uploadLimitRequest ??= api
      .get("/uploads/limits")
      .then((data) => {
        const bytes = Number(data?.maxUploadBytes ?? data?.limits?.maxUploadBytes);
        return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
      })
      .catch(() => null)
      .then((bytes) => {
        uploadLimit = bytes;
        return bytes;
      });
    uploadLimitRequest.then((bytes) => alive && setLimit(bytes));
    return () => {
      alive = false;
    };
  }, []);
  return limit;
}

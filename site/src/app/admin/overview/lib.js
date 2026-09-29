// Slice I helpers shared by the overviews, reports and history screens.
import {
  Archive,
  ArchiveRestore,
  Activity as ActivityIcon,
  BadgeCheck,
  CalendarDays,
  ChartColumn,
  ClipboardList,
  CreditCard,
  Download,
  FileDown,
  FolderKanban,
  KeyRound,
  Layers,
  MessageSquare,
  MessageSquareWarning,
  Pencil,
  Plus,
  Receipt,
  Send,
  Settings2,
  Trash2,
  UserCog,
  Users,
} from "lucide-react";
import { apiUrl, networkError, qs, signalUnauthenticated, toApiError } from "../../api/client.js";
import { triggerDownload } from "../../api/downloads.js";
import { isoDate, toDate } from "../../ui/index.js";

// ------------------------------------------------------------ people & dates

export const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

export function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "");
const longDateFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const weekdayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "long" });
const dayMonthFmt = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long" });

// "Segunda-feira, 28 de setembro"
export const longDate = (date = new Date()) => capitalize(longDateFmt.format(date));

// Local calendar day of an ISO instant ("2026-09-28").
export const dayKey = (value) => isoDate(value);

// Day header: { title: "Hoje" | "Segunda-feira", detail: "28 de setembro" (+ year when not current) }
export function dayHeading(key, now = new Date()) {
  const date = toDate(key);
  if (!date) return { title: "", detail: "" };
  const today = isoDate(now);
  const yesterday = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const detail = `${dayMonthFmt.format(date)}${date.getFullYear() !== now.getFullYear() ? ` de ${date.getFullYear()}` : ""}`;
  if (key === today) return { title: "Hoje", detail };
  if (key === yesterday) return { title: "Ontem", detail };
  return { title: capitalize(weekdayFmt.format(date)), detail };
}

// [{ key, heading, items }] in the order the items arrive (newest first).
export function groupByDay(items = []) {
  const groups = [];
  const index = new Map();
  for (const item of items) {
    const key = dayKey(item.createdAt);
    if (!index.has(key)) {
      const group = { key, heading: dayHeading(key), items: [] };
      index.set(key, group);
      groups.push(group);
    }
    index.get(key).items.push(item);
  }
  return groups;
}

// Local YYYY-MM-DD n days from today.
export const daysFromToday = (n) => {
  const now = new Date();
  return isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
};

// Period presets shared by the report and history filters.
export function presetRange(preset, custom = {}) {
  const today = daysFromToday(0);
  switch (preset) {
    case "hoje":
      return { from: today, to: today };
    case "7":
      return { from: daysFromToday(-6), to: today };
    case "30":
      return { from: daysFromToday(-29), to: today };
    case "90":
      return { from: daysFromToday(-89), to: today };
    case "ano":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "custom":
      return { from: custom.from || daysFromToday(-29), to: custom.to || today };
    default:
      return { from: undefined, to: undefined };
  }
}

// 12.5 -> "13 h", 70 -> "2,9 dias", 0.4 -> "< 1 h"
export function formatHours(hours) {
  if (hours === null || hours === undefined || Number.isNaN(Number(hours))) return "—";
  const h = Number(hours);
  if (h < 1) return "< 1 h";
  if (h < 48) return `${Math.round(h)} h`;
  const days = h / 24;
  return `${days.toFixed(days < 10 ? 1 : 0).replace(".", ",").replace(",0", "")} dias`;
}

// ------------------------------------------------------------------ links

// Where a client opens a material: posts in Conteúdo, the rest in Arquivos.
export const clientMaterialLink = (material) =>
  material?.kind === "post" ? `/painel/conteudo/${material.id}` : `/painel/arquivos?material=${encodeURIComponent(material?.id ?? "")}`;

// ---------------------------------------------------------- activity kinds

// Groups for the history filter and the icon of each entry. `match` lists the
// first segment of action names ("material.created" -> "material") and entity types.
export const ACTION_GROUPS = [
  { key: "materials", label: "Materiais e versões", match: ["material", "version", "file", "upload"], icon: Layers },
  { key: "releases", label: "Liberações e kits", match: ["release", "kit", "identity"], icon: Send },
  { key: "approvals", label: "Aprovações e ajustes", match: ["approval", "review", "decision"], icon: BadgeCheck },
  { key: "comments", label: "Comentários", match: ["comment"], icon: MessageSquare },
  { key: "downloads", label: "Downloads", match: ["download", "zip"], icon: Download },
  { key: "content", label: "Conteúdo e publicação", match: ["post", "content", "campaign", "publication"], icon: CalendarDays },
  { key: "briefings", label: "Briefings", match: ["briefing"], icon: ClipboardList },
  { key: "projects", label: "Projetos e tarefas", match: ["project", "task"], icon: FolderKanban },
  { key: "clients", label: "Clientes e marcas", match: ["client", "brand", "color", "font"], icon: Users },
  { key: "team", label: "Equipe e acessos", match: ["user", "team", "session", "auth", "invite"], icon: UserCog },
  { key: "commerce", label: "Comercial e pagamentos", match: ["order", "subscription", "payment", "service", "checkout", "webhook"], icon: Receipt },
  { key: "settings", label: "Configurações", match: ["settings", "setting", "category"], icon: Settings2 },
  { key: "reports", label: "Relatórios e exportações", match: ["report", "activity"], icon: ChartColumn },
];
const OTHER_GROUP = { key: "other", label: "Outros registros", match: [], icon: ActivityIcon };

export function groupOf(action = "", entityType = "") {
  const text = String(action);
  if (/approv|changes_requested|request_changes|decision/.test(text)) return ACTION_GROUPS[2];
  if (/comment/.test(text)) return ACTION_GROUPS[3];
  if (/download|\.zip/.test(text)) return ACTION_GROUPS[4];
  if (/releas/.test(text)) return ACTION_GROUPS[1];
  const prefix = text.split(".")[0];
  return (
    ACTION_GROUPS.find((group) => group.match.includes(prefix)) ||
    ACTION_GROUPS.find((group) => group.match.includes(entityType)) ||
    OTHER_GROUP
  );
}

// Icon and tone for one entry, from the verb when it is telling.
export function actionLook(action = "", entityType = "") {
  const text = String(action);
  const verb = text.split(".").slice(1).join(".") || text;
  if (/approved|approve$/.test(verb)) return { icon: BadgeCheck, tone: "olive" };
  if (/changes|adjust|request/.test(verb)) return { icon: MessageSquareWarning, tone: "clay" };
  if (/fail|reject|error/.test(verb)) return { icon: groupOf(action, entityType).icon, tone: "red" };
  if (/paid|payment|charge/.test(text)) return { icon: CreditCard, tone: "olive" };
  if (/releas|deliver|published/.test(text)) return { icon: Send, tone: "teal" };
  if (/download|zip/.test(text)) return { icon: Download, tone: "neutral" };
  if (/export/.test(verb)) return { icon: FileDown, tone: "neutral" };
  if (/comment/.test(text)) return { icon: MessageSquare, tone: "neutral" };
  if (/unarchiv|restor/.test(verb)) return { icon: ArchiveRestore, tone: "neutral" };
  if (/archiv/.test(verb)) return { icon: Archive, tone: "neutral" };
  if (/delet|remov/.test(verb)) return { icon: Trash2, tone: "neutral" };
  if (/password|login|invite|session/.test(text)) return { icon: KeyRound, tone: "neutral" };
  if (/creat|upload|added|sent|submitted/.test(verb)) return { icon: Plus, tone: "neutral" };
  if (/updat|edit|chang|renam|moved|reorder/.test(verb)) return { icon: Pencil, tone: "neutral" };
  return { icon: groupOf(action, entityType).icon, tone: "neutral" };
}

// pt-BR names for activity_log.entity_type values.
const ENTITY_LABELS = {
  material: "Material",
  version: "Versão",
  file: "Arquivo",
  upload: "Envio",
  release: "Liberação",
  kit: "Kit",
  approval: "Aprovação",
  comment: "Comentário",
  zip: "Pacote ZIP",
  download: "Download",
  post: "Publicação",
  campaign: "Campanha",
  briefing: "Briefing",
  project: "Projeto",
  task: "Tarefa",
  client: "Cliente",
  brand: "Marca",
  color: "Cor",
  font: "Fonte",
  identity: "Identidade",
  user: "Usuário",
  order: "Pedido",
  subscription: "Assinatura",
  payment: "Pagamento",
  service: "Plano ou serviço",
  category: "Categoria",
  setting: "Configuração",
  settings: "Configurações",
  report: "Relatório",
};
export const entityLabel = (type) => ENTITY_LABELS[type] ?? type ?? "";

// ------------------------------------------------------------------- CSV

function filenameFrom(disposition) {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall back to the plain name */
    }
  }
  return /filename="([^"]+)"/i.exec(disposition)?.[1] ?? null;
}

// Downloads a CSV export (same session) and returns the file name. Errors
// come back as ApiError with the server's pt-BR message.
export async function exportCsv(path, params, fallbackName = "metta.csv") {
  const url = apiUrl(path) + qs({ ...params, format: "csv" });
  let response;
  try {
    response = await fetch(url, { credentials: "same-origin", headers: { Accept: "text/csv" } });
  } catch {
    throw networkError();
  }
  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* not JSON */
    }
    const error = toApiError(response.status, body);
    signalUnauthenticated(error, path);
    throw error;
  }
  const blob = await response.blob();
  const name = filenameFrom(response.headers.get("content-disposition")) || fallbackName;
  const href = URL.createObjectURL(blob);
  triggerDownload(href, name);
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return name;
}

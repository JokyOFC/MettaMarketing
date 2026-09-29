// Activity entries shared by the overviews and history screens (slice I).
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { Avatar, Badge, formatDateTime, formatRelative, formatTime, roleLabel } from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { actionLook, entityLabel } from "../overview/lib.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");

export const actorName = (item) => item.actor?.name ?? "Sistema";

// Downloads are access records listed in the staff history; they never count
// as an approval, and every place that shows one says so.
export const DOWNLOAD_NOTE = "Download — não equivale a aprovação";
export const isDownload = (item) => item?.entityType === "download" || String(item?.action ?? "").startsWith("download.");

// Summaries start with the actor's name ("Ana aprovou a versão 2…"); the person
// who did it reads "Você aprovou a versão 2…".
export function personalSummary(item, viewerId) {
  const name = item.actor?.name;
  const summary = item.summary ?? "";
  if (!viewerId || !name || item.actor?.id !== viewerId || !summary.startsWith(name)) return summary;
  return `Você${summary.slice(name.length)}`;
}

export function ActionIcon({ item, size = 16 }) {
  const { icon: Glyph, tone } = actionLook(item.action, item.entityType);
  return (
    <span className={cx("ov-act-icon", `ov-tone--${tone}`)} aria-hidden="true">
      <Glyph size={size} strokeWidth={1.4} />
    </span>
  );
}

function where(item, showClient = true) {
  const parts = [];
  if (showClient && item.client?.name) parts.push(item.client.name);
  if (item.brand?.name && item.brand.name !== item.client?.name) parts.push(item.brand.name);
  return parts.join(" › ");
}

// Compact feed for the overviews: icon, sentence, who · where · when.
// The whole row opens the entry's link (stretched link) when there is one.
export function ActivityFeed({ items = [], showWhere = true, showClient = true, className }) {
  const { user } = useAuth();
  return (
    <ol className={cx("ov-feed", className)}>
      {items.map((item, index) => {
        const place = showWhere ? where(item, showClient) : "";
        return (
          <li key={item.id} className={cx("ov-feed__item", "ui-enter", item.link && "has-link")} style={{ "--i": Math.min(index, 8) }}>
            <ActionIcon item={item} />
            <div className="ov-feed__body">
              <p className="ov-feed__text">
                {item.link ? (
                  <Link to={item.link} className="ov-stretch" title={item.linkLabel || undefined}>
                    {personalSummary(item, user?.id)}
                  </Link>
                ) : (
                  personalSummary(item, user?.id)
                )}
                {isDownload(item) && <span className="ov-feed__note">{DOWNLOAD_NOTE}</span>}
              </p>
              <p className="ov-feed__meta">
                <span>{actorName(item)}</span>
                {place && <span>{place}</span>}
                <time dateTime={item.createdAt} title={formatDateTime(item.createdAt)}>
                  {formatRelative(item.createdAt)}
                </time>
              </p>
            </div>
            {item.link && <ArrowUpRight className="ov-feed__go" size={16} strokeWidth={1.4} aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

// Calendar date as a small block: day number over the short month.
export function DateBlock({ date, className }) {
  if (!date) return null;
  const [y, m, d] = String(date).slice(0, 10).split("-").map(Number);
  const month = new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(new Date(y, m - 1, d)).replace(".", "");
  return (
    <span className={cx("ov-date", className)} aria-hidden="true">
      <span className="ov-date__day">{d}</span>
      <span className="ov-date__month">{month}</span>
    </span>
  );
}

// ------------------------------------------------------------ data details

const KEY_LABELS = {
  from: "De",
  to: "Para",
  previous: "Antes",
  next: "Depois",
  status: "Situação",
  title: "Título",
  name: "Nome",
  items: "Itens",
  count: "Quantidade",
  rows: "Linhas",
  versionNumber: "Versão",
  version: "Versão",
  materialIds: "Materiais",
  fileIds: "Arquivos",
  notifyEmail: "Avisar por e-mail",
  notifyApp: "Avisar na plataforma",
  message: "Mensagem",
  reason: "Motivo",
  amountCents: "Valor (centavos)",
  role: "Papel",
  email: "E-mail",
  report: "Relatório",
  filters: "Filtros",
  clientId: "Cliente",
  brandId: "Marca",
  projectId: "Projeto",
  // downloads
  scope: "Escopo",
  file: "Arquivo",
  files: "Arquivos",
  materials: "Materiais",
  package: "Pacote",
  fileId: "Código do arquivo",
  zipJobId: "Código do pacote",
  approval: "Conta como aprovação",
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function show(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (value === true) return "Sim";
  if (value === false) return "Não";
  if (typeof value === "string" && ISO_INSTANT.test(value)) return formatDateTime(value);
  if (Array.isArray(value)) {
    if (!value.length) return "—";
    if (value.every((v) => v === null || typeof v !== "object")) return value.map(show).join(", ");
    return JSON.stringify(value);
  }
  return String(value);
}

// Flattens nested data into [label, value] pairs ("filtros › cliente").
function flatten(data, prefix = [], out = []) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    out.push([prefix.join(" › ") || "Valor", show(data)]);
    return out;
  }
  const entries = Object.entries(data);
  if (!entries.length && prefix.length) out.push([prefix.join(" › "), "—"]);
  for (const [key, value] of entries) {
    const label = KEY_LABELS[key] ?? key;
    if (value && typeof value === "object" && !Array.isArray(value) && prefix.length < 3) flatten(value, [...prefix, label], out);
    else out.push([[...prefix, label].join(" › "), show(value)]);
  }
  return out;
}

export function DataDetails({ data, extra = [] }) {
  const pairs = [...extra, ...(data === null || data === undefined ? [] : flatten(data))];
  if (!pairs.length) return null;
  return (
    <dl className="ov-data">
      {pairs.map(([key, value], index) => (
        <div key={`${key}-${index}`} className="ov-data__row">
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------- full log entry

// One entry of the staff history: time, icon, sentence, who/where, link and
// an expandable panel with the recorded data.
export function ActivityEntry({ item, index = 0 }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const place = where(item);
  const hasData = item.data !== null && item.data !== undefined;
  return (
    <li className={cx("ov-entry", "ui-enter", open && "is-open")} style={{ "--i": Math.min(index, 8) }}>
      <time className="ov-entry__time" dateTime={item.createdAt} title={formatDateTime(item.createdAt)}>
        {formatTime(item.createdAt)}
      </time>
      <ActionIcon item={item} />
      <div className="ov-entry__body">
        <p className="ov-entry__summary">{personalSummary(item, user?.id)}</p>
        <div className="ov-entry__meta">
          <span className="ov-entry__actor">
            {item.actor ? <Avatar name={item.actor.name} size={20} decorative /> : null}
            <span>{actorName(item)}</span>
            {item.actor?.role && <span className="ov-entry__role">{roleLabel(item.actor.role)}</span>}
          </span>
          {place && <span className="ov-entry__where">{place}</span>}
          {item.visibility === "client" && (
            <Badge tone="teal" size="sm" dot>
              Visível ao cliente
            </Badge>
          )}
          {isDownload(item) && (
            <Badge tone="neutral" size="sm" className="ov-entry__note">
              {DOWNLOAD_NOTE}
            </Badge>
          )}
        </div>
        <div className="ov-entry__actions">
          {item.link && (
            <Link to={item.link} className="ov-chip">
              <span className="ui-truncate">{item.material?.title ?? item.linkLabel}</span>
              <ArrowUpRight size={14} strokeWidth={1.4} aria-hidden="true" />
              {item.material?.title && <span className="ui-sr-only">({item.linkLabel})</span>}
            </Link>
          )}
          <button type="button" className="ov-disclose" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
            <span>{open ? "Ocultar detalhes" : "Detalhes"}</span>
            <ChevronDown size={14} strokeWidth={1.4} aria-hidden="true" />
          </button>
        </div>
        <div id={panelId} className="ov-collapse" inert={!open} aria-hidden={!open}>
          <div className="ov-collapse__inner">
            <DataDetails
              data={hasData ? item.data : null}
              extra={[
                ["Quando", formatDateTime(item.createdAt)],
                ["Registro", [entityLabel(item.entityType), item.entityId].filter(Boolean).join(" · ")],
                ["Código da ação", item.action],
              ]}
            />
            {!hasData && <p className="ov-data__empty">Sem dados adicionais registrados.</p>}
          </div>
        </div>
      </div>
    </li>
  );
}

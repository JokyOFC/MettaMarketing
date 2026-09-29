import { useMemo, useState } from "react";
import { Check, CircleAlert, RotateCcw, Trash2, X } from "lucide-react";
import { FileGlyph, IconButton, Input, ProgressBar, Select, formatBytes, formatPercent } from "../../ui/index.js";
import { Handle, Live, MoveButtons } from "./parts.jsx";
import { useDragSort } from "./useDragSort.js";
import { isImageExt } from "./data.js";

const ROLE_OPTIONS = [
  { value: "original", label: "Original" },
  { value: "final", label: "Final" },
  { value: "editable", label: "Editável" },
  { value: "cover", label: "Capa" },
];

// Local preview of an image; a file that is not really an image (or is empty)
// falls back to the format glyph instead of a broken-image icon.
function QueueThumb({ item }) {
  const [broken, setBroken] = useState(false);
  if (item.preview && !broken) return <img src={item.preview} alt="" onError={() => setBroken(true)} />;
  return <FileGlyph kind={kindOf(item.ext)} format={item.ext.toUpperCase()} compact />;
}

const KIND_BY_EXT = {
  svg: "vector",
  eps: "vector",
  mp4: "video",
  mov: "video",
  webm: "video",
  m4v: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  pdf: "pdf",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  zip: "archive",
  pptx: "document",
  key: "document",
  docx: "document",
  xlsx: "document",
  txt: "document",
};
const kindOf = (ext) => KIND_BY_EXT[ext] ?? (isImageExt(ext) || ["tif", "tiff"].includes(ext) ? "image" : "design");

// Totals across the queue for the summary line and the overall bar.
export function queueStats(items) {
  const stats = { total: items.length, done: 0, uploading: 0, queued: 0, failed: 0, cancelled: 0, bytes: 0, sent: 0 };
  for (const item of items) {
    if (item.status === "done") stats.done += 1;
    else if (item.status === "uploading") stats.uploading += 1;
    else if (item.status === "queued") stats.queued += 1;
    else if (item.status === "error") stats.failed += 1;
    else if (item.status === "cancelled") stats.cancelled += 1;
    if (item.status !== "error" && item.status !== "cancelled") {
      stats.bytes += item.size;
      stats.sent += item.status === "done" ? item.size : Math.min(item.loaded ?? 0, item.size);
    }
  }
  return stats;
}

/**
 * Upload list with real progress per file, cancel/retry/remove, an optional
 * role per file and optional ordering (drag + keyboard) for grouped
 * materials (carousel slides).
 */
export function FileQueue({ queue, roles = null, sortable = false, titles = false, allowCover = true, label = "Arquivos enviados" }) {
  const { items } = queue;
  const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  const sort = useDragSort({
    ids: items.map((item) => item.key),
    disabled: !sortable,
    labelOf: (key) => byKey.get(key)?.name ?? "Arquivo",
    onReorder: (keys) => queue.setOrder(keys),
  });
  const ordered = sortable ? sort.order.map((key) => byKey.get(key)).filter(Boolean) : items;

  // Slide number among originals, in list order.
  const slideNumber = new Map();
  let n = 0;
  for (const item of ordered) if (item.role === "original" && item.status !== "error") slideNumber.set(item.key, (n += 1));
  const multi = sortable && n > 1;
  const stats = queueStats(items);

  if (!items.length) return null;
  return (
    <section className="lib-q" aria-label={label}>
      <div className="lib-q__summary">
        <p aria-live="polite">
          <strong>{stats.total === 1 ? "1 arquivo" : `${stats.total} arquivos`}</strong>
          {stats.done > 0 && <span> · {stats.done} enviado{stats.done === 1 ? "" : "s"}</span>}
          {stats.uploading + stats.queued > 0 && <span> · {stats.uploading + stats.queued} em envio</span>}
          {stats.failed > 0 && <span className="is-error"> · {stats.failed} com falha</span>}
        </p>
        {stats.bytes > 0 && stats.uploading + stats.queued > 0 && (
          <ProgressBar value={stats.sent / stats.bytes} size="sm" aria-label="Progresso total do envio" />
        )}
      </div>
      <ul className="lib-q__list">
        {ordered.map((item, index) => {
          const pct = item.total ? item.loaded / item.total : 0;
          const roleOptions = (roles ?? []).map((value) => ROLE_OPTIONS.find((o) => o.value === value)).filter(Boolean).map((option) =>
            option.value === "cover" && (!allowCover || !isImageExt(item.ext)) ? { ...option, disabled: true } : option,
          );
          return (
            <li key={item.key} className="lib-q__item ui-enter" data-status={item.status} style={{ "--i": Math.min(index, 8) }} {...(sortable ? sort.itemProps(item.key) : {})}>
              {sortable && <Handle {...sort.handleProps(item.key)} />}
              <div className="lib-q__thumb" aria-hidden="true">
                <QueueThumb item={item} />
                {multi && slideNumber.has(item.key) && <span className="lib-q__slide">{slideNumber.get(item.key)}</span>}
              </div>
              <div className="lib-q__main">
                <div className="lib-q__top">
                  <span className="lib-q__name" title={item.name}>
                    {item.name}
                  </span>
                  <span className="lib-q__size">{formatBytes(item.size)}</span>
                </div>
                {titles && item.status !== "error" && (
                  <Input
                    size="sm"
                    value={item.title}
                    maxLength={200}
                    aria-label={`Título do material para ${item.name}`}
                    placeholder="Título do material"
                    onValueChange={(title) => queue.update(item.key, { title })}
                    disabled={Boolean(item.saved)}
                  />
                )}
                <div className="lib-q__status">
                  {item.status === "uploading" && (
                    <>
                      <ProgressBar value={pct} size="sm" aria-label={`Enviando ${item.name}`} />
                      <span className="lib-q__pct">
                        {formatPercent(pct)} · {formatBytes(item.loaded)} de {formatBytes(item.total)}
                      </span>
                    </>
                  )}
                  {item.status === "queued" && <span className="lib-q__muted">Na fila</span>}
                  {item.status === "done" && (
                    <span className="lib-q__ok">
                      <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                      {item.saved ? "Salvo no material" : "Enviado"}
                    </span>
                  )}
                  {item.status === "cancelled" && <span className="lib-q__muted">Envio cancelado</span>}
                  {item.status === "error" && (
                    <span className="lib-q__err" role="alert">
                      <CircleAlert size={14} strokeWidth={1.6} aria-hidden="true" />
                      {item.error?.message}
                    </span>
                  )}
                </div>
              </div>
              <div className="lib-q__side">
                {roleOptions.length > 0 && item.status !== "error" && (
                  <Select
                    size="sm"
                    value={item.role}
                    options={roleOptions}
                    aria-label={`Tipo de arquivo de ${item.name}`}
                    disabled={Boolean(item.saved)}
                    onValueChange={(role) => queue.update(item.key, { role })}
                  />
                )}
                {sortable && (
                  <MoveButtons index={index} count={ordered.length} label={item.name} onMove={(delta) => sort.move(item.key, delta)} />
                )}
                {item.status === "uploading" && (
                  <IconButton size="sm" variant="ghost" icon={X} label={`Cancelar envio de ${item.name}`} onClick={() => queue.cancel(item.key)} />
                )}
                {(item.status === "cancelled" || (item.status === "error" && item.error?.retry !== false)) && (
                  <IconButton size="sm" variant="ghost" icon={RotateCcw} label={`Tentar enviar ${item.name} de novo`} onClick={() => queue.retry(item.key)} />
                )}
                {item.status !== "uploading" && !item.saved && (
                  <IconButton size="sm" variant="ghost" icon={Trash2} label={`Remover ${item.name}`} onClick={() => queue.remove(item.key)} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <Live text={sort.announcement} />
    </section>
  );
}

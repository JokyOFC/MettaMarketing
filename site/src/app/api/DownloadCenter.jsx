import { useId } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Download,
  FileArchive,
  RotateCcw,
  X,
} from "lucide-react";
import { formatBytes, formatDateTime } from "../ui/format.js";
import "./downloads.css";

const ICON = { size: 18, strokeWidth: 1.4, "aria-hidden": true };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const bytes = (value) => (Number.isFinite(value) ? formatBytes(value) : "");

function progressOf(job) {
  if (job.status === "ready") return 1;
  if (Number.isFinite(job.progress)) return Math.max(0, Math.min(1, job.progress));
  if (job.totalBytes > 0) return Math.min(1, (job.processedBytes || 0) / job.totalBytes);
  return 0;
}

function describe(job) {
  const files = job.fileCount ? plural(job.fileCount, "arquivo", "arquivos") : "";
  switch (job.status) {
    case "queued":
      return ["Na fila", files].filter(Boolean).join(" · ");
    case "running": {
      const done = job.totalBytes
        ? `${bytes(job.processedBytes || 0)} de ${bytes(job.totalBytes)}`
        : "Preparando";
      return [done, files].filter(Boolean).join(" · ");
    }
    case "ready":
      return [
        job.downloadedAt ? "Baixado" : "Pronto",
        bytes(job.sizeBytes),
        files,
      ]
        .filter(Boolean)
        .join(" · ");
    case "expired":
      // with a reason (content changed, file gone) the reason line explains it
      return job.error ? "Não está mais disponível." : "O ZIP expirou. Gere de novo para baixar.";
    default:
      return "Não foi possível gerar o ZIP.";
  }
}

function JobRow({ job, onDownload, onRetry, onDismiss }) {
  const active = job.status === "queued" || job.status === "running";
  const progress = progressOf(job);
  const percent = Math.round(progress * 100);
  const label = job.label || job.filename || "Pacote ZIP";
  return (
    <li className={`dl-job is-${job.status}`}>
      <span className="dl-job-icon" aria-hidden="true">
        {job.status === "failed" ? (
          <AlertCircle {...ICON} />
        ) : job.status === "ready" && job.downloadedAt ? (
          <Check {...ICON} />
        ) : (
          <FileArchive {...ICON} />
        )}
      </span>
      <div className="dl-job-body">
        <strong title={label}>{label}</strong>
        <span className="dl-job-meta">
          {describe(job)}
          {active && job.offline ? " · reconectando…" : ""}
        </span>
        {active && (
          <div
            className="dl-progress"
            role="progressbar"
            aria-label={`Progresso de ${label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${percent}%`}
          >
            <span style={{ transform: `scaleX(${progress})` }} />
          </div>
        )}
        {active && <span className="dl-job-percent">{percent}%</span>}
        {(job.status === "failed" || job.status === "expired") && job.error && (
          <span className="dl-job-error">{job.error}</span>
        )}
        {job.status === "ready" && job.expiresAt && (
          <span className="dl-job-hint">
            Disponível até {formatDateTime(job.expiresAt)}
          </span>
        )}
      </div>
      <div className="dl-job-actions">
        {job.status === "ready" && (
          <button
            type="button"
            className="dl-button primary"
            onClick={() => onDownload(job)}
            disabled={job.linking}
            aria-busy={job.linking || undefined}
          >
            <Download size={15} strokeWidth={1.4} aria-hidden="true" />
            Baixar
          </button>
        )}
        {(job.status === "failed" || job.status === "expired") && job.scope && (
          <button
            type="button"
            className="dl-button"
            onClick={() => onRetry(job)}
          >
            <RotateCcw size={15} strokeWidth={1.4} aria-hidden="true" />
            Tentar de novo
          </button>
        )}
        <button
          type="button"
          className="dl-icon"
          onClick={() => onDismiss(job.id)}
          aria-label={active ? `Ocultar ${label}` : `Remover ${label} da lista`}
        >
          <X size={16} strokeWidth={1.4} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

// Fixed tray with the user's ZIP jobs: bottom-left on desktop, bottom sheet on
// phones. Progress comes from the server (bytes written), never simulated.
// The provider renders a second instance inside an open modal dialog for the
// jobs started from it (outside the dialog the page is inert).
export default function DownloadTray({
  jobs,
  open,
  announcement,
  onToggle,
  onDownload,
  onRetry,
  onDismiss,
  onClear,
}) {
  const listId = useId();
  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  ).length;
  const finished = jobs.length - active;
  const ready = jobs.filter((job) => job.status === "ready").length;
  const summary = active
    ? `${plural(active, "ZIP", "ZIPs")} em preparo`
    : ready
      ? `${plural(ready, "ZIP pronto", "ZIPs prontos")}`
      : plural(jobs.length, "item", "itens");
  return (
    <>
      <span className="dl-sr" role="status" aria-live="polite">
        {announcement}
      </span>
      {jobs.length > 0 && (
        <section
          className={`dl-tray ${open ? "is-open" : ""}`}
          aria-label="Downloads"
        >
          <header className="dl-tray-head">
            <button
              type="button"
              className="dl-tray-toggle"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls={listId}
            >
              <FileArchive size={17} strokeWidth={1.4} aria-hidden="true" />
              <span className="dl-tray-title">Downloads</span>
              <span className="dl-tray-summary">{summary}</span>
              <ChevronDown
                className="dl-chevron"
                size={16}
                strokeWidth={1.4}
                aria-hidden="true"
              />
            </button>
            {open && finished > 0 && (
              <button type="button" className="dl-clear" onClick={onClear}>
                Limpar concluídos
              </button>
            )}
          </header>
          <div className="dl-tray-body" id={listId} inert={!open}>
            <ul className="dl-list">
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onDownload={onDownload}
                  onRetry={onRetry}
                  onDismiss={onDismiss}
                />
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}

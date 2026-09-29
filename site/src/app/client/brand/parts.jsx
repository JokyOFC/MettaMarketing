// Small building blocks shared by "Minha marca" and "Arquivos".
import { useState } from "react";
import { Download, Grid2x2, Lock, Maximize2, Moon, Sun } from "lucide-react";
import { useDownloads } from "../../api/downloads.js";
import {
  Button,
  Checker,
  FileMeta,
  MEDIA_ICONS,
  Skeleton,
  Spinner,
  formatBytes,
  formatDate,
} from "../../ui/index.js";
import { cx, downloadBlock, textBlocks, useZipJob } from "./lib.js";

const ICON = { strokeWidth: 1.4, "aria-hidden": true };

// ------------------------------------------------------------ text

export function RichText({ text, className }) {
  const blocks = textBlocks(text);
  if (!blocks.length) return null;
  return (
    <div className={cx("mb-prose", className)}>
      {blocks.map((block, i) =>
        block.type === "list" ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {line}
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

// Numbered editorial section heading: Cormorant index + light Raleway title.
export function SectionHead({ id, index, eyebrow, title, description, actions }) {
  return (
    <header className="mb-sec__head">
      <div className="mb-sec__titles">
        <p className="mb-sec__eyebrow">
          {index != null && <span className="mb-sec__index">{String(index).padStart(2, "0")}</span>}
          <span>{eyebrow}</span>
        </p>
        <h2 id={id} className="mb-sec__title" tabIndex={-1}>
          {title}
        </h2>
        {description && <p className="mb-sec__desc">{description}</p>}
      </div>
      {actions && <div className="mb-sec__actions">{actions}</div>}
    </header>
  );
}

// ------------------------------------------------------------ formats

// Format chips that screen readers read as one phrase ("Formatos: SVG, PNG,
// PDF"): the chips are the text, with a visually hidden prefix and commas.
// Formats beyond `max` collapse into "+N", whose full list is still read
// (and shown on hover). `as` picks the wrapper element.
export function FormatList({ formats = [], max = Infinity, prefix = "Formatos:", className = "mb-formats", as: Tag = "span" }) {
  if (!formats.length) return null;
  const shown = formats.slice(0, max);
  const rest = formats.slice(shown.length);
  return (
    <Tag className={className}>
      {prefix && <span className="ui-sr-only">{prefix} </span>}
      {shown.map((format, i) => (
        <span key={format} className="ui-format">
          {i > 0 && <span className="ui-sr-only">, </span>}
          {format}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="mb-formats__more" title={rest.join(", ")}>
          <span aria-hidden="true">+{rest.length}</span>
          <span className="ui-sr-only">, {rest.join(", ")}</span>
        </span>
      )}
    </Tag>
  );
}

// ------------------------------------------------------------ backgrounds

export const BG_OPTIONS = [
  { value: "light", label: "Claro", icon: Sun },
  { value: "dark", label: "Escuro", icon: Moon },
  { value: "checker", label: "Quadriculado", icon: Grid2x2 },
];

// Radiogroup (arrows, Home/End) with 44 px targets on touch screens.
export function BgSwitcher({ value, onChange, iconOnly = true, label = "Fundo da prévia", className }) {
  const pickAt = (event, index) => {
    const option = BG_OPTIONS[(index + BG_OPTIONS.length) % BG_OPTIONS.length];
    onChange(option.value);
    const group = event.currentTarget;
    requestAnimationFrame(() => group.querySelector(`[data-value="${option.value}"]`)?.focus());
  };
  const onKeyDown = (event) => {
    const index = BG_OPTIONS.findIndex((o) => o.value === value);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step) {
      event.preventDefault();
      pickAt(event, index + step);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      pickAt(event, event.key === "Home" ? 0 : BG_OPTIONS.length - 1);
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("mb-bgs", !iconOnly && "has-labels", className)}
      onKeyDown={onKeyDown}
    >
      {BG_OPTIONS.map(({ value: option, label: text, icon: Glyph }) => {
        const checked = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={iconOnly ? text : undefined}
            title={iconOnly ? text : undefined}
            tabIndex={checked ? 0 : -1}
            data-value={option}
            className={cx("mb-bgs__opt", `is-${option}`)}
            onClick={() => onChange(option)}
          >
            <Glyph size={15} {...ICON} />
            {!iconOnly && <span>{text}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Artwork on a light, dark or checkered ground; the grounds cross-fade (220 ms).
export function LogoStage({
  url,
  alt = "",
  bg = "light",
  format,
  mediaKind,
  onOpen,
  openLabel,
  className,
  size = "md",
}) {
  const [loaded, setLoaded] = useState({ url: null, ok: false, failed: false });
  const state = loaded.url === url ? loaded : { url, ok: false, failed: false };
  const Glyph = MEDIA_ICONS[mediaKind] || MEDIA_ICONS.other;
  const showImage = url && !state.failed;
  const inner = (
    <>
      <span className="mb-stage__layer mb-stage__layer--light" aria-hidden="true" />
      <span className="mb-stage__layer mb-stage__layer--dark" aria-hidden="true" />
      <Checker className="mb-stage__layer mb-stage__layer--checker" aria-hidden="true" />
      {showImage ? (
        <img
          className={cx("mb-stage__img", state.ok && "is-loaded")}
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          ref={(img) => {
            if (img?.complete && img.naturalWidth > 0 && !state.ok)
              setLoaded({ url, ok: true, failed: false });
          }}
          onLoad={() => setLoaded({ url, ok: true, failed: false })}
          onError={() => setLoaded({ url, ok: false, failed: true })}
        />
      ) : (
        <span className="mb-glyph" aria-hidden="true">
          <Glyph size={24} {...ICON} />
          {format && <span>{format}</span>}
        </span>
      )}
      {showImage && !state.ok && <span className="mb-stage__skel" aria-hidden="true" />}
      {onOpen && (
        <span className="mb-stage__zoom" aria-hidden="true">
          <Maximize2 size={15} {...ICON} />
        </span>
      )}
    </>
  );
  const classes = cx("mb-stage", `mb-stage--${size}`, `is-${bg}`, onOpen && "is-openable", className);
  if (onOpen)
    return (
      <button type="button" className={classes} onClick={onOpen} aria-label={openLabel}>
        {inner}
      </button>
    );
  return <div className={classes}>{inner}</div>;
}

// ------------------------------------------------------------ downloads

// Button that starts a ZIP and then shows the job's real progress
// ("Preparando ZIP… 40%") until the download begins. `start` returns the
// tray job (startZip's result). The label stays visible while it works, so
// the button is marked busy instead of using the kit's spinner-only state.
export function ZipButton({ start, icon, children, className, style, "aria-label": ariaLabel, ...props }) {
  const zip = useZipJob();
  const progress = zip.busy && zip.percent !== null ? zip.percent / 100 : null;
  return (
    <Button
      {...props}
      aria-label={ariaLabel && zip.busy ? `${ariaLabel}: ${zip.text}` : ariaLabel}
      icon={zip.busy ? <Spinner size={16} /> : icon}
      className={cx("mb-zipbtn", zip.busy && "is-working", className)}
      style={progress !== null ? { ...style, "--mb-zip": progress } : style}
      aria-busy={zip.busy || undefined}
      aria-disabled={zip.busy || undefined}
      onClick={zip.busy ? undefined : () => zip.run(start)}
    >
      {zip.busy ? <span className="mb-zipbtn__text">{zip.text}</span> : children}
    </Button>
  );
}

function chipLabels(files) {
  const counts = files.reduce((acc, f) => ({ ...acc, [f.format]: (acc[f.format] || 0) + 1 }), {});
  return (file) => {
    const base = file.format || (file.ext || "").toUpperCase() || "Arquivo";
    if (counts[file.format] > 1 && file.width) return `${base} ${file.width} px`;
    return base;
  };
}

// One download chip per file that really exists: format + size.
export function FileChips({ files, material, loading, formats = [], editable = [], className, layout = "pills" }) {
  const { downloadFile, isDownloading } = useDownloads();
  const rows = layout === "rows";
  if (loading)
    return (
      <div className={cx("mb-chips", rows && "mb-chips--rows", className)} aria-busy="true">
        {(formats.length ? formats : ["", ""]).map((f, i) => (
          <Skeleton key={`${f}${i}`} width={rows ? "100%" : 86} height={rows ? 30 : 34} radius={rows ? 3 : 999} />
        ))}
      </div>
    );
  const all = [...(files || []), ...(editable || [])];
  if (!all.length) return null;
  const labelOf = chipLabels(all);
  const blocked = all.every((f) => !f.downloadable) ? downloadBlock(all[0], material) : null;
  return (
    <div className={cx("mb-chips", rows && "mb-chips--rows", className)}>
      <ul className="mb-chips__list" aria-label="Formatos disponíveis">
        {all.map((file) => {
          const busy = isDownloading(file.id);
          const isEditable = file.role === "editable";
          const reason = downloadBlock(file, material);
          return (
            <li key={file.id}>
              <button
                type="button"
                className={cx("mb-chip", isEditable && "is-editable", busy && "is-busy")}
                disabled={!file.downloadable || busy}
                aria-label={`Baixar ${file.name} (${labelOf(file)}, ${formatBytes(file.sizeBytes)})${isEditable ? ", editável" : ""}`}
                title={reason || file.name}
                onClick={() => downloadFile(file.id, { name: file.name })}
              >
                <span className="mb-chip__icon">
                  {busy ? <Spinner size={13} /> : file.downloadable ? <Download size={14} {...ICON} /> : <Lock size={13} {...ICON} />}
                </span>
                <span className="mb-chip__fmt">{labelOf(file)}</span>
                {isEditable && <span className="mb-chip__tag">Editável</span>}
                <span className="mb-chip__size">{formatBytes(file.sizeBytes)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {blocked && (
        <p className="mb-chips__note">
          <Lock size={13} {...ICON} />
          <span>{blocked}</span>
        </p>
      )}
    </div>
  );
}

// A file line: name · format · size · version · date + its own download.
export function FileRow({ file, material, version, showVersion = true, index }) {
  const { downloadFile, isDownloading } = useDownloads();
  const busy = isDownloading(file.id);
  const reason = downloadBlock(file, material);
  const Glyph = MEDIA_ICONS[file.mediaKind] || MEDIA_ICONS.other;
  return (
    <li className="mb-filerow ui-enter" style={index != null ? { "--i": Math.min(index, 8) } : undefined}>
      <span className="mb-filerow__icon" aria-hidden="true">
        {file.previews?.thumb ? (
          <img src={file.previews.thumb} alt="" loading="lazy" decoding="async" />
        ) : (
          <Glyph size={18} {...ICON} />
        )}
      </span>
      <div className="mb-filerow__meta">
        <FileMeta
          file={file}
          version={showVersion ? version : undefined}
          date={file.createdAt}
          dimensions
        />
        {reason && (
          <p className="mb-filerow__note">
            <Lock size={12} {...ICON} />
            <span>{reason}</span>
          </p>
        )}
      </div>
      <button
        type="button"
        className="mb-dlbtn"
        disabled={!file.downloadable || busy}
        onClick={() => downloadFile(file.id, { name: file.name })}
        aria-label={`Baixar ${file.name}`}
      >
        {busy ? <Spinner size={14} /> : file.downloadable ? <Download size={16} {...ICON} /> : <Lock size={15} {...ICON} />}
        <span className="mb-dlbtn__text">Baixar</span>
      </button>
    </li>
  );
}

export function FileList({ files, material, version, className, label }) {
  if (!files?.length) return null;
  return (
    <ul className={cx("mb-filelist", className)} aria-label={label}>
      {files.map((file, i) => (
        <FileRow key={file.id} file={file} material={material} version={version} index={i} />
      ))}
    </ul>
  );
}

// "v2 · 12 out. 2026" for a material summary.
export function versionLine(material) {
  return [
    material?.version?.number ? `v${material.version.number}` : null,
    formatDate(material?.version?.releasedAt || material?.releasedAt),
  ]
    .filter(Boolean)
    .join(" · ");
}

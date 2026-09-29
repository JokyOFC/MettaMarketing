import { useCallback, useId, useRef, useState } from "react";
import { CloudUpload, Play } from "lucide-react";
import { MEDIA_ICONS } from "./Icon.jsx";
import { fileFormat, formatBytes, formatDate, formatDuration } from "./format.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- Checker

// Checkerboard for transparent artwork (logos, PNG, SVG).
export function Checker({ as: Tag = "div", size = 14, className, style, children, ...rest }) {
  return (
    <Tag
      className={cx("ui-checker", className)}
      style={{ "--checker-size": `${size}px`, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

// ---------------------------------------------------------------- Thumb

function parseAspect(aspect, width, height) {
  if (typeof aspect === "number" && aspect > 0) return aspect;
  if (typeof aspect === "string" && aspect !== "auto") {
    const [w, h] = aspect.split(/[/:x]/).map(Number);
    if (w > 0 && h > 0) return w / h;
  }
  if (width > 0 && height > 0) return Math.min(2.4, Math.max(0.56, width / height));
  return 1;
}

function pickUrl({ src, file, thumb, rendition, kind }) {
  if (src) return src;
  if (file?.previews) {
    const p = file.previews;
    if (kind === "video")
      return rendition === "preview"
        ? p.preview || p.poster || p.thumb
        : p.thumb || p.poster || p.preview;
    return rendition === "preview" ? p.preview || p.thumb : p.thumb || p.preview;
  }
  return thumb?.url || null;
}

// Tasteful card for files without a preview: icon per media kind + format.
export function FileGlyph({ kind = "other", format, name, status, compact = false }) {
  const Glyph = MEDIA_ICONS[kind] || MEDIA_ICONS.other;
  return (
    <span className={cx("ui-fileglyph", compact && "ui-fileglyph--compact")}>
      <span className="ui-fileglyph__icon" aria-hidden="true">
        <Glyph size={compact ? 18 : 22} strokeWidth={1.3} />
      </span>
      {format && <span className="ui-fileglyph__format">{format}</span>}
      {!compact && name && <span className="ui-fileglyph__name">{name}</span>}
      {!compact && status === "pending" && (
        <span className="ui-fileglyph__note">Gerando prévia…</span>
      )}
    </span>
  );
}

// Preview box with the real proportion. bg: light | dark | checker | auto.
// fit: contain (logos, vectors — padded) | cover (posts). Shows a skeleton
// until the image loads and a file card when there is no preview.
export function Thumb({
  file,
  thumb,
  src,
  rendition = "thumb",
  aspect,
  bg = "auto",
  fit,
  alt = "",
  mediaKind,
  format,
  name,
  badge,
  showPlay = true,
  className,
  style,
  children,
  rounded = true,
}) {
  const kind = mediaKind || file?.mediaKind || thumb?.mediaKind || "other";
  const url = pickUrl({ src, file, thumb, rendition, kind });
  const width = file?.width ?? thumb?.width;
  const height = file?.height ?? thumb?.height;
  const ratio = parseAspect(aspect, width, height);
  const resolvedFit = fit || (kind === "vector" || bg !== "auto" ? "contain" : "cover");
  const [state, setState] = useState({ url, status: "loading" });
  const status = state.url === url ? state.status : "loading";
  if (state.url !== url) setState({ url, status: "loading" });

  const imgRef = useCallback(
    (img) => {
      if (img && img.complete && img.naturalWidth > 0) setState({ url, status: "loaded" });
    },
    [url],
  );
  const fmt = format || file?.format || fileFormat(file?.name || name);
  const showImage = url && status !== "error";
  const duration = file?.durationMs;

  return (
    <div
      className={cx(
        "ui-thumb",
        `ui-thumb--${bg}`,
        `ui-thumb--${resolvedFit}`,
        `is-${showImage ? status : "empty"}`,
        rounded && "ui-thumb--rounded",
        className,
      )}
      style={{ aspectRatio: ratio, ...style }}
      data-kind={kind}
    >
      {showImage && (
        <img
          ref={imgRef}
          className="ui-thumb__img"
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState({ url, status: "loaded" })}
          onError={() => setState({ url, status: "error" })}
        />
      )}
      {showImage && status === "loading" && <span className="ui-thumb__skel" aria-hidden="true" />}
      {!showImage && (
        <FileGlyph
          kind={kind}
          format={fmt}
          name={alt ? undefined : name || file?.name}
          status={file?.previewStatus}
          compact={ratio > 1.8}
        />
      )}
      {kind === "video" && showPlay && (
        <span className="ui-thumb__play" aria-hidden="true">
          <Play size={16} strokeWidth={1.4} />
          {duration ? <span>{formatDuration(duration)}</span> : null}
        </span>
      )}
      {badge && <span className="ui-thumb__badge">{badge}</span>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- FileMeta

// name · FORMAT · 1,2 MB · v2 · 12 out. 2026
export function FileMeta({
  file,
  name,
  format,
  sizeBytes,
  version,
  date,
  dimensions = false,
  extra,
  showName = true,
  layout = "stack",
  className,
}) {
  const n = name ?? file?.name;
  const fmt = format ?? file?.format ?? fileFormat(n);
  const size = sizeBytes ?? file?.sizeBytes;
  const when = date ?? file?.createdAt;
  const dims =
    dimensions && file?.width && file?.height ? `${file.width} × ${file.height} px` : null;
  const facts = [
    fmt && <span className="ui-format">{fmt}</span>,
    size != null && formatBytes(size),
    dims,
    file?.durationMs ? formatDuration(file.durationMs) : null,
    version != null && version !== "" && `v${version}`,
    when && <time dateTime={typeof when === "string" ? when : undefined}>{formatDate(when)}</time>,
    extra,
  ].filter(Boolean);
  return (
    <div className={cx("ui-filemeta", `ui-filemeta--${layout}`, className)}>
      {showName && n && (
        <span className="ui-filemeta__name" title={n}>
          {n}
        </span>
      )}
      {/* Separators sit in the gap before each fact; the wrapper clips the one
          that starts a wrapped line, so no line begins with a dot. */}
      <span className="ui-filemeta__facts">
        <span className="ui-filemeta__row">
          {facts.map((fact, i) => (
            <span key={i} className="ui-filemeta__fact">
              {fact}
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- Dropzone

function matchesAccept(file, accept) {
  if (!accept) return true;
  const rules = accept
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

// Drag-and-drop area plus a real button that opens the file picker, so it
// works by keyboard and touch. onFiles(File[]); onReject([{file, reason}]).
export function Dropzone({
  onFiles,
  onReject,
  accept,
  multiple = true,
  disabled = false,
  maxSizeBytes,
  title = "Arraste arquivos para cá",
  description,
  buttonLabel = "Escolher arquivos",
  icon,
  compact = false,
  className,
  children,
}) {
  const inputRef = useRef(null);
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const hintId = useId();

  const take = (list) => {
    const files = Array.from(list || []);
    if (!files.length) return;
    const picked = multiple ? files : files.slice(0, 1);
    const accepted = [];
    const rejected = [];
    for (const file of picked) {
      if (!matchesAccept(file, accept)) rejected.push({ file, reason: "Formato não permitido." });
      else if (maxSizeBytes && file.size > maxSizeBytes)
        rejected.push({ file, reason: `Acima do limite de ${formatBytes(maxSizeBytes)}.` });
      else accepted.push(file);
    }
    if (rejected.length) onReject?.(rejected);
    if (accepted.length) onFiles?.(accepted);
  };

  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");

  return (
    <div
      className={cx(
        "ui-drop",
        over && "is-over",
        disabled && "is-disabled",
        compact && "ui-drop--compact",
        className,
      )}
      onDragEnter={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      }}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        take(event.dataTransfer.files);
      }}
    >
      <span className="ui-drop__icon" aria-hidden="true">
        {icon || <CloudUpload size={compact ? 20 : 26} strokeWidth={1.3} />}
      </span>
      <div className="ui-drop__text">
        <p className="ui-drop__title">{over ? "Solte para adicionar" : title}</p>
        {description && (
          <p id={hintId} className="ui-drop__desc">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        className="ui-btn ui-btn--secondary ui-btn--md"
        disabled={disabled}
        aria-describedby={description ? hintId : undefined}
        onClick={() => inputRef.current?.click()}
      >
        <span className="ui-btn__label">
          <span className="ui-btn__text">{buttonLabel}</span>
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        hidden
        tabIndex={-1}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          take(event.target.files);
          event.target.value = "";
        }}
      />
      {children}
    </div>
  );
}

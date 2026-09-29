// Small presentational pieces shared by the library pages (prefix lib-).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, GripVertical, X } from "lucide-react";
import { Badge, BULK_SHORTCUT, IconButton, StatusBadge, Thumb, registerBulkBar } from "../../ui/index.js";
import { usePresence } from "../../ui/layer.js";
import { artBackground } from "./data.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");

// Visibility and approval are separate axes: always two badges, never merged.
export function MaterialBadges({ material, size = "sm", delivered = true, pending = true, className }) {
  if (!material) return null;
  const approval = material.requiresApproval && material.approvalStatus && material.approvalStatus !== "none";
  const nextDraft =
    pending &&
    material.visibility === "released" &&
    material.currentVersionId &&
    material.releasedVersionId &&
    material.currentVersionId !== material.releasedVersionId;
  return (
    <span className={cx("lib-badges", className)}>
      {material.archivedAt ? (
        <StatusBadge kind="archived" value size={size} />
      ) : (
        <StatusBadge kind="visibility" value={material.visibility} size={size} />
      )}
      {approval && <StatusBadge kind="approval" value={material.approvalStatus} size={size} />}
      {delivered && material.deliveredAt && <StatusBadge kind="delivered" value size={size} />}
      {nextDraft && (
        <Badge tone="slate" size={size} title="Há uma versão mais nova ainda não liberada">
          v{material.version?.number} em preparo
        </Badge>
      )}
    </span>
  );
}

export function VersionTag({ number, className }) {
  if (!number) return null;
  return (
    <span className={cx("lib-vtag", className)} title={`Versão ${number}`}>
      v{number}
    </span>
  );
}

// The chip text is what assistive tech reads ("Formatos: SVG, PNG"); when the
// list is collapsed into "+N" the hidden part is still spoken in full.
export function Formats({ formats = [], max = 4, className }) {
  if (!formats.length) return null;
  const shown = formats.slice(0, max);
  const hidden = formats.slice(shown.length);
  return (
    <span className={cx("lib-formats", className)}>
      <span className="ui-sr-only">{formats.length === 1 ? "Formato:" : "Formatos:"} </span>
      {shown.map((format, index) => (
        <span key={format} className="ui-format">
          {format}
          {index < formats.length - 1 && <span className="ui-sr-only">, </span>}
        </span>
      ))}
      {hidden.length > 0 && (
        <span className="lib-formats__more" title={hidden.join(", ")}>
          <span aria-hidden="true">+{hidden.length}</span>
          <span className="ui-sr-only">{hidden.join(", ")}</span>
        </span>
      )}
    </span>
  );
}

// Artwork presented on a uniform stage without cropping it: logos sit on
// their preview background; posts, photos and videos keep their real
// proportion centred on a quiet surface.
export function Art({ material, file, thumb, stage = 4 / 3, rendition = "thumb", bg, alt = "", badge, className, children }) {
  const source = file ? null : thumb ?? material?.thumb ?? null;
  const background = bg ?? artBackground(material);
  const width = file?.width ?? source?.width;
  const height = file?.height ?? source?.height;
  const ratio = width > 0 && height > 0 ? width / height : null;

  if (background !== "auto" || !ratio) {
    return (
      <Thumb
        file={file}
        thumb={source}
        rendition={rendition}
        aspect={stage}
        bg={background}
        fit={background !== "auto" ? "contain" : undefined}
        alt={alt}
        className={cx("lib-art lib-art--flat", className)}
        badge={badge}
      >
        {children}
      </Thumb>
    );
  }
  // Content box of the stage (7% padding on every side).
  const inner = 0.86 / (1 / stage - 0.14);
  const wide = ratio >= inner;
  return (
    <div className={cx("lib-art lib-art--stage", className)} style={{ aspectRatio: stage }}>
      <Thumb
        file={file}
        thumb={source}
        rendition={rendition}
        aspect={ratio}
        alt={alt}
        className="lib-art__piece"
        style={wide ? { width: "100%", height: "auto" } : { width: "auto", height: "100%" }}
      />
      {badge && <span className="lib-art__badge">{badge}</span>}
      {children}
    </div>
  );
}

// Drawn check for confirmations (ring, then tick; ≤ 300 ms each).
export function CheckDraw({ size = 56, className }) {
  return (
    <svg className={cx("lib-checkdraw", className)} viewBox="0 0 52 52" width={size} height={size} aria-hidden="true">
      <circle className="lib-checkdraw__ring" cx="26" cy="26" r="24" pathLength="1" />
      <path className="lib-checkdraw__tick" d="M15.5 27l7 7 14.5-15.5" pathLength="1" />
    </svg>
  );
}

// "Move earlier / later" buttons — the keyboard and touch path for sorting.
// The ends use aria-disabled (not `disabled`): a button that disables itself
// while focused would drop the focus to <body> after the last move.
export function MoveButtons({ index, count, onMove, label = "item", axis = "y", className }) {
  const Prev = axis === "x" ? ChevronLeft : ChevronUp;
  const Next = axis === "x" ? ChevronRight : ChevronDown;
  const atStart = index <= 0;
  const atEnd = index >= count - 1;
  return (
    <span className={cx("lib-move", className)}>
      <IconButton
        size="sm"
        variant="ghost"
        icon={Prev}
        label={`Mover ${label} para antes`}
        tooltip={false}
        aria-disabled={atStart || undefined}
        onClick={() => !atStart && onMove(-1)}
      />
      <IconButton
        size="sm"
        variant="ghost"
        icon={Next}
        label={`Mover ${label} para depois`}
        tooltip={false}
        aria-disabled={atEnd || undefined}
        onClick={() => !atEnd && onMove(1)}
      />
    </span>
  );
}

export function Handle(props) {
  return (
    <button {...props}>
      <GripVertical size={16} strokeWidth={1.4} aria-hidden="true" />
    </button>
  );
}

export function Live({ text }) {
  return (
    <span className="ui-sr-only" role="status" aria-live="polite">
      {text}
    </span>
  );
}

// Section heading used inside pages: small caps eyebrow + light title.
export function SectionHead({ eyebrow, title, accent, count, actions, id, className }) {
  return (
    <div className={cx("lib-sechead", className)}>
      <div className="lib-sechead__titles">
        {eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}
        <h2 id={id} className="lib-sechead__title">
          {title}
          {accent && (
            <>
              {" "}
              <em>{accent}</em>
            </>
          )}
          {count !== undefined && count !== null && <span className="lib-sechead__count">{count}</span>}
        </h2>
      </div>
      {actions && <div className="lib-sechead__actions">{actions}</div>}
    </div>
  );
}

// Floating batch bar centred on the content column. Same look as the kit's
// BulkBar (reuses its inner classes) but sized to its content, so a full set
// of library actions stays on one line on desktop. It is rendered in the page
// (right after the filters), not portalled to the end of <body>, so it sits
// close to the selection in the tab order; `position: fixed` keeps the look.
// Esc inside the bar calls onEscape (the page returns focus to the item).
export function LibBulkBar({
  count = 0,
  onClear,
  onEscape,
  children,
  note,
  noun = ["selecionado", "selecionados"],
  label = "Ações em lote",
  ref,
}) {
  const presence = usePresence(count > 0, 220);
  const [shown, setShown] = useState(count);
  const [offset, setOffset] = useState(0);
  const anchor = useRef(null);
  const bar = useRef(null);
  const setBar = (el) => {
    bar.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
  // Same registration as the kit's BulkBar: Alt+Shift+L reaches it and
  // toasts/the downloads tray stay above it (--ui-bulkbar-h).
  const mounted = presence !== "closed";
  useLayoutEffect(() => (mounted ? registerBulkBar(bar.current) : undefined), [mounted]);
  useEffect(() => {
    if (count > 0) setShown(count);
  }, [count]);
  useLayoutEffect(() => {
    if (presence === "closed" || !anchor.current) return undefined;
    const read = () => {
      const style = getComputedStyle(anchor.current);
      setOffset(parseFloat(style.getPropertyValue("--app-inset-left") || style.getPropertyValue("--sh-sidebar-w")) || 0);
    };
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [presence]);
  return (
    <>
      <span ref={anchor} hidden />
      {presence !== "closed" && (
        <div
          ref={setBar}
          className="lib-bulkbar"
          role="region"
          aria-label={label}
          aria-keyshortcuts={BULK_SHORTCUT}
          data-state={presence}
          style={{ "--lib-bulk-offset": `${offset}px` }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented || !onEscape) return;
            event.preventDefault();
            onEscape();
          }}
        >
          <span className="ui-bulkbar__count" aria-live="polite">
            <strong>{shown}</strong> {shown === 1 ? noun[0] : noun[1]}
            {note && <small className="lib-bulkbar__note">{note}</small>}
          </span>
          <div className="ui-bulkbar__actions">{children}</div>
          {onClear && (
            <button type="button" className="ui-bulkbar__clear" onClick={onClear}>
              <X size={16} strokeWidth={1.4} aria-hidden="true" />
              <span>Limpar seleção</span>
            </button>
          )}
        </div>
      )}
    </>
  );
}

// Skip link shown after the most recently selected item: Enter moves the
// focus straight to the batch bar instead of tabbing through the whole list.
export function BulkJump({ count, onJump, className }) {
  if (!count) return null;
  return (
    <button type="button" className={cx("lib-bulkjump", className)} onClick={onJump}>
      Ações em lote ({count})
    </button>
  );
}

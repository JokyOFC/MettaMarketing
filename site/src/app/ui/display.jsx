import {
  Check,
  Copy,
  RotateCcw,
  SearchX,
  ShieldAlert,
  WifiOff,
  CircleAlert,
  Inbox,
} from "lucide-react";
import { renderIcon } from "./Icon.jsx";
import { statusInfo } from "./status.js";
import { initials } from "./format.js";
import { COPY_FAILED_MESSAGE, useCopy } from "./hooks.js";
import { useToast } from "./toast.jsx";

const cx = (...parts) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- Badge

// Discreet pill. tone: neutral | slate | olive | amber | clay | teal | red | dark.
export function Badge({
  tone = "neutral",
  dot = false,
  icon,
  size = "md",
  className,
  children,
  ...rest
}) {
  return (
    <span className={cx("ui-badge", `ui-tone--${tone}`, `ui-badge--${size}`, className)} {...rest}>
      {dot && <span className="ui-badge__dot" aria-hidden="true" />}
      {renderIcon(icon, { size: 13 })}
      <span className="ui-badge__text">{children}</span>
    </span>
  );
}

// Label and tone from status.js; the dot is decoration, the text carries meaning.
export function StatusBadge({ kind, value, label, size = "md", className, title }) {
  if (value === undefined || value === null || value === "") return null;
  const info = statusInfo(kind, value);
  return (
    <Badge
      tone={info?.tone || "neutral"}
      dot
      size={size}
      className={cx("ui-status", className)}
      title={title}
      data-kind={kind}
      data-value={String(value)}
    >
      {label || info?.label || String(value)}
    </Badge>
  );
}

export function Kbd({ children, className, ...rest }) {
  return (
    <kbd className={cx("ui-kbd", className)} {...rest}>
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------- Avatar

const AVATAR_TONES = ["olive", "sage", "clay", "teal", "stone"];
const hash = (text) =>
  [...String(text || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function Avatar({ name, src, size = 32, className, title, decorative = false }) {
  const tone = AVATAR_TONES[hash(name) % AVATAR_TONES.length];
  const a11y = decorative
    ? { "aria-hidden": true }
    : { role: "img", "aria-label": name || "Usuário" };
  return (
    <span
      className={cx("ui-avatar", `ui-avatar--${tone}`, className)}
      style={{ "--avatar-size": `${size}px` }}
      title={title}
      {...a11y}
    >
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------- Progress

// Real progress (value 0..1). Omit value only when the size is genuinely unknown.
export function ProgressBar({
  value,
  label,
  showValue = false,
  size = "md",
  tone = "olive",
  className,
  "aria-label": ariaLabel,
}) {
  const known = typeof value === "number" && Number.isFinite(value);
  const ratio = known ? Math.min(1, Math.max(0, value)) : 0;
  const percent = Math.round(ratio * 100);
  return (
    <div className={cx("ui-progress", `ui-progress--${size}`, `ui-progress--${tone}`, className)}>
      {(label || showValue) && (
        <div className="ui-progress__top">
          {label && <span className="ui-progress__label">{label}</span>}
          {showValue && known && <span className="ui-progress__value">{percent}%</span>}
        </div>
      )}
      <div
        className={cx("ui-progress__track", !known && "is-indeterminate")}
        role="progressbar"
        aria-label={ariaLabel || (typeof label === "string" ? label : "Progresso")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? percent : undefined}
        aria-valuetext={known ? `${percent}%` : "Em andamento"}
      >
        <span
          className="ui-progress__fill"
          style={known ? { transform: `scaleX(${ratio})` } : undefined}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Skeletons

export function Skeleton({ width, height = 14, radius, circle = false, className, style }) {
  return (
    <span
      className={cx("ui-skel", circle && "ui-skel--circle", className)}
      style={{
        width: width ?? (circle ? height : "100%"),
        height,
        borderRadius: radius,
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

const Loading = ({ label = "Carregando" }) => (
  <span className="ui-sr-only" role="status">
    {label}
  </span>
);

// Placeholder rows for tables and lists.
export function SkeletonRows({ rows = 5, columns = 4, media = false, className, label }) {
  return (
    <div className={cx("ui-skel-rows", className)}>
      <Loading label={label} />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="ui-skel-row" aria-hidden="true" style={{ "--i": r }}>
          {media && <Skeleton width={40} height={40} radius={4} />}
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} height={12} width={c === 0 ? "38%" : `${14 + ((r + c) % 3) * 6}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// Placeholder cards (thumbnail + two lines) in the same grid the real cards use.
export function SkeletonCards({
  count = 6,
  aspect = 4 / 3,
  minWidth = 220,
  lines = 2,
  className,
  label,
}) {
  return (
    <div className={cx("ui-skel-cards", className)} style={{ "--min": `${minWidth}px` }}>
      <Loading label={label} />
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ui-skel-card" aria-hidden="true">
          <span className="ui-skel ui-skel--block" style={{ aspectRatio: aspect }} />
          {Array.from({ length: lines }, (_, l) => (
            <Skeleton key={l} height={l === 0 ? 14 : 11} width={l === 0 ? "70%" : "45%"} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Empty / Error

export function EmptyState({
  icon = Inbox,
  title,
  description,
  action,
  children,
  compact = false,
  className,
  headingLevel = 3,
}) {
  const Heading = `h${headingLevel}`;
  return (
    <div className={cx("ui-empty", compact && "ui-empty--compact", className)}>
      <span className="ui-empty__icon" aria-hidden="true">
        {renderIcon(icon, { size: compact ? 18 : 22 })}
      </span>
      {title && <Heading className="ui-empty__title">{title}</Heading>}
      {description && <p className="ui-empty__text">{description}</p>}
      {children}
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}

function explain(error) {
  const status = error?.status;
  const code = error?.code;
  if (code === "network" || status === 0)
    return { icon: WifiOff, title: "Sem conexão com o servidor" };
  if (status === 404 || code === "not_found")
    return { icon: SearchX, title: "Não encontramos este item" };
  if (status === 403 || code === "forbidden")
    return { icon: ShieldAlert, title: "Acesso não permitido" };
  if (status === 401) return { icon: ShieldAlert, title: "Sua sessão terminou" };
  return { icon: CircleAlert, title: "Não foi possível carregar" };
}

// Plain explanation + the server message + retry.
export function ErrorState({
  error,
  title,
  onRetry,
  retryLabel = "Tentar de novo",
  compact = false,
  className,
  action,
}) {
  const info = explain(error);
  const heading = title || info.title;
  let message =
    (typeof error === "string" ? error : error?.message) ||
    "Algo não saiu como esperado. Tente de novo em instantes.";
  // Server messages often open with the same sentence as the heading.
  if (message.toLowerCase().startsWith(heading.toLowerCase()))
    message = message.slice(heading.length).replace(/^[\s.,:;–—-]+/, "");
  return (
    <div
      className={cx("ui-empty ui-error", compact && "ui-empty--compact", className)}
      role="alert"
    >
      <span className="ui-empty__icon" aria-hidden="true">
        {renderIcon(info.icon, { size: compact ? 18 : 22 })}
      </span>
      <h3 className="ui-empty__title">{heading}</h3>
      {message && <p className="ui-empty__text">{message}</p>}
      {(onRetry || action) && (
        <div className="ui-empty__action">
          {onRetry && error?.status !== 404 && error?.status !== 403 && (
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={onRetry}>
              <span className="ui-btn__label">
                <RotateCcw size={16} strokeWidth={1.4} aria-hidden="true" />
                <span className="ui-btn__text">{retryLabel}</span>
              </span>
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Copy

// Copies `text`; the label swaps to "Copiado" with a check for 1.6 s and the
// change is announced to screen readers. When the browser refuses the
// clipboard, an error toast says so (and how to copy by hand).
export function CopyButton({
  text,
  label = "Copiar",
  copiedLabel = "Copiado",
  failedMessage = COPY_FAILED_MESSAGE,
  variant = "ghost",
  size = "sm",
  iconOnly = false,
  className,
  onCopied,
  onFailed,
  children,
}) {
  const { copy, copied } = useCopy();
  const toast = useToast();
  const onClick = async () => {
    const ok = await copy(typeof text === "function" ? text() : text);
    if (ok) onCopied?.();
    else {
      toast.error(failedMessage);
      onFailed?.();
    }
  };
  const glyph = copied ? (
    <Check size={16} strokeWidth={1.6} aria-hidden="true" className="ui-copy__check" />
  ) : (
    <Copy size={16} strokeWidth={1.4} aria-hidden="true" />
  );
  return (
    <>
      <button
        type="button"
        className={cx(
          iconOnly
            ? `ui-iconbtn ui-iconbtn--${variant === "ghost" ? "ghost" : "outline"} ui-iconbtn--${size}`
            : `ui-btn ui-btn--${variant} ui-btn--${size}`,
          "ui-copy",
          copied && "is-copied",
          className,
        )}
        aria-label={iconOnly ? (copied ? copiedLabel : label) : undefined}
        onClick={onClick}
      >
        {iconOnly ? (
          glyph
        ) : (
          <span className="ui-btn__label">
            {glyph}
            <span className="ui-btn__text">{copied ? copiedLabel : children || label}</span>
          </span>
        )}
      </button>
      <span className="ui-sr-only" role="status" aria-live="polite">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}

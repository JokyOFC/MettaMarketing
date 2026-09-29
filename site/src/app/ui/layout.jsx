import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, ChevronRight, SlidersHorizontal } from "lucide-react";
import { renderIcon } from "./Icon.jsx";
import { Skeleton } from "./display.jsx";

const cx = (...parts) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- Card

// Surface with a hairline. Interactive when it has `to`, `href` or `onClick`:
// lifts 1px, darkens the border and shows a focus ring. `index` staggers the
// entry animation (max 8 steps x 40ms).
export function Card({
  as,
  to,
  href,
  onClick,
  padding = "md",
  index,
  animate = index !== undefined,
  selected = false,
  tone,
  className,
  children,
  style,
  ref,
  ...rest
}) {
  const interactive = Boolean(to || href || onClick);
  const classes = cx(
    "ui-card",
    `ui-card--pad-${padding}`,
    interactive && "is-interactive",
    selected && "is-selected",
    animate && "ui-enter",
    tone && `ui-card--${tone}`,
    className,
  );
  const s = index !== undefined ? { "--i": Math.min(index, 8), ...style } : style;
  if (to)
    return (
      <Link ref={ref} to={to} className={classes} style={s} onClick={onClick} {...rest}>
        {children}
      </Link>
    );
  if (href)
    return (
      <a ref={ref} href={href} className={classes} style={s} onClick={onClick} {...rest}>
        {children}
      </a>
    );
  const Tag = as || "div";
  const keyboard =
    onClick && !as
      ? {
          role: "button",
          tabIndex: 0,
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onClick(event);
            }
          },
        }
      : {};
  return (
    <Tag ref={ref} className={classes} style={s} onClick={onClick} {...keyboard} {...rest}>
      {children}
    </Tag>
  );
}

// ---------------------------------------------------------------- Panel

// Titled section: eyebrow, light Raleway title, description, actions, body.
export function Panel({
  title,
  eyebrow,
  description,
  actions,
  children,
  footer,
  padding = "md",
  headingLevel = 2,
  as: Tag = "section",
  className,
  bodyClassName,
  index,
  ...rest
}) {
  const titleId = useId();
  const Heading = `h${headingLevel}`;
  return (
    <Tag
      className={cx(
        "ui-panel",
        `ui-card--pad-${padding}`,
        index !== undefined && "ui-enter",
        className,
      )}
      aria-labelledby={title ? titleId : undefined}
      style={index !== undefined ? { "--i": Math.min(index, 8) } : undefined}
      {...rest}
    >
      {(title || eyebrow || actions) && (
        <div className="ui-panel__head">
          <div className="ui-panel__titles">
            {eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}
            {title && (
              <Heading id={titleId} className="ui-panel__title">
                {title}
              </Heading>
            )}
            {description && <p className="ui-panel__desc">{description}</p>}
          </div>
          {actions && <div className="ui-panel__actions">{actions}</div>}
        </div>
      )}
      <div className={cx("ui-panel__body", bodyClassName)}>{children}</div>
      {footer && <div className="ui-panel__foot">{footer}</div>}
    </Tag>
  );
}

// ---------------------------------------------------------------- PageHeader

// eyebrow · title (+ italic accent word) · description · actions.
// `back` = {to, label} renders a quiet return link above the eyebrow.
export function PageHeader({
  eyebrow,
  title,
  accent,
  description,
  actions,
  back,
  meta,
  breadcrumbs,
  children,
  className,
}) {
  return (
    <header className={cx("ui-pagehead", className)}>
      {breadcrumbs}
      {back && (
        <Link to={back.to} className="ui-pagehead__back">
          <ArrowLeft size={16} strokeWidth={1.4} aria-hidden="true" />
          <span>{back.label || "Voltar"}</span>
        </Link>
      )}
      <div className="ui-pagehead__row">
        <div className="ui-pagehead__titles">
          {eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}
          <h1 className="ui-pagehead__title">
            {title}
            {accent && (
              <>
                {" "}
                <em>{accent}</em>
              </>
            )}
          </h1>
          {description && <p className="ui-pagehead__desc">{description}</p>}
          {meta && <div className="ui-pagehead__meta">{meta}</div>}
        </div>
        {actions && <div className="ui-pagehead__actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

// ---------------------------------------------------------------- Stat

// Real numbers only: pass loading while fetching; never a placeholder value.
export function Stat({
  label,
  value,
  hint,
  to,
  loading = false,
  icon,
  tone,
  index,
  className,
  linkLabel,
}) {
  const body = (
    <>
      <span className="ui-stat__label">
        {renderIcon(icon, { size: 16 })}
        <span>{label}</span>
      </span>
      <span className="ui-stat__value">
        {loading ? <Skeleton width={72} height={38} /> : (value ?? "—")}
      </span>
      {hint && <span className="ui-stat__hint">{hint}</span>}
      {to && (
        <span className="ui-stat__go" aria-hidden={linkLabel ? undefined : true}>
          {linkLabel && <span>{linkLabel}</span>}
          <ArrowUpRight size={16} strokeWidth={1.4} aria-hidden="true" />
        </span>
      )}
      <span className="ui-stat__rule" aria-hidden="true" />
    </>
  );
  const long = typeof value === "string" && value.length > 7;
  const classes = cx(
    "ui-stat",
    tone && `ui-stat--${tone}`,
    to && "is-interactive",
    long && "is-long",
    index !== undefined && "ui-enter",
    className,
  );
  const style = index !== undefined ? { "--i": Math.min(index, 8) } : undefined;
  if (to)
    return (
      <Link to={to} className={classes} style={style} aria-busy={loading || undefined}>
        {body}
      </Link>
    );
  return (
    <div className={classes} style={style} aria-busy={loading || undefined}>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- FilterBar

// Search + filters + actions. On phones the filters fold behind "Filtros (n)".
export function FilterBar({
  search,
  children,
  actions,
  activeCount = 0,
  onClear,
  clearLabel = "Limpar filtros",
  summary,
  className,
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className={cx("ui-filterbar", open && "is-open", className)}>
      <div className="ui-filterbar__main">
        {search && <div className="ui-filterbar__search">{search}</div>}
        {children && (
          <button
            type="button"
            className="ui-btn ui-btn--secondary ui-btn--md ui-filterbar__toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="ui-btn__label">
              <SlidersHorizontal size={16} strokeWidth={1.4} aria-hidden="true" />
              <span className="ui-btn__text">Filtros{activeCount ? ` (${activeCount})` : ""}</span>
            </span>
          </button>
        )}
        {children && (
          <div id={panelId} className="ui-filterbar__filters">
            {children}
          </div>
        )}
        {actions && <div className="ui-filterbar__actions">{actions}</div>}
      </div>
      {(summary || (activeCount > 0 && onClear)) && (
        <div className="ui-filterbar__summary">
          {summary && <span>{summary}</span>}
          {activeCount > 0 && onClear && (
            <button type="button" className="ui-btn ui-btn--link ui-btn--sm" onClick={onClear}>
              <span className="ui-btn__label">
                <span className="ui-btn__text">{clearLabel}</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Breadcrumbs

// items: [{label, to}]; the last one is the current page. Phones show the parent only.
export function Breadcrumbs({ items = [], className }) {
  if (!items.length) return null;
  return (
    <nav className={cx("ui-crumbs", className)} aria-label="Trilha de navegação">
      <ol>
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className={cx(i === items.length - 2 && "is-parent")}>
              {last || !item.to ? (
                <span aria-current={last ? "page" : undefined}>{item.label}</span>
              ) : (
                <Link to={item.to}>{item.label}</Link>
              )}
              {!last && <ChevronRight size={14} strokeWidth={1.4} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

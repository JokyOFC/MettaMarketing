import { Link } from "react-router-dom";
import { Spinner, renderIcon } from "./Icon.jsx";
import { Tooltip } from "./Tooltip.jsx";

const cx = (...parts) => parts.filter(Boolean).join(" ");

// Pill buttons. variant: primary | secondary | ghost | danger | link.
// `to` renders a router Link, `href` an anchor; everything else a <button>.
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  loading = false,
  disabled = false,
  block = false,
  to,
  href,
  type = "button",
  className,
  children,
  ref,
  ...rest
}) {
  const classes = cx(
    "ui-btn",
    `ui-btn--${variant}`,
    `ui-btn--${size}`,
    block && "ui-btn--block",
    loading && "is-loading",
    !children && "ui-btn--icon-only",
    className,
  );
  const iconSize = size === "sm" ? 16 : 17;
  const content = (
    <>
      <span className="ui-btn__label">
        {renderIcon(icon, { size: iconSize })}
        {children != null && children !== false && <span className="ui-btn__text">{children}</span>}
        {renderIcon(iconRight, { size: iconSize, className: "ui-btn__trail" })}
      </span>
      {loading && <Spinner size={size === "sm" ? 14 : 16} className="ui-btn__spinner" />}
    </>
  );
  const inactive = disabled || loading;

  if (to && !inactive)
    return (
      <Link ref={ref} to={to} className={classes} {...rest}>
        {content}
      </Link>
    );
  if (href && !inactive)
    return (
      <a ref={ref} href={href} className={classes} {...rest}>
        {content}
      </a>
    );
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...rest}
      onClick={loading ? (event) => event.preventDefault() : rest.onClick}
    >
      {content}
    </button>
  );
}

// Round hairline icon button. `label` is required (aria-label) and doubles as
// the tooltip unless tooltip={false} or a different string is given.
export function IconButton({
  label,
  icon,
  size = "md",
  variant = "outline",
  tooltip = true,
  tooltipPlacement = "top",
  loading = false,
  disabled = false,
  to,
  href,
  type = "button",
  className,
  children,
  ref,
  ...rest
}) {
  if (import.meta.env?.DEV && !label) console.warn("[ui] IconButton needs a label");
  const classes = cx(
    "ui-iconbtn",
    `ui-iconbtn--${variant}`,
    `ui-iconbtn--${size}`,
    loading && "is-loading",
    className,
  );
  const glyph = loading ? (
    <Spinner size={14} />
  ) : (
    renderIcon(icon, { size: size === "sm" ? 16 : 18 }) || children
  );
  let node;
  if (to && !disabled)
    node = (
      <Link ref={ref} to={to} className={classes} aria-label={label} {...rest}>
        {glyph}
      </Link>
    );
  else if (href && !disabled)
    node = (
      <a ref={ref} href={href} className={classes} aria-label={label} {...rest}>
        {glyph}
      </a>
    );
  else
    node = (
      <button
        ref={ref}
        type={type}
        className={classes}
        aria-label={label}
        disabled={disabled}
        aria-busy={loading || undefined}
        {...rest}
      >
        {glyph}
      </button>
    );
  if (!tooltip) return node;
  return (
    <Tooltip
      content={typeof tooltip === "string" ? tooltip : label}
      placement={tooltipPlacement}
      describe={typeof tooltip === "string" && tooltip !== label}
    >
      {node}
    </Tooltip>
  );
}

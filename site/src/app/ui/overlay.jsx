import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { Ellipsis, X } from "lucide-react";
import { Icon, renderIcon } from "./Icon.jsx";
import { Button } from "./Button.jsx";
import {
  composeHandlers,
  lockScroll,
  mergeRefs,
  popModal,
  pushModal,
  unlockScroll,
  useFloating,
  usePresence,
} from "./layer.js";

export { Tooltip } from "./Tooltip.jsx";

const cx = (...parts) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- Menu

const isItemEnabled = (el) => el && el.getAttribute("aria-disabled") !== "true";

// Accessible dropdown. items: [{label, icon, onSelect, to, href, danger,
// disabled, description, divider, heading}]. `trigger` may be an element
// (receives ref/aria props) or omitted for the default "more" icon button.
export function Menu({
  items = [],
  trigger,
  label = "Mais ações",
  icon,
  align = "end",
  placement = "bottom",
  className,
  onOpenChange,
  minWidth = 200,
}) {
  const [open, setOpenState] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const focusOnOpen = useRef("first");
  const menuId = useId();
  const presence = usePresence(open);
  const mounted = presence !== "closed";

  const setOpen = useCallback(
    (value) => {
      setOpenState(value);
      onOpenChange?.(value);
    },
    [onOpenChange],
  );

  useFloating(mounted, triggerRef, menuRef, { placement, align, offset: 6 });

  const itemEls = () =>
    Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || []).filter(isItemEnabled);

  useEffect(() => {
    if (!open) return undefined;
    const els = itemEls();
    const target = focusOnOpen.current === "last" ? els[els.length - 1] : els[0];
    (target || menuRef.current)?.focus({ preventScroll: true });
    const onDown = (event) => {
      if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target))
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const onTriggerKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusOnOpen.current = event.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  };
  const onTriggerClick = () => {
    focusOnOpen.current = "first";
    setOpen(!open);
  };

  const onMenuKeyDown = (event) => {
    const els = itemEls();
    const index = els.indexOf(document.activeElement);
    const focusAt = (i) => els[(i + els.length) % els.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(els.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (event.key.length === 1 && /\S/.test(event.key)) {
          const char = event.key.toLowerCase();
          const start = index + 1;
          const ordered = [...els.slice(start), ...els.slice(0, start)];
          ordered.find((el) => el.textContent.trim().toLowerCase().startsWith(char))?.focus();
        }
    }
  };

  const triggerProps = {
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": mounted ? menuId : undefined,
  };
  let triggerNode;
  if (typeof trigger === "function") {
    triggerNode = trigger({
      ref: triggerRef,
      open,
      props: { ...triggerProps, onClick: onTriggerClick, onKeyDown: onTriggerKeyDown },
    });
  } else if (isValidElement(trigger)) {
    triggerNode = cloneElement(trigger, {
      ...triggerProps,
      ref: mergeRefs(trigger.props.ref, triggerRef),
      onClick: composeHandlers(trigger.props.onClick, onTriggerClick),
      onKeyDown: composeHandlers(trigger.props.onKeyDown, onTriggerKeyDown),
    });
  } else {
    triggerNode = (
      <button
        ref={triggerRef}
        type="button"
        className="ui-iconbtn ui-iconbtn--ghost ui-iconbtn--md"
        aria-label={label}
        {...triggerProps}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
      >
        {renderIcon(icon || Ellipsis, { size: 18 })}
      </button>
    );
  }

  const select = (item, event) => {
    if (item.disabled) {
      event.preventDefault();
      return;
    }
    close(!item.to && !item.href);
    item.onSelect?.(event);
  };

  return (
    <>
      {triggerNode}
      {mounted && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={typeof label === "string" ? label : undefined}
          tabIndex={-1}
          popover="manual"
          className={cx("ui-menu ui-layer", className)}
          style={{ minWidth }}
          data-state={presence}
          onKeyDown={onMenuKeyDown}
        >
          {items.filter(Boolean).map((item, i) => {
            if (item.divider)
              return <div key={`d${i}`} role="separator" className="ui-menu__divider" />;
            if (item.heading)
              return (
                <div key={`h${i}`} className="ui-menu__heading" role="presentation">
                  {item.heading}
                </div>
              );
            const inner = (
              <>
                {item.icon ? (
                  renderIcon(item.icon, { size: 16 })
                ) : (
                  <span className="ui-menu__gap" />
                )}
                <span className="ui-menu__text">
                  <span>{item.label}</span>
                  {item.description && <small>{item.description}</small>}
                </span>
                {item.hint && <span className="ui-menu__hint">{item.hint}</span>}
              </>
            );
            const key = item.key || (typeof item.label === "string" ? item.label : i);
            const common = {
              role: "menuitem",
              tabIndex: -1,
              "aria-disabled": item.disabled || undefined,
              className: cx("ui-menu__item", item.danger && "is-danger"),
              onClick: (event) => select(item, event),
            };
            if (item.to && !item.disabled)
              return (
                <Link key={key} {...common} to={item.to}>
                  {inner}
                </Link>
              );
            if (item.href && !item.disabled)
              return (
                <a
                  key={key}
                  {...common}
                  href={item.href}
                  target={item.target}
                  rel={item.target === "_blank" ? "noreferrer" : undefined}
                >
                  {inner}
                </a>
              );
            return (
              <button key={key} {...common} type="button">
                {inner}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Modal / Drawer

const MODAL_MS = 220;

// Native <dialog> with showModal(): the browser traps focus and makes the page
// inert. Esc and the backdrop call onClose; focus returns to the opener.
export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  description,
  children,
  footer,
  actions,
  size = "md",
  variant = "modal",
  dismissible = true,
  hideClose = false,
  initialFocus,
  className,
  bodyClassName,
  headerAside,
  "aria-label": ariaLabel,
}) {
  const dialogRef = useRef(null);
  const openerRef = useRef(null);
  const downOnBackdrop = useRef(false);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const presence = usePresence(Boolean(open), variant === "drawer" ? 260 : MODAL_MS);
  const mounted = presence !== "closed";
  const closing = presence === "closing";

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !mounted) return undefined;
    if (!dialog.open) {
      openerRef.current = document.activeElement;
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
      const target = initialFocus?.current || dialog.querySelector("[autofocus], [data-autofocus]");
      if (target) target.focus({ preventScroll: true });
    }
    lockScroll();
    pushModal(dialog);
    return () => {
      popModal(dialog);
      unlockScroll();
      if (dialog.open) dialog.close();
      const opener = openerRef.current;
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || dialog.contains(active)))
        opener.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  const requestClose = () => {
    if (dismissible) onCloseRef.current?.();
  };

  if (!mounted) return null;
  const foot = footer ?? actions;
  const labelled = title ? titleId : undefined;

  return (
    <dialog
      ref={dialogRef}
      className={cx(
        "ui-dialog",
        variant === "drawer" ? "ui-dialog--drawer" : "ui-dialog--modal",
        `ui-dialog--${size}`,
        className,
      )}
      data-state={closing ? "closing" : "open"}
      aria-labelledby={labelled}
      aria-label={labelled ? undefined : ariaLabel}
      aria-describedby={description ? descId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClose={() => {
        // The browser may force-close on repeated Esc; keep React state in sync.
        // Our own close() (unmount, or StrictMode re-running the effect, which
        // reopens the dialog before this event arrives) must not reach onClose.
        if (open && !dialogRef.current?.open) onCloseRef.current?.();
      }}
      onPointerDown={(event) => {
        downOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && downOnBackdrop.current) requestClose();
        downOnBackdrop.current = false;
      }}
    >
      <div className="ui-dialog__panel">
        {(title || eyebrow || !hideClose) && (
          <div className="ui-dialog__head">
            <div className="ui-dialog__titles">
              {eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}
              {title && (
                <h2 id={titleId} className="ui-dialog__title">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="ui-dialog__desc">
                  {description}
                </p>
              )}
            </div>
            {headerAside}
            {!hideClose && dismissible && (
              <button
                type="button"
                className="ui-iconbtn ui-iconbtn--ghost ui-iconbtn--md ui-dialog__close"
                aria-label="Fechar"
                onClick={requestClose}
              >
                <X size={18} strokeWidth={1.4} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <div className={cx("ui-dialog__body", bodyClassName)}>{children}</div>
        {foot && <div className="ui-dialog__foot">{foot}</div>}
      </div>
    </dialog>
  );
}

// Side panel from the right; same dialog semantics. size: sm 480 · md 600 · lg 760.
export function Drawer(props) {
  return <Modal {...props} variant="drawer" />;
}

// Confirmation with an optional async action: shows progress, keeps the dialog
// open and explains the error if the action fails, closes on success.
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = "Confirmar ação",
  description,
  children,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "default",
  loading: loadingProp,
  icon,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const loading = loadingProp ?? busy;

  const confirm = async () => {
    setError(null);
    try {
      const result = onConfirm?.();
      if (result && typeof result.then === "function") {
        setBusy(true);
        await result;
        setBusy(false);
        onClose?.();
      }
    } catch (err) {
      setBusy(false);
      setError(err);
    }
  };

  return (
    <Modal
      open={open}
      onClose={loading ? undefined : onClose}
      dismissible={!loading}
      size="sm"
      title={title}
      description={description}
      className={cx("ui-confirm", tone === "danger" && "ui-confirm--danger")}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={loading}
            data-autofocus={tone === "danger" ? true : undefined}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={confirm}
            loading={loading}
            icon={icon}
            data-autofocus={tone === "danger" ? undefined : true}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error && (
        <p className="ui-inline-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{error.message || "Não foi possível concluir. Tente de novo."}</span>
        </p>
      )}
    </Modal>
  );
}

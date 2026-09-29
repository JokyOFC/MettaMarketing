import { useEffect, useId, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "../../ui/index.js";
import { cx } from "../../shared/review/util.js";

// "Filtros" disclosure for the content toolbar: the secondary filters live in
// a small panel under the button (inline on phones), so search, client, brand,
// sort and the view switch stay on one row. Non-modal: Esc or a click outside
// closes it and gives the focus back to the button; nothing depends on hover.
export function FilterPopover({ count = 0, children, onClear, label = "Filtros" }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.querySelector("select, input, button")?.focus({ preventScroll: true });
    const onDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className={cx("cnt-filterpop", open && "is-open")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <Button
        ref={buttonRef}
        icon={SlidersHorizontal}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cx("cnt-filterpop__button", count > 0 && "has-active")}
      >
        {label}
        {count > 0 && (
          <span className="cnt-filterpop__count ui-num">
            <span className="ui-sr-only">, ativos: </span>
            {count}
          </span>
        )}
      </Button>
      {open && (
        <div ref={panelRef} id={panelId} className="cnt-filterpop__panel ui-enter" role="group" aria-label={label}>
          <div className="cnt-filterpop__fields">{children}</div>
          <div className="cnt-filterpop__foot">
            {onClear && (
              <Button size="sm" variant="ghost" disabled={!count} onClick={onClear}>
                Limpar estes filtros
              </Button>
            )}
            <Button size="sm" onClick={() => close()}>
              Fechar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Active filters as removable chips ("Rede: Instagram ×").
export function FilterChips({ chips = [], onClearAll }) {
  if (!chips.length) return null;
  return (
    <ul className="cnt-chips" aria-label="Filtros ativos">
      {chips.map((chip) => (
        <li key={chip.key}>
          <button
            type="button"
            className="cnt-chip"
            onClick={chip.onRemove}
            aria-label={`Remover filtro ${chip.label}: ${chip.value}`}
          >
            <span className="cnt-chip__label">{chip.label}:</span> {chip.value}
            <X size={13} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </li>
      ))}
      {onClearAll && chips.length > 1 && (
        <li>
          <button type="button" className="rv-textbtn cnt-chips__clear" onClick={onClearAll}>
            Limpar filtros
          </button>
        </li>
      )}
    </ul>
  );
}

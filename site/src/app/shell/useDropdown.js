import { useCallback, useEffect, useRef, useState } from "react";

const ITEMS = '[role^="menuitem"]:not([disabled]), [data-dropdown-item]:not([disabled])';

// Disclosure for topbar menus: outside click, Escape and focus leaving the
// dropdown (Tab, Shift+Tab) close it; Escape returns focus to the trigger;
// arrow keys, Home and End move between items. In role="menu" panels the items
// are tabIndex={-1}: Tab leaves the menu instead of walking through it.
export function useDropdown({ focusFirst = true } = {}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    // Keyboard focus moved somewhere outside the trigger and the panel.
    const onFocusOut = (event) => {
      const next = event.relatedTarget;
      if (next && !rootRef.current?.contains(next)) setOpen(false);
    };
    const root = rootRef.current;
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    root?.addEventListener("focusout", onFocusOut);
    const frame = focusFirst
      ? requestAnimationFrame(() => panelRef.current?.querySelector(ITEMS)?.focus())
      : 0;
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      root?.removeEventListener("focusout", onFocusOut);
    };
  }, [open, close, focusFirst]);

  const onPanelKeyDown = useCallback((event) => {
    // Shift+Tab out of a menu lands on its own trigger: close it there.
    if (event.key === "Tab" && event.shiftKey && panelRef.current?.getAttribute("role") === "menu") {
      event.preventDefault();
      close();
      return;
    }
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = [...(panelRef.current?.querySelectorAll(ITEMS) || [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    let next = 0;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % items.length;
    if (event.key === "ArrowUp") next = index <= 0 ? items.length - 1 : index - 1;
    if (event.key === "End") next = items.length - 1;
    items[next].focus();
  }, [close]);

  const onButtonKeyDown = useCallback((event) => {
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  }, [open]);

  return {
    open,
    setOpen,
    toggle,
    close,
    rootRef,
    buttonRef,
    panelRef,
    onPanelKeyDown,
    onButtonKeyDown,
  };
}

// Small top-layer helpers shared by Menu, Tooltip, Modal and toasts.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export const supportsPopover =
  typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

export function showLayer(el) {
  if (!el || !supportsPopover || !el.hasAttribute("popover")) return;
  try {
    if (!el.matches(":popover-open")) el.showPopover();
  } catch {
    // detached or already shown elsewhere
  }
}

export function hideLayer(el) {
  if (!el || !supportsPopover || !el.hasAttribute("popover")) return;
  try {
    if (el.matches(":popover-open")) el.hidePopover();
  } catch {
    // ignore
  }
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

// Positions a fixed floating element next to its anchor, flipping vertically
// when it would leave the viewport. Writes data-side for transform-origin.
export function placeFloating(
  anchor,
  floating,
  { placement = "bottom", align = "start", offset = 6 } = {},
) {
  if (!anchor || !floating) return;
  const a = anchor.getBoundingClientRect();
  const f = floating.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 8;
  if (placement === "right" || placement === "left") {
    // Beside the anchor (sidebar rail tooltips), vertically centred.
    const fitsRight = a.right + offset + f.width <= vw - gap;
    const fitsLeft = a.left - offset - f.width >= gap;
    let side = placement;
    if (side === "right" && !fitsRight && fitsLeft) side = "left";
    else if (side === "left" && !fitsLeft && fitsRight) side = "right";
    const left = side === "right" ? a.right + offset : a.left - offset - f.width;
    const top = clamp(a.top + a.height / 2 - f.height / 2, gap, vh - f.height - gap);
    floating.style.top = `${Math.round(top)}px`;
    floating.style.left = `${Math.round(clamp(left, gap, vw - f.width - gap))}px`;
    floating.dataset.side = side;
    floating.dataset.align = "center";
    return;
  }
  let side = placement;
  const fitsBelow = a.bottom + offset + f.height <= vh - gap;
  const fitsAbove = a.top - offset - f.height >= gap;
  if (side === "bottom" && !fitsBelow && fitsAbove) side = "top";
  else if (side === "top" && !fitsAbove && fitsBelow) side = "bottom";
  let top = side === "bottom" ? a.bottom + offset : a.top - offset - f.height;
  let left =
    align === "end"
      ? a.right - f.width
      : align === "center"
        ? a.left + a.width / 2 - f.width / 2
        : a.left;
  left = clamp(left, gap, vw - f.width - gap);
  top = clamp(top, gap, vh - f.height - gap);
  floating.style.top = `${Math.round(top)}px`;
  floating.style.left = `${Math.round(left)}px`;
  floating.dataset.side = side;
  floating.dataset.align = align;
}

// ---- modal stack: lets toasts render inside the top-most open dialog, the
// only place that is not inert while a modal is open.
const stack = [];
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

export function pushModal(el) {
  stack.push(el);
  emit();
}

export function popModal(el) {
  const i = stack.lastIndexOf(el);
  if (i >= 0) stack.splice(i, 1);
  emit();
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const getTop = () => stack[stack.length - 1] || null;

export function useTopModal() {
  return useSyncExternalStore(subscribe, getTop, () => null);
}

// Page scroll lock shared by every open dialog.
let locks = 0;
export function lockScroll() {
  locks += 1;
  if (locks === 1) document.documentElement.classList.add("ui-scroll-lock");
}
export function unlockScroll() {
  locks = Math.max(0, locks - 1);
  if (locks === 0) document.documentElement.classList.remove("ui-scroll-lock");
}

export function mergeRefs(...refs) {
  return (node) => {
    refs.forEach((ref) => {
      if (!ref) return;
      if (typeof ref === "function") ref(node);
      else ref.current = node;
    });
  };
}

// Calls every handler in order (the consumer's first, then the kit's).
export const composeHandlers =
  (...handlers) =>
  (event, ...args) => {
    handlers.forEach((handler) => handler?.(event, ...args));
  };

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// "open" | "closing" | "closed": keeps a layer mounted during its exit
// animation. Derived during render so opening never skips a frame.
export function usePresence(open, ms = 150) {
  const [prevOpen, setPrevOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setClosing(!open && !prefersReducedMotion());
  }
  useEffect(() => {
    if (!closing) return undefined;
    const id = setTimeout(() => setClosing(false), ms);
    return () => clearTimeout(id);
  }, [closing, ms]);
  return open ? "open" : closing ? "closing" : "closed";
}

// Shows `floatingRef` in the top layer next to `anchorRef` while active and
// follows scroll/resize.
export function useFloating(active, anchorRef, floatingRef, options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useLayoutEffect(() => {
    if (!active) return undefined;
    const update = () => placeFloating(anchorRef.current, floatingRef.current, optionsRef.current);
    showLayer(floatingRef.current);
    update();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [active, anchorRef, floatingRef]);
}

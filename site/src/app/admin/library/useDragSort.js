import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "../../ui/index.js";

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const EDGE = 64;

/**
 * Reordering for lists and grids by pointer (mouse, pen, touch) and keyboard.
 *
 *   const sort = useDragSort({ ids, onReorder(nextIds, {from, to, via}), labelOf(id) });
 *   <li {...sort.itemProps(id)}>  <button {...sort.handleProps(id)} />  </li>
 *   sort.move(id, -1)  // "Mover para antes" buttons
 *
 * While dragging, the list reorders live (other items glide with a short FLIP
 * animation); onReorder runs once on drop. Arrow keys on the handle move one
 * step and commit right away. Esc or a cancelled pointer restores the order.
 */
export function useDragSort({ ids, onReorder, labelOf = () => "Item", disabled = false }) {
  const [drag, setDrag] = useState(null); // { id, order }
  const [announcement, setAnnouncement] = useState("");
  const els = useRef(new Map());
  const before = useRef(null); // rects captured right before a reorder
  const layout = useRef(new Map()); // settled document rects, for hit testing
  const state = useRef(null);
  const reduced = useReducedMotion();
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const order = drag?.order ?? ids;

  const measure = () => {
    const map = new Map();
    els.current.forEach((el, id) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      map.set(id, { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height });
    });
    return map;
  };

  const snapshot = () => {
    const map = new Map();
    els.current.forEach((el, id) => el && map.set(id, el.getBoundingClientRect()));
    before.current = map;
  };

  // FLIP: glide every item from where it was to its new slot.
  useLayoutEffect(() => {
    const previous = before.current;
    if (!previous) return;
    before.current = null;
    if (state.current) layout.current = measure();
    if (reduced) return;
    els.current.forEach((el, id) => {
      const prev = previous.get(id);
      if (!el || !prev || typeof el.animate !== "function") return;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
        duration: 200,
        easing: EASE,
      });
    });
  });

  const announce = (id, index, total) =>
    setAnnouncement(`${labelOf(id)}: posição ${index + 1} de ${total}.`);

  const move = useCallback(
    (id, delta) => {
      const list = idsRef.current;
      const from = list.indexOf(id);
      const to = from + delta;
      if (disabled || from < 0 || to < 0 || to >= list.length) return;
      snapshot();
      const next = [...list];
      next.splice(from, 1);
      next.splice(to, 0, id);
      onReorderRef.current?.(next, { from, to, via: "keyboard" });
      announce(id, to, list.length);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled],
  );

  const listeners = useRef(null);
  const detach = () => {
    const l = listeners.current;
    if (!l) return;
    window.removeEventListener("pointermove", l.move);
    window.removeEventListener("pointerup", l.up);
    window.removeEventListener("pointercancel", l.cancel);
    listeners.current = null;
  };
  useEffect(() => detach, []);

  const finish = (commit) => {
    const current = state.current;
    state.current = null;
    detach();
    if (!current) return;
    snapshot();
    setDrag(null);
    document.documentElement.classList.remove("lib-dragging");
    if (commit && current.moved) {
      const from = idsRef.current.indexOf(current.id);
      const to = current.order.indexOf(current.id);
      if (from !== to) {
        onReorderRef.current?.(current.order, { from, to, via: "pointer" });
        announce(current.id, to, current.order.length);
      }
    } else if (current.moved) {
      setAnnouncement("Ordem mantida.");
    }
  };

  useEffect(() => {
    if (!drag) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(drag)]);

  const onPointerDown = (id) => (event) => {
    if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    detach();
    // Window listeners (not pointer capture): React may move the dragged node
    // in the DOM while the list reorders, which would drop a capture.
    const l = { move: (e) => onPointerMove(e), up: () => finish(true), cancel: () => finish(false) };
    listeners.current = l;
    window.addEventListener("pointermove", l.move);
    window.addEventListener("pointerup", l.up);
    window.addEventListener("pointercancel", l.cancel);
    layout.current = measure();
    state.current = { id, order: [...idsRef.current], moved: false };
    document.documentElement.classList.add("lib-dragging");
    setDrag({ id, order: state.current.order });
  };

  const onPointerMove = (event) => {
    const current = state.current;
    if (!current) return;
    const { clientX, clientY } = event;
    if (clientY < EDGE) window.scrollBy(0, -12);
    else if (clientY > window.innerHeight - EDGE) window.scrollBy(0, 12);
    const x = clientX + window.scrollX;
    const y = clientY + window.scrollY;
    let target = null;
    for (const [otherId, r] of layout.current) {
      if (otherId === current.id) continue;
      if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) {
        target = otherId;
        break;
      }
    }
    if (!target) return;
    const from = current.order.indexOf(current.id);
    const to = current.order.indexOf(target);
    if (to < 0 || from === to) return;
    snapshot();
    const next = [...current.order];
    next.splice(from, 1);
    next.splice(to, 0, current.id);
    current.order = next;
    current.moved = true;
    setDrag({ id: current.id, order: next });
  };

  const itemProps = (id) => ({
    ref: (el) => {
      if (el) els.current.set(id, el);
      else els.current.delete(id);
    },
    "data-dragging": drag?.id === id ? "true" : undefined,
  });

  const handleProps = (id) => ({
    type: "button",
    className: "lib-handle",
    "aria-label": `Reordenar ${labelOf(id)}. Use as setas para mover.`,
    title: "Arraste ou use as setas para reordenar",
    disabled,
    onPointerDown: onPointerDown(id),
    onKeyDown: (event) => {
      const delta = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key];
      if (!delta) return;
      event.preventDefault();
      move(id, delta);
    },
  });

  return { order, itemProps, handleProps, move, draggingId: drag?.id ?? null, announcement };
}

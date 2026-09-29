// Vertical drag-to-reorder with pointer events (mouse, pen and touch) plus a
// keyboard path on the same handle: ArrowUp/ArrowDown move the item.
//
//   const sort = useDragSort({ keys, onMove(from, to), label: (i) => "…" });
//   <li ref={sort.itemRef(key)} style={sort.itemStyle(index)} className={sort.itemClass(index)}>
//     <button {...sort.handleProps(index)} />
//   </li>
//   <span className="ui-sr-only" aria-live="polite">{sort.message}</span>
import { useCallback, useEffect, useRef, useState } from "react";

const EDGE = 72; // px from the viewport edge where auto-scroll starts
const SPEED = 14;

export function useDragSort({ keys, onMove, label = (index) => `Item ${index + 1}`, disabled = false }) {
  const elements = useRef(new Map());
  const handles = useRef(new Map());
  const session = useRef(null);
  const frame = useRef(0);
  const [drag, setDragState] = useState(null); // { from, to, dy, shift }
  const dragRef = useRef(null);
  const setDrag = useCallback((next) => {
    dragRef.current = next;
    setDragState(next);
  }, []);
  const [message, setMessage] = useState("");
  const pendingFocus = useRef(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const itemRef = useCallback(
    (key) => (node) => {
      if (node) elements.current.set(key, node);
      else elements.current.delete(key);
    },
    [],
  );

  // Keeps keyboard focus on the moved item's handle after the list re-renders.
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    handles.current.get(key)?.focus({ preventScroll: false });
  });

  const update = useCallback((clientY) => {
    const s = session.current;
    if (!s) return;
    s.lastY = clientY;
    const dy = clientY + window.scrollY - s.startDocY;
    const center = s.rects[s.from].top + s.rects[s.from].height / 2 + dy;
    let to = 0;
    s.rects.forEach((rect, i) => {
      if (i !== s.from && rect.top + rect.height / 2 < center) to += 1;
    });
    const current = dragRef.current;
    if (current && (current.dy !== dy || current.to !== to)) setDrag({ ...current, dy, to });
  }, [setDrag]);

  const stopScrolling = () => cancelAnimationFrame(frame.current);

  const autoScroll = useCallback(() => {
    const s = session.current;
    if (!s) return;
    const y = s.lastY;
    let step = 0;
    if (y < EDGE) step = -SPEED * (1 - Math.max(0, y) / EDGE);
    else if (y > window.innerHeight - EDGE) step = SPEED * (1 - Math.max(0, window.innerHeight - y) / EDGE);
    if (step) {
      window.scrollBy(0, step);
      update(y);
    }
    frame.current = requestAnimationFrame(autoScroll);
  }, [update]);

  const finish = useCallback(
    (commit) => {
      const s = session.current;
      session.current = null;
      stopScrolling();
      const current = dragRef.current;
      setDrag(null);
      if (commit && current && current.to !== current.from) {
        onMoveRef.current?.(current.from, current.to);
        setMessage(`${label(current.from)}: agora na posição ${current.to + 1} de ${s?.rects.length ?? keys.length}.`);
      }
    },
    [label, keys.length, setDrag],
  );

  useEffect(() => () => stopScrolling(), []);

  const handleProps = (index) => {
    const key = keys[index];
    return {
      ref: (node) => {
        if (node) handles.current.set(key, node);
        else handles.current.delete(key);
      },
      type: "button",
      disabled,
      "aria-label": `Reordenar: ${label(index)}. Use as setas para cima e para baixo.`,
      "aria-roledescription": "alça de reordenação",
      "data-dragging": drag?.from === index || undefined,
      onPointerDown: (event) => {
        if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
        const rects = keys.map((k) => {
          const rect = elements.current.get(k)?.getBoundingClientRect();
          return rect ? { top: rect.top + window.scrollY, height: rect.height } : { top: 0, height: 0 };
        });
        if (rects.length < 2) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const next = rects[index + 1] ?? rects[index - 1];
        const gap = next
          ? Math.max(0, next.top > rects[index].top ? next.top - (rects[index].top + rects[index].height) : rects[index].top - (next.top + next.height))
          : 0;
        session.current = { from: index, rects, startDocY: event.clientY + window.scrollY, lastY: event.clientY };
        setDrag({ from: index, to: index, dy: 0, shift: rects[index].height + gap });
        frame.current = requestAnimationFrame(autoScroll);
      },
      onPointerMove: (event) => {
        if (session.current) update(event.clientY);
      },
      onPointerUp: () => session.current && finish(true),
      onPointerCancel: () => session.current && finish(false),
      onLostPointerCapture: () => session.current && finish(true),
      onKeyDown: (event) => {
        if (disabled) return;
        let to = null;
        if (event.key === "ArrowUp" && index > 0) to = index - 1;
        else if (event.key === "ArrowDown" && index < keys.length - 1) to = index + 1;
        else if (event.key === "Home" && index > 0) to = 0;
        else if (event.key === "End" && index < keys.length - 1) to = keys.length - 1;
        else if (event.key === "Escape" && session.current) {
          event.preventDefault();
          finish(false);
          return;
        }
        if (to === null) return;
        event.preventDefault();
        pendingFocus.current = key;
        onMoveRef.current?.(index, to);
        setMessage(`${label(index)}: agora na posição ${to + 1} de ${keys.length}.`);
      },
    };
  };

  // Transform for each row while a drag is running.
  const itemStyle = (index) => {
    if (!drag) return undefined;
    const { from, to, dy, shift } = drag;
    if (index === from) return { transform: `translateY(${dy}px)`, zIndex: 3, position: "relative" };
    if (from < to && index > from && index <= to) return { transform: `translateY(${-shift}px)` };
    if (from > to && index >= to && index < from) return { transform: `translateY(${shift}px)` };
    return { transform: "translateY(0)" };
  };

  const itemClass = (index) => (!drag ? "" : index === drag.from ? "is-dragging" : "is-shifting");

  return {
    dragging: Boolean(drag),
    itemRef,
    itemStyle,
    itemClass,
    handleProps,
    message,
  };
}

// Moves one element of an array (returns a new array).
export function moveItem(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

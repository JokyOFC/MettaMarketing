import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import { composeHandlers, mergeRefs, useFloating, usePresence } from "./layer.js";

// Shows on hover (after a short delay) and on keyboard focus; Esc hides it.
// Never the only way to reach information: the trigger keeps its own name.
// `describe` links the text as aria-describedby (off when it repeats the label).
export function Tooltip({
  content,
  children,
  placement = "top",
  delay = 350,
  describe = true,
  disabled,
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const tipRef = useRef(null);
  const timer = useRef(0);
  const id = useId();
  const presence = usePresence(open, 100);
  const mounted = presence !== "closed";

  useFloating(mounted, anchorRef, tipRef, { placement, align: "center", offset: 8 });
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const child = Children.only(children);
  if (!content || disabled || !isValidElement(child)) return child;

  const show = (wait) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), wait);
  };
  const hide = (wait = 0) => {
    clearTimeout(timer.current);
    if (wait) timer.current = setTimeout(() => setOpen(false), wait);
    else setOpen(false);
  };
  const linked = describe && typeof content === "string";

  const trigger = cloneElement(child, {
    ref: mergeRefs(child.props.ref, anchorRef),
    "aria-describedby": linked
      ? [child.props["aria-describedby"], id].filter(Boolean).join(" ")
      : child.props["aria-describedby"],
    onPointerEnter: composeHandlers(child.props.onPointerEnter, (event) => {
      if (event.pointerType === "mouse") show(delay);
    }),
    onPointerLeave: composeHandlers(child.props.onPointerLeave, () => hide(80)),
    onPointerDown: composeHandlers(child.props.onPointerDown, () => hide()),
    onFocus: composeHandlers(child.props.onFocus, (event) => {
      if (event.currentTarget.matches?.(":focus-visible")) show(0);
    }),
    onBlur: composeHandlers(child.props.onBlur, () => hide()),
  });

  return (
    <>
      {trigger}
      {linked && !mounted && (
        <span id={id} hidden>
          {content}
        </span>
      )}
      {mounted && (
        <span
          ref={tipRef}
          id={linked ? id : undefined}
          role="tooltip"
          popover="manual"
          className="ui-tooltip ui-layer"
          data-state={presence}
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={() => hide(80)}
        >
          {content}
        </span>
      )}
    </>
  );
}

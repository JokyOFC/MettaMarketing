import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import { FileGlyph, useReducedMotion } from "../../ui/index.js";
import { VideoPlayer } from "./VideoPlayer.jsx";
import { clamp, cx, ratioOf, stageUrl, thumbUrl } from "./util.js";
import "./review.css";

const SWIPE = 48; // px needed to change slide
const THUMBS_MAX = 16;

function parseAspect(aspect, files) {
  if (typeof aspect === "number" && aspect > 0) return aspect;
  if (typeof aspect === "string") {
    const [w, h] = aspect.split(/[/:x]/).map(Number);
    if (w > 0 && h > 0) return w / h;
  }
  const first = files.find((file) => file?.width && file?.height);
  return first ? clamp(ratioOf(first), 0.5, 2) : 4 / 5;
}

// One slide: the optimised preview at the carousel's proportion, a video
// player, or a file card when no preview exists.
function Slide({ file, index, count, active, render, onOpen, dragged }) {
  if (!render) return <div className="rv-slide__placeholder" aria-hidden="true" />;
  if (file.mediaKind === "video") return <VideoPlayer file={file} active={active} className="rv-slide__video" />;
  const url = stageUrl(file);
  if (!url)
    return (
      <div className="rv-slide__glyph">
        <FileGlyph kind={file.mediaKind} format={file.format} name={file.name} status={file.previewStatus} />
      </div>
    );
  const img = (
    <img
      src={url}
      alt={`Slide ${index + 1} de ${count}`}
      draggable={false}
      decoding="async"
      loading={active ? "eager" : "lazy"}
    />
  );
  if (!onOpen) return img;
  return (
    <button
      type="button"
      className="rv-slide__open"
      tabIndex={active ? 0 : -1}
      aria-label={`Ampliar slide ${index + 1}`}
      onClick={(event) => {
        if (dragged.current) {
          event.preventDefault();
          return;
        }
        onOpen(index);
      }}
    >
      {img}
    </button>
  );
}

// Slides at their real proportion with buttons, arrow keys, swipe (pointer
// events), a live "3 / 8" counter and a thumbnail strip (or dots). Neighbours
// preload; the slide change animates 220 ms (instant with reduced motion).
export function CarouselViewer({
  files = [],
  initialIndex = 0,
  index: controlledIndex,
  onIndexChange,
  aspect,
  onExpand,
  bg,
  label = "Slides",
  maxHeight,
  showThumbs = true,
  className,
}) {
  const count = files.length;
  const reduced = useReducedMotion();
  const [innerIndex, setInnerIndex] = useState(() => clamp(initialIndex, 0, Math.max(0, count - 1)));
  const index = clamp(controlledIndex ?? innerIndex, 0, Math.max(0, count - 1));
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [seen, setSeen] = useState(() => new Set([index]));
  const pointer = useRef(null);
  const dragged = useRef(false);
  const stripRef = useRef(null);
  const regionId = useId();
  const ratio = parseAspect(aspect, files);

  useEffect(() => {
    setSeen((prev) => (prev.has(index) ? prev : new Set(prev).add(index)));
    // Scroll only the thumbnail strip, sideways: scrollIntoView would also move
    // the page or the drawer that holds the viewer.
    const strip = stripRef.current;
    const thumb = strip?.querySelector(`[data-index="${index}"]`);
    if (strip && thumb) {
      const box = strip.getBoundingClientRect();
      const rect = thumb.getBoundingClientRect();
      const left = rect.left - box.left + strip.scrollLeft;
      const right = left + rect.width;
      let target = null;
      if (left < strip.scrollLeft) target = left;
      else if (right > strip.scrollLeft + strip.clientWidth) target = right - strip.clientWidth;
      if (target !== null) strip.scrollTo?.({ left: Math.max(0, target), behavior: reduced ? "auto" : "smooth" });
    }
  }, [index, reduced]);

  useEffect(() => {
    if (controlledIndex === undefined && innerIndex > count - 1) setInnerIndex(Math.max(0, count - 1));
  }, [count, innerIndex, controlledIndex]);

  if (!count) return null;

  const go = (next) => {
    const target = clamp(next, 0, count - 1);
    if (target === index) return;
    if (controlledIndex === undefined) setInnerIndex(target);
    onIndexChange?.(target);
  };

  const onKeyDown = (event) => {
    if (event.target.closest("video, input, textarea, select")) return;
    const keys = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: count - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    go(keys[event.key]);
  };

  const onPointerDown = (event) => {
    if (count < 2 || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (event.target.closest("video, .rv-carousel__nav, .rv-carousel__expand")) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, width: event.currentTarget.offsetWidth };
    dragged.current = false;
  };
  const onPointerMove = (event) => {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    const dx = event.clientX - p.x;
    const dy = event.clientY - p.y;
    if (!p.axis) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      p.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (p.axis === "x") {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
      }
    }
    if (p.axis !== "x") return;
    dragged.current = true;
    // resistance at the ends
    const edge = (index === 0 && dx > 0) || (index === count - 1 && dx < 0);
    setDrag(edge ? dx / 3 : dx);
  };
  const endDrag = (event) => {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    pointer.current = null;
    if (p.axis === "x") {
      const dx = event.clientX - p.x;
      const threshold = Math.min(SWIPE, p.width * 0.18);
      if (dx <= -threshold) go(index + 1);
      else if (dx >= threshold) go(index - 1);
    }
    setDrag(0);
    setDragging(false);
    // keep the flag until the click that follows a drag was swallowed
    setTimeout(() => {
      dragged.current = false;
    }, 0);
  };

  const hasThumbs = showThumbs && count > 1 && count <= THUMBS_MAX && files.some((file) => thumbUrl(file));
  const trackStyle = {
    transform: `translate3d(calc(${-index * 100}% + ${drag}px), 0, 0)`,
    transition: dragging || reduced ? "none" : undefined,
  };

  return (
    <section
      className={cx("rv-carousel", bg && `rv-bg--${bg}`, className)}
      aria-roledescription="carrossel"
      aria-label={label}
      style={{ "--ratio": ratio, ...(maxHeight ? { "--rv-stage-max": maxHeight } : null) }}
    >
      <div
        className={cx("rv-carousel__viewport", dragging && "is-dragging")}
        tabIndex={0}
        aria-describedby={`${regionId}-hint`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="rv-carousel__frame">
          <div className="rv-carousel__track" style={trackStyle}>
            {files.map((file, i) => {
              const active = i === index;
              const render = Math.abs(i - index) <= 1 || seen.has(i);
              return (
                <div
                  key={file.id ?? i}
                  className={cx("rv-slide", active && "is-active")}
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`${i + 1} de ${count}`}
                  aria-hidden={active ? undefined : true}
                  inert={active ? undefined : true}
                >
                  <Slide
                    file={file}
                    index={i}
                    count={count}
                    active={active}
                    render={render}
                    onOpen={onExpand}
                    dragged={dragged}
                  />
                </div>
              );
            })}
          </div>
          {count > 1 && (
            <>
              {/* aria-disabled (not disabled) at the ends: the focused button
                  stays focusable instead of dropping focus to <body>. */}
              <button
                type="button"
                className="rv-carousel__nav rv-carousel__nav--prev"
                aria-label="Slide anterior"
                aria-disabled={index === 0 || undefined}
                onClick={() => go(index - 1)}
              >
                <ChevronLeft size={20} strokeWidth={1.4} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="rv-carousel__nav rv-carousel__nav--next"
                aria-label="Próximo slide"
                aria-disabled={index === count - 1 || undefined}
                onClick={() => go(index + 1)}
              >
                <ChevronRight size={20} strokeWidth={1.4} aria-hidden="true" />
              </button>
            </>
          )}
          <p className="rv-carousel__counter" aria-live="polite" aria-atomic="true">
            <span className="ui-sr-only">Slide </span>
            {index + 1} <span aria-hidden="true">/</span>
            <span className="ui-sr-only"> de </span> {count}
          </p>
          {onExpand && files[index]?.mediaKind !== "video" && (
            <button
              type="button"
              className="rv-carousel__expand"
              aria-label={`Ampliar slide ${index + 1}`}
              onClick={() => onExpand(index)}
            >
              <Maximize2 size={16} strokeWidth={1.4} aria-hidden="true" />
            </button>
          )}
        </div>
        <span id={`${regionId}-hint`} className="ui-sr-only">
          Use as setas do teclado ou deslize para trocar de slide.
        </span>
      </div>

      {count > 1 &&
        (hasThumbs ? (
          <div className="rv-carousel__thumbs" ref={stripRef} role="group" aria-label="Escolher slide">
            {files.map((file, i) => {
              const url = thumbUrl(file);
              return (
                <button
                  key={file.id ?? i}
                  type="button"
                  data-index={i}
                  className={cx("rv-carousel__thumb", i === index && "is-active")}
                  aria-label={`Ir para o slide ${i + 1}`}
                  aria-current={i === index ? "true" : undefined}
                  onClick={() => go(i)}
                >
                  {url ? (
                    <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />
                  ) : (
                    <span className="rv-carousel__thumb-num">{i + 1}</span>
                  )}
                  <span className="rv-carousel__thumb-pos" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rv-carousel__dots" role="group" aria-label="Escolher slide">
            {files.map((file, i) => (
              <button
                key={file.id ?? i}
                type="button"
                className={cx("rv-carousel__dot", i === index && "is-active")}
                aria-label={`Ir para o slide ${i + 1}`}
                aria-current={i === index ? "true" : undefined}
                onClick={() => go(i)}
              />
            ))}
          </div>
        ))}
    </section>
  );
}

export default CarouselViewer;

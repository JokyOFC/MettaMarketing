import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, RotateCcw, X } from "lucide-react";
import { FileGlyph, IconButton, ProgressBar, formatBytes } from "../../ui/index.js";
import { api } from "../../api/client.js";
import { uploadFile } from "../../api/upload.js";
import { cx } from "../../shared/review/util.js";

let seq = 0;

const kindOf = (file) => {
  const type = file.type || "";
  if (type.startsWith("image/svg")) return "vector";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  return "other";
};
const formatOf = (name) => (String(name).includes(".") ? String(name).split(".").pop().toUpperCase() : "");

// Uploads each file on its own request (real progress through XHR), with
// cancel, retry and removal. Items keep the order the team gives them.
export function useUploadQueue() {
  const [items, setItems] = useState([]);
  const controllers = useRef(new Map());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const update = useCallback((key, patch) => {
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  const send = useCallback(
    async (key, file) => {
      const controller = new AbortController();
      controllers.current.set(key, controller);
      update(key, { status: "uploading", progress: 0, error: null });
      try {
        const upload = await uploadFile(file, {
          signal: controller.signal,
          onProgress: (loaded, total) => update(key, { progress: total ? loaded / total : 0 }),
        });
        update(key, { status: "done", progress: 1, upload });
      } catch (error) {
        if (error?.name === "AbortError") return;
        update(key, { status: "error", error: error?.message || "Não foi possível enviar este arquivo." });
      } finally {
        controllers.current.delete(key);
      }
    },
    [update],
  );

  const add = useCallback(
    (files, { replace = false } = {}) => {
      const next = files.map((file) => ({
        key: `u${++seq}`,
        file,
        name: file.name,
        size: file.size,
        kind: kindOf(file),
        format: formatOf(file.name),
        preview: file.type.startsWith("image/") && !file.type.includes("svg") ? URL.createObjectURL(file) : null,
        status: "uploading",
        progress: 0,
      }));
      if (replace) itemsRef.current.forEach((item) => discard(item));
      setItems((list) => (replace ? next : [...list, ...next]));
      next.forEach((item) => send(item.key, item.file));
    },
    [send], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function discard(item) {
    controllers.current.get(item.key)?.abort();
    if (item.preview) URL.revokeObjectURL(item.preview);
    if (item.upload?.id) api.del(`/uploads/${item.upload.id}`).catch(() => {});
  }

  const remove = useCallback((key) => {
    const item = itemsRef.current.find((entry) => entry.key === key);
    if (item) discard(item);
    setItems((list) => list.filter((entry) => entry.key !== key));
  }, []);

  const retry = useCallback(
    (key) => {
      const item = itemsRef.current.find((entry) => entry.key === key);
      if (item?.file) send(key, item.file);
    },
    [send],
  );

  const move = useCallback((from, to) => {
    setItems((list) => {
      if (to < 0 || to >= list.length || from === to) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  // Forget the items without deleting the uploads (they now belong to a material).
  const clear = useCallback(() => {
    itemsRef.current.forEach((item) => item.preview && URL.revokeObjectURL(item.preview));
    setItems([]);
  }, []);

  useEffect(
    () => () => {
      controllers.current.forEach((controller) => controller.abort());
      itemsRef.current.forEach((item) => item.preview && URL.revokeObjectURL(item.preview));
    },
    [],
  );

  return {
    items,
    add,
    remove,
    retry,
    move,
    clear,
    busy: items.some((item) => item.status === "uploading"),
    failed: items.filter((item) => item.status === "error").length,
    ready: items.filter((item) => item.status === "done"),
  };
}

// Ordered list with a drag handle (pointer: mouse and touch), keyboard moves
// (arrows on the handle) and explicit up/down buttons. items: [{key, name,
// size, kind, format, preview|thumbUrl, status, progress, error}].
export function SlideList({ items, onMove, onRemove, onRetry, noun = "slide", numbered = true, removeLabel = "Remover", disabled = false }) {
  const listRef = useRef(null);
  const [dragKey, setDragKey] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  // After a move the moved row's control keeps the focus (the grip, or the
  // up/down button that was pressed), even though the row changed place.
  const focusTarget = useRef(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    focusTarget.current = null;
    const selector =
      target.control === "grip"
        ? `[data-grip="${CSS.escape(target.key)}"]`
        : `[data-move="${target.control}"][data-key="${CSS.escape(target.key)}"]`;
    listRef.current?.querySelector(selector)?.focus();
  }, [items]);

  const moveBy = (index, delta, control) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    if (control) focusTarget.current = { key: items[index].key, control };
    onMove(index, target);
    setAnnouncement(`${items[index].name} movido para a posição ${target + 1} de ${items.length}.`);
  };

  const startDrag = (event, key) => {
    if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    setDragKey(key);
    const onMoveEvent = (moveEvent) => {
      const rows = [...(listRef.current?.children ?? [])];
      const list = itemsRef.current;
      const from = list.findIndex((item) => item.key === key);
      if (from < 0 || rows.length !== list.length) return;
      // target = how many other rows sit above the pointer
      let to = 0;
      rows.forEach((row, i) => {
        if (i === from) return;
        const rect = row.getBoundingClientRect();
        if (moveEvent.clientY > rect.top + rect.height / 2) to += 1;
      });
      if (to !== from) onMove(from, to);
    };
    const end = () => {
      window.removeEventListener("pointermove", onMoveEvent);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const list = itemsRef.current;
      const index = list.findIndex((item) => item.key === key);
      if (index >= 0) setAnnouncement(`${list[index].name} na posição ${index + 1} de ${list.length}.`);
      setDragKey(null);
    };
    window.addEventListener("pointermove", onMoveEvent);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  if (!items.length) return null;
  return (
    <>
      <ol ref={listRef} className="cnt-slides" aria-label={`Ordem dos ${noun}s`}>
        {items.map((item, index) => {
          const thumb = item.preview || item.thumbUrl;
          return (
            <li
              key={item.key}
              className={cx("cnt-slide", dragKey === item.key && "is-dragging", item.status === "error" && "is-error")}
            >
              <button
                type="button"
                className="cnt-slide__grip"
                data-grip={item.key}
                aria-label={`Mover ${item.name}, posição ${index + 1} de ${items.length}. Use as setas para cima e para baixo.`}
                disabled={disabled || items.length < 2}
                onPointerDown={(event) => startDrag(event, item.key)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveBy(index, -1, "grip");
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveBy(index, 1, "grip");
                  }
                }}
              >
                <GripVertical size={16} strokeWidth={1.4} aria-hidden="true" />
              </button>
              {numbered ? (
                <span className="cnt-slide__pos" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
              ) : (
                <span />
              )}
              <span className="cnt-slide__thumb">
                {thumb ? (
                  <img src={thumb} alt="" draggable={false} />
                ) : (
                  <span className="ui-thumb" style={{ position: "relative", display: "block" }}>
                    <FileGlyph kind={item.kind} format={item.format} compact />
                  </span>
                )}
              </span>
              <span className="cnt-slide__info">
                <span className="cnt-slide__name" title={item.name}>
                  {item.name}
                </span>
                {item.status === "uploading" ? (
                  <ProgressBar value={item.progress} size="sm" label={`Enviando ${Math.round((item.progress ?? 0) * 100)}%`} aria-label={`Envio de ${item.name}`} />
                ) : item.status === "error" ? (
                  <span className="cnt-slide__error" role="alert">
                    {item.error}
                  </span>
                ) : (
                  <span className="cnt-slide__meta">
                    {[item.format, item.size != null ? formatBytes(item.size) : null, item.status === "done" && item.upload ? "Enviado" : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </span>
              <span className="cnt-slide__actions">
                {item.status === "error" && onRetry && (
                  <IconButton label="Tentar enviar de novo" icon={RotateCcw} size="sm" variant="ghost" onClick={() => onRetry(item.key)} />
                )}
                {/* aria-disabled at the ends (not disabled): the pressed button
                    keeps the focus when its row reaches the top or bottom. */}
                <IconButton
                  label={`Mover ${item.name} para cima`}
                  icon={ArrowUp}
                  size="sm"
                  variant="ghost"
                  className="cnt-slide__move"
                  data-move="up"
                  data-key={item.key}
                  disabled={disabled}
                  aria-disabled={index === 0 || undefined}
                  onClick={() => moveBy(index, -1, "up")}
                />
                <IconButton
                  label={`Mover ${item.name} para baixo`}
                  icon={ArrowDown}
                  size="sm"
                  variant="ghost"
                  className="cnt-slide__move"
                  data-move="down"
                  data-key={item.key}
                  disabled={disabled}
                  aria-disabled={index === items.length - 1 || undefined}
                  onClick={() => moveBy(index, 1, "down")}
                />
                {onRemove && (
                  <IconButton label={`${removeLabel} ${item.name}`} icon={X} size="sm" variant="ghost" disabled={disabled} onClick={() => onRemove(item.key)} />
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="ui-sr-only" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}

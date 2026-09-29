import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { uploadFile } from "../../api/upload.js";
import { formatBytes } from "../../ui/format.js";
import { ALLOWED_EXTS, extOf, isEditableExt, isImageExt, titleFromFilename } from "./data.js";

let seq = 0;
const nextKey = () => `u${Date.now().toString(36)}${(seq += 1)}`;

// Clear pt-BR reasons per failure; `retry` says whether trying again can help.
export function explainUploadError(error) {
  const code = error?.code ?? "internal";
  if (code === "payload_too_large")
    return { code, retry: false, message: error.message || "Arquivo acima do limite de envio." };
  if (code === "unsupported_media")
    return {
      code,
      retry: false,
      message: error.message || "Formato não permitido ou conteúdo diferente da extensão do arquivo.",
    };
  if (code === "network" || error?.status === 0)
    return { code: "network", retry: true, message: "A conexão caiu durante o envio. Verifique a internet e tente de novo." };
  if (code === "unauthenticated") return { code, retry: false, message: "Sua sessão terminou. Entre de novo para continuar." };
  if (code === "validation") return { code, retry: false, message: error.message || "Arquivo recusado pelo servidor." };
  return { code, retry: true, message: error?.message || "Não foi possível enviar este arquivo." };
}

/**
 * Parallel uploads with real per-file progress (XHR), cancel, retry and
 * removal. Every file starts uploading as soon as it is added; a failure
 * never blocks the others. item = { key, file, name, ext, size, status:
 * queued|uploading|done|error|cancelled, loaded, total, upload, error, role,
 * title, preview (object URL for images), saved }.
 */
export function useUploadQueue({ concurrency = 3, defaultRole, maxBytes = null } = {}) {
  const [items, setItems] = useState([]);
  const controllers = useRef(new Map());
  const started = useRef(new Set());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // The limit arrives from the server after mount; read it when files are added.
  const limitRef = useRef(maxBytes);
  limitRef.current = maxBytes;

  const update = useCallback((key, patch) => {
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...(typeof patch === "function" ? patch(item) : patch) } : item)));
  }, []);

  const start = useCallback(
    (item) => {
      if (started.current.has(item.key)) return;
      started.current.add(item.key);
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      update(item.key, { status: "uploading", loaded: 0, total: item.size, error: null });
      uploadFile(item.file, {
        signal: controller.signal,
        onProgress: (loaded, total) => update(item.key, { loaded, total: total || item.size }),
      })
        .then((upload) => update(item.key, { status: "done", upload, loaded: item.size, total: item.size }))
        .catch((error) => {
          if (error?.name === "AbortError") update(item.key, { status: "cancelled", loaded: 0 });
          else update(item.key, { status: "error", error: explainUploadError(error) });
        })
        .finally(() => {
          controllers.current.delete(item.key);
          started.current.delete(item.key);
        });
    },
    [update],
  );

  // Pump: keep up to `concurrency` uploads running.
  useEffect(() => {
    const running = items.filter((item) => item.status === "uploading").length;
    const free = Math.max(0, concurrency - running);
    items
      .filter((item) => item.status === "queued" && !started.current.has(item.key))
      .slice(0, free)
      .forEach(start);
  }, [items, concurrency, start]);

  const add = useCallback(
    (files, { role } = {}) => {
      const limit = limitRef.current;
      const next = Array.from(files).map((file) => {
        const ext = extOf(file.name);
        const allowed = ALLOWED_EXTS.includes(ext);
        // Refused before sending: an oversized file would otherwise upload
        // for minutes only to be answered with 413.
        const tooBig = allowed && limit > 0 && file.size > limit;
        return {
          key: nextKey(),
          file,
          name: file.name,
          ext,
          size: file.size,
          status: allowed && !tooBig ? "queued" : "error",
          loaded: 0,
          total: file.size,
          upload: null,
          error: !allowed
            ? {
                code: "unsupported_media",
                retry: false,
                message: `Formato ${ext ? `.${ext}` : "sem extensão"} não permitido. Envie imagens, vetores, vídeos, PDF, fontes ou arquivos de design.`,
              }
            : tooBig
              ? {
                  code: "payload_too_large",
                  retry: false,
                  message: `Acima do limite de ${formatBytes(limit)}. Envie uma versão menor ou compacte o arquivo.`,
                }
              : null,
          role: role ?? defaultRole ?? (isEditableExt(ext) ? "editable" : "original"),
          title: titleFromFilename(file.name),
          preview: isImageExt(ext) && typeof URL !== "undefined" ? URL.createObjectURL(file) : null,
          saved: null,
        };
      });
      setItems((list) => [...list, ...next]);
      return next;
    },
    [defaultRole],
  );

  const cancel = useCallback((key) => controllers.current.get(key)?.abort(), []);

  const retry = useCallback(
    (key) => update(key, (item) => (item.error?.retry === false ? {} : { status: "queued", error: null, loaded: 0 })),
    [update],
  );

  const discard = (item) => {
    if (item?.upload?.id && !item.saved) api.del(`/uploads/${item.upload.id}`).catch(() => {});
    if (item?.preview) URL.revokeObjectURL(item.preview);
  };

  const remove = useCallback((key) => {
    const item = itemsRef.current.find((entry) => entry.key === key);
    controllers.current.get(key)?.abort();
    discard(item);
    setItems((list) => list.filter((entry) => entry.key !== key));
  }, []);

  const reset = useCallback(() => {
    for (const item of itemsRef.current) {
      controllers.current.get(item.key)?.abort();
      discard(item);
    }
    setItems([]);
  }, []);

  // Drops items that now belong to a material (no discard call).
  const forget = useCallback((keys) => {
    const drop = new Set(keys);
    for (const item of itemsRef.current) if (drop.has(item.key) && item.preview) URL.revokeObjectURL(item.preview);
    itemsRef.current = itemsRef.current.filter((item) => !drop.has(item.key));
    setItems((list) => list.filter((item) => !drop.has(item.key)));
  }, []);

  const setOrder = useCallback((keys) => {
    setItems((list) => {
      const map = new Map(list.map((item) => [item.key, item]));
      const ordered = keys.map((key) => map.get(key)).filter(Boolean);
      return [...ordered, ...list.filter((item) => !keys.includes(item.key))];
    });
  }, []);

  // Uploads never attached to a material are discarded when the page closes.
  useEffect(
    () => () => {
      for (const item of itemsRef.current) {
        controllers.current.get(item.key)?.abort();
        discard(item);
      }
    },
    [],
  );

  const busy = items.some((item) => item.status === "uploading" || item.status === "queued");
  const unsaved = items.some((item) => item.status === "done" && !item.saved);
  useEffect(() => {
    if (!busy && !unsaved) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, unsaved]);

  return { items, add, cancel, retry, remove, reset, forget, update, setOrder, busy, unsaved };
}

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { api, isAbort, messageFor, NETWORK_MESSAGE } from "./client.js";
import { useToast } from "../ui/index.js";
import { useTopModal } from "../ui/layer.js";
import DownloadTray from "./DownloadCenter.jsx";

const ACTIVE = new Set(["queued", "running"]);
const FINAL = new Set(["ready", "failed", "expired"]);
const FIRST_POLL = 700;
const MAX_POLL = 2000;
const HANDLED_KEY = "metta:zips:handled";
const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;
// Server 404 messages that say nothing specific (scope checks): the page
// shows its own sentence for those, and the server's for the rest.
const GENERIC_NOT_FOUND = new Set([
  "Não encontramos este item.",
  "Endereço não encontrado.",
  messageFor("not_found"),
]);

export const isActiveJob = (job) => ACTIVE.has(job.status);

// 0–100 from the server's real byte progress (null before it is known).
export function zipJobPercent(job) {
  if (!job) return null;
  if (job.status === "ready") return 100;
  const value = Number.isFinite(job.progress)
    ? job.progress
    : job.totalBytes > 0
      ? (job.processedBytes || 0) / job.totalBytes
      : null;
  return value === null ? null : Math.round(Math.max(0, Math.min(1, value)) * 100);
}

export function downloadErrorMessage(error) {
  switch (error?.code) {
    case "download_disabled":
    case "font_license":
    case "expired":
      return error.message || messageFor(error.code);
    case "not_found":
      // e.g. "O arquivo não está mais disponível no armazenamento."
      return error.message && !GENERIC_NOT_FOUND.has(error.message)
        ? error.message
        : "Este arquivo não está disponível para você.";
    case "network":
      return NETWORK_MESSAGE;
    default:
      return error?.message || messageFor("internal");
  }
}

// Starts the browser download from a same-origin URL without buffering the file
// in memory; the server answers with Content-Disposition: attachment.
// container: the open modal dialog, if any (the rest of the page is inert).
export function triggerDownload(url, name, container) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name || "";
  link.rel = "noopener";
  link.style.display = "none";
  (container?.isConnected ? container : document.body).appendChild(link);
  link.click();
  link.remove();
}

export async function requestFileLink(fileId) {
  return api.post("/downloads/link", { fileId });
}

function readHandled() {
  try {
    return new Set(JSON.parse(localStorage.getItem(HANDLED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveHandled(set) {
  try {
    localStorage.setItem(HANDLED_KEY, JSON.stringify([...set].slice(-60)));
  } catch {
    /* storage unavailable: the tray just forgets dismissed jobs */
  }
}

// Same package request? (type and ids; the label does not matter)
const sameList = (a, b) => {
  const left = [...new Set(a || [])].sort();
  const right = [...new Set(b || [])].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};
export function sameZipScope(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("label");
  for (const key of keys) {
    if (Array.isArray(a[key]) || Array.isArray(b[key])) {
      if (!sameList(a[key], b[key])) return false;
    } else if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  return true;
}

const DownloadContext = createContext(null);

// enabled=false (roles without files, e.g. finance) skips resuming ZIP jobs.
export function DownloadCenterProvider({ children, enabled = true }) {
  const toast = useToast();
  const [jobs, setJobs] = useState([]);
  const [pending, setPending] = useState({});
  // Jobs resumed from an earlier visit start collapsed (a short bar, not a
  // panel over the page on phones); a ZIP started now opens the tray.
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // While a modal <dialog> is open everything outside it is inert and under
  // its backdrop: jobs started from inside it (and the live region) render in
  // that dialog, like the toasts do.
  const topModal = useTopModal();
  const topRef = useRef(topModal);
  topRef.current = topModal;
  const engine = useRef(null);

  if (!engine.current) {
    const timers = new Map();
    const autoDownload = new Set();
    const handled = readHandled();
    const state = { alive: true, jobs: [] };

    // state.jobs is the synchronous source of truth; React state mirrors it.
    const commit = (next) => {
      state.jobs = next;
      setJobs(next);
    };
    const withPercent = (job) => ({ ...job, percent: zipJobPercent(job) });
    const upsert = (patch) => {
      const list = state.jobs;
      const index = list.findIndex((job) => job.id === patch.id);
      commit(
        index === -1
          ? [withPercent(patch), ...list]
          : list.map((job, i) => (i === index ? withPercent({ ...job, ...patch }) : job)),
      );
    };
    const find = (id) => state.jobs.find((job) => job.id === id);
    const stop = (id) => {
      clearTimeout(timers.get(id));
      timers.delete(id);
    };
    const announce = (job) => {
      const label = job.label || "Pacote ZIP";
      if (job.status === "ready") setAnnouncement(`${label}: ZIP pronto para baixar.`);
      else if (job.status === "failed") setAnnouncement(`${label}: não foi possível gerar o ZIP.`);
      else if (job.status === "expired") setAnnouncement(`${label}: ${job.error || "o ZIP expirou."}`);
    };

    const fetchZip = async (id) => {
      const job = find(id);
      upsert({ id, linking: true });
      try {
        const { url } = await api.post(`/zips/${id}/link`);
        triggerDownload(url, job?.filename, topRef.current);
        handled.add(id);
        saveHandled(handled);
        upsert({ id, linking: false, downloadedAt: new Date().toISOString() });
      } catch (error) {
        if (!state.alive) return;
        if (error.code === "expired") {
          // the server re-checked the package (content changed, file gone):
          // the entry turns expired with the reason and offers a retry
          const patch = { id, linking: false, status: "expired", error: error.message || null };
          upsert(patch);
          announce({ ...find(id), ...patch });
        } else {
          upsert({ id, linking: false });
          toastRef.current?.error?.(downloadErrorMessage(error));
        }
      }
    };

    const settle = (job) => {
      stop(job.id);
      announce({ ...job, ...find(job.id) });
      if (job.status === "ready" && autoDownload.has(job.id)) {
        autoDownload.delete(job.id);
        fetchZip(job.id);
      }
    };

    const poll = (id, delay = FIRST_POLL) => {
      stop(id);
      timers.set(
        id,
        setTimeout(async () => {
          try {
            const { job } = await api.get(`/zips/${id}`);
            if (!state.alive || !find(id)) return;
            upsert({ ...job, offline: false });
            if (FINAL.has(job.status)) settle(job);
            else poll(id, Math.min(Math.round(delay * 1.4), MAX_POLL));
          } catch (error) {
            if (!state.alive || !find(id)) return;
            if (error.code === "network") {
              upsert({ id, offline: true });
              poll(id, MAX_POLL);
            } else {
              const failed = {
                id,
                status: error.code === "expired" ? "expired" : "failed",
                error:
                  error.code === "not_found"
                    ? "Este pacote não está mais disponível."
                    : error.message,
              };
              upsert(failed);
              settle(failed);
            }
          }
        }, delay),
      );
    };

    // scope: POST /api/zips scope. label: how the page names the package; the
    // server keeps it for mixed selections and names everything else from
    // what the ZIP really holds (the same name after a reload).
    // -> the tray entry ({ id, status, progress, percent, label, … }) or null
    const startZip = async (scope, { label } = {}) => {
      try {
        const body = { scope };
        if (label) body.label = String(label).trim().slice(0, 80);
        const { job } = await api.post("/zips", body);
        const entry = { ...job, label: job.label || label, scope: job.scope || scope, host: topRef.current };
        upsert(entry);
        setOpen(true);
        setAnnouncement(`${entry.label || "Pacote ZIP"}: preparando o ZIP.`);
        autoDownload.add(job.id);
        if (FINAL.has(job.status)) settle(job);
        else poll(job.id);
        return find(job.id) || entry;
      } catch (error) {
        if (!isAbort(error))
          toastRef.current?.error?.(
            error.code === "not_found"
              ? "Não encontramos arquivos disponíveis para este pacote."
              : error.message,
          );
        return null;
      }
    };

    const dismiss = (id) => {
      stop(id);
      autoDownload.delete(id);
      handled.add(id);
      saveHandled(handled);
      commit(state.jobs.filter((job) => job.id !== id));
    };

    const retry = async (job) => {
      if (!job.scope) return null;
      dismiss(job.id);
      return startZip(job.scope, { label: job.scope.label });
    };

    const clearFinished = () => {
      for (const job of state.jobs)
        if (!ACTIVE.has(job.status)) {
          handled.add(job.id);
          stop(job.id);
        }
      saveHandled(handled);
      commit(state.jobs.filter((job) => ACTIVE.has(job.status)));
    };

    // Picks up jobs from a previous page load: running ones keep their tray
    // entry; recent ready ones stay available until downloaded or dismissed.
    const resume = async () => {
      try {
        const data = await api.get("/zips");
        if (!state.alive) return;
        const items = data?.items || data?.jobs || [];
        const now = Date.now();
        for (const job of items.slice().reverse()) {
          if (handled.has(job.id) || find(job.id)) continue;
          const finished = Date.parse(job.finishedAt || job.createdAt || 0);
          const expires = job.expiresAt ? Date.parse(job.expiresAt) : Infinity;
          if (ACTIVE.has(job.status)) {
            upsert(job);
            poll(job.id);
          } else if (
            job.status === "ready" &&
            expires > now &&
            now - finished < RESUME_WINDOW_MS
          )
            upsert(job);
        }
      } catch {
        /* the tray stays empty when the endpoint is unavailable */
      }
    };

    engine.current = {
      state,
      timers,
      startZip,
      fetchZip,
      dismiss,
      retry,
      clearFinished,
      resume,
    };
  }

  useEffect(() => {
    const current = engine.current;
    current.state.alive = true;
    if (enabled) current.resume();
    return () => {
      current.state.alive = false;
      for (const id of current.timers.keys()) clearTimeout(current.timers.get(id));
      current.timers.clear();
    };
  }, [enabled]);

  // A modal opening or closing moves the live region: start it empty so an
  // old message is not read again.
  useEffect(() => {
    setAnnouncement("");
  }, [topModal]);

  const downloadFile = useCallback(async (fileId, { name } = {}) => {
    setPending((map) => ({ ...map, [fileId]: true }));
    try {
      const { url } = await requestFileLink(fileId);
      triggerDownload(url, name, topRef.current);
      return true;
    } catch (error) {
      if (!isAbort(error)) toastRef.current?.error?.(downloadErrorMessage(error));
      return false;
    } finally {
      setPending((map) => {
        const next = { ...map };
        delete next[fileId];
        return next;
      });
    }
  }, []);

  const value = useMemo(() => {
    const { startZip, dismiss, retry, clearFinished, fetchZip } = engine.current;
    return {
      // tray entries, newest first: { id, status, progress (0–1), percent
      // (0–100 | null), label, filename, fileCount, error, linking, scope, … }
      jobs,
      // latest entry for a package request (same type and ids), or null
      findJob: (scope) => jobs.find((job) => sameZipScope(job.scope, scope)) || null,
      downloadFile,
      startZip,
      // Several files: one goes straight to the browser, more become a ZIP.
      downloadFiles: (fileIds, { label, name } = {}) =>
        fileIds.length === 1
          ? downloadFile(fileIds[0], { name })
          : startZip({ type: "selection", fileIds }, { label }),
      downloadZip: (id) => fetchZip(id),
      isDownloading: (fileId) => Boolean(pending[fileId]),
      dismissJob: dismiss,
      retryJob: retry,
      clearFinished,
      trayOpen: open,
      setTrayOpen: setOpen,
    };
  }, [jobs, pending, open, downloadFile]);

  const trayProps = {
    open,
    onToggle: () => setOpen((current) => !current),
    onDownload: (job) => engine.current.fetchZip(job.id),
    onRetry: (job) => engine.current.retry(job),
    onDismiss: (id) => engine.current.dismiss(id),
    onClear: () => engine.current.clearFinished(),
  };
  // Once a ZIP is started from the open modal the whole list moves into it
  // (one tray, above the backdrop). Otherwise the page keeps its tray, under
  // the backdrop, so it never covers the modal's own buttons on phones.
  const hosting = Boolean(topModal) && jobs.some((job) => job.host === topModal);
  const modalJobs = hosting ? jobs : [];
  const pageJobs = hosting ? [] : jobs;

  return createElement(
    DownloadContext.Provider,
    { value },
    children,
    createElement(DownloadTray, {
      ...trayProps,
      jobs: pageJobs,
      announcement: topModal ? "" : announcement,
    }),
    topModal
      ? createPortal(
          createElement(
            "div",
            { className: "app ui-portal dl-portal" },
            createElement(DownloadTray, { ...trayProps, jobs: modalJobs, announcement }),
          ),
          topModal,
        )
      : null,
  );
}

// Outside the provider (e.g. an access page) single downloads still work;
// ZIPs need the tray and report it instead of failing silently.
const fallback = {
  jobs: [],
  findJob: () => null,
  downloadFile: async (fileId, { name } = {}) => {
    try {
      const { url } = await requestFileLink(fileId);
      triggerDownload(url, name);
      return true;
    } catch {
      return false;
    }
  },
  startZip: async () => null,
  downloadFiles: async () => null,
  downloadZip: () => {},
  isDownloading: () => false,
  dismissJob: () => {},
  retryJob: async () => null,
  clearFinished: () => {},
  trayOpen: false,
  setTrayOpen: () => {},
};

export function useDownloads() {
  return useContext(DownloadContext) || fallback;
}

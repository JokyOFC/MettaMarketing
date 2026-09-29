import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api/client.js";

const isAbortError = (error) => error?.name === "AbortError";

// What useApi shows for `path` given its stored state. The state belongs to
// the path it was fetched for, and the fetch effect only runs after the render
// in which `path` changed, so that render must not see another endpoint's
// payload: a different path shows `initialData` and counts as loading. A null
// path pauses the hook and keeps the last payload (a closing drawer does not
// flash empty). Exported for tests.
export function resolveApiState(state, path, initialData) {
  const current = path === null || path === undefined || state.path === path;
  const data = current ? state.data : initialData;
  const pending = path ? (current ? state.pending : true) : false;
  const hasData = data !== undefined && data !== null;
  return {
    data,
    error: current ? state.error : null,
    loading: pending && !hasData,
    refreshing: pending && hasData,
  };
}

// Fetches `path` (null skips) and refetches when path, params or deps change.
// `loading` is true only while there is nothing to show yet; background
// reloads set `refreshing` and keep the previous data on screen. Changing the
// path (another record) clears the data from the very first render with the
// new path; changing only params keeps it.
export function useApi(path, { params, deps = [], initialData, keepPrevious = true } = {}) {
  const paramsKey = params ? JSON.stringify(params) : "";
  const [state, setState] = useState(() => ({
    data: initialData,
    error: null,
    pending: Boolean(path),
    path,
  }));
  const controllerRef = useRef(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const pathRef = useRef(path);
  pathRef.current = path;
  const initialRef = useRef(initialData);
  initialRef.current = initialData;
  const [nonce, setNonce] = useState(0);
  const waitersRef = useRef([]);

  useEffect(() => {
    if (!path) {
      setState((s) => ({ ...s, pending: false, error: null, path }));
      waitersRef.current.splice(0).forEach((w) => w.resolve(undefined));
      return undefined;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((s) => ({
      data: s.path === path && keepPrevious ? s.data : initialData,
      error: null,
      pending: true,
      path,
    }));
    api
      .get(path, { params: paramsRef.current, signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ data, error: null, pending: false, path });
        waitersRef.current.splice(0).forEach((w) => w.resolve(data));
      })
      .catch((error) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState((s) => ({ ...s, error, pending: false }));
        waitersRef.current.splice(0).forEach((w) => w.reject(error));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, paramsKey, nonce, ...deps]);

  const reload = useCallback(
    () =>
      new Promise((resolve, reject) => {
        waitersRef.current.push({ resolve, reject });
        setNonce((n) => n + 1);
      }),
    [],
  );

  // Updaters receive what is on screen for the current path (never another
  // path's payload) and the result is stored for the current path.
  const setData = useCallback((next) => {
    setState((s) => {
      const target = pathRef.current;
      const visible = resolveApiState(s, target, initialRef.current).data;
      return {
        ...s,
        data: typeof next === "function" ? next(visible) : next,
        path: target ?? s.path,
      };
    });
  }, []);

  const view = resolveApiState(state, path, initialData);
  return {
    data: view.data,
    error: view.error,
    loading: view.loading,
    refreshing: view.refreshing,
    reload,
    setData,
  };
}

// Wraps an async action with loading/error state. `run` resolves with the
// action result and rethrows failures so callers can toast or show fields.
export function useMutation(fn, { onSuccess, onError } = {}) {
  const [state, setState] = useState({ loading: false, error: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const handlers = useRef({ onSuccess, onError });
  handlers.current = { onSuccess, onError };
  const mounted = useRef(true);
  const inflight = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args) => {
    inflight.current += 1;
    setState({ loading: true, error: null });
    try {
      const result = await fnRef.current(...args);
      inflight.current -= 1;
      if (mounted.current) setState({ loading: inflight.current > 0, error: null });
      handlers.current.onSuccess?.(result, ...args);
      return result;
    } catch (error) {
      inflight.current -= 1;
      if (mounted.current) setState({ loading: inflight.current > 0, error });
      handlers.current.onError?.(error, ...args);
      throw error;
    }
  }, []);

  const reset = useCallback(() => setState({ loading: false, error: null }), []);
  return { run, loading: state.loading, error: state.error, reset };
}

export function useDebounced(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function useMediaQuery(query) {
  const subscribe = useCallback(
    (notify) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    [query],
  );
  const get = () =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false;
  return useSyncExternalStore(subscribe, get, () => false);
}

export const useReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");

// Phones and narrow tablets: tables become cards, dialogs become sheets.
export const useIsNarrow = () => useMediaQuery("(max-width: 759.98px)");

// Selection over a list of ids. Ids that leave the list are dropped.
export function useSelection(ids = []) {
  const [selected, setSelected] = useState(() => new Set());
  const idsKey = ids.join("\u0000");

  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const allowed = new Set(ids);
      let changed = false;
      const next = new Set();
      prev.forEach((id) => (allowed.has(id) ? next.add(id) : (changed = true)));
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const toggle = useCallback((id, force) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const on = force === undefined ? !next.has(id) : force;
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const set = useCallback((value) => {
    setSelected(value instanceof Set ? new Set(value) : new Set(value || []));
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const all = useCallback(() => setSelected(new Set(ids)), [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = ids.reduce((n, id) => n + (selected.has(id) ? 1 : 0), 0);
  const isAll = ids.length > 0 && count === ids.length;
  const isSome = count > 0 && !isAll;
  const toggleAll = useCallback(() => (isAll ? clear() : all()), [isAll, clear, all]);

  return useMemo(
    () => ({
      selected,
      ids: [...selected],
      count: selected.size,
      has: (id) => selected.has(id),
      toggle,
      set,
      clear,
      all,
      toggleAll,
      isAll,
      isSome,
    }),
    [selected, toggle, set, clear, all, toggleAll, isAll, isSome],
  );
}

// Clipboard with a textarea fallback for older browsers / insecure contexts.
export async function copyText(text) {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export const COPY_FAILED_MESSAGE = "Não foi possível copiar. Selecione o texto e copie manualmente.";

// { copy(text), copied, failed } — `copied` stays true for `ms` after a
// success; `failed` stays true for `ms` after the clipboard refused (both the
// async API and the legacy fallback), so the UI can say so instead of doing
// nothing. `copy` resolves true/false.
export function useCopy(ms = 1600) {
  const [status, setStatus] = useState(null); // null | "copied" | "failed"
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(
    async (text) => {
      const ok = await copyText(text);
      clearTimeout(timer.current);
      setStatus(ok ? "copied" : "failed");
      timer.current = setTimeout(() => setStatus(null), ok ? ms : Math.max(ms, 4000));
      return ok;
    },
    [ms],
  );
  return { copy, copied: status === "copied", failed: status === "failed" };
}

// Keeps the latest value of a callback without re-subscribing effects.
export function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

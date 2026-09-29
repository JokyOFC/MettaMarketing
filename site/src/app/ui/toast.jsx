import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Info, X } from "lucide-react";
import { useTopModal } from "./layer.js";

const ToastContext = createContext(null);
const DURATION = { success: 4000, info: 4000, error: 7000 };
const MAX = 4;
let seq = 0;

function CheckDraw() {
  return (
    <svg className="ui-toast__check" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M7.5 12.4l3 3 6-6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength="1"
      />
    </svg>
  );
}

function ToastItem({ toast, onDismiss }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration);
  const started = useRef(0);

  useEffect(() => {
    if (toast.leaving || paused || !toast.duration) return undefined;
    started.current = Date.now();
    const id = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current = Math.max(800, remaining.current - (Date.now() - started.current));
    };
  }, [paused, toast.leaving, toast.duration, toast.id, onDismiss]);

  const isError = toast.type === "error";
  return (
    <div
      className={`ui-toast ui-toast--${toast.type}`}
      data-state={toast.leaving ? "closing" : "open"}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
    >
      <span className="ui-toast__icon">
        {toast.type === "success" ? (
          <CheckDraw />
        ) : isError ? (
          <CircleAlert size={18} strokeWidth={1.4} aria-hidden="true" />
        ) : (
          <Info size={18} strokeWidth={1.4} aria-hidden="true" />
        )}
      </span>
      <div className="ui-toast__body">
        {toast.title && <strong>{toast.title}</strong>}
        {toast.message && <span>{toast.message}</span>}
      </div>
      {toast.action && (
        <button
          type="button"
          className="ui-toast__action"
          onClick={() => {
            toast.action.onClick?.();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="ui-toast__close"
        aria-label="Fechar aviso"
        onClick={() => onDismiss(toast.id)}
      >
        <X size={16} strokeWidth={1.4} aria-hidden="true" />
      </button>
    </div>
  );
}

// Toast stack (bottom-right; bottom-center on phones). While a modal is open
// the stack renders inside it, the only part of the page that is not inert.
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const topModal = useTopModal();

  const dismiss = useCallback((id) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 180);
  }, []);

  const push = useCallback((type, input, options = {}) => {
    const base =
      input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      !(input instanceof Error) &&
      !input.$$typeof
        ? input
        : { message: input instanceof Error || input?.message ? input.message : input };
    const toast = {
      id: ++seq,
      type,
      duration: DURATION[type],
      ...base,
      ...options,
    };
    if (!toast.message && type === "error")
      toast.message = "Algo não saiu como esperado. Tente de novo.";
    // Phones keep at most two stacked so the page underneath stays usable.
    const max = typeof window !== "undefined" && window.matchMedia?.("(max-width: 759.98px)").matches ? 2 : MAX;
    setToasts((list) => [...list.filter((t) => !t.leaving).slice(-(max - 1)), toast]);
    return toast.id;
  }, []);

  const api = useMemo(() => {
    const toast = (message, options) => push("info", message, options);
    toast.success = (message, options) => push("success", message, options);
    toast.error = (message, options) => push("error", message, options);
    toast.info = (message, options) => push("info", message, options);
    toast.dismiss = dismiss;
    return toast;
  }, [push, dismiss]);

  const host = typeof document !== "undefined" ? topModal || document.body : null;

  return (
    <ToastContext.Provider value={api}>
      {children}
      {host &&
        toasts.length > 0 &&
        createPortal(
          <div className="app ui-portal">
            <div className="ui-toasts" aria-label="Avisos">
              {toasts.map((toast) => (
                <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
              ))}
            </div>
          </div>,
          host,
        )}
    </ToastContext.Provider>
  );
}

const fallback = (() => {
  const warn = (message) => {
    if (import.meta.env?.DEV) console.warn("[ui] useToast() outside <ToastProvider>:", message);
  };
  const toast = (m) => warn(m);
  toast.success = warn;
  toast.error = warn;
  toast.info = warn;
  toast.dismiss = () => {};
  return toast;
})();

// toast("msg") · toast.success(msg) · toast.error(errorOrMsg) · toast.info(msg)
// Each accepts a string, an Error/ApiError or {title, message, action:{label,onClick}, duration}.
export function useToast() {
  return useContext(ToastContext) || fallback;
}

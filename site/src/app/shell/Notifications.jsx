import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, CheckCheck, RotateCcw } from "lucide-react";
import { api } from "../api/client.js";
import { formatRelative } from "../ui/format.js";
import { useDropdown } from "./useDropdown.js";

const POLL_MS = 60_000;
const MISSING = new Set([404, 405, 501]);

// Bell with the unread count (every 60 s and on focus) and the 8 latest
// notifications. Hides itself while the notifications API is not available.
export default function Notifications({ area }) {
  const navigate = useNavigate();
  const panelId = useId();
  const dropdown = useDropdown({ focusFirst: false });
  const [available, setAvailable] = useState(true);
  const [unread, setUnread] = useState(0);
  const [list, setList] = useState({ items: null, loading: false, error: null });
  const alive = useRef(true);

  const loadCount = useCallback(async (event) => {
    // Interval ticks skip hidden tabs; mount, focus and visibility changes always load.
    if (event === "tick" && document.visibilityState === "hidden") return;
    try {
      const data = await api.get("/notifications/unread-count");
      if (alive.current) setUnread(Number(data?.unread) || 0);
    } catch (error) {
      if (alive.current && MISSING.has(error.status)) setAvailable(false);
    }
  }, []);

  const loadList = useCallback(async () => {
    setList((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await api.get("/notifications", { params: { pageSize: 8 } });
      if (!alive.current) return;
      setList({ items: (data?.items || []).slice(0, 8), loading: false, error: null });
      if (Number.isFinite(data?.unread)) setUnread(data.unread);
    } catch (error) {
      if (!alive.current) return;
      if (MISSING.has(error.status)) setAvailable(false);
      setList((current) => ({ ...current, loading: false, error }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const onVisible = () => document.visibilityState === "visible" && loadCount();
    loadCount();
    const timer = setInterval(() => loadCount("tick"), POLL_MS);
    window.addEventListener("focus", loadCount);
    // Pages that read or change notifications (e.g. the notification center) announce it.
    window.addEventListener("metta:notifications", loadCount);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", loadCount);
      window.removeEventListener("metta:notifications", loadCount);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadCount]);

  useEffect(() => {
    if (dropdown.open) loadList();
  }, [dropdown.open, loadList]);

  if (!available) return null;

  const markRead = (item) => {
    if (item.readAt) return;
    setList((current) => ({
      ...current,
      items: current.items?.map((entry) =>
        entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry,
      ),
    }));
    setUnread((value) => Math.max(0, value - 1));
    api.post(`/notifications/${item.id}/read`).catch(() => {});
  };

  const open = (item) => {
    markRead(item);
    dropdown.close(false);
    if (item.link && item.link.startsWith("/") && !item.link.startsWith("//"))
      navigate(item.link);
  };

  const readAll = async () => {
    try {
      await api.post("/notifications/read-all");
      const now = new Date().toISOString();
      setUnread(0);
      setList((current) => ({
        ...current,
        items: current.items?.map((entry) => ({ ...entry, readAt: entry.readAt || now })),
      }));
    } catch {
      /* the list keeps its state; the next refresh shows the truth */
    }
  };

  const allPath = area === "client" ? "/painel/notificacoes" : "/admin/notificacoes";
  const badge = unread > 9 ? "9+" : String(unread);
  const { items, loading, error } = list;

  return (
    <div className="sh-dd" ref={dropdown.rootRef}>
      <button
        ref={dropdown.buttonRef}
        type="button"
        className={`sh-icon-btn ${unread ? "has-badge" : ""}`}
        aria-label={
          unread
            ? `Notificações, ${unread} ${unread === 1 ? "não lida" : "não lidas"}`
            : "Notificações"
        }
        aria-expanded={dropdown.open}
        aria-controls={dropdown.open ? panelId : undefined}
        onClick={dropdown.toggle}
      >
        <Bell size={19} strokeWidth={1.4} aria-hidden="true" />
        {unread > 0 && (
          <span className="sh-badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
      {dropdown.open && (
        <div
          ref={dropdown.panelRef}
          id={panelId}
          className="sh-panel sh-notifications"
          role="dialog"
          aria-label="Notificações recentes"
          onKeyDown={dropdown.onPanelKeyDown}
        >
          <header className="sh-panel-head">
            <strong>Notificações</strong>
            {unread > 0 && (
              <button type="button" className="sh-text-btn" onClick={readAll}>
                <CheckCheck size={15} strokeWidth={1.4} aria-hidden="true" />
                Marcar todas como lidas
              </button>
            )}
          </header>
          {loading && !items && (
            <div className="sh-notif-skeleton" aria-busy="true" aria-label="Carregando">
              {[0, 1, 2].map((i) => (
                <span key={i} className="sh-skel sh-skel-row" />
              ))}
            </div>
          )}
          {error && !items && (
            <div className="sh-panel-empty">
              <p>Não foi possível carregar as notificações.</p>
              <button type="button" className="sh-text-btn" onClick={loadList}>
                <RotateCcw size={15} strokeWidth={1.4} aria-hidden="true" />
                Tentar de novo
              </button>
            </div>
          )}
          {items && items.length === 0 && (
            <div className="sh-panel-empty">
              <p>Nenhuma notificação por aqui. Avisos de entregas, aprovações e briefings aparecem neste espaço.</p>
            </div>
          )}
          {items && items.length > 0 && (
            <ul className="sh-notif-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-dropdown-item
                    className={`sh-notif ${item.readAt ? "" : "is-unread"}`}
                    onClick={() => open(item)}
                  >
                    <span className="sh-notif-dot" aria-hidden="true" />
                    <span className="sh-notif-body">
                      <strong>{item.title}</strong>
                      {item.body && <span className="sh-notif-text">{item.body}</span>}
                      <time dateTime={item.createdAt}>
                        {formatRelative(item.createdAt)}
                        {item.readAt ? "" : " · não lida"}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <footer className="sh-panel-foot">
            <Link
              to={allPath}
              data-dropdown-item
              onClick={() => dropdown.close(false)}
            >
              Ver todas
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}

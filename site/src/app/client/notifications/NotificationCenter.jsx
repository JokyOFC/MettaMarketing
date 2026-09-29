import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ClipboardList,
  Download,
  FolderKanban,
  MessageSquare,
  PackageOpen,
  Receipt,
  UserPlus,
} from "lucide-react";
import { api } from "../../api/client.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  Segmented,
  SkeletonRows,
  formatDate,
  formatTime,
  useToast,
} from "../../ui/index.js";
import "../../admin/briefings/hub.css";

const PAGE_SIZE = 30;
const cx = (...parts) => parts.filter(Boolean).join(" ");

const TYPE_ICONS = [
  [/briefing/i, ClipboardList],
  [/order|payment|subscription|pedido|pagamento|assinatura|finance/i, Receipt],
  [/approv|aprova/i, CheckCheck],
  [/change|ajuste|comment|coment/i, MessageSquare],
  [/zip|download/i, Download],
  [/release|material|version|kit|entrega|deliver/i, PackageOpen],
  [/project|task|projeto|tarefa/i, FolderKanban],
  [/invite|user|team|convite/i, UserPlus],
];
const iconFor = (type) => TYPE_ICONS.find(([pattern]) => pattern.test(type || ""))?.[1] ?? Bell;
const internalLink = (link) => typeof link === "string" && link.startsWith("/") && !link.startsWith("//");

const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long" });
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

function dayLabel(iso) {
  const date = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Hoje";
  if (days === 1) return "Ontem";
  const name = weekday.format(date);
  const capital = name.charAt(0).toUpperCase() + name.slice(1);
  if (days > 1 && days < 7) return capital;
  return `${capital}, ${formatDate(date, { year: date.getFullYear() !== new Date().getFullYear() })}`;
}

function groupByDay(items) {
  const groups = [];
  for (const item of items) {
    const key = startOfDay(new Date(item.createdAt)).getTime();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.createdAt), items: [item] });
  }
  return groups;
}

// Lets the topbar bell refresh its unread count right away.
function pingBell() {
  window.dispatchEvent(new CustomEvent("metta:notifications"));
}

// Full notifications page for /painel/notificacoes and /admin/notificacoes.
export default function NotificationCenter({ area = "client" }) {
  usePageTitle("Notificações");
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const [state, setState] = useState({ items: [], total: 0, unread: 0, page: 0, loading: true, more: false, error: null });
  const [markingAll, setMarkingAll] = useState(false);
  const request = useRef(0);

  const load = useCallback(
    async (page = 1) => {
      const ticket = ++request.current;
      setState((s) => ({ ...s, loading: page === 1 && !s.items.length, more: page > 1, error: null }));
      try {
        const data = await api.get("/notifications", {
          params: { unread: filter === "unread" ? 1 : undefined, page, pageSize: PAGE_SIZE },
        });
        if (ticket !== request.current) return;
        setState((s) => {
          const seen = new Set(page === 1 ? [] : s.items.map((item) => item.id));
          const items = page === 1 ? data.items : [...s.items, ...data.items.filter((item) => !seen.has(item.id))];
          return { items, total: data.total, unread: data.unread, page, loading: false, more: false, error: null };
        });
      } catch (error) {
        if (ticket !== request.current) return;
        setState((s) => ({ ...s, loading: false, more: false, error }));
      }
    },
    [filter],
  );

  useEffect(() => {
    setState((s) => ({ ...s, items: [], page: 0, loading: true }));
    load(1);
  }, [load]);

  const markRead = async (item) => {
    if (item.readAt) return;
    const at = new Date().toISOString();
    setState((s) => ({
      ...s,
      unread: Math.max(0, s.unread - 1),
      items: s.items.map((entry) => (entry.id === item.id ? { ...entry, readAt: at } : entry)),
    }));
    try {
      const res = await api.post(`/notifications/${item.id}/read`);
      if (Number.isFinite(res?.unread)) setState((s) => ({ ...s, unread: res.unread }));
      pingBell();
    } catch {
      /* the next load shows the real state */
    }
  };

  const markAll = async () => {
    setMarkingAll(true);
    try {
      await api.post("/notifications/read-all");
      const at = new Date().toISOString();
      setState((s) => ({ ...s, unread: 0, items: s.items.map((entry) => ({ ...entry, readAt: entry.readAt || at })) }));
      toast.success("Todas as notificações foram marcadas como lidas.");
      pingBell();
    } catch (error) {
      toast.error(error);
    } finally {
      setMarkingAll(false);
    }
  };

  const { items, total, unread, loading, error } = state;
  const groups = groupByDay(items);
  const remaining = Math.max(0, total - items.length);

  return (
    <div className="hub-page hub-notifs-page">
      <PageHeader
        eyebrow="Avisos"
        title="Notificações"
        description={
          area === "client"
            ? "Entregas, pedidos de aprovação, briefings e avisos da equipe Metta."
            : "Tudo o que precisa da sua atenção: respostas de clientes, aprovações, ajustes e entregas."
        }
        actions={
          <Button icon={CheckCheck} onClick={markAll} loading={markingAll} disabled={!unread}>
            Marcar todas como lidas
          </Button>
        }
      />

      <div className="hub-toolbar">
        <Segmented
          aria-label="Filtrar notificações"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Todas" },
            { value: "unread", label: unread ? `Não lidas (${unread})` : "Não lidas" },
          ]}
        />
      </div>

      {loading && <SkeletonRows rows={6} columns={2} media label="Carregando notificações" />}
      {error && !items.length && <ErrorState error={error} onRetry={() => load(1)} />}

      {!loading && !error && items.length === 0 &&
        (filter === "unread" ? (
          <EmptyState
            icon={CheckCheck}
            title="Tudo em dia"
            description="Você leu todas as notificações. Novos avisos aparecem aqui e no sino do topo."
            action={
              <Button variant="ghost" size="sm" onClick={() => setFilter("all")}>
                Ver todas
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={BellOff}
            title="Nenhuma notificação ainda"
            description={
              area === "client"
                ? "Quando a equipe liberar materiais, pedir sua aprovação ou enviar um briefing, o aviso aparece aqui."
                : "Respostas de briefings, aprovações, pedidos de ajuste e entregas aparecem aqui."
            }
          />
        ))}

      {groups.length > 0 && (
        <div className="hub-feed">
          {groups.map((group, g) => (
            <section key={group.key} className="hub-feed__day" aria-labelledby={`hub-day-${group.key}`}>
              <h2 id={`hub-day-${group.key}`} className="hub-feed__label">
                {group.label}
              </h2>
              <ul className="hub-feed__list">
                {group.items.map((item, i) => {
                  const TypeIcon = iconFor(item.type);
                  const unreadItem = !item.readAt;
                  const content = (
                    <>
                      <span className="hub-notif__icon" aria-hidden="true">
                        <TypeIcon size={17} strokeWidth={1.4} />
                      </span>
                      <span className="hub-notif__body">
                        <span className="hub-notif__title">{item.title}</span>
                        {item.body && <span className="hub-notif__text">{item.body}</span>}
                      </span>
                      <time className="hub-notif__time" dateTime={item.createdAt}>
                        {formatTime(item.createdAt)}
                      </time>
                      {unreadItem && <span className="ui-sr-only">, não lida</span>}
                    </>
                  );
                  return (
                    <li
                      key={item.id}
                      className={cx("hub-notif", unreadItem && "is-unread", g === 0 && "ui-enter")}
                      style={g === 0 ? { "--i": Math.min(i, 8) } : undefined}
                    >
                      {internalLink(item.link) ? (
                        <Link className="hub-notif__main" to={item.link} onClick={() => markRead(item)}>
                          {content}
                        </Link>
                      ) : (
                        <button type="button" className="hub-notif__main" onClick={() => markRead(item)}>
                          {content}
                        </button>
                      )}
                      {unreadItem && (
                        <IconButton
                          label="Marcar como lida"
                          icon={Check}
                          size="sm"
                          variant="ghost"
                          className="hub-notif__mark"
                          onClick={() => markRead(item)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {remaining > 0 && (
            <div className="hub-feed__more">
              <Button onClick={() => load(state.page + 1)} loading={state.more}>
                Carregar mais ({remaining})
              </Button>
            </div>
          )}
          {error && items.length > 0 && (
            <p className="ui-inline-error" role="alert">
              {error.message}{" "}
              <button type="button" className="ui-link" onClick={() => load(state.page + 1)}>
                Tentar de novo
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

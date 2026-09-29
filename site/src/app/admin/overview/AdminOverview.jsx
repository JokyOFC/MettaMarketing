import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  Check,
  ClipboardList,
  FolderKanban,
  History,
  Landmark,
  MessageSquareWarning,
  Receipt,
  Repeat,
  ChartColumn,
  Send,
  Upload,
  Wallet,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  Panel,
  SkeletonRows,
  Stat,
  StatusBadge,
  formatDate,
  formatMoney,
  formatRelative,
  formatTime,
  plural,
  useApi,
} from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import { ActivityFeed, DateBlock } from "../activity/feed.jsx";
import { firstName, greeting, longDate } from "./lib.js";
import "./ov.css";

const cx = (...parts) => parts.filter(Boolean).join(" ");

const INTRO = {
  admin: "O que pede atenção hoje, em todos os clientes.",
  manager: "O que pede atenção nos clientes sob sua gestão.",
  designer: "Seus projetos, prazos e tarefas em um só lugar.",
  finance: "Cobranças e assinaturas em acompanhamento.",
};

// Tiles appear by capability (same rules as the API), so their skeletons
// show up in the right places before the numbers arrive.
function tileDefs(can, role, data) {
  const d = data || {};
  const overdue = d.overdueCount || 0;
  const tiles = [
    can("projects.view") && {
      key: "projects",
      label: "Projetos em andamento",
      value: d.projectsInProgress,
      icon: FolderKanban,
      to: "/admin/projetos?status=in_progress",
      hint: role === "designer" ? "Projetos em que você está" : "Com a equipe agora",
    },
    (can("materials.view") || can("projects.view")) && {
      key: "deliveries",
      label: "Entregas próximas",
      value: d.upcomingCount,
      icon: CalendarClock,
      tone: overdue ? "clay" : undefined,
      hint: overdue
        ? `Prazos e publicações em 14 dias · ${plural(overdue, "atrasada", "atrasadas")}`
        : "Prazos e datas de publicação nos próximos 14 dias",
    },
    can("materials.view") && {
      key: "approvals",
      label: "Aprovações pendentes",
      value: d.pendingApprovals,
      icon: BadgeCheck,
      tone: "amber",
      to: can("approvals.view") ? "/admin/aprovacoes?status=pending" : undefined,
      hint: "Com o cliente para decisão",
    },
    can("materials.view") && {
      key: "changes",
      label: "Ajustes solicitados",
      value: d.changesRequested,
      icon: MessageSquareWarning,
      tone: "clay",
      to: can("approvals.view") ? "/admin/aprovacoes?status=changes_requested" : undefined,
      hint: "Esperando nova versão da equipe",
    },
    can("materials.release") && {
      key: "release",
      label: "Aguardando liberação",
      value: d.awaitingRelease,
      icon: Send,
      tone: "teal",
      to: "/admin/biblioteca?visibility=internal_review",
      hint: "Em revisão interna",
    },
    can("briefings.view") && {
      key: "briefings",
      label: "Briefings aguardando",
      value: d.briefingsAwaiting,
      icon: ClipboardList,
      to: "/admin/briefings?status=awaiting_client,in_progress",
      hint: "Enviados e ainda sem resposta",
    },
    can("finance.view") && {
      key: "payments",
      label: "Pagamentos pendentes",
      value: d.paymentsPending,
      icon: Wallet,
      tone: d.paymentsFailed ? "red" : "amber",
      // "open" = awaiting payment or rejected by Mercado Pago (still owed)
      to: can("orders.view") ? "/admin/pedidos?status=open" : "/admin/financeiro",
      hint: d.paymentsPendingCents
        ? `${formatMoney(d.paymentsPendingCents)} em aberto${d.paymentsFailed ? ` · ${plural(d.paymentsFailed, "com falha", "com falha")}` : ""}`
        : "Nenhum valor em aberto",
    },
    can("finance.view") && {
      key: "subscriptions",
      label: "Assinaturas ativas",
      value: d.activeSubscriptions,
      icon: Repeat,
      to: can("orders.view") ? "/admin/pedidos" : "/admin/financeiro",
      hint: d.activeSubscriptionsCents ? `${formatMoney(d.activeSubscriptionsCents)} por mês` : "Sem cobrança recorrente ativa",
    },
  ].filter(Boolean);
  if (role === "designer") {
    const order = ["projects", "deliveries", "changes", "approvals", "briefings"];
    tiles.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  return tiles;
}

const TYPE_LABEL = { project: "Projeto", post: "Publicação", asset: "Material" };
const RECENT_LIMIT = 8;

// Where an item stands: in production, in internal review, with the client
// or back with the team (approved or published items leave the list).
function deliveryState(item) {
  const s = item.status ?? {};
  if (item.type === "project" || !s.visibility) return null;
  if (s.visibility === "draft") return "Em produção";
  if (s.visibility === "internal_review") return "Em revisão interna";
  if (s.approval === "pending") return "Com o cliente para aprovação";
  if (s.approval === "changes_requested") return "Ajustes solicitados";
  return null;
}

function dueLabel(item) {
  if (item.dateKind !== "planned") return `prazo ${formatDate(item.dueDate)}`;
  const time = item.post?.plannedTime ? ` às ${item.post.plannedTime.slice(0, 5)}` : "";
  return `publicação prevista para ${formatDate(item.dueDate)}${time}`;
}

function daysLate(date) {
  const [y, m, d] = date.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(1, Math.round((today - due) / 86_400_000));
}

function Deliveries({ items }) {
  if (!items.length)
    return (
      <EmptyState
        compact
        icon={Check}
        title="Nada pendente por aqui."
        description="Materiais e projetos com prazo e publicações previstas para os próximos 14 dias aparecem nesta lista."
      />
    );
  return (
    <ol className="ov-due">
      {items.map((item, index) => (
        <li key={`${item.type}-${item.id}`} className={cx("ov-due__item", "ui-enter", item.overdue && "is-overdue")} style={{ "--i": Math.min(index, 8) }}>
          <DateBlock date={item.dueDate} />
          <div className="ov-due__body">
            <Link to={item.link} className="ov-due__title ov-stretch">
              {item.title}
              <span className="ui-sr-only">, {dueLabel(item)}</span>
            </Link>
            <p className="ov-due__meta">
              <span>
                {TYPE_LABEL[item.type === "project" ? "project" : item.kind] ?? "Material"}
                {item.dateKind === "planned" && item.post?.plannedTime ? ` · ${item.post.plannedTime.slice(0, 5)}` : ""}
              </span>
              <span>
                {item.client.name}
                {item.brand.name !== item.client.name ? ` › ${item.brand.name}` : ""}
              </span>
              {deliveryState(item) && <span className="ov-due__state">{deliveryState(item)}</span>}
            </p>
          </div>
          <div className="ov-due__side">
            {item.overdue ? (
              <Badge tone="clay" dot size="sm">
                {daysLate(item.dueDate) === 1 ? "Atrasada há 1 dia" : `Atrasada há ${daysLate(item.dueDate)} dias`}
              </Badge>
            ) : (
              <span className="ov-due__when">{formatRelative(item.dueDate)}</span>
            )}
            {item.owner ? (
              <span className="ov-due__owner" title={item.owner.name}>
                <Avatar name={item.owner.name} size={22} decorative />
                <span>{firstName(item.owner.name)}</span>
              </span>
            ) : (
              <span className="ov-due__owner is-empty">Sem responsável</span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Tasks({ items }) {
  if (!items.length)
    return <EmptyState compact icon={Check} title="Nenhuma tarefa aberta." description="Tarefas atribuídas a você nos projetos aparecem aqui." />;
  return (
    <ol className="ov-tasks">
      {items.map((task, index) => (
        <li key={task.id} className={cx("ov-tasks__item", "ui-enter")} style={{ "--i": Math.min(index, 8) }}>
          <div className="ov-tasks__body">
            <Link to={task.link} className="ov-tasks__title ov-stretch">
              {task.title}
            </Link>
            <p className="ov-tasks__meta">
              {task.project.name} · {task.brand.name}
            </p>
          </div>
          <div className="ov-tasks__side">
            <StatusBadge kind="task" value={task.status} size="sm" />
            {task.dueDate && (
              <span className={cx("ov-tasks__due", task.overdue && "is-late")}>
                {task.overdue ? `Venceu ${formatRelative(task.dueDate)}` : `Prazo ${formatRelative(task.dueDate)}`}
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function FinanceShortcuts({ can, grid = false }) {
  const links = [
    can("orders.view") && { to: "/admin/pedidos", icon: Receipt, title: "Pedidos e assinaturas", text: "Cobranças avulsas e planos mensais." },
    can("finance.view") && { to: "/admin/financeiro", icon: Landmark, title: "Financeiro", text: "Pagamentos confirmados e integração." },
    can("reports.finance") && { to: "/admin/relatorios?aba=financeiro", icon: ChartColumn, title: "Relatório financeiro", text: "Recebido, pendente e falhas por mês." },
  ].filter(Boolean);
  return (
    <ul className={cx("ov-shortcuts", grid && "ov-shortcuts--grid")}>
      {links.map(({ icon: Glyph, ...link }, index) => (
        <li key={link.to} className="ui-enter" style={{ "--i": index }}>
          <Link to={link.to} className="ov-shortcut">
            <span className="ov-shortcut__icon" aria-hidden="true">
              <Glyph size={18} strokeWidth={1.4} />
            </span>
            <span className="ov-shortcut__text">
              <strong>{link.title}</strong>
              <span>{link.text}</span>
            </span>
            <ArrowRight className="ov-shortcut__go" size={16} strokeWidth={1.4} aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function AdminOverview() {
  usePageTitle("Visão geral");
  const { user, can } = useAuth();
  const { data, error, loading, refreshing, reload } = useApi("/admin/overview");
  const [updatedAt, setUpdatedAt] = useState(null);
  useEffect(() => {
    if (data) setUpdatedAt(new Date());
  }, [data]);

  const role = user?.role;
  const tiles = tileDefs(can, role, data);
  const numbers = tiles.map((tile) => tile.value).filter((value) => typeof value === "number");
  const allClear = Boolean(data) && numbers.length > 0 && numbers.every((value) => value === 0);
  const showTasks = Array.isArray(data?.myTasks) && (role === "designer" || data.myTasks.length > 0);
  const showDeliveries = can("materials.view") || can("projects.view");
  const showTasksPanel = loading ? role === "designer" : showTasks;
  const showShortcuts = can("finance.view");
  // Row 1: deliveries (wide) beside tasks and shortcuts (narrow); either side
  // alone takes the full width (finance has no delivery or task lists).
  const sideVisible = showTasksPanel || showShortcuts;
  const recent = data?.recentActivity ?? [];

  const actions = (
    <>
      {can("materials.upload") && (
        <Button variant="primary" icon={Upload} to="/admin/biblioteca/enviar">
          Enviar materiais
        </Button>
      )}
      {can("activity.view") && (
        <Button icon={History} to="/admin/historico">
          Histórico
        </Button>
      )}
    </>
  );

  return (
    <div className="ov-page">
      <PageHeader
        eyebrow={longDate()}
        title={`${greeting()},`}
        accent={firstName(user?.name) || "equipe"}
        description={INTRO[role] ?? INTRO.admin}
        actions={actions}
        meta={
          updatedAt && (
            <span className="ov-updated">
              <span aria-live="polite">{refreshing ? "Atualizando…" : `Atualizado às ${formatTime(updatedAt)}`}</span>
              <IconButton label="Atualizar números" icon="refresh" size="sm" variant="ghost" loading={refreshing} onClick={() => reload().catch(() => {})} />
            </span>
          )
        }
      />

      <section className="ov-section" aria-labelledby="ov-pending-title">
        <div className="ov-section__head">
          <p className="ui-eyebrow" id="ov-pending-title">
            Resumo das pendências
          </p>
          {allClear && (
            <p className="ov-allclear ui-enter">
              <Check size={16} strokeWidth={1.6} aria-hidden="true" /> Nada pendente por aqui.
            </p>
          )}
        </div>
        {error && !data ? (
          <ErrorState error={error} onRetry={() => reload().catch(() => {})} />
        ) : (
          <div className={cx("ov-stats", `ov-stats--n${tiles.length}`, refreshing && "is-refreshing")}>
            {tiles.map((tile, index) => (
              <Stat
                key={tile.key}
                index={index}
                label={tile.label}
                value={tile.value}
                loading={loading}
                hint={loading ? undefined : tile.hint}
                icon={tile.icon}
                tone={tile.tone}
                to={tile.to}
              />
            ))}
          </div>
        )}
      </section>

      {!(error && !data) && (showDeliveries || sideVisible) && (
        <div className={cx("ov-columns", !(showDeliveries && sideVisible) && "ov-columns--single")}>
          {showDeliveries && (
            <div className="ov-col">
              <Panel
                index={2}
                eyebrow="Próximos 14 dias"
                title="Próximas entregas"
                description="Prazos de materiais e projetos e datas de publicação dos posts, atrasados primeiro."
              >
                {loading ? <SkeletonRows rows={4} columns={3} media /> : <Deliveries items={data?.upcomingDeliveries ?? []} />}
              </Panel>
            </div>
          )}
          {sideVisible && (
            <div className="ov-col">
              {showTasksPanel && (
                <Panel
                  index={3}
                  eyebrow="Atribuídas a você"
                  title="Minhas tarefas"
                  description={data?.myTasksTotal > (data?.myTasks?.length ?? 0) ? `Mostrando ${data.myTasks.length} de ${data.myTasksTotal}.` : undefined}
                >
                  {loading ? <SkeletonRows rows={3} columns={2} /> : <Tasks items={data.myTasks} />}
                </Panel>
              )}
              {showShortcuts && (
                <Panel index={4} eyebrow="Atalhos" title="Comercial e financeiro">
                  <FinanceShortcuts can={can} grid={!showDeliveries} />
                </Panel>
              )}
            </div>
          )}
        </div>
      )}

      {!(error && !data) && can("activity.view") && (
        <Panel
          index={5}
          eyebrow="Movimento"
          title="Atividade recente"
          description={recent.length ? "Os últimos registros do histórico, incluindo os downloads feitos pelos clientes." : undefined}
          footer={
            <Link to="/admin/historico" className="ov-more">
              Ver histórico completo <ArrowRight size={14} strokeWidth={1.4} aria-hidden="true" />
            </Link>
          }
        >
          {loading ? (
            <SkeletonRows rows={5} columns={2} media />
          ) : recent.length ? (
            <ActivityFeed items={recent.slice(0, RECENT_LIMIT)} />
          ) : (
            <EmptyState compact icon={History} title="Ainda não há movimento." description="Envios, liberações, aprovações e downloads aparecem aqui assim que acontecerem." />
          )}
        </Panel>
      )}
    </div>
  );
}

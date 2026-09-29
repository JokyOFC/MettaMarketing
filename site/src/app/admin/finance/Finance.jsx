import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  CircleCheck,
  CircleX,
  Hourglass,
  KeyRound,
  Landmark,
  PlugZap,
  RefreshCw,
  Repeat,
  ShieldAlert,
  ShieldCheck,
  Wallet,
  Webhook,
} from "lucide-react";
import {
  Badge,
  Button,
  CopyButton,
  DataTable,
  ErrorState,
  Icon,
  PageHeader,
  Pagination,
  Panel,
  Select,
  Skeleton,
  Stat,
  StatusBadge,
  formatDateTime,
  formatMoney,
  formatRelative,
  monthLabel,
  plural,
  useApi,
  useReducedMotion,
} from "../../ui/index.js";
import { usePageTitle } from "../../shell/index.js";
import { Callout, cx } from "./common.jsx";
import "./fin.css";

const PAGE_SIZE = 20;

const PAYMENT_FILTERS = [
  { value: "approved", label: "Aprovados" },
  { value: "pending", label: "Em processamento" },
  { value: "failed", label: "Recusados ou cancelados" },
  { value: "refunded", label: "Estornados" },
];

const TOPIC_LABELS = {
  payment: "Pagamento",
  subscription_preapproval: "Assinatura",
  preapproval: "Assinatura",
  subscription_authorized_payment: "Mensalidade",
  authorized_payment: "Mensalidade",
  merchant_order: "Pedido do Mercado Pago",
};

function EventRow({ event, index }) {
  const known = Boolean(TOPIC_LABELS[event.topic]);
  let state;
  if (!event.signatureValid) state = { tone: "red", label: "Recusada" };
  else if (event.error) state = { tone: "red", label: "Com erro" };
  else if (!event.processedAt) state = { tone: "amber", label: "Processando" };
  else if (["payment", "subscription_preapproval", "preapproval", "subscription_authorized_payment", "authorized_payment"].includes(event.topic))
    state = { tone: "olive", label: "Confirmada na API" };
  else state = { tone: "neutral", label: "Sem ação" };
  return (
    <li className="fin-event ui-enter" style={{ "--i": Math.min(index, 8) }}>
      <span className={cx("fin-event__icon", event.signatureValid ? "is-valid" : "is-invalid")} aria-hidden="true">
        <Icon icon={event.signatureValid ? ShieldCheck : ShieldAlert} size={16} />
      </span>
      <div className="fin-event__main">
        <p className="fin-event__title">
          {known ? TOPIC_LABELS[event.topic] : event.topic || "Tópico não informado"}
          {event.resourceId && <span className="fin-event__id"> · Nº {event.resourceId}</span>}
        </p>
        <p className="fin-event__meta">
          <time dateTime={event.receivedAt} title={formatDateTime(event.receivedAt)}>
            {formatRelative(event.receivedAt)}
          </time>
          <span aria-hidden="true"> · </span>
          <span>{event.signatureValid ? "Assinatura válida" : "Assinatura inválida"}</span>
        </p>
        {event.error && <p className="fin-event__error">{event.error}</p>}
      </div>
      <Badge size="sm" tone={state.tone} dot>
        {state.label}
      </Badge>
    </li>
  );
}

function StatusRow({ icon, label, ok, okText, noText, hint }) {
  return (
    <div className="fin-mp__row">
      <span className="fin-mp__rowicon" aria-hidden="true">
        <Icon icon={icon} size={16} />
      </span>
      <span className="fin-mp__rowlabel">{label}</span>
      <span className={cx("fin-mp__rowvalue", ok ? "is-ok" : "is-missing")}>
        <Icon icon={ok ? CircleCheck : CircleX} size={14} />
        {ok ? okText : noText}
      </span>
      {hint && <span className="fin-mp__rowhint">{hint}</span>}
    </div>
  );
}

function MercadoPagoPanel({ status }) {
  const mp = status?.mercadopago;
  if (!mp)
    return (
      <div className="fin-mp__card">
        <Skeleton height={20} width={160} />
        <Skeleton height={14} />
        <Skeleton height={14} />
      </div>
    );
  return (
    <div className="fin-mp__card ui-enter">
      <p className="fin-mp__eyebrow">Integração</p>
      <h2 className="fin-mp__title" id="fin-mp-title">
        Mercado <em>Pago</em>
      </h2>
      <div className="fin-mp__rows">
        <StatusRow icon={KeyRound} label="Access Token" ok={mp.configured} okText="Configurado" noText="Não configurado" />
        {mp.configured && (
          <div className="fin-mp__row">
            <span className="fin-mp__rowicon" aria-hidden="true">
              <Icon icon={PlugZap} size={16} />
            </span>
            <span className="fin-mp__rowlabel">Modo</span>
            <span className={cx("fin-mp__rowvalue", mp.mode === "production" ? "is-ok" : "is-test")}>
              {mp.mode === "production" ? "Produção" : "Teste (sandbox)"}
            </span>
          </div>
        )}
        <StatusRow icon={ShieldCheck} label="Assinatura secreta" ok={mp.webhookSecretConfigured} okText="Configurada" noText="Não configurada" />
        <StatusRow icon={Webhook} label="Endereço público" ok={mp.publicUrl} okText="HTTPS público" noText="Local ou sem HTTPS" />
      </div>
      <div className="fin-mp__url">
        <span className="fin-mp__urllabel" id="fin-webhook-url">
          URL de notificação (webhook)
        </span>
        <div className="fin-mp__urlbox">
          <code aria-labelledby="fin-webhook-url">{mp.webhookUrl}</code>
          <CopyButton text={mp.webhookUrl} label="Copiar URL" className="fin-mp__copy" />
        </div>
      </div>
      {!mp.publicUrl && (
        <p className="fin-mp__warn">
          O Mercado Pago só entrega notificações a um endereço público com HTTPS. Em produção, defina <code>APP_URL</code> com o
          domínio da plataforma.
        </p>
      )}
      {mp.configured && !mp.webhookSecretConfigured && (
        <p className="fin-mp__warn">
          Sem a assinatura secreta, toda notificação é recusada por segurança e os pagamentos não são confirmados
          automaticamente. Use “Consultar Mercado Pago” no pedido enquanto isso.
        </p>
      )}
    </div>
  );
}

const STEPS = [
  {
    title: "Abra suas credenciais",
    text: "No painel de desenvolvedores do Mercado Pago, entre em Suas integrações, escolha a aplicação da Metta e abra Credenciais de produção (ou de teste, para homologar).",
  },
  {
    title: "Configure o Access Token",
    text: "Copie o Access Token e defina a variável MP_ACCESS_TOKEN no servidor. Tokens que começam com TEST- usam o ambiente de testes.",
  },
  {
    title: "Cadastre o webhook",
    text: "Em Webhooks › Configurar notificações, cole a URL de notificação ao lado e marque os eventos Pagamentos e Planos e assinaturas.",
  },
  {
    title: "Guarde a assinatura secreta",
    text: "O Mercado Pago gera uma assinatura secreta para os webhooks. Defina-a em MP_WEBHOOK_SECRET; sem ela, nenhuma notificação é aceita.",
  },
  {
    title: "Reinicie e teste",
    text: "Reinicie a aplicação, crie um pedido de valor baixo, gere o link e pague. A notificação aparece em Notificações recebidas e o pedido muda para Pago.",
  },
];

export default function Finance() {
  usePageTitle("Financeiro");
  const location = useLocation();
  const reduced = useReducedMotion();
  const summary = useApi("/finance/summary");
  const status = useApi("/finance/status");
  const events = useApi("/finance/webhooks", { params: { limit: 12 } });
  const [payStatus, setPayStatus] = useState("");
  const [page, setPage] = useState(1);
  const payments = useApi("/payments", { params: { status: payStatus || undefined, page, pageSize: PAGE_SIZE } });
  const mp = status.data?.mercadopago;
  const s = summary.data;

  useEffect(() => {
    if (location.hash !== "#mercado-pago" || !status.data) return;
    const target = document.getElementById("mercado-pago");
    target?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [location.hash, status.data, reduced]);

  const nothingYet =
    s && !s.receivable.count && !s.receivedThisMonth.count && !s.subscriptions.active && !s.subscriptions.pending && !s.drafts.count && payments.data?.total === 0;

  const columns = [
    {
      key: "target",
      header: "Referente a",
      primary: true,
      render: (p) => (
        <div className="fin-cell-two">
          <span className="fin-cell-two__main">{p.order?.description ?? p.subscription?.name ?? "Pagamento"}</span>
          <span className="fin-cell-two__sub">{p.client?.name ?? "Cliente não identificado"}</span>
        </div>
      ),
    },
    {
      key: "date",
      header: "Data",
      nowrap: true,
      sortable: true,
      sortValue: (p) => p.paidAt ?? p.updatedAt,
      render: (p) => formatDateTime(p.paidAt ?? p.updatedAt),
    },
    { key: "method", header: "Meio", hideOnMobile: true, render: (p) => p.methodLabel ?? "—" },
    {
      key: "status",
      header: "Status",
      render: (p) => (
        <div className="fin-cell-status">
          <StatusBadge kind="payment" value={p.status} size="sm" />
          {p.reason && p.status !== "approved" && <span className="fin-cell-status__reason">{p.reason}</span>}
        </div>
      ),
    },
    {
      key: "amount",
      header: "Valor",
      align: "end",
      nowrap: true,
      sortable: true,
      sortValue: (p) => p.amountCents ?? 0,
      render: (p) => <span className="fin-cell-money">{formatMoney(p.amountCents)}</span>,
    },
  ];

  return (
    <div className="fin-page">
      <PageHeader
        eyebrow="Financeiro e Mercado Pago"
        title="Cobranças e"
        accent="recebimentos"
        description="Valores e contagens reais, calculados a partir dos pedidos, assinaturas e pagamentos confirmados pelo Mercado Pago."
        actions={
          <Button icon={RefreshCw} onClick={() => Promise.all([summary.reload(), payments.reload(), events.reload()]).catch(() => {})}>
            Atualizar
          </Button>
        }
      />

      {mp && !mp.configured && (
        <Callout
          tone="amber"
          icon={PlugZap}
          title="Configure o Mercado Pago para cobrar online"
          className="fin-mb"
          index={0}
          actions={
            <Button size="sm" href="#mercado-pago" onClick={(event) => {
              event.preventDefault();
              document.getElementById("mercado-pago")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
            }}>
              Ver passo a passo
            </Button>
          }
        >
          Sem as credenciais, pedidos e assinaturas podem ser criados, mas nenhum link de pagamento é gerado.
        </Callout>
      )}

      {summary.error ? (
        <ErrorState error={summary.error} onRetry={summary.reload} />
      ) : (
        <div className="fin-stats">
          <Stat
            index={0}
            icon={Hourglass}
            tone="amber"
            label="A receber"
            loading={summary.loading}
            value={s && formatMoney(s.receivable.cents)}
            hint={
              s &&
              (s.receivable.count
                ? `${plural(s.receivable.count, "pedido em aberto", "pedidos em aberto")}${s.receivable.overdueCount ? ` · ${plural(s.receivable.overdueCount, "vencido", "vencidos")}` : ""}`
                : "Nenhuma cobrança em aberto")
            }
            to="/admin/pedidos?status=open"
          />
          <Stat
            index={1}
            icon={Wallet}
            tone="teal"
            label={s ? `Recebido em ${monthLabel(s.month, { year: false }).toLowerCase()}` : "Recebido no mês"}
            loading={summary.loading}
            value={s && formatMoney(s.receivedThisMonth.cents)}
            hint={
              s &&
              (s.receivedThisMonth.count
                ? plural(s.receivedThisMonth.count, "pagamento aprovado", "pagamentos aprovados")
                : "Nenhum pagamento aprovado neste mês")
            }
          />
          <Stat
            index={2}
            icon={Repeat}
            label="Assinaturas ativas"
            loading={summary.loading}
            value={s && s.subscriptions.active}
            hint={
              s &&
              (s.subscriptions.active
                ? `${formatMoney(s.subscriptions.monthlyCents)} por mês`
                : s.subscriptions.pending
                  ? plural(s.subscriptions.pending, "aguardando ativação", "aguardando ativação")
                  : "Nenhuma assinatura ativa")
            }
            to="/admin/pedidos?aba=assinaturas&status=active"
          />
          <Stat
            index={3}
            icon={CircleX}
            tone={s?.failures.recent ? "red" : undefined}
            label="Falhas recentes"
            loading={summary.loading}
            value={s && s.failures.recent}
            hint={
              s &&
              (s.failures.recent
                ? `Recusados nos últimos 30 dias${s.failures.failedOrders ? ` · ${plural(s.failures.failedOrders, "pedido para nova tentativa", "pedidos para nova tentativa")}` : ""}`
                : "Nenhum pagamento recusado nos últimos 30 dias")
            }
            to="/admin/pedidos?status=failed"
          />
        </div>
      )}

      {nothingYet && (
        <Callout tone="neutral" icon={Landmark} title="Ainda não há movimento financeiro" className="fin-mb" index={1}>
          Os números acima começam a aparecer quando você cria pedidos ou assinaturas em Pedidos e assinaturas e o Mercado Pago
          confirma os pagamentos.
        </Callout>
      )}

      <Panel
        index={2}
        className="fin-block"
        eyebrow="Movimento"
        title="Pagamentos"
        description="Cada tentativa registrada pelo Mercado Pago, com o motivo quando não é aprovada."
        actions={
          <Select
            aria-label="Filtrar pagamentos por status"
            size="sm"
            value={payStatus}
            placeholder="Todos os status"
            options={PAYMENT_FILTERS}
            onValueChange={(value) => {
              setPayStatus(value);
              setPage(1);
            }}
          />
        }
      >
        <DataTable
          bare
          caption="Pagamentos"
          columns={columns}
          rows={payments.data?.items ?? []}
          loading={payments.loading}
          error={payments.error}
          onRetry={payments.reload}
          rowLabel={(p) => p.order?.description ?? p.subscription?.name ?? p.id}
          empty={{
            icon: Wallet,
            title: payStatus ? "Nenhum pagamento neste filtro" : "Nenhum pagamento registrado",
            description: payStatus
              ? "Escolha outro status para ver mais pagamentos."
              : "Os pagamentos aparecem aqui quando o Mercado Pago confirma uma cobrança de pedido ou assinatura.",
          }}
        />
        {payments.data && (
          <Pagination page={page} pageSize={PAGE_SIZE} total={payments.data.total} onChange={setPage} />
        )}
      </Panel>

      <section id="mercado-pago" className="fin-mp" aria-labelledby="fin-mp-title">
        <MercadoPagoPanel status={status.data} />
        <div className="fin-mp__steps ui-enter" style={{ "--i": 1 }}>
          <p className="ui-eyebrow">Passo a passo</p>
          <h3 className="fin-mp__stepstitle">
            Como ligar os <em>pagamentos</em>
          </h3>
          <ol className="fin-steps">
            {STEPS.map((step, index) => (
              <li key={step.title} className="fin-steps__item">
                <span className="fin-steps__num" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <p className="fin-steps__title">{step.title}</p>
                  <p className="fin-steps__text">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          {status.error && <ErrorState compact error={status.error} onRetry={status.reload} />}
        </div>
      </section>

      <Panel
        className="fin-block"
        eyebrow="Webhooks"
        title="Notificações recebidas"
        description="As últimas notificações do Mercado Pago. Nada muda antes de a plataforma confirmar o pagamento na API."
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={Boolean(events.refreshing)} onClick={() => events.reload().catch(() => {})}>
            Atualizar
          </Button>
        }
      >
        {events.loading ? (
          <div className="fin-stack">
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        ) : events.error ? (
          <ErrorState compact error={events.error} onRetry={events.reload} />
        ) : events.data?.items.length ? (
          <ul className="fin-events">
            {events.data.items.map((event, index) => (
              <EventRow key={event.id} event={event} index={index} />
            ))}
          </ul>
        ) : (
          <p className="fin-quiet">
            Nenhuma notificação recebida ainda. Depois de cadastrar a URL no Mercado Pago, cada pagamento gera uma notificação
            que aparece aqui com a validação da assinatura.
          </p>
        )}
        {events.data?.total > (events.data?.items.length ?? 0) && (
          <p className="fin-hint">Mostrando as {events.data.items.length} mais recentes de {events.data.total}.</p>
        )}
      </Panel>
    </div>
  );
}

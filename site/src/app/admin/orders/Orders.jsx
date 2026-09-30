import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Receipt, Repeat } from "lucide-react";
import {
  Badge,
  Button,
  DataTable,
  FilterBar,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  Tabs,
  formatDate,
  formatMoney,
  statusOptions,
  useApi,
} from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import { Callout } from "../finance/common.jsx";
import NewOrderDrawer from "./NewOrderDrawer.jsx";
import NewSubscriptionDrawer from "./NewSubscriptionDrawer.jsx";
import OrderDrawer from "./OrderDrawer.jsx";
import SubscriptionDrawer from "./SubscriptionDrawer.jsx";
import "../finance/fin.css";

const PAGE_SIZE = 25;

function withCount(options, counts) {
  if (!counts) return options;
  return options.map((option) =>
    counts[option.value] !== undefined ? { ...option, label: `${option.label} (${counts[option.value]})` } : option,
  );
}

const ORDER_STATUS = [
  { value: "open", label: "Em aberto" },
  { value: "overdue", label: "Vencidos" },
  ...statusOptions("order"),
];
const SUBSCRIPTION_STATUS = statusOptions("subscription");

function ClientCell({ client, sub }) {
  return (
    <div className="fin-cell-two">
      <span className="fin-cell-two__main">{client.name}</span>
      {sub && <span className="fin-cell-two__sub">{sub}</span>}
    </div>
  );
}

// Contract status of an order/subscription (AssinaVelox).
function ContractCell({ item }) {
  if (item.contract && !["refused", "expired", "canceled"].includes(item.contract.status))
    return <StatusBadge kind="contract" value={item.contract.status} size="sm" />;
  if (item.contractWaiver)
    return (
      <Badge size="sm" tone="slate">
        Dispensado
      </Badge>
    );
  if (item.contractRequired)
    return (
      <Badge size="sm" tone="amber" dot>
        A gerar
      </Badge>
    );
  // Site purchase: the contract follows the payment.
  if (item.contractAfterPayment)
    return ["paid", "active", "paused"].includes(item.status) ? (
      <Badge size="sm" tone="amber" dot>
        A gerar
      </Badge>
    ) : (
      <Badge size="sm" tone="slate">
        Após o pagamento
      </Badge>
    );
  return <span className="fin-quiet">—</span>;
}

export default function Orders() {
  usePageTitle("Pedidos e assinaturas");
  const { can } = useAuth();
  const canManage = can("orders.manage");
  const canFinance = can("finance.view");
  const [params, setParams] = useSearchParams();
  const tab = params.get("aba") === "assinaturas" ? "subscriptions" : "orders";
  const clientId = params.get("clientId") ?? "";
  const status = params.get("status") ?? "";
  const q = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const orderId = params.get("pedido");
  const subscriptionId = params.get("assinatura");
  const [creating, setCreating] = useState(null);

  const update = (patch, { keepPage = false } = {}) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === undefined || value === "") next.delete(key);
          else next.set(key, String(value));
        }
        if (!keepPage && !("page" in patch)) next.delete("page");
        return next;
      },
      { replace: true },
    );

  const listParams = { clientId: clientId || undefined, status: status || undefined, q: q || undefined, page, pageSize: PAGE_SIZE };
  const orders = useApi(tab === "orders" ? "/orders" : null, { params: listParams });
  const subscriptions = useApi(tab === "subscriptions" ? "/subscriptions" : null, { params: listParams });
  const list = tab === "orders" ? orders : subscriptions;
  const options = useApi("/commerce/options");
  const mpStatus = useApi("/finance/status");
  const mp = mpStatus.data?.mercadopago;

  const clientOptions = useMemo(
    () =>
      (options.data?.clients ?? []).map((client) => ({
        value: client.id,
        label: client.status === "archived" ? `${client.name} (arquivado)` : client.name,
      })),
    [options.data],
  );
  const filtered = Boolean(clientId || status || q);
  const activeCount = (clientId ? 1 : 0) + (status ? 1 : 0);

  const orderColumns = [
    {
      key: "client",
      header: "Cliente",
      primary: true,
      sortable: true,
      sortValue: (o) => o.client.name,
      render: (o) => <ClientCell client={o.client} sub={o.brand?.name} />,
    },
    {
      key: "description",
      header: "Descrição",
      render: (o) => (
        <div className="fin-cell-two">
          <span className="fin-cell-two__main">{o.description}</span>
          {o.service && <span className="fin-cell-two__sub">{o.service.name}</span>}
        </div>
      ),
    },
    {
      key: "amount",
      header: "Valor",
      align: "end",
      nowrap: true,
      sortable: true,
      sortValue: (o) => o.amountCents,
      render: (o) => <span className="fin-cell-money">{formatMoney(o.amountCents)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (o) => (
        <div className="fin-cell-status">
          <span className="fin-cell-status__badges">
            <StatusBadge kind="order" value={o.status} size="sm" />
            {o.overdue && (
              <Badge size="sm" tone="red">
                Vencido
              </Badge>
            )}
          </span>
          {o.status === "failed" && o.failureReason && <span className="fin-cell-status__reason">{o.failureReason}</span>}
        </div>
      ),
    },
    { key: "contract", header: "Contrato", hideOnMobile: true, render: (o) => <ContractCell item={o} /> },
    {
      key: "createdAt",
      header: "Criado",
      nowrap: true,
      hideOnMobile: true,
      sortable: true,
      sortValue: (o) => o.createdAt,
      render: (o) => formatDate(o.createdAt),
    },
    {
      key: "dueDate",
      header: "Vencimento",
      nowrap: true,
      sortable: true,
      sortValue: (o) => o.dueDate ?? "",
      render: (o) =>
        o.dueDate ? <span className={o.overdue ? "fin-overdue" : undefined}>{formatDate(o.dueDate)}</span> : <span className="fin-quiet">—</span>,
    },
  ];

  const subscriptionColumns = [
    {
      key: "client",
      header: "Cliente",
      primary: true,
      sortable: true,
      sortValue: (s) => s.client.name,
      render: (s) => <ClientCell client={s.client} sub={s.payerEmail} />,
    },
    { key: "plan", header: "Plano", render: (s) => s.service.name },
    {
      key: "amount",
      header: "Valor mensal",
      align: "end",
      nowrap: true,
      sortable: true,
      sortValue: (s) => s.amountCents,
      render: (s) => <span className="fin-cell-money">{formatMoney(s.amountCents)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (s) => (
        <div className="fin-cell-status">
          <StatusBadge kind="subscription" value={s.status} size="sm" />
          {s.failureReason && <span className="fin-cell-status__reason">{s.failureReason}</span>}
        </div>
      ),
    },
    { key: "contract", header: "Contrato", hideOnMobile: true, render: (s) => <ContractCell item={s} /> },
    {
      key: "next",
      header: "Próxima cobrança",
      nowrap: true,
      render: (s) =>
        s.status === "active" && s.nextBillingDate ? formatDate(s.nextBillingDate) : <span className="fin-quiet">—</span>,
    },
    {
      key: "createdAt",
      header: "Criada",
      nowrap: true,
      hideOnMobile: true,
      sortable: true,
      sortValue: (s) => s.createdAt,
      render: (s) => formatDate(s.createdAt),
    },
  ];

  const emptyOrders = filtered
    ? {
        icon: Receipt,
        title: "Nenhum pedido neste filtro",
        description: "Mude o cliente, o status ou a busca para ver outros pedidos.",
        action: (
          <Button size="sm" onClick={() => update({ clientId: null, status: null, q: null })}>
            Limpar filtros
          </Button>
        ),
      }
    : {
        icon: Receipt,
        title: "Nenhum pedido ainda",
        description:
          "Crie um pedido para cobrar um serviço avulso ou um valor combinado. O cliente só vê a cobrança depois que o link de pagamento é gerado.",
        action: canManage && (
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setCreating("order")}>
            Novo pedido
          </Button>
        ),
      };
  const emptySubscriptions = filtered
    ? {
        icon: Repeat,
        title: "Nenhuma assinatura neste filtro",
        description: "Mude o cliente, o status ou a busca para ver outras assinaturas.",
        action: (
          <Button size="sm" onClick={() => update({ clientId: null, status: null, q: null })}>
            Limpar filtros
          </Button>
        ),
      }
    : {
        icon: Repeat,
        title: "Nenhuma assinatura ainda",
        description:
          "Assinaturas cobram um plano mensal pelo Mercado Pago. Crie uma, gere o link de autorização e envie ao cliente.",
        action: canManage && (
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setCreating("subscription")}>
            Nova assinatura
          </Button>
        ),
      };

  const selectedClient = options.data?.clients?.find((c) => c.id === clientId);

  return (
    <div className="fin-page">
      <PageHeader
        eyebrow="Comercial"
        title="Pedidos e"
        accent="assinaturas"
        description="Cobranças avulsas e planos mensais pagos pelo Mercado Pago. O status muda somente quando o Mercado Pago confirma."
        meta={
          mp?.configured ? (
            <Badge tone={mp.mode === "test" ? "amber" : "olive"} dot size="sm">
              {mp.mode === "test" ? "Mercado Pago em modo de teste" : "Mercado Pago em produção"}
            </Badge>
          ) : null
        }
        actions={
          canManage && (
            <>
              <Button icon={Repeat} onClick={() => setCreating("subscription")}>
                Nova assinatura
              </Button>
              <Button variant="primary" icon={Plus} onClick={() => setCreating("order")}>
                Novo pedido
              </Button>
            </>
          )
        }
      />

      {mp && !mp.configured && (
        <Callout
          tone="amber"
          icon="warning"
          title="Mercado Pago não configurado"
          className="fin-mb"
          index={0}
          actions={
            canFinance && (
              <Button size="sm" to="/admin/financeiro#mercado-pago">
                Ver como configurar
              </Button>
            )
          }
        >
          Pedidos e assinaturas podem ser criados, mas os links de pagamento só são gerados depois que as credenciais
          estiverem no servidor.
        </Callout>
      )}

      <Tabs
        aria-label="Pedidos ou assinaturas"
        value={tab}
        onChange={(value) =>
          update({ aba: value === "subscriptions" ? "assinaturas" : null, status: null, pedido: null, assinatura: null })
        }
        items={[
          { value: "orders", label: "Pedidos", icon: Receipt },
          { value: "subscriptions", label: "Assinaturas", icon: Repeat },
        ]}
      />

      <div className="fin-listwrap">
        <FilterBar
          search={
            <SearchInput
              value={q}
              label={tab === "orders" ? "Buscar pedidos" : "Buscar assinaturas"}
              placeholder={tab === "orders" ? "Buscar por descrição, cliente ou marca" : "Buscar por plano, cliente ou e-mail"}
              onChange={(value) => update({ q: value })}
            />
          }
          activeCount={activeCount}
          onClear={() => update({ clientId: null, status: null, q: null })}
          summary={
            list.data && filtered
              ? `${list.data.total} ${tab === "orders" ? (list.data.total === 1 ? "pedido" : "pedidos") : list.data.total === 1 ? "assinatura" : "assinaturas"}${selectedClient ? ` de ${selectedClient.name}` : ""}`
              : null
          }
        >
          <Select
            aria-label="Cliente"
            value={clientId}
            placeholder="Todos os clientes"
            options={clientOptions}
            onValueChange={(value) => update({ clientId: value })}
          />
          <Select
            aria-label="Status"
            value={status}
            placeholder="Todos os status"
            options={withCount(tab === "orders" ? ORDER_STATUS : SUBSCRIPTION_STATUS, list.data?.counts)}
            onValueChange={(value) => update({ status: value })}
          />
        </FilterBar>

        {tab === "orders" ? (
          <DataTable
            key="orders"
            caption="Pedidos"
            columns={orderColumns}
            rows={orders.data?.items ?? []}
            loading={orders.loading}
            error={orders.error}
            onRetry={orders.reload}
            empty={emptyOrders}
            rowLabel={(o) => o.description}
            onRowClick={(o) => update({ pedido: o.id }, { keepPage: true })}
            rowClassName={(o) => (o.id === orderId ? "is-selected" : undefined)}
          />
        ) : (
          <DataTable
            key="subscriptions"
            caption="Assinaturas"
            columns={subscriptionColumns}
            rows={subscriptions.data?.items ?? []}
            loading={subscriptions.loading}
            error={subscriptions.error}
            onRetry={subscriptions.reload}
            empty={emptySubscriptions}
            rowLabel={(s) => `${s.service.name} · ${s.client.name}`}
            onRowClick={(s) => update({ assinatura: s.id }, { keepPage: true })}
            rowClassName={(s) => (s.id === subscriptionId ? "is-selected" : undefined)}
          />
        )}

        {list.data && (
          <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onChange={(next) => update({ page: next })} />
        )}
      </div>

      <OrderDrawer
        orderId={orderId}
        onClose={() => update({ pedido: null }, { keepPage: true })}
        onChanged={() => orders.reload().catch(() => {})}
        mp={mp}
        canManage={canManage}
        canConfigure={canFinance}
      />
      <SubscriptionDrawer
        subscriptionId={subscriptionId}
        onClose={() => update({ assinatura: null }, { keepPage: true })}
        onChanged={() => subscriptions.reload().catch(() => {})}
        mp={mp}
        canManage={canManage}
        canConfigure={canFinance}
      />
      {canManage && (
        <>
          <NewOrderDrawer
            open={creating === "order"}
            options={options}
            defaultClientId={clientId}
            onClose={() => setCreating(null)}
            onCreated={(order) => {
              setCreating(null);
              update({ aba: null, pedido: order.id, status: null }, { keepPage: false });
              orders.reload().catch(() => {});
            }}
          />
          <NewSubscriptionDrawer
            open={creating === "subscription"}
            options={options}
            defaultClientId={clientId}
            onClose={() => setCreating(null)}
            onCreated={(subscription) => {
              setCreating(null);
              update({ aba: "assinaturas", assinatura: subscription.id, status: null }, { keepPage: false });
              subscriptions.reload().catch(() => {});
            }}
          />
        </>
      )}
    </div>
  );
}

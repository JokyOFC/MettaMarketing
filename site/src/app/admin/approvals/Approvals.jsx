import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCheck, Clock, MessageSquareWarning, SearchX } from "lucide-react";
import {
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
  SearchInput,
  Select,
  Tabs,
  formatDateTime,
  formatRelative,
  networkLabel,
  postFormatLabel,
  useApi,
} from "../../ui/index.js";
import { usePageTitle } from "../../shell/index.js";
import { PostThumb } from "../../shared/review/ContentViews.jsx";
import "../../shared/review/review.css";

const TABS = [
  {
    value: "pending",
    label: "Aguardando cliente",
    icon: Clock,
    description: "Versões liberadas que esperam a decisão do cliente, das mais antigas para as mais novas.",
    empty: { title: "Nada aguardando o cliente", description: "Quando um material for liberado para revisão, ele aparece aqui até o cliente decidir." },
  },
  {
    value: "changes_requested",
    label: "Ajustes solicitados",
    icon: MessageSquareWarning,
    description: "O cliente pediu ajustes: prepare uma nova versão e libere para uma nova aprovação.",
    empty: { title: "Nenhum ajuste pendente", description: "Pedidos de ajuste dos clientes aparecem aqui com o comentário e o slide indicados." },
  },
  {
    value: "approved",
    label: "Aprovados recentes",
    icon: CheckCheck,
    description: "Aprovações registradas, com quem aprovou, quando e qual versão.",
    empty: { title: "Nenhuma aprovação ainda", description: "As aprovações dos clientes aparecem aqui, das mais recentes para as mais antigas." },
  },
];
const STATUSES = TABS.map((tab) => tab.value);

function useTotal(status, params) {
  const { data } = useApi("/approvals", { params: { ...params, status, pageSize: 1 } });
  return data?.total;
}

export default function Approvals() {
  usePageTitle("Aprovações e ajustes");
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const status = STATUSES.includes(search.get("status")) ? search.get("status") : "changes_requested";
  const filters = {
    clientId: search.get("clientId") ?? "",
    brandId: search.get("brandId") ?? "",
    kind: search.get("kind") ?? "",
    q: search.get("q") ?? "",
  };
  const update = (patch) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearch(next, { replace: true });
  };

  const options = useApi("/content/options");
  const { data, error, loading, refreshing, reload } = useApi("/approvals", { params: { status, ...filters } });
  const totals = {
    pending: useTotal("pending", filters),
    changes_requested: useTotal("changes_requested", filters),
    approved: useTotal("approved", filters),
  };
  const items = data?.items ?? [];
  const active = TABS.find((tab) => tab.value === status);
  const brands = options.data?.brands ?? [];
  const clients = useMemo(() => {
    const map = new Map();
    for (const brand of brands) if (!map.has(brand.clientId)) map.set(brand.clientId, brand.clientName);
    return [...map].map(([value, label]) => ({ value, label }));
  }, [brands]);
  const activeCount = Object.values(filters).filter(Boolean).length;
  const linkFor = (item) => (item.kind === "post" ? `/admin/conteudo/${item.id}` : `/admin/biblioteca/${item.id}`);

  const columns = useMemo(
    () => [
      {
        key: "title",
        header: "Material",
        primary: true,
        sortable: true,
        sortValue: (item) => item.title,
        render: (item) => (
          <span className="cnt-cell-title">
            <PostThumb item={item} size="mini" />
            <span className="cnt-cell-title__text">
              <span className="cnt-cell-title__name">{item.title}</span>
              <span className="cnt-cell-title__sub">
                {item.kind === "post"
                  ? `${networkLabel(item.post?.network)} · ${postFormatLabel(item.post?.format)}`
                  : item.category?.name}
              </span>
            </span>
          </span>
        ),
      },
      {
        key: "client",
        header: "Cliente e marca",
        sortable: true,
        sortValue: (item) => `${item.client?.name} ${item.brand?.name}`,
        render: (item) => (
          <span className="cnt-cell-stack">
            <span>{item.client?.name}</span>
            <span className="ui-meta">{item.brand?.name}</span>
          </span>
        ),
      },
      {
        key: "version",
        header: "Versão",
        nowrap: true,
        sortValue: (item) => item.reviewVersion?.number ?? 0,
        render: (item) => <span className="ui-num">v{item.reviewVersion?.number ?? item.version?.number}</span>,
      },
      {
        key: "since",
        header: status === "approved" ? "Aprovado" : "Desde",
        sortable: true,
        nowrap: true,
        sortValue: (item) => item.since ?? "",
        render: (item) =>
          item.since ? (
            <time dateTime={item.since} title={formatDateTime(item.since)}>
              {formatRelative(item.since)}
            </time>
          ) : (
            "—"
          ),
      },
      {
        key: "owner",
        header: "Responsável",
        sortable: true,
        hideOnMobile: true,
        sortValue: (item) => item.owner?.name ?? "",
        render: (item) => item.owner?.name ?? <span className="ui-muted">—</span>,
      },
      status === "approved"
        ? {
            key: "decision",
            header: "Decisão",
            render: (item) =>
              item.lastDecision ? (
                <span className="cnt-cell-stack">
                  <span>Aprovado por {item.lastDecision.user?.name}</span>
                  {item.lastDecision.comment && <span className="cnt-queue-excerpt">“{item.lastDecision.comment}”</span>}
                </span>
              ) : (
                "—"
              ),
          }
        : {
            key: "request",
            header: "Último pedido de ajuste",
            mobileLabel: "Pedido de ajuste",
            render: (item) =>
              item.lastChangeRequest ? (
                <span className="cnt-cell-stack">
                  <span className="cnt-queue-excerpt">“{item.lastChangeRequest.body}”</span>
                  <span className="ui-meta">
                    {item.lastChangeRequest.author?.name} · v{item.lastChangeRequest.versionNumber}
                    {item.lastChangeRequest.slidePosition ? ` · slide ${item.lastChangeRequest.slidePosition}` : ""}
                  </span>
                </span>
              ) : (
                <span className="ui-muted">—</span>
              ),
          },
    ],
    [status],
  );

  return (
    <div className="cnt-page">
      <PageHeader
        eyebrow="Produção"
        title="Aprovações e"
        accent="ajustes"
        description="Cada decisão fica registrada com quem decidiu, quando e sobre qual versão. Download nunca conta como aprovação."
      />

      <Tabs
        aria-label="Situação da aprovação"
        value={status}
        onChange={(value) => update({ status: value })}
        items={TABS.map((tab) => ({ value: tab.value, label: tab.label, icon: tab.icon, count: totals[tab.value] }))}
      />

      <div className="cnt-filters">
        <p className="ui-meta">{active.description}</p>
        <FilterBar
          search={<SearchInput value={filters.q} onChange={(q) => update({ q })} placeholder="Buscar material ou campanha" label="Buscar na fila" />}
          activeCount={activeCount}
          onClear={() => update({ clientId: "", brandId: "", kind: "", q: "" })}
        >
          {clients.length > 1 && (
            <Select
              aria-label="Cliente"
              value={filters.clientId}
              onValueChange={(clientId) => update({ clientId, brandId: "" })}
              options={[{ value: "", label: "Todos os clientes" }, ...clients]}
            />
          )}
          <Select
            aria-label="Marca"
            value={filters.brandId}
            onValueChange={(brandId) => update({ brandId })}
            options={[
              { value: "", label: "Todas as marcas" },
              ...brands.filter((b) => !filters.clientId || b.clientId === filters.clientId).map((b) => ({ value: b.id, label: `${b.name} · ${b.clientName}` })),
            ]}
          />
          <Select
            aria-label="Tipo"
            value={filters.kind}
            onValueChange={(kind) => update({ kind })}
            options={[
              { value: "", label: "Posts e materiais" },
              { value: "post", label: "Somente posts" },
              { value: "asset", label: "Somente materiais" },
            ]}
          />
        </FilterBar>
      </div>

      {error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : (
        <DataTable
          key={status}
          columns={columns}
          rows={items}
          loading={loading || (refreshing && !items.length)}
          onRowClick={(item) => navigate(linkFor(item))}
          rowLabel={(item) => item.title}
          caption={active.label}
          empty={
            activeCount ? (
              <EmptyState compact icon={SearchX} title="Nada com esses filtros" description="Limpe os filtros para ver toda a fila." />
            ) : (
              <EmptyState compact icon={active.icon} title={active.empty.title} description={active.empty.description} />
            )
          }
        />
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Users } from "lucide-react";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Badge,
  Button,
  DataTable,
  FilterBar,
  PageHeader,
  SearchInput,
  Segmented,
  Stat,
  StatusBadge,
  formatDate,
  formatNumber,
  useApi,
  useIsNarrow,
} from "../../ui/index.js";
import ClientFormDrawer from "./ClientFormDrawer.jsx";
import { BrandMark } from "./crmShared.jsx";
import "./crm.css";

const STATUS_FILTERS = [
  { value: "", label: "Todos" },
  { value: "active", label: "Ativos" },
  { value: "paused", label: "Pausados" },
  { value: "archived", label: "Arquivados" },
];

function BrandChips({ brands }) {
  const active = brands.filter((brand) => brand.status === "active");
  if (!active.length) return <span className="ui-muted">Sem marca ativa</span>;
  const shown = active.slice(0, 3);
  return (
    <span className="crm-chips">
      {shown.map((brand) => (
        <span key={brand.id} className="crm-chip">
          {brand.name}
        </span>
      ))}
      {active.length > shown.length && <span className="crm-chip crm-chip--more">+{active.length - shown.length}</span>}
    </span>
  );
}

export default function ClientsList() {
  usePageTitle("Clientes e marcas");
  const navigate = useNavigate();
  const narrow = useIsNarrow();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const [creating, setCreating] = useState(params.get("novo") === "1");
  const { data, error, loading, refreshing, reload } = useApi("/clients", { params: { q, status } });
  const filtered = Boolean(q || status);
  const unfiltered = useApi(filtered ? "/clients" : null);
  const all = filtered ? unfiltered.data : data;
  const items = data?.items ?? [];
  const canCreate = can("clients.create");

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  // Real totals from the unfiltered list (never placeholders).
  const totals = useMemo(() => {
    const list = all?.items;
    if (!list) return null;
    return {
      active: list.filter((c) => c.status === "active").length,
      brands: list.reduce((sum, c) => sum + c.brandCount, 0),
      projects: list.reduce((sum, c) => sum + (c.projectCount ?? 0), 0),
    };
  }, [all]);

  const columns = [
    {
      key: "name",
      header: "Cliente",
      primary: true,
      sortable: true,
      sortValue: (row) => row.name,
      render: (row) => (
        <span className="crm-namecell">
          <BrandMark name={row.name} size={36} tone={row.status === "active" ? "olive" : "stone"} />
          <span className="crm-namecell__text">
            <span className="crm-namecell__title">
              {row.name}
              {row.source === "signup" && (
                <Badge size="sm" tone="slate" className="crm-source">
                  Cadastro pelo site
                </Badge>
              )}
            </span>
            {(row.legalName || row.contactName) && (
              <span className="crm-namecell__meta">{row.legalName || row.contactName}</span>
            )}
          </span>
        </span>
      ),
    },
    { key: "brands", header: "Marcas", render: (row) => <BrandChips brands={row.brands} /> },
    {
      key: "projectCount",
      header: "Projetos abertos",
      mobileLabel: "Projetos",
      align: "end",
      sortable: true,
      nowrap: true,
      render: (row) => <span className="ui-num">{formatNumber(row.projectCount)}</span>,
    },
    {
      key: "userCount",
      header: "Usuários",
      align: "end",
      sortable: true,
      nowrap: true,
      hideOnMobile: true,
      render: (row) => (row.userCount === null ? "—" : <span className="ui-num">{formatNumber(row.userCount)}</span>),
    },
    {
      key: "status",
      header: "Status",
      nowrap: true,
      render: (row) => <StatusBadge kind="client" value={row.status} size="sm" />,
    },
    {
      key: "createdAt",
      header: "Desde",
      sortable: true,
      nowrap: true,
      hideOnMobile: true,
      render: (row) => <span className="ui-meta">{formatDate(row.createdAt)}</span>,
    },
  ];

  return (
    <div className="crm-page">
      <PageHeader
        eyebrow="Relacionamento"
        title="Clientes e"
        accent="marcas"
        description="Cada cliente reúne suas marcas, pessoas com acesso, projetos e entregas — sempre separados de outros clientes."
        actions={
          canCreate && (
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              Novo cliente
            </Button>
          )
        }
      />

      {totals && all.items.length > 0 && (
        <div className="crm-stats">
          <Stat label="Clientes ativos" value={formatNumber(totals.active)} index={0} />
          <Stat label="Marcas ativas" value={formatNumber(totals.brands)} index={1} />
          {/* all projects not yet delivered (planning, production, review, paused); the
              overview's "Projetos em andamento" counts only the in_progress status */}
          <Stat
            label="Projetos abertos"
            value={formatNumber(totals.projects)}
            hint="Ainda não entregues, inclusive em planejamento"
            to={can("projects.view") ? "/admin/projetos?status=abertos" : undefined}
            index={2}
          />
        </div>
      )}

      <FilterBar
        search={
          <SearchInput
            value={q}
            onChange={(value) => setParam("q", value.trim())}
            placeholder="Buscar por cliente, marca, CNPJ ou contato"
            label="Buscar clientes"
            shortcut={narrow ? undefined : "/"}
          />
        }
        activeCount={status ? 1 : 0}
        onClear={() => setParam("status", "")}
        summary={
          data && !loading
            ? `${formatNumber(data.total)} ${data.total === 1 ? "cliente" : "clientes"}${refreshing ? " · atualizando…" : ""}`
            : null
        }
      >
        <Segmented
          aria-label="Filtrar por status"
          options={STATUS_FILTERS}
          value={status}
          onChange={(value) => setParam("status", value)}
          size="sm"
        />
      </FilterBar>

      <DataTable
        caption="Clientes"
        columns={columns}
        rows={items}
        loading={loading}
        error={error}
        onRetry={reload}
        rowLabel={(row) => row.name}
        onRowClick={(row) => navigate(`/admin/clientes/${row.id}`)}
        rowClassName={(row) => (row.status === "archived" ? "crm-row--muted" : undefined)}
        empty={
          filtered
            ? {
                icon: Users,
                title: "Nenhum cliente encontrado",
                description: "Revise a busca ou limpe o filtro de status.",
                action: (
                  <Button size="sm" onClick={() => setParams({}, { replace: true })}>
                    Limpar busca e filtros
                  </Button>
                ),
              }
            : {
                icon: Users,
                title: "Nenhum cliente por aqui ainda",
                description: canCreate
                  ? "Cadastre o primeiro cliente com a marca dele para começar a organizar projetos, arquivos e entregas."
                  : "Quando um administrador liberar clientes para você, eles aparecem aqui.",
                action: canCreate && (
                  <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
                    Novo cliente
                  </Button>
                ),
              }
        }
      />

      {canCreate && (
        <ClientFormDrawer
          open={creating}
          onClose={() => {
            setCreating(false);
            if (params.get("novo")) setParam("novo", "");
          }}
          onCreated={(result) => {
            setCreating(false);
            navigate(`/admin/clientes/${result.client.id}`, {
              state: result.user
                ? { invite: { name: result.user.name, email: result.user.email, inviteUrl: result.inviteUrl, emailStatus: result.emailStatus } }
                : undefined,
            });
          }}
        />
      )}
    </div>
  );
}

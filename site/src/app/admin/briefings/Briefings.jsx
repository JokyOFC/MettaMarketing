import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ClipboardList, Plus } from "lucide-react";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Button,
  DataTable,
  FilterBar,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  Tabs,
  formatRelative,
  useApi,
} from "../../ui/index.js";
import { dueInfo } from "../../client/briefings/questions.jsx";
import NewBriefingModal from "./NewBriefingModal.jsx";
import "./hub.css";

const cx = (...parts) => parts.filter(Boolean).join(" ");
const PAGE_SIZE = 25;
const OPEN = new Set(["awaiting_client", "in_progress"]);
// "Em aberto" = sent and not answered yet (what the overview counts as waiting).
const OPEN_STATUS = "awaiting_client,in_progress";
const STATUS_TABS = [
  { value: "", label: "Todos" },
  { value: OPEN_STATUS, label: "Em aberto" },
  { value: "draft", label: "Rascunhos" },
  { value: "awaiting_client", label: "Aguardando" },
  { value: "in_progress", label: "Em preenchimento" },
  { value: "submitted", label: "Respondidos" },
  { value: "reviewed", label: "Revisados" },
];

export default function Briefings() {
  usePageTitle("Briefings");
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can("briefings.manage");
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "";
  const q = params.get("q") || "";
  const brandId = params.get("marca") || "";
  const page = Math.max(1, Number(params.get("pagina")) || 1);
  const [creating, setCreating] = useState(false);

  const { data, error, loading, refreshing, reload } = useApi("/briefings", {
    params: { status, q, brandId, page, pageSize: PAGE_SIZE },
  });
  const brandsApi = useApi("/brands");

  const update = (next) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, String(value));
      else merged.delete(key);
    }
    if (!("pagina" in next)) merged.delete("pagina");
    setParams(merged, { replace: true });
  };

  const counts = data?.counts ?? {};
  const allCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const tabs = STATUS_TABS.map((tab) => ({
    ...tab,
    count: data
      ? tab.value
        ? tab.value.split(",").reduce((sum, key) => sum + (counts[key] ?? 0), 0)
        : allCount
      : undefined,
  }));
  const brandOptions = useMemo(
    () =>
      (brandsApi.data?.items ?? [])
        .map((brand) => ({ value: brand.id, label: brand.client?.name ? `${brand.client.name} · ${brand.name}` : brand.name }))
        .sort((a, b) => a.label.localeCompare(b.label, "pt-BR")),
    [brandsApi.data],
  );
  const filtered = Boolean(q || brandId);

  const columns = [
    {
      key: "title",
      header: "Briefing",
      primary: true,
      sortable: true,
      accessor: (row) => row.title,
      render: (row) => (
        <span className="hub-cell-title">
          <strong>{row.title}</strong>
          <span className="ui-meta">
            {row.client?.name} · {row.brand?.name}
          </span>
        </span>
      ),
    },
    {
      key: "project",
      header: "Projeto",
      hideOnMobile: true,
      accessor: (row) => row.project?.name ?? "",
      render: (row) => row.project?.name ?? <span className="ui-muted">—</span>,
    },
    {
      key: "status",
      header: "Situação",
      nowrap: true,
      // full card width on phones ("Aguardando preenchimento" is long)
      render: (row) => (
        <span className="hub-status-cell">
          <StatusBadge kind="briefing" value={row.status} size="sm" />
        </span>
      ),
    },
    {
      key: "progress",
      header: "Respostas",
      mobileLabel: "Respostas",
      sortValue: (row) => (row.progress.total ? row.progress.answered / row.progress.total : 0),
      sortable: true,
      render: (row) => <ProgressCell row={row} />,
    },
    {
      key: "due",
      header: "Prazo",
      nowrap: true,
      sortable: true,
      accessor: (row) => row.dueDate ?? "",
      render: (row) => {
        const due = dueInfo(row.dueDate, { open: OPEN.has(row.status) });
        if (!due) return <span className="ui-muted">Sem prazo</span>;
        return (
          <span className={cx("hub-due hub-due--cell", due.tone && `is-${due.tone}`)}>
            {due.date}
            {due.relative && <small>{due.relative}</small>}
          </span>
        );
      },
    },
    {
      key: "updatedAt",
      header: "Atualizado",
      hideOnMobile: true,
      nowrap: true,
      sortable: true,
      accessor: (row) => row.updatedAt,
      render: (row) => <span className="ui-meta">{formatRelative(row.updatedAt)}</span>,
    },
  ];

  const emptyNoData = !filtered && !status;
  return (
    <div className="hub-page">
      <PageHeader
        eyebrow="Produção"
        title="Briefings"
        accent="dos clientes"
        description="As perguntas que a equipe precisa antes de começar cada projeto. Acompanhe o que falta responder e revise o que chegou."
        actions={
          canManage && (
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              Novo briefing
            </Button>
          )
        }
      />

      <Tabs
        items={tabs}
        value={status}
        onChange={(value) => update({ status: value })}
        aria-label="Situação dos briefings"
        className="hub-tabs"
      />

      <FilterBar
        search={<SearchInput value={q} onChange={(value) => update({ q: value })} placeholder="Buscar por título, cliente ou marca" label="Buscar briefings" shortcut="/" />}
        activeCount={brandId ? 1 : 0}
        onClear={() => update({ q: "", marca: "" })}
      >
        {brandOptions.length > 0 && (
          <Select
            aria-label="Filtrar por marca"
            value={brandId}
            placeholder="Todas as marcas"
            options={brandOptions}
            onValueChange={(value) => update({ marca: value })}
          />
        )}
      </FilterBar>

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        loading={loading || (refreshing && !data?.items?.length)}
        error={error}
        onRetry={reload}
        onRowClick={(row) => navigate(`/admin/briefings/${row.id}`)}
        rowLabel={(row) => row.title}
        caption="Briefings"
        empty={
          emptyNoData
            ? {
                icon: ClipboardList,
                title: "Nenhum briefing ainda",
                description: canManage
                  ? "Crie o primeiro a partir de um modelo pronto (identidade visual, conteúdo mensal ou campanha) ou em branco."
                  : "Quando a equipe criar briefings para as marcas dos seus projetos, eles aparecem aqui.",
                action: canManage && (
                  <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
                    Novo briefing
                  </Button>
                ),
              }
            : {
                icon: ClipboardList,
                title: "Nenhum briefing encontrado",
                description: "Nenhum briefing corresponde a estes filtros.",
                action: (filtered || status) && (
                  <Button variant="ghost" size="sm" onClick={() => update({ q: "", marca: "", status: "" })}>
                    Limpar filtros
                  </Button>
                ),
              }
        }
      />

      {data && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={data.total}
          onChange={(next) => update({ pagina: next > 1 ? next : "" })}
          className="hub-pager"
        />
      )}

      {canManage && <NewBriefingModal open={creating} onClose={() => setCreating(false)} defaultBrandId={brandId} />}
    </div>
  );
}

function ProgressCell({ row }) {
  const { answered, total, required, requiredAnswered } = row.progress;
  if (row.status === "draft")
    return (
      <span className="ui-meta">
        {total} {total === 1 ? "pergunta" : "perguntas"}
      </span>
    );
  const ratio = total ? answered / total : 0;
  return (
    <span className="hub-progress-cell" title={required ? `${requiredAnswered} de ${required} obrigatórias` : undefined}>
      <span className="ui-num">
        {answered}/{total}
      </span>
      <span className="hub-minibar" aria-hidden="true">
        <span style={{ transform: `scaleX(${ratio})` }} />
      </span>
    </span>
  );
}

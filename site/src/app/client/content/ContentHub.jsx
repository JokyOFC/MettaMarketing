import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, CalendarDays, Inbox, LayoutGrid, List, SearchX } from "lucide-react";
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  SkeletonCards,
  formatRelative,
  labelOptions,
  monthKey,
  monthLabel,
  plural,
  useApi,
} from "../../ui/index.js";
import { useBrand, usePageTitle } from "../../shell/index.js";
import {
  ContentCalendar,
  PostGrid,
  PostThumb,
  calendarRange,
  postColumns,
} from "../../shared/review/ContentViews.jsx";
import { storage } from "../../shared/review/util.js";
import "../../shared/review/review.css";

const VIEW_KEY = "metta:content:view";
const VIEWS = [
  { value: "grid", label: "Grade", icon: LayoutGrid },
  { value: "list", label: "Lista", icon: List },
  { value: "calendar", label: "Calendário", icon: CalendarDays },
];
const STATUS_OPTIONS = [
  { value: "", label: "Todos os status" },
  { value: "approval:pending", label: "Aguardando aprovação" },
  { value: "approval:changes_requested", label: "Ajustes solicitados" },
  { value: "approval:approved", label: "Aprovado" },
  { value: "publication:scheduled", label: "Agendado" },
  { value: "publication:published", label: "Publicado" },
  { value: "delivered:1", label: "Entregue" },
];
const EMPTY_FILTERS = { status: "", network: "", format: "", campaignId: "", month: "", q: "" };

const monthRange = (month) => {
  if (!month) return {};
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
};

export function statusParams(status) {
  if (!status) return {};
  const [axis, value] = status.split(":");
  return { [axis]: value };
}

function PendingStrip({ brandId }) {
  const { data } = useApi("/approvals", { params: { brandId } });
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <section className="cnt-pending ui-enter" aria-labelledby="cnt-pending-title">
      <div className="cnt-pending__head">
        <h2 id="cnt-pending-title" className="cnt-pending__title">
          Aguardando sua <em>aprovação</em>
        </h2>
        <p className="cnt-pending__hint">
          {plural(items.length, "item precisa", "itens precisam")} da sua decisão
        </p>
      </div>
      <ul className="cnt-pending__list">
        {items.map((item) => {
          const post = item.kind === "post";
          return (
            <li key={item.id} className="cnt-pending__item">
              <Link to={post ? `/painel/conteudo/${item.id}` : `/painel/arquivos?material=${item.id}`} className="cnt-pending__card">
                <PostThumb item={item} size="mini" />
                <span className="cnt-pending__text">
                  <span className="cnt-pending__name">{item.title}</span>
                  <span className="cnt-pending__meta">
                    Versão {item.reviewVersion?.number ?? item.version?.number}
                    {item.since ? ` · enviada ${formatRelative(item.since)}` : ""}
                  </span>
                  <span className="cnt-pending__go">
                    Revisar <ArrowRight size={13} strokeWidth={1.4} aria-hidden="true" />
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function ContentHub() {
  usePageTitle("Conteúdo");
  const navigate = useNavigate();
  const { brand, brandId } = useBrand();
  const [view, setViewState] = useState(() => {
    const saved = storage.get(VIEW_KEY);
    return VIEWS.some((v) => v.value === saved) ? saved : "grid";
  });
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [calMonth, setCalMonth] = useState(() => monthKey(new Date()));
  const setView = (value) => {
    setViewState(value);
    storage.set(VIEW_KEY, value);
  };
  const set = (key) => (value) => setFilters((current) => ({ ...current, [key]: value }));

  useEffect(() => setFilters((current) => ({ ...current, campaignId: "" })), [brandId]);

  const options = useApi(brandId ? "/content/options" : null, { params: { brandId } });
  const calendar = view === "calendar";
  const range = calendarRange(calMonth);
  const params = {
    brandId,
    ...statusParams(filters.status),
    network: filters.network,
    format: filters.format,
    campaignId: filters.campaignId,
    q: filters.q,
    ...(calendar ? { view: "calendar", from: range.from, to: range.to } : { ...monthRange(filters.month), sort: "planned_desc" }),
  };
  const { data, error, loading, refreshing, reload } = useApi(brandId ? "/content" : null, { params });
  const items = data?.items ?? [];
  const activeCount = ["status", "network", "format", "campaignId", "q", ...(calendar ? [] : ["month"])].filter((key) => filters[key]).length;
  const columns = useMemo(() => postColumns(), []);
  const linkFor = (item) => `/painel/conteudo/${item.id}`;

  const campaignOptions = [
    { value: "", label: "Todas as campanhas" },
    ...(options.data?.campaigns ?? []).map((c) => ({ value: c.id, label: c.name })),
  ];
  const monthOptions = [
    { value: "", label: "Todos os meses" },
    ...(options.data?.months ?? []).map((m) => ({ value: m, label: monthLabel(m) })),
  ];

  if (!brandId)
    return (
      <div className="cnt-page">
        <PageHeader eyebrow="Conteúdo" title="Central de" accent="conteúdo" />
        <EmptyState
          icon={Inbox}
          title="Nenhuma marca ativa na sua conta"
          description="Quando a equipe Metta ativar uma marca para você, os posts dela aparecem aqui."
        />
      </div>
    );

  const empty =
    activeCount > 0 ? (
      <EmptyState
        icon={SearchX}
        title="Nenhuma publicação com esses filtros"
        description="Tente outro status, rede ou mês, ou limpe os filtros para ver tudo."
        action={
          <Button onClick={() => setFilters(EMPTY_FILTERS)} size="sm">
            Limpar filtros
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={Inbox}
        title="Nenhuma publicação liberada ainda"
        description={`Quando a equipe Metta liberar posts, carrosséis, stories ou vídeos de ${brand?.name ?? "sua marca"} para revisão, eles aparecem aqui.`}
      />
    );

  let body;
  if (error && !data) body = <ErrorState error={error} onRetry={reload} />;
  else if (calendar)
    body = (
      <ContentCalendar
        month={calMonth}
        onMonthChange={setCalMonth}
        items={items}
        undated={data?.undated ?? []}
        linkFor={linkFor}
        loading={loading || refreshing}
      />
    );
  else if (view === "list")
    body = (
      <DataTable
        columns={columns}
        rows={items}
        loading={loading}
        onRowClick={(item) => navigate(linkFor(item))}
        rowLabel={(item) => item.title}
        caption="Publicações"
        empty={empty}
      />
    );
  else if (loading) body = <SkeletonCards count={8} aspect={4 / 5} minWidth={212} label="Carregando publicações" />;
  else if (!items.length) body = empty;
  else body = <PostGrid items={items} linkFor={linkFor} />;

  return (
    <div className="cnt-page">
      <PageHeader
        eyebrow="Conteúdo"
        title="Central de"
        accent="conteúdo"
        description={`Posts, carrosséis, stories e vídeos de ${brand?.name}. Veja as prévias, aprove, peça ajustes e baixe o que foi liberado.`}
      />

      <PendingStrip brandId={brandId} />

      <div className="cnt-filters">
        <FilterBar
          search={<SearchInput value={filters.q} onChange={set("q")} placeholder="Buscar por título ou campanha" label="Buscar publicações" />}
          activeCount={activeCount}
          onClear={() => setFilters(EMPTY_FILTERS)}
          actions={<Segmented aria-label="Modo de exibição" options={VIEWS} value={view} onChange={setView} />}
        >
          <Select aria-label="Status" value={filters.status} onValueChange={set("status")} options={STATUS_OPTIONS} />
          <Select
            aria-label="Rede social"
            value={filters.network}
            onValueChange={set("network")}
            options={[{ value: "", label: "Todas as redes" }, ...labelOptions("network")]}
          />
          <Select
            aria-label="Formato"
            value={filters.format}
            onValueChange={set("format")}
            options={[{ value: "", label: "Todos os formatos" }, ...labelOptions("postFormat")]}
          />
          {campaignOptions.length > 1 && (
            <Select aria-label="Campanha" value={filters.campaignId} onValueChange={set("campaignId")} options={campaignOptions} />
          )}
          {!calendar && monthOptions.length > 1 && (
            <Select aria-label="Mês" value={filters.month} onValueChange={set("month")} options={monthOptions} />
          )}
        </FilterBar>
        {!calendar && data && (
          <p className="cnt-toolbar__count" aria-live="polite">
            {plural(data.total ?? items.length, "publicação", "publicações")}
            {refreshing ? " · atualizando…" : ""}
          </p>
        )}
      </div>

      {body}
    </div>
  );
}

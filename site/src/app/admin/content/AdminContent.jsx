import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CalendarCheck, CalendarDays, Inbox, LayoutGrid, List, Plus, SearchX, Send, Unlock } from "lucide-react";
import {
  BulkBar,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  SkeletonCards,
  label as labelOf,
  labelOptions,
  monthKey,
  plural,
  useApi,
  useSelection,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import { ContentCalendar, PostGrid, calendarRange, postColumns } from "../../shared/review/ContentViews.jsx";
import { storage } from "../../shared/review/util.js";
import ReleaseDialog from "../library/ReleaseDialog.jsx";
import { FilterChips, FilterPopover } from "./toolbar.jsx";
import "../../shared/review/review.css";

const VIEW_KEY = "metta:admin-content:view";
const PAGE_SIZE = 60;
const VIEWS = [
  { value: "grid", label: "Grade", icon: LayoutGrid },
  { value: "list", label: "Lista", icon: List },
  { value: "calendar", label: "Calendário", icon: CalendarDays },
];
// One select per axis family; the options say which axis they belong to.
const STATUS_OPTIONS = [
  { value: "", label: "Todas as situações" },
  { value: "approval:pending", label: "Aprovação: aguardando" },
  { value: "approval:changes_requested", label: "Aprovação: ajustes solicitados" },
  { value: "approval:approved", label: "Aprovação: aprovado" },
  { value: "publication:not_scheduled", label: "Publicação: não agendado" },
  { value: "publication:scheduled", label: "Publicação: agendado" },
  { value: "publication:published", label: "Publicação: publicado" },
  { value: "delivered:1", label: "Entrega: entregue" },
  { value: "delivered:0", label: "Entrega: não entregue" },
];
const VISIBILITY_OPTIONS = [
  { value: "", label: "Toda visibilidade" },
  { value: "draft", label: "Rascunho" },
  { value: "internal_review", label: "Revisão interna" },
  { value: "released", label: "Liberado" },
];
const VIEWS_SHORT = VIEWS.map((view) => ({ ...view, label: `Ver em ${view.label.toLowerCase()}` }));
const EMPTY = { q: "", clientId: "", brandId: "", visibility: "", status: "", network: "", format: "", campaignId: "", ownerId: "" };
// Filters that live in the "Filtros" panel (the rest sit on the toolbar).
const PANEL_KEYS = ["visibility", "status", "network", "format", "campaignId", "ownerId"];

const statusParams = (status) => {
  if (!status) return {};
  const [axis, value] = status.split(":");
  return { [axis]: value };
};
const optionLabel = (options, value) => options.find((option) => option.value === value)?.label ?? value;

export default function AdminContent() {
  usePageTitle("Conteúdo e calendário");
  const navigate = useNavigate();
  const toast = useToast();
  const { user, can } = useAuth();
  const [view, setViewState] = useState(() => {
    const saved = storage.get(VIEW_KEY);
    return VIEWS.some((v) => v.value === saved) ? saved : "grid";
  });
  // Links from other screens pre-filter the list (?clientId, ?brandId,
  // ?visibility, ?approval, ?publication, ?delivered).
  const [search] = useSearchParams();
  const [filters, setFilters] = useState(() => {
    const status = ["approval", "publication", "delivered"]
      .map((axis) => (search.get(axis) ? `${axis}:${search.get(axis)}` : null))
      .find((value) => value && STATUS_OPTIONS.some((o) => o.value === value));
    return {
      ...EMPTY,
      clientId: search.get("clientId") || "",
      brandId: search.get("brandId") || "",
      visibility: VISIBILITY_OPTIONS.some((o) => o.value && o.value === search.get("visibility")) ? search.get("visibility") : "",
      status: status ?? "",
    };
  });
  const [sort, setSort] = useState("planned_desc");
  const [page, setPage] = useState(1);
  const [calMonth, setCalMonth] = useState(() => monthKey(new Date()));
  const [releaseIds, setReleaseIds] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const setView = (value) => {
    setViewState(value);
    storage.set(VIEW_KEY, value);
  };
  const set = (key) => (value) => {
    setPage(1);
    setFilters((current) => {
      const next = { ...current, [key]: value };
      if (key === "clientId") {
        next.brandId = "";
        next.campaignId = "";
      }
      if (key === "brandId") next.campaignId = "";
      return next;
    });
  };

  const options = useApi("/content/options");
  const calendar = view === "calendar";
  const range = calendarRange(calMonth);
  const params = {
    clientId: filters.clientId,
    brandId: filters.brandId,
    visibility: filters.visibility,
    ...statusParams(filters.status),
    network: filters.network,
    format: filters.format,
    campaignId: filters.campaignId,
    ownerId: filters.ownerId,
    q: filters.q,
    ...(calendar ? { view: "calendar", from: range.from, to: range.to } : { sort, page, pageSize: PAGE_SIZE }),
  };
  const { data, error, loading, refreshing, reload } = useApi("/content", { params });
  const items = data?.items ?? [];
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const selection = useSelection(ids);
  // The post ticked last offers the skip link to the batch bar.
  const [lastPicked, setLastPicked] = useState(null);
  const gridSelection = useMemo(
    () => ({
      ...selection,
      toggle: (id) => {
        const on = !selection.has(id);
        selection.toggle(id, on);
        if (on) setLastPicked(id);
      },
    }),
    [selection],
  );
  const jump = lastPicked && selection.has(lastPicked) ? { id: lastPicked, count: selection.count } : null;
  const columns = useMemo(() => postColumns({ admin: true }), []);
  const linkFor = (item) => `/admin/conteudo/${item.id}`;

  const brands = options.data?.brands ?? [];
  const clients = useMemo(() => {
    const map = new Map();
    for (const brand of brands) if (!map.has(brand.clientId)) map.set(brand.clientId, brand.clientName);
    return [...map].map(([value, label]) => ({ value, label }));
  }, [brands]);
  const brandOptions = brands.filter((brand) => !filters.clientId || brand.clientId === filters.clientId);
  const campaigns = (options.data?.campaigns ?? []).filter((c) => c.brandId === filters.brandId);
  const owners = options.data?.owners ?? [];
  const activeCount = Object.keys(EMPTY).filter((key) => filters[key]).length;
  const panelCount = PANEL_KEYS.filter((key) => filters[key]).length;
  const clearAll = () => {
    setPage(1);
    setFilters(EMPTY);
  };
  const clearPanel = () => {
    setPage(1);
    setFilters((current) => ({ ...current, ...Object.fromEntries(PANEL_KEYS.map((key) => [key, ""])) }));
  };
  const ownerOptions = [
    { value: "", label: "Todos os responsáveis" },
    { value: user?.id ?? "me", label: "Meus posts" },
    ...owners.filter((o) => o.id !== user?.id).map((o) => ({ value: o.id, label: o.name })),
  ];
  const chips = [
    filters.visibility && { key: "visibility", label: "Visibilidade", value: optionLabel(VISIBILITY_OPTIONS, filters.visibility) },
    filters.status && { key: "status", label: "Situação", value: optionLabel(STATUS_OPTIONS, filters.status) },
    filters.network && { key: "network", label: "Rede", value: labelOf("network", filters.network) },
    filters.format && { key: "format", label: "Formato", value: labelOf("postFormat", filters.format) },
    filters.campaignId && {
      key: "campaignId",
      label: "Campanha",
      value: (options.data?.campaigns ?? []).find((c) => c.id === filters.campaignId)?.name ?? "Campanha",
    },
    filters.ownerId && { key: "ownerId", label: "Responsável", value: optionLabel(ownerOptions, filters.ownerId) },
  ]
    .filter(Boolean)
    .map((chip) => ({ ...chip, onRemove: () => set(chip.key)("") }));

  const runBulk = async (label, request) => {
    setBulkBusy(true);
    try {
      const result = await request();
      const skipped = result?.skipped?.length ?? 0;
      const updated = typeof result?.updated === "number" ? result.updated : result?.ids?.length ?? 0;
      if (updated) toast.success(`${label}: ${plural(updated, "post atualizado", "posts atualizados")}.`);
      if (skipped)
        toast.info({
          title: `${plural(skipped, "post ficou", "posts ficaram")} de fora`,
          message: result.skipped
            .slice(0, 3)
            .map((s) => `${items.find((i) => i.id === s.id)?.title ?? "Post"}: ${s.reason}`)
            .join(" · "),
        });
      selection.clear();
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkActions = (selected) => (
    <>
      {can("materials.upload") && (
        <button
          type="button"
          className="ui-bulkbar__action"
          disabled={bulkBusy}
          onClick={() => runBulk("Enviado para revisão interna", () => api.post("/materials/bulk", { ids: selected, action: "submit" }))}
        >
          <Send size={16} strokeWidth={1.4} aria-hidden="true" />
          <span>Revisão interna</span>
        </button>
      )}
      {can("materials.release") && (
        <button type="button" className="ui-bulkbar__action" disabled={bulkBusy} onClick={() => setReleaseIds(selected)}>
          <Unlock size={16} strokeWidth={1.4} aria-hidden="true" />
          <span>Liberar</span>
        </button>
      )}
      {can("content.publication") && (
        <button
          type="button"
          className="ui-bulkbar__action"
          disabled={bulkBusy}
          onClick={() => runBulk("Marcado como agendado", () => api.post("/content/bulk-publication", { ids: selected, status: "scheduled" }))}
        >
          <CalendarCheck size={16} strokeWidth={1.4} aria-hidden="true" />
          <span>Marcar agendado</span>
        </button>
      )}
    </>
  );

  const empty =
    activeCount > 0 ? (
      <EmptyState
        icon={SearchX}
        title="Nenhum post com esses filtros"
        description="Ajuste os filtros ou limpe tudo para ver todos os posts no seu escopo."
        action={
          <Button size="sm" onClick={clearAll}>
            Limpar filtros
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={Inbox}
        title="Nenhum post ainda"
        description="Crie o primeiro post de um cliente: envie as artes, escreva a legenda e salve como rascunho para revisão."
        action={
          can("content.manage") ? (
            <Button variant="primary" size="sm" icon={Plus} to="/admin/conteudo/novo">
              Novo post
            </Button>
          ) : null
        }
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
        admin
        loading={loading || refreshing}
      />
    );
  else if (view === "list")
    body = (
      <DataTable
        columns={columns}
        rows={items}
        loading={loading}
        selectable
        selected={selection.selected}
        onSelectedChange={selection.set}
        onRowClick={(item) => navigate(linkFor(item))}
        rowLabel={(item) => item.title}
        caption="Posts"
        empty={empty}
      />
    );
  else if (loading) body = <SkeletonCards count={10} aspect={4 / 5} minWidth={212} label="Carregando posts" />;
  else if (!items.length) body = empty;
  else
    body = (
      <>
        <PostGrid items={items} linkFor={linkFor} admin selection={gridSelection} jump={jump} />
        {selection.count > 0 && <div className="ui-bulkbar-spacer" aria-hidden="true" />}
      </>
    );

  return (
    <div className="cnt-page">
      <PageHeader
        eyebrow="Produção"
        title="Conteúdo e"
        accent="calendário"
        description="Posts de todos os clientes no seu escopo. Aprovação e publicação são estados separados: nada é marcado como publicado sem a equipe."
        actions={
          can("content.manage") ? (
            <Button variant="primary" icon={Plus} to="/admin/conteudo/novo">
              Novo post
            </Button>
          ) : null
        }
      />

      <div className="cnt-filters cnt-filters--bar">
        <div className="cnt-bar">
          <div className="cnt-bar__search">
            <SearchInput value={filters.q} onChange={set("q")} placeholder="Título ou campanha" label="Buscar posts por título ou campanha" />
          </div>
          {clients.length > 1 && (
            <Select
              aria-label="Cliente"
              className="cnt-bar__select"
              value={filters.clientId}
              onValueChange={set("clientId")}
              options={[{ value: "", label: "Todos os clientes" }, ...clients]}
            />
          )}
          <Select
            aria-label="Marca"
            className="cnt-bar__select"
            value={filters.brandId}
            onValueChange={set("brandId")}
            options={[
              { value: "", label: "Todas as marcas" },
              ...brandOptions.map((b) => ({ value: b.id, label: filters.clientId ? b.name : `${b.name} · ${b.clientName}` })),
            ]}
          />
          <FilterPopover count={panelCount} onClear={clearPanel}>
            <Field label="Visibilidade">
              <Select value={filters.visibility} onValueChange={set("visibility")} options={VISIBILITY_OPTIONS} />
            </Field>
            <Field label="Aprovação, publicação ou entrega">
              <Select value={filters.status} onValueChange={set("status")} options={STATUS_OPTIONS} />
            </Field>
            <Field label="Rede social">
              <Select value={filters.network} onValueChange={set("network")} options={[{ value: "", label: "Todas as redes" }, ...labelOptions("network")]} />
            </Field>
            <Field label="Formato">
              <Select value={filters.format} onValueChange={set("format")} options={[{ value: "", label: "Todos os formatos" }, ...labelOptions("postFormat")]} />
            </Field>
            <Field label="Campanha" hint={filters.brandId ? undefined : "Escolha uma marca para filtrar por campanha."}>
              <Select
                value={filters.campaignId}
                onValueChange={set("campaignId")}
                disabled={!campaigns.length}
                options={[
                  { value: "", label: campaigns.length ? "Todas as campanhas" : "Sem campanhas" },
                  ...campaigns.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            </Field>
            <Field label="Responsável">
              <Select value={filters.ownerId} onValueChange={set("ownerId")} options={ownerOptions} />
            </Field>
          </FilterPopover>
          <div className="cnt-bar__end">
            {!calendar && (
              <Select
                size="sm"
                aria-label="Ordenar por data prevista, atualização ou título"
                className="cnt-bar__sort"
                value={sort}
                onValueChange={(value) => {
                  setSort(value);
                  setPage(1);
                }}
                options={[
                  { value: "planned_desc", label: "Data mais recente" },
                  { value: "planned", label: "Data mais antiga" },
                  { value: "updated", label: "Atualizados" },
                  { value: "title", label: "Título (A–Z)" },
                ]}
              />
            )}
            <Segmented aria-label="Modo de exibição" iconOnly options={VIEWS_SHORT} value={view} onChange={setView} />
          </div>
        </div>
        <div className="cnt-toolbar">
          <FilterChips chips={chips} />
          <p className="cnt-toolbar__count" aria-live="polite">
            {!calendar && data ? plural(data.total ?? items.length, "post", "posts") : ""}
            {refreshing ? `${!calendar && data ? " · " : ""}atualizando…` : ""}
          </p>
          {activeCount > 0 && (
            <button type="button" className="rv-textbtn cnt-toolbar__clear" onClick={clearAll}>
              Limpar tudo
            </button>
          )}
        </div>
      </div>

      {/* Batch actions right after the toolbar, before the posts: keyboard
          users reach them without tabbing through every card (the bar still
          floats at the bottom of the screen). */}
      <BulkBar count={calendar ? 0 : selection.count} onClear={selection.clear} noun={["post selecionado", "posts selecionados"]}>
        {bulkActions(selection.ids)}
      </BulkBar>

      {body}

      {!calendar && data && (data.total ?? 0) > PAGE_SIZE && (
        <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
      )}

      <ReleaseDialog
        open={Boolean(releaseIds)}
        materialIds={releaseIds ?? []}
        onClose={() => setReleaseIds(null)}
        onReleased={() => {
          setReleaseIds(null);
          selection.clear();
          reload();
        }}
      />
    </div>
  );
}

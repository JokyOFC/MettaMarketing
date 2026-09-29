import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FileDown, History, Info, X } from "lucide-react";
import {
  Button,
  DateInput,
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
  SearchInput,
  Select,
  SkeletonRows,
  formatNumber,
  roleLabel,
  useApi,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { usePageTitle } from "../../shell/index.js";
import { ACTION_GROUPS, exportCsv, groupByDay, groupOf, presetRange } from "../overview/lib.js";
import { ActivityEntry } from "./feed.jsx";
import "../overview/ov.css";

const cx = (...parts) => parts.filter(Boolean).join(" ");
const PAGE_SIZE = 50;

const PERIODS = [
  { value: "", label: "Todo o período" },
  { value: "hoje", label: "Hoje" },
  { value: "7", label: "Últimos 7 dias" },
  { value: "30", label: "Últimos 30 dias" },
  { value: "90", label: "Últimos 90 dias" },
  { value: "custom", label: "Personalizado" },
];

const VISIBILITY = [
  { value: "", label: "Toda a visibilidade" },
  { value: "client", label: "Visível ao cliente" },
  { value: "internal", label: "Somente equipe" },
];

// URL keys (pt-BR, shareable) -> filter state.
const KEYS = ["q", "cliente", "marca", "projeto", "pessoa", "grupo", "acao", "material", "periodo", "de", "ate", "visibilidade"];
// Other screens link with the API names (?clientId=…); they map to the keys above.
const ALIASES = { cliente: "clientId", marca: "brandId", projeto: "projectId", material: "materialId" };

export default function ActivityLog() {
  usePageTitle("Histórico");
  const toast = useToast();
  const [search, setSearch] = useSearchParams();
  const f = Object.fromEntries(KEYS.map((key) => [key, search.get(key) ?? (ALIASES[key] && search.get(ALIASES[key])) ?? ""]));

  // Rewrite ?clientId=… links to the page's own keys so clearing a filter clears it.
  useEffect(() => {
    const aliased = Object.entries(ALIASES).filter(([, alias]) => search.has(alias));
    if (!aliased.length) return;
    const next = new URLSearchParams(search);
    for (const [key, alias] of aliased) {
      if (!next.get(key)) next.set(key, search.get(alias));
      next.delete(alias);
    }
    setSearch(next, { replace: true });
  }, [search, setSearch]);
  const facets = useApi("/activity/facets");
  const facet = facets.data;

  const setFilters = (changes) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearch(next, { replace: true });
  };

  // Actions of the chosen group, from the names that really exist.
  const groupActions = useMemo(() => {
    if (!f.grupo || !facet) return null;
    return facet.actions.filter((a) => groupOf(a.action).key === f.grupo).map((a) => a.action);
  }, [f.grupo, facet]);

  const range = presetRange(f.periodo, { from: f.de, to: f.ate });
  const serverParams = {
    q: f.q || undefined,
    clientId: f.cliente || undefined,
    brandId: f.marca || undefined,
    projectId: f.projeto || undefined,
    actorId: f.pessoa || undefined,
    materialId: f.material || undefined,
    visibility: f.visibilidade || undefined,
    action: f.grupo ? (groupActions?.length ? groupActions.join(",") : "__nenhuma__") : f.acao || undefined,
    from: range.from,
    to: range.to,
  };
  const waiting = Boolean(f.grupo) && !facet;
  const key = JSON.stringify(serverParams);
  const list = useApi(waiting ? null : "/activity", { params: { ...serverParams, pageSize: PAGE_SIZE } });

  const [extra, setExtra] = useState({ key, items: [], page: 1 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => setExtra({ key, items: [], page: 1 }), [key]);
  const more = extra.key === key ? extra : { items: [], page: 1 };

  const items = useMemo(() => {
    const seen = new Set();
    return [...(list.data?.items ?? []), ...more.items].filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
  }, [list.data, more.items]);
  const groups = useMemo(() => groupByDay(items), [items]);
  const total = list.data?.total ?? 0;

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = more.page + 1;
      const page = await api.get("/activity", { params: { ...serverParams, pageSize: PAGE_SIZE, page: next } });
      setExtra((current) => (current.key === key ? { key, items: [...current.items, ...page.items], page: next } : current));
    } catch (err) {
      toast.error(err);
    } finally {
      setLoadingMore(false);
    }
  }

  async function onExport() {
    setExporting(true);
    try {
      const name = await exportCsv("/activity", serverParams, "metta-historico.csv");
      toast.success({ title: "Exportação pronta", message: `${name} foi baixado.` });
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(false);
    }
  }

  // Options (only what exists in the viewer's history).
  const brands = (facet?.brands ?? []).filter((b) => !f.cliente || b.clientId === f.cliente);
  const brandIds = new Set(brands.map((b) => b.id));
  const projects = (facet?.projects ?? []).filter((p) => (f.marca ? p.brandId === f.marca : !f.cliente || brandIds.has(p.brandId)));
  const groupCounts = new Map();
  for (const a of facet?.actions ?? []) {
    const g = groupOf(a.action);
    groupCounts.set(g.key, (groupCounts.get(g.key) ?? 0) + a.count);
  }
  const groupOptions = [...ACTION_GROUPS, { key: "other", label: "Outros registros" }]
    .filter((g) => groupCounts.has(g.key) || g.key === f.grupo)
    .map((g) => ({ value: g.key, label: `${g.label} (${formatNumber(groupCounts.get(g.key) ?? 0)})` }));

  const activeCount = ["cliente", "marca", "projeto", "pessoa", "grupo", "acao", "material", "periodo", "visibilidade"].filter((k) => f[k]).length;
  const materialTitle = f.material ? (items.find((i) => i.material?.id === f.material)?.material?.title ?? "Material selecionado") : null;

  return (
    <div className="ov-page">
      <PageHeader
        eyebrow="Acompanhamento"
        title="Histórico"
        accent="completo"
        description="Tudo o que aconteceu na plataforma: envios, liberações, aprovações, downloads, briefings, pagamentos e acessos."
        actions={
          <Button icon={FileDown} onClick={onExport} loading={exporting} disabled={!total}>
            Exportar CSV
          </Button>
        }
      />

      <FilterBar
        search={<SearchInput value={f.q} onChange={(q) => setFilters({ q })} placeholder="Buscar no histórico" label="Buscar no histórico" shortcut="/" />}
        activeCount={activeCount}
        onClear={() => setSearch(f.q ? new URLSearchParams({ q: f.q }) : new URLSearchParams(), { replace: true })}
        summary={
          list.data && (
            <span aria-live="polite">
              {formatNumber(total)} {total === 1 ? "registro" : "registros"}
            </span>
          )
        }
      >
        <Select
          aria-label="Cliente"
          placeholder="Todos os clientes"
          value={f.cliente}
          onValueChange={(value) => setFilters({ cliente: value, marca: "", projeto: "" })}
          options={(facet?.clients ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
        <Select
          aria-label="Marca"
          placeholder="Todas as marcas"
          value={f.marca}
          onValueChange={(value) => setFilters({ marca: value, projeto: "" })}
          options={brands.map((b) => ({ value: b.id, label: b.name }))}
        />
        <Select
          aria-label="Projeto"
          placeholder="Todos os projetos"
          value={f.projeto}
          onValueChange={(value) => setFilters({ projeto: value })}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Select
          aria-label="Pessoa"
          placeholder="Todas as pessoas"
          value={f.pessoa}
          onValueChange={(value) => setFilters({ pessoa: value })}
          options={(facet?.actors ?? []).map((a) => ({ value: a.id, label: `${a.name} · ${roleLabel(a.role)}` }))}
        />
        <Select
          aria-label="Tipo de ação"
          placeholder="Todos os tipos de ação"
          value={f.grupo}
          onValueChange={(value) => setFilters({ grupo: value, acao: "" })}
          options={groupOptions}
        />
        <Select aria-label="Período" value={f.periodo} onValueChange={(value) => setFilters({ periodo: value })} options={PERIODS} />
        {f.periodo === "custom" && (
          <span className="ov-range">
            <DateInput aria-label="De" value={range.from} max={range.to} onValueChange={(value) => setFilters({ de: value })} />
            <span aria-hidden="true">até</span>
            <DateInput aria-label="Até" value={range.to} min={range.from} onValueChange={(value) => setFilters({ ate: value })} />
          </span>
        )}
        <Select aria-label="Visibilidade" value={f.visibilidade} onValueChange={(value) => setFilters({ visibilidade: value })} options={VISIBILITY} />
      </FilterBar>

      {(f.material || f.acao) && (
        <div className="ov-chips" aria-label="Filtros extras">
          {f.material && (
            <button type="button" className="ov-chip ov-chip--filter" onClick={() => setFilters({ material: "" })}>
              <span>Material: {materialTitle}</span>
              <X size={14} strokeWidth={1.4} aria-hidden="true" />
              <span className="ui-sr-only">Remover filtro</span>
            </button>
          )}
          {f.acao && (
            <button type="button" className="ov-chip ov-chip--filter" onClick={() => setFilters({ acao: "" })}>
              <span>Ação: {f.acao}</span>
              <X size={14} strokeWidth={1.4} aria-hidden="true" />
              <span className="ui-sr-only">Remover filtro</span>
            </button>
          )}
        </div>
      )}

      {f.grupo === "downloads" && (
        <div className="ov-callout" role="note">
          <Info size={18} strokeWidth={1.4} aria-hidden="true" />
          <p>
            <strong>Download não equivale a aprovação.</strong> Estes registros mostram quem baixou cada arquivo ou pacote, e quando. As
            decisões dos clientes ficam em Aprovações e ajustes.
          </p>
        </div>
      )}

      {(list.loading || waiting) && <SkeletonRows rows={8} columns={3} media label="Carregando histórico" />}
      {list.error && !list.data && <ErrorState error={list.error} onRetry={() => list.reload().catch(() => {})} />}
      {list.data && !items.length && (
        <EmptyState
          icon={History}
          title={activeCount || f.q ? "Nenhum registro com esses filtros." : "O histórico ainda está vazio."}
          description={
            activeCount || f.q
              ? "Ajuste o período ou remova algum filtro para ver mais registros."
              : "Cada envio, liberação, aprovação, download e alteração fica registrado aqui automaticamente."
          }
          action={
            activeCount || f.q ? (
              <Button size="sm" onClick={() => setSearch(new URLSearchParams(), { replace: true })}>
                Limpar filtros
              </Button>
            ) : null
          }
        />
      )}

      {items.length > 0 && (
        <div className={cx("ov-log", list.refreshing && "is-refreshing")}>
          {groups.map((group) => (
            <section key={group.key} className="ov-day" aria-labelledby={`ov-log-${group.key}`}>
              <h2 className="ov-day__title ov-day__title--sticky" id={`ov-log-${group.key}`}>
                {group.heading.title}
                <span className="ov-day__detail">{group.heading.detail}</span>
              </h2>
              <ol className="ov-entries">
                {group.items.map((item, index) => (
                  <ActivityEntry key={item.id} item={item} index={index} />
                ))}
              </ol>
            </section>
          ))}
          {items.length < total && (
            <div className="ov-loadmore">
              <p className="ov-loadmore__count">
                Mostrando {formatNumber(items.length)} de {formatNumber(total)}
              </p>
              <Button onClick={loadMore} loading={loadingMore}>
                Carregar mais
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

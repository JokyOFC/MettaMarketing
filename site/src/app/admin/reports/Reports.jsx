import { useSearchParams } from "react-router-dom";
import { FileDown } from "lucide-react";
import { useState } from "react";
import {
  Button,
  DateInput,
  EmptyState,
  ErrorState,
  PageHeader,
  Segmented,
  Select,
  SkeletonCards,
  SkeletonRows,
  Tabs,
  formatDate,
  useApi,
  useToast,
} from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import { exportCsv, presetRange } from "../overview/lib.js";
import { ApprovalsReport, DeliveriesReport, DownloadsReport, FinanceReport } from "./panels.jsx";
import "../overview/ov.css";

const cx = (...parts) => parts.filter(Boolean).join(" ");

const list = (value) => Array.isArray(value);
const num = (value) => typeof value === "number";

// `fits` recognises the answer of each report, so a body never renders
// another report's data (e.g. the previous tab's while the new one loads).
const TABS = [
  {
    value: "entregas",
    key: "deliveries",
    label: "Entregas",
    cap: "reports.view",
    body: DeliveriesReport,
    fits: (d) => num(d?.totals?.releases) && list(d.series) && list(d.byClient) && list(d.byCategory) && list(d.byBrand) && list(d.items),
  },
  {
    value: "aprovacoes",
    key: "approvals",
    label: "Aprovações",
    cap: "reports.view",
    body: ApprovalsReport,
    fits: (d) => num(d?.totals?.decisions) && list(d.series) && list(d.roundsDistribution) && list(d.byClient) && list(d.waiting) && list(d.items),
  },
  {
    value: "downloads",
    key: "downloads",
    label: "Downloads",
    cap: "reports.view",
    body: DownloadsReport,
    fits: (d) => num(d?.totals?.events) && list(d.series) && list(d.byClient) && list(d.byMaterial) && list(d.byUser) && list(d.items),
  },
  {
    value: "financeiro",
    key: "finance",
    label: "Financeiro",
    cap: "reports.finance",
    body: FinanceReport,
    fits: (d) => num(d?.totals?.paidCents) && list(d.series) && list(d.byClient) && list(d.items),
  },
];

const PRESETS = [
  { value: "30", label: "30 dias" },
  { value: "90", label: "90 dias" },
  { value: "ano", label: "Este ano" },
  { value: "custom", label: "Personalizado" },
];

const AUDIENCES = [
  { value: "client", label: "Clientes" },
  { value: "team", label: "Equipe Metta" },
  { value: "all", label: "Todos" },
];

const INTERVAL_LABEL = { day: "por dia", week: "por semana", month: "por mês" };

function ReportSkeleton() {
  return (
    <div className="ov-report-skel" aria-busy="true">
      <SkeletonCards count={4} aspect={2.4} minWidth={200} lines={0} label="Carregando relatório" />
      <SkeletonRows rows={5} columns={4} />
    </div>
  );
}

export default function Reports() {
  usePageTitle("Relatórios");
  const { can } = useAuth();
  const [search, setSearch] = useSearchParams();

  const tabs = TABS.filter((tab) => can(tab.cap));
  const tab = tabs.find((t) => t.value === search.get("aba")) ?? tabs[0];
  const filters = useApi(tab ? "/reports/filters" : null);

  const set = (changes) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearch(next, { replace: true });
  };

  if (!tab)
    return (
      <div className="ov-page">
        <EmptyState title="Sem relatórios disponíveis" description="Seu perfil não tem acesso a relatórios. Fale com um administrador da Metta." />
      </div>
    );

  return (
    <div className="ov-page">
      <PageHeader
        eyebrow="Acompanhamento"
        title="Relatórios da"
        accent="operação"
        description="Entregas, aprovações, downloads e financeiro calculados a partir dos registros reais da plataforma, no período e nos clientes que você escolher."
      />
      <Tabs items={tabs.map((t) => ({ value: t.value, label: t.label }))} value={tab.value} onChange={(value) => set({ aba: value })} aria-label="Relatórios">
        {/* keyed: each report starts from its own empty state, never from the previous tab's data */}
        <ReportTab key={tab.key} tab={tab} search={search} set={set} options={filters.data} />
      </Tabs>
    </div>
  );
}

function ReportTab({ tab, search, set, options }) {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const preset = PRESETS.some((p) => p.value === search.get("periodo")) ? search.get("periodo") : "90";
  const range = presetRange(preset, { from: search.get("de"), to: search.get("ate") });
  const clientId = search.get("cliente") ?? "";
  const brandId = search.get("marca") ?? "";
  const audience = AUDIENCES.some((a) => a.value === search.get("publico")) ? search.get("publico") : "client";

  const clients = options?.clients ?? [];
  const brands = (options?.brands ?? []).filter((b) => !clientId || b.clientId === clientId);
  const params = {
    from: range.from,
    to: range.to,
    clientId: clientId || undefined,
    brandId: brandId || undefined,
    audience: tab.key === "downloads" ? audience : undefined,
  };
  const report = useApi(`/reports/${tab.key}`, { params });
  // Only data this report recognises is drawn; anything else shows the skeleton.
  const data = tab.fits(report.data) ? report.data : null;
  const waiting = !data && !report.error;

  async function onExport() {
    setExporting(true);
    try {
      const name = await exportCsv(`/reports/${tab.key}`, params, `metta-${tab.value}.csv`);
      toast.success({ title: "Exportação pronta", message: `${name} foi baixado. Abre direto no Excel.` });
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(false);
    }
  }

  const Body = tab.body;
  const interval = data?.range?.interval;

  return (
    <div className="ov-report">
      <div className="ov-filters" role="group" aria-label="Filtros do relatório">
        <div className="ov-filters__row">
          <Segmented options={PRESETS} value={preset} onChange={(value) => set({ periodo: value })} size="sm" aria-label="Período" />
          {preset === "custom" && (
            <span className="ov-range">
              <DateInput aria-label="De" value={range.from} max={range.to} onValueChange={(value) => set({ de: value })} />
              <span aria-hidden="true">até</span>
              <DateInput aria-label="Até" value={range.to} min={range.from} onValueChange={(value) => set({ ate: value })} />
            </span>
          )}
        </div>
        <div className="ov-filters__row">
          <Select
            aria-label="Cliente"
            placeholder="Todos os clientes"
            value={clientId}
            onValueChange={(value) => set({ cliente: value, marca: "" })}
            options={clients.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Select
            aria-label="Marca"
            placeholder="Todas as marcas"
            value={brandId}
            onValueChange={(value) => set({ marca: value })}
            options={brands.map((b) => ({ value: b.id, label: b.name }))}
          />
          {tab.key === "downloads" && (
            <Segmented options={AUDIENCES} value={audience} onChange={(value) => set({ publico: value === "client" ? "" : value })} size="sm" aria-label="Quem baixou" />
          )}
          <span className="ov-filters__spacer" />
          <Button icon={FileDown} onClick={onExport} loading={exporting} disabled={!data}>
            Exportar CSV
          </Button>
        </div>
        <p className="ov-filters__note" aria-live="polite">
          {formatDate(range.from)} a {formatDate(range.to)}
          {interval ? ` · agrupado ${INTERVAL_LABEL[interval]}` : ""}
        </p>
      </div>
      {waiting && <ReportSkeleton />}
      {report.error && !data && <ErrorState error={report.error} onRetry={() => report.reload().catch(() => {})} />}
      {report.error && data && <ErrorState compact error={report.error} onRetry={() => report.reload().catch(() => {})} />}
      {data && (
        <div className={cx("ov-report__body", report.refreshing && "is-refreshing")} aria-busy={report.refreshing || undefined}>
          <Body data={data} />
        </div>
      )}
    </div>
  );
}

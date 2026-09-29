// Accessible charts for the reports (slice I): stacked columns over time and
// ranked horizontal bars. Drawn with HTML/CSS from real values; every chart
// has a legend (2+ series), per-column tooltips on hover, focus and tap,
// arrow-key navigation and a table view with the same numbers.
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BarChart3, Table2 } from "lucide-react";
import { DataTable, EmptyState, Panel, Segmented, formatNumber } from "../../ui/index.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");

// Series colors come from the kit's tone tokens (validated pairs: olive/clay
// and olive/sage separate under color-vision deficiencies; identity never
// relies on color alone — legend, tooltip and table carry it too).
export const SERIES = {
  olive: "var(--app-tone-olive-fg)",
  sage: "var(--app-sage)",
  clay: "var(--app-tone-clay-dot)",
  amber: "var(--app-tone-amber-fg)",
  red: "var(--app-tone-red-dot)",
};

// ---------------------------------------------------------------- periods

const monthShort = new Intl.DateTimeFormat("pt-BR", { month: "short" });
const monthLong = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const dayMonth = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric" });
const local = (date) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
const clean = (text) => text.replace(/\./g, "").replace(/ de /g, " ");
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Short axis label for a bucket.
export function periodShort(bucket, interval, multiYear = false) {
  const date = local(bucket.start ?? bucket.period);
  if (interval === "month") return `${clean(monthShort.format(date))}${multiYear ? ` ${String(date.getFullYear()).slice(2)}` : ""}`;
  return clean(dayMonth.format(date));
}

// Long label for tooltips, tables and screen readers.
export function periodLong(bucket, interval) {
  const start = local(bucket.start ?? bucket.period);
  if (interval === "month") return cap(monthLong.format(start));
  if (interval === "week") return `Semana de ${clean(dayMonth.format(start))} a ${clean(dayMonth.format(local(bucket.end)))}`;
  return dayMonthYear.format(start);
}

// ------------------------------------------------------------------ scale

function niceScale(max, integer) {
  if (!(max > 0)) return { top: integer ? 4 : 1, ticks: [0] };
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const steps = integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  let step = (steps.find((s) => residual <= s) ?? 10) * magnitude;
  if (integer) step = Math.max(1, Math.round(step));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { top, ticks };
}

function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [ref]);
  return width;
}

// ------------------------------------------------------------ ColumnChart

/**
 * Stacked columns. data: buckets {period, start, end, [seriesKey]: number};
 * series: [{key, label, color}]; format: value -> text (tooltips, table);
 * axisFormat: compact tick text; interval: day | week | month.
 */
export function ColumnChart({ data = [], series = [], interval = "month", format = formatNumber, axisFormat, height = 200, label, integer = true }) {
  const plotRef = useRef(null);
  const listRef = useRef(null);
  const width = useWidth(plotRef);
  const [active, setActive] = useState(null);
  const [cursor, setCursor] = useState(Math.max(0, data.length - 1));
  const tick = axisFormat ?? format;
  const totals = data.map((d) => series.reduce((sum, s) => sum + (Number(d[s.key]) || 0), 0));
  const { top, ticks } = niceScale(Math.max(0, ...totals), integer);
  const years = new Set(data.map((d) => String(d.start ?? d.period).slice(0, 4)));
  const multiYear = years.size > 1;
  const n = data.length || 1;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((width || 600) / 52))));
  const gutter = Math.min(96, Math.max(28, ...ticks.map((t) => String(tick(t)).length * 6.6 + 10)));

  const describe = (i) => {
    const d = data[i];
    const parts = series.map((s) => `${format(Number(d[s.key]) || 0)} ${s.label.toLowerCase()}`);
    return `${periodLong(d, interval)}: ${parts.join(", ")}${series.length > 1 ? `; total ${format(totals[i])}` : ""}`;
  };

  const move = (event) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 };
    let next = cursor;
    if (event.key in keys) next = Math.min(data.length - 1, Math.max(0, cursor + keys[event.key]));
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = data.length - 1;
    else return;
    event.preventDefault();
    setCursor(next);
    setActive(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.focus();
  };

  const tipAlign = active === null ? "" : active < n * 0.2 ? "is-start" : active > n * 0.8 ? "is-end" : "";

  return (
    <figure className="ov-chart" aria-label={label}>
      {series.length > 1 && (
        <ul className="ov-legend" aria-label="Legenda">
          {series.map((s) => (
            <li key={s.key}>
              <span className="ov-legend__swatch" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="ov-chart__frame" style={{ "--ov-gutter": `${gutter}px` }}>
        <div className="ov-chart__plot" ref={plotRef} style={{ height }}>
          {ticks.map((t) => (
            <div key={t} className="ov-chart__grid" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden="true">
              <span>{tick(t)}</span>
            </div>
          ))}
          <div ref={listRef} className="ov-chart__cols" role="list" aria-label={label} onKeyDown={move}>
            {data.map((d, i) => {
              const total = totals[i];
              const pct = top ? (total / top) * 100 : 0;
              return (
                <div
                  key={d.period}
                  role="listitem"
                  tabIndex={i === cursor ? 0 : -1}
                  data-index={i}
                  aria-label={describe(i)}
                  className={cx("ov-chart__col", active === i && "is-active")}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive((current) => (current === i ? null : current))}
                  onFocus={() => {
                    setActive(i);
                    setCursor(i);
                  }}
                  onBlur={() => setActive((current) => (current === i ? null : current))}
                >
                  <span className="ov-chart__bar" style={{ height: total ? `max(3px, ${pct}%)` : 0, "--i": Math.min(i, 16) }}>
                    {series.map((s) =>
                      Number(d[s.key]) > 0 ? <span key={s.key} className="ov-chart__seg" style={{ flexGrow: Number(d[s.key]), background: s.color }} /> : null,
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {active !== null && data[active] && (
            <div className={cx("ov-chart__tip", tipAlign)} style={{ left: `${((active + 0.5) / n) * 100}%` }} aria-hidden="true">
              <p className="ov-chart__tip-title">{periodLong(data[active], interval)}</p>
              {series.map((s) => (
                <p key={s.key} className="ov-chart__tip-row">
                  <span className="ov-chart__tip-key" style={{ background: s.color }} />
                  <strong>{format(Number(data[active][s.key]) || 0)}</strong>
                  <span>{s.label}</span>
                </p>
              ))}
              {series.length > 1 && (
                <p className="ov-chart__tip-total">
                  Total <strong>{format(totals[active])}</strong>
                </p>
              )}
            </div>
          )}
        </div>
        <div className="ov-chart__x" aria-hidden="true">
          {data.map((d, i) => (
            <span key={d.period} className={cx(i % every !== 0 && "is-hidden")}>
              {periodShort(d, interval, multiYear)}
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}

// Same numbers as a table (the chart's accessible alternative).
export function ChartTable({ data = [], series = [], interval, format = formatNumber, label }) {
  const columns = [
    { key: "period", header: "Período", primary: true, render: (d) => periodLong(d, interval) },
    ...series.map((s) => ({ key: s.key, header: s.label, align: "end", nowrap: true, render: (d) => format(Number(d[s.key]) || 0) })),
  ];
  if (series.length > 1)
    columns.push({
      key: "total",
      header: "Total",
      align: "end",
      nowrap: true,
      render: (d) => format(series.reduce((sum, s) => sum + (Number(d[s.key]) || 0), 0)),
    });
  return <DataTable columns={columns} rows={data} rowKey="period" dense bare caption={label} maxHeight={360} />;
}

const VIEWS = [
  { value: "chart", label: "Gráfico", icon: BarChart3 },
  { value: "table", label: "Tabela", icon: Table2 },
];

// Panel with a chart/table switch. `charts`: one or more {key, title, series, format, ...}
// drawn side by side (small multiples) from the same buckets.
export function ChartPanel({ title, eyebrow, description, data, interval, charts, empty, index, tableFormat }) {
  const [view, setView] = useState("chart");
  const isEmpty = !data?.length || charts.every((chart) => data.every((d) => chart.series.every((s) => !Number(d[s.key]))));
  const allSeries = charts.flatMap((chart) => chart.series);
  return (
    <Panel
      index={index}
      eyebrow={eyebrow}
      title={title}
      description={description}
      actions={
        !isEmpty && <Segmented options={VIEWS} value={view} onChange={setView} size="sm" iconOnly aria-label={`Ver ${title} como`} />
      }
    >
      {isEmpty ? (
        <EmptyState compact title={empty?.title ?? "Sem registros no período."} description={empty?.description} />
      ) : view === "table" ? (
        <ChartTable data={data} series={allSeries} interval={interval} format={tableFormat ?? charts[0].format} label={title} />
      ) : (
        <div className={cx("ov-charts", charts.length > 1 && "ov-charts--multi")}>
          {charts.map((chart) => (
            <div key={chart.key} className="ov-charts__item">
              {chart.title && <p className="ov-charts__title">{chart.title}</p>}
              <ColumnChart
                data={data}
                series={chart.series}
                interval={interval}
                format={chart.format}
                axisFormat={chart.axisFormat}
                integer={chart.integer ?? true}
                height={chart.height ?? (charts.length > 1 ? 160 : 220)}
                label={chart.label ?? `${title}${chart.title ? ` — ${chart.title}` : ""}`}
              />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// -------------------------------------------------------------- BarList

/** Ranked bars: items [{key, label, sublabel, value, to}]; the value is always written out. */
export function BarList({ items = [], format = formatNumber, label, color = SERIES.olive, limit = 8, empty = "Sem registros no período." }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return <p className="ov-bars__empty">{empty}</p>;
  const max = Math.max(...items.map((item) => Number(item.value) || 0), 0);
  const shown = expanded ? items : items.slice(0, limit);
  return (
    <>
      <ol className="ov-bars" aria-label={label}>
        {shown.map((item, index) => {
          const pct = max ? ((Number(item.value) || 0) / max) * 100 : 0;
          return (
            <li key={item.key} className="ov-bars__item ui-enter" style={{ "--i": Math.min(index, 8) }}>
              <div className="ov-bars__top">
                <span className="ov-bars__label">{item.to ? <Link to={item.to}>{item.label}</Link> : item.label}</span>
                <span className="ov-bars__value">{format(item.value)}</span>
              </div>
              {item.sublabel && <span className="ov-bars__sub">{item.sublabel}</span>}
              <span className="ov-bars__track" aria-hidden="true">
                <span className="ov-bars__fill" style={{ width: item.value ? `max(3px, ${pct}%)` : 0, background: item.color ?? color }} />
              </span>
            </li>
          );
        })}
      </ol>
      {items.length > limit && (
        <button type="button" className="ov-bars__more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "Mostrar menos" : `Mostrar todos (${formatNumber(items.length)})`}
        </button>
      )}
    </>
  );
}

import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { renderIcon } from "./Icon.jsx";
import { formatNumber } from "./format.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");
const itemValue = (item) => item.value ?? item.id;

// Measures the active element so the indicator can slide to it.
function useIndicator(containerRef, activeKey, deps = []) {
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const measure = () => {
      const el = container.querySelector('[data-active="true"]');
      if (!el) return setBox(null);
      setBox({
        left: el.offsetLeft,
        width: el.offsetWidth,
        top: el.offsetTop,
        height: el.offsetHeight,
      });
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    return () => observer?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, ...deps]);
  return box;
}

// Roving focus for tablists and radiogroups (arrows, Home, End).
function rovingKeyDown(event, values, current, select, { vertical = false } = {}) {
  const enabled = values.filter((v) => !v.disabled).map((v) => v.value);
  const index = enabled.indexOf(current);
  const next = { ArrowRight: 1, ArrowLeft: -1, ...(vertical ? { ArrowDown: 1, ArrowUp: -1 } : {}) }[
    event.key
  ];
  let target;
  if (next) target = enabled[(index + next + enabled.length) % enabled.length];
  else if (event.key === "Home") target = enabled[0];
  else if (event.key === "End") target = enabled[enabled.length - 1];
  if (target === undefined) return;
  event.preventDefault();
  const container = event.currentTarget;
  select(target);
  requestAnimationFrame(() =>
    container?.querySelector(`[data-value="${CSS.escape(String(target))}"]`)?.focus(),
  );
}

// ---------------------------------------------------------------- Tabs

// items: [{value|id, label, count, icon, disabled, content}]. The active
// panel renders `item.content` or `children`; without either, only the tablist.
export function Tabs({
  items,
  tabs,
  value,
  onChange,
  children,
  className,
  panelClassName,
  "aria-label": ariaLabel,
  size = "md",
}) {
  const list = (items || tabs || []).map((item) => ({ ...item, value: itemValue(item) }));
  const baseId = useId();
  const listRef = useRef(null);
  const active = value ?? list[0]?.value;
  const box = useIndicator(listRef, active, [list.length]);
  const activeItem = list.find((item) => item.value === active);
  const panelContent = activeItem?.content ?? children;
  const hasPanel = panelContent !== undefined && panelContent !== null;
  const tabId = (v) => `${baseId}-tab-${v}`;
  const panelId = `${baseId}-panel`;

  return (
    <div className={cx("ui-tabs", `ui-tabs--${size}`, className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        className="ui-tabs__list"
        onKeyDown={(event) => rovingKeyDown(event, list, active, (v) => onChange?.(v))}
      >
        {list.map((item) => {
          const selected = item.value === active;
          return (
            <button
              key={item.value}
              id={tabId(item.value)}
              type="button"
              role="tab"
              data-value={item.value}
              data-active={selected}
              aria-selected={selected}
              aria-controls={hasPanel && selected ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              className="ui-tab"
              onClick={() => onChange?.(item.value)}
            >
              {renderIcon(item.icon, { size: 16 })}
              <span>{item.label}</span>
              {item.count !== undefined && item.count !== null && (
                <span className="ui-tab__count">{formatNumber(item.count)}</span>
              )}
            </button>
          );
        })}
        <span
          className="ui-tabs__indicator"
          aria-hidden="true"
          style={
            box ? { transform: `translateX(${box.left}px)`, width: box.width } : { opacity: 0 }
          }
        />
      </div>
      {hasPanel && (
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={tabId(active)}
          tabIndex={0}
          className={cx("ui-tabs__panel", panelClassName)}
        >
          {panelContent}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Segmented

// Compact exclusive choice (Grade / Lista / Calendário). Radiogroup semantics
// with roving tabindex. options: [{value, label, icon, disabled}].
// `iconOnly` hides labels visually (they stay as accessible names).
export function Segmented({
  options,
  items,
  value,
  onChange,
  className,
  size = "md",
  iconOnly = false,
  "aria-label": ariaLabel,
}) {
  const list = (options || items || []).map((item) => ({ ...item, value: itemValue(item) }));
  const ref = useRef(null);
  const box = useIndicator(ref, value, [list.length]);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx("ui-seg", `ui-seg--${size}`, iconOnly && "ui-seg--icons", className)}
      onKeyDown={(event) =>
        rovingKeyDown(event, list, value, (v) => onChange?.(v), { vertical: true })
      }
    >
      <span
        className="ui-seg__thumb"
        aria-hidden="true"
        style={box ? { transform: `translateX(${box.left}px)`, width: box.width } : { opacity: 0 }}
      />
      {list.map((item) => {
        const checked = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={iconOnly ? item.label : undefined}
            title={iconOnly ? item.label : undefined}
            data-value={item.value}
            data-active={checked}
            tabIndex={checked || (value === undefined && item === list[0]) ? 0 : -1}
            disabled={item.disabled}
            className="ui-seg__opt"
            onClick={() => onChange?.(item.value)}
          >
            {renderIcon(item.icon, { size: 16 })}
            {!iconOnly && <span>{item.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Pagination

function pageList(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set([1, pages, page - 1, page, page + 1]);
  const sorted = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out = [];
  sorted.forEach((p, i) => {
    if (i && p - sorted[i - 1] > 1) out.push(`gap-${p}`);
    out.push(p);
  });
  return out;
}

// "1–50 de 230" + previous/next + compact page numbers.
export function Pagination({
  page = 1,
  pageSize = 50,
  total = 0,
  onChange,
  className,
  label = "Paginação",
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && page === 1) {
    return total ? (
      <div className={cx("ui-pager", className)}>
        <span className="ui-pager__range">{plural(total)}</span>
      </div>
    ) : null;
  }
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className={cx("ui-pager", className)} aria-label={label}>
      <span className="ui-pager__range">
        {formatNumber(from)}–{formatNumber(to)} de {formatNumber(total)}
      </span>
      <div className="ui-pager__pages">
        <button
          type="button"
          className="ui-iconbtn ui-iconbtn--ghost ui-iconbtn--sm"
          aria-label="Página anterior"
          disabled={page <= 1}
          onClick={() => onChange?.(page - 1)}
        >
          <ChevronLeft size={16} strokeWidth={1.4} aria-hidden="true" />
        </button>
        {pageList(page, pages).map((p) =>
          typeof p === "string" ? (
            <span key={p} className="ui-pager__gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className={cx("ui-pager__page", p === page && "is-current")}
              aria-current={p === page ? "page" : undefined}
              aria-label={`Página ${p}`}
              onClick={() => onChange?.(p)}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          className="ui-iconbtn ui-iconbtn--ghost ui-iconbtn--sm"
          aria-label="Próxima página"
          disabled={page >= pages}
          onClick={() => onChange?.(page + 1)}
        >
          <ChevronRight size={16} strokeWidth={1.4} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

const plural = (n) => `${formatNumber(n)} ${n === 1 ? "item" : "itens"}`;

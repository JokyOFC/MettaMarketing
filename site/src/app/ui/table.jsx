import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, X } from "lucide-react";
import { Checkbox } from "./forms.jsx";
import { EmptyState, ErrorState, SkeletonRows } from "./display.jsx";
import { renderIcon } from "./Icon.jsx";
import { useIsNarrow } from "./hooks.js";
import { showLayer, supportsPopover, usePresence } from "./layer.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");
const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

const INTERACTIVE =
  "a, button, input, select, textarea, label, summary, [role='button'], [role='menuitem'], [data-no-row-click]";

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof Date && b instanceof Date) return a - b;
  return collator.compare(String(a), String(b));
}

const cellValue = (column, row) =>
  column.render ? column.render(row) : column.accessor ? column.accessor(row) : row[column.key];

// ---------------------------------------------------------------- BulkBar

// Keyboard shortcut that moves focus to the open bulk bar from anywhere.
export const BULK_SHORTCUT = "Alt+Shift+L";
const isBulkShortcut = (event) =>
  event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyL";

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// Controls that pick items: where Esc in the bar sends focus back to.
const SELECTION_CONTROL =
  'input[type="checkbox"], [role="checkbox"], [aria-pressed], [aria-checked], [aria-selected]';

const openBars = []; // bars currently on screen, most recent last
const barListeners = new Set();
const notifyBars = () => barListeners.forEach((fn) => fn());
const subscribeBars = (fn) => {
  barListeners.add(fn);
  return () => barListeners.delete(fn);
};
const barCount = () => openBars.length;
const barSpace = new Map(); // bar element -> px it covers above the viewport bottom

const usable = (el) => Boolean(el?.isConnected && el.getClientRects().length);

function firstBarControl(bar) {
  const actions = bar.querySelector(".ui-bulkbar__actions");
  return [...(actions?.querySelectorAll(FOCUSABLE) || []), ...bar.querySelectorAll(FOCUSABLE)].find(
    usable,
  );
}

// Moves focus to the first action of the most recently opened bulk bar.
// Returns false when no bar is open.
export function focusBulkBar() {
  for (let i = openBars.length - 1; i >= 0; i -= 1) {
    const target = firstBarControl(openBars[i]);
    if (target) {
      target.focus();
      return true;
    }
  }
  return false;
}

function onBulkShortcut(event) {
  if (event.defaultPrevented || !isBulkShortcut(event)) return;
  if (focusBulkBar()) event.preventDefault();
}

// Toasts and other bottom-anchored layers read --ui-bulkbar-h to stay above
// the bar instead of covering its actions.
function publishBarSpace() {
  const root = document.documentElement;
  const max = Math.max(0, ...barSpace.values());
  if (max > 0) root.style.setProperty("--ui-bulkbar-h", `${Math.ceil(max)}px`);
  else root.style.removeProperty("--ui-bulkbar-h");
}

// Reads the shell's sidebar width (inherited custom property) so the bar can
// center itself on the content column.
function readContentOffset(el) {
  const style = getComputedStyle(el);
  const raw = style.getPropertyValue("--app-inset-left") || style.getPropertyValue("--sh-sidebar-w");
  return parseFloat(raw) || 0;
}

// For page-specific floating batch bars that don't use <BulkBar> (e.g. the
// library's): registers `el` like an open BulkBar, so BULK_SHORTCUT reaches it
// and toasts/trays keep clear of it through --ui-bulkbar-h. Returns cleanup.
export function registerBulkBar(el) {
  if (!el) return () => {};
  openBars.push(el);
  notifyBars();
  if (openBars.length === 1) document.addEventListener("keydown", onBulkShortcut);
  const measure = () => {
    const bottom = parseFloat(getComputedStyle(el).bottom) || 0;
    barSpace.set(el, el.offsetHeight + bottom);
    publishBarSpace();
  };
  measure();
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
  observer?.observe(el);
  window.addEventListener("resize", measure);
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", measure);
    const i = openBars.indexOf(el);
    if (i >= 0) openBars.splice(i, 1);
    notifyBars();
    if (!openBars.length) document.removeEventListener("keydown", onBulkShortcut);
    barSpace.delete(el);
    publishBarSpace();
  };
}

// Floating bar at the bottom of the viewport for batch actions.
// It is rendered where the page places it, so it follows the selection in the
// tab order (put it right after the selectable list); it is shown in the top
// layer (Popover API) so no transformed ancestor can trap its fixed position.
// Keyboard: Alt+Shift+L (BULK_SHORTCUT) or <BulkJump> moves focus to its first
// action; Esc inside the bar returns focus to the last selection control
// (or `returnFocusRef`). Clearing the selection returns focus there too.
export function BulkBar({
  count = 0,
  children,
  actions,
  onClear,
  label = "Ações em lote",
  noun = ["selecionado", "selecionados"],
  returnFocusRef,
}) {
  const open = count > 0;
  const presence = usePresence(open, 220);
  const [shown, setShown] = useState(count);
  const [offset, setOffset] = useState(0);
  const barRef = useRef(null);
  const lastSelection = useRef(null);
  const lastOutside = useRef(null);
  const focusInside = useRef(false);
  const [announce, setAnnounce] = useState("");
  const wasOpen = useRef(false);

  useEffect(() => {
    if (count > 0) setShown(count);
  }, [count]);

  // Persistent live region (it exists before the bar appears, so the first
  // selection is announced too, with the shortcut).
  useEffect(() => {
    const words = `${count} ${count === 1 ? noun[0] : noun[1]}`;
    if (count > 0 && !wasOpen.current)
      setAnnounce(`${words}. Ações em lote disponíveis: ${BULK_SHORTCUT}.`);
    else if (count > 0) setAnnounce(words);
    else if (wasOpen.current) setAnnounce("Seleção limpa.");
    wasOpen.current = count > 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  // Remember the control that picked items (for Esc and after clearing).
  useEffect(() => {
    const onFocusIn = (event) => {
      const t = event.target;
      if (!(t instanceof Element) || barRef.current?.contains(t)) return;
      lastOutside.current = t;
      if (t.matches(SELECTION_CONTROL)) lastSelection.current = t;
    };
    const onChange = (event) => {
      const t = event.target;
      if (!(t instanceof Element) || barRef.current?.contains(t)) return;
      if (t.matches('input[type="checkbox"]')) lastSelection.current = t;
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("change", onChange, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("change", onChange, true);
    };
  }, []);

  const returnTarget = useCallback(
    () =>
      [returnFocusRef?.current, lastSelection.current, lastOutside.current].find(usable) || null,
    [returnFocusRef],
  );

  const mounted = presence !== "closed";
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!mounted || !bar) return undefined;
    showLayer(bar);
    openBars.push(bar);
    notifyBars();
    if (openBars.length === 1) document.addEventListener("keydown", onBulkShortcut);
    const measure = () => {
      setOffset(readContentOffset(bar));
      const bottom = parseFloat(getComputedStyle(bar).bottom) || 0;
      barSpace.set(bar, bar.offsetHeight + bottom);
      publishBarSpace();
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(bar);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      const i = openBars.indexOf(bar);
      if (i >= 0) openBars.splice(i, 1);
      notifyBars();
      if (!openBars.length) document.removeEventListener("keydown", onBulkShortcut);
      barSpace.delete(bar);
      publishBarSpace();
    };
  }, [mounted]);

  // The bar left the screen while it had focus (selection cleared by an
  // action): send focus back to the list instead of losing it to <body>.
  useEffect(() => {
    if (mounted || !focusInside.current) return;
    focusInside.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) returnTarget()?.focus();
  }, [mounted, returnTarget]);

  const clear = () => {
    const target = returnTarget();
    onClear?.();
    target?.focus();
  };

  const onKeyDown = (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = returnTarget();
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    target.focus();
  };

  if (typeof document === "undefined") return null;
  return (
    <>
      <span className="ui-sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </span>
      {mounted && (
        <div
          ref={barRef}
          className="ui-bulkbar"
          role="region"
          aria-label={label}
          aria-keyshortcuts={BULK_SHORTCUT}
          popover={supportsPopover ? "manual" : undefined}
          data-state={presence}
          style={{ "--ui-bulk-offset": `${offset}px` }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            focusInside.current = true;
          }}
          onBlur={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
              focusInside.current = false;
          }}
        >
          <span className="ui-bulkbar__count">
            <strong>{shown}</strong> {shown === 1 ? noun[0] : noun[1]}
          </span>
          <div className="ui-bulkbar__actions">{actions ?? children}</div>
          {onClear && (
            <button type="button" className="ui-bulkbar__clear" onClick={clear}>
              <X size={16} strokeWidth={1.4} aria-hidden="true" />
              <span>Limpar seleção</span>
            </button>
          )}
        </div>
      )}
    </>
  );
}

// Skip-link style helper placed next to a selection control: invisible until
// it receives keyboard focus, then "Ir para as ações em lote (N)" moves focus
// into the bar. It only exists while a bulk bar is open (whoever renders it).
// DataTable puts one after the checkbox used last; card grids can do the same.
export function BulkJump({ count = 0, className }) {
  const bars = useSyncExternalStore(subscribeBars, barCount, () => 0);
  if (!count || !bars) return null;
  return (
    <button
      type="button"
      className={cx("ui-bulkjump", className)}
      aria-keyshortcuts={BULK_SHORTCUT}
      data-no-row-click
      onClick={(event) => {
        event.stopPropagation();
        focusBulkBar();
      }}
    >
      Ir para as ações em lote ({count})
    </button>
  );
}

function renderBulkActions(bulkActions, ids, rows, clear) {
  if (!bulkActions) return null;
  if (typeof bulkActions === "function") return bulkActions(ids, rows, clear);
  if (!Array.isArray(bulkActions)) return bulkActions;
  return bulkActions.map((action) => (
    <button
      key={action.label}
      type="button"
      className={cx("ui-bulkbar__action", action.tone === "danger" && "is-danger")}
      disabled={action.disabled}
      onClick={() => action.onClick?.(ids, rows, clear)}
    >
      {renderIcon(action.icon, { size: 16 })}
      <span>{action.label}</span>
    </button>
  ));
}

// ---------------------------------------------------------------- DataTable

const ALL = "\u0000all";

// Column classes shared by <th> and <td>. `numeric` (or align "end" + nowrap)
// shrinks the column to its content so text columns get the room.
const columnClasses = (column) =>
  cx(
    column.align && `is-${column.align}`,
    (column.numeric || (column.align === "end" && column.nowrap)) && "is-num",
    column.primary && "is-primary",
    column.actions && "is-actions",
  );

const columnStyle = (column) => {
  const style = {};
  if (column.width) style.width = column.width;
  if (column.minWidth) style.minWidth = column.minWidth;
  return Object.keys(style).length ? style : undefined;
};

// Watches the width the table gets (not the viewport). Columns with
// `hideBelow` leave first; if the table still overflows it turns compact
// (headers may wrap, so short numeric columns stop claiming a long header's
// width), and if even that does not fit, the rows become cards.
// `needs[level]` remembers how wide the table was at each level, so a roomier
// level only comes back once there is room for it.
const COMPACT = 1;
const CARDS = 2;
function useFit(rootRef, columns, enabled) {
  const [fit, setFit] = useState({ width: 0, level: 0, needs: [0, 0] });
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const observerRef = useRef(null);
  const observedRef = useRef(null);

  // The observed element changes between the table and the card layout, so
  // this re-subscribes whenever the root node is a different one.
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (node === observedRef.current) return;
    observerRef.current?.disconnect();
    observerRef.current = null;
    observedRef.current = node;
    if (!node || typeof ResizeObserver === "undefined") return;
    const bucket = (width) =>
      columnsRef.current
        .filter((c) => c.hideBelow && width < c.hideBelow)
        .map((c) => c.key)
        .join("|");
    const update = () => {
      const width = node.clientWidth;
      if (!width) return;
      const current = fitRef.current;
      let level = current.level;
      while (level > 0 && width >= current.needs[level - 1]) level -= 1;
      if (level !== current.level || !current.width || bucket(width) !== bucket(current.width))
        setFit({ ...current, width, level });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observerRef.current = observer;
    update();
  });
  useLayoutEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedRef.current = null;
    },
    [],
  );

  // Called after the table rendered: one level down when it overflows.
  const check = useCallback(
    (wrap, table) => {
      if (!enabled || !wrap || !table) return;
      const need = table.offsetWidth;
      if (need <= wrap.clientWidth + 1) return;
      setFit((f) => {
        if (f.level >= CARDS) return f;
        const needs = [...f.needs];
        needs[f.level] = need;
        return { ...f, level: f.level + 1, needs };
      });
    },
    [enabled],
  );
  const level = enabled ? fit.level : 0;
  return { width: fit.width, compact: level === COMPACT, cards: level === CARDS, check };
}

// columns: [{key, header, render(row), accessor(row), sortable, sortValue(row),
//   align: 'start'|'end'|'center', width, minWidth, nowrap, numeric, primary,
//   actions, hideOnMobile, hideBelow (px of table width), mobileLabel}]
// selection: `selected` (Set or array) + onSelectedChange (same type back).
// Sorting is client-side unless `sort` + onSortChange are given.
// Rows become stacked cards below 760px and also, with cards="auto" (default),
// whenever the table does not fit the width it is given (beside the sidebar
// on a tablet, inside a drawer). cards="narrow" keeps the table and its
// horizontal scroll there; the actions column stays pinned to the right.
// `bare` drops the card chrome when the table already sits inside a Panel.
// The header is sticky within `maxHeight` (the wrapper scrolls horizontally).
export function DataTable({
  columns = [],
  rows = [],
  rowKey = "id",
  selectable = false,
  selected: selectedProp,
  onSelectedChange,
  bulkActions,
  onRowClick,
  rowLabel,
  loading = false,
  error,
  onRetry,
  empty,
  sort: sortProp,
  onSortChange,
  defaultSort,
  caption,
  maxHeight,
  dense = false,
  bare = false,
  cards: cardsMode = "auto",
  className,
  rowClassName,
  isRowSelectable,
  "aria-label": ariaLabel,
}) {
  const narrow = useIsNarrow();
  const captionId = useId();
  const keyOf = (row) => (typeof rowKey === "function" ? rowKey(row) : row[rowKey]);
  const rootRef = useRef(null);
  const tableRef = useRef(null);
  const [lastToggled, setLastToggled] = useState(null);

  const fit = useFit(rootRef, columns, cardsMode === "auto" && !narrow);
  const visibleColumns = columns.filter(
    (c) => !(c.hideBelow && fit.width && fit.width < c.hideBelow),
  );
  const asCards = narrow || fit.cards;

  const [innerSelected, setInnerSelected] = useState(() => new Set());
  const controlled = selectedProp !== undefined;
  const selectedSet = useMemo(
    () =>
      controlled
        ? selectedProp instanceof Set
          ? selectedProp
          : new Set(selectedProp || [])
        : innerSelected,
    [controlled, selectedProp, innerSelected],
  );
  const setSelected = (next) => {
    if (!controlled) setInnerSelected(next);
    onSelectedChange?.(Array.isArray(selectedProp) ? [...next] : next);
  };

  const [innerSort, setInnerSort] = useState(defaultSort || null);
  const sort = sortProp !== undefined ? sortProp : innerSort;
  const changeSort = (key) => {
    const next =
      sort?.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
    if (onSortChange) onSortChange(next);
    else setInnerSort(next);
  };

  const sortedRows = useMemo(() => {
    if (!sort || onSortChange) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column) return rows;
    const value = column.sortValue || column.accessor || ((row) => row[column.key]);
    const out = [...rows].sort((a, b) => compare(value(a), value(b)));
    return sort.dir === "desc" ? out.reverse() : out;
  }, [rows, sort, columns, onSortChange]);

  const selectableRows = sortedRows.filter((row) => !isRowSelectable || isRowSelectable(row));
  const visibleIds = selectableRows.map(keyOf);
  const selectedVisible = visibleIds.filter((id) => selectedSet.has(id));
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  const someSelected = selectedVisible.length > 0 && !allSelected;

  const toggleRow = (id) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setLastToggled({ id });
    setSelected(next);
  };
  const toggleAll = () => {
    const next = new Set(selectedSet);
    if (allSelected) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    setLastToggled({ all: true });
    setSelected(next);
  };
  const clear = () => setSelected(new Set());

  // Table layout: once rendered, check that it fits the width it was given.
  useLayoutEffect(() => {
    if (!asCards) fit.check(rootRef.current, tableRef.current);
  });

  const rowClick = (row) => (event) => {
    if (!onRowClick) return;
    if (
      event.target.closest?.(INTERACTIVE) &&
      event.target.closest(INTERACTIVE) !== event.currentTarget
    )
      return;
    onRowClick(row, event);
  };
  const rowKeyDown = (row) => (event) => {
    if (!onRowClick || event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onRowClick(row, event);
    }
  };

  const selectedIds = [...selectedSet];
  const selectedRows = rows.filter((row) => selectedSet.has(keyOf(row)));
  const hasBulk = Boolean(selectable && bulkActions);
  // The bar may be the table's own (bulkActions) or one the page renders for
  // the same selection: BulkJump shows only while some bar is open.
  const bulk = hasBulk && (
    <BulkBar count={selectedIds.length} onClear={clear}>
      {renderBulkActions(bulkActions, selectedIds, selectedRows, clear)}
    </BulkBar>
  );
  // "Ir para as ações em lote" right after the checkbox that was just used.
  const jumpAfter = (id) =>
    selectable &&
    selectedIds.length > 0 &&
    (id === ALL ? lastToggled?.all : lastToggled?.id === id && selectedSet.has(id)) && (
      <BulkJump count={selectedIds.length} />
    );

  const wrapClass = (...extra) =>
    cx("ui-table-wrap", bare && "ui-table-wrap--bare", ...extra, className);

  if (loading && !rows.length)
    return (
      <div className={wrapClass()} aria-busy="true">
        <SkeletonRows rows={6} columns={Math.min(4, Math.max(2, columns.length - 1))} />
      </div>
    );
  if (error && !rows.length)
    return (
      <div className={wrapClass()}>
        <ErrorState error={error} onRetry={onRetry} compact />
      </div>
    );
  if (!rows.length) {
    const node =
      empty && typeof empty === "object" && !empty.$$typeof ? (
        <EmptyState compact {...empty} />
      ) : (
        empty || <EmptyState compact title="Nada por aqui ainda" />
      );
    return <div className={wrapClass("is-empty")}>{node}</div>;
  }

  const primary = columns.find((c) => c.primary) || columns[0];
  const label = (row) => (rowLabel ? rowLabel(row) : String(keyOf(row)));

  if (asCards) {
    return (
      <>
        <div
          ref={rootRef}
          className={cx("ui-table-wrap ui-table-cards", !narrow && "is-wide", className)}
          aria-busy={loading || undefined}
        >
          {selectable && (
            <div className="ui-table-cards__all">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onChange={toggleAll}
                label={allSelected ? "Desmarcar todos" : "Selecionar todos"}
                size="lg"
              />
              {jumpAfter(ALL)}
            </div>
          )}
          <ul className="ui-rowcards" aria-label={ariaLabel || caption}>
            {sortedRows.map((row, index) => {
              const id = keyOf(row);
              const isSel = selectedSet.has(id);
              const canSelect = !isRowSelectable || isRowSelectable(row);
              return (
                <li
                  key={id}
                  className={cx(
                    "ui-rowcard",
                    "ui-enter",
                    isSel && "is-selected",
                    onRowClick && "is-clickable",
                    rowClassName?.(row),
                  )}
                  style={{ "--i": Math.min(index, 8) }}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={rowClick(row)}
                  onKeyDown={rowKeyDown(row)}
                >
                  <div className="ui-rowcard__head">
                    {selectable && canSelect && (
                      <span className="ui-rowcard__check">
                        <Checkbox
                          checked={isSel}
                          onChange={() => toggleRow(id)}
                          aria-label={`Selecionar ${label(row)}`}
                          size="lg"
                        />
                        {jumpAfter(id)}
                      </span>
                    )}
                    <div className="ui-rowcard__primary">{cellValue(primary, row)}</div>
                  </div>
                  <dl className="ui-rowcard__fields">
                    {columns
                      .filter(
                        (c) =>
                          c !== primary && !(narrow && c.hideOnMobile) && c.header !== undefined,
                      )
                      .map((column) => {
                        const value = cellValue(column, row);
                        if (value === null || value === undefined || value === "" || value === false)
                          return null;
                        return (
                          <div key={column.key} className={cx(column.actions && "is-actions")}>
                            {!column.actions && <dt>{column.mobileLabel ?? column.header}</dt>}
                            <dd>{value}</dd>
                          </div>
                        );
                      })}
                  </dl>
                </li>
              );
            })}
          </ul>
        </div>
        {bulk}
        {selectable && selectedIds.length > 0 && (
          <div className="ui-bulkbar-spacer" aria-hidden="true" />
        )}
      </>
    );
  }

  return (
    <>
      <div
        ref={rootRef}
        className={wrapClass(maxHeight && "has-max")}
        style={maxHeight ? { maxHeight } : undefined}
        aria-busy={loading || undefined}
      >
        <table
          ref={tableRef}
          className={cx(
            "ui-table",
            dense && "ui-table--dense",
            fit.compact && "is-compact",
            onRowClick && "is-clickable",
          )}
          aria-label={caption ? undefined : ariaLabel}
          aria-describedby={caption ? captionId : undefined}
        >
          {caption && (
            <caption id={captionId} className="ui-sr-only">
              {caption}
            </caption>
          )}
          <thead>
            <tr>
              {selectable && (
                <th scope="col" className="ui-table__check">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={toggleAll}
                    aria-label={allSelected ? "Desmarcar todos" : "Selecionar todos"}
                  />
                  {jumpAfter(ALL)}
                </th>
              )}
              {visibleColumns.map((column) => {
                const active = sort?.key === column.key;
                const ariaSort = column.sortable
                  ? active
                    ? sort.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                  : undefined;
                const SortIcon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={cx(columnClasses(column), column.headerClassName)}
                    style={columnStyle(column)}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        className={cx("ui-table__sort", active && "is-active")}
                        onClick={() => changeSort(column.key)}
                      >
                        <span>{column.header}</span>
                        <SortIcon size={13} strokeWidth={1.5} aria-hidden="true" />
                      </button>
                    ) : column.actions ? (
                      <span className="ui-sr-only">{column.header || "Ações"}</span>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, index) => {
              const id = keyOf(row);
              const isSel = selectedSet.has(id);
              const canSelect = !isRowSelectable || isRowSelectable(row);
              return (
                <tr
                  key={id}
                  className={cx(isSel && "is-selected", rowClassName?.(row))}
                  style={{ "--i": Math.min(index, 8) }}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={rowClick(row)}
                  onKeyDown={rowKeyDown(row)}
                >
                  {selectable && (
                    <td className="ui-table__check">
                      {canSelect && (
                        <Checkbox
                          checked={isSel}
                          onChange={() => toggleRow(id)}
                          aria-label={`Selecionar ${label(row)}`}
                        />
                      )}
                      {canSelect && jumpAfter(id)}
                    </td>
                  )}
                  {visibleColumns.map((column) => (
                    <td
                      key={column.key}
                      className={cx(
                        columnClasses(column),
                        column.nowrap && "is-nowrap",
                        column.className,
                      )}
                      style={column.minWidth ? { minWidth: column.minWidth } : undefined}
                    >
                      {cellValue(column, row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {bulk}
      {selectable && selectedIds.length > 0 && (
        <div className="ui-bulkbar-spacer" aria-hidden="true" />
      )}
    </>
  );
}

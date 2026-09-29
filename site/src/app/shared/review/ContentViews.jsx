import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Clock,
  Layers,
  Megaphone,
  MessageSquareWarning,
  PackageCheck,
  Play,
} from "lucide-react";
import {
  BulkJump,
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Modal,
  StatusBadge,
  Thumb,
  formatDate,
  formatDuration,
  formatWeekday,
  isoDate,
  monthKey,
  monthLabel,
  networkLabel,
  plural,
  postFormatLabel,
  statusLabel,
  useIsNarrow,
} from "../../ui/index.js";
import { cx, postRatio } from "./util.js";
import "./review.css";

const FRAME = 4 / 5;
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const WEEKDAYS_LONG = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export const isVideoPost = (item) =>
  item?.mediaKind === "video" || item?.post?.format === "reels" || item?.post?.format === "video";
export const isCarouselPost = (item) => (item?.slides ?? 0) > 1;

export function postDateLabel(item, { year = false } = {}) {
  const date = item?.post?.plannedDate;
  if (!date) return "Sem data prevista";
  return `${formatDate(date, { year })}${item.post.plannedTime ? `, ${item.post.plannedTime}` : ""}`;
}

// Approval, publication and delivery are separate axes: discreet badges,
// never merged into one status. `stack` lays them out one per line (tables).
export function PostStatus({ item, admin = false, size = "sm", stack = false, showReleased = false }) {
  const approval = item.requiresApproval && item.approvalStatus !== "none" ? item.approvalStatus : null;
  const publication = item.post?.publicationStatus;
  return (
    <span className={cx("cnt-status", stack && "cnt-status--stack")}>
      {admin && (item.visibility !== "released" || showReleased) && (
        <StatusBadge kind="visibility" value={item.visibility} size={size} />
      )}
      {approval && <StatusBadge kind="approval" value={approval} size={size} />}
      {publication && publication !== "not_scheduled" && <StatusBadge kind="publication" value={publication} size={size} />}
      {item.deliveredAt && <StatusBadge kind="delivered" value={item.deliveredAt} size={size} />}
      {item.archivedAt && <StatusBadge kind="archived" value={true} size={size} />}
    </span>
  );
}

// Sort key for the "Situação" column: visibility, then approval, publication
// and delivery, in the order the work moves.
const SITUATION_ORDER = {
  draft: 0,
  internal_review: 1,
  changes_requested: 2,
  pending: 3,
  none: 4,
  approved: 5,
};
const situationSort = (item) =>
  [
    SITUATION_ORDER[item.visibility === "released" ? item.approvalStatus : item.visibility] ?? 9,
    { not_scheduled: 0, scheduled: 1, published: 2 }[item.post?.publicationStatus] ?? 0,
    item.deliveredAt ? 1 : 0,
  ].join("");

// Thumbnail at the post's real proportion inside a regular 4:5 frame, so the
// grid stays aligned and nothing is cropped (stories/reels read as 9:16).
export function PostThumb({ item, size = "card", className }) {
  const ratio = postRatio(item);
  const wide = ratio >= FRAME;
  const video = isVideoPost(item);
  const slides = item.slides ?? 0;
  return (
    <div className={cx("cnt-frame", `cnt-frame--${size}`, className)}>
      <div className="cnt-frame__media" style={{ "--ratio": ratio, ...(wide ? { width: "100%" } : { height: "100%" }) }}>
        <Thumb
          thumb={item.thumb}
          aspect={ratio}
          fit="cover"
          showPlay={false}
          alt=""
          mediaKind={item.thumb?.mediaKind || item.mediaKind || "image"}
          format={item.formats?.[0]}
        />
      </div>
      {size === "card" && slides > 1 && (
        <span className="cnt-badge cnt-badge--slides" title={`Carrossel com ${slides} slides`}>
          <Layers size={13} strokeWidth={1.4} aria-hidden="true" />
          <span className="ui-sr-only">Carrossel com </span>
          {slides}
          <span className="ui-sr-only"> slides</span>
        </span>
      )}
      {size === "card" && video && (
        <span className="cnt-badge cnt-badge--video">
          <Play size={12} strokeWidth={1.6} aria-hidden="true" />
          <span className="ui-sr-only">Vídeo </span>
          {item.durationMs ? formatDuration(item.durationMs) : "Vídeo"}
        </span>
      )}
    </div>
  );
}

// jumpCount: this card holds the checkbox used last, so a keyboard user gets
// the kit's "Ir para as ações em lote (N)" skip link right after it.
export function PostCard({ item, to, index = 0, admin = false, selectable = false, selected = false, onToggle, jumpCount = 0 }) {
  return (
    <article className={cx("cnt-card", "ui-enter", selected && "is-selected")} style={{ "--i": Math.min(index, 8) }}>
      <Link to={to} className="cnt-card__link">
        <PostThumb item={item} />
        <div className="cnt-card__body">
          <h3 className="cnt-card__title">{item.title}</h3>
          <p className="cnt-card__meta">
            <span>{networkLabel(item.post?.network)}</span>
            <span aria-hidden="true"> · </span>
            <span>{postFormatLabel(item.post?.format)}</span>
          </p>
          <p className="cnt-card__date">
            <CalendarDays size={13} strokeWidth={1.4} aria-hidden="true" />
            {postDateLabel(item)}
          </p>
          {admin && (
            <p className="cnt-card__client">
              {item.client?.name}
              {item.brand?.name && item.brand.name !== item.client?.name ? ` · ${item.brand.name}` : ""}
            </p>
          )}
        </div>
      </Link>
      <div className="cnt-card__foot">
        <PostStatus item={item} admin={admin} />
      </div>
      {selectable && (
        <span className="cnt-card__check">
          <Checkbox checked={selected} onCheckedChange={() => onToggle?.(item.id)} aria-label={`Selecionar ${item.title}`} size="lg" />
          {jumpCount > 0 && <BulkJump count={jumpCount} />}
        </span>
      )}
    </article>
  );
}

export function PostGrid({ items, linkFor, admin, selection, jump = null }) {
  return (
    <ul className="cnt-grid" aria-label="Publicações">
      {items.map((item, index) => (
        <li key={item.id}>
          <PostCard
            item={item}
            to={linkFor(item)}
            index={index}
            admin={admin}
            selectable={Boolean(selection)}
            selected={selection?.has(item.id)}
            onToggle={selection?.toggle}
            jumpCount={jump?.id === item.id ? jump.count : 0}
          />
        </li>
      ))}
    </ul>
  );
}

// Compact row (agenda, day list, approval strip).
export function PostRow({ item, to, admin = false, aside }) {
  return (
    <div className="cnt-row">
      <Link to={to} className="cnt-row__link">
        <PostThumb item={item} size="mini" />
        <span className="cnt-row__text">
          <span className="cnt-row__title">{item.title}</span>
          <span className="cnt-row__meta">
            {networkLabel(item.post?.network)} · {postFormatLabel(item.post?.format)}
            {item.post?.plannedTime ? ` · ${item.post.plannedTime}` : ""}
            {admin && item.client?.name ? ` · ${item.client.name}` : ""}
          </span>
        </span>
      </Link>
      <PostStatus item={item} admin={admin} />
      {aside}
    </div>
  );
}

// DataTable columns for the list view. The states sit together in one
// "Situação" cell (one badge per axis, each with its own words) so the table
// fits the content column; the team's responsible person rides in the title
// line.
export function postColumns({ admin = false } = {}) {
  const columns = [
    {
      key: "title",
      header: "Post",
      primary: true,
      sortable: true,
      sortValue: (item) => item.title,
      render: (item) => {
        const meta = [item.post?.campaign?.name, admin && item.owner?.name ? `Resp.: ${item.owner.name}` : null].filter(Boolean);
        return (
          <span className="cnt-cell-title">
            <PostThumb item={item} size="mini" />
            <span className="cnt-cell-title__text">
              <span className="cnt-cell-title__name">{item.title}</span>
              {meta.length > 0 && <span className="cnt-cell-title__sub">{meta.join(" · ")}</span>}
            </span>
          </span>
        );
      },
    },
  ];
  if (admin)
    columns.push({
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
    });
  if (admin)
    columns.push({
      key: "network",
      header: "Rede e formato",
      sortable: true,
      nowrap: true,
      sortValue: (item) => `${item.post?.network} ${item.post?.format}`,
      render: (item) => (
        <span className="cnt-cell-stack">
          <span>{networkLabel(item.post?.network)}</span>
          <span className="ui-meta">{postFormatLabel(item.post?.format)}</span>
        </span>
      ),
    });
  else
    columns.push(
      { key: "network", header: "Rede", sortable: true, render: (item) => networkLabel(item.post?.network), sortValue: (item) => item.post?.network },
      { key: "format", header: "Formato", sortable: true, render: (item) => postFormatLabel(item.post?.format), sortValue: (item) => item.post?.format, hideOnMobile: true },
    );
  columns.push(
    {
      key: "date",
      header: "Data prevista",
      sortable: true,
      nowrap: true,
      sortValue: (item) => `${item.post?.plannedDate ?? "9999"} ${item.post?.plannedTime ?? ""}`,
      render: (item) => (item.post?.plannedDate ? postDateLabel(item, { year: true }) : <span className="ui-muted">—</span>),
    },
  );
  columns.push({
    key: "situation",
    header: "Situação",
    mobileLabel: "Situação",
    sortable: true,
    sortValue: situationSort,
    render: (item) =>
      admin || (item.requiresApproval && item.approvalStatus !== "none") || item.post?.publicationStatus !== "not_scheduled" || item.deliveredAt ? (
        <PostStatus item={item} admin={admin} stack showReleased />
      ) : (
        <span className="ui-muted">—</span>
      ),
  });
  if (!admin)
    columns.push({
      key: "version",
      header: "Versão",
      align: "end",
      nowrap: true,
      hideOnMobile: true,
      render: (item) => (item.version ? <span className="ui-num">v{item.version.number}</span> : "—"),
      sortValue: (item) => item.version?.number ?? 0,
    });
  return columns;
}

// ---------------------------------------------------------------- calendar

// The one state a calendar chip shows with a glyph (plus its colour bar):
// published wins, then the client's decision; drafts for the team. Never
// colour alone: the glyph has a legend and the full status is read aloud.
const CAL_STATES = [
  { key: "pending", label: "Aguardando aprovação", Icon: Clock },
  { key: "changes", label: "Ajustes solicitados", Icon: MessageSquareWarning },
  { key: "approved", label: "Aprovado", Icon: Check },
  { key: "published", label: "Publicado", Icon: Megaphone },
];
const CAL_DRAFT = { key: "draft", label: "Ainda não liberado", Icon: CircleDashed };
// Delivery is its own axis: a second, independent mark on the chip.
const CAL_DELIVERED = { key: "delivered", label: "Arquivos finais entregues", Icon: PackageCheck };

function calendarState(item, admin) {
  if (item.post?.publicationStatus === "published") return CAL_STATES[3];
  if (admin && item.visibility !== "released") return CAL_DRAFT;
  if (item.approvalStatus === "changes_requested") return CAL_STATES[1];
  if (item.approvalStatus === "approved") return CAL_STATES[2];
  if (item.approvalStatus === "pending") return CAL_STATES[0];
  return null;
}

// Everything a screen reader hears about a chip's state, axis by axis.
function calendarStatusText(item, admin) {
  const parts = [];
  if (admin && item.visibility !== "released") parts.push(statusLabel("visibility", item.visibility));
  if (item.requiresApproval && item.approvalStatus && item.approvalStatus !== "none")
    parts.push(statusLabel("approval", item.approvalStatus));
  const publication = item.post?.publicationStatus;
  if (publication && publication !== "not_scheduled") parts.push(statusLabel("publication", publication));
  if (item.deliveredAt) parts.push(statusLabel("delivered", item.deliveredAt));
  return parts.map((part) => part.toLowerCase()).join(", ");
}

function CalendarLegend({ admin }) {
  const states = [...(admin ? [CAL_DRAFT] : []), ...CAL_STATES, CAL_DELIVERED];
  return (
    <ul className="cnt-cal__legend" aria-label="Legenda do calendário">
      {states.map(({ key, label, Icon }) => (
        <li key={key} className={cx("cnt-cal__legend-item", `is-${key}`)}>
          <Icon size={13} strokeWidth={1.6} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}

const fromIso = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (iso, n) => {
  const date = fromIso(iso);
  date.setDate(date.getDate() + n);
  return isoDate(date);
};
const longDay = (iso) => {
  const date = fromIso(iso);
  return `${WEEKDAYS_LONG[date.getDay()]}, ${date.getDate()} de ${MONTHS[date.getMonth()]}`;
};

// First and last day shown in the month grid (weeks start on Sunday).
export function calendarRange(month) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
  const end = new Date(start);
  end.setDate(start.getDate() + weeks * 7 - 1);
  return { from: isoDate(start), to: isoDate(end), weeks, first: isoDate(first), last: isoDate(last) };
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

function DayCell({ iso, inMonth, isToday, posts, focused, linkFor, admin, onFocusDay, onMore, cellRef }) {
  const day = fromIso(iso).getDate();
  const shown = posts.slice(0, 3);
  const extra = posts.length - shown.length;
  return (
    <div
      ref={cellRef}
      role="gridcell"
      tabIndex={focused ? 0 : -1}
      data-date={iso}
      aria-label={`${longDay(iso)}${posts.length ? `, ${plural(posts.length, "publicação", "publicações")}` : ", sem publicações"}`}
      aria-current={isToday ? "date" : undefined}
      className={cx("cnt-cal__day", !inMonth && "is-outside", isToday && "is-today", posts.length > 0 && "has-posts")}
      onFocus={() => onFocusDay(iso)}
    >
      <span className="cnt-cal__num" aria-hidden="true">
        {day}
      </span>
      {shown.length > 0 && (
        <ul className="cnt-cal__posts">
          {shown.map((item) => {
            const state = calendarState(item, admin);
            const status = calendarStatusText(item, admin);
            return (
              <li key={item.id}>
                <Link
                  to={linkFor(item)}
                  className={cx(
                    "cnt-cal__post",
                    `is-${item.approvalStatus}`,
                    item.post?.publicationStatus === "published" && "is-published",
                    state?.key === "draft" && "is-draft",
                  )}
                  tabIndex={focused ? 0 : -1}
                  title={state ? `${item.title} · ${state.label}` : item.title}
                >
                  <PostThumb item={item} size="dot" />
                  <span className="cnt-cal__post-text">
                    <span className="cnt-cal__line">
                      {state && (
                        <state.Icon className={cx("cnt-cal__glyph", `is-${state.key}`)} size={12} strokeWidth={1.8} aria-hidden="true" />
                      )}
                      {item.deliveredAt && (
                        <CAL_DELIVERED.Icon className="cnt-cal__glyph is-delivered" size={12} strokeWidth={1.8} aria-hidden="true" />
                      )}
                      {item.post?.plannedTime && <span className="cnt-cal__time ui-num">{item.post.plannedTime}</span>}
                    </span>
                    <span className="cnt-cal__title">{item.title}</span>
                  </span>
                  <span className="ui-sr-only">
                    {status ? `, ${status}` : ""}
                    {admin ? `, ${item.client?.name}` : ""}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {extra > 0 && (
        <button type="button" className="cnt-cal__more" tabIndex={focused ? 0 : -1} onClick={() => onMore(iso)}>
          + {extra} {extra === 1 ? "outra" : "outras"}
        </button>
      )}
    </div>
  );
}

// Month view with posts on their planned dates. Days are a keyboard grid
// (arrows, Home/End, Page Up/Down change month); phones get an agenda list.
export function ContentCalendar({ month, onMonthChange, items = [], undated = [], linkFor, admin = false, loading = false }) {
  const narrow = useIsNarrow();
  const range = calendarRange(month);
  const today = isoDate(new Date());
  const [focusDay, setFocusDay] = useState(() => (today >= range.first && today <= range.last ? today : range.first));
  const [dayOpen, setDayOpen] = useState(null);
  const cells = useRef(new Map());
  const moveFocus = useRef(false);

  const byDate = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      const date = item.post?.plannedDate;
      if (!date) continue;
      if (!map.has(date)) map.set(date, []);
      map.get(date).push(item);
    }
    for (const list of map.values())
      list.sort((a, b) => String(a.post?.plannedTime ?? "99").localeCompare(String(b.post?.plannedTime ?? "99")));
    return map;
  }, [items]);

  useEffect(() => {
    if (focusDay < range.from || focusDay > range.to) setFocusDay(today >= range.first && today <= range.last ? today : range.first);
  }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    cells.current.get(focusDay)?.focus();
  }, [focusDay, month]);

  const go = (iso) => {
    moveFocus.current = true;
    if (iso < range.first || iso > range.last) onMonthChange(iso.slice(0, 7));
    setFocusDay(iso);
  };
  const onKeyDown = (event) => {
    if (!event.target.matches?.('[role="gridcell"]')) return;
    const date = fromIso(focusDay);
    const map = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      Home: () => addDays(focusDay, -date.getDay()),
      End: () => addDays(focusDay, 6 - date.getDay()),
      PageUp: () => isoDate(new Date(date.getFullYear(), date.getMonth() - 1, Math.min(date.getDate(), 28))),
      PageDown: () => isoDate(new Date(date.getFullYear(), date.getMonth() + 1, Math.min(date.getDate(), 28))),
    };
    if (event.key === "Enter") {
      const link = event.target.querySelector("a, button");
      if (link) {
        event.preventDefault();
        link.focus();
      }
      return;
    }
    if (!map[event.key]) return;
    event.preventDefault();
    go(map[event.key]());
  };

  const days = Array.from({ length: range.weeks * 7 }, (_, i) => addDays(range.from, i));
  const monthPosts = days.filter((iso) => iso >= range.first && iso <= range.last && byDate.has(iso));

  const header = (
    <div className="cnt-cal__head">
      <h2 className="cnt-cal__month" aria-live="polite">
        {monthLabel(month)}
      </h2>
      <div className="cnt-cal__nav">
        <Button size="sm" variant="ghost" onClick={() => onMonthChange(monthKey(new Date()))} disabled={month === monthKey(new Date())}>
          Hoje
        </Button>
        <IconButton label="Mês anterior" icon={ChevronLeft} size="sm" onClick={() => onMonthChange(shiftMonth(month, -1))} />
        <IconButton label="Próximo mês" icon={ChevronRight} size="sm" onClick={() => onMonthChange(shiftMonth(month, 1))} />
      </div>
    </div>
  );

  const undatedBlock =
    undated.length > 0 ? (
      <section className="cnt-undated" aria-label="Sem data prevista">
        <h3 className="rv-section-title">Sem data prevista ({undated.length})</h3>
        <div className="cnt-undated__list">
          {undated.map((item) => (
            <PostRow key={item.id} item={item} to={linkFor(item)} admin={admin} />
          ))}
        </div>
      </section>
    ) : null;

  const dayModal = (
    <Modal open={Boolean(dayOpen)} onClose={() => setDayOpen(null)} size="sm" title={dayOpen ? longDay(dayOpen) : ""} eyebrow="Publicações do dia">
      <div className="cnt-daylist">
        {(byDate.get(dayOpen) ?? []).map((item) => (
          <PostRow key={item.id} item={item} to={linkFor(item)} admin={admin} />
        ))}
      </div>
    </Modal>
  );

  if (narrow)
    return (
      <div className={cx("cnt-cal cnt-cal--agenda", loading && "is-loading")} aria-busy={loading || undefined}>
        {header}
        {monthPosts.length ? (
          <ol className="cnt-agenda">
            {monthPosts.map((iso) => (
              <li key={iso} className={cx("cnt-agenda__day", iso === today && "is-today")}>
                <p className="cnt-agenda__date">
                  <span className="cnt-agenda__num">{fromIso(iso).getDate()}</span>
                  <span>{formatWeekday(iso)}</span>
                </p>
                <div className="cnt-agenda__posts">
                  {byDate.get(iso).map((item) => (
                    <PostRow key={item.id} item={item} to={linkFor(item)} admin={admin} />
                  ))}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState
            compact
            icon={CalendarDays}
            title={`Nada previsto em ${monthLabel(month, { year: false }).toLowerCase()}`}
            description="Use as setas para ver outros meses."
          />
        )}
        {undatedBlock}
      </div>
    );

  return (
    <div className={cx("cnt-cal", loading && "is-loading")} aria-busy={loading || undefined}>
      {header}
      <CalendarLegend admin={admin} />
      <div className="cnt-cal__grid" role="grid" aria-label={`Calendário de ${monthLabel(month)}`} onKeyDown={onKeyDown}>
        <div role="row" className="cnt-cal__week cnt-cal__week--head">
          {WEEKDAYS.map((day, i) => (
            <span key={day} role="columnheader" className="cnt-cal__wd" aria-label={WEEKDAYS_LONG[i]}>
              {day}
            </span>
          ))}
        </div>
        {Array.from({ length: range.weeks }, (_, week) => (
          <div role="row" className="cnt-cal__week" key={week}>
            {days.slice(week * 7, week * 7 + 7).map((iso) => (
              <DayCell
                key={iso}
                iso={iso}
                inMonth={iso >= range.first && iso <= range.last}
                isToday={iso === today}
                posts={byDate.get(iso) ?? []}
                focused={iso === focusDay}
                linkFor={linkFor}
                admin={admin}
                onFocusDay={setFocusDay}
                onMore={setDayOpen}
                cellRef={(node) => {
                  if (node) cells.current.set(iso, node);
                  else cells.current.delete(iso);
                }}
              />
            ))}
          </div>
        ))}
      </div>
      {!loading && !items.length && (
        <p className="cnt-cal__empty">Nenhuma publicação prevista neste mês. Use as setas para ver outros meses.</p>
      )}
      {undatedBlock}
      {dayModal}
    </div>
  );
}

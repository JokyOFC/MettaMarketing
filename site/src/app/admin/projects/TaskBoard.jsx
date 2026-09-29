import { useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRightLeft, ArrowUp, ArrowUpToLine, FileImage, Plus, UserRound } from "lucide-react";
import { Avatar, IconButton, Menu, useReducedMotion } from "../../ui/index.js";
import { DueLabel, cx } from "../clients/crmShared.jsx";
import { TASK_COLUMNS } from "./projectShared.jsx";
import "../clients/crm.css";

// Tasks of one column in board order.
export const columnTasks = (tasks, status) => tasks.filter((task) => task.status === status);

// Returns a new task list with `id` placed at `index` of column `status`.
export function moveTask(tasks, id, status, index) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return tasks;
  const moved = { ...task, status, completedAt: status === "done" ? task.completedAt ?? new Date().toISOString() : null };
  const out = [];
  for (const column of TASK_COLUMNS) {
    const list = tasks.filter((t) => t.status === column.value && t.id !== id);
    if (column.value === status) list.splice(Math.max(0, Math.min(index, list.length)), 0, moved);
    list.forEach((t, position) => out.push({ ...t, sortOrder: position }));
  }
  return out;
}

function TaskCard({ task, column, position, total, canMove, dragging, onOpen, onMoveTo, onDragStart, onDragEnd, registerRef }) {
  const done = task.status === "done";
  const moveItems = [
    { heading: "Mover para" },
    ...TASK_COLUMNS.filter((c) => c.value !== task.status).map((c) => ({
      label: c.label,
      icon: ArrowRightLeft,
      onSelect: () => onMoveTo(task, c.value, Number.MAX_SAFE_INTEGER),
    })),
    { divider: true },
    { label: "Para o topo", icon: ArrowUpToLine, disabled: position === 0, onSelect: () => onMoveTo(task, task.status, 0) },
    { label: "Subir", icon: ArrowUp, disabled: position === 0, onSelect: () => onMoveTo(task, task.status, position - 1) },
    { label: "Descer", icon: ArrowDown, disabled: position >= total - 1, onSelect: () => onMoveTo(task, task.status, position + 1) },
  ];
  return (
    <li
      ref={(node) => registerRef(task.id, node)}
      className={cx("crm-task", done && "is-done", dragging && "is-dragging")}
      data-task-id={task.id}
      draggable={canMove}
      onDragStart={(event) => onDragStart(event, task)}
      onDragEnd={onDragEnd}
      onClick={(event) => {
        if (event.target.closest("button, a, [role='menuitem']") && !event.target.closest(".crm-task__open")) return;
        onOpen(task);
      }}
    >
      <button type="button" className="crm-task__open" onClick={(event) => { event.stopPropagation(); onOpen(task); }}>
        <span className="crm-task__title">{task.title}</span>
      </button>
      <div className="crm-task__meta">
        {task.assignee ? (
          <span className="crm-task__who" title={task.assignee.name}>
            <Avatar name={task.assignee.name} size={22} decorative />
            <span>{task.assignee.name.split(" ")[0]}</span>
          </span>
        ) : (
          <span className="crm-task__who is-empty">
            <UserRound size={14} strokeWidth={1.4} aria-hidden="true" />
            <span>Sem responsável</span>
          </span>
        )}
        {task.dueDate && <DueLabel date={task.dueDate} done={done} compact />}
      </div>
      {task.material && (
        <span className="crm-task__material" title={task.material.title}>
          <FileImage size={13} strokeWidth={1.4} aria-hidden="true" />
          <span>{task.material.title}</span>
        </span>
      )}
      {canMove && (
        <div className="crm-task__move">
          <Menu
            label={`Mover a tarefa ${task.title} (${column.label}, posição ${position + 1} de ${total})`}
            icon={ArrowRightLeft}
            items={moveItems}
            minWidth={210}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Four-column board. Mouse: drag and drop. Keyboard and touch: the "Mover"
 * menu on every card. onMove(taskId, status, index) applies the change;
 * the board animates cards from where they were (FLIP).
 */
export default function TaskBoard({ tasks, canManage, onOpen, onCreate, onMove }) {
  const reduced = useReducedMotion();
  const boardRef = useRef(null);
  const nodes = useRef(new Map());
  const snapshot = useRef(null);
  const skipId = useRef(null);
  // Keyboard/touch moves ("Mover" menu): the card may remount in another
  // column (or be moved in the DOM), which drops focus to <body>. Keep it on
  // the moved card's "Mover" button, also if the server answer or a failed
  // save moves it again shortly after.
  const refocus = useRef(null); // { id, until }
  const [drag, setDrag] = useState(null); // { id, height }
  const [over, setOver] = useState(null); // { status, index }
  const [announcement, setAnnouncement] = useState("");

  const registerRef = (id, node) => {
    if (node) nodes.current.set(id, node);
    else nodes.current.delete(id);
  };

  const place = (el) => {
    const board = boardRef.current;
    const a = el.getBoundingClientRect();
    const b = board.getBoundingClientRect();
    return { x: a.left - b.left + board.scrollLeft, y: a.top - b.top };
  };
  const takeSnapshot = () => {
    if (reduced || !boardRef.current) return;
    const map = new Map();
    nodes.current.forEach((el, id) => map.set(id, place(el)));
    snapshot.current = map;
  };

  // FLIP: after a move, animate each card from its previous place.
  useLayoutEffect(() => {
    const before = snapshot.current;
    snapshot.current = null;
    if (!before || !boardRef.current) return;
    nodes.current.forEach((el, id) => {
      const from = before.get(id);
      if (!from) return;
      if (id === skipId.current) {
        el.animate([{ opacity: 0.4, transform: "scale(0.98)" }, { opacity: 1, transform: "none" }], {
          duration: 200,
          easing: "cubic-bezier(.22,1,.36,1)",
        });
        return;
      }
      const to = place(el);
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 260,
        easing: "cubic-bezier(.22,1,.36,1)",
      });
    });
    skipId.current = null;
  }, [tasks]);

  useLayoutEffect(() => {
    const target = refocus.current;
    if (!target) return;
    if (Date.now() > target.until) {
      refocus.current = null;
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return; // focus is somewhere on purpose
    const card = nodes.current.get(target.id);
    const button = card?.querySelector(".crm-task__move button") ?? card?.querySelector(".crm-task__open");
    if (!button) return;
    button.focus({ preventScroll: true });
    // reveal the card where it landed (after the FLIP animation, so the
    // scroll does not aim at the place it is animating from)
    const reveal = () => {
      if (card.isConnected) card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" });
    };
    const running = card.getAnimations?.() ?? [];
    if (running.length) Promise.all(running.map((animation) => animation.finished)).then(reveal, reveal);
    else reveal();
  }, [tasks, reduced]);

  const move = (task, status, index, { dropped = false } = {}) => {
    const list = columnTasks(tasks, status).filter((t) => t.id !== task.id);
    const target = Math.max(0, Math.min(index, list.length));
    const current = columnTasks(tasks, task.status).findIndex((t) => t.id === task.id);
    if (task.status === status && current === target) return;
    takeSnapshot();
    skipId.current = dropped ? task.id : null;
    refocus.current = dropped ? null : { id: task.id, until: Date.now() + 4000 };
    const label = TASK_COLUMNS.find((c) => c.value === status).label;
    setAnnouncement(`${task.title} movida para ${label}, posição ${target + 1}.`);
    onMove(task.id, status, target);
  };

  // ---------------------------------------------------------------- drag and drop (mouse)

  const onDragStart = (event, task) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
    const height = event.currentTarget.getBoundingClientRect().height;
    // let the browser take its drag image before the card dims
    requestAnimationFrame(() => setDrag({ id: task.id, height }));
  };
  const onDragEnd = () => {
    setDrag(null);
    setOver(null);
  };

  const indexFor = (listEl, clientY) => {
    const cards = [...listEl.querySelectorAll("[data-task-id]")].filter((el) => el.dataset.taskId !== drag?.id);
    for (let i = 0; i < cards.length; i += 1) {
      const rect = cards[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return cards.length;
  };

  const onDragOver = (event, status) => {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const index = indexFor(event.currentTarget, event.clientY);
    if (over?.status !== status || over?.index !== index) setOver({ status, index });
  };
  const onDragLeave = (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOver((current) => (current ? null : current));
  };
  const onDrop = (event, status) => {
    event.preventDefault();
    const id = drag?.id || event.dataTransfer.getData("text/plain");
    const task = tasks.find((t) => t.id === id);
    const index = over?.status === status ? over.index : columnTasks(tasks, status).filter((t) => t.id !== id).length;
    setDrag(null);
    setOver(null);
    if (task) move(task, status, index, { dropped: true });
  };

  return (
    <div className="crm-board" ref={boardRef}>
      {TASK_COLUMNS.map((column) => {
        const list = columnTasks(tasks, column.value);
        const dropIndex = over?.status === column.value ? over.index : -1;
        // the dragged card stays in place (dimmed); the slot shows where it lands
        const rows = [];
        let k = 0;
        list.forEach((task, position) => {
          if (task.id !== drag?.id) {
            if (dropIndex === k) rows.push(<DropSlot key="slot" height={drag?.height} />);
            k += 1;
          }
          rows.push(
            <TaskCard
              key={task.id}
              task={task}
              column={column}
              position={position}
              total={list.length}
              canMove={canManage}
              dragging={drag?.id === task.id}
              onOpen={onOpen}
              onMoveTo={move}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              registerRef={registerRef}
            />,
          );
        });
        if (dropIndex >= k) rows.push(<DropSlot key="slot" height={drag?.height} />);
        return (
          <section key={column.value} className={cx("crm-col", `crm-col--${column.value}`, dropIndex >= 0 && "is-over")} aria-label={column.label}>
            <header className="crm-col__head">
              <span className="crm-col__dot" aria-hidden="true" />
              <h3 className="crm-col__title">{column.label}</h3>
              <span className="crm-col__count">
                <span aria-hidden="true">{list.length}</span>
                <span className="ui-sr-only">
                  {list.length} {list.length === 1 ? "tarefa" : "tarefas"}
                </span>
              </span>
              {canManage && (
                <IconButton label={`Nova tarefa em ${column.label}`} icon={Plus} size="sm" variant="ghost" onClick={() => onCreate(column.value)} className="crm-col__add" />
              )}
            </header>
            <ul
              className="crm-col__list"
              onDragOver={(event) => onDragOver(event, column.value)}
              onDragLeave={onDragLeave}
              onDrop={(event) => onDrop(event, column.value)}
            >
              {rows}
              {!list.length && dropIndex < 0 && (
                <li className="crm-col__empty">{drag ? "Solte aqui" : column.value === "done" ? "Nada concluído ainda" : "Nenhuma tarefa"}</li>
              )}
            </ul>
          </section>
        );
      })}
      <span className="ui-sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

function DropSlot({ height }) {
  return <li className="crm-task-slot" aria-hidden="true" style={{ "--slot-h": `${Math.round(height || 64)}px` }} />;
}

import { useEffect, useId, useRef, useState } from "react";
import { BadgeCheck, CircleCheck, EyeOff, Lock, MessageSquare, MessageSquareWarning, Pencil, RotateCcw, Send } from "lucide-react";
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  Kbd,
  Select,
  SkeletonRows,
  Tabs,
  Textarea,
  formatDateTime,
  formatRelative,
  useApi,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import { cx } from "./util.js";
import "./review.css";

let tempSeq = 0;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

function KindLabel({ kind }) {
  if (kind === "change_request")
    return (
      <span className="rv-comment__kind rv-comment__kind--changes">
        <MessageSquareWarning size={14} strokeWidth={1.4} aria-hidden="true" />
        Pedido de ajuste
      </span>
    );
  if (kind === "approval_note")
    return (
      <span className="rv-comment__kind rv-comment__kind--approval">
        <BadgeCheck size={14} strokeWidth={1.4} aria-hidden="true" />
        Nota de aprovação
      </span>
    );
  return null;
}

function Comment({ comment, staff, onResolve, onEdit, index }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  const internal = comment.visibility === "internal";
  const team = !comment.author?.isClient;
  const save = async () => {
    if (!text.trim() || text.trim() === comment.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onEdit(comment, text.trim());
    setSaving(false);
    if (ok) setEditing(false);
  };
  return (
    <li
      className={cx(
        "rv-comment",
        "ui-enter",
        internal && "rv-comment--internal",
        comment.kind === "change_request" && "rv-comment--changes",
        comment.kind === "approval_note" && "rv-comment--approval",
        comment.pending && "is-pending",
        comment.resolvedAt && "is-resolved",
      )}
      style={{ "--i": Math.min(index, 8) }}
    >
      <Avatar name={comment.author?.name} size={32} decorative />
      <div className="rv-comment__main">
        <div className="rv-comment__head">
          <span className="rv-comment__author">{comment.author?.name || "Equipe Metta"}</span>
          <span className={cx("rv-chip", team ? "rv-chip--team" : "rv-chip--client")}>{team ? "Metta" : "Cliente"}</span>
          {comment.versionNumber != null && <span className="rv-chip rv-chip--quiet">v{comment.versionNumber}</span>}
          {comment.slidePosition != null && <span className="rv-chip rv-chip--quiet">slide {comment.slidePosition}</span>}
          <time className="rv-comment__time" dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>
            {comment.pending ? "enviando…" : formatRelative(comment.createdAt)}
          </time>
        </div>
        <KindLabel kind={comment.kind} />
        {editing ? (
          <div className="rv-comment__edit">
            <Textarea
              value={text}
              autoGrow
              rows={3}
              aria-label="Editar comentário"
              onValueChange={setText}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  save();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                  setText(comment.body);
                }
              }}
              autoFocus
            />
            <div className="rv-comment__edit-actions">
              <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setText(comment.body))}>
                Cancelar
              </Button>
              <Button size="sm" variant="primary" loading={saving} onClick={save}>
                Salvar
              </Button>
            </div>
          </div>
        ) : (
          <p className="rv-comment__body">{comment.body}</p>
        )}
        {(comment.editedAt || comment.resolvedAt) && !editing && (
          <p className="rv-comment__foot">
            {comment.editedAt && <span>editado</span>}
            {comment.resolvedAt && (
              <span className="rv-comment__resolved">
                <CircleCheck size={13} strokeWidth={1.4} aria-hidden="true" />
                Resolvido{comment.resolvedBy?.name ? ` por ${comment.resolvedBy.name}` : ""}
              </span>
            )}
          </p>
        )}
        {!comment.pending && !editing && (comment.mine || staff) && (
          <div className="rv-comment__actions">
            {comment.mine && comment.kind === "comment" && (
              <button type="button" className="rv-textbtn" onClick={() => setEditing(true)}>
                <Pencil size={13} strokeWidth={1.4} aria-hidden="true" />
                Editar
              </button>
            )}
            {staff && !internal && (
              <button type="button" className="rv-textbtn" onClick={() => onResolve(comment, !comment.resolvedAt)}>
                {comment.resolvedAt ? (
                  <RotateCcw size={13} strokeWidth={1.4} aria-hidden="true" />
                ) : (
                  <CircleCheck size={13} strokeWidth={1.4} aria-hidden="true" />
                )}
                {comment.resolvedAt ? "Reabrir" : "Marcar como resolvido"}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function Composer({ internal, slides, onSubmit, disabled, placeholder, notice }) {
  const [text, setText] = useState("");
  const [slide, setSlide] = useState("");
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setText("");
    const ok = await onSubmit(body, slide ? Number(slide) : null);
    setBusy(false);
    if (ok) setSlide("");
    else setText(body);
  };
  return (
    <form
      className={cx("rv-composer", internal && "rv-composer--internal")}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {internal && (
        <p className="rv-composer__flag">
          <Lock size={14} strokeWidth={1.4} aria-hidden="true" />
          Visível apenas para a equipe
        </p>
      )}
      {!internal && notice && (
        <p className="rv-composer__flag rv-composer__flag--held" id={`${hintId}-notice`}>
          <EyeOff size={14} strokeWidth={1.4} aria-hidden="true" />
          {notice}
        </p>
      )}
      <Textarea
        value={text}
        rows={3}
        autoGrow
        maxRows={10}
        maxLength={5000}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={internal ? "Nova nota interna" : "Novo comentário"}
        aria-describedby={!internal && notice ? `${hintId}-notice ${hintId}` : hintId}
        onValueChange={setText}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="rv-composer__bar">
        {slides > 1 ? (
          <Select
            size="sm"
            value={slide}
            onValueChange={setSlide}
            aria-label="Slide do comentário"
            className="rv-composer__slide"
            options={[
              { value: "", label: "Todos os slides" },
              ...Array.from({ length: slides }, (_, i) => ({ value: String(i + 1), label: `Slide ${i + 1}` })),
            ]}
          />
        ) : (
          <span />
        )}
        <span id={hintId} className="rv-composer__hint">
          <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd> + <Kbd>Enter</Kbd> para enviar
        </span>
        <Button type="submit" size="sm" variant={internal ? "secondary" : "primary"} icon={Send} disabled={!text.trim() || disabled} loading={busy}>
          {internal ? "Salvar nota" : "Comentar"}
        </Button>
      </div>
    </form>
  );
}

// Chronological thread. Staff with `canInternal` get two tabs: "Com o cliente"
// and "Notas internas" (visually unmistakable, never sent to clients — the
// server enforces it). New comments appear at once and roll back on error.
// versionReleased={false} (staff): the version the messages go to was not
// released yet, so the client neither sees them nor is notified until it is.
// internalVersionId/internalVersionNumber (staff): where "Notas internas" go
// when that differs from the client conversation (e.g. the draft being
// prepared while client comments stay on the released version).
// subject: what the client is talking about, for the empty state.
export function CommentThread({
  materialId,
  versionId,
  versionNumber,
  versionReleased,
  internalVersionId,
  internalVersionNumber,
  subject = "esta publicação",
  canInternal = false,
  slides = 0,
  refreshKey,
  disabled = false,
  title = "Comentários",
  className,
}) {
  const { user } = useAuth();
  const toast = useToast();
  const staff = Boolean(user) && user.role !== "client";
  const [tab, setTab] = useState("client");
  const { data, error, loading, reload, setData } = useApi(materialId ? `/materials/${materialId}/comments` : null, {
    deps: [refreshKey],
  });
  const listRef = useRef(null);
  const items = data?.items ?? [];
  const inTab = (comment) => !canInternal || (comment.visibility ?? "client") === tab;
  const shown = items.filter(inTab);
  const counts = {
    client: items.filter((c) => (c.visibility ?? "client") === "client").length,
    internal: items.filter((c) => c.visibility === "internal").length,
  };

  useEffect(() => {
    if (!canInternal) setTab("client");
  }, [canInternal]);

  const submit = async (body, slidePosition) => {
    const visibility = canInternal ? tab : "client";
    const toInternal = visibility === "internal" && internalVersionId !== undefined;
    const targetId = toInternal ? internalVersionId : versionId;
    const targetNumber = toInternal ? internalVersionNumber : versionNumber;
    const temp = {
      id: `tmp-${++tempSeq}`,
      pending: true,
      materialId,
      versionId: targetId ?? null,
      versionNumber: targetNumber ?? null,
      author: { id: user?.id, name: user?.name, isClient: user?.role === "client" },
      body,
      kind: "comment",
      slidePosition,
      createdAt: new Date().toISOString(),
      visibility: staff ? visibility : undefined,
      mine: true,
    };
    setData((current) => ({ ...(current || {}), items: [...(current?.items ?? []), temp] }));
    try {
      const { comment } = await api.post(`/materials/${materialId}/comments`, {
        body,
        versionId: targetId ?? undefined,
        slidePosition: slidePosition ?? undefined,
        visibility: staff ? visibility : undefined,
      });
      setData((current) => ({
        ...(current || {}),
        items: (current?.items ?? []).map((c) => (c.id === temp.id ? comment : c)),
      }));
      return true;
    } catch (err) {
      setData((current) => ({ ...(current || {}), items: (current?.items ?? []).filter((c) => c.id !== temp.id) }));
      toast.error(err?.fields?.body || err);
      return false;
    }
  };

  const patch = async (comment, body) => {
    try {
      const { comment: next } = await api.patch(`/comments/${comment.id}`, body);
      setData((current) => ({ ...current, items: current.items.map((c) => (c.id === next.id ? next : c)) }));
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    }
  };

  const thread = (
    <div className="rv-thread__body">
      {loading ? (
        <SkeletonRows rows={3} columns={2} media label="Carregando comentários" />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} compact />
      ) : shown.length ? (
        <ol ref={listRef} className="rv-thread__list" aria-live="polite" aria-relevant="additions">
          {shown.map((comment, index) => (
            <Comment
              key={comment.id}
              comment={comment}
              staff={staff}
              index={index}
              onResolve={(c, resolved) => patch(c, { resolved })}
              onEdit={(c, body) => patch(c, { body })}
            />
          ))}
        </ol>
      ) : (
        <EmptyState
          compact
          icon={canInternal && tab === "internal" ? Lock : MessageSquare}
          title={
            canInternal && tab === "internal"
              ? "Nenhuma nota interna"
              : staff
                ? "Nenhum comentário com o cliente"
                : "Nenhum comentário ainda"
          }
          description={
            canInternal && tab === "internal"
              ? "Combine ajustes com a equipe aqui. O cliente nunca vê estas notas."
              : staff
                ? "O que for escrito aqui aparece para o cliente quando o material estiver liberado."
                : `Escreva abaixo para falar com a equipe Metta sobre ${subject}.`
          }
        />
      )}
      {materialId && (
        <Composer
          key={tab}
          internal={canInternal && tab === "internal"}
          slides={slides}
          disabled={disabled}
          onSubmit={submit}
          notice={
            staff && versionReleased === false && !(canInternal && tab === "internal")
              ? `A versão ${versionNumber ?? ""} ainda não foi liberada: a mensagem fica guardada e só aparece para o cliente quando a versão for liberada. Ninguém é avisado agora.`.replace("versão  ", "versão ")
              : null
          }
          placeholder={
            canInternal && tab === "internal"
              ? "Escreva uma nota para a equipe…"
              : staff
                ? versionReleased === false
                  ? "Escreva uma mensagem para quando esta versão for liberada…"
                  : "Escreva uma mensagem para o cliente…"
                : "Escreva um comentário para a equipe Metta…"
          }
        />
      )}
    </div>
  );

  return (
    <section className={cx("rv-thread", className)} aria-label={title}>
      {canInternal ? (
        <Tabs
          aria-label="Tipo de comentário"
          value={tab}
          onChange={setTab}
          items={[
            { value: "client", label: "Com o cliente", count: counts.client },
            { value: "internal", label: "Notas internas", icon: Lock, count: counts.internal },
          ]}
          panelClassName={cx("rv-thread__panel", tab === "internal" && "is-internal")}
        >
          {thread}
        </Tabs>
      ) : (
        thread
      )}
    </section>
  );
}

export default CommentThread;

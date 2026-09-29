import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  BellRing,
  Check,
  CheckCheck,
  Eye,
  Link2,
  Lock,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Button,
  ConfirmDialog,
  DateInput,
  Drawer,
  ErrorState,
  Field,
  Input,
  Menu,
  Modal,
  PageHeader,
  Panel,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  copyText,
  formatDate,
  formatDateTime,
  useApi,
  useToast,
} from "../../ui/index.js";
import {
  QuestionBlock,
  QuestionInput,
  dueInfo,
  hasOptions,
  pad2,
  typeMeta,
} from "../../client/briefings/questions.jsx";
import { noticeChannels } from "../clients/crmShared.jsx";
import AnswersView from "./AnswersView.jsx";
import QuestionBuilder from "./QuestionBuilder.jsx";
import "./hub.css";

const cx = (...parts) => parts.filter(Boolean).join(" ");
const LOCKED = new Set(["submitted", "reviewed"]);

const toDraft = (briefing) => ({
  id: briefing.id,
  title: briefing.title ?? "",
  intro: briefing.intro ?? "",
  dueDate: briefing.dueDate ?? "",
  questions: (briefing.questions ?? []).map((q) => ({
    id: q.id,
    label: q.label ?? "",
    help: q.help ?? "",
    type: q.type,
    required: Boolean(q.required),
    options: q.options ? [...q.options] : [],
  })),
});

function toPayload(draft, { locked }) {
  const payload = { title: draft.title.trim(), intro: draft.intro.trim() || null, dueDate: draft.dueDate || null };
  if (!locked)
    payload.questions = draft.questions.map((q) => ({
      id: q.id,
      label: q.label.trim(),
      help: q.help.trim() || null,
      type: q.type,
      required: q.required,
      ...(hasOptions(q.type) ? { options: q.options.map((o) => o.trim()).filter(Boolean) } : {}),
    }));
  return payload;
}

function validateDraft(draft, { locked }) {
  const errors = { questions: {} };
  if (!draft.title.trim()) errors.title = "Dê um título ao briefing.";
  if (!locked)
    for (const q of draft.questions) {
      const e = {};
      if (!q.label.trim()) e.label = "Escreva a pergunta.";
      if (hasOptions(q.type)) {
        const options = q.options.map((o) => o.trim()).filter(Boolean);
        if (options.length < 2) e.options = "Adicione pelo menos duas opções.";
        else if (new Set(options.map((o) => o.toLowerCase())).size !== options.length)
          e.options = "As opções precisam ser diferentes entre si.";
      }
      if (Object.keys(e).length) errors.questions[q.id] = e;
    }
  return errors;
}

const hasErrors = (errors) => Boolean(errors.title || Object.keys(errors.questions ?? {}).length);

// Server field keys ("questions.3.label") back onto question ids.
function mapServerErrors(fields = {}, draft) {
  const errors = { questions: {} };
  for (const [key, message] of Object.entries(fields)) {
    const match = /^questions\.(\d+)\.(\w+)/.exec(key);
    if (match) {
      const q = draft.questions[Number(match[1])];
      if (q) errors.questions[q.id] = { ...errors.questions[q.id], [match[2] === "options" ? "options" : "label"]: message };
    } else if (key === "title") errors.title = message;
  }
  return errors;
}

function focusFirstError(errors, draft) {
  if (errors.title) return document.getElementById("hub-title")?.focus();
  const first = draft.questions.find((q) => errors.questions?.[q.id]);
  if (!first) return;
  const target = errors.questions[first.id].label
    ? document.getElementById(`hub-qlabel-${first.id}`)
    : document.getElementById(`hub-qopt-${first.id}`);
  target?.focus({ preventScroll: true });
  target?.closest(".hub-qcard")?.scrollIntoView({ block: "center" });
}

export default function BriefingEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data, error, loading, reload, setData } = useApi(`/briefings/${id}`);
  const briefing = data?.briefing;
  usePageTitle(briefing?.title || "Briefing");

  const [draft, setDraft] = useState(null);
  const [errors, setErrors] = useState({ questions: {} });
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState(null);
  const [dialog, setDialog] = useState(null); // send | reopen | delete | preview
  const [busy, setBusy] = useState(null);
  const [reopenMessage, setReopenMessage] = useState("");

  // Server state -> editable draft. Unsaved edits survive background reloads.
  const baselineJson = useMemo(() => (briefing ? JSON.stringify(toDraft(briefing)) : null), [briefing]);
  const previousBaseline = useRef(null);
  const syncWith = useRef(null);
  useLayoutEffect(() => {
    if (!baselineJson) return;
    const previous = previousBaseline.current;
    const sent = syncWith.current;
    previousBaseline.current = baselineJson;
    syncWith.current = null;
    setDraft((current) => {
      if (!current || current.id !== briefing.id) return JSON.parse(baselineJson);
      const json = JSON.stringify(current);
      return json === previous || json === sent ? JSON.parse(baselineJson) : current;
    });
  }, [baselineJson, briefing?.id]);

  // First view: answers once the client has written something, questions otherwise.
  useEffect(() => {
    if (!briefing || view) return;
    const answered = briefing.progress?.answered > 0;
    setView(LOCKED.has(briefing.status) || (briefing.status !== "draft" && answered) ? "answers" : "questions");
  }, [briefing, view]);

  const perms = briefing?.permissions ?? {};
  const locked = briefing ? LOCKED.has(briefing.status) : false;
  const canEdit = Boolean(perms.canEdit);
  const dirty = Boolean(canEdit && draft && baselineJson && JSON.stringify(draft) !== baselineJson);

  const save = useCallback(async () => {
    if (!draft || !briefing) return false;
    const local = validateDraft(draft, { locked });
    setErrors(local);
    if (hasErrors(local)) {
      toast.error("Revise os campos destacados antes de salvar.");
      requestAnimationFrame(() => focusFirstError(local, draft));
      return false;
    }
    setSaving(true);
    syncWith.current = JSON.stringify(draft);
    try {
      const res = await api.patch(`/briefings/${briefing.id}`, toPayload(draft, { locked }));
      setData({ briefing: res.briefing });
      setErrors({ questions: {} });
      toast.success("Briefing salvo.");
      return true;
    } catch (err) {
      syncWith.current = null;
      if (err.fields) {
        const mapped = mapServerErrors(err.fields, draft);
        setErrors(mapped);
        requestAnimationFrame(() => focusFirstError(mapped, draft));
      }
      toast.error(err);
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, briefing, locked, setData, toast]);

  // Ctrl/Cmd+S saves; leaving with unsaved edits asks first.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (!dirty) return;
        event.preventDefault();
        save();
      }
    };
    const onBeforeUnload = (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty, save]);

  if (loading || (briefing && !draft)) return <EditorSkeleton />;
  if (!briefing)
    return (
      <ErrorState
        error={error}
        onRetry={reload}
        action={
          <Button variant="ghost" size="sm" to="/admin/briefings">
            Voltar aos briefings
          </Button>
        }
      />
    );

  const activeView = briefing.status === "draft" ? "questions" : view ?? (locked ? "answers" : "questions");
  const requiredCount = draft.questions.filter((q) => q.required).length;
  const due = dueInfo(briefing.dueDate, { open: !locked && briefing.status !== "draft" });
  const clientLink = `${window.location.origin}/painel/briefings/${briefing.id}`;

  const act = async (name, request, done) => {
    setBusy(name);
    try {
      const res = await request();
      if (res?.briefing) setData({ briefing: res.briefing });
      done?.(res);
      return res;
    } catch (err) {
      toast.error(err);
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const openSend = async () => {
    if (!draft.questions.length) {
      toast.error("Adicione pelo menos uma pergunta antes de enviar.");
      return;
    }
    if (dirty && !(await save())) return;
    setDialog("send");
  };

  const send = () =>
    act(
      "send",
      () => api.post(`/briefings/${briefing.id}/send`),
      (res) => {
        setView("questions");
        const notified = res.notified ?? res.recipients;
        if (notified)
          toast.success({
            title: "Briefing enviado",
            message: `${notified} ${notified === 1 ? "pessoa foi avisada" : "pessoas foram avisadas"} ${noticeChannels(res)}`,
          });
        else
          toast.info({
            title: "Briefing enviado",
            message: "O cliente ainda não tem usuários ativos para receber o aviso. Convide alguém em Clientes e marcas.",
          });
      },
    );

  const remind = () =>
    act(
      "remind",
      () => api.post(`/briefings/${briefing.id}/send`),
      (res) => {
        const notified = res.notified ?? res.recipients;
        if (notified) toast.success(`Lembrete enviado para ${notified} ${notified === 1 ? "pessoa" : "pessoas"} ${noticeChannels(res)}`);
        else toast.info("O cliente não tem usuários ativos para receber o lembrete.");
      },
    ).catch(() => {});

  const review = () =>
    act("review", () => api.post(`/briefings/${briefing.id}/review`), () => toast.success("Briefing marcado como revisado.")).catch(
      () => {},
    );

  const reopen = () =>
    act(
      "reopen",
      () => api.post(`/briefings/${briefing.id}/reopen`, { message: reopenMessage.trim() || null }),
      () => {
        setDialog(null);
        setReopenMessage("");
        toast.success("Briefing reaberto. O cliente foi avisado e pode editar as respostas.");
      },
    ).catch(() => {});

  const remove = () =>
    act(
      "delete",
      () => api.del(`/briefings/${briefing.id}`),
      () => {
        toast.success("Briefing excluído.");
        navigate("/admin/briefings", { replace: true });
      },
    );

  const copyLink = async () => {
    if (await copyText(clientLink)) toast.success("Link do cliente copiado.");
    else toast.error("Não foi possível copiar o link.");
  };

  const menuItems = [
    { label: "Prévia do formulário", icon: Eye, onSelect: () => setDialog("preview") },
    briefing.status !== "draft" && { label: "Copiar link do cliente", icon: Link2, onSelect: copyLink },
    perms.canDelete && { divider: true },
    perms.canDelete && { label: "Excluir briefing", icon: Trash2, danger: true, onSelect: () => setDialog("delete") },
  ].filter(Boolean);

  const actions = (
    <>
      {perms.canSend && (
        <Button variant="primary" icon={Send} onClick={openSend} loading={busy === "send"}>
          Enviar ao cliente
        </Button>
      )}
      {perms.canRemind && (
        <Button icon={BellRing} onClick={remind} loading={busy === "remind"}>
          Reenviar lembrete
        </Button>
      )}
      {perms.canReview && (
        <Button variant="primary" icon={CheckCheck} onClick={review} loading={busy === "review"}>
          Marcar como revisado
        </Button>
      )}
      {perms.canReopen && (
        <Button icon={RotateCcw} onClick={() => setDialog("reopen")}>
          Reabrir
        </Button>
      )}
      <Menu items={menuItems} label="Mais ações do briefing" />
    </>
  );

  const tabs =
    briefing.status === "draft"
      ? null
      : [
          { value: "answers", label: "Respostas", count: briefing.progress.answered },
          { value: "questions", label: "Perguntas", count: briefing.questions.length },
        ];

  const questionsView = (
    <div className="hub-stack">
      {briefing.status !== "draft" && !locked && canEdit && (
        <div className="hub-notice is-info" role="note">
          <Eye size={16} strokeWidth={1.4} aria-hidden="true" />
          <p>
            O cliente já pode ver este briefing. Ao salvar, as mudanças nas perguntas aparecem para ele na hora; respostas
            de perguntas removidas deixam de ser exibidas.
          </p>
        </div>
      )}
      {locked && canEdit && (
        <div className="hub-notice" role="note">
          <Lock size={16} strokeWidth={1.4} aria-hidden="true" />
          <p>As respostas já foram enviadas, então as perguntas estão travadas. Para alterá-las, reabra o briefing.</p>
        </div>
      )}

      <Panel eyebrow="Apresentação" className="hub-intro-panel" index={0}>
        <div className="hub-stack">
          <Field label="Título" required error={errors.title} id="hub-title">
            {canEdit ? (
              <Input
                className="hub-title-input"
                value={draft.title}
                maxLength={160}
                onValueChange={(value) => setDraft((d) => ({ ...d, title: value }))}
              />
            ) : (
              <p className="hub-readonly-text">{briefing.title}</p>
            )}
          </Field>
          <Field label="Texto de abertura" optional hint="Aparece no topo do formulário, antes da primeira pergunta.">
            {canEdit ? (
              <Textarea
                value={draft.intro}
                rows={3}
                autoGrow
                maxLength={4000}
                placeholder="Ex.: Estas respostas orientam o projeto. Leva cerca de 15 minutos."
                onValueChange={(value) => setDraft((d) => ({ ...d, intro: value }))}
              />
            ) : (
              <p className="hub-readonly-text">{briefing.intro || "Sem texto de abertura."}</p>
            )}
          </Field>
        </div>
      </Panel>

      {canEdit && !locked ? (
        <QuestionBuilder
          questions={draft.questions}
          errors={errors.questions}
          onChange={(questions) => setDraft((d) => ({ ...d, questions }))}
        />
      ) : (
        <ReadOnlyQuestions questions={briefing.questions} />
      )}
    </div>
  );

  return (
    <div className="hub-page hub-editor-page">
      <PageHeader
        back={{ to: "/admin/briefings", label: "Briefings" }}
        eyebrow={`${briefing.client?.name} · ${briefing.brand?.name}`}
        title={draft.title.trim() || briefing.title}
        meta={
          <ul className="hub-meta" aria-label="Situação do briefing">
            <li>
              <StatusBadge kind="briefing" value={briefing.status} />
            </li>
            {briefing.project && <li>{briefing.project.name}</li>}
            <li>
              {briefing.questions.length} {briefing.questions.length === 1 ? "pergunta" : "perguntas"}
            </li>
            {due && (
              <li className={cx(due.tone && `is-${due.tone}`)}>
                Prazo {due.relative ? due.text : due.date}
              </li>
            )}
          </ul>
        }
        actions={actions}
      />

      <div className="hub-editor">
        <div className="hub-editor__main">
          {tabs ? (
            <Tabs items={tabs} value={activeView} onChange={setView} aria-label="Conteúdo do briefing" className="hub-tabs">
              {activeView === "answers" ? <AnswersView briefing={briefing} /> : questionsView}
            </Tabs>
          ) : (
            questionsView
          )}

          {dirty && (
            <div className="hub-savebar" role="region" aria-label="Alterações não salvas">
              <span className="hub-savebar__text">
                <span className="hub-savebar__dot" aria-hidden="true" />
                Alterações não salvas
              </span>
              <div className="hub-savebar__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setDraft(JSON.parse(baselineJson));
                    setErrors({ questions: {} });
                  }}
                >
                  Descartar
                </Button>
                <Button variant="primary" size="sm" icon={Check} loading={saving} onClick={save}>
                  Salvar
                </Button>
              </div>
            </div>
          )}
        </div>

        <aside className="hub-editor__aside" aria-label="Detalhes do briefing">
          <Panel title="Detalhes" padding="md" index={1}>
            <dl className="hub-facts">
              <div>
                <dt>Cliente</dt>
                <dd>{briefing.client?.name}</dd>
              </div>
              <div>
                <dt>Marca</dt>
                <dd>{briefing.brand?.name}</dd>
              </div>
              <div>
                <dt>Projeto</dt>
                <dd>
                  {briefing.project ? (
                    can("projects.view") ? (
                      <Link className="ui-link" to={`/admin/projetos/${briefing.project.id}`}>
                        {briefing.project.name}
                      </Link>
                    ) : (
                      briefing.project.name
                    )
                  ) : (
                    <span className="ui-muted">Sem projeto</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Perguntas</dt>
                <dd>
                  {draft.questions.length} · {requiredCount} {requiredCount === 1 ? "obrigatória" : "obrigatórias"}
                </dd>
              </div>
            </dl>
            <Field label="Prazo para o cliente" optional className="hub-due-field">
              {canEdit ? (
                <DateInput value={draft.dueDate} onValueChange={(value) => setDraft((d) => ({ ...d, dueDate: value }))} />
              ) : (
                <p className="hub-readonly-text">{briefing.dueDate ? formatDate(briefing.dueDate) : "Sem prazo"}</p>
              )}
            </Field>
          </Panel>
          <Panel title="Linha do tempo" padding="md" index={2}>
            <Timeline briefing={briefing} />
          </Panel>
        </aside>
      </div>

      <ConfirmDialog
        open={dialog === "send"}
        onClose={() => setDialog(null)}
        onConfirm={send}
        title="Enviar briefing ao cliente?"
        description={`As pessoas com acesso de ${briefing.client?.name} recebem um aviso na plataforma com o link para responder e, com o envio de e-mails configurado, também por e-mail (quem mantém os avisos por e-mail ativos).`}
        confirmLabel="Enviar ao cliente"
        icon={Send}
      >
        <dl className="hub-facts hub-facts--compact">
          <div>
            <dt>Marca</dt>
            <dd>{briefing.brand?.name}</dd>
          </div>
          <div>
            <dt>Perguntas</dt>
            <dd>
              {draft.questions.length} · {requiredCount} {requiredCount === 1 ? "obrigatória" : "obrigatórias"}
            </dd>
          </div>
          <div>
            <dt>Prazo</dt>
            <dd>{draft.dueDate ? formatDate(draft.dueDate) : "Sem prazo"}</dd>
          </div>
        </dl>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        onConfirm={remove}
        tone="danger"
        title="Excluir este briefing?"
        description={
          briefing.status === "draft"
            ? "O rascunho e as perguntas serão apagados. Esta ação não pode ser desfeita."
            : "O cliente já recebeu o link, que deixará de funcionar. Esta ação não pode ser desfeita."
        }
        confirmLabel="Excluir briefing"
        icon={Trash2}
      />

      <Modal
        open={dialog === "reopen"}
        onClose={busy ? undefined : () => setDialog(null)}
        dismissible={!busy}
        size="sm"
        title="Reabrir para o cliente"
        description="O cliente volta a editar as respostas e recebe um aviso. As respostas atuais são mantidas."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={Boolean(busy)}>
              Cancelar
            </Button>
            <Button variant="primary" icon={RotateCcw} onClick={reopen} loading={busy === "reopen"}>
              Reabrir briefing
            </Button>
          </>
        }
      >
        <Field label="Mensagem para o cliente" optional hint="Explique o que precisa ser completado ou revisto.">
          <Textarea
            value={reopenMessage}
            rows={3}
            maxLength={1000}
            data-autofocus
            placeholder="Ex.: Pode detalhar melhor o público principal?"
            onValueChange={setReopenMessage}
          />
        </Field>
      </Modal>

      <Drawer
        open={dialog === "preview"}
        onClose={() => setDialog(null)}
        size="lg"
        eyebrow="Prévia do cliente"
        title={draft.title || briefing.title}
        description={
          dirty
            ? "Mostrando a versão em edição, ainda não salva. Nada do que for preenchido aqui é guardado."
            : "Assim o cliente vê o formulário. Nada do que for preenchido aqui é guardado."
        }
      >
        <PreviewForm draft={draft} />
      </Drawer>
    </div>
  );
}

function ReadOnlyQuestions({ questions }) {
  return (
    <ol className="hub-qlist is-locked">
      {questions.map((question, index) => {
        const meta = typeMeta(question.type);
        const TypeIcon = meta.icon;
        return (
          <li key={question.id} className="hub-qcard is-locked ui-enter" style={{ "--i": Math.min(index, 8) }}>
            <div className="hub-qcard__rail">
              <span className="hub-qcard__num" aria-hidden="true">
                {pad2(index + 1)}
              </span>
            </div>
            <div className="hub-qcard__body">
              <p className="hub-qcard__static">
                <span className="ui-sr-only">Pergunta {index + 1}: </span>
                {question.label}
              </p>
              {question.help && <p className="hub-question__help">{question.help}</p>}
              <p className="hub-qcard__chips">
                <span className="hub-chip">
                  <TypeIcon size={13} strokeWidth={1.4} aria-hidden="true" />
                  {meta.label}
                </span>
                {question.required && <span className="hub-chip is-strong">Obrigatória</span>}
              </p>
              {question.options?.length > 0 && (
                <ul className="hub-answer hub-answer--chips is-options" aria-label="Opções">
                  {question.options.map((option) => (
                    <li key={option}>{option}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function PreviewForm({ draft }) {
  const [answers, setAnswers] = useState({});
  const questions = draft.questions.filter((q) => q.label.trim());
  return (
    <div className="hub-preview">
      {draft.intro.trim() && <p className="hub-preview__intro">{draft.intro}</p>}
      {questions.length === 0 ? (
        <p className="ui-muted">Adicione perguntas para ver a prévia.</p>
      ) : (
        <div className="hub-questions">
          {questions.map((question, index) => {
            const q = { ...question, help: question.help || null, options: question.options.filter((o) => o.trim()) };
            return (
              <QuestionBlock key={q.id} index={index} question={q} scope="hub-prev">
                {({ id, describedBy }) => (
                  <QuestionInput
                    id={id}
                    describedBy={describedBy}
                    question={q}
                    value={answers[q.id]}
                    onChange={(value) => setAnswers((current) => ({ ...current, [q.id]: value }))}
                  />
                )}
              </QuestionBlock>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Timeline({ briefing }) {
  const steps = [
    { key: "created", label: "Criado", at: briefing.createdAt, by: briefing.createdBy?.name },
    { key: "sent", label: "Enviado ao cliente", at: briefing.sentAt },
    { key: "submitted", label: "Respostas enviadas", at: briefing.submittedAt, by: briefing.submittedBy?.name },
    { key: "reviewed", label: "Revisado pela equipe", at: briefing.reviewedAt, by: briefing.reviewedBy?.name },
  ];
  return (
    <ol className="hub-timeline">
      {steps.map((step) => (
        <li key={step.key} className={cx("hub-timeline__step", step.at && "is-done")}>
          <span className="hub-timeline__dot" aria-hidden="true" />
          <span className="hub-timeline__label">{step.label}</span>
          <span className="hub-timeline__meta">
            {step.at ? (
              <>
                <time dateTime={step.at}>{formatDateTime(step.at)}</time>
                {step.by ? ` · ${step.by}` : ""}
              </>
            ) : (
              "Pendente"
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function EditorSkeleton() {
  return (
    <div className="hub-page" aria-busy="true">
      <span className="ui-sr-only" role="status">
        Carregando briefing
      </span>
      <div className="hub-skel-head" aria-hidden="true">
        <Skeleton width={90} height={12} />
        <Skeleton width="48%" height={34} />
        <Skeleton width={260} height={14} />
      </div>
      <div className="hub-editor" aria-hidden="true">
        <div className="hub-editor__main hub-stack">
          <Skeleton height={150} radius={4} />
          <Skeleton height={170} radius={4} />
          <Skeleton height={170} radius={4} />
        </div>
        <div className="hub-editor__aside hub-stack">
          <Skeleton height={220} radius={4} />
        </div>
      </div>
    </div>
  );
}

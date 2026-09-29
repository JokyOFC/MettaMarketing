import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { CalendarClock, Check, CircleAlert, Cloud, CloudOff, History, ListChecks, RotateCcw, Send } from "lucide-react";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Button,
  ConfirmDialog,
  ErrorState,
  PageHeader,
  ProgressBar,
  Skeleton,
  Spinner,
  StatusBadge,
  formatDateTime,
  formatTime,
  useApi,
  useLatest,
  useReducedMotion,
} from "../../ui/index.js";
import {
  AnswerValue,
  QuestionBlock,
  QuestionInput,
  controlId,
  dueInfo,
  hasAnswer,
  progressOf,
} from "./questions.jsx";
import "../../admin/briefings/hub.css";

const SAVE_DELAY = 900;
const cx = (...parts) => parts.filter(Boolean).join(" ");

// Unsaved answers are mirrored in this browser so a dropped connection or a
// closed tab never loses what was typed.
const backupKey = (userId, id) => `metta:briefing:${userId}:${id}`;
function readBackup(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
function writeBackup(key, answers) {
  try {
    localStorage.setItem(key, JSON.stringify({ answers, at: Date.now() }));
  } catch {
    /* storage blocked: the server copy is what counts */
  }
}
function dropBackup(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to clean */
  }
}

function initialAnswers(briefing, key) {
  const server = briefing.answers || {};
  const backup = readBackup(key);
  if (
    backup?.answers &&
    backup.at > Date.parse(briefing.updatedAt) &&
    JSON.stringify(backup.answers) !== JSON.stringify(server)
  )
    return { answers: backup.answers, restored: true };
  if (backup) dropBackup(key);
  return { answers: server, restored: false };
}

function scrollToQuestion(questionId, reduced) {
  const block = document.querySelector(`[data-question="${CSS.escape(questionId)}"]`);
  const control =
    document.getElementById(controlId("hub", questionId)) || block?.querySelector("input, textarea, select");
  control?.focus({ preventScroll: true });
  block?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
}

export default function BriefingForm() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, error, loading, reload, setData } = useApi(`/briefings/${id}`);
  const [justSent, setJustSent] = useState(false);
  const briefing = data?.briefing;
  usePageTitle(briefing?.title || "Briefing");

  if (loading) return <FormSkeleton />;
  if (!briefing)
    return (
      <div className="hub-form">
        <ErrorState
          error={error}
          onRetry={reload}
          action={
            <Button variant="ghost" size="sm" to="/painel/briefings">
              Voltar aos briefings
            </Button>
          }
        />
      </div>
    );

  if (briefing.permissions?.canAnswer)
    return (
      <AnswerForm
        key={briefing.id}
        briefing={briefing}
        userId={user.id}
        onSubmitted={(next) => {
          setJustSent(true);
          setData({ briefing: next });
        }}
        onClosed={() => reload().catch(() => {})}
      />
    );
  return <SubmittedView briefing={briefing} justSent={justSent} />;
}

function FormHeader({ briefing, children }) {
  const due = dueInfo(briefing.dueDate, { open: briefing.permissions?.canAnswer });
  const required = briefing.questions.filter((q) => q.required).length;
  return (
    <PageHeader
      className="hub-formhead"
      back={{ to: "/painel/briefings", label: "Briefings" }}
      eyebrow={[briefing.brand?.name, briefing.project?.name].filter(Boolean).join(" · ")}
      title={briefing.title}
      description={briefing.intro}
      meta={
        <ul className="hub-meta" aria-label="Sobre este briefing">
          <li>
            <StatusBadge kind="briefing" value={briefing.status} size="sm" />
          </li>
          <li>
            <ListChecks size={15} strokeWidth={1.4} aria-hidden="true" />
            {briefing.questions.length} {briefing.questions.length === 1 ? "pergunta" : "perguntas"}
            {required ? ` · ${required} ${required === 1 ? "obrigatória" : "obrigatórias"}` : ""}
          </li>
          {due && (
            <li className={cx(due.tone && `is-${due.tone}`)}>
              <CalendarClock size={15} strokeWidth={1.4} aria-hidden="true" />
              Prazo {due.text}
            </li>
          )}
        </ul>
      }
    >
      {children}
    </PageHeader>
  );
}

function SaveStatus({ save, onRetry }) {
  if (save.state === "saving")
    return (
      <span className="hub-save">
        <Spinner size={13} />
        Salvando…
      </span>
    );
  if (save.state === "offline")
    return (
      <span className="hub-save is-problem">
        <CloudOff size={15} strokeWidth={1.4} aria-hidden="true" />
        <span>Sem conexão. Suas respostas estão guardadas neste aparelho.</span>
        <button type="button" className="hub-save__retry" onClick={onRetry}>
          Tentar agora
        </button>
      </span>
    );
  if (save.state === "error")
    return (
      <span className="hub-save is-problem">
        <CircleAlert size={15} strokeWidth={1.4} aria-hidden="true" />
        <span>{save.error?.message || "Não foi possível salvar."}</span>
        <button type="button" className="hub-save__retry" onClick={onRetry}>
          <RotateCcw size={13} strokeWidth={1.6} aria-hidden="true" />
          Tentar de novo
        </button>
      </span>
    );
  if (save.at)
    return (
      <span className={cx("hub-save", save.state === "saved" && "is-saved")}>
        <Check size={15} strokeWidth={1.6} aria-hidden="true" className="hub-save__check" />
        Salvo às {formatTime(save.at)}
      </span>
    );
  return (
    <span className="hub-save">
      <Cloud size={15} strokeWidth={1.4} aria-hidden="true" />
      Salvamento automático
    </span>
  );
}

function AnswerForm({ briefing, userId, onSubmitted, onClosed }) {
  const reduced = useReducedMotion();
  const key = backupKey(userId, briefing.id);
  const [boot] = useState(() => initialAnswers(briefing, key));
  const [answers, setAnswers] = useState(boot.answers);
  const [save, setSave] = useState({ state: boot.restored ? "dirty" : "idle", at: null, error: null });
  const [errors, setErrors] = useState({});
  const [summary, setSummary] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState(boot.restored);
  const [announce, setAnnounce] = useState("");

  const answersRef = useLatest(answers);
  const version = useRef(boot.restored ? 1 : 0);
  const savedVersion = useRef(0);
  const inflight = useRef(null);
  const again = useRef(false);
  const timer = useRef(0);
  const closed = useRef(false);
  const flushRef = useRef(null);
  const closedRef = useLatest(onClosed);

  const questions = briefing.questions;
  const progress = progressOf(questions, answers);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (closed.current) return Promise.resolve();
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    if (version.current === savedVersion.current) return Promise.resolve();
    const v = version.current;
    setSave((current) => ({ ...current, state: "saving" }));
    const request = api
      .put(`/briefings/${briefing.id}/answers`, { answers: answersRef.current, submit: false })
      .then((res) => {
        savedVersion.current = v;
        if (v === version.current) {
          dropBackup(key);
          setSave((current) => {
            if (current.state === "offline" || current.state === "error") setAnnounce("Respostas salvas.");
            return { state: "saved", at: res.savedAt, error: null };
          });
        } else setSave((current) => ({ ...current, state: "dirty", at: res.savedAt }));
      })
      .catch((err) => {
        if (err.status === 409 || err.status === 404) {
          // the team closed or removed the briefing meanwhile
          closed.current = true;
          closedRef.current?.(err);
          return;
        }
        const offline = err.isNetwork || err.code === "network";
        setSave({ state: offline ? "offline" : "error", at: null, error: err });
        setAnnounce(offline ? "Sem conexão. As respostas ainda não foram salvas." : "Não foi possível salvar as respostas.");
      })
      .finally(() => {
        inflight.current = null;
        if (again.current) {
          again.current = false;
          if (version.current !== savedVersion.current) timer.current = setTimeout(() => flushRef.current(), 250);
        }
      });
    inflight.current = request;
    return request;
  }, [briefing.id, key, answersRef, closedRef]);
  flushRef.current = flush;

  // Restored answers are saved right away.
  useEffect(() => {
    if (boot.restored) timer.current = setTimeout(() => flushRef.current(), 400);
    return () => clearTimeout(timer.current);
  }, [boot.restored]);

  // Mirror unsaved answers locally.
  useEffect(() => {
    if (version.current !== savedVersion.current && !closed.current) writeBackup(key, answers);
  }, [answers, key]);

  // Retry when the connection returns; save when the tab is hidden or closed.
  useEffect(() => {
    const pending = () => !closed.current && version.current !== savedVersion.current;
    const onOnline = () => pending() && flushRef.current();
    const onVisibility = () => document.visibilityState === "hidden" && pending() && flushRef.current();
    const onPageHide = () => {
      if (!pending() || inflight.current) return;
      try {
        fetch(`/api/briefings/${briefing.id}/answers`, {
          method: "PUT",
          keepalive: true,
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Metta-Request": "1" },
          body: JSON.stringify({ answers: answersRef.current, submit: false }),
        }).catch(() => {});
      } catch {
        /* the local copy still holds the answers */
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      if (pending()) flushRef.current(); // leaving the page inside the app
    };
  }, [briefing.id, answersRef]);

  const change = (questionId, value) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
    version.current += 1;
    setErrors((current) => {
      if (!current[questionId]) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });
    setSave((current) => (current.state === "saving" ? current : { ...current, state: "dirty" }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), SAVE_DELAY);
  };

  const requestSubmit = () => {
    const missing = questions.filter((q) => q.required && !hasAnswer(q, answers[q.id]));
    if (missing.length) {
      setErrors(
        Object.fromEntries(
          missing.map((q) => [q.id, q.type === "multi" ? "Escolha pelo menos uma opção." : "Responda esta pergunta."]),
        ),
      );
      setSummary(missing.length === 1 ? "Falta 1 resposta obrigatória." : `Faltam ${missing.length} respostas obrigatórias.`);
      scrollToQuestion(missing[0].id, reduced);
      return;
    }
    setSummary(null);
    setConfirming(true);
  };

  const submit = async () => {
    clearTimeout(timer.current);
    if (inflight.current) await inflight.current.catch(() => {});
    try {
      const res = await api.put(`/briefings/${briefing.id}/answers`, { answers: answersRef.current, submit: true });
      closed.current = true;
      dropBackup(key);
      onSubmitted(res.briefing);
    } catch (err) {
      const fields = err.fields || {};
      const mapped = {};
      for (const [field, message] of Object.entries(fields))
        if (field.startsWith("answers.")) mapped[field.slice(8)] = message;
      if (Object.keys(mapped).length) {
        setConfirming(false);
        setErrors(mapped);
        setSummary(err.message || "Revise as respostas destacadas.");
        const first = questions.find((q) => mapped[q.id]);
        if (first) setTimeout(() => scrollToQuestion(first.id, reduced), 60);
        return;
      }
      if (err.status === 409) {
        setConfirming(false);
        closed.current = true;
        onClosed(err);
        return;
      }
      throw err; // shown inside the dialog
    }
  };

  const requiredDone = progress.required ? progress.requiredAnswered / progress.required : progress.total ? progress.answered / progress.total : 0;
  const counter = progress.required
    ? `${progress.requiredAnswered} de ${progress.required} obrigatórias`
    : `${progress.answered} de ${progress.total} respondidas`;

  return (
    <div className="hub-form">
      <FormHeader briefing={briefing} />

      <div className="hub-formbar" role="region" aria-label="Andamento do preenchimento">
        <div className="hub-formbar__progress">
          <span className="hub-formbar__count">
            <strong className="ui-num">{counter}</strong>
            {progress.required > 0 && progress.answered > progress.requiredAnswered && (
              <span className="hub-formbar__extra"> · {progress.answered} de {progress.total} no total</span>
            )}
          </span>
          <ProgressBar value={requiredDone} size="sm" aria-label="Perguntas obrigatórias respondidas" />
        </div>
        <SaveStatus save={save} onRetry={() => flushRef.current()} />
        <span className="ui-sr-only" role="status" aria-live="polite">
          {announce}
        </span>
      </div>

      {notice && (
        <div className="hub-notice" role="status">
          <History size={16} strokeWidth={1.4} aria-hidden="true" />
          <p>Recuperamos respostas que ainda não tinham sido salvas neste aparelho. Elas já estão sendo salvas.</p>
          <button type="button" className="hub-notice__close" onClick={() => setNotice(false)}>
            Entendi
          </button>
        </div>
      )}

      <form
        className="hub-questions"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          requestSubmit();
        }}
      >
        {questions.map((question, index) => (
          <QuestionBlock
            key={question.id}
            index={index}
            question={question}
            error={errors[question.id]}
            className="ui-enter"
          >
            {({ id, describedBy }) => (
              <QuestionInput
                id={id}
                describedBy={describedBy}
                invalid={Boolean(errors[question.id])}
                question={question}
                value={answers[question.id]}
                onChange={(value) => change(question.id, value)}
              />
            )}
          </QuestionBlock>
        ))}

        <div className="hub-submit">
          {summary && (
            <p className="ui-inline-error" role="alert">
              <CircleAlert size={16} strokeWidth={1.4} aria-hidden="true" />
              <span>{summary}</span>
            </p>
          )}
          <p className="hub-submit__hint">
            Quando terminar, envie as respostas. A equipe Metta é avisada e o formulário passa a ficar somente para
            leitura.
          </p>
          <Button type="submit" variant="primary" icon={Send}>
            Enviar respostas
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={submit}
        title="Enviar respostas?"
        description="A equipe Metta recebe um aviso e o formulário fica somente para leitura. Se precisar mudar algo depois, a equipe pode reabrir o briefing para você."
        confirmLabel="Enviar respostas"
        icon={Send}
      >
        <p className="hub-confirm-line">
          {progress.answered} de {progress.total} perguntas respondidas
          {progress.required ? `, incluindo todas as ${progress.required} obrigatórias.` : "."}
        </p>
      </ConfirmDialog>
    </div>
  );
}

function SubmittedView({ briefing, justSent }) {
  const headingRef = useRef(null);
  useEffect(() => {
    if (justSent) {
      window.scrollTo({ top: 0 });
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [justSent]);
  const reviewed = briefing.status === "reviewed";
  const closedWithoutAnswers = briefing.status !== "submitted" && !reviewed;

  return (
    <div className="hub-form">
      <FormHeader briefing={briefing} />
      {!closedWithoutAnswers && (
        <section className={cx("hub-thanks", justSent && "is-fresh", reviewed && "is-reviewed")} aria-labelledby="hub-thanks-title">
          <svg className="hub-thanks__mark" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
            <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="1.2" pathLength="1" />
            <path
              d="M15 24.5l6.2 6.2L33.5 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength="1"
            />
          </svg>
          <div>
            <h2 id="hub-thanks-title" ref={headingRef} tabIndex={-1} className="hub-thanks__title">
              {reviewed ? (
                <>
                  Respostas <em>revisadas</em>
                </>
              ) : (
                <>
                  Obrigado. Respostas <em>enviadas</em>
                </>
              )}
            </h2>
            <p className="hub-thanks__text">
              {reviewed
                ? `A equipe Metta revisou este briefing${briefing.reviewedAt ? ` em ${formatDateTime(briefing.reviewedAt)}` : ""}. Obrigado pela colaboração.`
                : `A equipe Metta foi avisada${briefing.submittedAt ? ` em ${formatDateTime(briefing.submittedAt)}` : ""} e vai usar estas informações no projeto. Se quiser mudar algo, fale com a equipe: ela pode reabrir o briefing para você.`}
            </p>
            {briefing.submittedBy?.name && <p className="hub-thanks__by">Enviado por {briefing.submittedBy.name}</p>}
          </div>
        </section>
      )}
      <div className="hub-questions is-readonly">
        {briefing.questions.map((question, index) => (
          <QuestionBlock key={question.id} index={index} question={question} readOnly>
            <AnswerValue question={question} value={briefing.answers?.[question.id]} />
          </QuestionBlock>
        ))}
      </div>
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="hub-form" aria-busy="true">
      <span className="ui-sr-only" role="status">
        Carregando briefing
      </span>
      <div className="hub-skel-head" aria-hidden="true">
        <Skeleton width={120} height={12} />
        <Skeleton width="62%" height={34} />
        <Skeleton width="90%" height={14} />
        <Skeleton width="70%" height={14} />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="hub-skel-question" aria-hidden="true">
          <Skeleton width={28} height={22} />
          <div>
            <Skeleton width="55%" height={16} />
            <Skeleton height={44} radius={4} style={{ marginTop: 14 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

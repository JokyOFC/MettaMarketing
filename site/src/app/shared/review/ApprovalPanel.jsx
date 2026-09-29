import { useEffect, useRef, useState } from "react";
import { Check, Clock, MessageSquareWarning } from "lucide-react";
import { Button, Field, Select, Textarea, formatDateTime, formatRelative, useToast } from "../../ui/index.js";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import { useShell } from "../../shell/ShellContext.jsx";
import { cx, fetchMaterial, groupFiles, versionOf } from "./util.js";
import "./review.css";

// Circle + check drawn in 300 ms (static with reduced motion).
export function CheckMark({ animate = false, size = 44 }) {
  return (
    <svg className={cx("rv-checkmark", animate && "is-drawing")} viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <circle cx="24" cy="24" r="21" pathLength="1" />
      <path d="M15 24.5l6.2 6.2L33.5 18" pathLength="1" />
    </svg>
  );
}

function StateIcon({ status, animate }) {
  if (status === "approved") return <CheckMark animate={animate} />;
  if (status === "changes_requested")
    return (
      <span className="rv-approval__icon rv-approval__icon--changes" aria-hidden="true">
        <MessageSquareWarning size={20} strokeWidth={1.4} />
      </span>
    );
  return (
    <span className="rv-approval__icon rv-approval__icon--pending" aria-hidden="true">
      <Clock size={20} strokeWidth={1.4} />
    </span>
  );
}

// Staff see the decision state without actions.
function StaffSummary({ material, version }) {
  const status = material.approvalStatus;
  if (!material.requiresApproval || !version) return null;
  const text =
    status === "approved"
      ? `Aprovada por ${version.decidedBy?.name ?? "cliente"} em ${formatDateTime(version.decidedAt)}.`
      : status === "changes_requested"
        ? `Ajustes pedidos por ${version.decidedBy?.name ?? "cliente"} em ${formatDateTime(version.decidedAt)}.`
        : `Com o cliente desde ${formatDateTime(version.releasedAt)} (${formatRelative(version.releasedAt)}).`;
  return (
    <div className={cx("rv-approval", `rv-approval--${status}`)}>
      <div className="rv-approval__state">
        <StateIcon status={status} />
        <div>
          <p className="rv-approval__eyebrow">Versão {version.number} com o cliente</p>
          <p className="rv-approval__title">
            {status === "approved" ? "Aprovada" : status === "changes_requested" ? "Ajustes solicitados" : "Aguardando aprovação"}
          </p>
          <p className="rv-approval__text">{text}</p>
        </div>
      </div>
    </div>
  );
}

// Client decision on the version under review: approve (with a confirmation
// step and a drawn check) or request changes (required text, optional slide).
// A 409 (new version, already decided) reloads the material.
export function ApprovalPanel({ material, onDone, className }) {
  const { user } = useAuth();
  const toast = useToast();
  const { refreshCounts } = useShell();
  const [mode, setMode] = useState("idle");
  const [note, setNote] = useState("");
  const [changes, setChanges] = useState("");
  const [slide, setSlide] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const focusRef = useRef(null);
  const changesRef = useRef(null);
  const stateRef = useRef(null);
  const sectionRef = useRef(null);
  // Focus bookkeeping: which idle control opened a step (the idle controls are
  // re-created on Voltar/Cancelar, so they are found again by their action)
  // and whether a decision was just recorded (focus moves to the new state's
  // title instead of falling to <body>).
  const triggerRef = useRef(null);
  const pendingFocus = useRef(null);
  const releasedId = material?.releasedVersionId;

  useEffect(() => {
    setMode("idle");
    setError(null);
  }, [releasedId, material?.approvalStatus]);
  useEffect(() => {
    if (mode !== "idle") {
      focusRef.current?.focus();
      return;
    }
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "state") stateRef.current?.focus();
    else if (target === "trigger") {
      const node = sectionRef.current?.querySelector(`[data-approval-action="${triggerRef.current}"]`);
      (node || stateRef.current)?.focus();
    }
  }, [mode, material?.approvalStatus, releasedId]);

  const open = (next) => () => {
    triggerRef.current = next;
    setError(null);
    setMode(next);
  };
  const back = () => {
    pendingFocus.current = "trigger";
    setError(null);
    setMode("idle");
  };

  if (!material || !material.requiresApproval || !releasedId) return null;
  const version = versionOf(material, releasedId);
  if (!version) return null;
  if (user?.role !== "client") return <StaffSummary material={material} version={version} />;

  const status = material.approvalStatus;
  // Posts: every original is a slide. Assets: formats of the same artwork
  // (logo.svg + logo.png) are one piece, not slides; they have no caption.
  const isPost = material.kind === "post";
  const originals = groupFiles(version.files).originals;
  const slides = isPost ? originals.length : new Set(originals.map((f) => String(f.name || f.id).replace(/\.[^.]+$/, "").toLowerCase())).size;
  const reviewWhat = ["a prévia", slides > 1 ? "todos os slides" : !isPost ? "os arquivos" : null, isPost ? "a legenda" : null].filter(Boolean);
  const reviewText = reviewWhat.length > 1 ? `${reviewWhat.slice(0, -1).join(", ")} e ${reviewWhat[reviewWhat.length - 1]}` : reviewWhat[0];
  const n = version.number;

  const finish = async (promise, success) => {
    setBusy(true);
    setError(null);
    try {
      const result = await promise;
      refreshCounts?.();
      success?.(result);
      // the confirming button disappears: focus goes to the new state's title
      pendingFocus.current = "state";
      setMode("idle");
      onDone?.(result.material);
    } catch (err) {
      if (err?.status === 409) {
        toast.info({ title: "Esta versão mudou", message: err.message });
        try {
          const fresh = await fetchMaterial(material);
          if (fresh) onDone?.(fresh);
        } catch {
          /* the page keeps what it has */
        }
        pendingFocus.current = "state";
        setMode("idle");
      } else setError(err);
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    finish(api.post(`/materials/${material.id}/approve`, { versionId: releasedId, note: note.trim() || undefined }), () => {
      setCelebrate(true);
      setNote("");
      toast.success({ title: `Versão ${n} aprovada`, message: "Sua aprovação ficou registrada. A equipe Metta foi avisada." });
    });

  const requestChanges = () => {
    if (!changes.trim()) {
      setError({ fields: { body: "Descreva os ajustes que você precisa." } });
      // the field is described by the error: moving focus there reads it
      changesRef.current?.focus();
      return;
    }
    finish(
      api.post(`/materials/${material.id}/request-changes`, {
        versionId: releasedId,
        body: changes.trim(),
        slidePosition: slide ? Number(slide) : undefined,
      }),
      () => {
        setChanges("");
        setSlide("");
        toast.success({ title: "Pedido de ajustes enviado", message: "A equipe Metta vai preparar uma nova versão." });
      },
    );
  };

  const fieldError = error?.fields?.body || error?.fields?.note;
  const generalError = error && !fieldError ? error.message || "Não foi possível concluir. Tente de novo." : null;

  let body;
  if (mode === "confirm") {
    body = (
      <div className="rv-approval__step ui-enter">
        <p ref={focusRef} tabIndex={-1} className="rv-approval__title">
          Confirmar aprovação da versão {n}?
        </p>
        <p className="rv-approval__text">
          A aprovação fica registrada com seu nome, a data e a versão. Se uma nova versão for enviada, ela precisará de uma nova aprovação.
        </p>
        <Field label="Mensagem para a equipe" optional error={error?.fields?.note}>
          <Textarea value={note} rows={2} autoGrow maxLength={2000} onValueChange={setNote} placeholder="Ex.: Pode seguir para a publicação." />
        </Field>
        {generalError && (
          <p className="ui-inline-error" role="alert">
            {generalError}
          </p>
        )}
        <div className="rv-approval__actions">
          <Button variant="primary" icon={Check} loading={busy} onClick={approve}>
            Confirmar aprovação
          </Button>
          <Button variant="ghost" disabled={busy} onClick={back}>
            Voltar
          </Button>
        </div>
      </div>
    );
  } else if (mode === "changes") {
    body = (
      <div className="rv-approval__step ui-enter">
        <p ref={focusRef} tabIndex={-1} className="rv-approval__title">
          O que precisa mudar na versão {n}?
        </p>
        <Field label="Ajustes" required error={fieldError}>
          <Textarea
            ref={changesRef}
            value={changes}
            rows={4}
            autoGrow
            maxLength={5000}
            onValueChange={(value) => {
              setChanges(value);
              if (fieldError) setError(null);
            }}
            placeholder="Descreva cada ajuste com o máximo de clareza. Ex.: trocar a foto do slide 2 por uma mais clara."
          />
        </Field>
        {slides > 1 && (
          <Field label="Slide" optional hint="Indique o slide se o ajuste for em um só.">
            <Select
              value={slide}
              onValueChange={setSlide}
              options={[
                { value: "", label: "Vários slides ou o post todo" },
                ...Array.from({ length: slides }, (_, i) => ({ value: String(i + 1), label: `Slide ${i + 1}` })),
              ]}
            />
          </Field>
        )}
        {generalError && (
          <p className="ui-inline-error" role="alert">
            {generalError}
          </p>
        )}
        <div className="rv-approval__actions">
          <Button variant="primary" loading={busy} onClick={requestChanges}>
            Enviar pedido de ajustes
          </Button>
          <Button variant="ghost" disabled={busy} onClick={back}>
            Cancelar
          </Button>
        </div>
      </div>
    );
  } else if (status === "approved") {
    body = (
      <div className="rv-approval__state" role={celebrate ? "status" : undefined}>
        <StateIcon status="approved" animate={celebrate} />
        <div>
          <p className="rv-approval__eyebrow">Versão {n}</p>
          <p ref={stateRef} tabIndex={-1} className="rv-approval__title">
            Aprovada
          </p>
          <p className="rv-approval__text">
            por {version.decidedBy?.name ?? "você"} em {formatDateTime(version.decidedAt)}. A aprovação ficou registrada no
            histórico da publicação.
          </p>
        </div>
      </div>
    );
  } else if (status === "changes_requested") {
    body = (
      <>
        <div className="rv-approval__state">
          <StateIcon status="changes_requested" />
          <div>
            <p className="rv-approval__eyebrow">Versão {n}</p>
            <p ref={stateRef} tabIndex={-1} className="rv-approval__title">
              Ajustes solicitados
            </p>
            <p className="rv-approval__text">
              {version.decidedBy?.name ?? "Você"} pediu ajustes em {formatDateTime(version.decidedAt)}. A equipe Metta está preparando
              uma nova versão, e você será avisado quando ela chegar.
            </p>
          </div>
        </div>
        {/* One quiet way back, no disabled primary next to it. */}
        <p className="rv-approval__why rv-approval__override">
          Se preferir, você ainda pode aprovar a versão {n} como está.{" "}
          <button type="button" className="rv-textbtn" data-approval-action="confirm" onClick={open("confirm")}>
            Aprovar a versão {n} mesmo assim
          </button>
        </p>
      </>
    );
  } else {
    body = (
      <>
        <div className="rv-approval__state">
          <StateIcon status="pending" />
          <div>
            <p className="rv-approval__eyebrow">Versão {n} em revisão</p>
            <p ref={stateRef} tabIndex={-1} className="rv-approval__title">
              Aguardando sua aprovação
            </p>
            <p className="rv-approval__text">
              Revise {reviewText}. Aprove ou peça ajustes com um comentário.
            </p>
          </div>
        </div>
        <div className="rv-approval__actions">
          <Button variant="primary" icon={Check} data-approval-action="confirm" onClick={open("confirm")}>
            Aprovar versão {n}
          </Button>
          <Button data-approval-action="changes" onClick={open("changes")}>
            Solicitar ajustes
          </Button>
        </div>
      </>
    );
  }

  return (
    <section
      ref={sectionRef}
      className={cx("rv-approval", `rv-approval--${mode === "idle" ? status : mode}`, className)}
      aria-label="Aprovação"
    >
      {body}
    </section>
  );
}

export default ApprovalPanel;

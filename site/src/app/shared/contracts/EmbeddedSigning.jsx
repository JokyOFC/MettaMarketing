// Embedded AssinaVelox signing (docs/fase-3/widget-embutido.md on the
// AssinaVelox side). We implement the host side of the postMessage protocol
// ourselves instead of loading a third-party script into the Metta origin:
// the iframe loads the session URL WITHOUT its "#t=" fragment and, when the
// widget asks ("assinavelox:boot"), receives the one-time token by message,
// only for its exact origin. The token is then forgotten. Messages are
// accepted only from that origin, from our own iframe, with v=1 and the same
// session id. "completed" is a hint: the server confirms with the API.
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { Button, Drawer, Icon, Skeleton, useReducedMotion } from "../../ui/index.js";
import "./contracts.css";

const READY_TIMEOUT_MS = 20000;
const MIN_HEIGHT = 640;

const ERROR_TEXT = {
  invalid_link: "Este acesso não vale mais. Abra uma nova sessão.",
  link_used: "Este acesso já foi usado. Abra uma nova sessão.",
  link_expired: "O acesso expirou. Abra uma nova sessão.",
  link_revoked: "O acesso foi encerrado. Abra uma nova sessão.",
  session_expired: "A sessão expirou por inatividade. Abra uma nova sessão.",
  session_revoked: "A sessão foi encerrada. Abra uma nova sessão.",
  origin_removed: "Este endereço deixou de ser autorizado na AssinaVelox.",
  not_framed: "A assinatura precisa abrir dentro da plataforma.",
  unavailable: "Esta assinatura não está disponível agora: talvez ainda não seja a sua vez ou você já tenha respondido.",
  unsupported: "Este contrato exige uma etapa que só funciona pelo link enviado por e-mail.",
  revoked: "A sessão foi encerrada.",
  expired: "O prazo do contrato terminou.",
  canceled: "O contrato foi cancelado.",
  network: "A conexão com a AssinaVelox falhou. Tente de novo.",
  timeout:
    "A AssinaVelox não respondeu. Pode ser que o endereço da plataforma ainda não esteja autorizado no widget de assinatura.",
};

export default function EmbeddedSigning({ open, onClose, title, subtitle, openSession, onCompleted, onRefused, emailHint }) {
  const reduced = useReducedMotion();
  const frameRef = useRef(null);
  const sessionRef = useRef(null); // { sessionId, widgetOrigin, token }
  const [phase, setPhase] = useState("idle"); // idle | opening | loading | ready | done | refused | error
  const [error, setError] = useState(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [src, setSrc] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState(null);
  // Callbacks from the parent may change identity on every render; keep the
  // latest in refs so a re-render never opens a second session.
  const openSessionRef = useRef(openSession);
  openSessionRef.current = openSession;
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  const onRefusedRef = useRef(onRefused);
  onRefusedRef.current = onRefused;

  const start = useCallback(async () => {
    setPhase("opening");
    setError(null);
    setSrc(null);
    sessionRef.current = null;
    try {
      const session = await openSessionRef.current();
      const [base, fragment = ""] = String(session.url).split("#");
      const token = new URLSearchParams(fragment).get("t");
      sessionRef.current = { sessionId: session.sessionId, widgetOrigin: session.widgetOrigin, token };
      setPhase("loading");
      setSrc(base);
    } catch (err) {
      setError({ message: err?.message ?? "Não foi possível abrir a assinatura agora.", fatal: true });
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setSrc(null);
      sessionRef.current = null;
      setOutcome(null);
      return undefined;
    }
    start();
    return undefined;
  }, [open, attempt, start]);

  // Message protocol (v1).
  useEffect(() => {
    if (!src) return undefined;
    const onMessage = (event) => {
      const session = sessionRef.current;
      const frame = frameRef.current;
      if (!session || !frame || event.origin !== session.widgetOrigin || event.source !== frame.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object" || message.v !== 1 || message.session !== session.sessionId) return;
      const payload = message.payload ?? {};
      switch (message.type) {
        case "assinavelox:boot":
          if (session.token) {
            frame.contentWindow.postMessage(
              { type: "assinavelox:token", v: 1, session: session.sessionId, payload: { token: session.token } },
              session.widgetOrigin,
            );
            session.token = null; // one delivery only
          }
          break;
        case "assinavelox:ready":
          setPhase((current) => (current === "loading" ? "ready" : current));
          break;
        case "assinavelox:resize":
          if (Number.isFinite(payload.height)) setHeight(Math.max(MIN_HEIGHT, Math.min(4000, Math.round(payload.height))));
          break;
        case "assinavelox:completed":
          setOutcome(payload.status ?? "completed");
          setPhase("done");
          onCompletedRef.current?.(payload.status);
          break;
        case "assinavelox:refused":
          setPhase("refused");
          onRefusedRef.current?.();
          break;
        case "assinavelox:error":
          if (payload.fatal) {
            setError({ code: payload.code, message: ERROR_TEXT[payload.code] ?? payload.message ?? "A assinatura foi interrompida.", fatal: true });
            setPhase("error");
          } else if (payload.code === "frame_too_small") {
            setError({ code: payload.code, message: "Aumente a janela para continuar a assinatura.", fatal: false });
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(() => {
      setPhase((current) => {
        if (current !== "loading") return current;
        setError({ code: "timeout", message: ERROR_TEXT.timeout, fatal: true });
        return "error";
      });
    }, READY_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, [src]);

  const retry = () => setAttempt((n) => n + 1);
  const showFrame = src && ["loading", "ready"].includes(phase);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      eyebrow="Assinatura do contrato"
      title={title}
      description={subtitle}
      className="ct-sign"
      bodyClassName="ct-sign__body"
    >
      {["opening", "loading", "ready"].includes(phase) && (
        <p className="ct-sign__intro">
          <Icon icon={ShieldCheck} size={16} />
          <span>
            A assinatura acontece na <strong>AssinaVelox</strong>, aqui dentro da plataforma. Você recebe um código por e-mail
            para confirmar sua identidade antes de registrar o aceite.
          </span>
        </p>
      )}
      {error && !error.fatal && (
        <p className="ct-sign__warn" role="status">
          {error.message}
        </p>
      )}

      {(phase === "opening" || phase === "loading") && (
        <div className="ct-sign__skeleton" aria-busy="true" aria-label="Carregando a assinatura">
          <Skeleton height={28} width="42%" />
          <Skeleton height={320} />
          <Skeleton height={44} width="56%" />
        </div>
      )}

      {showFrame && (
        <iframe
          ref={frameRef}
          key={`${src}-${attempt}`}
          src={src}
          title="Assinatura do contrato na AssinaVelox"
          className={`ct-sign__frame${phase === "ready" ? " is-ready" : ""}${reduced ? " is-static" : ""}`}
          style={{ height }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          referrerPolicy="no-referrer"
          allow="clipboard-write"
        />
      )}

      {phase === "done" && (
        <div className="ct-sign__result ui-enter" role="status">
          <span className="ct-sign__check" aria-hidden="true">
            <svg viewBox="0 0 52 52" width="52" height="52">
              <circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M16 27l7 7 14-15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <h3>Aceite registrado</h3>
          <p>
            {outcome === "already_signed_pending_others" || outcome === "completed"
              ? "Seu aceite foi registrado. Agora a Metta assina; quando as duas assinaturas estiverem registradas, a cópia final aparece aqui e chega por e-mail."
              : "Seu aceite foi registrado. A AssinaVelox está finalizando o documento; a cópia final aparece aqui em instantes."}
          </p>
          <Button variant="primary" icon={CircleCheck} onClick={onClose}>
            Concluir
          </Button>
        </div>
      )}

      {phase === "refused" && (
        <div className="ct-sign__result is-refused ui-enter" role="status">
          <Icon icon={CircleX} size={40} />
          <h3>Contrato recusado</h3>
          <p>Registramos a sua recusa. A equipe da Metta foi avisada e entra em contato para ajustar o que for preciso.</p>
          <Button variant="secondary" onClick={onClose}>
            Fechar
          </Button>
        </div>
      )}

      {phase === "error" && (
        <div className="ct-sign__result is-error ui-enter" role="alert">
          <Icon icon={CircleX} size={40} />
          <h3>Não foi possível abrir a assinatura</h3>
          <p>{error?.message}</p>
          <div className="ct-sign__actions">
            <Button variant="primary" icon={RefreshCw} onClick={retry}>
              Tentar de novo
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Fechar
            </Button>
          </div>
          <p className="ct-sign__fallback">
            <Icon icon={Mail} size={15} />
            <span>{emailHint ?? "Você também pode assinar pelo link que a AssinaVelox enviou por e-mail."}</span>
          </p>
        </div>
      )}
    </Drawer>
  );
}

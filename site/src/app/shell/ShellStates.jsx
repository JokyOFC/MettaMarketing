import { useState } from "react";
import { Link } from "react-router-dom";
import { Compass, LockKeyhole, RotateCcw, WifiOff } from "lucide-react";
import Logo from "../../Logo.jsx";
import { useAuth } from "../auth/AuthProvider.jsx";
import { homeFor } from "../auth/roles.js";
import { usePageTitle } from "./ShellContext.jsx";
import "./shell.css";

const ICON = { size: 22, strokeWidth: 1.4, "aria-hidden": true };

// Plain paper while the session is checked: no spinner flash, no layout jump.
export function BootScreen() {
  return <div className="sh-boot" aria-busy="true" aria-label="Carregando" />;
}

function StateBlock({ icon, eyebrow, title, children, actions }) {
  return (
    <section className="sh-state">
      <span className="sh-state-icon">{icon}</span>
      {eyebrow && <span className="sh-state-eyebrow">{eyebrow}</span>}
      <h1 className="sh-state-title">{title}</h1>
      <div className="sh-state-text">{children}</div>
      {actions && <div className="sh-state-actions">{actions}</div>}
    </section>
  );
}

export function Unavailable({ error, onRetry }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app sh-standalone">
      <Link to="/" className="sh-standalone-logo" aria-label="Metta Marketing, início">
        <Logo />
      </Link>
      <StateBlock
        icon={<WifiOff {...ICON} />}
        title="Não foi possível verificar seu acesso."
        actions={
          <button
            type="button"
            className="sh-btn primary"
            onClick={retry}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            <RotateCcw size={16} strokeWidth={1.4} aria-hidden="true" />
            {busy ? "Verificando…" : "Tentar de novo"}
          </button>
        }
      >
        <p>{error?.message}</p>
      </StateBlock>
    </div>
  );
}

export function NoAccess({ standalone = false }) {
  const { user, logout } = useAuth();
  usePageTitle("Sem acesso");
  const block = (
    <StateBlock
      icon={<LockKeyhole {...ICON} />}
      eyebrow="Acesso"
      title="Sem acesso a esta área"
      actions={
        standalone ? (
          <button type="button" className="sh-btn" onClick={logout}>
            Sair
          </button>
        ) : (
          <Link to={homeFor(user)} className="sh-btn">
            Voltar ao início
          </Link>
        )
      }
    >
      <p>
        {standalone
          ? "Este acesso ainda não está liberado. Fale com a equipe da Metta para revisar a sua conta."
          : "O seu perfil não inclui esta área. Se precisar dela, peça a um administrador da Metta."}
      </p>
    </StateBlock>
  );
  return standalone ? <div className="app sh-standalone">{block}</div> : block;
}

export function ProductNotFound() {
  const { user } = useAuth();
  usePageTitle("Página não encontrada");
  return (
    <StateBlock
      icon={<Compass {...ICON} />}
      eyebrow="404"
      title="Esta página não está por aqui."
      actions={
        <Link to={homeFor(user)} className="sh-btn">
          Voltar ao início
        </Link>
      }
    >
      <p>O endereço pode ter mudado ou o item não está disponível para você.</p>
    </StateBlock>
  );
}

// Suspense fallback inside the main area while a page chunk loads.
export function PageFallback() {
  return (
    <div className="sh-fallback" aria-busy="true" aria-label="Carregando página">
      <span className="sh-skel sh-skel-eyebrow" />
      <span className="sh-skel sh-skel-title" />
      <span className="sh-skel sh-skel-line" />
      <div className="sh-skel-grid">
        <span className="sh-skel sh-skel-card" />
        <span className="sh-skel sh-skel-card" />
        <span className="sh-skel sh-skel-card" />
      </div>
    </div>
  );
}

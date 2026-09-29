// Pieces shared by the order and subscription drawers.
import { Check, Link2, X } from "lucide-react";
import { CopyButton, Icon, plural } from "../../ui/index.js";
import { ExternalLinkButton, cx } from "../finance/common.jsx";

// The checkout URL as a quiet, selectable field with copy/open.
export function CheckoutLink({ url }) {
  return (
    <div className="fin-link">
      <div className="fin-link__field">
        <Icon icon={Link2} size={16} />
        <span className="fin-link__url" title={url}>
          {url}
        </span>
      </div>
      <div className="fin-link__tools">
        <CopyButton text={url} label="Copiar link" variant="secondary" />
        <ExternalLinkButton href={url}>Abrir</ExternalLinkButton>
      </div>
    </div>
  );
}

// Horizontal progress: [{label, state: 'done'|'current'|'todo'|'failed'|'stopped'}].
export function Journey({ steps, label }) {
  return (
    <ol className="fin-journey" aria-label={label}>
      {steps.map((step, index) => (
        <li
          key={step.label}
          className={cx("fin-journey__step", `is-${step.state}`)}
          aria-current={step.state === "current" ? "step" : undefined}
          style={{ "--i": index }}
        >
          <span className="fin-journey__dot" aria-hidden="true">
            {step.state === "done" && <Check size={11} strokeWidth={2} />}
            {(step.state === "failed" || step.state === "stopped") && <X size={11} strokeWidth={2} />}
          </span>
          <span className="fin-journey__label">{step.label}</span>
          <span className="ui-sr-only">
            {{ done: "concluído", current: "etapa atual", todo: "pendente", failed: "com falha", stopped: "encerrado" }[step.state]}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function sentMessage(res, noun = "Cobrança enviada") {
  const people = plural(res.sent, "pessoa", "pessoas");
  if (!res.sent) return `${noun}, mas ninguém recebeu o aviso.`;
  return res.emailConfigured
    ? `${noun} a ${people}, na plataforma e por e-mail.`
    : `${noun} a ${people} na plataforma. O e-mail não está configurado, então não houve envio por e-mail.`;
}

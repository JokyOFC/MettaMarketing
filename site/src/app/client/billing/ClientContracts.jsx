// Client portal: contracts sent by Metta (AssinaVelox). The signer can sign
// here, inside the platform (embedded widget), or through the e-mail
// invitation; completed contracts offer the final PDF and the evidence page.
import { useCallback, useEffect, useRef, useState } from "react";
import { FileSignature, Hourglass, Mail, PenLine } from "lucide-react";
import { Button, Icon, StatusBadge, formatDate, formatDateTime, useToast } from "../../ui/index.js";
import { api } from "../../api/client.js";
import EmbeddedSigning from "../../shared/contracts/EmbeddedSigning.jsx";
import { ContractFiles, Signers } from "../../admin/orders/ContractSection.jsx";
import "../../shared/contracts/contracts.css";

function ContractCard({ contract, index, onSign }) {
  const client = contract.signers.find((s) => s.role === "client");
  const metta = contract.signers.find((s) => s.role === "metta");
  const waiting = contract.status === "sent";
  const done = contract.status === "completed";
  return (
    <article
      className={`ct-card ui-enter${waiting && client?.turn ? " is-attention" : ""}${done ? " is-done" : ""}`}
      style={{ "--i": Math.min(index, 8) }}
    >
      <div className="ct-card__head">
        <div>
          <p className="ct-card__title">{contract.title}</p>
          <p className="ct-card__meta">
            <span className="ct-code">{contract.code}</span>
            {contract.sentAt && <> · enviado em {formatDate(contract.sentAt)}</>}
            {waiting && contract.expiresAt && <> · assine até {formatDate(contract.expiresAt)}</>}
          </p>
        </div>
        <StatusBadge kind="contract" value={contract.status} />
      </div>

      {(waiting || done) && <Signers contract={contract} />}

      {waiting && client?.turn && client.isYou && (
        <div className="ct-card__actions">
          <Button variant="primary" icon={PenLine} onClick={() => onSign(contract)}>
            Assinar agora
          </Button>
          <span className="ct-card__meta">
            <Icon icon={Mail} size={13} /> Um código chega em {client.email} para confirmar sua identidade.
          </span>
        </div>
      )}
      {waiting && client?.turn && !client.isYou && (
        <p className="ct-card__text">
          Este contrato deve ser assinado por <strong>{client.name}</strong> ({client.email}). A AssinaVelox enviou o convite
          para esse e-mail; se essa pessoa tiver acesso à plataforma, ela também pode assinar por aqui.
        </p>
      )}
      {waiting && metta?.turn && (
        <p className="ct-card__text">Aceite do contratante registrado. Falta a assinatura da Metta; avisamos assim que o contrato for concluído.</p>
      )}

      {done && (
        <>
          <p className="ct-card__text">
            Concluído em {formatDateTime(contract.completedAt)}.
            {contract.signatureStatusLabel && <> {contract.signatureStatusLabel}.</>}
            {contract.verificationCode && (
              <>
                {" "}
                Código de verificação: <span className="ct-code">{contract.verificationCode}</span>
              </>
            )}
          </p>
          <ContractFiles contract={contract} />
        </>
      )}
      {contract.status === "refused" && (
        <p className="ct-card__text">Contrato recusado{contract.refusalReason ? `: “${contract.refusalReason}”` : "."} A Metta foi avisada.</p>
      )}
      {contract.status === "expired" && <p className="ct-card__text">O prazo para assinar terminou. A Metta pode enviar um novo contrato.</p>}
      {contract.status === "canceled" && <p className="ct-card__text">Este contrato foi cancelado pela Metta. Não é preciso assiná-lo.</p>}
    </article>
  );
}

export default function ClientContracts({ contracts, onChanged }) {
  const toast = useToast();
  const [signing, setSigning] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  // One refresh per signing: the widget's "completed" schedules it and
  // closing the drawer afterwards must not ask again (server limit: 1 per 3 s).
  const refreshTimer = useRef(null);

  // /painel/financeiro#contratos (link of the notifications and e-mails)
  useEffect(() => {
    if (scrolled || !contracts?.length || window.location.hash !== "#contratos") return;
    setScrolled(true);
    document.getElementById("contratos")?.scrollIntoView({ block: "start" });
  }, [contracts, scrolled]);

  const openSession = useCallback(() => api.post(`/portal/contracts/${signing.id}/sign-session`), [signing]);

  if (!contracts?.length) return null;
  const refresh = (id) =>
    api
      .post(`/portal/contracts/${id}/refresh`)
      .then(() => onChanged?.())
      .catch(() => onChanged?.());

  const turnOf = (role) => contracts.filter((c) => c.status === "sent" && c.signers.some((s) => s.role === role && s.turn)).length;
  const yours = turnOf("client");
  const metta = turnOf("metta");
  // Canceled/expired contracts stay reachable but folded away.
  const current = contracts.filter((c) => !["canceled", "expired"].includes(c.status));
  const closed = contracts.filter((c) => ["canceled", "expired"].includes(c.status));
  return (
    <section className="fin-portal__section" id="contratos" aria-labelledby="fin-contracts-title">
      <div className="fin-portal__head">
        <h2 className="fin-portal__title" id="fin-contracts-title">
          <em>Contratos</em>
        </h2>
        {yours > 0 ? (
          <p className="fin-portal__total">
            <Icon icon={FileSignature} size={14} /> {yours} aguardando sua assinatura
          </p>
        ) : metta > 0 ? (
          <p className="fin-portal__total">
            <Icon icon={Hourglass} size={14} /> {metta} aguardando a assinatura da Metta
          </p>
        ) : null}
      </div>
      {current.length > 0 && (
        <div className="fin-stack">
          {current.map((contract, index) => (
            <ContractCard key={contract.id} contract={contract} index={index} onSign={setSigning} />
          ))}
        </div>
      )}
      {closed.length > 0 && (
        <details className="ct-closed">
          <summary>
            {closed.length === 1 ? "1 contrato cancelado ou expirado" : `${closed.length} contratos cancelados ou expirados`}
          </summary>
          <div className="fin-stack">
            {closed.map((contract, index) => (
              <ContractCard key={contract.id} contract={contract} index={index} onSign={setSigning} />
            ))}
          </div>
        </details>
      )}
      {signing && (
        <EmbeddedSigning
          open={Boolean(signing)}
          onClose={() => {
            const id = signing.id;
            setSigning(null);
            if (refreshTimer.current) {
              // Completed: refresh now instead of waiting for the timer.
              clearTimeout(refreshTimer.current);
              refreshTimer.current = null;
            }
            refresh(id);
          }}
          title={signing.title}
          subtitle={`${signing.code} · assinatura do contratante`}
          openSession={openSession}
          onCompleted={() => {
            toast.success("Aceite registrado");
            const id = signing.id;
            refreshTimer.current = setTimeout(() => {
              refreshTimer.current = null;
              refresh(id);
            }, 1500);
          }}
        />
      )}
    </section>
  );
}

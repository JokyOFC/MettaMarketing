// Contract of an order or subscription (AssinaVelox), inside the admin
// drawers. Covers every state: integration not ready, waived, not generated,
// preparing, failed, waiting for signatures, completed, refused/expired/canceled.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  CircleCheck,
  CircleX,
  Download,
  ExternalLink,
  Eye,
  FileCheck2,
  FileSignature,
  FileText,
  PenLine,
  RefreshCw,
  Settings,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import {
  Button,
  ConfirmDialog,
  Field,
  Icon,
  Input,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  Textarea,
  formatDate,
  formatDateTime,
  useApi,
  useToast,
} from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { api } from "../../api/client.js";
import EmbeddedSigning from "../../shared/contracts/EmbeddedSigning.jsx";
import { Callout, SectionTitle, Timeline } from "../finance/common.jsx";
import "../../shared/contracts/contracts.css";

const STEP_LABELS = {
  queued: "na fila",
  envelope: "criando o documento",
  document: "enviando o PDF",
  processing: "processando o PDF",
  recipients: "definindo quem assina",
  fields: "posicionando as assinaturas",
  send: "enviando os convites",
};

const OTHER = "__other";

/**
 * Adds the contract step after "Criado/Criada" in the order/subscription
 * journey. While a required contract is not signed, the payment steps that
 * come after it cannot be the current one.
 */
export function withContractStep(steps, item) {
  if (!item.contractRequired && !item.contract && !item.contractWaiver) return steps;
  const status = item.contract?.status;
  let step;
  if (status === "completed") step = { label: "Contrato assinado", state: "done" };
  else if (item.contractWaiver) step = { label: "Contrato dispensado", state: "done" };
  else if (status === "refused") step = { label: "Contrato recusado", state: "failed" };
  else if (status === "failed") step = { label: "Contrato", state: "failed" };
  else if (status === "sent" || status === "sending") step = { label: "Contrato", state: "current" };
  else step = { label: "Contrato", state: item.contractRequired ? "current" : "todo" };
  const blocking = item.contractRequired && step.state !== "done";
  const rest = steps.slice(1).map((s) => (blocking && s.state === "current" ? { ...s, state: "todo" } : s));
  return [steps[0], step, ...rest];
}

export function contractFileUrl(contract, kind, download = false) {
  return `/api/contracts/${contract.id}/files/${kind}${download ? "?download=1" : ""}`;
}

export function ContractFiles({ contract }) {
  const files = [
    contract.files.signed && { kind: "signed", name: "Contrato assinado", hint: "PDF final com as assinaturas registradas" },
    contract.files.evidence && { kind: "evidence", name: "Página de evidências", hint: "Linha do tempo, identificadores e resumos" },
    contract.files.original && { kind: "original", name: "PDF enviado", hint: "Como o contrato saiu da Metta" },
  ].filter(Boolean);
  if (!files.length) return null;
  return (
    <ul className="ct-files">
      {files.map((file, index) => (
        <li key={file.kind} className="ct-file ui-enter" style={{ "--i": index }}>
          <span className="ct-file__icon" aria-hidden="true">
            <Icon icon={file.kind === "signed" ? FileCheck2 : FileText} size={18} />
          </span>
          <span className="ct-file__text">
            <span className="ct-file__name">{file.name}</span>
            <span className="ct-file__hint">{file.hint}</span>
          </span>
          <span className="ct-file__actions">
            <Button size="sm" variant="ghost" icon={Eye} href={contractFileUrl(contract, file.kind)} target="_blank" rel="noopener">
              Abrir
            </Button>
            <Button size="sm" variant="secondary" icon={Download} href={contractFileUrl(contract, file.kind, true)}>
              Baixar
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Signers({ contract }) {
  return (
    <ol className="ct-signers">
      {contract.signers.map((signer, index) => {
        const done = ["signed", "approved"].includes(signer.status);
        return (
          <li key={signer.role} className={`ct-signer${done ? " is-done" : ""}${signer.turn ? " is-turn" : ""}`}>
            <span className="ct-signer__step" aria-hidden="true">
              {done ? <Icon icon={CircleCheck} size={15} /> : index + 1}
            </span>
            <span className="ct-signer__name">
              {signer.name}
              {signer.isYou && <span className="ct-signer__you">você</span>}
            </span>
            <span className="ct-signer__info">
              {signer.role === "client" ? "Contratante" : "Metta"}
              {signer.status && <StatusBadge kind="contractSigner" value={signer.status} size="sm" />}
              {signer.signedAt && <span>em {formatDateTime(signer.signedAt)}</span>}
              {!signer.status && signer.turn && <span>é a vez desta pessoa</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SendDialog({ open, onClose, source, integration, onSent }) {
  const toast = useToast();
  const users = useApi(open ? `/clients/${source.clientId}/users` : null);
  const client = useApi(open && source.kind === "subscription" ? `/clients/${source.clientId}` : null);
  const active = useMemo(() => (users.data?.items ?? []).filter((u) => u.status === "active"), [users.data]);
  const brands = client.data?.brands ?? [];
  const [choice, setChoice] = useState("");
  const [other, setOther] = useState({ name: "", email: "" });
  const [brandId, setBrandId] = useState("");
  const [days, setDays] = useState(String(integration?.expiresInDays ?? 15));
  const [errors, setErrors] = useState({});
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setOther({ name: "", email: "" });
    setDays(String(integration?.expiresInDays ?? 15));
  }, [open, integration?.expiresInDays]);
  useEffect(() => {
    if (open && !choice && active.length) setChoice(active[0].id);
    if (open && !active.length && users.data) setChoice(OTHER);
  }, [open, active, choice, users.data]);
  useEffect(() => {
    if (open && !brandId && brands.length) setBrandId(brands[0].id);
  }, [open, brands, brandId]);

  const signer = choice === OTHER ? { name: other.name.trim(), email: other.email.trim() } : { userId: choice };
  const sourceParams = source.kind === "order" ? { orderId: source.id } : { subscriptionId: source.id, brandId: brandId || null };

  const validate = () => {
    const local = {};
    if (!choice) local.signer = "Escolha quem assina pelo cliente.";
    if (choice === OTHER) {
      if (signer.name.length < 2) local["signer.name"] = "Informe o nome.";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signer.email)) local["signer.email"] = "Informe um e-mail válido.";
    }
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 90) local.days = "Use de 1 a 90 dias.";
    setErrors(local);
    return !Object.keys(local).length;
  };

  const [previewing, setPreviewing] = useState(false);
  // POST (the signer's data never goes into a URL) and open the PDF as a blob.
  const preview = async () => {
    if (!validate()) return;
    setPreviewing(true);
    try {
      const res = await fetch("/api/contracts/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Metta-Request": "1" },
        body: JSON.stringify({ ...sourceParams, signer, expiresInDays: Number(days) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? "Não foi possível gerar a prévia.");
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err);
    } finally {
      setPreviewing(false);
    }
  };

  const send = async () => {
    if (!validate()) return;
    setSending(true);
    try {
      const res = await api.post("/contracts", { ...sourceParams, signer, expiresInDays: Number(days) });
      toast.success("Contrato em preparação na AssinaVelox");
      onSent(res.contract);
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err);
    } finally {
      setSending(false);
    }
  };

  const mettaSigner = integration?.signer;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      eyebrow="Contrato"
      title={<>Enviar para <em>assinatura</em></>}
      description={source.title}
      footer={
        <>
          <Button variant="ghost" icon={Eye} onClick={preview} loading={previewing} disabled={sending}>
            Pré-visualizar PDF
          </Button>
          <Button variant="primary" icon={FileSignature} loading={sending} onClick={send}>
            Enviar para assinatura
          </Button>
        </>
      }
    >
      <div className="ct-send">
        <Field label="Quem assina pelo cliente" required error={errors.signer}>
          <Select
            value={choice}
            onValueChange={setChoice}
            placeholder={users.loading ? "Carregando…" : undefined}
            options={[
              ...active.map((u) => ({ value: u.id, label: `${u.name} · ${u.email}` })),
              { value: OTHER, label: "Outra pessoa (informar nome e e-mail)" },
            ]}
          />
        </Field>
        {choice === OTHER && (
          <div className="ct-send__row ui-enter">
            <Field label="Nome" required error={errors["signer.name"]}>
              <Input value={other.name} maxLength={120} onValueChange={(name) => setOther((o) => ({ ...o, name }))} />
            </Field>
            <Field label="E-mail" required error={errors["signer.email"]}>
              <Input type="email" value={other.email} maxLength={254} onValueChange={(email) => setOther((o) => ({ ...o, email }))} />
            </Field>
          </div>
        )}
        <div className="ct-send__row">
          {source.kind === "subscription" && brands.length > 0 && (
            <Field label="Marca" hint="Aparece no objeto do contrato.">
              <Select value={brandId} onValueChange={setBrandId} options={brands.map((b) => ({ value: b.id, label: b.name }))} />
            </Field>
          )}
          <Field label="Prazo para assinar" error={errors.days} hint="Em dias, de 1 a 90.">
            <Input type="number" inputMode="numeric" min={1} max={90} value={days} onValueChange={setDays} />
          </Field>
        </div>
        <p className="ct-send__note">
          A AssinaVelox envia o convite por e-mail. Quem tem acesso à plataforma também pode assinar em Financeiro, sem sair
          da área do cliente. Depois do cliente, assina pela Metta: {mettaSigner?.name ?? "o representante configurado"}
          {mettaSigner?.email ? ` (${mettaSigner.email})` : ""}.
        </p>
      </div>
    </Modal>
  );
}

function WaiveDialog({ open, onClose, source, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);
  const save = async () => {
    if (reason.trim().length < 3) return setError("Explique o motivo em poucas palavras.");
    setSaving(true);
    try {
      await api.post("/contracts/waive", {
        ...(source.kind === "order" ? { orderId: source.id } : { subscriptionId: source.id }),
        reason: reason.trim(),
      });
      toast.success("Contrato dispensado para este item");
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      eyebrow="Contrato"
      title="Dispensar o contrato"
      description="O pagamento deixa de esperar a assinatura. O motivo fica no histórico."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            Dispensar
          </Button>
        </>
      }
    >
      <Field label="Motivo" required error={error}>
        <Textarea rows={3} maxLength={300} value={reason} onValueChange={setReason} placeholder="Ex.: contrato assinado em papel em 12/09." />
      </Field>
    </Modal>
  );
}

/**
 * source: { kind: 'order'|'subscription', id, clientId, title, status, contract,
 *           contractRequired, contractSatisfied, contractWaiver }
 */
export default function ContractSection({ source, canManage, canConfigure, onChanged }) {
  const toast = useToast();
  const { user } = useAuth();
  const status = useApi("/contracts/status");
  const integration = status.data;
  const contractId = source.contract?.id ?? null;
  const detail = useApi(contractId ? `/contracts/${contractId}` : null);
  const contract = detail.data?.contract?.id === contractId ? detail.data.contract : source.contract;
  const [dialog, setDialog] = useState(null); // send | waive | cancel | sign
  const [busy, setBusy] = useState(null);
  const [cancelReason, setCancelReason] = useState("");
  const lastStatus = useRef(contract?.status);

  // Poll while the job prepares the envelope; refresh the parent at the end.
  const reloadRef = useRef(detail.reload);
  reloadRef.current = detail.reload;
  useEffect(() => {
    if (contract?.status !== "sending") return undefined;
    const timer = setInterval(() => reloadRef.current?.(), 1500);
    return () => clearInterval(timer);
  }, [contract?.status]);
  useEffect(() => {
    if (lastStatus.current && contract?.status && lastStatus.current !== contract.status) onChanged?.();
    lastStatus.current = contract?.status;
  }, [contract?.status, onChanged]);

  const run = async (kind, fn) => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const sync = () =>
    run("sync", async () => {
      const res = await api.post(`/contracts/${contract.id}/sync`);
      detail.setData({ contract: res.contract });
      toast.info("Status consultado na AssinaVelox");
      onChanged?.();
    });
  const retry = () =>
    run("retry", async () => {
      const res = await api.post(`/contracts/${contract.id}/retry`);
      detail.setData({ contract: res.contract });
    });
  const cancel = async () => {
    const res = await api.post(`/contracts/${contract.id}/cancel`, { reason: cancelReason.trim() || null });
    detail.setData({ contract: res.contract });
    if (res.warning) toast.info(res.warning);
    else toast.success("Contrato cancelado");
    onChanged?.();
  };
  const unwaive = () =>
    run("unwaive", async () => {
      await api.post("/contracts/unwaive", source.kind === "order" ? { orderId: source.id } : { subscriptionId: source.id });
      toast.success("O contrato volta a ser exigido");
      onChanged?.();
    });
  const openSession = useCallback(() => api.post(`/contracts/${contractId}/sign-session`), [contractId]);

  const mettaSigner = contract?.signers?.find((s) => s.role === "metta");
  const canSignHere = contract?.status === "sent" && mettaSigner?.turn && mettaSigner?.isYou;
  const orderOpen =
    source.kind === "order"
      ? ["draft", "pending_payment", "failed"].includes(source.status)
      : ["pending", "active", "paused", "failed"].includes(source.status);
  const terminal = contract && ["refused", "expired", "canceled"].includes(contract.status);
  const ready = integration?.ready;

  let body = null;
  if (!integration) body = <p className="fin-quiet">Carregando…</p>;
  else if (!integration.configured && !contract)
    body = (
      <Callout
        tone="neutral"
        icon={FileSignature}
        title="Contratos pela AssinaVelox"
        actions={
          canConfigure && (
            <Button size="sm" variant="secondary" icon={Settings} to="/admin/configuracoes?aba=contratos">
              Configurar contratos
            </Button>
          )
        }
      >
        A integração com a AssinaVelox ainda não está configurada. Até lá, pedidos e planos seguem sem contrato e o pagamento
        não espera assinatura.
      </Callout>
    );
  else if (source.contractWaiver && !contract?.status?.match(/^(sent|sending|completed)$/))
    body = (
      <Callout
        tone="slate"
        icon={ShieldCheck}
        title="Contrato dispensado"
        actions={
          canManage && (
            <Button size="sm" variant="ghost" icon={Undo2} loading={busy === "unwaive"} onClick={unwaive}>
              Voltar a exigir
            </Button>
          )
        }
      >
        {source.contractWaiver.reason} · {formatDate(source.contractWaiver.at)}
      </Callout>
    );
  else if (!contract || terminal)
    body = (
      <div className="ct-card ui-enter">
        {terminal && (
          <p className="ct-card__text">
            <StatusBadge kind="contract" value={contract.status} size="sm" />{" "}
            {contract.status === "refused"
              ? `${contract.signers[0].name} recusou o contrato${contract.refusalReason ? `: “${contract.refusalReason}”` : "."}`
              : contract.status === "expired"
                ? "O prazo para assinar terminou."
                : "O contrato anterior foi cancelado."}
          </p>
        )}
        <p className="ct-card__text">
          {source.contractRequired
            ? "O pagamento só é liberado ao cliente depois que ele e a Metta assinarem o contrato."
            : "Envie o contrato para assinatura antes de começar o trabalho."}
        </p>
        {!ready && integration.issues?.length > 0 && (
          <ul className="ct-list">
            {integration.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        {canManage && orderOpen && (
          <div className="ct-card__actions">
            <Button variant="primary" icon={FileSignature} disabled={!ready} onClick={() => setDialog("send")}>
              {terminal ? "Gerar novo contrato" : "Gerar contrato"}
            </Button>
            {source.contractRequired && (
              <Button variant="ghost" onClick={() => setDialog("waive")}>
                Dispensar contrato
              </Button>
            )}
            {!ready && canConfigure && (
              <Button variant="ghost" icon={Settings} to="/admin/configuracoes?aba=contratos">
                Configurar
              </Button>
            )}
          </div>
        )}
      </div>
    );
  else if (contract.status === "sending")
    body = (
      <div className="ct-card ui-enter" aria-live="polite">
        <p className="ct-progress">
          <Spinner size={16} />
          Preparando na AssinaVelox · {STEP_LABELS[contract.step] ?? "em andamento"}
        </p>
        <p className="ct-card__text">Isso leva alguns segundos. Pode fechar esta janela: o envio continua.</p>
      </div>
    );
  else if (contract.status === "failed")
    body = (
      <Callout
        tone="red"
        icon={CircleX}
        title="O contrato não foi enviado"
        live
        actions={
          canManage && (
            <>
              <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy === "retry"} onClick={retry}>
                Tentar de novo
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDialog("cancel")}>
                Cancelar
              </Button>
            </>
          )
        }
      >
        {contract.error ?? "A AssinaVelox não concluiu o envio."}
      </Callout>
    );
  else
    body = (
      <div className={`ct-card ui-enter${contract.status === "completed" ? " is-done" : ""}`}>
        <div className="ct-card__head">
          <div>
            <p className="ct-card__title">{contract.title}</p>
            <p className="ct-card__meta">
              <span className="ct-code">{contract.code}</span>
              {contract.displayCode && <> · AssinaVelox {contract.displayCode}</>}
              {contract.sentAt && <> · enviado em {formatDate(contract.sentAt)}</>}
              {contract.status === "sent" && contract.expiresAt && <> · prazo até {formatDate(contract.expiresAt)}</>}
            </p>
          </div>
        </div>
        <Signers contract={contract} />
        {contract.status === "completed" && (
          <>
            <p className="ct-card__text">
              Concluído em {formatDateTime(contract.completedAt)}.{" "}
              {contract.signatureStatusLabel && <span>{contract.signatureStatusLabel}.</span>}
              {contract.verificationCode && (
                <>
                  {" "}
                  Código de verificação pública: <span className="ct-code">{contract.verificationCode}</span>
                </>
              )}
            </p>
            <ContractFiles contract={contract} />
          </>
        )}
        {contract.status === "sent" && (
          <div className="ct-card__actions">
            {canSignHere && (
              <Button variant="primary" icon={PenLine} onClick={() => setDialog("sign")}>
                Assinar agora
              </Button>
            )}
            <Button variant="secondary" size="sm" icon={RefreshCw} loading={busy === "sync"} onClick={sync}>
              Atualizar status
            </Button>
            <Button variant="ghost" size="sm" icon={ExternalLink} href={contractFileUrl(contract, "original")} target="_blank" rel="noopener">
              PDF enviado
            </Button>
            {canManage && (
              <Button variant="ghost" size="sm" icon={Ban} className="fin-danger-text" onClick={() => setDialog("cancel")}>
                Cancelar contrato
              </Button>
            )}
          </div>
        )}
        {contract.status === "sent" && !canSignHere && mettaSigner?.turn && (
          <p className="ct-card__text">
            Falta a assinatura de {mettaSigner.name}, pela Metta. O convite está no e-mail dessa pessoa
            {mettaSigner.isYou ? "" : "; quem estiver logado com esse e-mail também pode assinar por aqui"}.
          </p>
        )}
      </div>
    );

  return (
    <section className="fin-section" aria-labelledby={`ct-${source.id}`}>
      <SectionTitle
        id={`ct-${source.id}`}
        aside={contract && !terminal ? <StatusBadge kind="contract" value={contract.status} /> : null}
      >
        Contrato
      </SectionTitle>
      {body}
      {detail.data?.contract?.timeline?.length > 0 && (
        <details className="ct-history">
          <summary className="fin-quiet">Histórico do contrato</summary>
          <Timeline items={detail.data.contract.timeline} systemLabel="AssinaVelox" />
        </details>
      )}

      <SendDialog
        open={dialog === "send"}
        onClose={() => setDialog(null)}
        source={source}
        integration={integration}
        onSent={() => {
          setDialog(null);
          onChanged?.();
        }}
      />
      <WaiveDialog
        open={dialog === "waive"}
        onClose={() => setDialog(null)}
        source={source}
        onDone={() => {
          setDialog(null);
          onChanged?.();
        }}
      />
      <ConfirmDialog
        open={dialog === "cancel"}
        onClose={() => setDialog(null)}
        onConfirm={cancel}
        tone="danger"
        title="Cancelar o contrato?"
        description={contract ? `${contract.code} · ${contract.title}` : undefined}
        confirmLabel="Cancelar contrato"
        cancelLabel="Voltar"
      >
        <p>O documento é cancelado na AssinaVelox e quem ainda não assinou é avisado. O histórico fica preservado.</p>
        <Field label="Motivo" optional>
          <Textarea rows={2} maxLength={300} value={cancelReason} onValueChange={setCancelReason} />
        </Field>
      </ConfirmDialog>
      {contract && (
        <EmbeddedSigning
          open={dialog === "sign"}
          onClose={() => {
            setDialog(null);
            detail.reload();
            onChanged?.();
          }}
          title={contract.title}
          subtitle={`${contract.code} · assinatura pela Metta`}
          openSession={openSession}
          onCompleted={() => {
            setTimeout(() => {
              api.post(`/contracts/${contract.id}/sync`).then((res) => detail.setData({ contract: res.contract }), () => {});
            }, 1500);
          }}
          emailHint={`Você também pode assinar pelo link que a AssinaVelox enviou para ${user?.email ?? "o seu e-mail"}.`}
        />
      )}
    </section>
  );
}

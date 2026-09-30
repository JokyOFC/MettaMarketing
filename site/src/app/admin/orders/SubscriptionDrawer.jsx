import { useEffect, useRef, useState } from "react";
import { Ban, BadgeCheck, CircleAlert, Link2, RefreshCw, Send } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  Drawer,
  ErrorState,
  Menu,
  Skeleton,
  SkeletonRows,
  StatusBadge,
  formatDate,
  plural,
  useApi,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { Amount, Callout, Facts, MpErrorNotice, PaymentRows, QuietLink, SectionTitle, Timeline } from "../finance/common.jsx";
import { CheckoutLink, Journey, sentMessage } from "./CheckoutParts.jsx";
import ContractSection, { withContractStep } from "./ContractSection.jsx";

function journeyFor(subscription) {
  const actions = new Set(subscription.timeline.map((entry) => entry.action));
  const linked = subscription.hasCheckout || actions.has("subscription.checkout_created");
  const status = subscription.status;
  const authorized = ["active", "paused"].includes(status) || actions.has("subscription.active");
  return [
    { label: subscription.contractAfterPayment ? "Criada pelo site" : "Criada", state: "done" },
    { label: "Link gerado", state: linked ? "done" : status === "pending" ? "current" : "todo" },
    {
      label: "Autorizada",
      key: "payment",
      state: authorized ? "done" : status === "pending" && linked ? "current" : status === "failed" ? "failed" : "todo",
    },
    status === "cancelled"
      ? { label: "Cancelada", state: "stopped" }
      : status === "paused"
        ? { label: "Pausada", state: "stopped" }
        : { label: "Cobrança mensal", state: status === "active" ? "current" : "todo" },
  ];
}

export default function SubscriptionDrawer({ subscriptionId, onClose, onChanged, mp, canManage, canConfigure }) {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi(subscriptionId ? `/subscriptions/${subscriptionId}` : null);
  const current = data?.subscription?.id === subscriptionId ? data.subscription : null;
  const last = useRef(null);
  if (current) last.current = current;
  const subscription = subscriptionId ? current : last.current;
  const [linkError, setLinkError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    setLinkError(null);
    setConfirmCancel(false);
  }, [subscriptionId]);

  const apply = (next) => {
    setData({ subscription: next });
    onChanged?.();
  };
  const run = async (kind, fn) => {
    setBusy(kind);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const generate = (regenerate = false) =>
    run(regenerate ? "regenerate" : "checkout", async () => {
      setLinkError(null);
      try {
        const res = await api.post(`/subscriptions/${subscription.id}/checkout`, { regenerate });
        apply(res.subscription);
        toast.success(regenerate ? "Novo link de autorização gerado" : "Link de autorização gerado");
      } catch (err) {
        setLinkError({ error: err, retry: () => generate(regenerate) });
      }
    });

  const send = () =>
    run("send", async () => {
      try {
        const res = await api.post(`/subscriptions/${subscription.id}/send`);
        apply(res.subscription);
        toast.success(sentMessage(res, "Assinatura enviada"));
      } catch (err) {
        toast.error(err);
      }
    });

  const sync = () =>
    run("sync", async () => {
      setLinkError(null);
      try {
        const res = await api.post(`/subscriptions/${subscription.id}/sync`);
        apply(res.subscription);
        toast.info(res.changed ? "Status atualizado com o Mercado Pago." : "Nada mudou no Mercado Pago desde a última atualização.");
      } catch (err) {
        setLinkError({ error: err, retry: sync });
      }
    });

  const cancel = async () => {
    const res = await api.post(`/subscriptions/${subscription.id}/cancel`);
    apply(res.subscription);
    toast.success("Assinatura cancelada");
  };

  const status = subscription?.status;
  const pending = status === "pending" || status === "failed";
  const mpReady = mp?.configured !== false;
  const sentBefore = subscription?.timeline.some((entry) => entry.action === "subscription.sent");

  return (
    <>
      <Drawer
        open={Boolean(subscriptionId)}
        onClose={onClose}
        eyebrow="Assinatura"
        title={subscription ? subscription.service.name : "Assinatura"}
        description={subscription?.client.name}
        footer={
          subscription &&
          canManage && (
            <div className="fin-drawer-foot">
              {(subscription.mpPreapprovalId || subscription.hasCheckout) && mpReady && status !== "cancelled" && (
                <Button variant="ghost" size="sm" icon={RefreshCw} loading={busy === "sync"} onClick={sync}>
                  Consultar Mercado Pago
                </Button>
              )}
              <span className="fin-drawer-foot__gap" />
              {status !== "cancelled" && (
                <Button variant="ghost" size="sm" icon={Ban} className="fin-danger-text" onClick={() => setConfirmCancel(true)}>
                  Cancelar assinatura
                </Button>
              )}
            </div>
          )
        }
      >
        {!subscription && loading && (
          <div className="fin-stack">
            <Skeleton width={180} height={40} />
            <SkeletonRows rows={5} columns={2} label="Carregando assinatura" />
          </div>
        )}
        {!subscription && error && <ErrorState error={error} onRetry={reload} compact />}
        {subscription && (
          <div className="fin-stack">
            <div className="fin-hero">
              <Amount cents={subscription.amountCents} size="xl" per="mês" />
              <div className="fin-hero__badges">
                <StatusBadge kind="subscription" value={subscription.status} />
              </div>
            </div>

            {subscription.failureReason && (
              <Callout tone="red" icon={CircleAlert} title="Atenção na cobrança" index={0}>
                <p className="fin-reason">{subscription.failureReason}</p>
                <p>O Mercado Pago tenta a cobrança novamente. O cliente pode atualizar o cartão na conta dele no Mercado Pago.</p>
              </Callout>
            )}
            {status === "active" && !subscription.failureReason && (
              <Callout tone="olive" icon={BadgeCheck} title="Assinatura autorizada no Mercado Pago" index={0}>
                {subscription.nextBillingDate
                  ? `Próxima cobrança prevista para ${formatDate(subscription.nextBillingDate)}.`
                  : "As cobranças mensais acontecem automaticamente."}
              </Callout>
            )}

            <Journey label="Andamento da assinatura" steps={withContractStep(journeyFor(subscription), subscription)} />

            <ContractSection
              source={{
                kind: "subscription",
                id: subscription.id,
                clientId: subscription.client.id,
                title: `Plano ${subscription.service.name} · ${subscription.client.name}`,
                status: subscription.status,
                contract: subscription.contract,
                contractRequired: subscription.contractRequired,
                contractSatisfied: subscription.contractSatisfied,
                contractWaiver: subscription.contractWaiver,
                contractAfterPayment: subscription.contractAfterPayment,
                contractAutoAt: subscription.contractAutoAt,
              }}
              canManage={canManage}
              canConfigure={canConfigure}
              onChanged={() => {
                reload();
                onChanged?.();
              }}
            />

            {pending && (
              <section className="fin-section" aria-labelledby="fin-sub-link">
                <SectionTitle id="fin-sub-link">Autorização no Mercado Pago</SectionTitle>
                {subscription.contractRequired && !subscription.contractSatisfied && (
                  <p className="fin-hint">O cliente só vê o link de autorização depois que o contrato estiver assinado pelas duas partes.</p>
                )}
                {subscription.checkoutUrl ? (
                  <>
                    <CheckoutLink url={subscription.checkoutUrl} />
                    {canManage && (
                      <div className="fin-section__actions">
                        <Button
                          variant={sentBefore ? "secondary" : "primary"}
                          icon={Send}
                          loading={busy === "send"}
                          disabled={!subscription.recipients}
                          onClick={send}
                        >
                          {sentBefore ? "Enviar de novo" : "Enviar ao cliente"}
                        </Button>
                        <Menu
                          label="Mais opções do link"
                          items={[
                            {
                              label: "Gerar novo link",
                              description: "O link atual é cancelado no Mercado Pago",
                              icon: RefreshCw,
                              disabled: !mpReady,
                              onSelect: () => generate(true),
                            },
                          ]}
                        />
                      </div>
                    )}
                    <p className="fin-hint">
                      A autorização precisa ser feita com a conta do Mercado Pago de <strong>{subscription.payerEmail}</strong>.
                      {subscription.recipients
                        ? ` “Enviar ao cliente” avisa ${plural(subscription.recipients, "pessoa", "pessoas")} de ${subscription.client.name}.`
                        : ` ${subscription.client.name} ainda não tem usuários ativos na plataforma.`}
                    </p>
                  </>
                ) : (
                  <div className="fin-linkstart">
                    <p>
                      Gere o link de autorização. O cliente aprova a cobrança mensal de{" "}
                      <strong>{subscription.payerEmail}</strong> no Mercado Pago e a assinatura fica ativa quando o Mercado Pago
                      confirmar.
                    </p>
                    {canManage && (
                      <Button variant="primary" icon={Link2} loading={busy === "checkout"} disabled={!mpReady} onClick={() => generate(false)}>
                        Gerar link de autorização
                      </Button>
                    )}
                    {!mpReady && !linkError && (
                      <MpErrorNotice error={{ code: "integration_not_configured" }} canConfigure={canConfigure} />
                    )}
                  </div>
                )}
                {linkError && (
                  <MpErrorNotice
                    error={linkError.error}
                    canConfigure={canConfigure}
                    retrying={Boolean(busy)}
                    onRetry={linkError.error.code === "integration_not_configured" ? undefined : linkError.retry}
                    onDismiss={() => setLinkError(null)}
                  />
                )}
              </section>
            )}
            {!pending && linkError && (
              <MpErrorNotice error={linkError.error} canConfigure={canConfigure} retrying={Boolean(busy)} onRetry={linkError.retry} />
            )}

            <section className="fin-section" aria-labelledby="fin-sub-details">
              <SectionTitle id="fin-sub-details">Detalhes</SectionTitle>
              <Facts
                items={[
                  {
                    label: "Cliente",
                    value: <QuietLink to={`/admin/clientes/${subscription.client.id}`}>{subscription.client.name}</QuietLink>,
                  },
                  { label: "Plano", value: subscription.service.name },
                  { label: "Pagador", value: subscription.payerEmail },
                  { label: "Início", value: subscription.startedAt && formatDate(subscription.startedAt) },
                  { label: "Próxima cobrança", value: status === "active" && subscription.nextBillingDate && formatDate(subscription.nextBillingDate) },
                  { label: "Cancelada em", value: subscription.cancelledAt && formatDate(subscription.cancelledAt) },
                  {
                    label: "Referência",
                    value: (
                      <span className="fin-ref">
                        <code>{subscription.externalReference}</code>
                        <CopyButton text={subscription.externalReference} label="Copiar referência" iconOnly />
                      </span>
                    ),
                  },
                  {
                    label: "Criada",
                    value: `${formatDate(subscription.createdAt)}${subscription.createdBy ? ` por ${subscription.createdBy.name}` : ""}${subscription.contractAfterPayment ? ", pelo site" : ""}`,
                  },
                ]}
              />
              {subscription.service.items?.length > 0 && (
                <ul className="fin-included">
                  {subscription.service.items.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              )}
            </section>

            <section className="fin-section" aria-labelledby="fin-sub-payments">
              <SectionTitle id="fin-sub-payments">Mensalidades</SectionTitle>
              <PaymentRows payments={subscription.payments} empty="Nenhuma mensalidade registrada ainda. Cada cobrança confirmada pelo Mercado Pago aparece aqui." />
            </section>

            <section className="fin-section" aria-labelledby="fin-sub-history">
              <SectionTitle id="fin-sub-history">Histórico</SectionTitle>
              <Timeline items={subscription.timeline} />
            </section>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancel}
        tone="danger"
        title="Cancelar esta assinatura?"
        description={subscription ? `${subscription.service.name} · ${subscription.client.name}` : undefined}
        confirmLabel="Cancelar assinatura"
        cancelLabel="Voltar"
      >
        {subscription?.mpPreapprovalId
          ? "A cobrança recorrente é cancelada primeiro no Mercado Pago; só depois a assinatura muda aqui. O cliente é avisado e não haverá novas cobranças."
          : "Ainda não há autorização no Mercado Pago; a assinatura é apenas encerrada aqui."}
      </ConfirmDialog>
    </>
  );
}

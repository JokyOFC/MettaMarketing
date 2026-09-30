import { useEffect, useRef, useState } from "react";
import { Ban, CircleCheck, CircleX, Link2, Pencil, RefreshCw, Send } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  DateInput,
  Drawer,
  ErrorState,
  Field,
  Input,
  Menu,
  Skeleton,
  SkeletonRows,
  StatusBadge,
  formatDate,
  formatDateTime,
  plural,
  useApi,
  useToast,
} from "../../ui/index.js";
import { api } from "../../api/client.js";
import { Amount, Callout, Facts, MoneyInput, MpErrorNotice, PaymentRows, QuietLink, SectionTitle, Timeline, dueText } from "../finance/common.jsx";
import { CheckoutLink, Journey, sentMessage } from "./CheckoutParts.jsx";
import ContractSection, { withContractStep } from "./ContractSection.jsx";
import { useInvalidFocus } from "../clients/crmShared.jsx";

const OPEN = new Set(["pending_payment", "failed"]);

function journeyFor(order) {
  const actions = new Set(order.timeline.map((entry) => entry.action));
  const linked = order.hasCheckout || actions.has("order.checkout_created");
  const sent = actions.has("order.sent");
  const end = {
    paid: { label: "Pago", state: "done" },
    refunded: { label: "Estornado", state: "stopped" },
    failed: { label: "Não aprovado", state: "failed" },
    cancelled: { label: "Cancelado", state: "stopped" },
  }[order.status] ?? { label: "Pago", state: linked ? "current" : "todo" };
  const closed = ["paid", "refunded", "cancelled", "failed"].includes(order.status);
  // Bought on the site: the client opened the payment; nothing was sent.
  const site = order.contractAfterPayment;
  return [
    { label: site ? "Pedido pelo site" : "Criado", state: "done" },
    { label: "Link gerado", state: linked ? "done" : closed ? "todo" : "current" },
    ...(site ? [] : [{ label: "Enviado", state: sent ? "done" : "todo" }]),
    { ...end, key: "payment" },
  ];
}

function EditOrder({ order, onCancel, onSaved }) {
  const draft = order.status === "draft";
  const [form, setForm] = useState({ description: order.description, amountCents: order.amountCents, dueDate: order.dueDate ?? "" });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState(null);
  const [formRef, focusInvalid] = useInvalidFocus();

  const save = async (event) => {
    event.preventDefault();
    const body = draft
      ? { description: form.description.trim(), amountCents: form.amountCents, dueDate: form.dueDate || null }
      : { dueDate: form.dueDate || null };
    const local = {};
    if (draft && !body.description) local.description = "Descreva o pedido.";
    if (draft && !(body.amountCents > 0)) local.amountCents = "Informe um valor maior que zero.";
    setErrors(local);
    if (Object.keys(local).length) return focusInvalid();
    setSaving(true);
    setFailure(null);
    try {
      const res = await api.patch(`/orders/${order.id}`, body);
      onSaved(res.order);
    } catch (err) {
      if (err.fields) {
        setErrors(err.fields);
        focusInvalid(err.message);
      }
      setFailure(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form ref={formRef} className="fin-edit ui-enter" onSubmit={save} noValidate>
      {draft && (
        <>
          <Field label="Descrição" required error={errors.description}>
            <Input value={form.description} maxLength={250} data-autofocus onValueChange={(description) => setForm((f) => ({ ...f, description }))} />
          </Field>
          <Field label="Valor" required error={errors.amountCents}>
            <MoneyInput value={form.amountCents} onValueChange={(amountCents) => setForm((f) => ({ ...f, amountCents }))} />
          </Field>
        </>
      )}
      <Field label="Vencimento" optional error={errors.dueDate} hint={draft ? undefined : "Com o link já gerado, só o vencimento pode mudar."}>
        <DateInput value={form.dueDate} onValueChange={(dueDate) => setForm((f) => ({ ...f, dueDate }))} />
      </Field>
      {failure && !failure.fields && <p className="ui-inline-error" role="alert">{failure.message}</p>}
      <div className="fin-edit__actions">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button variant="primary" size="sm" type="submit" loading={saving}>
          Salvar
        </Button>
      </div>
    </form>
  );
}

export default function OrderDrawer({ orderId, onClose, onChanged, mp, canManage, canConfigure }) {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi(orderId ? `/orders/${orderId}` : null);
  const current = data?.order?.id === orderId ? data.order : null;
  // Keep the last record on screen while the drawer slides out.
  const last = useRef(null);
  if (current) last.current = current;
  const order = orderId ? current : last.current;
  const [linkError, setLinkError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setLinkError(null);
    setEditing(false);
    setConfirmCancel(false);
  }, [orderId]);

  const apply = (next) => {
    setData({ order: next });
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
        const res = await api.post(`/orders/${order.id}/checkout`, { regenerate });
        apply(res.order);
        toast.success(regenerate ? "Novo link gerado. O anterior deixa de aceitar pagamentos." : "Link de pagamento gerado");
      } catch (err) {
        setLinkError({ error: err, retry: () => generate(regenerate) });
      }
    });

  const send = () =>
    run("send", async () => {
      try {
        const res = await api.post(`/orders/${order.id}/send`);
        apply(res.order);
        toast.success(sentMessage(res));
      } catch (err) {
        toast.error(err);
      }
    });

  const sync = () =>
    run("sync", async () => {
      setLinkError(null);
      try {
        const res = await api.post(`/orders/${order.id}/sync`);
        apply(res.order);
        toast.info(
          res.found
            ? `${plural(res.found, "pagamento encontrado", "pagamentos encontrados")} no Mercado Pago${res.changed ? "; status atualizado." : "; nada mudou."}`
            : "O Mercado Pago ainda não tem pagamentos para este pedido.",
        );
      } catch (err) {
        setLinkError({ error: err, retry: sync });
      }
    });

  const cancel = async () => {
    const res = await api.post(`/orders/${order.id}/cancel`);
    apply(res.order);
    if (res.warning) toast.info(res.warning);
    else toast.success("Pedido cancelado");
  };

  const open = order && (order.status === "draft" || OPEN.has(order.status));
  const sentBefore = order?.timeline.some((entry) => entry.action === "order.sent");
  const mpReady = mp?.configured !== false;

  return (
    <>
      <Drawer
        open={Boolean(orderId)}
        onClose={onClose}
        eyebrow="Pedido"
        title={order ? order.description : "Pedido"}
        description={order ? `${order.client.name}${order.brand ? ` · ${order.brand.name}` : ""}` : undefined}
        footer={
          order &&
          canManage && (
            <div className="fin-drawer-foot">
              {order.hasCheckout && open && mpReady && (
                <Button variant="ghost" size="sm" icon={RefreshCw} loading={busy === "sync"} onClick={sync}>
                  Consultar Mercado Pago
                </Button>
              )}
              <span className="fin-drawer-foot__gap" />
              {open && (
                <Button variant="ghost" size="sm" icon={Ban} className="fin-danger-text" onClick={() => setConfirmCancel(true)}>
                  Cancelar pedido
                </Button>
              )}
            </div>
          )
        }
      >
        {!order && loading && (
          <div className="fin-stack">
            <Skeleton width={180} height={40} />
            <SkeletonRows rows={5} columns={2} label="Carregando pedido" />
          </div>
        )}
        {!order && error && <ErrorState error={error} onRetry={reload} compact />}
        {order && (
          <div className="fin-stack">
            <div className="fin-hero">
              <Amount cents={order.amountCents} size="xl" />
              <div className="fin-hero__badges">
                <StatusBadge kind="order" value={order.status} />
                {order.overdue && <Badge tone="red">Vencido</Badge>}
              </div>
            </div>

            {order.status === "failed" && (
              <Callout tone="red" icon={CircleX} title="Pagamento não aprovado" index={0}>
                <p className="fin-reason">{order.failureReason ?? "O Mercado Pago recusou a última tentativa."}</p>
                <p>
                  O cliente pode tentar de novo pelo mesmo link, com outro cartão ou via Pix. Se preferir, gere um novo link e
                  envie outra vez.
                </p>
              </Callout>
            )}
            {order.status === "paid" && (
              <Callout tone="olive" icon={CircleCheck} title="Pagamento confirmado pelo Mercado Pago" index={0}>
                Pago em {formatDateTime(order.paidAt)}.
              </Callout>
            )}
            {order.status === "cancelled" && (
              <Callout tone="neutral" icon={Ban} title="Pedido cancelado" index={0}>
                O link não aceita novos pagamentos. Se algum pagamento chegar mesmo assim, ele aparece abaixo para estorno.
              </Callout>
            )}

            <Journey label="Andamento do pedido" steps={withContractStep(journeyFor(order), order)} />

            <ContractSection
              source={{
                kind: "order",
                id: order.id,
                clientId: order.client.id,
                title: `${order.description} · ${order.client.name}`,
                status: order.status,
                contract: order.contract,
                contractRequired: order.contractRequired,
                contractSatisfied: order.contractSatisfied,
                contractWaiver: order.contractWaiver,
                contractAfterPayment: order.contractAfterPayment,
                contractAutoAt: order.contractAutoAt,
              }}
              canManage={canManage}
              canConfigure={canConfigure}
              onChanged={() => {
                reload();
                onChanged?.();
              }}
            />

            {open && (
              <section className="fin-section" aria-labelledby="fin-order-link">
                <SectionTitle id="fin-order-link">Link de pagamento</SectionTitle>
                {order.contractRequired && !order.contractSatisfied && (
                  <p className="fin-hint">O cliente só consegue pagar depois que o contrato estiver assinado pelas duas partes.</p>
                )}
                {order.checkoutUrl ? (
                  <>
                    <CheckoutLink url={order.checkoutUrl} />
                    {canManage && (
                      <div className="fin-section__actions">
                        <Button
                          variant={sentBefore ? "secondary" : "primary"}
                          icon={Send}
                          loading={busy === "send"}
                          disabled={!OPEN.has(order.status) || !order.recipients}
                          onClick={send}
                        >
                          {sentBefore ? "Enviar de novo" : "Enviar ao cliente"}
                        </Button>
                        <Menu
                          label="Mais opções do link"
                          items={[
                            {
                              label: "Gerar novo link",
                              description: "O link atual deixa de aceitar pagamentos",
                              icon: RefreshCw,
                              disabled: !mpReady || busy === "regenerate",
                              onSelect: () => generate(true),
                            },
                          ]}
                        />
                      </div>
                    )}
                    <p className="fin-hint">
                      {order.recipients
                        ? `“Enviar ao cliente” avisa ${plural(order.recipients, "pessoa", "pessoas")} de ${order.client.name} na plataforma e por e-mail. O pagamento acontece no Mercado Pago.`
                        : `${order.client.name} ainda não tem usuários ativos. Convide alguém em Clientes e marcas ou copie o link.`}
                    </p>
                  </>
                ) : (
                  <div className="fin-linkstart">
                    <p>
                      Gere o link do Checkout Pro do Mercado Pago. O pedido passa para <strong>Aguardando pagamento</strong> e fica
                      visível ao cliente em Financeiro.
                    </p>
                    {canManage && (
                      <Button
                        variant="primary"
                        icon={Link2}
                        loading={busy === "checkout"}
                        onClick={() => generate(false)}
                        disabled={!mpReady}
                      >
                        Gerar link de pagamento
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

            <section className="fin-section" aria-labelledby="fin-order-details">
              <SectionTitle
                id="fin-order-details"
                aside={
                  canManage &&
                  open &&
                  !editing && (
                    <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>
                      {order.status === "draft" ? "Editar" : "Alterar vencimento"}
                    </Button>
                  )
                }
              >
                Detalhes
              </SectionTitle>
              {editing ? (
                <EditOrder
                  order={order}
                  onCancel={() => setEditing(false)}
                  onSaved={(next) => {
                    setEditing(false);
                    apply(next);
                    toast.success("Pedido atualizado");
                  }}
                />
              ) : (
                <Facts
                  items={[
                    { label: "Cliente", value: <QuietLink to={`/admin/clientes/${order.client.id}`}>{order.client.name}</QuietLink> },
                    { label: "Marca", value: order.brand?.name },
                    { label: "Serviço", value: order.service?.name ?? "Personalizado" },
                    {
                      label: "Vencimento",
                      value: order.dueDate ? (
                        <span className={order.overdue ? "fin-overdue" : undefined}>{dueText(order.dueDate, order.overdue)}</span>
                      ) : (
                        "Sem vencimento"
                      ),
                    },
                    { label: "Pago em", value: order.paidAt && formatDateTime(order.paidAt) },
                    {
                      label: "Referência",
                      value: (
                        <span className="fin-ref">
                          <code>{order.externalReference}</code>
                          <CopyButton text={order.externalReference} label="Copiar referência" iconOnly />
                        </span>
                      ),
                    },
                    {
                      label: "Criado",
                      value: `${formatDate(order.createdAt)}${order.createdBy ? ` por ${order.createdBy.name}` : ""}${order.contractAfterPayment ? ", pelo site" : ""}`,
                    },
                  ]}
                />
              )}
            </section>

            <section className="fin-section" aria-labelledby="fin-order-payments">
              <SectionTitle id="fin-order-payments">Pagamentos</SectionTitle>
              <PaymentRows
                payments={order.payments}
                empty={
                  order.hasCheckout
                    ? "Nenhuma tentativa de pagamento ainda. Cada tentativa confirmada pelo Mercado Pago aparece aqui."
                    : "Os pagamentos aparecem aqui depois que o link for gerado e o cliente pagar."
                }
              />
            </section>

            <section className="fin-section" aria-labelledby="fin-order-history">
              <SectionTitle id="fin-order-history">Histórico</SectionTitle>
              <Timeline items={order.timeline} />
            </section>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancel}
        tone="danger"
        title="Cancelar este pedido?"
        description={order ? `${order.description} · ${order.client.name}` : undefined}
        confirmLabel="Cancelar pedido"
        cancelLabel="Voltar"
      >
        {order?.hasCheckout
          ? "O link de pagamento é desativado no Mercado Pago e o cliente recebe um aviso na plataforma. O histórico fica preservado."
          : "O pedido é encerrado e sai da lista de cobranças. O histórico fica preservado."}
      </ConfirmDialog>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BadgeCheck,
  CircleCheck,
  CircleX,
  Clock,
  CreditCard,
  FileSignature,
  Hourglass,
  Info,
  Lock,
  RefreshCw,
  Repeat,
  Wallet,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  Panel,
  Skeleton,
  SkeletonCards,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatRelative,
  useApi,
  useToast,
} from "../../ui/index.js";
import { useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import { api } from "../../api/client.js";
import { Amount, Callout, PaymentRows, cx } from "../../admin/finance/common.jsx";
import "../../admin/finance/fin.css";
import ClientContracts from "./ClientContracts.jsx";

const POLL_MS = 4000;
const POLL_LIMIT = 23; // ~90 s
const RETURNS = new Set(["sucesso", "pendente", "falha", "assinatura"]);
// Parameters Mercado Pago appends to the return URL; never trusted, only cleared.
const MP_PARAMS = [
  "retorno",
  "collection_id",
  "collection_status",
  "payment_id",
  "status",
  "external_reference",
  "payment_type",
  "merchant_order_id",
  "preference_id",
  "site_id",
  "processing_mode",
  "merchant_account_id",
  "preapproval_id",
];

// Which order the return refers to (Mercado Pago echoes our external_reference).
const orderIdFromReference = (reference) => (reference?.startsWith("metta-ord_") ? reference.slice("metta-".length) : null);

// The contract waits for the client's signature (not for Metta's).
const awaitsClient = (contract) => contract?.status === "sent" && contract.signers?.some((s) => s.role === "client" && s.turn);

// Site purchases are paid first; their contract follows in the Contratos section.
const CONTRACT_NEXT = " O contrato chega em instantes na seção Contratos desta página, para você assinar.";

function ReturnBanner({ kind, order, subscription, polling, contractsEnabled, onRefresh, onDismiss, refreshing }) {
  // The server is the only source of truth: "paid" only when it says so.
  if (order?.status === "paid")
    return (
      <Callout
        live
        tone="olive"
        icon={CircleCheck}
        title="Pagamento confirmado"
        className="fin-return is-confirmed"
        actions={
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Fechar
          </Button>
        }
      >
        O Mercado Pago confirmou o pagamento de {order.description}. Obrigado!
        {contractsEnabled && order.contractAfterPayment && !order.contract ? CONTRACT_NEXT : ""}
      </Callout>
    );
  if (kind === "assinatura" && subscription?.status === "active")
    return (
      <Callout live tone="olive" icon={BadgeCheck} title="Assinatura ativa" className="fin-return is-confirmed" actions={<Button size="sm" variant="ghost" onClick={onDismiss}>Fechar</Button>}>
        O Mercado Pago confirmou a autorização de {subscription.service.name}. As cobranças mensais acontecem automaticamente.
        {contractsEnabled && subscription.contractAfterPayment && !subscription.contract ? CONTRACT_NEXT : ""}
      </Callout>
    );
  const refresh = (
    <Button size="sm" variant="secondary" icon={RefreshCw} loading={refreshing} onClick={onRefresh}>
      Atualizar
    </Button>
  );
  const close = (
    <Button size="sm" variant="ghost" onClick={onDismiss}>
      Fechar aviso
    </Button>
  );
  if (kind === "falha")
    return (
      <Callout
        live
        tone="red"
        icon={CircleX}
        title="O pagamento não foi concluído"
        className="fin-return"
        actions={close}
      >
        {order?.status === "failed" && order.failureReason ? <p className="fin-reason">{order.failureReason}.</p> : null}
        <p>
          O Mercado Pago informou que esta tentativa não foi concluída. Você pode tentar de novo, com outro cartão ou via Pix, ou
          falar com a Metta se precisar de ajuda.
        </p>
      </Callout>
    );
  if (kind === "pendente")
    return (
      <Callout live tone="amber" icon={Hourglass} title="Pagamento em processamento" className="fin-return" actions={<>{refresh}{close}</>}>
        <p>
          O Mercado Pago ainda está processando o pagamento. Pix costuma compensar em minutos; boleto, em até 3 dias úteis.
          Avisamos aqui e por e-mail assim que for aprovado.
        </p>
        {polling && <p className="fin-return__poll">Verificando a confirmação automaticamente…</p>}
      </Callout>
    );
  if (kind === "assinatura")
    return (
      <Callout live tone="slate" icon={Clock} title="Recebemos seu retorno do Mercado Pago" className="fin-return" actions={<>{refresh}{close}</>}>
        <p>A assinatura aparece como ativa assim que o Mercado Pago confirmar a autorização.</p>
        {polling && <p className="fin-return__poll">Verificando a confirmação automaticamente…</p>}
      </Callout>
    );
  return (
    <Callout live tone="slate" icon={Clock} title="Recebemos seu retorno do Mercado Pago" className="fin-return" actions={<>{refresh}{close}</>}>
      <p>A confirmação aparece aqui assim que o pagamento for aprovado.</p>
      {polling && <p className="fin-return__poll">Verificando a confirmação automaticamente…</p>}
    </Callout>
  );
}

function dueLabel(dueDate, overdue) {
  const relative = formatRelative(dueDate);
  const absolute = formatDate(dueDate);
  const isRelative = /^(hoje|amanhã|ontem|em \d|há \d)/.test(relative);
  return `${overdue ? "Venceu" : "Vence"} ${isRelative ? `${relative} · ${absolute}` : `em ${absolute}`}`;
}

function OpenOrderCard({ order, index, paying, payError, onPay, onRetry }) {
  const failed = order.status === "failed";
  return (
    <Card as="article" padding="none" index={index} className={cx("fin-bill", failed && "is-failed", order.overdue && "is-overdue")}>
      <div className="fin-bill__main">
        <div className="fin-bill__info">
          <div className="fin-bill__badges">
            <StatusBadge kind="order" value={order.status} size="sm" />
            {order.overdue && (
              <Badge size="sm" tone="red">
                Vencido
              </Badge>
            )}
          </div>
          <h3 className="fin-bill__title">{order.description}</h3>
          <p className="fin-bill__meta">
            {order.brand && <span>{order.brand.name}</span>}
            {order.dueDate ? (
              <span className={order.overdue ? "fin-overdue" : undefined}>{dueLabel(order.dueDate, order.overdue)}</span>
            ) : (
              <span>Sem data de vencimento</span>
            )}
          </p>
          {failed && order.failureReason && (
            <p className="fin-bill__reason">
              <Icon icon={CircleX} size={14} />
              <span>Última tentativa não aprovada: {order.failureReason}</span>
            </p>
          )}
        </div>
        <div className="fin-bill__pay">
          <Amount cents={order.amountCents} size="lg" />
          {order.canPay ? (
            <>
              <Button variant="primary" icon={CreditCard} loading={paying} onClick={onPay} block>
                {failed ? "Tentar de novo" : "Pagar com Mercado Pago"}
              </Button>
              <span className="fin-bill__secure">
                <Icon icon={Lock} size={12} /> Pagamento seguro no Mercado Pago
              </span>
            </>
          ) : (
            <>
              {awaitsClient(order.contract) && (
                <Button variant="secondary" icon={FileSignature} href="#contratos" block>
                  Assinar o contrato
                </Button>
              )}
              <span className="fin-bill__secure">
                <Icon icon={Lock} size={12} /> {order.payBlockedReason ?? "O pagamento é liberado depois da assinatura."}
              </span>
            </>
          )}
        </div>
      </div>
      {payError && (
        <div className="fin-bill__error">
          {payError.code === "integration_not_configured" ? (
            <Callout live tone="amber" icon={Info} title="Pagamento online indisponível">
              {payError.message || "Pagamento online indisponível no momento. Fale com a Metta."}
            </Callout>
          ) : (
            <Callout
              live
              tone="red"
              icon={CircleX}
              title="Não foi possível abrir o pagamento"
              actions={
                payError.code !== "conflict" && (
                  <Button size="sm" icon={RefreshCw} onClick={onRetry}>
                    Tentar de novo
                  </Button>
                )
              }
            >
              {payError.message}
            </Callout>
          )}
        </div>
      )}
    </Card>
  );
}

function SubscriptionCard({ subscription, index }) {
  const { status } = subscription;
  return (
    <Card as="article" padding="md" index={index} className="fin-subcard">
      <div className="fin-subcard__head">
        <div>
          <p className="fin-subcard__eyebrow">Plano mensal</p>
          <h3 className="fin-subcard__title">{subscription.service.name}</h3>
        </div>
        <StatusBadge kind="subscription" value={status} />
      </div>
      <Amount cents={subscription.amountCents} size="lg" per="mês" />
      {subscription.service.items?.length > 0 && (
        <ul className="fin-included">
          {subscription.service.items.map((item, i) => (
            <li key={`${item}-${i}`}>{item}</li>
          ))}
        </ul>
      )}
      <div className="fin-subcard__facts">
        {status === "active" && subscription.nextBillingDate && <span>Próxima cobrança em {formatDate(subscription.nextBillingDate)}</span>}
        {subscription.startedAt && <span>Ativa desde {formatDate(subscription.startedAt)}</span>}
        {status === "cancelled" && subscription.cancelledAt && <span>Cancelada em {formatDate(subscription.cancelledAt)}</span>}
        {status === "paused" && <span>Pausada no Mercado Pago. Nenhuma cobrança acontece enquanto estiver pausada.</span>}
      </div>
      {subscription.failureReason && (
        <p className="fin-bill__reason">
          <Icon icon={CircleX} size={14} />
          <span>{subscription.failureReason}. O Mercado Pago tenta novamente; você pode atualizar o cartão na sua conta do Mercado Pago.</span>
        </p>
      )}
      {status === "pending" &&
        (subscription.checkoutUrl ? (
          <div className="fin-subcard__action">
            <p>
              Autorize a cobrança mensal no Mercado Pago com a conta <strong>{subscription.payerEmail}</strong>.
            </p>
            <Button variant="primary" icon={BadgeCheck} href={subscription.checkoutUrl}>
              Autorizar no Mercado Pago
            </Button>
          </div>
        ) : subscription.payBlockedReason ? (
          <div className="fin-subcard__action">
            <p>{subscription.payBlockedReason}</p>
            {awaitsClient(subscription.contract) && (
              <Button variant="secondary" icon={FileSignature} href="#contratos">
                Assinar o contrato
              </Button>
            )}
          </div>
        ) : (
          <p className="fin-quiet">A Metta está preparando o link de autorização desta assinatura.</p>
        ))}
    </Card>
  );
}

export default function ClientBilling() {
  usePageTitle("Financeiro");
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data, error, loading, refreshing, reload } = useApi("/portal/billing");
  const contracts = useApi("/portal/contracts");
  const [paying, setPaying] = useState(null);
  const [payErrors, setPayErrors] = useState({});
  const [polls, setPolls] = useState(0);
  const [contractPolls, setContractPolls] = useState(0);
  const pollTimer = useRef(0);

  const retorno = RETURNS.has(params.get("retorno")) ? params.get("retorno") : null;
  const returnedOrderId = orderIdFromReference(params.get("external_reference"));
  const orders = data?.orders ?? [];
  // Open = still to be paid (payment may wait for the contract signature).
  const open = orders.filter((o) => o.status === "pending_payment" || o.status === "failed");
  const closed = orders.filter((o) => o.status !== "pending_payment" && o.status !== "failed");
  const subscriptions = data?.subscriptions ?? [];
  const payments = data?.payments ?? [];
  const returnedOrder = returnedOrderId ? orders.find((o) => o.id === returnedOrderId) : null;
  const pendingSubscription = subscriptions.find((s) => s.status === "pending") ?? subscriptions[0];

  const settled =
    (retorno === "assinatura" && pendingSubscription?.status === "active") ||
    (returnedOrder ? returnedOrder.status === "paid" : retorno === "sucesso" && !open.length && orders.length > 0);
  const polling = Boolean(retorno && retorno !== "falha" && data && !settled && polls < POLL_LIMIT);

  // After returning from Mercado Pago, check the server for a while (webhooks take seconds).
  useEffect(() => {
    if (!polling) return undefined;
    pollTimer.current = window.setTimeout(() => {
      if (document.visibilityState === "visible") reload().catch(() => {});
      setPolls((n) => n + 1);
    }, POLL_MS);
    return () => window.clearTimeout(pollTimer.current);
  }, [polling, polls, reload]);

  // A site purchase just confirmed: its contract is on the way; show it as soon as it is sent.
  const returnedItem = retorno === "assinatura" ? pendingSubscription : returnedOrder;
  const reloadContracts = contracts.reload;
  const awaitingContract = Boolean(
    settled &&
      data?.contractsEnabled &&
      returnedItem?.contractAfterPayment &&
      !contracts.data?.items?.some((c) => c.orderId === returnedItem.id || c.subscriptionId === returnedItem.id) &&
      contractPolls < POLL_LIMIT,
  );
  useEffect(() => {
    if (!awaitingContract) return undefined;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible") {
        reloadContracts().catch(() => {});
        reload().catch(() => {});
      }
      setContractPolls((n) => n + 1);
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [awaitingContract, contractPolls, reloadContracts, reload]);

  const dismiss = () => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const key of MP_PARAMS) next.delete(key);
        return next;
      },
      { replace: true },
    );
    setPolls(0);
  };

  const pay = async (order) => {
    setPaying(order.id);
    setPayErrors((current) => ({ ...current, [order.id]: null }));
    try {
      const res = await api.post(`/portal/orders/${order.id}/pay`);
      if (!/^https:\/\//.test(res.checkoutUrl ?? "")) throw new Error("Link de pagamento inválido. Fale com a Metta.");
      window.location.assign(res.checkoutUrl);
      // Keep the button busy while the browser leaves the page.
    } catch (err) {
      setPaying(null);
      if (err.code === "conflict") {
        toast.info(err.message);
        reload().catch(() => {});
      }
      setPayErrors((current) => ({ ...current, [order.id]: err }));
    }
  };

  const totalOpen = useMemo(() => open.reduce((sum, o) => sum + (o.amountCents ?? 0), 0), [open]);

  // Contracts come first while one waits for the client's signature; after
  // that they are reference material below the charges. The key keeps the
  // section's state (signing drawer) when it moves.
  const contractItems = contracts.data?.items;
  const contractsFirst = Boolean(contractItems?.some(awaitsClient));
  const contractsSection = (
    <ClientContracts
      key="contracts"
      contracts={contractItems}
      onChanged={() => {
        contracts.reload().catch(() => {});
        reload().catch(() => {});
      }}
    />
  );

  return (
    <div className="fin-page fin-portal">
      <PageHeader
        eyebrow="Financeiro"
        title="Pagamentos e"
        accent="assinaturas"
        description={`Cobranças da Metta para ${user?.client?.name ?? "sua empresa"}. Os pagamentos são processados com segurança pelo Mercado Pago; a Metta não vê os dados do seu cartão.`}
      />

      {retorno && data && (
        <ReturnBanner
          kind={retorno}
          order={returnedOrder}
          subscription={pendingSubscription}
          polling={polling}
          contractsEnabled={Boolean(data.contractsEnabled)}
          refreshing={refreshing}
          onRefresh={() => reload().catch(() => {})}
          onDismiss={dismiss}
        />
      )}

      {/* Waits for the contracts too: they decide the order of the sections. */}
      {loading || contracts.loading ? (
        <div className="fin-stack">
          <SkeletonCards count={2} aspect={5} minWidth={320} lines={2} label="Carregando financeiro" />
          <Skeleton height={120} />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : (
        <>
          {contractsFirst && contractsSection}

          {!data.paymentsEnabled && open.length > 0 && (
            <Callout tone="amber" icon={Info} title="Pagamento online indisponível no momento" className="fin-mb" index={0}>
              Pagamento online indisponível no momento. Fale com a Metta para combinar outra forma de pagamento.
            </Callout>
          )}

          <section className="fin-portal__section" aria-labelledby="fin-open-title">
            <div className="fin-portal__head">
              <h2 className="fin-portal__title" id="fin-open-title">
                Cobranças em <em>aberto</em>
              </h2>
              {open.length > 0 && (
                <p className="fin-portal__total">
                  Total <Amount cents={totalOpen} size="sm" />
                </p>
              )}
            </div>
            {open.length ? (
              <div className="fin-bills">
                {open.map((order, index) => (
                  <OpenOrderCard
                    key={order.id}
                    order={order}
                    index={index}
                    paying={paying === order.id}
                    payError={payErrors[order.id]}
                    onPay={() => pay(order)}
                    onRetry={() => pay(order)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                icon={Wallet}
                title="Nenhuma cobrança em aberto"
                description="Quando a Metta enviar uma cobrança, ela aparece aqui para pagamento pelo Mercado Pago. Você também recebe um aviso por e-mail."
              />
            )}
          </section>

          <section className="fin-portal__section" aria-labelledby="fin-subs-title">
            <div className="fin-portal__head">
              <h2 className="fin-portal__title" id="fin-subs-title">
                Assinatura
              </h2>
            </div>
            {subscriptions.length ? (
              <div className="fin-subcards">
                {subscriptions.map((subscription, index) => (
                  <SubscriptionCard key={subscription.id} subscription={subscription} index={index} />
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                icon={Repeat}
                title="Nenhuma assinatura"
                description="Planos mensais contratados com a Metta aparecem aqui, com o status da cobrança recorrente no Mercado Pago."
                action={
                  <Button size="sm" variant="secondary" to="/planos">
                    Conhecer os planos
                  </Button>
                }
              />
            )}
          </section>

          {!contractsFirst && contractsSection}

          <div className="fin-portal__grid">
            <Panel title="Histórico de pagamentos" eyebrow="Mercado Pago" className="fin-block">
              <PaymentRows
                payments={payments}
                showTarget
                empty="Nenhum pagamento registrado ainda. Cada pagamento confirmado pelo Mercado Pago aparece aqui com data e meio de pagamento."
              />
            </Panel>
            {closed.length > 0 && (
              <Panel title="Cobranças encerradas" eyebrow="Pedidos" className="fin-block">
                <ul className="fin-closed">
                  {closed.map((order) => (
                    <li key={order.id} className="fin-closed__row">
                      <div>
                        <p className="fin-closed__title">{order.description}</p>
                        <p className="fin-closed__meta">
                          {order.status === "paid" && order.paidAt ? `Pago em ${formatDateTime(order.paidAt)}` : `Criado em ${formatDate(order.createdAt)}`}
                        </p>
                      </div>
                      <div className="fin-closed__side">
                        <Amount cents={order.amountCents} size="sm" />
                        <StatusBadge kind="order" value={order.status} size="sm" />
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        </>
      )}
    </div>
  );
}

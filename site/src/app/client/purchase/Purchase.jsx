// Online purchase started by a "Comprar" button of the site (/planos).
// Shows the item with the catalog price, asks what Mercado Pago and the
// contract need (payer e-mail for plans, CPF/CNPJ when missing) and sends the
// client to Mercado Pago. The contract comes after the payment is confirmed.
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Check, CircleX, CreditCard, Info, Lock, MessageCircle, PackageX, RefreshCw, Wallet } from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  PageHeader,
  Panel,
  Skeleton,
  focusFirstInvalid,
  useApi,
} from "../../ui/index.js";
import { usePageTitle } from "../../shell/index.js";
import { api } from "../../api/client.js";
import { whatsappUrl } from "../../../data/brand.js";
import { Amount, Callout } from "../../admin/finance/common.jsx";
import "../../admin/finance/fin.css";
import "./purchase.css";

function Steps({ offer, contractAfterPayment }) {
  const plan = offer.kind === "subscription";
  const steps = [
    {
      title: "Pagamento no Mercado Pago",
      text: plan
        ? "Você autoriza a cobrança mensal com a sua conta do Mercado Pago. As mensalidades são cobradas automaticamente."
        : "Você paga com os meios disponíveis no Mercado Pago. A Metta não vê os dados do seu cartão.",
    },
    {
      title: "Contrato",
      text: contractAfterPayment
        ? "Com o pagamento confirmado, o contrato chega em Financeiro para você assinar aqui mesmo. O convite também vai por e-mail."
        : "Com o pagamento confirmado, a Metta entra em contato para formalizar o contrato.",
    },
    {
      title: "Início",
      text: "A equipe da Metta é avisada na hora e combina com você os próximos passos da sua marca.",
    },
  ];
  return (
    <ol className="buy-steps">
      {steps.map((step, index) => (
        <li key={step.title}>
          <span className="buy-steps__num" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div>
            <strong>{step.title}</strong>
            <p>{step.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function TalkToMetta() {
  return (
    <Button size="sm" variant="ghost" icon={MessageCircle} href={whatsappUrl} target="_blank" rel="noopener noreferrer">
      Falar com a Metta
    </Button>
  );
}

export default function Purchase() {
  const { slug } = useParams();
  usePageTitle("Contratar");
  const { data, error, loading, reload } = useApi(`/portal/offers/${encodeURIComponent(slug ?? "")}`);
  const [payerEmail, setPayerEmail] = useState("");
  const [taxId, setTaxId] = useState("");
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef(null);

  const offer = data?.offer;
  const plan = offer?.kind === "subscription";
  useEffect(() => {
    if (data?.payerEmail) setPayerEmail((current) => current || data.payerEmail);
  }, [data?.payerEmail]);

  const submit = async (event) => {
    event.preventDefault();
    const local = {};
    if (plan && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail.trim())) local.payerEmail = "Informe um e-mail válido.";
    if (data.needsDocument) {
      const digits = taxId.replace(/\D/g, "");
      if (!taxId.trim()) local.document = "Informe o CNPJ ou o CPF que vai no contrato.";
      else if (digits.length !== 11 && digits.length !== 14) local.document = "Informe um CPF (11 dígitos) ou um CNPJ (14 dígitos).";
    }
    setErrors(local);
    setFailure(null);
    if (Object.keys(local).length) return focusFirstInvalid(formRef);
    setBusy(true);
    try {
      const res = await api.post("/portal/purchases", {
        offer: offer.slug,
        ...(plan ? { payerEmail: payerEmail.trim() } : {}),
        ...(data.needsDocument ? { document: taxId.trim() } : {}),
      });
      if (!/^https:\/\//.test(res.checkoutUrl ?? "")) throw new Error("Link de pagamento inválido. Fale com a Metta.");
      window.location.assign(res.checkoutUrl);
      // Stays busy while the browser leaves for Mercado Pago.
    } catch (err) {
      setBusy(false);
      if (err.fields) {
        setErrors(err.fields);
        focusFirstInvalid(formRef);
        return;
      }
      // Something changed (plan now active, item unavailable): show the current state.
      if (["plan_active", "plan_pending", "not_found"].includes(err.code)) reload().catch(() => {});
      else setFailure(err);
    }
  };

  let content;
  if (loading && !data)
    content = (
      <div className="buy-grid" aria-busy="true" aria-label="Carregando pedido">
        <Skeleton height={320} />
        <Skeleton height={320} />
      </div>
    );
  else if (error?.code === "not_found")
    content = (
      <EmptyState
        icon={PackageX}
        title="Este item não está disponível para compra online"
        description="Ele pode ter saído do catálogo. Veja os planos atuais no site ou fale com a Metta."
        action={
          <div className="buy-actions">
            <Button variant="secondary" to="/planos">
              Ver planos
            </Button>
            <TalkToMetta />
          </div>
        }
      />
    );
  else if (error) content = <ErrorState error={error} onRetry={reload} />;
  else if (offer)
    content = (
      <div className="buy-grid">
        <Card as="section" padding="lg" className="buy-offer" aria-labelledby="buy-offer-title" index={0}>
          <p className="fin-subcard__eyebrow">{plan ? "Plano mensal" : "Serviço avulso"}</p>
          <h2 className="buy-offer__title" id="buy-offer-title">
            {offer.name}
          </h2>
          <Amount cents={offer.priceCents} size="xl" per={plan ? "mês" : undefined} />
          {offer.description && <p className="buy-offer__desc">{offer.description}</p>}
          {offer.items.length > 0 && (
            <ul className="buy-offer__items" aria-label="O que está incluído">
              {offer.items.map((item, index) => (
                <li key={`${item}-${index}`}>
                  <Check size={15} strokeWidth={1.6} aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="buy-side">
          <Panel eyebrow="Como funciona" title="Próximos passos" index={1}>
            <Steps offer={offer} contractAfterPayment={data.contractAfterPayment} />
          </Panel>

          {data.blocked ? (
            <Callout
              live
              tone="amber"
              icon={Info}
              title={data.blocked.code === "plan_pending" ? "Sua assinatura já está preparada" : "Você já tem um plano"}
              actions={
                <>
                  <Button size="sm" variant="secondary" icon={Wallet} to="/painel/financeiro">
                    Ver Financeiro
                  </Button>
                  <TalkToMetta />
                </>
              }
            >
              {data.blocked.message}
            </Callout>
          ) : !data.paymentsEnabled ? (
            <Callout live tone="amber" icon={Info} title="Pagamento online indisponível no momento" actions={<TalkToMetta />}>
              Fale com a Metta para contratar por outro caminho.
            </Callout>
          ) : (
            <Card as="form" padding="lg" className="buy-form" ref={formRef} onSubmit={submit} noValidate index={2}>
              {plan && (
                <Field
                  label="E-mail da conta do Mercado Pago"
                  required
                  error={errors.payerEmail}
                  hint="A cobrança mensal é autorizada no Mercado Pago com uma conta neste e-mail."
                >
                  <Input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    maxLength={254}
                    value={payerEmail}
                    onValueChange={setPayerEmail}
                  />
                </Field>
              )}
              {data.needsDocument && (
                <Field label="CNPJ ou CPF" required error={errors.document} hint="Vai no contrato. Pode digitar com ou sem pontuação.">
                  <Input inputMode="numeric" autoComplete="off" maxLength={40} value={taxId} onValueChange={setTaxId} />
                </Field>
              )}
              {failure && (
                <Callout
                  live
                  tone={failure.code === "integration_not_configured" ? "amber" : "red"}
                  icon={failure.code === "integration_not_configured" ? Info : CircleX}
                  title={failure.code === "integration_not_configured" ? "Pagamento online indisponível" : "Não foi possível abrir o pagamento"}
                  actions={
                    failure.code === "upstream_error" || failure.code === "network" ? (
                      <Button size="sm" icon={RefreshCw} type="submit">
                        Tentar de novo
                      </Button>
                    ) : (
                      <TalkToMetta />
                    )
                  }
                >
                  {failure.message}
                </Callout>
              )}
              <Button type="submit" variant="primary" icon={CreditCard} loading={busy} block>
                {plan ? "Autorizar no Mercado Pago" : "Pagar no Mercado Pago"}
              </Button>
              <p className="buy-form__secure">
                <Icon icon={Lock} size={12} /> Pagamento seguro no Mercado Pago. Você volta para cá ao terminar.
              </p>
            </Card>
          )}
        </div>
      </div>
    );

  return (
    <div className="fin-page buy-page">
      <PageHeader
        eyebrow="Contratar"
        title="Confira o seu"
        accent="pedido"
        description="O valor é o do catálogo da Metta. Primeiro vem o pagamento, no Mercado Pago; depois, o contrato para você assinar."
      />
      {content}
    </div>
  );
}

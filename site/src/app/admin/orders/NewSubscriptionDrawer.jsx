import { useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Button, Drawer, ErrorState, Field, Input, Select, Skeleton, formatMoney } from "../../ui/index.js";
import { api } from "../../api/client.js";
import { Amount, Callout, MoneyInput } from "../finance/common.jsx";
import { useInvalidFocus } from "../clients/crmShared.jsx";

const empty = (clientId) => ({ clientId: clientId ?? "", serviceId: "", amountCents: null, payerEmail: "" });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function NewSubscriptionDrawer({ open, options, defaultClientId, onClose, onCreated }) {
  const [form, setForm] = useState(() => empty(defaultClientId));
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formRef, focusInvalid] = useInvalidFocus();
  const data = options.data;

  const clients = useMemo(() => (data?.clients ?? []).filter((c) => c.status !== "archived"), [data]);
  const plans = useMemo(() => (data?.services ?? []).filter((s) => s.kind === "subscription"), [data]);
  const plan = plans.find((p) => p.id === form.serviceId);

  useEffect(() => {
    if (!open) return;
    const client = clients.find((c) => c.id === defaultClientId);
    setForm({ ...empty(client ? client.id : ""), payerEmail: client?.contactEmail ?? "" });
    setErrors({});
    setFailure(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  const chooseClient = (clientId) => {
    const previous = clients.find((c) => c.id === form.clientId);
    const next = clients.find((c) => c.id === clientId);
    setForm((current) => ({
      ...current,
      clientId,
      payerEmail:
        !current.payerEmail || current.payerEmail === previous?.contactEmail ? (next?.contactEmail ?? "") : current.payerEmail,
    }));
  };

  const choosePlan = (serviceId) => {
    const next = plans.find((p) => p.id === serviceId);
    setForm((current) => ({
      ...current,
      serviceId,
      amountCents: current.amountCents === null || current.amountCents === plan?.priceCents ? (next?.priceCents ?? null) : current.amountCents,
    }));
  };

  const submit = async (event) => {
    event.preventDefault();
    const local = {};
    if (!form.clientId) local.clientId = "Escolha o cliente.";
    if (!form.serviceId) local.serviceId = "Escolha o plano.";
    if (!(form.amountCents > 0)) local.amountCents = "Informe um valor mensal maior que zero.";
    if (!EMAIL.test(form.payerEmail.trim())) local.payerEmail = "Informe o e-mail da conta do Mercado Pago que vai pagar.";
    setErrors(local);
    if (Object.keys(local).length) return focusInvalid();
    setSaving(true);
    setFailure(null);
    try {
      const res = await api.post("/subscriptions", {
        clientId: form.clientId,
        serviceId: form.serviceId,
        amountCents: form.amountCents,
        payerEmail: form.payerEmail.trim(),
      });
      onCreated(res.subscription);
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
    <Drawer
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      eyebrow="Nova assinatura"
      title="Plano mensal"
      description="A assinatura fica aguardando ativação até o cliente autorizar a cobrança recorrente no Mercado Pago."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="fin-new-subscription" loading={saving} disabled={!data || !plans.length}>
            Criar assinatura
          </Button>
        </>
      }
    >
      {!data && options.loading && (
        <div className="fin-stack">
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      )}
      {!data && options.error && <ErrorState error={options.error} onRetry={options.reload} compact />}
      {data && (
        <form ref={formRef} id="fin-new-subscription" className="fin-form" onSubmit={submit} noValidate>
          {!plans.length && (
            <Callout tone="amber" icon={Info} title="Nenhum plano mensal ativo">
              Cadastre ou ative um plano de assinatura mensal em Planos e serviços.
            </Callout>
          )}
          <Field label="Cliente" required error={errors.clientId}>
            <Select
              value={form.clientId}
              placeholder="Escolha o cliente"
              options={clients.map((c) => ({ value: c.id, label: c.name }))}
              onValueChange={chooseClient}
              data-autofocus
            />
          </Field>
          <Field label="Plano" required error={errors.serviceId}>
            <Select
              value={form.serviceId}
              placeholder="Escolha o plano"
              options={plans.map((p) => ({ value: p.id, label: `${p.name} · ${formatMoney(p.priceCents)}/mês` }))}
              onValueChange={choosePlan}
            />
          </Field>
          {plan && plan.items?.length > 0 && (
            <ul className="fin-included ui-enter" aria-label={`Incluído em ${plan.name}`}>
              {plan.items.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
            </ul>
          )}
          <Field label="Valor mensal" required error={errors.amountCents} hint="Preenchido pelo plano; ajuste se houver condição combinada.">
            <MoneyInput value={form.amountCents} suffix="por mês" onValueChange={(amountCents) => update({ amountCents })} />
          </Field>
          <Field
            label="E-mail do pagador"
            required
            error={errors.payerEmail}
            hint="A conta do Mercado Pago que vai autorizar a cobrança mensal. Precisa ser exatamente este e-mail."
          >
            <Input type="email" autoComplete="off" value={form.payerEmail} onValueChange={(payerEmail) => update({ payerEmail })} />
          </Field>
          {plan && form.amountCents > 0 && (
            <div className="fin-preview ui-enter" aria-live="polite">
              <span className="fin-preview__label">Cobrança recorrente</span>
              <Amount cents={form.amountCents} size="md" per="mês" />
            </div>
          )}
          {failure && !failure.fields && (
            <Callout tone="red" live title="Não foi possível criar a assinatura">
              {failure.message}
            </Callout>
          )}
        </form>
      )}
    </Drawer>
  );
}

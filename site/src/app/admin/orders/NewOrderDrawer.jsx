import { useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Button, DateInput, Drawer, ErrorState, Field, Input, Select, Skeleton, formatMoney } from "../../ui/index.js";
import { api } from "../../api/client.js";
import { Callout, MoneyInput } from "../finance/common.jsx";
import { useInvalidFocus } from "../clients/crmShared.jsx";

const CUSTOM = "__custom";

const empty = (clientId) => ({
  clientId: clientId ?? "",
  brandId: "",
  serviceId: CUSTOM,
  description: "",
  amountCents: null,
  dueDate: "",
});

export default function NewOrderDrawer({ open, options, defaultClientId, onClose, onCreated }) {
  const [form, setForm] = useState(() => empty(defaultClientId));
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formRef, focusInvalid] = useInvalidFocus();
  const data = options.data;

  useEffect(() => {
    if (!open) return;
    const known = data?.clients?.some((c) => c.id === defaultClientId && c.status !== "archived");
    setForm(empty(known ? defaultClientId : ""));
    setErrors({});
    setFailure(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const clients = useMemo(() => (data?.clients ?? []).filter((c) => c.status !== "archived"), [data]);
  const client = clients.find((c) => c.id === form.clientId);
  const brands = (client?.brands ?? []).filter((b) => b.status !== "archived");
  const services = data?.services ?? [];
  const service = services.find((s) => s.id === form.serviceId);

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  const chooseService = (serviceId) => {
    const next = services.find((s) => s.id === serviceId);
    const previous = service;
    setForm((current) => ({
      ...current,
      serviceId,
      // Prefill from the catalog, keeping anything the person already typed by hand.
      description: next && (!current.description || current.description === previous?.name) ? next.name : current.description,
      amountCents:
        next && (current.amountCents === null || current.amountCents === previous?.priceCents) ? next.priceCents : current.amountCents,
    }));
  };

  const submit = async (event) => {
    event.preventDefault();
    const local = {};
    if (!form.clientId) local.clientId = "Escolha o cliente.";
    if (!form.description.trim()) local.description = "Descreva o que está sendo cobrado.";
    if (!(form.amountCents > 0)) local.amountCents = "Informe um valor maior que zero.";
    setErrors(local);
    if (Object.keys(local).length) return focusInvalid();
    setSaving(true);
    setFailure(null);
    try {
      const res = await api.post("/orders", {
        clientId: form.clientId,
        brandId: form.brandId || null,
        serviceId: form.serviceId === CUSTOM ? null : form.serviceId,
        description: form.description.trim(),
        amountCents: form.amountCents,
        dueDate: form.dueDate || null,
      });
      onCreated(res.order);
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

  const oneOff = services.filter((s) => s.kind === "one_off");
  const monthly = services.filter((s) => s.kind === "subscription");

  return (
    <Drawer
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      eyebrow="Novo pedido"
      title="Cobrança avulsa"
      description="O pedido nasce como rascunho. O cliente só vê a cobrança depois que o link de pagamento é gerado."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="fin-new-order" loading={saving} disabled={!data}>
            Criar pedido
          </Button>
        </>
      }
    >
      {!data && options.loading && (
        <div className="fin-stack">
          <Skeleton height={40} />
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      )}
      {!data && options.error && <ErrorState error={options.error} onRetry={options.reload} compact />}
      {data && (
        <form ref={formRef} id="fin-new-order" className="fin-form" onSubmit={submit} noValidate>
          {!clients.length && (
            <Callout tone="amber" icon={Info} title="Nenhum cliente disponível">
              Cadastre um cliente em Clientes e marcas antes de criar pedidos.
            </Callout>
          )}
          <Field label="Cliente" required error={errors.clientId}>
            <Select
              value={form.clientId}
              placeholder="Escolha o cliente"
              options={clients.map((c) => ({ value: c.id, label: c.name }))}
              onValueChange={(clientId) => update({ clientId, brandId: "" })}
              data-autofocus
            />
          </Field>
          <Field label="Marca" optional error={errors.brandId} hint={client && !brands.length ? "Este cliente ainda não tem marcas ativas." : undefined}>
            <Select
              value={form.brandId}
              placeholder={client ? "Sem marca específica" : "Escolha o cliente primeiro"}
              disabled={!client}
              options={brands.map((b) => ({ value: b.id, label: b.name }))}
              onValueChange={(brandId) => update({ brandId })}
            />
          </Field>
          <Field label="Serviço" error={errors.serviceId} hint="Escolha do catálogo para preencher descrição e valor, ou cobre um valor personalizado.">
            <Select value={form.serviceId} onValueChange={chooseService}>
              <option value={CUSTOM}>Personalizado (descrição e valor livres)</option>
              {oneOff.length > 0 && (
                <optgroup label="Serviços avulsos">
                  {oneOff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {formatMoney(s.priceCents)}
                    </option>
                  ))}
                </optgroup>
              )}
              {monthly.length > 0 && (
                <optgroup label="Planos mensais (cobrança única)">
                  {monthly.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {formatMoney(s.priceCents)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="Descrição" required error={errors.description} hint="Aparece para o cliente e no Mercado Pago.">
            <Input value={form.description} maxLength={250} onValueChange={(description) => update({ description })} placeholder="Ex.: Identidade visual completa" />
          </Field>
          <div className="fin-form__row">
            <Field label="Valor" required error={errors.amountCents}>
              <MoneyInput value={form.amountCents} onValueChange={(amountCents) => update({ amountCents })} />
            </Field>
            <Field label="Vencimento" optional error={errors.dueDate}>
              <DateInput value={form.dueDate} onValueChange={(dueDate) => update({ dueDate })} />
            </Field>
          </div>
          {failure && !failure.fields && (
            <Callout tone="red" live title="Não foi possível criar o pedido">
              {failure.message}
            </Callout>
          )}
        </form>
      )}
    </Drawer>
  );
}

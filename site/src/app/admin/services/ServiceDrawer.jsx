import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button, Drawer, Field, IconButton, Input, Segmented, Select, Switch, Textarea } from "../../ui/index.js";
import { api } from "../../api/client.js";
import { siteOffers } from "../../../data/brand.js";
import { Callout, MoneyInput } from "../finance/common.jsx";
import { useInvalidFocus } from "../clients/crmShared.jsx";

const KINDS = [
  { value: "subscription", label: "Assinatura mensal" },
  { value: "one_off", label: "Avulso" },
];

const blank = {
  name: "",
  kind: "subscription",
  priceCents: null,
  description: "",
  items: [""],
  includesEditables: false,
  active: true,
  slug: "",
};

function fromService(service) {
  if (!service) return { ...blank, items: [""] };
  return {
    name: service.name,
    kind: service.kind,
    priceCents: service.priceCents,
    description: service.description ?? "",
    items: service.items?.length ? [...service.items] : [""],
    includesEditables: service.includesEditables,
    active: service.active,
    slug: service.slug ?? "",
  };
}

// "Comprar" buttons of the site (/planos) that this kind of service can answer.
const offerLabel = (offer) => (offer.kind === "subscription" ? `Plano ${offer.name}` : offer.name);
const offersFor = (kind) => siteOffers.filter((offer) => offer.kind === kind);

// Included items: one row per line, reorderable without drag (keyboard and touch).
function ItemsEditor({ items, onChange, errors }) {
  const refs = useRef([]);
  const focusNext = useRef(null);
  useEffect(() => {
    if (focusNext.current !== null) {
      refs.current[focusNext.current]?.focus();
      focusNext.current = null;
    }
  });
  const set = (index, value) => onChange(items.map((item, i) => (i === index ? value : item)));
  const add = (at = items.length) => {
    const next = [...items];
    next.splice(at, 0, "");
    focusNext.current = at;
    onChange(next);
  };
  const remove = (index) => {
    const next = items.filter((_, i) => i !== index);
    focusNext.current = Math.max(0, index - 1);
    onChange(next.length ? next : [""]);
  };
  const move = (index, delta) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    focusNext.current = index + delta;
    onChange(next);
  };
  return (
    <div className="fin-items">
      <ol className="fin-items__list">
        {items.map((item, index) => (
          <li key={index} className="fin-items__row">
            <span className="fin-items__num" aria-hidden="true">
              {index + 1}
            </span>
            <Input
              ref={(node) => {
                refs.current[index] = node;
              }}
              value={item}
              aria-label={`Item ${index + 1}`}
              invalid={Boolean(errors?.[`items.${index}`])}
              placeholder={index === 0 ? "Ex.: 12 posts por mês" : "Outro item incluído"}
              maxLength={160}
              onValueChange={(value) => set(index, value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add(index + 1);
                } else if (event.key === "Backspace" && !item && items.length > 1) {
                  event.preventDefault();
                  remove(index);
                }
              }}
            />
            <div className="fin-items__tools">
              <IconButton size="sm" variant="ghost" icon={ArrowUp} label="Mover para cima" disabled={index === 0} onClick={() => move(index, -1)} tooltip={false} />
              <IconButton size="sm" variant="ghost" icon={ArrowDown} label="Mover para baixo" disabled={index === items.length - 1} onClick={() => move(index, 1)} tooltip={false} />
              <IconButton size="sm" variant="ghost" icon={X} label={`Remover item ${index + 1}`} onClick={() => remove(index)} tooltip={false} />
            </div>
          </li>
        ))}
      </ol>
      <Button size="sm" variant="ghost" icon={Plus} onClick={() => add()} disabled={items.length >= 30}>
        Adicionar item
      </Button>
    </div>
  );
}

export default function ServiceDrawer({ open, service, onClose, onSaved }) {
  const [form, setForm] = useState(() => fromService(service));
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formRef, focusInvalid] = useInvalidFocus();
  const editing = Boolean(service);
  const used = Boolean(service?.usage && (service.usage.orders || service.usage.subscriptions));

  useEffect(() => {
    if (open) {
      setForm(fromService(service));
      setErrors({});
      setFailure(null);
    }
  }, [open, service]);

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  const submit = async (event) => {
    event?.preventDefault();
    const local = {};
    if (!form.name.trim()) local.name = "Dê um nome ao serviço.";
    if (form.priceCents === null || form.priceCents === undefined) local.priceCents = "Informe o preço.";
    else if (form.kind === "subscription" && form.priceCents <= 0) local.priceCents = "Assinaturas precisam de um valor mensal maior que zero.";
    setErrors(local);
    if (Object.keys(local).length) return focusInvalid();
    setSaving(true);
    setFailure(null);
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      priceCents: form.priceCents,
      description: form.description.trim() || null,
      items: form.items.map((item) => item.trim()).filter(Boolean),
      includesEditables: form.includesEditables,
      active: form.active,
      slug: form.slug || null,
    };
    try {
      const res = editing ? await api.patch(`/services/${service.id}`, body) : await api.post("/services", body);
      onSaved(res.service, !editing);
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
      eyebrow={editing ? "Editar serviço" : "Novo serviço"}
      title={editing ? service.name : "Plano ou serviço avulso"}
      description="Preços em reais. Mudanças de preço valem para novos pedidos e assinaturas; o que já foi criado mantém o valor original."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="fin-service-form" loading={saving}>
            {editing ? "Salvar alterações" : "Criar serviço"}
          </Button>
        </>
      }
    >
      <form ref={formRef} id="fin-service-form" className="fin-form" onSubmit={submit} noValidate>
        <Field label="Nome" required error={errors.name}>
          <Input value={form.name} maxLength={120} onValueChange={(name) => update({ name })} data-autofocus placeholder="Ex.: Gestão de redes" />
        </Field>

        <div className="ui-field">
          <div className="ui-field__top">
            <span className="ui-field__label" id="fin-kind-label">
              Tipo de cobrança
            </span>
          </div>
          <Segmented
            aria-label="Tipo de cobrança"
            options={KINDS.map((k) => ({ ...k, disabled: used && k.value !== form.kind }))}
            value={form.kind}
            onChange={(kind) => update({ kind, slug: offersFor(kind).some((offer) => offer.slug === form.slug) ? form.slug : "" })}
          />
          {used ? (
            <p className="ui-field__hint">O tipo não muda depois que o serviço foi usado em pedidos ou assinaturas.</p>
          ) : (
            <p className="ui-field__hint">
              {form.kind === "subscription"
                ? "Cobrado todo mês por assinatura no Mercado Pago."
                : "Cobrado uma vez, por pedido com link de pagamento."}
            </p>
          )}
          {errors.kind && <p className="ui-field__error">{errors.kind}</p>}
        </div>

        <Field label={form.kind === "subscription" ? "Valor mensal" : "Preço"} required error={errors.priceCents}>
          <MoneyInput value={form.priceCents} onValueChange={(priceCents) => update({ priceCents })} suffix={form.kind === "subscription" ? "por mês" : undefined} />
        </Field>

        <Field
          label="Botão de compra no site"
          optional
          error={errors.slug}
          hint={
            form.slug
              ? "Quem clica em “Comprar” desse item em /planos compra este serviço, pelo preço daqui, e paga no Mercado Pago. O contrato vai depois do pagamento."
              : "Ligue a um botão “Comprar” de /planos para vender este serviço pelo site."
          }
        >
          <Select
            value={form.slug}
            onValueChange={(slug) => update({ slug })}
            options={[{ value: "", label: "Nenhum" }, ...offersFor(form.kind).map((offer) => ({ value: offer.slug, label: offerLabel(offer) }))]}
          />
        </Field>

        <Field
          label="Descrição"
          optional
          error={errors.description}
          hint="Aparece para a equipe ao criar pedidos e assinaturas e, com o botão do site ligado, na página de compra do cliente."
        >
          <Textarea value={form.description} rows={3} maxLength={1000} autoGrow onValueChange={(description) => update({ description })} />
        </Field>

        <div className="ui-field">
          <div className="ui-field__top">
            <span className="ui-field__label">Itens incluídos</span>
            <span className="ui-field__opt">opcional</span>
          </div>
          <ItemsEditor items={form.items} errors={errors} onChange={(items) => update({ items })} />
          {errors.items && <p className="ui-field__error">{errors.items}</p>}
        </div>

        <div className="fin-form__switches">
          <Switch
            label="Inclui arquivos editáveis"
            description="A entrega deste serviço contempla os arquivos abertos."
            checked={form.includesEditables}
            onCheckedChange={(includesEditables) => update({ includesEditables })}
          />
          <Switch
            label="Ativo"
            description="Serviços inativos continuam no histórico, mas não aparecem em novos pedidos e assinaturas."
            checked={form.active}
            onCheckedChange={(active) => update({ active })}
          />
        </div>

        {failure && !failure.fields && (
          <Callout tone="red" live title="Não foi possível salvar">
            {failure.message}
          </Callout>
        )}
      </form>
    </Drawer>
  );
}

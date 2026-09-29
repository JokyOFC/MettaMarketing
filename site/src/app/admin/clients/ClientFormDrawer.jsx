import { useEffect, useId, useRef, useState } from "react";
import { Building2, Mail, Phone, UserPlus } from "lucide-react";
import { api } from "../../api/client.js";
import { useAuth } from "../../auth/index.js";
import {
  Button,
  Checkbox,
  Drawer,
  Field,
  Input,
  Switch,
  Textarea,
  useApi,
  useToast,
} from "../../ui/index.js";
import { InternalBadge, PersonCell, clean, maskDocument, maskPhone, useForm } from "./crmShared.jsx";
import "./crm.css";

const EMPTY = {
  name: "",
  legalName: "",
  document: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  internalNotes: "",
  brandName: "",
  brandDescription: "",
  inviteUser: false,
  userName: "",
  userEmail: "",
  managerIds: [],
};

const fromClient = (client) => ({
  ...EMPTY,
  name: client.name ?? "",
  legalName: client.legalName ?? "",
  document: client.document ?? "",
  contactName: client.contactName ?? "",
  contactEmail: client.contactEmail ?? "",
  contactPhone: client.contactPhone ?? "",
  internalNotes: client.internalNotes ?? "",
});

// Creates a client (admin) with its first brand, managers and an optional
// invitation, or edits an existing client (sensitive fields for admins only).
export default function ClientFormDrawer({ open, onClose, client = null, canEditSensitive = true, onCreated, onSaved }) {
  const editing = Boolean(client);
  const toast = useToast();
  const { can } = useAuth();
  const formId = useId();
  const form = useForm(EMPTY);
  const { values, set, bind, fieldError } = form;
  const [saving, setSaving] = useState(false);
  const brandTouched = useRef(false);
  const showManagers = !editing && can("team.view");
  const managers = useApi(open && showManagers ? "/team/users" : null, { params: { role: "manager" } });

  useEffect(() => {
    if (!open) return;
    brandTouched.current = false;
    form.reset(client ? fromClient(client) : EMPTY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client?.id]);

  const onName = (value) => {
    set("name", value);
    if (!editing && !brandTouched.current) set("brandName", value);
  };

  const submit = async (event) => {
    event.preventDefault();
    const base = {
      name: values.name.trim(),
      legalName: clean(values.legalName),
      document: clean(values.document),
      contactName: clean(values.contactName),
      contactEmail: clean(values.contactEmail),
      contactPhone: clean(values.contactPhone),
      internalNotes: clean(values.internalNotes),
    };
    const local = {};
    if (!base.name) local.name = "Informe o nome do cliente.";
    if (!editing && !values.brandName.trim()) local["brand.name"] = "Dê um nome à primeira marca.";
    if (!editing && values.inviteUser) {
      if (!values.userName.trim()) local["user.name"] = "Informe o nome da pessoa.";
      if (!values.userEmail.trim()) local["user.email"] = "Informe o e-mail da pessoa.";
    }
    if (Object.keys(local).length) {
      form.setErrors(local);
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const body = {};
        const original = fromClient(client);
        for (const key of Object.keys(base)) {
          if (!canEditSensitive && ["name", "legalName", "document"].includes(key)) continue;
          if ((clean(original[key]) ?? null) !== (base[key] ?? null)) body[key] = base[key];
        }
        if (!Object.keys(body).length) {
          onClose?.();
          return;
        }
        const res = await api.patch(`/clients/${client.id}`, body);
        toast.success("Dados do cliente salvos.");
        onSaved?.(res.client);
        onClose?.();
      } else {
        const res = await api.post("/clients", {
          ...base,
          brand: { name: values.brandName.trim(), description: clean(values.brandDescription) },
          managerIds: values.managerIds,
          user: values.inviteUser ? { name: values.userName.trim(), email: values.userEmail.trim() } : undefined,
        });
        toast.success(`Cliente ${res.client.name} criado com a marca ${res.brand?.name ?? ""}.`);
        onCreated?.(res);
      }
    } catch (error) {
      if (!form.fail(error)) toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  const managerRows = (managers.data?.items ?? []).filter((m) => m.status !== "disabled");
  const toggleManager = (id, on) =>
    set("managerIds", on ? [...values.managerIds, id] : values.managerIds.filter((item) => item !== id));
  const locked = editing && !canEditSensitive;

  return (
    <Drawer
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      size="md"
      eyebrow={editing ? "Cliente" : "Novo cliente"}
      title={editing ? `Editar ${client.name}` : "Cadastrar cliente e marca"}
      description={
        editing
          ? locked
            ? "Você pode atualizar contatos e notas internas. Nome, razão social e CNPJ ficam com a administração."
            : "Atualize os dados de cadastro e contato."
          : "O cliente começa com a primeira marca. Outras marcas podem ser criadas depois, cada uma com arquivos e projetos separados."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {editing ? "Salvar alterações" : "Criar cliente"}
          </Button>
        </>
      }
    >
      <form ref={form.ref} id={formId} className="crm-form" onSubmit={submit} noValidate>
        <fieldset className="crm-form__section">
          <legend className="crm-form__legend">
            <span className="crm-form__index">01</span> Dados do cliente
          </legend>
          <Field label="Nome do cliente" required error={fieldError("name")} hint={locked ? "Somente administradores alteram." : undefined}>
            <Input {...bind("name")} onValueChange={onName} autoComplete="organization" data-autofocus disabled={locked} icon={Building2} />
          </Field>
          <div className="crm-form__row">
            <Field label="Razão social" optional error={fieldError("legalName")}>
              <Input {...bind("legalName")} disabled={locked} />
            </Field>
            <Field label="CNPJ" optional error={fieldError("document")} hint={!locked ? "Para pessoa física, informe o CPF." : undefined}>
              <Input
                value={values.document}
                onValueChange={(value) => set("document", maskDocument(value))}
                onBlur={() => set("document", maskDocument(values.document, { final: true }))}
                inputMode="numeric"
                placeholder="00.000.000/0000-00"
                disabled={locked}
              />
            </Field>
          </div>
          <div className="crm-form__row">
            <Field label="Pessoa de contato" optional error={fieldError("contactName")}>
              <Input {...bind("contactName")} autoComplete="name" />
            </Field>
            <Field label="Telefone" optional error={fieldError("contactPhone")}>
              <Input
                value={values.contactPhone}
                onValueChange={(value) => set("contactPhone", maskPhone(value))}
                inputMode="tel"
                autoComplete="tel"
                placeholder="(11) 90000-0000"
                icon={Phone}
              />
            </Field>
          </div>
          <Field label="E-mail de contato" optional error={fieldError("contactEmail")}>
            <Input {...bind("contactEmail")} type="email" autoComplete="email" icon={Mail} />
          </Field>
        </fieldset>

        {!editing && (
          <fieldset className="crm-form__section">
            <legend className="crm-form__legend">
              <span className="crm-form__index">02</span> Primeira marca
            </legend>
            <Field label="Nome da marca" required error={fieldError("brand.name")} hint="Preenchido com o nome do cliente; ajuste se a marca tiver outro nome.">
              <Input
                {...bind("brandName")}
                onValueChange={(value) => {
                  brandTouched.current = true;
                  set("brandName", value);
                }}
              />
            </Field>
            <Field label="Descrição" optional error={fieldError("brand.description")}>
              <Textarea {...bind("brandDescription")} rows={2} autoGrow placeholder="Segmento, público ou observações visíveis à equipe." />
            </Field>
          </fieldset>
        )}

        {showManagers && (
          <fieldset className="crm-form__section">
            <legend className="crm-form__legend">
              <span className="crm-form__index">03</span> Gestores com acesso
            </legend>
            <p className="crm-form__note">Gestores só veem os clientes liberados para eles. Administradores veem todos.</p>
            {managers.loading ? (
              <p className="crm-form__note">Carregando gestores…</p>
            ) : managerRows.length ? (
              <div className="crm-checklist">
                {managerRows.map((manager) => (
                  <Checkbox
                    key={manager.id}
                    checked={values.managerIds.includes(manager.id)}
                    onCheckedChange={(on) => toggleManager(manager.id, on)}
                    label={<PersonCell name={manager.name} email={manager.email} size={28} />}
                  />
                ))}
              </div>
            ) : (
              <p className="crm-form__note">Nenhum gestor cadastrado ainda. Convide a equipe em Equipe e permissões.</p>
            )}
          </fieldset>
        )}

        {!editing && (
          <fieldset className="crm-form__section">
            <legend className="crm-form__legend">
              <span className="crm-form__index">{showManagers ? "04" : "03"}</span> Acesso do cliente
            </legend>
            <Switch
              checked={values.inviteUser}
              onCheckedChange={(on) => set("inviteUser", on)}
              label="Convidar alguém do cliente agora"
              description="A pessoa recebe um link para definir a senha e acessar somente as marcas deste cliente."
            />
            {values.inviteUser && (
              <div className="crm-form__row crm-reveal">
                <Field label="Nome" required error={fieldError("user.name")}>
                  <Input {...bind("userName")} icon={UserPlus} autoComplete="off" />
                </Field>
                <Field label="E-mail" required error={fieldError("user.email")}>
                  <Input {...bind("userEmail")} type="email" autoComplete="off" icon={Mail} />
                </Field>
              </div>
            )}
          </fieldset>
        )}

        <fieldset className="crm-form__section">
          <legend className="crm-form__legend crm-form__legend--aside">
            <span>
              <span className="crm-form__index">{editing ? "02" : showManagers ? "05" : "04"}</span> Notas internas
            </span>
            <InternalBadge />
          </legend>
          <Field label="Notas" optional error={fieldError("internalNotes")} hint="Nunca aparecem para o cliente.">
            <Textarea {...bind("internalNotes")} rows={3} autoGrow />
          </Field>
        </fieldset>
      </form>
    </Drawer>
  );
}

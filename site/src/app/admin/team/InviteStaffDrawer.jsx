import { useEffect, useId, useState } from "react";
import { Mail, UserPlus } from "lucide-react";
import { api } from "../../api/client.js";
import { Button, Drawer, Field, Input, useToast } from "../../ui/index.js";
import { InviteResult, clean, cx, useForm } from "../clients/crmShared.jsx";
import ClientChecklist from "./ClientChecklist.jsx";
import { ROLE_SCOPES } from "./PermissionMatrix.jsx";
import "../clients/crm.css";

const STAFF_ROLES = ["manager", "designer", "finance", "admin"];
const EMPTY = { name: "", email: "", role: "designer", jobTitle: "", clientIds: [] };

export function RoleChoice({ value, onChange, name, disabledRole }) {
  return (
    <div className="crm-rolechoice" role="radiogroup" aria-label="Papel na equipe">
      {STAFF_ROLES.map((role) => (
        <label key={role} className={cx("crm-rolecard", value === role && "is-on", disabledRole === role && "is-disabled")}>
          <input
            type="radio"
            name={name}
            value={role}
            checked={value === role}
            disabled={disabledRole === role}
            onChange={() => onChange(role)}
          />
          <span className="crm-rolecard__title">{ROLE_SCOPES[role].title}</span>
          <span className="crm-rolecard__text">{ROLE_SCOPES[role].text}</span>
        </label>
      ))}
    </div>
  );
}

// Invites a staff member; managers can get client access right away.
export default function InviteStaffDrawer({ open, onClose, onInvited }) {
  const toast = useToast();
  const formId = useId();
  const form = useForm(EMPTY);
  const { values, set, bind, fieldError } = form;
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    form.reset(EMPTY);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    const local = {};
    if (!values.name.trim()) local.name = "Informe o nome.";
    if (!values.email.trim()) local.email = "Informe o e-mail.";
    if (Object.keys(local).length) return form.setErrors(local);
    setSaving(true);
    try {
      const res = await api.post("/team/users", {
        name: values.name.trim(),
        email: values.email.trim(),
        role: values.role,
        jobTitle: clean(values.jobTitle),
        clientIds: values.role === "manager" ? values.clientIds : undefined,
      });
      setResult({ ...res, name: res.user.name, email: res.user.email });
      onInvited?.(res.user);
      if (!res.inviteUrl) toast.success(`Convite enviado para ${res.user.email}.`);
    } catch (error) {
      if (!form.fail(error)) toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      size="md"
      eyebrow="Equipe"
      title={result ? "Convite criado" : "Convidar pessoa para a equipe"}
      description={result ? undefined : "A pessoa recebe um link para definir a senha. O papel define o que ela pode fazer; o acesso a clientes, o que ela pode ver."}
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={() => { form.reset(EMPTY); setResult(null); }} icon={UserPlus}>
              Convidar outra pessoa
            </Button>
            <Button variant="primary" onClick={onClose}>
              Concluir
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button variant="primary" type="submit" form={formId} loading={saving}>
              Enviar convite
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="crm-form">
          <InviteResult result={result} name={result.name} email={result.email} />
          <p className="crm-form__note">
            {ROLE_SCOPES[result.user.role].title}
            {result.user.role === "manager" && ` · ${result.user.access.clients.length} ${result.user.access.clients.length === 1 ? "cliente liberado" : "clientes liberados"}`}
          </p>
        </div>
      ) : (
        <form ref={form.ref} id={formId} className="crm-form" onSubmit={submit} noValidate>
          <div className="crm-form__row">
            <Field label="Nome" required error={fieldError("name")}>
              <Input {...bind("name")} autoComplete="off" data-autofocus />
            </Field>
            <Field label="Cargo" optional error={fieldError("jobTitle")}>
              <Input {...bind("jobTitle")} placeholder="Ex.: Designer sênior" />
            </Field>
          </div>
          <Field label="E-mail" required error={fieldError("email")}>
            <Input {...bind("email")} type="email" autoComplete="off" icon={Mail} />
          </Field>
          <fieldset className="crm-form__section">
            <legend className="crm-form__legend">Papel</legend>
            <RoleChoice value={values.role} onChange={(role) => set("role", role)} name={`${formId}-role`} />
            {fieldError("role") && <p className="ui-field__error">{fieldError("role")}</p>}
          </fieldset>
          {values.role === "manager" && (
            <fieldset className="crm-form__section crm-reveal">
              <legend className="crm-form__legend">Clientes que ela vai gerenciar</legend>
              <ClientChecklist value={values.clientIds} onChange={(ids) => set("clientIds", ids)} />
              {fieldError("clientIds") && <p className="ui-field__error">{fieldError("clientIds")}</p>}
            </fieldset>
          )}
          {values.role === "designer" && (
            <p className="crm-form__note crm-reveal">Designers acessam somente os projetos em que forem colocados. Atribua projetos depois do convite.</p>
          )}
        </form>
      )}
    </Drawer>
  );
}

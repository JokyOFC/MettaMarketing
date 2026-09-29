import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../../api/client.js";
import { Button, ErrorState, Field, Input, Panel, SkeletonRows, Switch, useApi, useToast } from "../../ui/index.js";
import { useInvalidFocus } from "../clients/crmShared.jsx";

const toForm = (settings) => ({
  orgName: settings.orgName ?? "",
  supportEmail: settings.supportEmail ?? "",
  zipRetentionHours: String(settings.zipRetentionHours ?? 24),
  defaultNotifyEmail: Boolean(settings.defaultNotifyEmail),
  signupEnabled: settings.signupEnabled !== false,
});

export default function OrganizationTab() {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi("/settings");
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [formRef, focusInvalid] = useInvalidFocus();

  useEffect(() => {
    if (data?.settings) setForm(toForm(data.settings));
  }, [data]);

  if (loading || (data && !form)) return <SkeletonRows rows={4} columns={2} label="Carregando configurações" />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;

  const baseline = toForm(data.settings);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const set = (key) => (value) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event) => {
    event.preventDefault();
    const hours = Number(form.zipRetentionHours);
    const local = {};
    if (!form.orgName.trim()) local.orgName = "Informe o nome da organização.";
    if (!/^\S+@\S+\.\S+$/.test(form.supportEmail.trim())) local.supportEmail = "Informe um e-mail válido.";
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) local.zipRetentionHours = "Use um número inteiro entre 1 e 720 horas.";
    setErrors(local);
    if (Object.keys(local).length) return focusInvalid();
    setSaving(true);
    try {
      const res = await api.patch("/settings", {
        orgName: form.orgName.trim(),
        supportEmail: form.supportEmail.trim(),
        zipRetentionHours: hours,
        defaultNotifyEmail: form.defaultNotifyEmail,
        signupEnabled: form.signupEnabled,
      });
      setData(res);
      toast.success("Configurações salvas.");
    } catch (err) {
      if (err.fields) {
        setErrors(err.fields);
        focusInvalid(err.message);
      } else toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="hub-org">
      <Panel eyebrow="Organização" title="Dados da Metta" description="Aparecem nos e-mails e nas orientações de suporte." index={0}>
        <div className="hub-stack">
          <div className="hub-two">
            <Field label="Nome da organização" required error={errors.orgName}>
              <Input value={form.orgName} maxLength={120} onValueChange={set("orgName")} />
            </Field>
            <Field label="E-mail de suporte" required error={errors.supportEmail} hint="Para onde clientes e equipe devem escrever.">
              <Input type="email" inputMode="email" autoComplete="email" value={form.supportEmail} maxLength={254} onValueChange={set("supportEmail")} />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel eyebrow="Downloads" title="Pacotes ZIP" index={1}>
        <Field
          label="Tempo de disponibilidade"
          required
          error={errors.zipRetentionHours}
          hint="Por quanto tempo um ZIP gerado continua disponível para baixar antes de ser apagado. Gerar de novo é sempre possível."
          className="hub-org__hours"
        >
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={720}
            step={1}
            value={form.zipRetentionHours}
            suffix="horas"
            onValueChange={set("zipRetentionHours")}
          />
        </Field>
      </Panel>

      <Panel eyebrow="Avisos" title="Padrão para novos usuários" index={2}>
        <Switch
          label="Avisos por e-mail ativados"
          description="Novas pessoas convidadas começam recebendo avisos por e-mail. Cada pessoa pode mudar isso em Conta."
          checked={form.defaultNotifyEmail}
          onCheckedChange={set("defaultNotifyEmail")}
        />
      </Panel>

      <Panel eyebrow="Acesso" title="Cadastro pelo site" index={3}>
        <Switch
          label="Cadastro aberto"
          description="Qualquer pessoa pode criar a conta da empresa em /cadastro. O acesso só é ativado depois que ela confirma o e-mail (é preciso o SMTP configurado em Integrações), e cada novo cadastro chega às notificações dos administradores. Desligado, a página explica que o acesso é por convite."
          checked={form.signupEnabled}
          onCheckedChange={set("signupEnabled")}
        />
      </Panel>

      <div className="hub-form-actions">
        <Button variant="ghost" disabled={!dirty || saving} onClick={() => setForm(baseline)}>
          Descartar
        </Button>
        <Button variant="primary" type="submit" icon={Check} loading={saving} disabled={!dirty}>
          Salvar configurações
        </Button>
      </div>
    </form>
  );
}

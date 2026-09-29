// Configurações › Contratos: AssinaVelox integration status (API, webhooks,
// embedded signing), the rules for contracts (who signs for Metta, forum,
// deadline, payment only after signature) and the versioned templates.
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, Eye, FileSignature, Link2, PlugZap, RefreshCw, Save, ShieldCheck, Unplug } from "lucide-react";
import { api } from "../../api/client.js";
import {
  Badge,
  Button,
  CopyButton,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Switch,
  Tabs,
  Textarea,
  formatDateTime,
  useApi,
  useToast,
} from "../../ui/index.js";
import "../../shared/contracts/contracts.css";

const Env = ({ children }) => <code className="hub-env">{children}</code>;

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g;

function unknownVariables(text, known) {
  const set = new Set();
  for (const match of String(text).matchAll(PLACEHOLDER)) if (!known.has(match[1])) set.add(match[1]);
  return [...set];
}

function IntegrationCard({ integration, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const run = async (kind, fn) => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  const test = () =>
    run("test", async () => {
      const res = await api.post("/contracts/integration/test");
      toast.success({ title: "Conexão com a AssinaVelox confirmada", message: `Resposta em ${res.ms} ms.` });
    });
  const connect = () =>
    run("connect", async () => {
      await api.post("/contracts/integration/webhook");
      toast.success("Notificações da AssinaVelox conectadas");
      onChanged();
    });
  const disconnect = () =>
    run("disconnect", async () => {
      await api.del("/contracts/integration/webhook");
      toast.info("Notificações desconectadas. A consulta periódica continua atualizando os contratos.");
      onChanged();
    });
  const { webhook } = integration;
  return (
    <article className="hub-int ui-enter" style={{ "--i": 0 }} aria-labelledby="ct-int-title">
      <header className="hub-int__head">
        <span className="hub-int__icon" aria-hidden="true">
          <FileSignature size={19} strokeWidth={1.4} />
        </span>
        <h3 id="ct-int-title" className="hub-int__title">
          AssinaVelox
        </h3>
        {integration.configured ? (
          <Badge tone="olive" dot>
            Configurada
          </Badge>
        ) : (
          <Badge tone="amber" dot>
            Não configurada
          </Badge>
        )}
      </header>
      <dl className="hub-facts hub-facts--compact">
        <div>
          <dt>API</dt>
          <dd>{integration.apiHost ?? "—"}</dd>
        </div>
        <div>
          <dt>Notificações</dt>
          <dd>
            {webhook.subscription
              ? `Conectadas desde ${formatDateTime(webhook.subscription.createdAt)}`
              : webhook.envSecret
                ? "Segredo definido no servidor"
                : "Não conectadas"}
          </dd>
        </div>
        <div>
          <dt>Consulta periódica</dt>
          <dd>{integration.syncMinutes ? `A cada ${integration.syncMinutes} min` : "Desligada"}</dd>
        </div>
        <div>
          <dt>Assinatura na plataforma</dt>
          <dd>{integration.appOrigin}</dd>
        </div>
      </dl>
      <div className="hub-int__guide">
        {integration.configured ? (
          <>
            <p>
              Os contratos são gerados pela Metta, enviados pela API da AssinaVelox e acompanhados pelas notificações (webhooks)
              e por uma consulta periódica, que cobre notificações perdidas.
            </p>
            <p>
              Para assinar sem sair da plataforma, cadastre <Env>{integration.appOrigin}</Env> em{" "}
              <strong>API e integrações › Widget de assinatura</strong> na AssinaVelox.
            </p>
            {!webhook.publicUrl && (
              <p>
                As notificações exigem um endereço HTTPS público em <Env>APP_URL</Env>. Neste ambiente os contratos são
                atualizados pela consulta periódica e pelo botão “Atualizar status”.
              </p>
            )}
          </>
        ) : (
          <>
            <p>
              Defina <Env>ASSINAVELOX_API_URL</Env> (termina em <Env>/api/v1</Env>) e <Env>ASSINAVELOX_TOKEN</Env> no ambiente
              do servidor e reinicie a aplicação. Enquanto isso, pedidos e planos seguem sem contrato.
            </p>
            <p>Na AssinaVelox, crie a chave em API e integrações › Chaves com estas permissões:</p>
          </>
        )}
        <ul className="ct-list ct-list--inline">
          {integration.requiredAbilities.map((ability) => (
            <li key={ability}>
              <Env>{ability}</Env>
            </li>
          ))}
        </ul>
        <p>
          Endereço das notificações: <Env>{webhook.url}</Env>{" "}
          <CopyButton text={webhook.url} label="Copiar endereço" iconOnly />
        </p>
      </div>
      {integration.configured && (
        <div className="hub-int__actions">
          <Button size="sm" icon={PlugZap} loading={busy === "test"} onClick={test}>
            Testar conexão
          </Button>
          {webhook.subscription ? (
            <Button size="sm" variant="ghost" icon={Unplug} loading={busy === "disconnect"} onClick={disconnect}>
              Desconectar notificações
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={Link2} loading={busy === "connect"} onClick={connect} disabled={!webhook.publicUrl}>
              Conectar notificações
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function RulesForm({ settings, issues, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(settings);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(settings), [settings]);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const res = await api.patch("/contracts/settings", {
        signerName: form.signerName?.trim() || undefined,
        signerEmail: form.signerEmail?.trim() || undefined,
        signerRole: form.signerRole?.trim() || undefined,
        companyName: form.companyName?.trim() || undefined,
        companyDocument: form.companyDocument?.trim() || undefined,
        forum: form.forum?.trim() || undefined,
        noticeDays: Number(form.noticeDays),
        expiresInDays: Number(form.expiresInDays),
        requiredBeforePayment: Boolean(form.requiredBeforePayment),
      });
      toast.success("Regras dos contratos salvas");
      onSaved(res);
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="ct-panel ui-enter" style={{ "--i": 1 }} onSubmit={save} noValidate aria-labelledby="ct-rules-title">
      <h3 id="ct-rules-title" className="ct-panel__title">
        Regras dos contratos
      </h3>
      {issues.length > 0 && (
        <ul className="ct-list" role="status">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <div className="ct-send__row">
        <Field label="Quem assina pela Metta" required error={errors.signerName} hint="Representante legal ou procurador.">
          <Input value={form.signerName ?? ""} maxLength={120} onValueChange={set("signerName")} />
        </Field>
        <Field label="E-mail de quem assina" required error={errors.signerEmail} hint="Recebe o convite da AssinaVelox; com login na plataforma, assina pelo painel.">
          <Input type="email" value={form.signerEmail ?? ""} maxLength={254} onValueChange={set("signerEmail")} />
        </Field>
      </div>
      <div className="ct-send__row">
        <Field label="Razão social" required error={errors.companyName}>
          <Input value={form.companyName ?? ""} maxLength={160} onValueChange={set("companyName")} />
        </Field>
        <Field label="CNPJ" required error={errors.companyDocument}>
          <Input value={form.companyDocument ?? ""} maxLength={18} onValueChange={set("companyDocument")} />
        </Field>
      </div>
      <div className="ct-send__row">
        <Field label="Foro" required error={errors.forum} hint="Cidade/UF da comarca.">
          <Input value={form.forum ?? ""} maxLength={120} onValueChange={set("forum")} placeholder="Ex.: São Paulo/SP" />
        </Field>
        <Field label="Aviso prévio para encerrar planos" error={errors.noticeDays} hint="Em dias. Vai para {{aviso_previo_dias}}.">
          <Input type="number" inputMode="numeric" min={0} max={365} value={String(form.noticeDays ?? 30)} onValueChange={set("noticeDays")} />
        </Field>
      </div>
      <div className="ct-send__row">
        <Field label="Prazo padrão para assinar" error={errors.expiresInDays} hint="Em dias, de 1 a 90.">
          <Input type="number" inputMode="numeric" min={1} max={90} value={String(form.expiresInDays ?? 15)} onValueChange={set("expiresInDays")} />
        </Field>
        <Field label="Pagamento" hint="Quando ligado, o cliente só paga depois que as duas partes assinarem.">
          <Switch
            checked={Boolean(form.requiredBeforePayment)}
            onCheckedChange={set("requiredBeforePayment")}
            label="Liberar o pagamento só depois da assinatura"
          />
        </Field>
      </div>
      <div className="ct-panel__actions">
        <Button type="submit" variant="primary" icon={Save} loading={saving}>
          Salvar regras
        </Button>
      </div>
    </form>
  );
}

function TemplateEditor({ template, variables, onSaved }) {
  const toast = useToast();
  const known = useMemo(() => new Set(variables.map((v) => v.key)), [variables]);
  const [title, setTitle] = useState(template.title);
  const [body, setBody] = useState(template.body);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState(null);
  const bodyRef = useRef(null);
  useEffect(() => {
    setTitle(template.title);
    setBody(template.body);
    setError(null);
  }, [template]);
  const unknown = unknownVariables(`${title}\n${body}`, known);
  const dirty = title !== template.title || body !== template.body;

  const insert = (key) => {
    const token = `{{${key}}}`;
    const el = bodyRef.current;
    if (!el) return setBody((b) => `${b}${token}`);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${token}${body.slice(end)}`;
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const preview = async () => {
    setPreviewing(true);
    try {
      const res = await fetch(`/api/contracts/templates/${template.kind}/preview`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Metta-Request": "1" },
        body: JSON.stringify({ title, body }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? "Não foi possível gerar a prévia.");
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err);
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.put(`/contracts/templates/${template.kind}`, { title, body });
      toast.success(`Versão ${res.template.version} do modelo salva`);
      onSaved(res.template);
    } catch (err) {
      setError(err.fields?.body ?? err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="hub-stack">
      <p className="ui-meta">
        {template.reviewed ? (
          <>
            <Badge tone="olive" dot>
              Revisado
            </Badge>{" "}
            Versão {template.version}, salva {template.updatedBy ? `por ${template.updatedBy} ` : ""}em {formatDateTime(template.updatedAt)}.
            Contratos já enviados não mudam.
          </>
        ) : (
          <>
            <Badge tone="amber" dot>
              Modelo inicial
            </Badge>{" "}
            Texto de partida da plataforma: revise com a assessoria jurídica e salve antes do primeiro envio.
          </>
        )}
      </p>
      <Field label="Título do contrato" required>
        <Input value={title} maxLength={160} onValueChange={setTitle} />
      </Field>
      <Field
        label="Texto do contrato"
        required
        error={error ?? (unknown.length ? `Variáveis desconhecidas: ${unknown.map((v) => `{{${v}}}`).join(", ")}` : undefined)}
        hint="# Título de cláusula · - item de lista · **negrito** · {{variável}}. {{itens}} sozinho em uma linha vira a lista de itens do serviço."
      >
        <Textarea ref={bodyRef} rows={18} autoGrow maxRows={40} value={body} onValueChange={setBody} className="ct-template" spellCheck />
      </Field>
      <div>
        <p className="ui-meta">Variáveis (clique para inserir no cursor)</p>
        <div className="ct-vars">
          {variables.map((v) => (
            <button key={v.key} type="button" className="ct-var" onClick={() => insert(v.key)} title={`${v.label} · ex.: ${v.example}`}>
              {`{{${v.key}}}`}
            </button>
          ))}
        </div>
      </div>
      <div className="ct-panel__actions">
        <Button variant="ghost" icon={Eye} loading={previewing} onClick={preview}>
          Pré-visualizar PDF
        </Button>
        <Button
          variant="primary"
          icon={template.reviewed && !dirty ? CircleCheck : Save}
          loading={saving}
          disabled={unknown.length > 0 || (!dirty && template.reviewed)}
          onClick={save}
        >
          {template.reviewed ? (dirty ? "Salvar nova versão" : "Salvo") : "Revisei e quero usar este modelo"}
        </Button>
      </div>
    </div>
  );
}

export default function ContractsTab() {
  const { data, error, loading, refreshing, reload, setData } = useApi("/contracts/settings");
  const [kind, setKind] = useState("subscription");
  if (loading)
    return (
      <div className="hub-stack" aria-busy="true">
        <Skeleton height={220} radius={4} />
        <Skeleton height={320} radius={4} />
      </div>
    );
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const template = data.templates.find((t) => t.kind === kind) ?? data.templates[0];
  return (
    <div className="hub-stack">
      <div className="hub-toolbar">
        <p className="ui-meta">
          <ShieldCheck size={14} strokeWidth={1.4} aria-hidden="true" /> A chave da API e os segredos ficam só no servidor e nunca
          aparecem aqui.
        </p>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => reload().catch(() => {})} loading={refreshing}>
          Atualizar
        </Button>
      </div>
      <IntegrationCard integration={data.integration} onChanged={() => reload().catch(() => {})} />
      <RulesForm settings={data.settings} issues={data.issues} onSaved={(res) => setData({ ...data, settings: res.settings, issues: res.issues })} />
      <section className="ct-panel ui-enter" style={{ "--i": 2 }} aria-labelledby="ct-templates-title">
        <h3 id="ct-templates-title" className="ct-panel__title">
          Modelos de contrato
        </h3>
        <Tabs
          items={data.templates.map((t) => ({ value: t.kind, label: t.reviewed ? t.label : `${t.label} · revisar` }))}
          value={template.kind}
          onChange={setKind}
          aria-label="Modelos de contrato"
        >
          <TemplateEditor
            template={template}
            variables={data.variables}
            onSaved={(saved) => setData({ ...data, templates: data.templates.map((t) => (t.kind === saved.kind ? saved : t)) })}
          />
        </Tabs>
      </section>
    </div>
  );
}

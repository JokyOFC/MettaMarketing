import { useMemo, useState } from "react";
import { Check, Circle, Eye, EyeOff, KeyRound, LogOut, Mail, Monitor, Smartphone } from "lucide-react";
import { api } from "../../api/client.js";
import { roleLabel, useAuth } from "../../auth/index.js";
import { usePageTitle } from "../../shell/index.js";
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Panel,
  SkeletonRows,
  Switch,
  formatDate,
  formatDateTime,
  formatRelative,
  useApi,
  useToast,
} from "../../ui/index.js";
import { useInvalidFocus } from "../../admin/clients/crmShared.jsx";
import "../../admin/briefings/hub.css";

const cx = (...parts) => parts.filter(Boolean).join(" ");

// Account page for both areas (/painel/conta and /admin/conta).
export default function Account() {
  usePageTitle("Conta");
  const { user } = useAuth();
  const [sessionsKey, setSessionsKey] = useState(0);
  if (!user) return null;
  return (
    <div className="hub-page hub-account">
      <PageHeader
        eyebrow="Conta"
        title="Sua"
        accent="conta"
        description="Seus dados, os avisos por e-mail, a senha e os aparelhos conectados."
      />
      <div className="hub-account__grid">
        <ProfilePanel user={user} />
        <div className="hub-stack">
          <NotifyPanel user={user} />
          <PasswordPanel user={user} onChanged={() => setSessionsKey((n) => n + 1)} />
        </div>
        <SessionsPanel key={sessionsKey} />
      </div>
    </div>
  );
}

function ProfilePanel({ user }) {
  const { setUser } = useAuth();
  const toast = useToast();
  const initial = { name: user.name ?? "", jobTitle: user.jobTitle ?? "", phone: user.phone ?? "" };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [formRef, focusInvalid] = useInvalidFocus();
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const client = user.role === "client";

  const submit = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setErrors({ name: "Informe seu nome." });
      return focusInvalid();
    }
    setSaving(true);
    setErrors({});
    try {
      const res = await api.patch("/auth/profile", {
        name: form.name.trim(),
        jobTitle: form.jobTitle.trim() || null,
        phone: form.phone.trim() || null,
      });
      setUser(res.user);
      setForm({ name: res.user.name ?? "", jobTitle: res.user.jobTitle ?? "", phone: res.user.phone ?? "" });
      toast.success("Perfil atualizado.");
    } catch (err) {
      if (err.fields) {
        setErrors(err.fields);
        focusInvalid(null);
      }
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel eyebrow="Perfil" title="Seus dados" className="hub-account__profile" index={0}>
      <div className="hub-identity">
        <Avatar name={form.name || user.name} size={56} decorative />
        <div className="hub-identity__text">
          <strong>{user.name}</strong>
          <span className="hub-identity__email">
            <Mail size={14} strokeWidth={1.4} aria-hidden="true" />
            {user.email}
          </span>
          <span className="ui-meta">{client ? `Cliente${user.client?.name ? ` · ${user.client.name}` : ""}` : roleLabel(user.role)}</span>
        </div>
      </div>
      <form ref={formRef} className="hub-stack" onSubmit={submit} noValidate>
        <Field label="Nome" required error={errors.name}>
          <Input
            value={form.name}
            autoComplete="name"
            maxLength={120}
            onValueChange={(name) => setForm((f) => ({ ...f, name }))}
          />
        </Field>
        <div className="hub-two">
          <Field label="Cargo" optional error={errors.jobTitle}>
            <Input
              value={form.jobTitle}
              autoComplete="organization-title"
              maxLength={120}
              placeholder={client ? "Ex.: Gerente de marketing" : "Ex.: Designer"}
              onValueChange={(jobTitle) => setForm((f) => ({ ...f, jobTitle }))}
            />
          </Field>
          <Field label="Telefone" optional error={errors.phone}>
            <Input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={40}
              value={form.phone}
              placeholder="(11) 90000-0000"
              onValueChange={(phone) => setForm((f) => ({ ...f, phone }))}
            />
          </Field>
        </div>
        <p className="ui-meta">
          O e-mail de acesso não pode ser alterado aqui. Para trocá-lo, fale com{" "}
          {client ? "a equipe Metta" : "um administrador"}.
        </p>
        <div className="hub-form-actions">
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => setForm(initial)}>
            Descartar
          </Button>
          <Button variant="primary" type="submit" loading={saving} disabled={!dirty} icon={Check}>
            Salvar perfil
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function NotifyPanel({ user }) {
  const { setUser } = useAuth();
  const toast = useToast();
  const [value, setValue] = useState(Boolean(user.notifyEmail));
  const [saving, setSaving] = useState(false);

  const change = async (checked) => {
    setValue(checked);
    setSaving(true);
    try {
      const res = await api.patch("/auth/profile", { notifyEmail: checked });
      setUser(res.user);
      toast.success(
        checked
          ? "Avisos por e-mail ativados."
          : "Avisos por e-mail desativados. Você continua vendo tudo nas notificações da plataforma.",
      );
    } catch (err) {
      setValue(!checked);
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel eyebrow="Avisos" title="Notificações por e-mail" index={1}>
      <Switch
        label="Receber avisos por e-mail"
        description={
          user.role === "client"
            ? "Materiais liberados, pedidos de aprovação, briefings e cobranças."
            : "Respostas de briefings, aprovações, pedidos de ajuste e projetos atribuídos."
        }
        checked={value}
        disabled={saving}
        onCheckedChange={change}
      />
      <p className="ui-meta hub-account__note">
        Convites e redefinições de senha são sempre enviados por e-mail, mesmo com os avisos desativados.
      </p>
    </Panel>
  );
}

// Password strength from length and variety; only a hint, the server rules are
// "at least 10 characters and different from the e-mail".
function strengthOf(password) {
  if (!password) return { score: 0, label: "" };
  let score = 0;
  if (password.length >= 10) score += 1;
  if (password.length >= 14) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 0.5;
  if (/\d/.test(password)) score += 0.5;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  if (password.length < 10) score = Math.min(score, 1);
  const level = score >= 3.5 ? 4 : score >= 2.5 ? 3 : score >= 1.5 ? 2 : 1;
  return { score: level, label: ["", "Fraca", "Razoável", "Boa", "Forte"][level] };
}

// The reveal toggle keeps one name per field ("Mostrar nova senha") and
// reports its state with aria-pressed.
function PasswordField({ label, revealLabel, value, onChange, error, autoComplete, show, onToggle, hint }) {
  return (
    <Field label={label} error={error} hint={hint} required>
      <Input
        type={show ? "text" : "password"}
        value={value}
        autoComplete={autoComplete}
        maxLength={256}
        spellCheck={false}
        onValueChange={onChange}
        suffix={
          <button type="button" className="hub-reveal" onClick={onToggle} aria-label={revealLabel} aria-pressed={show} title={show ? "Ocultar" : "Mostrar"}>
            {show ? <EyeOff size={16} strokeWidth={1.4} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.4} aria-hidden="true" />}
          </button>
        }
      />
    </Field>
  );
}

function PasswordPanel({ user, onChanged }) {
  const toast = useToast();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [show, setShow] = useState({ current: false, next: false, confirm: false });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [formRef, focusInvalid] = useInvalidFocus();
  const strength = strengthOf(form.next);
  const rules = [
    { ok: form.next.length >= 10, text: "Pelo menos 10 caracteres", required: true },
    { ok: Boolean(form.next) && form.next.trim().toLowerCase() !== user.email.toLowerCase(), text: "Diferente do seu e-mail", required: true },
    { ok: Boolean(form.next) && form.next !== form.current, text: "Diferente da senha atual", required: true },
    { ok: /[^A-Za-z0-9]/.test(form.next) || /\d/.test(form.next), text: "Números ou símbolos deixam a senha mais forte" },
    { ok: form.next.length >= 14, text: "14 caracteres ou mais, de preferência uma frase" },
  ];
  const set = (key) => (value) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const toggle = (key) => () => setShow((s) => ({ ...s, [key]: !s[key] }));

  const submit = async (event) => {
    event.preventDefault();
    const local = {};
    if (!form.current) local.current = "Informe a senha atual.";
    if (!rules.slice(0, 3).every((rule) => rule.ok)) local.next = "A nova senha ainda não atende aos requisitos.";
    if (form.confirm !== form.next) local.confirm = "As senhas não conferem.";
    setErrors(local);
    if (Object.keys(local).length) return focusInvalid();
    setSaving(true);
    try {
      await api.post("/auth/password/change", { currentPassword: form.current, newPassword: form.next });
      setForm({ current: "", next: "", confirm: "" });
      setShow({ current: false, next: false, confirm: false });
      toast.success({ title: "Senha alterada", message: "As sessões em outros aparelhos foram encerradas." });
      onChanged?.();
    } catch (err) {
      if (err.fields) {
        setErrors({ current: err.fields.currentPassword, next: err.fields.newPassword });
        focusInvalid(err.message);
      } else toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel eyebrow="Segurança" title="Senha" index={2}>
      <form ref={formRef} className="hub-stack" onSubmit={submit} noValidate>
        <PasswordField
          label="Senha atual"
          revealLabel="Mostrar senha atual"
          value={form.current}
          onChange={set("current")}
          error={errors.current}
          autoComplete="current-password"
          show={show.current}
          onToggle={toggle("current")}
        />
        <PasswordField
          label="Nova senha"
          revealLabel="Mostrar nova senha"
          value={form.next}
          onChange={set("next")}
          error={errors.next}
          autoComplete="new-password"
          show={show.next}
          onToggle={toggle("next")}
        />
        {form.next && (
          <div className="hub-strength" data-score={strength.score}>
            <span className="hub-strength__bar" aria-hidden="true">
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={cx(n <= strength.score && "is-on")} />
              ))}
            </span>
            <span className="hub-strength__label">Força: {strength.label}</span>
          </div>
        )}
        <ul className="hub-rules" aria-label="Requisitos da nova senha">
          {rules.map((rule) => (
            <li key={rule.text} className={cx(rule.ok && "is-ok", !rule.required && "is-tip")}>
              {rule.ok ? (
                <Check size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Circle size={10} strokeWidth={1.6} aria-hidden="true" />
              )}
              <span>
                {rule.text}
                <span className="ui-sr-only">{rule.ok ? " (atendido)" : rule.required ? " (pendente)" : " (sugestão)"}</span>
              </span>
            </li>
          ))}
        </ul>
        <PasswordField
          label="Confirme a nova senha"
          revealLabel="Mostrar a confirmação da senha"
          value={form.confirm}
          onChange={set("confirm")}
          error={errors.confirm}
          autoComplete="new-password"
          show={show.confirm}
          onToggle={toggle("confirm")}
        />
        <p className="ui-meta">Ao trocar a senha, os outros aparelhos conectados saem da conta.</p>
        <div className="hub-form-actions">
          <Button variant="primary" type="submit" loading={saving} icon={KeyRound}>
            Alterar senha
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function describeAgent(ua = "") {
  const text = String(ua || "");
  const browser = /Edg\//.test(text)
    ? "Edge"
    : /OPR\/|Opera/.test(text)
      ? "Opera"
      : /Firefox\//.test(text)
        ? "Firefox"
        : /Chrome\//.test(text)
          ? "Chrome"
          : /Safari\//.test(text)
            ? "Safari"
            : null;
  const os = /iPhone|iPad|iPod/.test(text)
    ? "iOS"
    : /Android/.test(text)
      ? "Android"
      : /Windows/.test(text)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(text)
          ? "macOS"
          : /Linux/.test(text)
            ? "Linux"
            : null;
  const mobile = /Mobile|iPhone|Android/.test(text);
  const label = browser && os ? `${browser} no ${os}` : browser || os || "Navegador desconhecido";
  return { label, mobile };
}

function SessionsPanel() {
  const { logout } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi("/auth/sessions");
  const [ending, setEnding] = useState(null);
  const [confirmSelf, setConfirmSelf] = useState(false);
  const items = useMemo(() => data?.items ?? [], [data]);
  const others = items.filter((item) => !item.current);

  const end = async (session) => {
    setEnding(session.id);
    try {
      await api.del(`/auth/sessions/${session.id}`);
      setData((d) => ({ ...d, items: (d?.items ?? []).filter((item) => item.id !== session.id) }));
      toast.success("Sessão encerrada.");
    } catch (err) {
      toast.error(err);
    } finally {
      setEnding(null);
    }
  };

  const endOthers = async () => {
    setEnding("others");
    let failed = 0;
    for (const session of others) {
      try {
        await api.del(`/auth/sessions/${session.id}`);
      } catch {
        failed += 1;
      }
    }
    setEnding(null);
    await reload().catch(() => {});
    if (failed) toast.error(`Não foi possível encerrar ${failed} ${failed === 1 ? "sessão" : "sessões"}. Tente de novo.`);
    else toast.success("As outras sessões foram encerradas.");
  };

  return (
    <Panel
      eyebrow="Acesso"
      title="Sessões ativas"
      description="Aparelhos e navegadores conectados à sua conta. Encerre os que você não reconhece."
      className="hub-account__sessions"
      index={3}
      actions={
        others.length > 0 && (
          <Button size="sm" icon={LogOut} onClick={endOthers} loading={ending === "others"}>
            Encerrar as outras
          </Button>
        )
      }
    >
      {loading && <SkeletonRows rows={2} columns={2} media label="Carregando sessões" />}
      {error && !data && <ErrorState error={error} onRetry={reload} compact />}
      {items.length > 0 && (
        <ul className="hub-sessions">
          {items.map((session, index) => {
            const agent = describeAgent(session.userAgent);
            const DeviceIcon = agent.mobile ? Smartphone : Monitor;
            return (
              <li key={session.id} className={cx("hub-session ui-enter", session.current && "is-current")} style={{ "--i": Math.min(index, 8) }}>
                <span className="hub-session__icon" aria-hidden="true">
                  <DeviceIcon size={18} strokeWidth={1.4} />
                </span>
                <div className="hub-session__body">
                  <p className="hub-session__title">
                    {agent.label}
                    {session.current && (
                      <Badge tone="olive" size="sm" dot>
                        Esta sessão
                      </Badge>
                    )}
                  </p>
                  <p className="ui-meta">
                    {session.current ? "Ativa agora" : `Último acesso ${formatRelative(session.lastSeenAt)}`}
                    {session.ip ? ` · IP ${session.ip}` : ""} · desde {formatDate(session.createdAt)}
                  </p>
                </div>
                {session.current ? (
                  <Button size="sm" variant="ghost" icon={LogOut} onClick={() => setConfirmSelf(true)}>
                    Sair
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => end(session)}
                    loading={ending === session.id}
                    disabled={ending === "others"}
                    aria-label={`Encerrar sessão: ${agent.label}, último acesso ${formatRelative(session.lastSeenAt)}${session.ip ? `, IP ${session.ip}` : ""}, iniciada em ${formatDateTime(session.createdAt)}`}
                  >
                    Encerrar
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={confirmSelf}
        onClose={() => setConfirmSelf(false)}
        onConfirm={() => logout()}
        title="Sair deste aparelho?"
        description="Você volta para a tela de entrada e precisa da senha para acessar de novo."
        confirmLabel="Sair"
        icon={LogOut}
      />
    </Panel>
  );
}

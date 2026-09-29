import { useEffect, useId, useState } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Check, Circle, MailCheck, MessageCircle, TimerOff } from "lucide-react";
import Logo from "../Logo.jsx";
import { Arrow } from "../components/SiteChrome.jsx";
import { contactEmail, mailto, whatsappUrl } from "../data/brand.js";
import { api, NETWORK_MESSAGE } from "../app/api/client.js";
import { useAuth } from "../app/auth/AuthProvider.jsx";
import { homeFor, safeNext } from "../app/auth/roles.js";
import "../app/auth/access.css";

const MIN_PASSWORD = 10;

// Split-screen editorial frame shared by every access page.
function AuthLayout({ kicker = "ÁREA DO CLIENTE", title, lead, children, footer }) {
  return (
    <main className="auth-page">
      <aside className="auth-art">
        <img src="/images/hero.webp" alt="" />
        <Link to="/" aria-label="Metta Marketing, início">
          <Logo />
        </Link>
        <div>
          <p className="eyebrow">UM ESPAÇO PARA AVANÇAR</p>
          <h1>
            Sua marca.
            <br />
            Nossa conexão.
            <br />
            <em>O próximo passo.</em>
          </h1>
          <p>
            Estratégia, conteúdo e acompanhamento.
            <br />
            Tudo na mesma direção.
          </p>
        </div>
        <span>ESTRATÉGIAS QUE CONECTAM SUA FINTECH AOS CLIENTES.</span>
      </aside>
      <section className="auth-form-wrap">
        <Link to="/" className="auth-back">
          ← Voltar ao site
        </Link>
        <div className="auth-form-inner acc-inner">
          <span className="acc-kicker">{kicker}</span>
          <h2>{title}</h2>
          {lead && <p>{lead}</p>}
          {children}
          {footer}
        </div>
        <span className="auth-bottom">METTA MARKETING · FEITO COM INTENÇÃO.</span>
      </section>
    </main>
  );
}

function PasswordInput({ id, value, onChange, autoComplete, invalid, describedBy, visible, onToggle }) {
  return (
    <div className="password-field">
      <input
        id={id}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
        aria-pressed={visible}
      >
        {visible ? "Ocultar" : "Mostrar"}
      </button>
    </div>
  );
}

function SubmitButton({ busy, children, busyLabel }) {
  return (
    <button
      className="button solid acc-submit"
      type="submit"
      disabled={busy}
      aria-busy={busy || undefined}
    >
      {busy ? busyLabel : children}
      <Arrow />
    </button>
  );
}

function FormError({ children }) {
  if (!children) return null;
  return (
    <p className="form-error acc-error" role="alert">
      {children}
    </p>
  );
}

function StatePanel({ icon: Icon, title, children }) {
  return (
    <div className="acc-panel" role="status">
      <span className="acc-panel-icon" aria-hidden="true">
        <Icon size={22} strokeWidth={1.4} />
      </span>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

// Live hints for a new password. The only hard rule (server) is the length.
function PasswordHints({ id, password, confirm, email, name }) {
  const lower = password.toLowerCase();
  const local = String(email || "").split("@")[0].toLowerCase();
  const first = String(name || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
  const personal =
    (local.length >= 3 && lower.includes(local)) ||
    (first.length >= 3 && lower.includes(first));
  const hints = [
    { ok: password.length >= MIN_PASSWORD, text: `Pelo menos ${MIN_PASSWORD} caracteres` },
    { ok: /[a-zA-Z]/.test(password) && /\d/.test(password), text: "Letras e números" },
    { ok: password.length > 0 && !personal, text: "Sem o seu nome ou e-mail" },
    { ok: password.length > 0 && password === confirm, text: "Confirmação igual à senha" },
  ];
  return (
    <ul className="acc-hints" id={id} aria-label="Dicas para a senha">
      {hints.map((hint) => (
        <li key={hint.text} className={hint.ok ? "is-ok" : ""}>
          {hint.ok ? (
            <Check size={14} strokeWidth={1.6} aria-hidden="true" />
          ) : (
            <Circle size={10} strokeWidth={1.4} aria-hidden="true" />
          )}
          <span>
            {hint.text}
            <span className="acc-sr">{hint.ok ? " (atendido)" : " (pendente)"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function checkNewPassword(password, confirm) {
  const fields = {};
  if (password.length < MIN_PASSWORD)
    fields.password = `Use pelo menos ${MIN_PASSWORD} caracteres.`;
  if (password !== confirm) fields.confirm = "As senhas precisam ser iguais.";
  return fields;
}

// ------------------------------------------------------------------- login

function loginMessage(error) {
  switch (error.code) {
    case "invalid_credentials":
    case "unauthenticated":
    case "not_found":
      return "E-mail ou senha incorretos. Confira os dados e tente de novo.";
    case "rate_limited":
      return "Muitas tentativas seguidas. Por segurança, aguarde alguns minutos antes de tentar de novo.";
    case "account_disabled":
    case "disabled":
      return "Este acesso está desativado. Fale com a equipe da Metta para reativá-lo.";
    case "network":
      return NETWORK_MESSAGE;
    default:
      return error.message;
  }
}

export function LoginPage() {
  const { user, login, expired: sessionLost } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const next = params.get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const expired = sessionLost || location.state?.reason === "expired";

  if (user && !busy) return <Navigate to={safeNext(next, user)} replace />;

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const signedIn = await login(email.trim(), password);
      setPassword("");
      navigate(safeNext(next, signedIn), { replace: true });
    } catch (failure) {
      setError(loginMessage(failure));
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={
        <>
          Bom ter você <em>aqui.</em>
        </>
      }
      lead="Entre para acompanhar a sua marca, os conteúdos e as entregas da Metta."
      footer={
        <p className="auth-switch">
          Ainda não tem acesso? <Link to="/cadastro">Saiba como funciona o convite</Link>
        </p>
      }
    >
      {expired && !error && (
        <p className="acc-note" role="status">
          Sua sessão terminou. Entre de novo para continuar de onde parou.
        </p>
      )}
      <form className="metta-form" onSubmit={submit}>
        <label>
          E-mail
          <input
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(error) || undefined}
          />
        </label>
        <label>
          Senha
          <PasswordInput
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            invalid={Boolean(error)}
            visible={visible}
            onToggle={() => setVisible(!visible)}
          />
        </label>
        <div className="acc-row">
          <Link to="/recuperar-senha" className="acc-link">
            Esqueci minha senha
          </Link>
        </div>
        <FormError>{error}</FormError>
        <SubmitButton busy={busy} busyLabel="Entrando…">
          Entrar
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}

// -------------------------------------------------------- invitation only

export function InviteOnlyPage() {
  return (
    <AuthLayout
      title={
        <>
          Acesso por <em>convite.</em>
        </>
      }
      lead="A área do cliente é criada pela equipe da Metta para cada empresa que atendemos."
      footer={
        <p className="auth-switch">
          Já tem acesso? <Link to="/login">Entrar</Link>
        </p>
      }
    >
      <ol className="acc-steps">
        <li>
          <span aria-hidden="true">01</span>
          <p>A Metta cadastra a sua empresa e as suas marcas.</p>
        </li>
        <li>
          <span aria-hidden="true">02</span>
          <p>Você recebe um convite por e-mail, com um link pessoal.</p>
        </li>
        <li>
          <span aria-hidden="true">03</span>
          <p>Pelo link, você confirma seus dados e define a sua senha.</p>
        </li>
      </ol>
      <div className="acc-actions">
        <a className="button solid" href={whatsappUrl} target="_blank" rel="noopener noreferrer">
          <span className="acc-inline">
            <MessageCircle size={17} strokeWidth={1.4} aria-hidden="true" />
            Falar com a Metta pelo WhatsApp
          </span>
          <Arrow />
        </a>
        <a className="acc-link" href={mailto("Acesso à área do cliente")}>
          Ou escreva para {contactEmail}
        </a>
      </div>
      <p className="form-note acc-footnote">
        Recebeu um convite e o link expirou? Peça um novo à equipe que atende a sua marca.
      </p>
    </AuthLayout>
  );
}

// -------------------------------------------------------------- invitation

export function InvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const ids = { hints: useId(), password: useId(), confirm: useId() };
  const [invite, setInvite] = useState({ status: "loading" });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [fields, setFields] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setInvite({ status: "loading" });
    api
      .get(`/auth/invite/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then((data) => {
        if (data?.purpose === "reset") {
          navigate(`/redefinir-senha/${encodeURIComponent(token)}`, { replace: true });
          return;
        }
        setInvite({ status: "ready", email: data?.email, name: data?.name });
        setName(data?.name || "");
      })
      .catch((failure) => {
        if (failure.name === "AbortError") return;
        setInvite(
          ["expired", "not_found", "bad_request"].includes(failure.code)
            ? { status: "invalid" }
            : { status: "error", error: failure },
        );
      });
    return () => controller.abort();
  }, [token, navigate, attempt]);

  async function submit(event) {
    event.preventDefault();
    setError("");
    const problems = checkNewPassword(password, confirm);
    if (!name.trim()) problems.name = "Informe o seu nome.";
    if (invite.email && password.trim().toLowerCase() === invite.email.toLowerCase())
      problems.password = "A senha não pode ser igual ao e-mail.";
    setFields(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    try {
      const data = await api.post("/auth/invite/accept", {
        token,
        password,
        name: name.trim(),
      });
      setPassword("");
      setConfirm("");
      setUser(data.user);
      navigate(homeFor(data.user), { replace: true });
    } catch (failure) {
      setBusy(false);
      if (failure.code === "expired" || failure.code === "not_found") {
        setInvite({ status: "invalid" });
        return;
      }
      if (failure.fields) setFields(failure.fields);
      setError(failure.code === "validation" && failure.fields ? "" : failure.message);
    }
  }

  if (invite.status === "invalid")
    return (
      <AuthLayout title="Convite indisponível." footer={<InviteHelp />}>
        <StatePanel icon={TimerOff} title="Este convite expirou ou já foi usado.">
          <p>
            Se você já definiu a sua senha, basta entrar. Caso contrário, peça um novo
            convite à equipe da Metta.
          </p>
        </StatePanel>
        <div className="acc-actions">
          <Link className="button solid" to="/login">
            Entrar
            <Arrow />
          </Link>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title={
        <>
          Boas-vindas à <em>Metta.</em>
        </>
      }
      lead="Confirme seus dados e defina a senha para acessar o espaço da sua marca."
      footer={<InviteHelp />}
    >
      {invite.status === "loading" && (
        <div className="acc-skeleton" aria-busy="true" aria-label="Carregando convite">
          <span />
          <span />
          <span />
        </div>
      )}
      {invite.status === "error" && (
        <div className="acc-actions">
          <FormError>{invite.error?.message}</FormError>
          <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
            Tentar de novo
            <Arrow />
          </button>
        </div>
      )}
      {invite.status === "ready" && (
        <form className="metta-form" onSubmit={submit} noValidate>
          <div className="acc-email">
            <span>Convite para</span>
            <strong>{invite.email}</strong>
          </div>
          <input type="email" name="email" autoComplete="username" value={invite.email || ""} readOnly hidden />
          <label>
            Seu nome
            <input
              required
              autoComplete="name"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={Boolean(fields.name) || undefined}
            />
            {fields.name && <span className="acc-field-error">{fields.name}</span>}
          </label>
          <label htmlFor={ids.password}>
            Crie uma senha
            <PasswordInput
              id={ids.password}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              invalid={Boolean(fields.password)}
              describedBy={ids.hints}
              visible={visible}
              onToggle={() => setVisible(!visible)}
            />
            {fields.password && <span className="acc-field-error">{fields.password}</span>}
          </label>
          <label htmlFor={ids.confirm}>
            Confirme a senha
            <input
              id={ids.confirm}
              type={visible ? "text" : "password"}
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              aria-invalid={Boolean(fields.confirm) || undefined}
            />
            {fields.confirm && <span className="acc-field-error">{fields.confirm}</span>}
          </label>
          <PasswordHints
            id={ids.hints}
            password={password}
            confirm={confirm}
            email={invite.email}
            name={name}
          />
          <FormError>{error}</FormError>
          <SubmitButton busy={busy} busyLabel="Criando acesso…">
            Criar acesso
          </SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}

function InviteHelp() {
  return (
    <p className="auth-switch">
      Dúvidas sobre o acesso? <a href={mailto("Convite da área do cliente")}>Fale com a Metta</a>
    </p>
  );
}

// ---------------------------------------------------------- forgot password

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.post("/auth/password/forgot", { email: email.trim() });
      setSent(true);
    } catch (failure) {
      // The answer never reveals whether an account exists; only connection
      // and throttling problems are worth reporting.
      if (failure.code === "network" || failure.status >= 500) setError(failure.message);
      else if (failure.code === "rate_limited")
        setError("Muitos pedidos seguidos. Aguarde alguns minutos e tente de novo.");
      else setSent(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={
        <>
          Recuperar <em>senha.</em>
        </>
      }
      lead={
        sent
          ? null
          : "Informe o e-mail de acesso. Enviaremos um link para você criar uma nova senha."
      }
      footer={
        <p className="auth-switch">
          Lembrou a senha? <Link to="/login">Entrar</Link>
        </p>
      }
    >
      {sent ? (
        <StatePanel icon={MailCheck} title="Confira a sua caixa de entrada.">
          <p>
            Se houver um acesso ativo para <strong>{email.trim()}</strong>, você vai receber
            um link para criar uma nova senha. O link vale por tempo limitado. Confira também
            a pasta de spam.
          </p>
        </StatePanel>
      ) : (
        <form className="metta-form" onSubmit={submit}>
          <label>
            E-mail
            <input
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <FormError>{error}</FormError>
          <SubmitButton busy={busy} busyLabel="Enviando…">
            Enviar link
          </SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}

// ----------------------------------------------------------- reset password

export function ResetPasswordPage() {
  const { token } = useParams();
  const ids = { hints: useId(), password: useId(), confirm: useId() };
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [fields, setFields] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState("form");
  const [account, setAccount] = useState(null);

  // Checks the link up front so an expired one does not cost a typed password.
  useEffect(() => {
    const controller = new AbortController();
    api
      .get(`/auth/invite/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then((data) => setAccount(data?.email ? data : null))
      .catch((failure) => {
        if (failure.code === "expired" || failure.code === "not_found") setState("invalid");
      });
    return () => controller.abort();
  }, [token]);

  async function submit(event) {
    event.preventDefault();
    setError("");
    const problems = checkNewPassword(password, confirm);
    if (account?.email && password.trim().toLowerCase() === account.email.toLowerCase())
      problems.password = "A senha não pode ser igual ao e-mail.";
    setFields(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    try {
      await api.post("/auth/password/reset", { token, password });
      setPassword("");
      setConfirm("");
      setState("done");
    } catch (failure) {
      if (failure.code === "expired" || failure.code === "not_found") setState("invalid");
      else {
        if (failure.fields) setFields(failure.fields);
        setError(failure.code === "validation" && failure.fields ? "" : failure.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (state === "done")
    return (
      <AuthLayout title={<>Senha <em>redefinida.</em></>}>
        <StatePanel icon={Check} title="Tudo certo.">
          <p>A nova senha já vale. Entre com ela para continuar.</p>
        </StatePanel>
        <div className="acc-actions">
          <Link className="button solid" to="/login">
            Entrar
            <Arrow />
          </Link>
        </div>
      </AuthLayout>
    );

  if (state === "invalid")
    return (
      <AuthLayout title="Link indisponível.">
        <StatePanel icon={TimerOff} title="Este link expirou ou já foi usado.">
          <p>Peça um novo link para redefinir a senha. Ele chega em alguns minutos.</p>
        </StatePanel>
        <div className="acc-actions">
          <Link className="button solid" to="/recuperar-senha">
            Pedir um novo link
            <Arrow />
          </Link>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title={
        <>
          Nova <em>senha.</em>
        </>
      }
      lead="Escolha uma senha que você não usa em outros serviços."
      footer={
        <p className="auth-switch">
          Lembrou a senha? <Link to="/login">Entrar</Link>
        </p>
      }
    >
      <form className="metta-form" onSubmit={submit} noValidate>
        {account?.email && (
          <div className="acc-email">
            <span>Acesso</span>
            <strong>{account.email}</strong>
          </div>
        )}
        <input
          type="email"
          name="email"
          autoComplete="username"
          value={account?.email || ""}
          readOnly
          hidden
        />
        <label htmlFor={ids.password}>
          Nova senha
          <PasswordInput
            id={ids.password}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            invalid={Boolean(fields.password)}
            describedBy={ids.hints}
            visible={visible}
            onToggle={() => setVisible(!visible)}
          />
          {fields.password && <span className="acc-field-error">{fields.password}</span>}
        </label>
        <label htmlFor={ids.confirm}>
          Confirme a nova senha
          <input
            id={ids.confirm}
            type={visible ? "text" : "password"}
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={Boolean(fields.confirm) || undefined}
          />
          {fields.confirm && <span className="acc-field-error">{fields.confirm}</span>}
        </label>
        <PasswordHints
          id={ids.hints}
          password={password}
          confirm={confirm}
          email={account?.email}
        />
        <FormError>{error}</FormError>
        <SubmitButton busy={busy} busyLabel="Salvando…">
          Salvar nova senha
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}

export default LoginPage;

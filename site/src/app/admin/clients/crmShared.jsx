// Shared pieces of slice E (clients, team, projects): input masks, a small
// form-state hook, focus on invalid fields, invite and notification feedback,
// member avatars and due-date labels. The invalid-field focus and the
// notification wording are also used by the orders, services, settings,
// briefings and account forms.
import { useCallback, useRef, useState } from "react";
import { CalendarClock, CircleAlert, Lock, MailCheck, Send } from "lucide-react";
import { focusFirstInvalid } from "../../ui/forms.jsx";
import {
  Avatar,
  Badge,
  CopyButton,
  Icon,
  formatDate,
  formatRelative,
  isoDate,
  roleLabel,
  useReducedMotion,
  useToast,
} from "../../ui/index.js";

export const cx = (...parts) => parts.filter(Boolean).join(" ");

// ------------------------------------------------------------------ masks

const digits = (value, max) =>
  String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, max);

// Progressive CNPJ mask (00.000.000/0000-00); 11 digits read as CPF on blur.
export function maskDocument(value, { final = false } = {}) {
  const d = digits(value, 14);
  if (final && d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  let out = d.slice(0, 2);
  if (d.length > 2) out += `.${d.slice(2, 5)}`;
  if (d.length > 5) out += `.${d.slice(5, 8)}`;
  if (d.length > 8) out += `/${d.slice(8, 12)}`;
  if (d.length > 12) out += `-${d.slice(12, 14)}`;
  return out;
}

// (11) 3333-4444 or (11) 93333-4444
export function maskPhone(value) {
  const d = digits(value, 11);
  if (!d) return "";
  if (d.length <= 2) return `(${d}`;
  const area = `(${d.slice(0, 2)}) `;
  const rest = d.slice(2);
  if (rest.length <= 4) return area + rest;
  if (d.length <= 10) return `${area}${rest.slice(0, 4)}-${rest.slice(4)}`;
  return `${area}${rest.slice(0, 5)}-${rest.slice(5)}`;
}

// ------------------------------------------------------------------ form state

const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Groups without a single control (member picker, checklists) mark their
// wrapper with .is-invalid instead of aria-invalid: focus their first control.
function focusInvalidGroup(root, reducedMotion) {
  const control = root?.querySelector(".is-invalid")?.querySelector(FOCUSABLE);
  if (!control) return false;
  control.focus({ preventScroll: true });
  control.scrollIntoView?.({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
  return true;
}

/**
 * useInvalidFocus() -> [ref, focusInvalid(fallbackMessage?)]
 * Put `ref` on the <form> (or the element that holds the fields) and call
 * focusInvalid() right after setting validation errors: once the errors have
 * rendered, the first invalid field gets focus and scrolls into view (kit
 * focusFirstInvalid), so the primary button never "does nothing" with the
 * problem off-screen; its label and error text are announced. When no field
 * shows the error (e.g. a server error for a field this form does not
 * render), the fallback message is shown as a toast instead (null: none).
 */
export function useInvalidFocus() {
  const ref = useRef(null);
  const reducedMotion = useReducedMotion();
  const toast = useToast();
  const focusInvalid = useCallback(
    (fallback = "Revise os campos destacados.") => {
      if (!ref.current) return;
      focusFirstInvalid(ref, { reducedMotion }).then((found) => {
        if (found || focusInvalidGroup(ref.current, reducedMotion)) return;
        if (fallback) toast.error(fallback);
      });
    },
    [reducedMotion, toast],
  );
  return [ref, focusInvalid];
}

const hasError = (errors) => Object.values(errors ?? {}).some(Boolean);

/**
 * useForm(initial) -> { ref, values, set(name, value), bind(name), errors,
 *   setErrors, fieldError(name), reset(next), fail(error) }
 * bind(name) spreads { value, onValueChange } on kit inputs; fail(error) maps
 * ApiError.fields (422) and returns true when the error was a validation one.
 * Put `ref` on the <form>: setErrors(nonEmpty) and fail() move focus to the
 * first invalid field.
 */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [errors, setErrorState] = useState({});
  const [ref, focusInvalid] = useInvalidFocus();
  const set = useCallback((name, value) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrorState((current) => (current[name] ? { ...current, [name]: undefined } : current));
  }, []);
  const bind = (name) => ({ value: values[name] ?? "", onValueChange: (value) => set(name, value) });
  const reset = useCallback((next) => {
    setValues(next);
    setErrorState({});
  }, []);
  const setErrors = useCallback(
    (next) => {
      setErrorState(next);
      if (hasError(next)) focusInvalid();
    },
    [focusInvalid],
  );
  const fail = (error) => {
    if (error?.code === "validation" && error.fields) {
      setErrorState(error.fields);
      focusInvalid(error.message);
      return true;
    }
    return false;
  };
  return { ref, values, setValues, set, bind, errors, setErrors, fieldError: (name) => errors[name], reset, fail };
}

// Keeps the last non-empty value so a dialog keeps its content while it
// animates closed after the state that opened it was cleared.
export function useSticky(value) {
  const last = useRef(value);
  if (value !== null && value !== undefined && value !== false) last.current = value;
  return value || last.current;
}

// Trimmed value or null (optional API fields).
export const clean = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
};

// ------------------------------------------------------------------ dates

export const todayIso = () => isoDate(new Date());

export function isOverdue(dueDate, { done = false } = {}) {
  return Boolean(dueDate) && !done && dueDate < todayIso();
}

// "Prazo 12 out." · "Atrasado · 12 out." · "Hoje"
export function DueLabel({ date, done = false, prefix = "Prazo", className, compact = false }) {
  if (!date) return null;
  const late = isOverdue(date, { done });
  const today = date === todayIso() && !done;
  const year = date.slice(0, 4) !== String(new Date().getFullYear());
  const text = formatDate(date, { year });
  return (
    <span className={cx("crm-due", late && "is-late", today && "is-today", className)} title={formatDate(date)}>
      <CalendarClock size={14} strokeWidth={1.4} aria-hidden="true" />
      <span>
        {late ? (
          <>
            <strong>Atrasado</strong> · {text}
          </>
        ) : today ? (
          <>
            <strong>Hoje</strong>
            {compact ? "" : ` · ${text}`}
          </>
        ) : compact ? (
          text
        ) : (
          `${prefix} ${text}`
        )}
      </span>
    </span>
  );
}

// ------------------------------------------------------------------ people

export function MemberStack({ members = [], max = 4, size = 26, label = "Equipe" }) {
  if (!members.length) return <span className="crm-members crm-members--empty">Sem equipe</span>;
  const shown = members.slice(0, max);
  const extra = members.length - shown.length;
  const names = members.map((member) => member.name).join(", ");
  return (
    <span className="crm-members" role="img" aria-label={`${label}: ${names}`} title={names} style={{ "--stack-size": `${size}px` }}>
      {shown.map((member) => (
        <Avatar key={member.id} name={member.name} size={size} decorative />
      ))}
      {extra > 0 && (
        <span className="crm-members__more" style={{ "--avatar-size": `${size}px` }} aria-hidden="true">
          +{extra}
        </span>
      )}
    </span>
  );
}

export function PersonCell({ name, email, detail, size = 32, muted = false, badge }) {
  const meta = [detail, email].filter(Boolean).join(" · ");
  return (
    <span className={cx("crm-person", muted && "is-muted")}>
      <Avatar name={name} size={size} decorative />
      <span className="crm-person__text">
        <span className="crm-person__name">
          {name}
          {badge}
        </span>
        {meta && (
          <span className="crm-person__meta" title={meta}>
            {meta}
          </span>
        )}
      </span>
    </span>
  );
}

// Invite status line for invited users.
export function inviteText(user) {
  if (user.status !== "invited") return null;
  if (!user.invite) return "Convite sem link ativo — reenvie para gerar um novo.";
  if (user.invite.expired) return `Convite expirado em ${formatDate(user.invite.expiresAt)}`;
  return `Convite enviado ${formatRelative(user.invite.sentAt)} · vale até ${formatDate(user.invite.expiresAt)}`;
}

export const roleName = (role) => roleLabel(role);

// ------------------------------------------------------------------ notification feedback

/**
 * How the people were told, worded from the API answer
 * { notified, emailConfigured, emailRecipients } (projects, members, briefings).
 * Never claims an e-mail that was not sent: without SMTP the messages stay in
 * the outbox as "não configurado" (Configurações > E-mails), and people who
 * turned e-mail notices off only get the in-app notice.
 *   noticeChannels(res) -> "na plataforma e por e-mail." | "na plataforma. O envio…"
 */
export function noticeChannels({ notified = 0, emailConfigured = false, emailRecipients = 0 } = {}) {
  if (!emailConfigured) return "na plataforma. O envio de e-mails ainda não está configurado.";
  if (!emailRecipients)
    return notified === 1
      ? "na plataforma. Os avisos por e-mail estão desligados no perfil dessa pessoa."
      : "na plataforma. Os avisos por e-mail estão desligados no perfil dessas pessoas.";
  if (emailRecipients >= notified) return "na plataforma e por e-mail.";
  return `na plataforma; ${emailRecipients} também por e-mail.`;
}

// ------------------------------------------------------------------ badges

export function InternalBadge({ label = "Somente equipe" }) {
  return (
    <Badge tone="dark" size="sm" icon={Lock} className="crm-internal">
      {label}
    </Badge>
  );
}

// Typographic brand tile (no logo invented): Cormorant initial on olive.
export function BrandMark({ name, size = 44, tone = "olive" }) {
  const letter = String(name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span className={cx("crm-mark", `crm-mark--${tone}`)} style={{ "--mark-size": `${size}px` }} aria-hidden="true">
      {letter}
    </span>
  );
}

// ------------------------------------------------------------------ invites

/**
 * Feedback after inviting someone. With e-mail configured the API never sends
 * the link back; without it, inviteUrl comes back for the team to hand over.
 */
export function InviteResult({ result, name, email, className }) {
  if (!result) return null;
  if (result.inviteUrl) {
    return (
      <div className={cx("crm-invite", className)} role="status">
        <div className="crm-invite__head">
          <Icon icon={Send} size={18} />
          <div>
            <p className="crm-invite__title">Convite criado para {name}</p>
            <p className="crm-invite__text">
              O envio de e-mails ainda não está configurado. Copie o link e envie para {name} por um canal
              seguro. Ele vale por 72 horas e funciona uma única vez.
            </p>
          </div>
        </div>
        <div className="crm-invite__link">
          <input
            className="ui-control ui-control--sm"
            readOnly
            value={result.inviteUrl}
            aria-label={`Link de convite de ${name}`}
            onFocus={(event) => event.currentTarget.select()}
          />
          <CopyButton text={result.inviteUrl} label="Copiar link" copiedLabel="Link copiado" variant="secondary" />
        </div>
      </div>
    );
  }
  const failed = result.emailStatus === "failed";
  return (
    <div className={cx("crm-invite", failed && "is-failed", className)} role="status">
      <div className="crm-invite__head">
        <Icon icon={failed ? CircleAlert : MailCheck} size={18} />
        <div>
          <p className="crm-invite__title">
            {failed
              ? "O e-mail de convite não foi enviado"
              : result.emailStatus === "queued"
                ? `Enviando o convite para ${email}`
                : `Convite enviado para ${email}`}
          </p>
          <p className="crm-invite__text">
            {failed
              ? "O servidor de e-mail recusou a mensagem. Use “Reenviar convite” em alguns minutos."
              : "O link vale por 72 horas. Se a pessoa não encontrar o e-mail, reenvie o convite."}
          </p>
        </div>
      </div>
    </div>
  );
}

// "1 marca" / "3 marcas"
export const count = (n, one, many) => `${n ?? 0} ${(n ?? 0) === 1 ? one : many}`;

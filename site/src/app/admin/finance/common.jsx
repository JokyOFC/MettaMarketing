// Shared pieces of the commerce slice (admin planos/pedidos/financeiro and
// the client billing page). Styles: fin.css (prefix fin-).
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BadgeCheck,
  Ban,
  CircleAlert,
  CircleCheck,
  CircleX,
  CloudOff,
  CreditCard,
  FileSignature,
  Link2,
  PenLine,
  PlugZap,
  Receipt,
  RefreshCw,
  Send,
  Undo2,
} from "lucide-react";
import {
  Button,
  Icon,
  Input,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  renderIcon,
} from "../../ui/index.js";

export const cx = (...parts) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- money

const decimals = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "1.500,00" | "1500" | "1500.5" | "R$ 1.500" -> cents (null when empty/invalid).
export function parseMoney(text) {
  let t = String(text ?? "")
    .replace(/[^\d.,]/g, "")
    .trim();
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export const centsToText = (cents) =>
  cents === null || cents === undefined || Number.isNaN(Number(cents)) ? "" : decimals.format(Number(cents) / 100);

// Currency field: types freely, reports cents, tidies the text on blur.
export function MoneyInput({ value, onValueChange, suffix, ...rest }) {
  const [text, setText] = useState(() => centsToText(value));
  const last = useRef(value ?? null);
  useEffect(() => {
    if ((value ?? null) !== last.current) {
      last.current = value ?? null;
      setText(centsToText(value));
    }
  }, [value]);
  return (
    <Input
      inputMode="decimal"
      autoComplete="off"
      icon={<span className="fin-money__cur">R$</span>}
      suffix={suffix}
      placeholder="0,00"
      value={text}
      onChange={(event) => {
        const next = event.target.value.replace(/[^\d.,]/g, "");
        setText(next);
        const cents = parseMoney(next);
        last.current = cents;
        onValueChange?.(cents);
      }}
      onBlur={() => setText(centsToText(last.current))}
      {...rest}
    />
  );
}

// R$ 1.500,00 with a light display face; `per` adds "/mês".
export function Amount({ cents, size = "md", per, className }) {
  if (cents === null || cents === undefined) return <span className={cx("fin-amount", className)}>—</span>;
  const [int, dec] = centsToText(cents).split(",");
  return (
    <span className={cx("fin-amount", `fin-amount--${size}`, className)}>
      <span className="ui-sr-only">
        {formatMoney(cents)}
        {per ? ` por ${per}` : ""}
      </span>
      <span className="fin-amount__cur" aria-hidden="true">
        R$
      </span>
      <span className="fin-amount__int" aria-hidden="true">
        {int}
      </span>
      <span className="fin-amount__dec" aria-hidden="true">
        ,{dec}
      </span>
      {per && (
        <em className="fin-amount__per" aria-hidden="true">
          /{per}
        </em>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- notices

// Tinted note with an icon. tone: neutral | amber | red | olive | slate | teal.
export function Callout({ tone = "neutral", icon, title, children, actions, className, live = false, index }) {
  return (
    <div
      className={cx("fin-callout", `ui-tone--${tone}`, index !== undefined && "ui-enter", className)}
      role={live ? (tone === "red" ? "alert" : "status") : undefined}
      style={index !== undefined ? { "--i": index } : undefined}
    >
      {icon && <span className="fin-callout__icon">{renderIcon(icon, { size: 18 })}</span>}
      <div className="fin-callout__body">
        {title && <p className="fin-callout__title">{title}</p>}
        {children && <div className="fin-callout__text">{children}</div>}
        {actions && <div className="fin-callout__actions">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * Explains a failed Mercado Pago action for the team: missing credentials
 * (with the path to set them up), upstream trouble (with retry) or anything else.
 */
export function MpErrorNotice({ error, onRetry, retrying = false, canConfigure = false, onDismiss }) {
  if (!error) return null;
  if (error.code === "integration_not_configured")
    return (
      <Callout
        live
        tone="amber"
        icon={PlugZap}
        title="Mercado Pago não configurado"
        actions={
          <>
            {canConfigure && (
              <Button size="sm" variant="secondary" to="/admin/financeiro#mercado-pago">
                Ver passo a passo
              </Button>
            )}
            {onDismiss && (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Entendi
              </Button>
            )}
          </>
        }
      >
        Defina <code>MP_ACCESS_TOKEN</code> e <code>MP_WEBHOOK_SECRET</code> no servidor e reinicie a aplicação. Até lá,
        nenhum link de pagamento é gerado e nada é cobrado.
      </Callout>
    );
  const upstreamTrouble = error.code === "upstream_error" || error.code === "network";
  return (
    <Callout
      live
      tone="red"
      icon={upstreamTrouble ? CloudOff : CircleAlert}
      title={upstreamTrouble ? "O Mercado Pago não respondeu como esperado" : "Não foi possível concluir"}
      actions={
        onRetry && (
          <Button size="sm" variant="secondary" icon={RefreshCw} loading={retrying} onClick={onRetry}>
            Tentar de novo
          </Button>
        )
      }
    >
      {error.message}
    </Callout>
  );
}

// ---------------------------------------------------------------- timeline

const ACTION_ICONS = {
  "order.created": Receipt,
  "order.updated": Receipt,
  "order.checkout_created": Link2,
  "order.checkout_opened": CreditCard,
  "order.sent": Send,
  "order.cancelled": Ban,
  "payment.approved": CircleCheck,
  "payment.rejected": CircleX,
  "payment.pending": RefreshCw,
  "payment.refunded": Undo2,
  "payment.charged_back": CircleAlert,
  "payment.approved_after_cancel": CircleAlert,
  "subscription.created": Receipt,
  "subscription.checkout_created": Link2,
  "subscription.sent": Send,
  "subscription.active": BadgeCheck,
  "subscription.paused": CircleAlert,
  "subscription.cancelled": Ban,
  "subscription.payment_approved": CircleCheck,
  "subscription.payment_failed": CircleX,
};

const ACTION_TONES = {
  "payment.approved": "olive",
  "subscription.active": "olive",
  "subscription.payment_approved": "olive",
  "payment.rejected": "red",
  "subscription.payment_failed": "red",
  "payment.charged_back": "red",
  "payment.approved_after_cancel": "amber",
  "order.cancelled": "neutral",
  "subscription.cancelled": "neutral",
};

// Activity entries of one order/subscription, oldest first.
export function Timeline({ items = [], empty = "Nada registrado ainda.", systemLabel = "Mercado Pago" }) {
  if (!items.length) return <p className="fin-quiet">{empty}</p>;
  return (
    <ol className="fin-timeline">
      {items.map((item, index) => {
        const system = !item.actor;
        return (
          <li
            key={item.id}
            className={cx("fin-timeline__item", "ui-enter", `is-${ACTION_TONES[item.action] ?? "base"}`)}
            style={{ "--i": Math.min(index, 8) }}
          >
            <span className="fin-timeline__dot" aria-hidden="true">
              <Icon icon={ACTION_ICONS[item.action] ?? Receipt} size={13} />
            </span>
            <div className="fin-timeline__body">
              <p className="fin-timeline__text">{item.summary}</p>
              <p className="fin-timeline__meta">
                <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                <span aria-hidden="true"> · </span>
                <span>{system ? systemLabel : item.actor.name}</span>
                {item.visibility === "client" && <span className="fin-timeline__seen">visível ao cliente</span>}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- payments

export function PaymentRows({ payments = [], showTarget = false, empty }) {
  if (!payments.length)
    return <p className="fin-quiet">{empty ?? "Nenhuma tentativa de pagamento registrada ainda."}</p>;
  return (
    <ul className="fin-payrows">
      {payments.map((payment, index) => (
        <li key={payment.id} className="fin-payrow ui-enter" style={{ "--i": Math.min(index, 8) }}>
          <div className="fin-payrow__main">
            <div className="fin-payrow__top">
              <StatusBadge kind="payment" value={payment.status} size="sm" />
              {payment.methodLabel && <span className="fin-payrow__method">{payment.methodLabel}</span>}
            </div>
            {showTarget && (payment.order || payment.subscription) && (
              <p className="fin-payrow__target">{payment.order?.description ?? payment.subscription?.name}</p>
            )}
            {payment.reason && payment.status !== "approved" && <p className="fin-payrow__reason">{payment.reason}</p>}
            <p className="fin-payrow__meta">
              {formatDateTime(payment.paidAt ?? payment.updatedAt ?? payment.createdAt)}
              {payment.providerPaymentId && <span> · Nº {payment.providerPaymentId}</span>}
            </p>
          </div>
          <Amount cents={payment.amountCents} size="sm" />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- facts list

// [{label, value, hint}] as a hairline definition list.
export function Facts({ items, className }) {
  const rows = items.filter(
    (item) => item && item.value !== undefined && item.value !== null && item.value !== "" && item.value !== false,
  );
  return (
    <dl className={cx("fin-facts", className)}>
      {rows.map((item) => (
        <div key={item.label} className="fin-facts__row">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const dueText = (dueDate, overdue) => {
  if (!dueDate) return null;
  return overdue ? `Venceu em ${formatDate(dueDate)}` : `Vence em ${formatDate(dueDate)}`;
};

export function SectionTitle({ children, aside, id }) {
  return (
    <div className="fin-section__head">
      <h3 className="fin-section__title" id={id}>
        {children}
      </h3>
      {aside}
    </div>
  );
}

export function ExternalLinkButton({ href, children = "Abrir", size = "sm" }) {
  return (
    <Button size={size} variant="ghost" href={href} target="_blank" rel="noopener noreferrer" icon="external">
      {children}
    </Button>
  );
}

export function QuietLink({ to, children }) {
  return (
    <Link to={to} className="ui-link">
      {children}
    </Link>
  );
}

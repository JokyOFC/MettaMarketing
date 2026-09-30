// Mercado Pago: fetch-based API client, webhook signature check, pt-BR
// reasons and the reconciliation rules that move orders and subscriptions.
// State only changes after the payment/preapproval is fetched from the API
// with our own credentials (webhooks are hints, never the source of truth).

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { logActivity } from "../lib/audit.js";
import { newId } from "../lib/ids.js";
import { notConfigured, upstream } from "../lib/errors.js";
import { clientUserIds, notify } from "../lib/notify.js";
import { now } from "../lib/time.js";
import { contractsReady } from "./contracts.js";

export const MESSAGES = {
  notConfigured: "Mercado Pago não configurado. Defina as credenciais no servidor para gerar cobranças.",
  clientNotConfigured: "Pagamento online indisponível no momento. Fale com a Metta.",
  rejectedCredentials: "Credenciais do Mercado Pago recusadas. Confira o Access Token configurado no servidor.",
  unavailable: "Mercado Pago indisponível no momento. Tente de novo.",
};

const DEFAULT_TIMEOUT_MS = 10_000;

// ------------------------------------------------------------------ config

export function mpSettings(config) {
  const mp = config.mercadopago ?? {};
  return {
    token: mp.accessToken ?? config.mpAccessToken ?? null,
    secret: mp.webhookSecret ?? config.mpWebhookSecret ?? null,
    apiBase: String(mp.apiBase ?? config.mpApiBase ?? "https://api.mercadopago.com").replace(/\/+$/, ""),
  };
}

// TEST- access tokens belong to the sandbox; everything else is production.
export function modeForToken(token) {
  if (!token) return null;
  return /^TEST-/i.test(String(token)) ? "test" : "production";
}

export const webhookUrl = (config) => `${config.appUrl}/api/webhooks/mercadopago`;

// Mercado Pago only reaches public HTTPS addresses (notifications, auto return).
export function isPublicUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:") return false;
    return !/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|\[::1\]|::1)/i.test(hostname) && !hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function mpStatus(config) {
  const { token, secret } = mpSettings(config);
  return {
    configured: Boolean(token),
    mode: modeForToken(token),
    webhookSecretConfigured: Boolean(secret),
    webhookUrl: webhookUrl(config),
    publicUrl: isPublicUrl(config.appUrl),
  };
}

// ------------------------------------------------------------------ client

function summarize(data) {
  if (!data || typeof data !== "object") return "";
  const cause = Array.isArray(data.cause) ? data.cause.find((c) => c?.description) : null;
  const text = String(cause?.description || data.message || data.error || "").trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function mpError(message, extra = {}) {
  return Object.assign(upstream(message), extra);
}

/**
 * mpRequest(ctx, method, path, { body, query, idempotencyKey }) -> parsed JSON.
 * Errors: 503 integration_not_configured (no token), 502 upstream_error
 * (rejected credentials, timeout/network, MP validation message summarized).
 */
export async function mpRequest(ctx, method, path, { body, query, idempotencyKey } = {}) {
  const { token, apiBase } = mpSettings(ctx.config);
  if (!token) throw notConfigured(MESSAGES.notConfigured);
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(query ?? {}))
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;

  const controller = new AbortController();
  const timeoutMs = Number(ctx.config.mpTimeoutMs) || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text = "";
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (err) {
    const timedOut = controller.signal.aborted;
    ctx.log?.warn?.(`[mercadopago] ${method} ${path} ${timedOut ? "timed out" : `failed: ${err?.message ?? err}`}`);
    throw mpError(MESSAGES.unavailable, { mpStatus: 0, mpTimeout: timedOut });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (response.ok) return data ?? {};

  const status = response.status;
  ctx.log?.warn?.(`[mercadopago] ${method} ${path} -> ${status}`);
  if (status === 401 || status === 403) throw mpError(MESSAGES.rejectedCredentials, { mpStatus: status });
  if (status >= 500 || status === 429) throw mpError(MESSAGES.unavailable, { mpStatus: status });
  const summary = summarize(data);
  throw mpError(`O Mercado Pago recusou a solicitação${summary ? `: ${summary}` : "."}`, { mpStatus: status });
}

const checkoutLink = (ctx, data) =>
  modeForToken(mpSettings(ctx.config).token) === "test"
    ? data.sandbox_init_point || data.init_point
    : data.init_point || data.sandbox_init_point;

const backUrl = (ctx, result) => `${ctx.config.appUrl}/painel/financeiro?retorno=${result}`;

// Checkout Pro preference for a one-off order -> { id, url }.
export async function createPreference(ctx, order) {
  const body = {
    items: [
      {
        id: order.id,
        title: String(order.description).slice(0, 250),
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(order.amount_cents) / 100,
      },
    ],
    external_reference: order.external_reference,
    back_urls: {
      success: backUrl(ctx, "sucesso"),
      pending: backUrl(ctx, "pendente"),
      failure: backUrl(ctx, "falha"),
    },
    statement_descriptor: "METTA MARKETING",
    metadata: { order_id: order.id },
  };
  // Local addresses are refused by Mercado Pago for these two fields.
  if (isPublicUrl(ctx.config.appUrl)) {
    body.auto_return = "approved";
    body.notification_url = webhookUrl(ctx.config);
  }
  const data = await mpRequest(ctx, "POST", "/checkout/preferences", { body, idempotencyKey: randomUUID() });
  const url = checkoutLink(ctx, data);
  if (!data.id || !url) throw mpError("O Mercado Pago não devolveu o link de pagamento. Tente de novo.");
  return { id: String(data.id), url };
}

// Monthly preapproval (subscription) -> { id, url, status }.
export async function createPreapproval(ctx, subscription, service) {
  const body = {
    reason: `${service.name} · Metta Marketing`.slice(0, 250),
    external_reference: subscription.external_reference,
    payer_email: subscription.payer_email,
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: Number(subscription.amount_cents) / 100,
      currency_id: "BRL",
    },
    back_url: backUrl(ctx, "assinatura"),
    status: "pending",
  };
  const data = await mpRequest(ctx, "POST", "/preapproval", { body, idempotencyKey: randomUUID() });
  const url = data.init_point || data.sandbox_init_point;
  if (!data.id || !url) throw mpError("O Mercado Pago não devolveu o link de autorização. Tente de novo.");
  return { id: String(data.id), url, status: data.status ?? "pending" };
}

export const getPayment = (ctx, id) => mpRequest(ctx, "GET", `/v1/payments/${encodeURIComponent(id)}`);
export const getPreapproval = (ctx, id) => mpRequest(ctx, "GET", `/preapproval/${encodeURIComponent(id)}`);
export const getAuthorizedPayment = (ctx, id) =>
  mpRequest(ctx, "GET", `/authorized_payments/${encodeURIComponent(id)}`);

export const cancelPreapproval = (ctx, id) =>
  mpRequest(ctx, "PUT", `/preapproval/${encodeURIComponent(id)}`, { body: { status: "cancelled" } });

// Stops an old checkout link from accepting new payments (best effort).
export const expirePreference = (ctx, id) =>
  mpRequest(ctx, "PUT", `/checkout/preferences/${encodeURIComponent(id)}`, {
    body: { expires: true, expiration_date_to: new Date().toISOString() },
  });

export async function searchPayments(ctx, externalReference) {
  const data = await mpRequest(ctx, "GET", "/v1/payments/search", {
    query: { external_reference: externalReference, sort: "date_created", criteria: "asc", limit: 50 },
  });
  return Array.isArray(data?.results) ? data.results : [];
}

// ------------------------------------------------------------------ signature

export function parseSignatureHeader(header) {
  const out = {};
  for (const part of String(header ?? "").split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    out[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
  }
  return out;
}

/**
 * x-signature "ts=…,v1=…": v1 = HMAC-SHA256(secret, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;")
 * data.id is lower-cased when alphanumeric; absent values leave their part out.
 * -> { valid, reason: null | 'secret_missing' | 'missing' | 'mismatch' }
 */
export function verifySignature({ secret, header, requestId, dataId }) {
  if (!secret) return { valid: false, reason: "secret_missing" };
  const { ts, v1 } = parseSignatureHeader(header);
  if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return { valid: false, reason: "missing" };
  let id = dataId === undefined || dataId === null || dataId === "" ? null : String(dataId);
  if (id && /^[a-z0-9]+$/i.test(id)) id = id.toLowerCase();
  let manifest = "";
  if (id) manifest += `id:${id};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  const expected = Buffer.from(createHmac("sha256", secret).update(manifest).digest("hex"), "utf8");
  const given = Buffer.from(v1.toLowerCase(), "utf8");
  const valid = expected.length === given.length && timingSafeEqual(expected, given);
  return { valid, reason: valid ? null : "mismatch" };
}

export function signManifest(secret, { dataId, requestId, ts }) {
  let id = dataId ? String(dataId) : null;
  if (id && /^[a-z0-9]+$/i.test(id)) id = id.toLowerCase();
  let manifest = "";
  if (id) manifest += `id:${id};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  return `ts=${ts},v1=${createHmac("sha256", secret).update(manifest).digest("hex")}`;
}

// ------------------------------------------------------------------ pt-BR vocabulary

const DETAIL_REASONS = {
  cc_rejected_insufficient_amount: "Saldo ou limite insuficiente",
  cc_rejected_bad_filled_security_code: "Código de segurança do cartão inválido",
  cc_rejected_bad_filled_date: "Data de validade do cartão inválida",
  cc_rejected_bad_filled_card_number: "Número do cartão inválido",
  cc_rejected_bad_filled_other: "Dados do cartão incorretos",
  cc_rejected_call_for_authorize: "O banco pediu autorização do titular para este pagamento",
  cc_rejected_card_disabled: "Cartão desativado. Fale com o banco emissor",
  cc_rejected_card_error: "Não foi possível processar o cartão",
  cc_rejected_duplicated_payment: "Pagamento duplicado: já existe um pagamento igual recente",
  cc_rejected_high_risk: "Recusado pela análise de segurança do Mercado Pago",
  cc_rejected_max_attempts: "Limite de tentativas atingido. Use outro cartão",
  cc_rejected_invalid_installments: "Parcelamento não aceito para este cartão",
  cc_rejected_blacklist: "Recusado pelo Mercado Pago",
  cc_rejected_other_reason: "O banco emissor recusou o pagamento",
  cc_rejected_card_type_not_allowed: "Tipo de cartão não aceito",
  cc_amount_rate_limit_exceeded: "Limite do meio de pagamento excedido",
  rejected_by_bank: "O banco recusou o pagamento",
  rejected_by_regulations: "Recusado por regras do meio de pagamento",
  rejected_insufficient_data: "Dados insuficientes para aprovar o pagamento",
  rejected_high_risk: "Recusado pela análise de segurança do Mercado Pago",
  rejected_other_reason: "O pagamento foi recusado",
  bank_error: "Erro no banco ao processar o pagamento",
  expired: "O prazo para pagamento expirou",
  by_collector: "Cancelado pela Metta",
  by_payer: "Cancelado pelo pagador",
  by_admin: "Cancelado pelo Mercado Pago",
  pending_waiting_payment: "Aguardando o pagamento (Pix ou boleto)",
  pending_waiting_transfer: "Aguardando a transferência",
  pending_contingency: "Em processamento pelo Mercado Pago",
  pending_review_manual: "Em análise pelo Mercado Pago",
  pending_challenge: "Aguardando confirmação do titular",
  refunded: "Valor estornado",
  partially_refunded: "Valor parcialmente estornado",
  settled: "Contestação resolvida",
  in_process: "Em análise",
};

const STATUS_REASONS = {
  rejected: "Pagamento recusado pelo Mercado Pago",
  cancelled: "Pagamento cancelado",
  refunded: "Valor estornado",
  charged_back: "Pagamento contestado no cartão",
  in_mediation: "Pagamento em disputa",
};

// Short pt-BR explanation for a payment status/status_detail (null when approved).
export function paymentReason(status, statusDetail) {
  if (status === "approved" || status === "authorized") return null;
  if (statusDetail && DETAIL_REASONS[statusDetail]) return DETAIL_REASONS[statusDetail];
  return STATUS_REASONS[status] ?? null;
}

const TYPE_LABELS = {
  credit_card: "Cartão de crédito",
  debit_card: "Cartão de débito",
  prepaid_card: "Cartão pré-pago",
  ticket: "Boleto",
  bank_transfer: "Transferência",
  account_money: "Saldo no Mercado Pago",
  digital_currency: "Linha de crédito",
  digital_wallet: "Carteira digital",
  atm: "Pagamento em lotérica",
};

// Stored as "<payment_type_id>/<payment_method_id>".
export function methodLabel(method) {
  if (!method) return null;
  const [type, id] = String(method).split("/");
  if (id === "pix" || type === "pix") return "Pix";
  const base = TYPE_LABELS[type] ?? "Mercado Pago";
  if ((type === "credit_card" || type === "debit_card") && id) return `${base} (${id.charAt(0).toUpperCase()}${id.slice(1)})`;
  return base;
}

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const formatBRL = (cents) => money.format(Number(cents || 0) / 100);

export function formatDateBR(date) {
  if (!date) return "";
  const [y, m, d] = String(date).slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : String(date);
}

// ------------------------------------------------------------------ reconciliation

// Admins and the finance team: they follow every charge.
export async function financeTeamIds(db) {
  return (await db
    .all("SELECT id FROM users WHERE role IN ('admin', 'finance') AND status = 'active'"))
    .map((row) => row.id);
}

// Mercado Pago dates carry offsets ("…-04:00"); store UTC ISO so ranges compare.
export function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const toCents = (value) => (value === undefined || value === null ? null : Math.round(Number(value) * 100));

const paymentMethod = (payment) =>
  [payment.payment_type_id, payment.payment_method_id].filter(Boolean).join("/") || null;

// A small, non-personal subset of the payment kept for audit.
function rawSubset(payment) {
  return JSON.stringify({
    id: payment.id,
    status: payment.status,
    status_detail: payment.status_detail,
    transaction_amount: payment.transaction_amount,
    currency_id: payment.currency_id,
    payment_type_id: payment.payment_type_id,
    payment_method_id: payment.payment_method_id,
    installments: payment.installments,
    date_created: payment.date_created,
    date_approved: payment.date_approved,
    date_last_updated: payment.date_last_updated,
    external_reference: payment.external_reference,
    live_mode: payment.live_mode,
  });
}

function preapprovalIdOf(payment) {
  return (
    payment?.metadata?.preapproval_id ??
    payment?.point_of_interaction?.transaction_data?.subscription_id ??
    null
  );
}

// Finds the order or subscription a payment belongs to.
export async function resolveReference(db, { externalReference, preapprovalId }) {
  if (externalReference) {
    const order = await db.get("SELECT * FROM orders WHERE external_reference = ?", [String(externalReference)]);
    if (order) return { order };
    const subscription = await db.get("SELECT * FROM subscriptions WHERE external_reference = ?", [String(externalReference)]);
    if (subscription) return { subscription };
  }
  if (preapprovalId) {
    const subscription = await db.get("SELECT * FROM subscriptions WHERE mp_preapproval_id = ?", [String(preapprovalId)]);
    if (subscription) return { subscription };
  }
  return {};
}

export class ReconcileError extends Error {}

const clientLink = "/painel/financeiro";
// Appended to the client's confirmation when a site purchase gets its contract next.
const CONTRACT_NEXT = " Em instantes o contrato chega para você assinar na área Financeiro, na seção Contratos.";
const orderLink = (id) => `/admin/pedidos?pedido=${id}`;
const subscriptionLink = (id) => `/admin/pedidos?aba=assinaturas&assinatura=${id}`;

/**
 * Applies a payment fetched from the API. Upserts the payments row and moves
 * the order (approved -> paid, rejected/cancelled -> failed with reason,
 * pending/in_process -> pending_payment, refunded -> refunded). Notifies and
 * logs only when something actually changed. -> { kind, id, changed }
 * Throws ReconcileError for references that do not belong to this platform.
 */
export async function applyPayment(ctx, payment, { preapprovalId = null } = {}) {
  const { db } = ctx;
  const ref = await resolveReference(db, {
    externalReference: payment.external_reference,
    preapprovalId: preapprovalId ?? preapprovalIdOf(payment),
  });
  if (!ref.order && !ref.subscription)
    throw new ReconcileError(
      `Referência desconhecida (${payment.external_reference || "sem external_reference"}): pagamento ${payment.id} não pertence a um pedido ou assinatura da plataforma.`,
    );

  const status = String(payment.status ?? "unknown");
  const detail = payment.status_detail ? String(payment.status_detail) : null;
  const amount = toCents(payment.transaction_amount);
  const paidAt = status === "approved" ? (toIso(payment.date_approved) ?? now()) : null;
  const at = now();
  const order = ref.order ?? null;
  const subscription = ref.subscription ?? null;
  const clientId = order?.client_id ?? subscription?.client_id ?? null;

  return await db.tx(async () => {
    const previous = await db.get("SELECT * FROM payments WHERE provider = 'mercadopago' AND provider_payment_id = ?", [
      String(payment.id),
    ]);
    if (previous) {
      await db.run(
        `UPDATE payments SET status = ?, status_detail = ?, amount_cents = ?, method = ?, paid_at = COALESCE(?, paid_at),
           raw = ?, order_id = COALESCE(order_id, ?), subscription_id = COALESCE(subscription_id, ?),
           client_id = COALESCE(client_id, ?), updated_at = ?
         WHERE id = ?`,
        [status, detail, amount, paymentMethod(payment), paidAt, rawSubset(payment), order?.id, subscription?.id, clientId, at, previous.id],
      );
    } else {
      await db.run(
        `INSERT INTO payments (id, provider, provider_payment_id, order_id, subscription_id, client_id, status,
           status_detail, amount_cents, method, paid_at, raw, created_at, updated_at)
         VALUES (?, 'mercadopago', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId("pay"),
          String(payment.id),
          order?.id,
          subscription?.id,
          clientId,
          status,
          detail,
          amount,
          paymentMethod(payment),
          paidAt,
          rawSubset(payment),
          at,
          at,
        ],
      );
    }
    const statusChanged = !previous || previous.status !== status;
    if (order) return { kind: "order", id: order.id, changed: await applyToOrder(ctx, order, { status, detail, amount, paidAt, statusChanged }) };
    return {
      kind: "subscription",
      id: subscription.id,
      changed: await applyToSubscriptionPayment(ctx, subscription, { status, detail, amount, statusChanged }),
    };
  });
}

async function applyToOrder(ctx, order, { status, detail, amount, paidAt, statusChanged }) {
  const { db } = ctx;
  const at = now();
  const label = `${order.description} (${formatBRL(amount ?? order.amount_cents)})`;
  const client = await db.get("SELECT name FROM clients WHERE id = ?", [order.client_id]);
  const staffTitle = (text) => `${text} · ${client?.name ?? "Cliente"}`;
  const base = { entityType: "order", entityId: order.id, clientId: order.client_id, brandId: order.brand_id };

  if (status === "approved") {
    if (order.status === "paid") return false;
    if (order.status === "cancelled" || order.status === "refunded") {
      // Money arrived through an old link: keep the decision visible to finance.
      if (!statusChanged) return false;
      await logActivity(ctx, {
        ...base,
        action: "payment.approved_after_cancel",
        summary: `Pagamento aprovado para pedido ${order.status === "cancelled" ? "cancelado" : "estornado"}: ${label}. Verifique se é preciso estornar.`,
        data: { amountCents: amount },
      });
      await notify(ctx, await financeTeamIds(db), {
        type: "payment.attention",
        title: staffTitle("Pagamento recebido em pedido cancelado"),
        body: `${label}. Confira no Mercado Pago se é preciso estornar.`,
        link: orderLink(order.id),
        entityType: "order",
        entityId: order.id,
        email: true,
      });
      return false;
    }
    await db.run("UPDATE orders SET status = 'paid', paid_at = ?, failure_reason = NULL, updated_at = ? WHERE id = ?", [
      paidAt ?? at,
      at,
      order.id,
    ]);
    // Bought on the site: the contract comes now, after the payment (after the commit).
    const fromSite = Boolean(order.contract_after_payment);
    if (fromSite) ctx.jobs?.enqueue("contracts.after_payment", { orderId: order.id });
    const contractNext = fromSite && (await contractsReady(ctx));
    await logActivity(ctx, {
      ...base,
      action: "payment.approved",
      summary: `Pagamento confirmado: ${label}`,
      data: { amountCents: amount },
      visibility: "client",
    });
    await notify(ctx, await clientUserIds(db, order.client_id), {
      type: "payment.approved",
      title: "Pagamento confirmado",
      body: `Recebemos o pagamento de ${formatBRL(amount ?? order.amount_cents)} referente a ${order.description}. Obrigado!${
        contractNext ? CONTRACT_NEXT : ""
      }`,
      link: clientLink,
      entityType: "order",
      entityId: order.id,
      email: true,
      emailLines: [
        ["Descrição", order.description],
        ["Valor", formatBRL(amount ?? order.amount_cents)],
      ],
      actionLabel: "Ver financeiro",
    });
    await notify(ctx, await financeTeamIds(db), {
      type: "payment.approved",
      title: staffTitle(fromSite ? "Nova compra pelo site" : "Pagamento aprovado"),
      body: fromSite
        ? `Pagamento confirmado pelo site: ${label}.${contractNext ? " O contrato segue automaticamente para o cliente assinar." : ""}`
        : label,
      link: orderLink(order.id),
      entityType: "order",
      entityId: order.id,
      email: true,
    });
    return true;
  }

  if (status === "rejected" || status === "cancelled") {
    // Old attempts that did not change never pull a newer link back to failed.
    if (!statusChanged || !["draft", "pending_payment", "failed"].includes(order.status)) return false;
    const reason = paymentReason(status, detail) ?? "Pagamento não aprovado";
    await db.run("UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", [reason, at, order.id]);
    await logActivity(ctx, {
      ...base,
      action: "payment.rejected",
      summary: `Pagamento não aprovado: ${label}. Motivo: ${reason}`,
      data: { amountCents: amount, statusDetail: detail },
      visibility: "client",
    });
    await notify(ctx, await clientUserIds(db, order.client_id), {
      type: "payment.failed",
      title: "Pagamento não aprovado",
      body: `${reason}. Você pode tentar de novo em Financeiro, com outro cartão ou via Pix.`,
      link: clientLink,
      entityType: "order",
      entityId: order.id,
      email: true,
      emailLines: [
        ["Descrição", order.description],
        ["Valor", formatBRL(order.amount_cents)],
        ["Motivo", reason],
      ],
      actionLabel: "Tentar de novo",
    });
    await notify(ctx, await financeTeamIds(db), {
      type: "payment.failed",
      title: staffTitle("Pagamento recusado"),
      body: `${label}. Motivo: ${reason}`,
      link: orderLink(order.id),
      entityType: "order",
      entityId: order.id,
      email: true,
    });
    return true;
  }

  if (status === "pending" || status === "in_process" || status === "authorized") {
    if (!statusChanged || !["draft", "failed"].includes(order.status)) return false;
    await db.run("UPDATE orders SET status = 'pending_payment', failure_reason = NULL, updated_at = ? WHERE id = ?", [at, order.id]);
    await logActivity(ctx, {
      ...base,
      action: "payment.pending",
      summary: `Pagamento em processamento: ${label}. ${paymentReason(status, detail) ?? ""}`.trim(),
      data: { statusDetail: detail },
    });
    return true;
  }

  if (status === "refunded" || status === "charged_back") {
    if (order.status !== "paid") return false;
    await db.run("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?", [at, order.id]);
    const what = status === "refunded" ? "Pagamento estornado" : "Pagamento contestado";
    await logActivity(ctx, { ...base, action: `payment.${status}`, summary: `${what}: ${label}`, visibility: "client" });
    await notify(ctx, await financeTeamIds(db), {
      type: `payment.${status}`,
      title: staffTitle(what),
      body: label,
      link: orderLink(order.id),
      entityType: "order",
      entityId: order.id,
      email: true,
    });
    return true;
  }
  return false;
}

async function applyToSubscriptionPayment(ctx, subscription, { status, detail, amount, statusChanged }) {
  const { db } = ctx;
  if (!statusChanged) return false;
  const at = now();
  const service = await db.get("SELECT name FROM services WHERE id = ?", [subscription.service_id]);
  const label = `${service?.name ?? "Assinatura"} (${formatBRL(amount ?? subscription.amount_cents)})`;
  const base = { entityType: "subscription", entityId: subscription.id, clientId: subscription.client_id };
  if (status === "approved") {
    await db.run("UPDATE subscriptions SET failure_reason = NULL, updated_at = ? WHERE id = ?", [at, subscription.id]);
    await logActivity(ctx, {
      ...base,
      action: "subscription.payment_approved",
      summary: `Mensalidade paga: ${label}`,
      visibility: "client",
    });
    await notify(ctx, await financeTeamIds(db), {
      type: "payment.approved",
      title: "Mensalidade recebida",
      body: label,
      link: subscriptionLink(subscription.id),
      entityType: "subscription",
      entityId: subscription.id,
    });
    return true;
  }
  if (status === "rejected" || status === "cancelled") {
    const reason = paymentReason(status, detail) ?? "Cobrança não aprovada";
    await db.run("UPDATE subscriptions SET failure_reason = ?, updated_at = ? WHERE id = ?", [
      `Última cobrança não aprovada: ${reason}`,
      at,
      subscription.id,
    ]);
    await logActivity(ctx, {
      ...base,
      action: "subscription.payment_failed",
      summary: `Mensalidade não aprovada: ${label}. Motivo: ${reason}`,
      visibility: "client",
    });
    await notify(ctx, await clientUserIds(db, subscription.client_id), {
      type: "payment.failed",
      title: "Mensalidade não aprovada",
      body: `${reason}. O Mercado Pago tenta a cobrança de novo; se preferir, atualize o cartão na sua conta do Mercado Pago.`,
      link: clientLink,
      entityType: "subscription",
      entityId: subscription.id,
      email: true,
    });
    await notify(ctx, await financeTeamIds(db), {
      type: "payment.failed",
      title: "Mensalidade recusada",
      body: `${label}. Motivo: ${reason}`,
      link: subscriptionLink(subscription.id),
      entityType: "subscription",
      entityId: subscription.id,
      email: true,
    });
    return true;
  }
  return false;
}

const PREAPPROVAL_STATUS = { authorized: "active", paused: "paused", cancelled: "cancelled", pending: "pending" };

/**
 * Applies a preapproval fetched from the API: authorized -> active, paused,
 * cancelled. -> { kind, id, changed }
 */
export async function applyPreapproval(ctx, preapproval) {
  const { db } = ctx;
  let subscription = preapproval.external_reference
    ? await db.get("SELECT * FROM subscriptions WHERE external_reference = ?", [String(preapproval.external_reference)])
    : null;
  subscription ??= await db.get("SELECT * FROM subscriptions WHERE mp_preapproval_id = ?", [String(preapproval.id)]);
  if (!subscription)
    throw new ReconcileError(
      `Referência desconhecida (${preapproval.external_reference || "sem external_reference"}): assinatura ${preapproval.id} não pertence à plataforma.`,
    );

  const next = PREAPPROVAL_STATUS[preapproval.status];
  if (!next) return { kind: "subscription", id: subscription.id, changed: false };
  // An older, replaced authorization link that was cancelled says nothing about this subscription.
  const sameLink = !subscription.mp_preapproval_id || subscription.mp_preapproval_id === String(preapproval.id);
  if (!sameLink && next !== "active") return { kind: "subscription", id: subscription.id, changed: false };

  const at = now();
  const nextBilling = preapproval.next_payment_date ? String(preapproval.next_payment_date).slice(0, 10) : null;
  return await db.tx(async () => {
    await db.run(
      `UPDATE subscriptions SET mp_preapproval_id = ?, next_billing_date = COALESCE(?, next_billing_date), updated_at = ? WHERE id = ?`,
      [String(preapproval.id), nextBilling, at, subscription.id],
    );
    if (subscription.status === next || (subscription.status === "cancelled" && next !== "cancelled"))
      return { kind: "subscription", id: subscription.id, changed: false };

    const service = await db.get("SELECT name FROM services WHERE id = ?", [subscription.service_id]);
    const client = await db.get("SELECT name FROM clients WHERE id = ?", [subscription.client_id]);
    const name = service?.name ?? "Assinatura";
    const base = { entityType: "subscription", entityId: subscription.id, clientId: subscription.client_id };
    // Bought on the site: the contract comes once the plan is authorized.
    const fromSite = Boolean(subscription.contract_after_payment);
    if (next === "active") {
      await db.run(
        `UPDATE subscriptions SET status = 'active', started_at = COALESCE(started_at, ?), failure_reason = NULL, updated_at = ? WHERE id = ?`,
        [toIso(preapproval.date_created) ?? at, at, subscription.id],
      );
      if (fromSite) ctx.jobs?.enqueue("contracts.after_payment", { subscriptionId: subscription.id });
    } else if (next === "cancelled") {
      await db.run("UPDATE subscriptions SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?), updated_at = ? WHERE id = ?", [
        at,
        at,
        subscription.id,
      ]);
    } else {
      await db.run("UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?", [next, at, subscription.id]);
    }
    const copy = {
      active: ["Assinatura ativa", `A assinatura ${name} (${formatBRL(subscription.amount_cents)}/mês) foi autorizada no Mercado Pago.`],
      paused: ["Assinatura pausada", `A assinatura ${name} foi pausada no Mercado Pago.`],
      cancelled: ["Assinatura cancelada", `A assinatura ${name} foi cancelada no Mercado Pago.`],
      pending: ["Assinatura aguardando autorização", `A assinatura ${name} aguarda autorização no Mercado Pago.`],
    }[next];
    await logActivity(ctx, {
      ...base,
      action: `subscription.${next}`,
      summary: copy[1],
      visibility: next === "pending" ? "internal" : "client",
    });
    if (next !== "pending") {
      const newSale = fromSite && next === "active" && subscription.status === "pending";
      const contractNext = newSale && (await contractsReady(ctx));
      await notify(ctx, await clientUserIds(db, subscription.client_id), {
        type: `subscription.${next}`,
        title: copy[0],
        body: `${copy[1]}${contractNext ? CONTRACT_NEXT : ""}`,
        link: clientLink,
        entityType: "subscription",
        entityId: subscription.id,
        email: true,
      });
      await notify(ctx, await financeTeamIds(db), {
        type: `subscription.${next}`,
        title: `${newSale ? "Nova assinatura pelo site" : copy[0]} · ${client?.name ?? "Cliente"}`,
        body: newSale
          ? `${copy[1]} Contratada pelo site.${contractNext ? " O contrato segue automaticamente para o cliente assinar." : ""}`
          : copy[1],
        link: subscriptionLink(subscription.id),
        entityType: "subscription",
        entityId: subscription.id,
        // A new sale from the site is news for the team; a routine authorization is not.
        email: next !== "active" || newSale,
      });
    }
    return { kind: "subscription", id: subscription.id, changed: true };
  });
}

// ------------------------------------------------------------------ webhook processing

const TOPICS = {
  payment: "payment",
  subscription_preapproval: "preapproval",
  preapproval: "preapproval",
  subscription_authorized_payment: "authorized_payment",
  authorized_payment: "authorized_payment",
};
export const topicKind = (topic) => TOPICS[String(topic ?? "")] ?? null;

/**
 * Confirms a notification against the API and applies it. Records
 * processed_at and error on the webhook_events row; never throws.
 */
export async function processWebhookEvent(ctx, eventId, { topic, resourceId }) {
  const { db } = ctx;
  const finish = async (error = null) => {
    try {
      await db.run("UPDATE webhook_events SET processed_at = ?, error = ? WHERE id = ?", [now(), error, eventId]);
    } catch (err) {
      ctx.log?.error?.("[mercadopago] could not record webhook result", err);
    }
  };
  const kind = topicKind(topic);
  try {
    if (!kind) return await finish(null);
    if (!resourceId) return await finish("Notificação sem o identificador do recurso (data.id).");
    if (kind === "payment") {
      await applyPayment(ctx, await getPayment(ctx, resourceId));
    } else if (kind === "preapproval") {
      await applyPreapproval(ctx, await getPreapproval(ctx, resourceId));
    } else {
      const authorized = await getAuthorizedPayment(ctx, resourceId);
      const paymentId = authorized?.payment?.id;
      if (!paymentId) return await finish(null);
      const payment = await getPayment(ctx, paymentId);
      await applyPayment(ctx, { ...payment, external_reference: payment.external_reference ?? authorized.external_reference }, {
        preapprovalId: authorized.preapproval_id ?? null,
      });
    }
    return await finish(null);
  } catch (err) {
    const message =
      err instanceof ReconcileError || err?.status ? String(err.message) : "Falha inesperada ao processar a notificação.";
    if (!(err instanceof ReconcileError) && !err?.status) ctx.log?.error?.("[mercadopago] webhook processing failed", err);
    return await finish(message.slice(0, 500));
  }
}

// In-flight processing per context (tests and shutdown wait on it).
const inflight = new WeakMap();

export function trackWork(ctx, promise) {
  let set = inflight.get(ctx);
  if (!set) inflight.set(ctx, (set = new Set()));
  set.add(promise);
  promise.finally(() => set.delete(promise));
  return promise;
}

export async function webhookIdle(ctx) {
  const set = inflight.get(ctx);
  while (set?.size) await Promise.allSettled([...set]);
}

// AssinaVelox API v1 (contracts): client from the vendored SDK, pt-BR error
// translation, integration status, outgoing-webhook verification and the
// REST Hook subscription used to receive envelope events. The API is the
// source of truth: webhooks only tell us which envelope to look at again.
import { ApiError, AssinaVelox, NetworkError, RequestTimeoutError, webhooks } from "../vendor/assinavelox-sdk/index.js";
import { HttpError, notConfigured } from "../lib/errors.js";
import { open, seal } from "../lib/secretbox.js";
import { getSetting, setSetting } from "../lib/settings.js";
import { now } from "../lib/time.js";

export const MESSAGES = {
  notConfigured:
    "AssinaVelox não configurada. Defina ASSINAVELOX_API_URL e ASSINAVELOX_TOKEN no servidor para enviar contratos.",
  clientNotConfigured: "A assinatura de contratos está indisponível no momento. Fale com a Metta.",
  unauthorized: "A AssinaVelox recusou a chave de API. Confira ASSINAVELOX_TOKEN no servidor.",
  creatorLacks: "Quem criou a chave na AssinaVelox não tem mais permissão para esta ação. Gere uma nova chave.",
  featureOff:
    "Este recurso não está habilitado na conta da AssinaVelox (API, webhooks ou assinatura embutida). Confira o plano da organização.",
  rateLimited: "A AssinaVelox pediu uma pausa entre as requisições. Tente de novo em instantes.",
  unavailable: "AssinaVelox indisponível no momento. Tente de novo em instantes.",
  dispatchFailed: "A AssinaVelox não conseguiu emitir os convites agora. Nada foi enviado; tente de novo em instantes.",
};

const CONFLICTS = {
  "recipient-not-active": "Ainda não é a vez desta pessoa assinar, ou ela já respondeu.",
  "recipient-not-invited": "O convite desta pessoa não está ativo na AssinaVelox.",
  "recipient-not-signable": "Esta pessoa não precisa assinar o contrato.",
  "invalid-status": "O contrato não está mais em andamento na AssinaVelox.",
  "already-sent": "Este contrato já foi enviado para assinatura.",
  "embedded-unsupported": "Este contrato exige uma etapa que só funciona pelo link enviado por e-mail.",
  "embedded-session-closed": "Esta sessão de assinatura foi encerrada. Abra uma nova.",
  "too-many-sessions": "Há sessões de assinatura demais abertas. Aguarde alguns minutos e tente de novo.",
  "envelope-not-ready": "A AssinaVelox ainda está processando o PDF do contrato. Tente de novo em instantes.",
  "idempotency-request-in-progress": "Esta etapa já está em andamento. Aguarde alguns segundos.",
};

// Events the Metta platform subscribes to (REST Hook). Payloads only carry
// ids; every change is confirmed through GET /envelopes/{id}.
export const WEBHOOK_EVENTS = [
  "envelope.sent",
  "recipient.viewed",
  "recipient.signed",
  "recipient.refused",
  "envelope.refused",
  "envelope.completed",
  "envelope.expired",
  "envelope.canceled",
  "document.processing_failed",
];

// Abilities the API key needs (shown in Configurações > Contratos).
export const REQUIRED_ABILITIES = [
  "envelopes:read",
  "envelopes:write",
  "envelopes:send",
  "documents:read",
  "recipients:read",
  "webhooks:manage",
  "embedded_signing:manage",
];

const WEBHOOK_SETTING = "assinavelox.webhook";
const SECRET_PURPOSE = "assinavelox-webhook";

// ------------------------------------------------------------------ config & status

export function avSettings(config) {
  const av = config.assinavelox ?? {};
  return {
    apiUrl: av.apiUrl ?? null,
    token: av.token ?? null,
    webhookSecret: av.webhookSecret ?? null,
    syncMinutes: Number.isFinite(av.syncMinutes) ? av.syncMinutes : 5,
    timeoutMs: av.timeoutMs || 30000,
    fetch: av.fetch ?? null,
  };
}

export const isConfigured = (config) => {
  const { apiUrl, token } = avSettings(config);
  return Boolean(apiUrl && token);
};

/** Origin of the Metta app, sent to AssinaVelox when opening an embedded session. */
export const appOrigin = (config) => new URL(config.appUrl).origin;

/** Origin of the AssinaVelox widget (the host of the API). */
export function widgetOrigin(config) {
  const { apiUrl } = avSettings(config);
  try {
    return apiUrl ? new URL(apiUrl).origin : null;
  } catch {
    return null;
  }
}

export const webhookUrl = (config) => `${config.appUrl}/api/webhooks/assinavelox`;

// AssinaVelox only delivers to public HTTPS addresses (SSRF guard on its side).
export function isPublicHttps(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:") return false;
    return !/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1)/i.test(hostname) && !hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

async function storedWebhook(ctx) {
  const value = await getSetting(ctx.db, WEBHOOK_SETTING, null);
  return value && typeof value === "object" ? value : null;
}

export async function avStatus(ctx) {
  const { config } = ctx;
  const settings = avSettings(config);
  const stored = await storedWebhook(ctx);
  let apiHost = null;
  try {
    apiHost = settings.apiUrl ? new URL(settings.apiUrl).host : null;
  } catch {
    apiHost = null;
  }
  return {
    configured: isConfigured(config),
    apiHost,
    appOrigin: appOrigin(config),
    widgetOrigin: widgetOrigin(config),
    syncMinutes: settings.syncMinutes,
    requiredAbilities: REQUIRED_ABILITIES,
    webhook: {
      url: webhookUrl(config),
      publicUrl: isPublicHttps(config.appUrl),
      envSecret: Boolean(settings.webhookSecret),
      subscription: stored
        ? {
            id: stored.id,
            targetUrl: stored.targetUrl,
            events: stored.events ?? [],
            secretHint: stored.secretHint ?? null,
            createdAt: stored.createdAt,
          }
        : null,
      receiving: Boolean(settings.webhookSecret || stored?.secret),
    },
  };
}

// ------------------------------------------------------------------ client & errors

const clients = new WeakMap();

/** AssinaVelox SDK client for this configuration (503 when not configured). */
export function avClient(ctx) {
  const settings = avSettings(ctx.config);
  if (!settings.apiUrl || !settings.token) throw notConfigured(MESSAGES.notConfigured);
  const cached = clients.get(ctx.config);
  if (cached) return cached;
  const client = new AssinaVelox({
    baseUrl: settings.apiUrl,
    token: settings.token,
    timeoutMs: settings.timeoutMs,
    headers: { "X-Client": "metta-platform" },
    ...(settings.fetch ? { fetch: settings.fetch } : {}),
  });
  clients.set(ctx.config, client);
  return client;
}

function firstError(errors) {
  for (const messages of Object.values(errors ?? {})) {
    const text = Array.isArray(messages) ? messages[0] : messages;
    if (text) return String(text);
  }
  return null;
}

/**
 * Translates an SDK error into an HttpError with a pt-BR message the UI can
 * show. Keeps the AssinaVelox problem type and correlation id for the logs.
 */
export function toHttpError(err, { what = "a operação" } = {}) {
  if (err instanceof HttpError) return err;
  const extra = (e, avStatus, slug, correlationId) => Object.assign(e, { avStatus, avType: slug, correlationId });
  if (err instanceof RequestTimeoutError || err instanceof NetworkError)
    return extra(new HttpError(502, "upstream_error", MESSAGES.unavailable), 0, err instanceof RequestTimeoutError ? "timeout" : "network", null);
  if (!(err instanceof ApiError)) return extra(new HttpError(502, "upstream_error", MESSAGES.unavailable), 0, "unknown", null);

  const slug = err.slug;
  const status = err.status;
  const cid = err.correlationId;
  const make = (httpStatus, code, message) => extra(new HttpError(httpStatus, code, message), status, slug, cid);

  if (status === 401) return make(502, "upstream_error", MESSAGES.unauthorized);
  if (status === 403 && slug === "missing-ability") {
    const ability = err.problem?.required_ability ? `“${err.problem.required_ability}”` : "necessária";
    return make(502, "upstream_error", `A chave da AssinaVelox não tem a permissão ${ability}. Gere uma chave com as permissões listadas em Configurações > Contratos.`);
  }
  if (status === 403 && slug === "creator-lacks-permission") return make(502, "upstream_error", MESSAGES.creatorLacks);
  if (status === 403) return make(502, "upstream_error", `A AssinaVelox não permitiu ${what}.`);
  if (status === 404) return make(502, "upstream_error", `A AssinaVelox não encontrou o recurso de ${what}. ${MESSAGES.featureOff}`);
  if (status === 409) {
    const message = CONFLICTS[slug] ?? err.detail ?? `A AssinaVelox não pôde concluir ${what} no estado atual do contrato.`;
    return make(409, "conflict", message);
  }
  if (status === 413) return make(502, "upstream_error", "O PDF do contrato ficou maior que o limite aceito pela AssinaVelox.");
  if (status === 422) {
    if (err.errors?.origin)
      return make(
        502,
        "upstream_error",
        "O endereço da plataforma Metta não está autorizado no widget da AssinaVelox. Cadastre-o em API e integrações → Widget de assinatura.",
      );
    const detail = firstError(err.errors) ?? err.detail;
    return make(502, "upstream_error", `A AssinaVelox recusou os dados de ${what}${detail ? `: ${detail}` : "."}`);
  }
  if (status === 429) return make(502, "upstream_error", MESSAGES.rateLimited);
  if (status === 503 && slug === "dispatch-failed") return make(502, "upstream_error", MESSAGES.dispatchFailed);
  return make(502, "upstream_error", MESSAGES.unavailable);
}

/** Runs fn(client) translating SDK errors; logs the AssinaVelox correlation id. */
export async function avCall(ctx, what, fn) {
  const client = avClient(ctx);
  try {
    return await fn(client);
  } catch (err) {
    const httpError = toHttpError(err, { what });
    ctx.log?.warn?.(
      `[assinavelox] ${what} failed: ${httpError.avStatus ?? ""} ${httpError.avType ?? err?.name ?? ""}${httpError.correlationId ? ` (correlation ${httpError.correlationId})` : ""}`,
    );
    throw httpError;
  }
}

/** Quick connectivity check for the settings screen. */
export async function testConnection(ctx) {
  const started = Date.now();
  const page = await avCall(ctx, "a verificação da conexão", (client) => client.listEnvelopes({ per_page: 1 }));
  return { ok: true, ms: Date.now() - started, envelopes: page.data.length };
}

// ------------------------------------------------------------------ webhooks

/** Secrets accepted for incoming deliveries (env + the stored subscription). */
export async function webhookSecrets(ctx) {
  const secrets = [];
  const { webhookSecret } = avSettings(ctx.config);
  if (webhookSecret) secrets.push(webhookSecret);
  const stored = await storedWebhook(ctx);
  const opened = stored?.secret ? open(ctx.config.appSecret, SECRET_PURPOSE, stored.secret) : null;
  if (opened) secrets.push(opened);
  return secrets;
}

/**
 * verifyWebhook(ctx, rawBody, headers) -> { valid, reason, event }
 * reason: secret_missing | invalid (bad signature or outside the 5 min window) | bad_json
 */
export async function verifyWebhook(ctx, rawBody, getHeader) {
  const secrets = await webhookSecrets(ctx);
  if (!secrets.length) return { valid: false, reason: "secret_missing" };
  const signature = getHeader(webhooks.SIGNATURE_HEADER);
  const timestamp = getHeader(webhooks.TIMESTAMP_HEADER);
  const valid = secrets.some((secret) => webhooks.verifySignature(secret, signature, timestamp, rawBody));
  if (!valid) return { valid: false, reason: "invalid" };
  try {
    return { valid: true, event: JSON.parse(Buffer.from(rawBody).toString("utf8")) };
  } catch {
    return { valid: false, reason: "bad_json" };
  }
}

/** Creates the REST Hook subscription on AssinaVelox and keeps its secret sealed. */
export async function connectWebhook(ctx, userId = null) {
  const targetUrl = webhookUrl(ctx.config);
  if (!isPublicHttps(targetUrl))
    throw new HttpError(
      409,
      "conflict",
      "A AssinaVelox só entrega notificações para um endereço HTTPS público. Configure APP_URL com o domínio da plataforma; até lá, os contratos são atualizados pela consulta periódica.",
    );
  const result = await avCall(ctx, "a assinatura das notificações", (client) =>
    client.createWebhookSubscription({ target_url: targetUrl, events: WEBHOOK_EVENTS }),
  );
  const subscription = result.data;
  const stored = await storedWebhook(ctx);
  // 200 without a secret means the subscription already existed for this token.
  const secret = subscription.secret
    ? seal(ctx.config.appSecret, SECRET_PURPOSE, subscription.secret)
    : stored?.id === subscription.id
      ? stored.secret
      : null;
  if (!secret)
    throw new HttpError(
      409,
      "conflict",
      "A AssinaVelox já tinha esta assinatura de notificações, mas o segredo não está guardado aqui. Remova a assinatura antiga na AssinaVelox e conecte de novo, ou defina ASSINAVELOX_WEBHOOK_SECRET.",
    );
  const value = {
    id: subscription.id,
    targetUrl: subscription.target_url,
    events: subscription.events,
    secretHint: subscription.secret_hint ?? null,
    secret,
    createdAt: subscription.created_at ?? now(),
  };
  await setSetting(ctx.db, WEBHOOK_SETTING, value, userId);
  return value;
}

export async function disconnectWebhook(ctx, userId = null) {
  const stored = await storedWebhook(ctx);
  if (!stored) return false;
  try {
    await avCall(ctx, "a remoção das notificações", (client) => client.deleteWebhookSubscription(stored.id));
  } catch (err) {
    // Already gone on the AssinaVelox side: forget it here too.
    if (err?.avStatus !== 404) throw err;
  }
  await setSetting(ctx.db, WEBHOOK_SETTING, null, userId);
  return true;
}

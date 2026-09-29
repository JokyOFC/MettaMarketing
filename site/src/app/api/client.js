// Thin JSON client for /api. Every failure becomes an ApiError whose message is
// ready to show (pt-BR); callers branch on `code`, never on message text.

export const NETWORK_MESSAGE =
  "Sem conexão com o servidor. Verifique sua internet e tente de novo.";

const MESSAGES = {
  bad_request: "Não foi possível processar o pedido. Revise os dados e tente de novo.",
  unauthenticated: "Sua sessão terminou. Entre de novo para continuar.",
  invalid_credentials: "E-mail ou senha incorretos.",
  forbidden: "Você não tem permissão para esta ação.",
  not_found: "Não encontramos este item. Ele pode ter sido removido ou não estar disponível para você.",
  conflict: "Este item mudou enquanto você trabalhava. Atualize a página e tente de novo.",
  expired: "O link expirou. Tente de novo.",
  payload_too_large: "Arquivo acima do limite permitido.",
  unsupported_media: "Formato não permitido.",
  validation: "Revise os campos destacados.",
  rate_limited: "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.",
  upstream_error: "O serviço externo não respondeu. Tente de novo em instantes.",
  integration_not_configured: "Esta integração ainda não foi configurada.",
  not_implemented: "Este recurso ainda não está disponível.",
  internal: "Algo deu errado do nosso lado. Tente de novo em instantes.",
  network: NETWORK_MESSAGE,
  download_disabled: "O download deste arquivo não está liberado.",
  font_license: "A licença desta fonte não permite distribuição. Use o link oficial.",
};

const CODE_BY_STATUS = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "expired",
  413: "payload_too_large",
  415: "unsupported_media",
  422: "validation",
  429: "rate_limited",
  501: "not_implemented",
  502: "upstream_error",
  503: "integration_not_configured",
};

export const messageFor = (code) => MESSAGES[code] || MESSAGES.internal;

export class ApiError extends Error {
  constructor({ status = 0, code, message, fields = null, data = null } = {}) {
    const resolved = code || CODE_BY_STATUS[status] || "internal";
    super(message || messageFor(resolved));
    this.name = "ApiError";
    this.status = status;
    this.code = resolved;
    this.fields = fields;
    this.data = data;
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export const isAbort = (error) => error?.name === "AbortError";

// Builds an ApiError from an HTTP status and a parsed body (possibly null).
export function toApiError(status, body) {
  const error = body && typeof body === "object" ? body.error : null;
  return new ApiError({
    status,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message : undefined,
    fields: error?.fields || null,
    data: body,
  });
}

export function networkError(message = NETWORK_MESSAGE) {
  return new ApiError({ status: 0, code: "network", message });
}

// Tells the auth layer the session is gone. Wrong passwords (invalid_credentials)
// are not a lost session and do not fire it.
export function signalUnauthenticated(error, path) {
  if (error.status !== 401 || error.code !== "unauthenticated") return;
  window.dispatchEvent(
    new CustomEvent("metta:unauthenticated", { detail: { path } }),
  );
}

// "?a=1&b=x" from an object; skips null, undefined, "" and false. Arrays repeat the key.
export function qs(params) {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null || item === "" || item === false)
        continue;
      search.append(key, item === true ? "1" : String(item));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

// Accepts "/materials", "materials" or "/api/materials".
export function apiUrl(path) {
  if (/^https?:\/\//.test(path) || path.startsWith("/api/") || path.startsWith("/dl/"))
    return path;
  return `/api${path.startsWith("/") ? "" : "/"}${path}`;
}

async function readBody(response) {
  if (response.status === 204 || response.status === 205) return null;
  const type = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!text) return null;
  if (type.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

async function request(method, path, { body, params, signal, headers } = {}) {
  const url = apiUrl(path) + qs(params);
  const init = {
    method,
    credentials: "same-origin",
    signal,
    headers: { Accept: "application/json", ...headers },
  };
  if (method !== "GET" && method !== "HEAD") init.headers["X-Metta-Request"] = "1";
  if (body !== undefined && body !== null) {
    if (body instanceof FormData || body instanceof Blob) init.body = body;
    else {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw networkError();
  }
  let data;
  try {
    data = await readBody(response);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw networkError();
  }
  if (!response.ok) {
    const error = toApiError(response.status, data);
    signalUnauthenticated(error, path);
    throw error;
  }
  return data;
}

export const api = {
  get: (path, { params, signal, headers } = {}) =>
    request("GET", path, { params, signal, headers }),
  post: (path, body, options) => request("POST", path, { ...options, body }),
  patch: (path, body, options) => request("PATCH", path, { ...options, body }),
  put: (path, body, options) => request("PUT", path, { ...options, body }),
  del: (path, body, options) => request("DELETE", path, { ...options, body }),
};
api.delete = api.del;

export default api;

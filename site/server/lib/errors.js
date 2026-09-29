// HttpError and the JSON error middleware. Every error answer has the shape
// { error: { code, message (pt-BR, shown to people), fields? } }.

export class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
  }
}

export const badRequest = (message = "Requisição inválida.", code = "bad_request") =>
  new HttpError(400, code, message);
export const unauthenticated = (message = "Sua sessão terminou. Entre novamente para continuar.") =>
  new HttpError(401, "unauthenticated", message);
export const forbidden = (message = "Você não tem permissão para esta ação.", code = "forbidden") =>
  new HttpError(403, code, message);
export const notFound = (message = "Não encontramos este item.") =>
  new HttpError(404, "not_found", message);
export const conflict = (message = "Este item mudou enquanto você trabalhava. Atualize a página.", code = "conflict") =>
  new HttpError(409, code, message);
export const expired = (message = "Este link expirou. Gere um novo para continuar.") =>
  new HttpError(410, "expired", message);
export const payloadTooLarge = (message = "O arquivo ultrapassa o limite permitido.") =>
  new HttpError(413, "payload_too_large", message);
export const unsupportedMedia = (message = "Formato de arquivo não permitido.") =>
  new HttpError(415, "unsupported_media", message);
export const validation = (fields = {}, message = "Revise os campos destacados.") =>
  new HttpError(422, "validation", message, fields);
export const rateLimited = (message = "Muitas tentativas. Aguarde alguns minutos e tente novamente.") =>
  new HttpError(429, "rate_limited", message);
export const upstream = (message = "O serviço externo não respondeu como esperado. Tente novamente.") =>
  new HttpError(502, "upstream_error", message);
export const notConfigured = (message = "Esta integração ainda não foi configurada.") =>
  new HttpError(503, "integration_not_configured", message);

export const INTERNAL_MESSAGE = "Algo não saiu como esperado. Tente novamente.";

export function sendError(res, status, code, message, fields) {
  const error = { code, message };
  if (fields && Object.keys(fields).length) error.fields = fields;
  res.status(status).json({ error });
}

// JSON 404 for unmatched /api and /dl paths.
export function apiNotFound(req, res) {
  sendError(res, 404, "not_found", "Endereço não encontrado.");
}

export function errorHandler(ctx) {
  // Express recognises error middleware by its four arguments.
  // eslint-disable-next-line no-unused-vars
  return function handleError(err, req, res, next) {
    if (res.headersSent) {
      req.socket?.destroy?.();
      return;
    }
    if (err instanceof HttpError) {
      if (err.status === 413 || err.status === 415) res.set("Connection", "close");
      return sendError(res, err.status, err.code, err.message, err.fields);
    }
    // body-parser and friends
    if (err?.type === "entity.parse.failed")
      return sendError(res, 400, "bad_request", "Não foi possível ler os dados enviados.");
    if (err?.type === "entity.too.large")
      return sendError(res, 413, "payload_too_large", "Os dados enviados ultrapassam o limite.");
    if (err?.name === "ZodError" && Array.isArray(err.issues)) {
      const fields = {};
      for (const issue of err.issues) fields[issue.path.join(".") || "_"] ??= issue.message;
      return sendError(res, 422, "validation", "Revise os campos destacados.", fields);
    }
    const log = ctx?.log ?? console;
    log.error(`[${req.method} ${redactUrl(req.originalUrl)}]`, err);
    sendError(res, 500, "internal", INTERNAL_MESSAGE);
  };
}

// Temporary links and invitation tokens never reach the logs.
export function redactUrl(url = "") {
  return String(url)
    .replace(/(\/dl\/)[^/?#]+/g, "$1[token]")
    .replace(/(\/api\/auth\/invite\/)[^/?#]+/g, "$1[token]")
    .replace(/([?&](?:token|signature)=)[^&#]+/gi, "$1[redacted]");
}

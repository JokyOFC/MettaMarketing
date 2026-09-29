import { forbidden } from "./errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The only state-changing endpoint without a session: Mercado Pago signs its
// notifications instead (routes/webhooks.js). Matched exactly and without
// regard to case, since Express routes are case-insensitive.
const EXEMPT = /^\/api\/webhooks\/mercadopago\/?$/i;

// Every state-changing request must carry X-Metta-Request: 1 (a custom header
// cannot be sent cross-site without CORS, and we never enable CORS) and, when
// the browser sends Origin, it must be the app itself. The guard does not
// depend on the path prefix: "/API/..." or "/Api/..." reach the same routers.
export function csrf(ctx) {
  const appOrigin = new URL(ctx.config.appUrl).origin;
  return function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (EXEMPT.test(req.path)) return next();
    if (req.get("x-metta-request") !== "1")
      return next(forbidden("Requisição bloqueada por segurança. Recarregue a página e tente novamente."));
    const origin = req.get("origin");
    if (origin !== undefined && !originAllowed(origin, appOrigin, req))
      return next(forbidden("Origem da requisição não permitida."));
    next();
  };
}

function originAllowed(origin, appOrigin, req) {
  if (origin === appOrigin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  const host = req.get("host");
  return Boolean(host) && parsed.host === host && /^https?:$/.test(parsed.protocol);
}

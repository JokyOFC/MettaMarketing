import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Temporary links (HMAC-SHA256 with a key derived from APP_SECRET).
 * createSigner(secret) -> { sign(payload, ttlSec = 300) -> token,
 *   issue(payload, ttlSec) -> { token, url: '/dl/<token>', expiresAt },
 *   verify(token) -> payload | { expired: true, ...payload } | null }
 * payload: { t: 'file' | 'zip', id, u: userId }. Redemption must also check
 * that u matches the session user and re-run the access check.
 */
export function createSigner(secret) {
  if (!secret) throw new Error("createSigner requires a secret");
  const key = createHmac("sha256", String(secret)).update("metta:signed-links:v1").digest();
  const mac = (body) => createHmac("sha256", key).update(body).digest();

  function sign(payload, ttlSec = 300) {
    const data = {
      t: payload.t,
      id: payload.id,
      u: payload.u,
      exp: Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSec)),
    };
    const body = Buffer.from(JSON.stringify(data)).toString("base64url");
    return `${body}.${mac(body).toString("base64url")}`;
  }

  function verify(token) {
    if (typeof token !== "string" || token.length > 1024) return null;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
    const body = token.slice(0, dot);
    let given;
    try {
      given = Buffer.from(token.slice(dot + 1), "base64url");
    } catch {
      return null;
    }
    const expected = mac(body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let data;
    try {
      data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!data || typeof data !== "object" || typeof data.exp !== "number") return null;
    if (data.exp * 1000 <= Date.now()) return { expired: true, ...data };
    return data;
  }

  function issue(payload, ttlSec = 300) {
    const token = sign(payload, ttlSec);
    const { exp } = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    return { token, url: `/dl/${token}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  return { sign, verify, issue };
}

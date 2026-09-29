import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { forbidden, rateLimited, unauthenticated, expired } from "./errors.js";
import { newId, newToken } from "./ids.js";
import { addDays, addHours, addMinutes, now } from "./time.js";
import { can, capabilitiesFor } from "./permissions.js";

const scryptAsync = promisify(scrypt);

// ------------------------------------------------------------------ passwords

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scryptAsync(String(password).normalize("NFKC"), salt, keylen, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== "string" || typeof password !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  let actual;
  try {
    actual = await scryptAsync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Spends the same time as a real check when the account does not exist.
let dummyHash = null;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(String(password ?? ""), dummyHash);
  return false;
}

// pt-BR messages; null when the password is acceptable.
export function passwordProblem(password, email) {
  if (typeof password !== "string" || password.length < 10) return "Use pelo menos 10 caracteres.";
  if (password.length > 256) return "Use no máximo 256 caracteres.";
  if (email && password.trim().toLowerCase() === String(email).trim().toLowerCase())
    return "A senha não pode ser igual ao e-mail.";
  return null;
}

// ------------------------------------------------------------------ sessions

export const SESSION_COOKIE = "metta_sid";
const SESSION_DAYS = 14;
const TOUCH_AFTER_MS = 10 * 60 * 1000; // sliding refresh at most every 10 min

export const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");

function cookieOptions(config, maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(config?.isProduction),
    path: "/",
    maxAge: maxAgeMs,
  };
}

export function setSessionCookie(res, config, token) {
  res.cookie(SESSION_COOKIE, token, cookieOptions(config, SESSION_DAYS * 24 * 60 * 60 * 1000));
}

export function clearSessionCookie(res, config) {
  const { maxAge, ...options } = cookieOptions(config, 0);
  res.clearCookie(SESSION_COOKIE, options);
}

export const clientIp = (req) => req?.ip || req?.socket?.remoteAddress || null;
const userAgent = (req) => String(req?.get?.("user-agent") ?? "").slice(0, 300) || null;

// Creates a session row and, when req.res exists, sets the cookie.
// Returns { id, token, expiresAt }.
export function createSession(ctx, user, req) {
  const token = newToken();
  const id = newId("ses");
  const createdAt = now();
  const expiresAt = addDays(SESSION_DAYS, createdAt);
  ctx.db.run(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, sha256(token), user.id, createdAt, createdAt, expiresAt, clientIp(req), userAgent(req)],
  );
  if (req?.res) setSessionCookie(req.res, ctx.config, token);
  return { id, token, expiresAt };
}

export function revokeSession(db, sessionId) {
  db.run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), sessionId]);
}

// Revokes every active session of a user, optionally keeping one.
export function revokeUserSessions(db, userId, { exceptId = null } = {}) {
  return db.run(
    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?",
    [now(), userId, exceptId],
  ).changes;
}

// Strips secrets from a user row and adds capabilities.
export function toRequestUser(row) {
  if (!row) return null;
  const { password_hash, ...user } = row;
  user.capabilities = capabilitiesFor(user.role);
  return user;
}

// Middleware: reads metta_sid, loads req.session and req.user (or null).
export function loadSession(ctx) {
  return function sessionMiddleware(req, res, next) {
    req.user = null;
    req.session = null;
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token || token.length > 200) return next();
    const session = ctx.db.get(
      "SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
      [sha256(token), now()],
    );
    if (!session) {
      clearSessionCookie(res, ctx.config);
      return next();
    }
    const user = ctx.db.get("SELECT * FROM users WHERE id = ?", [session.user_id]);
    if (!user || user.status !== "active") {
      revokeSession(ctx.db, session.id);
      clearSessionCookie(res, ctx.config);
      return next();
    }
    if (Date.now() - new Date(session.last_seen_at).getTime() > TOUCH_AFTER_MS) {
      const seen = now();
      session.last_seen_at = seen;
      session.expires_at = addDays(SESSION_DAYS, seen);
      ctx.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", [
        seen,
        session.expires_at,
        session.id,
      ]);
      setSessionCookie(res, ctx.config, token);
    }
    req.session = session;
    req.user = toRequestUser(user);
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthenticated());
  next();
}

export function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    if (!req.user) return next(unauthenticated());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

// requireCap('a') or requireCap('a', 'b') — passes when the user has any.
export function requireCap(...caps) {
  return function capGuard(req, res, next) {
    if (!req.user) return next(unauthenticated());
    if (!caps.some((cap) => can(req.user, cap))) return next(forbidden());
    next();
  };
}

export const requireStaff = requireRole("admin", "manager", "designer", "finance");
export const requireClient = requireRole("client");

// ------------------------------------------------------- invite/reset tokens

// Issues a one-time token; previous unused tokens of the same purpose stop
// working. Returns the raw token (only its hash is stored).
export function issueToken(ctx, userId, purpose, ttlHours, createdBy = null) {
  const token = newToken();
  const createdAt = now();
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL", [
      userId,
      purpose,
    ]);
    ctx.db.run(
      `INSERT INTO auth_tokens (token_hash, user_id, purpose, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sha256(token), userId, purpose, createdBy, createdAt, addHours(ttlHours, createdAt)],
    );
  });
  return token;
}

// Looks a token up without consuming it. purpose may be null (any).
// Returns { token: row, user } or null when unknown, used, expired or the
// account is disabled.
export function peekToken(ctx, rawToken, purpose = null) {
  if (typeof rawToken !== "string" || rawToken.length < 20 || rawToken.length > 200) return null;
  const row = ctx.db.get("SELECT * FROM auth_tokens WHERE token_hash = ?", [sha256(rawToken)]);
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (purpose && row.purpose !== purpose) return null;
  const user = ctx.db.get("SELECT * FROM users WHERE id = ?", [row.user_id]);
  if (!user || user.status === "disabled") return null;
  if (row.purpose === "invite" && user.status !== "invited") return null;
  if (row.purpose === "reset" && user.status !== "active") return null;
  return { token: row, user };
}

// Consumes a token (single use). Throws 410 expired when it cannot be used.
export function consumeToken(ctx, rawToken, purpose) {
  const found = peekToken(ctx, rawToken, purpose);
  if (!found) throw expired("Este link expirou ou já foi usado. Peça um novo à equipe Metta.");
  const { changes } = ctx.db.run(
    "UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
    [now(), found.token.token_hash],
  );
  if (!changes) throw expired("Este link expirou ou já foi usado. Peça um novo à equipe Metta.");
  return found.user;
}

// ------------------------------------------------------------ login throttle

const WINDOW_MINUTES = 15;
const MAX_FAILURES = 5;
const MAX_FAILURES_PER_IP = 30;

// Throws 429 after 5 failures for the same e-mail + IP within 15 minutes
// (counted since the last success), or 30 failures from one IP.
export function assertLoginAllowed(db, email, ip) {
  const since = addMinutes(-WINDOW_MINUTES);
  const lastSuccess = db.get(
    "SELECT MAX(created_at) AS at FROM login_attempts WHERE email = ? AND ip IS ? AND success = 1 AND created_at > ?",
    [email, ip, since],
  )?.at;
  const from = lastSuccess && lastSuccess > since ? lastSuccess : since;
  const failures = db.get(
    "SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND ip IS ? AND success = 0 AND created_at > ?",
    [email, ip, from],
  ).n;
  if (failures >= MAX_FAILURES) throw rateLimited();
  if (ip) {
    const byIp = db.get(
      "SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > ?",
      [ip, since],
    ).n;
    if (byIp >= MAX_FAILURES_PER_IP) throw rateLimited();
  }
}

export function recordLoginAttempt(db, email, ip, success) {
  db.run("INSERT INTO login_attempts (email, ip, success, created_at) VALUES (?, ?, ?, ?)", [
    String(email ?? "").slice(0, 254),
    ip,
    success ? 1 : 0,
    now(),
  ]);
}

export function pruneLoginAttempts(db, days = 30) {
  db.run("DELETE FROM login_attempts WHERE created_at < ?", [addDays(-days)]);
}

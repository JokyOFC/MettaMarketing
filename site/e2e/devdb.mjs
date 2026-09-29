// Development-database helpers for the e2e flows (default auth mode).
// The flows never type passwords: each person gets a session row created
// directly in the local dev DB, exactly like a login would, and every session
// made here is revoked at the end of the run. Refuses anything but a local MySQL.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// The dev API's DATABASE_URL: --db, the environment or site/.env (only that
// key is read from the file).
export function devDatabaseUrl(explicit) {
  if (explicit) return explicit;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = join(SITE, ".env");
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/);
      if (match) return match[1].replace(/^(["'])(.*)\1$/, "$2");
    }
  throw new Error("Defina DATABASE_URL no site/.env (o mesmo banco usado pela API de desenvolvimento).");
}

export async function openDevDb(url) {
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error("O e2e só mexe em um MySQL local (127.0.0.1 ou localhost).");
  const conn = await mysql.createConnection({ uri: url, charset: "utf8mb4", timezone: "Z", dateStrings: true });
  const query = async (sql, params = []) => (await conn.query(sql, params))[0];
  const one = async (sql, params) => (await query(sql, params))[0];
  const minted = [];
  const nowIso = () => new Date().toISOString();

  return {
    // Session for an existing, active user. Returns the cookie value.
    async mintSession(email) {
      const user = await one("SELECT id, status, role FROM users WHERE email = ?", [email.toLowerCase()]);
      if (!user) throw new Error(`usuário ${email} não existe no banco de desenvolvimento (rode npm run seed:dev)`);
      if (user.status !== "active") throw new Error(`usuário ${email} está ${user.status}`);
      const token = randomBytes(32).toString("base64url");
      const id = `ses_${randomBytes(12).toString("base64url").slice(0, 16)}`;
      const at = new Date();
      await query(
        "INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, createHash("sha256").update(token).digest("hex"), user.id, at.toISOString(), at.toISOString(), new Date(at.getTime() + 86400000).toISOString(), "127.0.0.1", "metta-e2e"],
      );
      minted.push(id);
      return token;
    },
    // Stand-in for choosing a password on the invitation page (session mode
    // only): activates the invited user and burns the unused invitation links.
    async activateInvited(email) {
      const user = await one("SELECT id, status FROM users WHERE email = ?", [email.toLowerCase()]);
      if (!user) throw new Error(`convite para ${email} não encontrado`);
      if (user.status !== "invited") throw new Error(`usuário ${email} está ${user.status}, esperado invited`);
      const at = nowIso();
      await query("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?", [at, user.id]);
      await query("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL", [at, user.id]);
    },
    async userStatus(email) {
      return (await one("SELECT status FROM users WHERE email = ?", [email.toLowerCase()]))?.status ?? null;
    },
    // Opens a charge directly (there is no Mercado Pago in the dev setup).
    async setOrderStatus(orderId, status) {
      await query("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), orderId]);
    },
    // Latest outbox message sent to an address (e.g. the sign-up confirmation link).
    async lastEmail(to) {
      return one("SELECT * FROM email_outbox WHERE to_email = ? ORDER BY created_at DESC, seq DESC LIMIT 1", [to.toLowerCase()]);
    },
    async revokeAll() {
      for (const id of minted.splice(0)) await query("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [nowIso(), id]);
    },
    async close() {
      try {
        await conn.end();
      } catch {}
    },
  };
}

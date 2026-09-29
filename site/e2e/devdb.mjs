// Development-database helpers for the e2e flows (default auth mode).
// The flows never type passwords: each person gets a session row created
// directly in the local dev DB, exactly like a login would, and every session
// made here is revoked at the end of the run. Refuses anything but a local file.
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function openDevDb(path) {
  if (!existsSync(path)) throw new Error(`Banco de desenvolvimento não encontrado: ${path}`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 8000");
  const minted = [];
  const nowIso = () => new Date().toISOString();

  return {
    // Session for an existing, active user. Returns the cookie value.
    mintSession(email) {
      const user = db.prepare("SELECT id, status, role FROM users WHERE email = ?").get(email.toLowerCase());
      if (!user) throw new Error(`usuário ${email} não existe no banco de desenvolvimento (rode npm run seed:dev)`);
      if (user.status !== "active") throw new Error(`usuário ${email} está ${user.status}`);
      const token = randomBytes(32).toString("base64url");
      const id = `ses_${randomBytes(12).toString("base64url").slice(0, 16)}`;
      const at = new Date();
      db.prepare(
        "INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, createHash("sha256").update(token).digest("hex"), user.id, at.toISOString(), at.toISOString(), new Date(at.getTime() + 86400000).toISOString(), "127.0.0.1", "metta-e2e");
      minted.push(id);
      return token;
    },
    // Stand-in for choosing a password on the invitation page (session mode
    // only): activates the invited user and burns the unused invitation links.
    activateInvited(email) {
      const user = db.prepare("SELECT id, status FROM users WHERE email = ?").get(email.toLowerCase());
      if (!user) throw new Error(`convite para ${email} não encontrado`);
      if (user.status !== "invited") throw new Error(`usuário ${email} está ${user.status}, esperado invited`);
      const at = nowIso();
      db.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?").run(at, user.id);
      db.prepare("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(at, user.id);
    },
    userStatus(email) {
      return db.prepare("SELECT status FROM users WHERE email = ?").get(email.toLowerCase())?.status ?? null;
    },
    revokeAll() {
      const stmt = db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
      for (const id of minted.splice(0)) stmt.run(nowIso(), id);
    },
    close() {
      try {
        db.close();
      } catch {}
    },
  };
}

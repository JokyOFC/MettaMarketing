import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { issueToken } from "../lib/auth.js";
import { createAgent, createClientWithBrand, createUser, lastEmail, login, startTestServer, TEST_PASSWORD } from "./helpers.js";

let server;
before(async () => {
  server = await startTestServer();
});
after(async () => {
  await server?.close();
});

const tokenFrom = (email, path) => {
  const text = lastEmail(server.ctx, email)?.text_body ?? "";
  const match = new RegExp(`${path}/([A-Za-z0-9_-]+)`).exec(text);
  return match?.[1] ?? null;
};

describe("login, me, logout", () => {
  test("logs in, reads /me and logs out", async () => {
    const user = await createUser(server.ctx, { role: "manager", name: "Gestora" });
    const agent = createAgent(server);
    assert.equal((await agent.get("/api/auth/me")).status, 401);

    const res = await agent.post("/api/auth/login", { email: user.email.toUpperCase(), password: TEST_PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, user.email);
    assert.equal(res.body.user.role, "manager");
    assert.ok(res.body.user.capabilities.includes("materials.release"));
    assert.ok(!res.body.user.capabilities.includes("clients.create"));
    assert.equal(res.body.user.password_hash, undefined);
    const cookie = res.headers.getSetCookie().find((line) => line.startsWith("metta_sid="));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);

    const me = await agent.get("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, user.id);
    assert.deepEqual(me.body.user.brands, []);

    // session token is stored hashed
    const token = agent.cookie.split("=")[1];
    assert.equal(server.db.get("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?", [token]).n, 0);

    assert.equal((await agent.post("/api/auth/logout")).status, 204);
    assert.equal((await agent.get("/api/auth/me")).status, 401);
  });

  test("client /me lists its client and active brands", async () => {
    const { clientId, brand } = createClientWithBrand(server.ctx, { name: "Cliente Um", brandName: "Marca Um" });
    const user = await createUser(server.ctx, { role: "client", clientId });
    const agent = await login(server, { email: user.email });
    assert.deepEqual(agent.user.client, { id: clientId, name: "Cliente Um" });
    assert.deepEqual(agent.user.brands, [{ id: brand.id, name: "Marca Um", slug: brand.slug, clientId }]);
    assert.deepEqual(agent.user.capabilities, ["portal.access"]);
  });

  test("wrong password and unknown e-mail get the same generic answer", async () => {
    const user = await createUser(server.ctx, { role: "designer" });
    const agent = createAgent(server);
    const wrong = await agent.post("/api/auth/login", { email: user.email, password: "nao-e-essa-senha" });
    const unknown = await agent.post("/api/auth/login", { email: "ninguem@example.test", password: "qualquer-coisa" });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error.code, "invalid_credentials");
    assert.deepEqual(wrong.body, unknown.body);
  });

  test("validation errors come back per field in pt-BR", async () => {
    const res = await createAgent(server).post("/api/auth/login", { email: "" });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "validation");
    assert.ok(res.body.error.fields.email);
    assert.ok(res.body.error.fields.password);
  });

  test("rate limits after 5 failures for the same e-mail and IP", async () => {
    const user = await createUser(server.ctx, { role: "finance" });
    const agent = createAgent(server);
    for (let i = 0; i < 5; i += 1) {
      const res = await agent.post("/api/auth/login", { email: user.email, password: "senha-errada-123" });
      assert.equal(res.status, 401);
    }
    const blocked = await agent.post("/api/auth/login", { email: user.email, password: TEST_PASSWORD });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "rate_limited");
  });

  test("invited users cannot log in and disabled users are refused", async () => {
    const invited = await createUser(server.ctx, { role: "designer", status: "invited" });
    const res = await createAgent(server).post("/api/auth/login", { email: invited.email, password: TEST_PASSWORD });
    assert.equal(res.status, 401);

    const disabled = await createUser(server.ctx, { role: "designer", status: "disabled" });
    const refused = await createAgent(server).post("/api/auth/login", { email: disabled.email, password: TEST_PASSWORD });
    assert.equal(refused.status, 403);
  });

  test("disabling a user ends the current session", async () => {
    const user = await createUser(server.ctx, { role: "designer" });
    const agent = await login(server, { email: user.email });
    server.db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    assert.equal((await agent.get("/api/auth/me")).status, 401);
  });
});

describe("invitations", () => {
  test("accepting an invite sets the password and signs in", async () => {
    const user = await createUser(server.ctx, { role: "manager", status: "invited", name: "Convidada" });
    const token = issueToken(server.ctx, user.id, "invite", 72);
    const agent = createAgent(server);

    const peek = await agent.get(`/api/auth/invite/${token}`);
    assert.equal(peek.status, 200);
    assert.deepEqual(peek.body, { email: user.email, name: "Convidada", purpose: "invite" });

    const short = await agent.post("/api/auth/invite/accept", { token, password: "curta" });
    assert.equal(short.status, 422);
    assert.ok(short.body.error.fields.password);

    const same = await agent.post("/api/auth/invite/accept", { token, password: user.email });
    assert.equal(same.status, 422);

    const ok = await agent.post("/api/auth/invite/accept", { token, password: "uma-senha-nova-e-longa", name: "Ana Gestora" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.status, "active");
    assert.equal(ok.body.user.name, "Ana Gestora");
    assert.equal((await agent.get("/api/auth/me")).status, 200);

    const reuse = await createAgent(server).post("/api/auth/invite/accept", { token, password: "outra-senha-longa-1" });
    assert.equal(reuse.status, 410);
    assert.equal((await createAgent(server).get(`/api/auth/invite/${token}`)).status, 410);

    const again = await createAgent(server).post("/api/auth/login", { email: user.email, password: "uma-senha-nova-e-longa" });
    assert.equal(again.status, 200);
  });

  test("a new invite invalidates the previous link; expired links answer 410", async () => {
    const user = await createUser(server.ctx, { role: "designer", status: "invited" });
    const first = issueToken(server.ctx, user.id, "invite", 72);
    const second = issueToken(server.ctx, user.id, "invite", 72);
    assert.equal((await createAgent(server).get(`/api/auth/invite/${first}`)).status, 410);
    assert.equal((await createAgent(server).get(`/api/auth/invite/${second}`)).status, 200);

    const stale = issueToken(server.ctx, user.id, "invite", -1);
    assert.equal((await createAgent(server).get(`/api/auth/invite/${stale}`)).status, 410);
    assert.equal((await createAgent(server).get("/api/auth/invite/nao-existe-este-token-aqui")).status, 410);
  });
});

describe("password reset and change", () => {
  test("forgot always answers 204 and e-mails a single-use link", async () => {
    const user = await createUser(server.ctx, { role: "admin" });
    const other = await login(server, { email: user.email });
    const anon = createAgent(server);

    assert.equal((await anon.post("/api/auth/password/forgot", { email: "ninguem@example.test" })).status, 204);
    assert.equal(lastEmail(server.ctx, "ninguem@example.test"), undefined);

    assert.equal((await anon.post("/api/auth/password/forgot", { email: user.email })).status, 204);
    const email = lastEmail(server.ctx, user.email);
    assert.equal(email.status, "not_configured");
    assert.match(email.html_body, /redefinir-senha/);
    const token = tokenFrom(user.email, "/redefinir-senha");
    assert.ok(token);
    assert.ok(email.text_body.startsWith("Redefinição de senha"));

    const peek = await anon.get(`/api/auth/invite/${token}`);
    assert.equal(peek.body.purpose, "reset");

    const weak = await anon.post("/api/auth/password/reset", { token, password: "123" });
    assert.equal(weak.status, 422);
    const reset = await anon.post("/api/auth/password/reset", { token, password: "senha-redefinida-ok" });
    assert.equal(reset.status, 204);
    assert.equal((await other.get("/api/auth/me")).status, 401, "old sessions are revoked");
    assert.equal((await anon.post("/api/auth/password/reset", { token, password: "mais-uma-senha-ok" })).status, 410);
    assert.equal((await createAgent(server).post("/api/auth/login", { email: user.email, password: "senha-redefinida-ok" })).status, 200);
  });

  test("changing the password keeps this session and revokes the others", async () => {
    const user = await createUser(server.ctx, { role: "designer" });
    const a = await login(server, { email: user.email });
    const b = await login(server, { email: user.email });

    const wrong = await a.post("/api/auth/password/change", { currentPassword: "errada-demais-1", newPassword: "nova-senha-segura" });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.body.error.fields.currentPassword);

    const ok = await a.post("/api/auth/password/change", { currentPassword: TEST_PASSWORD, newPassword: "nova-senha-segura" });
    assert.equal(ok.status, 204);
    assert.equal((await a.get("/api/auth/me")).status, 200);
    assert.equal((await b.get("/api/auth/me")).status, 401);
  });
});

describe("profile and sessions", () => {
  test("updates the profile and manages sessions", async () => {
    const user = await createUser(server.ctx, { role: "manager" });
    const a = await login(server, { email: user.email });
    const b = await login(server, { email: user.email });

    const profile = await a.patch("/api/auth/profile", { name: "Novo Nome", jobTitle: "Gestora de contas", notifyEmail: false });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.name, "Novo Nome");
    assert.equal(profile.body.user.jobTitle, "Gestora de contas");
    assert.equal(profile.body.user.notifyEmail, false);

    const list = await a.get("/api/auth/sessions");
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 2);
    const other = list.body.items.find((item) => !item.current);
    assert.ok(other);
    assert.equal((await a.del(`/api/auth/sessions/${other.id}`)).status, 204);
    assert.equal((await b.get("/api/auth/me")).status, 401);

    const stranger = await createUser(server.ctx, { role: "manager" });
    const s = await login(server, { email: stranger.email });
    const mine = (await a.get("/api/auth/sessions")).body.items[0].id;
    assert.equal((await s.del(`/api/auth/sessions/${mine}`)).status, 404);
  });
});

describe("CSRF", () => {
  test("state-changing requests need X-Metta-Request and a matching Origin", async () => {
    const user = await createUser(server.ctx, { role: "admin" });
    const plain = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password: TEST_PASSWORD }),
    });
    assert.equal(plain.status, 403);

    const agent = createAgent(server);
    const foreign = await agent.post("/api/auth/login", { email: user.email, password: TEST_PASSWORD }, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    const nullOrigin = await agent.post("/api/auth/login", { email: user.email, password: TEST_PASSWORD }, { headers: { origin: "null" } });
    assert.equal(nullOrigin.status, 403);

    const appOrigin = await agent.post("/api/auth/login", { email: user.email, password: TEST_PASSWORD }, { headers: { origin: "http://127.0.0.1:5173" } });
    assert.equal(appOrigin.status, 200);
    const sameHost = await agent.patch("/api/auth/profile", { name: "Admin" }, { headers: { origin: server.url } });
    assert.equal(sameHost.status, 200);

    // GET never needs the header
    const me = await fetch(`${server.url}/api/auth/me`, { headers: { cookie: agent.cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get("cache-control"), "no-store");
    assert.equal(me.headers.get("x-content-type-options"), "nosniff");
    assert.equal(me.headers.get("x-powered-by"), null);
  });

  test("changing the case of the path does not skip the guard or no-store", async () => {
    const user = await createUser(server.ctx, { role: "admin" });
    const agent = createAgent(server);
    assert.equal((await agent.post("/api/auth/login", { email: user.email, password: TEST_PASSWORD })).status, 200);
    const bare = (method, path, extra = {}) =>
      fetch(`${server.url}${path}`, { method, headers: { cookie: agent.cookie, "content-type": "application/json", ...extra }, body: method === "GET" ? undefined : "{}" });

    // upper-case prefix: never reaches a route (JSON 404, no-store)
    for (const [method, path] of [
      ["POST", "/API/notifications/read-all"],
      ["POST", "/API/auth/logout"],
      ["POST", "/Api/uploads"],
      ["GET", "/API/auth/me"],
      ["GET", "/DL/whatever"],
    ]) {
      const res = await bare(method, path);
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.headers.get("cache-control"), "no-store", `${method} ${path}`);
      assert.equal((await res.json()).error.code, "not_found");
    }
    // mixed case after the prefix still matches a route, so the guard applies regardless of the path
    for (const path of ["/api/AUTH/logout", "/api/Notifications/read-all"]) {
      const res = await bare("POST", path);
      assert.equal(res.status, 403, path);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    // any non-API state-changing request is guarded too
    assert.equal((await bare("POST", "/qualquer-coisa")).status, 403);
    // the session survived every attempt above
    assert.equal((await agent.get("/api/auth/me")).status, 200);
    // and the Mercado Pago webhook stays reachable without the header (signature checked there)
    const hook = await fetch(`${server.url}/api/webhooks/mercadopago`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(hook.status, 401);
  });

  test("unknown API paths answer JSON 404", async () => {
    const res = await createAgent(server).get("/api/nada-aqui");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "not_found");
  });
});

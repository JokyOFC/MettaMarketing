import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createAgent, createClientWithBrand, createUser, lastEmail, login, startTestServer } from "./helpers.js";

let server;
let admin;
before(async () => {
  server = await startTestServer();
  const adminUser = await createUser(server.ctx, { role: "admin", name: "Administração" });
  admin = await login(server, { email: adminUser.email });
});
after(async () => {
  await server?.close();
});

let counter = 0;
const person = (overrides = {}) => {
  counter += 1;
  return {
    name: "Ana Souza",
    email: `ana.${Date.now().toString(36)}${counter}@exemplo.test`,
    company: `Empresa ${counter}`,
    phone: "(11) 98888-7777",
    document: "12.345.678/0001-90",
    password: "senha-forte-do-cadastro",
    acceptTerms: true,
    ...overrides,
  };
};

const confirmToken = async (email) => {
  const text = (await lastEmail(server.ctx, email))?.text_body ?? "";
  return /\/confirmar-email\/([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
};
const userRow = (email) => server.db.get("SELECT * FROM users WHERE email = ?", [email]);
const clientCount = async () => (await server.db.get("SELECT COUNT(*) AS n FROM clients")).n;

describe("self sign-up", () => {
  test("is open by default", async () => {
    const res = await createAgent(server).get("/api/auth/signup");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { enabled: true });
  });

  test("creates the company and a pending access, confirmed only through the e-mail link", async () => {
    const input = person();
    const visitor = createAgent(server);
    const res = await visitor.post("/api/auth/signup", input);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { email: input.email });

    const user = await userRow(input.email);
    assert.equal(user.status, "pending");
    assert.equal(user.role, "client");
    assert.ok(user.password_hash.startsWith("scrypt$"));
    assert.ok(user.terms_accepted_at);
    const client = await server.db.get("SELECT * FROM clients WHERE id = ?", [user.client_id]);
    assert.equal(client.name, input.company);
    assert.equal(client.source, "signup");
    assert.equal(client.document, input.document);
    assert.equal(client.contact_email, input.email);
    assert.equal(visitor.cookie, null, "no session before the e-mail is confirmed");

    // Not active yet: the right password gets a specific answer, a wrong one the generic answer.
    const early = await createAgent(server).post("/api/auth/login", { email: input.email, password: input.password });
    assert.equal(early.status, 403);
    assert.equal(early.body.error.code, "email_not_verified");
    const wrong = await createAgent(server).post("/api/auth/login", { email: input.email, password: "outra-senha-qualquer" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "invalid_credentials");

    const token = await confirmToken(input.email);
    assert.ok(token, "the confirmation link is in the outbox");
    const mail = await lastEmail(server.ctx, input.email);
    assert.equal(mail.status, "not_configured");

    // Opening the link (GET) only checks it.
    const peek = await createAgent(server).get(`/api/auth/verify/${token}`);
    assert.equal(peek.status, 200);
    assert.deepEqual(peek.body, { email: input.email, name: input.name, company: input.company });
    assert.equal((await userRow(input.email)).status, "pending");

    const confirm = await visitor.post("/api/auth/verify", { token });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.user.email, input.email);
    assert.equal(confirm.body.user.role, "client");
    assert.deepEqual(confirm.body.user.client, { id: user.client_id, name: input.company });
    assert.equal((await userRow(input.email)).status, "active");
    const me = await visitor.get("/api/auth/me");
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user.brands, []);

    // single use
    const again = await createAgent(server).post("/api/auth/verify", { token });
    assert.equal(again.status, 410);
    assert.equal((await createAgent(server).get(`/api/auth/verify/${token}`)).status, 410);

    // the team hears about it and sees where the account came from
    const notes = (await admin.get("/api/notifications")).body.items;
    const note = notes.find((n) => n.type === "client.signed_up" && n.entityId === user.client_id);
    assert.ok(note, "admins are notified after the confirmation");
    assert.equal(note.link, `/admin/clientes/${user.client_id}`);
    const list = (await admin.get(`/api/clients?q=${encodeURIComponent(input.company)}`)).body.items;
    assert.equal(list.find((c) => c.id === user.client_id)?.source, "signup");

    // and the person can log in normally now
    const agent = await login(server, { email: input.email, password: input.password });
    assert.equal(agent.user.client.id, user.client_id);
  });

  test("never reveals whether an e-mail already has an access", async () => {
    const { clientId } = await createClientWithBrand(server.ctx, { name: "Cliente Existente" });
    const existing = await createUser(server.ctx, { role: "client", clientId });
    const before = await clientCount();
    const res = await createAgent(server).post("/api/auth/signup", person({ email: existing.email }));
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { email: existing.email });
    assert.equal(await clientCount(), before, "no second account");
    assert.equal((await userRow(existing.email)).status, "active");
    const notice = await lastEmail(server.ctx, existing.email);
    assert.match(notice.subject, /Tentativa de cadastro/);
    assert.doesNotMatch(notice.text_body, /confirmar-email/);
  });

  test("a second sign-up while pending re-sends the link, not a second account", async () => {
    const input = person();
    await createAgent(server).post("/api/auth/signup", input);
    const first = await confirmToken(input.email);
    const before = await clientCount();
    // within a minute: no new e-mail
    assert.equal((await createAgent(server).post("/api/auth/signup", { ...input, company: "Outra" })).status, 202);
    assert.equal(await confirmToken(input.email), first);
    // later: a fresh link, and the previous one stops working
    await server.db.run("UPDATE auth_tokens SET created_at = ? WHERE purpose = 'verify'", [new Date(Date.now() - 5 * 60_000).toISOString()]);
    assert.equal((await createAgent(server).post("/api/auth/signup/resend", { email: input.email })).status, 202);
    const second = await confirmToken(input.email);
    assert.ok(second && second !== first);
    assert.equal((await createAgent(server).get(`/api/auth/verify/${first}`)).status, 410);
    assert.equal(await clientCount(), before);
    // the resend answer is the same for unknown addresses
    assert.equal((await createAgent(server).post("/api/auth/signup/resend", { email: "ninguem@exemplo.test" })).status, 202);
  });

  test("validates the form and drops bots", async () => {
    const agent = createAgent(server);
    const missing = await agent.post("/api/auth/signup", person({ acceptTerms: false, document: "123", password: "curta" }));
    assert.equal(missing.status, 422);
    assert.ok(missing.body.error.fields.acceptTerms);
    const invalid = await agent.post("/api/auth/signup", person({ document: "123", password: "curta" }));
    assert.equal(invalid.status, 422);
    assert.ok(invalid.body.error.fields.document);
    assert.ok(invalid.body.error.fields.password);
    const noCompany = await agent.post("/api/auth/signup", person({ company: "  " }));
    assert.equal(noCompany.status, 422);
    assert.ok(noCompany.body.error.fields.company);

    const before = await clientCount();
    const bot = person({ website: "https://spam.example" });
    const res = await agent.post("/api/auth/signup", bot);
    assert.equal(res.status, 202);
    assert.equal(await clientCount(), before);
    assert.equal(await userRow(bot.email), undefined);
  });

  test("the team can close sign-up", async () => {
    const closed = await admin.patch("/api/settings", { signupEnabled: false });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.settings.signupEnabled, false);
    assert.deepEqual((await createAgent(server).get("/api/auth/signup")).body, { enabled: false });
    const res = await createAgent(server).post("/api/auth/signup", person());
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "signup_closed");
    assert.equal((await admin.patch("/api/settings", { signupEnabled: true })).body.settings.signupEnabled, true);
  });

  test("a new account sees nothing of other clients", async () => {
    const other = await createClientWithBrand(server.ctx, { name: "Cliente Vizinho", brandName: "Marca Vizinha" });
    const input = person();
    const visitor = createAgent(server);
    await visitor.post("/api/auth/signup", input);
    await visitor.post("/api/auth/verify", { token: await confirmToken(input.email) });
    assert.equal((await visitor.get(`/api/brands/${other.brandId}/library`)).status, 404);
    assert.equal((await visitor.get("/api/clients")).status, 403);
    const kits = await visitor.get("/api/kits");
    assert.equal(kits.status, 200);
    assert.deepEqual(kits.body.items, []);
  });
});

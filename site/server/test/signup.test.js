import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createAgent, createClientWithBrand, createUser, login, startTestServer } from "./helpers.js";

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

const userRow = (email) => server.db.get("SELECT * FROM users WHERE email = ?", [email]);
const clientCount = async () => (await server.db.get("SELECT COUNT(*) AS n FROM clients")).n;

describe("self sign-up", () => {
  test("is open by default", async () => {
    const res = await createAgent(server).get("/api/auth/signup");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { enabled: true });
  });

  test("creates the company and an active access, signed in right away", async () => {
    const input = person();
    const visitor = createAgent(server);
    const res = await visitor.post("/api/auth/signup", input);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, input.email);
    assert.equal(res.body.user.role, "client");
    assert.deepEqual(res.body.user.capabilities, ["portal.access"]);
    assert.equal(res.body.user.password_hash, undefined);

    const user = await userRow(input.email);
    assert.equal(user.status, "active");
    assert.ok(user.password_hash.startsWith("scrypt$"));
    assert.ok(user.terms_accepted_at);
    assert.deepEqual(res.body.user.client, { id: user.client_id, name: input.company });
    const client = await server.db.get("SELECT * FROM clients WHERE id = ?", [user.client_id]);
    assert.equal(client.name, input.company);
    assert.equal(client.source, "signup");
    assert.equal(client.document, input.document);
    assert.equal(client.contact_email, input.email);

    // signed in: the session cookie works at once
    assert.ok(visitor.cookie, "a session cookie is set");
    const me = await visitor.get("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, user.id);
    assert.deepEqual(me.body.user.brands, []);

    // no e-mail is needed to get in
    assert.equal((await server.db.get("SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ?", [user.id])).n, 0);

    // the team hears about it and sees where the account came from
    const notes = (await admin.get("/api/notifications")).body.items;
    const note = notes.find((n) => n.type === "client.signed_up" && n.entityId === user.client_id);
    assert.ok(note, "admins are notified");
    assert.equal(note.link, `/admin/clientes/${user.client_id}`);
    const list = (await admin.get(`/api/clients?q=${encodeURIComponent(input.company)}`)).body.items;
    assert.equal(list.find((c) => c.id === user.client_id)?.source, "signup");

    // and the person logs in normally afterwards
    const agent = await login(server, { email: input.email, password: input.password });
    assert.equal(agent.user.client.id, user.client_id);
  });

  test("an e-mail that already has an access is refused", async () => {
    const { clientId } = await createClientWithBrand(server.ctx, { name: "Cliente Existente" });
    const existing = await createUser(server.ctx, { role: "client", clientId });
    const before = await clientCount();
    const res = await createAgent(server).post("/api/auth/signup", person({ email: existing.email.toUpperCase() }));
    assert.equal(res.status, 422);
    assert.match(res.body.error.fields.email, /já tem um acesso/);
    assert.equal(await clientCount(), before, "no second account");
    assert.equal((await userRow(existing.email)).client_id, clientId);
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
    assert.equal(res.status, 400);
    assert.equal(agent.cookie, null);
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
    const visitor = createAgent(server);
    assert.equal((await visitor.post("/api/auth/signup", person())).status, 201);
    assert.equal((await visitor.get(`/api/brands/${other.brandId}/library`)).status, 404);
    assert.equal((await visitor.get("/api/clients")).status, 403);
    const kits = await visitor.get("/api/kits");
    assert.equal(kits.status, 200);
    assert.deepEqual(kits.body.items, []);
  });
});

// Clients, brands, client users and team management (slice E), including
// scope isolation: out-of-scope ids answer 404, missing capabilities 403.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  addStaffAccess,
  createAgent,
  createClientWithBrand,
  createProject,
  createUser,
  lastEmail,
  login,
  startTestServer,
  TEST_PASSWORD,
} from "./helpers.js";

const VALID_CNPJ = "11.222.333/0001-81";

let server;
let ctx;
const u = {};
const a = {};
const f = {};

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;
  const one = await createClientWithBrand(ctx, { name: "Cliente Um", brandName: "Marca Um" });
  const two = await createClientWithBrand(ctx, { name: "Cliente Dois", brandName: "Marca Dois" });
  Object.assign(f, { clientA: one.clientId, brandA: one.brandId, clientB: two.clientId, brandB: two.brandId });

  u.admin = await createUser(ctx, { role: "admin", name: "Admin Principal" });
  u.manager = await createUser(ctx, { role: "manager", name: "Gestora A" });
  u.managerNone = await createUser(ctx, { role: "manager", name: "Gestor Sem Acesso" });
  u.designer = await createUser(ctx, { role: "designer", name: "Designer A" });
  u.finance = await createUser(ctx, { role: "finance", name: "Financeiro" });
  u.clientA = await createUser(ctx, { role: "client", clientId: f.clientA, name: "Cliente A" });
  await addStaffAccess(ctx, u.manager.id, f.clientA);
  f.projectA = (await createProject(ctx, { brandId: f.brandA, memberIds: [u.designer.id] })).id;

  for (const [key, user] of Object.entries(u)) a[key] = await login(server, { email: user.email });
});

after(() => server?.close());

describe("clients", () => {
  test("admin creates a client with its first brand, a manager and an invited user (criterion 1)", async () => {
    const res = await a.admin.post("/api/clients", {
      name: "Aurora Pagamentos",
      legalName: "Aurora Pagamentos S.A.",
      document: "11222333000181",
      contactName: "Ana",
      contactEmail: "ana@aurora.test",
      contactPhone: "(11) 99999-0000",
      internalNotes: "Cliente estratégico",
      brand: { name: "Aurora", description: "Marca principal" },
      managerIds: [u.manager.id],
      user: { name: "Bruno Aurora", email: "bruno@aurora.test" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.client.name, "Aurora Pagamentos");
    assert.equal(res.body.client.document, VALID_CNPJ);
    assert.equal(res.body.client.internalNotes, "Cliente estratégico");
    assert.equal(res.body.brand.name, "Aurora");
    assert.equal(res.body.brand.slug, "aurora");
    assert.equal(res.body.user.status, "invited");
    // e-mail is not configured in tests: the link comes back for the team to hand over
    assert.equal(res.body.emailStatus, "not_configured");
    assert.match(res.body.inviteUrl, /\/convite\/[A-Za-z0-9_-]{20,}$/);
    assert.equal((await lastEmail(ctx, "bruno@aurora.test")).status, "not_configured");

    // the manager got access and an in-app notice
    const clientId = res.body.client.id;
    assert.ok(await ctx.db.get("SELECT 1 AS y FROM staff_client_access WHERE user_id = ? AND client_id = ?", [u.manager.id, clientId]));
    assert.ok(await ctx.db.get("SELECT 1 AS y FROM notifications WHERE user_id = ? AND entity_id = ?", [u.manager.id, clientId]));
    const logged = (await ctx.db.all("SELECT action FROM activity_log WHERE client_id = ?", [clientId])).map((r) => r.action);
    for (const action of ["client.created", "brand.created", "user.invited"]) assert.ok(logged.includes(action), action);

    // the invitation works end to end
    const token = res.body.inviteUrl.split("/convite/")[1];
    const guest = createAgent(server);
    const accepted = await guest.post("/api/auth/invite/accept", { token, password: "senha-muito-boa-1" });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.user.client.id, clientId);
    assert.deepEqual(accepted.body.user.brands.map((b) => b.name), ["Aurora"]);
  });

  test("validation: CNPJ, required name and duplicate e-mail", async () => {
    let res = await a.admin.post("/api/clients", { name: "", document: "11.111.111/1111-11" });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.name);
    assert.match(res.body.error.fields.document, /CNPJ/);
    res = await a.admin.post("/api/clients", { name: "Outro", user: { name: "X", email: u.clientA.email } });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields["user.email"]);
  });

  test("only admins create clients", async () => {
    for (const key of ["manager", "designer", "finance", "clientA"]) {
      const res = await a[key].post("/api/clients", { name: "Tentativa" });
      assert.equal(res.status, 403, key);
    }
  });

  test("lists follow the scope of each role", async () => {
    const names = async (agent) => (await agent.get("/api/clients")).body.items.map((c) => c.name);
    assert.ok((await names(a.admin)).includes("Cliente Dois"));
    const managerList = await names(a.manager);
    assert.ok(managerList.includes("Cliente Um"));
    assert.ok(!managerList.includes("Cliente Dois"));
    assert.deepEqual(await names(a.managerNone), []);
    assert.deepEqual(await names(a.designer), ["Cliente Um"]);
    assert.equal((await a.clientA.get("/api/clients")).status, 403);

    const one = (await a.admin.get("/api/clients?q=Marca%20Um")).body.items;
    assert.equal(one.length, 1);
    assert.equal(one[0].brandCount, 1);
    assert.equal(one[0].projectCount, 1);
    assert.equal(one[0].userCount, 1);
  });

  test("search never matches fields the role cannot read (designer: no CNPJ or contacts)", async () => {
    await ctx.db.run("UPDATE clients SET document = ?, contact_email = ?, contact_name = ? WHERE id = ?", [
      "44.555.666/0001-77",
      "ceo-secreto@um.test",
      "Contato Sigiloso",
      f.clientA,
    ]);
    const count = async (agent, q) => (await agent.get(`/api/clients?q=${encodeURIComponent(q)}`)).body.items.length;
    for (const q of ["44.555", "ceo-secreto", "Sigiloso"]) {
      assert.equal(await count(a.designer, q), 0, `designer probing ${q}`);
      assert.equal(await count(a.manager, q), 1, `manager searching ${q}`);
    }
    assert.equal(await count(a.designer, "Cliente Um"), 1, "name still matches");
    assert.equal(await count(a.designer, "Marca Um"), 1, "brand of the designer's project matches");
    // brand names outside the designer's projects are not searchable either
    const hidden = await ctx.db.get("SELECT id FROM brands WHERE client_id = ? AND name = 'Marca Oculta'", [f.clientA]);
    if (!hidden)
      await ctx.db.run(
        "INSERT INTO brands (id, client_id, name, slug, status, created_at, updated_at) VALUES ('brd_searchHidden001', ?, 'Marca Oculta', 'marca-oculta', 'active', ?, ?)",
        [f.clientA, new Date().toISOString(), new Date().toISOString()],
      );
    assert.equal(await count(a.designer, "Marca Oculta"), 0);
    assert.equal(await count(a.manager, "Marca Oculta"), 1);
    await ctx.db.run("DELETE FROM brands WHERE id = 'brd_searchHidden001'");
    await ctx.db.run("UPDATE clients SET document = NULL, contact_email = NULL, contact_name = NULL WHERE id = ?", [f.clientA]);
  });

  test("detail: 404 outside the scope, internal data only for the team", async () => {
    assert.equal((await a.managerNone.get(`/api/clients/${f.clientA}`)).status, 404);
    assert.equal((await a.manager.get(`/api/clients/${f.clientB}`)).status, 404);
    assert.equal((await a.designer.get(`/api/clients/${f.clientB}`)).status, 404);

    const res = await a.manager.get(`/api/clients/${f.clientA}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.brands.length, 1);
    assert.equal(res.body.brands[0].counts.projects, 1);
    assert.equal(res.body.users.length, 1);
    assert.equal(res.body.projects.length, 1);
    assert.deepEqual(res.body.managers.map((m) => m.id), [u.manager.id]);
    assert.equal(res.body.permissions.canEditSensitive, false);
    assert.equal(res.body.permissions.canManageAccess, false);

    const designer = await a.designer.get(`/api/clients/${f.clientA}`);
    assert.equal(designer.status, 200);
    assert.equal(designer.body.client.internalNotes, undefined);
    assert.equal(designer.body.client.document, undefined);
    assert.deepEqual(designer.body.users, []);
    assert.deepEqual(designer.body.managers, []);
  });

  test("managers edit contacts and notes, not sensitive data", async () => {
    let res = await a.manager.patch(`/api/clients/${f.clientA}`, { contactName: "Carla", internalNotes: "Prefere WhatsApp" });
    assert.equal(res.status, 200);
    assert.equal(res.body.client.contactName, "Carla");
    res = await a.manager.patch(`/api/clients/${f.clientA}`, { name: "Novo nome" });
    assert.equal(res.status, 403);
    assert.equal((await a.managerNone.patch(`/api/clients/${f.clientA}`, { contactName: "X" })).status, 404);
    assert.equal((await a.designer.patch(`/api/clients/${f.clientA}`, { contactName: "X" })).status, 403);
    res = await a.admin.patch(`/api/clients/${f.clientA}`, { name: "Cliente Um", status: "paused" });
    assert.equal(res.status, 200);
    assert.equal(res.body.client.status, "paused");
    await a.admin.patch(`/api/clients/${f.clientA}`, { status: "active" });
  });
});

describe("brands", () => {
  test("create, edit and archive within scope", async () => {
    let res = await a.manager.post(`/api/clients/${f.clientA}/brands`, { name: "Marca Um Kids", description: "Linha infantil" });
    assert.equal(res.status, 201);
    const brand = res.body.brand;
    assert.equal(brand.clientId, f.clientA);
    assert.equal(brand.slug, "marca-um-kids");
    res = await a.manager.post(`/api/clients/${f.clientA}/brands`, { name: "marca um kids" });
    assert.equal(res.status, 422);
    assert.equal((await a.managerNone.post(`/api/clients/${f.clientA}/brands`, { name: "X" })).status, 404);
    assert.equal((await a.designer.patch(`/api/brands/${f.brandA}`, { description: "X" })).status, 403);

    res = await a.manager.patch(`/api/brands/${brand.id}`, { usageGuidelines: "Respeite a área de proteção.", internalNotes: "Só equipe" });
    assert.equal(res.status, 200);
    // guidelines stay a team draft until the identity release (D3)
    assert.equal(res.body.brand.usageGuidelines, null);
    assert.equal(res.body.brand.usageGuidelinesDraft, "Respeite a área de proteção.");
    assert.equal(res.body.brand.hasUnreleasedGuidelines, true);
    assert.equal(res.body.brand.internalNotes, "Só equipe");
    const seen = await a.clientA.get(`/api/brands/${brand.id}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.brand.usageGuidelines, null);
    assert.ok(!("usageGuidelinesDraft" in seen.body.brand));
    assert.ok(!JSON.stringify(seen.body).includes("proteção"), "draft text never reaches the client");
    const listed = (await a.clientA.get("/api/brands")).body.items.find((b) => b.id === brand.id);
    assert.equal(listed.usageGuidelines, null);

    // guidelines sent on creation are a draft too
    res = await a.manager.post(`/api/clients/${f.clientA}/brands`, { name: "Marca Um Pet", typographyGuidelines: "Títulos em Raleway." });
    assert.equal(res.status, 201);
    assert.equal(res.body.brand.typographyGuidelines, null);
    assert.equal(res.body.brand.typographyGuidelinesDraft, "Títulos em Raleway.");
    assert.equal((await a.clientA.get(`/api/brands/${res.body.brand.id}`)).body.brand.typographyGuidelines, null);
    await a.manager.patch(`/api/brands/${res.body.brand.id}`, { status: "archived" });
    res = await a.manager.patch(`/api/brands/${brand.id}`, { status: "archived" });
    assert.equal(res.body.brand.status, "archived");
    assert.equal((await a.clientA.get(`/api/brands/${brand.id}`)).status, 404);
  });

  test("clients see only their own active brands, without internal notes", async () => {
    await ctx.db.run("UPDATE brands SET internal_notes = 'segredo' WHERE id = ?", [f.brandA]);
    const res = await a.clientA.get("/api/brands");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((b) => b.id), [f.brandA]);
    assert.equal(res.body.items[0].internalNotes, undefined);
    assert.equal(res.body.items[0].counts, undefined);
    assert.equal((await a.clientA.get(`/api/brands/${f.brandB}`)).status, 404);
    const staff = await a.admin.get(`/api/brands/${f.brandA}`);
    assert.equal(staff.body.brand.internalNotes, "segredo");
    assert.equal((await a.designer.get(`/api/brands/${f.brandB}`)).status, 404);
  });
});

describe("client users", () => {
  test("invite, resend, disable (revokes sessions) and re-enable", async () => {
    let res = await a.manager.post(`/api/clients/${f.clientA}/users`, { name: "Dora", email: "dora@um.test" });
    assert.equal(res.status, 201);
    assert.ok(res.body.inviteUrl);
    const dora = res.body.user;
    assert.equal(dora.status, "invited");
    assert.ok(dora.invite.expiresAt);

    res = await a.manager.post(`/api/clients/${f.clientA}/users`, { name: "Dora 2", email: "DORA@um.test" });
    assert.equal(res.status, 422);
    assert.equal((await a.managerNone.post(`/api/clients/${f.clientA}/users`, { name: "X", email: "x@um.test" })).status, 404);
    assert.equal((await a.designer.post(`/api/clients/${f.clientA}/users`, { name: "X", email: "x@um.test" })).status, 403);

    // resending right away is throttled, later it works and the old link stops working
    const firstToken = res.body.inviteUrl;
    res = await a.manager.post(`/api/users/${dora.id}/invite`);
    assert.equal(res.status, 429);
    await ctx.db.run("UPDATE auth_tokens SET created_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?", [dora.id]);
    res = await a.manager.post(`/api/users/${dora.id}/invite`);
    assert.equal(res.status, 200);
    assert.ok(res.body.inviteUrl);
    assert.notEqual(res.body.inviteUrl, firstToken);
    assert.equal((await a.managerNone.post(`/api/users/${dora.id}/invite`)).status, 404);

    // disabling an active client user ends their session at once
    const clientAgent = await login(server, { email: u.clientA.email, password: TEST_PASSWORD });
    assert.equal((await clientAgent.get("/api/auth/me")).status, 200);
    res = await a.manager.patch(`/api/clients/${f.clientA}/users/${u.clientA.id}`, { status: "disabled" });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.status, "disabled");
    assert.equal((await clientAgent.get("/api/auth/me")).status, 401);
    assert.equal((await a.manager.post(`/api/users/${u.clientA.id}/invite`)).status, 409);
    res = await a.manager.patch(`/api/clients/${f.clientA}/users/${u.clientA.id}`, { status: "active" });
    assert.equal(res.body.user.status, "active");
    a.clientA = await login(server, { email: u.clientA.email });

    // an invited person re-enabled goes back to "invited"
    await a.manager.patch(`/api/clients/${f.clientA}/users/${dora.id}`, { status: "disabled" });
    res = await a.manager.patch(`/api/clients/${f.clientA}/users/${dora.id}`, { status: "active" });
    assert.equal(res.body.user.status, "invited");
    // users of another client are out of reach
    assert.equal((await a.manager.patch(`/api/clients/${f.clientB}/users/${dora.id}`, { status: "disabled" })).status, 404);
  });
});

describe("team", () => {
  test("team.view lists staff only; team.manage invites", async () => {
    let res = await a.manager.get("/api/team/users");
    assert.equal(res.status, 200);
    assert.ok(res.body.items.every((item) => item.role !== "client"));
    assert.equal(res.body.permissions.canManage, false);
    const managerRow = res.body.items.find((item) => item.id === u.manager.id);
    assert.equal(managerRow.access.kind, "clients");
    assert.ok(managerRow.access.clients.some((c) => c.id === f.clientA));
    const designerRow = res.body.items.find((item) => item.id === u.designer.id);
    assert.deepEqual(designerRow.access.clients.map((c) => c.id), [f.clientA]);
    assert.equal((await a.designer.get("/api/team/users")).status, 403);
    assert.equal((await a.finance.get("/api/team/users")).status, 403);

    const roles = (await a.manager.get("/api/team/roles")).body.items;
    assert.ok(roles.find((r) => r.role === "admin").capabilities.includes("team.manage"));
    assert.ok(!roles.find((r) => r.role === "manager").capabilities.includes("clients.create"));

    assert.equal((await a.manager.post("/api/team/users", { name: "X", email: "x@metta.test", role: "designer" })).status, 403);
    res = await a.admin.post("/api/team/users", {
      name: "Nova Gestora",
      email: "nova@metta.test",
      role: "manager",
      jobTitle: "Atendimento",
      clientIds: [f.clientB],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.status, "invited");
    assert.equal(res.body.user.jobTitle, "Atendimento");
    assert.ok(res.body.inviteUrl);
    assert.deepEqual(res.body.user.access.clients.map((c) => c.id), [f.clientB]);
    res = await a.admin.post("/api/team/users", { name: "Y", email: "y@metta.test", role: "client" });
    assert.equal(res.status, 422);
  });

  test("with e-mail configured the invite link is never returned", async () => {
    const mailServer = await startTestServer({ mailTransport: { jsonTransport: true } });
    try {
      const admin = await createUser(mailServer.ctx, { role: "admin" });
      const agent = await login(mailServer, { email: admin.email });
      const res = await agent.post("/api/team/users", { name: "Z", email: "z@metta.test", role: "designer" });
      assert.equal(res.status, 201);
      assert.equal(res.body.inviteUrl, undefined);
      assert.equal(res.body.emailStatus, "sent");
      assert.equal((await lastEmail(mailServer.ctx, "z@metta.test")).status, "sent");
    } finally {
      await mailServer.close();
    }
  });

  test("roles and status: last admin, self changes and session revocation", async () => {
    let res = await a.admin.patch(`/api/team/users/${u.admin.id}`, { role: "manager" });
    assert.equal(res.status, 409);
    res = await a.admin.patch(`/api/team/users/${u.admin.id}`, { status: "disabled" });
    assert.equal(res.status, 409);
    assert.equal((await a.manager.patch(`/api/team/users/${u.designer.id}`, { role: "manager" })).status, 403);
    assert.equal((await a.admin.patch(`/api/team/users/${u.clientA.id}`, { name: "X" })).status, 404);

    // a second admin cannot demote the first while two exist... but can when another stays
    const second = await createUser(ctx, { role: "admin", name: "Segunda Admin" });
    const secondAgent = await login(server, { email: second.email });
    res = await secondAgent.patch(`/api/team/users/${u.admin.id}`, { jobTitle: "Direção" });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.jobTitle, "Direção");
    res = await a.admin.patch(`/api/team/users/${second.id}`, { role: "finance" });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, "finance");
    // now u.admin is the only active admin again
    res = await secondAgent.patch(`/api/team/users/${u.admin.id}`, { role: "designer" });
    assert.equal(res.status, 403); // second is finance now: no team.manage

    const temp = await createUser(ctx, { role: "designer", name: "Temporário" });
    const tempAgent = await login(server, { email: temp.email });
    res = await a.admin.patch(`/api/team/users/${temp.id}`, { status: "disabled" });
    assert.equal(res.body.user.status, "disabled");
    assert.equal((await tempAgent.get("/api/auth/me")).status, 401);
    res = await a.admin.patch(`/api/team/users/${temp.id}`, { status: "active" });
    assert.equal(res.body.user.status, "active");
  });

  test("client access for managers only", async () => {
    let res = await a.admin.put(`/api/team/users/${u.managerNone.id}/clients`, { clientIds: [f.clientB] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.added, [f.clientB]);
    const fresh = await login(server, { email: u.managerNone.email });
    assert.equal((await fresh.get(`/api/clients/${f.clientB}`)).status, 200);
    assert.equal((await fresh.get(`/api/clients/${f.clientA}`)).status, 404);
    assert.ok(await ctx.db.get("SELECT 1 AS y FROM notifications WHERE user_id = ? AND type = 'team.client_access'", [u.managerNone.id]));

    res = await a.admin.put(`/api/team/users/${u.designer.id}/clients`, { clientIds: [f.clientB] });
    assert.equal(res.status, 422);
    assert.equal((await a.manager.put(`/api/team/users/${u.managerNone.id}/clients`, { clientIds: [] })).status, 403);

    // from the client screen
    res = await a.admin.post(`/api/clients/${f.clientA}/managers`, { userId: u.managerNone.id });
    assert.equal(res.status, 201);
    assert.ok(res.body.managers.some((m) => m.id === u.managerNone.id));
    assert.equal((await a.admin.post(`/api/clients/${f.clientA}/managers`, { userId: u.designer.id })).status, 422);
    assert.equal((await a.manager.post(`/api/clients/${f.clientA}/managers`, { userId: u.managerNone.id })).status, 403);
    res = await a.admin.del(`/api/clients/${f.clientA}/managers/${u.managerNone.id}`);
    assert.equal(res.status, 200);
    assert.equal((await a.admin.del(`/api/clients/${f.clientA}/managers/${u.managerNone.id}`)).status, 404);
  });
});

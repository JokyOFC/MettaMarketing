// Notifications, categories and settings (slice H): own-rows-only
// notifications, category management rules, admin-only settings, integration
// status and the redacted e-mail outbox.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { newId } from "../lib/ids.js";
import { notify } from "../lib/notify.js";
import { now } from "../lib/time.js";
import { createAgent, createClientWithBrand, createUser, insertMaterial, login, startTestServer } from "./helpers.js";

let server;
let ctx;
const u = {};
const a = {};

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;
  const { clientId, brandId } = await createClientWithBrand(ctx, { name: "Cliente A" });
  u.admin = await createUser(ctx, { role: "admin", name: "Admin" });
  u.manager = await createUser(ctx, { role: "manager" });
  u.designer = await createUser(ctx, { role: "designer" });
  u.client = await createUser(ctx, { role: "client", clientId, name: "Cliente" });
  u.other = await createUser(ctx, { role: "client", clientId, name: "Outra pessoa" });
  for (const key of Object.keys(u)) a[key] = await login(server, { email: u[key].email });
  await insertMaterial(ctx, { brandId, categorySlug: "stories", createdBy: u.admin.id });
});

after(async () => {
  await server?.close();
});

describe("notifications", () => {
  let mine;
  let theirs;
  before(async () => {
    mine = [];
    for (const n of [1, 2, 3]) mine.push((await notify(ctx, [u.client.id], { type: "test", title: `Aviso ${n}`, link: "/painel" }))[0]);
    theirs = (await notify(ctx, [u.other.id], { type: "test", title: "Aviso de outra pessoa" }))[0];
    await ctx.db.run("UPDATE notifications SET read_at = ? WHERE id = ?", [now(), mine[0]]);
  });

  test("lists only the caller's rows, newest first, with unread totals", async () => {
    const res = await a.client.get("/api/notifications");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.unread, 2);
    assert.ok(res.body.items.every((item) => item.id !== theirs));
    assert.deepEqual(Object.keys(res.body.items[0]).sort(), ["body", "createdAt", "entityId", "entityType", "id", "link", "readAt", "title", "type"]);

    const unread = await a.client.get("/api/notifications?unread=1");
    assert.equal(unread.body.total, 2);
    assert.ok(unread.body.items.every((item) => item.readAt === null));

    const paged = await a.client.get("/api/notifications?pageSize=1&page=2");
    assert.equal(paged.body.items.length, 1);
    assert.equal(paged.body.total, 3);

    assert.deepEqual((await a.client.get("/api/notifications/unread-count")).body, { unread: 2 });
  });

  test("marking someone else's notification answers 404", async () => {
    assert.equal((await a.client.post(`/api/notifications/${theirs}/read`)).status, 404);
    assert.equal((await ctx.db.get("SELECT read_at FROM notifications WHERE id = ?", [theirs])).read_at, null);
  });

  test("read one and read all touch only the caller's rows", async () => {
    const one = await a.client.post(`/api/notifications/${mine[1]}/read`);
    assert.equal(one.status, 200);
    assert.ok(one.body.notification.readAt);
    assert.equal(one.body.unread, 1);

    const all = await a.client.post("/api/notifications/read-all");
    assert.equal(all.status, 200);
    assert.equal(all.body.updated, 1);
    assert.equal((await a.client.get("/api/notifications/unread-count")).body.unread, 0);
    assert.equal((await a.other.get("/api/notifications/unread-count")).body.unread, 1);
  });

  test("requires a session", async () => {
    const anonymous = createAgent(server);
    assert.equal((await anonymous.get("/api/notifications")).status, 401);
    assert.equal((await anonymous.post("/api/notifications/read-all")).status, 401);
  });
});

describe("categories", () => {
  const find = (items, slug) => items.find((item) => item.slug === slug);

  test("everyone signed in lists active categories; only admins see material counts", async () => {
    const client = await a.client.get("/api/categories");
    assert.equal(client.status, 200);
    assert.equal(client.body.items.length, 11);
    assert.equal(client.body.items[0].slug, "logotipo");
    assert.equal(client.body.items[0].materialCount, undefined);
    assert.ok(client.body.items.every((item) => item.isSystem && item.archivedAt === null));

    const admin = await a.admin.get("/api/categories");
    assert.equal(find(admin.body.items, "stories").materialCount, 1);
    assert.equal((await a.designer.get("/api/categories")).body.items[0].materialCount, undefined);

    const identity = await a.designer.get("/api/categories?area=identity");
    assert.ok(identity.body.items.every((item) => item.area === "identity"));
  });

  test("only categories.manage creates categories", async () => {
    const body = { name: "Endomarketing", area: "other" };
    assert.equal((await a.client.post("/api/categories", body)).status, 403);
    assert.equal((await a.manager.post("/api/categories", body)).status, 403);
    assert.equal((await a.designer.post("/api/categories", body)).status, 403);
  });

  test("creates with a slug, default folder and position at the end of its area", async () => {
    const res = await a.admin.post("/api/categories", { name: "Ações de endomarketing", area: "other" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { category } = res.body;
    assert.equal(category.slug, "acoes-de-endomarketing");
    assert.equal(category.folder, "Ações de endomarketing");
    assert.equal(category.isSystem, false);
    const list = (await a.admin.get("/api/categories?area=other")).body.items;
    assert.equal(list[list.length - 1].id, category.id);

    const duplicate = await a.admin.post("/api/categories", { name: "ações de ENDOMARKETING", area: "content" });
    assert.equal(duplicate.status, 422);
    const badFolder = await a.admin.post("/api/categories", { name: "Pasta", area: "other", folder: "a/b" });
    assert.equal(badFolder.status, 422);
    assert.ok(badFolder.body.error.fields.folder);
    const badArea = await a.admin.post("/api/categories", { name: "Área", area: "financeiro" });
    assert.equal(badArea.status, 422);
  });

  test("system categories can be renamed but not archived or moved to another area", async () => {
    const logo = find((await a.admin.get("/api/categories")).body.items, "logotipo");
    assert.equal((await a.admin.patch(`/api/categories/${logo.id}`, { archived: true })).status, 403);
    assert.equal((await a.admin.patch(`/api/categories/${logo.id}`, { area: "content" })).status, 403);
    const renamed = await a.admin.patch(`/api/categories/${logo.id}`, { name: "Logotipos", folder: "Logotipos" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.category.name, "Logotipos");
    assert.equal(renamed.body.category.slug, "logotipo");
    assert.equal((await a.manager.patch(`/api/categories/${logo.id}`, { name: "X" })).status, 403);
  });

  test("custom categories archive, disappear for clients, restore and free their slug", async () => {
    const created = (await a.admin.post("/api/categories", { name: "Eventos", area: "content", folder: "Eventos" })).body.category;
    const archived = await a.admin.patch(`/api/categories/${created.id}`, { archived: true, area: "other" });
    assert.equal(archived.status, 200);
    assert.ok(archived.body.category.archivedAt);
    assert.equal(archived.body.category.area, "other");
    assert.ok(!(await a.client.get("/api/categories")).body.items.some((item) => item.id === created.id));
    assert.ok(!(await a.client.get("/api/categories?archived=1")).body.items.some((item) => item.id === created.id));
    assert.ok((await a.admin.get("/api/categories?archived=1")).body.items.some((item) => item.id === created.id));

    const again = await a.admin.post("/api/categories", { name: "Eventos", area: "content" });
    assert.equal(again.status, 201);
    assert.equal(again.body.category.slug, "eventos-2");
    const blocked = await a.admin.patch(`/api/categories/${created.id}`, { archived: false });
    assert.equal(blocked.status, 422);
    const restored = await a.admin.patch(`/api/categories/${created.id}`, { archived: false, name: "Eventos antigos" });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.category.archivedAt, null);
    assert.equal((await a.admin.patch("/api/categories/cat_inexistente000000", { name: "X" })).status, 404);
  });

  test("reorder follows the given ids inside each area", async () => {
    const identity = (await a.admin.get("/api/categories?area=identity")).body.items.map((item) => item.id);
    const reversed = [...identity].reverse();
    const res = await a.admin.post("/api/categories/reorder", { ids: reversed });
    assert.equal(res.status, 200);
    const after = (await a.client.get("/api/categories?area=identity")).body.items.map((item) => item.id);
    assert.deepEqual(after, reversed);
    const all = (await a.client.get("/api/categories")).body.items;
    assert.equal(all[0].area, "identity");
    assert.equal(all[all.length - 1].area, "other");
    assert.equal((await a.admin.post("/api/categories/reorder", { ids: ["cat_naoexiste00000000"] })).status, 422);
    assert.equal((await a.manager.post("/api/categories/reorder", { ids: reversed })).status, 403);
  });
});

describe("settings", () => {
  test("only admins read and change organization settings", async () => {
    assert.equal((await a.manager.get("/api/settings")).status, 403);
    assert.equal((await a.client.get("/api/settings")).status, 403);
    assert.equal((await a.manager.patch("/api/settings", { orgName: "X" })).status, 403);
    const res = await a.admin.get("/api/settings");
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.orgName, "Metta Marketing");
    assert.equal(res.body.settings.zipRetentionHours, 24);
    assert.equal(res.body.settings.defaultNotifyEmail, true);
  });

  test("validates and saves settings, logging the change", async () => {
    let res = await a.admin.patch("/api/settings", { zipRetentionHours: 0, supportEmail: "não é e-mail" });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.zipRetentionHours);
    assert.equal(res.body.error.fields.supportEmail, "Informe um e-mail válido.");

    res = await a.admin.patch("/api/settings", { orgName: "Metta", supportEmail: "Contato@Metta.test", zipRetentionHours: 48, defaultNotifyEmail: false });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.settings, { orgName: "Metta", supportEmail: "contato@metta.test", zipRetentionHours: 48, defaultNotifyEmail: false });
    assert.deepEqual((await a.admin.get("/api/settings")).body.settings, res.body.settings);
    const log = await ctx.db.get("SELECT * FROM activity_log WHERE action = 'settings.updated' ORDER BY id DESC LIMIT 1");
    assert.match(log.summary, /retenção dos ZIPs/);
    assert.equal(log.visibility, "internal");
  });

  test("integration status without credentials", async () => {
    assert.equal((await a.manager.get("/api/settings/integrations")).status, 403);
    const res = await a.admin.get("/api/settings/integrations");
    assert.equal(res.status, 200);
    const body = res.body;
    assert.equal(body.email.configured, false);
    assert.ok(body.email.from);
    assert.deepEqual(
      { configured: body.mercadopago.configured, mode: body.mercadopago.mode, webhookSecret: body.mercadopago.webhookSecret },
      { configured: false, mode: null, webhookSecret: false },
    );
    assert.equal(body.storage.driver, "local");
    assert.ok(body.storage.usedBytes > 0);
    assert.ok(body.storage.files >= 1);
    assert.equal(typeof body.ffmpeg.available, "boolean");
    assert.equal(typeof body.outbox.notConfigured, "number");
    assert.ok(!JSON.stringify(body).includes(ctx.config.appSecret));
  });

  test("outbox lists e-mails with status and hides one-time links", async () => {
    const res0 = await createAgent(server).post("/api/auth/password/forgot", { email: u.designer.email });
    assert.equal(res0.status, 204);
    await ctx.mailer.idle();
    const stored = await ctx.db.get("SELECT * FROM email_outbox WHERE to_email = ? ORDER BY created_at DESC LIMIT 1", [u.designer.email]);
    const token = /redefinir-senha\/([A-Za-z0-9_-]+)/.exec(stored.text_body)[1];

    assert.equal((await a.manager.get("/api/settings/outbox")).status, 403);
    const res = await a.admin.get("/api/settings/outbox");
    assert.equal(res.status, 200);
    const email = res.body.items.find((item) => item.id === stored.id);
    assert.equal(email.status, "not_configured");
    assert.equal(email.toUser.id, u.designer.id);
    assert.match(email.excerpt, /redefinir-senha\/\[link oculto\]/);
    assert.ok(!JSON.stringify(res.body).includes(token));
    assert.equal(email.text_body, undefined);
    assert.equal(email.html_body, undefined);
    assert.ok(res.body.counts.not_configured >= 1);
    assert.equal(res.body.configured, false);

    const filtered = await a.admin.get("/api/settings/outbox?status=sent");
    assert.equal(filtered.body.total, 0);

    const retry = await a.admin.post(`/api/settings/outbox/${stored.id}/retry`);
    assert.equal(retry.status, 503);
    assert.equal(retry.body.error.code, "integration_not_configured");
    assert.equal((await a.admin.post("/api/settings/email/test")).status, 503);
  });
});

describe("settings with integrations configured", () => {
  let configured;
  let admin;
  before(async () => {
    configured = await startTestServer({ mailTransport: { jsonTransport: true }, mpAccessToken: "TEST-123-abc", mpWebhookSecret: "segredo" });
    const user = await createUser(configured.ctx, { role: "admin" });
    admin = await login(configured, { email: user.email });
  });
  after(async () => {
    await configured?.close();
  });

  test("reports e-mail and Mercado Pago as configured, without secrets", async () => {
    const res = await admin.get("/api/settings/integrations");
    assert.equal(res.status, 200);
    assert.equal(res.body.email.configured, true);
    assert.deepEqual(
      { configured: res.body.mercadopago.configured, mode: res.body.mercadopago.mode, webhookSecret: res.body.mercadopago.webhookSecret },
      { configured: true, mode: "test", webhookSecret: true },
    );
    assert.ok(!JSON.stringify(res.body).includes("TEST-123-abc"));
    assert.ok(!JSON.stringify(res.body).includes("segredo"));
  });

  test("sends a test e-mail and retries a failed one", async () => {
    const test1 = await admin.post("/api/settings/email/test");
    assert.equal(test1.status, 200);
    assert.equal(test1.body.status, "sent");

    const id = newId("eml");
    await configured.db.run(
      `INSERT INTO email_outbox (id, to_email, subject, text_body, status, error, attempts, created_at)
       VALUES (?, 'pessoa@example.test', 'Assunto', 'Texto', 'failed', 'timeout', 1, ?)`,
      [id, now()],
    );
    const retry = await admin.post(`/api/settings/outbox/${id}/retry`);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.email.status, "sent");
    assert.equal(retry.body.email.attempts, 2);
    assert.equal((await admin.post(`/api/settings/outbox/${id}/retry`)).status, 409);
    assert.equal((await admin.post("/api/settings/outbox/eml_naoexiste000000/retry")).status, 404);
  });
});

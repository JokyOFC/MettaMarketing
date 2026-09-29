// End-to-end acceptance scenario of the owner spec (criteria 1-11), on one
// fresh test server, through the real HTTP API with a real session per role.
// The only shortcuts are the initial staff accounts (DB fixtures, like the
// first admin created by `npm run create-admin`), a 1-second link minted with
// the server's own signer to test expiry, and switching the Mercado Pago
// credentials on at runtime (config is read per request) against a local mock.
// Criterion 12 (mobile) is covered by the browser checks.
//
// Every response the two client users receive is scanned: no internal note,
// internal comment, draft, storage key or staff-only field may ever appear,
// and the second client never receives anything of the first one.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import { crc32, inflateRawSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { createAgent, createUser, login, pdf, png, startTestServer, svg, waitFor } from "./helpers.js";

const WEBHOOK_SECRET = "whsec-acceptance-7d1f";
const INTERNAL = "NOTA-INTERNA"; // every internal text below carries this marker
const PRIVATE_DRAFT = "RASCUNHO-PRIVADO"; // title of a material that is never released
const CLIENT_PASSWORD = "senha-cliente-norte-2026";
const OTHER_PASSWORD = "senha-outro-cliente-2026";

let server;
let mp;
const u = {}; // users
const as = {}; // agents (sessions)
const f = {}; // ids and facts gathered along the way
const bytes = {}; // uploaded buffers by file name
const norteIds = new Set(); // ids of the first client, never shown to the second
const scanned = { nina: 0, olga: 0 };

// ------------------------------------------------------------------ helpers

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const ids = (items) => (items ?? []).map((item) => item.id);
const idSet = (items) => new Set(ids(items));
const track = (...values) => values.flat().filter(Boolean).forEach((value) => norteIds.add(value));
const ok = (res, status, label = "") => assert.equal(res.status, status, `${label} ${JSON.stringify(res.body)?.slice(0, 600)}`);

// Keys a client must never receive, anywhere in a JSON body.
const STAFF_ONLY_KEYS = new Set([
  "internalNotes",
  "storageKey",
  "storage_key",
  "currentVersionId",
  "published",
  "ip",
  "userAgent",
  "passwordHash",
  "password_hash",
  "sha256",
  "resolvedBy",
  "externalReference",
]);

function walk(value, visit, path = "$") {
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child, `${path}.${key}`, value);
      walk(child, visit, `${path}.${key}`);
    }
  }
}

function scanClientBody(label, method, path, body) {
  if (!body || typeof body !== "object" || Buffer.isBuffer(body)) return;
  const where = `${label} ${method} ${path}`;
  const text = JSON.stringify(body);
  assert.ok(!text.includes(INTERNAL), `${where} leaked an internal note/comment: ${text.slice(0, 400)}`);
  assert.ok(!text.includes(PRIVATE_DRAFT), `${where} leaked a draft material`);
  walk(body, (key, child, at, parent) => {
    assert.ok(!STAFF_ONLY_KEYS.has(key), `${where} sent the staff-only field ${at}`);
    if (key === "visibility") assert.equal(child, "released", `${where} sent ${at} = ${child}`);
    if (key === "data" && "action" in parent) assert.fail(`${where} sent activity data at ${at}`);
  });
}

// Wraps an agent so every JSON answer passes `check(method, path, body)`.
function guarded(agent, check) {
  const request = async (method, path, options) => {
    const res = await agent.request(method, path, options);
    check(method, path, res.body);
    return res;
  };
  return {
    get cookie() {
      return agent.cookie;
    },
    user: agent.user,
    request,
    get: (path, options) => request("GET", path, options),
    post: (path, body, options = {}) => request("POST", path, { ...options, body }),
    patch: (path, body, options = {}) => request("PATCH", path, { ...options, body }),
    put: (path, body, options = {}) => request("PUT", path, { ...options, body }),
    del: (path, options) => request("DELETE", path, options),
  };
}

const guardFirstClient = (agent) =>
  guarded(agent, (method, path, body) => {
    scanned.nina += 1;
    scanClientBody("cliente Norte", method, path, body);
  });

// The second client additionally never sees a name, e-mail or id of the first one.
const guardOtherClient = (agent) =>
  guarded(agent, (method, path, body) => {
    scanned.olga += 1;
    scanClientBody("outro cliente", method, path, body);
    if (!body || typeof body !== "object" || Buffer.isBuffer(body)) return;
    const text = JSON.stringify(body);
    for (const needle of ["Norte", "norte.test", ...norteIds])
      assert.ok(!text.includes(needle), `outro cliente ${method} ${path} received “${needle}”: ${text.slice(0, 300)}`);
  });

async function upload(agent, filename, buffer, contentType) {
  bytes[filename] = buffer;
  const res = await agent.upload("/api/uploads", { buffer, filename, contentType });
  ok(res, 201, `upload ${filename}`);
  assert.equal(res.body.upload.sizeBytes, buffer.length);
  return res.body.upload.id;
}

// Minimal ZIP reader: central directory + stored/deflated entries, CRC checked.
function unzip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "not a ZIP (no end of central directory)");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory entry");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = rawName.toString("utf8");
    // pt-BR names ("Conteúdo", "lançamento") must be flagged UTF-8 or Windows garbles them
    if (rawName.some((byte) => byte > 0x7f)) assert.ok(flags & 0x800, `${name}: UTF-8 flag missing`);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    assert.equal(buffer.readUInt32LE(local), 0x04034b50, `${name}: local header`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else assert.fail(`${name}: unexpected compression method ${method}`);
    assert.equal(data.length, size, `${name}: size`);
    assert.equal(crc32(data) >>> 0, crc, `${name}: CRC`);
    entries.push({ name, method, data });
  }
  return entries;
}

// Requests a ZIP as `agent`, follows the job to the end, downloads and unzips it.
async function zipAs(agent, scope) {
  const created = await agent.post("/api/zips", { scope });
  ok(created, 202, `zip ${JSON.stringify(scope)}`);
  const id = created.body.job.id;
  const seen = new Set([created.body.job.status]);
  const job = await waitFor(
    async () => {
      const res = await agent.get(`/api/zips/${id}`);
      ok(res, 200, "zip job");
      seen.add(res.body.job.status);
      return ["ready", "failed"].includes(res.body.job.status) ? res.body.job : null;
    },
    { timeout: 20000 },
  );
  assert.equal(job.status, "ready", job.error ?? "");
  assert.equal(job.progress, 1);
  assert.equal(job.processedBytes, job.totalBytes);
  const link = await agent.post(`/api/zips/${id}/link`);
  ok(link, 200, "zip link");
  const res = await agent.get(link.body.url);
  ok(res, 200, "zip download");
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment/);
  assert.ok((res.headers.get("content-disposition") ?? "").includes(job.filename), "download named after the job");
  assert.equal(res.body.length, job.sizeBytes);
  return { job, url: link.body.url, entries: unzip(res.body), statuses: seen };
}

// Polls a material (as staff) until no preview is still being generated.
async function previewsSettled(agent, materialId) {
  return waitFor(
    async () => {
      const res = await agent.get(`/api/materials/${materialId}`);
      const files = res.body.material.versions.flatMap((v) => v.files);
      return files.every((file) => file.previewStatus !== "pending") ? res.body.material : null;
    },
    { timeout: 20000, interval: 50 },
  );
}

const notificationsOf = async (agent) => {
  const res = await agent.get("/api/notifications?pageSize=100");
  ok(res, 200, "notifications");
  return res.body.items;
};

// ------------------------------------------------------------------ mock Mercado Pago

async function startMockMercadoPago() {
  const state = { mode: "ok", preferences: [], payments: new Map(), calls: [] };
  const instance = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://mock");
    state.calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (state.mode === "error") return send(500, { message: "internal_error", status: 500 });
    if (req.method === "POST" && url.pathname === "/checkout/preferences") {
      const id = `pref-${state.preferences.length + 1}`;
      state.preferences.push({ id, body: JSON.parse(raw) });
      return send(201, { id, init_point: `https://mp.example/checkout?pref_id=${id}`, sandbox_init_point: `https://sandbox.mp.example/checkout?pref_id=${id}` });
    }
    if (req.method === "PUT" && url.pathname.startsWith("/checkout/preferences/")) return send(200, { expires: true });
    if (req.method === "GET" && url.pathname === "/v1/payments/search") {
      const results = [...state.payments.values()].filter((p) => p.external_reference === url.searchParams.get("external_reference"));
      return send(200, { results, paging: { total: results.length } });
    }
    const payment = url.pathname.match(/^\/v1\/payments\/([^/]+)$/);
    if (req.method === "GET" && payment)
      return state.payments.has(payment[1]) ? send(200, state.payments.get(payment[1])) : send(404, { message: "Payment not found" });
    send(404, { message: "not found" });
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${instance.address().port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        instance.close(() => resolve());
        instance.closeAllConnections?.();
      }),
  };
}

// x-signature as documented by Mercado Pago (independent of the server code).
function signWebhook(secret, { dataId, requestId, ts }) {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  return `ts=${ts},v1=${createHmac("sha256", secret).update(manifest).digest("hex")}`;
}

async function postWebhook({ dataId, signature, requestId = randomUUID() }) {
  const ts = String(Date.now());
  const response = await fetch(`${server.url}/api/webhooks/mercadopago?data.id=${dataId}&type=payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-signature": signature ?? signWebhook(WEBHOOK_SECRET, { dataId, requestId, ts }),
    },
    body: JSON.stringify({ action: "payment.updated", api_version: "v1", type: "payment", data: { id: String(dataId) }, live_mode: false }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// ------------------------------------------------------------------ setup

before(async () => {
  mp = await startMockMercadoPago();
  // 1 MB upload limit (MAX_UPLOAD_MB=1) so criterion 11 can hit it cheaply.
  server = await startTestServer({ maxUploadMb: 1 });
  const { ctx } = server;
  u.admin = await createUser(ctx, { role: "admin", name: "Ana Admin" });
  u.manager = await createUser(ctx, { role: "manager", name: "Gestora Lia" });
  u.designer = await createUser(ctx, { role: "designer", name: "Designer Téo" });
  u.otherDesigner = await createUser(ctx, { role: "designer", name: "Designer Sem Projeto" });
  u.finance = await createUser(ctx, { role: "finance", name: "Financeiro Rui" });
  for (const key of Object.keys(u)) as[key] = await login(server, { email: u[key].email });
});

after(async () => {
  await server?.close();
  await mp?.close();
});

// ------------------------------------------------------------------ scenario

describe("acceptance scenario (spec criteria 1-11)", { concurrency: false }, () => {
  test("1. the admin creates a client and its brand, invites the client user, who accepts; a second client exists", async () => {
    const created = await as.admin.post("/api/clients", {
      name: "Studio Norte",
      legalName: "Studio Norte Comunicação Ltda.",
      contactEmail: "contato@norte.test",
      internalNotes: `${INTERNAL} cliente: renegociar escopo em dezembro`,
      brand: { name: "Norte", description: "Marca principal do estúdio." },
      managerIds: [u.manager.id],
      user: { name: "Nina Norte", email: "nina@norte.test" },
    });
    ok(created, 201, "create client");
    f.client = created.body.client.id;
    f.brand = created.body.brand.id;
    track(f.client, f.brand);
    assert.equal(created.body.brand.name, "Norte");
    assert.equal(created.body.brand.clientId, f.client);
    assert.equal(created.body.user.status, "invited");
    assert.equal(created.body.user.email, "nina@norte.test");
    // no SMTP in tests: the team gets the invite link to pass on, and says so
    assert.equal(created.body.emailStatus, "not_configured");
    const token = new URL(created.body.inviteUrl).pathname.split("/convite/")[1];
    assert.ok(token);

    const brandNotes = await as.admin.patch(`/api/brands/${f.brand}`, { internalNotes: `${INTERNAL} marca: cliente sensível a verde` });
    ok(brandNotes, 200, "brand internal notes");

    const peek = await createAgent(server).get(`/api/auth/invite/${token}`);
    ok(peek, 200, "invite peek");
    assert.equal(peek.body.email, "nina@norte.test");
    const nina = createAgent(server);
    const accepted = await nina.post("/api/auth/invite/accept", { token, password: CLIENT_PASSWORD });
    ok(accepted, 200, "accept invite");
    assert.equal(accepted.body.user.role, "client");
    assert.equal(accepted.body.user.client.id, f.client);
    assert.deepEqual(ids(accepted.body.user.brands), [f.brand]);
    assert.ok(accepted.body.user.capabilities.includes("portal.access"));
    u.client = accepted.body.user;
    track(u.client.id);
    as.client = guardFirstClient(nina);
    // the invite cannot be used twice; the password works for a normal login
    assert.equal((await createAgent(server).post("/api/auth/invite/accept", { token, password: CLIENT_PASSWORD })).status, 410);
    const relogin = await login(server, { email: "nina@norte.test", password: CLIENT_PASSWORD });
    assert.equal(relogin.user.id, u.client.id);

    // a second brand of the same client stays separate
    const second = await as.admin.post(`/api/clients/${f.client}/brands`, { name: "Norte Café" });
    ok(second, 201, "second brand");
    f.brand2 = second.body.brand.id;
    track(f.brand2);
    const me = await as.client.get("/api/auth/me");
    assert.deepEqual(new Set(ids(me.body.user.brands)), new Set([f.brand, f.brand2]));

    // the second client, with its own user, created the same way
    const other = await as.admin.post("/api/clients", {
      name: "Outro Cliente",
      brand: { name: "Outra Marca" },
      user: { name: "Olga Outro", email: "olga@outro.test" },
    });
    ok(other, 201, "second client");
    f.otherClient = other.body.client.id;
    f.otherBrand = other.body.brand.id;
    const olga = createAgent(server);
    const otherToken = new URL(other.body.inviteUrl).pathname.split("/convite/")[1];
    ok(await olga.post("/api/auth/invite/accept", { token: otherToken, password: OTHER_PASSWORD }), 200, "accept second invite");
    as.otherClient = guardOtherClient(olga);

    // the manager was given access to Studio Norte only
    const managed = await as.manager.get("/api/clients");
    assert.deepEqual(ids(managed.body.items), [f.client]);
    assert.equal((await as.manager.get(`/api/clients/${f.otherClient}`)).status, 404);
    const detail = await as.admin.get(`/api/clients/${f.client}`);
    assert.deepEqual(new Set(ids(detail.body.brands)), new Set([f.brand, f.brand2]));
    assert.equal(detail.body.users.find((user) => user.email === "nina@norte.test").status, "active");
  });

  test("2. the team receives an assigned project (notification, my projects, my tasks)", async () => {
    const created = await as.admin.post("/api/projects", {
      brandId: f.brand,
      name: "Identidade e lançamento",
      status: "in_progress",
      dueDate: "2026-11-30",
      internalNotes: `${INTERNAL} projeto: margem apertada, priorizar logo`,
      members: [
        { userId: u.manager.id, role: "lead" },
        { userId: u.designer.id, role: "designer" },
      ],
    });
    ok(created, 201, "create project");
    f.project = created.body.project.id;
    track(f.project);

    // the designer is notified and finds the project among their own
    const inbox = await notificationsOf(as.designer);
    const assigned = inbox.find((n) => n.type === "project.assigned" && n.entityId === f.project);
    assert.ok(assigned, "designer notified of the assignment");
    assert.equal(assigned.link, `/admin/projetos/${f.project}`);
    assert.ok((await notificationsOf(as.manager)).some((n) => n.type === "project.assigned" && n.entityId === f.project));
    const mine = await as.designer.get("/api/projects?mine=1");
    ok(mine, 200, "my projects");
    assert.deepEqual(ids(mine.body.items), [f.project]);
    assert.ok(mine.body.items[0].members.some((m) => m.id === u.designer.id && m.role === "designer"));
    assert.deepEqual(ids((await as.otherDesigner.get("/api/projects?mine=1")).body.items), []);
    assert.equal((await as.otherDesigner.get(`/api/projects/${f.project}`)).status, 404);

    // a task for the designer shows up in "my tasks"
    const task = await as.manager.post(`/api/projects/${f.project}/tasks`, {
      title: "Criar logo e carrossel de lançamento",
      assigneeId: u.designer.id,
      dueDate: "2026-10-15",
    });
    ok(task, 201, "create task");
    f.task = task.body.task.id;
    const tasks = await as.designer.get("/api/me/tasks");
    ok(tasks, 200, "my tasks");
    const mineTask = tasks.body.items.find((t) => t.id === f.task);
    assert.ok(mineTask, "task listed for the designer");
    assert.equal(mineTask.project.id, f.project);
    assert.ok((await notificationsOf(as.designer)).some((n) => n.entityId === f.task || String(n.link ?? "").includes(f.task)));

    // the manager (project lead) sends a briefing to the client
    const briefing = await as.manager.post("/api/briefings", {
      brandId: f.brand,
      projectId: f.project,
      templateId: "identidade-visual",
      dueDate: "2026-10-10",
    });
    ok(briefing, 201, "create briefing");
    f.briefing = briefing.body.briefing.id;
    track(f.briefing);
    ok(await as.manager.post(`/api/briefings/${f.briefing}/send`), 200, "send briefing");

    // the client sees the project (no internal notes) and the briefing
    const portal = await as.client.get("/api/portal/projects");
    ok(portal, 200, "portal projects");
    assert.deepEqual(ids(portal.body.items), [f.project]);
    assert.equal(portal.body.items[0].materialCount, 0);
    assert.ok(idSet((await as.client.get("/api/briefings")).body.items).has(f.briefing));
    ok(await as.client.get(`/api/briefings/${f.briefing}`), 200, "client briefing");
  });

  test("3. the designer uploads a logo (PNG + SVG + PDF) and a 3-slide carousel as drafts, invisible to the client", async () => {
    const categories = await as.designer.get("/api/categories");
    f.logos = categories.body.items.find((c) => c.slug === "logotipo").id;
    f.posts = categories.body.items.find((c) => c.slug === "posts-carrosseis").id;

    const logoFiles = [
      [await upload(as.designer, "norte-logo.svg", svg({ width: 240, height: 90, color: "#2f3b24" }), "image/svg+xml"), 1],
      [await upload(as.designer, "norte-logo.png", await png({ width: 480, height: 180, color: "#2f3b24" }), "image/png"), 2],
      [await upload(as.designer, "norte-logo.pdf", pdf(), "application/pdf"), 3],
    ];
    const logo = await as.designer.post("/api/materials", {
      kind: "asset",
      brandId: f.brand,
      projectId: f.project,
      categoryId: f.logos,
      title: "Logo principal Norte",
      variant: "principal",
      internalNotes: `${INTERNAL} logo: conferir margem de segurança antes de liberar`,
      files: logoFiles.map(([uploadId, position]) => ({ uploadId, role: "original", position })),
    });
    ok(logo, 201, "create logo");
    f.logo = logo.body.material.id;
    f.logoV1 = logo.body.material.versions[0].id;
    assert.equal(logo.body.material.visibility, "draft");
    assert.equal(logo.body.material.approvalStatus, "none");
    assert.equal(logo.body.material.owner.id, u.designer.id);
    assert.equal(logo.body.material.project.id, f.project);
    assert.equal(logo.body.material.version.number, 1);
    assert.equal(logo.body.material.version.status, "draft");
    assert.deepEqual(logo.body.material.formats, ["SVG", "PNG", "PDF"]);
    const logoByName = Object.fromEntries(logo.body.material.versions[0].files.map((file) => [file.name, file.id]));
    f.logoSvg = logoByName["norte-logo.svg"];
    f.logoPng = logoByName["norte-logo.png"];
    f.logoPdf = logoByName["norte-logo.pdf"];
    track(f.logo, f.logoV1, f.logoSvg, f.logoPng, f.logoPdf);

    const slides = [];
    for (const [index, color] of ["#202619", "#6b7a4a", "#e3e0d5"].entries())
      slides.push(await upload(as.designer, `slide-${index + 1}.png`, await png({ width: 1080, height: 1350, color }), "image/png"));
    const post = await as.designer.post("/api/content", {
      brandId: f.brand,
      projectId: f.project,
      title: "Carrossel de lançamento",
      network: "instagram",
      format: "carrossel",
      plannedDate: "2026-10-20",
      plannedTime: "18:00",
      caption: "Chegou a nova identidade da Norte.",
      hashtags: "#norte #lancamento",
      internalNotes: `${INTERNAL} post: aguardar ok do jurídico sobre a promo`,
      files: slides.map((uploadId, index) => ({ uploadId, role: "original", position: index + 1 })),
    });
    ok(post, 201, "create carousel");
    f.post = post.body.material.id;
    f.v1 = post.body.material.versions[0].id;
    assert.equal(post.body.material.visibility, "draft");
    assert.equal(post.body.material.category.id, f.posts);
    assert.equal(post.body.material.post.format, "carrossel");
    const v1Files = post.body.material.versions[0].files;
    assert.deepEqual(
      v1Files.map((file) => [file.position, file.name]),
      [
        [1, "slide-1.png"],
        [2, "slide-2.png"],
        [3, "slide-3.png"],
      ],
    );
    f.v1Slides = v1Files.map((file) => file.id);
    track(f.post, f.v1, f.v1Slides);

    // a draft that is never released (its title must never reach a client)
    const draftUpload = await upload(as.designer, "logo-alternativa.png", await png({ width: 200, height: 200, color: "#a0522d" }), "image/png");
    const draft = await as.designer.post("/api/materials", {
      kind: "asset",
      brandId: f.brand,
      projectId: f.project,
      categoryId: f.logos,
      title: `Logo alternativa ${PRIVATE_DRAFT}`,
      variant: "secundaria",
      files: [{ uploadId: draftUpload, role: "original", position: 1 }],
    });
    ok(draft, 201, "create draft");
    f.draft = draft.body.material.id;
    f.draftFile = draft.body.material.versions[0].files[0].id;
    track(f.draft, f.draftFile);

    // previews are generated in the background from the originals
    for (const id of [f.logo, f.post, f.draft]) {
      const settled = await previewsSettled(as.designer, id);
      for (const file of settled.versions[0].files)
        assert.equal(file.previewStatus, file.mediaKind === "pdf" ? "unsupported" : "ready", `${file.name} preview`);
    }
    ok(await as.designer.get(`/api/files/${f.logoPng}/preview/thumb`), 200, "staff thumb");
    ok(await as.designer.get(`/api/files/${f.v1Slides[0]}/preview/preview`), 200, "staff preview");
    ok(await as.designer.get(`/api/files/${f.logoPdf}/stream`), 200, "staff pdf stream");

    // drafts stay private: every client-facing door answers 404
    assert.deepEqual((await as.client.get("/api/materials")).body.items, []);
    assert.deepEqual((await as.client.get("/api/content")).body.items, []);
    for (const id of [f.logo, f.post, f.draft]) {
      assert.equal((await as.client.get(`/api/materials/${id}`)).status, 404);
      assert.equal((await as.client.get(`/api/materials/${id}/comments`)).status, 404);
    }
    assert.equal((await as.client.get(`/api/content/${f.post}`)).status, 404);
    assert.equal((await as.client.get(`/api/versions/${f.v1}`)).status, 404);
    for (const fileId of [f.logoPng, f.logoSvg, f.v1Slides[0]]) {
      assert.equal((await as.client.get(`/api/files/${fileId}/preview/thumb`)).status, 404);
      assert.equal((await as.client.get(`/api/files/${fileId}/preview/preview`)).status, 404);
    }
    assert.equal((await as.client.get(`/api/files/${f.logoPdf}/stream`)).status, 404);
    for (const fileId of [f.logoPng, f.logoPdf, f.v1Slides[0]])
      assert.equal((await as.client.post("/api/downloads/link", { fileId })).status, 404);
    assert.equal((await as.client.post("/api/zips", { scope: { type: "carousel", materialId: f.post } })).status, 404);
    assert.equal((await as.client.post("/api/zips", { scope: { type: "brand_kit", brandId: f.brand } })).status, 404);
    const library = await as.client.get(`/api/brands/${f.brand}/library`);
    ok(library, 200, "empty library");
    assert.equal(Object.values(library.body.logos).flat().length, 0);
  });

  test("4. the manager reviews the release summary and releases to the right client; the designer cannot", async () => {
    // designers produce, they do not release
    assert.equal((await as.designer.post("/api/releases/preview", { materialIds: [f.logo, f.post] })).status, 403);
    assert.equal((await as.designer.post("/api/releases", { materialIds: [f.logo, f.post], notifyApp: true })).status, 403);

    const preview = await as.manager.post("/api/releases/preview", { materialIds: [f.logo, f.post] });
    ok(preview, 200, "release preview");
    const summary = preview.body;
    assert.deepEqual({ id: summary.client.id, name: summary.client.name }, { id: f.client, name: "Studio Norte" });
    assert.equal(summary.brand.id, f.brand);
    assert.deepEqual(
      summary.recipients.map((r) => r.email),
      ["nina@norte.test"],
      "only the active users of this client",
    );
    assert.deepEqual(new Set(summary.items.map((item) => item.material.id)), new Set([f.logo, f.post]));
    for (const item of summary.items) {
      assert.equal(item.version.number, 1);
      assert.equal(item.isNewVersion, false);
      assert.equal(item.requiresApproval, true);
      assert.equal(item.downloadEnabled, true);
      assert.ok(item.files.every((file) => file.clientVisible && file.clientDownloadable));
    }
    assert.equal(summary.items.find((item) => item.material.id === f.logo).files.length, 3);
    assert.equal(summary.items.find((item) => item.material.id === f.post).files.length, 3);
    assert.equal(summary.counts.toRelease, 2);
    assert.deepEqual(summary.blockers, []);

    const release = await as.manager.post("/api/releases", {
      materialIds: [f.logo, f.post],
      notifyApp: true,
      notifyEmail: true,
      message: "Primeiras entregas da nova identidade.",
    });
    ok(release, 201, "release");
    f.release1 = release.body.release.id;
    assert.equal(release.body.release.client.id, f.client);
    assert.equal(release.body.release.releasedCount, 2);
    for (const material of release.body.materials) {
      assert.equal(material.visibility, "released");
      assert.equal(material.approvalStatus, "pending");
    }
    // releasing again with nothing new is refused
    assert.equal((await as.manager.post("/api/releases", { materialIds: [f.logo, f.post] })).status, 409);

    // the client is notified in the platform and by e-mail (recorded, SMTP not configured)
    const inbox = await notificationsOf(as.client);
    const notice = inbox.find((n) => n.type === "material.released");
    assert.ok(notice, "client notified of the release");
    assert.match(notice.title, /2 novos materiais/);
    assert.match(notice.body, /Primeiras entregas/);
    const outbox = await waitFor(async () => {
      const res = await as.admin.get("/api/settings/outbox?pageSize=100");
      return res.body.items.find((mail) => mail.to === "nina@norte.test" && mail.status === "not_configured" && /materiais/i.test(mail.subject));
    });
    assert.ok(outbox);
    assert.deepEqual(
      (await notificationsOf(as.otherClient)).filter((n) => n.type === "material.released"),
      [],
      "nothing for the other client",
    );
  });

  test("5. the client views both, comments and requests changes; internal notes never reach the client", async () => {
    const list = await as.client.get("/api/materials");
    assert.deepEqual(new Set(ids(list.body.items)), new Set([f.logo, f.post]), "released materials only, never the draft");

    // logo detail: the released version, full-quality files and separate previews
    const logo = (await as.client.get(`/api/materials/${f.logo}`)).body.material;
    assert.equal(logo.visibility, "released");
    assert.equal(logo.approvalStatus, "pending");
    assert.equal(logo.brand.id, f.brand);
    assert.equal(logo.client.id, f.client);
    assert.equal(logo.project.id, f.project);
    assert.equal(logo.category.slug, "logotipo");
    assert.deepEqual(logo.owner, { name: "Designer Téo" }, "team members appear by name only");
    assert.equal(logo.version.id, f.logoV1);
    assert.deepEqual(ids(logo.versions), [f.logoV1]);
    assert.deepEqual(logo.formats, ["SVG", "PNG", "PDF"]);
    assert.equal(logo.permissions.canApprove, true);
    assert.equal(logo.permissions.canDownload, true);
    assert.equal(logo.permissions.canRelease, false);
    const logoFiles = Object.fromEntries(logo.versions[0].files.map((file) => [file.name, file]));
    assert.equal(logoFiles["norte-logo.png"].sizeBytes, bytes["norte-logo.png"].length);
    assert.equal(logoFiles["norte-logo.png"].downloadable, true);
    assert.equal(logoFiles["norte-logo.png"].previews.thumb, `/api/files/${f.logoPng}/preview/thumb`);
    assert.equal(logoFiles["norte-logo.svg"].previews.preview, `/api/files/${f.logoSvg}/preview/preview`);
    assert.equal(logoFiles["norte-logo.pdf"].previews.stream, `/api/files/${f.logoPdf}/stream`);
    const thumb = await as.client.get(logoFiles["norte-logo.png"].previews.thumb);
    ok(thumb, 200, "client thumb");
    assert.equal(thumb.headers.get("content-type"), "image/webp");
    assert.match(thumb.headers.get("cache-control"), /private/);
    assert.notEqual(sha(thumb.body), sha(bytes["norte-logo.png"]), "the preview is a separate rendition");
    const svgPreview = await as.client.get(logoFiles["norte-logo.svg"].previews.preview);
    ok(svgPreview, 200, "svg rasterised preview");
    assert.equal(svgPreview.headers.get("content-type"), "image/webp");
    const pdfStream = await as.client.get(logoFiles["norte-logo.pdf"].previews.stream);
    ok(pdfStream, 200, "pdf stream");
    assert.equal(pdfStream.headers.get("content-type"), "application/pdf");
    assert.match(pdfStream.headers.get("content-disposition"), /^inline/);

    // carousel detail: post fields, caption, slides in order with previews
    const post = (await as.client.get(`/api/content/${f.post}`)).body.material;
    assert.equal(post.kind, "post");
    assert.deepEqual(
      { network: post.post.network, format: post.post.format, plannedDate: post.post.plannedDate, publication: post.post.publicationStatus },
      { network: "instagram", format: "carrossel", plannedDate: "2026-10-20", publication: "not_scheduled" },
    );
    assert.equal(post.versions[0].caption, "Chegou a nova identidade da Norte.");
    assert.deepEqual(
      post.versions[0].files.map((file) => file.id),
      f.v1Slides,
    );
    for (const file of post.versions[0].files) ok(await as.client.get(file.previews.preview), 200, `slide ${file.position} preview`);
    assert.ok(idSet((await as.client.get("/api/content")).body.items).has(f.post));

    // the brand library shows the released logo, not the draft variant
    const library = (await as.client.get(`/api/brands/${f.brand}/library`)).body;
    assert.deepEqual(ids(library.logos.principal), [f.logo]);
    assert.deepEqual(library.logos.secundaria, []);

    // team: one internal note, one message to the client
    const note = await as.manager.post(`/api/materials/${f.post}/comments`, {
      body: `${INTERNAL}: o contraste do slide 3 está no limite`,
      visibility: "internal",
    });
    ok(note, 201, "internal note");
    assert.equal(note.body.comment.visibility, "internal");
    const hello = await as.manager.post(`/api/materials/${f.post}/comments`, { body: "Oi, Nina! Qualquer dúvida, estamos aqui." });
    ok(hello, 201, "team comment");
    assert.ok((await notificationsOf(as.client)).some((n) => n.type === "comment.team" && n.entityId === f.post));

    // client comment on a slide
    const comment = await as.client.post(`/api/materials/${f.post}/comments`, {
      body: "Adorei o primeiro slide!",
      slidePosition: 1,
      visibility: "internal", // ignored: a client always writes client-visible comments
    });
    ok(comment, 201, "client comment");
    f.clientComment = comment.body.comment.id;
    track(f.clientComment);
    assert.equal(comment.body.comment.kind, "comment");
    assert.equal(comment.body.comment.versionId, f.v1);
    assert.equal(comment.body.comment.author.isClient, true);
    for (const staff of [as.manager, as.designer])
      assert.ok((await notificationsOf(staff)).some((n) => n.type === "comment.client" && n.entityId === f.post));

    const thread = (await as.client.get(`/api/materials/${f.post}/comments`)).body.items;
    assert.deepEqual(
      thread.map((c) => c.body),
      ["Oi, Nina! Qualquer dúvida, estamos aqui.", "Adorei o primeiro slide!"],
    );
    assert.deepEqual(thread[0].author, { name: "Gestora Lia", isClient: false });
    const staffThread = (await as.manager.get(`/api/materials/${f.post}/comments`)).body;
    assert.equal(staffThread.counts.internal, 1);
    assert.ok(staffThread.items.some((c) => c.visibility === "internal" && c.body.startsWith(INTERNAL)));
    assert.equal((await as.client.patch(`/api/comments/${note.body.comment.id}`, { body: "x" })).status, 404, "internal note unreachable by id");

    // change request on slide 3
    const changes = await as.client.post(`/api/materials/${f.post}/request-changes`, {
      versionId: f.v1,
      body: "Troquem a cor do slide 3 e coloquem ele como capa, por favor.",
      slidePosition: 3,
    });
    ok(changes, 200, "request changes");
    assert.equal(changes.body.comment.kind, "change_request");
    assert.equal(changes.body.comment.slidePosition, 3);
    assert.equal(changes.body.material.approvalStatus, "changes_requested");
    assert.equal(changes.body.approval.decision, "changes_requested");
    assert.equal(changes.body.approval.versionId, f.v1);
    assert.equal(changes.body.approval.user.id, u.client.id);
    assert.equal(
      (await as.client.post(`/api/materials/${f.post}/request-changes`, { versionId: f.v1, body: "De novo" })).status,
      409,
      "one decision per version",
    );

    // the team is notified and a task is opened for the owner (documented rule)
    for (const staff of [as.manager, as.designer])
      assert.ok((await notificationsOf(staff)).some((n) => n.type === "approval.changes_requested" && n.entityId === f.post));
    const tasks = (await as.designer.get("/api/me/tasks")).body.items;
    const fix = tasks.find((t) => t.material?.id === f.post);
    assert.ok(fix, "change-request task in the designer's list");
    assert.equal(fix.title, "Ajustes: Carrossel de lançamento (v1)");
    assert.equal(fix.assignee.id, u.designer.id);
    assert.equal(fix.project.id, f.project);
    assert.match(fix.description, /slide 3/);

    // every other client-facing view of these materials (all scanned by the guard)
    const decisions = await as.client.get(`/api/materials/${f.post}/approvals`);
    assert.deepEqual(
      decisions.body.items.map((d) => [d.decision, d.versionId, d.user.id]),
      [["changes_requested", f.v1, u.client.id]],
    );
    const clientHistory = await as.client.get(`/api/materials/${f.post}/history`);
    ok(clientHistory, 200, "client history");
    assert.ok(clientHistory.body.items.every((entry) => entry.action !== "comment.internal"));
    assert.ok(clientHistory.body.items.some((entry) => entry.action === "material.changes_requested"));
    const pending = await as.client.get("/api/approvals");
    assert.deepEqual(ids(pending.body.items), [f.logo]);
    const overview = await as.client.get("/api/portal/overview");
    ok(overview, 200, "portal overview");
    ok(await as.client.get("/api/portal/activity"), 200, "portal activity");
    ok(await as.client.get("/api/releases"), 200, "client releases");
    ok(await as.client.get(`/api/versions/${f.v1}`), 200, "client version");
    ok(await as.client.get(`/api/brands/${f.brand}`), 200, "client brand");
    ok(await as.client.get(`/api/materials?projectId=${f.project}`), 200, "client materials by project");
    const portal = (await as.client.get("/api/portal/projects")).body.items[0];
    assert.equal(portal.materialCount, 2, "drafts are not counted for the client");
    assert.equal(portal.changesRequestedCount, 1);
  });

  test("6. the designer sends a new version (slides reordered), the manager releases it; approval resets, history kept", async () => {
    // v2 starts as a copy of v1; slide 3 is replaced and moved to the front
    const newSlide = await upload(as.designer, "slide-3-ajustado.png", await png({ width: 1080, height: 1350, color: "#9c6b3f" }), "image/png");
    const created = await as.designer.post(`/api/materials/${f.post}/versions`, {
      copyFrom: "current",
      files: [{ uploadId: newSlide, role: "original", position: 4 }],
      caption: "Chegou a nova identidade da Norte. Cores ajustadas.",
      changeSummary: "Slide 3 com a nova cor, agora como capa",
    });
    ok(created, 201, "new version");
    f.v2 = created.body.version.id;
    track(f.v2);
    assert.equal(created.body.version.number, 2);
    assert.equal(created.body.version.status, "draft");
    const copies = Object.fromEntries(created.body.version.files.map((file) => [file.name, file.id]));
    assert.deepEqual(Object.keys(copies).sort(), ["slide-1.png", "slide-2.png", "slide-3-ajustado.png", "slide-3.png"]);
    ok(await as.designer.del(`/api/files/${copies["slide-3.png"]}`), 204, "remove old slide 3 from v2");
    const reordered = await as.designer.patch(`/api/versions/${f.v2}`, {
      files: [
        { id: copies["slide-3-ajustado.png"], position: 1 },
        { id: copies["slide-1.png"], position: 2 },
        { id: copies["slide-2.png"], position: 3 },
      ],
    });
    ok(reordered, 200, "reorder slides");
    assert.deepEqual(
      reordered.body.version.files.map((file) => [file.position, file.name]),
      [
        [1, "slide-3-ajustado.png"],
        [2, "slide-1.png"],
        [3, "slide-2.png"],
      ],
    );
    f.v2Slides = reordered.body.version.files.map((file) => file.id);
    track(f.v2Slides);
    // only one open version at a time
    assert.equal((await as.designer.post(`/api/materials/${f.post}/versions`, { copyFrom: "current" })).status, 409);

    // removing the copy did not touch v1: its slide 3 is intact for the team
    const oldSlide3 = await as.manager.post("/api/downloads/link", { fileId: f.v1Slides[2] });
    ok(oldSlide3, 200, "staff link to v1 slide 3");
    const oldBytes = await as.manager.get(oldSlide3.body.url);
    ok(oldBytes, 200, "v1 slide 3 still stored");
    assert.equal(sha(oldBytes.body), sha(bytes["slide-3.png"]));
    ok(await as.manager.get(`/api/files/${f.v1Slides[2]}/preview/thumb`), 200, "v1 slide 3 preview still stored");
    await previewsSettled(as.designer, f.post);

    // until the team releases v2 the client keeps seeing v1 only
    const before = (await as.client.get(`/api/materials/${f.post}`)).body.material;
    assert.equal(before.version.id, f.v1);
    assert.deepEqual(ids(before.versions), [f.v1]);
    assert.ok(!JSON.stringify(before).includes("slide-3-ajustado"));
    assert.equal((await as.client.get(`/api/versions/${f.v2}`)).status, 404);
    assert.equal((await as.client.get(`/api/files/${f.v2Slides[0]}/preview/thumb`)).status, 404);
    assert.equal((await as.client.post("/api/downloads/link", { fileId: f.v2Slides[0] })).status, 404);

    const preview = await as.manager.post("/api/releases/preview", { materialIds: [f.post] });
    ok(preview, 200, "v2 preview");
    assert.equal(preview.body.items[0].isNewVersion, true);
    assert.equal(preview.body.items[0].version.number, 2);
    assert.equal(preview.body.counts.newVersions, 1);
    ok(await as.manager.post("/api/releases", { materialIds: [f.post], notifyApp: true }), 201, "release v2");
    assert.ok(
      (await notificationsOf(as.client)).some((n) => n.type === "material.released" && n.entityId === f.post && /versão 2/.test(n.title)),
    );

    const now = (await as.client.get(`/api/materials/${f.post}`)).body.material;
    assert.equal(now.version.id, f.v2);
    assert.equal(now.approvalStatus, "pending", "a new version needs a new approval");
    assert.equal(now.permissions.canApprove, true);
    assert.deepEqual(ids(now.versions), [f.v2, f.v1], "the old version stays in the history");
    assert.deepEqual(
      now.versions[0].files.map((file) => file.name),
      ["slide-3-ajustado.png", "slide-1.png", "slide-2.png"],
    );
    assert.equal(now.versions[0].caption, "Chegou a nova identidade da Norte. Cores ajustadas.");
    assert.equal(now.versions[0].changeSummary, "Slide 3 com a nova cor, agora como capa");
    assert.equal(now.versions[1].status, "superseded");
    assert.deepEqual(ids(now.versions[1].files), f.v1Slides);
    ok(await as.client.get(`/api/files/${f.v1Slides[2]}/preview/thumb`), 200, "old version still viewable");
    ok(await as.client.get(`/api/files/${f.v2Slides[0]}/preview/thumb`), 200, "new version viewable");

    const staffHistory = (await as.manager.get(`/api/materials/${f.post}/history`)).body;
    assert.deepEqual(
      staffHistory.versions.map((v) => [v.number, v.status]),
      [
        [2, "released"],
        [1, "superseded"],
      ],
    );
  });

  test("7. the client approves the new version; who, when and which version are recorded", async () => {
    const stale = await as.client.post(`/api/materials/${f.post}/approve`, { versionId: f.v1 });
    assert.equal(stale.status, 409, "the old version cannot be approved");
    assert.equal(stale.body.error.code, "conflict");
    assert.ok(stale.body.error.message.length > 20);

    const before = Date.now();
    const approve = await as.client.post(`/api/materials/${f.post}/approve`, { versionId: f.v2, note: "Perfeito, aprovado!" });
    ok(approve, 200, "approve");
    assert.equal(approve.body.material.approvalStatus, "approved");
    assert.equal(approve.body.material.approvedVersionId, f.v2);
    assert.equal(approve.body.approval.decision, "approved");
    assert.equal(approve.body.approval.versionId, f.v2);
    assert.equal(approve.body.approval.versionNumber, 2);
    assert.equal(approve.body.approval.user.id, u.client.id);
    assert.equal((await as.client.post(`/api/materials/${f.post}/approve`, { versionId: f.v2 })).status, 409, "already approved");

    const decisions = (await as.manager.get(`/api/materials/${f.post}/approvals`)).body.items;
    assert.deepEqual(
      decisions.map((d) => [d.decision, d.versionNumber, d.user.id]),
      [
        ["approved", 2, u.client.id],
        ["changes_requested", 1, u.client.id],
      ],
    );
    const approved = decisions[0];
    assert.equal(approved.user.name, "Nina Norte");
    assert.equal(approved.comment, "Perfeito, aprovado!");
    const at = Date.parse(approved.createdAt);
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, `approval time ${approved.createdAt}`);
    assert.ok(approved.ip, "the team sees where it was approved from");
    const detail = (await as.manager.get(`/api/materials/${f.post}`)).body.material;
    assert.equal(detail.versions.find((v) => v.id === f.v2).decidedBy.id, u.client.id);
    assert.equal(detail.versions.find((v) => v.id === f.v2).status, "approved");
    for (const staff of [as.manager, as.designer])
      assert.ok((await notificationsOf(staff)).some((n) => n.type === "approval.approved" && n.entityId === f.post));
  });

  test("8. the client downloads individual files and organised ZIPs; downloads are recorded and are not approvals", async () => {
    const statusBefore = {
      logo: (await as.client.get(`/api/materials/${f.logo}`)).body.material.approvalStatus,
      post: (await as.client.get(`/api/materials/${f.post}`)).body.material.approvalStatus,
    };
    assert.deepEqual(statusBefore, { logo: "pending", post: "approved" });

    // individual files: temporary link, attachment, original bytes
    for (const [fileId, name, mime] of [
      [f.logoPng, "norte-logo.png", "image/png"],
      [f.logoSvg, "norte-logo.svg", "image/svg+xml"],
      [f.v2Slides[0], "slide-3-ajustado.png", "image/png"],
    ]) {
      const link = await as.client.post("/api/downloads/link", { fileId });
      ok(link, 200, `link ${name}`);
      assert.match(link.body.url, /^\/dl\/[\w-]+\.[\w-]+$/);
      const ttl = Date.parse(link.body.expiresAt) - Date.now();
      assert.ok(ttl > 0 && ttl <= 300_000, "short-lived link");
      const file = await as.client.get(link.body.url);
      ok(file, 200, `download ${name}`);
      assert.match(file.headers.get("content-disposition"), /^attachment/);
      assert.ok(file.headers.get("content-disposition").includes(name));
      assert.equal(file.headers.get("content-type").split(";")[0], mime);
      assert.equal(sha(file.body), sha(bytes[name]), `${name}: identical to the upload`);
    }
    f.ninaFileLink = (await as.client.post("/api/downloads/link", { fileId: f.logoPng })).body.url;

    // carousel ZIP: the approved version's slides, numbered in the new order
    const carousel = await zipAs(as.client, { type: "carousel", materialId: f.post });
    assert.deepEqual(
      carousel.entries.map((entry) => entry.name),
      [
        "Norte - Carrossel de lançamento/01-slide-3-ajustado.png",
        "Norte - Carrossel de lançamento/02-slide-1.png",
        "Norte - Carrossel de lançamento/03-slide-2.png",
      ],
    );
    for (const entry of carousel.entries) {
      assert.equal(sha(entry.data), sha(bytes[entry.name.split("/").pop().slice(3)]), `${entry.name}: original bytes`);
      assert.equal(entry.method, 0, "PNG is stored, not recompressed");
    }
    f.ninaZipJob = carousel.job.id;
    f.ninaZipLink = carousel.url;
    track(f.ninaZipJob);

    // brand kit ZIP: Marca/Identidade visual/Logos/<FORMATO>/<arquivo>, only released files
    const kit = await zipAs(as.client, { type: "brand_kit", brandId: f.brand });
    assert.match(kit.job.filename, /^norte-kit-de-marca-\d{4}-\d{2}-\d{2}\.zip$/);
    assert.deepEqual(
      kit.entries.map((entry) => entry.name),
      ["Norte/Identidade visual/Logos/SVG/norte-logo.svg", "Norte/Identidade visual/Logos/PNG/norte-logo.png", "Norte/Identidade visual/Logos/PDF/norte-logo.pdf"],
    );
    for (const entry of kit.entries) assert.equal(sha(entry.data), sha(bytes[entry.name.split("/").pop()]), `${entry.name}: original bytes`);

    // final package of the project: both areas under one root
    const project = await zipAs(as.client, { type: "project", projectId: f.project });
    assert.deepEqual(
      project.entries.map((entry) => entry.name).sort(),
      [
        "Norte - Identidade e lançamento/Conteúdo/2026-10/Sem campanha/Carrossel de lançamento/01-slide-3-ajustado.png",
        "Norte - Identidade e lançamento/Conteúdo/2026-10/Sem campanha/Carrossel de lançamento/02-slide-1.png",
        "Norte - Identidade e lançamento/Conteúdo/2026-10/Sem campanha/Carrossel de lançamento/03-slide-2.png",
        "Norte - Identidade e lançamento/Identidade visual/Logos/PDF/norte-logo.pdf",
        "Norte - Identidade e lançamento/Identidade visual/Logos/PNG/norte-logo.png",
        "Norte - Identidade e lançamento/Identidade visual/Logos/SVG/norte-logo.svg",
      ].sort(),
    );

    // a released brand kit (for the isolation checks) downloads the same way
    const brandKit = await as.manager.post("/api/kits", {
      brandId: f.brand,
      projectId: f.project,
      name: "Kit de marca Norte",
      kind: "brand_kit",
      materialIds: [f.logo],
    });
    ok(brandKit, 201, "create kit");
    f.kit = brandKit.body.kit.id;
    track(f.kit);
    ok(await as.manager.post(`/api/kits/${f.kit}/release`, { notifyApp: true }), 201, "release kit");
    ok(await as.client.get(`/api/kits/${f.kit}`), 200, "client kit");
    const kitZip = await zipAs(as.client, { type: "kit", kitId: f.kit });
    assert.deepEqual(
      kitZip.entries.map((entry) => entry.name),
      [
        "Norte - Kit de marca Norte/Identidade visual/Logos/SVG/norte-logo.svg",
        "Norte - Kit de marca Norte/Identidade visual/Logos/PNG/norte-logo.png",
        "Norte - Kit de marca Norte/Identidade visual/Logos/PDF/norte-logo.pdf",
      ],
    );

    // downloading is never approving
    assert.equal((await as.client.get(`/api/materials/${f.logo}`)).body.material.approvalStatus, "pending");
    assert.equal((await as.client.get(`/api/materials/${f.post}`)).body.material.approvalStatus, "approved");
    const logoHistory = (await as.manager.get(`/api/materials/${f.logo}/history`)).body;
    const fileDownloads = logoHistory.downloads.filter((d) => d.kind === "file");
    assert.ok(fileDownloads.some((d) => d.user.id === u.client.id && d.fileName === "norte-logo.png" && d.versionNumber === 1));
    assert.ok(fileDownloads.some((d) => d.fileName === "norte-logo.svg"));
    assert.ok(logoHistory.downloads.filter((d) => d.kind === "zip").length >= 3, "brand kit, project and kit ZIPs");
    assert.ok(logoHistory.downloads.every((d) => d.isApproval === false));
    assert.ok(!logoHistory.activity.some((a) => a.action === "material.approved"));
    const report = await as.admin.get(`/api/reports/downloads?clientId=${f.client}`);
    ok(report, 200, "downloads report");
  });

  test("9. the other client cannot reach any of these records by changing URLs or ids", async () => {
    const other = as.otherClient;
    const is404 = async (promise, label) => {
      const res = await promise;
      assert.equal(res.status, 404, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, "not_found", label);
      return res.body;
    };
    // a foreign id answers exactly like an id that does not exist
    const same = async (label, send, realId, fakeId) =>
      assert.deepEqual(await is404(send(realId), label), await is404(send(fakeId), `${label} (inexistente)`), label);
    await same("material", (id) => other.get(`/api/materials/${id}`), f.post, "mat_naoexiste000000");
    await same("file download", (id) => other.post("/api/downloads/link", { fileId: id }), f.logoPng, "fil_naoexiste000000");
    await same("thumb", (id) => other.get(`/api/files/${id}/preview/thumb`), f.logoPng, "fil_naoexiste000000");
    await same("zip", (id) => other.post("/api/zips", { scope: { type: "brand_kit", brandId: id } }), f.brand, "brd_naoexiste000000");
    await same("briefing", (id) => other.get(`/api/briefings/${id}`), f.briefing, "brf_naoexiste000000");
    await same("kit", (id) => other.get(`/api/kits/${id}`), f.kit, "kit_naoexiste000000");

    // lists never include the first client's records
    for (const path of ["/api/materials", "/api/content", "/api/approvals", "/api/kits", "/api/briefings", "/api/portal/projects", "/api/releases", "/api/zips"])
      assert.deepEqual((await other.get(path)).body.items, [], path);
    assert.deepEqual(ids((await other.get("/api/brands")).body.items), [f.otherBrand]);
    assert.deepEqual((await other.get(`/api/materials?projectId=${f.project}`)).body.items, []);
    assert.deepEqual((await other.get(`/api/materials?brandId=${f.brand}`)).body.items, []);
    ok(await other.get("/api/portal/overview"), 200, "own overview");
    ok(await other.get("/api/portal/activity"), 200, "own activity");
    ok(await other.get("/api/notifications"), 200, "own notifications");

    // materials, versions and their sub-resources
    for (const id of [f.logo, f.post, f.draft]) {
      await is404(other.get(`/api/materials/${id}`), `material ${id}`);
      await is404(other.get(`/api/materials/${id}/comments`), "comments");
      await is404(other.post(`/api/materials/${id}/comments`, { body: "oi" }), "comment");
      await is404(other.get(`/api/materials/${id}/approvals`), "approvals");
      await is404(other.get(`/api/materials/${id}/history`), "history");
      await is404(other.post(`/api/materials/${id}/approve`, { versionId: f.v2 }), "approve");
      await is404(other.post(`/api/materials/${id}/request-changes`, { versionId: f.v2, body: "x" }), "request changes");
    }
    await is404(other.get(`/api/content/${f.post}`), "content");
    for (const id of [f.v1, f.v2, f.logoV1]) await is404(other.get(`/api/versions/${id}`), `version ${id}`);
    await is404(other.patch(`/api/comments/${f.clientComment}`, { body: "x" }), "comment by id");

    // files: previews, stream, download links
    for (const fileId of [f.logoPng, f.logoSvg, f.logoPdf, ...f.v1Slides, ...f.v2Slides, f.draftFile]) {
      await is404(other.get(`/api/files/${fileId}/preview/thumb`), `thumb ${fileId}`);
      await is404(other.get(`/api/files/${fileId}/preview/preview`), `preview ${fileId}`);
      await is404(other.get(`/api/files/${fileId}/stream`), `stream ${fileId}`);
      await is404(other.post("/api/downloads/link", { fileId }), `download link ${fileId}`);
    }
    // a valid link minted for the first client's user reveals nothing either
    const stolenFile = await other.get(f.ninaFileLink);
    assert.equal(stolenFile.status, 404, `stolen file link: ${stolenFile.status}`);
    const stolenZip = await other.get(f.ninaZipLink);
    assert.equal(stolenZip.status, 404, `stolen ZIP link: ${stolenZip.status}`);
    // ...while the first client still can use them
    ok(await as.client.get(f.ninaFileLink), 200, "own link still works");

    // ZIP jobs and ZIPs built from foreign ids
    await is404(other.get(`/api/zips/${f.ninaZipJob}`), "zip job");
    await is404(other.post(`/api/zips/${f.ninaZipJob}/link`), "zip link");
    for (const scope of [
      { type: "selection", fileIds: [f.logoPng] },
      { type: "selection", materialIds: [f.logo] },
      { type: "category", brandId: f.brand, categoryId: f.logos },
      { type: "brand_kit", brandId: f.brand },
      { type: "brand_kit", brandId: f.brand2 },
      { type: "carousel", materialId: f.post },
      { type: "project", projectId: f.project },
      { type: "kit", kitId: f.kit },
    ])
      await is404(other.post("/api/zips", { scope }), `zip ${scope.type}`);

    // kits, briefings, brands and their library, notifications
    await is404(other.get(`/api/kits/${f.kit}`), "kit");
    await is404(other.get(`/api/briefings/${f.briefing}`), "briefing");
    await is404(other.put(`/api/briefings/${f.briefing}/answers`, { answers: {}, submit: false }), "briefing answers");
    for (const brandId of [f.brand, f.brand2]) {
      await is404(other.get(`/api/brands/${brandId}`), "brand");
      await is404(other.get(`/api/brands/${brandId}/library`), "brand library");
    }
    await is404(other.get(`/api/portal/projects?brandId=${f.brand}`), "portal projects of a foreign brand");
    const ninaNotification = (await notificationsOf(as.client))[0].id;
    await is404(other.post(`/api/notifications/${ninaNotification}/read`), "notification");

    // projects have no client detail endpoint: the staff one answers the same
    // way for a foreign id and for one that does not exist (nothing revealed)
    const foreign = await other.get(`/api/projects/${f.project}`);
    const nonexistent = await other.get("/api/projects/prj_naoexiste000000");
    assert.equal(foreign.status, nonexistent.status);
    assert.deepEqual(foreign.body, nonexistent.body);
    assert.ok([403, 404].includes(foreign.status));
    await is404(other.post("/api/zips", { scope: { type: "project", projectId: f.project } }), "project zip");
    assert.ok(scanned.olga > 60, "every answer to the other client was scanned");
  });

  test("10. the admin reads the whole history, in order", async () => {
    const history = await as.admin.get(`/api/materials/${f.post}/history`);
    ok(history, 200, "admin history");
    const chronological = [...history.body.activity].reverse();
    const actions = chronological.map((entry) => entry.action);
    const expected = [
      "material.created",
      "material.released",
      "comment.internal",
      "comment.created",
      "comment.created",
      "material.changes_requested",
      "version.created",
      "file.deleted",
      "version.updated",
      "material.released",
      "material.approved",
    ];
    assert.deepEqual(actions, expected, actions.join(" → "));
    const byAction = (action, n = 0) => chronological.filter((entry) => entry.action === action)[n];
    assert.equal(byAction("material.created").actor.id, u.designer.id);
    assert.equal(byAction("material.released").actor.id, u.manager.id);
    assert.equal(byAction("material.released").data.versionNumber, 1);
    assert.equal(byAction("material.released", 1).data.versionNumber, 2);
    assert.equal(byAction("material.changes_requested").actor.id, u.client.id);
    assert.equal(byAction("material.approved").actor.id, u.client.id);
    assert.equal(byAction("material.approved").data.versionId, f.v2);
    for (let i = 1; i < chronological.length; i++)
      assert.ok(chronological[i - 1].createdAt <= chronological[i].createdAt, "activity in time order");

    assert.deepEqual(
      history.body.versions.map((v) => [v.number, v.status, v.releasedBy?.id, v.decidedBy?.id]),
      [
        [2, "approved", u.manager.id, u.client.id],
        [1, "superseded", u.manager.id, u.client.id],
      ],
    );
    assert.deepEqual(
      history.body.releases.map((r) => [r.versionNumber, r.actor.id]),
      [
        [2, u.manager.id],
        [1, u.manager.id],
      ],
    );
    const zipDownloads = history.body.downloads.filter((d) => d.kind === "zip" && d.user.id === u.client.id);
    assert.ok(zipDownloads.length >= 2, "carousel and project ZIPs");
    assert.ok(history.body.downloads.some((d) => d.kind === "file" && d.fileName === "slide-3-ajustado.png"));
    assert.ok(history.body.downloads.every((d) => d.isApproval === false));
    // the merged timeline: newest first, downloads after the approval
    const merged = [...history.body.items].reverse();
    for (let i = 1; i < merged.length; i++) assert.ok(merged[i - 1].createdAt <= merged[i].createdAt, "timeline in time order");
    const approvedAt = merged.findIndex((entry) => entry.action === "material.approved");
    const clientDownload = merged.findIndex((entry) => entry.type === "download" && entry.actor?.id === u.client.id);
    assert.ok(approvedAt >= 0 && clientDownload > approvedAt, "the client's downloads come after the approval");
    // the team's own download of the old slide (step 6) is recorded as well
    const staffDownload = merged.findIndex((entry) => entry.type === "download" && entry.actor?.id === u.manager.id);
    assert.ok(staffDownload >= 0 && staffDownload < approvedAt);

    // the global activity log for the client, filtered, paged and in order
    const log = await as.admin.get(`/api/activity?clientId=${f.client}&pageSize=200`);
    ok(log, 200, "activity");
    const all = [...log.body.items].reverse();
    const index = (action, predicate = () => true) => all.findIndex((entry) => entry.action === action && predicate(entry));
    const steps = [
      index("client.created"),
      index("user.invite_accepted"),
      index("project.created"),
      index("task.created"),
      index("briefing.created"),
      index("material.created", (e) => e.materialId === f.post),
      index("release.created"),
      index("comment.created", (e) => e.materialId === f.post),
      index("material.changes_requested"),
      index("version.created"),
      index("material.approved"),
      index("kit.released"),
    ];
    assert.ok(steps.every((step) => step >= 0), `missing steps: ${JSON.stringify(steps)}`);
    assert.deepEqual([...steps].sort((a, b) => a - b), steps, "activity of the client in order");
    const perMaterial = await as.admin.get(`/api/activity?materialId=${f.post}&pageSize=200`);
    const isDownload = (entry) => entry.entityType === "download";
    assert.deepEqual(
      new Set(perMaterial.body.items.filter((entry) => !isDownload(entry)).map((entry) => entry.id)),
      new Set(history.body.activity.map((entry) => entry.id)),
    );
    // the admin history lists this material's downloads too, never as approvals (lead decision D1)
    const downloadsLogged = perMaterial.body.items.filter(isDownload);
    assert.ok(downloadsLogged.length > 0, "downloads in the admin history");
    assert.ok(downloadsLogged.every((entry) => /^download\./.test(entry.action)));
    const loggedIds = new Set(downloadsLogged.map((entry) => entry.id));
    assert.ok(history.body.downloads.every((d) => !d.id || loggedIds.has(d.id)), "same downloads as the material history");
    // the other client's records stay out of this client's log
    assert.ok(log.body.items.every((entry) => !entry.client || entry.client.id === f.client));
  });

  test("11. upload, download and payment failures get clear, documented errors", async () => {
    // uploads: over the limit (streamed and declared), wrong type, fake signature, empty
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1.5 * 1024 * 1024, 7)]);
    for (const buffer of [big, Buffer.alloc(3 * 1024 * 1024, 1)]) {
      const res = await as.designer.upload("/api/uploads", { buffer, filename: "grande.png", contentType: "image/png" });
      assert.equal(res.status, 413);
      assert.equal(res.body.error.code, "payload_too_large");
      assert.equal(res.body.error.message, "O arquivo ultrapassa o limite de 1 MB.");
    }
    const exe = await as.designer.upload("/api/uploads", { buffer: Buffer.from("MZ\x90\x00binary"), filename: "setup.exe" });
    assert.equal(exe.status, 415);
    assert.equal(exe.body.error.code, "unsupported_media");
    assert.match(exe.body.error.message, /\.exe não são aceitos/);
    const fake = await as.designer.upload("/api/uploads", { buffer: Buffer.from("isto não é um png"), filename: "foto.png" });
    assert.equal(fake.status, 415);
    assert.match(fake.body.error.message, /não corresponde a um \.png/);
    const empty = await as.designer.upload("/api/uploads", { buffer: Buffer.alloc(0), filename: "vazio.png" });
    assert.equal(empty.status, 422);
    assert.equal(empty.body.error.fields.file, "O arquivo está vazio.");
    const stillWorks = await upload(as.designer, "depois-do-erro.png", await png(), "image/png");
    ok(await as.designer.del(`/api/uploads/${stillWorks}`), 204, "discard upload");

    // download links: forged, tampered, expired, anonymous
    const forged = await as.client.get("/dl/token-invalido");
    assert.equal(forged.status, 404);
    assert.equal(forged.body.error.code, "not_found");
    const [body, mac] = f.ninaFileLink.slice("/dl/".length).split(".");
    const tampered = await as.client.get(`/dl/${body}.${mac.slice(0, -3)}abc`);
    assert.equal(tampered.status, 404);
    const shortLived = server.ctx.signer.issue({ t: "file", id: f.logoPng, u: u.client.id }, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const expired = await as.client.get(shortLived.url);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, "expired");
    assert.match(expired.body.error.message, /expirou/);
    const anonymous = await createAgent(server).get(f.ninaFileLink);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, "unauthenticated");

    // download disabled by the team: 403 with the documented code, also for links issued before
    const earlierLink = (await as.client.post("/api/downloads/link", { fileId: f.logoPng })).body.url;
    ok(await as.manager.patch(`/api/materials/${f.logo}`, { downloadEnabled: false }), 200, "disable download");
    const blocked = await as.client.post("/api/downloads/link", { fileId: f.logoPng });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "download_disabled");
    assert.match(blocked.body.error.message, /download/);
    const late = await as.client.get(earlierLink);
    assert.equal(late.status, 403);
    assert.equal(late.body.error.code, "download_disabled");
    const selection = await as.client.post("/api/zips", { scope: { type: "selection", fileIds: [f.logoPng] } });
    assert.equal(selection.status, 403);
    assert.equal(selection.body.error.code, "download_disabled");
    const view = (await as.client.get(`/api/materials/${f.logo}`)).body.material;
    assert.equal(view.permissions.canDownload, false);
    assert.ok(view.versions[0].files.every((file) => file.downloadable === false));
    ok(await as.client.get(`/api/files/${f.logoPng}/preview/thumb`), 200, "the preview stays visible");

    // payments: not configured -> 503
    const order = await as.finance.post("/api/orders", {
      clientId: f.client,
      brandId: f.brand,
      description: "Identidade visual — parcela final",
      amountCents: 250000,
      dueDate: "2026-10-30",
    });
    ok(order, 201, "create order");
    f.order = order.body.order.id;
    assert.equal(order.body.order.status, "draft");
    assert.equal((await as.finance.get("/api/finance/status")).body.mercadopago.configured, false);
    const notConfigured = await as.finance.post(`/api/orders/${f.order}/checkout`);
    assert.equal(notConfigured.status, 503);
    assert.equal(notConfigured.body.error.code, "integration_not_configured");
    assert.match(notConfigured.body.error.message, /Mercado Pago/);
    assert.equal((await as.finance.get(`/api/orders/${f.order}`)).body.order.status, "draft");

    // credentials in place (read per request), but Mercado Pago fails -> 502
    Object.assign(server.ctx.config, {
      mercadopago: { accessToken: "TEST-acceptance-token", webhookSecret: WEBHOOK_SECRET, apiBase: mp.url },
      mpAccessToken: "TEST-acceptance-token",
      mpWebhookSecret: WEBHOOK_SECRET,
      mpApiBase: mp.url,
    });
    assert.deepEqual((await as.finance.get("/api/finance/status")).body.mercadopago.configured, true);
    mp.state.mode = "error";
    const upstream = await as.finance.post(`/api/orders/${f.order}/checkout`);
    assert.equal(upstream.status, 502);
    assert.equal(upstream.body.error.code, "upstream_error");
    assert.match(upstream.body.error.message, /Tente de novo/);
    const unchanged = (await as.finance.get(`/api/orders/${f.order}`)).body.order;
    assert.equal(unchanged.status, "draft");
    assert.equal(unchanged.checkoutUrl, null);

    // Mercado Pago back: the checkout link is created and the client can pay
    mp.state.mode = "ok";
    const checkout = await as.finance.post(`/api/orders/${f.order}/checkout`);
    ok(checkout, 200, "checkout");
    assert.match(checkout.body.checkoutUrl, /^https:\/\/sandbox\.mp\.example\//);
    assert.equal(mp.state.calls.find((c) => c.path === "/checkout/preferences").auth, "Bearer TEST-acceptance-token");
    const reference = checkout.body.order.externalReference;
    const billing = await as.client.get("/api/portal/billing");
    const open = billing.body.orders.find((o) => o.id === f.order);
    assert.equal(open.status, "pending_payment");
    assert.equal(open.canPay, true);
    const pay = await as.client.post(`/api/portal/orders/${f.order}/pay`);
    ok(pay, 200, "client pay");
    assert.equal(pay.body.checkoutUrl, checkout.body.checkoutUrl);
    assert.deepEqual((await as.otherClient.get("/api/portal/billing")).body.orders, []);
    assert.equal((await as.otherClient.post(`/api/portal/orders/${f.order}/pay`)).status, 404);

    // the card is refused at Mercado Pago; a forged notification changes nothing
    mp.state.payments.set("880001", {
      id: 880001,
      status: "rejected",
      status_detail: "cc_rejected_insufficient_amount",
      external_reference: reference,
      transaction_amount: 2500,
      currency_id: "BRL",
      payment_type_id: "credit_card",
      payment_method_id: "visa",
      date_created: new Date().toISOString(),
      date_approved: null,
      live_mode: false,
    });
    const forgedHook = await postWebhook({ dataId: "880001", signature: `ts=${Date.now()},v1=${"0".repeat(64)}` });
    assert.equal(forgedHook.status, 401);
    assert.equal((await as.finance.get(`/api/orders/${f.order}`)).body.order.status, "pending_payment");

    // the signed notification is confirmed against the API and marks the order failed
    const hook = await postWebhook({ dataId: "880001" });
    assert.equal(hook.status, 200, JSON.stringify(hook.body));
    const failed = await waitFor(async () => {
      const res = await as.finance.get(`/api/orders/${f.order}`);
      return res.body.order.status === "failed" ? res.body.order : null;
    });
    assert.equal(failed.failureReason, "Saldo ou limite insuficiente");
    const clientOrder = (await as.client.get("/api/portal/billing")).body.orders.find((o) => o.id === f.order);
    assert.equal(clientOrder.status, "failed");
    assert.equal(clientOrder.failureReason, "Saldo ou limite insuficiente");
    assert.equal(clientOrder.canPay, true, "the client can try again");
    const failure = (await notificationsOf(as.client)).find((n) => n.type === "payment.failed");
    assert.ok(failure, "client told about the refused payment");
    assert.match(failure.body, /Saldo ou limite insuficiente/);
    assert.ok(scanned.nina > 100, "every answer to the client was scanned");
  });
});

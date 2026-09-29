// Slice I: overviews, reports and history. Counts must match the fixtures,
// stay inside each viewer's scope, and never leak internal rows to clients.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";
import { addDaysToDate, csvCell, localDayStartIso, localToday } from "../routes/reports.js";
import {
  addStaffAccess,
  createBrand,
  createClientWithBrand,
  createProject,
  createUser,
  insertMaterial,
  login,
  startTestServer,
} from "./helpers.js";

let server;
let ctx;
const u = {};
const f = {};
const agents = {};

const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const today = localToday();
const inDays = (n) => addDaysToDate(today, n);
// A timestamp at local noon of today + n days (safe from day-boundary flakiness).
const noonIn = (n) => iso(Date.parse(localDayStartIso(inDays(n))) + 12 * HOUR);

function run(sql, params) {
  return ctx.db.run(sql, params);
}

function setMaterial(id, fields) {
  const keys = Object.keys(fields);
  run(`UPDATE materials SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
}

// Extra released version for a material (number n, released at `at`).
function addVersion(materialId, number, at, userId, status = "released") {
  const id = newId("ver");
  run(
    `INSERT INTO material_versions (id, material_id, number, status, created_by, created_at, released_at, released_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, materialId, number, status, userId, at, at, userId],
  );
  return id;
}

function decide(materialId, versionId, decision, at, userId) {
  run(
    "INSERT INTO approvals (id, material_id, version_id, decision, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [newId("apr"), materialId, versionId, decision, userId, at],
  );
}

function activity({ actor, action, entityType = "material", entityId = null, clientId = null, brandId = null, projectId = null, materialId = null, summary, visibility = "internal", data = null, at = now() }) {
  run(
    `INSERT INTO activity_log (actor_id, actor_role, action, entity_type, entity_id, client_id, brand_id, project_id, material_id,
       summary, data, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [actor?.id ?? null, actor?.role ?? null, action, entityType, entityId, clientId, brandId, projectId, materialId, summary, data ? JSON.stringify(data) : null, visibility, at],
  );
}

function download({ user, clientId, brandId, materialId = null, fileId = null, kind = "file", zipJobId = null, scope, at }) {
  const id = newId("dle");
  run(
    `INSERT INTO download_events (id, user_id, client_id, brand_id, material_id, file_id, zip_job_id, kind, scope, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, user.id, clientId, brandId, materialId, fileId, zipJobId, kind, scope ?? (kind === "zip" ? "selection" : "file"), at],
  );
  return id;
}

// A ready ZIP job whose entries hold every file of `items` (insertMaterial results).
function zipJob({ user, clientId, brandId, items, scope, label }) {
  const id = newId("zip");
  const entries = items.flatMap((item) =>
    item.files.map((file, index) => ({ f: file.id, m: item.material.id, p: `${label}/${index + 1}-${file.id}.png`, s: 0, n: 10 })),
  );
  run(
    `INSERT INTO zip_jobs (id, user_id, client_id, brand_id, scope, label, filename, status, file_count, total_bytes, entries, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
    [id, user.id, clientId, brandId, JSON.stringify(scope), label, `${label}.zip`, entries.length, entries.length * 10, JSON.stringify(entries), now()],
  );
  return id;
}

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;

  const a = createClientWithBrand(ctx, { name: "Cliente Aurora", brandName: "Aurora" });
  const b = createClientWithBrand(ctx, { name: "Cliente Boreal", brandName: "Boreal" });
  Object.assign(f, { clientA: a.clientId, brandA: a.brandId, clientB: b.clientId, brandB: b.brandId });
  f.brandA2 = createBrand(ctx, a.clientId, "Aurora Kids").id;

  u.admin = await createUser(ctx, { role: "admin", name: "Ana Admin" });
  u.managerA = await createUser(ctx, { role: "manager", name: "Gabi Gestora" });
  u.designer = await createUser(ctx, { role: "designer", name: "Davi Designer" });
  u.finance = await createUser(ctx, { role: "finance", name: "Fábio Financeiro" });
  u.clientA = await createUser(ctx, { role: "client", clientId: a.clientId, name: "Carla Aurora" });
  u.clientB = await createUser(ctx, { role: "client", clientId: b.clientId, name: "Bruno Boreal" });
  addStaffAccess(ctx, u.managerA.id, a.clientId);

  f.projectA = createProject(ctx, { brandId: a.brandId, name: "Identidade Aurora", memberIds: [u.designer.id] });
  f.projectA2 = createProject(ctx, { brandId: a.brandId, name: "Site Aurora", status: "planning" });
  f.projectB = createProject(ctx, { brandId: b.brandId, name: "Campanha Boreal" });
  run("UPDATE projects SET due_date = ? WHERE id = ?", [inDays(10), f.projectA.id]);
  run("UPDATE projects SET due_date = ? WHERE id = ?", [inDays(3), f.projectB.id]);

  // Client A materials
  f.pendingA = await insertMaterial(ctx, { brandId: a.brandId, projectId: f.projectA.id, title: "Logo principal", visibility: "released", createdBy: u.designer.id });
  setMaterial(f.pendingA.material.id, { internal_notes: "nota interna secreta" });
  f.changesA = await insertMaterial(ctx, { brandId: a.brandId, projectId: f.projectA.id, title: "Carrossel lançamento", kind: "post", plannedDate: inDays(5), visibility: "released", createdBy: u.designer.id });
  f.approvedA = await insertMaterial(ctx, { brandId: a.brandId, projectId: f.projectA.id, title: "Manual da marca", categorySlug: "manual-da-marca", visibility: "released", createdBy: u.designer.id });
  f.draftA = await insertMaterial(ctx, { brandId: a.brandId, projectId: f.projectA.id, title: "Rascunho da papelaria", createdBy: u.designer.id });
  setMaterial(f.draftA.material.id, { due_date: inDays(5) });
  f.reviewA = await insertMaterial(ctx, { brandId: a.brandId, projectId: f.projectA2.id, title: "Ícones do site", visibility: "internal_review", createdBy: u.managerA.id });
  setMaterial(f.reviewA.material.id, { due_date: inDays(-2) });
  f.otherBrandA2 = await insertMaterial(ctx, { brandId: f.brandA2, title: "Logo Kids", visibility: "released", createdBy: u.managerA.id });
  // Client B
  f.pendingB = await insertMaterial(ctx, { brandId: b.brandId, projectId: f.projectB.id, title: "Logo Boreal", visibility: "released", createdBy: u.admin.id });
  setMaterial(f.pendingB.material.id, { due_date: inDays(2) });

  // Decision history on A: carrossel v1 changes requested; manual v1 changes, v2 approved (1 round).
  const t0 = Date.now() - 20 * 24 * HOUR;
  run("UPDATE material_versions SET released_at = ? WHERE id = ?", [iso(t0), f.changesA.version.id]);
  decide(f.changesA.material.id, f.changesA.version.id, "changes_requested", iso(t0 + 10 * HOUR), u.clientA.id);
  setMaterial(f.changesA.material.id, { approval_status: "changes_requested" });

  run("UPDATE material_versions SET released_at = ?, status = 'superseded' WHERE id = ?", [iso(t0), f.approvedA.version.id]);
  decide(f.approvedA.material.id, f.approvedA.version.id, "changes_requested", iso(t0 + 20 * HOUR), u.clientA.id);
  const v2 = addVersion(f.approvedA.material.id, 2, iso(t0 + 48 * HOUR), u.designer.id, "approved");
  decide(f.approvedA.material.id, v2, "approved", iso(t0 + 54 * HOUR), u.clientA.id);
  setMaterial(f.approvedA.material.id, { approval_status: "approved", approved_version_id: v2, released_version_id: v2, current_version_id: v2 });

  // Client B decision (must never count for manager A)
  run("UPDATE material_versions SET released_at = ? WHERE id = ?", [iso(t0), f.pendingB.version.id]);
  const vB2 = addVersion(f.pendingB.material.id, 2, iso(t0 + 5 * HOUR), u.admin.id);
  decide(f.pendingB.material.id, vB2, "approved", iso(t0 + 7 * HOUR), u.clientB.id);
  setMaterial(f.pendingB.material.id, { approval_status: "pending", released_version_id: vB2, current_version_id: vB2 });

  // Briefings: A awaiting, A draft (not counted), B in progress
  const at = now();
  const briefing = (brandId, status, title, questions = [], answers = {}) => {
    const id = newId("brf");
    run(
      `INSERT INTO briefings (id, brand_id, title, questions, answers, status, sent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, brandId, title, JSON.stringify(questions), JSON.stringify(answers), status, status === "draft" ? null : at, at, at],
    );
    return id;
  };
  f.briefingA = briefing(
    a.brandId,
    "awaiting_client",
    "Briefing de conteúdo",
    [
      { id: "q1", label: "Público", type: "text", required: true },
      { id: "q2", label: "Tom", type: "text", required: false },
    ],
    { q1: "Fintechs" },
  );
  briefing(a.brandId, "draft", "Rascunho de briefing");
  briefing(b.brandId, "in_progress", "Briefing Boreal");

  // Commerce: A pending order, B paid + failed, A active subscription.
  const svc = ctx.db.get("SELECT id FROM services ORDER BY sort_order LIMIT 1").id;
  const order = (clientId, brandId, status, cents, extra = {}) =>
    run(
      `INSERT INTO orders (id, client_id, brand_id, description, amount_cents, status, due_date, external_reference, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("ord"), clientId, brandId, extra.description ?? "Pedido de teste", cents, status, extra.due ?? null, newId("ref"), extra.paidAt ?? null, extra.at ?? at, extra.at ?? at],
    );
  order(a.clientId, a.brandId, "pending_payment", 150000, { due: inDays(7), description: "Identidade visual" });
  order(b.clientId, b.brandId, "paid", 90000, { paidAt: noonIn(-3) });
  order(b.clientId, b.brandId, "failed", 50000, { at: noonIn(-2), description: "=HYPERLINK(\"x\")" });
  run(
    `INSERT INTO subscriptions (id, client_id, service_id, amount_cents, status, external_reference, created_at, updated_at)
     VALUES (?, ?, ?, 120000, 'active', ?, ?, ?)`,
    [newId("sub"), a.clientId, svc, newId("ref"), at, at],
  );

  // Tasks: designer has 2 open (1 overdue) and 1 done.
  const task = (title, status, due) =>
    run(
      `INSERT INTO tasks (id, project_id, title, assignee_id, status, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("tsk"), f.projectA.id, title, u.designer.id, status, due, at, at],
    );
  task("Ajustar carrossel", "doing", inDays(-1));
  task("Exportar logos", "todo", inDays(4));
  task("Tarefa concluída", "done", inDays(1));

  // Activity: client-visible and internal rows on A, rows on B, an old row.
  activity({ actor: u.managerA, action: "release.created", entityType: "release", clientId: a.clientId, brandId: a.brandId, materialId: f.pendingA.material.id, projectId: f.projectA.id, summary: "Gabi liberou “Logo principal”.", visibility: "client", data: { items: 1 }, at: noonIn(-1) });
  activity({ actor: u.designer, action: "material.created", clientId: a.clientId, brandId: a.brandId, materialId: f.draftA.material.id, projectId: f.projectA.id, entityId: f.draftA.material.id, summary: "Davi criou o material “Rascunho da papelaria”.", data: { secret: "interno" }, at: noonIn(0) });
  activity({ actor: u.clientA, action: "approval.approved", entityType: "approval", clientId: a.clientId, brandId: a.brandId, materialId: f.approvedA.material.id, projectId: f.projectA.id, summary: "Carla aprovou a versão 2 de “Manual da marca”.", visibility: "client", at: noonIn(-15) });
  activity({ actor: u.admin, action: "client.updated", entityType: "client", entityId: a.clientId, clientId: a.clientId, summary: "Ana atualizou o cadastro de Cliente Aurora.", at: noonIn(-5) });
  activity({ actor: u.admin, action: "release.created", entityType: "release", clientId: b.clientId, brandId: b.brandId, materialId: f.pendingB.material.id, projectId: f.projectB.id, summary: "Ana liberou “Logo Boreal”.", visibility: "client", at: noonIn(-1) });
  activity({ actor: u.clientA, action: "order.paid", entityType: "order", clientId: a.clientId, summary: "Pagamento confirmado.", visibility: "client", at: noonIn(-40) });
  activity({ actor: u.admin, action: "settings.updated", entityType: "settings", summary: "Ana alterou as configurações.", at: noonIn(-2) });

  // Downloads: client A twice (file + zip), staff once on A, client B once.
  const fileA = f.pendingA.files[0].id;
  download({ user: u.clientA, clientId: a.clientId, brandId: a.brandId, materialId: f.pendingA.material.id, fileId: fileA, at: noonIn(-2) });
  download({ user: u.clientA, clientId: a.clientId, brandId: a.brandId, kind: "zip", at: noonIn(-1) });
  download({ user: u.managerA, clientId: a.clientId, brandId: a.brandId, materialId: f.pendingA.material.id, fileId: fileA, at: noonIn(-1) });
  download({ user: u.clientB, clientId: b.clientId, brandId: b.brandId, materialId: f.pendingB.material.id, fileId: f.pendingB.files[0].id, at: noonIn(-1) });

  for (const [key, user] of Object.entries(u)) agents[key] = await login(server, { email: user.email });
});

after(async () => {
  await server?.close();
});

// ------------------------------------------------------------------ overview

describe("GET /api/admin/overview", () => {
  test("admin sees every client", async () => {
    const res = await agents.admin.get("/api/admin/overview");
    assert.equal(res.status, 200);
    const o = res.body;
    assert.equal(o.projectsInProgress, 2); // projectA + projectB (projectA2 is planning)
    assert.equal(o.pendingApprovals, 3); // pendingA, otherBrandA2, pendingB
    assert.equal(o.changesRequested, 1);
    assert.equal(o.awaitingRelease, 1);
    assert.equal(o.briefingsAwaiting, 2);
    // open orders: A awaiting payment + B rejected by Mercado Pago (still owed)
    assert.equal(o.paymentsPending, 2);
    assert.equal(o.paymentsPendingCents, 200000);
    assert.equal(o.paymentsFailed, 1);
    assert.equal(o.activeSubscriptions, 1);
    assert.equal(o.activeSubscriptionsCents, 120000);
    // next 14 days: draftA (5d), pendingB (2d), changesA (post planned in 5d), projectA (10d), projectB (3d); overdue: reviewA
    assert.equal(o.upcomingCount, 5);
    assert.equal(o.overdueCount, 1);
    assert.equal(o.upcomingDeliveries[0].id, f.reviewA.material.id);
    assert.equal(o.upcomingDeliveries[0].overdue, true);
    const titles = o.upcomingDeliveries.map((item) => item.title);
    assert.ok(titles.includes("Identidade Aurora") && titles.includes("Logo Boreal") && titles.includes("Carrossel lançamento"));
    assert.ok(o.recentActivity.length >= 5 && o.recentActivity.length <= 8);
    assert.ok(o.recentActivity.every((item) => "data" in item && "visibility" in item));
    // client downloads show up in the recent activity; the team's own do not
    const downloads = o.recentActivity.filter((item) => item.entityType === "download");
    assert.ok(downloads.length > 0);
    assert.ok(downloads.every((item) => item.actor.role === "client" && item.isApproval === false));
  });

  test("manager counts only the clients they manage", async () => {
    const o = (await agents.managerA.get("/api/admin/overview")).body;
    assert.equal(o.projectsInProgress, 1);
    assert.equal(o.pendingApprovals, 2);
    assert.equal(o.changesRequested, 1);
    assert.equal(o.briefingsAwaiting, 1);
    assert.equal(o.paymentsPending, null);
    assert.equal(o.activeSubscriptions, null);
    assert.equal(o.upcomingCount, 3); // draftA + changesA (post) + projectA
    assert.ok(o.upcomingDeliveries.every((item) => item.client.id === f.clientA));
    assert.ok(o.recentActivity.length > 0);
    assert.ok(o.recentActivity.every((item) => item.client?.id === f.clientA));
  });

  test("designer sees their projects and open tasks", async () => {
    const o = (await agents.designer.get("/api/admin/overview")).body;
    assert.equal(o.projectsInProgress, 1);
    assert.equal(o.pendingApprovals, 1); // only pendingA (projectA); otherBrandA2 is not theirs
    assert.equal(o.awaitingRelease, null); // no materials.release
    assert.equal(o.paymentsPending, null);
    assert.equal(o.myTasksTotal, 2);
    assert.deepEqual(o.myTasks.map((t) => t.title), ["Ajustar carrossel", "Exportar logos"]);
    assert.equal(o.myTasks[0].overdue, true);
    assert.ok(o.upcomingDeliveries.every((item) => item.client.id === f.clientA));
    assert.ok(o.recentActivity.every((item) => item.client?.id !== f.clientB));
    assert.ok(!o.recentActivity.some((item) => item.action === "settings.updated"));
  });

  test("finance sees commerce only", async () => {
    const o = (await agents.finance.get("/api/admin/overview")).body;
    assert.equal(o.paymentsPending, 2);
    assert.equal(o.paymentsFailed, 1);
    assert.equal(o.activeSubscriptions, 1);
    assert.equal(o.projectsInProgress, null);
    assert.equal(o.pendingApprovals, null);
    assert.equal(o.upcomingDeliveries, null);
    assert.equal(o.recentActivity, null);
  });

  test("clients and anonymous visitors are refused", async () => {
    assert.equal((await agents.clientA.get("/api/admin/overview")).status, 403);
    assert.equal((await fetch(`${server.url}/api/admin/overview`)).status, 401);
  });
});

describe("GET /api/portal/overview", () => {
  test("client A sees only their own released materials", async () => {
    const res = await agents.clientA.get("/api/portal/overview");
    assert.equal(res.status, 200);
    const o = res.body;
    assert.deepEqual(new Set(o.pendingApprovals.map((m) => m.id)), new Set([f.pendingA.material.id, f.otherBrandA2.material.id]));
    assert.ok(o.pendingApprovals.every((m) => !("internalNotes" in m) && m.visibility === "released"));
    assert.ok(!JSON.stringify(o).includes("nota interna secreta"));
    assert.ok(!JSON.stringify(o).includes(f.draftA.material.id));
    assert.ok(!JSON.stringify(o).includes(f.pendingB.material.id));
    assert.deepEqual(new Set(o.recentReleases.map((m) => m.id)), new Set([f.changesA.material.id, f.approvedA.material.id]));
    assert.deepEqual(o.upcoming.map((m) => m.id), [f.changesA.material.id]);
    assert.equal(o.totals.released, 4);
    assert.equal(o.totals.pendingApprovals, 2);
    assert.equal(o.totals.changesRequested, 1);
    assert.equal(o.billing.pendingOrders, 1);
    assert.equal(o.billing.pendingAmountCents, 150000);
    assert.equal(o.briefingsToFill.length, 1);
    assert.equal(o.briefingsToFill[0].questionCount, 2);
    assert.equal(o.briefingsToFill[0].answeredCount, 1);
    assert.equal(o.briefingsToFill[0].requiredAnswered, 1);
    // client-visible rows only, without data/visibility
    assert.deepEqual(o.recentActivity.map((a) => a.action).sort(), ["approval.approved", "order.paid", "release.created"]);
    assert.ok(o.recentActivity.every((a) => !("data" in a) && !("visibility" in a)));
    const release = o.recentActivity.find((a) => a.action === "release.created");
    assert.equal(release.link, `/painel/arquivos?material=${f.pendingA.material.id}`);
    assert.deepEqual(release.actor, { name: "Gabi Gestora" });
  });

  test("brand filter narrows lists and rejects other clients' brands", async () => {
    const o = (await agents.clientA.get(`/api/portal/overview?brandId=${f.brandA2}`)).body;
    assert.deepEqual(o.pendingApprovals.map((m) => m.id), [f.otherBrandA2.material.id]);
    assert.equal(o.briefingsToFill.length, 0);
    assert.equal(o.brand.id, f.brandA2);
    assert.equal((await agents.clientA.get(`/api/portal/overview?brandId=${f.brandB}`)).status, 404);
  });

  test("staff cannot use the portal endpoint", async () => {
    assert.equal((await agents.admin.get("/api/portal/overview")).status, 403);
  });
});

// ------------------------------------------------------------------ activity

describe("GET /api/activity", () => {
  test("admin reads everything with data, paginated", async () => {
    const res = await agents.admin.get("/api/activity?pageSize=3");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 11); // 7 activity rows + 4 downloads
    assert.equal(res.body.items.length, 3);
    assert.equal(res.body.hasMore, true);
    const all = (await agents.admin.get("/api/activity")).body.items;
    const created = all.find((a) => a.action === "material.created");
    assert.deepEqual(created.data, { secret: "interno" });
    assert.equal(created.visibility, "internal");
    assert.equal(created.link, `/admin/biblioteca/${f.draftA.material.id}`);
    assert.equal(created.material.title, "Rascunho da papelaria");
  });

  test("filters: client, action prefix, entity type, visibility, period and search", async () => {
    const get = async (qs) => (await agents.admin.get(`/api/activity?${qs}`)).body;
    assert.equal((await get(`clientId=${f.clientB}`)).total, 2); // release + Bruno's download
    assert.equal((await get("action=release.*")).total, 2);
    assert.equal((await get("action=release.created,order.paid")).total, 3);
    assert.equal((await get("entityType=client")).total, 1);
    assert.equal((await get("visibility=client")).total, 4); // downloads are internal records
    assert.equal((await get(`from=${inDays(-3)}&to=${inDays(0)}`)).total, 8); // 4 rows + 4 downloads
    assert.equal((await get("q=Papelaria")).total, 1);
    assert.equal((await get(`materialId=${f.pendingA.material.id}`)).total, 3); // release + 2 file downloads
    assert.equal((await agents.admin.get(`/api/activity?from=${inDays(1)}&to=${inDays(0)}`)).status, 422);
  });

  test("manager is limited to their clients; other ids answer 404", async () => {
    const res = await agents.managerA.get("/api/activity");
    assert.equal(res.body.total, 8); // 5 rows + 3 downloads on client A
    assert.ok(res.body.items.every((a) => a.client?.id === f.clientA));
    assert.equal((await agents.managerA.get(`/api/activity?clientId=${f.clientB}`)).status, 404);
    assert.equal((await agents.managerA.get(`/api/activity?materialId=${f.pendingB.material.id}`)).status, 404);
  });

  test("designer sees their projects and own actions only", async () => {
    const res = await agents.designer.get("/api/activity");
    // + the two downloads of "Logo principal" (a material of their project)
    assert.deepEqual(res.body.items.map((a) => a.action).sort(), ["approval.approved", "download.file", "download.file", "material.created", "release.created"]);
  });

  test("finance and clients cannot read the staff history", async () => {
    assert.equal((await agents.finance.get("/api/activity")).status, 403);
    assert.equal((await agents.clientA.get("/api/activity")).status, 403);
    assert.equal((await agents.finance.get("/api/activity/facets")).status, 403);
  });

  test("facets list only what is in scope", async () => {
    const res = await agents.managerA.get("/api/activity/facets");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.clients.map((c) => c.id), [f.clientA]);
    assert.ok(!res.body.actions.some((a) => a.action === "settings.updated"));
    assert.ok(res.body.actors.some((a) => a.id === u.designer.id));
  });

  test("CSV export has BOM, ; separator and is logged", async () => {
    const res = await agents.admin.request("GET", "/api/activity?format=csv&clientId=" + f.clientB, { raw: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv; charset=utf-8/);
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const lines = buffer.toString("utf8").slice(1).trimEnd().split("\r\n");
    assert.equal(lines[0].split(";")[0], "Data");
    assert.equal(lines.length, 3); // header + release + download
    assert.ok(lines.some((line) => /Ana liberou “Logo Boreal”/.test(line)));
    assert.ok(lines.some((line) => /Bruno Boreal baixou .*Download — não equivale a aprovação\./.test(line)));
    const logged = ctx.db.get("SELECT * FROM activity_log WHERE action = 'activity.exported' ORDER BY id DESC LIMIT 1");
    assert.equal(logged.actor_id, u.admin.id);
    ctx.db.run("DELETE FROM activity_log WHERE action IN ('activity.exported', 'report.exported')");
  });
});

describe("GET /api/portal/activity", () => {
  test("client sees only client-visible rows of their own account", async () => {
    const res = await agents.clientA.get("/api/portal/activity");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    assert.ok(res.body.items.every((a) => a.client.id === f.clientA && !("data" in a)));
    const b = (await agents.clientB.get("/api/portal/activity")).body;
    assert.deepEqual(b.items.map((a) => a.summary), ["Ana liberou “Logo Boreal”."]);
    assert.equal((await agents.clientA.get(`/api/portal/activity?brandId=${f.brandB}`)).status, 404);
    assert.equal((await agents.clientA.get("/api/portal/activity?entityType=order")).body.total, 1);
    assert.equal((await agents.managerA.get("/api/portal/activity")).status, 403);
  });

  test("links to materials the client can no longer see are dropped", async () => {
    setMaterial(f.pendingA.material.id, { archived_at: now() });
    const items = (await agents.clientA.get("/api/portal/activity")).body.items;
    const release = items.find((a) => a.action === "release.created");
    assert.equal(release.link, null);
    assert.equal(release.material, null);
    assert.equal(release.materialId, null);
    setMaterial(f.pendingA.material.id, { archived_at: null });
  });
});

// ------------------------------------------------------------------- reports

describe("reports", () => {
  const range = () => `from=${inDays(-30)}&to=${inDays(0)}`;

  test("deliveries count released versions per client, category and period", async () => {
    const res = await agents.admin.get(`/api/reports/deliveries?${range()}`);
    assert.equal(res.status, 200);
    const d = res.body;
    // released versions in range: pendingA v1, changesA v1, approvedA v1+v2, otherBrandA2 v1, pendingB v1+v2
    assert.equal(d.totals.releases, 7);
    assert.equal(d.totals.newMaterials, 5);
    assert.equal(d.totals.newVersions, 2);
    assert.equal(d.totals.clients, 2);
    assert.equal(d.series.reduce((sum, b) => sum + b.total, 0), 7);
    assert.equal(d.range.interval, "day");
    assert.equal(d.series.length, 31);
    const aurora = d.byClient.find((c) => c.id === f.clientA);
    assert.equal(aurora.total, 5);
    assert.ok(d.byCategory.some((c) => c.name === "Manual da marca" && c.total === 2));
  });

  test("manager's reports exclude other clients and reject their ids", async () => {
    const d = (await agents.managerA.get(`/api/reports/deliveries?${range()}`)).body;
    assert.equal(d.totals.releases, 5);
    assert.ok(d.byClient.every((c) => c.id === f.clientA));
    assert.equal((await agents.managerA.get(`/api/reports/deliveries?clientId=${f.clientB}`)).status, 404);
    assert.equal((await agents.managerA.get(`/api/reports/approvals?brandId=${f.brandB}`)).status, 404);
    const a = (await agents.managerA.get(`/api/reports/approvals?${range()}`)).body;
    assert.equal(a.totals.decisions, 3);
  });

  test("approvals: time to decision, rounds and approval rate", async () => {
    const a = (await agents.admin.get(`/api/reports/approvals?${range()}&clientId=${f.clientA}`)).body;
    assert.equal(a.totals.decisions, 3);
    assert.equal(a.totals.approved, 1);
    assert.equal(a.totals.changesRequested, 2);
    assert.equal(Math.round(a.totals.approvalRate * 1000), 333);
    // hours: 10, 20 (v1 of manual) and 6 (v2 approved) -> avg 12
    assert.equal(a.totals.avgHoursToDecision, 12);
    assert.equal(a.totals.avgHoursToApproval, 6);
    assert.equal(a.totals.avgRounds, 1);
    assert.equal(a.totals.firstPassRate, 0);
    assert.equal(a.roundsDistribution[1].total, 1);
    assert.equal(a.totals.pendingNow, 2);
    const manual = a.items.find((i) => i.material.id === f.approvedA.material.id);
    assert.equal(manual.rounds, 1);
    assert.equal(manual.lastDecision.decision, "approved");
  });

  test("downloads are counted per client and kept apart from approvals", async () => {
    const d = (await agents.admin.get(`/api/reports/downloads?${range()}`)).body;
    assert.equal(d.audience, "client");
    assert.equal(d.totals.events, 3);
    assert.equal(d.totals.files, 2);
    assert.equal(d.totals.zips, 1);
    assert.equal(d.totals.excluded, 1); // the manager's download
    assert.equal(d.byClient.find((c) => c.id === f.clientA).total, 2);
    assert.ok(!("approved" in d.totals));
    const team = (await agents.admin.get(`/api/reports/downloads?${range()}&audience=team`)).body;
    assert.equal(team.totals.events, 1);
    const scoped = (await agents.managerA.get(`/api/reports/downloads?${range()}&audience=all`)).body;
    assert.equal(scoped.totals.events, 3);
    assert.ok(scoped.byClient.every((c) => c.id === f.clientA));
    // a download never changes approval state
    assert.equal(ctx.db.get("SELECT approval_status FROM materials WHERE id = ?", [f.pendingA.material.id]).approval_status, "pending");
  });

  test("finance report requires reports.finance", async () => {
    assert.equal((await agents.managerA.get("/api/reports/finance")).status, 403);
    assert.equal((await agents.finance.get("/api/reports/deliveries")).status, 403);
    const res = await agents.finance.get(`/api/reports/finance?${range()}`);
    assert.equal(res.status, 200);
    const d = res.body;
    assert.equal(d.range.interval, "month");
    assert.equal(d.totals.paidCents, 90000);
    assert.equal(d.totals.pendingCents, 150000);
    assert.equal(d.totals.failedCents, 50000);
    assert.equal(d.totals.activeSubscriptions, 1);
    assert.equal(d.totals.recurringCents, 120000);
    const filtered = (await agents.finance.get(`/api/reports/finance?${range()}&clientId=${f.clientA}`)).body;
    assert.equal(filtered.totals.paidCents, 0);
    assert.equal(filtered.totals.pendingCents, 150000);
  });

  test("clients and designers cannot read reports", async () => {
    assert.equal((await agents.clientA.get("/api/reports/deliveries")).status, 403);
    assert.equal((await agents.designer.get("/api/reports/deliveries")).status, 403);
    assert.equal((await agents.designer.get("/api/reports/filters")).status, 403);
  });

  test("filters endpoint lists clients and reports in scope", async () => {
    const res = (await agents.managerA.get("/api/reports/filters")).body;
    assert.deepEqual(res.clients.map((c) => c.id), [f.clientA]);
    assert.deepEqual(res.reports, ["deliveries", "approvals", "downloads"]);
    const fin = (await agents.finance.get("/api/reports/filters")).body;
    assert.deepEqual(fin.reports, ["finance"]);
    assert.equal(fin.clients.length, 2);
  });

  test("CSV: UTF-8 BOM, ; separator, pt-BR numbers and formula neutralising", async () => {
    const res = await agents.finance.request("GET", `/api/reports/finance?${range()}&format=csv`, { raw: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv; charset=utf-8/);
    assert.match(res.headers.get("content-disposition"), /attachment; filename="metta-financeiro-/);
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
    assert.equal(text.charCodeAt(0), 0xfeff);
    const lines = text.slice(1).trimEnd().split("\r\n");
    assert.deepEqual(lines[0].split(";"), ["Mês", "Data", "Cliente", "Marca", "Descrição", "Origem", "Situação", "Valor (R$)"]);
    assert.equal(lines.length, 4);
    assert.ok(lines.some((line) => line.endsWith(";Pendente;1500,00")));
    assert.ok(lines.some((line) => line.includes(`"'=HYPERLINK(""x"")"`)));
    const deliveries = await agents.admin.request("GET", `/api/reports/deliveries?${range()}&format=csv`, { raw: true });
    const rows = Buffer.from(await deliveries.arrayBuffer()).toString("utf8").slice(1).trimEnd().split("\r\n");
    assert.equal(rows.length, 8); // header + 7 releases
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'report.exported'").n, 2);
  });

  test("csvCell escapes separators, quotes and formulas", () => {
    assert.equal(csvCell("a;b"), '"a;b"');
    assert.equal(csvCell('diz "oi"'), '"diz ""oi"""');
    assert.equal(csvCell("+55 11"), "'+55 11");
    assert.equal(csvCell(12.5), "12,5");
    assert.equal(csvCell({ money: 123456 }), "1234,56");
    assert.equal(csvCell(null), "");
  });

  test("invalid ranges answer 422 with a pt-BR field message", async () => {
    const res = await agents.admin.get("/api/reports/deliveries?from=2026-13-01");
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.from);
    const reversed = await agents.admin.get(`/api/reports/deliveries?from=${inDays(0)}&to=${inDays(-5)}`);
    assert.equal(reversed.status, 422);
  });
});

// --------------------------------------------------- review fixes (batch B5)

describe("Histórico lists downloads, never as approvals (D1)", () => {
  const x = {};
  before(() => {
    // Brand kit ZIP with two materials of project A; carousel ZIP with one;
    // a ZIP with only "Logo Kids" (no project: never the designer's).
    x.kitJob = zipJob({ user: u.clientA, clientId: f.clientA, brandId: f.brandA, items: [f.pendingA, f.changesA], scope: { type: "brand_kit", brandId: f.brandA }, label: "Kit de marca · Aurora" });
    x.carouselJob = zipJob({ user: u.clientA, clientId: f.clientA, brandId: f.brandA, items: [f.changesA], scope: { type: "carousel", materialId: f.changesA.material.id }, label: "Carrossel · Carrossel lançamento" });
    x.kidsJob = zipJob({ user: u.clientA, clientId: f.clientA, brandId: f.brandA2, items: [f.otherBrandA2], scope: { type: "selection", fileIds: [], materialIds: [f.otherBrandA2.material.id] }, label: "Seleção · 1 arquivo" });
    const job = (id) => ctx.db.get("SELECT scope FROM zip_jobs WHERE id = ?", [id]).scope;
    x.kit = download({ user: u.clientA, clientId: f.clientA, brandId: f.brandA, kind: "zip", zipJobId: x.kitJob, scope: job(x.kitJob), at: noonIn(0) });
    x.carousel = download({ user: u.clientA, clientId: f.clientA, brandId: f.brandA, kind: "zip", zipJobId: x.carouselJob, scope: job(x.carouselJob), at: noonIn(0) });
    x.kids = download({ user: u.clientA, clientId: f.clientA, brandId: f.brandA2, kind: "zip", zipJobId: x.kidsJob, scope: job(x.kidsJob), at: noonIn(0) });
  });
  after(() => {
    run("DELETE FROM download_events WHERE id IN (?, ?, ?)", [x.kit, x.carousel, x.kids]);
    run("DELETE FROM zip_jobs WHERE id IN (?, ?, ?)", [x.kitJob, x.carouselJob, x.kidsJob]);
  });

  test("file and ZIP downloads come with who, what, where and the no-approval note", async () => {
    const res = await agents.admin.get("/api/activity?action=download.*&pageSize=200");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 7); // 4 fixture downloads + 3 ZIPs
    const items = res.body.items;
    assert.ok(items.every((a) => a.entityType === "download" && a.isApproval === false && a.note === "Download — não equivale a aprovação."));
    assert.ok(items.every((a) => a.visibility === "internal" && a.data.approval === false));

    const file = items.find((a) => a.action === "download.file" && a.actor.id === u.clientA.id);
    assert.match(file.summary, /^Carla Aurora baixou “logo\.png” de “Logo principal”\.$/);
    assert.deepEqual(file.actor, { id: u.clientA.id, name: "Carla Aurora", role: "client" });
    assert.equal(file.client.id, f.clientA);
    assert.equal(file.brand.id, f.brandA);
    assert.equal(file.material.id, f.pendingA.material.id);
    assert.equal(file.link, `/admin/biblioteca/${f.pendingA.material.id}`);
    assert.equal(file.data.scope, "Arquivo individual");
    assert.equal(file.data.fileId, f.pendingA.files[0].id);

    const kit = items.find((a) => a.id === x.kit);
    assert.equal(kit.action, "download.zip");
    assert.equal(kit.summary, "Carla Aurora baixou o pacote ZIP “Kit de marca · Aurora”.");
    assert.equal(kit.material, null); // two materials: attributed through the entries
    assert.equal(kit.data.scope, "Kit de marca");
    assert.equal(kit.data.materials, 2);
    assert.equal(kit.data.zipJobId, x.kitJob);
    assert.equal(kit.link, `/admin/marcas/${f.brandA}`);

    const carousel = items.find((a) => a.id === x.carousel);
    assert.equal(carousel.material.id, f.changesA.material.id); // one material: named
    assert.equal(carousel.link, `/admin/conteudo/${f.changesA.material.id}`);
    assert.equal(carousel.projectId, f.projectA.id);

    // own type, own filter, searchable, and nothing changed the approval state
    assert.equal((await agents.admin.get("/api/activity?entityType=download")).body.total, 7);
    assert.equal((await agents.admin.get("/api/activity?q=Kit%20de%20marca")).body.items[0].id, x.kit);
    assert.equal(ctx.db.get("SELECT approval_status FROM materials WHERE id = ?", [f.changesA.material.id]).approval_status, "changes_requested");
  });

  test("ZIPs are attributed to the materials and projects they hold", async () => {
    const ids = async (qs) => (await agents.admin.get(`/api/activity?${qs}&pageSize=200`)).body.items.map((a) => a.id);
    const carousel = await ids(`materialId=${f.changesA.material.id}`);
    assert.deepEqual(new Set(carousel), new Set([x.kit, x.carousel]));
    const logo = await ids(`materialId=${f.pendingA.material.id}`);
    assert.ok(logo.includes(x.kit) && !logo.includes(x.carousel) && !logo.includes(x.kids));
    const project = await ids(`projectId=${f.projectA.id}`);
    assert.ok(project.includes(x.kit) && project.includes(x.carousel) && !project.includes(x.kids));
  });

  test("scope: designer sees ZIPs of their project, manager their clients, clients never", async () => {
    const designer = (await agents.designer.get("/api/activity?pageSize=200")).body.items.map((a) => a.id);
    assert.ok(designer.includes(x.kit) && designer.includes(x.carousel));
    assert.ok(!designer.includes(x.kids));
    const manager = (await agents.managerA.get("/api/activity?entityType=download&pageSize=200")).body.items;
    assert.equal(manager.length, 6); // 3 fixture downloads on client A + 3 ZIPs
    assert.ok(manager.every((a) => a.client.id === f.clientA));
    const portal = (await agents.clientA.get("/api/portal/activity?pageSize=100")).body.items;
    assert.ok(!portal.some((a) => a.entityType === "download" || String(a.action).startsWith("download.")));
    const overview = (await agents.clientA.get("/api/portal/overview")).body;
    assert.ok(!overview.recentActivity.some((a) => a.entityType === "download"));
  });

  test("facets offer downloads as their own type", async () => {
    const facets = (await agents.admin.get("/api/activity/facets")).body;
    assert.equal(facets.actions.find((a) => a.action === "download.zip").count, 4);
    assert.equal(facets.actions.find((a) => a.action === "download.file").count, 3);
    assert.equal(facets.entityTypes.find((t) => t.entityType === "download").count, 7);
    assert.ok(facets.actors.some((a) => a.id === u.clientB.id));
    const manager = (await agents.managerA.get("/api/activity/facets")).body;
    assert.ok(!manager.actors.some((a) => a.id === u.clientB.id));
  });
});

describe("Entregas próximas: posts by planned date, finished deliverables leave", () => {
  const x = {};
  before(async () => {
    const c = createClientWithBrand(ctx, { name: "Cliente Cometa", brandName: "Cometa" });
    x.client = c.clientId;
    u.managerC = await createUser(ctx, { role: "manager", name: "Cora Gestora" });
    addStaffAccess(ctx, u.managerC.id, c.clientId);
    agents.managerC = await login(server, { email: u.managerC.email });
    const post = async (title, plannedDate, { visibility = "draft", approval, publication, due } = {}) => {
      const item = await insertMaterial(ctx, { brandId: c.brandId, kind: "post", title, plannedDate, visibility, createdBy: u.managerC.id });
      if (approval) setMaterial(item.material.id, { approval_status: approval, requires_approval: approval === "none" ? 0 : 1 });
      if (due) setMaterial(item.material.id, { due_date: due });
      if (publication) run("UPDATE post_details SET publication_status = ?, planned_time = '14:30' WHERE material_id = ?", [publication, item.material.id]);
      return item.material.id;
    };
    const asset = async (title, due, { visibility = "released", approval } = {}) => {
      const item = await insertMaterial(ctx, { brandId: c.brandId, title, visibility, createdBy: u.managerC.id });
      setMaterial(item.material.id, { due_date: due, ...(approval ? { approval_status: approval, requires_approval: approval === "none" ? 0 : 1 } : {}) });
      return item.material.id;
    };
    x.draftPost = await post("Post em produção", inDays(3));
    x.scheduled = await post("Post aprovado e agendado", inDays(4), { visibility: "released", approval: "approved", publication: "scheduled" });
    x.unscheduled = await post("Post aprovado sem agendar", inDays(6), { visibility: "released", approval: "approved", publication: "not_scheduled" });
    x.published = await post("Post publicado", inDays(-1), { visibility: "released", approval: "approved", publication: "published" });
    x.latePost = await post("Post aguardando cliente", inDays(-3), { visibility: "released" });
    x.dueFirst = await post("Post com prazo de arte", inDays(9), { due: inDays(2) });
    x.approvedAsset = await asset("Logo aprovada", inDays(-10), { approval: "approved" });
    x.noApprovalAsset = await asset("Manual entregue", inDays(-5), { approval: "none" });
    x.pendingAsset = await asset("Papelaria com o cliente", inDays(-4));
  });
  after(() => {
    run("DELETE FROM materials WHERE brand_id IN (SELECT id FROM brands WHERE client_id = ?)", [x.client]);
  });

  test("posts count by deadline or planned publication date until approved or published", async () => {
    const o = (await agents.managerC.get("/api/admin/overview")).body;
    const byId = new Map(o.upcomingDeliveries.map((item) => [item.id, item]));
    const draft = byId.get(x.draftPost);
    assert.equal(draft.type, "post");
    assert.equal(draft.dueDate, inDays(3));
    assert.equal(draft.dateKind, "planned");
    assert.equal(draft.link, `/admin/conteudo/${x.draftPost}`);
    assert.equal(draft.status.publication, "not_scheduled");
    assert.deepEqual(draft.post, { plannedDate: inDays(3), plannedTime: null });
    const dueFirst = byId.get(x.dueFirst);
    assert.equal(dueFirst.dueDate, inDays(2)); // the art deadline comes before the publication
    assert.equal(dueFirst.dateKind, "due");
    const late = byId.get(x.latePost);
    assert.equal(late.overdue, true);
    assert.equal(late.status.approval, "pending");
    // approved (scheduled or not) and published posts are delivered
    assert.ok(!byId.has(x.scheduled) && !byId.has(x.unscheduled) && !byId.has(x.published));
  });

  test("approved or no-approval deliverables leave the list; those with the client stay", async () => {
    const o = (await agents.managerC.get("/api/admin/overview")).body;
    const ids = o.upcomingDeliveries.map((item) => item.id);
    assert.ok(!ids.includes(x.approvedAsset) && !ids.includes(x.noApprovalAsset));
    assert.ok(ids.includes(x.pendingAsset));
    assert.equal(o.upcomingCount, 2); // draft post, post with an art deadline
    assert.equal(o.overdueCount, 2); // post awaiting the client, stationery awaiting the client
  });
});

describe("Pagamentos em aberto include payments Mercado Pago rejected", () => {
  test("the client overview keeps a rejected order in the billing notice", async () => {
    const b = (await agents.clientB.get("/api/portal/overview")).body;
    assert.deepEqual(b.billing, { pendingOrders: 1, pendingAmountCents: 50000, nextDueDate: null, failedOrders: 1, failedAmountCents: 50000 });
    const a = (await agents.clientA.get("/api/portal/overview")).body;
    assert.equal(a.billing.pendingOrders, 1);
    assert.equal(a.billing.failedOrders, 0);
  });
});

describe("downloads report: ZIPs count for every material inside", () => {
  const x = {};
  before(() => {
    x.job = zipJob({ user: u.clientA, clientId: f.clientA, brandId: f.brandA, items: [f.pendingA, f.approvedA, f.pendingA], scope: { type: "brand_kit", brandId: f.brandA }, label: "Kit de marca · Aurora" });
    x.event = download({ user: u.clientA, clientId: f.clientA, brandId: f.brandA, kind: "zip", zipJobId: x.job, scope: JSON.stringify({ type: "brand_kit" }), at: noonIn(0) });
  });
  after(() => {
    run("DELETE FROM download_events WHERE id = ?", [x.event]);
    run("DELETE FROM zip_jobs WHERE id = ?", [x.job]);
  });

  test("byMaterial and totals.materials include ZIP contents", async () => {
    const d = (await agents.admin.get(`/api/reports/downloads?from=${inDays(-30)}&to=${inDays(0)}`)).body;
    assert.equal(d.totals.events, 4);
    assert.equal(d.totals.zips, 2);
    assert.equal(d.totals.materials, 3); // Logo principal, Logo Boreal, Manual da marca
    const logo = d.byMaterial.find((m) => m.id === f.pendingA.material.id);
    assert.equal(logo.total, 2); // file + the ZIP, counted once even with two entries
    assert.equal(logo.zips, 1);
    const manual = d.byMaterial.find((m) => m.id === f.approvedA.material.id);
    assert.equal(manual.total, 1);
    assert.equal(manual.title, "Manual da marca");
    assert.equal(manual.client.id, f.clientA);
    const item = d.items.find((i) => i.id === x.event);
    assert.equal(item.materialCount, 2);
    assert.equal(item.material, null);
    const csv = await agents.admin.request("GET", `/api/reports/downloads?from=${inDays(-30)}&to=${inDays(0)}&format=csv`, { raw: true });
    const text = Buffer.from(await csv.arrayBuffer()).toString("utf8");
    assert.match(text, /Logo principal, Manual da marca;Kit de marca · Aurora;ZIP/);
    ctx.db.run("DELETE FROM activity_log WHERE action = 'report.exported'");
  });
});

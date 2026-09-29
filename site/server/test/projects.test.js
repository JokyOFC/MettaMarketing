// Projects, members, tasks and the client's project list (slice E),
// including isolation between roles and between clients.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  addStaffAccess,
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
const a = {};
const f = {};

const notificationsOf = (userId, type) =>
  ctx.db.all("SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY created_at", [userId, type]);

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;
  const one = createClientWithBrand(ctx, { name: "Cliente A", brandName: "Marca A" });
  const two = createClientWithBrand(ctx, { name: "Cliente B", brandName: "Marca B" });
  Object.assign(f, { clientA: one.clientId, brandA: one.brandId, clientB: two.clientId, brandB: two.brandId });

  u.admin = await createUser(ctx, { role: "admin", name: "Admin" });
  u.manager = await createUser(ctx, { role: "manager", name: "Gestora" });
  u.managerNone = await createUser(ctx, { role: "manager", name: "Gestor sem acesso" });
  u.designer = await createUser(ctx, { role: "designer", name: "Designer Um" });
  u.designer2 = await createUser(ctx, { role: "designer", name: "Designer Dois" });
  u.finance = await createUser(ctx, { role: "finance", name: "Financeiro" });
  u.clientA = await createUser(ctx, { role: "client", clientId: f.clientA, name: "Pessoa A" });
  u.clientB = await createUser(ctx, { role: "client", clientId: f.clientB, name: "Pessoa B" });
  addStaffAccess(ctx, u.manager.id, f.clientA);
  f.projectB = createProject(ctx, { brandId: f.brandB, name: "Projeto B", memberIds: [u.designer2.id] }).id;
  f.service = ctx.db.get("SELECT id, name FROM services ORDER BY sort_order LIMIT 1");

  for (const [key, user] of Object.entries(u)) a[key] = await login(server, { email: user.email });
});

after(() => server?.close());

describe("projects", () => {
  test("creating a project notifies every assigned member in-app and by e-mail (criterion 2)", async () => {
    const res = await a.manager.post("/api/projects", {
      brandId: f.brandA,
      name: "Identidade visual 2026",
      description: "Nova identidade",
      serviceId: f.service.id,
      status: "in_progress",
      startDate: "2026-10-01",
      dueDate: "2026-11-15",
      includesEditables: true,
      internalNotes: "Cliente pediu prioridade",
      members: [
        { userId: u.designer.id, role: "designer" },
        { userId: u.manager.id, role: "lead" },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const project = res.body.project;
    f.projectA = project.id;
    assert.equal(project.brand.id, f.brandA);
    assert.equal(project.client.name, "Cliente A");
    assert.equal(project.service.id, f.service.id);
    assert.equal(project.includesEditables, true);
    assert.equal(project.members.length, 2);
    assert.equal(project.members[0].memberRole, "lead");
    assert.equal(project.internalNotes, undefined); // list shape has no notes
    // the answer says who was reached and how: the author is skipped and,
    // without SMTP, no e-mail is claimed (review: toasts said "e por e-mail")
    assert.equal(res.body.notified, 1);
    assert.equal(res.body.emailConfigured, false);
    assert.equal(res.body.emailRecipients, 1);

    const [notice] = notificationsOf(u.designer.id, "project.assigned");
    assert.equal(notice.title, "Novo projeto atribuído");
    assert.equal(notice.link, `/admin/projetos/${project.id}`);
    // the author is not notified about their own action
    assert.equal(notificationsOf(u.manager.id, "project.assigned").length, 0);
    await ctx.mailer.idle();
    const mail = ctx.db.get("SELECT * FROM email_outbox WHERE to_user_id = ? ORDER BY created_at DESC", [u.designer.id]);
    assert.equal(mail.subject, "Novo projeto atribuído");
    assert.match(mail.text_body, /Identidade visual 2026/);
    const logged = ctx.db.get("SELECT * FROM activity_log WHERE action = 'project.created' AND entity_id = ?", [project.id]);
    assert.equal(logged.client_id, f.clientA);
  });

  test("validation and member eligibility", async () => {
    let res = await a.admin.post("/api/projects", { brandId: f.brandA, name: "", dueDate: "2026-13-40" });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.name);
    assert.ok(res.body.error.fields.dueDate);
    res = await a.admin.post("/api/projects", { brandId: f.brandA, name: "Datas", startDate: "2026-10-10", dueDate: "2026-10-01" });
    assert.equal(res.status, 422);
    res = await a.admin.post("/api/projects", { brandId: f.brandA, name: "Sem acesso", memberIds: [u.managerNone.id] });
    assert.equal(res.status, 422);
    assert.match(res.body.error.fields.members, /não tem acesso/);
    res = await a.admin.post("/api/projects", { brandId: f.brandA, name: "Financeiro", memberIds: [u.finance.id] });
    assert.equal(res.status, 422);

    const options = await a.manager.get(`/api/projects/options?brandId=${f.brandA}`);
    assert.equal(options.status, 200);
    assert.deepEqual(options.body.brands.map((b) => b.id), [f.brandA]);
    assert.ok(options.body.services.length > 0);
    const none = options.body.staff.find((s) => s.id === u.managerNone.id);
    assert.equal(none.eligible, false);
    assert.ok(options.body.staff.find((s) => s.id === u.designer.id).eligible);
    assert.equal((await a.manager.get(`/api/projects/options?brandId=${f.brandB}`)).status, 404);
  });

  test("scope: managers need client access, finance and clients cannot manage projects", async () => {
    assert.equal((await a.managerNone.post("/api/projects", { brandId: f.brandA, name: "X" })).status, 404);
    assert.equal((await a.manager.post("/api/projects", { brandId: f.brandB, name: "X" })).status, 404);
    for (const key of ["designer", "finance", "clientA"])
      assert.equal((await a[key].post("/api/projects", { brandId: f.brandA, name: "X" })).status, 403, key);
    assert.equal((await a.finance.get("/api/projects")).status, 403);
    assert.equal((await a.finance.get(`/api/projects/${f.projectA}`)).status, 403);
    assert.equal((await a.clientA.get(`/api/projects/${f.projectA}`)).status, 403);
    assert.equal((await a.managerNone.get(`/api/projects/${f.projectA}`)).status, 404);
    assert.equal((await a.manager.get(`/api/projects/${f.projectB}`)).status, 404);
    assert.equal((await a.manager.patch(`/api/projects/${f.projectB}`, { name: "X" })).status, 404);
  });

  test("designers see only the projects they belong to", async () => {
    const list = await a.designer.get("/api/projects");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((p) => p.id), [f.projectA]);
    assert.equal(list.body.permissions.canCreate, false);
    assert.equal((await a.designer.get(`/api/projects/${f.projectB}`)).status, 404);
    assert.equal((await a.designer.patch(`/api/projects/${f.projectA}`, { name: "X" })).status, 403);
    const mine = await a.admin.get("/api/projects?mine=1");
    assert.deepEqual(mine.body.items, []);
    const all = await a.admin.get(`/api/projects?clientId=${f.clientA}`);
    assert.deepEqual(all.body.items.map((p) => p.id), [f.projectA]);
  });

  test("detail and patch: status, delivery date and activity", async () => {
    await insertMaterial(ctx, { brandId: f.brandA, projectId: f.projectA, createdBy: u.designer.id, visibility: "draft" });
    await insertMaterial(ctx, { brandId: f.brandA, projectId: f.projectA, createdBy: u.designer.id, visibility: "released" });
    let res = await a.designer.get(`/api/projects/${f.projectA}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.project.internalNotes, "Cliente pediu prioridade");
    assert.equal(res.body.project.materialCounts.total, 2);
    assert.equal(res.body.project.materialCounts.draft, 1);
    assert.equal(res.body.project.materialCounts.pending, 1);
    assert.equal(res.body.materials.total, 2);
    assert.equal(res.body.permissions.canEdit, false);
    assert.equal(res.body.permissions.canManageTasks, true);
    assert.ok(res.body.activity.some((entry) => entry.action === "project.created"));

    res = await a.manager.patch(`/api/projects/${f.projectA}`, { status: "delivered" });
    assert.equal(res.status, 200);
    assert.equal(res.body.project.status, "delivered");
    assert.ok(res.body.project.deliveredAt);
    res = await a.manager.patch(`/api/projects/${f.projectA}`, { status: "in_review", dueDate: "2026-12-01" });
    assert.equal(res.body.project.deliveredAt, null);
    assert.equal(res.body.project.dueDate, "2026-12-01");
    const moved = ctx.db.all("SELECT visibility FROM activity_log WHERE action = 'project.status_changed' AND entity_id = ?", [f.projectA]);
    assert.equal(moved.length, 2);
    assert.ok(moved.every((row) => row.visibility === "client"));
  });

  test("members replace notifies only the people who joined", async () => {
    const before = notificationsOf(u.designer.id, "project.assigned").length;
    const res = await a.manager.put(`/api/projects/${f.projectA}/members`, {
      members: [
        { userId: u.manager.id, role: "lead" },
        { userId: u.designer.id, role: "editor" },
        { userId: u.designer2.id, role: "designer" },
      ],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.added, [u.designer2.id]);
    assert.deepEqual(res.body.changed, [u.designer.id]);
    assert.equal(notificationsOf(u.designer.id, "project.assigned").length, before);
    assert.equal(notificationsOf(u.designer2.id, "project.assigned").length, 1);
    const designer2 = await login(server, { email: u.designer2.email });
    assert.equal((await designer2.get(`/api/projects/${f.projectA}`)).status, 200);
    assert.equal((await a.designer.put(`/api/projects/${f.projectA}/members`, { members: [] })).status, 403);
    assert.equal(
      (await a.manager.put(`/api/projects/${f.projectA}/members`, { members: [{ userId: u.clientA.id, role: "designer" }] })).status,
      422,
    );
  });

  test("members replace reports the in-app and e-mail reach of the notices", async () => {
    // own client, so the portal checks below keep their fixtures
    const other = createClientWithBrand(ctx, { name: "Cliente Avisos", brandName: "Marca Avisos" });
    const quiet = await createUser(ctx, { role: "designer", name: "Designer Silenciosa" });
    ctx.db.run("UPDATE users SET notify_email = 0 WHERE id = ?", [quiet.id]);
    const invited = await createUser(ctx, { role: "designer", name: "Designer Convidado", status: "invited" });
    const project = createProject(ctx, { brandId: other.brandId, name: "Alcance dos avisos" }).id;
    const configured = ctx.mailer.isConfigured;
    try {
      // without SMTP: in-app only, whatever the preferences
      let res = await a.admin.put(`/api/projects/${project}/members`, { members: [{ userId: quiet.id, role: "designer" }] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        { notified: res.body.notified, emailConfigured: res.body.emailConfigured, emailRecipients: res.body.emailRecipients },
        { notified: 1, emailConfigured: false, emailRecipients: 0 },
      );
      // with SMTP: e-mail only for active people who keep e-mail notices on;
      // the author (admin, added as lead) is never notified
      ctx.mailer.isConfigured = () => true;
      const members = [
        { userId: u.admin.id, role: "lead" },
        { userId: quiet.id, role: "designer" },
        { userId: u.designer.id, role: "designer" },
        { userId: invited.id, role: "editor" },
      ];
      res = await a.admin.put(`/api/projects/${project}/members`, { members });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual([...res.body.added].sort(), [u.admin.id, u.designer.id, invited.id].sort());
      assert.equal(res.body.notified, 2); // the designer and the invited editor (in-app)
      assert.equal(res.body.emailConfigured, true);
      assert.equal(res.body.emailRecipients, 1); // only the active designer with e-mail notices on
      // nobody new: nothing notified
      res = await a.admin.put(`/api/projects/${project}/members`, { members });
      assert.equal(res.body.notified, 0);
      assert.equal(res.body.emailRecipients, 0);
    } finally {
      ctx.mailer.isConfigured = configured;
    }
  });
});

describe("tasks", () => {
  test("create with assignee, move across columns, reorder and delete", async () => {
    let res = await a.designer.post(`/api/projects/${f.projectA}/tasks`, {
      title: "Explorar símbolos",
      description: "Três caminhos",
      assigneeId: u.designer2.id,
      dueDate: "2026-10-20",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const first = res.body.task;
    assert.equal(first.status, "todo");
    assert.equal(first.assignee.id, u.designer2.id);
    const [notice] = notificationsOf(u.designer2.id, "task.assigned");
    assert.equal(notice.title, "Nova tarefa atribuída");
    assert.equal(notice.link, `/admin/projetos/${f.projectA}?tarefa=${first.id}`);

    res = await a.manager.post(`/api/projects/${f.projectA}/tasks`, { title: "Manual da marca" });
    const second = res.body.task;
    res = await a.manager.post(`/api/projects/${f.projectA}/tasks`, { title: "Paleta", sortOrder: 0 });
    const third = res.body.task;
    const todo = res.body.tasks.filter((t) => t.status === "todo").map((t) => t.id);
    assert.deepEqual(todo, [third.id, first.id, second.id]);

    // assignee must belong to the project
    const outsider = await createUser(ctx, { role: "designer", name: "De fora" });
    res = await a.manager.post(`/api/projects/${f.projectA}/tasks`, { title: "X", assigneeId: outsider.id });
    assert.equal(res.status, 422);
    assert.match(res.body.error.fields.assigneeId, /não faz parte/);

    // move to review: leads are told, done sets completedAt
    res = await a.designer2.patch(`/api/tasks/${first.id}`, { status: "review", sortOrder: 0 });
    assert.equal(res.status, 200);
    assert.equal(res.body.task.status, "review");
    assert.ok(notificationsOf(u.manager.id, "task.review").length >= 1);
    res = await a.designer2.patch(`/api/tasks/${first.id}`, { status: "done" });
    assert.ok(res.body.task.completedAt);
    res = await a.designer2.patch(`/api/tasks/${first.id}`, { status: "doing" });
    assert.equal(res.body.task.completedAt, null);

    // reorder inside a column
    res = await a.manager.patch(`/api/tasks/${second.id}`, { sortOrder: 0 });
    assert.deepEqual(res.body.tasks.filter((t) => t.status === "todo").map((t) => t.id), [second.id, third.id]);

    // reassigning notifies the new person
    res = await a.manager.patch(`/api/tasks/${third.id}`, { assigneeId: u.designer.id, title: "Paleta de cores" });
    assert.equal(res.body.task.assignee.id, u.designer.id);
    assert.ok(notificationsOf(u.designer.id, "task.assigned").some((n) => n.body.startsWith("Paleta de cores")));

    // designers delete only what they created; managers anything
    assert.equal((await a.designer.del(`/api/tasks/${second.id}`)).status, 403);
    assert.equal((await a.designer.del(`/api/tasks/${first.id}`)).status, 204);
    assert.equal((await a.manager.del(`/api/tasks/${second.id}`)).status, 204);

    const list = await a.designer.get(`/api/projects/${f.projectA}/tasks`);
    assert.deepEqual(list.body.items.map((t) => t.id), [third.id]);
  });

  test("tasks outside the scope are unreachable", async () => {
    const res = await a.designer2.post(`/api/projects/${f.projectB}/tasks`, { title: "Tarefa B" });
    assert.equal(res.status, 201);
    const taskB = res.body.task.id;
    assert.equal((await a.designer.patch(`/api/tasks/${taskB}`, { status: "done" })).status, 404);
    assert.equal((await a.designer.del(`/api/tasks/${taskB}`)).status, 404);
    assert.equal((await a.manager.get(`/api/projects/${f.projectB}/tasks`)).status, 404);
    assert.equal((await a.designer.post(`/api/projects/${f.projectB}/tasks`, { title: "X" })).status, 404);
    assert.equal((await a.finance.post(`/api/projects/${f.projectA}/tasks`, { title: "X" })).status, 403);
    assert.equal((await a.clientA.patch(`/api/tasks/${taskB}`, { title: "X" })).status, 403);
  });

  test("my tasks lists open tasks assigned to me", async () => {
    const res = await a.designer.get("/api/me/tasks");
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 1);
    assert.ok(res.body.items.every((t) => t.assignee.id === u.designer.id && t.status !== "done"));
    assert.equal(res.body.items[0].project.id, f.projectA);
    assert.equal((await a.finance.get("/api/me/tasks")).status, 403);
  });
});

describe("portal projects", () => {
  test("clients see their own projects with released deliveries only", async () => {
    await insertMaterial(ctx, {
      brandId: f.brandB,
      projectId: f.projectB,
      createdBy: u.designer2.id,
      visibility: "released",
      requiresApproval: false,
    });
    ctx.db.run("UPDATE projects SET internal_notes = 'nota interna' WHERE id = ?", [f.projectA]);
    const at = new Date().toISOString();
    ctx.db.run(
      "INSERT INTO kits (id, brand_id, project_id, name, kind, status, released_at, created_at, updated_at) VALUES ('kit_AAAAAAAAAAAAAAAA', ?, ?, 'Pacote final', 'project_package', 'released', ?, ?, ?)",
      [f.brandA, f.projectA, at, at, at],
    );
    const released = ctx.db.get("SELECT id FROM materials WHERE project_id = ? AND visibility = 'released'", [f.projectA]);
    ctx.db.run("INSERT INTO kit_items (kit_id, material_id, sort_order) VALUES ('kit_AAAAAAAAAAAAAAAA', ?, 0)", [released.id]);

    let res = await a.clientA.get("/api/portal/projects");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((p) => p.id), [f.projectA]);
    const project = res.body.items[0];
    // one draft and one released material: only the released one counts
    assert.equal(project.materialCount, 1);
    assert.equal(project.pendingCount, 1);
    assert.equal(project.hasDownloads, true);
    assert.deepEqual(project.kits.map((k) => k.name), ["Pacote final"]);
    assert.equal(project.internalNotes, undefined);
    assert.equal(project.members, undefined);
    assert.equal(project.taskCounts, undefined);

    res = await a.clientB.get("/api/portal/projects");
    assert.deepEqual(res.body.items.map((p) => p.id), [f.projectB]);
    assert.equal(res.body.items[0].finalizedCount, 1);
    assert.equal((await a.clientA.get(`/api/portal/projects?brandId=${f.brandB}`)).status, 404);
    assert.equal((await a.admin.get("/api/portal/projects")).status, 403);
  });
});

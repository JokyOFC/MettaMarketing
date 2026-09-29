// Comments, change requests and approvals: the client decides on the released
// version only, every decision is logged, and internal notes never reach clients.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";
import {
  addStaffAccess,
  createClientWithBrand,
  createProject,
  createUser,
  insertMaterial,
  login,
  png,
  startTestServer,
} from "./helpers.js";

let server;
let ctx;
const u = {};
const f = {};
const as = {};

const INTERNAL = "Nota interna: margem do slide 2 está apertada";

// Simulates what slice A's release does for a new version: v(n+1) released,
// the previous released version superseded, approval back to pending.
async function releaseNewVersion(materialId, number) {
  const db = ctx.db;
  const material = await db.get("SELECT * FROM materials WHERE id = ?", [materialId]);
  const id = newId("ver");
  const at = now();
  await db.run(
    `INSERT INTO material_versions (id, material_id, number, status, change_summary, created_by, created_at, released_at, released_by)
     VALUES (?, ?, ?, 'released', 'Ajustes do cliente', ?, ?, ?, ?)`,
    [id, materialId, number, u.designer.id, at, at, u.manager.id],
  );
  await db.run("UPDATE material_versions SET status = 'superseded' WHERE id = ?", [material.released_version_id]);
  await db.run(
    `UPDATE materials SET current_version_id = ?, released_version_id = ?, approval_status = 'pending', updated_at = ? WHERE id = ?`,
    [id, id, at, materialId],
  );
  return id;
}

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;
  const a = await createClientWithBrand(ctx, { name: "Cliente A", brandName: "Marca A" });
  const b = await createClientWithBrand(ctx, { name: "Cliente B", brandName: "Marca B" });
  Object.assign(f, { clientA: a.clientId, brandA: a.brandId, brandB: b.brandId });
  u.admin = await createUser(ctx, { role: "admin", name: "Admin" });
  u.manager = await createUser(ctx, { role: "manager", name: "Gestora A" });
  u.managerB = await createUser(ctx, { role: "manager", name: "Gestor B" });
  u.designer = await createUser(ctx, { role: "designer", name: "Designer A" });
  u.finance = await createUser(ctx, { role: "finance" });
  u.clientA = await createUser(ctx, { role: "client", clientId: a.clientId, name: "Ana Cliente" });
  u.clientA2 = await createUser(ctx, { role: "client", clientId: a.clientId, name: "Beto Cliente" });
  u.clientB = await createUser(ctx, { role: "client", clientId: b.clientId, name: "Bia Cliente" });
  await addStaffAccess(ctx, u.manager.id, a.clientId);
  await addStaffAccess(ctx, u.managerB.id, b.clientId);
  f.project = (await createProject(ctx, { brandId: a.brandId, memberIds: [u.designer.id] })).id;

  const slide = await png();
  const post = await insertMaterial(ctx, {
    brandId: a.brandId,
    projectId: f.project,
    kind: "post",
    categorySlug: "posts-carrosseis",
    title: "Carrossel de lançamento",
    createdBy: u.designer.id,
    ownerId: u.designer.id,
    visibility: "released",
    plannedDate: "2026-10-12",
    files: [
      { role: "original", filename: "01.png", buffer: slide },
      { role: "original", filename: "02.png", buffer: slide },
    ],
  });
  f.post = post.material.id;
  f.v1 = post.version.id;

  const draft = await insertMaterial(ctx, {
    brandId: a.brandId,
    projectId: f.project,
    kind: "post",
    categorySlug: "posts-carrosseis",
    title: "Rascunho",
    createdBy: u.designer.id,
  });
  f.draft = draft.material.id;

  const logo = await insertMaterial(ctx, {
    brandId: a.brandId,
    title: "Logo final",
    createdBy: u.admin.id,
    visibility: "released",
    requiresApproval: false,
  });
  f.logo = logo.material.id;
  f.logoVersion = logo.version.id;

  for (const key of Object.keys(u)) as[key] = await login(server, { email: u[key].email });
});

after(() => server?.close());

describe("comments", () => {
  test("clients always write client-visible comments, whatever they send", async () => {
    const res = await as.clientA.post(`/api/materials/${f.post}/comments`, {
      body: "Gostei muito do slide 1",
      visibility: "internal",
      slidePosition: 1,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.comment.visibility, undefined);
    assert.equal(res.body.comment.versionId, f.v1);
    assert.equal(res.body.comment.versionNumber, 1);
    assert.equal(res.body.comment.author.isClient, true);
    assert.equal(res.body.comment.mine, true);
    f.clientComment = res.body.comment.id;
    const row = await ctx.db.get("SELECT visibility FROM comments WHERE id = ?", [f.clientComment]);
    assert.equal(row.visibility, "client");
    // the team is notified
    assert.ok(await ctx.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'comment.client'", [u.designer.id]));
    assert.ok(await ctx.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'comment.client'", [u.manager.id]));
  });

  test("internal notes never reach clients, not even as counts", async () => {
    const note = await as.designer.post(`/api/materials/${f.post}/comments`, { body: INTERNAL, visibility: "internal" });
    assert.equal(note.status, 201);
    assert.equal(note.body.comment.visibility, "internal");
    f.internal = note.body.comment.id;

    const reply = await as.manager.post(`/api/materials/${f.post}/comments`, {
      body: "Obrigada! Ajustamos o que precisar.",
      parentId: f.clientComment,
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.comment.visibility, "client");
    assert.ok(await ctx.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'comment.team'", [u.clientA.id]));

    const badParent = await as.manager.post(`/api/materials/${f.post}/comments`, { body: "x", parentId: f.internal });
    assert.equal(badParent.status, 422);

    const staff = await as.manager.get(`/api/materials/${f.post}/comments`);
    assert.equal(staff.body.items.length, 3);
    assert.deepEqual(staff.body.counts, { client: 2, internal: 1 });
    const onlyInternal = await as.manager.get(`/api/materials/${f.post}/comments?visibility=internal`);
    assert.deepEqual(onlyInternal.body.items.map((c) => c.id), [f.internal]);
    assert.deepEqual(onlyInternal.body.counts, { client: 2, internal: 1 });

    const client = await as.clientA.get(`/api/materials/${f.post}/comments?visibility=internal`);
    assert.equal(client.status, 200);
    assert.equal(client.body.items.length, 2);
    assert.equal(client.body.counts, undefined);
    const text = JSON.stringify(client.body);
    assert.equal(text.includes(INTERNAL), false);
    assert.equal(text.includes('"internal"'), false);
    assert.equal(text.includes(f.internal), false);
    // Team authors appear by name only.
    const team = client.body.items.find((c) => !c.author.isClient);
    assert.deepEqual(team.author, { name: "Gestora A", isClient: false });

    assert.equal((await as.clientA.patch(`/api/comments/${f.internal}`, { body: "x" })).status, 404);
  });

  test("client-visible comments on unreleased versions stay hidden from clients", async () => {
    const draftVersion = newId("ver");
    await ctx.db.run(
      "INSERT INTO material_versions (id, material_id, number, status, created_by, created_at) VALUES (?, ?, 9, 'draft', ?, ?)",
      [draftVersion, f.post, u.designer.id, now()],
    );
    const res = await as.designer.post(`/api/materials/${f.post}/comments`, { body: "Prévia da v9", versionId: draftVersion });
    assert.equal(res.status, 201);
    const client = await as.clientA.get(`/api/materials/${f.post}/comments`);
    assert.equal(client.body.items.some((c) => c.id === res.body.comment.id), false);
    assert.equal((await as.clientA.post(`/api/materials/${f.post}/comments`, { body: "x", versionId: draftVersion })).status, 422);
    await ctx.db.run("DELETE FROM comments WHERE id = ?", [res.body.comment.id]);
    await ctx.db.run("DELETE FROM material_versions WHERE id = ?", [draftVersion]);
  });

  test("team messages follow the released version; talk about an unreleased version never reaches the client", async () => {
    const logo = await insertMaterial(ctx, {
      brandId: f.brandA,
      projectId: f.project,
      title: "Logo Norte",
      createdBy: u.designer.id,
      visibility: "released",
      requiresApproval: false, // stays out of the approval queues below
    });
    const materialId = logo.material.id;
    const v1 = logo.version.id;
    // v2 in preparation: current version, never released
    const v2 = newId("ver");
    await ctx.db.run(
      "INSERT INTO material_versions (id, material_id, number, status, created_by, created_at) VALUES (?, ?, 2, 'draft', ?, ?)",
      [v2, materialId, u.designer.id, now()],
    );
    await ctx.db.run("UPDATE materials SET current_version_id = ? WHERE id = ?", [v2, materialId]);
    const clientNotes = async () =>
      await ctx.db.all("SELECT * FROM notifications WHERE user_id = ? AND entity_id = ? ORDER BY created_at, seq", [u.clientA.id, materialId]);
    const emailsWith = async (text) =>
      (await ctx.db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE to_email = ? AND text_body LIKE ?", [u.clientA.email.toLowerCase(), `%${text}%`])).n;

    // No versionId: a client-visible message goes to v1, the version the client sees.
    const visible = await as.manager.post(`/api/materials/${materialId}/comments`, { body: "Mensagem sobre a versão 1" });
    assert.equal(visible.status, 201, JSON.stringify(visible.body));
    assert.equal(visible.body.comment.versionId, v1);
    assert.equal(visible.body.comment.versionNumber, 1);
    const seen = await as.clientA.get(`/api/materials/${materialId}/comments`);
    assert.ok(seen.body.items.some((c) => c.id === visible.body.comment.id));
    const [note] = await clientNotes();
    assert.equal(note.type, "comment.team");
    // files open their drawer in Arquivos on the conversation
    assert.equal(note.link, `/painel/arquivos?material=${materialId}#comentarios`);
    const logged = await ctx.db.get("SELECT visibility FROM activity_log WHERE entity_id = ?", [visible.body.comment.id]);
    assert.equal(logged.visibility, "client");
    await ctx.mailer.idle?.();
    assert.equal(await emailsWith("Mensagem sobre a versão 1"), 1);

    // Explicitly about the draft v2: stored, but the client neither sees it
    // nor is notified or e-mailed, and the history entry stays internal.
    const hidden = await as.manager.post(`/api/materials/${materialId}/comments`, {
      body: "Rascunho da versão 2 com ajustes",
      versionId: v2,
    });
    assert.equal(hidden.status, 201, JSON.stringify(hidden.body));
    assert.equal(hidden.body.comment.versionId, v2);
    assert.equal(hidden.body.comment.visibility, "client");
    const after = await as.clientA.get(`/api/materials/${materialId}/comments`);
    assert.equal(after.body.items.some((c) => c.id === hidden.body.comment.id), false);
    assert.equal(JSON.stringify(after.body).includes("Rascunho da versão 2"), false);
    assert.equal((await clientNotes()).length, 1);
    await ctx.mailer.idle?.();
    assert.equal(await emailsWith("Rascunho da versão 2"), 0);
    const internalLog = await ctx.db.get("SELECT visibility FROM activity_log WHERE entity_id = ?", [hidden.body.comment.id]);
    assert.equal(internalLog.visibility, "internal");
    const portal = await as.clientA.get("/api/portal/activity");
    if (portal.status === 200) assert.equal(JSON.stringify(portal.body).includes(hidden.body.comment.id), false);

    // Internal notes keep following the version in preparation.
    const internal = await as.designer.post(`/api/materials/${materialId}/comments`, { body: "Conferir kerning", visibility: "internal" });
    assert.equal(internal.body.comment.versionId, v2);

    // Once v2 is released to the client, the earlier message becomes visible.
    await ctx.db.run("UPDATE material_versions SET status = 'released', released_at = ? WHERE id = ?", [now(), v2]);
    await ctx.db.run("UPDATE materials SET released_version_id = ? WHERE id = ?", [v2, materialId]);
    const released = await as.clientA.get(`/api/materials/${materialId}/comments`);
    assert.ok(released.body.items.some((c) => c.id === hidden.body.comment.id));
    assert.equal(released.body.items.some((c) => c.id === internal.body.comment.id), false);
  });

  test("isolation: other client, finance, other manager, drafts", async () => {
    assert.equal((await as.clientB.get(`/api/materials/${f.post}/comments`)).status, 404);
    assert.equal((await as.clientB.post(`/api/materials/${f.post}/comments`, { body: "invasão" })).status, 404);
    assert.equal((await as.clientB.patch(`/api/comments/${f.clientComment}`, { body: "x" })).status, 404);
    assert.equal((await as.managerB.get(`/api/materials/${f.post}/comments`)).status, 404);
    assert.equal((await as.finance.get(`/api/materials/${f.post}/comments`)).status, 403);
    assert.equal((await as.clientA.get(`/api/materials/${f.draft}/comments`)).status, 404);
    assert.equal((await as.clientA.post(`/api/materials/${f.draft}/comments`, { body: "x" })).status, 404);
  });

  test("editing and resolving", async () => {
    const empty = await as.clientA.post(`/api/materials/${f.post}/comments`, { body: "   " });
    assert.equal(empty.status, 422);
    assert.equal(empty.body.error.fields.body, "Escreva o comentário.");

    const edited = await as.clientA.patch(`/api/comments/${f.clientComment}`, { body: "Gostei muito do slide 1!" });
    assert.equal(edited.status, 200);
    assert.ok(edited.body.comment.editedAt);
    assert.equal((await as.clientA2.patch(`/api/comments/${f.clientComment}`, { body: "outro" })).status, 403);
    assert.equal((await as.clientA.patch(`/api/comments/${f.clientComment}`, { resolved: true })).status, 403);
    const resolved = await as.manager.patch(`/api/comments/${f.clientComment}`, { resolved: true });
    assert.equal(resolved.status, 200);
    assert.ok(resolved.body.comment.resolvedAt);
    assert.equal(resolved.body.comment.resolvedBy.id, u.manager.id);
  });
});

describe("decisions", () => {
  test("only the client can decide, and only on the released version", async () => {
    assert.equal((await as.designer.post(`/api/materials/${f.post}/approve`, { versionId: f.v1 })).status, 403);
    assert.equal((await as.admin.post(`/api/materials/${f.post}/approve`, { versionId: f.v1 })).status, 403);
    assert.equal((await as.designer.post(`/api/materials/${f.post}/request-changes`, { versionId: f.v1, body: "x" })).status, 403);
    assert.equal((await as.clientB.post(`/api/materials/${f.post}/approve`, { versionId: f.v1 })).status, 404);
    assert.equal((await as.clientB.post(`/api/materials/${f.post}/request-changes`, { versionId: f.v1, body: "x" })).status, 404);
    assert.equal((await as.clientA.post(`/api/materials/${f.draft}/approve`, { versionId: f.v1 })).status, 404);
    assert.equal((await as.clientA.post(`/api/materials/${f.post}/approve`, { versionId: "ver_notthisversion00" })).status, 409);
    assert.equal((await as.clientA.post(`/api/materials/${f.logo}/approve`, { versionId: f.logoVersion })).status, 409);
    const missing = await as.clientA.post(`/api/materials/${f.post}/approve`, {});
    assert.equal(missing.status, 422);
  });

  test("request changes: comment, decision, task and notifications", async () => {
    const empty = await as.clientA.post(`/api/materials/${f.post}/request-changes`, { versionId: f.v1, body: "" });
    assert.equal(empty.status, 422);
    assert.equal(empty.body.error.fields.body, "Descreva os ajustes que você precisa.");

    const res = await as.clientA.request("POST", `/api/materials/${f.post}/request-changes`, {
      body: { versionId: f.v1, body: "Trocar a foto do slide 2 por uma mais clara.", slidePosition: 2 },
      headers: { "user-agent": "TesteNavegador/1.0" },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.material.approvalStatus, "changes_requested");
    assert.equal(res.body.comment.kind, "change_request");
    assert.equal(res.body.comment.slidePosition, 2);
    assert.equal(res.body.approval.decision, "changes_requested");
    assert.equal(res.body.approval.ip, undefined);

    const version = await ctx.db.get("SELECT * FROM material_versions WHERE id = ?", [f.v1]);
    assert.equal(version.status, "changes_requested");
    assert.equal(version.decided_by, u.clientA.id);
    const decision = await ctx.db.get("SELECT * FROM approvals WHERE material_id = ?", [f.post]);
    assert.equal(decision.decision, "changes_requested");
    assert.equal(decision.user_id, u.clientA.id);
    assert.equal(decision.user_agent, "TesteNavegador/1.0");
    assert.ok(decision.ip);
    assert.equal(decision.comment_id, res.body.comment.id);

    const task = await ctx.db.get("SELECT * FROM tasks WHERE material_id = ?", [f.post]);
    assert.equal(task.project_id, f.project);
    assert.equal(task.assignee_id, u.designer.id);
    assert.equal(task.status, "todo");
    assert.match(task.description, /slide 2/);

    for (const id of [u.designer.id, u.manager.id])
      assert.ok(await ctx.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'approval.changes_requested'", [id]));
    assert.equal(
      await ctx.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'approval.changes_requested'", [u.managerB.id]),
      undefined,
    );
    const activity = await ctx.db.get("SELECT * FROM activity_log WHERE material_id = ? AND action = 'material.changes_requested'", [f.post]);
    assert.equal(activity.visibility, "client");

    const again = await as.clientA.post(`/api/materials/${f.post}/request-changes`, { versionId: f.v1, body: "Mais uma coisa" });
    assert.equal(again.status, 409);
  });

  test("a new released version needs a new decision; the old version is refused", async () => {
    f.v2 = await releaseNewVersion(f.post, 2);
    const old = await as.clientA.post(`/api/materials/${f.post}/approve`, { versionId: f.v1 });
    assert.equal(old.status, 409);
    const oldChanges = await as.clientA.post(`/api/materials/${f.post}/request-changes`, { versionId: f.v1, body: "x" });
    assert.equal(oldChanges.status, 409);

    const res = await as.clientA.post(`/api/materials/${f.post}/approve`, { versionId: f.v2, note: "Perfeito, pode seguir." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.material.approvalStatus, "approved");
    assert.equal(res.body.material.approvedVersionId, f.v2);
    assert.equal(res.body.approval.versionNumber, 2);
    assert.equal(res.body.approval.user.name, "Ana Cliente");

    const version = await ctx.db.get("SELECT * FROM material_versions WHERE id = ?", [f.v2]);
    assert.equal(version.status, "approved");
    assert.equal(version.decided_by, u.clientA.id);
    assert.ok(version.decided_at);
    // the earlier decision stays in the log
    assert.equal((await ctx.db.get("SELECT COUNT(*) AS n FROM approvals WHERE material_id = ?", [f.post])).n, 2);
    const noteRow = await ctx.db.get("SELECT * FROM comments WHERE material_id = ? AND kind = 'approval_note'", [f.post]);
    assert.equal(noteRow.visibility, "client");
    const activity = await ctx.db.get("SELECT * FROM activity_log WHERE material_id = ? AND action = 'material.approved'", [f.post]);
    assert.equal(activity.visibility, "client");
    assert.match(activity.summary, /aprovou a versão 2/);
    assert.ok(await ctx.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'approval.approved'", [u.designer.id]));

    assert.equal((await as.clientA2.post(`/api/materials/${f.post}/approve`, { versionId: f.v2 })).status, 409);
  });

  test("approve is also allowed after changes were requested on the same version", async () => {
    const other = await insertMaterial(ctx, {
      brandId: f.brandA,
      kind: "post",
      categorySlug: "stories",
      title: "Story",
      createdBy: u.designer.id,
      visibility: "released",
    });
    const changes = await as.clientA.post(`/api/materials/${other.material.id}/request-changes`, {
      versionId: other.version.id,
      body: "Aumentar o logo",
    });
    assert.equal(changes.status, 200);
    // no project: no task
    assert.equal(await ctx.db.get("SELECT 1 FROM tasks WHERE material_id = ?", [other.material.id]), undefined);
    const approve = await as.clientA.post(`/api/materials/${other.material.id}/approve`, { versionId: other.version.id });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.material.approvalStatus, "approved");
    f.story = other.material.id;
  });

  test("decision history: clients see who and when, staff also see IP and browser", async () => {
    const client = await as.clientA.get(`/api/materials/${f.post}/approvals`);
    assert.equal(client.status, 200);
    assert.deepEqual(client.body.items.map((item) => [item.versionNumber, item.decision]), [
      [2, "approved"],
      [1, "changes_requested"],
    ]);
    assert.equal(client.body.items[0].comment, "Perfeito, pode seguir.");
    assert.equal(client.body.items[1].slidePosition, 2);
    assert.equal(client.body.items[0].ip, undefined);
    assert.deepEqual(client.body.releases.map((r) => r.versionNumber), [2, 1]);
    assert.equal(client.body.releases[0].releasedBy, null);

    const staff = await as.manager.get(`/api/materials/${f.post}/approvals`);
    assert.ok(staff.body.items[0].ip);
    assert.equal(staff.body.items[1].userAgent, "TesteNavegador/1.0");
    assert.equal(staff.body.releases[0].releasedBy.id, u.manager.id);

    assert.equal((await as.clientB.get(`/api/materials/${f.post}/approvals`)).status, 404);
    assert.equal((await as.managerB.get(`/api/materials/${f.post}/approvals`)).status, 404);
    assert.equal((await as.finance.get(`/api/materials/${f.post}/approvals`)).status, 403);
  });
});

describe("approval queue", () => {
  test("staff queue by status with last decision and change request", async () => {
    assert.equal((await as.designer.get("/api/approvals")).status, 403);
    assert.equal((await as.finance.get("/api/approvals")).status, 403);

    const approved = await as.manager.get("/api/approvals?status=approved");
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.body.items.map((item) => item.id).sort(), [f.post, f.story].sort());
    const post = approved.body.items.find((item) => item.id === f.post);
    assert.equal(post.lastDecision.decision, "approved");
    assert.equal(post.reviewVersion.number, 2);
    assert.equal(post.lastChangeRequest.slidePosition, 2);
    assert.ok(post.since);

    assert.equal((await as.managerB.get("/api/approvals?status=approved")).body.total, 0);

    await releaseNewVersion(f.post, 3);
    const pending = await as.manager.get("/api/approvals");
    assert.deepEqual(pending.body.items.map((item) => item.id), [f.post]);
    assert.equal(pending.body.items[0].reviewVersion.number, 3);
    const changes = await as.admin.get("/api/approvals?status=changes_requested");
    assert.equal(changes.body.total, 0);
  });

  test("clients get their own pending items only", async () => {
    const mine = await as.clientA.get("/api/approvals");
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.items.map((item) => item.id), [f.post]);
    assert.equal(mine.body.total, 1);
    assert.equal("internalNotes" in mine.body.items[0], false);
    assert.equal(mine.body.items[0].lastDecision.ip, undefined);
    const other = await as.clientB.get("/api/approvals");
    assert.equal(other.body.total, 0);
    const byOtherBrand = await as.clientA.get(`/api/approvals?brandId=${f.brandB}`);
    assert.equal(byOtherBrand.body.total, 0);
  });
});

// Content hub: posts, publication (always manual), campaigns and isolation.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { now } from "../lib/time.js";
import {
  addStaffAccess,
  categoryId,
  createClientWithBrand,
  createProject,
  createUpload,
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

// Simulates a release (slice A owns /api/releases): version and material go live.
function release(materialId) {
  const db = ctx.db;
  const material = db.get("SELECT * FROM materials WHERE id = ?", [materialId]);
  const at = now();
  db.run("UPDATE material_versions SET status = 'released', released_at = ?, released_by = ? WHERE id = ?", [
    at,
    u.manager.id,
    material.current_version_id,
  ]);
  db.run(
    `UPDATE materials SET visibility = 'released', released_version_id = current_version_id, released_at = ?,
       approval_status = CASE WHEN requires_approval = 1 THEN 'pending' ELSE 'none' END WHERE id = ?`,
    [at, materialId],
  );
}

async function uploads(user, count) {
  const list = [];
  for (let i = 0; i < count; i += 1)
    list.push(await createUpload(ctx, user.id, { buffer: await png({ width: 108, height: 135 }), filename: `slide-${i + 1}.png` }));
  return list;
}

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;
  const a = createClientWithBrand(ctx, { name: "Cliente A", brandName: "Marca A" });
  const b = createClientWithBrand(ctx, { name: "Cliente B", brandName: "Marca B" });
  Object.assign(f, { clientA: a.clientId, brandA: a.brandId, clientB: b.clientId, brandB: b.brandId });

  u.admin = await createUser(ctx, { role: "admin", name: "Admin" });
  u.manager = await createUser(ctx, { role: "manager", name: "Gestora A" });
  u.managerB = await createUser(ctx, { role: "manager", name: "Gestor B" });
  u.designer = await createUser(ctx, { role: "designer", name: "Designer A" });
  u.designerIdle = await createUser(ctx, { role: "designer", name: "Designer sem projeto" });
  u.finance = await createUser(ctx, { role: "finance" });
  u.clientA = await createUser(ctx, { role: "client", clientId: a.clientId, name: "Cliente Ana" });
  u.clientB = await createUser(ctx, { role: "client", clientId: b.clientId, name: "Cliente Bia" });
  addStaffAccess(ctx, u.manager.id, a.clientId);
  addStaffAccess(ctx, u.managerB.id, b.clientId);
  f.project = createProject(ctx, { brandId: a.brandId, name: "Conteúdo mensal", memberIds: [u.designer.id] }).id;

  for (const key of Object.keys(u)) as[key] = await login(server, { email: u[key].email });
});

after(() => server?.close());

describe("posts", () => {
  test("designer creates a carousel draft in their project with ordered slides", async () => {
    const [one, two] = await uploads(u.designer, 2);
    const res = await as.designer.post("/api/content", {
      brandId: f.brandA,
      projectId: f.project,
      title: "Lançamento outubro",
      network: "instagram",
      format: "carrossel",
      plannedDate: "2026-10-12",
      plannedTime: "18:30",
      caption: "Legenda do carrossel",
      hashtags: "#metta #fintech",
      notes: "Observação para o cliente",
      internalNotes: "Nota interna da equipe",
      files: [
        { uploadId: two.id, position: 2 },
        { uploadId: one.id, position: 1 },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const material = res.body.material;
    assert.equal(material.kind, "post");
    assert.equal(material.visibility, "draft");
    assert.equal(material.category.slug, "posts-carrosseis");
    assert.equal(material.post.network, "instagram");
    assert.equal(material.post.format, "carrossel");
    assert.equal(material.post.plannedDate, "2026-10-12");
    assert.equal(material.post.plannedTime, "18:30");
    assert.equal(material.post.publicationStatus, "not_scheduled");
    assert.equal(material.internalNotes, "Nota interna da equipe");
    assert.equal(material.slides, 2);
    const [version] = material.versions;
    assert.equal(version.number, 1);
    assert.equal(version.caption, "Legenda do carrossel");
    assert.deepEqual(
      version.files.filter((file) => file.role === "original").map((file) => file.name),
      ["slide-1.png", "slide-2.png"],
    );
    f.carousel = material.id;
  });

  test("format picks the default category", async () => {
    const [story] = await uploads(u.designer, 1);
    const res = await as.designer.post("/api/content", {
      brandId: f.brandA,
      projectId: f.project,
      title: "Story bastidores",
      network: "instagram",
      format: "stories",
      files: [{ uploadId: story.id }],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.material.category.slug, "stories");
    f.story = res.body.material.id;

    const reel = await as.manager.post("/api/content", { brandId: f.brandA, title: "Reel", network: "tiktok", format: "reels" });
    assert.equal(reel.status, 201);
    assert.equal(reel.body.material.category.slug, "reels-videos");
    f.reel = reel.body.material.id;
  });

  test("validation answers in pt-BR and designers need one of their projects", async () => {
    const missing = await as.manager.post("/api/content", { brandId: f.brandA, title: "" });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error.fields.network, "Escolha a rede social.");
    assert.equal(missing.body.error.fields.format, "Escolha o formato.");
    assert.ok(missing.body.error.fields.title);

    const noProject = await as.designer.post("/api/content", { brandId: f.brandA, title: "Post", network: "instagram", format: "estatico" });
    assert.equal(noProject.status, 422);
    assert.ok(noProject.body.error.fields.projectId);

    const otherBrand = await as.designerIdle.post("/api/content", { brandId: f.brandA, title: "Post", network: "instagram", format: "estatico" });
    assert.equal(otherBrand.status, 404);

    const badTime = await as.manager.post("/api/content", {
      brandId: f.brandA,
      title: "Post",
      network: "instagram",
      format: "estatico",
      plannedTime: "25:00",
    });
    assert.equal(badTime.status, 422);
    assert.equal(badTime.body.error.fields.plannedTime, "Use o formato HH:MM.");
  });

  test("clients never see drafts; released posts come without internal fields", async () => {
    const before = await as.clientA.get("/api/content");
    assert.equal(before.status, 200);
    assert.equal(before.body.items.length, 0);
    assert.equal((await as.clientA.get(`/api/content/${f.carousel}`)).status, 404);

    release(f.carousel);
    const list = await as.clientA.get(`/api/content?brandId=${f.brandA}`);
    assert.equal(list.body.items.length, 1);
    const item = list.body.items[0];
    assert.equal(item.id, f.carousel);
    assert.equal(item.slides, 2);
    assert.equal(item.visibility, "released");
    assert.equal(item.approvalStatus, "pending");
    assert.equal("internalNotes" in item, false);
    assert.equal("currentVersionId" in item, false);

    const detail = await as.clientA.get(`/api/content/${f.carousel}`);
    assert.equal(detail.status, 200);
    assert.equal(JSON.stringify(detail.body).includes("Nota interna da equipe"), false);
    assert.equal(detail.body.material.post.publishedBy, undefined);
  });

  test("isolation: other client, finance and out-of-scope staff", async () => {
    assert.equal((await as.clientB.get("/api/content")).body.items.length, 0);
    assert.equal((await as.clientB.get(`/api/content/${f.carousel}`)).status, 404);
    assert.equal((await as.finance.get("/api/content")).status, 403);
    assert.equal((await as.managerB.get(`/api/content/${f.carousel}`)).status, 404);
    assert.equal((await as.managerB.get("/api/content")).body.items.length, 0);
    assert.equal((await as.managerB.patch(`/api/content/${f.carousel}`, { title: "x" })).status, 404);
    assert.equal((await as.clientA.patch(`/api/content/${f.carousel}`, { title: "x" })).status, 403);
    assert.equal((await as.clientA.post("/api/content", { brandId: f.brandA })).status, 403);
  });

  test("filters, sort and calendar view", async () => {
    const grid = await as.manager.get(`/api/content?brandId=${f.brandA}&format=stories`);
    assert.deepEqual(grid.body.items.map((item) => item.id), [f.story]);
    const pending = await as.manager.get(`/api/content?approval=pending`);
    assert.deepEqual(pending.body.items.map((item) => item.id), [f.carousel]);
    const search = await as.manager.get(`/api/content?q=${encodeURIComponent("lançamento")}`);
    assert.deepEqual(search.body.items.map((item) => item.id), [f.carousel]);

    const calendar = await as.manager.get(`/api/content?view=calendar&from=2026-10-01&to=2026-10-31`);
    assert.deepEqual(calendar.body.items.map((item) => item.id), [f.carousel]);
    assert.deepEqual(calendar.body.undated.map((item) => item.id).sort(), [f.reel, f.story].sort());
    const bad = await as.manager.get("/api/content?from=2026-13-01");
    assert.equal(bad.status, 422);
  });

  test("editing post fields; caption changes need a new version once released", async () => {
    const edit = await as.designer.patch(`/api/content/${f.story}`, {
      plannedDate: "2026-10-20",
      caption: "Nova legenda",
      internalNotes: "Revisar cor",
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.material.post.plannedDate, "2026-10-20");
    assert.equal(edit.body.material.versions[0].caption, "Nova legenda");
    assert.equal(edit.body.material.internalNotes, "Revisar cor");

    const locked = await as.designer.patch(`/api/content/${f.carousel}`, { caption: "Mudou depois de liberar" });
    assert.equal(locked.status, 409);

    const toVideo = await as.manager.patch(`/api/content/${f.story}`, { format: "reels" });
    assert.equal(toVideo.body.material.category.slug, "reels-videos");
    assert.equal(toVideo.body.material.post.format, "reels");

    const idle = await as.designerIdle.patch(`/api/content/${f.story}`, { title: "Invasão" });
    assert.ok([403, 404].includes(idle.status));
  });

  test("publication is manual, needs confirmation and records who", async () => {
    assert.equal((await as.designer.patch(`/api/content/${f.carousel}/publication`, { status: "scheduled" })).status, 403);
    assert.equal((await as.clientA.patch(`/api/content/${f.carousel}/publication`, { status: "published", confirm: true })).status, 403);

    const draft = await as.manager.patch(`/api/content/${f.story}/publication`, { status: "scheduled" });
    assert.equal(draft.status, 409);

    const scheduled = await as.manager.patch(`/api/content/${f.carousel}/publication`, { status: "scheduled" });
    assert.equal(scheduled.status, 200);
    assert.equal(scheduled.body.material.post.publicationStatus, "scheduled");
    assert.equal(scheduled.body.material.post.scheduledBy.id, u.manager.id);
    assert.ok(scheduled.body.material.post.scheduledAt);
    // Approval is a separate axis: scheduling does not approve anything.
    assert.equal(scheduled.body.material.approvalStatus, "pending");

    const unconfirmed = await as.manager.patch(`/api/content/${f.carousel}/publication`, { status: "published" });
    assert.equal(unconfirmed.status, 422);
    assert.ok(unconfirmed.body.error.fields.confirm);

    const future = await as.manager.patch(`/api/content/${f.carousel}/publication`, {
      status: "published",
      confirm: true,
      publishedAt: "2099-01-01T10:00:00Z",
    });
    assert.equal(future.status, 422);

    const badUrl = await as.manager.patch(`/api/content/${f.carousel}/publication`, {
      status: "published",
      confirm: true,
      publishedUrl: "javascript:alert(1)",
    });
    assert.equal(badUrl.status, 422);

    const published = await as.manager.patch(`/api/content/${f.carousel}/publication`, {
      status: "published",
      confirm: true,
      publishedUrl: "https://instagram.com/p/abc",
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.material.post.publicationStatus, "published");
    assert.equal(published.body.material.post.publishedBy.name, "Gestora A");
    assert.equal(published.body.material.post.publishedUrl, "https://instagram.com/p/abc");

    const client = await as.clientA.get(`/api/content/${f.carousel}`);
    assert.equal(client.body.material.post.publicationStatus, "published");
    assert.equal(client.body.material.post.publishedBy, undefined);
    const note = ctx.db.get("SELECT * FROM notifications WHERE user_id = ? AND type = 'content.published'", [u.clientA.id]);
    assert.ok(note);
    const activity = ctx.db.get("SELECT * FROM activity_log WHERE material_id = ? AND action = 'content.published'", [f.carousel]);
    assert.equal(activity.visibility, "client");
    assert.equal(JSON.parse(activity.data).manual, true);

    const back = await as.admin.patch(`/api/content/${f.carousel}/publication`, { status: "not_scheduled" });
    assert.equal(back.body.material.post.publicationStatus, "not_scheduled");
    assert.equal(back.body.material.post.publishedAt, null);
  });

  test("scheduling from the planned date uses São Paulo time, whatever the server's time zone", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const planned = await as.manager.patch(`/api/content/${f.carousel}`, { plannedDate: "2026-10-12", plannedTime: "18:30" });
      assert.equal(planned.status, 200, JSON.stringify(planned.body));
      const scheduled = await as.manager.patch(`/api/content/${f.carousel}/publication`, { status: "scheduled" });
      assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
      // 18:30 in São Paulo (UTC−3) is 21:30 UTC
      assert.equal(scheduled.body.material.post.scheduledAt, "2026-10-12T21:30:00.000Z");

      await as.manager.patch(`/api/content/${f.carousel}`, { plannedTime: null });
      await as.manager.patch(`/api/content/${f.carousel}/publication`, { status: "not_scheduled" });
      const bulk = await as.manager.post("/api/content/bulk-publication", { ids: [f.carousel], status: "scheduled" });
      assert.deepEqual(bulk.body.ids, [f.carousel]);
      const row = ctx.db.get("SELECT scheduled_at FROM post_details WHERE material_id = ?", [f.carousel]);
      // no time: noon in São Paulo
      assert.equal(row.scheduled_at, "2026-10-12T15:00:00.000Z");
      await as.manager.patch(`/api/content/${f.carousel}/publication`, { status: "not_scheduled" });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test("the responsible person must already work on the client (owner grants write access)", async () => {
    const outsider = await createUser(ctx, { role: "designer", name: "Designer de fora" });
    const outsiderAgent = await login(server, { email: outsider.email });
    const otherManager = u.managerB;

    const patchOutsider = await as.designer.patch(`/api/content/${f.story}`, { ownerId: outsider.id });
    assert.equal(patchOutsider.status, 422);
    assert.equal(patchOutsider.body.error.fields.ownerId, "Escolha alguém da equipe com acesso a este cliente.");
    const patchManagerB = await as.manager.patch(`/api/content/${f.story}`, { ownerId: otherManager.id });
    assert.equal(patchManagerB.status, 422);
    // the outsider still cannot reach the post
    assert.equal((await outsiderAgent.get(`/api/content/${f.story}`)).status, 404);
    assert.equal((await outsiderAgent.patch(`/api/content/${f.story}`, { title: "Invasão" })).status, 404);

    const createOutsider = await as.manager.post("/api/content", {
      brandId: f.brandA,
      title: "Post com responsável de fora",
      network: "instagram",
      format: "estatico",
      ownerId: outsider.id,
    });
    assert.equal(createOutsider.status, 422);
    assert.ok(createOutsider.body.error.fields.ownerId);

    // allowed: admin, the client's manager, a designer of the brand's projects
    for (const person of [u.admin, u.manager, u.designer]) {
      const ok = await as.manager.patch(`/api/content/${f.story}`, { ownerId: person.id });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.material.owner.id, person.id);
    }
    // unchanged owner never blocks saving other fields
    assert.equal((await as.manager.patch(`/api/content/${f.story}`, { ownerId: u.designer.id, title: "Story bastidores" })).status, 200);

    // options tell the editor who can be chosen for each brand
    const options = await as.manager.get("/api/content/options");
    const byId = new Map(options.body.owners.map((owner) => [owner.id, owner]));
    assert.equal(byId.get(u.admin.id).brandIds, null);
    assert.deepEqual(byId.get(u.manager.id).brandIds, [f.brandA]);
    assert.deepEqual(byId.get(u.designer.id).brandIds, [f.brandA]);
    assert.deepEqual(byId.get(outsider.id).brandIds, []);
    // a manager never learns brands outside their scope through the list
    assert.deepEqual(byId.get(u.managerB.id).brandIds, []);
  });

  test("delivery is its own axis and filter", async () => {
    const at = now();
    ctx.db.run("UPDATE materials SET delivered_at = ? WHERE id = ?", [at, f.carousel]);
    const delivered = await as.manager.get(`/api/content?brandId=${f.brandA}&delivered=1`);
    assert.deepEqual(delivered.body.items.map((item) => item.id), [f.carousel]);
    assert.equal(delivered.body.items[0].deliveredAt, at);
    const notDelivered = await as.manager.get(`/api/content?brandId=${f.brandA}&delivered=0`);
    assert.equal(notDelivered.body.items.some((item) => item.id === f.carousel), false);
    assert.ok(notDelivered.body.items.length > 0);
    const client = await as.clientA.get(`/api/content?delivered=1`);
    assert.deepEqual(client.body.items.map((item) => item.id), [f.carousel]);
    const calendar = await as.manager.get(`/api/content?view=calendar&from=2026-10-01&to=2026-10-31&delivered=0`);
    assert.equal(calendar.body.items.some((item) => item.id === f.carousel), false);
    ctx.db.run("UPDATE materials SET delivered_at = NULL WHERE id = ?", [f.carousel]);
  });

  test("bulk scheduling skips drafts and never publishes", async () => {
    const res = await as.manager.post("/api/content/bulk-publication", { ids: [f.carousel, f.story, "mat_doesnotexist12345"], status: "scheduled" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.ids, [f.carousel]);
    assert.equal(res.body.skipped.length, 2);
    const publish = await as.manager.post("/api/content/bulk-publication", { ids: [f.carousel], status: "published" });
    assert.equal(publish.status, 422);
  });
});

describe("campaigns", () => {
  test("create, list by scope and keep names unique per brand", async () => {
    const created = await as.designer.post("/api/campaigns", { brandId: f.brandA, name: "Black Friday", startDate: "2026-11-01", endDate: "2026-11-30" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    f.campaign = created.body.campaign.id;
    const duplicate = await as.manager.post("/api/campaigns", { brandId: f.brandA, name: "black friday" });
    assert.equal(duplicate.status, 422);
    const range = await as.manager.post("/api/campaigns", { brandId: f.brandA, name: "X", startDate: "2026-11-10", endDate: "2026-11-01" });
    assert.equal(range.status, 422);
    assert.equal((await as.managerB.post("/api/campaigns", { brandId: f.brandA, name: "Y" })).status, 404);
    assert.equal((await as.clientA.post("/api/campaigns", { brandId: f.brandA, name: "Y" })).status, 403);

    const other = await as.managerB.post("/api/campaigns", { brandId: f.brandB, name: "Campanha B" });
    assert.equal(other.status, 201);
    const wrong = await as.manager.patch(`/api/content/${f.carousel}`, { campaignId: other.body.campaign.id });
    assert.equal(wrong.status, 422);
    const linked = await as.manager.patch(`/api/content/${f.carousel}`, { campaignId: f.campaign });
    assert.equal(linked.body.material.post.campaign.name, "Black Friday");

    const staffList = await as.manager.get(`/api/campaigns?brandId=${f.brandA}`);
    assert.deepEqual(staffList.body.items.map((item) => item.name), ["Black Friday"]);
    assert.equal((await as.managerB.get("/api/campaigns")).body.items.some((item) => item.id === f.campaign), false);

    // Clients only see campaigns that hold posts released to them.
    const clientList = await as.clientA.get("/api/campaigns");
    assert.deepEqual(clientList.body.items.map((item) => item.name), ["Black Friday"]);
    assert.equal(clientList.body.items[0].postCount, 1);
    assert.equal((await as.clientB.get("/api/campaigns")).body.items.some((item) => item.id === f.campaign), false);

    const filtered = await as.clientA.get(`/api/content?campaignId=${f.campaign}`);
    assert.deepEqual(filtered.body.items.map((item) => item.id), [f.carousel]);
  });

  test("patch and delete keep posts, without the campaign", async () => {
    assert.equal((await as.managerB.patch(`/api/campaigns/${f.campaign}`, { name: "Outra" })).status, 404);
    const renamed = await as.manager.patch(`/api/campaigns/${f.campaign}`, { name: "Black Friday 2026" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.campaign.name, "Black Friday 2026");

    const temp = await as.manager.post("/api/campaigns", { brandId: f.brandA, name: "Temporária" });
    assert.equal((await as.designer.del(`/api/campaigns/${temp.body.campaign.id}`)).status, 403);
    assert.equal((await as.manager.del(`/api/campaigns/${temp.body.campaign.id}`)).status, 204);
    assert.equal((await as.designer.del(`/api/campaigns/${f.campaign}`)).status, 204);
    const post = await as.manager.get(`/api/content/${f.carousel}`);
    assert.equal(post.status, 200);
    assert.equal(post.body.material.post.campaign, null);
  });
});

describe("options", () => {
  test("staff options stay inside the scope; clients get their months and campaigns", async () => {
    const manager = await as.manager.get("/api/content/options");
    assert.equal(manager.status, 200);
    assert.deepEqual(manager.body.brands.map((brand) => brand.id), [f.brandA]);
    assert.deepEqual(manager.body.projects.map((project) => project.id), [f.project]);
    assert.ok(manager.body.owners.some((owner) => owner.id === u.designer.id));
    assert.equal(manager.body.owners.some((owner) => owner.role === "client"), false);
    assert.ok(manager.body.months.includes("2026-10"));

    const admin = await as.admin.get("/api/content/options");
    assert.deepEqual(admin.body.brands.map((brand) => brand.id).sort(), [f.brandA, f.brandB].sort());

    const client = await as.clientA.get(`/api/content/options?brandId=${f.brandA}`);
    assert.equal(client.status, 200);
    assert.equal(client.body.brands, undefined);
    assert.equal(client.body.owners, undefined);
    assert.deepEqual(client.body.months, ["2026-10"]);
    const other = await as.clientB.get("/api/content/options");
    assert.deepEqual(other.body.months, []);
    assert.equal((await as.finance.get("/api/content/options")).status, 403);
  });

  test("a post of another brand never leaks through the client list", async () => {
    const { material } = await insertMaterial(ctx, {
      brandId: f.brandB,
      kind: "post",
      categorySlug: "posts-carrosseis",
      title: "Post da Marca B",
      createdBy: u.admin.id,
      visibility: "released",
      plannedDate: "2026-10-05",
    });
    const a = await as.clientA.get(`/api/content?brandId=${f.brandB}`);
    assert.equal(a.body.items.length, 0);
    const b = await as.clientB.get("/api/content");
    assert.deepEqual(b.body.items.map((item) => item.id), [material.id]);
    assert.equal(categoryId(ctx, "posts-carrosseis"), material.category_id);
  });
});

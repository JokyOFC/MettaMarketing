// Slice A — isolation between accounts through the HTTP API. Out-of-scope
// ids answer 404 (never revealing existence); visible-but-forbidden actions 403.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";
import {
  addStaffAccess,
  categoryId,
  createAgent,
  createClientWithBrand,
  createProject,
  createUser,
  insertMaterial,
  login,
  png,
  startTestServer,
  waitFor,
} from "./helpers.js";

let server;
let ctx;
let db;
const u = {};
const a = {};
const f = {};

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;
  db = server.db;
  const A = createClientWithBrand(ctx, { name: "Aurora Pagamentos", brandName: "Aurora" });
  const B = createClientWithBrand(ctx, { name: "Boreal", brandName: "Boreal" });
  Object.assign(f, { clientA: A.clientId, brandA: A.brandId, clientB: B.clientId, brandB: B.brandId });
  u.admin = await createUser(ctx, { role: "admin" });
  u.managerA = await createUser(ctx, { role: "manager" });
  u.managerB = await createUser(ctx, { role: "manager" });
  u.designerA = await createUser(ctx, { role: "designer" });
  u.designerOut = await createUser(ctx, { role: "designer" });
  u.finance = await createUser(ctx, { role: "finance" });
  u.clientA = await createUser(ctx, { role: "client", clientId: A.clientId });
  u.clientB = await createUser(ctx, { role: "client", clientId: B.clientId });
  addStaffAccess(ctx, u.managerA.id, A.clientId);
  addStaffAccess(ctx, u.managerB.id, B.clientId);
  f.projectA = createProject(ctx, { brandId: A.brandId, name: "Identidade Aurora", memberIds: [u.designerA.id] }).id;
  f.projectB = createProject(ctx, { brandId: B.brandId, name: "Conteúdo Boreal", memberIds: [u.designerOut.id] }).id;

  const image = await png();
  f.logo = await insertMaterial(ctx, {
    brandId: A.brandId,
    projectId: f.projectA,
    title: "Logo Aurora",
    visibility: "released",
    createdBy: u.designerA.id,
    files: [
      { role: "original", filename: "logo.png", buffer: image },
      { role: "cover", filename: "capa.png", buffer: image },
    ],
  });
  f.video = await insertMaterial(ctx, {
    brandId: A.brandId,
    projectId: f.projectA,
    categorySlug: "reels-videos",
    title: "Reels",
    visibility: "released",
    createdBy: u.designerA.id,
    files: [{ role: "original", filename: "reels.mp4", buffer: Buffer.from("\0\0\0\x18ftypmp42") }],
  });
  f.post = await insertMaterial(ctx, {
    kind: "post",
    brandId: A.brandId,
    projectId: f.projectA,
    categorySlug: "posts-carrosseis",
    title: "Carrossel",
    visibility: "released",
    createdBy: u.designerA.id,
    plannedDate: "2026-10-01",
    files: [
      { role: "original", filename: "1.png", buffer: image, position: 1 },
      { role: "original", filename: "2.png", buffer: image, position: 2 },
    ],
  });
  f.draft = await insertMaterial(ctx, { brandId: A.brandId, projectId: f.projectA, title: "Rascunho A", createdBy: u.designerA.id });
  f.logoB = await insertMaterial(ctx, { brandId: B.brandId, projectId: f.projectB, title: "Logo Boreal", visibility: "released", createdBy: u.admin.id });
  // a thumbnail row so preview routes have something to serve
  const stored = await ctx.storage.putBuffer(image);
  db.run(
    "INSERT INTO file_renditions (file_id, kind, storage_key, mime, width, height, size_bytes, created_at) VALUES (?, 'thumb', ?, 'image/webp', 64, 64, ?, ?)",
    [f.logo.files[0].id, stored.key, stored.size, now()],
  );
  f.kit = newId("kit");
  db.run("INSERT INTO kits (id, brand_id, name, kind, status, created_at, updated_at) VALUES (?, ?, 'Kit Aurora', 'brand_kit', 'released', ?, ?)", [
    f.kit,
    A.brandId,
    now(),
    now(),
  ]);
  db.run("INSERT INTO kit_items (kit_id, material_id, sort_order) VALUES (?, ?, 10)", [f.kit, f.logo.material.id]);
  for (const [key, user] of Object.entries(u)) a[key] = await login(server, { email: user.email });
});

after(async () => {
  await server?.close();
});

const logoId = () => f.logo.material.id;
const fileId = () => f.logo.files[0].id;

describe("client B against client A", () => {
  test("materials, versions, files, previews, streams and history are 404", async () => {
    const b = a.clientB;
    assert.equal((await a.clientA.get(`/api/materials/${logoId()}`)).status, 200, "sanity: A sees its material");
    for (const path of [
      `/api/materials/${logoId()}`,
      `/api/materials/${logoId()}/history`,
      `/api/versions/${f.logo.version.id}`,
      `/api/files/${fileId()}/preview/thumb`,
      `/api/files/${f.video.files[0].id}/stream`,
      `/api/kits/${f.kit}`,
    ]) {
      const res = await b.get(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.body.error.code, "not_found");
    }
    assert.equal((await b.post("/api/downloads/link", { fileId: fileId() })).status, 404);
    const list = await b.get("/api/materials");
    assert.deepEqual(list.body.items.map((m) => m.id), [f.logoB.material.id]);
    assert.ok(!(await b.get(`/api/materials?brandId=${f.brandA}`)).body.items.length);
    assert.equal((await b.get("/api/kits")).body.items.length, 0);
  });

  test("every ZIP scope pointing at A is refused", async () => {
    const b = a.clientB;
    const scopes = [
      { type: "selection", fileIds: [fileId()] },
      { type: "selection", materialIds: [logoId()] },
      { type: "category", brandId: f.brandA, categoryId: categoryId(ctx, "logotipo") },
      { type: "brand_kit", brandId: f.brandA },
      { type: "carousel", materialId: f.post.material.id },
      { type: "project", projectId: f.projectA },
      { type: "kit", kitId: f.kit },
    ];
    for (const scope of scopes) {
      const res = await b.post("/api/zips", { scope });
      assert.equal(res.status, 404, JSON.stringify(scope));
    }
    // mixing an own file with a foreign one is refused as a whole
    const mixed = await b.post("/api/zips", { scope: { type: "selection", fileIds: [f.logoB.files[0].id, fileId()] } });
    assert.equal(mixed.status, 404);
  });

  test("B cannot redeem A's links or follow A's ZIP jobs", async () => {
    const link = await a.clientA.post("/api/downloads/link", { fileId: fileId() });
    // outside the record's scope a stolen link reveals nothing (404, §2 rule 2)
    assert.equal((await a.clientB.get(link.body.url)).status, 404);
    assert.equal((await a.admin.get(link.body.url)).status, 403, "visible to an admin, but still personal");
    const created = await a.clientA.post("/api/zips", { scope: { type: "brand_kit", brandId: f.brandA } });
    assert.equal(created.status, 202);
    const jobId = created.body.job.id;
    await waitFor(async () => (await a.clientA.get(`/api/zips/${jobId}`)).body.job.status === "ready");
    assert.equal((await a.clientB.get(`/api/zips/${jobId}`)).status, 404);
    assert.equal((await a.clientB.post(`/api/zips/${jobId}/link`)).status, 404);
    const zipLink = await a.clientA.post(`/api/zips/${jobId}/link`);
    assert.equal((await a.clientB.get(zipLink.body.url)).status, 404);
    assert.equal((await a.admin.get(zipLink.body.url)).status, 403, "not even an admin");
  });

  test("clients never see drafts, and cannot write", async () => {
    assert.equal((await a.clientA.get(`/api/materials/${f.draft.material.id}`)).status, 404);
    assert.equal((await a.clientA.patch(`/api/materials/${logoId()}`, { title: "x" })).status, 403);
    assert.equal((await a.clientA.post("/api/releases/preview", { materialIds: [logoId()] })).status, 403);
    assert.equal((await a.clientA.post(`/api/materials/${logoId()}/archive`)).status, 403);
    assert.equal((await a.clientA.post("/api/kits", { brandId: f.brandA, name: "x" })).status, 403);
    assert.equal((await a.clientA.del(`/api/files/${fileId()}`)).status, 403);
  });
});

describe("staff scope", () => {
  test("designer outside the project gets 404 and cannot release", async () => {
    const d = a.designerOut;
    assert.equal((await d.get(`/api/materials/${logoId()}`)).status, 404);
    assert.equal((await d.get(`/api/files/${fileId()}/preview/thumb`)).status, 404);
    assert.equal((await d.post("/api/downloads/link", { fileId: fileId() })).status, 404);
    assert.equal((await d.patch(`/api/materials/${logoId()}`, { title: "x" })).status, 404);
    assert.equal((await d.post(`/api/materials/${logoId()}/versions`, {})).status, 404);
    assert.equal((await d.post("/api/zips", { scope: { type: "brand_kit", brandId: f.brandA } })).status, 404);
    assert.equal((await d.post("/api/releases/preview", { materialIds: [logoId()] })).status, 403);
    assert.equal((await d.post("/api/releases", { materialIds: [logoId()], notifyApp: true })).status, 403);
    assert.ok(!(await d.get("/api/materials")).body.items.some((m) => m.brand.id === f.brandA));
    const up = await d.upload("/api/uploads", { buffer: await png(), filename: "intruso.png" });
    assert.equal(up.status, 201);
    const created = await d.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.projectA,
      categoryId: categoryId(ctx, "logotipo"),
      title: "Intruso",
      files: [{ uploadId: up.body.upload.id }],
    });
    assert.equal(created.status, 404);
  });

  test("designer of the project reads and edits, but never releases or delivers", async () => {
    const d = a.designerA;
    assert.equal((await d.get(`/api/materials/${logoId()}`)).status, 200);
    assert.equal((await d.get(`/api/materials/${f.logoB.material.id}`)).status, 404);
    assert.equal((await d.post("/api/releases/preview", { materialIds: [f.draft.material.id] })).status, 403);
    assert.equal((await d.post(`/api/materials/${logoId()}/deliver`)).status, 403);
    assert.equal((await d.post(`/api/kits/${f.kit}/release`, {})).status, 403);
    assert.equal((await d.post(`/api/materials/${logoId()}/archive`)).status, 403);
    // someone else's upload cannot be attached
    const foreignUpload = await a.managerA.upload("/api/uploads", { buffer: await png(), filename: "do-gestor.png" });
    const res = await d.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.projectA,
      categoryId: categoryId(ctx, "logotipo"),
      title: "Com upload alheio",
      files: [{ uploadId: foreignUpload.body.upload.id }],
    });
    assert.equal(res.status, 422);
  });

  test("managers are limited to their clients", async () => {
    assert.equal((await a.managerB.get(`/api/materials/${logoId()}`)).status, 404);
    assert.equal((await a.managerB.post("/api/releases/preview", { materialIds: [logoId()] })).status, 404);
    const mixed = await a.managerA.post("/api/releases/preview", { materialIds: [logoId(), f.logoB.material.id] });
    assert.equal(mixed.status, 404, "a foreign id anywhere refuses the whole release");
    assert.equal((await a.managerB.post("/api/kits", { brandId: f.brandA, name: "Kit" })).status, 404);
    assert.equal((await a.managerB.get(`/api/kits/${f.kit}`)).status, 404);
    assert.ok(!(await a.managerB.get("/api/releases")).body.items.length);
  });

  test("admins see everything; mixed brands are blocked in the preview", async () => {
    const preview = await a.admin.post("/api/releases/preview", { materialIds: [f.draft.material.id, f.logoB.material.id] });
    assert.equal(preview.status, 200);
    assert.ok(preview.body.blockers.some((b) => /marcas diferentes/.test(b)));
    const release = await a.admin.post("/api/releases", { materialIds: [f.draft.material.id, f.logoB.material.id], notifyApp: true });
    assert.equal(release.status, 409);
    assert.equal(db.get("SELECT visibility FROM materials WHERE id = ?", [f.draft.material.id]).visibility, "draft", "nothing applied");
  });

  test("finance never reaches materials or files", async () => {
    const fin = a.finance;
    assert.equal((await fin.get("/api/materials")).status, 403);
    assert.equal((await fin.get(`/api/materials/${logoId()}`)).status, 403);
    assert.equal((await fin.get(`/api/files/${fileId()}/preview/thumb`)).status, 403);
    assert.equal((await fin.post("/api/downloads/link", { fileId: fileId() })).status, 403);
    assert.equal((await fin.upload("/api/uploads", { buffer: await png(), filename: "x.png" })).status, 403);
    assert.equal((await fin.post("/api/zips", { scope: { type: "brand_kit", brandId: f.brandA } })).status, 403);
  });

  test("anonymous requests are 401", async () => {
    const anon = createAgent(server);
    for (const path of ["/api/materials", `/api/materials/${logoId()}`, `/api/files/${fileId()}/preview/thumb`, "/api/zips", "/api/kits"])
      assert.equal((await anon.get(path)).status, 401, path);
  });
});

describe("responsible person (ownerId)", () => {
  const OUTSIDER = "Escolha alguém da equipe com acesso a este cliente.";

  test("a designer cannot hand a client's material to someone outside that client", async () => {
    const d = a.designerA;
    assert.equal((await a.designerOut.get(`/api/materials/${logoId()}`)).status, 404, "sanity: outsider has no access");
    const toOutsider = await d.patch(`/api/materials/${logoId()}`, { ownerId: u.designerOut.id });
    assert.equal(toOutsider.status, 422);
    assert.equal(toOutsider.body.error.fields.ownerId, OUTSIDER);
    assert.equal(db.get("SELECT owner_id FROM materials WHERE id = ?", [logoId()]).owner_id, u.designerA.id);
    assert.equal((await a.designerOut.get(`/api/materials/${logoId()}`)).status, 404, "still no access");
    assert.equal((await a.designerOut.get(`/api/materials/${logoId()}/history`)).status, 404);

    // a manager of another client, or finance, is not assignable either
    assert.equal((await d.patch(`/api/materials/${logoId()}`, { ownerId: u.managerB.id })).body.error.fields.ownerId, OUTSIDER);
    assert.equal((await a.admin.patch(`/api/materials/${logoId()}`, { ownerId: u.finance.id })).status, 422);
    assert.equal((await a.admin.patch(`/api/materials/${logoId()}`, { ownerId: u.clientA.id })).status, 422);

    // bulk: reported per material, nothing changes
    const bulk = await a.managerA.post("/api/materials/bulk", { ids: [logoId()], action: "set_owner", value: u.designerOut.id });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.updated, 0);
    assert.deepEqual(bulk.body.skipped, [{ id: logoId(), reason: OUTSIDER }]);

    // creating with an outsider as owner is refused too
    const up = await d.upload("/api/uploads", { buffer: await png(), filename: "dono.png" });
    const created = await d.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.projectA,
      categoryId: categoryId(ctx, "logotipo"),
      title: "Dono de fora",
      ownerId: u.designerOut.id,
      files: [{ uploadId: up.body.upload.id }],
    });
    assert.equal(created.status, 422);
    assert.equal(created.body.error.fields.ownerId, OUTSIDER);
  });

  test("people who already work on the client can be responsible", async () => {
    // a manager with access to the client, an admin, a designer of a project of the brand
    const designerA2 = await createUser(ctx, { role: "designer", name: "Outra designer" });
    createProject(ctx, { brandId: f.brandA, name: "Conteúdo Aurora", memberIds: [designerA2.id] });
    for (const ownerId of [u.managerA.id, u.admin.id, designerA2.id]) {
      const res = await a.designerA.patch(`/api/materials/${f.draft.material.id}`, { ownerId });
      assert.equal(res.status, 200, `${ownerId} ${JSON.stringify(res.body)}`);
      assert.equal(db.get("SELECT owner_id FROM materials WHERE id = ?", [f.draft.material.id]).owner_id, ownerId);
      // put it back so the designer keeps write access through ownership
      db.run("UPDATE materials SET owner_id = ? WHERE id = ?", [u.designerA.id, f.draft.material.id]);
    }
    const bulk = await a.managerA.post("/api/materials/bulk", { ids: [f.draft.material.id], action: "set_owner", value: u.managerA.id });
    assert.equal(bulk.body.updated, 1);
    db.run("UPDATE materials SET owner_id = ? WHERE id = ?", [u.designerA.id, f.draft.material.id]);
  });
});

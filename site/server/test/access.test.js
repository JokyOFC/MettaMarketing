// Scope rules for every role, using direct DB fixtures (lib/access.js and
// services/materials.js). Out-of-scope ids must answer 404.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  assertBrand,
  assertClient,
  assertFile,
  assertMaterial,
  assertProject,
  assertVersion,
  canWriteMaterial,
  getScope,
  scopeSql,
} from "../lib/access.js";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";
import {
  createMaterial,
  createVersion,
  getMaterialDetail,
  listMaterials,
} from "../services/materials.js";
import {
  addStaffAccess,
  categoryId,
  createBrand,
  createClientWithBrand,
  createProject,
  createUpload,
  createUser,
  fakeReq,
  insertMaterial,
  png,
  startTestServer,
  ttf,
} from "./helpers.js";

let server;
let ctx;
const u = {};
const f = {};

const req = (user) => fakeReq(ctx, user);
const status = (fn) => {
  try {
    fn();
    return 200;
  } catch (err) {
    return err.status ?? 500;
  }
};
const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;

  const a = createClientWithBrand(ctx, { name: "Cliente A", brandName: "Marca A" });
  const b = createClientWithBrand(ctx, { name: "Cliente B", brandName: "Marca B" });
  f.clientA = a.clientId;
  f.brandA = a.brandId;
  f.clientB = b.clientId;
  f.brandB = b.brandId;
  f.brandA2 = createBrand(ctx, a.clientId, "Marca A2").id;

  u.admin = await createUser(ctx, { role: "admin" });
  u.managerA = await createUser(ctx, { role: "manager" });
  u.managerNone = await createUser(ctx, { role: "manager" });
  u.designer = await createUser(ctx, { role: "designer" });
  u.designerIdle = await createUser(ctx, { role: "designer" });
  u.finance = await createUser(ctx, { role: "finance" });
  u.clientA = await createUser(ctx, { role: "client", clientId: a.clientId });
  u.clientB = await createUser(ctx, { role: "client", clientId: b.clientId });
  addStaffAccess(ctx, u.managerA.id, a.clientId);

  f.projectA1 = createProject(ctx, { brandId: a.brandId, name: "Identidade A", memberIds: [u.designer.id] }).id;
  f.projectA2 = createProject(ctx, { brandId: a.brandId, name: "Conteúdo A" }).id;
  f.projectB = createProject(ctx, { brandId: b.brandId, name: "Projeto B" }).id;

  const image = await png();
  f.released = await insertMaterial(ctx, {
    brandId: a.brandId,
    projectId: f.projectA1,
    title: "Logo principal",
    visibility: "released",
    createdBy: u.designer.id,
    files: [
      { role: "original", filename: "logo.png", buffer: image },
      { role: "final", filename: "logo-final.png", buffer: image },
      { role: "editable", filename: "logo.ai", buffer: Buffer.from("%PDF-1.4 ai") },
      { role: "cover", filename: "capa.png", buffer: image },
    ],
  });
  ctx.db.run("UPDATE materials SET internal_notes = 'nota interna secreta' WHERE id = ?", [f.released.material.id]);
  f.draft = await insertMaterial(ctx, { brandId: a.brandId, projectId: f.projectA1, title: "Rascunho", createdBy: u.designer.id });
  f.review = await insertMaterial(ctx, {
    brandId: a.brandId,
    projectId: f.projectA1,
    title: "Em revisão",
    visibility: "internal_review",
    createdBy: u.designer.id,
  });
  f.archived = await insertMaterial(ctx, { brandId: a.brandId, title: "Arquivado", visibility: "released", archived: true, createdBy: u.managerA.id });
  f.otherProject = await insertMaterial(ctx, { brandId: a.brandId, projectId: f.projectA2, title: "Outro projeto", createdBy: u.managerA.id });
  f.noDownload = await insertMaterial(ctx, { brandId: a.brandId, title: "Sem download", visibility: "released", downloadEnabled: false, createdBy: u.managerA.id });
  f.fontLocked = await insertMaterial(ctx, {
    brandId: a.brandId,
    categorySlug: "tipografia",
    title: "Fonte licenciada",
    visibility: "released",
    createdBy: u.managerA.id,
    files: [{ role: "original", filename: "Fonte.ttf", buffer: ttf(), fontDistributable: false }],
  });
  f.fontFree = await insertMaterial(ctx, {
    brandId: a.brandId,
    categorySlug: "tipografia",
    title: "Fonte livre",
    visibility: "released",
    createdBy: u.managerA.id,
    files: [{ role: "original", filename: "Livre.otf", buffer: ttf(), fontDistributable: true }],
  });
  f.brandA2Mat = await insertMaterial(ctx, { brandId: f.brandA2, title: "Marca A2", visibility: "released", createdBy: u.managerA.id });
  f.releasedB = await insertMaterial(ctx, { brandId: b.brandId, projectId: f.projectB, title: "Logo B", visibility: "released", createdBy: u.admin.id });

  // an unreleased v2 on the released material
  f.v2 = newId("ver");
  ctx.db.run(
    "INSERT INTO material_versions (id, material_id, number, status, created_by, created_at) VALUES (?, ?, 2, 'draft', ?, ?)",
    [f.v2, f.released.material.id, u.designer.id, now()],
  );
});

after(async () => {
  await server?.close();
});

describe("getScope", () => {
  test("describes each role", () => {
    assert.equal(getScope(req(u.admin)).all, true);
    const finance = getScope(req(u.finance));
    assert.equal(finance.all, true);
    assert.equal(finance.materials, false);
    const manager = getScope(req(u.managerA));
    assert.deepEqual([...manager.clientIds], [f.clientA]);
    assert.equal(manager.projectIds, null);
    const designer = getScope(req(u.designer));
    assert.deepEqual([...designer.projectIds], [f.projectA1]);
    assert.deepEqual([...designer.brandIds], [f.brandA]);
    assert.deepEqual([...designer.clientIds], [f.clientA]);
    assert.deepEqual([...getScope(req(u.clientA)).clientIds], [f.clientA]);
    assert.equal(getScope(req(u.designerIdle)).projectIds.size, 0);
  });

  test("requires a user", () => {
    assert.equal(status(() => getScope({ ctx, user: null })), 401);
  });
});

describe("clients, brands and projects", () => {
  test("admin and finance see every client and brand", () => {
    for (const user of [u.admin, u.finance]) {
      assert.equal(status(() => assertClient(req(user), f.clientB)), 200);
      assert.equal(status(() => assertBrand(req(user), f.brandB)), 200);
    }
    assert.equal(status(() => assertProject(req(u.admin), f.projectB)), 200);
    assert.equal(status(() => assertProject(req(u.finance), f.projectB)), 404);
  });

  test("manager is limited to granted clients", () => {
    const r = req(u.managerA);
    assert.equal(status(() => assertClient(r, f.clientA)), 200);
    assert.equal(status(() => assertBrand(r, f.brandA2)), 200);
    assert.equal(status(() => assertProject(r, f.projectA2)), 200);
    assert.equal(status(() => assertClient(r, f.clientB)), 404);
    assert.equal(status(() => assertBrand(r, f.brandB)), 404);
    assert.equal(status(() => assertProject(r, f.projectB)), 404);
    const none = req(u.managerNone);
    assert.equal(status(() => assertClient(none, f.clientA)), 404);
    assert.equal(status(() => assertMaterial(none, f.released.material.id)), 404);
  });

  test("designer reads only brands and projects it works on", () => {
    const r = req(u.designer);
    assert.equal(status(() => assertClient(r, f.clientA)), 200);
    assert.equal(status(() => assertBrand(r, f.brandA)), 200);
    assert.equal(status(() => assertBrand(r, f.brandA2)), 404);
    assert.equal(status(() => assertProject(r, f.projectA1)), 200);
    assert.equal(status(() => assertProject(r, f.projectA2)), 404);
    assert.equal(status(() => assertClient(r, f.clientB)), 404);
    const idle = req(u.designerIdle);
    assert.equal(status(() => assertBrand(idle, f.brandA)), 404);
    assert.equal(status(() => assertClient(idle, f.clientA)), 404);
  });

  test("client sees only its own records", () => {
    const r = req(u.clientA);
    assert.equal(status(() => assertClient(r, f.clientA)), 200);
    assert.equal(status(() => assertBrand(r, f.brandA2)), 200);
    assert.equal(status(() => assertProject(r, f.projectA1)), 200);
    assert.equal(status(() => assertClient(r, f.clientB)), 404);
    assert.equal(status(() => assertBrand(r, f.brandB)), 404);
    assert.equal(status(() => assertProject(r, f.projectB)), 404);
    assert.equal(status(() => assertClient(r, "cli_nao_existe_000")), 404);
  });

  test("scopeSql helpers match the assert rules", () => {
    const countWith = (user, helper, table, alias) => {
      const s = scopeSql[helper](req(user), alias);
      return ctx.db.get(`SELECT COUNT(*) AS n FROM ${table} ${alias} WHERE ${s.sql}`, s.params).n;
    };
    assert.equal(countWith(u.managerA, "clients", "clients", "c"), 1);
    assert.equal(countWith(u.clientB, "brands", "brands", "b"), 1);
    assert.equal(countWith(u.designer, "brands", "brands", "b"), 1);
    assert.equal(countWith(u.designer, "projects", "projects", "p"), 1);
    assert.equal(countWith(u.finance, "projects", "projects", "p"), 0);
    assert.equal(countWith(u.clientA, "projects", "projects", "p"), 2);
    assert.equal(countWith(u.managerNone, "brands", "brands", "b"), 0);
  });
});

describe("materials", () => {
  test("client A sees only released, active, own materials", () => {
    const r = req(u.clientA);
    assert.equal(status(() => assertMaterial(r, f.released.material.id)), 200);
    assert.equal(status(() => assertMaterial(r, f.brandA2Mat.material.id)), 200);
    for (const hidden of [f.draft, f.review, f.archived, f.otherProject, f.releasedB])
      assert.equal(status(() => assertMaterial(r, hidden.material.id)), 404, hidden.material.title);
    assert.equal(status(() => assertMaterial(r, f.released.material.id, { write: true })), 403);
  });

  test("client B cannot reach client A's materials, versions or files", () => {
    const r = req(u.clientB);
    assert.equal(status(() => assertMaterial(r, f.released.material.id)), 404);
    assert.equal(status(() => assertVersion(r, f.released.version.id)), 404);
    for (const file of f.released.files) {
      assert.equal(status(() => assertFile(r, file.id)), 404);
      assert.equal(status(() => assertFile(r, file.id, { download: true })), 404);
    }
    assert.equal(status(() => assertMaterial(r, f.releasedB.material.id)), 200);
  });

  test("clients see released versions only and the allowed file roles", () => {
    const r = req(u.clientA);
    assert.equal(status(() => assertVersion(r, f.released.version.id)), 200);
    assert.equal(status(() => assertVersion(r, f.v2)), 404);
    const [original, final, editable, cover] = f.released.files;
    assert.equal(status(() => assertFile(r, original.id, { download: true })), 200);
    assert.equal(status(() => assertFile(r, final.id, { download: true })), 200);
    assert.equal(status(() => assertFile(r, editable.id)), 404, "editable not included");
    assert.equal(status(() => assertFile(r, cover.id)), 200, "cover is visible as a preview");
    assert.equal(status(() => assertFile(r, cover.id, { download: true })), 403);

    ctx.db.run("UPDATE materials SET editable_included = 1 WHERE id = ?", [f.released.material.id]);
    assert.equal(status(() => assertFile(req(u.clientA), editable.id, { download: true })), 200);
    ctx.db.run("UPDATE materials SET editable_included = 0 WHERE id = ?", [f.released.material.id]);

    // staff reach every file of the draft version
    assert.equal(status(() => assertVersion(req(u.managerA), f.v2)), 200);
    assert.equal(status(() => assertFile(req(u.designer), editable.id, { download: true })), 200);
  });

  test("download rules: disabled downloads and font licences", () => {
    const r = req(u.clientA);
    const [noDl] = f.noDownload.files;
    assert.equal(status(() => assertFile(r, noDl.id)), 200);
    assert.equal(code(() => assertFile(r, noDl.id, { download: true })), "download_disabled");
    assert.equal(code(() => assertFile(r, f.fontLocked.files[0].id, { download: true })), "font_license");
    assert.equal(status(() => assertFile(r, f.fontFree.files[0].id, { download: true })), 200);
    assert.equal(status(() => assertFile(req(u.managerA), noDl.id, { download: true })), 200);
  });

  test("designer reads its brands but writes only on member projects or own work", () => {
    const r = req(u.designer);
    assert.equal(status(() => assertMaterial(r, f.draft.material.id, { write: true })), 200);
    assert.equal(status(() => assertMaterial(r, f.otherProject.material.id)), 200);
    assert.equal(status(() => assertMaterial(r, f.otherProject.material.id, { write: true })), 403);
    assert.equal(canWriteMaterial(r, assertMaterial(r, f.otherProject.material.id)), false);
    assert.equal(status(() => assertMaterial(r, f.brandA2Mat.material.id)), 404);
    assert.equal(status(() => assertMaterial(r, f.releasedB.material.id)), 404);
    const idle = req(u.designerIdle);
    assert.equal(status(() => assertMaterial(idle, f.draft.material.id)), 404);
  });

  test("finance never reaches materials or files", () => {
    const r = req(u.finance);
    assert.equal(status(() => assertMaterial(r, f.released.material.id)), 404);
    assert.equal(status(() => assertFile(r, f.released.files[0].id)), 404);
    const s = scopeSql.materials(r, "m");
    assert.equal(ctx.db.get(`SELECT COUNT(*) AS n FROM materials m WHERE ${s.sql}`, s.params).n, 0);
  });

  test("manager scope covers every material of its clients", () => {
    const r = req(u.managerA);
    assert.equal(status(() => assertMaterial(r, f.otherProject.material.id, { write: true })), 200);
    assert.equal(status(() => assertMaterial(r, f.archived.material.id)), 200);
    assert.equal(status(() => assertMaterial(r, f.releasedB.material.id)), 404);
  });

  test("scopeSql.materials matches assertMaterial for every role", () => {
    const all = ctx.db.all("SELECT id FROM materials").map((row) => row.id);
    for (const user of Object.values(u)) {
      const s = scopeSql.materials(req(user), "m", "b");
      const listed = new Set(
        ctx.db.all(`SELECT m.id FROM materials m JOIN brands b ON b.id = m.brand_id WHERE ${s.sql}`, s.params).map((row) => row.id),
      );
      for (const id of all) {
        const visible = status(() => assertMaterial(req(user), id)) === 200;
        assert.equal(listed.has(id), visible, `${user.role} ${id}`);
      }
    }
  });
});

describe("materials service", () => {
  test("client lists and details carry no internal data", () => {
    const r = req(u.clientA);
    const { items, total } = listMaterials(r, {});
    const ids = items.map((item) => item.id).sort();
    const expected = [f.released, f.noDownload, f.fontLocked, f.fontFree, f.brandA2Mat].map((x) => x.material.id).sort();
    assert.deepEqual(ids, expected);
    assert.equal(total, expected.length);
    for (const item of items) {
      assert.equal(item.internalNotes, undefined);
      assert.equal(item.visibility, "released");
      assert.equal(item.currentVersionId, undefined);
    }
    const detail = getMaterialDetail(req(u.clientA), f.released.material.id);
    assert.equal(detail.internalNotes, undefined);
    assert.deepEqual(detail.versions.map((v) => v.number), [1]);
    const roles = detail.versions[0].files.map((file) => file.role);
    assert.deepEqual(roles, ["original", "final", "cover"]);
    assert.equal(detail.versions[0].files.find((file) => file.role === "cover").downloadable, false);
    assert.equal(detail.permissions.canApprove, true);
    assert.equal(detail.permissions.canEdit, false);
    assert.deepEqual(detail.formats, ["PNG"]);
    const json = JSON.stringify(detail);
    assert.ok(!json.includes("storage_key") && !json.includes("nota interna"));
    assert.equal(detail.owner.id, undefined, "team members appear by name only");
  });

  test("staff detail shows every version and internal notes", () => {
    const detail = getMaterialDetail(req(u.managerA), f.released.material.id);
    assert.equal(detail.internalNotes, "nota interna secreta");
    assert.deepEqual(detail.versions.map((v) => v.number), [2, 1]);
    assert.equal(detail.versions[1].files.length, 4);
    assert.equal(detail.permissions.canRelease, true);
    const designerView = getMaterialDetail(req(u.designer), f.released.material.id);
    assert.equal(designerView.permissions.canRelease, false);
    assert.equal(designerView.permissions.canEdit, true);
  });

  test("filters narrow lists within scope", () => {
    const r = req(u.admin);
    assert.equal(listMaterials(r, { brandId: f.brandB }).total, 1);
    assert.equal(listMaterials(r, { visibility: "draft", brandId: f.brandA }).items.every((m) => m.visibility === "draft"), true);
    assert.equal(listMaterials(r, { categorySlug: "tipografia" }).total, 2);
    assert.equal(listMaterials(r, { archived: "1" }).total, 1);
    assert.equal(listMaterials(r, { q: "livre" }).total, 1);
    const page = listMaterials(r, {}, { page: 1, pageSize: 2 });
    assert.equal(page.items.length, 2);
    assert.ok(page.total > 2);
    // a manager without access sees nothing
    assert.equal(listMaterials(req(u.managerNone), {}).total, 0);
  });

  test("designers create drafts only inside their projects", async () => {
    const r = req(u.designer);
    const cat = categoryId(ctx, "logotipo");
    assert.equal(status(() => createMaterial(r, { brandId: f.brandA, categoryId: cat, title: "Sem projeto" })), 422);
    assert.equal(status(() => createMaterial(r, { brandId: f.brandA, projectId: f.projectA2, categoryId: cat, title: "X" })), 404);
    assert.equal(status(() => createMaterial(r, { brandId: f.brandB, categoryId: cat, title: "X" })), 404);

    const upload = await createUpload(ctx, u.designer.id, { buffer: await png(), filename: "nova-logo.png" });
    const foreign = await createUpload(ctx, u.managerA.id, { buffer: await png(), filename: "alheio.png" });
    assert.equal(
      status(() =>
        createMaterial(r, { brandId: f.brandA, projectId: f.projectA1, categoryId: cat, title: "Alheio", files: [{ uploadId: foreign.id, role: "original" }] }),
      ),
      422,
    );
    const id = createMaterial(r, {
      brandId: f.brandA,
      projectId: f.projectA1,
      categoryId: cat,
      title: "Nova logo",
      files: [{ uploadId: upload.id, role: "original", position: 1 }],
    });
    const row = ctx.db.get("SELECT * FROM materials WHERE id = ?", [id]);
    assert.equal(row.visibility, "draft");
    assert.equal(ctx.db.get("SELECT status FROM uploads WHERE id = ?", [upload.id]).status, "attached");
    assert.equal(status(() => assertMaterial(req(u.clientA), id)), 404, "drafts stay private");
    // v1 is still a draft: no second version yet
    assert.equal(status(() => createVersion(r, id, {})), 409);
    ctx.db.run("UPDATE material_versions SET status = 'released', released_at = ? WHERE material_id = ?", [now(), id]);
    const versionId = createVersion(r, id, { copyFrom: "current", changeSummary: "Ajuste de cor" });
    const v2 = ctx.db.get("SELECT * FROM material_versions WHERE id = ?", [versionId]);
    assert.equal(v2.number, 2);
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM material_files WHERE version_id = ?", [versionId]).n, 1);
    assert.ok(ctx.db.get("SELECT COUNT(*) AS n FROM activity_log WHERE material_id = ?", [id]).n >= 2);
  });
});

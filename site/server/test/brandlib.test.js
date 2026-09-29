// Brand library endpoints (routes/brandlib.js): aggregation, client filtering,
// colour/font editors, licence sync, identity release and isolation.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  addStaffAccess,
  createAgent,
  createClientWithBrand,
  createProject,
  createUser,
  insertMaterial,
  login,
  png,
  startTestServer,
  svg,
  ttf,
} from "./helpers.js";

let server;
let ctx;
const u = {};
const f = {};
const as = {};

const setVariant = async (id, variant, { primary = false, sort } = {}) =>
  await ctx.db.run("UPDATE materials SET variant = ?, is_primary = ?, sort_order = COALESCE(?, sort_order) WHERE id = ?", [
    variant,
    primary ? 1 : 0,
    sort ?? null,
    id,
  ]);

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;

  const a = await createClientWithBrand(ctx, { name: "Cliente Aurora", brandName: "Aurora" });
  const b = await createClientWithBrand(ctx, { name: "Cliente Boreal", brandName: "Boreal" });
  f.clientA = a.clientId;
  f.brandA = a.brandId;
  f.clientB = b.clientId;
  f.brandB = b.brandId;

  u.admin = await createUser(ctx, { role: "admin", name: "Ana Admin" });
  u.manager = await createUser(ctx, { role: "manager", name: "Gil Gestor" });
  u.managerOther = await createUser(ctx, { role: "manager", name: "Outro Gestor" });
  u.designer = await createUser(ctx, { role: "designer", name: "Dora Designer" });
  u.designerOther = await createUser(ctx, { role: "designer", name: "Davi Sem Projeto" });
  u.finance = await createUser(ctx, { role: "finance" });
  u.clientA = await createUser(ctx, { role: "client", clientId: f.clientA, name: "Carla Cliente" });
  u.clientB = await createUser(ctx, { role: "client", clientId: f.clientB });
  await addStaffAccess(ctx, u.manager.id, f.clientA);
  await addStaffAccess(ctx, u.managerOther.id, f.clientB);
  f.project = await createProject(ctx, { brandId: f.brandA, memberIds: [u.designer.id], includesEditables: true });

  const common = { brandId: f.brandA, projectId: f.project.id, createdBy: u.designer.id };
  f.logoMain = await insertMaterial(ctx, {
    ...common,
    title: "Logo principal",
    visibility: "released",
    requiresApproval: false,
    editableIncluded: true,
    files: [
      { role: "original", filename: "logo.svg", buffer: svg() },
      { role: "original", filename: "logo.png", buffer: await png() },
      { role: "editable", filename: "logo.ai", buffer: Buffer.from("%!PS-Adobe") },
    ],
  });
  f.logoAlt = await insertMaterial(ctx, { ...common, title: "Logo principal alternativa", visibility: "released" });
  f.logoDraft = await insertMaterial(ctx, { ...common, title: "Símbolo rascunho" });
  f.logoArchived = await insertMaterial(ctx, { ...common, title: "Logo antiga", visibility: "released", archived: true });
  f.logoLoose = await insertMaterial(ctx, { ...common, title: "Assinatura sem variante", visibility: "released" });
  await setVariant(f.logoMain.material.id, "principal", { primary: true, sort: 50 });
  await setVariant(f.logoAlt.material.id, "principal", { sort: 10 });
  await setVariant(f.logoDraft.material.id, "simbolo");
  await setVariant(f.logoArchived.material.id, "escura");
  await ctx.db.run("UPDATE materials SET internal_notes = 'nota secreta da equipe' WHERE id = ?", [f.logoMain.material.id]);

  f.manual = await insertMaterial(ctx, {
    ...common,
    title: "Manual da marca",
    categorySlug: "manual-da-marca",
    visibility: "released",
    files: [{ role: "original", filename: "manual.pdf", buffer: Buffer.from("%PDF-1.4") }],
  });
  f.pattern = await insertMaterial(ctx, { ...common, title: "Grafismos", categorySlug: "identidade-visual", visibility: "released" });
  f.fontFiles = await insertMaterial(ctx, {
    ...common,
    title: "Fontes Manrope",
    categorySlug: "tipografia",
    visibility: "released",
    files: [
      { role: "original", filename: "Manrope-Regular.ttf", buffer: ttf(), fontDistributable: false },
      { role: "original", filename: "Manrope-Bold.ttf", buffer: ttf(), fontDistributable: false },
    ],
  });
  f.fontLicensed = await insertMaterial(ctx, {
    ...common,
    title: "Fonte Institucional (licenciada)",
    categorySlug: "tipografia",
    visibility: "released",
    files: [{ role: "original", filename: "Institucional.ttf", buffer: ttf(), fontDistributable: false }],
  });
  f.content = await insertMaterial(ctx, { ...common, title: "Post de lançamento", categorySlug: "posts-carrosseis", visibility: "released" });
  f.otherBrandLogo = await insertMaterial(ctx, { brandId: f.brandB, createdBy: u.admin.id, title: "Logo Boreal", visibility: "released" });

  as.admin = await login(server, u.admin);
  as.manager = await login(server, u.manager);
  as.managerOther = await login(server, u.managerOther);
  as.designer = await login(server, u.designer);
  as.designerOther = await login(server, u.designerOther);
  as.finance = await login(server, u.finance);
  as.clientA = await login(server, u.clientA);
  as.clientB = await login(server, u.clientB);
});

after(() => server?.close());

describe("GET /api/brands/:id/library", () => {
  test("staff get every identity material grouped, primary logo first", async () => {
    const res = await as.manager.get(`/api/brands/${f.brandA}/library`);
    assert.equal(res.status, 200);
    const body = res.body;
    assert.equal(body.brand.id, f.brandA);
    assert.equal(body.brand.internalNotes, null);
    assert.deepEqual(Object.keys(body.logos), ["principal", "secundaria", "simbolo", "clara", "escura", "monocromatica", "outros"]);
    assert.deepEqual(
      body.logos.principal.map((m) => m.id),
      [f.logoMain.material.id, f.logoAlt.material.id],
      "primary comes first even with a higher sort order",
    );
    assert.equal(body.logos.principal[0].isPrimary, true);
    assert.deepEqual(body.logos.simbolo.map((m) => m.id), [f.logoDraft.material.id], "drafts are visible to staff");
    assert.deepEqual(body.logos.escura, [], "archived materials stay out");
    assert.deepEqual(body.logos.outros.map((m) => m.id), [f.logoLoose.material.id]);
    assert.deepEqual(body.manual.map((m) => m.id), [f.manual.material.id]);
    const identityIds = body.identity.map((m) => m.id);
    assert.ok(identityIds.includes(f.pattern.material.id));
    assert.ok(identityIds.includes(f.fontFiles.material.id));
    assert.ok(!identityIds.includes(f.content.material.id), "content posts are not identity");
    assert.equal(body.sections[0].category.slug, "logotipo");
    assert.ok(body.sections.every((section) => section.category.area === "identity"));
    assert.equal(body.editables.count, 1);
    assert.ok(body.counts.formats.includes("SVG") && body.counts.formats.includes("PDF"));
    assert.ok(!body.counts.formats.includes("AI") || body.counts.files > 0);
    assert.equal(body.logos.principal[0].internalNotes, "nota secreta da equipe");
    assert.ok(body.categories.some((c) => c.slug === "logotipo"));
  });

  test("clients only see released content and never internal fields", async () => {
    await ctx.db.run(
      `INSERT INTO brand_colors (id, brand_id, name, hex, sort_order, visibility, created_at, updated_at)
       VALUES ('col_testReleased0001', ?, 'Oliva', '#202619', 10, 'released', ?, ?),
              ('col_testDraft0000001', ?, 'Rascunho', '#FF0000', 20, 'draft', ?, ?)`,
      [f.brandA, new Date().toISOString(), new Date().toISOString(), f.brandA, new Date().toISOString(), new Date().toISOString()],
    );
    const res = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    assert.equal(res.status, 200);
    const body = res.body;
    const all = [...Object.values(body.logos).flat(), ...body.manual, ...body.identity];
    assert.ok(all.length > 0);
    assert.ok(all.every((m) => m.visibility === "released"));
    assert.ok(!all.some((m) => m.id === f.logoDraft.material.id), "draft logo hidden");
    assert.ok(all.every((m) => !("internalNotes" in m)), "no internal notes");
    assert.ok(!("internalNotes" in body.brand));
    assert.deepEqual(body.colors.map((c) => c.id), ["col_testReleased0001"]);
    assert.ok(!("visibility" in body.colors[0]));
    assert.equal(body.editables.count, 1, "editable included in the service");
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("storage"), "storage keys never leave the server");
    assert.ok(!raw.includes("nota secreta"));
    await ctx.db.run("DELETE FROM brand_colors WHERE brand_id = ?", [f.brandA]);
  });

  test("isolation: other client, out-of-scope staff and finance", async () => {
    assert.equal((await as.clientB.get(`/api/brands/${f.brandA}/library`)).status, 404);
    assert.equal((await as.managerOther.get(`/api/brands/${f.brandA}/library`)).status, 404);
    assert.equal((await as.designerOther.get(`/api/brands/${f.brandA}/library`)).status, 404);
    assert.equal((await as.finance.get(`/api/brands/${f.brandA}/library`)).status, 403);
    assert.equal((await createAgent(server).get(`/api/brands/${f.brandA}/library`)).status, 401);
    assert.equal((await as.clientA.get(`/api/brands/brd_doesNotExist0000/library`)).status, 404);
    const own = await as.clientB.get(`/api/brands/${f.brandB}/library`);
    assert.equal(own.status, 200);
    assert.ok(!JSON.stringify(own.body).includes(f.logoMain.material.id));
  });

  test("designers see the brands of their projects", async () => {
    const res = await as.designer.get(`/api/brands/${f.brandA}/library`);
    assert.equal(res.status, 200);
    assert.ok(res.body.logos.simbolo.length === 1);
  });
});

describe("colours", () => {
  let colorId;

  test("create validates HEX with pt-BR messages", async () => {
    const bad = await as.designer.post(`/api/brands/${f.brandA}/colors`, { name: "", hex: "verde" });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.fields.hex, "Use o formato #RRGGBB.");
    assert.equal(bad.body.error.fields.name, "Dê um nome à cor.");

    const res = await as.designer.post(`/api/brands/${f.brandA}/colors`, {
      name: "Oliva profundo",
      hex: "#20261a",
      rgb: "32, 38, 26",
      role: "Primária",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.color.hex, "#20261A");
    assert.equal(res.body.color.visibility, "draft");
    colorId = res.body.color.id;
    const second = await as.manager.post(`/api/brands/${f.brandA}/colors`, { name: "Areia", hex: "#EDE9DF" });
    assert.equal(second.status, 201);
    assert.ok(second.body.color.sortOrder > res.body.color.sortOrder);
    f.secondColor = second.body.color.id;
  });

  test("isolation on colours", async () => {
    assert.equal((await as.clientA.post(`/api/brands/${f.brandA}/colors`, { name: "X", hex: "#000000" })).status, 403);
    assert.equal((await as.managerOther.post(`/api/brands/${f.brandA}/colors`, { name: "X", hex: "#000000" })).status, 404);
    assert.equal((await as.designerOther.patch(`/api/colors/${colorId}`, { name: "X" })).status, 404);
    assert.equal((await as.managerOther.del(`/api/colors/${colorId}`)).status, 404);
    assert.equal((await as.finance.patch(`/api/colors/${colorId}`, { name: "X" })).status, 403);
  });

  test("patch, reorder and hidden from clients until released", async () => {
    const patched = await as.designer.patch(`/api/colors/${colorId}`, { usage: "Fundos e títulos", pantone: "" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.color.usage, "Fundos e títulos");
    assert.equal(patched.body.color.pantone, null);

    const designerRelease = await as.designer.patch(`/api/colors/${colorId}`, { visibility: "released" });
    assert.equal(designerRelease.status, 403, "designers do not release");

    const reorder = await as.designer.post(`/api/brands/${f.brandA}/colors/reorder`, { ids: [f.secondColor, colorId] });
    assert.equal(reorder.status, 200);
    assert.deepEqual(reorder.body.items.map((c) => c.id), [f.secondColor, colorId]);
    const foreign = await as.manager.post(`/api/brands/${f.brandA}/colors/reorder`, { ids: ["col_notFromThisBrand"] });
    assert.equal(foreign.status, 422);

    const client = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    assert.deepEqual(client.body.colors, []);
  });
});

describe("fonts and licence", () => {
  let fontId;

  test("linking a font material syncs font_distributable", async () => {
    const wrong = await as.manager.post(`/api/brands/${f.brandA}/fonts`, {
      family: "Manrope",
      distribution: "allowed",
      materialId: f.otherBrandLogo.material.id,
    });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.body.error.fields.materialId);

    const badUrl = await as.manager.post(`/api/brands/${f.brandA}/fonts`, { family: "Manrope", sourceUrl: "ftp://x" });
    assert.equal(badUrl.status, 422);
    assert.ok(badUrl.body.error.fields.sourceUrl);

    const res = await as.manager.post(`/api/brands/${f.brandA}/fonts`, {
      family: "Manrope",
      role: "Textos",
      weights: ["400", "500"],
      sourceUrl: "https://fonts.google.com/specimen/Manrope",
      license: "SIL Open Font License",
      distribution: "allowed",
      materialId: f.fontFiles.material.id,
    });
    assert.equal(res.status, 201);
    fontId = res.body.font.id;
    assert.equal(res.body.font.weights, "400, 500");
    assert.equal(res.body.font.files.length, 2, "staff see the linked files");
    // a draft font never makes files downloadable: the licence reaches the client with the release
    const flags = await ctx.db.all("SELECT font_distributable FROM material_files WHERE material_id = ?", [f.fontFiles.material.id]);
    assert.ok(flags.every((row) => row.font_distributable === 0));
    const link = await as.clientA.post("/api/downloads/link", { fileId: f.fontFiles.files[0].id });
    assert.equal(link.status, 403);
    assert.equal(link.body.error.code, "font_license");
  });

  test("clients receive files only when distribution is allowed", async () => {
    const release = await as.manager.post(`/api/brands/${f.brandA}/identity/release`, { colorIds: [], fontIds: [fontId], notify: false });
    assert.equal(release.status, 200);
    assert.equal(release.body.released.fonts, 1);
    const released = await ctx.db.all("SELECT font_distributable FROM material_files WHERE material_id = ?", [f.fontFiles.material.id]);
    assert.ok(released.every((row) => row.font_distributable === 1), "released + allowed: distributable");
    assert.equal((await as.clientA.post("/api/downloads/link", { fileId: f.fontFiles.files[0].id })).status, 200);

    let lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    let font = lib.body.fonts.find((item) => item.id === fontId);
    assert.equal(font.files.length, 2);
    assert.ok(font.files.every((file) => file.downloadable));
    assert.ok(!("visibility" in font));

    const designerChange = await as.designer.patch(`/api/fonts/${fontId}`, { distribution: "reference_only" });
    assert.equal(designerChange.status, 403, "licence of a released font needs a manager");

    const change = await as.manager.patch(`/api/fonts/${fontId}`, { distribution: "reference_only" });
    assert.equal(change.status, 200);
    const flags = await ctx.db.all("SELECT font_distributable FROM material_files WHERE material_id = ?", [f.fontFiles.material.id]);
    assert.ok(flags.every((row) => row.font_distributable === 0));

    lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    font = lib.body.fonts.find((item) => item.id === fontId);
    assert.deepEqual(font.files, [], "reference only: no files");
    assert.equal(font.sourceUrl, "https://fonts.google.com/specimen/Manrope");
  });

  test("isolation on fonts", async () => {
    assert.equal((await as.clientB.patch(`/api/fonts/${fontId}`, { family: "X" })).status, 403);
    assert.equal((await as.managerOther.patch(`/api/fonts/${fontId}`, { family: "X" })).status, 404);
    assert.equal((await as.designerOther.del(`/api/fonts/${fontId}`)).status, 404);
    assert.equal((await as.designer.del(`/api/fonts/${fontId}`)).status, 403, "released: manager only");
  });

  test("a designer cannot make a licensed font downloadable (draft font or re-link)", async () => {
    const licensedFile = f.fontLicensed.files[0].id;
    const clientLink = async () => (await as.clientA.post("/api/downloads/link", { fileId: licensedFile })).body?.error?.code ?? "ok";
    assert.equal(await clientLink(), "font_license");

    // (a) draft font marked "allowed" linked to the released licensed material
    const draft = await as.designer.post(`/api/brands/${f.brandA}/fonts`, {
      family: "Institucional",
      distribution: "allowed",
      materialId: f.fontLicensed.material.id,
    });
    assert.equal(draft.status, 201);
    assert.equal(draft.body.font.visibility, "draft");
    assert.equal(await clientLink(), "font_license", "draft licence does not reach the client");

    // new files attached to that material follow the released licence too (trigger, migration 010)
    await ctx.db.run(
      `INSERT INTO material_files (id, version_id, material_id, role, position, original_name, display_name, ext, mime, size_bytes,
         sha256, storage_key, media_kind, preview_status, font_distributable, created_at)
       SELECT 'fil_triggerCheck0001', version_id, material_id, role, 9, 'Nova.ttf', 'Nova.ttf', ext, mime, size_bytes, sha256,
         storage_key, media_kind, preview_status, 1, created_at FROM material_files WHERE id = ?`,
      [licensedFile],
    );
    assert.equal((await ctx.db.get("SELECT font_distributable FROM material_files WHERE id = 'fil_triggerCheck0001'")).font_distributable, 0);
    await ctx.db.run("DELETE FROM material_files WHERE id = 'fil_triggerCheck0001'");

    // (b) re-linking a released "allowed" font to the licensed material needs a manager
    const open = await as.manager.post(`/api/brands/${f.brandA}/fonts`, {
      family: "Aberta",
      distribution: "allowed",
      materialId: f.fontFiles.material.id,
    });
    assert.equal(open.status, 201);
    const openRelease = await as.manager.post(`/api/brands/${f.brandA}/identity/release`, {
      colorIds: [],
      fontIds: [open.body.font.id],
      guidelines: false,
      notify: false,
    });
    assert.equal(openRelease.status, 200);
    const relink = await as.designer.patch(`/api/fonts/${open.body.font.id}`, { materialId: f.fontLicensed.material.id });
    assert.equal(relink.status, 403);
    assert.match(relink.body.error.message, /Peça a um gestor/);
    assert.equal(await clientLink(), "font_license");
    assert.equal((await ctx.db.get("SELECT material_id FROM brand_fonts WHERE id = ?", [open.body.font.id])).material_id, f.fontFiles.material.id);

    // releasing the draft "allowed" font (manager, with the summary) is what opens the download
    const draftRelease = await as.manager.post(`/api/brands/${f.brandA}/identity/release`, {
      colorIds: [],
      fontIds: [draft.body.font.id],
      guidelines: false,
      notify: false,
    });
    assert.equal(draftRelease.status, 200);
    assert.equal(await clientLink(), "ok");
    // hiding it again closes it
    assert.equal((await as.manager.patch(`/api/fonts/${draft.body.font.id}`, { visibility: "draft" })).status, 200);
    assert.equal(await clientLink(), "font_license");
    assert.equal((await as.manager.del(`/api/fonts/${draft.body.font.id}`)).status, 204);
    assert.equal((await as.manager.del(`/api/fonts/${open.body.font.id}`)).status, 204);
  });

  test("released fonts: only release-capable staff change what the client reads", async () => {
    const created = await as.designer.post(`/api/brands/${f.brandA}/fonts`, {
      family: "Raleway",
      sourceUrl: "https://fonts.google.com/specimen/Raleway",
    });
    const id = created.body.font.id;
    // drafts stay editable by the designer
    assert.equal((await as.designer.patch(`/api/fonts/${id}`, { role: "Títulos" })).status, 200);
    const released = await as.manager.post(`/api/brands/${f.brandA}/identity/release`, { colorIds: [], fontIds: [id], guidelines: false, notify: false });
    assert.equal(released.status, 200);

    for (const body of [{ sourceUrl: "https://attacker.example/phish" }, { family: "Outra" }, { weights: ["900"] }, { license: "Qualquer" }, { usage: "x" }]) {
      const res = await as.designer.patch(`/api/fonts/${id}`, body);
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.equal(res.body.error.message, "Esta tipografia já está visível ao cliente. Peça a um gestor para alterá-la.");
    }
    // sending the same values is not a change
    assert.equal((await as.designer.patch(`/api/fonts/${id}`, { family: "Raleway", role: "Títulos" })).status, 200);
    let lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    let font = lib.body.fonts.find((item) => item.id === id);
    assert.equal(font.sourceUrl, "https://fonts.google.com/specimen/Raleway");
    assert.equal(font.family, "Raleway");

    const manager = await as.manager.patch(`/api/fonts/${id}`, { usage: "Títulos curtos" });
    assert.equal(manager.status, 200);
    lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    font = lib.body.fonts.find((item) => item.id === id);
    assert.equal(font.usage, "Títulos curtos");
    assert.equal((await as.manager.del(`/api/fonts/${id}`)).status, 204);
  });

  test("deleting the font clears the licence flag", async () => {
    await as.manager.patch(`/api/fonts/${fontId}`, { distribution: "allowed" });
    assert.equal((await as.manager.del(`/api/fonts/${fontId}`)).status, 204);
    const flags = await ctx.db.all("SELECT font_distributable FROM material_files WHERE material_id = ?", [f.fontFiles.material.id]);
    assert.ok(flags.every((row) => row.font_distributable === 0));
  });
});

describe("identity release and guidelines", () => {
  test("only release-capable staff release; client is notified", async () => {
    assert.equal((await as.designer.post(`/api/brands/${f.brandA}/identity/release`, {})).status, 403);
    assert.equal((await as.managerOther.post(`/api/brands/${f.brandA}/identity/release`, {})).status, 404);
    assert.equal((await as.clientA.post(`/api/brands/${f.brandA}/identity/release`, {})).status, 403);

    const res = await as.manager.post(`/api/brands/${f.brandA}/identity/release`, { notifyEmail: true, message: "Paleta final" });
    assert.equal(res.status, 200);
    assert.equal(res.body.released.colors, 2);
    assert.ok(res.body.colors.every((c) => c.visibility === "released"));
    assert.equal(res.body.recipients, 1);

    const notification = await ctx.db.get("SELECT * FROM notifications WHERE user_id = ? AND type = 'identity_released'", [u.clientA.id]);
    assert.ok(notification);
    assert.equal(notification.link, "/painel/marca");
    const activity = await ctx.db.get(
      "SELECT * FROM activity_log WHERE action = 'brand.identity_released' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(activity.visibility, "client");
    assert.equal(activity.client_id, f.clientA);
    assert.equal((await ctx.db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?", [u.clientB.id])).n, 0);

    const again = await as.manager.post(`/api/brands/${f.brandA}/identity/release`, {});
    assert.equal(again.status, 422, "nothing new to release");

    const lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    assert.equal(lib.body.colors.length, 2);
  });

  test("released colours: designers cannot change what the client sees", async () => {
    const color = await ctx.db.get("SELECT * FROM brand_colors WHERE brand_id = ? AND visibility = 'released' ORDER BY sort_order LIMIT 1", [f.brandA]);
    for (const body of [{ hex: "#FF0000" }, { name: "Vermelho" }, { usage: "Qualquer uso" }, { pantone: "Pantone 185 C" }]) {
      const res = await as.designer.patch(`/api/colors/${color.id}`, body);
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.equal(res.body.error.message, "Esta cor já está visível ao cliente. Peça a um gestor para alterá-la.");
    }
    // same values (e.g. lower-case HEX) are not a change
    assert.equal((await as.designer.patch(`/api/colors/${color.id}`, { hex: color.hex.toLowerCase(), name: color.name })).status, 200);
    let lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    assert.equal(lib.body.colors.find((c) => c.id === color.id).hex, color.hex);

    const manager = await as.manager.patch(`/api/colors/${color.id}`, { usage: "Fundos institucionais" });
    assert.equal(manager.status, 200);
    lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    assert.equal(lib.body.colors.find((c) => c.id === color.id).usage, "Fundos institucionais");
  });

  test("released colours can only be hidden or removed by release-capable staff", async () => {
    const color = await ctx.db.get("SELECT id FROM brand_colors WHERE brand_id = ? AND visibility = 'released' LIMIT 1", [f.brandA]);
    assert.equal((await as.designer.del(`/api/colors/${color.id}`)).status, 403);
    const hide = await as.manager.patch(`/api/colors/${color.id}`, { visibility: "draft" });
    assert.equal(hide.status, 200);
    assert.equal(hide.body.color.visibility, "draft");
    assert.equal((await as.designer.del(`/api/colors/${color.id}`)).status, 204);
  });

  test("guidelines are saved as a draft through the brand scope; the client keeps the released text", async () => {
    const res = await as.designer.patch(`/api/brands/${f.brandA}/guidelines`, {
      usageGuidelines: "Respeite a área de proteção.",
      typographyGuidelines: "Títulos em Raleway 300.",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.brand.usageGuidelines, null, "released text unchanged");
    assert.equal(res.body.brand.usageGuidelinesDraft, "Respeite a área de proteção.");
    assert.equal(res.body.brand.typographyGuidelinesDraft, "Títulos em Raleway 300.");
    assert.equal(res.body.brand.hasUnreleasedGuidelines, true);
    assert.equal((await as.managerOther.patch(`/api/brands/${f.brandA}/guidelines`, { usageGuidelines: "x" })).status, 404);
    assert.equal((await as.clientA.patch(`/api/brands/${f.brandA}/guidelines`, { usageGuidelines: "x" })).status, 403);

    // designer and manager drafts never reach the client
    assert.equal((await as.manager.patch(`/api/brands/${f.brandA}`, { usageGuidelines: "TEXTO NÃO REVISADO" })).status, 200);
    for (const path of [`/api/brands/${f.brandA}/library`, `/api/brands/${f.brandA}`, "/api/brands"]) {
      const seen = await as.clientA.get(path);
      assert.equal(seen.status, 200, path);
      const raw = JSON.stringify(seen.body);
      assert.ok(!raw.includes("NÃO REVISADO") && !raw.includes("Raleway 300") && !raw.includes("Draft"), path);
    }
    let lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    assert.equal(lib.body.brand.usageGuidelines, null);
    assert.equal(lib.body.brand.typographyGuidelines, null);

    // designers cannot publish it
    assert.equal((await as.designer.post(`/api/brands/${f.brandA}/identity/release`, { guidelines: true })).status, 403);

    const release = await as.admin.post(`/api/brands/${f.brandA}/identity/release`, { colorIds: [], fontIds: [], guidelines: true });
    assert.equal(release.status, 200);
    assert.equal(release.body.released.guidelines, true);
    assert.equal(release.body.brand.hasUnreleasedGuidelines, false);
    assert.ok(release.body.brand.guidelinesReleasedAt);
    lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    assert.equal(lib.body.brand.usageGuidelines, "TEXTO NÃO REVISADO");
    assert.equal(lib.body.brand.typographyGuidelines, "Títulos em Raleway 300.");
    const logged = await ctx.db.get("SELECT * FROM activity_log WHERE action = 'brand.identity_released' ORDER BY id DESC LIMIT 1");
    assert.match(logged.summary, /orientações de uso e de tipografia/);

    // nothing new: guidelines do not count again
    assert.equal((await as.admin.post(`/api/brands/${f.brandA}/identity/release`, { colorIds: [], fontIds: [], guidelines: true })).status, 422);

    // editing back to the released text leaves no draft behind
    await as.designer.patch(`/api/brands/${f.brandA}/guidelines`, { usageGuidelines: "Outra versão" });
    const back = await as.designer.patch(`/api/brands/${f.brandA}/guidelines`, { usageGuidelines: "TEXTO NÃO REVISADO" });
    assert.equal(back.body.brand.hasUnreleasedGuidelines, false);
    assert.equal((await as.admin.post(`/api/brands/${f.brandA}/identity/release`, { colorIds: [], fontIds: [], guidelines: true })).status, 422);

    // clearing a released text is a draft change too, published only by the identity release
    await as.designer.patch(`/api/brands/${f.brandA}/guidelines`, { typographyGuidelines: "" });
    lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    assert.equal(lib.body.brand.typographyGuidelines, "Títulos em Raleway 300.");
    const cleared = await as.manager.post(`/api/brands/${f.brandA}/identity/release`, { colorIds: [], fontIds: [], notify: false });
    assert.equal(cleared.status, 200, "omitted guidelines = release the pending draft");
    lib = await as.clientA.get(`/api/brands/${f.brandA}/library`);
    assert.equal(lib.body.brand.typographyGuidelines, null);
  });
});

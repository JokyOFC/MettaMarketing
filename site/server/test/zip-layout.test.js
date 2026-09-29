// ZIP layout of docs/PLATFORM.md §5 (services/materials.js zipEntries/zipFilename).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { localDay, loadMaterialRows, zipEntries, zipFilename } from "../services/materials.js";
import { createClientWithBrand, createUser, fakeReq, insertMaterial, png, startTestServer, svg, ttf } from "./helpers.js";

let server;
let ctx;
let admin;
let clientUser;
let brandId;
let brandName;

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;
  admin = await createUser(ctx, { role: "admin" });
  const created = await createClientWithBrand(ctx, { brandName: "Aurora" });
  brandId = created.brandId;
  brandName = created.brand.name;
  clientUser = await createUser(ctx, { role: "client", clientId: created.clientId });
});
after(() => server?.close());

const released = (opts) => insertMaterial(ctx, { brandId, createdBy: admin.id, visibility: "released", ...opts });
const paths = async (req, materials, options) =>
  (await zipEntries(req, await loadMaterialRows(ctx.db, materials.map((m) => m.material.id)), options)).map((e) => e.path);

describe("zipEntries", () => {
  test("identity files go by format, editables apart, covers never", async () => {
    const logo = await released({
      title: "Logo principal",
      editableIncluded: true,
      files: [
        { role: "original", filename: "logo.png", buffer: await png() },
        { role: "original", filename: "logo.svg", buffer: Buffer.from(svg()) },
        { role: "editable", filename: "logo.ai", buffer: Buffer.from("%PDF-1.4 ai") },
        { role: "cover", filename: "capa.png", buffer: await png() },
      ],
    });
    const list = await paths(fakeReq(ctx, clientUser), [logo]);
    assert.deepEqual(list.sort(), [
      `${brandName}/Identidade visual/Logos/Editáveis/logo.ai`,
      `${brandName}/Identidade visual/Logos/PNG/logo.png`,
      `${brandName}/Identidade visual/Logos/SVG/logo.svg`,
    ]);
  });

  test("finals replace originals; editables need editable_included for clients", async () => {
    const logo = await released({
      title: "Símbolo",
      editableIncluded: false,
      files: [
        { role: "original", filename: "rascunho.png", buffer: await png() },
        { role: "final", filename: "simbolo.png", buffer: await png() },
        { role: "editable", filename: "simbolo.ai", buffer: Buffer.from("%PDF-1.4 ai") },
      ],
    });
    assert.deepEqual(await paths(fakeReq(ctx, clientUser), [logo]), [`${brandName}/Identidade visual/Logos/PNG/simbolo.png`]);
    const staff = await paths(fakeReq(ctx, admin), [logo]);
    assert.ok(staff.includes(`${brandName}/Identidade visual/Logos/Editáveis/simbolo.ai`));
    assert.ok(!staff.some((p) => p.endsWith("rascunho.png")));
    assert.deepEqual(await paths(fakeReq(ctx, admin), [logo], { includeEditables: false }), [
      `${brandName}/Identidade visual/Logos/PNG/simbolo.png`,
    ]);
  });

  test("posts: month, campaign, title and numbered slides in slide order", async () => {
    const post = await released({
      kind: "post",
      categorySlug: "posts-carrosseis",
      title: "Lançamento / Pix",
      plannedDate: "2026-10-05",
      files: [
        { role: "original", filename: "c.png", buffer: await png(), position: 3 },
        { role: "original", filename: "a.png", buffer: await png(), position: 1 },
        { role: "original", filename: "b.png", buffer: await png(), position: 2 },
      ],
    });
    const dir = `${brandName}/Conteúdo/2026-10/Sem campanha/Lançamento-Pix`;
    assert.deepEqual(await paths(fakeReq(ctx, clientUser), [post]), [`${dir}/01-a.png`, `${dir}/02-b.png`, `${dir}/03-c.png`]);
    assert.deepEqual(await paths(fakeReq(ctx, clientUser), [post], { layout: "carousel", root: `${brandName} - Lançamento` }), [
      `${brandName} - Lançamento/01-a.png`,
      `${brandName} - Lançamento/02-b.png`,
      `${brandName} - Lançamento/03-c.png`,
    ]);
  });

  test("other areas, name collisions and client download rules", async () => {
    const deck = await released({ categorySlug: "apresentacoes", title: "Deck", files: [{ filename: "deck.pdf", buffer: Buffer.from("%PDF-1.4") }] });
    const deck2 = await released({ categorySlug: "apresentacoes", title: "Deck 2", files: [{ filename: "deck.pdf", buffer: Buffer.from("%PDF-1.4") }] });
    const locked = await released({ categorySlug: "apresentacoes", title: "Sem download", downloadEnabled: false, files: [{ filename: "x.pdf", buffer: Buffer.from("%PDF-1.4") }] });
    const font = await released({
      categorySlug: "tipografia",
      title: "Fonte",
      files: [{ filename: "marca.ttf", buffer: ttf(), fontDistributable: false }],
    });
    const client = await paths(fakeReq(ctx, clientUser), [deck, deck2, locked, font]);
    assert.deepEqual(client.sort(), [`${brandName}/Materiais/Apresentações/deck (2).pdf`, `${brandName}/Materiais/Apresentações/deck.pdf`]);
    // identity categories come first, whatever order the rows were loaded in
    const staff = await paths(fakeReq(ctx, admin), [locked, font]);
    assert.deepEqual(staff, [`${brandName}/Identidade visual/Tipografia/TTF/marca.ttf`, `${brandName}/Materiais/Apresentações/x.pdf`]);
    assert.deepEqual(await paths(fakeReq(ctx, admin), [font, locked]), staff);
  });

  test("entries carry what the ZIP job needs", async () => {
    const logo = await released({ title: "Logo clara" });
    const [entry] = await zipEntries(fakeReq(ctx, clientUser), await loadMaterialRows(ctx.db, [logo.material.id]));
    assert.equal(entry.fileId, logo.files[0].id);
    assert.equal(entry.materialId, logo.material.id);
    assert.equal(entry.versionId, logo.version.id);
    assert.equal(entry.storageKey, logo.files[0].storage_key);
    assert.equal(entry.store, true);
    assert.ok(entry.sizeBytes > 0);
  });
});

test("zipFilename", () => {
  assert.equal(zipFilename("Aurora Pagamentos", "Kit de marca", new Date("2026-09-28T12:00:00Z")), "aurora-pagamentos-kit-de-marca-2026-09-28.zip");
  // São Paulo calendar: 00:00 UTC on 2 Jan is still 1 Jan (21:00 BRT)
  assert.equal(zipFilename("Ação", "Identidade visual", "2026-01-02T00:00:00Z"), "acao-identidade-visual-2026-01-01.zip");
  // a plain calendar date is kept as is
  assert.equal(zipFilename("Ação", "Identidade visual", "2026-01-02"), "acao-identidade-visual-2026-01-02.zip");
});

test("dates follow São Paulo, not UTC (23:30 BRT is still the same day)", () => {
  // 28 Sep 2026, 23:30 in São Paulo = 29 Sep, 02:30 UTC
  const lateEvening = new Date("2026-09-29T02:30:00Z");
  assert.equal(localDay(lateEvening), "2026-09-28");
  assert.equal(zipFilename("Aurora", "Kit de marca", lateEvening), "aurora-kit-de-marca-2026-09-28.zip");
  assert.equal(localDay("2026-09-29T03:00:00Z"), "2026-09-29", "midnight in São Paulo");
  assert.equal(localDay("não é data"), null);
});

test("a post released on the last evening of a month stays in that month's folder", async () => {
  const post = await released({
    kind: "post",
    categorySlug: "posts-carrosseis",
    title: "Fim de mês",
    files: [{ role: "original", filename: "arte.png", buffer: await png() }],
  });
  // 30 Sep 2026, 23:30 BRT = 1 Oct, 02:30 UTC; no planned date
  await ctx.db.run("UPDATE materials SET released_at = ? WHERE id = ?", ["2026-10-01T02:30:00.000Z", post.material.id]);
  assert.deepEqual(await paths(fakeReq(ctx, clientUser), [post]), [`${brandName}/Conteúdo/2026-09/Sem campanha/Fim de mês/01-arte.png`]);
});

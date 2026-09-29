// Slice A — temporary download links, download rules, ZIP packages (layout,
// progress, ownership, failures, expiry) and the download history.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { after, before, describe, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { createSigner } from "../lib/signed.js";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";
import { expireZips, failInterruptedZips, runZipJob } from "../services/zips.js";
import { zipFilename } from "../services/materials.js";
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
  waitFor,
} from "./helpers.js";

function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "zip end record");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    entries.push({ name, method, data: method === 0 ? raw : inflateRawSync(raw) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

let server;
let ctx;
let db;
const u = {};
const a = {};
const f = {};

async function startZip(agent, scope) {
  const res = await agent.post("/api/zips", { scope });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  return res.body.job;
}
async function finished(agent, jobId) {
  return waitFor(async () => {
    const res = await agent.get(`/api/zips/${jobId}`);
    return ["ready", "failed"].includes(res.body.job?.status) ? res.body.job : null;
  });
}
async function downloadZip(agent, scope) {
  const job = await finished(agent, (await startZip(agent, scope)).id);
  assert.equal(job.status, "ready", job.error ?? "");
  const link = await agent.post(`/api/zips/${job.id}/link`);
  const res = await agent.get(link.body.url);
  assert.equal(res.status, 200);
  return { job, entries: readZip(res.body), res };
}

before(async () => {
  server = await startTestServer();
  ctx = server.ctx;
  db = server.db;
  const A = await createClientWithBrand(ctx, { name: "Aurora Pagamentos", brandName: "Aurora" });
  const B = await createClientWithBrand(ctx, { name: "Boreal", brandName: "Boreal" });
  f.brandA = A.brandId;
  f.brandB = B.brandId;
  u.admin = await createUser(ctx, { role: "admin" });
  u.manager = await createUser(ctx, { role: "manager" });
  u.clientA = await createUser(ctx, { role: "client", clientId: A.clientId });
  u.clientA2 = await createUser(ctx, { role: "client", clientId: A.clientId });
  u.clientB = await createUser(ctx, { role: "client", clientId: B.clientId });
  await addStaffAccess(ctx, u.manager.id, A.clientId);
  f.project = (await createProject(ctx, { brandId: A.brandId, name: "Identidade" })).id;

  f.logoPng = await png({ width: 200, height: 100 });
  f.logoSvg = svg();
  const released = (opts) => insertMaterial(ctx, { brandId: A.brandId, createdBy: u.admin.id, visibility: "released", ...opts });
  f.logo = await released({
    title: "Logo principal",
    projectId: f.project,
    files: [
      { role: "original", filename: "logo.png", buffer: f.logoPng },
      { role: "original", filename: "logo.svg", buffer: f.logoSvg },
      { role: "editable", filename: "logo.ai", buffer: Buffer.from("%PDF-1.4 ai") },
      { role: "cover", filename: "capa.png", buffer: await png() },
    ],
  });
  f.noDownload = await released({ title: "Paleta", categorySlug: "paleta-de-cores", downloadEnabled: false, files: [{ filename: "paleta.pdf", buffer: Buffer.from("%PDF-1.4 paleta") }] });
  f.fontLocked = await released({ title: "Fonte licenciada", categorySlug: "tipografia", files: [{ filename: "Marca.ttf", buffer: ttf(), fontDistributable: false }] });
  f.fontFree = await released({ title: "Fonte livre", categorySlug: "tipografia", files: [{ filename: "Livre.otf", buffer: ttf(), fontDistributable: true }] });
  f.draft = await insertMaterial(ctx, { brandId: A.brandId, createdBy: u.admin.id, title: "Rascunho", files: [{ filename: "wip.png", buffer: await png() }] });
  f.logoB = await insertMaterial(ctx, { brandId: B.brandId, createdBy: u.admin.id, visibility: "released", title: "Logo B" });
  for (const [key, user] of Object.entries(u)) a[key] = await login(server, { email: user.email });
});

after(async () => {
  await server?.close();
});

describe("single downloads", () => {
  test("temporary link -> attachment with the original name and bytes, logged, approval untouched", async () => {
    const [pngFile] = f.logo.files;
    const link = await a.clientA.post("/api/downloads/link", { fileId: pngFile.id });
    assert.equal(link.status, 200);
    assert.match(link.body.url, /^\/dl\/[\w-]+\.[\w-]+$/);
    assert.ok(new Date(link.body.expiresAt).getTime() > Date.now());
    const res = await a.clientA.get(link.body.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="logo.png"/);
    assert.ok(res.body.equals(f.logoPng), "original quality");
    const event = await db.get("SELECT * FROM download_events WHERE file_id = ?", [pngFile.id]);
    assert.equal(event.kind, "file");
    assert.equal(event.user_id, u.clientA.id);
    assert.equal(event.material_id, f.logo.material.id);
    assert.equal((await db.get("SELECT approval_status FROM materials WHERE id = ?", [f.logo.material.id])).approval_status, "pending");

    const history = await a.manager.get(`/api/materials/${f.logo.material.id}/history`);
    const entry = history.body.downloads.find((d) => d.fileId === pngFile.id);
    assert.equal(entry.isApproval, false);
    assert.match(entry.note, /não indica aprovação/);
    assert.ok(history.body.items.some((item) => item.type === "download" && item.isApproval === false));
  });

  test("SVG downloads as attachment, never inline", async () => {
    const svgFile = f.logo.files[1];
    const link = await a.clientA.post("/api/downloads/link", { fileId: svgFile.id });
    const res = await a.clientA.get(link.body.url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /^attachment/);
    assert.match(res.headers.get("content-security-policy"), /sandbox/);
  });

  test("a link is bound to its user and re-checked on redemption", async () => {
    const [pngFile] = f.logo.files;
    const link = await a.clientA.post("/api/downloads/link", { fileId: pngFile.id });
    assert.equal((await a.clientA2.get(link.body.url)).status, 403, "same client, other person");
    assert.equal((await a.manager.get(link.body.url)).status, 403);
    assert.equal((await createAgent(server).get(link.body.url)).status, 401);
    const [body, mac] = link.body.url.slice(4).split(".");
    assert.equal((await a.clientA.get(`/dl/${body}.${mac.slice(0, -2)}xx`)).status, 404, "tampered");
    // a link issued before the download was disabled no longer works
    await db.run("UPDATE materials SET download_enabled = 0 WHERE id = ?", [f.logo.material.id]);
    const late = await a.clientA.get(link.body.url);
    assert.equal(late.status, 403);
    assert.equal(late.body.error.code, "download_disabled");
    await db.run("UPDATE materials SET download_enabled = 1 WHERE id = ?", [f.logo.material.id]);
  });

  test("expired links answer 410", async () => {
    const realNow = Date.now;
    let token;
    try {
      Date.now = () => realNow() - 3600 * 1000;
      token = ctx.signer.sign({ t: "file", id: f.logo.files[0].id, u: u.clientA.id }, 300);
    } finally {
      Date.now = realNow;
    }
    const res = await a.clientA.get(`/dl/${token}`);
    assert.equal(res.status, 410);
    assert.equal(res.body.error.code, "expired");
    // a token signed with another secret is just invalid
    const foreign = createSigner("outro-segredo-qualquer-com-32-caracteres").sign({ t: "file", id: f.logo.files[0].id, u: u.clientA.id });
    assert.equal((await a.clientA.get(`/dl/${foreign}`)).status, 404);
  });

  test("download rules: disabled, editables not included, font licence, covers", async () => {
    const disabled = await a.clientA.post("/api/downloads/link", { fileId: f.noDownload.files[0].id });
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.error.code, "download_disabled");
    // still visible, but the PDF itself is not streamed (it is the original)
    const detail = await a.clientA.get(`/api/materials/${f.noDownload.material.id}`);
    const pdfFile = detail.body.material.versions[0].files[0];
    assert.equal(pdfFile.downloadable, false);
    assert.equal(pdfFile.previews.stream, null);
    assert.equal((await a.clientA.get(`/api/files/${pdfFile.id}/stream`)).status, 403);
    assert.equal((await a.manager.get(`/api/files/${pdfFile.id}/stream`)).status, 200);

    const editable = f.logo.files[2];
    assert.equal((await a.clientA.post("/api/downloads/link", { fileId: editable.id })).status, 404);
    const logoDetail = await a.clientA.get(`/api/materials/${f.logo.material.id}`);
    assert.ok(!logoDetail.body.material.versions[0].files.some((file) => file.role === "editable"));
    assert.equal((await a.manager.post("/api/downloads/link", { fileId: editable.id })).status, 200, "staff keeps access");

    const font = await a.clientA.post("/api/downloads/link", { fileId: f.fontLocked.files[0].id });
    assert.equal(font.status, 403);
    assert.equal(font.body.error.code, "font_license");
    assert.equal((await a.clientA.post("/api/downloads/link", { fileId: f.fontFree.files[0].id })).status, 200);

    const cover = await a.clientA.post("/api/downloads/link", { fileId: f.logo.files[3].id });
    assert.equal(cover.status, 403);
    // ZIP selections obey the same rules
    assert.equal((await a.clientA.post("/api/zips", { scope: { type: "selection", fileIds: [f.noDownload.files[0].id] } })).status, 403);
    assert.equal((await a.clientA.post("/api/zips", { scope: { type: "selection", fileIds: [editable.id] } })).status, 404);
  });
});

describe("ZIP packages", () => {
  test("brand kit: Marca/Identidade visual/Logos/<FORMATO>, real progress, stored PNG", async () => {
    const { job, entries, res } = await downloadZip(a.clientA, { type: "brand_kit", brandId: f.brandA });
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, [
      "Aurora/Identidade visual/Logos/PNG/logo.png",
      "Aurora/Identidade visual/Logos/SVG/logo.svg",
      "Aurora/Identidade visual/Tipografia/OTF/Livre.otf",
    ]);
    assert.equal(job.label, "Kit de marca · Aurora");
    assert.match(job.filename, /^aurora-kit-de-marca-\d{4}-\d{2}-\d{2}\.zip$/);
    assert.equal(job.progress, 1);
    assert.equal(job.processedBytes, job.totalBytes);
    assert.equal(job.fileCount, 3);
    assert.deepEqual(job.scope, { type: "brand_kit", brandId: f.brandA });
    const pngEntry = entries.find((e) => e.name.endsWith("logo.png"));
    const svgEntry = entries.find((e) => e.name.endsWith("logo.svg"));
    assert.equal(pngEntry.method, 0, "already compressed: store");
    assert.equal(svgEntry.method, 8, "text formats: deflate");
    assert.ok(pngEntry.data.equals(f.logoPng));
    assert.ok(svgEntry.data.equals(f.logoSvg));
    assert.equal(res.headers.get("content-type"), "application/zip");
    const event = await db.get("SELECT * FROM download_events WHERE zip_job_id = ?", [job.id]);
    assert.equal(event.kind, "zip");
    assert.deepEqual(JSON.parse(event.scope), { type: "brand_kit", brandId: f.brandA });

    // staff with editables get them in "Editáveis"
    const staff = await downloadZip(a.manager, { type: "brand_kit", brandId: f.brandA });
    assert.ok(staff.entries.some((e) => e.name === "Aurora/Identidade visual/Logos/Editáveis/logo.ai"));
    const withoutEditables = await downloadZip(a.manager, { type: "brand_kit", brandId: f.brandA, includeEditables: false });
    assert.ok(!withoutEditables.entries.some((e) => e.name.includes("Editáveis")));
  });

  test("progress is real while the ZIP is written", async () => {
    const big = await insertMaterial(ctx, {
      brandId: f.brandA,
      createdBy: u.admin.id,
      visibility: "released",
      categorySlug: "reels-videos",
      title: "Vídeo longo",
      files: [{ filename: "longo.mp4", buffer: randomBytes(1024 * 1024) }],
    });
    const original = ctx.storage.createReadStream;
    // slow reads (16 chunks × 40 ms) so the running state is observable
    ctx.storage.createReadStream = (key, range) =>
      original.call(ctx.storage, key, range).pipe(
        new Transform({
          transform(chunk, encoding, callback) {
            setTimeout(() => callback(null, chunk), 40);
          },
        }),
      );
    try {
      const job = await startZip(a.clientA, { type: "selection", materialIds: [big.material.id] });
      const running = await waitFor(
        async () => {
          const current = (await a.clientA.get(`/api/zips/${job.id}`)).body.job;
          return current.status === "running" && current.processedBytes > 0 && current.processedBytes < current.totalBytes ? current : null;
        },
        { timeout: 10000, interval: 15 },
      );
      assert.ok(running.progress > 0 && running.progress < 1);
      assert.equal(running.totalBytes, 1024 * 1024);
      const done = await finished(a.clientA, job.id);
      assert.equal(done.status, "ready");
      assert.equal(done.progress, 1);
    } finally {
      ctx.storage.createReadStream = original;
    }
  });

  test("identical requests reuse the job; only the owner follows it", async () => {
    const first = await finished(a.clientA, (await startZip(a.clientA, { type: "category", brandId: f.brandA, categoryId: (await db.get("SELECT category_id FROM materials WHERE id = ?", [f.logo.material.id])).category_id })).id);
    assert.equal(first.status, "ready");
    const again = await startZip(a.clientA, { type: "category", brandId: f.brandA, categoryId: (await db.get("SELECT category_id FROM materials WHERE id = ?", [f.logo.material.id])).category_id });
    assert.equal(again.id, first.id);
    assert.equal((await a.clientA2.get(`/api/zips/${first.id}`)).status, 404);
    assert.equal((await a.clientA2.post(`/api/zips/${first.id}/link`)).status, 404);
    const link = await a.clientA.post(`/api/zips/${first.id}/link`);
    assert.equal((await a.clientA2.get(link.body.url)).status, 403);
    const mine = await a.clientA.get("/api/zips");
    assert.ok(mine.body.items.some((job) => job.id === first.id));
    assert.ok(!(await a.clientA2.get("/api/zips")).body.items.some((job) => job.id === first.id));
  });

  test("nothing downloadable -> clear 404", async () => {
    const res = await a.clientA.post("/api/zips", { scope: { type: "selection", materialIds: [f.noDownload.material.id] } });
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /Não há arquivos disponíveis/);
    const invalid = await a.clientA.post("/api/zips", { scope: { type: "tudo" } });
    assert.equal(invalid.status, 422);
  });

  test("a missing stored file fails the job with a clear message", async () => {
    const broken = await insertMaterial(ctx, {
      brandId: f.brandA,
      createdBy: u.admin.id,
      visibility: "released",
      categorySlug: "apresentacoes",
      title: "Apresentação",
      files: [{ filename: "deck.pdf", buffer: Buffer.from("%PDF-1.4 deck") }],
    });
    await ctx.storage.remove(broken.files[0].storage_key);
    const job = await finished(a.clientA, (await startZip(a.clientA, { type: "selection", materialIds: [broken.material.id] })).id);
    assert.equal(job.status, "failed");
    assert.match(job.error, /“deck\.pdf” não foi encontrado no armazenamento/);
    assert.equal((await a.clientA.post(`/api/zips/${job.id}/link`)).status, 409);
  });

  test("access revoked after generation -> the link stops working", async () => {
    const job = await finished(a.clientA, (await startZip(a.clientA, { type: "selection", fileIds: [f.fontFree.files[0].id] })).id);
    const link = await a.clientA.post(`/api/zips/${job.id}/link`);
    await db.run("UPDATE materials SET archived_at = ? WHERE id = ?", [now(), f.fontFree.material.id]);
    const res = await a.clientA.get(link.body.url);
    assert.equal(res.status, 410);
    await db.run("UPDATE materials SET archived_at = NULL WHERE id = ?", [f.fontFree.material.id]);
  });

  test("restart marks running jobs failed; expired ZIPs are removed", async () => {
    const orphan = newId("zip");
    await db.run(
      `INSERT INTO zip_jobs (id, user_id, scope, label, filename, status, created_at, started_at)
       VALUES (?, ?, '{"type":"brand_kit"}', 'Kit', 'kit.zip', 'running', ?, ?)`,
      [orphan, u.clientA.id, now(), now()],
    );
    assert.ok(await failInterruptedZips(ctx) >= 1);
    const row = await db.get("SELECT * FROM zip_jobs WHERE id = ?", [orphan]);
    assert.equal(row.status, "failed");
    assert.match(row.error, /reiniciou/);
    assert.equal(await runZipJob(ctx, orphan), null, "only queued jobs run");

    const { job } = await downloadZip(a.clientA, { type: "carousel", materialId: f.logo.material.id });
    const key = (await db.get("SELECT storage_key FROM zip_jobs WHERE id = ?", [job.id])).storage_key;
    await db.run("UPDATE zip_jobs SET expires_at = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), job.id]);
    assert.equal((await a.clientA.get(`/api/zips/${job.id}`)).body.job.status, "expired");
    const link = await a.clientA.post(`/api/zips/${job.id}/link`);
    assert.equal(link.status, 410);
    assert.ok((await expireZips(ctx)) >= 1);
    assert.equal((await db.get("SELECT status FROM zip_jobs WHERE id = ?", [job.id])).status, "expired");
    assert.equal(await ctx.storage.exists(key), false);
  });
});

// ---------------------------------------------------------------- review fixes (B2)

const released = (opts) => insertMaterial(ctx, { brandId: f.brandA, createdBy: u.admin.id, visibility: "released", ...opts });
const today = () => zipFilename("x", "", new Date()).slice(-14, -4);

describe("failures surface when the link is asked for", () => {
  test("a ZIP whose content is no longer allowed answers 410 on /link and turns expired", async () => {
    const guide = await released({
      title: "Guia de aplicação",
      categorySlug: "apresentacoes",
      files: [{ filename: "guia.pdf", buffer: Buffer.from("%PDF-1.4 guia") }],
    });
    const job = await finished(a.clientA, (await startZip(a.clientA, { type: "selection", materialIds: [guide.material.id] })).id);
    assert.equal(job.status, "ready");
    const key = (await db.get("SELECT storage_key FROM zip_jobs WHERE id = ?", [job.id])).storage_key;
    await db.run("UPDATE materials SET download_enabled = 0 WHERE id = ?", [guide.material.id]);
    try {
      const link = await a.clientA.post(`/api/zips/${job.id}/link`);
      assert.equal(link.status, 410);
      assert.equal(link.body.error.code, "expired");
      assert.equal(link.body.error.message, "O conteúdo deste pacote mudou desde que foi gerado. Gere o ZIP de novo.");
      const after = (await a.clientA.get(`/api/zips/${job.id}`)).body.job;
      assert.equal(after.status, "expired");
      assert.equal(after.error, link.body.error.message);
      assert.equal(await ctx.storage.exists(key), false, "the unusable package is freed");
      assert.equal((await a.clientA.post(`/api/zips/${job.id}/link`)).status, 410);
    } finally {
      await db.run("UPDATE materials SET download_enabled = 1 WHERE id = ?", [guide.material.id]);
    }
  });

  test("a ZIP whose stored file is gone answers 410 on /link", async () => {
    const deck = await released({
      title: "Deck comercial",
      categorySlug: "apresentacoes",
      files: [{ filename: "deck-comercial.pdf", buffer: Buffer.from("%PDF-1.4 deck comercial") }],
    });
    const job = await finished(a.clientA, (await startZip(a.clientA, { type: "selection", materialIds: [deck.material.id] })).id);
    await ctx.storage.remove((await db.get("SELECT storage_key FROM zip_jobs WHERE id = ?", [job.id])).storage_key);
    const link = await a.clientA.post(`/api/zips/${job.id}/link`);
    assert.equal(link.status, 410);
    assert.equal(link.body.error.message, "Este ZIP não está mais disponível. Gere o pacote de novo.");
    assert.equal((await a.clientA.get(`/api/zips/${job.id}`)).body.job.status, "expired");
    // asking again builds a fresh package
    const again = await startZip(a.clientA, { type: "selection", materialIds: [deck.material.id] });
    assert.notEqual(again.id, job.id);
  });

  test("a file missing from storage: clear 404 on /downloads/link, and nothing recorded on /dl", async () => {
    const photo = await released({ title: "Foto de capa", categorySlug: "materiais-adicionais", files: [{ filename: "capa-site.png", buffer: await png() }] });
    const [file] = photo.files;
    // a link issued while the file existed, redeemed after it vanished
    const early = await a.clientA.post("/api/downloads/link", { fileId: file.id });
    assert.equal(early.status, 200);
    await ctx.storage.remove(file.storage_key);
    const res = await a.clientA.get(early.body.url);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.message, "O arquivo não está mais disponível no armazenamento.");
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM download_events WHERE file_id = ?", [file.id])).n, 0, "a failed download is not a download");
    const link = await a.clientA.post("/api/downloads/link", { fileId: file.id });
    assert.equal(link.status, 404);
    assert.equal(link.body.error.code, "not_found");
    assert.equal(link.body.error.message, "O arquivo não está mais disponível no armazenamento.");
  });
});

describe("ZIP names", () => {
  test("a selection from one material is named after it", async () => {
    const logo = await released({
      title: "Logo horizontal",
      files: [
        { filename: "horizontal.png", buffer: await png({ color: "#101010" }) },
        { filename: "horizontal.svg", buffer: svg() },
      ],
    });
    const byFiles = await finished(a.clientA, (await startZip(a.clientA, { type: "selection", fileIds: logo.files.map((x) => x.id) })).id);
    assert.equal(byFiles.label, "Logo horizontal · 2 arquivos");
    assert.equal(byFiles.filename, `aurora-logo-horizontal-${today()}.zip`);
    const byMaterial = await finished(a.clientA, (await startZip(a.clientA, { type: "selection", materialIds: [logo.material.id] })).id);
    assert.equal(byMaterial.label, "Logo horizontal · 2 arquivos");
    // after a reload the tray reads the same name from the server
    const listed = (await a.clientA.get("/api/zips")).body.items.find((job) => job.id === byMaterial.id);
    assert.equal(listed.label, "Logo horizontal · 2 arquivos");
  });

  test("one category, a named mixed selection and an unnamed one", async () => {
    const icon = await released({ title: "Ícone app", files: [{ filename: "icone.png", buffer: await png({ color: "#202020" }) }] });
    const mark = await released({ title: "Marca d'água", files: [{ filename: "marca-dagua.png", buffer: await png({ color: "#303030" }) }] });
    const sameCategory = await finished(
      a.clientA,
      (await startZip(a.clientA, { type: "selection", materialIds: [icon.material.id, mark.material.id] })).id,
    );
    assert.equal(sameCategory.label, "Logotipo · 2 arquivos");
    assert.equal(sameCategory.filename, `aurora-logotipo-${today()}.zip`);

    const mixed = [icon.material.id, f.fontFree.material.id];
    const named = await a.clientA.post("/api/zips", { scope: { type: "selection", materialIds: mixed }, label: "  Tudo de Aurora  " });
    assert.equal(named.status, 202, JSON.stringify(named.body));
    assert.equal(named.body.job.label, "Tudo de Aurora");
    assert.equal(named.body.job.filename, `aurora-tudo-de-aurora-${today()}.zip`);
    assert.deepEqual(named.body.job.scope, { type: "selection", materialIds: mixed, label: "Tudo de Aurora" }, "kept for a retry");
    const unnamed = await startZip(a.clientA, { type: "selection", materialIds: mixed });
    assert.equal(unnamed.label, "Seleção · 2 arquivos");
    assert.notEqual(unnamed.id, named.body.job.id, "a different name is a different package");
    const tooLong = await a.clientA.post("/api/zips", { scope: { type: "selection", materialIds: mixed }, label: "x".repeat(81) });
    assert.equal(tooLong.status, 422);
    await finished(a.clientA, named.body.job.id);
    await finished(a.clientA, unnamed.id);
  });

  test("the same files asked as another scope get their own job, name and history scope", async () => {
    const C = await createClientWithBrand(ctx, { name: "Cedro Café", brandName: "Cedro" });
    const clientC = await createUser(ctx, { role: "client", clientId: C.clientId });
    const agent = await login(server, { email: clientC.email });
    const logo = await insertMaterial(ctx, { brandId: C.brandId, createdBy: u.admin.id, visibility: "released", title: "Logo Cedro" });
    const categoryId = (await db.get("SELECT category_id FROM materials WHERE id = ?", [logo.material.id])).category_id;

    const byCategory = await downloadZip(agent, { type: "category", brandId: C.brandId, categoryId });
    const kit = await downloadZip(agent, { type: "brand_kit", brandId: C.brandId });
    assert.notEqual(kit.job.id, byCategory.job.id);
    assert.deepEqual(
      kit.entries.map((entry) => entry.name),
      byCategory.entries.map((entry) => entry.name),
      "same files",
    );
    assert.equal(kit.job.label, "Kit de marca · Cedro");
    assert.match(kit.job.filename, /^cedro-kit-de-marca-/);
    assert.deepEqual(kit.job.scope, { type: "brand_kit", brandId: C.brandId });
    const event = await db.get("SELECT scope FROM download_events WHERE zip_job_id = ?", [kit.job.id]);
    assert.deepEqual(JSON.parse(event.scope), { type: "brand_kit", brandId: C.brandId });
    // and asking the same scope again still reuses it
    assert.equal((await startZip(agent, { type: "brand_kit", brandId: C.brandId })).id, kit.job.id);
  });
});

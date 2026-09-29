// Slice A — materials, uploads, versions, releases, delivery and renditions
// through the HTTP API.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import sharp from "sharp";
import { newId } from "../lib/ids.js";
import { now } from "../lib/time.js";
import { cleanupStaleUploads } from "../services/materials.js";
import {
  addStaffAccess,
  categoryId,
  createClientWithBrand,
  createProject,
  createUser,
  jpg,
  login,
  mp4,
  pdf,
  png,
  startTestServer,
  svg,
  waitFor,
} from "./helpers.js";

// Minimal ZIP reader (central directory order, stored/deflated entries).
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

const upload = async (agent, buffer, filename) => {
  const res = await agent.upload("/api/uploads", { buffer, filename });
  assert.equal(res.status, 201, `${filename}: ${JSON.stringify(res.body)}`);
  return res.body.upload;
};
const storageFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
      else out.push(entry.name);
    }
  };
  walk(ctx.config.storageDir);
  return out;
};
const tmpFiles = () => readdirSync(ctx.config.tmpDir);

async function zipOf(agent, scope) {
  const created = await agent.post("/api/zips", { scope });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const job = await waitFor(async () => {
    const res = await agent.get(`/api/zips/${created.body.job.id}`);
    return ["ready", "failed"].includes(res.body.job.status) ? res.body.job : null;
  });
  assert.equal(job.status, "ready", job.error ?? "");
  const link = await agent.post(`/api/zips/${job.id}/link`);
  assert.equal(link.status, 200);
  const file = await agent.get(link.body.url);
  assert.equal(file.status, 200);
  return { job, entries: readZip(file.body), headers: file.headers };
}

before(async () => {
  server = await startTestServer({ maxUploadMb: 1 });
  ctx = server.ctx;
  db = server.db;
  const A = await createClientWithBrand(ctx, { name: "Aurora Pagamentos", brandName: "Aurora" });
  const B = await createClientWithBrand(ctx, { name: "Boreal", brandName: "Boreal" });
  f.brandA = A.brandId;
  f.clientA = A.clientId;
  f.brandB = B.brandId;
  u.admin = await createUser(ctx, { role: "admin", name: "Ana Admin" });
  u.manager = await createUser(ctx, { role: "manager", name: "Gil Gestor" });
  u.designer = await createUser(ctx, { role: "designer", name: "Dora Designer" });
  u.clientA = await createUser(ctx, { role: "client", clientId: A.clientId, name: "Clara Cliente" });
  u.clientB = await createUser(ctx, { role: "client", clientId: B.clientId, name: "Bruno Cliente" });
  await addStaffAccess(ctx, u.manager.id, A.clientId);
  f.project = (await createProject(ctx, { brandId: A.brandId, name: "Identidade Aurora", memberIds: [u.designer.id] })).id;
  f.campaign = newId("cmp");
  await db.run("INSERT INTO campaigns (id, brand_id, name, created_at, updated_at) VALUES (?, ?, 'Lançamento Pix', ?, ?)", [
    f.campaign,
    A.brandId,
    now(),
    now(),
  ]);
  for (const [key, user] of Object.entries(u)) a[key] = await login(server, { email: user.email });
});

after(async () => {
  await server?.close();
});

describe("uploads", () => {
  test("streams into storage, reads metadata and stays private to the uploader", async () => {
    const image = await upload(a.designer, await png({ width: 320, height: 200 }), "Logo Aurora.png");
    assert.equal(image.mediaKind, "image");
    assert.equal(image.format, "PNG");
    assert.equal(image.width, 320);
    assert.equal(image.height, 200);
    assert.equal(image.name, "Logo Aurora.png");
    const vector = await upload(a.designer, svg(), "símbolo.svg");
    assert.equal(vector.mediaKind, "vector");
    assert.equal(vector.width, 120);
    assert.equal(vector.name, "símbolo.svg", "UTF-8 names survive");

    assert.equal((await a.manager.get(`/api/uploads/${image.id}`)).status, 404);
    assert.equal((await a.manager.del(`/api/uploads/${image.id}`)).status, 404);
    assert.equal((await a.designer.get(`/api/uploads/${image.id}`)).status, 200);
    assert.equal((await a.clientA.upload("/api/uploads", { buffer: await png(), filename: "x.png" })).status, 403);

    const row = await db.get("SELECT storage_key FROM uploads WHERE id = ?", [image.id]);
    assert.equal((await a.designer.del(`/api/uploads/${image.id}`)).status, 204);
    assert.equal((await db.get("SELECT status FROM uploads WHERE id = ?", [image.id])).status, "discarded");
    assert.equal(await ctx.storage.exists(row.storage_key), false);
  });

  test("refuses disallowed types, wrong signatures and empty files", async () => {
    const before = storageFiles().length;
    const exe = await a.designer.upload("/api/uploads", { buffer: Buffer.from("MZ...."), filename: "setup.exe" });
    assert.equal(exe.status, 415);
    assert.equal(exe.body.error.code, "unsupported_media");
    const fake = await a.designer.upload("/api/uploads", { buffer: Buffer.from("isto não é png"), filename: "foto.png" });
    assert.equal(fake.status, 415);
    const html = await a.designer.upload("/api/uploads", { buffer: Buffer.from("<html><script>1</script>"), filename: "logo.svg" });
    assert.equal(html.status, 415);
    const empty = await a.designer.upload("/api/uploads", { buffer: Buffer.alloc(0), filename: "vazio.pdf" });
    assert.equal(empty.status, 422);
    assert.equal(storageFiles().length, before, "nothing left in storage");
    assert.equal(tmpFiles().length, 0);
  });

  test("413 while streaming (and before) with the partial file removed", async () => {
    const before = storageFiles().length;
    const header = await png();
    const big = Buffer.concat([header, Buffer.alloc(1.5 * 1024 * 1024)]);
    const streamed = await a.designer.upload("/api/uploads", { buffer: big, filename: "grande.png" });
    assert.equal(streamed.status, 413);
    assert.equal(streamed.body.error.code, "payload_too_large");
    assert.match(streamed.body.error.message, /1 MB/);
    const huge = await a.designer.upload("/api/uploads", { buffer: Buffer.alloc(3 * 1024 * 1024), filename: "enorme.png" });
    assert.equal(huge.status, 413);
    assert.equal(storageFiles().length, before);
    await waitFor(() => tmpFiles().length === 0);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM uploads WHERE original_name IN ('grande.png', 'enorme.png')")).n, 0);
  });

  test("an upload aborted by the client leaves nothing behind", async () => {
    const before = storageFiles().length;
    const boundary = "----metta-abort";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="parcial.png"\r\nContent-Type: image/png\r\n\r\n`,
    );
    const { request } = await import("node:http");
    await new Promise((resolve) => {
      const req = request(`${server.url}/api/uploads`, {
        method: "POST",
        headers: {
          cookie: a.designer.cookie,
          "x-metta-request": "1",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(head.length + 400000),
        },
      });
      req.on("error", resolve);
      req.on("close", resolve);
      req.write(head);
      req.write(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100000)]));
      setTimeout(() => req.destroy(), 100);
    });
    await waitFor(() => tmpFiles().length === 0);
    assert.equal(storageFiles().length, before);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM uploads WHERE original_name = 'parcial.png'")).n, 0);
    // the server is still healthy
    await upload(a.designer, await png(), "depois.png");
  });

  test("stale unattached uploads are discarded with their files", async () => {
    const fresh = await upload(a.designer, await png(), "recente.png");
    const stale = await upload(a.designer, await png(), "antigo.png");
    await db.run("UPDATE uploads SET created_at = ? WHERE id = ?", [new Date(Date.now() - 49 * 3600 * 1000).toISOString(), stale.id]);
    const key = (await db.get("SELECT storage_key FROM uploads WHERE id = ?", [stale.id])).storage_key;
    assert.ok((await cleanupStaleUploads(ctx)) >= 1);
    assert.equal((await db.get("SELECT status FROM uploads WHERE id = ?", [stale.id])).status, "discarded");
    assert.equal((await db.get("SELECT status FROM uploads WHERE id = ?", [fresh.id])).status, "uploaded");
    assert.equal(await ctx.storage.exists(key), false);
  });
});

describe("logo lifecycle", () => {
  test("draft -> review -> release -> new version -> release again", async () => {
    const pngUpload = await upload(a.designer, await png({ width: 800, height: 400 }), "logo-principal.png");
    const svgUpload = await upload(a.designer, svg(), "logo-principal.svg");
    const created = await a.designer.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.project,
      categoryId: await categoryId(ctx, "logotipo"),
      title: "Logo principal",
      variant: "principal",
      previewBg: "light",
      tags: ["logo", "principal"],
      internalNotes: "usar a versão com respiro maior",
      files: [
        { uploadId: pngUpload.id, role: "original", position: 1 },
        { uploadId: svgUpload.id, role: "original", position: 2 },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const material = created.body.material;
    f.logo = material.id;
    assert.equal(material.visibility, "draft");
    assert.equal(material.versions.length, 1);
    assert.equal(material.versions[0].status, "draft");
    assert.deepEqual(material.formats, ["SVG", "PNG"]);
    assert.equal(material.internalNotes, "usar a versão com respiro maior");

    // drafts are invisible to the client
    assert.equal((await a.clientA.get(`/api/materials/${f.logo}`)).status, 404);
    assert.ok(!(await a.clientA.get("/api/materials")).body.items.some((m) => m.id === f.logo));
    // designers produce but never release
    assert.equal((await a.designer.post("/api/releases/preview", { materialIds: [f.logo] })).status, 403);
    assert.equal((await a.designer.post("/api/releases", { materialIds: [f.logo], notifyApp: true })).status, 403);

    const submitted = await a.designer.post(`/api/materials/${f.logo}/submit`);
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.material.visibility, "internal_review");
    assert.ok(await db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'material.submitted'", [u.manager.id]));
    assert.equal((await a.designer.post(`/api/materials/${f.logo}/submit`)).status, 409);

    const preview = await a.manager.post("/api/releases/preview", { materialIds: [f.logo] });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.client.id, f.clientA);
    assert.equal(preview.body.brand.id, f.brandA);
    assert.deepEqual(preview.body.recipients.map((r) => r.email), [u.clientA.email]);
    assert.equal(preview.body.items[0].version.number, 1);
    assert.equal(preview.body.items[0].isNewVersion, false);
    assert.equal(preview.body.items[0].requiresApproval, true);
    assert.equal(preview.body.items[0].files.length, 2);
    assert.deepEqual(preview.body.blockers, []);

    const released = await a.manager.post("/api/releases", { materialIds: [f.logo], notifyApp: true, notifyEmail: true, message: "Primeira entrega." });
    assert.equal(released.status, 201, JSON.stringify(released.body));
    assert.equal(released.body.items[0].versionNumber, 1);
    const row = await db.get("SELECT * FROM materials WHERE id = ?", [f.logo]);
    assert.equal(row.visibility, "released");
    assert.equal(row.approval_status, "pending");
    assert.equal((await db.get("SELECT status FROM material_versions WHERE id = ?", [row.released_version_id])).status, "released");
    const notice = await db.get("SELECT * FROM notifications WHERE user_id = ? AND type = 'material.released'", [u.clientA.id]);
    assert.equal(notice.link, `/painel/arquivos?material=${f.logo}`);
    await ctx.mailer.idle();
    assert.ok(await db.get("SELECT 1 FROM email_outbox WHERE to_email = ?", [u.clientA.email]));

    const seen = await a.clientA.get(`/api/materials/${f.logo}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.material.visibility, "released");
    assert.equal(seen.body.material.internalNotes, undefined);
    assert.equal(seen.body.material.versions[0].files.length, 2);
    assert.ok(!JSON.stringify(seen.body).includes("storage_key"));
    assert.equal(seen.body.material.permissions.canApprove, true);

    // v2: always a draft, invisible to the client until released
    const v2Upload = await upload(a.designer, await png({ width: 800, height: 400, color: "#aeb99a" }), "logo-principal-v2.png");
    const v2 = await a.designer.post(`/api/materials/${f.logo}/versions`, {
      files: [{ uploadId: v2Upload.id, role: "original", position: 1 }],
      changeSummary: "Ajuste de espaçamento",
    });
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    assert.equal(v2.body.version.number, 2);
    assert.equal(v2.body.version.status, "draft");
    f.v2 = v2.body.version.id;
    const clientView = await a.clientA.get(`/api/materials/${f.logo}`);
    assert.deepEqual(clientView.body.material.versions.map((v) => v.number), [1]);
    assert.equal(clientView.body.material.version.number, 1);
    assert.equal((await a.clientA.get(`/api/versions/${f.v2}`)).status, 404);

    // the client had approved v1 (slice D records it); v2 must ask again
    await db.run("UPDATE materials SET approval_status = 'approved', approved_version_id = released_version_id WHERE id = ?", [f.logo]);
    const preview2 = await a.manager.post("/api/releases/preview", { materialIds: [f.logo] });
    assert.equal(preview2.body.items[0].isNewVersion, true);
    assert.equal(preview2.body.items[0].version.number, 2);
    const release2 = await a.manager.post("/api/releases", { materialIds: [f.logo], notifyApp: true });
    assert.equal(release2.status, 201);
    const after = await db.get("SELECT * FROM materials WHERE id = ?", [f.logo]);
    assert.equal(after.approval_status, "pending");
    assert.equal(after.released_version_id, f.v2);
    assert.equal((await db.get("SELECT status FROM material_versions WHERE material_id = ? AND number = 1", [f.logo])).status, "superseded");
    const clientAfter = await a.clientA.get(`/api/materials/${f.logo}`);
    assert.deepEqual(clientAfter.body.material.versions.map((v) => v.number), [2, 1]);
    assert.equal(clientAfter.body.material.approvalStatus, "pending");
    // nothing new to release
    const again = await a.manager.post("/api/releases", { materialIds: [f.logo], notifyApp: true });
    assert.equal(again.status, 409);
  });

  test("history: staff sees everything, the client only its events", async () => {
    const staff = await a.manager.get(`/api/materials/${f.logo}/history`);
    assert.equal(staff.status, 200);
    assert.equal(staff.body.versions.length, 2);
    assert.equal(staff.body.releases.length, 2);
    assert.ok(staff.body.activity.some((entry) => entry.action === "material.submitted"));
    const client = await a.clientA.get(`/api/materials/${f.logo}/history`);
    assert.equal(client.status, 200);
    assert.ok(client.body.items.length >= 2);
    assert.ok(client.body.items.every((entry) => entry.visibility === undefined && entry.data === undefined));
    assert.ok(!client.body.items.some((entry) => entry.action === "material.submitted" || entry.action === "material.created"));
    assert.equal(client.body.versions, undefined);
    assert.equal(client.body.downloads, undefined);
  });

  test("release history lists releases per client", async () => {
    const staff = await a.manager.get(`/api/releases?brandId=${f.brandA}`);
    assert.equal(staff.status, 200);
    assert.ok(staff.body.items.length >= 2);
    assert.equal(staff.body.items[0].items[0].materialId, f.logo);
    const client = await a.clientA.get("/api/releases");
    assert.ok(client.body.items.length >= 2);
    assert.equal(client.body.items[0].notifyEmail, undefined);
    assert.equal((await a.clientB.get("/api/releases")).body.items.length, 0);
  });
});

describe("renditions", () => {
  test("thumb and preview WebP for images and SVG, served with a private cache", async () => {
    await ctx.jobs.idle();
    const file = await db.get("SELECT * FROM material_files WHERE material_id = ? AND ext = 'png' ORDER BY created_at LIMIT 1", [f.logo]);
    assert.equal(file.preview_status, "ready");
    const res = await a.clientA.get(`/api/files/${file.id}/preview/thumb`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.equal(res.headers.get("cache-control"), "private, max-age=300");
    assert.equal((await sharp(res.body).metadata()).width, 480);
    const preview = await a.clientA.get(`/api/files/${file.id}/preview/preview`);
    assert.equal((await sharp(preview.body).metadata()).width, 800, "never enlarged");

    // a small transparent SVG is rasterised sharply and keeps its alpha
    const transparent = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><circle cx="25" cy="25" r="20" fill="#202619"/></svg>',
    );
    const up = await upload(a.designer, transparent, "simbolo.svg");
    const created = await a.designer.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.project,
      categoryId: await categoryId(ctx, "logotipo"),
      title: "Símbolo",
      variant: "simbolo",
      files: [{ uploadId: up.id, role: "original" }],
    });
    await ctx.jobs.idle();
    const svgFile = created.body.material.versions[0].files[0];
    const detail = await a.designer.get(`/api/materials/${created.body.material.id}`);
    assert.equal(detail.body.material.versions[0].files[0].previewStatus, "ready");
    assert.ok(detail.body.material.thumb.url.endsWith("/preview/thumb"));
    const big = await a.designer.get(`/api/files/${svgFile.id}/preview/preview`);
    const meta = await sharp(big.body).metadata();
    assert.equal(meta.width, 1600);
    assert.equal(meta.hasAlpha, true);
    // SVG itself is never streamed inline
    assert.equal((await a.designer.get(`/api/files/${svgFile.id}/stream`)).status, 404);
    assert.equal((await a.designer.get(`/api/files/${svgFile.id}/preview/poster`)).status, 404);
  });

  test("PDF stays unsupported and streams inline with Range; a cover becomes the thumbnail", async () => {
    const doc = await upload(a.designer, pdf(), "manual.pdf");
    const cover = await upload(a.designer, await jpg({ width: 600, height: 800 }), "capa-manual.jpg");
    const created = await a.designer.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.project,
      categoryId: await categoryId(ctx, "manual-da-marca"),
      title: "Manual da marca",
      files: [
        { uploadId: doc.id, role: "original" },
        { uploadId: cover.id, role: "cover" },
      ],
    });
    assert.equal(created.status, 201);
    await ctx.jobs.idle();
    const detail = (await a.designer.get(`/api/materials/${created.body.material.id}`)).body.material;
    const [original, coverFile] = detail.versions[0].files;
    assert.equal(original.previewStatus, "unsupported");
    assert.equal(original.previews.stream, `/api/files/${original.id}/stream`);
    assert.equal(detail.thumb.fileId, coverFile.id);
    assert.deepEqual(detail.formats, ["PDF"]);
    const partial = await a.designer.request("GET", `/api/files/${original.id}/stream`, { headers: { range: "bytes=0-9" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-disposition").startsWith("inline"), true);
    assert.ok(partial.body.equals(pdf().subarray(0, 10)));
    assert.equal(partial.headers.get("content-range"), `bytes 0-9/${pdf().length}`);
  });

  test("videos get a poster when ffmpeg is available", async (t) => {
    const video = await mp4({ ctx });
    if (!video) return t.skip("ffmpeg not available");
    const up = await upload(a.designer, video, "reels.mp4");
    const created = await a.designer.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.project,
      categoryId: await categoryId(ctx, "reels-videos"),
      title: "Reels de lançamento",
      files: [{ uploadId: up.id, role: "original" }],
    });
    await ctx.jobs.idle();
    const detail = (await a.designer.get(`/api/materials/${created.body.material.id}`)).body.material;
    const file = detail.versions[0].files[0];
    assert.equal(file.previewStatus, "ready");
    assert.ok(file.previews.poster);
    assert.ok(file.durationMs > 0);
    const poster = await a.designer.get(file.previews.poster);
    assert.equal(poster.status, 200);
    assert.equal(poster.headers.get("content-type"), "image/webp");
  });
});

describe("carousel", () => {
  test("slides reordered by position keep that order in the ZIP", async () => {
    const slides = [];
    for (const [name, color] of [
      ["a.png", "#111111"],
      ["b.png", "#555555"],
      ["c.png", "#999999"],
    ])
      slides.push(await upload(a.designer, await png({ width: 108, height: 135, color }), name));
    const created = await a.designer.post("/api/materials", {
      kind: "post",
      brandId: f.brandA,
      projectId: f.project,
      categorySlug: "posts-carrosseis",
      title: "Pix sem fricção",
      network: "instagram",
      format: "carrossel",
      plannedDate: "2026-10-05",
      campaignId: f.campaign,
      caption: "Pague com Pix em segundos.",
      files: slides.map((s, i) => ({ uploadId: s.id, role: "original", position: i + 1 })),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const material = created.body.material;
    assert.equal(material.post.format, "carrossel");
    const version = material.versions[0];
    const byName = Object.fromEntries(version.files.map((file) => [file.name, file.id]));
    // c first, then a, then b
    const reordered = await a.designer.patch(`/api/versions/${version.id}`, {
      files: [
        { id: byName["c.png"], position: 1 },
        { id: byName["a.png"], position: 2 },
        { id: byName["b.png"], position: 3 },
      ],
    });
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    assert.deepEqual(reordered.body.version.files.map((file) => file.name), ["c.png", "a.png", "b.png"]);

    const release = await a.manager.post("/api/releases", { materialIds: [material.id], notifyApp: true });
    assert.equal(release.status, 201);
    assert.equal(
      (await db.get("SELECT link FROM notifications WHERE user_id = ? AND entity_id = ?", [u.clientA.id, material.id])).link,
      `/painel/conteudo/${material.id}`,
    );
    // released versions can no longer be reordered
    assert.equal((await a.designer.patch(`/api/versions/${version.id}`, { files: [{ id: byName["a.png"], position: 1 }] })).status, 409);

    const carousel = await zipOf(a.clientA, { type: "carousel", materialId: material.id });
    assert.deepEqual(
      carousel.entries.map((e) => e.name),
      ["Aurora - Pix sem fricção/01-c.png", "Aurora - Pix sem fricção/02-a.png", "Aurora - Pix sem fricção/03-b.png"],
    );
    assert.ok(carousel.entries.every((e) => e.method === 0), "PNG is stored, not recompressed");
    assert.equal(carousel.job.label, "Carrossel · Pix sem fricção");
    assert.match(carousel.headers.get("content-disposition"), /attachment/);

    const library = await zipOf(a.clientA, { type: "selection", materialIds: [material.id] });
    const dir = "Aurora/Conteúdo/2026-10/Lançamento Pix/Pix sem fricção";
    assert.deepEqual(library.entries.map((e) => e.name), [`${dir}/01-c.png`, `${dir}/02-a.png`, `${dir}/03-b.png`]);
    const original = await png({ width: 108, height: 135, color: "#999999" });
    assert.ok(library.entries[0].data.equals(original), "original quality preserved");
  });
});

describe("organisation", () => {
  test("primary per brand + category + variant swaps atomically", async () => {
    const make = async (title) => {
      const up = await upload(a.designer, await png(), `${title}.png`);
      const res = await a.designer.post("/api/materials", {
        brandId: f.brandA,
        projectId: f.project,
        categoryId: await categoryId(ctx, "logotipo"),
        title,
        variant: "escura",
        files: [{ uploadId: up.id }],
      });
      return res.body.material.id;
    };
    const first = await make("Logo escura 1");
    const second = await make("Logo escura 2");
    assert.equal((await a.designer.post(`/api/materials/${first}/primary`)).body.material.isPrimary, true);
    const swap = await a.designer.post(`/api/materials/${second}/primary`);
    assert.equal(swap.status, 200);
    assert.equal(swap.body.previousId, first);
    assert.equal((await db.get("SELECT is_primary FROM materials WHERE id = ?", [first])).is_primary, 0);
    assert.equal((await db.get("SELECT is_primary FROM materials WHERE id = ?", [second])).is_primary, 1);

    const reorder = await a.designer.post("/api/materials/reorder", { ids: [second, first] });
    assert.equal(reorder.status, 200);
    const order = (await db.all("SELECT id FROM materials WHERE id IN (?, ?) ORDER BY sort_order", [first, second])).map((r) => r.id);
    assert.deepEqual(order, [second, first]);
    assert.equal((await a.designer.post("/api/materials/reorder", { ids: [second, f.logo] })).status, 200, "same slot (logotipo)");
    f.dark = [first, second];
  });

  test("bulk actions report what was skipped", async () => {
    const foreign = newId("mat");
    const res = await a.manager.post("/api/materials/bulk", { ids: [...f.dark, foreign], action: "archive" });
    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 2);
    assert.deepEqual(res.body.skipped, [{ id: foreign, reason: "Material não encontrado." }]);
    assert.ok((await db.get("SELECT archived_at FROM materials WHERE id = ?", [f.dark[0]])).archived_at);
    const again = await a.manager.post("/api/materials/bulk", { ids: [f.dark[0]], action: "archive" });
    assert.equal(again.body.updated, 0);
    assert.equal(again.body.skipped[0].reason, "Este material já está arquivado.");
    assert.equal((await a.designer.post("/api/materials/bulk", { ids: f.dark, action: "unarchive" })).status, 403);
    const restore = await a.manager.post("/api/materials/bulk", { ids: f.dark, action: "unarchive" });
    assert.equal(restore.body.updated, 2);
    const invalid = await a.manager.post("/api/materials/bulk", { ids: f.dark, action: "explode" });
    assert.equal(invalid.status, 422);
    const moved = await a.manager.post("/api/materials/bulk", { ids: f.dark, action: "set_category", value: await categoryId(ctx, "identidade-visual") });
    assert.equal(moved.body.updated, 2);
  });

  test("patch rules: only releasers change download on released materials", async () => {
    assert.equal((await a.designer.patch(`/api/materials/${f.logo}`, { title: "Logo principal horizontal" })).status, 200);
    const blocked = await a.designer.patch(`/api/materials/${f.logo}`, { downloadEnabled: false });
    assert.equal(blocked.status, 403);
    const off = await a.manager.patch(`/api/materials/${f.logo}`, { downloadEnabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.material.downloadEnabled, false);
    assert.ok(await db.get("SELECT 1 FROM activity_log WHERE material_id = ? AND action = 'material.download_disabled' AND visibility = 'client'", [f.logo]));
    await a.manager.patch(`/api/materials/${f.logo}`, { downloadEnabled: true });
    const invalid = await a.manager.patch(`/api/materials/${f.logo}`, { variant: "neon", dueDate: "2026-02-30" });
    assert.equal(invalid.status, 422);
    assert.ok(invalid.body.error.fields.variant && invalid.body.error.fields.dueDate);
  });

  test("files of released versions stay; drafts can drop files", async () => {
    const released = await db.get("SELECT id FROM material_files WHERE version_id = ? LIMIT 1", [f.v2]);
    assert.equal((await a.designer.del(`/api/files/${released.id}`)).status, 409);
    const up = await upload(a.designer, await png(), "rascunho.png");
    const draft = await a.designer.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.project,
      categoryId: await categoryId(ctx, "materiais-adicionais"),
      title: "Rascunho descartável",
      files: [{ uploadId: up.id }],
    });
    const fileId = draft.body.material.versions[0].files[0].id;
    await ctx.jobs.idle();
    const keys = [
      (await db.get("SELECT storage_key FROM material_files WHERE id = ?", [fileId])).storage_key,
      ...(await db.all("SELECT storage_key FROM file_renditions WHERE file_id = ?", [fileId])).map((r) => r.storage_key),
    ];
    assert.equal((await a.designer.del(`/api/files/${fileId}`)).status, 204);
    for (const key of keys) assert.equal(await ctx.storage.exists(key), false);
    assert.equal((await db.get("SELECT status FROM uploads WHERE id = ?", [up.id])).status, "discarded");
  });
});

describe("final files after approval", () => {
  test("finals stay hidden until delivered, then reach the client", async () => {
    // client approved v2 (slice D)
    await db.run("UPDATE materials SET approval_status = 'approved', approved_version_id = ? WHERE id = ?", [f.v2, f.logo]);
    const original = await upload(a.designer, await png(), "extra.png");
    const wrongRole = await a.designer.post(`/api/versions/${f.v2}/files`, { files: [{ uploadId: original.id, role: "original" }] });
    assert.equal(wrongRole.status, 422);

    const final = await upload(a.designer, await png({ width: 2000, height: 1000 }), "logo-final.png");
    const added = await a.designer.post(`/api/versions/${f.v2}/files`, { files: [{ uploadId: final.id, role: "final" }] });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const [finalId] = added.body.fileIds;
    const staffFile = added.body.version.files.find((file) => file.id === finalId);
    assert.equal(staffFile.published, false);
    assert.equal(added.body.material.pendingDeliveryCount, 1);
    assert.equal(added.body.material.permissions.canDeliver, false, "designers do not deliver");

    const clientView = await a.clientA.get(`/api/materials/${f.logo}`);
    assert.ok(!clientView.body.material.versions[0].files.some((file) => file.id === finalId));
    assert.equal((await a.clientA.post("/api/downloads/link", { fileId: finalId })).status, 404);
    assert.equal((await a.clientA.get(`/api/files/${finalId}/preview/thumb`)).status, 404);
    assert.equal((await db.get("SELECT approval_status FROM materials WHERE id = ?", [f.logo])).approval_status, "approved");

    assert.equal((await a.designer.post(`/api/materials/${f.logo}/deliver`)).status, 403);
    const delivered = await a.manager.post(`/api/materials/${f.logo}/deliver`, { notifyEmail: false });
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
    assert.equal(delivered.body.published, 1);
    assert.ok(delivered.body.material.deliveredAt);
    assert.equal((await a.manager.post(`/api/materials/${f.logo}/deliver`)).status, 409);

    const after = await a.clientA.get(`/api/materials/${f.logo}`);
    const visible = after.body.material.versions[0].files.find((file) => file.id === finalId);
    assert.ok(visible);
    assert.equal(visible.published, undefined, "staff-only flag");
    assert.equal(after.body.material.deliveredAt !== null, true);
    assert.equal(after.body.material.approvalStatus, "approved", "delivery never changes approval");
    assert.equal((await a.clientA.post("/api/downloads/link", { fileId: finalId })).status, 200);
    assert.ok(await db.get("SELECT 1 FROM activity_log WHERE material_id = ? AND action = 'material.delivered' AND visibility = 'client'", [f.logo]));
    assert.ok(await db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'material.delivered'", [u.clientA.id]));
  });
});

describe("kits", () => {
  test("kit release reuses the release engine and shows only visible items", async () => {
    const up = await upload(a.designer, await png(), "padrao.png");
    const pattern = await a.designer.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.project,
      categoryId: await categoryId(ctx, "identidade-visual"),
      title: "Padrão gráfico",
      files: [{ uploadId: up.id }],
    });
    const draftId = pattern.body.material.id;
    const kit = await a.manager.post("/api/kits", {
      brandId: f.brandA,
      name: "Kit de marca Aurora",
      kind: "brand_kit",
      materialIds: [f.logo, draftId],
    });
    assert.equal(kit.status, 201, JSON.stringify(kit.body));
    const kitId = kit.body.kit.id;
    assert.deepEqual(kit.body.kit.materialIds, [f.logo, draftId]);
    assert.equal((await a.clientA.get(`/api/kits/${kitId}`)).status, 404, "draft kits are private");
    assert.equal((await a.manager.post("/api/kits", { brandId: f.brandA, name: "X", materialIds: [newId("mat")] })).status, 422);

    const preview = await a.manager.post(`/api/kits/${kitId}/release/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.counts.toRelease, 1);
    const released = await a.manager.post(`/api/kits/${kitId}/release`, { notifyApp: true });
    assert.equal(released.status, 201, JSON.stringify(released.body));
    assert.equal(released.body.kit.status, "released");
    assert.equal((await db.get("SELECT visibility FROM materials WHERE id = ?", [draftId])).visibility, "released");

    const clientKit = await a.clientA.get(`/api/kits/${kitId}`);
    assert.equal(clientKit.status, 200);
    assert.equal(clientKit.body.kit.items.length, 2);
    // archiving an item hides it from the client's kit
    await a.manager.post(`/api/materials/${draftId}/archive`);
    const reduced = await a.clientA.get(`/api/kits/${kitId}`);
    assert.deepEqual(reduced.body.kit.materialIds, [f.logo]);
    assert.equal((await a.clientA.get("/api/kits")).body.items.length, 1);
    assert.equal((await a.manager.del(`/api/kits/${kitId}`)).status, 409);
    await a.manager.post(`/api/materials/${draftId}/unarchive`);

    const zip = await zipOf(a.clientA, { type: "kit", kitId });
    assert.ok(zip.entries.every((e) => e.name.startsWith("Aurora - Kit de marca Aurora/Identidade visual/")));
  });
});

// ---------------------------------------------------------------- review fixes (B2)

// Logo released as v1, approved, with a final file attached after the release
// and delivered. -> { id, v1, finalId }
async function deliveredLogo(title, slug) {
  const original = await upload(a.designer, await png({ width: 400, height: 200, color: "#4a5a3a" }), `${slug}.png`);
  const created = await a.designer.post("/api/materials", {
    brandId: f.brandA,
    projectId: f.project,
    categoryId: await categoryId(ctx, "logotipo"),
    title,
    files: [{ uploadId: original.id, role: "original" }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.material.id;
  const v1 = created.body.material.versions[0].id;
  assert.equal((await a.manager.post("/api/releases", { materialIds: [id], notifyApp: false })).status, 201);
  await db.run("UPDATE materials SET approval_status = 'approved', approved_version_id = released_version_id WHERE id = ?", [id]);
  const final = await upload(a.designer, await png({ width: 1200, height: 600, color: "#1e2618" }), `${slug}-final.png`);
  const added = await a.designer.post(`/api/versions/${v1}/files`, { files: [{ uploadId: final.id, role: "final" }] });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const delivered = await a.manager.post(`/api/materials/${id}/deliver`, { notifyApp: false, notifyEmail: false });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.mode, "finals");
  assert.ok((await db.get("SELECT delivered_at FROM materials WHERE id = ?", [id])).delivered_at);
  return { id, v1, finalId: added.body.fileIds[0] };
}

describe("new versions and final files", () => {
  test("a version copied from the current one never carries the approved finals", async () => {
    const logo = await deliveredLogo("Logo secundária", "logo-sec");
    const next = await upload(a.designer, await png({ width: 400, height: 200, color: "#aeb99a" }), "logo-sec-v2.png");
    const v2 = await a.designer.post(`/api/materials/${logo.id}/versions`, {
      copyFrom: "current",
      files: [{ uploadId: next.id, role: "original" }],
      changeSummary: "Nova proporção",
    });
    assert.equal(v2.status, 201, JSON.stringify(v2.body));
    const files = v2.body.version.files;
    assert.deepEqual(files.map((file) => [file.role, file.name]).sort(), [
      ["original", "logo-sec-v2.png"],
      ["original", "logo-sec.png"],
    ]);

    const preview = await a.manager.post("/api/releases/preview", { materialIds: [logo.id] });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.items[0].inheritedFinalCount, 0);
    assert.ok(!preview.body.warnings.some((text) => /copiad/.test(text)));
    assert.equal((await a.manager.post("/api/releases", { materialIds: [logo.id], notifyApp: false })).status, 201);

    const row = await db.get("SELECT * FROM materials WHERE id = ?", [logo.id]);
    assert.equal(row.approval_status, "pending", "a new version asks for a new approval");
    assert.equal(row.delivered_at, null, "not delivered while it waits for approval");
    const clientView = (await a.clientA.get(`/api/materials/${logo.id}`)).body.material;
    assert.equal(clientView.deliveredAt, null);
    assert.ok(!clientView.versions[0].files.some((file) => file.role === "final"));
    // v1 keeps its delivered final in the history
    assert.ok(clientView.versions[1].files.some((file) => file.id === logo.finalId));

    const kit = await zipOf(a.clientA, { type: "brand_kit", brandId: f.brandA });
    const names = kit.entries.map((entry) => entry.name);
    assert.ok(names.includes("Aurora/Identidade visual/Logos/PNG/logo-sec-v2.png"), names.join("\n"));
    assert.ok(!names.some((name) => name.endsWith("logo-sec-final.png")), "the old final never replaces the new artwork");
  });

  test("finals copied into a version before the fix stay hidden and are flagged before release", async () => {
    const logo = await deliveredLogo("Símbolo antigo", "simbolo-antigo");
    const next = await upload(a.designer, await png({ color: "#8a9a70" }), "simbolo-antigo-v2.png");
    const v2 = (await a.designer.post(`/api/materials/${logo.id}/versions`, { files: [{ uploadId: next.id, role: "original" }] })).body.version;
    // what the old copy did: v1's final duplicated into v2, published
    const copyId = newId("fil");
    await db.run(
      `INSERT INTO material_files (id, version_id, material_id, role, position, original_name, display_name, ext, mime, size_bytes,
         sha256, storage_key, media_kind, width, height, duration_ms, preview_status, font_distributable, created_by, created_at, published)
       SELECT ?, ?, material_id, role, position, original_name, display_name, ext, mime, size_bytes, sha256, storage_key, media_kind,
         width, height, duration_ms, preview_status, font_distributable, created_by, ?, 1
       FROM material_files WHERE id = ?`,
      [copyId, v2.id, now(), logo.finalId],
    );

    const preview = await a.manager.post("/api/releases/preview", { materialIds: [logo.id] });
    assert.equal(preview.body.items[0].inheritedFinalCount, 1);
    assert.ok(
      preview.body.warnings.some((text) => /1 arquivo final copiado de uma versão anterior/.test(text)),
      preview.body.warnings.join(" | "),
    );
    assert.equal((await a.manager.post("/api/releases", { materialIds: [logo.id], notifyApp: false })).status, 201);

    const row = await db.get("SELECT delivered_at, approval_status FROM materials WHERE id = ?", [logo.id]);
    assert.equal(row.delivered_at, null);
    assert.equal(row.approval_status, "pending");
    assert.equal((await db.get("SELECT published FROM material_files WHERE id = ?", [copyId])).published, 0);
    const clientView = (await a.clientA.get(`/api/materials/${logo.id}`)).body.material;
    assert.ok(!clientView.versions[0].files.some((file) => file.id === copyId));
    assert.equal((await a.manager.get(`/api/materials/${logo.id}`)).body.material.pendingDeliveryCount, 1);
    const zip = await zipOf(a.clientA, { type: "selection", materialIds: [logo.id] });
    assert.deepEqual(zip.entries.map((entry) => entry.name), ["Aurora/Identidade visual/Logos/PNG/simbolo-antigo-v2.png"]);
  });
});

describe("delivery of originals", () => {
  test("a material delivered as its released originals can be marked delivered", async () => {
    const art = await upload(a.designer, await png({ width: 1080, height: 1080 }), "post-avulso.png");
    const created = await a.designer.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.project,
      categoryId: await categoryId(ctx, "materiais-adicionais"),
      title: "Arte avulsa",
      files: [{ uploadId: art.id, role: "original" }],
    });
    const id = created.body.material.id;
    assert.equal(created.body.material.deliverableWithoutFinals, false, "not released yet");
    assert.equal((await a.manager.post("/api/releases", { materialIds: [id], notifyApp: false })).status, 201);
    await db.run("UPDATE materials SET approval_status = 'approved', approved_version_id = released_version_id WHERE id = ?", [id]);
    const before = (await a.manager.get(`/api/materials/${id}`)).body.material;
    assert.equal(before.deliverableWithoutFinals, true);
    assert.equal(before.permissions.canDeliver, true);
    assert.equal((await a.clientA.get(`/api/materials/${id}`)).body.material.deliverableWithoutFinals, undefined, "staff-only flag");

    assert.equal((await a.designer.post(`/api/materials/${id}/deliver`)).status, 403);
    const delivered = await a.manager.post(`/api/materials/${id}/deliver`, { notifyApp: true, notifyEmail: true });
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
    assert.equal(delivered.body.mode, "originals");
    assert.equal(delivered.body.published, 0);
    assert.equal(delivered.body.files, 1);
    assert.ok(delivered.body.material.deliveredAt);
    assert.equal(delivered.body.material.deliverableWithoutFinals, false);
    assert.equal(delivered.body.material.approvalStatus, "approved", "delivery never changes approval");
    assert.equal(delivered.body.emailConfigured, false);
    assert.equal(delivered.body.appRecipients, 1);
    assert.equal(delivered.body.emailRecipients, 1);

    const entry = await db.get("SELECT * FROM activity_log WHERE material_id = ? AND action = 'material.delivered'", [id]);
    assert.equal(entry.visibility, "client");
    assert.match(entry.summary, /^Gil Gestor marcou “Arte avulsa” como entregue/);
    assert.ok(await db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'material.delivered' AND entity_id = ?", [u.clientA.id, id]));
    assert.ok((await a.clientA.get(`/api/materials/${id}`)).body.material.deliveredAt);
    const again = await a.manager.post(`/api/materials/${id}/deliver`);
    assert.equal(again.status, 409);
    assert.match(again.body.error.message, /já está marcado como entregue/);
  });
});

describe("notices report what was really sent", () => {
  test("release, kit release and delivery answer emailConfigured / appRecipients / emailRecipients (SMTP off)", async () => {
    const make = async (title) => {
      const up = await upload(a.designer, await png(), `${title}.png`);
      const res = await a.designer.post("/api/materials", {
        brandId: f.brandA,
        projectId: f.project,
        categoryId: await categoryId(ctx, "apresentacoes"),
        title,
        files: [{ uploadId: up.id }],
      });
      return res.body.material.id;
    };
    const first = await make("Apresentação institucional");
    const preview = await a.manager.post("/api/releases/preview", { materialIds: [first] });
    assert.equal(preview.body.emailConfigured, false);

    const released = await a.manager.post("/api/releases", { materialIds: [first], notifyApp: true, notifyEmail: true });
    assert.equal(released.status, 201);
    assert.equal(released.body.emailConfigured, false);
    assert.equal(released.body.appRecipients, 1);
    assert.equal(released.body.emailRecipients, 1);
    await ctx.mailer.idle();
    const outbox = await db.get("SELECT status FROM email_outbox WHERE to_email = ? ORDER BY created_at DESC LIMIT 1", [u.clientA.email]);
    assert.equal(outbox.status, "not_configured", "recorded, never pretended");

    // people who turned e-mail notices off are not counted; no notice -> zero
    await db.run("UPDATE users SET notify_email = 0 WHERE id = ?", [u.clientA.id]);
    try {
      const second = await make("Apresentação de resultados");
      const quiet = await a.manager.post("/api/releases", { materialIds: [second], notifyApp: true, notifyEmail: true });
      assert.equal(quiet.body.appRecipients, 1);
      assert.equal(quiet.body.emailRecipients, 0);
      const third = await make("Apresentação comercial");
      const silent = await a.manager.post("/api/releases", { materialIds: [third], notifyApp: false, notifyEmail: false });
      assert.deepEqual([silent.body.appRecipients, silent.body.emailRecipients], [0, 0]);
    } finally {
      await db.run("UPDATE users SET notify_email = 1 WHERE id = ?", [u.clientA.id]);
    }

    const fourth = await make("Apresentação do kit");
    const kit = await a.manager.post("/api/kits", { brandId: f.brandA, name: "Kit apresentações", materialIds: [fourth] });
    const kitRelease = await a.manager.post(`/api/kits/${kit.body.kit.id}/release`, { notifyApp: true, notifyEmail: true });
    assert.equal(kitRelease.status, 201, JSON.stringify(kitRelease.body));
    assert.equal(kitRelease.body.emailConfigured, false);
    assert.equal(kitRelease.body.appRecipients, 1);
    assert.equal(kitRelease.body.emailRecipients, 1);
  });
});

describe("history of download availability (D2)", () => {
  test("switching download writes one entry that starts with the person's name", async () => {
    const up = await upload(a.designer, await png(), "guia.png");
    const created = await a.designer.post("/api/materials", {
      brandId: f.brandA,
      projectId: f.project,
      categoryId: await categoryId(ctx, "materiais-adicionais"),
      title: "Guia rápido",
      files: [{ uploadId: up.id }],
    });
    const id = created.body.material.id;
    await a.manager.post("/api/releases", { materialIds: [id], notifyApp: false });
    const entriesAfter = async (since) =>
      await db.all("SELECT action, summary, visibility, data FROM activity_log WHERE material_id = ? AND id > ? ORDER BY id", [id, since]);
    const mark = async () => (await db.get("SELECT MAX(id) AS n FROM activity_log")).n;

    let since = await mark();
    assert.equal((await a.manager.patch(`/api/materials/${id}`, { downloadEnabled: false })).status, 200);
    let entries = await entriesAfter(since);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].action, "material.download_disabled");
    assert.equal(entries[0].visibility, "client");
    assert.equal(entries[0].summary, "Gil Gestor bloqueou o download de “Guia rápido”.");

    since = await mark();
    assert.equal((await a.manager.patch(`/api/materials/${id}`, { downloadEnabled: true, description: "Versão para impressão" })).status, 200);
    entries = await entriesAfter(since);
    assert.deepEqual(entries.map((entry) => entry.action), ["material.updated", "material.download_enabled"]);
    assert.deepEqual(JSON.parse(entries[0].data).fields, ["description"]);
    assert.equal(entries[1].summary, "Gil Gestor liberou o download de “Guia rápido”.");

    since = await mark();
    const bulk = await a.manager.post("/api/materials/bulk", { ids: [id], action: "disable_download" });
    assert.equal(bulk.body.updated, 1);
    entries = await entriesAfter(since);
    assert.equal(entries.length, 1);
    assert.match(entries[0].summary, /^Gil Gestor bloqueou o download/);

    const history = await a.clientA.get(`/api/materials/${id}/history`);
    const seen = history.body.items.find((item) => item.action === "material.download_disabled");
    assert.equal(seen.actor.name, "Gil Gestor");
    assert.ok(!history.body.items.some((item) => item.action === "material.updated"), "edits stay internal");
    await a.manager.patch(`/api/materials/${id}`, { downloadEnabled: true });
  });
});

describe("materials without a project or contracted service", () => {
  test("the release summary flags them and the library can list them", async () => {
    const up = await upload(a.manager, await png(), "avulso.png");
    const created = await a.manager.post("/api/materials", {
      brandId: f.brandA,
      categoryId: await categoryId(ctx, "materiais-adicionais"),
      title: "Material sem projeto",
      files: [{ uploadId: up.id }],
    });
    assert.equal(created.status, 201);
    const id = created.body.material.id;
    const preview = await a.manager.post("/api/releases/preview", { materialIds: [id] });
    assert.equal(preview.body.items[0].missingProject, true);
    assert.ok(preview.body.warnings.includes("“Material sem projeto”: sem projeto ou serviço vinculado."));
    const listed = await a.manager.get(`/api/materials?brandId=${f.brandA}&unassigned=1`);
    assert.ok(listed.body.items.some((m) => m.id === id));
    assert.ok(listed.body.items.every((m) => m.project === null));
    const withProject = await a.manager.post("/api/releases/preview", { materialIds: [f.logo] });
    assert.equal(withProject.body.items[0].missingProject, false);
  });
});

describe("upload limit", () => {
  test("pages can read the limit", async () => {
    const res = await a.designer.get("/api/uploads/limits");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { maxUploadBytes: 1024 * 1024, maxUploadMb: 1, maxUploadLabel: "1 MB" });
    assert.equal((await a.clientA.get("/api/uploads/limits")).status, 403);
  });

  test("a body declared too large is refused at once, not after the transfer", async () => {
    const { request } = await import("node:http");
    const boundary = "----metta-grande";
    const started = Date.now();
    const answer = await new Promise((resolve, reject) => {
      const req = request(`${server.url}/api/uploads`, {
        method: "POST",
        headers: {
          cookie: a.designer.cookie,
          "x-metta-request": "1",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(60 * 1024 * 1024),
        },
      });
      req.on("response", (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body), ms: Date.now() - started }));
      });
      req.on("error", reject);
      // a slow sender: 64 KB every 100 ms (60 MB would take ~100 s)
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="enorme.png"\r\n\r\n`);
      const timer = setInterval(() => (req.destroyed ? clearInterval(timer) : req.write(Buffer.alloc(64 * 1024))), 100);
      setTimeout(() => {
        clearInterval(timer);
        req.destroy();
      }, 6000);
    });
    assert.equal(answer.status, 413);
    assert.ok(answer.ms < 3000, `answered after ${answer.ms} ms`);
    assert.equal(answer.body.error.code, "payload_too_large");
    assert.equal(answer.body.error.message, "O arquivo ultrapassa o limite de 1 MB.");
    assert.equal(answer.body.error.maxBytes, 1024 * 1024);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM uploads WHERE original_name = 'enorme.png'")).n, 0);
    // the server is still healthy
    await upload(a.designer, await png(), "depois-do-grande.png");
  });
});

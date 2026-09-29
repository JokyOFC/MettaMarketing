// Test harness: boots the API on an ephemeral port with a temporary
// DATA_DIR and offers direct-DB fixtures plus an HTTP session helper.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp, createContext } from "../app.js";
import { findOnPath, loadConfig } from "../config.js";
import { hashPassword } from "../lib/auth.js";
import { newId } from "../lib/ids.js";
import { extOf, kindForExt, mimeFor } from "../lib/media.js";
import { now } from "../lib/time.js";

export const TEST_PASSWORD = "senha-de-teste-123";

/**
 * startTestServer(overrides) -> { url, ctx, db, close }
 * overrides are loadConfig overrides (e.g. { mpApiBase, mailTransport }).
 */
export async function startTestServer(overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "metta-test-"));
  const config = loadConfig({
    nodeEnv: "test",
    dataDir,
    appSecret: randomBytes(32).toString("hex"),
    appUrl: "http://127.0.0.1:5173",
    mpAccessToken: null,
    mpWebhookSecret: null,
    smtpUrl: null,
    smtpHost: null,
    avApiUrl: null,
    avToken: null,
    avWebhookSecret: null,
    ...overrides,
  });
  const ctx = createContext(config);
  const app = createApp(ctx);
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.on("error", reject);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    url,
    ctx,
    db: ctx.db,
    app,
    server,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await ctx.jobs?.stop();
      await ctx.mailer.idle();
      ctx.db.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

// ---------------------------------------------------------------- fixtures

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter += 1)}${randomBytes(2).toString("hex")}`;

/** Active user with a hashed password. -> row + { password } */
export async function createUser(ctx, { role = "admin", clientId = null, email, name, password = TEST_PASSWORD, status = "active", jobTitle = null } = {}) {
  const id = newId("usr");
  const at = now();
  const address = (email ?? `${role}-${unique()}@example.test`).toLowerCase();
  ctx.db.run(
    `INSERT INTO users (id, email, name, role, client_id, password_hash, status, job_title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, address, name ?? `Pessoa ${role}`, role, role === "client" ? clientId : null, status === "invited" ? null : await hashPassword(password), status, jobTitle, at, at],
  );
  return { ...ctx.db.get("SELECT * FROM users WHERE id = ?", [id]), password };
}

/** -> { client, brand, clientId, brandId } */
export function createClientWithBrand(ctx, { name, brandName } = {}) {
  const at = now();
  const clientId = newId("cli");
  const brandId = newId("brd");
  const clientName = name ?? `Cliente ${unique()}`;
  const brand = brandName ?? clientName;
  ctx.db.run("INSERT INTO clients (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)", [clientId, clientName, at, at]);
  const slug = brand
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "marca";
  ctx.db.run("INSERT INTO brands (id, client_id, name, slug, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)", [
    brandId,
    clientId,
    brand,
    slug,
    at,
    at,
  ]);
  return {
    client: ctx.db.get("SELECT * FROM clients WHERE id = ?", [clientId]),
    brand: ctx.db.get("SELECT * FROM brands WHERE id = ?", [brandId]),
    clientId,
    brandId,
  };
}

/** Extra brand for an existing client. */
export function createBrand(ctx, clientId, name = `Marca ${unique()}`) {
  const id = newId("brd");
  const at = now();
  ctx.db.run("INSERT INTO brands (id, client_id, name, slug, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)", [
    id,
    clientId,
    name,
    `marca-${unique()}`,
    at,
    at,
  ]);
  return ctx.db.get("SELECT * FROM brands WHERE id = ?", [id]);
}

export function addStaffAccess(ctx, userId, clientId) {
  ctx.db.run("INSERT OR IGNORE INTO staff_client_access (user_id, client_id, granted_at) VALUES (?, ?, ?)", [userId, clientId, now()]);
}

/** -> project row. memberIds join as 'designer'. */
export function createProject(ctx, { brandId, name, memberIds = [], includesEditables = false, status = "in_progress" } = {}) {
  const id = newId("prj");
  const at = now();
  ctx.db.run(
    "INSERT INTO projects (id, brand_id, name, status, includes_editables, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, brandId, name ?? `Projeto ${unique()}`, status, includesEditables ? 1 : 0, at, at],
  );
  for (const userId of memberIds)
    ctx.db.run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'designer', ?)", [id, userId, at]);
  return ctx.db.get("SELECT * FROM projects WHERE id = ?", [id]);
}

export const categoryId = (ctx, slug) => ctx.db.get("SELECT id FROM categories WHERE slug = ?", [slug])?.id;

/** Stores a buffer as an upload row owned by userId. -> upload row */
export async function createUpload(ctx, userId, { buffer, filename }) {
  const stored = await ctx.storage.putBuffer(buffer);
  const ext = extOf(filename);
  const id = newId("upl");
  ctx.db.run(
    `INSERT INTO uploads (id, user_id, original_name, ext, mime, size_bytes, sha256, storage_key, media_kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?)`,
    [id, userId, filename, ext, mimeFor(ext), stored.size, stored.sha256, stored.key, kindForExt(ext) ?? "other", now()],
  );
  return ctx.db.get("SELECT * FROM uploads WHERE id = ?", [id]);
}

/**
 * Inserts a material with one version and its files directly in the DB.
 * opts: { brandId, projectId, categorySlug, kind, title, createdBy, ownerId,
 *   visibility ('draft'|'internal_review'|'released'), archived, downloadEnabled,
 *   editableIncluded, files: [{ role, filename, buffer, position, mediaKind }] }
 * -> { material, version, files }
 */
export async function insertMaterial(ctx, opts) {
  const { db } = ctx;
  const at = now();
  const id = newId("mat");
  const versionId = newId("ver");
  const released = opts.visibility === "released";
  const createdBy = opts.createdBy;
  db.run(
    `INSERT INTO materials (id, kind, brand_id, project_id, category_id, title, owner_id, visibility, download_enabled,
       editable_included, requires_approval, approval_status, current_version_id, released_version_id, released_at,
       archived_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.kind ?? "asset",
      opts.brandId,
      opts.projectId ?? null,
      categoryId(ctx, opts.categorySlug ?? "logotipo"),
      opts.title ?? "Material de teste",
      opts.ownerId ?? createdBy,
      opts.visibility ?? "draft",
      opts.downloadEnabled === false ? 0 : 1,
      opts.editableIncluded ? 1 : 0,
      opts.requiresApproval === false ? 0 : 1,
      released && opts.requiresApproval !== false ? "pending" : "none",
      versionId,
      released ? versionId : null,
      released ? at : null,
      opts.archived ? at : null,
      createdBy,
      at,
      at,
    ],
  );
  if ((opts.kind ?? "asset") === "post")
    db.run("INSERT INTO post_details (material_id, network, format, planned_date) VALUES (?, ?, ?, ?)", [
      id,
      opts.network ?? "instagram",
      opts.format ?? "carrossel",
      opts.plannedDate ?? null,
    ]);
  db.run(
    `INSERT INTO material_versions (id, material_id, number, status, created_by, created_at, released_at, released_by)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    [versionId, id, released ? "released" : "draft", createdBy, at, released ? at : null, released ? createdBy : null],
  );
  const files = [];
  for (const [index, file] of (opts.files ?? [{ role: "original", filename: "logo.png", buffer: await png() }]).entries()) {
    const stored = await ctx.storage.putBuffer(file.buffer ?? Buffer.from("x"));
    const ext = extOf(file.filename);
    const fileId = newId("fil");
    db.run(
      `INSERT INTO material_files (id, version_id, material_id, role, position, original_name, display_name, ext, mime,
         size_bytes, sha256, storage_key, media_kind, preview_status, font_distributable, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unsupported', ?, ?, ?)`,
      [
        fileId,
        versionId,
        id,
        file.role ?? "original",
        file.position ?? index + 1,
        file.filename,
        file.filename,
        ext,
        mimeFor(ext),
        stored.size,
        stored.sha256,
        stored.key,
        file.mediaKind ?? kindForExt(ext) ?? "other",
        file.fontDistributable === undefined ? null : file.fontDistributable ? 1 : 0,
        createdBy,
        at,
      ],
    );
    files.push(db.get("SELECT * FROM material_files WHERE id = ?", [fileId]));
  }
  return {
    material: db.get("SELECT * FROM materials WHERE id = ?", [id]),
    version: db.get("SELECT * FROM material_versions WHERE id = ?", [versionId]),
    files,
  };
}

/** A fake Express request for calling lib/access.js and services directly. */
export function fakeReq(ctx, user) {
  const { password_hash, password, ...rest } = user;
  return { ctx, user: { ...rest }, ip: "127.0.0.1", get: () => undefined, headers: {} };
}

// ---------------------------------------------------------------- HTTP

async function readBody(response) {
  const type = response.headers.get("content-type") ?? "";
  if (response.status === 204) return null;
  if (type.includes("application/json")) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  if (type.startsWith("text/")) return response.text();
  return Buffer.from(await response.arrayBuffer());
}

/**
 * HTTP client bound to one cookie jar. Methods return { status, body, headers }.
 * Sends X-Metta-Request: 1 on every request.
 */
export function createAgent(server, { cookie = null } = {}) {
  const base = typeof server === "string" ? server : server.url;
  let jar = cookie;
  const request = async (method, path, { body, headers = {}, raw = false } = {}) => {
    const init = { method, headers: { "x-metta-request": "1", ...headers }, redirect: "manual" };
    if (jar) init.headers.cookie = jar;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${base}${path}`, init);
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const line of setCookie) {
      const [pair] = line.split(";");
      const [name, value] = pair.split("=");
      if (name.trim() === "metta_sid") jar = value ? `metta_sid=${value}` : null;
    }
    if (raw) return response;
    return { status: response.status, body: await readBody(response), headers: response.headers };
  };
  return {
    get cookie() {
      return jar;
    },
    set cookie(value) {
      jar = value;
    },
    request,
    get: (path, options) => request("GET", path, options),
    post: (path, body, options = {}) => request("POST", path, { ...options, body }),
    patch: (path, body, options = {}) => request("PATCH", path, { ...options, body }),
    put: (path, body, options = {}) => request("PUT", path, { ...options, body }),
    del: (path, options) => request("DELETE", path, options),
    upload(path, { buffer, filename, contentType = "application/octet-stream", field = "file", fields = {} }) {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
      form.append(field, new Blob([buffer], { type: contentType }), filename);
      return request("POST", path, { body: form });
    },
  };
}

/** Logs in through the API. -> agent with { user } (throws on failure). */
export async function login(server, { email, password = TEST_PASSWORD }) {
  const agent = createAgent(server);
  const res = await agent.post("/api/auth/login", { email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  agent.user = res.body.user;
  return agent;
}

// ---------------------------------------------------------------- files

const hexColor = (color) => color ?? "#202619";

export function png({ width = 64, height = 64, color } = {}) {
  return sharp({ create: { width, height, channels: 4, background: hexColor(color) } }).png().toBuffer();
}

export function jpg({ width = 64, height = 64, color } = {}) {
  return sharp({ create: { width, height, channels: 3, background: hexColor(color) } }).jpeg({ quality: 90 }).toBuffer();
}

export function svg({ width = 120, height = 60, color = "#202619" } = {}) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${color}"/></svg>`,
  );
}

// Minimal valid one-page PDF with a correct xref table.
export function pdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// One-second MP4 through ffmpeg when available, else null.
// mp4() | mp4({ ctx, width, height }) — ctx.config.ffmpegPath wins over PATH.
export async function mp4({ ctx, width = 64, height = 64 } = {}) {
  const bin = ctx?.config ? ctx.config.ffmpegPath : findOnPath("ffmpeg");
  if (!bin) return null;
  const out = join(tmpdir(), `metta-${unique()}.mp4`);
  try {
    await new Promise((resolve, reject) =>
      execFile(
        bin,
        ["-v", "error", "-f", "lavfi", "-i", `color=c=0x202619:s=${width}x${height}:d=1`, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", out],
        { timeout: 30000, windowsHide: true },
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    return readFileSync(out);
  } catch {
    return null;
  } finally {
    rmSync(out, { force: true });
  }
}

// Tiny TrueType-looking bytes (extension/signature tests only).
export function ttf() {
  return Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(60)]);
}

/** Polls fn until it returns a truthy value. */
export async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// Latest outbox e-mail for an address (tests read invite/reset links here).
export function lastEmail(ctx, to) {
  return ctx.db.get("SELECT * FROM email_outbox WHERE to_email = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [to.toLowerCase()]);
}

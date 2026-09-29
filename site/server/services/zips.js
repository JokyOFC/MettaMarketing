// Background ZIP packages (docs/PLATFORM.md §5). The request resolves and
// authorises the exact entry list; the worker streams those entries into a
// temporary zip with real byte progress and moves it into private storage.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { ZipArchive } from "archiver";
import { assertBrand, assertFile, assertMaterial, assertProject, scopeSql } from "../lib/access.js";
import { conflict, expired, notFound, rateLimited, validation } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { parseJson } from "../lib/serialize.js";
import { getSetting } from "../lib/settings.js";
import { addHours, now } from "../lib/time.js";
import { z } from "../lib/validate.js";
import {
  assertKit,
  kitMaterialRows,
  loadMaterialRows,
  MATERIAL_SELECT,
  removeStorageIfUnreferenced,
  zipEntries,
  zipFilename,
} from "./materials.js";

export const MAX_ZIP_FILES = 5000;
const MAX_ACTIVE_PER_USER = 4;
const PROGRESS_INTERVAL_MS = 250;
const ACTIVE = ["queued", "running"];

// ------------------------------------------------------------------ scope

const id = z.string().trim().min(1).max(64);
const editables = z.boolean().optional();
// Name the page gives a mixed selection (e.g. "Tudo de Aurora"); kept in the
// stored scope so a retry keeps it.
export const zipLabelSchema = z
  .string()
  .trim()
  .max(80, "Use no máximo 80 caracteres.")
  .optional()
  .transform((value) => value || undefined);
export const zipScopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("selection"),
    fileIds: z.array(id).max(MAX_ZIP_FILES).optional(),
    materialIds: z.array(id).max(1000).optional(),
    includeEditables: editables,
    label: zipLabelSchema,
  }),
  z.object({ type: z.literal("category"), brandId: id, categoryId: id, includeEditables: editables }),
  z.object({ type: z.literal("brand_kit"), brandId: id, includeEditables: editables }),
  z.object({ type: z.literal("carousel"), materialId: id, includeEditables: editables }),
  z.object({ type: z.literal("project"), projectId: id, includeEditables: editables }),
  z.object({ type: z.literal("kit"), kitId: id, includeEditables: editables }),
]);

const unique = (list) => [...new Set((list ?? []).filter(Boolean))];
const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * Name of a selection ZIP from what it really contains:
 *   one material        "<título> · N arquivos"   <marca>-<título>-<data>.zip
 *   one category        "<categoria> · N arquivos" <marca>-<categoria>-<data>.zip
 *   otherwise the page's label when given, else "Seleção · N arquivos".
 */
function selectionName(rows, entries, { brandName, requested }) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const used = [...new Set(entries.map((entry) => entry.materialId))].map((materialId) => byId.get(materialId)).filter(Boolean);
  const count = entries.length;
  const files = `${count} ${plural(count, "arquivo", "arquivos")}`;
  const base = brandName ?? "metta";
  if (used.length === 1) return { label: `${used[0].title} · ${files}`, filename: zipFilename(base, used[0].title) };
  const categories = new Set(used.map((row) => row.category_id));
  if (used.length && categories.size === 1)
    return { label: `${used[0].cat_name} · ${files}`, filename: zipFilename(base, used[0].cat_name) };
  const text = typeof requested === "string" ? requested.trim().slice(0, 80) : "";
  if (text) return { label: text, filename: zipFilename(base, text) };
  return { label: `Seleção · ${files}`, filename: zipFilename(base, "selecao") };
}

// Rows of the viewer's scope matching an extra WHERE (active materials only).
function scopedRows(req, where, params) {
  const s = scopeSql.materials(req, "m", "b");
  return req.ctx.db.all(`${MATERIAL_SELECT} WHERE ${where} AND m.archived_at IS NULL AND ${s.sql}`, [...params, ...s.params]);
}

// Two entry lists built separately may share a path: keep the first, suffix the rest.
function mergeEntries(lists) {
  const seenFiles = new Set();
  const taken = new Set();
  const out = [];
  for (const entry of lists.flat()) {
    if (seenFiles.has(entry.fileId)) continue;
    seenFiles.add(entry.fileId);
    let path = entry.path;
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${stem} (${n})${ext}`;
    taken.add(path.toLowerCase());
    out.push({ ...entry, path });
  }
  return out;
}

/**
 * resolveZipScope(req, scope) -> { entries, label, filename, clientId, brandId }
 * Every id is resolved through lib/access.js (404 out of scope; clients get
 * only visible, downloadable files — editables only when included, fonts only
 * when distributable). Selected files that cannot be downloaded answer 403.
 */
export function resolveZipScope(req, scope) {
  const { db } = req.ctx;
  const includeEditables = scope.includeEditables !== false;
  let entries;
  let label;
  let filename;
  let brand = null;

  switch (scope.type) {
    case "selection": {
      const fileIds = unique(scope.fileIds);
      const materialIds = unique(scope.materialIds);
      if (!fileIds.length && !materialIds.length) throw validation({ "scope.fileIds": "Selecione pelo menos um arquivo." });
      const files = fileIds.map((fileId) => assertFile(req, fileId, { download: true }));
      for (const materialId of materialIds) assertMaterial(req, materialId);
      const fileRows = loadMaterialRows(db, files.map((f) => f.material_id));
      const materialRows = loadMaterialRows(db, materialIds);
      entries = mergeEntries([
        zipEntries(req, fileRows, { fileIds }),
        zipEntries(req, materialRows, { includeEditables }),
      ]);
      const rows = [...fileRows, ...materialRows];
      const brands = new Set(rows.map((row) => row.brand_id));
      if (brands.size === 1) brand = { id: rows[0].brand_id, name: rows[0].brand_name, client_id: rows[0].client_id };
      ({ label, filename } = selectionName(rows, entries, { brandName: brand?.name ?? rows[0]?.client_name, requested: scope.label }));
      break;
    }
    case "category": {
      brand = assertBrand(req, scope.brandId);
      const category = db.get("SELECT * FROM categories WHERE id = ?", [scope.categoryId]);
      if (!category) throw notFound();
      const rows = scopedRows(req, "m.brand_id = ? AND m.category_id = ?", [brand.id, category.id]);
      entries = zipEntries(req, rows, { includeEditables });
      label = `${category.name} · ${brand.name}`;
      filename = zipFilename(brand.name, category.name);
      break;
    }
    case "brand_kit": {
      brand = assertBrand(req, scope.brandId);
      const rows = scopedRows(req, "m.brand_id = ? AND cat.area = 'identity'", [brand.id]);
      entries = zipEntries(req, rows, { includeEditables });
      label = `Kit de marca · ${brand.name}`;
      filename = zipFilename(brand.name, "kit de marca");
      break;
    }
    case "carousel": {
      assertMaterial(req, scope.materialId);
      const [row] = loadMaterialRows(db, [scope.materialId]);
      brand = { id: row.brand_id, name: row.brand_name, client_id: row.client_id };
      entries = zipEntries(req, [row], { layout: "carousel", root: `${row.brand_name} - ${row.title}`, includeEditables });
      label = `Carrossel · ${row.title}`;
      filename = zipFilename(row.brand_name, row.title);
      break;
    }
    case "project": {
      const project = assertProject(req, scope.projectId);
      brand = db.get("SELECT * FROM brands WHERE id = ?", [project.brand_id]);
      const rows = scopedRows(req, "m.project_id = ?", [project.id]);
      entries = zipEntries(req, rows, { root: `${brand.name} - ${project.name}`, includeEditables });
      label = `Pacote final · ${project.name}`;
      filename = zipFilename(brand.name, project.name);
      break;
    }
    case "kit": {
      const kit = assertKit(req, scope.kitId);
      brand = { id: kit.brand_id, name: kit.brand_name, client_id: kit.client_id };
      entries = zipEntries(req, kitMaterialRows(req, kit.id), { root: `${kit.brand_name} - ${kit.name}`, includeEditables });
      label = `Kit · ${kit.name}`;
      filename = zipFilename(kit.brand_name, kit.name);
      break;
    }
    default:
      throw validation({ "scope.type": "Tipo de pacote inválido." });
  }

  if (!entries.length) throw notFound("Não há arquivos disponíveis para download neste pacote.");
  if (entries.length > MAX_ZIP_FILES)
    throw validation({ scope: `O pacote passa de ${MAX_ZIP_FILES} arquivos. Baixe por categoria ou projeto.` }, "Pacote grande demais.");
  return { entries, label, filename, brandId: brand?.id ?? null, clientId: brand?.client_id ?? null };
}

// ------------------------------------------------------------------- jobs

export function zipRetentionHours(ctx) {
  const value = Number(getSetting(ctx.db, "zipRetentionHours", ctx.config.zipRetentionHours));
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(value, 1), 24 * 30) : 24;
}

const isExpired = (row) => row.status === "ready" && row.expires_at && new Date(row.expires_at).getTime() <= Date.now();

// ZipJob (docs/API.md). The requested scope comes back so the tray can retry.
export function serializeZipJob(row) {
  const status = isExpired(row) ? "expired" : row.status;
  const total = row.total_bytes ?? 0;
  const processed = status === "ready" ? total : Math.min(row.processed_bytes ?? 0, total);
  const scope = parseJson(row.scope, null);
  return {
    id: row.id,
    label: row.label,
    filename: row.filename,
    status,
    fileCount: row.file_count,
    totalBytes: total,
    processedBytes: processed,
    progress: status === "ready" ? 1 : total > 0 ? Math.min(1, processed / total) : 0,
    sizeBytes: row.size_bytes ?? null,
    error: row.error ?? null,
    scope,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

// Scope with sorted keys and id lists: the same request always hashes alike.
function stableScope(scope) {
  const out = {};
  for (const key of Object.keys(scope).sort()) {
    const value = scope[key];
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? [...new Set(value)].sort() : value;
  }
  return out;
}

/**
 * createZipJob(req, scope) -> zip_jobs row. An identical request (same user,
 * same scope, same label and same entries) that is still queued, running or
 * ready is reused; a different scope never borrows another job's name.
 */
export async function createZipJob(req, scope) {
  const { db, jobs, storage } = req.ctx;
  const resolved = resolveZipScope(req, scope);
  const entries = resolved.entries.map((e) => ({ f: e.fileId, m: e.materialId, p: e.path, s: e.store ? 1 : 0, n: e.sizeBytes }));
  const entriesJson = JSON.stringify(entries);
  const hash = createHash("sha256")
    .update(JSON.stringify({ scope: stableScope(scope), label: resolved.label, filename: resolved.filename }))
    .update("|")
    .update(entriesJson)
    .digest("hex");
  const at = now();

  const existing = db.get(
    `SELECT * FROM zip_jobs WHERE user_id = ? AND entries_hash = ? AND status IN ('queued', 'running', 'ready')
       AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1`,
    [req.user.id, hash, at],
  );
  if (existing && (existing.status !== "ready" || (existing.storage_key && (await storage.exists(existing.storage_key)))))
    return existing;
  const active = db.get("SELECT COUNT(*) AS n FROM zip_jobs WHERE user_id = ? AND status IN ('queued', 'running')", [req.user.id]).n;
  if (active >= MAX_ACTIVE_PER_USER)
    throw rateLimited("Você já tem pacotes sendo preparados. Aguarde um deles terminar para pedir outro.");

  const jobId = newId("zip");
  const { type, ...rest } = scope;
  db.run(
    `INSERT INTO zip_jobs (id, user_id, client_id, brand_id, scope, label, filename, status, file_count, total_bytes,
       processed_bytes, entries, entries_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?)`,
    [
      jobId,
      req.user.id,
      resolved.clientId,
      resolved.brandId,
      JSON.stringify({ type, ...rest }),
      resolved.label,
      resolved.filename,
      entries.length,
      entries.reduce((sum, e) => sum + (e.n ?? 0), 0),
      entriesJson,
      hash,
      at,
    ],
  );
  jobs?.enqueue("zips", { jobId });
  return db.get("SELECT * FROM zip_jobs WHERE id = ?", [jobId]);
}

// Owner-only lookup (404 for anybody else).
export function assertZipJob(req, jobId) {
  const row = jobId ? req.ctx.db.get("SELECT * FROM zip_jobs WHERE id = ? AND user_id = ?", [jobId, req.user.id]) : null;
  if (!row) throw notFound();
  return row;
}

// Ready and not expired, or 409/410 with a message for the tray.
export function assertZipReady(row) {
  if (row.status === "expired" || isExpired(row)) throw expired("Este ZIP expirou. Gere o pacote de novo.");
  if (row.status === "failed") throw conflict(row.error || "Não foi possível gerar este ZIP. Tente de novo.");
  if (row.status !== "ready" || !row.storage_key) throw conflict("O ZIP ainda está sendo preparado.");
  return row;
}

export const ZIP_CHANGED_MESSAGE = "O conteúdo deste pacote mudou desde que foi gerado. Gere o ZIP de novo.";
export const ZIP_GONE_MESSAGE = "Este ZIP não está mais disponível. Gere o pacote de novo.";

/**
 * zipLinkProblem(req, row) -> null | pt-BR message. The checks /dl makes,
 * run before issuing a link too, so the tray learns about them: every file
 * still downloadable by this user, and the stored ZIP still there.
 */
export async function zipLinkProblem(req, row) {
  if (!zipStillAllowed(req, row)) return ZIP_CHANGED_MESSAGE;
  if (!row.storage_key || !(await req.ctx.storage.exists(row.storage_key))) return ZIP_GONE_MESSAGE;
  return null;
}

/**
 * A ready ZIP that can no longer be downloaded becomes 'expired' with the
 * reason in `error` (GET /api/zips/:id shows it) and its stored file is
 * freed. Never throws.
 */
export async function retireZipJob(ctx, row, message) {
  try {
    ctx.db.run("UPDATE zip_jobs SET status = 'expired', storage_key = NULL, error = ? WHERE id = ? AND status = 'ready'", [
      message,
      row.id,
    ]);
    if (row.storage_key) await removeStorageIfUnreferenced(ctx, row.storage_key);
  } catch (err) {
    ctx.log?.warn?.(`[zips] could not retire ${row.id}: ${err.message}`);
  }
}

/**
 * Re-checks, at download time, that every file of the package is still
 * downloadable by this user. -> true | false
 */
export function zipStillAllowed(req, row) {
  const entries = parseJson(row.entries, []);
  for (const entry of entries) {
    try {
      assertFile(req, entry.f, { download: true });
    } catch {
      return false;
    }
  }
  return true;
}

class FriendlyError extends Error {}

const nameOf = (path) => String(path).split("/").pop();

function writeArchive(ctx, entries, target, { totalBytes, onBytes }) {
  const { storage } = ctx;
  return new Promise((resolve, reject) => {
    const output = createWriteStream(target, { flags: "wx" });
    // ZIP64 only when needed; level 6 is a good speed/size balance.
    const archive = new ZipArchive({ zlib: { level: 6 }, forceZip64: totalBytes > 0xf0000000 });
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      try {
        archive.abort();
      } catch {
        // already closed
      }
      output.destroy();
      reject(err);
    };
    archive.on("error", fail);
    archive.on("warning", fail);
    output.on("error", fail);
    output.on("close", () => {
      if (!failed) resolve(archive.pointer());
    });
    archive.pipe(output);

    // one entry at a time: only one stored file is open, progress is exact
    let index = 0;
    const next = () => {
      if (failed) return;
      if (index >= entries.length) {
        Promise.resolve(archive.finalize()).catch(fail);
        return;
      }
      const entry = entries[index++];
      const source = storage.createReadStream(entry.key);
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          onBytes(chunk.length);
          callback(null, chunk);
        },
      });
      source.on("error", () => fail(new FriendlyError(`Não foi possível ler “${nameOf(entry.p)}” do armazenamento. Avise a equipe Metta.`)));
      source.pipe(counter);
      archive.append(counter, { name: entry.p, store: entry.s === 1, date: entry.date ? new Date(entry.date) : new Date() });
    };
    archive.on("entry", next);
    next();
  });
}

/**
 * runZipJob(ctx, jobId) — worker for the 'zips' queue. Marks the job
 * running, writes processed_bytes at most every 250 ms, then ready (with
 * expires_at) or failed with a pt-BR message.
 */
export async function runZipJob(ctx, jobId) {
  const { db, storage } = ctx;
  const job = db.get("SELECT * FROM zip_jobs WHERE id = ?", [jobId]);
  if (!job || job.status !== "queued") return null;
  const started = db.run("UPDATE zip_jobs SET status = 'running', started_at = ?, processed_bytes = 0 WHERE id = ? AND status = 'queued'", [
    now(),
    jobId,
  ]);
  if (!started.changes) return null;

  const tmp = storage.tmpFile("zip");
  try {
    const entries = parseJson(job.entries, []);
    if (!entries.length) throw new FriendlyError("Este pacote não tem arquivos.");
    const ids = [...new Set(entries.map((e) => e.f))];
    const files = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const row of db.all(
        `SELECT id, storage_key, created_at FROM material_files WHERE id IN (${chunk.map(() => "?").join(", ")})`,
        chunk,
      ))
        files.set(row.id, row);
    }
    // every stored object must exist before we start writing
    let totalBytes = 0;
    for (const entry of entries) {
      const file = files.get(entry.f);
      if (!file) throw new FriendlyError(`O arquivo “${nameOf(entry.p)}” foi removido depois do pedido. Gere o ZIP de novo.`);
      const info = await storage.stat(file.storage_key);
      if (!info)
        throw new FriendlyError(`O arquivo “${nameOf(entry.p)}” não foi encontrado no armazenamento. Avise a equipe Metta.`);
      entry.key = file.storage_key;
      entry.date = file.created_at;
      totalBytes += info.size;
    }
    db.run("UPDATE zip_jobs SET total_bytes = ? WHERE id = ?", [totalBytes, jobId]);

    let processed = 0;
    let lastWrite = 0;
    const flush = () => {
      lastWrite = Date.now();
      db.run("UPDATE zip_jobs SET processed_bytes = ? WHERE id = ?", [processed, jobId]);
    };
    const size = await writeArchive(ctx, entries, tmp, {
      totalBytes,
      onBytes(bytes) {
        processed += bytes;
        if (Date.now() - lastWrite >= PROGRESS_INTERVAL_MS) flush();
      },
    });
    const stored = await storage.putFile(tmp, { move: true });
    const at = now();
    db.run(
      `UPDATE zip_jobs SET status = 'ready', storage_key = ?, size_bytes = ?, processed_bytes = total_bytes,
         finished_at = ?, expires_at = ?, error = NULL WHERE id = ?`,
      [stored.key, stored.size ?? size, at, addHours(zipRetentionHours(ctx), at), jobId],
    );
    return "ready";
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    if (!(err instanceof FriendlyError)) ctx.log?.error?.(`[zips] ${jobId} failed:`, err);
    const message = err instanceof FriendlyError ? err.message : "Não foi possível gerar o ZIP. Tente de novo em instantes.";
    db.run("UPDATE zip_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [message, now(), jobId]);
    return "failed";
  }
}

// ------------------------------------------------------------ maintenance

// Jobs interrupted by a restart never finish (the queue lives in memory).
export function failInterruptedZips(ctx) {
  return ctx.db.run(
    `UPDATE zip_jobs SET status = 'failed', finished_at = ?,
       error = 'A geração foi interrompida porque o servidor reiniciou. Tente de novo.'
     WHERE status IN (${ACTIVE.map(() => "?").join(", ")})`,
    [now(), ...ACTIVE],
  ).changes;
}

// Ready ZIPs past ZIP retention become 'expired' and their files are deleted.
export async function expireZips(ctx) {
  const rows = ctx.db.all("SELECT id, storage_key FROM zip_jobs WHERE status = 'ready' AND expires_at <= ?", [now()]);
  for (const row of rows) {
    ctx.db.run("UPDATE zip_jobs SET status = 'expired', storage_key = NULL WHERE id = ?", [row.id]);
    try {
      await removeStorageIfUnreferenced(ctx, row.storage_key);
    } catch (err) {
      ctx.log?.warn?.(`[zips] could not remove an expired zip: ${err.message}`);
    }
  }
  return rows.length;
}

// Temporary files left behind by a crash (uploads and ZIPs in progress are
// much younger than a day).
export async function cleanupTmp(ctx, { olderThanHours = 24 } = {}) {
  const dir = ctx.config.tmpDir;
  const cutoff = Date.now() - olderThanHours * 3600 * 1000;
  let removed = 0;
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (info.isFile() && info.mtimeMs < cutoff) {
        await rm(full, { force: true });
        removed += 1;
      }
    } catch {
      // gone already
    }
  }
  return removed;
}

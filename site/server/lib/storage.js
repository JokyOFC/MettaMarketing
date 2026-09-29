import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { copyFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError, payloadTooLarge } from "./errors.js";

// Opaque keys: 32 hex chars, stored sharded as ab/cd/<key>. Keys never carry
// user input, so a key can never escape the storage root.
const KEY_PATTERN = /^[a-f0-9]{32}$/;
const newKey = () => randomBytes(16).toString("hex");

/**
 * Private local storage under DATA_DIR/storage (never under public/ or dist/).
 * createStorage(config) -> { driver, root, putStream, putBuffer, putFile,
 *   createReadStream, stat, remove, exists, localPath, tmpFile, usage }
 */
export function createStorage(config) {
  const root = config.storageDir;
  const tmpDir = config.tmpDir;
  mkdirSync(root, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  function pathFor(key) {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) throw new Error("invalid storage key");
    return join(root, key.slice(0, 2), key.slice(2, 4), key);
  }

  async function place(tmpPath, { move = true } = {}) {
    const key = newKey();
    const target = pathFor(key);
    mkdirSync(join(root, key.slice(0, 2), key.slice(2, 4)), { recursive: true });
    if (move) {
      try {
        await rename(tmpPath, target);
      } catch (err) {
        if (err.code !== "EXDEV") throw err;
        await copyFile(tmpPath, target);
        await rm(tmpPath, { force: true });
      }
    } else {
      await copyFile(tmpPath, target);
    }
    return key;
  }

  // Temporary file path inside DATA_DIR/tmp (caller removes it).
  function tmpFile(ext = "") {
    const suffix = ext ? `.${String(ext).replace(/^\./, "").replace(/[^a-z0-9]/gi, "")}` : "";
    return join(tmpDir, `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}${suffix}`);
  }

  /**
   * Streams into storage while hashing. Over maxBytes: stops, removes the
   * partial file, drains the source and throws 413 payload_too_large.
   * -> { key, size, sha256 }
   */
  function putStream(readable, { maxBytes = Infinity } = {}) {
    const tmp = tmpFile();
    const hash = createHash("sha256");
    let size = 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      const out = createWriteStream(tmp, { flags: "wx" });
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > maxBytes) return callback(payloadTooLarge());
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const fail = (err) => {
        if (settled) return;
        settled = true;
        readable.unpipe?.(counter);
        counter.destroy();
        out.destroy();
        rm(tmp, { force: true }).catch(() => {});
        // let multipart parsers continue past the rest of this file
        if (!readable.destroyed) readable.resume?.();
        reject(err instanceof HttpError ? err : Object.assign(err, { storage: true }));
      };
      readable.on("error", fail);
      counter.on("error", fail);
      out.on("error", fail);
      out.on("finish", () => {
        if (settled) return;
        place(tmp)
          .then((key) => {
            settled = true;
            resolve({ key, size, sha256: hash.digest("hex") });
          })
          .catch(fail);
      });
      readable.pipe(counter).pipe(out);
    });
  }

  async function putBuffer(buffer) {
    const tmp = tmpFile();
    await writeFile(tmp, buffer, { flag: "wx" });
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const key = await place(tmp);
    return { key, size: buffer.length, sha256 };
  }

  // Copies (or moves, with { move: true }) a local file into storage.
  async function putFile(filePath, { move = false } = {}) {
    const hash = createHash("sha256");
    await pipeline(createReadStream(filePath), hash);
    const info = await stat(filePath);
    const key = await place(filePath, { move });
    return { key, size: info.size, sha256: hash.digest("hex") };
  }

  return {
    driver: "local",
    root,
    tmpFile,
    tmpPath: tmpFile,
    putStream,
    putBuffer,
    putFile,
    // put(buffer | readable, opts) — alias named in docs/PLATFORM.md
    put(source, options) {
      return Buffer.isBuffer(source) ? putBuffer(source) : putStream(source, options);
    },
    // { start, end } are inclusive byte offsets (HTTP Range semantics).
    createReadStream(key, range = {}) {
      const options = {};
      if (Number.isInteger(range.start)) options.start = range.start;
      if (Number.isInteger(range.end)) options.end = range.end;
      return createReadStream(pathFor(key), options);
    },
    async stat(key) {
      try {
        const info = await stat(pathFor(key));
        return { size: info.size, modifiedAt: info.mtime.toISOString() };
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
    async exists(key) {
      return Boolean(await this.stat(key));
    },
    async remove(key) {
      if (!key) return;
      await rm(pathFor(key), { force: true });
    },
    // Local path for tools that need a file (sharp, ffmpeg, archiver).
    localPath(key) {
      return pathFor(key);
    },
    // { files, usedBytes } — walks the storage tree (settings screen).
    async usage() {
      let files = 0;
      let usedBytes = 0;
      async function walk(dir) {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) {
            files += 1;
            usedBytes += (await stat(full)).size;
          }
        }
      }
      await walk(root);
      return { files, usedBytes };
    },
  };
}

export const isStorageKey = (key) => typeof key === "string" && KEY_PATTERN.test(key);

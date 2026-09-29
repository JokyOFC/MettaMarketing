// Thin synchronous wrapper over node:sqlite with a prepared-statement cache,
// parameter coercion and nested transactions (SAVEPOINT).

// node:sqlite still prints an ExperimentalWarning on load; keep logs clean
// without hiding any other warning.
const emitWarning = process.emitWarning;
process.emitWarning = function filteredEmitWarning(warning, ...args) {
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  const message = typeof warning === "string" ? warning : warning?.message;
  if (type === "ExperimentalWarning" && /sqlite/i.test(String(message))) return;
  return emitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = emitWarning;

const CACHE_LIMIT = 400;

// node:sqlite binds every JS number as REAL; integers go in as BigInt so they
// keep INTEGER storage in untyped/TEXT columns too.
function coerce(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

function bindParams(params) {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params.map(coerce);
  if (typeof params === "object" && !(params instanceof Uint8Array)) {
    const out = {};
    for (const [key, value] of Object.entries(params)) out[key] = coerce(value);
    return [out];
  }
  return [coerce(params)];
}

const plain = (row) => (row ? { ...row } : undefined);

/**
 * openDb(file | ':memory:') -> { get, all, run, exec, tx, afterCommit, close, raw }
 * params: array for `?` placeholders, plain object for `:named` ones (a
 * single scalar is accepted too). undefined -> NULL, booleans -> 0/1.
 */
export function openDb(file) {
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA synchronous = NORMAL");

  const cache = new Map();
  let depth = 0;
  let pending = [];
  let closed = false;

  function statement(sql) {
    let stmt = cache.get(sql);
    if (stmt) {
      // keep recently used statements at the end of the map
      cache.delete(sql);
      cache.set(sql, stmt);
      return stmt;
    }
    stmt = raw.prepare(sql);
    stmt.setAllowUnknownNamedParameters?.(true);
    cache.set(sql, stmt);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return stmt;
  }

  function flushAfterCommit() {
    const callbacks = pending;
    pending = [];
    for (const fn of callbacks) {
      try {
        fn();
      } catch (err) {
        console.error("[db] afterCommit callback failed:", err);
      }
    }
  }

  const db = {
    raw,
    get(sql, params) {
      return plain(statement(sql).get(...bindParams(params)));
    },
    all(sql, params) {
      return statement(sql).all(...bindParams(params)).map(plain);
    },
    run(sql, params) {
      const result = statement(sql).run(...bindParams(params));
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    exec(sql) {
      raw.exec(sql);
    },
    // Runs fn inside BEGIN IMMEDIATE (outermost) or a SAVEPOINT (nested).
    // fn must be synchronous; anything thrown rolls back and is rethrown.
    tx(fn) {
      const outer = depth === 0;
      const savepoint = `sp_${depth}`;
      raw.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      depth += 1;
      const mark = pending.length;
      let result;
      try {
        result = fn(db);
        if (result && typeof result.then === "function")
          throw new Error("db.tx callback must be synchronous");
      } catch (err) {
        depth -= 1;
        try {
          raw.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        } catch {
          // the original error matters more
        }
        pending.length = mark;
        throw err;
      }
      depth -= 1;
      raw.exec(outer ? "COMMIT" : `RELEASE ${savepoint}`);
      if (outer) flushAfterCommit();
      return result;
    },
    inTransaction() {
      return depth > 0;
    },
    // Defers side effects (job enqueue, e-mail) until the outermost commit;
    // runs immediately outside a transaction, dropped on rollback.
    afterCommit(fn) {
      if (depth > 0) pending.push(fn);
      else fn();
    },
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      raw.close();
    },
  };
  return db;
}

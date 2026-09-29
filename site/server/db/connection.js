// MySQL access through a mysql2 pool, with the surface the code already uses:
// get / all / run / exec / tx / afterCommit / inTransaction / close.
//
// - Queries issued inside db.tx() run on the transaction's connection, found
//   through AsyncLocalStorage, so helpers called inside a transaction join it.
// - Top-level transactions run one at a time in this process (like SQLite's
//   BEGIN IMMEDIATE); nested db.tx() calls use SAVEPOINTs. A deadlock or lock
//   timeout retries the whole transaction (up to 3 attempts).
// - afterCommit callbacks run after the outermost COMMIT, outside the
//   transaction context; they are dropped on rollback.
// - Sessions use PIPES_AS_CONCAT (|| concatenates text) and report matched
//   rows as `changes` (FOUND_ROWS), as SQLite did.
import { AsyncLocalStorage } from "node:async_hooks";
import mysql from "mysql2/promise";

const SQL_MODE = [
  "PIPES_AS_CONCAT",
  "STRICT_TRANS_TABLES",
  "NO_ZERO_IN_DATE",
  "NO_ZERO_DATE",
  "ERROR_FOR_DIVISION_BY_ZERO",
  "NO_ENGINE_SUBSTITUTION",
].join(",");
const RETRYABLE = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);
const MAX_ATTEMPTS = 3;

// undefined -> NULL, booleans -> 0/1, Date -> ISO string. Plain objects are
// refused: mysql2 would expand them into `key = value` lists.
function coerce(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    throw new TypeError("db: query parameters must be scalars (stringify objects before binding)");
  return value;
}

function bindParams(params) {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params.map(coerce);
  return [coerce(params)];
}

const plain = (row) => (row ? { ...row } : undefined);

// Lists built from arrays may come out empty. SQLite reads `x IN ()` as false
// and `x NOT IN ()` as true; MySQL rejects the syntax, so an empty subquery
// keeps that meaning.
const EMPTY_IN = /\bIN\s*\(\s*\)/i;
const withEmptyLists = (sql) =>
  EMPTY_IN.test(sql) ? sql.replace(/\bIN\s*\(\s*\)/gi, "IN (SELECT NULL FROM DUAL WHERE FALSE)") : sql;

/** Parses DATABASE_URL (mysql://user:pass@host:port/database). */
export function parseDatabaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL must look like mysql://user:password@host:3306/database");
  }
  if (!/^mysql2?:$/.test(parsed.protocol)) throw new Error("DATABASE_URL must start with mysql://");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || !/^[A-Za-z0-9_$-]+$/.test(database)) throw new Error("DATABASE_URL must name the database, e.g. mysql://…/metta");
  return {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username || "root"),
    password: decodeURIComponent(parsed.password || ""),
    database,
    ssl: parsed.searchParams.get("ssl") === "true" ? {} : undefined,
  };
}

const connectionOptions = (settings) => ({
  host: settings.host,
  port: settings.port,
  user: settings.user,
  password: settings.password,
  ssl: settings.ssl,
  charset: "utf8mb4",
  timezone: "Z",
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: true,
  flags: ["FOUND_ROWS"],
});

// Creates the database when it does not exist yet (needs the CREATE privilege).
async function ensureDatabase(settings) {
  const conn = await mysql.createConnection(connectionOptions(settings));
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${settings.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    );
  } finally {
    await conn.end();
  }
}

/** Drops the database named in `url` (tests). */
export async function dropDatabase(url) {
  const settings = parseDatabaseUrl(url);
  const conn = await mysql.createConnection(connectionOptions(settings));
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${settings.database}\``);
  } finally {
    await conn.end();
  }
}

/** Names of the databases on the server of `url` that start with `prefix`. */
export async function listDatabases(url, prefix) {
  const settings = parseDatabaseUrl(url);
  const conn = await mysql.createConnection(connectionOptions(settings));
  try {
    const [rows] = await conn.query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE ?", [
      `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    ]);
    return rows.map((row) => row.name);
  } finally {
    await conn.end();
  }
}

/**
 * openDb(url, { poolSize, createDatabase }) -> db
 * params: array for `?` placeholders (a single scalar is accepted too).
 */
export async function openDb(url, { poolSize = 10, createDatabase = true } = {}) {
  const settings = parseDatabaseUrl(url);
  const options = { ...connectionOptions(settings), database: settings.database };
  const probe = await mysql.createConnection(options).catch(async (err) => {
    if (err?.code !== "ER_BAD_DB_ERROR" || !createDatabase) throw err;
    await ensureDatabase(settings);
    return mysql.createConnection(options);
  });
  await probe.end();

  const pool = mysql.createPool({ ...options, connectionLimit: poolSize, waitForConnections: true, queueLimit: 0 });
  // Runs before any other command on the new connection (commands are queued
  // in order). The event hands over the core (callback) connection.
  pool.on("connection", (conn) => {
    conn.query(`SET SESSION sql_mode = '${SQL_MODE}'`, (err) => {
      if (err) console.error("[db] could not set sql_mode:", err.message);
    });
  });

  const als = new AsyncLocalStorage();
  let lockTail = Promise.resolve();
  let closed = false;

  // FIFO mutex for top-level transactions.
  async function acquireTxLock() {
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const previous = lockTail;
    lockTail = previous.then(() => next);
    await previous;
    return release;
  }

  const active = () => {
    const store = als.getStore();
    return store?.active ? store : null;
  };
  const target = () => active()?.conn ?? pool;

  async function query(sql, params) {
    const [result] = await target().query(withEmptyLists(sql), bindParams(params));
    return result;
  }

  function flushAfterCommit(callbacks) {
    for (const fn of callbacks) {
      try {
        const result = fn();
        if (result && typeof result.then === "function")
          result.catch((err) => console.error("[db] afterCommit callback failed:", err));
      } catch (err) {
        console.error("[db] afterCommit callback failed:", err);
      }
    }
  }

  const db = {
    pool,
    database: settings.database,
    async get(sql, params) {
      const rows = await query(sql, params);
      return plain(Array.isArray(rows) ? rows[0] : undefined);
    },
    async all(sql, params) {
      const rows = await query(sql, params);
      return Array.isArray(rows) ? rows.map(plain) : [];
    },
    async run(sql, params) {
      const result = await query(sql, params);
      return { changes: Number(result?.affectedRows ?? 0), lastInsertRowid: Number(result?.insertId ?? 0) };
    },
    // One statement (migrations use runScript for whole files).
    async exec(sql) {
      await target().query(sql);
    },
    // Runs fn inside a transaction (outermost) or a SAVEPOINT (nested).
    // Anything thrown rolls back and is rethrown.
    async tx(fn) {
      const store = active();
      if (store) {
        store.depth += 1;
        const savepoint = `sp_${store.depth}`;
        const mark = store.pending.length;
        await store.conn.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await fn(db);
          await store.conn.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (err) {
          try {
            await store.conn.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await store.conn.query(`RELEASE SAVEPOINT ${savepoint}`);
          } catch {
            // the original error matters more
          }
          store.pending.length = mark;
          throw err;
        } finally {
          store.depth -= 1;
        }
      }

      const release = await acquireTxLock();
      try {
        for (let attempt = 1; ; attempt += 1) {
          const conn = await pool.getConnection();
          const tx = { conn, depth: 0, pending: [], active: true };
          let result;
          try {
            await conn.query("START TRANSACTION");
            result = await als.run(tx, () => fn(db));
            await conn.query("COMMIT");
          } catch (err) {
            tx.active = false;
            try {
              await conn.query("ROLLBACK");
            } catch {
              // connection already broken
            }
            conn.release();
            if (RETRYABLE.has(err?.code) && attempt < MAX_ATTEMPTS) continue;
            throw err;
          }
          tx.active = false;
          conn.release();
          als.exit(() => flushAfterCommit(tx.pending));
          return result;
        }
      } finally {
        release();
      }
    },
    inTransaction() {
      return Boolean(active());
    },
    // Defers side effects (job enqueue, e-mail) until the outermost commit;
    // runs immediately outside a transaction, dropped on rollback.
    afterCommit(fn) {
      const store = active();
      if (store) store.pending.push(fn);
      else flushAfterCommit([fn]);
    },
    // Runs fn outside any transaction context (background work started from
    // inside a transaction must not use its connection).
    detached(fn) {
      return als.exit(fn);
    },
    // Executes a whole SQL file (migrations) on a dedicated connection.
    async runScript(sql) {
      const conn = await mysql.createConnection({ ...options, multipleStatements: true });
      try {
        await conn.query(`SET SESSION sql_mode = '${SQL_MODE}'`);
        await conn.query(sql);
      } finally {
        await conn.end();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
  return db;
}

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// Applies server/db/migrations/*.sql in lexical order, each in its own
// transaction. Returns the names applied in this call.
export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(db.all("SELECT name FROM schema_migrations").map((row) => row.name));
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    db.tx(() => {
      db.exec(sql);
      db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [
        name,
        new Date().toISOString(),
      ]);
    });
    applied.push(name);
  }
  return applied;
}

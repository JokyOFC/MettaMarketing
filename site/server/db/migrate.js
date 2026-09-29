import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// Applies server/db/migrations/*.sql in lexical order. MySQL commits DDL
// implicitly, so a file is recorded as applied only after it ran completely
// (a failure halfway needs a manual look). Returns the names applied now.
export async function migrate(db, dir = MIGRATIONS_DIR) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       VARCHAR(191) NOT NULL,
    applied_at VARCHAR(32) NOT NULL,
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
  const done = new Set((await db.all("SELECT name FROM schema_migrations")).map((row) => row.name));
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied = [];
  for (const name of files) {
    if (done.has(name)) continue;
    await db.runScript(readFileSync(join(dir, name), "utf8"));
    await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [name, new Date().toISOString()]);
    applied.push(name);
  }
  return applied;
}

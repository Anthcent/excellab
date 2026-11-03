import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "./db.js";

const MIGRATION_LOCK_KEY = 7331;
const defaultDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Applies pending numbered .sql files, each in its own transaction, recorded in schema_migrations. */
export async function migrate(db: Db, dir = defaultDir, log: (message: string) => void = () => undefined) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const sql = await readFile(join(dir, name), "utf8");
    try {
      await db.tx(async (t) => {
        // Serializes concurrent app instances booting against the same Postgres.
        await t.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
        const done = await t.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
        if (done.rows.length) return;
        await t.exec(sql);
        await t.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        log(`Applied migration ${name}`);
      });
    } catch (error) {
      throw new Error(`Migration ${name} failed`, { cause: error });
    }
  }
}

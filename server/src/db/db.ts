import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";

// bigint columns (e.g. count(*)) come back as plain numbers on the pg adapter. PGlite queries cast with ::int.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export type Row = Record<string, any>;

export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** Runs one or more statements without parameters (used by migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: "pg" | "pglite";
  /** Runs fn inside a transaction. Use only the handle passed to fn while it runs. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function pgQueryable(target: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T = Row>(sql: string, params?: unknown[]) {
      const result = await target.query(sql, params as any[]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    },
    async exec(sql: string) {
      await target.query(sql);
    },
  };
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Idle clients emit errors when Postgres restarts; without a listener Node crashes the process.
  pool.on("error", (error) => console.error("Idle Postgres client error", error));
  return {
    kind: "pg",
    ...pgQueryable(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(pgQueryable(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** `dir` undefined = in-memory (tests). Otherwise the database is persisted in that folder. */
export async function createPgliteDb(dir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dir) await mkdir(dirname(dir), { recursive: true });
  const lite = dir ? new PGlite(dir) : new PGlite();
  await lite.waitReady;
  const wrap = (target: any): Queryable => ({
    async query<T = Row>(sql: string, params?: unknown[]) {
      const result = await target.query(sql, params);
      return { rows: result.rows as T[], rowCount: (result.affectedRows ?? result.rows.length) as number };
    },
    async exec(sql: string) {
      await target.exec(sql);
    },
  });
  return {
    kind: "pglite",
    ...wrap(lite),
    tx: (fn) => lite.transaction((t) => fn(wrap(t))),
    close: () => lite.close(),
  };
}

export async function createDb(opts: { databaseUrl?: string | undefined; pgliteDir?: string | undefined }): Promise<Db> {
  if (opts.databaseUrl) return createPgDb(opts.databaseUrl);
  return createPgliteDb(opts.pgliteDir);
}

export function isUniqueViolation(error: unknown, constraint?: string) {
  const e = error as { code?: string; constraint?: string; message?: string };
  if (e?.code !== "23505" && !/duplicate key value/i.test(e?.message ?? "")) return false;
  return !constraint || e.constraint === constraint || (e.message ?? "").includes(constraint);
}

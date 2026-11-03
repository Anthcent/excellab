import { loadConfig } from "./config.js";
import { createDb } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { seedAdmin } from "./auth/seedAdmin.js";
import { deleteExpiredSessions } from "./auth/sessions.js";
import { seedDemo, seedDemoTeacher } from "./seed/demo.js";
import { buildApp } from "./http/app.js";

// Postgres can refuse connections briefly after reporting healthy; back off instead of crash-looping.
async function withRetry<T>(fn: () => Promise<T>, log: (message: string) => void, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const delay = 1000 * 2 ** (attempt - 1);
      log(`Database not ready (attempt ${attempt}/${attempts}), retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function main() {
  const config = loadConfig();
  const log = (message: string) => console.log(message);
  const db = await createDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
  log(config.databaseUrl ? "Database: Postgres (DATABASE_URL)" : `Database: embedded PGlite in ${config.pgliteDir}`);

  await withRetry(() => migrate(db, undefined, log), log);
  await seedAdmin(db, config.adminEmail, config.adminPassword, log);
  if (config.seedDemo) await seedDemo(db, log);
  if (config.seedDemo && !config.production) await seedDemoTeacher(db, log);

  const app = await buildApp({ db, config, logger: true });

  // Safety net: attempts are also expired lazily on every request that touches them.
  const sweep = setInterval(() => {
    app.sweepExpired().catch((error) => app.log.error({ err: error }, "Attempt sweep failed"));
    deleteExpiredSessions(db).catch((error) => app.log.error({ err: error }, "Session cleanup failed"));
  }, 60_000);
  sweep.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    clearInterval(sweep);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: "0.0.0.0", port: config.port });
  if (!config.databaseUrl || !config.production) log(`GridLab: http://localhost:${config.port}  (admin: ${config.adminEmail})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

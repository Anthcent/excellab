import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { loadConfig } from "../src/config.js";
import { createPgliteDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { seedAdmin } from "../src/auth/seedAdmin.js";
import { buildApp } from "../src/http/app.js";

export const ADMIN = { email: "admin@excellab.local", password: "admin12345" };

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  /** Moves the injectable clock (ms since epoch). */
  clock: { now: number };
  close(): Promise<void>;
  call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, opts?: { cookie?: string; payload?: unknown; headers?: Record<string, string> }): Promise<LightMyRequestResponse>;
  login(email: string, password: string): Promise<string>;
  register(email: string, name?: string): Promise<string>;
}

export async function createTestEnv(): Promise<TestEnv> {
  const db = await createPgliteDb(); // in-memory
  await migrate(db);
  const config = loadConfig({});
  await seedAdmin(db, ADMIN.email, ADMIN.password, () => undefined);
  const clock = { now: Date.parse("2030-01-01T10:00:00Z") };
  const app = await buildApp({ db, config, now: () => new Date(clock.now) });

  const call: TestEnv["call"] = (method, url, opts = {}) =>
    app.inject({
      method,
      url,
      headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
      ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });

  const cookieOf = (response: LightMyRequestResponse) => {
    const c = response.cookies.find((item) => item.name === "gl_session");
    if (!c) throw new Error(`expected a session cookie, got ${response.statusCode} ${response.body}`);
    return `gl_session=${c.value}`;
  };

  return {
    app,
    db,
    clock,
    call,
    async close() {
      await app.close();
      await db.close();
    },
    async login(email, password) {
      return cookieOf(await call("POST", "/api/auth/login", { payload: { email, password } }));
    },
    async register(email, name = "Estudiante") {
      return cookieOf(await call("POST", "/api/auth/register", { payload: { name, email, password: "secret-123" } }));
    },
  };
}

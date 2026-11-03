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
  call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, opts?: { cookie?: string; payload?: unknown; headers?: Record<string, string> }): Promise<LightMyRequestResponse>;
  login(email: string, password: string): Promise<string>;
  register(email: string, name?: string): Promise<string>;
  /** Admin creates a user (no forced password change) and returns its session cookie. Password: "secret-123". */
  makeUser(adminCookie: string, email: string, role: "student" | "teacher" | "admin", name?: string): Promise<string>;
}

export type Json = Record<string, any>;

/** Exercise n: type in A1 a formula that doubles B1 (= n). Full marks need the PRODUCTO function. */
export const exerciseBody = (n: number, overrides: Json = {}) => ({
  title: `Ejercicio ${n}`,
  instructions: `Duplica el valor de B1 (ejercicio ${n}).`,
  points: 10,
  workbook: { name: "Libro1", sheets: [{ name: "Hoja1", cells: { B1: { v: String(n) } }, colW: {} }] },
  checks: [
    { type: "cell_value", cell: "A1", expected: n * 2, requireFormula: true, points: 6, label: "Valor correcto" },
    { type: "cell_formula_uses", cell: "A1", functions: ["PRODUCTO"], points: 4, label: "Usa PRODUCTO" },
  ],
  ...overrides,
});

/** Student answer for exercise n. */
export const answer = (n: number, formula: string) => ({
  name: "Libro1",
  sheets: [{ name: "Hoja1", cells: { B1: { v: String(n) }, A1: { v: formula } }, colW: {} }],
});

/** Exercise title -> n, so a drawn exercise can be answered without knowing the random order. */
export const numberOf = (title: string) => Number(title.replace("Ejercicio ", ""));

export const CORRECT = (n: number) => answer(n, "=PRODUCTO(B1,2)");

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
    async makeUser(adminCookie, email, role, name = email.split("@")[0]!) {
      const created = await call("POST", "/api/admin/users", {
        cookie: adminCookie,
        payload: { name, email, password: "secret-123", role, mustChangePassword: false },
      });
      if (created.statusCode !== 201) throw new Error(`makeUser failed: ${created.statusCode} ${created.body}`);
      return cookieOf(await call("POST", "/api/auth/login", { payload: { email, password: "secret-123" } }));
    },
  };
}

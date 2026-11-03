import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  /** Empty = embedded PGlite (local/dev/tests). Set it to use a real Postgres. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().min(1).default("./data/pglite"),
  ADMIN_EMAIL: z.email().default("admin@excellab.local").transform((value) => value.trim().toLowerCase()),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  PUBLIC_ORIGIN: z.url().optional(),
  COOKIE_SECURE: booleanFromEnv.optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PORT: z.coerce.number().int().positive().default(3000),
  SEED_DEMO: booleanFromEnv.default(true),
  PUBLIC_DIR: z.string().optional(),
});

export interface Config {
  production: boolean;
  databaseUrl: string | undefined;
  pgliteDir: string;
  adminEmail: string;
  adminPassword: string | undefined;
  /** Extra allowed Origin for state-changing requests (same-host requests are always allowed). */
  publicOrigin: string | undefined;
  cookieSecure: boolean;
  sessionTtlDays: number;
  port: number;
  seedDemo: boolean;
  publicDir: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "" && value !== undefined));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = result.data;
  const production = e.NODE_ENV === "production";
  return {
    production,
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,
    adminEmail: e.ADMIN_EMAIL,
    // Development convenience only: production must set ADMIN_PASSWORD explicitly.
    adminPassword: e.ADMIN_PASSWORD ?? (production ? undefined : "admin12345"),
    publicOrigin: e.PUBLIC_ORIGIN ? new URL(e.PUBLIC_ORIGIN).origin : undefined,
    cookieSecure: e.COOKIE_SECURE ?? production,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    port: e.PORT,
    seedDemo: e.SEED_DEMO,
    publicDir: e.PUBLIC_DIR,
  };
}

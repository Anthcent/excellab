import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { Throttle } from "../auth/throttle.js";
import { SESSION_COOKIE, resolveSession, setSessionCookie } from "../auth/sessions.js";
import { authRoutes } from "../auth/routes.js";
import { studentRoutes } from "../attempts/routes.js";
import { exerciseAdminRoutes } from "../exercises/routes.js";
import { examAdminRoutes } from "../exams/routes.js";
import { userAdminRoutes } from "../users/routes.js";
import { statsRoutes } from "../stats/routes.js";
import { expireOverdueAttempts } from "../attempts/service.js";
import { AppError, errorHandler } from "./errors.js";
import type { AppContext } from "./context.js";

export interface AppDeps {
  db: Db;
  config: Config;
  logger?: boolean;
  /** Replaces the wall clock for exam deadlines and availability (tests). */
  now?: () => Date;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Closes every attempt past its deadline; returns how many were examined. */
    sweepExpired(): Promise<number>;
  }
}

const PASSWORD_CHANGE_ALLOWED = new Set(["/api/auth/me", "/api/auth/logout", "/api/auth/change-password", "/api/health"]);
const SAFE_METHODS =new Set(["GET", "HEAD", "OPTIONS"]);
const badOrigin = () => new AppError(403, "BAD_ORIGIN", "Solicitud no permitida desde este origen.");
const defaultPublicDir = fileURLToPath(new URL("../../../public/", import.meta.url));

export async function buildApp({ db, config, logger = false, now = () => new Date() }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 1_048_576 });

  const ctx: AppContext = {
    db,
    config,
    sessions: { ttlDays: config.sessionTtlDays, cookieSecure: config.cookieSecure },
    loginThrottle: new Throttle(5, 60_000),
    emailThrottle: new Throttle(20, 60_000),
    registerThrottle: new Throttle(30, 600_000),
    secretThrottle: new Throttle(10, 60_000),
    now,
  };

  // Only JSON bodies are accepted: text/plain and urlencoded would allow CORS-simple cross-site posts.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, "INVALID_JSON", "El cuerpo de la solicitud no es un JSON válido."), undefined);
    }
  });

  await app.register(cookie);

  app.decorate("sweepExpired", () => expireOverdueAttempts(ctx));
  app.decorateRequest("user", null);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "No encontramos lo que buscas." } }),
  );

  // CSRF defence for cookie sessions: state-changing requests must come from this same site.
  app.addHook("onRequest", async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== undefined) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === request.headers.host;
      } catch {
        sameHost = false;
      }
      if (origin !== config.publicOrigin && !sameHost) throw badOrigin();
    }
    if (request.headers["sec-fetch-site"] === "cross-site") throw badOrigin();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await resolveSession(db, token, ctx.sessions);
    if (!session) return;
    request.user = session.user;
    if (session.renewed) setSessionCookie(reply, token, ctx.sessions);
    // A temporary password must be replaced before anything else can be done.
    if (session.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(request.url.split("?")[0]!)) {
      throw new AppError(403, "PASSWORD_CHANGE_REQUIRED", "Debes cambiar tu contraseña temporal para continuar.");
    }
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    if (request.url.startsWith("/api/") && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });

  app.get("/api/health", { logLevel: "warn" }, async () => {
    await db.query("SELECT 1");
    return { status: "ok" };
  });

  await app.register(
    async (api) => {
      await authRoutes(api, ctx);
      await studentRoutes(api, ctx);
      await exerciseAdminRoutes(api, ctx);
      await examAdminRoutes(api, ctx);
      await userAdminRoutes(api, ctx);
      await statsRoutes(api, ctx);
    },
    { prefix: "/api" },
  );

  const publicDir = config.publicDir ?? defaultPublicDir;
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: "/" });
  } else {
    app.log.warn(`Static directory ${publicDir} not found: run "npm run build:site" to generate it`);
  }

  return app;
}

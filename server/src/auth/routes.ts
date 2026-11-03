import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isUniqueViolation } from "../db/db.js";
import { AppError } from "../http/errors.js";
import { currentUser, requireUser } from "../http/guards.js";
import type { AppContext } from "../http/context.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password.js";
import { SESSION_COOKIE, clearSessionCookie, deleteSession, signIn } from "./sessions.js";
import { createUser, findUserByEmail, normalizeEmail, toPublicUser } from "./users.js";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const newPasswordSchema = z.string().min(8).max(256);
export const nameSchema = z.string().trim().min(1).max(120);

const registerBody = z.object({ name: nameSchema, email: emailSchema, password: newPasswordSchema });
const loginBody = z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(256) });

export const invalidCredentials = () => new AppError(401, "INVALID_CREDENTIALS", "Correo o contraseña incorrectos.");
export const emailTaken = () => new AppError(409, "EMAIL_TAKEN", "Ya existe una cuenta con ese correo.");

/**
 * Verifies credentials and returns the user on success. Throttled per IP+email (5/min) and,
 * because client IPs come from proxy headers, also per email alone (20/min).
 */
export async function authenticate(ctx: AppContext, ip: string, email: string, password: string) {
  const key = `${ip}|${normalizeEmail(email)}`;
  ctx.loginThrottle.hit(key);
  ctx.emailThrottle.hit(normalizeEmail(email));
  const account = await findUserByEmail(ctx.db, email);
  const valid = account ? await verifyPassword(account.password_hash, password) : await verifyAgainstDummy(password);
  if (!account || !valid) throw invalidCredentials();
  ctx.loginThrottle.reset(key);
  return toPublicUser(account);
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post("/auth/register", async (request, reply) => {
    ctx.registerThrottle.hit(request.ip);
    const body = registerBody.parse(request.body);
    if (await findUserByEmail(ctx.db, body.email)) throw emailTaken();
    const passwordHash = await hashPassword(body.password);
    const user = await createUser(ctx.db, { ...body, passwordHash, role: "student" }).catch((error: unknown) => {
      throw isUniqueViolation(error) ? emailTaken() : error;
    });
    await signIn(ctx.db, reply, user.id, ctx.sessions);
    return reply.status(201).send(user);
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginBody.parse(request.body);
    const user = await authenticate(ctx, request.ip, body.email, body.password);
    await signIn(ctx.db, reply, user.id, ctx.sessions);
    return user;
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(ctx.db, token);
    clearSessionCookie(reply, ctx.sessions);
    return reply.status(204).send();
  });

  app.get("/auth/me", { preHandler: requireUser }, async (request) => currentUser(request));
}

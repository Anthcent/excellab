import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isUniqueViolation } from "../db/db.js";
import { AppError } from "../http/errors.js";
import { currentUser, requireUser } from "../http/guards.js";
import type { AppContext } from "../http/context.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password.js";
import { SESSION_COOKIE, clearSessionCookie, deleteSession, deleteUserSessions, signIn } from "./sessions.js";
import { PUBLIC_USER_COLUMNS, createUser, findUserByEmail, findUserById, normalizeEmail, toPublicUser, type UserRow } from "./users.js";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const newPasswordSchema = z.string().min(8).max(256);
export const nameSchema = z.string().trim().min(1).max(120);

const registerBody = z.object({ name: nameSchema, email: emailSchema, password: newPasswordSchema });
const profileBody = z.object({ name: nameSchema });
const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: newPasswordSchema });
const loginBody =z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(256) });

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
  // Only reveal the deactivation to someone who proved they know the password.
  if (!account.active) throw new AppError(403, "ACCOUNT_DISABLED", "Tu cuenta está desactivada. Contacta al administrador.");
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

  app.get("/auth/profile", { preHandler: requireUser }, async (request) => currentUser(request));

  app.patch("/auth/profile", { preHandler: requireUser }, async (request) => {
    const body = profileBody.parse(request.body);
    const user = currentUser(request);
    const { rows } = await ctx.db.query<UserRow>(
      `UPDATE users AS u SET name = $2 WHERE u.id = $1 RETURNING ${PUBLIC_USER_COLUMNS}`,
      [user.id, body.name],
    );
    return toPublicUser(rows[0]!);
  });

  app.post("/auth/change-password", { preHandler: requireUser }, async (request, reply) => {
    const body = changePasswordBody.parse(request.body);
    const user = currentUser(request);
    ctx.secretThrottle.hit(`pw|${user.id}`);
    const account = await findUserById(ctx.db, user.id);
    if (!account || !(await verifyPassword(account.password_hash, body.currentPassword))) {
      throw new AppError(400, "WRONG_CURRENT_PASSWORD", "La contraseña actual no es correcta.");
    }
    if (body.newPassword === body.currentPassword) {
      throw new AppError(400, "PASSWORD_UNCHANGED", "La nueva contraseña debe ser distinta de la actual.");
    }
    await ctx.db.query("UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1", [
      user.id,
      await hashPassword(body.newPassword),
    ]);
    ctx.secretThrottle.reset(`pw|${user.id}`);
    // Other devices are signed out; this session stays.
    await deleteUserSessions(ctx.db, user.id, request.cookies[SESSION_COOKIE]);
    return reply.status(200).send({ ...user, mustChangePassword: false });
  });
}

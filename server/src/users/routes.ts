import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isUniqueViolation, type Queryable } from "../db/db.js";
import type { AppContext } from "../http/context.js";
import { AppError, notFound } from "../http/errors.js";
import { currentUser, requireAdmin } from "../http/guards.js";
import { hashPassword } from "../auth/password.js";
import { deleteUserSessions } from "../auth/sessions.js";
import { emailSchema, emailTaken, nameSchema, newPasswordSchema } from "../auth/routes.js";
import { createUser, findUserById, type Role } from "../auth/users.js";
import { likePattern, pageOf, paginationQuery } from "../http/pagination.js";

const roleSchema = z.enum(["student", "teacher", "admin"]);
const idParams = z.object({ id: z.uuid() });

const listQuery = paginationQuery.extend({
  role: roleSchema.optional(),
  q: z.string().trim().max(100).optional(),
  active: z.enum(["true", "false"]).optional(),
});
const createBody = z.object({
  name: nameSchema,
  email: emailSchema,
  password: newPasswordSchema,
  role: roleSchema,
  /** Accounts created by an admin start with a temporary password unless this is explicitly false. */
  mustChangePassword: z.boolean().default(true),
});
const updateBody = z.object({ name: nameSchema, role: roleSchema, active: z.boolean() }).partial();
const resetBody = z.object({ password: newPasswordSchema });

const iso = (d: unknown) => (d ? new Date(d as string | Date).toISOString() : null);

interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  must_change_password: boolean;
  created_at: Date;
}

const toAdminUser = (r: AdminUserRow) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  active: r.active,
  mustChangePassword: r.must_change_password,
  createdAt: iso(r.created_at),
});

const USER_COLUMNS = "u.id, u.name, u.email, u.role, u.active, u.must_change_password, u.created_at";

async function activeAdminCount(q: Queryable) {
  const { rows } = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active");
  return rows[0]!.n;
}

export async function userAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = { preHandler: requireAdmin };
  const db = ctx.db;

  const load = async (q: Queryable, id: string) => {
    const { rows } = await q.query<AdminUserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [id]);
    if (!rows[0]) throw notFound("No encontramos ese usuario.");
    return rows[0];
  };

  app.get("/admin/users", guard, async (request) => {
    const query = listQuery.parse(request.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.role) where.push(`u.role = $${params.push(query.role)}`);
    if (query.active) where.push(`u.active = $${params.push(query.active === "true")}`);
    if (query.q) {
      const p = params.push(likePattern(query.q));
      where.push(`(u.name ILIKE $${p} OR u.email ILIKE $${p})`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows: total } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users u ${clause}`, params);
    const { page, pageSize } = pageOf(query, 25);
    const { rows } = await db.query<AdminUserRow>(
      `SELECT ${USER_COLUMNS} FROM users u ${clause} ORDER BY u.created_at DESC, u.id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return { items: rows.map(toAdminUser), total: total[0]!.n, page, pageSize };
  });

  app.post("/admin/users", guard, async (request, reply) => {
    const body = createBody.parse(request.body);
    if ((await db.query("SELECT 1 FROM users WHERE email = $1", [body.email])).rows.length) throw emailTaken();
    const created = await createUser(db, {
      name: body.name,
      email: body.email,
      passwordHash: await hashPassword(body.password),
      role: body.role,
      mustChangePassword: body.mustChangePassword,
    }).catch((error: unknown) => {
      throw isUniqueViolation(error) ? emailTaken() : error;
    });
    return reply.status(201).send(toAdminUser(await load(db, created.id)));
  });

  app.patch("/admin/users/:id", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateBody.parse(request.body);
    const me = currentUser(request);
    return db.tx(async (t) => {
      const target = await load(t, id);
      const nextRole = body.role ?? target.role;
      const nextActive = body.active ?? target.active;
      const losesAdmin = target.role === "admin" && target.active && (nextRole !== "admin" || !nextActive);
      if (id === me.id && (nextRole !== target.role || nextActive !== target.active)) {
        throw new AppError(409, "CANNOT_MODIFY_SELF", "No puedes cambiar tu propio rol ni desactivar tu propia cuenta.");
      }
      if (losesAdmin && (await activeAdminCount(t)) <= 1) {
        throw new AppError(409, "LAST_ADMIN", "Debe quedar al menos un administrador activo.");
      }
      await t.query("UPDATE users SET name = $2, role = $3, active = $4 WHERE id = $1", [id, body.name ?? target.name, nextRole, nextActive]);
      if (!nextActive) await deleteUserSessions(t, id);
      return toAdminUser(await load(t, id));
    });
  });

  app.post("/admin/users/:id/reset-password", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = resetBody.parse(request.body);
    if (id === currentUser(request).id) {
      throw new AppError(400, "USE_CHANGE_PASSWORD", "Para cambiar tu propia contraseña usa la opción de cambiar contraseña.");
    }
    if (!(await findUserById(db, id))) throw notFound("No encontramos ese usuario.");
    await db.tx(async (t) => {
      await t.query("UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1", [id, await hashPassword(body.password)]);
      await deleteUserSessions(t, id);
    });
    return reply.status(204).send();
  });
}

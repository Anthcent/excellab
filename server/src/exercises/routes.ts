import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/context.js";
import { AppError, badRequest, conflict, notFound } from "../http/errors.js";
import { currentUser, isAdmin, ownerScope, requireStaff } from "../http/guards.js";
import { checksSchema, gradeWorkbook, type Check } from "../grid/checks.js";
import { parseWorkbook, storedWorkbook } from "../grid/workbook.js";
import type { Queryable, Row } from "../db/db.js";
import type { PublicUser } from "../auth/users.js";
import { likePattern, pageOf, paginationQuery, wantsPage } from "../http/pagination.js";

const idParams = z.object({ id: z.uuid() });

const tagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(30))
  .max(10)
  .transform((tags) => [...new Set(tags)]);

const exerciseShape = {
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(20000),
  points: z.number().positive().max(1000),
  workbook: z.unknown(),
  checks: checksSchema,
  status: z.enum(["draft", "published"]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  tags: tagsSchema,
  estimatedMinutes: z.number().int().min(1).max(600).nullable(),
  category: z.string().trim().min(1).max(60).nullable(),
};
const createBody = z.object({
  title: exerciseShape.title,
  instructions: exerciseShape.instructions.default(""),
  points: exerciseShape.points.default(10),
  workbook: exerciseShape.workbook,
  checks: exerciseShape.checks.default([]),
  status: exerciseShape.status.default("published"),
  difficulty: exerciseShape.difficulty.default("medium"),
  tags: exerciseShape.tags.default([]),
  estimatedMinutes: exerciseShape.estimatedMinutes.default(null),
  category: exerciseShape.category.default(null),
});
const updateBody = z.object({ ...exerciseShape, ownerId: z.uuid() }).partial();
const previewBody = z.object({
  workbook: z.unknown(),
  /** Optional: try unsaved checks/points before saving them. */
  checks: checksSchema.optional(),
  points: exerciseShape.points.optional(),
});
const listQuery = paginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  difficulty: exerciseShape.difficulty.optional(),
  tag: z.string().trim().toLowerCase().max(30).optional(),
  status: exerciseShape.status.optional(),
  owner: z.uuid().optional(),
});
const exportQuery = z.object({ ids: z.string().max(20000).optional() });
const exportBody = z.object({ ids: z.array(z.uuid()).min(1).max(200) });
const importBody = z.union([z.array(z.unknown()), z.object({ exercises: z.array(z.unknown()) })]);

const MAX_IMPORT = 100;
export const EXPORT_FORMAT = "excellab.exercises";

const iso = (d: unknown) => (d ? new Date(d as string | Date).toISOString() : null);

function toApi(row: Row) {
  return {
    id: row.id as string,
    title: row.title as string,
    instructions: row.instructions as string,
    points: row.points as number,
    status: row.status as string,
    difficulty: row.difficulty as string,
    tags: (row.tags ?? []) as string[],
    estimatedMinutes: (row.estimated_minutes ?? null) as number | null,
    category: (row.category ?? null) as string | null,
    ownerId: (row.owner_id ?? null) as string | null,
    workbook: storedWorkbook(row.workbook),
    checks: row.checks as Check[],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function assertPublishable(status: string, checks: Check[]) {
  if (status === "published" && checks.length === 0) {
    throw badRequest("Un ejercicio publicado necesita al menos una verificación.", "NO_CHECKS");
  }
}

const insertExercise = (
  q: Queryable,
  owner: string,
  e: { title: string; instructions: string; points: number; workbook: unknown; checks: Check[]; status: string; difficulty: string; tags: string[]; estimatedMinutes: number | null; category: string | null },
) =>
  q.query(
    `INSERT INTO exercises (title, instructions, points, workbook, checks, status, difficulty, tags, estimated_minutes, category, created_by, owner_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11, $11) RETURNING *`,
    [e.title, e.instructions, e.points, JSON.stringify(e.workbook), JSON.stringify(e.checks), e.status, e.difficulty, JSON.stringify(e.tags), e.estimatedMinutes, e.category, owner],
  );

/** A staff member must be allowed to own content: an active teacher or admin. */
export async function assertValidOwner(q: Queryable, ownerId: string) {
  const { rows } = await q.query("SELECT 1 FROM users WHERE id = $1 AND role IN ('teacher', 'admin') AND active", [ownerId]);
  if (!rows.length) throw badRequest("El propietario debe ser un profesor o administrador activo.", "INVALID_OWNER");
}

export async function exerciseAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = { preHandler: requireStaff };
  const db = ctx.db;

  /** Loads an exercise the user may touch. Teachers get 404 for exercises they do not own. */
  const find = async (id: string, user: PublicUser) => {
    const scope = ownerScope(user);
    const { rows } = await db.query("SELECT * FROM exercises WHERE id = $1 AND ($2::uuid IS NULL OR owner_id = $2::uuid)", [id, scope ?? null]);
    if (!rows[0]) throw notFound("No encontramos ese ejercicio.");
    return rows[0];
  };

  app.get("/admin/exercises", guard, async (request) => {
    const query = listQuery.parse(request.query);
    const user = currentUser(request);
    const params: unknown[] = [];
    const where: string[] = [];
    const scope = ownerScope(user);
    if (scope) where.push(`e.owner_id = $${params.push(scope)}`);
    else if (query.owner) where.push(`e.owner_id = $${params.push(query.owner)}`);
    if (query.status) where.push(`e.status = $${params.push(query.status)}`);
    if (query.difficulty) where.push(`e.difficulty = $${params.push(query.difficulty)}`);
    if (query.tag) where.push(`e.tags @> $${params.push(JSON.stringify([query.tag]))}::jsonb`);
    if (query.q) {
      const p = params.push(likePattern(query.q));
      where.push(`(e.title ILIKE $${p} OR e.tags::text ILIKE $${p})`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const paged = wantsPage(query);
    const { page, pageSize } = pageOf(query, 25);
    const { rows } = await db.query(
      `SELECT e.id, e.title, e.points, e.status, e.difficulty, e.tags, e.estimated_minutes, e.category, e.owner_id, e.created_at, e.updated_at,
              o.name AS owner_name,
              jsonb_array_length(e.checks)::int AS check_count,
              (SELECT count(DISTINCT b.exam_id)::int FROM exam_block_exercises bx JOIN exam_blocks b ON b.id = bx.block_id WHERE bx.exercise_id = e.id) AS exam_count,
              (SELECT count(*)::int FROM attempts a WHERE a.exercise_ids @> jsonb_build_array(e.id::text)) AS attempts_count
         FROM exercises e LEFT JOIN users o ON o.id = e.owner_id
         ${clause} ORDER BY e.created_at DESC, e.id
         ${paged ? `LIMIT $${params.length + 1} OFFSET $${params.length + 2}` : ""}`,
      paged ? [...params, pageSize, (page - 1) * pageSize] : params,
    );
    const items = rows.map((r) => ({
      id: r.id,
      title: r.title,
      points: r.points,
      status: r.status,
      difficulty: r.difficulty,
      tags: r.tags ?? [],
      estimatedMinutes: r.estimated_minutes ?? null,
      category: r.category ?? null,
      ownerId: r.owner_id ?? null,
      ownerName: r.owner_name ?? null,
      checkCount: r.check_count,
      checksCount: r.check_count,
      examCount: r.exam_count,
      attemptsCount: r.attempts_count,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    }));
    if (!paged) return items;
    const { rows: total } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM exercises e ${clause}`, params);
    return { items, total: total[0]!.n, page, pageSize };
  });

  /* ----- Export / import (static paths are matched before /:id) ----- */

  const exportExercises = async (ids: string[], user: PublicUser) => {
    const scope = ownerScope(user);
    const marks = ids.map((_, i) => `$${i + 2}`).join(", ");
    const { rows } = await db.query(
      `SELECT * FROM exercises WHERE id IN (${marks}) AND ($1::uuid IS NULL OR owner_id = $1::uuid) ORDER BY created_at, id`,
      [scope ?? null, ...ids],
    );
    return {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: ctx.now().toISOString(),
      exercises: rows.map((r) => {
        const e = toApi(r);
        return {
          title: e.title,
          instructions: e.instructions,
          points: e.points,
          workbook: e.workbook,
          checks: e.checks,
          status: e.status,
          difficulty: e.difficulty,
          tags: e.tags,
          estimatedMinutes: e.estimatedMinutes,
          category: e.category,
        };
      }),
    };
  };

  app.get("/admin/exercises/export", guard, async (request) => {
    const { ids } = exportQuery.parse(request.query);
    const parsed = z.array(z.uuid()).min(1).max(200).parse((ids ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    return exportExercises(parsed, currentUser(request));
  });

  app.post("/admin/exercises/export", guard, async (request) => {
    const { ids } = exportBody.parse(request.body);
    return exportExercises(ids, currentUser(request));
  });

  app.post("/admin/exercises/import", guard, async (request) => {
    const parsed = importBody.parse(request.body);
    const items = Array.isArray(parsed) ? parsed : parsed.exercises;
    if (items.length === 0 || items.length > MAX_IMPORT) {
      throw badRequest(`Envía entre 1 y ${MAX_IMPORT} ejercicios por importación.`, "IMPORT_SIZE");
    }
    const user = currentUser(request);
    const results: Array<{ index: number; ok: boolean; id?: string; title?: string; error?: { code: string; message: string; fields?: string[] } }> = [];
    for (const [index, item] of items.entries()) {
      const title = typeof (item as { title?: unknown })?.title === "string" ? ((item as { title: string }).title as string) : undefined;
      const result = createBody.safeParse(item);
      if (!result.success) {
        const fields = result.error.issues.map((issue) => issue.path.join(".")).filter(Boolean);
        results.push({ index, ok: false, ...(title && { title }), error: { code: "VALIDATION", message: "Revisa los datos del ejercicio.", fields } });
        continue;
      }
      try {
        const body = result.data;
        const workbook = parseWorkbook(body.workbook);
        const { rows } = await insertExercise(db, user.id, { ...body, workbook, status: "draft" });
        results.push({ index, ok: true, id: rows[0]!.id as string, title: body.title });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        results.push({ index, ok: false, ...(title && { title }), error: { code: error.code, message: error.message } });
      }
    }
    const imported = results.filter((r) => r.ok).length;
    return { imported, failed: results.length - imported, results };
  });

  app.get("/admin/exercises/:id", guard, async (request) => toApi(await find(idParams.parse(request.params).id, currentUser(request))));

  app.post("/admin/exercises", guard, async (request, reply) => {
    const body = createBody.parse(request.body);
    const workbook = parseWorkbook(body.workbook);
    assertPublishable(body.status, body.checks);
    const { rows } = await insertExercise(db, currentUser(request).id, { ...body, workbook });
    return reply.status(201).send(toApi(rows[0]!));
  });

  app.route({
    method: ["PUT", "PATCH"],
    url: "/admin/exercises/:id",
    ...guard,
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = updateBody.parse(request.body);
      const user = currentUser(request);
      const current = await find(id, user);
      if (body.ownerId !== undefined) {
        if (!isAdmin(user)) throw new AppError(403, "FORBIDDEN", "Solo un administrador puede cambiar el propietario.");
        await assertValidOwner(db, body.ownerId);
      }
      const next = {
        title: body.title ?? current.title,
        instructions: body.instructions ?? current.instructions,
        points: body.points ?? current.points,
        workbook: body.workbook !== undefined ? parseWorkbook(body.workbook) : storedWorkbook(current.workbook),
        checks: body.checks ?? (current.checks as Check[]),
        status: body.status ?? current.status,
        difficulty: body.difficulty ?? current.difficulty,
        tags: body.tags ?? (current.tags as string[]),
        estimatedMinutes: body.estimatedMinutes !== undefined ? body.estimatedMinutes : current.estimated_minutes,
        category: body.category !== undefined ? body.category : current.category,
        ownerId: body.ownerId ?? current.owner_id,
      };
      assertPublishable(next.status, next.checks);
      const { rows } = await db.query(
        `UPDATE exercises SET title = $2, instructions = $3, points = $4, workbook = $5::jsonb, checks = $6::jsonb,
                status = $7, difficulty = $8, tags = $9::jsonb, estimated_minutes = $10, category = $11, owner_id = $12,
                updated_at = now() WHERE id = $1 RETURNING *`,
        [id, next.title, next.instructions, next.points, JSON.stringify(next.workbook), JSON.stringify(next.checks), next.status,
         next.difficulty, JSON.stringify(next.tags), next.estimatedMinutes, next.category, next.ownerId],
      );
      return toApi(rows[0]!);
    },
  });

  app.delete("/admin/exercises/:id", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await find(id, currentUser(request));
    const used = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM attempts WHERE exercise_ids @> $1::jsonb",
      [JSON.stringify([id])],
    );
    if (used.rows[0]!.n > 0) throw conflict("EXERCISE_IN_USE", "Este ejercicio ya fue usado en intentos de estudiantes y no se puede eliminar.");
    await db.query("DELETE FROM exercises WHERE id = $1", [id]);
    return reply.status(204).send();
  });

  /** Copy of an exercise as a draft owned by the caller. */
  app.post("/admin/exercises/:id/duplicate", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const user = currentUser(request);
    const source = toApi(await find(id, user));
    const title = `${source.title.slice(0, 190)} (copia)`;
    const { rows } = await insertExercise(db, user.id, { ...source, title, status: "draft" });
    return reply.status(201).send(toApi(rows[0]!));
  });

  /** Runs the checks of an exercise against a workbook, with expected values visible to staff only. */
  app.post("/admin/exercises/:id/preview-grade", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = previewBody.parse(request.body);
    const row = await find(id, currentUser(request));
    const workbook = parseWorkbook(body.workbook);
    const outcome = gradeWorkbook(workbook, body.checks ?? (row.checks as Check[]), body.points ?? (row.points as number));
    return outcome;
  });
}

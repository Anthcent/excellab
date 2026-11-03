import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/context.js";
import type { Queryable, Row } from "../db/db.js";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { currentUser, requireAdmin } from "../http/guards.js";
import { adminAttemptDetail, adminResults } from "../attempts/service.js";

const idParams = z.object({ id: z.uuid() });
const dateTime = z.iso.datetime({ offset: true }).nullable();

const examShape = {
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(20000),
  durationMinutes: z.number().int().min(1).max(600),
  maxAttempts: z.number().int().min(1).max(20),
  pickCount: z.number().int().min(1).max(500).nullable(),
  scale: z.number().positive().max(1000),
  passPercent: z.number().min(0).max(100),
  gradePolicy: z.enum(["best", "last"]),
  status: z.enum(["draft", "published"]),
  availableFrom: dateTime,
  availableUntil: dateTime,
};
const exerciseIds = z.array(z.uuid()).max(500);

const createBody = z.object({
  title: examShape.title,
  instructions: examShape.instructions.default(""),
  durationMinutes: examShape.durationMinutes,
  maxAttempts: examShape.maxAttempts.default(2),
  pickCount: examShape.pickCount.default(null),
  scale: examShape.scale.default(20),
  passPercent: examShape.passPercent.default(60),
  gradePolicy: examShape.gradePolicy.default("best"),
  status: examShape.status.default("draft"),
  availableFrom: examShape.availableFrom.default(null),
  availableUntil: examShape.availableUntil.default(null),
  exerciseIds: exerciseIds.optional(),
});
const updateBody = z.object({ ...examShape, exerciseIds }).partial();
const setExercisesBody = z.object({ exerciseIds });
const resultsQuery = z.object({ examId: z.uuid().optional(), userId: z.uuid().optional() });

const iso = (d: unknown) => (d ? new Date(d as string | Date).toISOString() : null);
const COLUMNS: Record<string, string> = {
  title: "title",
  instructions: "instructions",
  durationMinutes: "duration_minutes",
  maxAttempts: "max_attempts",
  pickCount: "pick_count",
  scale: "scale",
  passPercent: "pass_percent",
  gradePolicy: "grade_policy",
  status: "status",
  availableFrom: "available_from",
  availableUntil: "available_until",
};

function toApi(row: Row, exercises?: Row[]) {
  return {
    id: row.id as string,
    title: row.title as string,
    instructions: row.instructions as string,
    durationMinutes: row.duration_minutes as number,
    maxAttempts: row.max_attempts as number,
    pickCount: row.pick_count as number | null,
    scale: row.scale as number,
    passPercent: row.pass_percent as number,
    gradePolicy: row.grade_policy as string,
    status: row.status as string,
    availableFrom: iso(row.available_from),
    availableUntil: iso(row.available_until),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.exercise_count !== undefined && { exerciseCount: row.exercise_count as number, attemptCount: row.attempt_count as number }),
    ...(exercises && {
      exercises: exercises.map((e) => ({ id: e.id as string, title: e.title as string, points: e.points as number, position: e.position as number, status: e.status as string })),
    }),
  };
}

async function exercisesOf(q: Queryable, examId: string) {
  const { rows } = await q.query(
    `SELECT e.id, e.title, e.points, e.status, x.position FROM exam_exercises x JOIN exercises e ON e.id = x.exercise_id
      WHERE x.exam_id = $1 ORDER BY x.position, e.id`,
    [examId],
  );
  return rows;
}

/** Replaces the exam pool with the given ordered exercises. Only published exercises can be used. */
async function replaceExercises(q: Queryable, examId: string, ids: string[]) {
  if (new Set(ids).size !== ids.length) throw badRequest("Hay ejercicios repetidos en la lista.", "DUPLICATE_EXERCISES");
  if (ids.length) {
    const marks = ids.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await q.query<{ id: string; status: string }>(`SELECT id, status FROM exercises WHERE id IN (${marks})`, ids);
    if (rows.length !== ids.length) throw badRequest("Alguno de los ejercicios no existe.", "UNKNOWN_EXERCISE");
    if (rows.some((r) => r.status !== "published")) throw badRequest("Solo se pueden usar ejercicios publicados.", "EXERCISE_NOT_PUBLISHED");
  }
  await q.query("DELETE FROM exam_exercises WHERE exam_id = $1", [examId]);
  for (const [position, exerciseId] of ids.entries()) {
    await q.query("INSERT INTO exam_exercises (exam_id, exercise_id, position) VALUES ($1, $2, $3)", [examId, exerciseId, position]);
  }
}

async function assertPublishable(q: Queryable, examId: string) {
  const { rows } = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM exam_exercises WHERE exam_id = $1", [examId]);
  if (rows[0]!.n === 0) throw badRequest("Un examen publicado necesita al menos un ejercicio.", "EXAM_EMPTY");
}

export async function examAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = { preHandler: requireAdmin };
  const db = ctx.db;

  const detail = async (q: Queryable, id: string) => {
    const { rows } = await q.query("SELECT * FROM exams WHERE id = $1", [id]);
    if (!rows[0]) throw notFound("No encontramos ese examen.");
    return toApi(rows[0], await exercisesOf(q, id));
  };

  app.get("/admin/exams", guard, async () => {
    const { rows } = await db.query(
      `SELECT e.*, (SELECT count(*)::int FROM exam_exercises x WHERE x.exam_id = e.id) AS exercise_count,
                   (SELECT count(*)::int FROM attempts a WHERE a.exam_id = e.id) AS attempt_count
         FROM exams e ORDER BY e.created_at DESC, e.id`,
    );
    return rows.map((r) => toApi(r));
  });

  app.get("/admin/exams/:id", guard, async (request) => detail(db, idParams.parse(request.params).id));

  app.post("/admin/exams", guard, async (request, reply) => {
    const body = createBody.parse(request.body);
    const created = await db.tx(async (t) => {
      const { rows } = await t.query<{ id: string }>(
        `INSERT INTO exams (title, instructions, duration_minutes, max_attempts, pick_count, scale, pass_percent, grade_policy, status,
                            available_from, available_until, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12) RETURNING id`,
        [body.title, body.instructions, body.durationMinutes, body.maxAttempts, body.pickCount, body.scale, body.passPercent, body.gradePolicy,
         body.status, body.availableFrom, body.availableUntil, currentUser(request).id],
      );
      const id = rows[0]!.id;
      if (body.exerciseIds) await replaceExercises(t, id, body.exerciseIds);
      if (body.status === "published") await assertPublishable(t, id);
      return detail(t, id);
    });
    return reply.status(201).send(created);
  });

  app.put("/admin/exams/:id", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateBody.parse(request.body);
    return db.tx(async (t) => {
      const { rows } = await t.query("SELECT id FROM exams WHERE id = $1", [id]);
      if (!rows[0]) throw notFound("No encontramos ese examen.");
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        const cast = column.startsWith("available_") ? "::timestamptz" : "";
        sets.push(`${column} = $${params.push(value)}${cast}`);
      }
      if (sets.length) await t.query(`UPDATE exams SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
      if (body.exerciseIds) await replaceExercises(t, id, body.exerciseIds);
      const result = await detail(t, id);
      if (result.status === "published") await assertPublishable(t, id);
      return result;
    });
  });

  app.put("/admin/exams/:id/exercises", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = setExercisesBody.parse(request.body);
    return db.tx(async (t) => {
      await detail(t, id);
      await replaceExercises(t, id, body.exerciseIds);
      const result = await detail(t, id);
      if (result.status === "published") await assertPublishable(t, id);
      await t.query("UPDATE exams SET updated_at = now() WHERE id = $1", [id]);
      return result;
    });
  });

  app.delete("/admin/exams/:id", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await detail(db, id);
    const used = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM attempts WHERE exam_id = $1", [id]);
    if (used.rows[0]!.n > 0) throw conflict("EXAM_IN_USE", "Este examen ya tiene intentos de estudiantes y no se puede eliminar. Puedes despublicarlo.");
    await db.query("DELETE FROM exams WHERE id = $1", [id]);
    return reply.status(204).send();
  });

  app.get("/admin/results", guard, async (request) => adminResults(ctx, resultsQuery.parse(request.query)));

  app.get("/admin/attempts/:id", guard, async (request) => adminAttemptDetail(ctx, idParams.parse(request.params).id));
}

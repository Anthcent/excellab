import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/context.js";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { currentUser, requireAdmin } from "../http/guards.js";
import { checksSchema, gradeWorkbook, type Check } from "../grid/checks.js";
import { parseWorkbook, storedWorkbook } from "../grid/workbook.js";
import type { Row } from "../db/db.js";

const idParams = z.object({ id: z.uuid() });

const exerciseShape = {
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(20000),
  points: z.number().positive().max(1000),
  workbook: z.unknown(),
  checks: checksSchema,
  status: z.enum(["draft", "published"]),
};
const createBody = z.object({
  title: exerciseShape.title,
  instructions: exerciseShape.instructions.default(""),
  points: exerciseShape.points.default(10),
  workbook: exerciseShape.workbook,
  checks: exerciseShape.checks.default([]),
  status: exerciseShape.status.default("published"),
});
const updateBody = z.object(exerciseShape).partial();
const previewBody = z.object({
  workbook: z.unknown(),
  /** Optional: try unsaved checks/points before saving them. */
  checks: checksSchema.optional(),
  points: exerciseShape.points.optional(),
});

const iso = (d: unknown) => (d ? new Date(d as string | Date).toISOString() : null);

function toApi(row: Row) {
  return {
    id: row.id as string,
    title: row.title as string,
    instructions: row.instructions as string,
    points: row.points as number,
    status: row.status as string,
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

export async function exerciseAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = { preHandler: requireAdmin };
  const db = ctx.db;

  const find = async (id: string) => {
    const { rows } = await db.query("SELECT * FROM exercises WHERE id = $1", [id]);
    if (!rows[0]) throw notFound("No encontramos ese ejercicio.");
    return rows[0];
  };

  app.get("/admin/exercises", guard, async () => {
    const { rows } = await db.query(
      `SELECT e.id, e.title, e.points, e.status, e.created_at, e.updated_at,
              jsonb_array_length(e.checks)::int AS check_count,
              (SELECT count(*)::int FROM exam_exercises x WHERE x.exercise_id = e.id) AS exam_count
         FROM exercises e ORDER BY e.created_at DESC, e.id`,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      points: r.points,
      status: r.status,
      checkCount: r.check_count,
      examCount: r.exam_count,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    }));
  });

  app.get("/admin/exercises/:id", guard, async (request) => toApi(await find(idParams.parse(request.params).id)));

  app.post("/admin/exercises", guard, async (request, reply) => {
    const body = createBody.parse(request.body);
    const workbook = parseWorkbook(body.workbook);
    assertPublishable(body.status, body.checks);
    const { rows } = await db.query(
      `INSERT INTO exercises (title, instructions, points, workbook, checks, status, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7) RETURNING *`,
      [body.title, body.instructions, body.points, JSON.stringify(workbook), JSON.stringify(body.checks), body.status, currentUser(request).id],
    );
    return reply.status(201).send(toApi(rows[0]!));
  });

  app.put("/admin/exercises/:id", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateBody.parse(request.body);
    const current = await find(id);
    const next = {
      title: body.title ?? current.title,
      instructions: body.instructions ?? current.instructions,
      points: body.points ?? current.points,
      workbook: body.workbook !== undefined ? parseWorkbook(body.workbook) : storedWorkbook(current.workbook),
      checks: body.checks ?? (current.checks as Check[]),
      status: body.status ?? current.status,
    };
    assertPublishable(next.status, next.checks);
    const { rows } = await db.query(
      `UPDATE exercises SET title = $2, instructions = $3, points = $4, workbook = $5::jsonb, checks = $6::jsonb,
              status = $7, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, next.title, next.instructions, next.points, JSON.stringify(next.workbook), JSON.stringify(next.checks), next.status],
    );
    return toApi(rows[0]!);
  });

  app.delete("/admin/exercises/:id", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await find(id);
    const used = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM attempts WHERE exercise_ids @> $1::jsonb",
      [JSON.stringify([id])],
    );
    if (used.rows[0]!.n > 0) throw conflict("EXERCISE_IN_USE", "Este ejercicio ya fue usado en intentos de estudiantes y no se puede eliminar.");
    await db.query("DELETE FROM exercises WHERE id = $1", [id]);
    return reply.status(204).send();
  });

  /** Runs the checks of an exercise against a workbook, with expected values visible to staff only. */
  app.post("/admin/exercises/:id/preview-grade", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = previewBody.parse(request.body);
    const row = await find(id);
    const workbook = parseWorkbook(body.workbook);
    const outcome = gradeWorkbook(workbook, body.checks ?? (row.checks as Check[]), body.points ?? (row.points as number));
    return outcome;
  });
}

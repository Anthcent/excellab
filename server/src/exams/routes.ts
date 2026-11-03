import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/context.js";
import type { Queryable, Row } from "../db/db.js";
import { AppError, conflict, notFound } from "../http/errors.js";
import { currentUser, isAdmin, ownerScope, requireStaff } from "../http/guards.js";
import type { PublicUser } from "../auth/users.js";
import { adminAttemptDetail, adminResults, effectiveMaxAttempts } from "../attempts/service.js";
import { drawBlocks, newSeed } from "../attempts/random.js";
import { likePattern, pageOf, paginationQuery, wantsPage } from "../http/pagination.js";
import { assertValidOwner } from "../exercises/routes.js";
import {
  assertPublishable,
  blocksSchema,
  flattenExercises,
  loadStructure,
  prepareDraw,
  replaceBlocks,
  replaceWithFlatPool,
  syncLegacyPickCount,
  type BlockView,
} from "./service.js";

const idParams = z.object({ id: z.uuid() });
const dateTime = z.iso.datetime({ offset: true }).nullable();

const examShape = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500),
  instructions: z.string().max(20000),
  durationMinutes: z.number().int().min(1).max(600),
  maxAttempts: z.number().int().min(1).max(20),
  /** Deprecated: the draw is per block. Kept for the flat-pool API (see README). */
  pickCount: z.number().int().min(1).max(500).nullable(),
  scale: z.number().positive().max(1000),
  passPercent: z.number().min(0).max(100),
  gradePolicy: z.enum(["best", "last"]),
  status: z.enum(["draft", "published"]),
  availableFrom: dateTime,
  availableUntil: dateTime,
  shuffleBlocks: z.boolean(),
  feedbackMode: z.enum(["none", "score", "details"]),
  resultMode: z.enum(["immediate", "after_close", "hidden"]),
  allowReview: z.boolean(),
  accessCode: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .transform((value) => (value ? value : null)),
  restricted: z.boolean(),
};
const exerciseIds = z.array(z.uuid()).max(500);

const createBody = z.object({
  title: examShape.title,
  description: examShape.description.default(""),
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
  shuffleBlocks: examShape.shuffleBlocks.default(false),
  feedbackMode: examShape.feedbackMode.default("details"),
  resultMode: examShape.resultMode.default("immediate"),
  allowReview: examShape.allowReview.default(false),
  accessCode: examShape.accessCode.default(null),
  restricted: examShape.restricted.default(false),
  exerciseIds: exerciseIds.optional(),
  blocks: blocksSchema.optional(),
});
const updateBody = z.object({ ...examShape, exerciseIds, blocks: blocksSchema, ownerId: z.uuid() }).partial();
const setExercisesBody = z.object({ exerciseIds });
const setBlocksBody = z.object({ blocks: blocksSchema });
const listQuery = paginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: examShape.status.optional(),
  owner: z.uuid().optional(),
});
const resultsQuery = z.object({ examId: z.uuid().optional(), userId: z.uuid().optional() });
const accessBody = z.object({ emails: z.array(z.string().trim().toLowerCase().max(254)).max(2000), restricted: z.boolean().optional() });
const grantBody = z.object({ userId: z.uuid(), extra: z.number().int().min(1).max(5), reason: z.string().trim().max(300).default("") });
const previewBody = z.object({ seed: z.number().int().min(1).max(2_147_483_647).optional() }).default({});
const overrideParams = z.object({ id: z.uuid(), overrideId: z.uuid() });

const iso = (d: unknown) => (d ? new Date(d as string | Date).toISOString() : null);
const COLUMNS: Record<string, string> = {
  title: "title",
  description: "description",
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
  shuffleBlocks: "shuffle_blocks",
  feedbackMode: "feedback_mode",
  resultMode: "result_mode",
  allowReview: "allow_review",
  accessCode: "access_code",
  restricted: "restricted",
};

function toApi(row: Row, structure?: BlockView[]) {
  const exerciseCount = structure ? structure.reduce((n, b) => n + b.exercises.length, 0) : (row.exercise_count as number | undefined);
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description ?? "") as string,
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
    shuffleBlocks: row.shuffle_blocks as boolean,
    feedbackMode: row.feedback_mode as string,
    resultMode: row.result_mode as string,
    allowReview: row.allow_review as boolean,
    accessCode: (row.access_code ?? null) as string | null,
    restricted: row.restricted as boolean,
    ownerId: (row.owner_id ?? null) as string | null,
    ownerName: (row.owner_name ?? null) as string | null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(exerciseCount !== undefined && { exerciseCount }),
    ...(row.attempt_count !== undefined && { attemptCount: row.attempt_count as number }),
    ...(row.block_count !== undefined && { blockCount: row.block_count as number }),
    ...(row.access_count !== undefined && { accessCount: row.access_count as number }),
    ...(structure && { blocks: structure, exercises: flattenExercises(structure) }),
  };
}

const COUNTS = `(SELECT count(*)::int FROM exam_block_exercises bx JOIN exam_blocks b ON b.id = bx.block_id WHERE b.exam_id = e.id) AS exercise_count,
                (SELECT count(*)::int FROM exam_blocks b WHERE b.exam_id = e.id) AS block_count,
                (SELECT count(*)::int FROM exam_access ac WHERE ac.exam_id = e.id) AS access_count,
                (SELECT count(*)::int FROM attempts a WHERE a.exam_id = e.id) AS attempt_count`;

export async function examAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = { preHandler: requireStaff };
  const db = ctx.db;

  /** Loads an exam the user may touch; teachers get 404 for exams they do not own. */
  const findExam = async (q: Queryable, id: string, user: PublicUser) => {
    const scope = ownerScope(user);
    const { rows } = await q.query(
      `SELECT e.*, o.name AS owner_name, ${COUNTS}
         FROM exams e LEFT JOIN users o ON o.id = e.owner_id
        WHERE e.id = $1 AND ($2::uuid IS NULL OR e.owner_id = $2::uuid)`,
      [id, scope ?? null],
    );
    if (!rows[0]) throw notFound("No encontramos ese examen.");
    return rows[0];
  };

  const detail = async (q: Queryable, id: string, user: PublicUser) => {
    const row = await findExam(q, id, user);
    return toApi(row, await loadStructure(q, id));
  };

  app.get("/admin/exams", guard, async (request) => {
    const query = listQuery.parse(request.query);
    const user = currentUser(request);
    const params: unknown[] = [];
    const where: string[] = [];
    const scope = ownerScope(user);
    if (scope) where.push(`e.owner_id = $${params.push(scope)}`);
    else if (query.owner) where.push(`e.owner_id = $${params.push(query.owner)}`);
    if (query.status) where.push(`e.status = $${params.push(query.status)}`);
    if (query.q) where.push(`e.title ILIKE $${params.push(likePattern(query.q))}`);
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const paged = wantsPage(query);
    const { page, pageSize } = pageOf(query, 25);
    const { rows } = await db.query(
      `SELECT e.*, o.name AS owner_name, ${COUNTS}
         FROM exams e LEFT JOIN users o ON o.id = e.owner_id
         ${clause} ORDER BY e.created_at DESC, e.id
         ${paged ? `LIMIT $${params.length + 1} OFFSET $${params.length + 2}` : ""}`,
      paged ? [...params, pageSize, (page - 1) * pageSize] : params,
    );
    const items = rows.map((r) => toApi(r));
    if (!paged) return items;
    const { rows: total } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM exams e ${clause}`, params);
    return { items, total: total[0]!.n, page, pageSize };
  });

  app.get("/admin/exams/:id", guard, async (request) => detail(db, idParams.parse(request.params).id, currentUser(request)));

  app.post("/admin/exams", guard, async (request, reply) => {
    const body = createBody.parse(request.body);
    const user = currentUser(request);
    const created = await db.tx(async (t) => {
      const { rows } = await t.query<{ id: string }>(
        `INSERT INTO exams (title, description, instructions, duration_minutes, max_attempts, pick_count, scale, pass_percent, grade_policy, status,
                            available_from, available_until, shuffle_blocks, feedback_mode, result_mode, allow_review, access_code, restricted,
                            created_by, owner_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, $13, $14, $15, $16, $17, $18, $19, $19) RETURNING id`,
        [body.title, body.description, body.instructions, body.durationMinutes, body.maxAttempts, body.pickCount, body.scale, body.passPercent,
         body.gradePolicy, body.status, body.availableFrom, body.availableUntil, body.shuffleBlocks, body.feedbackMode, body.resultMode,
         body.allowReview, body.accessCode, body.restricted, user.id],
      );
      const id = rows[0]!.id;
      if (body.blocks) await replaceBlocks(t, id, body.blocks, user);
      else if (body.exerciseIds) await replaceWithFlatPool(t, id, body.exerciseIds, user, body.pickCount);
      if (body.status === "published") await assertPublishable(t, id);
      return detail(t, id, user);
    });
    return reply.status(201).send(created);
  });

  app.route({
    method: ["PUT", "PATCH"],
    url: "/admin/exams/:id",
    ...guard,
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = updateBody.parse(request.body);
      const user = currentUser(request);
      await findExam(db, id, user);
      if (body.ownerId !== undefined) {
        if (!isAdmin(user)) throw new AppError(403, "FORBIDDEN", "Solo un administrador puede cambiar el propietario.");
        await assertValidOwner(db, body.ownerId);
      }
      return db.tx(async (t) => {
        const sets: string[] = [];
        const params: unknown[] = [id];
        for (const [key, column] of Object.entries(COLUMNS)) {
          const value = (body as Record<string, unknown>)[key];
          if (value === undefined) continue;
          const cast = column.startsWith("available_") ? "::timestamptz" : "";
          sets.push(`${column} = $${params.push(value)}${cast}`);
        }
        if (body.ownerId !== undefined) sets.push(`owner_id = $${params.push(body.ownerId)}`);
        if (sets.length) await t.query(`UPDATE exams SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
        if (body.blocks) await replaceBlocks(t, id, body.blocks, user);
        else if (body.exerciseIds) await replaceWithFlatPool(t, id, body.exerciseIds, user, null);
        if (body.pickCount !== undefined && !body.blocks) await applyLegacyPickCount(t, id, body.pickCount);
        const result = await detail(t, id, user);
        if (result.status === "published") await assertPublishable(t, id);
        return result;
      });
    },
  });

  /** Deprecated exam-level pick count: applies to the only block of a one-block exam, and is ignored when there are several. */
  async function applyLegacyPickCount(t: Queryable, examId: string, pickCount: number | null) {
    const structure = await loadStructure(t, examId);
    if (structure.length !== 1) return;
    const block = structure[0]!;
    const pick = pickCount !== null && pickCount >= block.exercises.length ? null : pickCount;
    await t.query("UPDATE exam_blocks SET pick_count = $2 WHERE id = $1", [block.id, pick]);
    await syncLegacyPickCount(t, examId);
  }

  /** Convenience for the old flat pool: writes ONE default block with these exercises. */
  app.put("/admin/exams/:id/exercises", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = setExercisesBody.parse(request.body);
    const user = currentUser(request);
    return db.tx(async (t) => {
      const exam = await findExam(t, id, user);
      await replaceWithFlatPool(t, id, body.exerciseIds, user, exam.pick_count);
      await t.query("UPDATE exams SET updated_at = now() WHERE id = $1", [id]);
      const result = await detail(t, id, user);
      if (result.status === "published") await assertPublishable(t, id);
      return result;
    });
  });

  app.put("/admin/exams/:id/blocks", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = setBlocksBody.parse(request.body);
    const user = currentUser(request);
    return db.tx(async (t) => {
      await findExam(t, id, user);
      await replaceBlocks(t, id, body.blocks, user);
      await t.query("UPDATE exams SET updated_at = now() WHERE id = $1", [id]);
      const result = await detail(t, id, user);
      if (result.status === "published") await assertPublishable(t, id);
      return result;
    });
  });

  /** Simulates one draw with a throwaway seed: nothing is stored. */
  app.post("/admin/exams/:id/draw-preview", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = previewBody.parse(request.body ?? {});
    const exam = await findExam(db, id, currentUser(request));
    const prepared = await prepareDraw(db, id);
    const seed = body.seed ?? newSeed();
    const drawn = drawBlocks(prepared.blocks, seed, new Set(), exam.shuffle_blocks);
    const ids = drawn.flatMap((b) => b.exerciseIds);
    const marks = ids.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await db.query<{ id: string; title: string; points: number }>(`SELECT id, title, points FROM exercises WHERE id IN (${marks})`, ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const blocks = drawn.map((b) => {
      const exercises = b.exerciseIds.map((exerciseId) => {
        const r = byId.get(exerciseId)!;
        return { id: exerciseId, title: r.title, points: prepared.overrides.get(exerciseId) ?? r.points };
      });
      return {
        title: b.title,
        pickCount: prepared.blocks[b.blockIndex]!.pickCount,
        poolSize: prepared.blocks[b.blockIndex]!.pool.length,
        exercises,
        points: exercises.reduce((s, e) => s + e.points, 0),
      };
    });
    return { seed, exerciseCount: ids.length, totalPoints: blocks.reduce((s, b) => s + b.points, 0), blocks };
  });

  app.post("/admin/exams/:id/duplicate", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const user = currentUser(request);
    await findExam(db, id, user);
    const copyId = await db.tx(async (t) => {
      const { rows } = await t.query<{ id: string }>(
        `INSERT INTO exams (title, description, instructions, duration_minutes, max_attempts, pick_count, scale, pass_percent, grade_policy, status,
                            available_from, available_until, shuffle_blocks, feedback_mode, result_mode, allow_review, access_code, restricted,
                            created_by, owner_id)
         SELECT left(title, 190) || ' (copia)', description, instructions, duration_minutes, max_attempts, pick_count, scale, pass_percent, grade_policy,
                'draft', available_from, available_until, shuffle_blocks, feedback_mode, result_mode, allow_review, NULL, false, $2, $2
           FROM exams WHERE id = $1 RETURNING id`,
        [id, user.id],
      );
      const newId = rows[0]!.id;
      for (const block of await loadStructure(t, id)) {
        const { rows: created } = await t.query<{ id: string }>(
          "INSERT INTO exam_blocks (exam_id, position, title, pick_count, shuffle) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [newId, block.position, block.title, block.pickCount, block.shuffle],
        );
        for (const e of block.exercises) {
          await t.query("INSERT INTO exam_block_exercises (block_id, exercise_id, position, points_override) VALUES ($1, $2, $3, $4)", [
            created[0]!.id, e.exerciseId, e.position, e.pointsOverride,
          ]);
        }
      }
      return newId;
    });
    return reply.status(201).send(await detail(db, copyId, user));
  });

  app.delete("/admin/exams/:id", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await findExam(db, id, currentUser(request));
    const used = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM attempts WHERE exam_id = $1", [id]);
    if (used.rows[0]!.n > 0) throw conflict("EXAM_IN_USE", "Este examen ya tiene intentos de estudiantes y no se puede eliminar. Puedes despublicarlo.");
    await db.query("DELETE FROM exams WHERE id = $1", [id]);
    return reply.status(204).send();
  });

  /* ----- Allow list ----- */

  const accessList = async (examId: string, restricted: boolean) => {
    const { rows } = await db.query<{ id: string; name: string; email: string }>(
      `SELECT u.id, u.name, u.email FROM exam_access ac JOIN users u ON u.id = ac.user_id WHERE ac.exam_id = $1 ORDER BY u.name, u.email`,
      [examId],
    );
    return { restricted, entries: rows.map((r) => ({ userId: r.id, name: r.name, email: r.email })) };
  };

  app.get("/admin/exams/:id/access", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const exam = await findExam(db, id, currentUser(request));
    return accessList(id, exam.restricted);
  });

  app.put("/admin/exams/:id/access", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = accessBody.parse(request.body);
    const exam = await findExam(db, id, currentUser(request));
    const emails = [...new Set(body.emails.filter(Boolean))];
    const matched: Array<{ userId: string; name: string; email: string }> = [];
    if (emails.length) {
      const marks = emails.map((_, i) => `$${i + 1}`).join(", ");
      const { rows } = await db.query<{ id: string; name: string; email: string }>(
        `SELECT id, name, email FROM users WHERE role = 'student' AND email IN (${marks})`,
        emails,
      );
      matched.push(...rows.map((r) => ({ userId: r.id, name: r.name, email: r.email })));
    }
    const known = new Set(matched.map((m) => m.email));
    const unknown = emails.filter((e) => !known.has(e));
    await db.tx(async (t) => {
      await t.query("DELETE FROM exam_access WHERE exam_id = $1", [id]);
      for (const m of matched) await t.query("INSERT INTO exam_access (exam_id, user_id) VALUES ($1, $2)", [id, m.userId]);
      if (body.restricted !== undefined) await t.query("UPDATE exams SET restricted = $2, updated_at = now() WHERE id = $1", [id, body.restricted]);
    });
    return { restricted: body.restricted ?? (exam.restricted as boolean), matched, unknown };
  });

  /* ----- Extra attempts ----- */

  const listOverrides = async (examId: string) => {
    const { rows } = await db.query<Row>(
      `SELECT o.id, o.user_id, o.extra, o.reason, o.created_at, o.granted_by, u.name, u.email, g.name AS granted_by_name
         FROM attempt_overrides o JOIN users u ON u.id = o.user_id LEFT JOIN users g ON g.id = o.granted_by
        WHERE o.exam_id = $1 ORDER BY o.created_at DESC, o.id`,
      [examId],
    );
    return rows.map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      userName: r.name as string,
      userEmail: r.email as string,
      extra: r.extra as number,
      reason: r.reason as string,
      grantedBy: (r.granted_by ?? null) as string | null,
      grantedByName: (r.granted_by_name ?? null) as string | null,
      createdAt: iso(r.created_at),
    }));
  };

  app.get("/admin/exams/:id/overrides", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    await findExam(db, id, currentUser(request));
    return listOverrides(id);
  });

  app.get("/admin/exams/:id/grant-attempt", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    await findExam(db, id, currentUser(request));
    return listOverrides(id);
  });

  app.post("/admin/exams/:id/grant-attempt", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = grantBody.parse(request.body);
    const user = currentUser(request);
    const exam = await findExam(db, id, user);
    const student = await db.query("SELECT 1 FROM users WHERE id = $1 AND role = 'student'", [body.userId]);
    if (!student.rows.length) throw notFound("No encontramos a ese estudiante.");
    const { rows } = await db.query<Row>(
      `INSERT INTO attempt_overrides (exam_id, user_id, extra, reason, granted_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [id, body.userId, body.extra, body.reason, user.id],
    );
    return reply.status(201).send({
      id: rows[0]!.id as string,
      examId: id,
      userId: body.userId,
      extra: body.extra,
      reason: body.reason,
      createdAt: iso(rows[0]!.created_at),
      effectiveMaxAttempts: await effectiveMaxAttempts(db, { id, max_attempts: exam.max_attempts }, body.userId),
    });
  });

  app.delete("/admin/exams/:id/overrides/:overrideId", guard, async (request, reply) => {
    const { id, overrideId } = overrideParams.parse(request.params);
    await findExam(db, id, currentUser(request));
    const { rowCount } = await db.query("DELETE FROM attempt_overrides WHERE id = $1 AND exam_id = $2", [overrideId, id]);
    if (!rowCount) throw notFound("No encontramos esa autorización.");
    return reply.status(204).send();
  });

  /* ----- Results ----- */

  app.get("/admin/results", guard, async (request) => adminResults(ctx, resultsQuery.parse(request.query), ownerScope(currentUser(request))));

  app.get("/admin/attempts/:id", guard, async (request) =>
    adminAttemptDetail(ctx, idParams.parse(request.params).id, ownerScope(currentUser(request))),
  );
}

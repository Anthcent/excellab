import { z } from "zod";
import type { Queryable, Row } from "../db/db.js";
import { badRequest, conflict } from "../http/errors.js";
import type { PublicUser } from "../auth/users.js";
import type { DrawBlock } from "../attempts/random.js";

/* ---------- Block definitions ---------- */

export const blockSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1).max(120),
  /** null = draw every exercise of the block. */
  pickCount: z.number().int().min(1).max(500).nullable().default(null),
  shuffle: z.boolean().default(true),
  exercises: z
    .array(z.object({ exerciseId: z.uuid(), pointsOverride: z.number().positive().max(1000).nullable().optional() }))
    .max(500),
});
export const blocksSchema = z.array(blockSchema).max(20);
export type BlockInput = z.infer<typeof blockSchema>;

export const DEFAULT_BLOCK_TITLE = "Ejercicios";

export interface BlockView {
  id: string;
  position: number;
  title: string;
  pickCount: number | null;
  shuffle: boolean;
  exercises: Array<{
    exerciseId: string;
    title: string;
    points: number;
    pointsOverride: number | null;
    effectivePoints: number;
    status: string;
    position: number;
  }>;
}

/** Blocks of an exam with exercise summaries, in order. */
export async function loadStructure(q: Queryable, examId: string): Promise<BlockView[]> {
  const { rows } = await q.query<Row>(
    `SELECT b.id AS block_id, b.position AS block_position, b.title, b.pick_count, b.shuffle,
            bx.exercise_id, bx.position AS ex_position, bx.points_override, ex.title AS ex_title, ex.points, ex.status AS ex_status
       FROM exam_blocks b
       LEFT JOIN exam_block_exercises bx ON bx.block_id = b.id
       LEFT JOIN exercises ex ON ex.id = bx.exercise_id
      WHERE b.exam_id = $1
      ORDER BY b.position, b.id, bx.position, bx.exercise_id`,
    [examId],
  );
  const blocks: BlockView[] = [];
  const byId = new Map<string, BlockView>();
  for (const r of rows) {
    let block = byId.get(r.block_id);
    if (!block) {
      block = { id: r.block_id, position: r.block_position, title: r.title, pickCount: r.pick_count ?? null, shuffle: r.shuffle, exercises: [] };
      byId.set(r.block_id, block);
      blocks.push(block);
    }
    if (r.exercise_id) {
      block.exercises.push({
        exerciseId: r.exercise_id,
        title: r.ex_title,
        points: r.points,
        pointsOverride: r.points_override ?? null,
        effectivePoints: r.points_override ?? r.points,
        status: r.ex_status,
        position: r.ex_position,
      });
    }
  }
  return blocks;
}

/** Old API shape: one flat, ordered list of the exam exercises. */
export function flattenExercises(blocks: BlockView[]) {
  return blocks
    .flatMap((b) => b.exercises)
    .map((e, position) => ({ id: e.exerciseId, title: e.title, points: e.effectivePoints, position, status: e.status }));
}

/** exams.pick_count is deprecated: it only mirrors the pick count of an exam that has exactly one block. */
export async function syncLegacyPickCount(q: Queryable, examId: string) {
  const { rows } = await q.query<{ pick_count: number | null }>("SELECT pick_count FROM exam_blocks WHERE exam_id = $1", [examId]);
  if (rows.length === 0) return; // nothing to mirror: keep the stored value as the default for the next flat-pool write
  await q.query("UPDATE exams SET pick_count = $2 WHERE id = $1", [examId, rows.length === 1 ? rows[0]!.pick_count : null]);
}

/**
 * Replaces the whole block structure of an exam. Rules:
 * - an exercise appears once per exam; it must exist, be published and (teachers) be the teacher's own,
 *   except exercises the exam already contains, which may stay;
 * - pickCount cannot exceed the number of exercises in its block. With `lenientPick` (the legacy flat-pool API)
 *   a pickCount that is at least the block size simply means "all" (null), as it always did.
 */
export async function replaceBlocks(q: Queryable, examId: string, blocks: BlockInput[], user: PublicUser, lenientPick = false) {
  const ids = blocks.flatMap((b) => b.exercises.map((x) => x.exerciseId));
  if (new Set(ids).size !== ids.length) throw badRequest("Hay ejercicios repetidos en la lista.", "DUPLICATE_EXERCISES");

  const { rows: currentRows } = await q.query<{ id: string }>(
    `SELECT DISTINCT bx.exercise_id AS id FROM exam_block_exercises bx JOIN exam_blocks b ON b.id = bx.block_id WHERE b.exam_id = $1`,
    [examId],
  );
  const current = new Set(currentRows.map((r) => r.id));
  if (ids.length) {
    const marks = ids.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await q.query<{ id: string; status: string; owner_id: string | null }>(
      `SELECT id, status, owner_id FROM exercises WHERE id IN (${marks})`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const found = byId.get(id);
      const staying = current.has(id);
      if (!found || (!staying && user.role !== "admin" && found.owner_id !== user.id)) {
        throw badRequest("Alguno de los ejercicios no existe.", "UNKNOWN_EXERCISE");
      }
      if (!staying && found.status !== "published") throw badRequest("Solo se pueden usar ejercicios publicados.", "EXERCISE_NOT_PUBLISHED");
    }
  }

  const prepared = blocks.map((b) => {
    let pick = b.pickCount;
    if (pick !== null && pick >= b.exercises.length) {
      if (!lenientPick && pick > b.exercises.length) {
        throw badRequest(`El bloque «${b.title}» pide ${pick} ejercicios pero solo tiene ${b.exercises.length}.`, "PICK_EXCEEDS_POOL");
      }
      if (lenientPick) pick = null;
    }
    return { ...b, pickCount: pick };
  });

  const { rows: oldBlocks } = await q.query<{ id: string }>("SELECT id FROM exam_blocks WHERE exam_id = $1", [examId]);
  const oldIds = new Set(oldBlocks.map((r) => r.id));
  await q.query("DELETE FROM exam_blocks WHERE exam_id = $1", [examId]);
  for (const [position, block] of prepared.entries()) {
    const reuse = block.id && oldIds.has(block.id) ? block.id : null;
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO exam_blocks (id, exam_id, position, title, pick_count, shuffle)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6) RETURNING id`,
      [reuse, examId, position, block.title, block.pickCount, block.shuffle],
    );
    for (const [i, item] of block.exercises.entries()) {
      await q.query(
        "INSERT INTO exam_block_exercises (block_id, exercise_id, position, points_override) VALUES ($1, $2, $3, $4)",
        [rows[0]!.id, item.exerciseId, i, item.pointsOverride ?? null],
      );
    }
  }
  await syncLegacyPickCount(q, examId);
}

/** Flat pool API: collapses the structure into one block (the first existing block keeps its title/pick/shuffle). */
export async function replaceWithFlatPool(q: Queryable, examId: string, exerciseIds: string[], user: PublicUser, fallbackPick: number | null) {
  const existing = await loadStructure(q, examId);
  const first = existing[0];
  const overrides = new Map(existing.flatMap((b) => b.exercises).map((e) => [e.exerciseId, e.pointsOverride]));
  await replaceBlocks(
    q,
    examId,
    exerciseIds.length === 0
      ? []
      : [
          {
            ...(first && { id: first.id }),
            title: first?.title ?? DEFAULT_BLOCK_TITLE,
            pickCount: first ? first.pickCount : fallbackPick,
            shuffle: first?.shuffle ?? true,
            exercises: exerciseIds.map((exerciseId) => ({ exerciseId, pointsOverride: overrides.get(exerciseId) ?? null })),
          },
        ],
    user,
    true,
  );
}

/* ---------- Publishing and drawing ---------- */

interface PoolStat {
  title: string;
  pick_count: number | null;
  published: number;
}

async function poolStats(q: Queryable, examId: string): Promise<PoolStat[]> {
  const { rows } = await q.query<PoolStat>(
    `SELECT b.title, b.pick_count,
            (SELECT count(*)::int FROM exam_block_exercises bx JOIN exercises ex ON ex.id = bx.exercise_id
              WHERE bx.block_id = b.id AND ex.status = 'published') AS published
       FROM exam_blocks b WHERE b.exam_id = $1 ORDER BY b.position, b.id`,
    [examId],
  );
  return rows;
}

/** A published exam needs one block with a published exercise, and every block must be able to supply its pick count. */
export async function assertPublishable(q: Queryable, examId: string) {
  const stats = await poolStats(q, examId);
  if (!stats.some((s) => s.published > 0)) throw badRequest("Un examen publicado necesita al menos un ejercicio.", "EXAM_EMPTY");
  for (const s of stats) {
    if (s.pick_count !== null && s.pick_count > s.published) {
      throw badRequest(
        `El bloque «${s.title}» pide ${s.pick_count} ejercicios pero solo tiene ${s.published} publicados.`,
        "PICK_EXCEEDS_POOL",
      );
    }
  }
}

export interface PreparedDraw {
  blocks: DrawBlock[];
  /** exercise id -> points override (only exercises that have one). */
  overrides: Map<string, number>;
}

/**
 * Reads the blocks of an exam for drawing. Only published exercises enter a pool. A block whose published pool
 * is smaller than its pick count is an error (409 EXAM_POOL_TOO_SMALL); a pick-all block with nothing published is skipped.
 */
export async function prepareDraw(q: Queryable, examId: string): Promise<PreparedDraw> {
  const { rows } = await q.query<Row>(
    `SELECT b.id AS block_id, b.title, b.pick_count, b.shuffle, ex.id AS exercise_id, bx.points_override
       FROM exam_blocks b
       LEFT JOIN exam_block_exercises bx ON bx.block_id = b.id
       LEFT JOIN exercises ex ON ex.id = bx.exercise_id AND ex.status = 'published'
      WHERE b.exam_id = $1
      ORDER BY b.position, b.id, bx.position, bx.exercise_id`,
    [examId],
  );
  const order: string[] = [];
  const blocks = new Map<string, { title: string; pickCount: number | null; shuffle: boolean; pool: string[] }>();
  const overrides = new Map<string, number>();
  for (const r of rows) {
    let block = blocks.get(r.block_id);
    if (!block) {
      block = { title: r.title, pickCount: r.pick_count ?? null, shuffle: r.shuffle, pool: [] };
      blocks.set(r.block_id, block);
      order.push(r.block_id);
    }
    if (r.exercise_id) {
      block.pool.push(r.exercise_id);
      if (r.points_override !== null && r.points_override !== undefined) overrides.set(r.exercise_id, r.points_override);
    }
  }
  const result: DrawBlock[] = [];
  for (const id of order) {
    const block = blocks.get(id)!;
    if (block.pickCount !== null && block.pool.length < block.pickCount) {
      throw conflict(
        "EXAM_POOL_TOO_SMALL",
        `El bloque «${block.title}» necesita ${block.pickCount} ejercicios publicados y solo tiene ${block.pool.length}. Avisa a tu profesor.`,
      );
    }
    if (block.pool.length) result.push(block);
  }
  if (!result.length) throw conflict("EXAM_EMPTY", "Este examen todavía no tiene ejercicios.");
  return { blocks: result, overrides };
}

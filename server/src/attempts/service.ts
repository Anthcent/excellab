import { AppError, badRequest, conflict, notFound } from "../http/errors.js";
import type { AppContext } from "../http/context.js";
import { isUniqueViolation, type Queryable, type Row } from "../db/db.js";
import type { PublicUser } from "../auth/users.js";
import type { Workbook } from "../grid/engine.js";
import { checksSchema, gradeWorkbook, toStudentResults, type Check, type CheckResult, type GradeOutcome } from "../grid/checks.js";
import { parseWorkbook, storedWorkbook } from "../grid/workbook.js";
import { drawExercises, newSeed } from "./random.js";

/** Requests this long after the deadline are still accepted (clock skew, slow networks). */
export const GRACE_MS = 5_000;

const round2 = (x: number) => Math.round(x * 100) / 100;
const iso = (d: unknown) => (d ? new Date(d as string | Date).toISOString() : null);
const jsonb = (value: unknown) => JSON.stringify(value);
const placeholders = (n: number, start = 1) => Array.from({ length: n }, (_, i) => `$${start + i}`).join(", ");

export type AttemptStatus = "in_progress" | "submitted" | "expired";

export interface ExamRow {
  id: string;
  title: string;
  instructions: string;
  duration_minutes: number;
  max_attempts: number;
  pick_count: number | null;
  scale: number;
  pass_percent: number;
  grade_policy: "best" | "last";
  status: "draft" | "published";
  available_from: Date | null;
  available_until: Date | null;
}

export interface AttemptRow {
  id: string;
  exam_id: string;
  user_id: string;
  number: number;
  seed: number;
  exercise_ids: string[];
  started_at: Date;
  deadline_at: Date;
  submitted_at: Date | null;
  status: AttemptStatus;
  accepted_at: Date;
  score_percent: number | null;
  grade: number | null;
}

/* ---------- Shared helpers ---------- */

export async function loadExam(q: Queryable, id: string): Promise<ExamRow | undefined> {
  const { rows } = await q.query<ExamRow>("SELECT * FROM exams WHERE id = $1", [id]);
  return rows[0];
}

async function poolOf(q: Queryable, examId: string): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT x.exercise_id AS id FROM exam_exercises x JOIN exercises e ON e.id = x.exercise_id
      WHERE x.exam_id = $1 AND e.status = 'published' ORDER BY x.position, x.exercise_id`,
    [examId],
  );
  return rows.map((r) => r.id);
}

function windowState(exam: ExamRow, now: Date): "open" | "not_open" | "closed" {
  if (exam.available_from && now < new Date(exam.available_from)) return "not_open";
  if (exam.available_until && now > new Date(exam.available_until)) return "closed";
  return "open";
}

export function summarizeAttempt(a: AttemptRow) {
  return {
    id: a.id,
    number: a.number,
    status: a.status,
    scorePercent: a.score_percent,
    grade: a.grade,
    startedAt: iso(a.started_at),
    deadlineAt: iso(a.deadline_at),
    submittedAt: iso(a.submitted_at),
  };
}

/** The exam result of a student follows the exam grade policy over finished attempts. */
export function examResult(exam: Pick<ExamRow, "grade_policy" | "pass_percent">, attempts: AttemptRow[]) {
  const finished = attempts.filter((a) => a.status !== "in_progress" && a.grade !== null);
  if (!finished.length) return null;
  const chosen =
    exam.grade_policy === "last"
      ? finished.reduce((a, b) => (b.number > a.number ? b : a))
      : finished.reduce((a, b) => ((b.grade ?? 0) > (a.grade ?? 0) ? b : a));
  const percent = chosen.score_percent ?? 0;
  return { grade: chosen.grade as number, scorePercent: percent, passed: percent >= exam.pass_percent, attemptNumber: chosen.number };
}

/* ---------- Grading of attempts ---------- */

interface ExerciseRow {
  id: string;
  title: string;
  instructions: string;
  points: number;
  workbook: unknown;
  checks: unknown;
}

async function loadExercises(q: Queryable, ids: string[]): Promise<Map<string, ExerciseRow>> {
  if (!ids.length) return new Map();
  const { rows } = await q.query<ExerciseRow>(
    `SELECT id, title, instructions, points, workbook, checks FROM exercises WHERE id IN (${placeholders(ids.length)})`,
    ids,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

function parseChecks(raw: unknown): Check[] {
  const parsed = checksSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/** Grades a workbook against an exercise. Corrupt stored data never throws: it scores 0. */
export function gradeExercise(exercise: Pick<ExerciseRow, "points" | "checks">, workbook: Workbook): GradeOutcome {
  return gradeWorkbook(workbook, parseChecks(exercise.checks), exercise.points);
}

/** Result for an exercise nobody worked on: every check fails, nothing is evaluated. */
function emptyOutcome(exercise: Pick<ExerciseRow, "points" | "checks">): GradeOutcome {
  const checks = parseChecks(exercise.checks);
  const total = checks.reduce((s, c) => s + c.points, 0);
  const factor = total > 0 ? exercise.points / total : 0;
  const results: CheckResult[] = checks.map((c, index) => ({
    index,
    label: c.label || `Verificación ${index + 1}`,
    points: round2(c.points * factor),
    earned: 0,
    passed: false,
    type: c.type,
    ref: c.type === "range_values" ? c.range : c.cell,
  }));
  return { score: 0, maxScore: exercise.points, results };
}

/**
 * Closes an attempt: grades every exercise that was not submitted yet from its last saved draft
 * (no draft = 0), computes the totals and stores status + grade. Idempotent for closed attempts.
 */
async function closeAttempt(q: Queryable, attempt: AttemptRow, exam: ExamRow, status: "submitted" | "expired", at: Date): Promise<AttemptRow> {
  const exercises = await loadExercises(q, attempt.exercise_ids);
  const { rows: answers } = await q.query<Row>("SELECT * FROM attempt_answers WHERE attempt_id = $1", [attempt.id]);
  const byExercise = new Map(answers.map((a) => [a.exercise_id as string, a]));

  let score = 0;
  let max = 0;
  for (const id of attempt.exercise_ids) {
    const exercise = exercises.get(id);
    if (!exercise) continue;
    const answer = byExercise.get(id);
    if (answer?.submitted_at) {
      score += answer.score ?? 0;
      max += answer.max_score ?? exercise.points;
      continue;
    }
    let outcome: GradeOutcome;
    let workbook: Workbook;
    if (answer) {
      try {
        workbook = storedWorkbook(answer.workbook);
        outcome = gradeExercise(exercise, workbook);
      } catch {
        workbook = storedWorkbook(exercise.workbook);
        outcome = emptyOutcome(exercise);
      }
    } else {
      workbook = storedWorkbook(exercise.workbook);
      outcome = emptyOutcome(exercise);
    }
    await q.query(
      `INSERT INTO attempt_answers (attempt_id, exercise_id, workbook, updated_at, submitted_at, score, max_score, details, graded_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $4::timestamptz, $5, $6, $7::jsonb, $4::timestamptz)
       ON CONFLICT (attempt_id, exercise_id) DO UPDATE
         SET submitted_at = EXCLUDED.submitted_at, score = EXCLUDED.score, max_score = EXCLUDED.max_score,
             details = EXCLUDED.details, graded_at = EXCLUDED.graded_at`,
      [attempt.id, id, jsonb(workbook), at.toISOString(), outcome.score, outcome.maxScore, jsonb(outcome.results)],
    );
    score += outcome.score;
    max += outcome.maxScore;
  }

  const percent = max > 0 ? round2((score / max) * 100) : 0;
  const grade = round2((percent / 100) * exam.scale);
  const submittedAt = status === "expired" ? new Date(Math.min(at.getTime(), new Date(attempt.deadline_at).getTime())) : at;
  const { rows } = await q.query<AttemptRow>(
    `UPDATE attempts SET status = $2, submitted_at = $3::timestamptz, score_percent = $4, grade = $5
      WHERE id = $1 AND status = 'in_progress' RETURNING *`,
    [attempt.id, status, submittedAt.toISOString(), percent, grade],
  );
  return rows[0] ?? attempt;
}

/** If the attempt is past deadline + grace, grade it from the drafts and mark it expired. Own transaction. */
export async function refreshAttempt(ctx: AppContext, attemptId: string, userId?: string): Promise<AttemptRow> {
  const found = await ctx.db.query<AttemptRow>("SELECT * FROM attempts WHERE id = $1", [attemptId]);
  const attempt = found.rows[0];
  if (!attempt || (userId && attempt.user_id !== userId)) throw notFound("No encontramos ese intento.");
  const now = ctx.now();
  if (attempt.status !== "in_progress" || now.getTime() <= new Date(attempt.deadline_at).getTime() + GRACE_MS) return attempt;
  return ctx.db.tx(async (t) => {
    const exam = (await loadExam(t, attempt.exam_id))!;
    return closeAttempt(t, attempt, exam, "expired", now);
  });
}

/** Closes every overdue attempt (periodic safety net; requests also expire attempts lazily). */
export async function expireOverdueAttempts(ctx: AppContext): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - GRACE_MS).toISOString();
  const { rows } = await ctx.db.query<{ id: string }>(
    "SELECT id FROM attempts WHERE status = 'in_progress' AND deadline_at < $1::timestamptz",
    [cutoff],
  );
  for (const row of rows) await refreshAttempt(ctx, row.id);
  return rows.length;
}

/* ---------- Student: exams ---------- */

function examCard(exam: ExamRow & { pool_size: number }, attempts: AttemptRow[], now: Date) {
  const mine = attempts.filter((a) => a.exam_id === exam.id).sort((a, b) => a.number - b.number);
  const running = mine.find((a) => a.status === "in_progress");
  const result = examResult(exam, mine);
  const windowStatus = windowState(exam, now);
  return {
    id: exam.id,
    title: exam.title,
    durationMinutes: exam.duration_minutes,
    maxAttempts: exam.max_attempts,
    exerciseCount: exam.pick_count ? Math.min(exam.pick_count, exam.pool_size) : exam.pool_size,
    scale: exam.scale,
    passPercent: exam.pass_percent,
    gradePolicy: exam.grade_policy,
    availableFrom: iso(exam.available_from),
    availableUntil: iso(exam.available_until),
    window: windowStatus,
    attemptsUsed: mine.length,
    attemptsRemaining: Math.max(0, exam.max_attempts - mine.length),
    inProgressAttemptId: running?.id ?? null,
    result,
    attempts: mine.map(summarizeAttempt),
  };
}

async function myAttempts(q: Queryable, userId: string): Promise<AttemptRow[]> {
  const { rows } = await q.query<AttemptRow>("SELECT * FROM attempts WHERE user_id = $1 ORDER BY number", [userId]);
  return rows;
}

export async function listExamsForStudent(ctx: AppContext, user: PublicUser) {
  await expireMine(ctx, user.id);
  const { rows } = await ctx.db.query<ExamRow & { pool_size: number }>(
    `SELECT e.*, (SELECT count(*)::int FROM exam_exercises x JOIN exercises ex ON ex.id = x.exercise_id
                   WHERE x.exam_id = e.id AND ex.status = 'published') AS pool_size
       FROM exams e WHERE e.status = 'published' ORDER BY e.created_at, e.id`,
  );
  const attempts = await myAttempts(ctx.db, user.id);
  const now = ctx.now();
  return rows.map((exam) => examCard(exam, attempts, now));
}

async function expireMine(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query<{ id: string }>("SELECT id FROM attempts WHERE user_id = $1 AND status = 'in_progress'", [userId]);
  for (const row of rows) await refreshAttempt(ctx, row.id, userId);
}

export async function getExamForStudent(ctx: AppContext, user: PublicUser, examId: string) {
  await expireMine(ctx, user.id);
  const { rows } = await ctx.db.query<ExamRow & { pool_size: number }>(
    `SELECT e.*, (SELECT count(*)::int FROM exam_exercises x JOIN exercises ex ON ex.id = x.exercise_id
                   WHERE x.exam_id = e.id AND ex.status = 'published') AS pool_size
       FROM exams e WHERE e.id = $1 AND e.status = 'published'`,
    [examId],
  );
  const exam = rows[0];
  if (!exam) throw notFound("No encontramos ese examen.");
  const attempts = (await myAttempts(ctx.db, user.id)).filter((a) => a.exam_id === examId);
  // Rules and instructions only: the exercises themselves are revealed once an attempt starts.
  return { ...examCard(exam, attempts, ctx.now()), instructions: exam.instructions };
}

/* ---------- Student: attempts ---------- */

export async function startAttempt(ctx: AppContext, user: PublicUser, examId: string, accepted: boolean) {
  // A running attempt that is already overdue must be closed first so it does not block a new one.
  await expireMine(ctx, user.id);
  const now = ctx.now();
  try {
    return await ctx.db.tx(async (t) => {
      const exam = await loadExam(t, examId);
      if (!exam || exam.status !== "published") throw notFound("No encontramos ese examen.");

      const { rows: mine } = await t.query<AttemptRow>("SELECT * FROM attempts WHERE exam_id = $1 AND user_id = $2 ORDER BY number", [examId, user.id]);
      const running = mine.find((a) => a.status === "in_progress");
      if (running) return { attemptId: running.id, resumed: true };

      const windowStatus = windowState(exam, now);
      if (windowStatus === "not_open") throw new AppError(403, "EXAM_NOT_OPEN", "Este examen todavía no está disponible.");
      if (windowStatus === "closed") throw new AppError(403, "EXAM_CLOSED", "Este examen ya cerró.");
      if (mine.length >= exam.max_attempts) throw conflict("NO_ATTEMPTS_LEFT", "Ya usaste todos tus intentos para este examen.");
      if (accepted !== true) throw badRequest("Debes aceptar las instrucciones para comenzar.", "INSTRUCTIONS_NOT_ACCEPTED");

      const pool = await poolOf(t, examId);
      if (!pool.length) throw conflict("EXAM_EMPTY", "Este examen todavía no tiene ejercicios.");

      const seen = new Set(mine.flatMap((a) => a.exercise_ids));
      const seed = newSeed();
      const drawn = drawExercises(pool, exam.pick_count, seed, seen);
      const number = mine.reduce((m, a) => Math.max(m, a.number), 0) + 1;
      const deadline = new Date(now.getTime() + exam.duration_minutes * 60_000);
      const { rows } = await t.query<{ id: string }>(
        `INSERT INTO attempts (exam_id, user_id, number, seed, exercise_ids, started_at, deadline_at, accepted_at, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz, $6::timestamptz, 'in_progress') RETURNING id`,
        [examId, user.id, number, seed, jsonb(drawn), now.toISOString(), deadline.toISOString()],
      );
      return { attemptId: rows[0]!.id, resumed: false };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Two simultaneous starts: the second one gets the attempt the first one created.
    const { rows } = await ctx.db.query<AttemptRow>("SELECT id FROM attempts WHERE exam_id = $1 AND user_id = $2 AND status = 'in_progress'", [examId, user.id]);
    if (rows[0]) return { attemptId: rows[0].id, resumed: true };
    throw error;
  }
}

/** Attempt state for the student. Never includes checks or expected values. */
export async function attemptView(ctx: AppContext, attemptId: string, userId: string) {
  const attempt = await refreshAttempt(ctx, attemptId, userId);
  const exam = (await loadExam(ctx.db, attempt.exam_id))!;
  const exercises = await loadExercises(ctx.db, attempt.exercise_ids);
  const { rows: answers } = await ctx.db.query<Row>("SELECT * FROM attempt_answers WHERE attempt_id = $1", [attempt.id]);
  const byExercise = new Map(answers.map((a) => [a.exercise_id as string, a]));
  const finished = attempt.status !== "in_progress";

  const list = attempt.exercise_ids.flatMap((id, i) => {
    const exercise = exercises.get(id);
    if (!exercise) return [];
    const answer = byExercise.get(id);
    const submitted = !!answer?.submitted_at;
    return [
      {
        id,
        position: i + 1,
        title: exercise.title,
        instructions: exercise.instructions,
        points: exercise.points,
        workbook: storedWorkbook(answer?.workbook ?? exercise.workbook),
        submitted,
        score: submitted ? (answer!.score as number) : null,
        maxScore: submitted ? (answer!.max_score as number) : exercise.points,
        results: submitted ? toStudentResults((answer!.details ?? []) as CheckResult[]) : null,
      },
    ];
  });

  return {
    id: attempt.id,
    examId: exam.id,
    examTitle: exam.title,
    number: attempt.number,
    status: attempt.status,
    startedAt: iso(attempt.started_at),
    deadlineAt: iso(attempt.deadline_at),
    serverNow: ctx.now().toISOString(),
    durationMinutes: exam.duration_minutes,
    scale: exam.scale,
    passPercent: exam.pass_percent,
    scorePercent: finished ? attempt.score_percent : null,
    grade: finished ? attempt.grade : null,
    passed: finished && attempt.score_percent !== null ? attempt.score_percent >= exam.pass_percent : null,
    exercises: list,
  };
}

async function assertOpenAttempt(ctx: AppContext, attemptId: string, userId: string, exerciseId: string): Promise<AttemptRow> {
  const attempt = await refreshAttempt(ctx, attemptId, userId);
  if (attempt.status === "expired") throw conflict("ATTEMPT_EXPIRED", "El tiempo del examen terminó.");
  if (attempt.status !== "in_progress") throw conflict("ATTEMPT_CLOSED", "Este intento ya fue enviado.");
  if (!attempt.exercise_ids.includes(exerciseId)) throw notFound("Ese ejercicio no pertenece a este intento.");
  return attempt;
}

export async function saveDraft(ctx: AppContext, userId: string, attemptId: string, exerciseId: string, rawWorkbook: unknown) {
  const workbook = parseWorkbook(rawWorkbook);
  await assertOpenAttempt(ctx, attemptId, userId, exerciseId);
  const savedAt = ctx.now();
  const { rowCount } = await ctx.db.query(
    `INSERT INTO attempt_answers AS a (attempt_id, exercise_id, workbook, updated_at) VALUES ($1, $2, $3::jsonb, $4::timestamptz)
     ON CONFLICT (attempt_id, exercise_id) DO UPDATE SET workbook = EXCLUDED.workbook, updated_at = EXCLUDED.updated_at
       WHERE a.submitted_at IS NULL`,
    [attemptId, exerciseId, jsonb(workbook), savedAt.toISOString()],
  );
  if (!rowCount) throw conflict("EXERCISE_ALREADY_SUBMITTED", "Este ejercicio ya fue enviado y no se puede modificar.");
  return { savedAt: savedAt.toISOString() };
}

export async function submitExercise(ctx: AppContext, userId: string, attemptId: string, exerciseId: string, rawWorkbook: unknown) {
  const workbook = parseWorkbook(rawWorkbook);
  await assertOpenAttempt(ctx, attemptId, userId, exerciseId);
  const at = ctx.now();
  return ctx.db.tx(async (t) => {
    const exercises = await loadExercises(t, [exerciseId]);
    const exercise = exercises.get(exerciseId);
    if (!exercise) throw notFound("No encontramos ese ejercicio.");
    const { rows: existing } = await t.query<{ submitted_at: Date | null }>(
      "SELECT submitted_at FROM attempt_answers WHERE attempt_id = $1 AND exercise_id = $2",
      [attemptId, exerciseId],
    );
    if (existing[0]?.submitted_at) throw conflict("EXERCISE_ALREADY_SUBMITTED", "Este ejercicio ya fue enviado y no se puede modificar.");

    const outcome = gradeExercise(exercise, workbook);
    await t.query(
      `INSERT INTO attempt_answers (attempt_id, exercise_id, workbook, updated_at, submitted_at, score, max_score, details, graded_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $4::timestamptz, $5, $6, $7::jsonb, $4::timestamptz)
       ON CONFLICT (attempt_id, exercise_id) DO UPDATE
         SET workbook = EXCLUDED.workbook, updated_at = EXCLUDED.updated_at, submitted_at = EXCLUDED.submitted_at,
             score = EXCLUDED.score, max_score = EXCLUDED.max_score, details = EXCLUDED.details, graded_at = EXCLUDED.graded_at`,
      [attemptId, exerciseId, jsonb(workbook), at.toISOString(), outcome.score, outcome.maxScore, jsonb(outcome.results)],
    );
    const { rows: done } = await t.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM attempt_answers WHERE attempt_id = $1 AND submitted_at IS NOT NULL",
      [attemptId],
    );
    const { rows: att } = await t.query<{ exercise_ids: string[] }>("SELECT exercise_ids FROM attempts WHERE id = $1", [attemptId]);
    return {
      exerciseId,
      score: outcome.score,
      maxScore: outcome.maxScore,
      results: toStudentResults(outcome.results),
      progress: { submitted: done[0]!.n, total: att[0]!.exercise_ids.length },
    };
  });
}

export async function finishAttempt(ctx: AppContext, userId: string, attemptId: string) {
  const attempt = await refreshAttempt(ctx, attemptId, userId);
  if (attempt.status === "in_progress") {
    const at = ctx.now();
    await ctx.db.tx(async (t) => {
      const exam = (await loadExam(t, attempt.exam_id))!;
      await closeAttempt(t, attempt, exam, "submitted", at);
    });
  }
  return attemptView(ctx, attemptId, userId);
}

/* ---------- Student & staff: results ---------- */

export async function myResults(ctx: AppContext, user: PublicUser) {
  await expireMine(ctx, user.id);
  const attempts = await myAttempts(ctx.db, user.id);
  const examIds = [...new Set(attempts.map((a) => a.exam_id))];
  if (!examIds.length) return [];
  const { rows: exams } = await ctx.db.query<ExamRow>(`SELECT * FROM exams WHERE id IN (${placeholders(examIds.length)}) ORDER BY title`, examIds);
  return exams.map((exam) => {
    const mine = attempts.filter((a) => a.exam_id === exam.id);
    return {
      examId: exam.id,
      title: exam.title,
      scale: exam.scale,
      passPercent: exam.pass_percent,
      gradePolicy: exam.grade_policy,
      maxAttempts: exam.max_attempts,
      attemptsUsed: mine.length,
      result: examResult(exam, mine),
      attempts: mine.map(summarizeAttempt),
    };
  });
}

export async function adminResults(ctx: AppContext, filter: { examId?: string | undefined; userId?: string | undefined }) {
  await expireOverdueAttempts(ctx);
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.examId) where.push(`a.exam_id = $${params.push(filter.examId)}`);
  if (filter.userId) where.push(`a.user_id = $${params.push(filter.userId)}`);
  const { rows } = await ctx.db.query<AttemptRow & { user_name: string; user_email: string; exam_title: string; scale: number; pass_percent: number; grade_policy: "best" | "last" }>(
    `SELECT a.*, u.name AS user_name, u.email AS user_email, e.title AS exam_title, e.scale, e.pass_percent, e.grade_policy
       FROM attempts a JOIN users u ON u.id = a.user_id JOIN exams e ON e.id = a.exam_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY a.started_at DESC`,
    params,
  );
  const attempts = rows.map((r) => ({
    ...summarizeAttempt(r),
    examId: r.exam_id,
    examTitle: r.exam_title,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    scale: r.scale,
  }));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(`${r.exam_id}|${r.user_id}`, [...(groups.get(`${r.exam_id}|${r.user_id}`) ?? []), r]);
  const summary = [...groups.values()].map((g) => {
    const first = g[0]!;
    return {
      examId: first.exam_id,
      examTitle: first.exam_title,
      userId: first.user_id,
      userName: first.user_name,
      userEmail: first.user_email,
      scale: first.scale,
      attemptsUsed: g.length,
      result: examResult(first, g),
    };
  });
  return { attempts, summary };
}

export async function adminAttemptDetail(ctx: AppContext, attemptId: string) {
  const { rows } = await ctx.db.query<AttemptRow>("SELECT * FROM attempts WHERE id = $1", [attemptId]);
  if (!rows[0]) throw notFound("No encontramos ese intento.");
  const attempt = await refreshAttempt(ctx, attemptId);
  const exam = (await loadExam(ctx.db, attempt.exam_id))!;
  const { rows: users } = await ctx.db.query<{ name: string; email: string }>("SELECT name, email FROM users WHERE id = $1", [attempt.user_id]);
  const exercises = await loadExercises(ctx.db, attempt.exercise_ids);
  const { rows: answers } = await ctx.db.query<Row>("SELECT * FROM attempt_answers WHERE attempt_id = $1", [attemptId]);
  const byExercise = new Map(answers.map((a) => [a.exercise_id as string, a]));
  return {
    ...summarizeAttempt(attempt),
    seed: attempt.seed,
    examId: exam.id,
    examTitle: exam.title,
    scale: exam.scale,
    passPercent: exam.pass_percent,
    user: { id: attempt.user_id, name: users[0]?.name ?? "", email: users[0]?.email ?? "" },
    answers: attempt.exercise_ids.flatMap((id, i) => {
      const exercise = exercises.get(id);
      if (!exercise) return [];
      const a = byExercise.get(id);
      return [
        {
          exerciseId: id,
          position: i + 1,
          title: exercise.title,
          points: exercise.points,
          answered: !!a,
          submittedAt: iso(a?.submitted_at),
          score: a?.score ?? null,
          maxScore: a?.max_score ?? exercise.points,
          details: a?.details ?? null,
          workbook: a ? storedWorkbook(a.workbook) : null,
        },
      ];
    }),
  };
}

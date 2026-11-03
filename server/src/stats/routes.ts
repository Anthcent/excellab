import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/context.js";
import type { Row } from "../db/db.js";
import { notFound } from "../http/errors.js";
import { currentUser, ownerScope, requireStaff } from "../http/guards.js";
import { adminResults, expireOverdueAttempts } from "../attempts/service.js";
import { toCsv } from "./csv.js";

const idParams = z.object({ id: z.uuid() });
const resultsQuery = z.object({ examId: z.uuid().optional(), userId: z.uuid().optional() });

const DAY_MS = 86_400_000;
const round2 = (x: number) => Math.round(x * 100) / 100;
const iso = (d: unknown) => (d ? new Date(d as string | Date).toISOString() : null);
const mean = (values: number[]) => (values.length ? round2(values.reduce((s, v) => s + v, 0) / values.length) : null);
const percentOf = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : null);
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

const STATUS_ES: Record<string, string> = { in_progress: "En curso", submitted: "Enviado", expired: "Tiempo agotado" };
const CSV_HEADER = ["Estudiante", "Correo", "Examen", "Intento", "Estado", "Porcentaje", "Nota", "Escala", "Aprobado", "Inicio", "Entrega"];

function sendCsv(reply: FastifyReply, filename: string, body: string) {
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${filename}"`)
    .send(body);
}

const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 50) || "examen";

export async function statsRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = { preHandler: requireStaff };
  const db = ctx.db;

  /* ----- Dashboard ----- */

  app.get("/admin/stats", guard, async (request) => {
    const user = currentUser(request);
    const owner = ownerScope(user);
    await expireOverdueAttempts(ctx);
    const now = ctx.now();
    const since7 = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const since30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    const todayStart = new Date(`${utcDay(now)}T00:00:00.000Z`);
    const sinceDays = new Date(todayStart.getTime() - 13 * DAY_MS).toISOString();

    /** " AND e.owner_id = $n" for teachers, appended to queries that alias exams as `e`. */
    const scoped = (params: unknown[]) => (owner ? ` AND e.owner_id = $${params.push(owner)}` : "");

    const totalsParams: unknown[] = [since7, since30];
    const { rows: totals } = await db.query<Row>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE a.started_at >= $1::timestamptz)::int AS last7,
              count(*) FILTER (WHERE a.started_at >= $2::timestamptz)::int AS last30,
              count(*) FILTER (WHERE a.status = 'in_progress')::int AS in_progress,
              count(*) FILTER (WHERE a.status <> 'in_progress')::int AS finished,
              count(*) FILTER (WHERE a.status <> 'in_progress' AND a.score_percent >= e.pass_percent)::int AS passed,
              avg(a.score_percent) FILTER (WHERE a.status <> 'in_progress') AS avg_percent
         FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE true${scoped(totalsParams)}`,
      totalsParams,
    );
    const t = totals[0]!;

    const dayParams: unknown[] = [sinceDays];
    const { rows: dayRows } = await db.query<{ day: string; n: number }>(
      `SELECT to_char(a.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM attempts a JOIN exams e ON e.id = a.exam_id
        WHERE a.started_at >= $1::timestamptz${scoped(dayParams)} GROUP BY 1`,
      dayParams,
    );
    const perDay = new Map(dayRows.map((r) => [r.day, r.n]));
    const attemptsPerDay = Array.from({ length: 14 }, (_, i) => {
      const date = utcDay(new Date(todayStart.getTime() - (13 - i) * DAY_MS));
      return { date, count: perDay.get(date) ?? 0 };
    });

    const topParams: unknown[] = [];
    const { rows: top } = await db.query<{ id: string; title: string; n: number }>(
      `SELECT e.id, e.title, count(*)::int AS n FROM attempts a JOIN exams e ON e.id = a.exam_id
        WHERE true${scoped(topParams)} GROUP BY e.id, e.title ORDER BY n DESC, e.title, e.id LIMIT 5`,
      topParams,
    );

    const recentParams: unknown[] = [];
    const { rows: recent } = await db.query<Row>(
      `SELECT a.id, a.status, a.score_percent, a.grade, a.started_at, a.submitted_at, u.name, u.email, e.id AS exam_id, e.title, e.scale, e.pass_percent
         FROM attempts a JOIN exams e ON e.id = a.exam_id JOIN users u ON u.id = a.user_id
        WHERE true${scoped(recentParams)} ORDER BY a.started_at DESC, a.id DESC LIMIT 10`,
      recentParams,
    );

    const byStatus = async (table: "exercises" | "exams") => {
      const { rows } = await db.query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM ${table} ${owner ? "WHERE owner_id = $1" : ""} GROUP BY status`,
        owner ? [owner] : [],
      );
      const draft = rows.find((r) => r.status === "draft")?.n ?? 0;
      const published = rows.find((r) => r.status === "published")?.n ?? 0;
      return { draft, published, total: draft + published };
    };

    let students: number;
    let teachers: number | null = null;
    if (owner) {
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(DISTINCT a.user_id)::int AS n FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE e.owner_id = $1",
        [owner],
      );
      students = rows[0]!.n;
    } else {
      const { rows } = await db.query<{ role: string; n: number }>(
        "SELECT role, count(*)::int AS n FROM users WHERE active AND role IN ('student', 'teacher') GROUP BY role",
      );
      students = rows.find((r) => r.role === "student")?.n ?? 0;
      teachers = rows.find((r) => r.role === "teacher")?.n ?? 0;
    }

    return {
      scope: owner ? "own" : "all",
      counts: {
        students,
        teachers,
        exercises: await byStatus("exercises"),
        exams: await byStatus("exams"),
        attempts: { total: t.total, last7Days: t.last7, last30Days: t.last30, inProgress: t.in_progress },
      },
      averageGradePercent: t.avg_percent === null ? null : round2(Number(t.avg_percent)),
      passRate: percentOf(t.passed, t.finished),
      attemptsPerDay,
      topExams: top.map((r) => ({ examId: r.id, title: r.title, attempts: r.n })),
      recentAttempts: recent.map((r) => ({
        id: r.id,
        studentName: r.name,
        studentEmail: r.email,
        examId: r.exam_id,
        examTitle: r.title,
        status: r.status,
        scorePercent: r.score_percent ?? null,
        grade: r.grade ?? null,
        scale: r.scale,
        passed: r.status !== "in_progress" && r.score_percent !== null ? r.score_percent >= r.pass_percent : null,
        startedAt: iso(r.started_at),
        submittedAt: iso(r.submitted_at),
      })),
    };
  });

  /* ----- Exam analytics ----- */

  const ownedExam = async (id: string, request: Parameters<typeof currentUser>[0]) => {
    const owner = ownerScope(currentUser(request));
    const { rows } = await db.query<Row>("SELECT * FROM exams WHERE id = $1 AND ($2::uuid IS NULL OR owner_id = $2::uuid)", [id, owner ?? null]);
    if (!rows[0]) throw notFound("No encontramos ese examen.");
    return rows[0];
  };

  app.get("/admin/exams/:id/analytics", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    const exam = await ownedExam(id, request);
    await expireOverdueAttempts(ctx);

    const { rows: attempts } = await db.query<Row>(
      `SELECT a.id, a.user_id, a.number, a.status, a.score_percent, a.grade, a.started_at, a.submitted_at, a.exercise_ids, u.name, u.email
         FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.exam_id = $1 ORDER BY a.started_at, a.id`,
      [id],
    );
    const { rows: answers } = await db.query<Row>(
      `SELECT aa.exercise_id, aa.score, aa.max_score FROM attempt_answers aa JOIN attempts a ON a.id = aa.attempt_id
        WHERE a.exam_id = $1 AND aa.submitted_at IS NOT NULL`,
      [id],
    );

    const finished = attempts.filter((a) => a.status !== "in_progress" && a.score_percent !== null);
    const distribution = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: (i + 1) * 10, count: 0 }));
    for (const a of finished) distribution[Math.min(9, Math.floor((a.score_percent as number) / 10))]!.count++;

    const durations = attempts
      .filter((a) => a.status === "submitted" && a.submitted_at)
      .map((a) => (new Date(a.submitted_at).getTime() - new Date(a.started_at).getTime()) / 1000);

    const drawn = new Map<string, number>();
    for (const a of attempts) for (const exerciseId of a.exercise_ids as string[]) drawn.set(exerciseId, (drawn.get(exerciseId) ?? 0) + 1);
    const titles = new Map<string, string>();
    if (drawn.size) {
      const ids = [...drawn.keys()];
      const { rows } = await db.query<{ id: string; title: string }>(
        `SELECT id, title FROM exercises WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")})`,
        ids,
      );
      for (const r of rows) titles.set(r.id, r.title);
    }
    const exercises = [...drawn.entries()]
      .map(([exerciseId, timesDrawn]) => {
        const graded = answers.filter((a) => a.exercise_id === exerciseId && a.max_score > 0);
        return {
          exerciseId,
          title: titles.get(exerciseId) ?? "",
          timesDrawn,
          gradedCount: graded.length,
          averagePercent: mean(graded.map((a) => (a.score / a.max_score) * 100)),
          /** Percentage of graded answers that earned every point. */
          fullMarksShare: percentOf(graded.filter((a) => a.score >= a.max_score).length, graded.length),
        };
      })
      .sort((a, b) => b.timesDrawn - a.timesDrawn || a.title.localeCompare(b.title));

    const byUser = new Map<string, Row[]>();
    for (const a of attempts) byUser.set(a.user_id, [...(byUser.get(a.user_id) ?? []), a]);
    const students = [...byUser.values()].map((list) => {
      const done = list.filter((a) => a.status !== "in_progress" && a.grade !== null);
      const best = done.reduce<Row | undefined>((m, a) => (!m || a.grade > m.grade ? a : m), undefined);
      return {
        userId: list[0]!.user_id as string,
        name: list[0]!.name as string,
        email: list[0]!.email as string,
        attemptsUsed: list.length,
        bestGrade: best?.grade ?? null,
        bestPercent: best?.score_percent ?? null,
        passed: best ? best.score_percent >= exam.pass_percent : null,
        lastAttemptAt: iso(list[list.length - 1]!.started_at),
      };
    });
    students.sort((a, b) => (b.bestGrade ?? -1) - (a.bestGrade ?? -1) || a.name.localeCompare(b.name));

    return {
      exam: { id: exam.id as string, title: exam.title as string, scale: exam.scale as number, passPercent: exam.pass_percent as number },
      attemptsCount: attempts.length,
      finishedCount: finished.length,
      inProgressCount: attempts.filter((a) => a.status === "in_progress").length,
      uniqueStudents: byUser.size,
      averagePercent: mean(finished.map((a) => a.score_percent as number)),
      passRate: percentOf(finished.filter((a) => (a.score_percent as number) >= exam.pass_percent).length, finished.length),
      averageCompletionSeconds: durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : null,
      distribution,
      exercises,
      students,
    };
  });

  /* ----- CSV ----- */

  async function resultsCsv(filter: { examId?: string | undefined; userId?: string | undefined }, owner: string | undefined) {
    const { attempts } = await adminResults(ctx, filter, owner);
    return toCsv(
      CSV_HEADER,
      attempts.map((a) => [
        a.userName,
        a.userEmail,
        a.examTitle,
        a.number,
        STATUS_ES[a.status] ?? a.status,
        a.scorePercent,
        a.grade,
        a.scale,
        a.passed,
        a.startedAt,
        a.submittedAt,
      ]),
    );
  }

  app.get("/admin/results.csv", guard, async (request, reply) => {
    const filter = resultsQuery.parse(request.query);
    return sendCsv(reply, "resultados.csv", await resultsCsv(filter, ownerScope(currentUser(request))));
  });

  app.get("/admin/exams/:id/results.csv", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const exam = await ownedExam(id, request);
    return sendCsv(reply, `resultados-${slug(exam.title)}.csv`, await resultsCsv({ examId: id }, ownerScope(currentUser(request))));
  });
}

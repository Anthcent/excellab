import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, CORRECT, answer, createTestEnv, exerciseBody, numberOf, type Json, type TestEnv } from "./helpers.js";
import { toCsv } from "../src/stats/csv.js";

const minutes = (n: number) => n * 60_000;
const DAY = 86_400_000;

describe("csv encoding", () => {
  test("BOM, ';' delimiter, CRLF, decimal commas, quoting and formula guard", () => {
    const csv = toCsv(["a", "b;c"], [[1.5, "x;y"], ['q"uote', "línea\nnueva"], ["=1+1", "@cmd"], [null, true], [false, 7]]);
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.equal(
      csv,
      '﻿a;"b;c"\r\n' + '1,5;"x;y"\r\n' + '"q""uote";"línea\nnueva"\r\n' + "'=1+1;'@cmd\r\n" + ";Sí\r\n" + "No;7\r\n",
    );
  });
});

describe("stats, analytics and CSV export", () => {
  let env: TestEnv;
  let admin: string;
  let teacher: string;
  let examId: string;
  const base = Date.parse("2030-01-01T10:00:00Z");
  const ids: string[] = [];
  const names = { s1: 'Pérez; Ana "la" Mejor', s2: "=HYPERLINK(\"x\";\"y\")", s3: "Carlos Pendiente" };

  const json = (r: { json<T>(): T }) => r.json<Json>();

  before(async () => {
    env = await createTestEnv();
    admin = await env.login(ADMIN.email, ADMIN.password);
    teacher = await env.makeUser(admin, "profe@example.com", "teacher", "Profe");

    // Fresh database: every aggregate has its empty value.
    const empty = json(await env.call("GET", "/api/admin/stats", { cookie: admin }));
    assert.equal(empty.averageGradePercent, null);
    assert.equal(empty.passRate, null);
    assert.deepEqual(empty.topExams, []);
    assert.deepEqual(empty.recentAttempts, []);
    assert.equal(empty.attemptsPerDay.length, 14);
    assert.ok(empty.attemptsPerDay.every((d: Json) => d.count === 0));

    for (let n = 1; n <= 2; n++) ids.push(json(await env.call("POST", "/api/admin/exercises", { cookie: teacher, payload: exerciseBody(n) })).id);
    examId = json(
      await env.call("POST", "/api/admin/exams", {
        cookie: teacher,
        payload: { title: "Análisis: Parcial 1", durationMinutes: 30, maxAttempts: 3, status: "published", exerciseIds: ids },
      }),
    ).id;

    const play = async (cookie: string, solve: (n: number) => unknown, takes: number) => {
      const v = json(await env.call("POST", `/api/exams/${examId}/attempts`, { cookie, payload: { accepted: true } }));
      for (const ex of v.exercises as Json[]) {
        const n = numberOf(ex.title);
        await env.call("POST", `/api/attempts/${v.id}/exercises/${ex.id}/submit`, { cookie, payload: { workbook: solve(n) } });
      }
      env.clock.now += takes;
      await env.call("POST", `/api/attempts/${v.id}/finish`, { cookie });
      return v;
    };

    // Three days ago: a perfect attempt that takes 5 minutes.
    env.clock.now = base - 3 * DAY;
    const c1 = await env.register("uno@example.com", names.s1);
    await play(c1, CORRECT, minutes(5));
    // Today: a 50% attempt (exercise 1 right, exercise 2 wrong) that takes 2 minutes, and a running attempt.
    env.clock.now = base;
    const c2 = await env.register("dos@example.com", names.s2);
    await play(c2, (n) => (n === 1 ? CORRECT(1) : answer(n, "=0")), minutes(2));
    env.clock.now = base + minutes(10);
    const c3 = await env.register("tres@example.com", names.s3);
    await env.call("POST", `/api/exams/${examId}/attempts`, { cookie: c3, payload: { accepted: true } });
    env.clock.now = base + minutes(11);
  });
  after(() => env.close());

  test("dashboard stats: counts, averages, 14 zero-filled days, top exams and recent attempts", async () => {
    const s = json(await env.call("GET", "/api/admin/stats", { cookie: admin }));
    assert.equal(s.scope, "all");
    assert.deepEqual(s.counts.exercises, { draft: 0, published: 2, total: 2 });
    assert.deepEqual(s.counts.exams, { draft: 0, published: 1, total: 1 });
    assert.deepEqual(s.counts.attempts, { total: 3, last7Days: 3, last30Days: 3, inProgress: 1 });
    assert.equal(s.counts.students, 3);
    assert.equal(s.counts.teachers, 1);
    assert.equal(s.averageGradePercent, 75);
    assert.equal(s.passRate, 50);
    assert.equal(s.attemptsPerDay.length, 14);
    assert.equal(s.attemptsPerDay[13].date, "2030-01-01");
    assert.equal(s.attemptsPerDay[0].date, "2029-12-19");
    assert.equal(s.attemptsPerDay[13].count, 2);
    assert.equal(s.attemptsPerDay.find((d: Json) => d.date === "2029-12-29").count, 1);
    assert.equal(s.attemptsPerDay.reduce((n: number, d: Json) => n + d.count, 0), 3);
    assert.deepEqual(s.topExams, [{ examId, title: "Análisis: Parcial 1", attempts: 3 }]);
    assert.deepEqual(s.recentAttempts.map((a: Json) => a.studentEmail), ["tres@example.com", "dos@example.com", "uno@example.com"]);
    assert.deepEqual(s.recentAttempts.map((a: Json) => [a.status, a.scorePercent, a.passed]), [["in_progress", null, null], ["submitted", 50, false], ["submitted", 100, true]]);
    assert.equal(s.recentAttempts[0].examTitle, "Análisis: Parcial 1");
    for (const key of ["id", "studentName", "examId", "grade", "scale", "startedAt", "submittedAt"]) assert.ok(key in s.recentAttempts[0], key);

  });

  test("teacher stats are scoped to their own content", async () => {
    const other = await env.makeUser(admin, "otro-profe@example.com", "teacher");
    const own = json(await env.call("GET", "/api/admin/stats", { cookie: teacher }));
    assert.equal(own.scope, "own");
    assert.equal(own.counts.attempts.total, 3);
    assert.equal(own.counts.students, 3);
    assert.equal(own.counts.exams.total, 1);
    const none = json(await env.call("GET", "/api/admin/stats", { cookie: other }));
    assert.equal(none.counts.attempts.total, 0);
    assert.equal(none.counts.exercises.total, 0);
    assert.equal(none.averageGradePercent, null);
    assert.deepEqual(none.topExams, []);
  });

  test("exam analytics: distribution, per-exercise stats and per-student table", async () => {
    const a = json(await env.call("GET", `/api/admin/exams/${examId}/analytics`, { cookie: teacher }));
    assert.deepEqual(a.exam, { id: examId, title: "Análisis: Parcial 1", scale: 20, passPercent: 60 });
    assert.deepEqual([a.attemptsCount, a.finishedCount, a.inProgressCount, a.uniqueStudents], [3, 2, 1, 3]);
    assert.equal(a.averagePercent, 75);
    assert.equal(a.passRate, 50);
    assert.equal(a.averageCompletionSeconds, 210);
    assert.equal(a.distribution.length, 10);
    assert.deepEqual(a.distribution[0], { from: 0, to: 10, count: 0 });
    assert.deepEqual(a.distribution[9], { from: 90, to: 100, count: 1 }, "100% lands in the last bucket");
    assert.deepEqual(a.distribution[5], { from: 50, to: 60, count: 1 });
    assert.equal(a.distribution.reduce((n: number, d: Json) => n + d.count, 0), 2);

    assert.deepEqual(a.exercises.map((e: Json) => [e.title, e.timesDrawn, e.gradedCount, e.averagePercent, e.fullMarksShare]), [
      ["Ejercicio 1", 3, 2, 100, 100],
      ["Ejercicio 2", 3, 2, 50, 50],
    ]);
    assert.deepEqual(a.students.map((s: Json) => [s.name, s.attemptsUsed, s.bestGrade, s.bestPercent, s.passed]), [
      [names.s1, 1, 20, 100, true],
      [names.s2, 1, 10, 50, false],
      [names.s3, 1, null, null, null],
    ]);
    assert.ok(a.students[0].lastAttemptAt && a.students[0].email === "uno@example.com" && a.students[0].userId);

    // Admin can read it too; another teacher gets 404.
    assert.equal((await env.call("GET", `/api/admin/exams/${examId}/analytics`, { cookie: admin })).statusCode, 200);
    const other = await env.login("otro-profe@example.com", "secret-123");
    assert.equal((await env.call("GET", `/api/admin/exams/${examId}/analytics`, { cookie: other })).statusCode, 404);
    assert.equal((await env.call("GET", "/api/admin/exams/00000000-0000-4000-8000-000000000000/analytics", { cookie: admin })).statusCode, 404);
    // An exam without attempts has an empty but well-formed analytics document.
    const blank = json(await env.call("POST", "/api/admin/exams", { cookie: teacher, payload: { title: "Sin intentos", durationMinutes: 5 } }));
    const empty = json(await env.call("GET", `/api/admin/exams/${blank.id}/analytics`, { cookie: teacher }));
    assert.deepEqual([empty.attemptsCount, empty.averagePercent, empty.passRate, empty.averageCompletionSeconds, empty.exercises, empty.students], [0, null, null, null, [], []]);
    assert.equal(empty.distribution.length, 10);
  });

  test("results.csv: UTF-8 BOM, ';' delimiter, Spanish header, escaping, scoping", async () => {
    const r = await env.call("GET", `/api/admin/results.csv?examId=${examId}`, { cookie: teacher });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers["content-type"]), /^text\/csv; charset=utf-8/);
    assert.match(String(r.headers["content-disposition"]), /^attachment; filename="resultados\.csv"$/);
    const body = r.body;
    assert.equal(body.charCodeAt(0), 0xfeff, "starts with a BOM");
    const lines = body.slice(1).split("\r\n");
    assert.equal(lines[0], "Estudiante;Correo;Examen;Intento;Estado;Porcentaje;Nota;Escala;Aprobado;Inicio;Entrega");
    assert.equal(lines.at(-1), "", "ends with a line break");
    const rows = lines.slice(1, -1);
    assert.equal(rows.length, 3);
    const byEmail = (email: string) => rows.find((l) => l.includes(email))!;
    assert.equal(byEmail("uno@example.com").startsWith('"Pérez; Ana ""la"" Mejor";uno@example.com;Análisis: Parcial 1;1;Enviado;100;20;20;Sí;'), true, byEmail("uno@example.com"));
    assert.ok(byEmail("dos@example.com").startsWith("\"'=HYPERLINK(\"\"x\"\";\"\"y\"\")\";dos@example.com;"), "formula injection is neutralised");
    assert.ok(byEmail("dos@example.com").includes(";Enviado;50;10;20;No;"));
    assert.ok(byEmail("tres@example.com").includes(";En curso;;;20;;"), "running attempt: empty percent, grade and result");
    for (const row of rows) assert.equal(row.split(";").length >= 11, true);

    const perExam = await env.call("GET", `/api/admin/exams/${examId}/results.csv`, { cookie: admin });
    assert.equal(perExam.statusCode, 200);
    assert.match(String(perExam.headers["content-disposition"]), /filename="resultados-analisis-parcial-1\.csv"/);
    assert.equal(perExam.body, body, "same data as the filtered results export");
    assert.equal((await env.call("GET", "/api/admin/results.csv", { cookie: admin })).body, body);
    const other = await env.login("otro-profe@example.com", "secret-123");
    const scoped = await env.call("GET", "/api/admin/results.csv", { cookie: other });
    assert.equal(scoped.body, "﻿Estudiante;Correo;Examen;Intento;Estado;Porcentaje;Nota;Escala;Aprobado;Inicio;Entrega\r\n");
    assert.equal((await env.call("GET", `/api/admin/exams/${examId}/results.csv`, { cookie: other })).statusCode, 404);
    assert.equal((await env.call("GET", "/api/admin/results.csv?examId=nope", { cookie: admin })).statusCode, 400);
    const userId = json(await env.call("GET", "/api/admin/results", { cookie: admin })).attempts.find((a: Json) => a.userEmail === "uno@example.com").userId;
    const filtered = (await env.call("GET", `/api/admin/results.csv?userId=${userId}`, { cookie: admin })).body.split("\r\n").filter(Boolean);
    assert.equal(filtered.length, 2, "header + the one attempt of that student");
  });

  test("attempt detail includes block titles; admin results items gain passed/passPercent", async () => {
    const results = json(await env.call("GET", `/api/admin/results?examId=${examId}`, { cookie: teacher }));
    assert.equal(results.attempts.length, 3);
    const item = results.attempts.find((a: Json) => a.userEmail === "dos@example.com");
    assert.deepEqual([item.passPercent, item.passed, item.scorePercent], [60, false, 50]);
    const detail = json(await env.call("GET", `/api/admin/attempts/${item.id}`, { cookie: teacher }));
    assert.ok(detail.answers.every((x: Json) => x.block === "Ejercicios"));
    assert.equal(detail.answers.length, 2);
  });
  test("the 7 and 30 day windows move with the clock (runs last: it expires the running attempt)", async () => {
    // The window moves with the clock: ten days later only the 30-day window still sees everything.
    env.clock.now += 10 * DAY;
    const later = json(await env.call("GET", "/api/admin/stats", { cookie: admin }));
    assert.equal(later.counts.attempts.last7Days, 0);
    assert.equal(later.counts.attempts.last30Days, 3);
  });
});

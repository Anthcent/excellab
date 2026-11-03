import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, createTestEnv, type TestEnv } from "./helpers.js";

type Json = Record<string, any>;

const minutes = (n: number) => n * 60_000;

/** Exercise n: type in A1 a formula that doubles B1 (= n). Full marks need the PRODUCTO function. */
const exerciseBody = (n: number, overrides: Json = {}) => ({
  title: `Ejercicio ${n}`,
  instructions: `Duplica el valor de B1 (ejercicio ${n}).`,
  points: 10,
  workbook: { name: "Libro1", sheets: [{ name: "Hoja1", cells: { B1: { v: String(n) } }, colW: {} }] },
  checks: [
    { type: "cell_value", cell: "A1", expected: n * 2, requireFormula: true, points: 6, label: "Valor correcto" },
    { type: "cell_formula_uses", cell: "A1", functions: ["PRODUCTO"], points: 4, label: "Usa PRODUCTO" },
  ],
  ...overrides,
});

/** Student answer for exercise n. */
const answer = (n: number, formula: string) => ({
  name: "Libro1",
  sheets: [{ name: "Hoja1", cells: { B1: { v: String(n) }, A1: { v: formula } }, colW: {} }],
});

/** Exercise title -> n, so a drawn exercise can be answered without knowing the random order. */
const numberOf = (title: string) => Number(title.replace("Ejercicio ", ""));

describe("exam flow (PGlite, in memory)", () => {
  let env: TestEnv;
  let admin: string;
  let student: string;
  let exerciseIds: string[] = [];
  let examId: string;

  const createExam = async (overrides: Json = {}) => {
    const response = await env.call("POST", "/api/admin/exams", {
      cookie: admin,
      payload: {
        title: "Examen de prueba",
        instructions: "Lee con atención.",
        durationMinutes: 30,
        maxAttempts: 2,
        pickCount: 3,
        scale: 20,
        passPercent: 60,
        gradePolicy: "best",
        status: "published",
        exerciseIds,
        ...overrides,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<Json>();
  };

  const startAttempt = (cookie: string, id = examId, accepted: unknown = true) =>
    env.call("POST", `/api/exams/${id}/attempts`, { cookie, payload: { accepted } });

  /** Answers every exercise of an attempt view; returns the submit responses. */
  async function answerAll(cookie: string, view: Json, formulaFor: (n: number) => string) {
    const out: Json[] = [];
    for (const ex of view.exercises as Json[]) {
      const n = numberOf(ex.title);
      const r = await env.call("POST", `/api/attempts/${view.id}/exercises/${ex.id}/submit`, { cookie, payload: { workbook: answer(n, formulaFor(n)) } });
      assert.equal(r.statusCode, 200, r.body);
      out.push(r.json<Json>());
    }
    return out;
  }

  before(async () => {
    env = await createTestEnv();
    admin = await env.login(ADMIN.email, ADMIN.password);
    student = await env.register("ana@example.com", "Ana");
    for (let n = 1; n <= 5; n++) {
      const r = await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: exerciseBody(n) });
      assert.equal(r.statusCode, 201, r.body);
      exerciseIds.push(r.json<Json>().id);
    }
    examId = (await createExam()).id;
  });
  after(() => env.close());

  test("auth: me, bad login, logout", async () => {
    const me = await env.call("GET", "/api/auth/me", { cookie: student });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json<Json>().role, "student");
    assert.equal((await env.call("GET", "/api/auth/me")).statusCode, 401);
    const bad = await env.call("POST", "/api/auth/login", { payload: { email: "ana@example.com", password: "wrong-password" } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json<Json>().error.code, "INVALID_CREDENTIALS");
    const dup = await env.call("POST", "/api/auth/register", { payload: { name: "X", email: "ANA@example.com", password: "secret-123" } });
    assert.equal(dup.statusCode, 409);
  });

  test("exam list and detail show rules but not the exercises", async () => {
    const list = (await env.call("GET", "/api/exams", { cookie: student })).json<Json[]>();
    const exam = list.find((e) => e.id === examId)!;
    assert.equal(exam.attemptsRemaining, 2);
    assert.equal(exam.exerciseCount, 3);
    assert.equal(exam.scale, 20);
    const detail = (await env.call("GET", `/api/exams/${examId}`, { cookie: student })).json<Json>();
    assert.equal(detail.instructions, "Lee con atención.");
    assert.equal("exercises" in detail, false);
    assert.equal((await env.call("GET", "/api/exams")).statusCode, 401);
  });

  test("full flow: accept, start, draft, submit, finish, results (no answer leakage)", async () => {
    // Needs the accept checkbox.
    const noAccept = await startAttempt(student, examId, false);
    assert.equal(noAccept.statusCode, 400);
    assert.equal(noAccept.json<Json>().error.code, "INSTRUCTIONS_NOT_ACCEPTED");
    assert.equal((await env.call("POST", `/api/exams/${examId}/attempts`, { cookie: student, payload: {} })).statusCode, 400);

    const started = await startAttempt(student);
    assert.equal(started.statusCode, 201, started.body);
    const view = started.json<Json>();
    assert.equal(view.number, 1);
    assert.equal(view.status, "in_progress");
    assert.equal(view.exercises.length, 3);
    assert.ok(new Date(view.deadlineAt).getTime() - new Date(view.startedAt).getTime() === minutes(30));
    assert.equal(view.serverNow, new Date(env.clock.now).toISOString());

    // Starting again returns the running attempt instead of creating another.
    const again = await startAttempt(student);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json<Json>().id, view.id);
    assert.equal(again.json<Json>().resumed, true);

    const leaks = (body: string) => {
      assert.ok(!/"checks"|"expected"|"requireFormula"|tolerance/.test(body), `answer data leaked: ${body.slice(0, 300)}`);
    };
    leaks(started.body);

    const [first, second, third] = view.exercises as Json[];
    const n1 = numberOf(first.title);
    const n2 = numberOf(second.title);
    const n3 = numberOf(third.title);

    // Draft is stored and returned on the next read.
    const draft = await env.call("PUT", `/api/attempts/${view.id}/exercises/${first.id}/draft`, { cookie: student, payload: { workbook: answer(n1, "=B1*2") } });
    assert.equal(draft.statusCode, 200, draft.body);
    const reread = (await env.call("GET", `/api/attempts/${view.id}`, { cookie: student })).json<Json>();
    assert.equal(reread.exercises[0].workbook.sheets[0].cells.A1.v, "=B1*2");
    leaks(JSON.stringify(reread));

    // Submit: graded immediately, locked afterwards.
    const s1 = await env.call("POST", `/api/attempts/${view.id}/exercises/${first.id}/submit`, { cookie: student, payload: { workbook: answer(n1, `=PRODUCTO(B1,2)`) } });
    assert.equal(s1.statusCode, 200, s1.body);
    leaks(s1.body);
    assert.equal(s1.json<Json>().score, 10);
    assert.deepEqual(s1.json<Json>().results.map((r: Json) => r.passed), [true, true]);
    assert.equal(s1.json<Json>().progress.submitted, 1);

    const resubmit = await env.call("POST", `/api/attempts/${view.id}/exercises/${first.id}/submit`, { cookie: student, payload: { workbook: answer(n1, "=1") } });
    assert.equal(resubmit.statusCode, 409);
    assert.equal(resubmit.json<Json>().error.code, "EXERCISE_ALREADY_SUBMITTED");
    const lateDraft = await env.call("PUT", `/api/attempts/${view.id}/exercises/${first.id}/draft`, { cookie: student, payload: { workbook: answer(n1, "=1") } });
    assert.equal(lateDraft.statusCode, 409);

    // Correct value, wrong function: 6 of 10.
    const s2 = await env.call("POST", `/api/attempts/${view.id}/exercises/${second.id}/submit`, { cookie: student, payload: { workbook: answer(n2, "=B1*2") } });
    assert.equal(s2.json<Json>().score, 6);
    assert.deepEqual(s2.json<Json>().results.map((r: Json) => r.passed), [true, false]);

    // The third exercise is only a saved draft: finishing grades it.
    await env.call("PUT", `/api/attempts/${view.id}/exercises/${third.id}/draft`, { cookie: student, payload: { workbook: answer(n3, "=PRODUCTO(B1,2)") } });

    const finished = await env.call("POST", `/api/attempts/${view.id}/finish`, { cookie: student });
    assert.equal(finished.statusCode, 200, finished.body);
    leaks(finished.body);
    const result = finished.json<Json>();
    assert.equal(result.status, "submitted");
    assert.equal(result.scorePercent, 86.67); // 26 / 30
    assert.equal(result.grade, 17.33); // on a 20 scale
    assert.equal(result.passed, true);
    assert.ok(result.exercises.every((e: Json) => e.submitted));

    // Finishing twice is harmless.
    assert.equal((await env.call("POST", `/api/attempts/${view.id}/finish`, { cookie: student })).statusCode, 200);

    const results = (await env.call("GET", "/api/me/results", { cookie: student })).json<Json[]>();
    assert.equal(results.length, 1);
    assert.equal(results[0]!.result.grade, 17.33);
    assert.equal(results[0]!.attemptsUsed, 1);
    leaks(JSON.stringify(results));

    // Another student cannot read this attempt.
    const other = await env.register("otro@example.com");
    assert.equal((await env.call("GET", `/api/attempts/${view.id}`, { cookie: other })).statusCode, 404);
    assert.equal((await env.call("POST", `/api/attempts/${view.id}/finish`, { cookie: other })).statusCode, 404);

    // Attempt 2 prefers exercises not seen before: both unseen ones must be drawn.
    const seen1 = new Set((view.exercises as Json[]).map((e) => e.id));
    const unseen = exerciseIds.filter((id) => !seen1.has(id));
    const second_ = await startAttempt(student);
    assert.equal(second_.statusCode, 201);
    const v2 = second_.json<Json>();
    assert.equal(v2.number, 2);
    const drawn2 = (v2.exercises as Json[]).map((e) => e.id);
    for (const id of unseen) assert.ok(drawn2.includes(id), "unseen exercise should be drawn first");

    // A bad attempt scores 0; the best grade is kept (policy 'best').
    const f2 = (await env.call("POST", `/api/attempts/${v2.id}/finish`, { cookie: student })).json<Json>();
    assert.equal(f2.grade, 0);
    const best = (await env.call("GET", "/api/me/results", { cookie: student })).json<Json[]>()[0]!;
    assert.equal(best.result.grade, 17.33);
    assert.equal(best.result.attemptNumber, 1);

    // Third attempt is refused.
    const third_ = await startAttempt(student);
    assert.equal(third_.statusCode, 409);
    assert.equal(third_.json<Json>().error.code, "NO_ATTEMPTS_LEFT");
    const card = (await env.call("GET", "/api/exams", { cookie: student })).json<Json[]>().find((e) => e.id === examId)!;
    assert.equal(card.attemptsRemaining, 0);
  });

  test("grade policy 'last' uses the most recent attempt", async () => {
    const exam = await createExam({ title: "Política last", gradePolicy: "last", pickCount: null, exerciseIds: exerciseIds.slice(0, 2) });
    const cookie = await env.register("last@example.com");
    const v1 = (await startAttempt(cookie, exam.id)).json<Json>();
    await answerAll(cookie, v1, () => "=PRODUCTO(B1,2)");
    assert.equal((await env.call("POST", `/api/attempts/${v1.id}/finish`, { cookie })).json<Json>().grade, 20);
    const v2 = (await startAttempt(cookie, exam.id)).json<Json>();
    assert.equal((await env.call("POST", `/api/attempts/${v2.id}/finish`, { cookie })).json<Json>().grade, 0);
    const res = (await env.call("GET", "/api/me/results", { cookie })).json<Json[]>().find((r) => r.examId === exam.id)!;
    assert.equal(res.result.grade, 0);
    assert.equal(res.result.attemptNumber, 2);
  });

  test("deadline: grace period, lazy expiry grades the drafts, new attempt allowed", async () => {
    const exam = await createExam({ title: "Con reloj", pickCount: null, maxAttempts: 2, durationMinutes: 10, exerciseIds: exerciseIds.slice(0, 2) });
    const cookie = await env.register("reloj@example.com");
    const start = env.clock.now;
    const v = (await startAttempt(cookie, exam.id)).json<Json>();
    const [a, b] = v.exercises as Json[];
    await env.call("PUT", `/api/attempts/${v.id}/exercises/${a.id}/draft`, { cookie, payload: { workbook: answer(numberOf(a.title), "=PRODUCTO(B1,2)") } });

    // 3 s after the deadline is still inside the 5 s grace.
    env.clock.now = start + minutes(10) + 3_000;
    const ok = await env.call("PUT", `/api/attempts/${v.id}/exercises/${b.id}/draft`, { cookie, payload: { workbook: answer(numberOf(b.title), "=1") } });
    assert.equal(ok.statusCode, 200);

    // Past the grace: the request is rejected and the attempt is graded from the drafts.
    env.clock.now = start + minutes(10) + 6_000;
    const late = await env.call("POST", `/api/attempts/${v.id}/exercises/${b.id}/submit`, { cookie, payload: { workbook: answer(numberOf(b.title), "=PRODUCTO(B1,2)") } });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json<Json>().error.code, "ATTEMPT_EXPIRED");
    const state = (await env.call("GET", `/api/attempts/${v.id}`, { cookie })).json<Json>();
    assert.equal(state.status, "expired");
    assert.equal(state.scorePercent, 50); // first draft correct (10/10), second wrong (0/10)
    assert.equal(state.grade, 10);
    // finish on an expired attempt just returns the result.
    assert.equal((await env.call("POST", `/api/attempts/${v.id}/finish`, { cookie })).json<Json>().status, "expired");

    // The expired attempt used up attempt 1; a new one can start.
    const next = await startAttempt(cookie, exam.id);
    assert.equal(next.statusCode, 201);
    assert.equal(next.json<Json>().number, 2);
  });

  test("the periodic sweep expires attempts nobody touched", async () => {
    const exam = await createExam({ title: "Barrido", pickCount: null, durationMinutes: 5, exerciseIds: exerciseIds.slice(0, 1) });
    const cookie = await env.register("barrido@example.com");
    const v = (await startAttempt(cookie, exam.id)).json<Json>();
    env.clock.now += minutes(5) + 10_000;
    assert.ok((await env.app.sweepExpired()) >= 1);
    const { rows } = await env.db.query<{ status: string }>("SELECT status FROM attempts WHERE id = $1", [v.id]);
    assert.equal(rows[0]!.status, "expired");
  });

  test("availability window is enforced", async () => {
    const future = new Date(env.clock.now + minutes(60)).toISOString();
    const past = new Date(env.clock.now - minutes(60)).toISOString();
    const notYet = await createExam({ title: "Futuro", availableFrom: future, exerciseIds: exerciseIds.slice(0, 1) });
    const closed = await createExam({ title: "Cerrado", availableUntil: past, exerciseIds: exerciseIds.slice(0, 1) });
    const cookie = await env.register("ventana@example.com");
    assert.equal((await startAttempt(cookie, notYet.id)).json<Json>().error.code, "EXAM_NOT_OPEN");
    assert.equal((await startAttempt(cookie, closed.id)).json<Json>().error.code, "EXAM_CLOSED");
  });

  test("draft exams are hidden from students", async () => {
    const draft = await createExam({ title: "Borrador", status: "draft", exerciseIds: exerciseIds.slice(0, 1) });
    const list = (await env.call("GET", "/api/exams", { cookie: student })).json<Json[]>();
    assert.ok(!list.some((e) => e.id === draft.id));
    assert.equal((await startAttempt(student, draft.id)).statusCode, 404);
  });

  test("invalid or oversized workbooks are rejected", async () => {
    const exam = await createExam({ title: "Validación", pickCount: null, exerciseIds: exerciseIds.slice(0, 1) });
    const cookie = await env.register("valida@example.com");
    const v = (await startAttempt(cookie, exam.id)).json<Json>();
    const ex = v.exercises[0];
    const url = `/api/attempts/${v.id}/exercises/${ex.id}/draft`;
    assert.equal((await env.call("PUT", url, { cookie, payload: { workbook: "nope" } })).json<Json>().error.code, "INVALID_WORKBOOK");
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`A${i + 1}`, { v: "x" }]));
    const tooMany = { name: "L", sheets: Array.from({ length: 60 }, (_, i) => ({ name: `H${i}`, cells: many, colW: {} })) };
    assert.equal((await env.call("PUT", url, { cookie, payload: { workbook: tooMany } })).statusCode, 400);
    const huge = { name: "L", sheets: [{ name: "H", cells: { A1: { v: "x".repeat(1_100_000) } }, colW: {} }] };
    assert.equal((await env.call("PUT", url, { cookie, payload: { workbook: huge } })).statusCode, 413);
    // A client cannot smuggle a cached value: only raw cell content is graded.
    const spoof = { name: "L", sheets: [{ name: "Hoja1", cells: { A1: { v: "1", cached: 2, value: 2 } }, colW: {} }] };
    assert.equal((await env.call("PUT", url, { cookie, payload: { workbook: spoof } })).statusCode, 200);
  });

  test("heavy workbooks are bounded: the check fails quickly instead of hanging", async () => {
    const cells: Json = {};
    for (let r = 1; r <= 200; r++) for (const col of ["A", "B", "C", "D", "E"]) cells[`${col}${r}`] = { v: String(r) };
    const heavy: Json = {};
    for (let r = 1; r <= 200; r++) for (let c = 1; c <= 25; c++) heavy[`${String.fromCharCode(65 + c)}${r}`] = { v: "=SUMAPRODUCTO(Datos!$A$1:$E$200,Datos!$A$1:$E$200)+SUMAPRODUCTO(Datos!$A$1:$E$200,Datos!$A$1:$E$200)" };
    const workbook = { name: "L", sheets: [{ name: "Hoja1", cells: heavy, colW: {} }, { name: "Datos", cells, colW: {} }] };
    const created = await env.call("POST", "/api/admin/exercises", {
      cookie: admin,
      payload: exerciseBody(9, { workbook, checks: [{ type: "cell_value", cell: "Z200", expected: 1, points: 1 }] }),
    });
    const started = Date.now();
    const preview = await env.call("POST", `/api/admin/exercises/${created.json<Json>().id}/preview-grade`, { cookie: admin, payload: { workbook } });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json<Json>().score, 0);
    assert.ok(Date.now() - started < 8_000, "grading must be time bounded");
  });
});

describe("staff modules and permissions", () => {
  let env: TestEnv;
  let admin: string;
  let student: string;

  before(async () => {
    env = await createTestEnv();
    admin = await env.login(ADMIN.email, ADMIN.password);
    student = await env.register("alumno@example.com");
  });
  after(() => env.close());

  test("non-admins cannot reach /api/admin/*", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const routes: [("GET" | "POST" | "PUT" | "DELETE"), string][] = [
      ["GET", "/api/admin/exercises"],
      ["POST", "/api/admin/exercises"],
      ["GET", `/api/admin/exercises/${id}`],
      ["PUT", `/api/admin/exercises/${id}`],
      ["DELETE", `/api/admin/exercises/${id}`],
      ["POST", `/api/admin/exercises/${id}/preview-grade`],
      ["GET", "/api/admin/exams"],
      ["POST", "/api/admin/exams"],
      ["PUT", `/api/admin/exams/${id}`],
      ["PUT", `/api/admin/exams/${id}/exercises`],
      ["DELETE", `/api/admin/exams/${id}`],
      ["GET", "/api/admin/results"],
      ["GET", `/api/admin/attempts/${id}`],
    ];
    for (const [method, url] of routes) {
      const anon = await env.call(method, url, { payload: {} });
      assert.equal(anon.statusCode, 401, `${method} ${url} anonymous`);
      const forbidden = await env.call(method, url, { cookie: student, payload: {} });
      assert.equal(forbidden.statusCode, 403, `${method} ${url} as student`);
      assert.equal(forbidden.json<Json>().error.code, "FORBIDDEN");
    }
    assert.equal((await env.call("GET", "/api/admin/exams", { cookie: admin })).statusCode, 200);
  });

  test("cross-site requests are rejected", async () => {
    const r = await env.call("POST", "/api/auth/logout", { cookie: student, headers: { origin: "https://evil.example" } });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json<Json>().error.code, "BAD_ORIGIN");
    const same = await env.call("POST", "/api/auth/login", { headers: { origin: "http://localhost:3000", host: "localhost:3000" }, payload: { email: "x@x.co", password: "bad" } });
    assert.equal(same.statusCode, 401);
  });

  test("exercise authoring: validation, preview-grade, update and delete guard", async () => {
    // Published exercises need checks; unknown check types are rejected.
    assert.equal((await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: { ...exerciseBody(1), checks: [] } })).json<Json>().error.code, "NO_CHECKS");
    assert.equal((await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: { ...exerciseBody(1), checks: [{ type: "magic" }] } })).statusCode, 400);

    const created = await env.call("POST", "/api/admin/exercises", {
      cookie: admin,
      payload: exerciseBody(4, {
        checks: [
          { type: "cell_value", cell: "A1", expected: "HOLA", ignoreCase: true, points: 2 },
          { type: "cell_value", cell: "A2", expected: 3.14, tolerance: 0.01, points: 2 },
          { type: "range_values", range: "C1:C2", expected: [[1], [2]], points: 4 },
          { type: "cell_formula_uses", cell: "A3", functions: ["SI", "BUSCARV"], points: 2 },
        ],
      }),
    });
    assert.equal(created.statusCode, 201, created.body);
    const ex = created.json<Json>();
    assert.equal(ex.checks.length, 4);

    const workbook = {
      name: "L",
      sheets: [{ name: "Hoja1", cells: { A1: { v: "hola" }, A2: { v: "3.145" }, C1: { v: "1" }, C2: { v: "=1+1" }, A3: { v: '=SI(1=1,BUSCARV(1,C1:C2,1,FALSO),0)' } }, colW: {} }],
    };
    const preview = (await env.call("POST", `/api/admin/exercises/${ex.id}/preview-grade`, { cookie: admin, payload: { workbook } })).json<Json>();
    assert.equal(preview.score, 10);
    assert.ok(preview.results.every((r: Json) => r.passed));
    const partial = (await env.call("POST", `/api/admin/exercises/${ex.id}/preview-grade`, { cookie: admin, payload: { workbook: { ...workbook, sheets: [{ ...workbook.sheets[0], cells: { ...workbook.sheets[0]!.cells, A2: { v: "3.2" } } }] } } })).json<Json>();
    assert.equal(partial.score, 8);
    // Check points that do not add up to the exercise points are scaled proportionally.
    const scaled = (await env.call("POST", `/api/admin/exercises/${ex.id}/preview-grade`, { cookie: admin, payload: { workbook, points: 20 } })).json<Json>();
    assert.equal(scaled.score, 20);

    const updated = await env.call("PUT", `/api/admin/exercises/${ex.id}`, { cookie: admin, payload: { title: "Renombrado", points: 5 } });
    assert.equal(updated.json<Json>().title, "Renombrado");
    assert.equal(updated.json<Json>().checks.length, 4);
    assert.equal((await env.call("GET", "/api/admin/exercises", { cookie: admin })).json<Json[]>().length >= 1, true);
  });

  test("exams: ordering, publish rules and delete guards when attempts exist", async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: exerciseBody(n) })).json<Json>().id);

    const empty = await env.call("POST", "/api/admin/exams", { cookie: admin, payload: { title: "Vacío", durationMinutes: 10, status: "published" } });
    assert.equal(empty.json<Json>().error.code, "EXAM_EMPTY");

    const exam = (await env.call("POST", "/api/admin/exams", { cookie: admin, payload: { title: "Orden", durationMinutes: 10 } })).json<Json>();
    assert.equal(exam.status, "draft");
    assert.equal(exam.maxAttempts, 2);
    assert.equal(exam.scale, 20);
    assert.equal(exam.passPercent, 60);
    assert.equal(exam.gradePolicy, "best");

    const ordered = (await env.call("PUT", `/api/admin/exams/${exam.id}/exercises`, { cookie: admin, payload: { exerciseIds: [ids[2], ids[0], ids[1]] } })).json<Json>();
    assert.deepEqual(ordered.exercises.map((e: Json) => e.id), [ids[2], ids[0], ids[1]]);
    assert.equal((await env.call("PUT", `/api/admin/exams/${exam.id}/exercises`, { cookie: admin, payload: { exerciseIds: [ids[0], ids[0]] } })).statusCode, 400);
    assert.equal((await env.call("PUT", `/api/admin/exams/${exam.id}/exercises`, { cookie: admin, payload: { exerciseIds: ["00000000-0000-4000-8000-000000000000"] } })).statusCode, 400);

    const published = await env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: admin, payload: { status: "published", scale: 100, pickCount: 2 } });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json<Json>().scale, 100);

    // A student attempt makes the exam and the drawn exercises undeletable.
    const sc = await env.register("borrar@example.com");
    const v = (await env.call("POST", `/api/exams/${exam.id}/attempts`, { cookie: sc, payload: { accepted: true } })).json<Json>();
    assert.equal(v.exercises.length, 2);
    const drawnId = v.exercises[0].id;
    assert.equal((await env.call("DELETE", `/api/admin/exams/${exam.id}`, { cookie: admin })).statusCode, 409);
    const delEx = await env.call("DELETE", `/api/admin/exercises/${drawnId}`, { cookie: admin });
    assert.equal(delEx.statusCode, 409);
    assert.equal(delEx.json<Json>().error.code, "EXERCISE_IN_USE");

    // Results views for staff.
    await env.call("POST", `/api/attempts/${v.id}/finish`, { cookie: sc });
    const results = (await env.call("GET", `/api/admin/results?examId=${exam.id}`, { cookie: admin })).json<Json>();
    assert.equal(results.attempts.length, 1);
    assert.equal(results.summary[0].userEmail, "borrar@example.com");
    assert.equal(results.summary[0].result.grade, 0);
    const detail = (await env.call("GET", `/api/admin/attempts/${v.id}`, { cookie: admin })).json<Json>();
    assert.equal(detail.answers.length, 2);
    assert.ok(Array.isArray(detail.answers[0].details));
    assert.equal(detail.answers[0].details[0].type, "cell_value");
    assert.equal((await env.call("GET", `/api/admin/results?userId=${v.id}`, { cookie: admin })).json<Json>().attempts.length, 0);

    // Unused exam/exercise can be deleted.
    const spare = (await env.call("POST", "/api/admin/exams", { cookie: admin, payload: { title: "Sobrante", durationMinutes: 5 } })).json<Json>();
    assert.equal((await env.call("DELETE", `/api/admin/exams/${spare.id}`, { cookie: admin })).statusCode, 204);
  });

  test("login throttle blocks the sixth failed attempt in a minute", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await env.call("POST", "/api/auth/login", { payload: { email: "throttle@example.com", password: "nope-nope" } })).statusCode);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  });
});

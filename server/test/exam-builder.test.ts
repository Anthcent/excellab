import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, CORRECT, answer, createTestEnv, exerciseBody, numberOf, type Json, type TestEnv } from "./helpers.js";

const minutes = (n: number) => n * 60_000;

/** Shared fixture: an admin, a teacher, and ten published exercises ("Ejercicio 1".."Ejercicio 10"). */
async function fixture() {
  const env = await createTestEnv();
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const teacher = await env.makeUser(admin, "profe@example.com", "teacher", "Profe");
  const ex: string[] = []; // ex[n] is the id of "Ejercicio n"
  ex[0] = "";
  for (let n = 1; n <= 10; n++) {
    const r = await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: exerciseBody(n) });
    assert.equal(r.statusCode, 201, r.body);
    ex[n] = r.json<Json>().id;
  }
  return { env, admin, teacher, ex };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const blockOf = (title: string, nums: number[], ex: string[], rest: Json = {}) => ({
  title,
  shuffle: true,
  pickCount: null,
  exercises: nums.map((n) => ({ exerciseId: ex[n] })),
  ...rest,
});

describe("exam blocks", () => {
  let f: Fixture;
  before(async () => {
    f = await fixture();
  });
  after(() => f.env.close());

  const createExam = async (overrides: Json = {}, cookie = f.admin) => {
    const r = await f.env.call("POST", "/api/admin/exams", { cookie, payload: { title: "Examen por bloques", durationMinutes: 30, maxAttempts: 5, ...overrides } });
    assert.equal(r.statusCode, 201, r.body);
    return r.json<Json>();
  };
  const putBlocks = (examId: string, blocks: Json[], cookie = f.admin) => f.env.call("PUT", `/api/admin/exams/${examId}/blocks`, { cookie, payload: { blocks } });
  const start = (cookie: string, examId: string, body: Json = { accepted: true }) => f.env.call("POST", `/api/exams/${examId}/attempts`, { cookie, payload: body });

  test("PUT blocks replaces the structure and GET returns blocks with exercise summaries", async () => {
    const exam = await createExam();
    const saved = await putBlocks(exam.id, [
      blockOf("Básicas", [1, 2, 3], f.ex, { pickCount: 2 }),
      blockOf("Avanzadas", [4, 5], f.ex, { shuffle: false, exercises: [{ exerciseId: f.ex[4] }, { exerciseId: f.ex[5], pointsOverride: 20 }] }),
    ]);
    assert.equal(saved.statusCode, 200, saved.body);
    const body = saved.json<Json>();
    assert.equal(body.blocks.length, 2);
    assert.deepEqual(body.blocks.map((b: Json) => [b.title, b.position, b.pickCount, b.shuffle]), [["Básicas", 0, 2, true], ["Avanzadas", 1, null, false]]);
    assert.deepEqual(body.blocks[0].exercises.map((e: Json) => e.title), ["Ejercicio 1", "Ejercicio 2", "Ejercicio 3"]);
    const override = body.blocks[1].exercises[1];
    assert.deepEqual([override.points, override.pointsOverride, override.effectivePoints, override.status], [10, 20, 20, "published"]);
    assert.equal(body.exerciseCount, 5);
    assert.equal(body.exercises.length, 5, "flat list kept for the old API shape");
    assert.equal(body.pickCount, null, "deprecated exam-level pick_count only mirrors single-block exams");

    const read = (await f.env.call("GET", `/api/admin/exams/${exam.id}`, { cookie: f.admin })).json<Json>();
    assert.deepEqual(read.blocks, body.blocks);

    // Re-saving with the block ids keeps them; removing a block drops it.
    const again = (await putBlocks(exam.id, [{ ...blockOf("Básicas", [1, 2, 3], f.ex), id: body.blocks[0].id }])).json<Json>();
    assert.equal(again.blocks.length, 1);
    assert.equal(again.blocks[0].id, body.blocks[0].id);
    assert.equal(again.pickCount, null);
  });

  test("block validation: duplicates, unknown exercises, pick count above the pool, limits", async () => {
    const exam = await createExam();
    const dupAcross = await putBlocks(exam.id, [blockOf("A", [1, 2], f.ex), blockOf("B", [2, 3], f.ex)]);
    assert.equal(dupAcross.json<Json>().error.code, "DUPLICATE_EXERCISES");
    const unknown = await putBlocks(exam.id, [{ title: "A", exercises: [{ exerciseId: "00000000-0000-4000-8000-000000000000" }] }]);
    assert.equal(unknown.json<Json>().error.code, "UNKNOWN_EXERCISE");
    const tooMany = await putBlocks(exam.id, [blockOf("A", [1, 2], f.ex, { pickCount: 3 })]);
    assert.equal(tooMany.json<Json>().error.code, "PICK_EXCEEDS_POOL");
    assert.equal((await putBlocks(exam.id, [blockOf("", [1], f.ex)])).statusCode, 400);
    assert.equal((await putBlocks(exam.id, [{ title: "A", exercises: [{ exerciseId: f.ex[1], pointsOverride: 0 }] }])).statusCode, 400);
    assert.equal((await putBlocks(exam.id, Array.from({ length: 21 }, (_, i) => ({ title: `B${i}`, exercises: [] })))).statusCode, 400);
    // Drafts can be used? Only published exercises can be added.
    const draft = (await f.env.call("POST", "/api/admin/exercises", { cookie: f.admin, payload: exerciseBody(11, { status: "draft", checks: [] }) })).json<Json>();
    assert.equal((await putBlocks(exam.id, [{ title: "A", exercises: [{ exerciseId: draft.id }] }])).json<Json>().error.code, "EXERCISE_NOT_PUBLISHED");
    // The failed attempts changed nothing.
    assert.equal((await f.env.call("GET", `/api/admin/exams/${exam.id}`, { cookie: f.admin })).json<Json>().blocks.length, 0);
  });

  test("publishing needs a block with a published exercise and a feasible pick count", async () => {
    const exam = await createExam();
    const empty = await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "published" } });
    assert.equal(empty.json<Json>().error.code, "EXAM_EMPTY");
    await putBlocks(exam.id, [blockOf("Vacío", [], f.ex)]);
    assert.equal((await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "published" } })).json<Json>().error.code, "EXAM_EMPTY");
    await putBlocks(exam.id, [blockOf("A", [1, 2, 3], f.ex, { pickCount: 3 })]);
    // Unpublish one exercise: the pool (2) is now smaller than the pick (3).
    const spare = (await f.env.call("POST", "/api/admin/exercises", { cookie: f.admin, payload: exerciseBody(12) })).json<Json>();
    await putBlocks(exam.id, [blockOf("A", [], f.ex, { pickCount: 2, exercises: [{ exerciseId: f.ex[1] }, { exerciseId: f.ex[2] }, { exerciseId: spare.id }] })]);
    await f.env.call("PUT", `/api/admin/exercises/${spare.id}`, { cookie: f.admin, payload: { status: "draft" } });
    const ok = await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "published" } });
    assert.equal(ok.statusCode, 200, "pool of 2 published for a pick of 2");
    await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "draft" } });
    await putBlocks(exam.id, [blockOf("A", [], f.ex, { pickCount: 3, exercises: [{ exerciseId: f.ex[1] }, { exerciseId: f.ex[2] }, { exerciseId: spare.id }] })]);
    const bad = await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "published" } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json<Json>().error.code, "PICK_EXCEEDS_POOL");
  });

  test("an exercise unpublished after the exam was published makes the draw fail clearly (409)", async () => {
    const exam = await createExam();
    const spare = (await f.env.call("POST", "/api/admin/exercises", { cookie: f.admin, payload: exerciseBody(13) })).json<Json>();
    await putBlocks(exam.id, [{ title: "Sección única", pickCount: 3, shuffle: true, exercises: [{ exerciseId: f.ex[1] }, { exerciseId: f.ex[2] }, { exerciseId: spare.id }] }]);
    assert.equal((await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "published" } })).statusCode, 200);
    await f.env.call("PUT", `/api/admin/exercises/${spare.id}`, { cookie: f.admin, payload: { status: "draft" } });
    const s = await f.env.register("pool@example.com");
    const r = await start(s, exam.id);
    assert.equal(r.statusCode, 409);
    assert.equal(r.json<Json>().error.code, "EXAM_POOL_TOO_SMALL");
    assert.match(r.json<Json>().error.message, /Sección única/);
    assert.equal((await f.env.call("POST", `/api/admin/exams/${exam.id}/draw-preview`, { cookie: f.admin, payload: {} })).json<Json>().error.code, "EXAM_POOL_TOO_SMALL");
    // No attempt was consumed.
    const card = (await f.env.call("GET", "/api/exams", { cookie: s })).json<Json[]>().find((e) => e.id === exam.id)!;
    assert.equal(card.attemptsUsed, 0);
    // A pick-all block with nothing published is skipped; with every block empty the exam is empty (409).
    await putBlocks(exam.id, [{ title: "Vacía", exercises: [{ exerciseId: spare.id }] }, blockOf("Con datos", [1], f.ex)]);
    assert.equal((await start(s, exam.id)).statusCode, 201);
  });

  test("the draw picks per block, keeps block order, titles every exercise and never repeats", async () => {
    const exam = await createExam();
    await putBlocks(exam.id, [blockOf("Básicas", [1, 2, 3, 4], f.ex, { pickCount: 2 }), blockOf("Medias", [5, 6, 7], f.ex, { pickCount: 1 }), blockOf("Finales", [8, 9], f.ex)]);
    await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "published", maxAttempts: 10 } });
    const cookie = await f.env.register("bloques@example.com");
    for (let i = 0; i < 6; i++) {
      const v = (await start(cookie, exam.id)).json<Json>();
      const titles = v.exercises.map((e: Json) => e.block);
      assert.deepEqual(titles, ["Básicas", "Básicas", "Medias", "Finales", "Finales"], "blocks in position order");
      const ns = v.exercises.map((e: Json) => numberOf(e.title));
      assert.equal(new Set(ns).size, ns.length, "no duplicates");
      assert.ok(ns.slice(0, 2).every((n: number) => n >= 1 && n <= 4));
      assert.ok(ns[2] >= 5 && ns[2] <= 7);
      assert.deepEqual([...ns.slice(3)].sort(), [8, 9]);
      await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie });
    }
    const card = (await f.env.call("GET", "/api/exams", { cookie })).json<Json[]>().find((e) => e.id === exam.id)!;
    assert.equal(card.exerciseCount, 5, "student cards count the exercises of one draw");
  });

  test("shuffle flags: a block without shuffle keeps the exercise order; shuffleBlocks reorders blocks", async () => {
    const fixed = await createExam();
    await putBlocks(fixed.id, [blockOf("Fijo", [3, 1, 2], f.ex, { shuffle: false })]);
    await f.env.call("PUT", `/api/admin/exams/${fixed.id}`, { cookie: f.admin, payload: { status: "published", maxAttempts: 20 } });
    const cookie = await f.env.register("shuffle@example.com");
    for (let i = 0; i < 4; i++) {
      const v = (await start(cookie, fixed.id)).json<Json>();
      assert.deepEqual(v.exercises.map((e: Json) => numberOf(e.title)), [3, 1, 2]);
      await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie });
    }
    const shuffled = await createExam();
    await putBlocks(shuffled.id, [blockOf("Uno", [1], f.ex), blockOf("Dos", [2], f.ex), blockOf("Tres", [3], f.ex), blockOf("Cuatro", [4], f.ex)]);
    await f.env.call("PUT", `/api/admin/exams/${shuffled.id}`, { cookie: f.admin, payload: { status: "published", shuffleBlocks: true, maxAttempts: 20 } });
    const orders = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const v = (await start(cookie, shuffled.id)).json<Json>();
      orders.add(v.exercises.map((e: Json) => e.block).join(","));
      await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie });
    }
    assert.ok(orders.size > 1, "block order varies when shuffleBlocks is on");
    // Without shuffleBlocks the order is the definition order, always.
    await f.env.call("PUT", `/api/admin/exams/${shuffled.id}`, { cookie: f.admin, payload: { shuffleBlocks: false } });
    const fixedOrder = new Set<string>();
    const cookie2 = await f.env.register("shuffle2@example.com");
    for (let i = 0; i < 5; i++) {
      const v = (await start(cookie2, shuffled.id)).json<Json>();
      fixedOrder.add(v.exercises.map((e: Json) => e.block).join(","));
      await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie: cookie2 });
    }
    assert.deepEqual([...fixedOrder], ["Uno,Dos,Tres,Cuatro"]);
  });

  test("previously seen exercises are drawn last when the block pool is larger than the pick", async () => {
    const exam = await createExam();
    await putBlocks(exam.id, [blockOf("Pool", [1, 2, 3, 4, 5, 6], f.ex, { pickCount: 3 })]);
    await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "published", maxAttempts: 2 } });
    const cookie = await f.env.register("visto@example.com");
    const first = (await start(cookie, exam.id)).json<Json>();
    await f.env.call("POST", `/api/attempts/${first.id}/finish`, { cookie });
    const second = (await start(cookie, exam.id)).json<Json>();
    const a = first.exercises.map((e: Json) => numberOf(e.title)).sort();
    const b = second.exercises.map((e: Json) => numberOf(e.title)).sort();
    assert.deepEqual([...a, ...b].sort(), [1, 2, 3, 4, 5, 6], "the second attempt got exactly the three unseen exercises");
  });

  test("draw-preview shows a sample without creating an attempt; a seed makes it reproducible", async () => {
    const exam = await createExam();
    await putBlocks(exam.id, [
      blockOf("Básicas", [1, 2, 3, 4], f.ex, { pickCount: 2 }),
      { title: "Con puntos", shuffle: false, pickCount: null, exercises: [{ exerciseId: f.ex[5], pointsOverride: 25 }] },
    ]);
    const a = await f.env.call("POST", `/api/admin/exams/${exam.id}/draw-preview`, { cookie: f.admin, payload: { seed: 42 } });
    assert.equal(a.statusCode, 200, a.body);
    const b = await f.env.call("POST", `/api/admin/exams/${exam.id}/draw-preview`, { cookie: f.admin, payload: { seed: 42 } });
    assert.deepEqual(a.json<Json>(), b.json<Json>());
    const body = a.json<Json>();
    assert.equal(body.seed, 42);
    assert.equal(body.exerciseCount, 3);
    assert.deepEqual(body.blocks.map((x: Json) => [x.title, x.pickCount, x.poolSize, x.exercises.length]), [["Básicas", 2, 4, 2], ["Con puntos", null, 1, 1]]);
    assert.equal(body.blocks[1].exercises[0].points, 25);
    assert.equal(body.totalPoints, 10 + 10 + 25);
    assert.equal(typeof body.blocks[0].exercises[0].title, "string");
    const free = (await f.env.call("POST", `/api/admin/exams/${exam.id}/draw-preview`, { cookie: f.admin })).json<Json>();
    assert.ok(Number.isInteger(free.seed) && free.seed > 0);
    const { rows } = await f.env.db.query<{ n: number }>("SELECT count(*)::int AS n FROM attempts WHERE exam_id = $1", [exam.id]);
    assert.equal(rows[0]!.n, 0, "no attempt rows");
    // Empty exam: clear error.
    const blank = await createExam();
    assert.equal((await f.env.call("POST", `/api/admin/exams/${blank.id}/draw-preview`, { cookie: f.admin, payload: {} })).json<Json>().error.code, "EXAM_EMPTY");
  });

  test("points_override scales the exercise checks and the attempt totals", async () => {
    const exam = await createExam();
    // Exercise 1 is worth 10 normally; here 30. Exercise 2 keeps 10.
    await putBlocks(exam.id, [{ title: "Pesos", shuffle: false, pickCount: null, exercises: [{ exerciseId: f.ex[1], pointsOverride: 30 }, { exerciseId: f.ex[2] }] }]);
    await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "published" } });
    const cookie = await f.env.register("puntos@example.com");
    const v = (await start(cookie, exam.id)).json<Json>();
    assert.deepEqual(v.exercises.map((e: Json) => [numberOf(e.title), e.points, e.maxScore]), [[1, 30, 30], [2, 10, 10]]);

    // Exercise 1: right value (6/10 of the checks) but not PRODUCTO -> 18 of 30.
    const s1 = (await f.env.call("POST", `/api/attempts/${v.id}/exercises/${v.exercises[0].id}/submit`, { cookie, payload: { workbook: answer(1, "=B1*2") } })).json<Json>();
    assert.equal(s1.score, 18);
    assert.equal(s1.maxScore, 30);
    assert.deepEqual(s1.results.map((r: Json) => r.points), [18, 12], "check points are rescaled proportionally to 30");
    // Exercise 2 is left as a draft with full marks: graded on finish.
    await f.env.call("PUT", `/api/attempts/${v.id}/exercises/${v.exercises[1].id}/draft`, { cookie, payload: { workbook: CORRECT(2) } });
    const done = (await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie })).json<Json>();
    assert.equal(done.scorePercent, 70); // (18 + 10) / 40
    assert.equal(done.grade, 14);
    // The override is a snapshot: changing it afterwards does not regrade or re-weight the attempt.
    await putBlocks(exam.id, [{ title: "Pesos", shuffle: false, pickCount: null, exercises: [{ exerciseId: f.ex[1] }, { exerciseId: f.ex[2] }] }]);
    const reread = (await f.env.call("GET", `/api/attempts/${v.id}`, { cookie })).json<Json>();
    assert.equal(reread.exercises[0].points, 30);
    assert.equal(reread.scorePercent, 70);
    const detail = (await f.env.call("GET", `/api/admin/attempts/${v.id}`, { cookie: f.admin })).json<Json>();
    assert.deepEqual(detail.answers.map((a: Json) => [a.block, a.points, a.maxScore, a.score]), [["Pesos", 30, 30, 18], ["Pesos", 10, 10, 10]]);
  });

  test("legacy flat-pool API writes one default block (and keeps working)", async () => {
    const exam = await createExam({ pickCount: 2 });
    const r = await f.env.call("PUT", `/api/admin/exams/${exam.id}/exercises`, { cookie: f.admin, payload: { exerciseIds: [f.ex[3], f.ex[1], f.ex[2]] } });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json<Json>();
    assert.equal(body.blocks.length, 1);
    assert.equal(body.blocks[0].title, "Ejercicios");
    assert.equal(body.blocks[0].pickCount, 2, "the exam-level pick count seeds the default block");
    assert.deepEqual(body.exercises.map((e: Json) => numberOf(e.title)), [3, 1, 2]);
    // Setting pickCount on the exam updates the single block; one that covers the pool means "all".
    const p = (await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { pickCount: 5 } })).json<Json>();
    assert.equal(p.blocks[0].pickCount, null);
    // Replacing the structure again collapses to one block and keeps title/shuffle of the first one.
    await putBlocks(exam.id, [blockOf("Teoría", [1], f.ex, { shuffle: false }), blockOf("Práctica", [2], f.ex)]);
    const collapsed = (await f.env.call("PUT", `/api/admin/exams/${exam.id}/exercises`, { cookie: f.admin, payload: { exerciseIds: [f.ex[2], f.ex[1]] } })).json<Json>();
    assert.equal(collapsed.blocks.length, 1);
    assert.equal(collapsed.blocks[0].title, "Teoría");
    assert.equal(collapsed.blocks[0].shuffle, false);
    assert.deepEqual(collapsed.exercises.map((e: Json) => numberOf(e.title)), [2, 1]);
    assert.equal((await f.env.call("PUT", `/api/admin/exams/${exam.id}/exercises`, { cookie: f.admin, payload: { exerciseIds: [] } })).json<Json>().blocks.length, 0);
  });

  test("duplicate: copies settings and blocks as a draft owned by the caller, without code or access list", async () => {
    const exam = await createExam({
      title: "Original",
      description: "Resumen corto",
      feedbackMode: "score",
      resultMode: "after_close",
      allowReview: true,
      shuffleBlocks: true,
      accessCode: "SECRETO",
      restricted: true,
      scale: 100,
      passPercent: 50,
    });
    await putBlocks(exam.id, [blockOf("Uno", [1, 2], f.ex, { pickCount: 1 }), { title: "Dos", shuffle: false, pickCount: null, exercises: [{ exerciseId: f.ex[3], pointsOverride: 7 }] }]);
    await f.env.call("PUT", `/api/admin/exams/${exam.id}/access`, { cookie: f.admin, payload: { emails: [] } });
    await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { status: "published" } });
    const copy = await f.env.call("POST", `/api/admin/exams/${exam.id}/duplicate`, { cookie: f.admin });
    assert.equal(copy.statusCode, 201, copy.body);
    const c = copy.json<Json>();
    assert.notEqual(c.id, exam.id);
    assert.equal(c.title, "Original (copia)");
    assert.equal(c.status, "draft");
    assert.equal(c.accessCode, null);
    assert.equal(c.restricted, false);
    assert.equal(c.description, "Resumen corto");
    assert.deepEqual([c.feedbackMode, c.resultMode, c.allowReview, c.shuffleBlocks, c.scale, c.passPercent], ["score", "after_close", true, true, 100, 50]);
    assert.deepEqual(c.blocks.map((b: Json) => [b.title, b.pickCount, b.shuffle, b.exercises.map((e: Json) => [numberOf(e.title), e.pointsOverride])]), [["Uno", 1, true, [[1, null], [2, null]]], ["Dos", null, false, [[3, 7]]]]);
    assert.notEqual(c.blocks[0].id, (await f.env.call("GET", `/api/admin/exams/${exam.id}`, { cookie: f.admin })).json<Json>().blocks[0].id);
    // The copy has no access list; the original keeps its code.
    assert.equal((await f.env.call("GET", `/api/admin/exams/${c.id}/access`, { cookie: f.admin })).json<Json>().entries.length, 0);
    assert.equal((await f.env.call("GET", `/api/admin/exams/${exam.id}`, { cookie: f.admin })).json<Json>().accessCode, "SECRETO");
    // A teacher duplicating their own exam becomes its owner.
    const own = (await f.env.call("POST", "/api/admin/exercises", { cookie: f.teacher, payload: exerciseBody(20) })).json<Json>();
    const tExam = (await f.env.call("POST", "/api/admin/exams", { cookie: f.teacher, payload: { title: "Del profe", durationMinutes: 5, exerciseIds: [own.id] } })).json<Json>();
    const tCopy = (await f.env.call("POST", `/api/admin/exams/${tExam.id}/duplicate`, { cookie: f.teacher })).json<Json>();
    assert.equal(tCopy.ownerId, tExam.ownerId);
    // An admin duplicating it becomes the owner of the copy.
    const aCopy = (await f.env.call("POST", `/api/admin/exams/${tExam.id}/duplicate`, { cookie: f.admin })).json<Json>();
    assert.notEqual(aCopy.ownerId, tExam.ownerId);
  });

  test("exam settings are validated and returned to staff", async () => {
    const exam = await createExam();
    assert.deepEqual([exam.feedbackMode, exam.resultMode, exam.allowReview, exam.shuffleBlocks, exam.restricted, exam.accessCode, exam.description], ["details", "immediate", false, false, false, null, ""]);
    for (const bad of [{ feedbackMode: "all" }, { resultMode: "never" }, { description: "x".repeat(501) }, { accessCode: "x".repeat(65) }]) {
      assert.equal((await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: bad })).statusCode, 400, JSON.stringify(bad));
    }
    const set = (await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { accessCode: "  clave1  ", description: "  hola " } })).json<Json>();
    assert.equal(set.accessCode, "clave1");
    assert.equal(set.description, "hola");
    assert.equal((await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { accessCode: "" } })).json<Json>().accessCode, null);
    const list = (await f.env.call("GET", "/api/admin/exams?page=1&pageSize=3", { cookie: f.admin })).json<Json>();
    assert.ok(list.items.length <= 3 && list.total >= list.items.length);
    assert.equal(typeof list.items[0].blockCount, "number");
    assert.equal(typeof list.items[0].accessCount, "number");
    assert.equal((await f.env.call("GET", "/api/admin/exams?q=zzzz-nothing", { cookie: f.admin })).json<Json[]>().length, 0);
  });
});

describe("exam settings enforced for students", () => {
  let f: Fixture;
  before(async () => {
    f = await fixture();
  });
  after(() => f.env.close());

  const publish = async (overrides: Json = {}, nums = [1, 2]) => {
    const r = await f.env.call("POST", "/api/admin/exams", {
      cookie: f.admin,
      payload: {
        title: "Con ajustes",
        durationMinutes: 30,
        maxAttempts: 2,
        status: "published",
        blocks: [{ title: "Único", shuffle: false, exercises: nums.map((n) => ({ exerciseId: f.ex[n] })) }],
        ...overrides,
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json<Json>();
  };
  const start = (cookie: string, examId: string, body: Json = { accepted: true }) => f.env.call("POST", `/api/exams/${examId}/attempts`, { cookie, payload: body });
  const submit = (cookie: string, v: Json, i: number, workbook: unknown) =>
    f.env.call("POST", `/api/attempts/${v.id}/exercises/${v.exercises[i].id}/submit`, { cookie, payload: { workbook } });
  const card = async (cookie: string, examId: string) => (await f.env.call("GET", "/api/exams", { cookie })).json<Json[]>().find((e) => e.id === examId)!;

  /** Student submits exercise 1 right and leaves exercise 2 to the finish. Returns the submit and the finish responses. */
  async function play(cookie: string, examId: string) {
    const v = (await start(cookie, examId)).json<Json>();
    const sub = await submit(cookie, v, 0, CORRECT(numberOf(v.exercises[0].title)));
    assert.equal(sub.statusCode, 200, sub.body);
    const fin = await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie });
    return { v, sub: sub.json<Json>(), fin: fin.json<Json>() };
  }

  test("feedbackMode 'details' (default): score and per-check results after each submit", async () => {
    const exam = await publish();
    const cookie = await f.env.register("fb-details@example.com");
    const { sub, fin } = await play(cookie, exam.id);
    assert.equal(sub.feedbackMode, "details");
    assert.equal(sub.score, 10);
    assert.equal(sub.results.length, 2);
    assert.equal(fin.exercises[0].score, 10);
    assert.equal(fin.exercises[0].results.length, 2);
    assert.equal(fin.scorePercent, 50);
    assert.equal(fin.feedbackMode, "details");
  });

  test("feedbackMode 'score': the score without per-check results", async () => {
    const exam = await publish({ feedbackMode: "score" });
    const cookie = await f.env.register("fb-score@example.com");
    const v = (await start(cookie, exam.id)).json<Json>();
    const sub = (await submit(cookie, v, 0, CORRECT(numberOf(v.exercises[0].title)))).json<Json>();
    assert.equal(sub.score, 10);
    assert.equal(sub.maxScore, 10);
    assert.equal(sub.results, null);
    const view = (await f.env.call("GET", `/api/attempts/${v.id}`, { cookie })).json<Json>();
    assert.equal(view.exercises[0].score, 10);
    assert.equal(view.exercises[0].results, null);
    const fin = (await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie })).json<Json>();
    assert.equal(fin.exercises[0].score, 10);
    assert.equal(fin.exercises[0].results, null);
    assert.equal(fin.grade, 10);
  });

  test("feedbackMode 'none': nothing about the exercise result until the exam grade", async () => {
    const exam = await publish({ feedbackMode: "none" });
    const cookie = await f.env.register("fb-none@example.com");
    const v = (await start(cookie, exam.id)).json<Json>();
    const subRes = await submit(cookie, v, 0, CORRECT(numberOf(v.exercises[0].title)));
    const sub = subRes.json<Json>();
    assert.equal(sub.score, null);
    assert.equal(sub.results, null);
    assert.equal(sub.progress.submitted, 1);
    assert.ok(!/"passed"/.test(subRes.body), "no pass/fail data in the body");
    const view = (await f.env.call("GET", `/api/attempts/${v.id}`, { cookie })).json<Json>();
    assert.equal(view.exercises[0].submitted, true);
    assert.equal(view.exercises[0].score, null);
    assert.equal(view.exercises[0].results, null);
    const fin = (await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie })).json<Json>();
    assert.equal(fin.grade, 10, "the final grade is still shown (resultMode immediate)");
    assert.equal(fin.exercises[0].score, null);
    assert.equal(fin.exercises[0].results, null);
  });

  test("allowReview: finished attempts expose workbooks and per-check results, even with feedbackMode 'none'", async () => {
    const closed = await publish({ feedbackMode: "none", allowReview: false });
    const open = await publish({ feedbackMode: "none", allowReview: true });
    const c1 = await f.env.register("rev-no@example.com");
    const c2 = await f.env.register("rev-yes@example.com");
    const noReview = (await play(c1, closed.id)).fin;
    assert.equal(noReview.allowReview, false);
    assert.ok(noReview.exercises.every((e: Json) => e.workbook === null));
    assert.equal((await f.env.call("GET", `/api/attempts/${noReview.id}`, { cookie: c1 })).json<Json>().exercises[0].workbook, null);
    const review = (await play(c2, open.id)).fin;
    assert.equal(review.allowReview, true);
    assert.equal(review.exercises[0].score, 10);
    assert.equal(review.exercises[0].results.length, 2);
    assert.equal(review.exercises[0].workbook.sheets[0].cells.A1.v, "=PRODUCTO(B1,2)");
    const reread = (await f.env.call("GET", `/api/attempts/${review.id}`, { cookie: c2 })).json<Json>();
    assert.equal(reread.exercises[1].submitted, true, "unsubmitted exercises were graded on finish");
    assert.ok(reread.exercises[1].workbook);
    // While the attempt is running the workbook is always there (the runner needs it).
    const running = (await start(c1, closed.id)).json<Json>();
    assert.ok(running.exercises.every((e: Json) => e.workbook));
    // Checks and expected values never leak, with or without review.
    assert.ok(!/expected|requireFormula|tolerance|"actual"/.test(JSON.stringify(reread)));
  });

  test("resultMode 'hidden': no grade anywhere for the student, staff see everything", async () => {
    const exam = await publish({ resultMode: "hidden" });
    const cookie = await f.env.register("hidden@example.com");
    const { fin } = await play(cookie, exam.id);
    assert.equal(fin.status, "submitted");
    assert.deepEqual([fin.scorePercent, fin.grade, fin.passed, fin.resultsVisible], [null, null, null, false]);
    assert.ok(fin.exercises.every((e: Json) => e.score === null && e.results === null), "per-exercise results are hidden too");
    assert.equal(fin.resultMode, "hidden");
    const c = await card(cookie, exam.id);
    assert.equal(c.result, null);
    assert.equal(c.resultsVisible, false);
    assert.deepEqual([c.attempts[0].scorePercent, c.attempts[0].grade], [null, null]);
    const mine = (await f.env.call("GET", "/api/me/results", { cookie })).json<Json[]>().find((r) => r.examId === exam.id)!;
    assert.equal(mine.result, null);
    assert.equal(mine.attempts[0].grade, null);
    assert.equal(mine.attempts.length, 1);
    const reread = (await f.env.call("GET", `/api/attempts/${fin.id}`, { cookie })).json<Json>();
    assert.equal(reread.grade, null);
    const staff = (await f.env.call("GET", `/api/admin/results?examId=${exam.id}`, { cookie: f.admin })).json<Json>();
    assert.equal(staff.attempts[0].grade, 10);
    assert.equal(staff.summary[0].result.grade, 10);
    // An expired attempt is hidden as well.
    const s2 = await f.env.register("hidden2@example.com");
    const v = (await start(s2, exam.id)).json<Json>();
    f.env.clock.now += minutes(31);
    const expired = (await f.env.call("GET", `/api/attempts/${v.id}`, { cookie: s2 })).json<Json>();
    assert.equal(expired.status, "expired");
    assert.equal(expired.grade, null);
    f.env.clock.now -= minutes(31);
  });

  test("resultMode 'after_close': revealed when available_until passes or when the attempts are exhausted", async () => {
    const until = new Date(f.env.clock.now + minutes(120)).toISOString();
    const exam = await publish({ resultMode: "after_close", availableUntil: until, maxAttempts: 2 });
    const cookie = await f.env.register("close1@example.com");
    const first = (await play(cookie, exam.id)).fin;
    assert.deepEqual([first.grade, first.resultsVisible], [null, false], "first attempt of two, window still open");
    assert.equal((await card(cookie, exam.id)).result, null);
    const second = (await play(cookie, exam.id)).fin;
    assert.equal(second.resultsVisible, true, "attempts exhausted -> revealed");
    assert.equal(second.grade, 10);
    const c = await card(cookie, exam.id);
    assert.equal(c.resultsVisible, true);
    assert.equal(c.result.grade, 10);
    assert.equal(c.attempts.length, 2);
    assert.equal((await f.env.call("GET", `/api/attempts/${first.id}`, { cookie })).json<Json>().grade, 10, "the first attempt is revealed too");

    // Another student with attempts left: still hidden until the window closes.
    const other = await f.env.register("close2@example.com");
    const o = (await play(other, exam.id)).fin;
    assert.equal(o.grade, null);
    f.env.clock.now += minutes(121);
    assert.equal((await f.env.call("GET", `/api/attempts/${o.id}`, { cookie: other })).json<Json>().grade, 10, "window closed -> revealed");
    assert.equal((await card(other, exam.id)).result.grade, 10);
    f.env.clock.now -= minutes(121);

    // Without available_until only exhaustion reveals; a running attempt keeps it hidden.
    const open = await publish({ resultMode: "after_close", maxAttempts: 1 });
    const third = await f.env.register("close3@example.com");
    const v = (await start(third, open.id)).json<Json>();
    assert.equal((await card(third, open.id)).resultsVisible, false);
    const fin = (await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie: third })).json<Json>();
    assert.equal(fin.resultsVisible, true, "the single attempt is used up");
    // Extra attempts push the reveal back: the student is entitled to one more.
    await f.env.call("POST", `/api/admin/exams/${open.id}/grant-attempt`, { cookie: f.admin, payload: { userId: (await f.env.call("GET", "/api/auth/me", { cookie: third })).json<Json>().id, extra: 1 } });
    assert.equal((await card(third, open.id)).resultsVisible, false);
  });

  test("access code: required, constant-time compared, never exposed to students, throttled", async () => {
    const exam = await publish({ accessCode: "Clave-77" });
    const cookie = await f.env.register("codigo@example.com");
    const c = await card(cookie, exam.id);
    assert.equal(c.requiresCode, true);
    const detail = await f.env.call("GET", `/api/exams/${exam.id}`, { cookie });
    assert.equal(detail.json<Json>().requiresCode, true);
    for (const body of [JSON.stringify(c), detail.body, (await f.env.call("GET", "/api/exams", { cookie })).body]) {
      assert.ok(!body.includes("Clave-77") && !/accessCode|access_code/.test(body), "code not exposed to students");
    }
    const missing = await start(cookie, exam.id);
    assert.equal(missing.statusCode, 403);
    assert.equal(missing.json<Json>().error.code, "ACCESS_CODE_REQUIRED");
    const wrong = await start(cookie, exam.id, { accepted: true, accessCode: "clave-77" });
    assert.equal(wrong.json<Json>().error.code, "INVALID_ACCESS_CODE");
    assert.equal((await start(cookie, exam.id, { accepted: true, accessCode: "x".repeat(101) })).statusCode, 400);
    const right = await start(cookie, exam.id, { accepted: true, accessCode: " Clave-77 " });
    assert.equal(right.statusCode, 201, right.body);
    // Resuming a running attempt does not ask for the code again.
    assert.equal((await start(cookie, exam.id)).statusCode, 200);
    assert.equal((await card(await f.env.register("sin-codigo@example.com"), (await publish()).id)).requiresCode, false);
    // Admin sees the code.
    assert.equal((await f.env.call("GET", `/api/admin/exams/${exam.id}`, { cookie: f.admin })).json<Json>().accessCode, "Clave-77");
    // Guessing is throttled (10 checks per minute per student and exam).
    const guesser = await f.env.register("adivina@example.com");
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await start(guesser, exam.id, { accepted: true, accessCode: `nope-${i}` })).statusCode);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(403));
    assert.equal(codes[11], 429);
  });

  test("restricted exams are only visible to the students on the allow list", async () => {
    const exam = await publish({ restricted: true });
    const listed = await f.env.register("listado@example.com", "Listado");
    const other = await f.env.register("otro-alumno@example.com", "Otro");
    const teacherEmail = "profe@example.com";
    const put = await f.env.call("PUT", `/api/admin/exams/${exam.id}/access`, {
      cookie: f.admin,
      payload: { emails: ["Listado@Example.com", "desconocido@example.com", teacherEmail, "listado@example.com"] },
    });
    assert.equal(put.statusCode, 200, put.body);
    const out = put.json<Json>();
    assert.deepEqual(out.matched.map((m: Json) => m.email), ["listado@example.com"]);
    assert.deepEqual(out.unknown.sort(), ["desconocido@example.com", teacherEmail].sort(), "only students can be listed");
    assert.equal(out.restricted, true);
    const get = (await f.env.call("GET", `/api/admin/exams/${exam.id}/access`, { cookie: f.admin })).json<Json>();
    assert.equal(get.restricted, true);
    assert.deepEqual(get.entries.map((e: Json) => e.email), ["listado@example.com"]);

    assert.ok((await f.env.call("GET", "/api/exams", { cookie: listed })).json<Json[]>().some((e) => e.id === exam.id));
    assert.ok(!(await f.env.call("GET", "/api/exams", { cookie: other })).json<Json[]>().some((e) => e.id === exam.id));
    assert.equal((await f.env.call("GET", `/api/exams/${exam.id}`, { cookie: other })).statusCode, 404);
    assert.equal((await start(other, exam.id)).statusCode, 404);
    assert.equal((await start(listed, exam.id)).statusCode, 201);

    // Lifting the restriction opens it to everyone; the list stays stored.
    assert.equal((await f.env.call("PUT", `/api/admin/exams/${exam.id}/access`, { cookie: f.admin, payload: { emails: ["listado@example.com"], restricted: false } })).json<Json>().restricted, false);
    assert.equal((await start(other, exam.id)).statusCode, 201);
    // Removing a student from the list does not take away an exam they already took part in.
    await f.env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: f.admin, payload: { restricted: true } });
    await f.env.call("PUT", `/api/admin/exams/${exam.id}/access`, { cookie: f.admin, payload: { emails: [] } });
    assert.ok((await f.env.call("GET", "/api/exams", { cookie: listed })).json<Json[]>().some((e) => e.id === exam.id));
    assert.equal((await f.env.call("PUT", `/api/admin/exams/${exam.id}/access`, { cookie: f.admin, payload: { emails: "nope" } })).statusCode, 400);
  });

  test("extra attempts: grant, effective limit in cards/results/start, list and revoke", async () => {
    const exam = await publish({ maxAttempts: 1 });
    const cookie = await f.env.register("extra@example.com");
    const userId = (await f.env.call("GET", "/api/auth/me", { cookie })).json<Json>().id;
    const v = (await start(cookie, exam.id)).json<Json>();
    await f.env.call("POST", `/api/attempts/${v.id}/finish`, { cookie });
    const blocked = await start(cookie, exam.id);
    assert.equal(blocked.json<Json>().error.code, "NO_ATTEMPTS_LEFT");
    assert.equal((await card(cookie, exam.id)).attemptsRemaining, 0);

    assert.equal((await f.env.call("POST", `/api/admin/exams/${exam.id}/grant-attempt`, { cookie: f.admin, payload: { userId, extra: 6 } })).statusCode, 400);
    assert.equal((await f.env.call("POST", `/api/admin/exams/${exam.id}/grant-attempt`, { cookie: f.admin, payload: { userId, extra: 0 } })).statusCode, 400);
    assert.equal((await f.env.call("POST", `/api/admin/exams/${exam.id}/grant-attempt`, { cookie: f.admin, payload: { userId: (await f.env.call("GET", "/api/auth/me", { cookie: f.admin })).json<Json>().id, extra: 1 } })).statusCode, 404, "only students");
    const grant = await f.env.call("POST", `/api/admin/exams/${exam.id}/grant-attempt`, { cookie: f.admin, payload: { userId, extra: 2, reason: "Se cayó la conexión" } });
    assert.equal(grant.statusCode, 201, grant.body);
    assert.equal(grant.json<Json>().effectiveMaxAttempts, 3);
    const c = await card(cookie, exam.id);
    assert.deepEqual([c.maxAttempts, c.extraAttempts, c.attemptsRemaining], [3, 2, 2]);
    const again = await start(cookie, exam.id);
    assert.equal(again.statusCode, 201, again.body);
    assert.equal(again.json<Json>().number, 2);
    const mine = (await f.env.call("GET", "/api/me/results", { cookie })).json<Json[]>().find((r) => r.examId === exam.id)!;
    assert.equal(mine.maxAttempts, 3);
    const list = (await f.env.call("GET", `/api/admin/exams/${exam.id}/overrides`, { cookie: f.admin })).json<Json[]>();
    assert.equal(list.length, 1);
    assert.deepEqual([list[0]!.extra, list[0]!.reason, list[0]!.userEmail, list[0]!.grantedByName], [2, "Se cayó la conexión", "extra@example.com", "Administrador"]);
    assert.deepEqual((await f.env.call("GET", `/api/admin/exams/${exam.id}/grant-attempt`, { cookie: f.admin })).json<Json[]>(), list);
    // A second grant adds up; revoking removes it.
    await f.env.call("POST", `/api/admin/exams/${exam.id}/grant-attempt`, { cookie: f.admin, payload: { userId, extra: 1 } });
    assert.equal((await card(cookie, exam.id)).maxAttempts, 4);
    const all = (await f.env.call("GET", `/api/admin/exams/${exam.id}/overrides`, { cookie: f.admin })).json<Json[]>();
    assert.equal((await f.env.call("DELETE", `/api/admin/exams/${exam.id}/overrides/${all[0]!.id}`, { cookie: f.admin })).statusCode, 204);
    assert.equal((await card(cookie, exam.id)).maxAttempts, 3);
    assert.equal((await f.env.call("DELETE", `/api/admin/exams/${exam.id}/overrides/${all[0]!.id}`, { cookie: f.admin })).statusCode, 404);
  });

  test("student exam API keeps its shape and only adds optional fields", async () => {
    const exam = await publish({ description: "Una descripción", title: "Forma estable" });
    const cookie = await f.env.register("forma@example.com");
    const c = await card(cookie, exam.id);
    for (const key of ["id", "title", "durationMinutes", "maxAttempts", "exerciseCount", "scale", "passPercent", "gradePolicy", "availableFrom", "availableUntil", "window", "attemptsUsed", "attemptsRemaining", "inProgressAttemptId", "result", "attempts"]) {
      assert.ok(key in c, `card.${key}`);
    }
    assert.deepEqual([c.description, c.requiresCode, c.feedbackMode, c.resultMode, c.allowReview, c.resultsVisible, c.extraAttempts], ["Una descripción", false, "details", "immediate", false, true, 0]);
    const v = (await start(cookie, exam.id)).json<Json>();
    for (const key of ["id", "examId", "examTitle", "number", "status", "startedAt", "deadlineAt", "serverNow", "durationMinutes", "scale", "passPercent", "scorePercent", "grade", "passed", "exercises", "resumed"]) {
      assert.ok(key in v, `attempt.${key}`);
    }
    for (const key of ["id", "position", "title", "instructions", "points", "workbook", "submitted", "score", "maxScore", "results", "block"]) {
      assert.ok(key in v.exercises[0], `exercise.${key}`);
    }
    assert.equal(v.exercises[0].block, "Único");
    assert.equal(numberOf(v.exercises[0].title), 1);
  });
});

describe("migration 002 on an existing 001 database", () => {
  test("data from schema 001 is migrated into blocks, owners and defaults", async () => {
    const { createPgliteDb } = await import("../src/db/db.js");
    const { migrate } = await import("../src/db/migrate.js");
    const { mkdtemp, copyFile, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    // Only migration 001 first.
    const sourceDir = fileURLToPath(new URL("../migrations/", import.meta.url));
    const onlyFirst = await mkdtemp(join(tmpdir(), "mig001-"));
    const files = (await readdir(sourceDir)).filter((n) => n.endsWith(".sql")).sort();
    await copyFile(join(sourceDir, files[0]!), join(onlyFirst, files[0]!));
    const db = await createPgliteDb();
    try {
      await migrate(db, onlyFirst);
      const { rows: tables } = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
      assert.ok(!tables.some((t) => t.table_name === "exam_blocks"), "blocks do not exist yet");

      // Sample data in the 001 shape.
      const admin = (await db.query<{ id: string }>("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'a@x.co', 'h', 'admin') RETURNING id")).rows[0]!.id;
      await db.query("INSERT INTO users (name, email, password_hash, role) VALUES ('Alumno', 's@x.co', 'h', 'student')");
      const wb = JSON.stringify({ name: "L", sheets: [{ name: "H", cells: {}, colW: {} }] });
      const exIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        exIds.push((await db.query<{ id: string }>("INSERT INTO exercises (title, workbook, created_by, status) VALUES ($1, $2::jsonb, $3, 'published') RETURNING id", [`E${i}`, wb, i === 0 ? admin : null])).rows[0]!.id);
      }
      const examIds: string[] = [];
      for (const [title, pick] of [["Con pick", 2], ["Pick grande", 9], ["Sin pick", null], ["Vacío", 1]] as const) {
        examIds.push((await db.query<{ id: string }>("INSERT INTO exams (title, duration_minutes, pick_count, created_by) VALUES ($1, 30, $2, NULL) RETURNING id", [title, pick])).rows[0]!.id);
      }
      for (const examId of examIds.slice(0, 3)) {
        for (const [position, id] of [exIds[2]!, exIds[0]!, exIds[1]!].entries()) {
          await db.query("INSERT INTO exam_exercises (exam_id, exercise_id, position) VALUES ($1, $2, $3)", [examId, id, position]);
        }
      }
      const student = (await db.query<{ id: string }>("SELECT id FROM users WHERE email = 's@x.co'")).rows[0]!.id;
      await db.query(
        `INSERT INTO attempts (exam_id, user_id, number, seed, exercise_ids, started_at, deadline_at, accepted_at, status, score_percent, grade)
         VALUES ($1, $2, 1, 7, $3::jsonb, now(), now(), now(), 'submitted', 50, 10)`,
        [examIds[0], student, JSON.stringify([exIds[0]])],
      );

      // Apply every migration (001 is already recorded and is skipped).
      await migrate(db);
      const { rows: applied } = await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
      assert.ok(applied.length >= 2 && applied[0]!.name.startsWith("001"));

      // Users and constraints.
      const { rows: users } = await db.query<Row>("SELECT email, role, active, must_change_password FROM users ORDER BY email");
      assert.deepEqual(users.map((u) => [u.email, u.role, u.active, u.must_change_password]), [["a@x.co", "admin", true, false], ["s@x.co", "student", true, false]]);
      await db.query("INSERT INTO users (name, email, password_hash, role) VALUES ('T', 't@x.co', 'h', 'teacher')");
      await assert.rejects(db.query("INSERT INTO users (name, email, password_hash, role) VALUES ('X', 'x@x.co', 'h', 'wizard')"));

      // Ownership: created_by when present, otherwise the first admin.
      const { rows: owners } = await db.query<{ title: string; owner_id: string }>("SELECT title, owner_id FROM exercises ORDER BY title");
      assert.ok(owners.every((o) => o.owner_id === admin));
      const { rows: examOwners } = await db.query<{ owner_id: string }>("SELECT owner_id FROM exams");
      assert.ok(examOwners.every((o) => o.owner_id === admin));
      const { rows: defaults } = await db.query<Row>("SELECT difficulty, tags, estimated_minutes, category FROM exercises LIMIT 1");
      assert.deepEqual([defaults[0]!.difficulty, defaults[0]!.tags, defaults[0]!.estimated_minutes, defaults[0]!.category], ["medium", [], null, null]);

      // Blocks: one default block per exam that had exercises, same order and pick_count semantics.
      const { rows: blocks } = await db.query<Row>(
        `SELECT e.title, b.title AS block, b.position, b.pick_count, b.shuffle,
                (SELECT string_agg(x.exercise_id::text, ',' ORDER BY x.position) FROM exam_block_exercises x WHERE x.block_id = b.id) AS ids
           FROM exam_blocks b JOIN exams e ON e.id = b.exam_id ORDER BY e.title`,
      );
      assert.deepEqual(blocks.map((b) => [b.title, b.block, b.position, b.pick_count, b.shuffle]), [
        ["Con pick", "Ejercicios", 0, 2, true],
        ["Pick grande", "Ejercicios", 0, null, true], // pick 9 on a pool of 3 meant "all"
        ["Sin pick", "Ejercicios", 0, null, true],
      ]);
      assert.ok(blocks.every((b) => b.ids === [exIds[2], exIds[0], exIds[1]].join(",")), "exercise order preserved");
      assert.equal((await db.query("SELECT 1 FROM exam_blocks b JOIN exams e ON e.id = b.exam_id WHERE e.title = 'Vacío'")).rows.length, 0);
      const { rows: legacy } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM exam_exercises");
      assert.equal(legacy[0]!.n, 9, "the deprecated table is kept");

      // Exam defaults and the old attempt.
      const { rows: settings } = await db.query<Row>("SELECT feedback_mode, result_mode, allow_review, restricted, access_code, shuffle_blocks, description FROM exams LIMIT 1");
      assert.deepEqual(Object.values(settings[0]!), ["details", "immediate", false, false, null, false, ""]);
      const { rows: attempts } = await db.query<Row>("SELECT exercise_meta, grade FROM attempts");
      assert.deepEqual([attempts[0]!.exercise_meta, attempts[0]!.grade], [{}, 10]);

      // The migrated exam works end to end through the application.
      const { buildApp } = await import("../src/http/app.js");
      const { loadConfig } = await import("../src/config.js");
      const { hashPassword } = await import("../src/auth/password.js");
      await db.query("UPDATE users SET password_hash = $1 WHERE email IN ('a@x.co', 's@x.co')", [await hashPassword("secret-123")]);
      await db.query("UPDATE exams SET status = 'published'");
      const app = await buildApp({ db, config: loadConfig({}) });
      try {
        const login = async (email: string) => {
          const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "secret-123" } });
          return `gl_session=${r.cookies.find((c) => c.name === "gl_session")!.value}`;
        };
        const sc = await login("s@x.co");
        const exam = examIds[0]!;
        const old = await app.inject({ method: "GET", url: `/api/attempts/${(await db.query<{ id: string }>("SELECT id FROM attempts")).rows[0]!.id}`, headers: { cookie: sc } });
        assert.equal(old.statusCode, 200, "attempts from before the migration still load");
        assert.equal(old.json().exercises[0].block, null);
        const started = await app.inject({ method: "POST", url: `/api/exams/${exam}/attempts`, headers: { cookie: sc }, payload: { accepted: true } });
        assert.equal(started.statusCode, 201, started.body);
        assert.equal(started.json().exercises.length, 2, "pick_count 2 survived");
        assert.ok(started.json().exercises.every((e: Json) => e.block === "Ejercicios"));
        const ac = await login("a@x.co");
        const detail = await app.inject({ method: "GET", url: `/api/admin/exams/${exam}`, headers: { cookie: ac } });
        assert.equal(detail.json().blocks[0].exercises.length, 3);
        assert.equal(detail.json().pickCount, 2);
      } finally {
        await app.close();
      }
    } finally {
      await db.close();
      await rm(onlyFirst, { recursive: true, force: true });
    }
  });
});

type Row = Record<string, any>;

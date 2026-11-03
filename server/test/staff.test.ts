import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, CORRECT, createTestEnv, exerciseBody, type Json, type TestEnv } from "./helpers.js";

const ZERO = "00000000-0000-4000-8000-000000000000";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

describe("roles and permissions matrix", () => {
  let env: TestEnv;
  let admin: string;
  let teacher: string;
  let student: string;

  before(async () => {
    env = await createTestEnv();
    admin = await env.login(ADMIN.email, ADMIN.password);
    teacher = await env.makeUser(admin, "profe@example.com", "teacher");
    student = await env.register("alumno@example.com");
  });
  after(() => env.close());

  test("admin-only routes: anonymous 401, student 403, teacher 403", async () => {
    const routes: [Method, string][] = [
      ["GET", "/api/admin/users"],
      ["POST", "/api/admin/users"],
      ["PATCH", `/api/admin/users/${ZERO}`],
      ["POST", `/api/admin/users/${ZERO}/reset-password`],
    ];
    for (const [method, url] of routes) {
      assert.equal((await env.call(method, url, { payload: {} })).statusCode, 401, `${method} ${url} anonymous`);
      assert.equal((await env.call(method, url, { cookie: student, payload: {} })).statusCode, 403, `${method} ${url} student`);
      const asTeacher = await env.call(method, url, { cookie: teacher, payload: {} });
      assert.equal(asTeacher.statusCode, 403, `${method} ${url} teacher`);
      assert.equal(asTeacher.json<Json>().error.code, "FORBIDDEN");
    }
  });

  test("staff routes: anonymous 401, student 403, teacher passes the guard", async () => {
    const routes: [Method, string][] = [
      ["GET", "/api/admin/stats"],
      ["GET", "/api/admin/results.csv"],
      ["GET", `/api/admin/exams/${ZERO}/results.csv`],
      ["GET", `/api/admin/exams/${ZERO}/analytics`],
      ["PUT", `/api/admin/exams/${ZERO}/blocks`],
      ["POST", `/api/admin/exams/${ZERO}/draw-preview`],
      ["POST", `/api/admin/exams/${ZERO}/duplicate`],
      ["GET", `/api/admin/exams/${ZERO}/access`],
      ["PUT", `/api/admin/exams/${ZERO}/access`],
      ["POST", `/api/admin/exams/${ZERO}/grant-attempt`],
      ["GET", `/api/admin/exams/${ZERO}/overrides`],
      ["POST", `/api/admin/exercises/${ZERO}/duplicate`],
      ["GET", "/api/admin/exercises/export"],
      ["POST", "/api/admin/exercises/export"],
      ["POST", "/api/admin/exercises/import"],
    ];
    for (const [method, url] of routes) {
      assert.equal((await env.call(method, url, { payload: {} })).statusCode, 401, `${method} ${url} anonymous`);
      assert.equal((await env.call(method, url, { cookie: student, payload: {} })).statusCode, 403, `${method} ${url} student`);
      const asTeacher = await env.call(method, url, { cookie: teacher, payload: {} });
      assert.notEqual(asTeacher.statusCode, 403, `${method} ${url} teacher must pass the role guard`);
      assert.notEqual(asTeacher.statusCode, 401);
      const asAdmin = await env.call(method, url, { cookie: admin, payload: {} });
      assert.notEqual(asAdmin.statusCode, 403, `${method} ${url} admin`);
    }
  });

  test("public registration always creates a student, even if a role is sent", async () => {
    const r = await env.call("POST", "/api/auth/register", { payload: { name: "Intruso", email: "intruso@example.com", password: "secret-123", role: "admin" } });
    assert.equal(r.statusCode, 201);
    assert.equal(r.json<Json>().role, "student");
  });
});

describe("user management", () => {
  let env: TestEnv;
  let admin: string;

  before(async () => {
    env = await createTestEnv();
    admin = await env.login(ADMIN.email, ADMIN.password);
  });
  after(() => env.close());

  const me = async (cookie: string) => (await env.call("GET", "/api/auth/me", { cookie })).json<Json>();
  const adminId = async () => (await me(admin)).id as string;

  test("create a teacher with a temporary password: forced change before anything else", async () => {
    const created = await env.call("POST", "/api/admin/users", { cookie: admin, payload: { name: "Profe Temporal", email: "Temporal@Example.com", password: "temporal-123", role: "teacher" } });
    assert.equal(created.statusCode, 201, created.body);
    const user = created.json<Json>();
    assert.equal(user.role, "teacher");
    assert.equal(user.email, "temporal@example.com");
    assert.equal(user.active, true);
    assert.equal(user.mustChangePassword, true);
    assert.equal((await env.call("POST", "/api/admin/users", { cookie: admin, payload: { name: "X", email: "temporal@example.com", password: "temporal-123", role: "student" } })).json<Json>().error.code, "EMAIL_TAKEN");

    const cookie = await env.login("temporal@example.com", "temporal-123");
    const profile = await me(cookie);
    assert.equal(profile.mustChangePassword, true);
    // Blocked everywhere except me / logout / change-password.
    const blocked = await env.call("GET", "/api/admin/exercises", { cookie });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json<Json>().error.code, "PASSWORD_CHANGE_REQUIRED");
    assert.equal((await env.call("GET", "/api/exams", { cookie })).json<Json>().error.code, "PASSWORD_CHANGE_REQUIRED");

    const wrong = await env.call("POST", "/api/auth/change-password", { cookie, payload: { currentPassword: "nope-nope-1", newPassword: "nueva-clave-1" } });
    assert.equal(wrong.json<Json>().error.code, "WRONG_CURRENT_PASSWORD");
    const same = await env.call("POST", "/api/auth/change-password", { cookie, payload: { currentPassword: "temporal-123", newPassword: "temporal-123" } });
    assert.equal(same.json<Json>().error.code, "PASSWORD_UNCHANGED");
    assert.equal((await env.call("POST", "/api/auth/change-password", { cookie, payload: { currentPassword: "temporal-123", newPassword: "corta" } })).statusCode, 400);

    const changed = await env.call("POST", "/api/auth/change-password", { cookie, payload: { currentPassword: "temporal-123", newPassword: "nueva-clave-1" } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json<Json>().mustChangePassword, false);
    assert.equal((await env.call("GET", "/api/admin/exercises", { cookie })).statusCode, 200);
    assert.equal((await env.call("POST", "/api/auth/login", { payload: { email: "temporal@example.com", password: "temporal-123" } })).statusCode, 401);
    assert.equal((await env.call("POST", "/api/auth/login", { payload: { email: "temporal@example.com", password: "nueva-clave-1" } })).statusCode, 200);
  });

  test("change-password signs out the other devices but keeps the current one", async () => {
    await env.makeUser(admin, "multi@example.com", "student");
    const a = await env.login("multi@example.com", "secret-123");
    const b = await env.login("multi@example.com", "secret-123");
    assert.equal((await env.call("POST", "/api/auth/change-password", { cookie: a, payload: { currentPassword: "secret-123", newPassword: "otra-clave-77" } })).statusCode, 200);
    assert.equal((await env.call("GET", "/api/auth/me", { cookie: a })).statusCode, 200);
    assert.equal((await env.call("GET", "/api/auth/me", { cookie: b })).statusCode, 401);
  });

  test("profile: read and rename", async () => {
    const cookie = await env.makeUser(admin, "perfil@example.com", "student", "Perfil Uno");
    assert.equal((await env.call("GET", "/api/auth/profile", { cookie })).json<Json>().name, "Perfil Uno");
    const patched = await env.call("PATCH", "/api/auth/profile", { cookie, payload: { name: "  Nuevo Nombre " } });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json<Json>().name, "Nuevo Nombre");
    assert.equal((await env.call("PATCH", "/api/auth/profile", { cookie, payload: { name: "" } })).statusCode, 400);
    assert.equal((await env.call("GET", "/api/auth/profile")).statusCode, 401);
  });

  test("list with filters and pagination", async () => {
    await env.makeUser(admin, "lista-a@example.com", "teacher", "Ana Lista");
    await env.makeUser(admin, "lista-b@example.com", "student", "Beto Lista");
    await env.makeUser(admin, "lista-c@example.com", "student", "Carla Lista");
    const teachers = (await env.call("GET", "/api/admin/users?role=teacher", { cookie: admin })).json<Json>();
    assert.ok(teachers.items.length >= 1 && teachers.items.every((u: Json) => u.role === "teacher"));
    assert.equal(typeof teachers.total, "number");
    const byName = (await env.call("GET", "/api/admin/users?q=lista", { cookie: admin })).json<Json>();
    assert.equal(byName.total, 3);
    const byEmail = (await env.call("GET", "/api/admin/users?q=lista-b@", { cookie: admin })).json<Json>();
    assert.deepEqual(byEmail.items.map((u: Json) => u.email), ["lista-b@example.com"]);
    const page1 = (await env.call("GET", "/api/admin/users?q=lista&pageSize=2&page=1", { cookie: admin })).json<Json>();
    const page2 = (await env.call("GET", "/api/admin/users?q=lista&pageSize=2&page=2", { cookie: admin })).json<Json>();
    assert.equal(page1.items.length, 2);
    assert.equal(page2.items.length, 1);
    assert.equal(page1.total, 3);
    assert.equal(page2.page, 2);
    assert.equal((await env.call("GET", "/api/admin/users?active=false&q=lista", { cookie: admin })).json<Json>().total, 0);
    assert.equal((await env.call("GET", "/api/admin/users?role=wizard", { cookie: admin })).statusCode, 400);
    assert.ok(!JSON.stringify(teachers).includes("password"), "no password data in the listing");
  });

  test("deactivation blocks login, revokes sessions and can be undone", async () => {
    const cookie = await env.makeUser(admin, "baja@example.com", "student");
    const id = (await me(cookie)).id as string;
    const off = await env.call("PATCH", `/api/admin/users/${id}`, { cookie: admin, payload: { active: false } });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json<Json>().active, false);
    assert.equal((await env.call("GET", "/api/auth/me", { cookie })).statusCode, 401, "existing session is revoked");
    const login = await env.call("POST", "/api/auth/login", { payload: { email: "baja@example.com", password: "secret-123" } });
    assert.equal(login.statusCode, 403);
    assert.equal(login.json<Json>().error.code, "ACCOUNT_DISABLED");
    // A wrong password does not reveal that the account is disabled.
    assert.equal((await env.call("POST", "/api/auth/login", { payload: { email: "baja@example.com", password: "wrong-pass-1" } })).json<Json>().error.code, "INVALID_CREDENTIALS");
    assert.equal((await env.call("GET", "/api/admin/users?active=false&q=baja", { cookie: admin })).json<Json>().total, 1);
    assert.equal((await env.call("PATCH", `/api/admin/users/${id}`, { cookie: admin, payload: { active: true } })).statusCode, 200);
    assert.equal((await env.call("POST", "/api/auth/login", { payload: { email: "baja@example.com", password: "secret-123" } })).statusCode, 200);
  });

  test("role changes take effect on the next request", async () => {
    const cookie = await env.makeUser(admin, "asciende@example.com", "student");
    const id = (await me(cookie)).id as string;
    assert.equal((await env.call("GET", "/api/admin/exercises", { cookie })).statusCode, 403);
    assert.equal((await env.call("PATCH", `/api/admin/users/${id}`, { cookie: admin, payload: { role: "teacher", name: "Ascendido" } })).json<Json>().role, "teacher");
    assert.equal((await env.call("GET", "/api/admin/exercises", { cookie })).statusCode, 200);
  });

  test("an admin cannot demote or deactivate themselves; the last active admin always survives", async () => {
    const id = await adminId();
    const self = await env.call("PATCH", `/api/admin/users/${id}`, { cookie: admin, payload: { role: "teacher" } });
    assert.equal(self.statusCode, 409);
    assert.equal(self.json<Json>().error.code, "CANNOT_MODIFY_SELF");
    assert.equal((await env.call("PATCH", `/api/admin/users/${id}`, { cookie: admin, payload: { active: false } })).json<Json>().error.code, "CANNOT_MODIFY_SELF");
    assert.equal((await env.call("PATCH", `/api/admin/users/${id}`, { cookie: admin, payload: { name: "Admin Renombrado" } })).statusCode, 200);

    // With a second admin, the first can be deactivated by the second; the survivor can then not remove itself.
    const second = await env.makeUser(admin, "admin2@example.com", "admin");
    const secondId = (await me(second)).id as string;
    assert.equal((await env.call("PATCH", `/api/admin/users/${id}`, { cookie: second, payload: { active: false } })).statusCode, 200);
    assert.equal((await env.call("GET", "/api/auth/me", { cookie: admin })).statusCode, 401, "deactivated admin loses the session");
    const { rows } = await env.db.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active");
    assert.equal(rows[0]!.n, 1);
    for (const payload of [{ role: "student" }, { active: false }]) {
      const blocked = await env.call("PATCH", `/api/admin/users/${secondId}`, { cookie: second, payload });
      assert.equal(blocked.statusCode, 409);
    }
    // Reactivate the original admin (later tests use it).
    assert.equal((await env.call("PATCH", `/api/admin/users/${id}`, { cookie: second, payload: { active: true } })).statusCode, 200);
    admin = await env.login(ADMIN.email, ADMIN.password);
  });

  test("reset-password: temporary password, forced change, sessions revoked", async () => {
    const cookie = await env.makeUser(admin, "olvido@example.com", "student");
    const id = (await me(cookie)).id as string;
    const reset = await env.call("POST", `/api/admin/users/${id}/reset-password`, { cookie: admin, payload: { password: "provisoria-9" } });
    assert.equal(reset.statusCode, 204);
    assert.equal((await env.call("GET", "/api/auth/me", { cookie })).statusCode, 401);
    assert.equal((await env.call("POST", "/api/auth/login", { payload: { email: "olvido@example.com", password: "secret-123" } })).statusCode, 401);
    const fresh = await env.login("olvido@example.com", "provisoria-9");
    assert.equal((await me(fresh)).mustChangePassword, true);
    assert.equal((await env.call("POST", `/api/admin/users/${id}/reset-password`, { cookie: admin, payload: { password: "corta" } })).statusCode, 400);
    assert.equal((await env.call("POST", `/api/admin/users/${ZERO}/reset-password`, { cookie: admin, payload: { password: "provisoria-9" } })).statusCode, 404);
    assert.equal((await env.call("POST", `/api/admin/users/${await adminId()}/reset-password`, { cookie: admin, payload: { password: "provisoria-9" } })).json<Json>().error.code, "USE_CHANGE_PASSWORD");
  });
});

describe("teacher isolation and ownership", () => {
  let env: TestEnv;
  let admin: string;
  let teacherA: string;
  let teacherB: string;
  let student: string;
  const ids: Record<string, string> = {};

  const json = (r: { json<T>(): T }) => r.json<Json>();

  before(async () => {
    env = await createTestEnv();
    admin = await env.login(ADMIN.email, ADMIN.password);
    teacherA = await env.makeUser(admin, "a@example.com", "teacher", "Profe A");
    teacherB = await env.makeUser(admin, "b@example.com", "teacher", "Profe B");
    student = await env.register("est@example.com", "Estudiante Uno");
    ids.teacherA = json(await env.call("GET", "/api/auth/me", { cookie: teacherA })).id;
    ids.teacherB = json(await env.call("GET", "/api/auth/me", { cookie: teacherB })).id;

    ids.exA = json(await env.call("POST", "/api/admin/exercises", { cookie: teacherA, payload: exerciseBody(1) })).id;
    ids.exB = json(await env.call("POST", "/api/admin/exercises", { cookie: teacherB, payload: exerciseBody(2) })).id;
    ids.exAdmin = json(await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: exerciseBody(3) })).id;
    ids.examA = json(await env.call("POST", "/api/admin/exams", { cookie: teacherA, payload: { title: "Examen de A", durationMinutes: 20, exerciseIds: [ids.exA], status: "published" } })).id;
    ids.examB = json(await env.call("POST", "/api/admin/exams", { cookie: teacherB, payload: { title: "Examen de B", durationMinutes: 20, exerciseIds: [ids.exB], status: "published" } })).id;
  });
  after(() => env.close());

  test("new content is owned by its creator", async () => {
    const ex = json(await env.call("GET", `/api/admin/exercises/${ids.exA}`, { cookie: teacherA }));
    assert.equal(ex.ownerId, ids.teacherA);
    const exam = json(await env.call("GET", `/api/admin/exams/${ids.examA}`, { cookie: teacherA }));
    assert.equal(exam.ownerId, ids.teacherA);
    assert.equal(exam.ownerName, "Profe A");
  });

  test("a teacher cannot read, edit, delete or grade another teacher's exercise (404)", async () => {
    const calls: [Method, string, unknown?][] = [
      ["GET", `/api/admin/exercises/${ids.exB}`],
      ["PUT", `/api/admin/exercises/${ids.exB}`, { title: "Hackeado" }],
      ["PATCH", `/api/admin/exercises/${ids.exB}`, { title: "Hackeado" }],
      ["DELETE", `/api/admin/exercises/${ids.exB}`],
      ["POST", `/api/admin/exercises/${ids.exB}/preview-grade`, { workbook: exerciseBody(2).workbook }],
      ["POST", `/api/admin/exercises/${ids.exB}/duplicate`, {}],
      ["GET", `/api/admin/exercises/${ids.exAdmin}`],
    ];
    for (const [method, url, payload] of calls) {
      const r = await env.call(method, url, { cookie: teacherA, payload: payload ?? {} });
      assert.equal(r.statusCode, 404, `${method} ${url}`);
    }
    assert.equal(json(await env.call("GET", `/api/admin/exercises/${ids.exB}`, { cookie: admin })).title, "Ejercicio 2");
  });

  test("lists only show own content to teachers and everything to admins", async () => {
    const mine = json(await env.call("GET", "/api/admin/exercises", { cookie: teacherA })) as Json[];
    assert.deepEqual(mine.map((e) => e.id), [ids.exA]);
    const exams = json(await env.call("GET", "/api/admin/exams", { cookie: teacherA })) as Json[];
    assert.deepEqual(exams.map((e) => e.id), [ids.examA]);
    const all = json(await env.call("GET", "/api/admin/exercises", { cookie: admin })) as Json[];
    assert.equal(all.length, 3);
    // A teacher cannot widen the scope with the owner filter.
    const sneaky = json(await env.call("GET", `/api/admin/exercises?owner=${ids.teacherB}`, { cookie: teacherA })) as Json[];
    assert.deepEqual(sneaky.map((e) => e.id), [ids.exA]);
    const filtered = json(await env.call("GET", `/api/admin/exercises?owner=${ids.teacherB}`, { cookie: admin })) as Json[];
    assert.deepEqual(filtered.map((e) => e.id), [ids.exB]);
    const examsOfB = json(await env.call("GET", `/api/admin/exams?owner=${ids.teacherB}`, { cookie: admin })) as Json[];
    assert.deepEqual(examsOfB.map((e) => e.id), [ids.examB]);
  });

  test("a teacher cannot touch another teacher's exam (404) and cannot add foreign exercises", async () => {
    const calls: [Method, string, unknown?][] = [
      ["GET", `/api/admin/exams/${ids.examB}`],
      ["PUT", `/api/admin/exams/${ids.examB}`, { title: "Hackeado" }],
      ["PUT", `/api/admin/exams/${ids.examB}/exercises`, { exerciseIds: [] }],
      ["PUT", `/api/admin/exams/${ids.examB}/blocks`, { blocks: [] }],
      ["DELETE", `/api/admin/exams/${ids.examB}`],
      ["POST", `/api/admin/exams/${ids.examB}/duplicate`, {}],
      ["POST", `/api/admin/exams/${ids.examB}/draw-preview`, {}],
      ["GET", `/api/admin/exams/${ids.examB}/access`],
      ["PUT", `/api/admin/exams/${ids.examB}/access`, { emails: [] }],
      ["GET", `/api/admin/exams/${ids.examB}/overrides`],
      ["GET", `/api/admin/exams/${ids.examB}/analytics`],
      ["GET", `/api/admin/exams/${ids.examB}/results.csv`],
    ];
    for (const [method, url, payload] of calls) {
      assert.equal((await env.call(method, url, { cookie: teacherA, payload: payload ?? {} })).statusCode, 404, `${method} ${url}`);
    }
    const foreign = await env.call("PUT", `/api/admin/exams/${ids.examA}/blocks`, {
      cookie: teacherA,
      payload: { blocks: [{ title: "Mezcla", exercises: [{ exerciseId: ids.exA }, { exerciseId: ids.exB }] }] },
    });
    assert.equal(foreign.statusCode, 400);
    assert.equal(json(foreign).error.code, "UNKNOWN_EXERCISE");
    assert.equal((await env.call("PUT", `/api/admin/exams/${ids.examA}/exercises`, { cookie: teacherA, payload: { exerciseIds: [ids.exAdmin] } })).statusCode, 400);
    assert.equal((await env.call("POST", "/api/admin/exams", { cookie: teacherA, payload: { title: "Con ajeno", durationMinutes: 5, exerciseIds: [ids.exB] } })).statusCode, 400);
    // Admins may combine any exercises.
    const adminMix = await env.call("PUT", `/api/admin/exams/${ids.examA}/blocks`, {
      cookie: admin,
      payload: { blocks: [{ title: "Mezcla", exercises: [{ exerciseId: ids.exA }, { exerciseId: ids.exB }, { exerciseId: ids.exAdmin }] }] },
    });
    assert.equal(adminMix.statusCode, 200, adminMix.body);
    // ...and the teacher may keep the foreign exercises already in the exam when re-saving it.
    const resave = await env.call("PUT", `/api/admin/exams/${ids.examA}/blocks`, {
      cookie: teacherA,
      payload: { blocks: json(adminMix).blocks.map((b: Json) => ({ id: b.id, title: b.title, pickCount: null, shuffle: true, exercises: b.exercises.map((e: Json) => ({ exerciseId: e.exerciseId })) })) },
    });
    assert.equal(resave.statusCode, 200, resave.body);
    await env.call("PUT", `/api/admin/exams/${ids.examA}/blocks`, { cookie: admin, payload: { blocks: [{ title: "Ejercicios", exercises: [{ exerciseId: ids.exA }] }] } });
  });

  test("owner reassignment is admin-only and validated", async () => {
    const denied = await env.call("PUT", `/api/admin/exercises/${ids.exA}`, { cookie: teacherA, payload: { ownerId: ids.teacherB } });
    assert.equal(denied.statusCode, 403);
    assert.equal((await env.call("PUT", `/api/admin/exams/${ids.examA}`, { cookie: teacherA, payload: { ownerId: ids.teacherB } })).statusCode, 403);
    const student_ = json(await env.call("GET", "/api/auth/me", { cookie: student })).id;
    assert.equal(json(await env.call("PUT", `/api/admin/exercises/${ids.exA}`, { cookie: admin, payload: { ownerId: student_ } })).error.code, "INVALID_OWNER");

    const moved = await env.call("PATCH", `/api/admin/exercises/${ids.exAdmin}`, { cookie: admin, payload: { ownerId: ids.teacherB } });
    assert.equal(moved.statusCode, 200);
    assert.equal(json(moved).ownerId, ids.teacherB);
    assert.equal((await env.call("GET", `/api/admin/exercises/${ids.exAdmin}`, { cookie: teacherB })).statusCode, 200);
    assert.equal((await env.call("GET", `/api/admin/exercises/${ids.exAdmin}`, { cookie: admin })).statusCode, 200);
    const exam = await env.call("PUT", `/api/admin/exams/${ids.examA}`, { cookie: admin, payload: { ownerId: ids.teacherB } });
    assert.equal(json(exam).ownerId, ids.teacherB);
    assert.equal((await env.call("GET", `/api/admin/exams/${ids.examA}`, { cookie: teacherA })).statusCode, 404);
    assert.equal((await env.call("GET", `/api/admin/exams/${ids.examA}`, { cookie: teacherB })).statusCode, 200);
    // Put it back for the following tests.
    await env.call("PUT", `/api/admin/exams/${ids.examA}`, { cookie: admin, payload: { ownerId: ids.teacherA } });
  });

  test("results, attempts, stats and CSV are scoped to the teacher's own exams", async () => {
    const s2 = await env.register("est2@example.com", "Estudiante Dos");
    for (const [cookie, examId] of [[student, ids.examA], [s2, ids.examB]] as const) {
      const v = json(await env.call("POST", `/api/exams/${examId}/attempts`, { cookie, payload: { accepted: true } }));
      await env.call("POST", `/api/attempts/${v.id}/finish`, { cookie });
      ids[`att_${examId}`] = v.id;
    }
    const resA = json(await env.call("GET", "/api/admin/results", { cookie: teacherA }));
    assert.equal(resA.attempts.length, 1);
    assert.equal(resA.attempts[0].examId, ids.examA);
    assert.equal(json(await env.call("GET", "/api/admin/results", { cookie: admin })).attempts.length, 2);
    assert.equal(json(await env.call("GET", `/api/admin/results?examId=${ids.examB}`, { cookie: teacherA })).attempts.length, 0);

    assert.equal((await env.call("GET", `/api/admin/attempts/${ids[`att_${ids.examA}`]}`, { cookie: teacherA })).statusCode, 200);
    assert.equal((await env.call("GET", `/api/admin/attempts/${ids[`att_${ids.examB}`]}`, { cookie: teacherA })).statusCode, 404);
    assert.equal((await env.call("GET", `/api/admin/attempts/${ids[`att_${ids.examB}`]}`, { cookie: admin })).statusCode, 200);

    const statsA = json(await env.call("GET", "/api/admin/stats", { cookie: teacherA }));
    assert.equal(statsA.scope, "own");
    assert.equal(statsA.counts.attempts.total, 1);
    assert.equal(statsA.counts.students, 1);
    assert.equal(statsA.counts.teachers, null);
    assert.equal(statsA.counts.exams.total, 1);
    const statsAdmin = json(await env.call("GET", "/api/admin/stats", { cookie: admin }));
    assert.equal(statsAdmin.scope, "all");
    assert.equal(statsAdmin.counts.attempts.total, 2);
    assert.equal(statsAdmin.counts.teachers, 2);

    const csv = (await env.call("GET", "/api/admin/results.csv", { cookie: teacherA })).body;
    assert.ok(csv.includes("Estudiante Uno") && !csv.includes("Estudiante Dos"));
  });
});

describe("exercise bank", () => {
  let env: TestEnv;
  let admin: string;
  let teacher: string;
  const created: string[] = [];

  const json = (r: { json<T>(): T }) => r.json<Json>();

  before(async () => {
    env = await createTestEnv();
    admin = await env.login(ADMIN.email, ADMIN.password);
    teacher = await env.makeUser(admin, "banco@example.com", "teacher");
    const specs: [number, Json][] = [
      [1, { difficulty: "easy", tags: ["Suma", "basico", "suma"], estimatedMinutes: 5, category: "Aritmética" }],
      [2, { difficulty: "hard", tags: ["logica"], status: "draft", checks: [] }],
      [3, { difficulty: "medium", tags: ["suma", "avanzado"], title: "Totales 100%_especial" }],
    ];
    for (const [n, extra] of specs) {
      const r = await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: exerciseBody(n, extra) });
      assert.equal(r.statusCode, 201, r.body);
      created.push(json(r).id);
    }
  });
  after(() => env.close());

  test("bank fields: defaults, normalised tags and validation", async () => {
    const first = json(await env.call("GET", `/api/admin/exercises/${created[0]}`, { cookie: admin }));
    assert.equal(first.difficulty, "easy");
    assert.deepEqual(first.tags, ["suma", "basico"], "lowercased and deduplicated");
    assert.equal(first.estimatedMinutes, 5);
    assert.equal(first.category, "Aritmética");
    const plain = json(await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: exerciseBody(9) }));
    assert.equal(plain.difficulty, "medium");
    assert.deepEqual(plain.tags, []);
    assert.equal(plain.estimatedMinutes, null);
    assert.equal(plain.category, null);
    for (const bad of [{ difficulty: "impossible" }, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, { tags: ["x".repeat(31)] }, { estimatedMinutes: 0 }, { category: "" }]) {
      assert.equal((await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: exerciseBody(9, bad) })).statusCode, 400, JSON.stringify(bad));
    }
    const updated = json(await env.call("PUT", `/api/admin/exercises/${created[0]}`, { cookie: admin, payload: { difficulty: "hard", estimatedMinutes: null, tags: ["nuevo"] } }));
    assert.equal(updated.difficulty, "hard");
    assert.equal(updated.estimatedMinutes, null);
    assert.deepEqual(updated.tags, ["nuevo"]);
    await env.call("PUT", `/api/admin/exercises/${created[0]}`, { cookie: admin, payload: { difficulty: "easy", estimatedMinutes: 5, tags: ["suma", "basico"] } });
  });

  test("list: filters, usage counts, checksCount and pagination (bare array without page params)", async () => {
    const all = json(await env.call("GET", "/api/admin/exercises", { cookie: admin })) as Json[];
    assert.ok(Array.isArray(all));
    const first = all.find((e) => e.id === created[0])!;
    assert.equal(first.checksCount, 2);
    assert.equal(first.checkCount, 2);
    assert.equal(first.examCount, 0);
    assert.equal(first.attemptsCount, 0);

    const ids = (r: Json) => (r as Json[]).map((e) => e.id);
    assert.deepEqual(ids(json(await env.call("GET", "/api/admin/exercises?difficulty=hard", { cookie: admin }))), [created[1]]);
    assert.deepEqual(ids(json(await env.call("GET", "/api/admin/exercises?status=draft", { cookie: admin }))), [created[1]]);
    assert.deepEqual(new Set(ids(json(await env.call("GET", "/api/admin/exercises?tag=SUMA", { cookie: admin })))), new Set([created[0], created[2]]));
    assert.deepEqual(ids(json(await env.call("GET", "/api/admin/exercises?q=avanz", { cookie: admin }))), [created[2]], "q also searches tags");
    assert.deepEqual(ids(json(await env.call("GET", "/api/admin/exercises?q=100%25_esp", { cookie: admin }))), [created[2]], "LIKE wildcards are escaped");
    assert.equal((json(await env.call("GET", "/api/admin/exercises?q=%25", { cookie: admin })) as Json[]).length, 1, "a lone % matches only a literal %");

    const page = json(await env.call("GET", "/api/admin/exercises?page=1&pageSize=2", { cookie: admin }));
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 4);
    assert.equal(json(await env.call("GET", "/api/admin/exercises?page=2&pageSize=2", { cookie: admin })).items.length, 2);
    assert.equal((await env.call("GET", "/api/admin/exercises?pageSize=1000", { cookie: admin })).statusCode, 400);

    // Usage counts: add the exercise to an exam and to an attempt.
    const exam = json(await env.call("POST", "/api/admin/exams", { cookie: admin, payload: { title: "Uso", durationMinutes: 10, status: "published", exerciseIds: [created[0]] } }));
    const s = await env.register("uso@example.com");
    const v = json(await env.call("POST", `/api/exams/${exam.id}/attempts`, { cookie: s, payload: { accepted: true } }));
    assert.ok(v.id);
    const used = (json(await env.call("GET", "/api/admin/exercises", { cookie: admin })) as Json[]).find((e) => e.id === created[0])!;
    assert.equal(used.examCount, 1);
    assert.equal(used.attemptsCount, 1);
  });

  test("duplicate: draft copy owned by the caller", async () => {
    const copy = await env.call("POST", `/api/admin/exercises/${created[2]}/duplicate`, { cookie: admin });
    assert.equal(copy.statusCode, 201, copy.body);
    const c = json(copy);
    assert.equal(c.title, "Totales 100%_especial (copia)");
    assert.equal(c.status, "draft");
    assert.notEqual(c.id, created[2]);
    assert.deepEqual(c.tags, ["suma", "avanzado"]);
    assert.equal(c.checks.length, 2);
    assert.equal(c.difficulty, "medium");
    // A teacher cannot duplicate an exercise of someone else, but can duplicate and own their own.
    assert.equal((await env.call("POST", `/api/admin/exercises/${created[2]}/duplicate`, { cookie: teacher })).statusCode, 404);
    const own = json(await env.call("POST", "/api/admin/exercises", { cookie: teacher, payload: exerciseBody(5) }));
    const ownCopy = json(await env.call("POST", `/api/admin/exercises/${own.id}/duplicate`, { cookie: teacher }));
    assert.equal(ownCopy.ownerId, own.ownerId);
  });

  test("export then import round trip: drafts owned by the importer, per-item results", async () => {
    const exported = await env.call("POST", "/api/admin/exercises/export", { cookie: admin, payload: { ids: [created[0], created[2]] } });
    assert.equal(exported.statusCode, 200);
    const pack = json(exported);
    assert.equal(pack.format, "excellab.exercises");
    assert.equal(pack.exercises.length, 2);
    assert.ok(!JSON.stringify(pack).includes(created[0]!), "ids are not exported");
    const viaGet = json(await env.call("GET", `/api/admin/exercises/export?ids=${created[0]},${created[2]}`, { cookie: admin }));
    assert.equal(viaGet.exercises.length, 2);
    // A teacher exporting someone else's ids gets nothing.
    assert.equal(json(await env.call("POST", "/api/admin/exercises/export", { cookie: teacher, payload: { ids: [created[0]] } })).exercises.length, 0);
    assert.equal((await env.call("POST", "/api/admin/exercises/export", { cookie: admin, payload: { ids: [] } })).statusCode, 400);

    const items = [
      ...pack.exercises,
      { title: "Sin libro", checks: [] }, // missing workbook
      { title: "", workbook: exerciseBody(1).workbook }, // invalid title
      { title: "Libro roto", workbook: "nope", status: "published" },
    ];
    const imported = await env.call("POST", "/api/admin/exercises/import", { cookie: teacher, payload: { exercises: items } });
    assert.equal(imported.statusCode, 200, imported.body);
    const out = json(imported);
    assert.equal(out.imported, 2);
    assert.equal(out.failed, 3);
    assert.deepEqual(out.results.map((r: Json) => r.ok), [true, true, false, false, false]);
    assert.equal(out.results[2].error.code, "VALIDATION");
    assert.ok(out.results[2].error.fields.includes("workbook"));
    assert.equal(out.results[3].error.code, "VALIDATION");
    assert.ok(out.results[3].error.fields.includes("title"));
    assert.equal(out.results[4].error.code, "INVALID_WORKBOOK");
    const mine = (json(await env.call("GET", "/api/admin/exercises", { cookie: teacher })) as Json[]).filter((e) => e.title.startsWith("Ejercicio 1") || e.title.startsWith("Totales"));
    assert.equal(mine.length, 2);
    assert.ok(mine.every((e) => e.status === "draft"), "imports are always drafts");
    // A bare array is accepted too, and the size limit applies.
    assert.equal((await env.call("POST", "/api/admin/exercises/import", { cookie: teacher, payload: [pack.exercises[0]] })).statusCode, 200);
    assert.equal((await env.call("POST", "/api/admin/exercises/import", { cookie: teacher, payload: [] })).json<Json>().error.code, "IMPORT_SIZE");
    assert.equal((await env.call("POST", "/api/admin/exercises/import", { cookie: teacher, payload: { nope: 1 } })).statusCode, 400);
  });
});

// Used by other suites through the helpers; keeps CORRECT referenced for tree-shaking linters.
void CORRECT;

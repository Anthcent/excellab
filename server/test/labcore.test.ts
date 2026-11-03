import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* Loads src/lab-core.js the same way the browser does: a plain script that fills `globalThis.LabCore`. */
const path = fileURLToPath(new URL("../../src/lab-core.js", import.meta.url));
const holder: { LabCore?: any } = {};
new Function("globalThis", readFileSync(path, "utf8"))(holder);
const C = holder.LabCore;

test("routes: parsing, params, access levels and unknown paths", () => {
  assert.equal(C.matchRoute("#/practica").name, "practice");
  assert.equal(C.matchRoute("#/examenes").name, "exams");
  const exam = C.matchRoute("#/examenes/3f2a-bb");
  assert.deepEqual([exam.name, exam.params.id, exam.access], ["exam", "3f2a-bb", "user"]);
  assert.equal(C.matchRoute("#/intento/abc-123/").params.id, "abc-123");
  assert.equal(C.matchRoute("#/resultados").name, "results");
  assert.equal(C.matchRoute("#/admin/ejercicios/nuevo").name, "adminExerciseNew");
  assert.equal(C.matchRoute("#/admin/ejercicios/nuevo/hoja").name, "adminExerciseNewSheet");
  assert.equal(C.matchRoute("#/admin/ejercicios/ab12/hoja").params.id, "ab12");
  assert.equal(C.matchRoute("#/admin/examenes/xyz").access, "admin");
  assert.equal(C.matchRoute("#/admin/intentos/q1").name, "adminAttempt");
  assert.equal(C.matchRoute("#/admin/resultados?examId=a&userId=b").query.userId, "b");
  assert.equal(C.matchRoute("").name, "root");
  assert.equal(C.matchRoute("#/nada").name, "notFound");
  assert.equal(C.matchRoute("#/examenes/a b").name, "notFound");
});

test("safeNext only accepts internal app routes", () => {
  assert.equal(C.safeNext("#/examenes/abc"), "#/examenes/abc");
  assert.equal(C.safeNext("/examenes/abc"), "#/examenes/abc");
  assert.equal(C.safeNext("//evil.com"), null);
  assert.equal(C.safeNext("https://evil.com"), null);
  assert.equal(C.safeNext("javascript:alert(1)"), null);
  assert.equal(C.safeNext("#/login"), null);
  assert.equal(C.safeNext("#/desconocido"), null);
  assert.equal(C.safeNext(undefined), null);
});

test("deep links: ?exam=<id> wins, ?next= is validated", () => {
  const id = "0a1b2c3d-1111-2222-3333-444455556666";
  assert.equal(C.deepLinkTarget("?exam=" + id, ""), "#/examenes/" + id);
  assert.equal(C.deepLinkTarget("?exam=" + id + "&next=%23/resultados", ""), "#/examenes/" + id);
  assert.equal(C.deepLinkTarget("?next=%23%2Fresultados", ""), "#/resultados");
  assert.equal(C.deepLinkTarget("?next=/resultados", ""), "#/resultados");
  assert.equal(C.deepLinkTarget("?next=https://evil.com", ""), null);
  assert.equal(C.deepLinkTarget("?exam=<script>", ""), null);
  assert.equal(C.deepLinkTarget("", ""), null);
  assert.equal(C.loginHash("#/examenes/x"), "#/login?next=%23%2Fexamenes%2Fx");
  assert.equal(C.matchRoute(C.loginHash("#/examenes/x")).query.next, "#/examenes/x");
});

test("clock: offset from server time, remaining time never negative", () => {
  let local = 1_000_000;
  const clock = C.createClock(() => local);
  // Server says it is 5_000_000 ms; the request took 200 ms round trip (sent 1_000_000, received 1_000_200).
  assert.equal(clock.sync(new Date(5_000_000).toISOString(), 1_000_000, 1_000_200), true);
  assert.equal(clock.offset, 5_000_000 - 1_000_100);
  local = 1_000_200;
  assert.equal(clock.now(), 5_000_100);
  const deadline = new Date(5_000_000 + 10 * 60_000).toISOString();
  assert.equal(clock.remainingMs(deadline), 10 * 60_000 - 100);
  local += 11 * 60_000;
  assert.equal(clock.remainingMs(deadline), 0);
  assert.equal(clock.sync("not a date"), false);
  assert.equal(clock.remainingMs("nope"), 0);
});

test("clock: a wrong local clock is corrected by the server offset", () => {
  const localSkewed = 9_999_999_000; // the student's clock is far in the future
  const clock = C.createClock(() => localSkewed);
  clock.sync(new Date(2_000_000).toISOString(), localSkewed, localSkewed);
  assert.equal(clock.remainingMs(new Date(2_060_000).toISOString()), 60_000);
});

test("timer formatting and levels", () => {
  assert.equal(C.formatDuration(754_000), "12:34");
  assert.equal(C.formatDuration(3_725_000), "1:02:05");
  assert.equal(C.formatDuration(0), "00:00");
  assert.equal(C.formatDuration(-5), "00:00");
  assert.equal(C.formatDuration(59_100), "01:00"); // rounds up so it never shows 00:00 early
  assert.equal(C.timerLevel(10 * 60_000), "ok");
  assert.equal(C.timerLevel(300_000), "warn");
  assert.equal(C.timerLevel(60_000), "danger");
  assert.equal(C.timerLevel(1), "danger");
  assert.equal(C.timerLevel(0), "over");
});

test("autosaver: debounces, serializes, retries and flushes", async () => {
  const timers: { fn: () => void; ms: number }[] = [];
  const setT = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  const clearT = (id: number) => { const t = timers[id - 1]; if (t) t.fn = () => {}; };
  let saves = 0;
  let failNext = false;
  const errors: unknown[] = [];
  const saver = C.createAutosaver({
    delay: 2500, retryMs: 8000, setTimeout: setT, clearTimeout: clearT,
    save: async () => { saves++; if (failNext) { failNext = false; throw new Error("boom"); } },
    onError: (e: unknown) => errors.push(e),
  });
  saver.markDirty(); saver.markDirty(); saver.markDirty();
  assert.equal(saves, 0);
  assert.equal(timers.at(-1)!.ms, 2500);
  timers.at(-1)!.fn();
  await saver.flush();
  assert.equal(saves, 1);
  assert.equal(saver.dirty, false);

  failNext = true;
  saver.markDirty();
  await saver.flush(); // fails, stays dirty, schedules a retry
  assert.equal(errors.length, 1);
  assert.equal(saver.dirty, true);
  assert.equal(timers.at(-1)!.ms, 8000);
  await saver.flush();
  assert.equal(saver.dirty, false);
  assert.equal(saves, 3);

  saver.stop();
  saver.markDirty();
  assert.equal(saver.dirty, false);
});

test("autosaver: fatal errors stop retrying", async () => {
  const saver = C.createAutosaver({
    delay: 1, setTimeout: () => 1, clearTimeout: () => {},
    save: async () => { throw Object.assign(new Error("x"), { code: "ATTEMPT_EXPIRED" }); },
    fatal: (e: { code: string }) => e.code === "ATTEMPT_EXPIRED",
  });
  saver.markDirty();
  await saver.flush();
  saver.markDirty(); // ignored after a fatal error
  assert.equal(saver.dirty, true);
  let calls = 0;
  const second = C.createAutosaver({ delay: 1, setTimeout: () => 1, clearTimeout: () => {}, save: async () => { calls++; } });
  second.markDirty();
  await second.flush();
  assert.equal(calls, 1);
});

test("check rows <-> API payload round trip", () => {
  const checks = [
    { type: "cell_value", sheet: "Ventas", cell: "B8", expected: 600, tolerance: 0.5, ignoreCase: true, requireFormula: true, points: 7, label: "Total" },
    { type: "cell_value", cell: "A1", expected: "123", points: 1 },
    { type: "cell_value", cell: "A2", expected: true, points: 1 },
    { type: "cell_formula_uses", cell: "B8", functions: ["SUMA", "SI"], points: 3 },
    { type: "range_values", range: "C2:C3", expected: [["Aprobado"], [5.5]], points: 5, label: "Rango" },
  ];
  const rows = checks.map(C.checkToRow);
  assert.equal(rows[1].expected, '"123"'); // numeric-looking text keeps its quotes in the editor
  assert.equal(rows[2].expected, "VERDADERO");
  assert.equal(rows[3].functions, "SUMA, SI");
  const back = C.rowsToChecks(rows);
  assert.equal(back.ok, true);
  assert.deepEqual(back.checks, checks);
});

test("check rows: parsing of expected values and decimal commas", () => {
  assert.equal(C.parseScalar(" 12,5 "), 12.5);
  assert.equal(C.parseScalar("-3"), -3);
  assert.equal(C.parseScalar("verdadero"), true);
  assert.equal(C.parseScalar("FALSE"), false);
  assert.equal(C.parseScalar('"7"'), "7");
  assert.equal(C.parseScalar("Aprobado"), "Aprobado");
  const r = C.rowToCheck({ ...C.blankCheckRow("cell_value"), cell: "b8", expected: "1,5", tolerance: "0,01", points: "2,5" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.check, { type: "cell_value", cell: "B8", expected: 1.5, tolerance: 0.01, points: 2.5 });
});

test("check rows: validation messages", () => {
  const bad = C.rowToCheck({ ...C.blankCheckRow("cell_value"), cell: "8B", expected: "", points: "0" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.cell && bad.errors.expected && bad.errors.points);
  const fn = C.rowToCheck({ ...C.blankCheckRow("cell_formula_uses"), cell: "A1", functions: " , " });
  assert.ok(fn.errors.functions);
  const range = C.rowToCheck({ ...C.blankCheckRow("range_values"), range: "C2:C5", matrix: "1\n2", points: "1" });
  assert.match(range.errors.matrix, /4 fila/);
  const ragged = C.rowToCheck({ ...C.blankCheckRow("range_values"), range: "A1:B2", matrix: "1;2\n3", points: "1" });
  assert.match(ragged.errors.matrix, /misma cantidad/);
  const ok = C.rowToCheck({ ...C.blankCheckRow("range_values"), range: "a1:b2", matrix: "1 ; 2\n3\t4", points: "1" });
  assert.deepEqual(ok.check.expected, [[1, 2], [3, 4]]);
  assert.equal(ok.check.range, "A1:B2");
  assert.deepEqual(C.rangeDims("C2:C5"), { rows: 4, cols: 1 });
  assert.deepEqual(C.rangeDims("B2:A1"), { rows: 2, cols: 2 });
  assert.equal(C.rangeDims("nope"), null);
  const many = C.rowsToChecks([C.blankCheckRow("cell_value"), { ...C.blankCheckRow("cell_value"), cell: "A1", expected: "1" }]);
  assert.equal(many.ok, false);
  assert.equal(many.errors[0].index, 0);
  assert.equal(many.checks.length, 1);
});

test("auth forms validation", () => {
  assert.deepEqual(Object.keys(C.validateLogin({ email: "", password: "" })).sort(), ["email", "password"]);
  assert.deepEqual(C.validateLogin({ email: "a@b.co", password: "x" }), {});
  const r = C.validateRegister({ name: " ", email: "nope", password: "short", confirm: "other" });
  assert.deepEqual(Object.keys(r).sort(), ["confirm", "email", "name", "password"]);
  assert.match(r.password, /8 caracteres/);
  assert.match(r.confirm, /no coinciden/);
  assert.deepEqual(C.validateRegister({ name: "Ana", email: "ana@mail.com", password: "12345678", confirm: "12345678" }), {});
  assert.match(C.validateRegister({ name: "Ana", email: "ana@mail.com", password: "12345678", confirm: "1234567x" }).confirm, /no coinciden/);
});

test("exercise form validation and payload", () => {
  const errors = C.validateExerciseForm({ title: " ", points: "0", status: "x", instructions: "" });
  assert.deepEqual(Object.keys(errors).sort(), ["points", "status", "title"]);
  const form = { title: " Suma ", points: "10", status: "published", instructions: "Hazlo" };
  assert.deepEqual(C.validateExerciseForm(form), {});
  const payload = C.exerciseFormToPayload(form, [{ type: "cell_value" }], null);
  assert.deepEqual(payload, { title: "Suma", instructions: "Hazlo", points: 10, status: "published", checks: [{ type: "cell_value" }] });
  assert.ok("workbook" in C.exerciseFormToPayload(form, [], { name: "x", sheets: [] }));
});

test("exam form validation and payload mapping", () => {
  const form = C.examToForm({ title: "Parcial", durationMinutes: 45, maxAttempts: 2, pickCount: null, scale: 20, passPercent: 60, gradePolicy: "best", status: "draft", availableFrom: null, availableUntil: null });
  assert.equal(form.pickCount, "");
  assert.deepEqual(C.validateExamForm(form), {});
  const payload = C.examFormToPayload(form);
  assert.deepEqual(payload, { title: "Parcial", instructions: "", durationMinutes: 45, maxAttempts: 2, pickCount: null, scale: 20, passPercent: 60, gradePolicy: "best", status: "draft", availableFrom: null, availableUntil: null });
  const bad = C.validateExamForm({ ...form, title: "", durationMinutes: "0", maxAttempts: "21", pickCount: "1.5", scale: "-1", passPercent: "101", availableFrom: "2030-02-02T10:00", availableUntil: "2030-02-01T10:00" });
  assert.deepEqual(Object.keys(bad).sort(), ["availableUntil", "durationMinutes", "maxAttempts", "passPercent", "pickCount", "scale", "title"]);
  assert.equal(C.examFormToPayload({ ...form, pickCount: "5", scale: "10,5" }).pickCount, 5);
  assert.equal(C.examFormToPayload({ ...form, scale: "10,5" }).scale, 10.5);
});

test("datetime-local conversion round trips in local time", () => {
  const local = "2030-06-15T09:30";
  const iso = C.localInputToIso(local);
  assert.equal(C.isoToLocalInput(iso), local);
  assert.equal(C.localInputToIso(""), null);
  assert.equal(C.localInputToIso("garbage"), undefined);
  assert.equal(C.isoToLocalInput(null), "");
});

test("moveItem moves a copy and ignores out of range", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(C.moveItem(list, 0, 1), ["b", "a", "c"]);
  assert.deepEqual(C.moveItem(list, 2, 0), ["c", "a", "b"]);
  assert.deepEqual(C.moveItem(list, 0, -1), list);
  assert.deepEqual(C.moveItem(list, 1, 9), list);
  assert.deepEqual(list, ["a", "b", "c"]);
});

test("exam card states", () => {
  const base = { id: "1", window: "open", attemptsUsed: 0, attemptsRemaining: 2, inProgressAttemptId: null };
  assert.equal(C.examCardState(base).key, "available");
  assert.equal(C.examCardState(base).cta, "Comenzar");
  assert.equal(C.examCardState({ ...base, attemptsUsed: 1, attemptsRemaining: 1 }).cta, "Nuevo intento");
  const running = C.examCardState({ ...base, inProgressAttemptId: "a1" });
  assert.deepEqual([running.key, running.cta, running.resume], ["running", "Continuar", true]);
  assert.equal(C.examCardState({ ...base, attemptsRemaining: 0, attemptsUsed: 2 }).key, "no_attempts");
  assert.equal(C.examCardState({ ...base, window: "closed" }).canStart, false);
  assert.equal(C.examCardState({ ...base, window: "not_open" }).key, "not_open");
  // a running attempt can always be continued, even if the window closed meanwhile
  assert.equal(C.examCardState({ ...base, window: "closed", inProgressAttemptId: "a1" }).canStart, true);
});

test("error messages from API errors", () => {
  assert.match(C.errorMessage({ code: "NETWORK" }), /conectar/);
  assert.equal(C.errorMessage({ code: "EMAIL_TAKEN", message: "Ya existe una cuenta con ese correo." }), "Ya existe una cuenta con ese correo.");
  assert.equal(C.errorMessage({ code: "VALIDATION", message: "Revisa los datos ingresados.", fields: ["title", "checks.2.cell", "checks.2.points"] }), "Revisa estos datos: Título, Verificación 3: celda, Verificación 3: puntos.");
  assert.equal(C.describeField("durationMinutes"), "Duración");
  assert.equal(C.errorMessage({ code: "INTERNAL", message: "x" }), C.CODE_MESSAGES.INTERNAL);
  assert.equal(C.errorMessage(null), C.CODE_MESSAGES.INTERNAL);
});

test("number and grade formatting use Spanish decimals", () => {
  assert.equal(C.formatGrade(17.5, 20), "17,5 / 20");
  assert.equal(C.formatGrade(null, 20), "-");
  assert.equal(C.formatPercent(87.5), "87,5 %");
  assert.equal(C.formatNumber(3.456), "3,46");
});

test("workbookKey ignores the cursor position only", () => {
  const a = { name: "L", sheets: [{ name: "H", cells: { A1: { v: "1" } }, colW: {}, sel: { ar: 0, ac: 0, fr: 0, fc: 0 } }] };
  const b = JSON.parse(JSON.stringify(a));
  b.sheets[0].sel.ar = 5;
  assert.equal(C.workbookKey(a), C.workbookKey(b));
  b.sheets[0].cells.A1.v = "2";
  assert.notEqual(C.workbookKey(a), C.workbookKey(b));
});

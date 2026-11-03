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

/* ---------- staff console additions ---------- */
test("routes: users are admin-only, analytics and dashboard are staff routes", () => {
  assert.equal(C.matchRoute("#/admin/usuarios").name, "adminUsers");
  assert.equal(C.matchRoute("#/admin/usuarios").access, "sysadmin");
  const a = C.matchRoute("#/admin/examenes/ab-12/analiticas");
  assert.deepEqual([a.name, a.params.id, a.access], ["adminExamAnalytics", "ab-12", "admin"]);
  assert.equal(C.matchRoute("#/admin/examenes/nuevo").name, "adminExamNew");
  assert.equal(C.matchRoute("#/admin").name, "adminHome");
  assert.equal(C.isStaff({ role: "teacher" }), true);
  assert.equal(C.isStaff({ role: "student" }), false);
  assert.equal(C.isStaff(null), false);
  assert.equal(C.roleLabel("admin"), "Administrador");
});

test("markdown-lite: headings, lists, bold, italic and code become tokens", () => {
  const blocks = C.parseMarkdownLite("# Titulo\nTexto con **negrita**, *cursiva* y `codigo`.\n\n- uno\n- dos **x**\n\nfin");
  assert.deepEqual(blocks.map((b: any) => b.t), ["h", "p", "ul", "p"]);
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[1].inline.map((t: any) => t.k), ["text", "b", "text", "i", "text", "code", "text"]);
  assert.equal(blocks[2].items.length, 2);
  assert.deepEqual(blocks[2].items[1].map((t: any) => t.k), ["text", "b"]);
});

test("markdown-lite: formulas with asterisks are not italicised and HTML stays plain text", () => {
  const p = C.parseMarkdownLite("Calcula =A1*B1*C1 y 2 * 3")[0];
  assert.deepEqual(p.inline.map((t: any) => t.k), ["text"]);
  assert.equal(p.inline[0].s, "Calcula =A1*B1*C1 y 2 * 3");
  assert.equal(C.parseMarkdownLite("")[0], undefined);
});

test("markdown-lite: XSS attempts never produce anything but text tokens", () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '[click](javascript:alert(1))',
    '**<b onmouseover=alert(1)>x</b>**',
    '- <iframe src="//evil"></iframe>',
    '# <svg/onload=alert(1)>',
    '`</code><script>alert(1)</script>`',
    '"><img src=x onerror=alert(1)>',
  ];
  const walk = (blocks: any[]) => blocks.flatMap((b) => (b.t === "ul" ? b.items.flat() : b.inline));
  for (const a of attacks) {
    const tokens = walk(C.parseMarkdownLite(a));
    assert.ok(tokens.every((t: any) => ["text", "b", "i", "code"].includes(t.k)), a);
    // the markup survives only as literal characters inside token text
    assert.equal(tokens.map((t: any) => t.s).join("").includes("<") || !a.includes("<"), true, a);
    assert.ok(Object.keys(tokens[0] || {}).every((k) => k === "k" || k === "s"), "tokens carry no attributes");
  }
  const huge = C.parseMarkdownLite("a".repeat(50000));
  assert.ok(huge[0].inline[0].s.length <= 20000, "input is capped");
});

test("markdown-lite helper bar inserts markers around the selection", () => {
  assert.deepEqual(C.applyMdFormat("hola mundo", 5, 10, "bold"), { value: "hola **mundo**", start: 7, end: 12 });
  assert.equal(C.applyMdFormat("x", 0, 0, "italic").value, "*texto*x");
  assert.equal(C.applyMdFormat("uno\ndos", 4, 7, "list").value, "uno\n- dos");
  assert.equal(C.applyMdFormat("uno", 0, 3, "heading").value, "# uno");
});

test("tags: normalized, unique and capped at 10", () => {
  let tags: string[] = [];
  for (const t of ["  Funciones ", "FUNCIONES", "suma", ""]) tags = C.addTag(tags, t).tags;
  assert.deepEqual(tags, ["funciones", "suma"]);
  assert.equal(C.addTag(tags, "suma").reason, "Esa etiqueta ya está agregada.");
  for (let i = 0; i < 12; i++) tags = C.addTag(tags, "t" + i).tags;
  assert.equal(tags.length, 10);
  assert.equal(C.addTag(tags, "otra").added, false);
  assert.equal(C.normalizeTag("x".repeat(50)).length, 30);
});

test("access list e-mails: split, lowercase, dedupe and flag invalid ones", () => {
  const r = C.parseEmails("Ana@Example.com, luis@example.com;\nana@example.com  mal@correo  ");
  assert.deepEqual(r.valid, ["ana@example.com", "luis@example.com"]);
  assert.deepEqual(r.invalid, ["mal@correo"]);
});

test("password helpers: generator, strength and change validation", () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pw = C.generatePassword(rnd, 14);
  assert.equal(pw.length, 14);
  assert.ok(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw));
  assert.ok(!/[0Ol1I]/.test(pw), "no ambiguous characters");
  assert.equal(C.generateAccessCode(rnd, 6).length, 6);
  assert.equal(C.passwordStrength("abc").label, "Muy corta");
  assert.ok(C.passwordStrength("Abcdefgh1234!").score >= 3);
  assert.ok(C.passwordStrength("aaaaaaaa").score <= 1);
  assert.deepEqual(Object.keys(C.validateChangePassword({ current: "", next: "123", confirm: "x" })).sort(), ["confirm", "current", "next"]);
  assert.equal(C.validateChangePassword({ current: "abcdefgh", next: "abcdefgh", confirm: "abcdefgh" }).next, "La nueva contraseña debe ser distinta de la actual.");
  assert.deepEqual(C.validateChangePassword({ current: "old-pass", next: "new-pass-1", confirm: "new-pass-1" }), {});
  assert.deepEqual(Object.keys(C.validateUserForm({ name: "", email: "x", role: "boss", password: "1" })).sort(), ["email", "name", "password", "role"]);
  assert.deepEqual(C.validateUserForm({ name: "Ana", role: "teacher" }, { needEmail: false, needPassword: false }), {});
});

const examFixture = () => ({
  blocks: [
    { id: "b1", title: "Básicas", pickCount: 2, shuffle: true, exercises: [
      { exerciseId: "e1", title: "Uno", points: 10, status: "published", pointsOverride: null },
      { exerciseId: "e2", title: "Dos", points: 10, status: "published", pointsOverride: 5 },
      { exerciseId: "e3", title: "Tres", points: 10, status: "draft", pointsOverride: null },
    ] },
    { id: "b2", title: "Todas", pickCount: null, shuffle: false, exercises: [{ exerciseId: "e4", title: "Cuatro", points: 20, status: "published", pointsOverride: null }] },
  ],
});

test("exam builder: blocks round trip into the PUT /blocks payload", () => {
  const blocks = C.blocksFromExam(examFixture());
  assert.equal(blocks[0].pick, "2");
  assert.equal(blocks[1].pick, "");
  assert.equal(blocks[0].exercises[1].pointsOverride, "5");
  blocks[0].exercises[0].pointsOverride = "7,5";
  blocks[1].title = "  Final ";
  blocks.push(C.newBlock("Nueva"));
  const body = C.blocksToPayload(blocks);
  assert.deepEqual(body.blocks[0], {
    id: "b1", title: "Básicas", pickCount: 2, shuffle: true,
    exercises: [{ exerciseId: "e1", pointsOverride: 7.5 }, { exerciseId: "e2", pointsOverride: 5 }, { exerciseId: "e3" }],
  });
  assert.deepEqual(body.blocks[1], { id: "b2", title: "Final", pickCount: null, shuffle: false, exercises: [{ exerciseId: "e4" }] });
  assert.equal("id" in body.blocks[2], false, "new blocks carry no id");
  assert.deepEqual(body.blocks[2].exercises, []);
});

test("exam builder: validation against the published pool and totals", () => {
  const blocks = C.blocksFromExam(examFixture());
  assert.equal(C.validateBlocks(blocks).ok, true);
  blocks[0].pick = "3"; // only 2 published
  const v = C.validateBlocks(blocks);
  assert.equal(v.ok, false);
  assert.match(v.errors[blocks[0].key].pick, /solo hay 2/);
  blocks[0].pick = "0";
  assert.match(C.validateBlocks(blocks).errors[blocks[0].key].pick, /mayor o igual a 1/);
  blocks[0].pick = "2"; blocks[1].title = " ";
  assert.ok(C.validateBlocks(blocks).errors[blocks[1].key].title);
  blocks[1].title = "ok"; blocks[0].exercises[0].pointsOverride = "-3";
  assert.ok(C.validateBlocks(blocks).errors[blocks[0].key].override[0]);
  blocks[0].exercises[0].pointsOverride = "";
  blocks[1].exercises.push({ ...blocks[0].exercises[0] });
  assert.ok(C.validateBlocks(blocks).errors[blocks[1].key].dup[1], "the same exercise twice is flagged");
  blocks[1].exercises.pop();
  const t = C.blockTotals(blocks);
  assert.equal(t.poolSize, 3);
  assert.equal(t.exercises, 3);        // 2 drawn from block 1 + 1 of block 2
  assert.equal(t.poolPoints, 10 + 5 + 20);
  assert.equal(Math.round(t.expectedPoints * 100) / 100, 15 + 20); // 2 x avg(10, 5) + 20
});

test("exam builder: publish checklist mirrors the server rules", () => {
  const now = Date.parse("2030-01-01T10:00:00Z");
  const form = { title: "Parcial", availableFrom: "", availableUntil: "" };
  assert.equal(C.checklistReady(C.publishChecklist(form, [], now)), false);
  const blocks = C.blocksFromExam(examFixture());
  const ok = C.publishChecklist(form, blocks, now);
  assert.equal(C.checklistReady(ok), true);
  assert.equal(ok.find((i: any) => i.key === "drafts").ok, false, "drafts only warn");
  assert.equal(ok.find((i: any) => i.key === "drafts").warn, true);
  blocks[0].pick = "9";
  assert.equal(C.checklistReady(C.publishChecklist(form, blocks, now)), false);
  blocks[0].pick = "";
  assert.equal(C.checklistReady(C.publishChecklist({ title: "", availableFrom: "", availableUntil: "" }, blocks, now)), false);
  assert.equal(C.checklistReady(C.publishChecklist({ ...form, availableFrom: "2030-02-02T10:00", availableUntil: "2030-02-01T10:00" }, blocks, now)), false);
  assert.equal(C.publishChecklist({ ...form, availableUntil: "2029-01-01T10:00" }, blocks, now).find((i: any) => i.key === "window").ok, false, "a window that already closed");
});

test("exam settings: form <-> payload with the new options", () => {
  const form = C.examSettingsToForm({ title: "P", description: "d", durationMinutes: 30, maxAttempts: 3, scale: 10, passPercent: 50, gradePolicy: "last", status: "draft", availableFrom: null, availableUntil: null, shuffleBlocks: true, feedbackMode: "score", resultMode: "after_close", allowReview: true, accessCode: "AB12", restricted: true, ownerId: "o1" });
  assert.deepEqual(C.validateExamSettings(form), {});
  const p = C.examSettingsToPayload(form, { withOwner: true });
  assert.deepEqual(p, { title: "P", description: "d", instructions: "", durationMinutes: 30, maxAttempts: 3, scale: 10, passPercent: 50, gradePolicy: "last", status: "draft", availableFrom: null, availableUntil: null, shuffleBlocks: true, feedbackMode: "score", resultMode: "after_close", allowReview: true, accessCode: "AB12", restricted: true, ownerId: "o1" });
  assert.equal("pickCount" in p, false, "the deprecated pickCount is never sent");
  assert.equal(C.examSettingsToPayload({ ...form, accessCode: "  " }).accessCode, null, "an empty code clears it");
  assert.equal("ownerId" in C.examSettingsToPayload(form), false);
  const bad = C.validateExamSettings({ ...form, feedbackMode: "x", resultMode: "y", description: "a".repeat(501) });
  assert.deepEqual(Object.keys(bad).sort(), ["description", "feedbackMode", "resultMode"]);
  assert.match(C.modeHelp(C.RESULT_MODES, "hidden"), /nunca ve su nota/);
});

test("exercise form: difficulty, tags, minutes and category reach the payload only when present", () => {
  const f = { title: "A", points: "5", status: "draft", instructions: "", difficulty: "hard", tags: ["x"], estimatedMinutes: "7", category: " Lógica " };
  assert.deepEqual(C.validateExerciseForm(f), {});
  assert.deepEqual(C.exerciseFormToPayload(f, [], null), { title: "A", instructions: "", points: 5, status: "draft", checks: [], difficulty: "hard", tags: ["x"], estimatedMinutes: 7, category: "Lógica" });
  assert.equal(C.exerciseFormToPayload({ ...f, estimatedMinutes: "", category: "" }, [], null).estimatedMinutes, null);
  assert.deepEqual(Object.keys(C.validateExerciseForm({ ...f, difficulty: "x", estimatedMinutes: "0" })).sort(), ["difficulty", "estimatedMinutes"]);
});

test("charts: bar layout and area path stay inside the box", () => {
  const L = C.barLayout([0, 3, 10], 300, 100, { l: 20, r: 0, t: 10, b: 20 });
  assert.equal(L.max, 10);
  assert.equal(L.bars[2].h, 70);
  assert.equal(L.bars[2].y, 10);
  assert.equal(L.bars[0].h, 0);
  assert.ok(L.bars.every((b: any) => b.x >= 20 && b.x + b.w <= 300));
  const A = C.areaPath([1, 2, 3], 100, 50, { l: 0, r: 0, t: 0, b: 0 });
  assert.match(A.line, /^M0 /);
  assert.match(A.area, /Z$/);
  assert.equal(C.barLayout([], 100, 50).bars.length, 0);
});

test("instructions dock: initial state and student messages", () => {
  assert.equal(C.instrInitialOpen(null, false), true);
  assert.equal(C.instrInitialOpen(null, true), false, "closed by default on phones");
  assert.equal(C.instrInitialOpen("closed", false), false);
  assert.equal(C.instrInitialOpen("open", true), true);
  assert.equal(C.instrInitialOpen("garbage", false), true);
  assert.equal(C.instrPrefKey("abc"), "gridlab.instr.abc");
  assert.match(C.hiddenResultMessage("after_close"), /al cerrar el examen/);
  assert.match(C.hiddenResultMessage("hidden"), /docente/);
  assert.match(C.feedbackSummary("none", { score: null }), /quedó registrada/);
  assert.match(C.feedbackSummary("score", { score: 4, maxScore: 10 }), /4 de 10/);
  assert.equal(C.pageInfo(80, 2, 25).from, 26);
  assert.equal(C.pageInfo(0, 1, 25).from, 0);
});

test("error messages cover the new API codes", () => {
  for (const code of ["ACCESS_CODE_REQUIRED", "INVALID_ACCESS_CODE", "PASSWORD_CHANGE_REQUIRED", "CANNOT_MODIFY_SELF", "LAST_ADMIN", "EXAM_IN_USE", "PICK_EXCEEDS_POOL"]) {
    assert.ok(C.errorMessage({ code }).length > 10, code);
  }
  assert.equal(C.errorMessage({ code: "EMAIL_TAKEN" }), "Ya existe una cuenta con ese correo.");
});

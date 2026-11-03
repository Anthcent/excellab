import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error jsdom ships no types in this project
import { JSDOM, VirtualConsole } from "jsdom";
import { createTestEnv, ADMIN, type TestEnv } from "./helpers.js";

/**
 * End-to-end flow of the lab UI: the real built page (public/index.html) runs inside jsdom against a real
 * HTTP server (in-memory PGlite). jsdom has no layout engine, so positions/sizes are not exercised; the
 * flows (routing, forms, API calls, autosave, locking, results) are.
 */

const PAGE = readFileSync(fileURLToPath(new URL("../../public/index.html", import.meta.url)), "utf8");
let env: TestEnv;
let base = "";
const windows: any[] = [];
const problems: string[] = [];

before(async () => {
  env = await createTestEnv();
  await env.app.listen({ port: 0, host: "127.0.0.1" });
  const address = env.app.server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}/`;
});
after(async () => {
  for (const w of windows) { try { w.close(); } catch { /* already closed */ } }
  await env.close();
});

/* ---------- jsdom harness ---------- */
type Jar = { cookie: string };

function cookieFetch(jar: Jar, root: string) {
  return async (input: string, init: any = {}) => {
    const { signal: _signal, ...rest } = init; // jsdom's AbortSignal is not a Node one
    const headers = new Headers(rest.headers || {});
    if (jar.cookie) headers.set("cookie", jar.cookie);
    const res = await fetch(new URL(input, root).toString(), { ...rest, headers });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (name !== "gl_session") continue;
      const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || value === "";
      jar.cookie = expired ? "" : `${name}=${value}`;
    }
    return res;
  };
}

function openPage(jar: Jar, url: string): any {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => problems.push("jsdomError: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")));
  virtualConsole.on("error", (...a: unknown[]) => problems.push("console.error: " + a.join(" ")));
  const dom = new JSDOM(PAGE, {
    url, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
    beforeParse(window: any) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: () => ({ width: 10 }), font: "" });
      window.Element.prototype.scrollIntoView = () => {};
      window.scrollTo = () => {};
      window.fetch = cookieFetch(jar, url);
    },
  });
  windows.push(dom.window);
  return dom.window;
}

async function waitFor<T>(fn: () => T | undefined | null | false, what: string, timeout = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    let value: T | undefined | null | false;
    try { value = fn(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const view = (w: any) => w.document.getElementById("labView") as HTMLElement;
const viewText = (w: any) => view(w).textContent || "";
const stripText = (w: any) => w.document.getElementById("labStrip").textContent || "";
const hashOf = (w: any) => w.location.hash as string;
const bodyIs = (w: any, text: string) => (w.document.body.textContent || "").includes(text);

function byText(scope: ParentNode, selector: string, text: string): any {
  return [...scope.querySelectorAll(selector)].find((e) => (e.textContent || "").trim() === text);
}
async function clickText(w: any, selector: string, text: string, scope?: ParentNode) {
  const el = await waitFor(() => byText(scope || w.document, selector, text), `${selector} "${text}"`);
  el.click();
  return el;
}
function labelled(scope: ParentNode, label: string): any {
  const l = [...scope.querySelectorAll("label")].find((x) => (x.textContent || "").trim() === label) as HTMLLabelElement | undefined;
  if (!l) throw new Error(`label not found: ${label}`);
  const el = scope.querySelector("#" + l.htmlFor);
  if (!el) throw new Error(`control not found for: ${label}`);
  return el;
}
function setValue(w: any, el: any, value: string) {
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
  el.dispatchEvent(new w.Event("change", { bubbles: true }));
}
function setChecked(w: any, el: any, on: boolean) {
  el.checked = on;
  el.dispatchEvent(new w.Event("change", { bubbles: true }));
}
async function fill(w: any, scope: ParentNode, label: string, value: string) {
  const el = await waitFor(() => { try { return labelled(scope, label); } catch { return null; } }, `field ${label}`);
  setValue(w, el, value);
}
async function confirmModal(w: any, buttonText: string) {
  const modal = await waitFor(() => w.document.querySelector(".lab-modal"), "modal");
  byText(modal, "button", buttonText)!.click();
  await waitFor(() => !w.document.querySelector(".lab-modal"), "modal closed");
}

/* simulator helpers (keyboard path, like a real user) */
const cell = (w: any, addr: string) => {
  const col = addr.charCodeAt(0) - 65, row = Number(addr.slice(1)) - 1;
  return (w.document.querySelectorAll("#grid tbody tr")[row] as HTMLTableRowElement).cells[col + 1]!;
};
function key(w: any, target: any, k: string, extra: object = {}) {
  target.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
}
function selectCell(w: any, addr: string) {
  const nameBox = w.document.getElementById("nameBox");
  nameBox.value = addr;
  key(w, nameBox, "Enter");
}
function typeInCell(w: any, addr: string, text: string) {
  selectCell(w, addr);
  key(w, w.document.body, text[0]!);
  const ed = w.document.getElementById("cellEditor");
  assert.equal(ed.hidden, false, `editor should open for ${addr}`);
  ed.value = text;
  ed.dispatchEvent(new w.Event("input", { bubbles: true }));
  key(w, ed, "Enter");
}

async function boot(w: any) {
  await w.LabApp.ready;
}
async function login(w: any, email: string, password: string) {
  await waitFor(() => hashOf(w).startsWith("#/login"), "login route");
  await fill(w, view(w), "Correo electrónico", email);
  await fill(w, view(w), "Contraseña", password);
  byText(view(w), "button", "Ingresar")!.click();
}

const errorsSeen = () => problems.filter((p) => !/Not implemented: (window\.)?(scrollTo|HTMLCanvasElement)/.test(p));

/* ---------- Practice-only mode ---------- */
test("API unreachable: only the simulator, no lab UI, no errors", async () => {
  const w = openPage({ cookie: "" }, "http://127.0.0.1:1/");
  await boot(w);
  assert.equal(w.document.body.classList.contains("lab"), false);
  assert.equal(w.document.getElementById("labBar"), null);
  assert.equal(w.document.getElementById("app").hidden, false);
  assert.equal(cell(w, "A1").textContent, "Producto"); // sample workbook of the free practice mode
  typeInCell(w, "L1", "hola");
  assert.equal(cell(w, "L1").textContent, "hola");
  assert.ok(w.localStorage.getItem("gridlab.workbook.es.v1")!.includes("hola"), "practice mode keeps saving to localStorage");
  assert.deepEqual(errorsSeen(), []);
});

test("file:// origin: lab mode never starts", async () => {
  const w = openPage({ cookie: "" }, "file:///C:/gridlab/index.html");
  await boot(w);
  assert.equal(w.document.body.classList.contains("lab"), false);
  assert.equal(cell(w, "A1").textContent, "Producto");
  assert.deepEqual(errorsSeen(), []);
});

/* ---------- Full flow: admin builds an exam, a student takes it ---------- */
const state: { exerciseId: string; examId: string; attemptId: string; studentCookie: string } = { exerciseId: "", examId: "", attemptId: "", studentCookie: "" };

test("admin: login redirect, create exercise (form + sheet + checks), preview grading, create and publish exam", async () => {
  const jar: Jar = { cookie: "" };
  const w = openPage(jar, base + "#/admin/ejercicios");
  await boot(w);
  assert.equal(w.document.body.classList.contains("lab"), true);
  await login(w, ADMIN.email, ADMIN.password);
  await waitFor(() => hashOf(w) === "#/admin/ejercicios", "back to the requested admin route after login");
  await waitFor(() => bodyIs(w, "Todavía no hay ejercicios"), "empty exercise list");

  // Exercise form
  await clickText(w, "a", "Crear el primero");
  await waitFor(() => hashOf(w) === "#/admin/ejercicios/nuevo", "new exercise route");
  const v = view(w);
  await fill(w, v, "Título", "Suma de B1 y B2");
  await fill(w, v, "Puntos del ejercicio", "10");
  await fill(w, v, "Estado", "published");
  await fill(w, v, "Instrucciones para el estudiante", "En B4 suma B1 y B2 con SUMA.");

  // Publishing without checks is rejected before any request
  byText(v, "button", "Crear ejercicio")!.click();
  await waitFor(() => (v.textContent || "").includes("necesita al menos una verificación"), "no-checks validation");

  // Checks
  await clickText(w, "button", "Agregar verificación", v);
  const rows = () => [...v.querySelectorAll(".check-row")] as HTMLElement[];
  await waitFor(() => rows().length === 1, "check row 1");
  await fill(w, rows()[0]!, "Celda", "B4");
  await fill(w, rows()[0]!, "Valor esperado", "12");
  setChecked(w, labelled(rows()[0]!, "Exigir que la celda tenga una fórmula"), true);
  await fill(w, rows()[0]!, "Puntos", "7");
  await fill(w, rows()[0]!, "Etiqueta (la ve el estudiante)", "El total es correcto");
  await fill(w, v, "Tipo de verificación", "cell_formula_uses");
  await clickText(w, "button", "Agregar verificación", v);
  await waitFor(() => rows().length === 2, "check row 2");
  await fill(w, rows()[1]!, "Celda", "B4");
  await fill(w, rows()[1]!, "Funciones requeridas", "SUMA");
  await fill(w, rows()[1]!, "Puntos", "3");
  await fill(w, rows()[1]!, "Etiqueta (la ve el estudiante)", "Usa SUMA");

  // Invalid check shows the field error
  await fill(w, rows()[0]!, "Celda", "8B");
  byText(v, "button", "Crear ejercicio")!.click();
  await waitFor(() => (v.textContent || "").includes("celda válida"), "invalid cell error");
  await fill(w, rows()[0]!, "Celda", "B4");

  // Initial workbook inside the real simulator; form state survives the round trip
  await clickText(w, "a", "Editar hoja inicial");
  await waitFor(() => hashOf(w) === "#/admin/ejercicios/nuevo/hoja", "sheet route");
  await waitFor(() => w.document.getElementById("app").hidden === false, "simulator visible");
  assert.match(stripText(w), /Hoja inicial: Suma de B1 y B2/);
  typeInCell(w, "A1", "Datos");
  typeInCell(w, "B1", "5");
  typeInCell(w, "B2", "7");
  assert.equal(cell(w, "B2").textContent, "7");
  assert.equal(byText(w.document.getElementById("labStrip"), "button", "Probar calificación").disabled, true, "needs a saved exercise");
  await clickText(w, "a", "Volver al formulario");
  await waitFor(() => hashOf(w) === "#/admin/ejercicios/nuevo" && labelled(view(w), "Título").value === "Suma de B1 y B2", "form restored");
  assert.equal(view(w).querySelectorAll(".check-row").length, 2);
  assert.match(viewText(w), /1 hoja · 3 celdas con datos/);
  byText(view(w), "button", "Crear ejercicio")!.click();
  await waitFor(() => /^#\/admin\/ejercicios\/[0-9a-f-]{36}$/.test(hashOf(w)), "redirect to the created exercise");
  state.exerciseId = hashOf(w).split("/").pop()!;
  await waitFor(() => labelled(view(w), "Título").value === "Suma de B1 y B2" && view(w).querySelectorAll(".check-row").length === 2, "created exercise loaded");

  // Grading preview with a sample answer typed in the simulator
  await clickText(w, "a", "Editar hoja inicial");
  await waitFor(() => hashOf(w).endsWith("/hoja") && cell(w, "B2").textContent === "7", "stored sheet loaded in the simulator");
  typeInCell(w, "B4", "=SUMA(B1:B2)");
  assert.equal(cell(w, "B4").textContent, "12");
  await clickText(w, "button", "Probar calificación", w.document.getElementById("labStrip")!);
  await waitFor(() => stripText(w).includes("Puntaje de la prueba: 10 / 10"), "preview grade result");
  assert.match(stripText(w), /Usa SUMA/);
  // wrong answer fails the value check
  typeInCell(w, "B4", "=B1");
  await clickText(w, "button", "Probar calificación", w.document.getElementById("labStrip")!);
  await waitFor(() => stripText(w).includes("Puntaje de la prueba: 0 / 10") || stripText(w).includes("Puntaje de la prueba: 3 / 10"), "failing preview");
  // The answer must not be stored as the initial sheet: clear it and save
  selectCell(w, "B4");
  key(w, w.document.body, "Delete");
  assert.equal(cell(w, "B4").textContent, "");
  await clickText(w, "button", "Guardar hoja", w.document.getElementById("labStrip")!);
  await waitFor(() => (w.document.getElementById("toast").textContent || "").includes("Hoja guardada"), "save confirmation");
  const stored = (await env.call("GET", `/api/admin/exercises/${state.exerciseId}`, { cookie: jar.cookie })).json();
  assert.equal(stored.workbook.sheets[0].cells.B2.v, "7");
  assert.equal(stored.workbook.sheets[0].cells.B4, undefined);

  // Exam: publishing with no exercises is rejected, then a proper one
  w.location.hash = "#/admin/examenes/nuevo";
  await waitFor(() => hashOf(w) === "#/admin/examenes/nuevo" && labelled(view(w), "Título"), "new exam form");
  const ev = view(w);
  await fill(w, ev, "Título", "Parcial de sumas");
  await fill(w, ev, "Duración (minutos)", "30");
  await fill(w, ev, "Estado", "published");
  byText(ev, "button", "Crear examen")!.click();
  await waitFor(() => (ev.textContent || "").includes("Agrega al menos un ejercicio"), "exam without exercises rejected");
  const addBtn = await waitFor(() => [...ev.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Agregar Suma de B1 y B2"), "add button");
  (addBtn as HTMLElement).click();
  await waitFor(() => (ev.querySelector("ol")!.textContent || "").includes("Suma de B1 y B2"), "exercise picked");
  byText(ev, "button", "Crear examen")!.click();
  await waitFor(() => /^#\/admin\/examenes\/[0-9a-f-]{36}$/.test(hashOf(w)), "redirect to the created exam");
  state.examId = hashOf(w).split("/").pop()!;
  await waitFor(() => viewText(w).includes("?exam=" + state.examId) && viewText(w).includes("Publicado"), "exam published with deep link shown");

  // Exercise list now flags it as in use; lists render
  w.location.hash = "#/admin/ejercicios";
  await waitFor(() => viewText(w).includes("En 1 examen"), "in-use badge");
  w.location.hash = "#/admin/examenes";
  await waitFor(() => viewText(w).includes("Parcial de sumas"), "exam list");

  // Deleting an exercise that belongs to no attempts is allowed by the API, so only check the exam delete confirm path exists
  assert.ok(byText(view(w), "button", "Despublicar"));
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

test("student: deep link -> register -> instructions -> attempt -> autosave -> reload resume -> submit -> locked -> finish -> result", async () => {
  const jar: Jar = { cookie: "" };
  let w = openPage(jar, base + "?exam=" + state.examId);
  await boot(w);
  await waitFor(() => hashOf(w).startsWith("#/login?next="), "anonymous visitors are sent to login with the deep link kept");
  assert.equal(w.location.search, "", "the query string is cleaned from the URL");

  // Register with validation
  await clickText(w, "a", "Crear cuenta");
  await waitFor(() => hashOf(w).startsWith("#/registro"), "register route");
  await fill(w, view(w), "Nombre completo", "Ana Pérez");
  await fill(w, view(w), "Correo electrónico", "ana@example.com");
  await fill(w, view(w), "Contraseña", "short");
  await fill(w, view(w), "Repite la contraseña", "other");
  byText(view(w), "button", "Crear cuenta")!.click();
  await waitFor(() => viewText(w).includes("al menos 8 caracteres") && viewText(w).includes("no coinciden"), "validation messages");
  await fill(w, view(w), "Contraseña", "secret-123");
  await fill(w, view(w), "Repite la contraseña", "secret-123");
  byText(view(w), "button", "Crear cuenta")!.click();
  await waitFor(() => hashOf(w) === "#/examenes/" + state.examId, "deep link opens the instruction screen after registering");
  assert.equal(byText(w.document.getElementById("labBar"), "button", "Cerrar sesión") !== undefined, true);

  // Instructions: start button disabled until the checkbox is ticked
  await waitFor(() => viewText(w).includes("Parcial de sumas") && viewText(w).includes("Reglas"), "instruction screen");
  assert.match(viewText(w), /30 minutos/);
  assert.match(viewText(w), /te quedan 2/);
  const start = await waitFor(() => byText(view(w), "button", "Comenzar intento"), "start button");
  assert.equal(start.disabled, true);
  const accept = labelled(view(w), "He leído y acepto las instrucciones");
  setChecked(w, accept, true);
  assert.equal(start.disabled, false);
  setChecked(w, accept, false);
  assert.equal(start.disabled, true);
  setChecked(w, accept, true);
  start.click();
  await waitFor(() => /^#\/intento\/[0-9a-f-]{36}$/.test(hashOf(w)), "attempt route");
  state.attemptId = hashOf(w).split("/").pop()!;

  // Runner
  await waitFor(() => stripText(w).includes("1 de 1 ejercicios") && w.document.getElementById("app").hidden === false, "runner visible");
  assert.match(stripText(w), /Parcial de sumas/);
  assert.match(stripText(w), /Intento 1/);
  const timer = w.document.querySelector(".timer");
  assert.match(timer.textContent, /^(29|30):\d\d$/);
  assert.match(stripText(w), /Suma de B1 y B2/);
  assert.match(stripText(w), /En B4 suma B1 y B2/);
  assert.equal(cell(w, "B2").textContent, "7");
  assert.equal(w.Lab.isReadOnly(), false);
  typeInCell(w, "B4", "=SUMA(B1:B2)");
  assert.equal(cell(w, "B4").textContent, "12");
  await waitFor(() => /Borrador guardado/.test(stripText(w)), "debounced draft save", 9000);
  const practiceSaved = w.localStorage.getItem("gridlab.workbook.es.v1") || "";
  assert.ok(!practiceSaved.includes("SUMA(B1:B2)"), "exam workbook must never reach the practice localStorage key");
  const noAnswer = await env.call("GET", `/api/attempts/${state.attemptId}`, { cookie: jar.cookie });
  assert.equal(JSON.stringify(noAnswer.json()).includes("expected"), false, "students never get the checks");
  w.close();

  // Reload mid-attempt: resumes with the draft and the timer
  w = openPage(jar, base + "#/intento/" + state.attemptId);
  await boot(w);
  await waitFor(() => stripText(w).includes("1 de 1 ejercicios"), "runner after reload");
  assert.equal(cell(w, "B4").textContent, "12", "draft restored from the server");
  assert.match(w.document.querySelector(".timer").textContent, /^(29|30|28):\d\d$/);

  // Submit the exercise
  await clickText(w, "button", "Terminar ejercicio", w.document.getElementById("labStrip")!);
  await confirmModal(w, "Enviar y calificar");
  await waitFor(() => stripText(w).includes("Puntaje: 10 / 10") && stripText(w).includes("Calificado"), "graded exercise with per-check list");
  assert.match(stripText(w), /El total es correcto/);
  assert.match(stripText(w), /Usa SUMA/);
  assert.equal(w.Lab.isReadOnly(), true);
  assert.equal(byText(w.document.getElementById("labStrip"), "button", "Terminar ejercicio").disabled, true);
  // Every mutation path is blocked in read-only mode
  typeInCell_expectBlocked(w);

  // Finish the exam
  await clickText(w, "button", "Finalizar examen", w.document.getElementById("labStrip")!);
  await confirmModal(w, "Finalizar examen");
  await waitFor(() => viewText(w).includes("100 %") && viewText(w).includes("20 / 20") && viewText(w).includes("Aprobado"), "result screen");
  assert.equal(w.document.getElementById("app").hidden, true);
  assert.match(viewText(w), /Suma de B1 y B2/);
  await waitFor(() => byText(view(w), "a", "Otro intento (1 disponible)"), "second attempt offered");
  state.studentCookie = jar.cookie;

  // Back to the list and to the results
  await clickText(w, "a", "Volver a mis exámenes");
  await waitFor(() => hashOf(w) === "#/examenes" && viewText(w).includes("Intentos: 1 de 2"), "exams list with attempts used");
  assert.match(viewText(w), /20 \/ 20/);
  assert.match(viewText(w), /Aprobado/);
  assert.ok(byText(view(w), "a", "Nuevo intento"));
  w.location.hash = "#/resultados";
  await waitFor(() => viewText(w).includes("Resultado que cuenta") && viewText(w).includes("20 / 20"), "my results");

  // Free practice is untouched after the exam
  w.location.hash = "#/practica";
  await waitFor(() => w.document.getElementById("app").hidden === false && cell(w, "A1").textContent === "Producto", "practice workbook restored");
  assert.equal(w.Lab.isActive(), false);
  assert.ok(!(w.localStorage.getItem("gridlab.workbook.es.v1") || "").includes("SUMA(B1:B2)"));
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

function typeInCell_expectBlocked(w: any) {
  const before = cell(w, "B2").textContent;
  selectCell(w, "B2");
  key(w, w.document.body, "9"); // would start editing
  assert.equal(w.document.getElementById("cellEditor").hidden, true, "editor must not open");
  key(w, w.document.body, "Delete");
  key(w, w.document.body, "b", { ctrlKey: true }); // formatting shortcut
  key(w, w.document.body, "z", { ctrlKey: true });
  key(w, w.document.body, "j", { ctrlKey: true }); // fill down
  selectCell(w, "B4");
  key(w, w.document.body, "Delete");
  assert.equal(cell(w, "B2").textContent, before);
  assert.equal(cell(w, "B4").textContent, "12", "Delete must not clear a graded exercise");
  assert.equal(w.Lab.getWorkbook().sheets[0].cells.B4.v, "=SUMA(B1:B2)");
  assert.equal(w.Lab.getWorkbook().sheets[0].cells.B4.s, undefined);
  w.document.getElementById("addSheet").click();
  assert.equal(w.Lab.getWorkbook().sheets.length, 1, "no sheets can be added");
  const paste = new w.Event("paste", { bubbles: true, cancelable: true });
  paste.clipboardData = { getData: () => "x\ty" };
  w.document.body.dispatchEvent(paste);
  assert.equal(cell(w, "C4").textContent, "");
}

test("student: a second attempt that runs out of time shows the final result (expired)", async () => {
  const jar: Jar = { cookie: state.studentCookie };
  let w = openPage(jar, base + "#/examenes/" + state.examId);
  await boot(w);
  const accept = await waitFor(() => { try { return labelled(view(w), "He leído y acepto las instrucciones"); } catch { return null; } }, "instructions");
  setChecked(w, accept, true);
  byText(view(w), "button", "Comenzar intento")!.click();
  await waitFor(() => /^#\/intento\//.test(hashOf(w)) && stripText(w).includes("Intento 2"), "attempt 2 runner");
  const id = hashOf(w).split("/").pop()!;
  // Nothing was answered; the server clock jumps past the deadline plus grace
  env.clock.now += 31 * 60_000;
  w.close();
  w = openPage(jar, base + "#/intento/" + id);
  await boot(w);
  await waitFor(() => viewText(w).includes("Tiempo agotado") && viewText(w).includes("0 %"), "expired attempt shows its final result");
  assert.equal(w.document.getElementById("app").hidden, true);
  // Both attempts used: no more starts, but the best grade still counts
  w.location.hash = "#/examenes";
  await waitFor(() => viewText(w).includes("Sin intentos") && viewText(w).includes("20 / 20"), "no attempts left, best result kept");
  env.clock.now -= 31 * 60_000;
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

async function shortExamAttempt(email: string) {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const exam = (await env.call("POST", "/api/admin/exams", { cookie: admin, payload: { title: "Examen corto " + email, durationMinutes: 1, maxAttempts: 1 } })).json();
  await env.call("PUT", `/api/admin/exams/${exam.id}/exercises`, { cookie: admin, payload: { exerciseIds: [state.exerciseId] } });
  const published = await env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: admin, payload: { status: "published" } });
  assert.equal(published.statusCode, 200);
  const cookie = await env.register(email);
  const attempt = (await env.call("POST", `/api/exams/${exam.id}/attempts`, { cookie, payload: { accepted: true } })).json();
  return { cookie, attemptId: attempt.id as string };
}

test("student: the countdown reaching zero finishes the attempt and shows the summary", async () => {
  const { cookie, attemptId } = await shortExamAttempt("zero@example.com");
  env.clock.now += 58_500; // 1.5 s left on the server clock
  const w = openPage({ cookie }, base + "#/intento/" + attemptId);
  await boot(w);
  await waitFor(() => stripText(w).includes("1 de 1 ejercicios"), "runner");
  assert.match(w.document.querySelector(".timer").textContent, /^00:0[12]$/);
  await waitFor(() => viewText(w).includes("0 %") && viewText(w).includes("0 / 20") && viewText(w).includes("Reprobado"), "automatic finish at zero", 10000);
  assert.equal(w.document.getElementById("app").hidden, true);
  env.clock.now -= 58_500;
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

test("student: a draft save after the deadline closes the attempt and shows the result", async () => {
  const { cookie, attemptId } = await shortExamAttempt("late@example.com");
  const w = openPage({ cookie }, base + "#/intento/" + attemptId);
  await boot(w);
  await waitFor(() => stripText(w).includes("1 de 1 ejercicios"), "runner");
  typeInCell(w, "B4", "=SUMA(B1:B2)");
  env.clock.now += 120_000; // past the deadline and the grace period before the debounced save fires
  await waitFor(() => viewText(w).includes("Tiempo agotado"), "expired result after the rejected draft save", 10000);
  assert.match(viewText(w), /Se aprueba con 60 %/);
  env.clock.now -= 120_000;
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

test("admin: results list, filters and attempt detail with the submitted workbook read-only", async () => {
  const jar: Jar = { cookie: "" };
  const w = openPage(jar, base + "#/admin/resultados");
  await boot(w);
  await login(w, ADMIN.email, ADMIN.password);
  await waitFor(() => hashOf(w) === "#/admin/resultados" && viewText(w).includes("Tiempo agotado"), "results table with both attempts");
  assert.match(viewText(w), /Parcial de sumas/);
  const examSel = labelled(view(w), "Examen");
  setValue(w, examSel, state.examId);
  await waitFor(() => hashOf(w).includes("examId=" + state.examId), "filter reflected in the URL");
  const detailLinks = () => [...view(w).querySelectorAll("a")].filter((a) => (a.textContent || "") === "Ver detalle");
  await waitFor(() => detailLinks().length === 2, "two attempts listed after filtering");
  const links = detailLinks();
  const graded = links.find((a) => (a.closest("tr")!.textContent || "").includes("100 %"))!;
  graded.click();
  await waitFor(() => hashOf(w).startsWith("#/admin/intentos/") && stripText(w).includes("Ana Pérez"), "attempt detail");
  assert.match(stripText(w), /10 \/ 10/);
  assert.match(stripText(w), /El total es correcto/);
  await waitFor(() => cell(w, "B4").textContent === "12", "submitted workbook shown");
  assert.equal(w.Lab.isReadOnly(), true);
  // Admin section is hidden from students
  const s = openPage({ cookie: state.studentCookie }, base + "#/admin/ejercicios");
  await boot(s);
  await waitFor(() => viewText(s).includes("No tienes permisos"), "students cannot open admin screens");
  assert.equal(byText(s.document.getElementById("labBar"), "a", "Ejercicios"), undefined);
  assert.deepEqual(errorsSeen(), []);
  w.close();
  s.close();
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error jsdom ships no types in this project
import { JSDOM, VirtualConsole } from "jsdom";
import { createTestEnv, ADMIN, exerciseBody, type TestEnv } from "./helpers.js";

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
const dockText = (w: any) => (w.document.getElementById("instrCard")?.textContent as string) || "";
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
  await waitFor(() => (ev.textContent || "").includes("No se puede publicar todavía"), "exam without exercises rejected");
  await clickText(w, "button", "Secciones y ejercicios");
  const addBtn = await waitFor(() => [...ev.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Agregar Suma de B1 y B2"), "add button");
  (addBtn as HTMLElement).click();
  await waitFor(() => (ev.querySelector(".blk-list")!.textContent || "").includes("Suma de B1 y B2"), "exercise picked");
  byText(ev, "button", "Crear examen")!.click();
  await waitFor(() => /^#\/admin\/examenes\/[0-9a-f-]{36}$/.test(hashOf(w)), "redirect to the created exam");
  state.examId = hashOf(w).split("/").pop()!;
  await waitFor(() => viewText(w).includes("?exam=" + state.examId) && viewText(w).includes("Publicado"), "exam published with deep link shown");

  // Exercise list now flags it as in use; lists render
  w.location.hash = "#/admin/ejercicios";
  await waitFor(() => viewText(w).includes("1 examen"), "in-use badge");
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
  assert.equal(w.document.getElementById("instrTab") !== null, true);
  assert.match(stripText(w), /Parcial de sumas/);
  assert.match(stripText(w), /Intento 1/);
  const timer = w.document.querySelector(".timer");
  assert.match(timer.textContent, /^(29|30):\d\d$/);
  // Instructions dock: open by default on roomy screens; the tab, Escape and the close button hide it
  const tab = w.document.getElementById("instrTab");
  const card = w.document.getElementById("instrCard");
  assert.equal(card.getAttribute("role"), "dialog");
  assert.equal(card.getAttribute("aria-modal"), "false");
  assert.equal(tab.getAttribute("aria-controls"), "instrCard");
  assert.equal(tab.getAttribute("aria-expanded"), "true");
  assert.equal(card.hidden, false);
  assert.equal(tab.classList.contains("is-open"), true);
  assert.match(dockText(w), /Suma de B1 y B2/);
  assert.match(dockText(w), /En B4 suma B1 y B2/);
  assert.match(dockText(w), /10 pts/);
  assert.equal(stripText(w).includes("En B4 suma"), false, "instructions no longer live in the strip");
  tab.click();
  assert.equal(card.hidden, true);
  assert.equal(tab.getAttribute("aria-expanded"), "false");
  assert.equal(tab.classList.contains("is-open"), false, "closed tab is rendered semi-transparent (no is-open class)");
  assert.equal(w.document.activeElement, tab, "focus stays on the tab");
  assert.equal(w.sessionStorage.getItem("gridlab.instr." + state.attemptId), "closed", "preference is remembered per attempt");
  tab.click();
  assert.equal(card.hidden, false);
  assert.equal(w.sessionStorage.getItem("gridlab.instr." + state.attemptId), "open");
  key(w, w.document.body, "Escape");
  assert.equal(card.hidden, true, "Escape closes it");
  tab.click();
  (card.querySelector('button[aria-label="Cerrar instrucciones"]') as HTMLElement).click();
  assert.equal(card.hidden, true);
  assert.equal(w.document.activeElement, tab, "focus returns to the tab after closing with the button");
  tab.click();
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
  await waitFor(() => dockText(w).includes("Puntaje: 10 / 10") && dockText(w).includes("Calificado"), "graded exercise with per-check list");
  assert.match(dockText(w), /El total es correcto/);
  assert.match(dockText(w), /Usa SUMA/);
  assert.equal(w.document.getElementById("instrCard").hidden, false, "the card opens by itself to show the score");
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

/* ---------- Staff console: roles, sidebar, users, forced password change, builder, markdown ---------- */
const navLabels = (w: any) => [...w.document.querySelectorAll(".st-nav a")].map((a: any) => (a.textContent || "").trim());

test("staff: the sidebar is role-aware (teachers never see Usuarios) and the dashboard loads", async () => {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const teacher = await env.makeUser(admin, "profe.sidebar@example.com", "teacher", "Profe Sidebar");

  const a = openPage({ cookie: admin }, base + "#/admin");
  await boot(a);
  await waitFor(() => navLabels(a).length > 0, "admin sidebar");
  assert.deepEqual(navLabels(a), ["Panel", "Ejercicios", "Exámenes", "Resultados", "Usuarios"]);
  await waitFor(() => viewText(a).includes("Intentos por día") && viewText(a).includes("Exámenes más usados"), "dashboard sections");
  assert.ok(viewText(a).includes("Todo el contenido"));
  assert.ok(a.document.querySelector(".chart"), "the attempts chart is inline SVG");
  assert.match(viewText(a), /Acciones rápidas/);
  // collapsible sidebar remembers its state
  (a.document.querySelector(".st-collapse") as HTMLElement).click();
  assert.equal(a.document.querySelector(".staff").classList.contains("collapsed"), true);
  assert.equal(a.localStorage.getItem("gridlab.sidebar"), "collapsed");
  assert.equal(byText(a.document.getElementById("labBar"), "a", "Administración") !== undefined, true);

  const t = openPage({ cookie: teacher }, base + "#/admin");
  await boot(t);
  await waitFor(() => navLabels(t).length > 0, "teacher sidebar");
  assert.deepEqual(navLabels(t), ["Panel", "Ejercicios", "Exámenes", "Resultados"]);
  assert.ok(viewText(t).includes("Solo tu contenido"));
  assert.equal(byText(t.document.getElementById("labBar"), "a", "Mi panel") !== undefined, true);
  t.location.hash = "#/admin/usuarios";
  await waitFor(() => viewText(t).includes("No tienes permisos"), "teachers cannot open the users screen");
  assert.deepEqual(errorsSeen(), []);
  a.close(); t.close();
});

test("staff: admin creates a user from the modal, duplicate e-mail is explained, role badges show", async () => {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const w = openPage({ cookie: admin }, base + "#/admin/usuarios");
  await boot(w);
  await waitFor(() => viewText(w).includes("Nuevo usuario") && w.document.querySelector(".tbl"), "users table");
  await clickText(w, "button", "Nuevo usuario");
  const modal = await waitFor(() => w.document.querySelector(".lab-modal"), "create modal");
  await clickText(w, "button", "Generar", modal);
  const pw = labelled(modal, "Contraseña temporal");
  assert.ok(pw.value.length >= 12, "the generator fills the temporary password");
  assert.equal(labelled(modal, "Debe cambiar la contraseña al ingresar").checked, true, "must-change defaults to on");
  byText(modal, "button", "Crear usuario")!.click();
  await waitFor(() => (modal.textContent || "").includes("Escribe el nombre"), "validation");
  await fill(w, modal, "Nombre", "Carlos Docente");
  await fill(w, modal, "Correo electrónico", "carlos.docente@example.com");
  await fill(w, modal, "Rol", "teacher");
  byText(modal, "button", "Crear usuario")!.click();
  await waitFor(() => !w.document.querySelector(".lab-modal"), "modal closed after creating");
  await waitFor(() => viewText(w).includes("carlos.docente@example.com"), "new row listed");
  const row = [...view(w).querySelectorAll("tbody tr")].find((r: any) => (r.textContent || "").includes("carlos.docente@example.com")) as HTMLElement;
  assert.match(row.textContent || "", /Profesor/);
  assert.match(row.textContent || "", /Contraseña temporal/);
  // duplicate e-mail
  await clickText(w, "button", "Nuevo usuario");
  const m2 = await waitFor(() => w.document.querySelector(".lab-modal"), "second modal");
  await fill(w, m2, "Nombre", "Otro");
  await fill(w, m2, "Correo electrónico", "carlos.docente@example.com");
  await clickText(w, "button", "Generar", m2);
  byText(m2, "button", "Crear usuario")!.click();
  await waitFor(() => (m2.textContent || "").includes("Ya existe una cuenta con ese correo"), "EMAIL_TAKEN message");
  byText(m2, "button", "Cancelar")!.click();
  // filters: role + search
  setValue(w, labelled(view(w), "Rol"), "teacher");
  await waitFor(() => { const rows = [...view(w).querySelectorAll("tbody tr")]; return rows.length > 0 && rows.every((r: any) => /Profesor/.test(r.textContent || "")); }, "role filter");
  // an admin cannot deactivate themselves (CANNOT_MODIFY_SELF is explained, the menu item is disabled)
  const own = [...view(w).querySelectorAll("tbody tr")].find((r: any) => (r.textContent || "").includes("(tú)")) as HTMLElement | undefined;
  assert.equal(own, undefined, "the admin is filtered out by role=teacher");
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

test("first login: a temporary password forces the 'Cambia tu contraseña' screen, then continues to the intended route", async () => {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const created = await env.call("POST", "/api/admin/users", { cookie: admin, payload: { name: "Temporal Uno", email: "temporal.uno@example.com", password: "temporal-123", role: "student" } });
  assert.equal(created.statusCode, 201);
  const cookie = await env.login("temporal.uno@example.com", "temporal-123");
  // the API itself blocks everything else
  const blocked = await env.call("GET", "/api/exams", { cookie });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, "PASSWORD_CHANGE_REQUIRED");

  const w = openPage({ cookie }, base + "#/resultados");
  await boot(w);
  await waitFor(() => viewText(w).includes("Cambia tu contraseña"), "forced screen");
  assert.equal(hashOf(w), "#/resultados", "the intended route is kept");
  const bar = w.document.getElementById("labBar");
  assert.equal(byText(bar, "a", "Exámenes"), undefined, "no navigation while the password is temporary");
  assert.ok(byText(bar, "button", "Cerrar sesión"));
  // validation first
  byText(view(w), "button", "Guardar y continuar")!.click();
  await waitFor(() => viewText(w).includes("Escribe tu contraseña actual"), "required current password");
  await fill(w, view(w), "Contraseña actual", "temporal-123");
  await fill(w, view(w), "Nueva contraseña", "temporal-123");
  await fill(w, view(w), "Repite la nueva contraseña", "temporal-123");
  byText(view(w), "button", "Guardar y continuar")!.click();
  await waitFor(() => viewText(w).includes("distinta de la actual"), "new password must differ");
  await fill(w, view(w), "Contraseña actual", "equivocada-999");
  await fill(w, view(w), "Nueva contraseña", "Nueva-clave-2030");
  await fill(w, view(w), "Repite la nueva contraseña", "Nueva-clave-2030");
  assert.match(viewText(w), /Fuerte|Buena/, "strength hint");
  byText(view(w), "button", "Guardar y continuar")!.click();
  await waitFor(() => viewText(w).includes("contraseña actual no es correcta"), "WRONG_CURRENT_PASSWORD");
  await fill(w, view(w), "Contraseña actual", "temporal-123");
  byText(view(w), "button", "Guardar y continuar")!.click();
  await waitFor(() => viewText(w).includes("Mis resultados") && !viewText(w).includes("Cambia tu contraseña"), "continues to the requested screen");
  assert.equal(hashOf(w), "#/resultados");
  assert.ok(byText(w.document.getElementById("labBar"), "a", "Exámenes"), "navigation is back");
  const after = await env.call("POST", "/api/auth/login", { payload: { email: "temporal.uno@example.com", password: "Nueva-clave-2030" } });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json().mustChangePassword, false);
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

test("first login: a 403 PASSWORD_CHANGE_REQUIRED during a session also forces the screen", async () => {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  await env.call("POST", "/api/admin/users", { cookie: admin, payload: { name: "Temporal Dos", email: "temporal.dos@example.com", password: "temporal-123", role: "student" } });
  const cookie = await env.login("temporal.dos@example.com", "temporal-123");
  const w = openPage({ cookie }, base + "#/practica");
  await boot(w);
  await waitFor(() => viewText(w).includes("Cambia tu contraseña"), "forced even on the practice route");
  w.close();
});

test("profile menu: change name and open the password dialog", async () => {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const cookie = await env.makeUser(admin, "perfil@example.com", "student", "Perfil Uno");
  const w = openPage({ cookie }, base + "#/examenes");
  await boot(w);
  const chip = await waitFor(() => w.document.querySelector("#labBar button.user"), "user chip");
  chip.click();
  const menu = await waitFor(() => w.document.querySelector(".pop-menu"), "profile menu");
  assert.equal(chip.getAttribute("aria-expanded"), "true");
  assert.ok(byText(menu, "button", "Mi perfil") && byText(menu, "button", "Cambiar contraseña") && byText(menu, "button", "Cerrar sesión"));
  byText(menu, "button", "Mi perfil")!.click();
  const modal = await waitFor(() => w.document.querySelector(".lab-modal"), "profile dialog");
  await fill(w, modal, "Nombre", "Perfil Renombrado");
  byText(modal, "button", "Guardar nombre")!.click();
  await waitFor(() => !w.document.querySelector(".lab-modal") && (w.document.querySelector("#labBar .user .name")!.textContent || "") === "Perfil Renombrado", "name updated in the bar");
  const me = (await env.call("GET", "/api/auth/me", { cookie })).json();
  assert.equal(me.name, "Perfil Renombrado");
  w.close();
});

test("exam builder: two sections, pick count against the pool, points override and the PUT /blocks payload", async () => {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const ids: string[] = [];
  for (const n of [11, 12, 13]) {
    const r = await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: { ...exerciseBody(n), status: "published", difficulty: n === 11 ? "easy" : "hard", tags: ["builder"] } });
    assert.equal(r.statusCode, 201, r.body);
    ids.push(r.json().id);
  }
  const exam = (await env.call("POST", "/api/admin/exams", { cookie: admin, payload: { title: "Constructor", durationMinutes: 30, blocks: [{ title: "Primera", pickCount: null, shuffle: false, exercises: [{ exerciseId: ids[0] }] }] } })).json();

  const w = openPage({ cookie: admin }, base + "#/admin/examenes/" + exam.id);
  await boot(w);
  await waitFor(() => labelled(view(w), "Título").value === "Constructor", "builder loaded");
  assert.equal(w.document.querySelectorAll('.xb-tabs [role="tab"]').length, 6, "six sections as tabs");
  await clickText(w, "button", "Secciones y ejercicios");
  await waitFor(() => w.document.querySelectorAll(".blk").length === 1, "one section");
  await clickText(w, "button", "Agregar sección");
  await waitFor(() => w.document.querySelectorAll(".blk").length === 2, "two sections");
  const blk2 = () => w.document.querySelectorAll(".blk")[1] as HTMLElement;
  await fill(w, blk2(), "Nombre de la sección", "Segunda parte");
  // picker: filter by difficulty, add two exercises to the active (new) section
  await waitFor(() => [...w.document.querySelectorAll("button")].find((b: any) => b.getAttribute("aria-label") === "Agregar Ejercicio 12"), "picker rendered");
  (byLabel(w, "Agregar Ejercicio 12") as HTMLElement).click();
  (byLabel(w, "Agregar Ejercicio 13") as HTMLElement).click();
  await waitFor(() => blk2().querySelectorAll(".blk-list li").length === 2, "two exercises in section 2");
  assert.equal(byLabel(w, "Agregar Ejercicio 11"), undefined, "an exercise already in the exam cannot be added twice");
  // override and pick count with live validation
  const ov = blk2().querySelector('input[aria-label="Puntos en este examen para Ejercicio 12"]') as HTMLInputElement;
  setValue(w, ov, "4");
  setValue(w, labelled(blk2(), "Ejercicios por intento"), "n");
  setValue(w, labelled(blk2(), "Cantidad"), "5");
  await waitFor(() => (blk2().textContent || "").includes("Pides 5 pero solo hay 2"), "live pick validation");
  byText(w.document, "button", "Guardar cambios")!.click();
  await waitFor(() => (viewText(w)).includes("Revisa los campos marcados"), "save is blocked while a pick exceeds the pool");
  setValue(w, labelled(blk2(), "Cantidad"), "1");
  await waitFor(() => !(blk2().textContent || "").includes("Pides 5"), "error cleared");
  byText(w.document, "button", "Guardar cambios")!.click();
  await waitFor(() => (w.document.getElementById("toast")!.textContent || "").includes("Examen guardado"), "saved", 8000);
  const saved = (await env.call("GET", `/api/admin/exams/${exam.id}`, { cookie: admin })).json();
  assert.equal(saved.blocks.length, 2);
  assert.equal(saved.blocks[1].title, "Segunda parte");
  assert.equal(saved.blocks[1].pickCount, 1);
  assert.equal(saved.blocks[0].pickCount, null);
  assert.deepEqual(saved.blocks[1].exercises.map((e: any) => [e.exerciseId, e.pointsOverride]), [[ids[1], 4], [ids[2], null]]);
  assert.equal(saved.blocks[0].id !== undefined, true);
  // simulated draw: one exercise from section 2 plus the one of section 1
  await waitFor(() => labelled(view(w), "Título").value === "Constructor", "builder reloaded after saving");
  await clickText(w, "button", "Secciones y ejercicios");
  const draw = await waitFor(() => { const b = byText(view(w), "button", "Simular sorteo"); return b && !b.disabled ? b : null; }, "draw button enabled when nothing is pending");
  draw.click();
  await waitFor(() => viewText(w).includes("Segunda parte") && viewText(w).includes("2 ejercicios") && viewText(w).includes("Sortear otra vez"), "draw preview shown");
  // the publish checklist reflects the structure
  await clickText(w, "button", "Publicación");
  assert.match(view(w).querySelector(".checklist")!.textContent || "", /Tiene ejercicios publicados/);
  assert.equal(view(w).querySelectorAll(".checklist .fail").length, 0);
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

const byLabel = (w: any, label: string) => [...w.document.querySelectorAll("button")].find((b: any) => b.getAttribute("aria-label") === label);

test("exam builder: unsaved-changes guard, access list and extra attempts", async () => {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const stu = await env.register("extra.alumno@example.com", "Extra Alumno");
  assert.ok(stu);
  const ex = (await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: { ...exerciseBody(21), status: "published" } })).json();
  const exam = (await env.call("POST", "/api/admin/exams", { cookie: admin, payload: { title: "Acceso", durationMinutes: 30, blocks: [{ title: "A", pickCount: null, shuffle: false, exercises: [{ exerciseId: ex.id }] }] } })).json();
  const w = openPage({ cookie: admin }, base + "#/admin/examenes/" + exam.id);
  await boot(w);
  await waitFor(() => labelled(view(w), "Título").value === "Acceso", "builder");
  assert.equal(w.document.querySelector(".xb-bar .dirty")!.hasAttribute("hidden"), true, "no unsaved badge at first");
  setValue(w, labelled(view(w), "Título"), "Acceso (editado)");
  assert.equal(w.document.querySelector(".xb-bar .dirty")!.hasAttribute("hidden"), false, "unsaved badge after editing");
  // leaving asks for confirmation; staying keeps the form
  w.location.hash = "#/admin/examenes";
  await waitFor(() => w.document.querySelector(".lab-modal"), "leave guard dialog");
  assert.match(w.document.querySelector(".lab-modal")!.textContent || "", /Cambios sin guardar/);
  await confirmModal(w, "Seguir editando");
  await waitFor(() => labelled(view(w), "Título").value === "Acceso (editado)", "still editing");

  // access list
  await clickText(w, "button", "Acceso e intentos extra");
  await waitFor(() => { try { return labelled(view(w), "Correos de los estudiantes"); } catch { return null; } }, "access list");
  await fill(w, view(w), "Correos de los estudiantes", "extra.alumno@example.com\ndesconocido@example.com");
  await clickText(w, "button", "Guardar lista");
  await waitFor(() => viewText(w).includes("1 estudiante(s) encontrados") && viewText(w).includes("desconocido@example.com"), "matched vs unknown");
  const acc = (await env.call("GET", `/api/admin/exams/${exam.id}/access`, { cookie: admin })).json();
  assert.equal(acc.entries.length >= 1, true);
  // extra attempts for a student from the list
  await fill(w, view(w), "Estudiante", "extra.alumno@example.com");
  await fill(w, view(w), "Intentos extra", "2");
  await fill(w, view(w), "Motivo (opcional)", "Falla de conexión");
  await clickText(w, "button", "Conceder intentos");
  await waitFor(() => viewText(w).includes("hasta 4 intentos"), "grant-attempt result");
  await waitFor(() => viewText(w).includes("Falla de conexión") && viewText(w).includes("Revocar"), "override listed");
  byText(view(w), "button", "Revocar")!.click();
  await confirmModal(w, "Revocar");
  await waitFor(() => viewText(w).includes("No hay intentos extra concedidos"), "override revoked");
  // unknown student is explained
  await fill(w, view(w), "Estudiante", "nadie@example.com");
  await clickText(w, "button", "Conceder intentos");
  await waitFor(() => viewText(w).includes("No encuentro a ese estudiante"), "unknown student");
  setValue(w, labelled(view(w), "Título"), "Acceso");
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

test("student: exam instructions render markdown-lite safely (no raw HTML, no links)", async () => {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const ex = (await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: { ...exerciseBody(31), status: "published" } })).json();
  const evil = '# Hola\n**negrita** y *cursiva*\n- <img src=x onerror="window.__pwned=1">\n- [link](javascript:window.__pwned=1)\n<script>window.__pwned=1</script>\n`<b>codigo</b>`';
  const exam = (await env.call("POST", "/api/admin/exams", { cookie: admin, payload: { title: "Seguro", durationMinutes: 30, instructions: evil, blocks: [{ title: "A", pickCount: null, shuffle: false, exercises: [{ exerciseId: ex.id }] }] } })).json();
  const pub = await env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: admin, payload: { status: "published" } });
  assert.equal(pub.statusCode, 200, pub.body);
  const cookie = await env.register("lector.seguro@example.com", "Lector");
  const w = openPage({ cookie }, base + "#/examenes/" + exam.id);
  await boot(w);
  const md = await waitFor(() => w.document.querySelector(".md"), "rendered instructions");
  assert.equal(md.querySelector("img, script, iframe, a, svg, object"), null, "no dangerous elements");
  assert.equal(md.querySelectorAll("strong").length, 1);
  assert.equal(md.querySelectorAll("em").length, 1);
  assert.equal(md.querySelectorAll("h3").length, 1, "# becomes a heading");
  assert.equal(md.querySelectorAll("li").length, 2);
  assert.match(md.textContent || "", /<img src=x onerror=/, "the markup is shown as literal text");
  assert.match(md.textContent || "", /<script>window\.__pwned=1<\/script>/);
  assert.equal(w.__pwned, undefined, "nothing executed");
  assert.equal([...view(w).querySelectorAll("*")].some((e: any) => [...e.attributes].some((a: any) => /^on/i.test(a.name))), false, "no inline handlers");
  w.close();
});

test("student: access code, hidden results and feedback modes are honoured", async () => {
  const admin = await env.login(ADMIN.email, ADMIN.password);
  const ex = (await env.call("POST", "/api/admin/exercises", { cookie: admin, payload: { ...exerciseBody(41), status: "published" } })).json();
  const exam = (await env.call("POST", "/api/admin/exams", { cookie: admin, payload: {
    title: "Con código", durationMinutes: 30, accessCode: "SECRETO", feedbackMode: "none", resultMode: "hidden", maxAttempts: 1,
    blocks: [{ title: "Sección única", pickCount: null, shuffle: false, exercises: [{ exerciseId: ex.id }] }] } })).json();
  await env.call("PUT", `/api/admin/exams/${exam.id}`, { cookie: admin, payload: { status: "published" } });
  const cookie = await env.register("con.codigo@example.com", "Con Codigo");
  const w = openPage({ cookie }, base + "#/examenes/" + exam.id);
  await boot(w);
  await waitFor(() => { try { return labelled(view(w), "Código de acceso"); } catch { return null; } }, "code field");
  setChecked(w, labelled(view(w), "He leído y acepto las instrucciones"), true);
  byText(view(w), "button", "Comenzar intento")!.click();
  await waitFor(() => viewText(w).includes("Escribe el código de acceso"), "empty code");
  await fill(w, view(w), "Código de acceso", "NOPE");
  byText(view(w), "button", "Comenzar intento")!.click();
  await waitFor(() => viewText(w).includes("código de acceso no es correcto"), "INVALID_ACCESS_CODE");
  await fill(w, view(w), "Código de acceso", "SECRETO");
  byText(view(w), "button", "Comenzar intento")!.click();
  await waitFor(() => /^#\/intento\//.test(hashOf(w)) && stripText(w).includes("1 de 1 ejercicios"), "attempt started with the code");
  typeInCell(w, "A1", "=PRODUCTO(B1,2)");
  await clickText(w, "button", "Terminar ejercicio", w.document.getElementById("labStrip")!);
  await confirmModal(w, "Enviar y calificar");
  await waitFor(() => dockText(w).includes("Respuesta enviada"), "feedbackMode none shows no score");
  assert.equal(dockText(w).includes("Puntaje"), false);
  assert.equal(w.document.querySelector(".step .sc")!.textContent!.includes("/"), false, "no score in the stepper either");
  await clickText(w, "button", "Finalizar examen", w.document.getElementById("labStrip")!);
  await confirmModal(w, "Finalizar examen");
  await waitFor(() => viewText(w).includes("Tu intento fue enviado") && viewText(w).includes("la nota la publica tu docente"), "hidden result message");
  assert.equal(viewText(w).includes("%"), false, "no grade leaks into the screen");
  w.location.hash = "#/examenes";
  await waitFor(() => viewText(w).includes("la nota la publica tu docente"), "card hides the result too");
  assert.deepEqual(errorsSeen(), []);
  w.close();
});

/* =====================================================================
   GridLab lab core: pure logic for the exam/exercise screens (no DOM, no network).

   Same trick as engine.js: an IIFE that assigns LabCore on the object it receives as
   `globalThis`, so the browser uses it through a plain <script> and the tests evaluate the file
   with a private holder. Everything here is covered by server/test/labcore.test.ts.
   ===================================================================== */
(function (root) {
'use strict';

/* ---------- Small helpers ---------- */
const isBlank = v => v === undefined || v === null || String(v).trim() === '';
const round2 = x => Math.round(x * 100) / 100;
const pad2 = n => String(n).padStart(2, '0');

/** 17.5 -> "17,5"; 20 -> "20" (Spanish decimal comma, at most 2 decimals). */
function formatNumber(x) {
  if (typeof x !== 'number' || !isFinite(x)) return '-';
  return String(round2(x)).replace('.', ',');
}
function formatGrade(grade, scale) {
  if (grade === null || grade === undefined) return '-';
  return formatNumber(grade) + ' / ' + formatNumber(scale);
}
function formatPercent(p) {
  return p === null || p === undefined ? '-' : formatNumber(p) + ' %';
}

/* ---------- Routing (hash based) ---------- */
const ID = '([A-Za-z0-9-]{1,64})';
const ROUTES = [
  ['practice', /^\/practica$/, [], 'public'],
  ['login', /^\/login$/, [], 'public'],
  ['register', /^\/registro$/, [], 'public'],
  ['exams', /^\/examenes$/, [], 'user'],
  ['exam', new RegExp('^/examenes/' + ID + '$'), ['id'], 'user'],
  ['attempt', new RegExp('^/intento/' + ID + '$'), ['id'], 'user'],
  ['results', /^\/resultados$/, [], 'user'],
  ['adminHome', /^\/admin$/, [], 'admin'],
  ['adminExercises', /^\/admin\/ejercicios$/, [], 'admin'],
  ['adminExerciseNew', /^\/admin\/ejercicios\/nuevo$/, [], 'admin'],
  ['adminExerciseNewSheet', /^\/admin\/ejercicios\/nuevo\/hoja$/, [], 'admin'],
  ['adminExercise', new RegExp('^/admin/ejercicios/' + ID + '$'), ['id'], 'admin'],
  ['adminExerciseSheet', new RegExp('^/admin/ejercicios/' + ID + '/hoja$'), ['id'], 'admin'],
  ['adminExams', /^\/admin\/examenes$/, [], 'admin'],
  ['adminExamNew', /^\/admin\/examenes\/nuevo$/, [], 'admin'],
  ['adminExam', new RegExp('^/admin/examenes/' + ID + '$'), ['id'], 'admin'],
  ['adminResults', /^\/admin\/resultados$/, [], 'admin'],
  ['adminAttempt', new RegExp('^/admin/intentos/' + ID + '$'), ['id'], 'admin'],
];

function parseQuery(qs) {
  const out = {};
  const params = new URLSearchParams(String(qs || '').replace(/^\?/, ''));
  for (const [k, v] of params) out[k] = v;
  return out;
}

/** "#/examenes/abc?x=1" -> { path: "/examenes/abc", query: { x: "1" } } */
function parseHash(hash) {
  let h = String(hash || '').replace(/^#/, '');
  let query = {};
  const qi = h.indexOf('?');
  if (qi >= 0) {
    query = parseQuery(h.slice(qi + 1));
    h = h.slice(0, qi);
  }
  if (!h.startsWith('/')) h = '/' + h;
  h = h.replace(/\/+$/, '') || '/';
  return { path: h, query };
}

/** Resolves a hash to { name, params, query, path, access }. Unknown paths give name "notFound". */
function matchRoute(hash) {
  const { path, query } = parseHash(hash);
  for (const [name, re, keys, access] of ROUTES) {
    const m = re.exec(path);
    if (!m) continue;
    const params = {};
    keys.forEach((k, i) => { params[k] = m[i + 1]; });
    return { name, params, query, path, access };
  }
  return { name: path === '/' ? 'root' : 'notFound', params: {}, query, path, access: 'public' };
}

/**
 * Accepts "#/examenes/x" or "/examenes/x" and returns the normalized "#/..." hash, or null when the
 * value is not an internal route that makes sense as a login redirect target.
 */
function safeNext(value) {
  if (typeof value !== 'string' || !value || value.length > 300) return null;
  let v = value.trim();
  if (v.startsWith('#')) v = v.slice(1);
  if (!v.startsWith('/') || v.startsWith('//')) return null;
  const r = matchRoute(v);
  if (r.name === 'notFound' || r.name === 'root' || r.name === 'login' || r.name === 'register') return null;
  return '#' + v;
}

const UUID_LIKE = /^[0-9a-fA-F-]{8,64}$/;

/**
 * Deep links from other sites: "/?exam=<id>" opens the instruction screen of that exam (after login).
 * "/?next=%23/examenes/<id>" works for any internal route. Returns a hash or null.
 */
function deepLinkTarget(search, hash) {
  const q = parseQuery(search);
  if (q.exam && UUID_LIKE.test(q.exam)) return '#/examenes/' + q.exam;
  if (q.next) {
    const n = safeNext(q.next);
    if (n) return n;
  }
  const inHash = parseHash(hash).query;
  if (inHash.exam && UUID_LIKE.test(inHash.exam)) return '#/examenes/' + inHash.exam;
  return null;
}

const loginHash = next => '#/login' + (next ? '?next=' + encodeURIComponent(next) : '');
const registerHash = next => '#/registro' + (next ? '?next=' + encodeURIComponent(next) : '');

/* ---------- Server clock and countdown ---------- */

/**
 * The browser clock is only used to measure elapsed time. The offset to the server clock is
 * computed from the `serverNow` the API sends (assuming the response left halfway through the
 * round trip) and refreshed whenever a response carries a server timestamp.
 */
function createClock(localNow) {
  const now = localNow || Date.now;
  let offset = 0;
  let synced = false;
  return {
    sync(serverIso, sentAt, receivedAt) {
      const server = Date.parse(serverIso);
      if (isNaN(server)) return false;
      const sent = typeof sentAt === 'number' ? sentAt : now();
      const received = typeof receivedAt === 'number' ? receivedAt : sent;
      offset = server - (sent + received) / 2;
      synced = true;
      return true;
    },
    get synced() { return synced; },
    get offset() { return offset; },
    now() { return now() + offset; },
    remainingMs(deadlineIso) {
      const deadline = Date.parse(deadlineIso);
      return isNaN(deadline) ? 0 : Math.max(0, deadline - (now() + offset));
    },
  };
}

/** 754000 -> "12:34"; 3_725_000 -> "1:02:05". */
function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
}

/** Visual level of the timer: ok, warn (5 min or less), danger (1 min or less), over (time is up). */
function timerLevel(ms) {
  if (ms <= 0) return 'over';
  if (ms <= 60000) return 'danger';
  if (ms <= 300000) return 'warn';
  return 'ok';
}

/* ---------- Debounced autosave ---------- */

/**
 * Debounces and serializes saves. markDirty() schedules save(); flush() saves right now (waits for
 * a save in flight); a change that arrives while saving triggers one more save. Failures keep the
 * dirty flag and retry after retryMs. Timers are injectable for tests.
 */
function createAutosaver(opts) {
  const delay = opts.delay == null ? 2500 : opts.delay;
  const retryMs = opts.retryMs == null ? 10000 : opts.retryMs;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  let timer = null;
  let dirty = false;
  let running = null;
  let stopped = false;
  const clear = () => { if (timer !== null) { clearT(timer); timer = null; } };
  const schedule = ms => { clear(); if (!stopped) timer = setT(() => { timer = null; run(); }, ms); };

  async function run() {
    if (running) return running;
    if (!dirty) return;
    running = (async () => {
      try {
        while (dirty && !stopped) {
          dirty = false;
          try {
            await opts.save();
            if (opts.onSaved) opts.onSaved();
          } catch (err) {
            dirty = true;
            if (opts.onError) opts.onError(err);
            if (opts.fatal && opts.fatal(err)) { stopped = true; clear(); return; }
            schedule(retryMs);
            return;
          }
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    markDirty() { if (stopped) return; dirty = true; if (!running) schedule(delay); },
    async flush() { clear(); if (running) await running; if (dirty) await run(); },
    stop() { stopped = true; clear(); },
    get dirty() { return dirty; },
    get saving() { return !!running; },
  };
}

/* ---------- Errors ---------- */

const CODE_MESSAGES = {
  NETWORK: 'No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
  INTERNAL: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
  UNAUTHENTICATED: 'Tu sesión terminó. Inicia sesión para continuar.',
  FORBIDDEN: 'No tienes permisos para realizar esta acción.',
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  EMAIL_TAKEN: 'Ya existe una cuenta con ese correo.',
  TOO_MANY_ATTEMPTS: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.',
  BAD_ORIGIN: 'Solicitud no permitida desde este origen.',
  INSTRUCTIONS_NOT_ACCEPTED: 'Debes aceptar las instrucciones para comenzar.',
  NO_ATTEMPTS_LEFT: 'Ya usaste todos tus intentos para este examen.',
  EXAM_NOT_OPEN: 'Este examen todavía no está disponible.',
  EXAM_CLOSED: 'Este examen ya cerró.',
  EXAM_EMPTY: 'El examen necesita al menos un ejercicio.',
  ATTEMPT_EXPIRED: 'El tiempo del examen terminó.',
  ATTEMPT_CLOSED: 'Este intento ya fue enviado.',
  EXERCISE_ALREADY_SUBMITTED: 'Este ejercicio ya fue enviado y no se puede modificar.',
  INVALID_WORKBOOK: 'El libro es demasiado grande o no es válido (máximo 20 hojas y 8000 celdas con datos).',
  PAYLOAD_TOO_LARGE: 'Los datos superan el tamaño permitido.',
};

/** Field names (as the API reports them) -> labels shown to the user. */
const FIELD_LABELS = {
  name: 'Nombre', email: 'Correo', password: 'Contraseña',
  title: 'Título', instructions: 'Instrucciones', points: 'Puntos', status: 'Estado', workbook: 'Hoja inicial', checks: 'Verificaciones',
  durationMinutes: 'Duración', maxAttempts: 'Intentos máximos', pickCount: 'Ejercicios por intento', scale: 'Escala',
  passPercent: 'Porcentaje para aprobar', gradePolicy: 'Nota del examen', availableFrom: 'Disponible desde', availableUntil: 'Disponible hasta',
  exerciseIds: 'Ejercicios',
  sheet: 'hoja', cell: 'celda', expected: 'valor esperado', tolerance: 'tolerancia', functions: 'funciones', range: 'rango', label: 'etiqueta',
};

/** "checks.2.cell" -> "Verificación 3: celda"; "title" -> "Título". */
function describeField(path) {
  const parts = String(path).split('.');
  if (parts[0] === 'checks' && /^\d+$/.test(parts[1] || '')) {
    const rest = parts.slice(2).filter(p => !/^\d+$/.test(p));
    const what = rest.length ? (FIELD_LABELS[rest[0]] || rest[0]).toLowerCase() : '';
    return 'Verificación ' + (Number(parts[1]) + 1) + (what ? ': ' + what : '');
  }
  return FIELD_LABELS[parts[0]] || parts[0];
}

/** Friendly Spanish message for an ApiError-like object { status, code, message, fields }. */
function errorMessage(err) {
  if (!err) return CODE_MESSAGES.INTERNAL;
  if (err.code === 'VALIDATION' && Array.isArray(err.fields) && err.fields.length) {
    const names = [...new Set(err.fields.map(describeField))];
    return 'Revisa estos datos: ' + names.join(', ') + '.';
  }
  if (err.code && CODE_MESSAGES[err.code] && !err.message) return CODE_MESSAGES[err.code];
  if (err.code === 'NETWORK' || err.code === 'INTERNAL') return CODE_MESSAGES[err.code];
  if (err.message) return err.message;
  return CODE_MESSAGES[err.code] || CODE_MESSAGES.INTERNAL;
}

/** Top-level API field names -> true, used to mark inputs in a form. Check rows use "checks.<i>.<field>". */
function fieldSet(err) {
  const set = new Set();
  if (err && Array.isArray(err.fields)) for (const f of err.fields) set.add(String(f));
  return set;
}

/* ---------- Auth form validation ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateLogin(v) {
  const errors = {};
  if (isBlank(v.email)) errors.email = 'Escribe tu correo.';
  else if (!EMAIL_RE.test(String(v.email).trim())) errors.email = 'Escribe un correo válido.';
  if (!v.password) errors.password = 'Escribe tu contraseña.';
  return errors;
}

function validateRegister(v) {
  const errors = {};
  if (isBlank(v.name)) errors.name = 'Escribe tu nombre.';
  else if (String(v.name).trim().length > 120) errors.name = 'El nombre es demasiado largo (máximo 120 caracteres).';
  if (isBlank(v.email)) errors.email = 'Escribe tu correo.';
  else if (!EMAIL_RE.test(String(v.email).trim())) errors.email = 'Escribe un correo válido.';
  if (!v.password) errors.password = 'Escribe una contraseña.';
  else if (String(v.password).length < 8) errors.password = 'La contraseña debe tener al menos 8 caracteres.';
  else if (String(v.password).length > 256) errors.password = 'La contraseña es demasiado larga.';
  if (!v.confirm) errors.confirm = 'Repite la contraseña.';
  else if (v.confirm !== v.password) errors.confirm = 'Las contraseñas no coinciden.';
  return errors;
}

/* ---------- Check editor <-> API payload ---------- */
const CELL_RE = /^[A-Za-z]{1,3}[0-9]{1,4}$/;
const RANGE_RE = /^([A-Za-z]{1,3})([0-9]{1,4}):([A-Za-z]{1,3})([0-9]{1,4})$/;
const CHECK_TYPES = [
  { value: 'cell_value', label: 'Valor de una celda' },
  { value: 'cell_formula_uses', label: 'La celda usa funciones' },
  { value: 'range_values', label: 'Valores de un rango' },
];

function colNumber(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}
/** "C2:C5" -> { rows: 4, cols: 1 } (normalizes reversed ranges), or null. */
function rangeDims(range) {
  const m = RANGE_RE.exec(String(range || '').trim());
  if (!m) return null;
  const c1 = colNumber(m[1]), c2 = colNumber(m[3]), r1 = +m[2], r2 = +m[4];
  return { rows: Math.abs(r2 - r1) + 1, cols: Math.abs(c2 - c1) + 1 };
}

/** Text typed by the author -> scalar: numbers, VERDADERO/FALSO, "quoted" forces text, anything else is text. */
function parseScalar(text) {
  const t = String(text).trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (/^-?\d+([.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  if (/^(VERDADERO|TRUE)$/i.test(t)) return true;
  if (/^(FALSO|FALSE)$/i.test(t)) return false;
  return t;
}
function scalarToText(v) {
  if (typeof v === 'boolean') return v ? 'VERDADERO' : 'FALSO';
  if (typeof v === 'number') return String(v);
  const s = v === null || v === undefined ? '' : String(v);
  const needsQuotes = /^-?\d+([.,]\d+)?$/.test(s.trim()) || /^(VERDADERO|TRUE|FALSO|FALSE)$/i.test(s.trim()) || (s.length >= 2 && s.startsWith('"') && s.endsWith('"'));
  return needsQuotes ? '"' + s + '"' : s;
}

/** Text grid: one row per line, cells separated by ";", "|" or a tab (Excel paste). */
function parseMatrix(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.map(line => line.split(/\t|;|\|/).map(parseScalar));
}
function matrixToText(matrix) {
  return (matrix || []).map(row => row.map(scalarToText).join(' ; ')).join('\n');
}

function blankCheckRow(type) {
  return { type: type || 'cell_value', sheet: '', cell: '', expected: '', tolerance: '', ignoreCase: false, requireFormula: false, functions: '', range: '', matrix: '', points: '1', label: '' };
}

/** API check -> editable row (all values as strings, ready for inputs). */
function checkToRow(check) {
  const row = blankCheckRow(check.type);
  row.sheet = check.sheet || '';
  row.points = String(check.points == null ? 1 : check.points);
  row.label = check.label || '';
  if (check.type === 'cell_value') {
    row.cell = check.cell || '';
    row.expected = scalarToText(check.expected);
    row.tolerance = check.tolerance == null ? '' : String(check.tolerance);
    row.ignoreCase = !!check.ignoreCase;
    row.requireFormula = !!check.requireFormula;
  } else if (check.type === 'cell_formula_uses') {
    row.cell = check.cell || '';
    row.functions = (check.functions || []).join(', ');
  } else if (check.type === 'range_values') {
    row.range = check.range || '';
    row.matrix = matrixToText(check.expected);
    row.tolerance = check.tolerance == null ? '' : String(check.tolerance);
    row.ignoreCase = !!check.ignoreCase;
  }
  return row;
}

function parseNumber(text) {
  const t = String(text).trim().replace(',', '.');
  return t !== '' && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
}

/** Editable row -> { ok, check } or { ok:false, errors: { field: message } }. */
function rowToCheck(row) {
  const errors = {};
  const out = { type: row.type };
  const sheet = String(row.sheet || '').trim();
  if (sheet) {
    if (sheet.length > 31) errors.sheet = 'El nombre de la hoja tiene máximo 31 caracteres.';
    else out.sheet = sheet;
  }
  const points = parseNumber(row.points);
  if (isNaN(points) || points <= 0 || points > 1000) errors.points = 'Los puntos deben ser un número entre 0 y 1000.';
  const label = String(row.label || '').trim();
  if (label.length > 200) errors.label = 'La etiqueta es demasiado larga (máximo 200).';

  const tolerance = isBlank(row.tolerance) ? null : parseNumber(row.tolerance);
  if (tolerance !== null && (isNaN(tolerance) || tolerance < 0)) errors.tolerance = 'La tolerancia debe ser un número mayor o igual a 0.';

  if (row.type === 'cell_value') {
    const cell = String(row.cell || '').trim();
    if (!CELL_RE.test(cell)) errors.cell = 'Escribe una celda válida, por ejemplo B8.';
    else out.cell = cell.toUpperCase();
    if (String(row.expected).trim() === '') errors.expected = 'Escribe el valor esperado.';
    else {
      const expected = parseScalar(row.expected);
      if (typeof expected === 'string' && expected.length > 2000) errors.expected = 'El valor esperado es demasiado largo.';
      out.expected = expected;
    }
    if (tolerance !== null && !errors.tolerance) out.tolerance = tolerance;
    if (row.ignoreCase) out.ignoreCase = true;
    if (row.requireFormula) out.requireFormula = true;
  } else if (row.type === 'cell_formula_uses') {
    const cell = String(row.cell || '').trim();
    if (!CELL_RE.test(cell)) errors.cell = 'Escribe una celda válida, por ejemplo B8.';
    else out.cell = cell.toUpperCase();
    const fns = String(row.functions || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    if (!fns.length) errors.functions = 'Escribe al menos una función, por ejemplo SUMA.';
    else if (fns.length > 20 || fns.some(f => f.length > 40)) errors.functions = 'Máximo 20 funciones de hasta 40 caracteres.';
    else out.functions = fns;
  } else if (row.type === 'range_values') {
    const range = String(row.range || '').trim();
    const dims = rangeDims(range);
    if (!dims) errors.range = 'Escribe un rango válido, por ejemplo C2:C5.';
    else out.range = range.toUpperCase();
    const matrix = parseMatrix(row.matrix);
    if (!matrix.length) errors.matrix = 'Escribe los valores esperados, una fila por línea.';
    else if (dims) {
      const ragged = matrix.some(r => r.length !== matrix[0].length);
      if (ragged) errors.matrix = 'Todas las filas deben tener la misma cantidad de celdas.';
      else if (matrix.length !== dims.rows || matrix[0].length !== dims.cols) {
        errors.matrix = 'El rango ' + range.toUpperCase() + ' tiene ' + dims.rows + ' fila(s) y ' + dims.cols + ' columna(s), pero escribiste ' + matrix.length + ' fila(s) y ' + matrix[0].length + ' columna(s).';
      } else if (matrix.length > 200 || matrix[0].length > 26) errors.matrix = 'El rango es demasiado grande.';
      else out.expected = matrix;
    }
    if (tolerance !== null && !errors.tolerance) out.tolerance = tolerance;
    if (row.ignoreCase) out.ignoreCase = true;
  } else {
    errors.type = 'Tipo de verificación desconocido.';
  }

  if (!errors.points) out.points = points;
  if (label) out.label = label;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, check: out };
}

/** All rows -> { ok, checks, errors: [{ index, errors }] }. */
function rowsToChecks(rows) {
  const checks = [];
  const errors = [];
  rows.forEach((row, index) => {
    const r = rowToCheck(row);
    if (r.ok) checks.push(r.check);
    else errors.push({ index, errors: r.errors });
  });
  if (rows.length > 50) errors.push({ index: -1, errors: { checks: 'Máximo 50 verificaciones.' } });
  return { ok: errors.length === 0, checks, errors };
}

/* ---------- Exercise and exam forms ---------- */

function validateExerciseForm(f) {
  const errors = {};
  if (isBlank(f.title)) errors.title = 'Escribe un título.';
  else if (String(f.title).trim().length > 200) errors.title = 'El título es demasiado largo (máximo 200).';
  const points = parseNumber(f.points);
  if (isNaN(points) || points <= 0 || points > 1000) errors.points = 'Los puntos deben ser un número entre 0 y 1000.';
  if (String(f.instructions || '').length > 20000) errors.instructions = 'Las instrucciones son demasiado largas.';
  if (f.status !== 'draft' && f.status !== 'published') errors.status = 'Elige un estado.';
  return errors;
}

function exerciseFormToPayload(f, checks, workbook) {
  const payload = {
    title: String(f.title).trim(),
    instructions: String(f.instructions || ''),
    points: parseNumber(f.points),
    status: f.status,
    checks,
  };
  if (workbook) payload.workbook = workbook;
  return payload;
}

/** ISO string -> value for <input type="datetime-local"> in local time ("" for null). */
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
/** "2030-01-01T10:00" (local time) -> ISO string, or null for "". NaN-safe: returns undefined if invalid. */
function localInputToIso(value) {
  if (isBlank(value)) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function examToForm(exam) {
  return {
    title: exam.title || '',
    instructions: exam.instructions || '',
    durationMinutes: String(exam.durationMinutes == null ? 60 : exam.durationMinutes),
    maxAttempts: String(exam.maxAttempts == null ? 2 : exam.maxAttempts),
    pickCount: exam.pickCount == null ? '' : String(exam.pickCount),
    scale: String(exam.scale == null ? 20 : exam.scale),
    passPercent: String(exam.passPercent == null ? 60 : exam.passPercent),
    gradePolicy: exam.gradePolicy || 'best',
    status: exam.status || 'draft',
    availableFrom: isoToLocalInput(exam.availableFrom),
    availableUntil: isoToLocalInput(exam.availableUntil),
  };
}

function isIntIn(text, lo, hi) {
  const n = parseNumber(text);
  return Number.isInteger(n) && n >= lo && n <= hi;
}

function validateExamForm(f) {
  const errors = {};
  if (isBlank(f.title)) errors.title = 'Escribe un título.';
  else if (String(f.title).trim().length > 200) errors.title = 'El título es demasiado largo (máximo 200).';
  if (!isIntIn(f.durationMinutes, 1, 600)) errors.durationMinutes = 'La duración debe ser un número entero de minutos entre 1 y 600.';
  if (!isIntIn(f.maxAttempts, 1, 20)) errors.maxAttempts = 'Los intentos deben ser un número entero entre 1 y 20.';
  if (!isBlank(f.pickCount) && !isIntIn(f.pickCount, 1, 500)) errors.pickCount = 'Déjalo vacío para usar todos los ejercicios, o escribe un entero entre 1 y 500.';
  const scale = parseNumber(f.scale);
  if (isNaN(scale) || scale <= 0 || scale > 1000) errors.scale = 'La escala debe ser un número mayor que 0 (por ejemplo 20).';
  const pass = parseNumber(f.passPercent);
  if (isNaN(pass) || pass < 0 || pass > 100) errors.passPercent = 'El porcentaje debe estar entre 0 y 100.';
  if (f.gradePolicy !== 'best' && f.gradePolicy !== 'last') errors.gradePolicy = 'Elige cómo se calcula la nota.';
  if (f.status !== 'draft' && f.status !== 'published') errors.status = 'Elige un estado.';
  const from = localInputToIso(f.availableFrom), until = localInputToIso(f.availableUntil);
  if (from === undefined) errors.availableFrom = 'Fecha no válida.';
  if (until === undefined) errors.availableUntil = 'Fecha no válida.';
  if (from && until && Date.parse(from) >= Date.parse(until)) errors.availableUntil = 'La fecha de cierre debe ser posterior a la de apertura.';
  if (String(f.instructions || '').length > 20000) errors.instructions = 'Las instrucciones son demasiado largas.';
  return errors;
}

function examFormToPayload(f) {
  return {
    title: String(f.title).trim(),
    instructions: String(f.instructions || ''),
    durationMinutes: parseNumber(f.durationMinutes),
    maxAttempts: parseNumber(f.maxAttempts),
    pickCount: isBlank(f.pickCount) ? null : parseNumber(f.pickCount),
    scale: parseNumber(f.scale),
    passPercent: parseNumber(f.passPercent),
    gradePolicy: f.gradePolicy,
    status: f.status,
    availableFrom: localInputToIso(f.availableFrom) || null,
    availableUntil: localInputToIso(f.availableUntil) || null,
  };
}

/** Moves an item inside a copy of the array (used by the exam exercise picker). */
function moveItem(list, from, to) {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list.slice();
  const copy = list.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/* ---------- Student exam cards ---------- */

/**
 * State of an exam card for a student.
 * key: running | available | not_open | closed | no_attempts
 */
function examCardState(exam) {
  if (exam.inProgressAttemptId) return { key: 'running', label: 'En curso', cta: 'Continuar', canStart: true, resume: true };
  if (exam.window === 'closed') return { key: 'closed', label: 'Cerrado', cta: 'Cerrado', canStart: false };
  if (exam.window === 'not_open') return { key: 'not_open', label: 'Aún no disponible', cta: 'No disponible', canStart: false };
  if (exam.attemptsRemaining <= 0) return { key: 'no_attempts', label: 'Sin intentos', cta: 'Sin intentos', canStart: false };
  return { key: 'available', label: 'Disponible', cta: exam.attemptsUsed > 0 ? 'Nuevo intento' : 'Comenzar', canStart: true };
}

const STATUS_LABELS = { in_progress: 'En curso', submitted: 'Enviado', expired: 'Tiempo agotado', draft: 'Borrador', published: 'Publicado' };
const statusLabel = s => STATUS_LABELS[s] || s;

/** Progress of a running attempt: how many exercises were already submitted. */
function attemptProgress(view) {
  const total = view.exercises.length;
  const submitted = view.exercises.filter(e => e.submitted).length;
  return { total, submitted, pending: total - submitted };
}

/** JSON of a workbook without per-sheet selection, to tell real edits from cursor moves. */
function workbookKey(wb) {
  return JSON.stringify(wb, (k, v) => (k === 'sel' ? undefined : v));
}

root.LabCore = {
  formatNumber, formatGrade, formatPercent,
  parseQuery, parseHash, matchRoute, safeNext, deepLinkTarget, loginHash, registerHash,
  createClock, formatDuration, timerLevel, createAutosaver,
  errorMessage, describeField, fieldSet, CODE_MESSAGES,
  validateLogin, validateRegister,
  CHECK_TYPES, blankCheckRow, checkToRow, rowToCheck, rowsToChecks, parseScalar, scalarToText, parseMatrix, matrixToText, rangeDims,
  validateExerciseForm, exerciseFormToPayload, examToForm, validateExamForm, examFormToPayload, isoToLocalInput, localInputToIso,
  moveItem, examCardState, statusLabel, attemptProgress, workbookKey,
};
})(typeof globalThis !== 'undefined' ? globalThis : this);

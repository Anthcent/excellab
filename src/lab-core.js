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
  ['adminUsers', /^\/admin\/usuarios$/, [], 'sysadmin'],
  ['adminExercises', /^\/admin\/ejercicios$/, [], 'admin'],
  ['adminExerciseNew', /^\/admin\/ejercicios\/nuevo$/, [], 'admin'],
  ['adminExerciseNewSheet', /^\/admin\/ejercicios\/nuevo\/hoja$/, [], 'admin'],
  ['adminExercise', new RegExp('^/admin/ejercicios/' + ID + '$'), ['id'], 'admin'],
  ['adminExerciseSheet', new RegExp('^/admin/ejercicios/' + ID + '/hoja$'), ['id'], 'admin'],
  ['adminExams', /^\/admin\/examenes$/, [], 'admin'],
  ['adminExamNew', /^\/admin\/examenes\/nuevo$/, [], 'admin'],
  ['adminExam', new RegExp('^/admin/examenes/' + ID + '$'), ['id'], 'admin'],
  ['adminExamAnalytics', new RegExp('^/admin/examenes/' + ID + '/analiticas$'), ['id'], 'admin'],
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
  ACCESS_CODE_REQUIRED: 'Este examen pide un código de acceso.',
  INVALID_ACCESS_CODE: 'El código de acceso no es correcto.',
  PASSWORD_CHANGE_REQUIRED: 'Debes cambiar tu contraseña temporal para continuar.',
  ACCOUNT_DISABLED: 'Esta cuenta está desactivada. Habla con un administrador.',
  WRONG_CURRENT_PASSWORD: 'La contraseña actual no es correcta.',
  PASSWORD_UNCHANGED: 'La nueva contraseña debe ser distinta de la actual.',
  CANNOT_MODIFY_SELF: 'No puedes cambiar tu propio rol ni desactivar tu propia cuenta.',
  LAST_ADMIN: 'No puedes dejar el sistema sin administradores activos.',
  USE_CHANGE_PASSWORD: 'Para tu propia cuenta usa "Cambiar contraseña" en tu perfil.',
  EXAM_POOL_TOO_SMALL: 'Una sección pide más ejercicios de los que tiene publicados.',
  PICK_EXCEEDS_POOL: 'Una sección pide más ejercicios de los que tiene publicados.',
  DUPLICATE_EXERCISES: 'Un ejercicio no puede estar dos veces en el mismo examen.',
  UNKNOWN_EXERCISE: 'Alguno de los ejercicios ya no existe o no es tuyo.',
  EXERCISE_NOT_PUBLISHED: 'Solo se pueden usar ejercicios publicados.',
  EXAM_IN_USE: 'Este examen ya tiene intentos de estudiantes y no se puede eliminar. Despublícalo si ya no debe aparecer.',
  EXERCISE_IN_USE: 'Este ejercicio ya se usó en intentos y no se puede eliminar. Pásalo a borrador si ya no debe usarse.',
  INVALID_OWNER: 'Ese propietario no es válido.',
};

/** Field names (as the API reports them) -> labels shown to the user. */
const FIELD_LABELS = {
  name: 'Nombre', email: 'Correo', password: 'Contraseña',
  title: 'Título', instructions: 'Instrucciones', points: 'Puntos', status: 'Estado', workbook: 'Hoja inicial', checks: 'Verificaciones',
  durationMinutes: 'Duración', maxAttempts: 'Intentos máximos', pickCount: 'Ejercicios por intento', scale: 'Escala',
  passPercent: 'Porcentaje para aprobar', gradePolicy: 'Nota del examen', availableFrom: 'Disponible desde', availableUntil: 'Disponible hasta',
  exerciseIds: 'Ejercicios', difficulty: 'Dificultad', tags: 'Etiquetas', estimatedMinutes: 'Minutos estimados', category: 'Categoría',
  description: 'Descripción', accessCode: 'Código de acceso', feedbackMode: 'Retroalimentación', resultMode: 'Resultados', blocks: 'Secciones',
  currentPassword: 'Contraseña actual', newPassword: 'Nueva contraseña', role: 'Rol',
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
  if (f.difficulty !== undefined && !['easy', 'medium', 'hard'].includes(f.difficulty)) errors.difficulty = 'Elige una dificultad.';
  if (f.estimatedMinutes !== undefined && !isBlank(f.estimatedMinutes) && !isIntIn(f.estimatedMinutes, 1, 600)) errors.estimatedMinutes = 'Escribe minutos enteros entre 1 y 600, o déjalo vacío.';
  if (f.category !== undefined && String(f.category || '').trim().length > 60) errors.category = 'La categoría es demasiado larga (máximo 60).';
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
  if (f.difficulty !== undefined) payload.difficulty = f.difficulty;
  if (f.tags !== undefined) payload.tags = f.tags;
  if (f.estimatedMinutes !== undefined) payload.estimatedMinutes = isBlank(f.estimatedMinutes) ? null : parseNumber(f.estimatedMinutes);
  if (f.category !== undefined) payload.category = isBlank(f.category) ? null : String(f.category).trim();
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

const DIFFICULTIES = [{ value: 'easy', label: 'Fácil' }, { value: 'medium', label: 'Media' }, { value: 'hard', label: 'Difícil' }];
const difficultyLabel = d => { const x = DIFFICULTIES.find(o => o.value === d); return x ? x.label : d || '-'; };
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

/* ---------- Roles ---------- */
const ROLE_LABELS = { student: 'Estudiante', teacher: 'Profesor', admin: 'Administrador' };
const roleLabel = r => ROLE_LABELS[r] || r;
const ROLE_BADGE = { student: '', teacher: 'info', admin: 'ok' };
const isStaff = user => !!user && (user.role === 'teacher' || user.role === 'admin');

/* ---------- Markdown-lite (safe by construction) ----------
   Returns tokens, never HTML: the UI turns them into elements with textContent, so nothing the author
   types can become markup. Supported: # / ## / ### headings, "- " lists, **bold**, *italic*, `code`. */
const MD_MAX = 20000;
const isWordChar = ch => !!ch && /[A-Za-z0-9_À-ɏ]/.test(ch);

function parseInlineMd(src) {
  const s = String(src);
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ k: 'text', s: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '*' && s[i + 1] === '*') {
      const j = s.indexOf('**', i + 2);
      if (j > i + 2) { flush(); out.push({ k: 'b', s: s.slice(i + 2, j) }); i = j + 2; continue; }
    }
    if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { flush(); out.push({ k: 'code', s: s.slice(i + 1, j) }); i = j + 1; continue; }
    }
    if (ch === '*' && s[i + 1] !== '*' && !isWordChar(s[i - 1]) && s[i + 1] && !/\s/.test(s[i + 1])) {
      let j = -1;
      for (let k = i + 2; k < s.length; k++) {
        if (s[k] === '*' && s[k - 1] !== '*' && s[k + 1] !== '*' && !/\s/.test(s[k - 1]) && !isWordChar(s[k + 1])) { j = k; break; }
      }
      if (j > 0) { flush(); out.push({ k: 'i', s: s.slice(i + 1, j) }); i = j + 1; continue; }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** text -> [{ t:'h', level:1|2|3, inline }, { t:'ul', items:[inline] }, { t:'p', inline }] */
function parseMarkdownLite(text) {
  const lines = String(text == null ? '' : text).slice(0, MD_MAX).replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  const endPara = () => { if (para.length) { blocks.push({ t: 'p', inline: parseInlineMd(para.join('\n')) }); para = []; } };
  const endList = () => { if (list) { blocks.push({ t: 'ul', items: list }); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { endPara(); endList(); continue; }
    if ((m = /^(#{1,3})\s+(.+)$/.exec(line))) { endPara(); endList(); blocks.push({ t: 'h', level: m[1].length, inline: parseInlineMd(m[2]) }); continue; }
    if ((m = /^\s{0,3}-\s+(.+)$/.exec(line))) { endPara(); (list = list || []).push(parseInlineMd(m[1])); continue; }
    endList();
    para.push(line);
  }
  endPara(); endList();
  return blocks;
}

/** Insert markers around a selection for the formatting helper bar. Returns { value, start, end }. */
function applyMdFormat(value, start, end, kind) {
  const v = String(value);
  const a = Math.max(0, Math.min(start, v.length)), b = Math.max(a, Math.min(end, v.length));
  const sel = v.slice(a, b);
  if (kind === 'bold' || kind === 'italic' || kind === 'code') {
    const mark = kind === 'bold' ? '**' : kind === 'italic' ? '*' : '`';
    const inner = sel || (kind === 'bold' ? 'texto' : kind === 'italic' ? 'texto' : 'codigo');
    const next = v.slice(0, a) + mark + inner + mark + v.slice(b);
    return { value: next, start: a + mark.length, end: a + mark.length + inner.length };
  }
  const lineStart = v.lastIndexOf('\n', a - 1) + 1;
  const prefix = kind === 'heading' ? '# ' : '- ';
  const chunk = v.slice(lineStart, b || a);
  const lines = (chunk || '').split('\n').map(l => (l.startsWith(prefix) ? l : prefix + l));
  const next = v.slice(0, lineStart) + lines.join('\n') + v.slice(b || a);
  return { value: next, start: lineStart, end: lineStart + lines.join('\n').length };
}

/* ---------- Tags, e-mails, passwords ---------- */
function normalizeTag(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 30);
}
/** Adds a tag to a copy of the list (lowercase, unique, max 10). Returns { tags, added, reason }. */
function addTag(tags, raw) {
  const tag = normalizeTag(raw);
  if (!tag) return { tags: tags.slice(), added: false, reason: '' };
  if (tags.includes(tag)) return { tags: tags.slice(), added: false, reason: 'Esa etiqueta ya está agregada.' };
  if (tags.length >= 10) return { tags: tags.slice(), added: false, reason: 'Máximo 10 etiquetas.' };
  return { tags: tags.concat(tag), added: true, reason: '' };
}

/** Free text (one per line / comma / semicolon) -> { valid: [unique lowercase], invalid: [...] }. */
function parseEmails(text) {
  const valid = [], invalid = [];
  const seen = new Set();
  for (const part of String(text || '').split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    (EMAIL_RE.test(e) && e.length <= 254 ? valid : invalid).push(e);
  }
  return { valid, invalid };
}

const PW_ALPHABET = { lower: 'abcdefghijkmnpqrstuvwxyz', upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', digit: '23456789', symbol: '!@#$%&*?' };
/** randomInt(n) -> integer in [0, n). Injectable so it is testable; the UI passes crypto.getRandomValues. */
function generatePassword(randomInt, length) {
  const len = Math.max(10, Math.min(64, length || 12));
  const groups = Object.values(PW_ALPHABET);
  const all = groups.join('');
  const out = groups.map(g => g[randomInt(g.length)]);
  while (out.length < len) out.push(all[randomInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}
function generateAccessCode(randomInt, length) {
  const alphabet = PW_ALPHABET.upper + PW_ALPHABET.digit;
  let s = '';
  for (let i = 0; i < (length || 6); i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}
/** score 0-4 plus a Spanish label and a hint about what to improve. */
function passwordStrength(pw) {
  const p = String(pw || '');
  if (!p) return { score: 0, label: '', hint: '' };
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) score++;
  else if (/\d/.test(p) || /[^A-Za-z0-9]/.test(p)) score += 0.5;
  score = Math.min(4, Math.floor(score));
  if (p.length < 8) return { score: Math.min(score, 1), label: 'Muy corta', hint: 'Usa al menos 8 caracteres.' };
  const labels = ['Débil', 'Débil', 'Aceptable', 'Buena', 'Fuerte'];
  const hints = ['Mezcla letras, números y símbolos.', 'Añade más caracteres y mezcla mayúsculas.', 'Añade números o símbolos para reforzarla.', 'Casi lista: unos caracteres más la hacen fuerte.', 'Muy buena contraseña.'];
  return { score, label: labels[score], hint: hints[score] };
}
function validateChangePassword(v) {
  const errors = {};
  if (!v.current) errors.current = 'Escribe tu contraseña actual.';
  if (!v.next) errors.next = 'Escribe la nueva contraseña.';
  else if (String(v.next).length < 8) errors.next = 'La contraseña debe tener al menos 8 caracteres.';
  else if (String(v.next).length > 256) errors.next = 'La contraseña es demasiado larga.';
  else if (v.current && v.next === v.current) errors.next = 'La nueva contraseña debe ser distinta de la actual.';
  if (!v.confirm) errors.confirm = 'Repite la nueva contraseña.';
  else if (v.confirm !== v.next) errors.confirm = 'Las contraseñas no coinciden.';
  return errors;
}
function validateUserForm(v, opts) {
  const errors = {};
  if (isBlank(v.name)) errors.name = 'Escribe el nombre.';
  else if (String(v.name).trim().length > 120) errors.name = 'El nombre es demasiado largo (máximo 120 caracteres).';
  if (!opts || opts.needEmail !== false) {
    if (isBlank(v.email)) errors.email = 'Escribe el correo.';
    else if (!EMAIL_RE.test(String(v.email).trim())) errors.email = 'Escribe un correo válido.';
  }
  if (!ROLE_LABELS[v.role]) errors.role = 'Elige un rol.';
  if (!opts || opts.needPassword !== false) {
    if (!v.password) errors.password = 'Escribe o genera una contraseña temporal.';
    else if (String(v.password).length < 8) errors.password = 'La contraseña debe tener al menos 8 caracteres.';
  }
  return errors;
}

/** { totalPages, from, to } for a "1-25 de 80" label. */
function pageInfo(total, page, pageSize) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const p = Math.max(1, Math.min(page, pages));
  return { pages, page: p, from: total ? (p - 1) * pageSize + 1 : 0, to: Math.min(total, p * pageSize) };
}

/* ---------- Exam settings (builder form) ---------- */
const FEEDBACK_MODES = [
  { value: 'none', label: 'Nada', help: 'Al enviar un ejercicio el estudiante solo ve que quedó enviado, sin puntaje.' },
  { value: 'score', label: 'Solo la nota', help: 'Al enviar un ejercicio ve su puntaje, pero no cuáles verificaciones fallaron.' },
  { value: 'details', label: 'Nota con detalle', help: 'Ve el puntaje y el resultado de cada verificación (correcta o incorrecta).' },
];
const RESULT_MODES = [
  { value: 'immediate', label: 'Inmediato', help: 'La nota final se muestra apenas el estudiante termina su intento.' },
  { value: 'after_close', label: 'Al cerrar el examen', help: 'La nota se oculta hasta que pase la fecha de cierre o el estudiante agote sus intentos.' },
  { value: 'hidden', label: 'Oculto', help: 'El estudiante nunca ve su nota; solo la ve el personal.' },
];
const modeHelp = (list, value) => { const m = list.find(x => x.value === value); return m ? m.help : ''; };

function examSettingsToForm(exam) {
  const base = examToForm(exam);
  return {
    title: base.title,
    description: exam.description || '',
    instructions: base.instructions,
    durationMinutes: base.durationMinutes,
    maxAttempts: base.maxAttempts,
    scale: base.scale,
    passPercent: base.passPercent,
    gradePolicy: base.gradePolicy,
    status: base.status,
    availableFrom: base.availableFrom,
    availableUntil: base.availableUntil,
    shuffleBlocks: !!exam.shuffleBlocks,
    feedbackMode: exam.feedbackMode || 'details',
    resultMode: exam.resultMode || 'immediate',
    allowReview: !!exam.allowReview,
    accessCode: exam.accessCode || '',
    restricted: !!exam.restricted,
    ownerId: exam.ownerId || '',
  };
}
function validateExamSettings(f) {
  const errors = validateExamForm({ ...f, pickCount: '' });
  if (String(f.description || '').length > 500) errors.description = 'La descripción es demasiado larga (máximo 500).';
  if (String(f.accessCode || '').trim().length > 64) errors.accessCode = 'El código es demasiado largo (máximo 64).';
  if (!FEEDBACK_MODES.some(m => m.value === f.feedbackMode)) errors.feedbackMode = 'Elige qué ve el estudiante al enviar.';
  if (!RESULT_MODES.some(m => m.value === f.resultMode)) errors.resultMode = 'Elige cuándo se muestra la nota.';
  return errors;
}
/** Settings payload for PUT /admin/exams/:id (no blocks, no deprecated pickCount). */
function examSettingsToPayload(f, opts) {
  const p = {
    title: String(f.title).trim(),
    description: String(f.description || '').trim(),
    instructions: String(f.instructions || ''),
    durationMinutes: parseNumber(f.durationMinutes),
    maxAttempts: parseNumber(f.maxAttempts),
    scale: parseNumber(f.scale),
    passPercent: parseNumber(f.passPercent),
    gradePolicy: f.gradePolicy,
    status: f.status,
    availableFrom: localInputToIso(f.availableFrom) || null,
    availableUntil: localInputToIso(f.availableUntil) || null,
    shuffleBlocks: !!f.shuffleBlocks,
    feedbackMode: f.feedbackMode,
    resultMode: f.resultMode,
    allowReview: !!f.allowReview,
    accessCode: isBlank(f.accessCode) ? null : String(f.accessCode).trim(),
    restricted: !!f.restricted,
  };
  if (opts && opts.withOwner && f.ownerId) p.ownerId = f.ownerId;
  return p;
}

/* ---------- Exam blocks (builder) ---------- */
let blockSeq = 0;
function newBlock(title) {
  return { key: 'b' + (++blockSeq), id: null, title: title || 'Sección', pick: '', shuffle: false, exercises: [] };
}
/** API exam -> editable blocks. `pick` is '' (todos) or a numeric string. */
function blocksFromExam(exam) {
  return (exam && exam.blocks ? exam.blocks : []).map(b => ({
    key: 'b' + (++blockSeq), id: b.id || null, title: b.title || 'Sección',
    pick: b.pickCount == null ? '' : String(b.pickCount), shuffle: !!b.shuffle,
    exercises: (b.exercises || []).map(e => ({
      exerciseId: e.exerciseId, title: e.title, points: e.points, status: e.status,
      pointsOverride: e.pointsOverride == null ? '' : String(e.pointsOverride),
    })),
  }));
}
const publishedCount = b => b.exercises.filter(e => e.status === 'published').length;
const effPoints = e => { const o = parseNumber(e.pointsOverride); return !isBlank(e.pointsOverride) && !isNaN(o) ? o : Number(e.points) || 0; };

/** Per-block and overall figures for the totals panel. Expected points = picks x average points of the block. */
function blockTotals(blocks) {
  const rows = blocks.map(b => {
    const pool = publishedCount(b);
    const pub = b.exercises.filter(e => e.status === 'published');
    const pickN = isBlank(b.pick) ? pool : Math.min(parseNumber(b.pick) || 0, pool);
    const poolPoints = pub.reduce((s, e) => s + effPoints(e), 0);
    const avg = pub.length ? poolPoints / pub.length : 0;
    return { key: b.key, pool, total: b.exercises.length, picks: pickN, poolPoints, expectedPoints: isBlank(b.pick) ? poolPoints : avg * pickN };
  });
  return {
    rows,
    exercises: rows.reduce((n, r) => n + r.picks, 0),
    poolSize: rows.reduce((n, r) => n + r.pool, 0),
    poolPoints: rows.reduce((n, r) => n + r.poolPoints, 0),
    expectedPoints: rows.reduce((n, r) => n + r.expectedPoints, 0),
  };
}
/** Validation of the block editor: { errors: { [blockKey]: { title?, pick?, override: {idx: msg} } }, ok }. */
function validateBlocks(blocks) {
  const errors = {};
  const seen = new Set();
  blocks.forEach(b => {
    const e = {};
    if (isBlank(b.title)) e.title = 'Escribe el nombre de la sección.';
    else if (String(b.title).trim().length > 120) e.title = 'El nombre es demasiado largo (máximo 120).';
    if (!isBlank(b.pick)) {
      const n = parseNumber(b.pick);
      const pool = publishedCount(b);
      if (!Number.isInteger(n) || n < 1) e.pick = 'Escribe un entero mayor o igual a 1, o elige "todos".';
      else if (n > pool) e.pick = pool ? 'Pides ' + n + ' pero solo hay ' + pool + ' ejercicio(s) publicado(s) en la sección.' : 'La sección no tiene ejercicios publicados.';
    }
    b.exercises.forEach((x, i) => {
      if (!isBlank(x.pointsOverride)) {
        const o = parseNumber(x.pointsOverride);
        if (isNaN(o) || o <= 0 || o > 1000) (e.override = e.override || {})[i] = 'Entre 0 y 1000.';
      }
      if (seen.has(x.exerciseId)) (e.dup = e.dup || {})[i] = 'Repetido en el examen.';
      seen.add(x.exerciseId);
    });
    if (Object.keys(e).length) errors[b.key] = e;
  });
  if (blocks.length > 20) errors._ = { count: 'Máximo 20 secciones.' };
  return { errors, ok: Object.keys(errors).length === 0 };
}
/** Editable blocks -> body of PUT /admin/exams/:id/blocks. */
function blocksToPayload(blocks) {
  return {
    blocks: blocks.map(b => {
      const out = {
        title: String(b.title).trim(),
        pickCount: isBlank(b.pick) ? null : parseNumber(b.pick),
        shuffle: !!b.shuffle,
        exercises: b.exercises.map(x => {
          const o = { exerciseId: x.exerciseId };
          if (!isBlank(x.pointsOverride)) o.pointsOverride = parseNumber(x.pointsOverride);
          return o;
        }),
      };
      if (b.id) out.id = b.id;
      return out;
    }),
  };
}
/** Mirror of the server's publish validation: [{ key, ok, label, detail }]. */
function publishChecklist(f, blocks, now) {
  const items = [];
  const t = blockTotals(blocks);
  items.push({ key: 'title', ok: !isBlank(f.title), label: 'Tiene título', detail: isBlank(f.title) ? 'Escribe un título.' : '' });
  items.push({ key: 'blocks', ok: blocks.length > 0, label: 'Tiene al menos una sección', detail: blocks.length ? '' : 'Agrega una sección.' });
  items.push({ key: 'exercises', ok: t.poolSize > 0, label: 'Tiene ejercicios publicados', detail: t.poolSize > 0 ? t.poolSize + ' ejercicio(s) publicado(s) en total.' : 'Agrega ejercicios publicados a una sección.' });
  const bad = blocks.filter(b => !isBlank(b.pick) && (!Number.isInteger(parseNumber(b.pick)) || parseNumber(b.pick) > publishedCount(b)));
  items.push({ key: 'pick', ok: bad.length === 0, label: 'Los sorteos no superan el banco de cada sección', detail: bad.length ? 'Revisa: ' + bad.map(b => b.title || 'Sección').join(', ') + '.' : '' });
  const drafts = blocks.reduce((n, b) => n + b.exercises.length - publishedCount(b), 0);
  items.push({ key: 'drafts', ok: drafts === 0, warn: true, label: 'No hay ejercicios en borrador', detail: drafts ? drafts + ' ejercicio(s) en borrador no se sortean hasta que los publiques.' : '' });
  const from = localInputToIso(f.availableFrom), until = localInputToIso(f.availableUntil);
  let windowOk = from !== undefined && until !== undefined;
  let detail = windowOk ? '' : 'Alguna fecha no es válida.';
  if (windowOk && from && until && Date.parse(from) >= Date.parse(until)) { windowOk = false; detail = 'El cierre debe ser posterior a la apertura.'; }
  else if (windowOk && until && Date.parse(until) <= (now || Date.now())) { windowOk = false; detail = 'La fecha de cierre ya pasó: nadie podrá iniciar el examen.'; }
  items.push({ key: 'window', ok: windowOk, label: 'La ventana de disponibilidad es coherente', detail });
  return items;
}
const checklistReady = items => items.filter(i => !i.warn).every(i => i.ok);

/* ---------- Charts ---------- */
/** Bars for a w x h SVG with padding: [{ x, y, w, h, value, i }] and a "nice" upper bound. */
function barLayout(values, width, height, pad) {
  const p = Object.assign({ l: 28, r: 8, t: 10, b: 22 }, pad || {});
  const max = Math.max(1, ...values);
  const nice = max <= 5 ? max : Math.ceil(max / 5) * 5;
  const iw = width - p.l - p.r, ih = height - p.t - p.b;
  const slot = values.length ? iw / values.length : 0;
  const gap = Math.min(8, slot * 0.25);
  return {
    max: nice, pad: p, slot,
    bars: values.map((v, i) => {
      const bh = nice ? (v / nice) * ih : 0;
      return { i, value: v, x: p.l + i * slot + gap / 2, w: Math.max(1, slot - gap), h: bh, y: p.t + ih - bh };
    }),
  };
}
/** Polyline points (and closed area path) for a series. */
function areaPath(values, width, height, pad) {
  const p = Object.assign({ l: 28, r: 8, t: 10, b: 22 }, pad || {});
  const max = Math.max(1, ...values);
  const nice = max <= 5 ? max : Math.ceil(max / 5) * 5;
  const iw = width - p.l - p.r, ih = height - p.t - p.b;
  const step = values.length > 1 ? iw / (values.length - 1) : 0;
  const pts = values.map((v, i) => [Math.round((p.l + i * step) * 10) / 10, Math.round((p.t + ih - (v / nice) * ih) * 10) / 10]);
  const line = pts.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' ');
  const base = p.t + ih;
  return { max: nice, pts, line, area: pts.length ? line + ' L' + pts[pts.length - 1][0] + ' ' + base + ' L' + pts[0][0] + ' ' + base + ' Z' : '', pad: p };
}

/* ---------- Instructions dock (student runner) ---------- */
const instrPrefKey = attemptId => 'gridlab.instr.' + attemptId;
/** 'open' | 'closed' | null from a stored string. */
const parseInstrPref = v => (v === 'open' || v === 'closed' ? v : null);
/** open state: stored preference wins; otherwise open on roomy screens and closed on phones. */
function instrInitialOpen(pref, isCompact) {
  const p = parseInstrPref(pref);
  return p ? p === 'open' : !isCompact;
}

/** Message that replaces the grade when the student cannot see it yet. */
function hiddenResultMessage(resultMode) {
  if (resultMode === 'after_close') return 'Resultados disponibles al cerrar el examen.';
  if (resultMode === 'hidden') return 'En este examen la nota la publica tu docente; aquí no se muestra.';
  return 'Tus resultados todavía no están disponibles.';
}
/** What a student sees right after submitting one exercise, by feedback mode. */
function feedbackSummary(mode, out) {
  if (mode === 'none' || out.score === null || out.score === undefined) return 'Ejercicio enviado. Tu respuesta quedó registrada.';
  return 'Ejercicio calificado: ' + formatNumber(out.score) + ' de ' + formatNumber(out.maxScore) + ' puntos.';
}

root.LabCore = {
  ROLE_LABELS, roleLabel, ROLE_BADGE, isStaff,
  parseMarkdownLite, parseInlineMd, applyMdFormat,
  normalizeTag, addTag, parseEmails, generatePassword, generateAccessCode, passwordStrength, validateChangePassword, validateUserForm, pageInfo,
  FEEDBACK_MODES, RESULT_MODES, modeHelp, examSettingsToForm, validateExamSettings, examSettingsToPayload,
  newBlock, blocksFromExam, blockTotals, validateBlocks, blocksToPayload, publishChecklist, checklistReady, effPoints, publishedCount,
  barLayout, areaPath, instrPrefKey, parseInstrPref, instrInitialOpen, hiddenResultMessage, feedbackSummary,
  formatNumber, formatGrade, formatPercent,
  parseQuery, parseHash, matchRoute, safeNext, deepLinkTarget, loginHash, registerHash,
  createClock, formatDuration, timerLevel, createAutosaver,
  errorMessage, describeField, fieldSet, CODE_MESSAGES,
  validateLogin, validateRegister,
  CHECK_TYPES, blankCheckRow, checkToRow, rowToCheck, rowsToChecks, parseScalar, scalarToText, parseMatrix, matrixToText, rangeDims,
  validateExerciseForm, exerciseFormToPayload, examToForm, validateExamForm, examFormToPayload, isoToLocalInput, localInputToIso,
  DIFFICULTIES, difficultyLabel, moveItem, examCardState, statusLabel, attemptProgress, workbookKey,
};
})(typeof globalThis !== 'undefined' ? globalThis : this);

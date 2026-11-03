/* =====================================================================
   GridLab lab UI: shell, router, auth, student exams and the exam runner.
   Admin screens live in lab-admin.js and plug in through window.LabApp.

   Lab mode only starts when GET /api/auth/me answers (200 or 401). Opened from file:// or without
   an API, nothing here touches the page and the practice simulator works exactly as before.
   Pure logic is in lab-core.js (window.LabCore); the simulator bridge is window.Lab (app.js).
   ===================================================================== */
(() => {
'use strict';
const C = window.LabCore;
const Sim = window.Lab;
if (!C || !Sim) return;

/* ================= DOM helpers ================= */
let uid = 0;
const nextId = p => (p || 'lb') + (++uid);

/** Tiny element builder. Strings become text nodes (never HTML), so user data cannot inject markup. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'readOnly') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  const add = kid => {
    if (kid === undefined || kid === null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}

const fmtDate = iso => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  try { return d.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
};

const badge = (text, kind) => h('span', { class: 'badge' + (kind ? ' ' + kind : ''), text });
const notice = (kind, text, extra) => h('div', { class: 'notice ' + kind, role: kind === 'error' ? 'alert' : 'status' }, text, extra);

function loadingBox(text) {
  return h('div', { class: 'state', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text || 'Cargando…');
}
function failureBox(err, retry) {
  return h('div', { class: 'state', role: 'alert' },
    h('p', { text: C.errorMessage(err) }),
    retry ? h('button', { class: 'lb-btn', type: 'button', onclick: retry, text: 'Reintentar' }) : null);
}

/** Disables a button and shows a spinner while `on`; prevents double submits. */
function busy(btn, on) {
  if (!btn) return;
  btn.disabled = !!on;
  if (on) {
    btn.setAttribute('aria-busy', 'true');
    if (!btn.querySelector('.spinner')) btn.prepend(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  } else {
    btn.removeAttribute('aria-busy');
    const s = btn.querySelector('.spinner'); if (s) s.remove();
  }
}
async function withBusy(btn, fn) {
  if (btn && btn.disabled) return undefined;
  busy(btn, true);
  try { return await fn(); } finally { busy(btn, false); }
}

/**
 * Labeled form control. kind: input | textarea | select | check.
 * Returns { wrap, input, setError(msg), clear() }.
 */
function field(label, kind, opts) {
  opts = opts || {};
  const id = nextId('f');
  const errId = id + '-err', hintId = id + '-hint';
  let input;
  if (kind === 'textarea') input = h('textarea', { id, rows: opts.rows || 4, maxlength: opts.maxlength });
  else if (kind === 'select') input = h('select', { id }, (opts.options || []).map(o => h('option', { value: o.value, text: o.label })));
  else input = h('input', { id, type: kind === 'check' ? 'checkbox' : (opts.type || 'text'), maxlength: opts.maxlength, inputmode: opts.inputmode, min: opts.min, max: opts.max, step: opts.step, placeholder: opts.placeholder });
  if (opts.autocomplete) input.setAttribute('autocomplete', opts.autocomplete);
  if (opts.required) input.setAttribute('aria-required', 'true');
  if (opts.value !== undefined && opts.value !== null) { if (kind === 'check') input.checked = !!opts.value; else input.value = opts.value; }
  if (opts.disabled) input.disabled = true;
  const err = h('div', { class: 'err', id: errId, hidden: true });
  const hint = opts.hint ? h('div', { class: 'hint', id: hintId, text: opts.hint }) : null;
  input.setAttribute('aria-describedby', (hint ? hintId + ' ' : '') + errId);
  const wrap = kind === 'check'
    ? h('div', { class: 'lb-check' }, input, h('label', { for: id, text: label }), err)
    : h('div', { class: 'lb-field' }, h('label', { for: id, text: label }), input, hint, err);
  return {
    wrap, input,
    setError(msg) {
      err.textContent = msg || ''; err.hidden = !msg;
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    },
    clear() { this.setError(''); },
  };
}

/** Applies a { name: message } map to fields; returns the first field with an error (to focus it). */
function applyErrors(fields, errors) {
  let first = null;
  for (const [name, f] of Object.entries(fields)) {
    const msg = errors[name] || '';
    f.setError(msg);
    if (msg && !first) first = f;
  }
  return first;
}

/* ================= Modal dialogs (focus trap, Esc, restore focus) ================= */
function modal(opts) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const titleId = nextId('m');
    const actions = (opts.actions || [{ label: 'Aceptar', value: true, kind: 'primary' }]);
    const box = h('div', { class: 'box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('h2', { id: titleId, text: opts.title }),
      opts.body || null,
      h('div', { class: 'actions' }, actions.map(a => h('button', {
        type: 'button', class: 'lb-btn' + (a.kind ? ' ' + a.kind : ''), 'data-autofocus': a.autofocus ? '' : null,
        onclick: () => close(a.value), text: a.label,
      }))));
    const overlay = h('div', { class: 'lab-modal lab-ui' }, box);
    const focusables = () => [...box.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(e => !e.disabled);
    function onKey(e) {
      if (e.key === 'Escape' && opts.dismissible !== false) { e.preventDefault(); e.stopPropagation(); close(null); return; }
      if (e.key !== 'Tab') return;
      const f = focusables(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    function close(value) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previous && previous.focus && document.contains(previous)) previous.focus();
      resolve(value);
    }
    overlay.addEventListener('mousedown', e => { if (e.target === overlay && opts.dismissible !== false) close(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    const start = box.querySelector('[data-autofocus]') || focusables()[0];
    if (start) start.focus();
  });
}

/** Resolves true when the user confirms. */
async function confirmDialog(o) {
  const r = await modal({
    title: o.title,
    body: h('div', null, (Array.isArray(o.message) ? o.message : [o.message]).map(t => h('p', { text: t }))),
    actions: [
      { label: o.cancelLabel || 'Cancelar', value: false },
      { label: o.confirmLabel || 'Aceptar', value: true, kind: o.danger ? 'danger solid' : 'primary', autofocus: !o.danger },
    ],
  });
  return r === true;
}
const infoDialog = (title, message) => modal({ title, body: h('p', { text: message }), actions: [{ label: 'Entendido', value: true, kind: 'primary', autofocus: true }] });

/* ================= API client ================= */
class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message || code);
    this.status = status; this.code = code; this.fields = fields || [];
  }
}
const state = { user: null, flash: '', pendingNext: null };

async function request(method, path, body, opts) {
  opts = opts || {};
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl && !opts.keepalive ? setTimeout(() => ctl.abort(), 25000) : null;
  const t0 = Date.now();
  let res, text = '';
  try {
    res = await fetch('/api' + path, {
      method, credentials: 'same-origin', keepalive: !!opts.keepalive,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined,
    });
    text = await res.text();
  } catch (e) {
    throw new ApiError(0, 'NETWORK', '', []);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const t1 = Date.now();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (!res.ok) {
    const er = (data && data.error) || {};
    const err = new ApiError(res.status, er.code || (res.status >= 500 ? 'INTERNAL' : 'HTTP_' + res.status), er.message || '', er.fields);
    if (res.status === 401 && !opts.noAuthRedirect && er.code === 'UNAUTHENTICATED') sessionExpired();
    throw err;
  }
  return opts.timing ? { data, t0, t1 } : data;
}
const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
  put: (p, b, o) => request('PUT', p, b, o),
  del: (p, o) => request('DELETE', p, undefined, o),
};

/* ================= Shell (top bar, strip, view) ================= */
const appEl = document.getElementById('app');
let bar, strip, view, live;
const screens = {};
let current = null;      // { leave?, destroy? } of the screen on display
let navToken = 0;
let lastHash = '';

function buildShell() {
  document.body.classList.add('lab');
  bar = h('header', { id: 'labBar', class: 'lab-ui', role: 'banner' });
  strip = h('section', { id: 'labStrip', class: 'lab-ui', 'aria-label': 'Contexto del ejercicio', hidden: true });
  view = h('main', { id: 'labView', class: 'lab-ui', tabindex: '-1', hidden: true });
  live = h('div', { class: 'sr-only', 'aria-live': 'polite', id: 'labLive' });
  document.body.insertBefore(bar, appEl);
  document.body.insertBefore(strip, appEl);
  document.body.insertBefore(view, appEl);
  document.body.appendChild(live);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(bar), new ResizeObserver(measure).observe(strip);
}
function measure() {
  const px = (bar ? bar.offsetHeight : 0) + (strip && !strip.hidden ? strip.offsetHeight : 0);
  document.documentElement.style.setProperty('--labtop', px + 'px');
}
const announce = text => { if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); } };

function showView() {
  appEl.hidden = true; strip.hidden = true; view.hidden = false;
  measure();
}
/** Shows the simulator, optionally with a context strip above it. */
function showSim(stripNode) {
  view.hidden = true; appEl.hidden = false;
  strip.replaceChildren();
  if (stripNode) { strip.appendChild(stripNode); strip.hidden = false; } else strip.hidden = true;
  measure(); Sim.refresh();
}

const navGroup = name => {
  if (name === 'practice') return 'practice';
  if (['exams', 'exam', 'attempt'].includes(name)) return 'exams';
  if (name === 'results') return 'results';
  if (['adminExercises', 'adminExerciseNew', 'adminExerciseNewSheet', 'adminExercise', 'adminExerciseSheet'].includes(name)) return 'adminExercises';
  if (['adminExams', 'adminExamNew', 'adminExam'].includes(name)) return 'adminExams';
  if (['adminResults', 'adminAttempt'].includes(name)) return 'adminResults';
  return '';
};

function renderBar(routeName) {
  const group = navGroup(routeName === undefined ? C.matchRoute(location.hash).name : routeName);
  const link = (key, href, text) => h('a', { href, 'aria-current': group === key ? 'page' : null, text });
  const u = state.user;
  bar.replaceChildren(
    h('a', { class: 'brand', href: '#/practica', text: 'GridLab' }),
    h('nav', { 'aria-label': 'Principal' },
      link('practice', '#/practica', 'Práctica libre'),
      link('exams', '#/examenes', 'Exámenes'),
      link('results', '#/resultados', 'Mis resultados'),
      u && u.role === 'admin' ? [
        h('span', { class: 'grp', text: 'Admin' }),
        link('adminExercises', '#/admin/ejercicios', 'Ejercicios'),
        link('adminExams', '#/admin/examenes', 'Exámenes'),
        link('adminResults', '#/admin/resultados', 'Resultados'),
      ] : null),
    h('div', { class: 'who' },
      u ? [
        h('span', { class: 'name', title: u.email, text: u.name }),
        u.role === 'admin' ? badge('Admin', 'info') : null,
        h('button', { class: 'lb-btn sm', type: 'button', onclick: logout, text: 'Cerrar sesión' }),
      ] : [h('a', { class: 'lb-btn sm primary', href: '#/login', text: 'Ingresar' })]));
  measure();
}

async function logout() {
  try { await api.post('/auth/logout', undefined, { noAuthRedirect: true }); } catch (e) { /* the cookie may already be gone */ }
  state.user = null;
  Sim.resetToPractice();
  renderBar();
  navigate('#/practica');
}

function sessionExpired() {
  if (!state.user) return;
  state.user = null;
  state.flash = 'Tu sesión terminó. Inicia sesión para continuar.';
  renderBar();
  const here = C.matchRoute(location.hash);
  if (here.access !== 'public') navigate(C.loginHash(safeHere()));
}
const safeHere = () => C.safeNext(location.hash) || null;
const defaultHome = () => (state.user && state.user.role === 'admin' ? '#/admin/ejercicios' : '#/examenes');

function navigate(hash, replace) {
  if (replace) {
    history.replaceState(null, '', location.pathname + location.search + hash);
    route();
  } else if (location.hash === hash) route();
  else location.hash = hash;
}

/* ================= Router ================= */
async function route() {
  const r = C.matchRoute(location.hash);
  const token = ++navToken;
  if (current && current.leave) {
    let ok = true;
    try { ok = (await current.leave(r)) !== false; } catch (e) { ok = true; }
    if (token !== navToken) return;
    if (!ok) { history.replaceState(null, '', location.pathname + location.search + lastHash); navToken--; return; }
  }
  if (current && current.destroy) { try { current.destroy(); } catch (e) { /* ignore */ } }
  current = null;
  lastHash = location.hash;

  if (r.name === 'root') return navigate('#/practica', true);
  if (r.access !== 'public' && !state.user) {
    return navigate(C.loginHash(C.safeNext(location.hash)), true);
  }
  if ((r.name === 'login' || r.name === 'register') && state.user) {
    return navigate(C.safeNext(r.query.next) || defaultHome(), true);
  }
  renderBar(r.name);

  const root = h('div');
  const ctx = { route: r, params: r.params, query: r.query, root, stale: () => token !== navToken, showView, showSim };
  if (r.name === 'practice') {
    Sim.resetToPractice();
    showSim(null);
    current = {};
    return;
  }
  if (r.access === 'admin' && state.user.role !== 'admin') {
    showView(); view.replaceChildren(h('div', { class: 'lab-page mid' }, notice('error', C.CODE_MESSAGES.FORBIDDEN))); view.scrollTop = 0;
    current = {};
    return;
  }
  const screen = screens[r.name];
  showView();
  view.replaceChildren(root);
  view.scrollTop = 0;
  if (!screen) {
    root.append(h('div', { class: 'lab-page mid' }, h('div', { class: 'state' }, h('p', { text: 'No encontramos esa página.' }), h('a', { class: 'lb-btn', href: defaultHome(), text: 'Ir al inicio' }))));
    current = {};
    return;
  }
  root.append(loadingBox());
  try {
    const result = await screen(ctx);
    if (token === navToken) {
      current = result || {};
      if (!view.hidden && !view.contains(document.activeElement)) view.focus({ preventScroll: true });
    } else if (result && result.destroy) result.destroy();
  } catch (err) {
    if (token === navToken) { root.replaceChildren(failureBox(err, () => route())); current = {}; }
  }
}

window.addEventListener('hashchange', route);

/* ================= Auth screens ================= */
function authCard(title, children) {
  return h('div', { class: 'lab-page narrow' }, h('div', { class: 'card' }, h('h1', { text: title }), children));
}

screens.login = async ctx => {
  const next = C.safeNext(ctx.query.next);
  const email = field('Correo electrónico', 'input', { type: 'email', autocomplete: 'username', required: true });
  const password = field('Contraseña', 'input', { type: 'password', autocomplete: 'current-password', required: true });
  const msg = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { class: 'lb-btn primary', type: 'submit', text: 'Ingresar' });
  const form = h('form', { novalidate: true, 'aria-label': 'Ingresar' }, email.wrap, password.wrap, msg, h('div', null, submit));
  if (state.flash) { msg.append(notice('warn', state.flash)); state.flash = ''; }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const values = { email: email.input.value, password: password.input.value };
    const errors = C.validateLogin(values);
    const first = applyErrors({ email, password }, errors);
    msg.replaceChildren();
    if (first) { first.input.focus(); return; }
    await withBusy(submit, async () => {
      try {
        state.user = await api.post('/auth/login', { email: values.email.trim(), password: values.password }, { noAuthRedirect: true });
        renderBar();
        navigate(next || defaultHome(), true);
      } catch (err) {
        msg.replaceChildren(notice('error', C.errorMessage(err)));
      }
    });
  });
  ctx.root.replaceChildren(authCard('Ingresar', [
    h('p', { class: 'muted', text: 'Ingresa para presentar exámenes y ver tus resultados.' }),
    form,
    h('p', { class: 'small' }, '¿No tienes cuenta? ', h('a', { href: C.registerHash(next), text: 'Crear cuenta' })),
    h('p', { class: 'small' }, h('a', { href: '#/practica', text: 'Seguir con la práctica libre' })),
  ]));
  email.input.focus();
};

screens.register = async ctx => {
  const next = C.safeNext(ctx.query.next);
  const f = {
    name: field('Nombre completo', 'input', { autocomplete: 'name', required: true, maxlength: 120 }),
    email: field('Correo electrónico', 'input', { type: 'email', autocomplete: 'email', required: true }),
    password: field('Contraseña', 'input', { type: 'password', autocomplete: 'new-password', required: true, hint: 'Mínimo 8 caracteres.' }),
    confirm: field('Repite la contraseña', 'input', { type: 'password', autocomplete: 'new-password', required: true }),
  };
  const msg = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { class: 'lb-btn primary', type: 'submit', text: 'Crear cuenta' });
  const form = h('form', { novalidate: true, 'aria-label': 'Crear cuenta' }, f.name.wrap, f.email.wrap, f.password.wrap, f.confirm.wrap, msg, h('div', null, submit));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const values = { name: f.name.input.value, email: f.email.input.value, password: f.password.input.value, confirm: f.confirm.input.value };
    const first = applyErrors(f, C.validateRegister(values));
    msg.replaceChildren();
    if (first) { first.input.focus(); return; }
    await withBusy(submit, async () => {
      try {
        state.user = await api.post('/auth/register', { name: values.name.trim(), email: values.email.trim(), password: values.password }, { noAuthRedirect: true });
        renderBar();
        navigate(next || defaultHome(), true);
      } catch (err) {
        if (err.code === 'EMAIL_TAKEN') { f.email.setError(C.CODE_MESSAGES.EMAIL_TAKEN); f.email.input.focus(); }
        else if (err.code === 'VALIDATION' && err.fields.length) {
          const map = {};
          err.fields.forEach(n => { map[n] = 'Valor no válido.'; });
          applyErrors(f, map);
          msg.replaceChildren(notice('error', C.errorMessage(err)));
        } else msg.replaceChildren(notice('error', C.errorMessage(err)));
      }
    });
  });
  ctx.root.replaceChildren(authCard('Crear cuenta', [
    h('p', { class: 'muted', text: 'Crea tu cuenta de estudiante para presentar exámenes.' }),
    form,
    h('p', { class: 'small' }, '¿Ya tienes cuenta? ', h('a', { href: C.loginHash(next), text: 'Ingresar' })),
  ]));
  f.name.input.focus();
};

/* ================= Student: exams list ================= */
function resultLine(exam) {
  const r = exam.result;
  if (!r) return null;
  const which = exam.gradePolicy === 'last' ? 'Último intento' : 'Mejor intento';
  return h('div', null,
    h('div', { class: 'small muted', text: which + ' (n.º ' + r.attemptNumber + ')' }),
    h('div', null, h('strong', { text: C.formatGrade(r.grade, exam.scale) }), ' · ' + C.formatPercent(r.scorePercent) + ' ', badge(r.passed ? 'Aprobado' : 'Reprobado', r.passed ? 'ok' : 'bad')));
}

function examCard(exam) {
  const st = C.examCardState(exam);
  const kind = st.key === 'available' ? 'ok' : st.key === 'running' ? 'info' : 'warn';
  const action = st.canStart
    ? h('a', { class: 'lb-btn primary', href: st.resume ? '#/intento/' + exam.inProgressAttemptId : '#/examenes/' + exam.id, text: st.cta })
    : h('button', { class: 'lb-btn', type: 'button', disabled: true, text: st.cta });
  return h('article', { class: 'card', 'aria-label': exam.title },
    h('div', { class: 'row', style: 'display:flex;gap:8px;align-items:flex-start' },
      h('h2', { style: 'flex:1', text: exam.title }), badge(st.label, kind)),
    h('div', { class: 'chips' },
      h('span', { class: 'chip', text: exam.durationMinutes + ' min' }),
      h('span', { class: 'chip', text: exam.exerciseCount + (exam.exerciseCount === 1 ? ' ejercicio' : ' ejercicios') }),
      h('span', { class: 'chip', text: 'Intentos: ' + exam.attemptsUsed + ' de ' + exam.maxAttempts }),
      h('span', { class: 'chip', text: 'Quedan: ' + exam.attemptsRemaining })),
    exam.availableUntil ? h('div', { class: 'small muted', text: 'Disponible hasta ' + fmtDate(exam.availableUntil) }) : null,
    exam.availableFrom && st.key === 'not_open' ? h('div', { class: 'small muted', text: 'Abre el ' + fmtDate(exam.availableFrom) }) : null,
    h('div', { class: 'grow' }, resultLine(exam) || h('div', { class: 'small muted', text: 'Aún no tienes resultados.' })),
    h('div', null, action));
}

screens.exams = async ctx => {
  const root = ctx.root;
  const load = async () => {
    root.replaceChildren(loadingBox('Cargando exámenes…'));
    try {
      const exams = await api.get('/exams');
      if (ctx.stale()) return;
      root.replaceChildren(h('div', { class: 'lab-page' },
        h('div', { class: 'lab-head' }, h('h1', { text: 'Exámenes' }), h('a', { class: 'lb-btn', href: '#/resultados', text: 'Mis resultados' })),
        exams.length ? h('div', { class: 'cards' }, exams.map(examCard))
          : h('div', { class: 'card state' }, h('p', { text: 'Todavía no hay exámenes publicados.' }))));
    } catch (err) { if (!ctx.stale()) root.replaceChildren(h('div', { class: 'lab-page' }, failureBox(err, load))); }
  };
  await load();
};

/* ================= Student: instructions ================= */
screens.exam = async ctx => {
  const root = ctx.root;
  const id = ctx.params.id;
  const load = async () => {
    root.replaceChildren(loadingBox('Cargando examen…'));
    let exam;
    try { exam = await api.get('/exams/' + id); } catch (err) {
      if (ctx.stale()) return;
      root.replaceChildren(h('div', { class: 'lab-page mid' }, failureBox(err, err.status === 404 ? null : load), h('p', { class: 'state' }, h('a', { class: 'lb-btn', href: '#/examenes', text: 'Volver a los exámenes' }))));
      return;
    }
    if (ctx.stale()) return;
    renderExam(exam);
  };

  function renderExam(exam) {
    const st = C.examCardState(exam);
    const policy = exam.gradePolicy === 'last' ? 'tu último intento' : 'tu mejor intento';
    const rules = [
      'Tienes ' + exam.durationMinutes + ' minutos desde que comienzas. El cronómetro corre en el servidor: si sales de la página o cierras el navegador, el tiempo sigue contando.',
      'Intentos permitidos: ' + exam.maxAttempts + ' (te quedan ' + exam.attemptsRemaining + '). La nota del examen es ' + policy + '.',
      'Recibirás ' + exam.exerciseCount + (exam.exerciseCount === 1 ? ' ejercicio' : ' ejercicios') + ' elegidos al azar; cada intento puede traer ejercicios distintos.',
      'Cada ejercicio se envía una sola vez: al enviarlo se califica al instante y ya no puedes modificarlo.',
      'Tu avance se guarda solo como borrador. Al terminar el tiempo, o al finalizar el examen, se califica automáticamente lo que no hayas enviado.',
      'Se aprueba con ' + C.formatNumber(exam.passPercent) + ' % o más. La nota se expresa sobre ' + C.formatNumber(exam.scale) + '.',
    ];
    const msg = h('div', { 'aria-live': 'polite' });
    let action;
    if (st.resume) {
      action = h('a', { class: 'lb-btn primary', href: '#/intento/' + exam.inProgressAttemptId, text: 'Continuar intento' });
    } else {
      const accept = field('He leído y acepto las instrucciones', 'check', { required: true });
      const start = h('button', { class: 'lb-btn primary', type: 'button', disabled: true, text: 'Comenzar intento' });
      const sync = () => { start.disabled = !(accept.input.checked && st.canStart) || start.hasAttribute('aria-busy'); };
      accept.input.addEventListener('change', sync);
      if (!st.canStart) accept.input.disabled = true;
      start.addEventListener('click', () => withBusy(start, async () => {
        msg.replaceChildren();
        if (!accept.input.checked) return;
        try {
          const created = await api.post('/exams/' + id + '/attempts', { accepted: true });
          navigate('#/intento/' + created.id);
        } catch (err) { msg.replaceChildren(notice('error', C.errorMessage(err))); }
      }));
      action = h('div', null, accept.wrap, h('div', null, start));
    }
    const blocked = !st.canStart ? notice('warn', st.key === 'closed' ? C.CODE_MESSAGES.EXAM_CLOSED : st.key === 'not_open' ? C.CODE_MESSAGES.EXAM_NOT_OPEN : C.CODE_MESSAGES.NO_ATTEMPTS_LEFT) : null;
    root.replaceChildren(h('div', { class: 'lab-page mid' },
      h('div', { class: 'lab-head' }, h('h1', { text: exam.title }), h('a', { class: 'lb-btn', href: '#/examenes', text: 'Volver a los exámenes' })),
      st.resume ? notice('ok', 'Tienes un intento en curso. El tiempo sigue corriendo.') : null,
      blocked,
      h('div', { class: 'card' },
        h('h2', { text: 'Instrucciones' }),
        exam.instructions ? h('p', { class: 'pre', text: exam.instructions }) : h('p', { class: 'muted', text: 'Este examen no tiene instrucciones adicionales.' }),
        h('h3', { text: 'Reglas' }),
        h('ul', { class: 'rules' }, rules.map(t => h('li', { text: t })))),
      exam.result ? h('div', { class: 'card' }, h('h2', { text: 'Tu resultado actual' }), resultLine(exam)) : null,
      h('div', { class: 'card' }, action, msg)));
  }
  await load();
};

/* ================= Student: results ================= */
function attemptRows(attempts, scale) {
  return attempts.map(a => h('tr', null,
    h('td', { text: 'Intento ' + a.number }),
    h('td', null, badge(C.statusLabel(a.status), a.status === 'in_progress' ? 'info' : '')),
    h('td', { class: 'num', text: a.status === 'in_progress' ? '-' : C.formatGrade(a.grade, scale) }),
    h('td', { class: 'num', text: a.status === 'in_progress' ? '-' : C.formatPercent(a.scorePercent) }),
    h('td', { class: 'nowrap', text: fmtDate(a.submittedAt || a.startedAt) }),
    h('td', null, h('a', { class: 'lb-btn sm', href: '#/intento/' + a.id, text: a.status === 'in_progress' ? 'Continuar' : 'Ver detalle' }))));
}

screens.results = async ctx => {
  const root = ctx.root;
  const load = async () => {
    root.replaceChildren(loadingBox('Cargando resultados…'));
    try {
      const rows = await api.get('/me/results');
      if (ctx.stale()) return;
      root.replaceChildren(h('div', { class: 'lab-page' },
        h('div', { class: 'lab-head' }, h('h1', { text: 'Mis resultados' }), h('a', { class: 'lb-btn', href: '#/examenes', text: 'Ver exámenes' })),
        rows.length ? rows.map(r => h('section', { class: 'card', 'aria-label': r.title },
          h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
            h('h2', { style: 'flex:1', text: r.title }),
            h('span', { class: 'chip', text: 'Intentos: ' + r.attemptsUsed + ' de ' + r.maxAttempts }),
            r.result ? badge(r.result.passed ? 'Aprobado' : 'Reprobado', r.result.passed ? 'ok' : 'bad') : badge('Sin calificar')),
          r.result ? h('p', null, 'Resultado que cuenta (', r.gradePolicy === 'last' ? 'último intento' : 'mejor intento', ', n.º ' + r.result.attemptNumber + '): ',
            h('strong', { text: C.formatGrade(r.result.grade, r.scale) }), ' · ' + C.formatPercent(r.result.scorePercent)) : h('p', { class: 'muted', text: 'Todavía no tienes intentos terminados.' }),
          h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, ['Intento', 'Estado', 'Nota', 'Porcentaje', 'Fecha', ''].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'num' : null, text: t })))),
            h('tbody', null, attemptRows(r.attempts, r.scale)))))
        ) : h('div', { class: 'card state' }, h('p', { text: 'Aún no has presentado ningún examen.' }), h('a', { class: 'lb-btn primary', href: '#/examenes', text: 'Ir a los exámenes' }))));
    } catch (err) { if (!ctx.stale()) root.replaceChildren(h('div', { class: 'lab-page' }, failureBox(err, load))); }
  };
  await load();
};

/* ================= Exam runner ================= */
function checkList(results) {
  return h('ul', { class: 'checks' }, results.map(r => h('li', { class: r.passed ? 'pass' : 'fail' },
    h('span', { class: 'mark', 'aria-hidden': 'true', text: r.passed ? '✓' : '✗' }),
    h('span', null, r.label, h('span', { class: 'sr-only', text: r.passed ? ' (correcto)' : ' (incorrecto)' })),
    h('span', { class: 'pts', text: C.formatNumber(r.earned) + ' / ' + C.formatNumber(r.points) }))));
}

function attemptResult(ctx, v) {
  const root = ctx.root;
  const body = h('div', { class: 'lab-page mid' },
    h('div', { class: 'lab-head' },
      h('h1', { text: v.examTitle }),
      h('span', { class: 'chip', text: 'Intento ' + v.number }),
      v.status === 'expired' ? badge('Tiempo agotado', 'warn') : badge('Enviado', 'info')),
    v.status === 'expired' ? notice('warn', 'El tiempo se agotó: se calificó lo último que habías guardado.') : null,
    h('section', { class: 'card', 'aria-label': 'Resultado' },
      h('div', { class: 'score' },
        h('div', null, h('div', { class: 'small muted', text: 'Porcentaje' }), h('div', { class: 'big', text: C.formatPercent(v.scorePercent) })),
        h('div', null, h('div', { class: 'small muted', text: 'Nota' }), h('div', { class: 'big', text: C.formatGrade(v.grade, v.scale) })),
        h('div', null, v.passed === null ? null : badge(v.passed ? 'Aprobado' : 'Reprobado', v.passed ? 'ok' : 'bad'),
          h('div', { class: 'small muted', text: 'Se aprueba con ' + C.formatNumber(v.passPercent) + ' %' })))),
    h('section', { class: 'card', 'aria-label': 'Detalle por ejercicio' },
      h('h2', { text: 'Por ejercicio' }),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Ejercicio', 'Puntaje'].map((t, i) => h('th', { class: i ? 'num' : null, text: t })))),
        h('tbody', null, v.exercises.map(e => h('tr', null, h('td', { text: e.position + '. ' + e.title }), h('td', { class: 'num', text: C.formatNumber(e.score || 0) + ' / ' + C.formatNumber(e.maxScore) })))))),
      h('div', { style: 'margin-top:10px' }, v.exercises.filter(e => e.results && e.results.length).map(e => h('details', { class: 'fold' },
        h('summary', { text: e.position + '. ' + e.title + ' — ' + C.formatNumber(e.score || 0) + ' / ' + C.formatNumber(e.maxScore) }), checkList(e.results))))));
  const actions = h('div', { class: 'card', style: 'display:flex;gap:8px;flex-wrap:wrap' },
    h('a', { class: 'lb-btn primary', href: '#/examenes', text: 'Volver a mis exámenes' }),
    h('a', { class: 'lb-btn', href: '#/resultados', text: 'Mis resultados' }));
  body.append(actions);
  root.replaceChildren(body);
  api.get('/exams/' + v.examId).then(exam => {
    if (ctx.stale()) return;
    const st = C.examCardState(exam);
    if (st.canStart && !st.resume) actions.append(h('a', { class: 'lb-btn', href: '#/examenes/' + exam.id, text: 'Otro intento (' + exam.attemptsRemaining + ' disponible' + (exam.attemptsRemaining === 1 ? '' : 's') + ')' }));
    else if (st.resume) actions.append(h('a', { class: 'lb-btn', href: '#/intento/' + exam.inProgressAttemptId, text: 'Continuar intento en curso' }));
  }).catch(() => { /* optional extra button */ });
  return {};
}

screens.attempt = async ctx => {
  const root = ctx.root;
  let first;
  try {
    first = await api.get('/attempts/' + ctx.params.id, { timing: true });
  } catch (err) {
    if (ctx.stale()) return {};
    root.replaceChildren(h('div', { class: 'lab-page mid' }, failureBox(err, err.status === 404 ? null : () => route()), h('p', { class: 'state' }, h('a', { class: 'lb-btn', href: '#/examenes', text: 'Volver a los exámenes' }))));
    return {};
  }
  if (ctx.stale()) return {};
  if (first.data.status !== 'in_progress') return attemptResult(ctx, first.data);
  return runAttempt(ctx, first.data, first.t0, first.t1);
};

function runAttempt(ctx, initial, t0, t1) {
  const root = ctx.root;
  let v = initial;
  const clock = C.createClock();
  clock.sync(v.serverNow, t0, t1);
  const R = { cur: 0, busy: false, ending: false, over: false, warned5: false, warned1: false, panelOpen: !window.matchMedia('(max-height: 540px)').matches };
  const savedKey = {};     // exerciseId -> workbookKey of what the server has
  let unsub = null, timerId = 0, destroyed = false;

  /* ----- strip ----- */
  const titleEl = h('span', { class: 'title' });
  const progressEl = h('span', { class: 'chip' });
  const timerEl = h('span', { class: 'timer', role: 'timer', 'aria-label': 'Tiempo restante' });
  const saveEl = h('span', { class: 'savestate', 'aria-live': 'off' });
  const panelBtn = h('button', { class: 'lb-btn sm', type: 'button', 'aria-controls': 'runPanel', onclick: () => { R.panelOpen = !R.panelOpen; refresh(); }, text: 'Instrucciones' });
  const submitBtn = h('button', { class: 'lb-btn sm primary', type: 'button', onclick: () => submitCurrent(), text: 'Terminar ejercicio' });
  const finishBtn = h('button', { class: 'lb-btn sm danger', type: 'button', onclick: () => finishExam(false), text: 'Finalizar examen' });
  const stepper = h('div', { class: 'stepper', role: 'group', 'aria-label': 'Ejercicios' });
  const panel = h('div', { class: 'panel', id: 'runPanel', role: 'region', 'aria-label': 'Instrucciones del ejercicio' });
  const stripNode = h('div', null,
    h('div', { class: 'row' }, titleEl, h('span', { class: 'chip', text: 'Intento ' + v.number }), progressEl, timerEl, saveEl,
      h('span', { class: 'spacer' }), panelBtn, submitBtn, finishBtn),
    h('div', { class: 'row' }, stepper),
    panel);

  const exercise = () => v.exercises[R.cur];
  const submittedCount = () => v.exercises.filter(e => e.submitted).length;

  function refresh() {
    const ex = exercise();
    titleEl.textContent = v.examTitle; titleEl.title = v.examTitle;
    progressEl.textContent = (R.cur + 1) + ' de ' + v.exercises.length + ' ejercicios · ' + submittedCount() + ' enviados';
    const stepFocus = stepper.contains(document.activeElement);
    stepper.replaceChildren(...v.exercises.map((e, i) => h('button', {
      class: 'step' + (e.submitted ? ' done' : ''), type: 'button', 'aria-current': i === R.cur ? 'true' : null,
      'aria-label': 'Ejercicio ' + (i + 1) + (e.submitted ? ', calificado' : ''), title: e.title,
      onclick: () => goTo(i),
    }, String(i + 1), e.submitted ? h('span', { 'aria-hidden': 'true', text: '✓' }) : null)));
    if (stepFocus && stepper.children[R.cur]) stepper.children[R.cur].focus();
    submitBtn.disabled = R.busy || R.ending || ex.submitted;
    finishBtn.disabled = R.busy || R.ending;
    panelBtn.setAttribute('aria-expanded', R.panelOpen ? 'true' : 'false');
    panelBtn.textContent = R.panelOpen ? 'Ocultar instrucciones' : 'Instrucciones';
    panel.hidden = !R.panelOpen;
    panel.replaceChildren(
      h('h3', null, (R.cur + 1) + '. ' + ex.title + ' ', ex.submitted ? badge('Calificado', 'ok') : badge(C.formatNumber(ex.points) + ' pts')),
      ex.instructions ? h('p', { class: 'pre', text: ex.instructions }) : h('p', { class: 'muted', text: 'Este ejercicio no tiene instrucciones.' }),
      ex.submitted ? h('div', null,
        h('p', null, h('strong', { text: 'Puntaje: ' + C.formatNumber(ex.score || 0) + ' / ' + C.formatNumber(ex.maxScore) }), ' (el ejercicio quedó bloqueado)'),
        ex.results ? checkList(ex.results) : null) : null);
    measure();
  }

  function setSave(text, bad) {
    saveEl.textContent = text; saveEl.className = 'savestate' + (bad ? ' bad' : '');
    Sim.setSaveLabel('· ' + text);
  }

  /* ----- drafts ----- */
  async function putDraft(ex) {
    const snap = ex.workbook;
    const key = C.workbookKey(snap);
    ex.needsSave = false;
    try {
      const out = await api.put('/attempts/' + v.id + '/exercises/' + ex.id + '/draft', { workbook: snap }, { timing: true });
      clock.sync(out.data.savedAt, out.t0, out.t1);
      savedKey[ex.id] = key;
    } catch (err) {
      if (err.code === 'EXERCISE_ALREADY_SUBMITTED') return;
      ex.needsSave = true;
      throw err;
    }
  }
  const saver = C.createAutosaver({
    delay: 2500, retryMs: 8000,
    save: async () => {
      setSave('Guardando…');
      for (const ex of v.exercises) if (ex.needsSave && !ex.submitted) await putDraft(ex);
    },
    onSaved: () => setSave('Borrador guardado ' + new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
    onError: err => {
      if (err.code === 'ATTEMPT_EXPIRED' || err.code === 'ATTEMPT_CLOSED') { setSave('Intento cerrado', true); reloadClosed(); return; }
      setSave('No se pudo guardar; reintentando…', true);
    },
    fatal: err => err.code === 'ATTEMPT_EXPIRED' || err.code === 'ATTEMPT_CLOSED',
  });

  function captureCurrent() {
    const ex = exercise();
    if (ex.submitted || destroyed) return;
    const snap = Sim.getWorkbook();
    const key = C.workbookKey(snap);
    if (key !== savedKey[ex.id] || ex.needsSave) { ex.workbook = snap; ex.needsSave = true; }
  }
  function onSimChange() {
    if (R.busy || R.ending || destroyed) return;
    const ex = exercise();
    if (ex.submitted) return;
    const snap = Sim.getWorkbook();
    if (C.workbookKey(snap) === savedKey[ex.id] && !ex.needsSave) return;
    ex.workbook = snap; ex.needsSave = true;
    setSave('Cambios sin guardar');
    saver.markDirty();
  }

  async function reloadClosed() {
    if (R.ending) return;
    R.ending = true; stopTimer(); saver.stop();
    try {
      const out = await api.get('/attempts/' + v.id);
      if (!destroyed) { teardown(); attemptResult(ctx, out); showView(); }
    } catch (err) { R.ending = false; Sim.toast(C.errorMessage(err)); }
  }

  /* ----- exercise switching ----- */
  function loadCurrent() {
    const ex = exercise();
    Sim.loadWorkbook(ex.workbook, { readOnly: ex.submitted, title: ex.title });
    if (savedKey[ex.id] === undefined) savedKey[ex.id] = C.workbookKey(Sim.getWorkbook());
    setSave(ex.submitted ? 'Ejercicio calificado' : 'Borrador en el servidor');
    refresh();
  }
  async function goTo(i) {
    if (i === R.cur || R.busy || R.ending) return;
    captureCurrent();
    const flushing = saver.flush();
    R.cur = i;
    loadCurrent();
    await flushing;
  }

  /* ----- submit / finish ----- */
  async function submitCurrent() {
    const ex = exercise();
    if (R.busy || R.ending || ex.submitted) return;
    const ok = await confirmDialog({
      title: 'Terminar ejercicio',
      message: ['Se enviará y calificará el ejercicio ' + (R.cur + 1) + '. Después no podrás modificarlo.'],
      confirmLabel: 'Enviar y calificar',
    });
    if (!ok || R.busy || ex.submitted || R.ending) return;
    R.busy = true; refresh(); busy(submitBtn, true);
    try {
      const snap = Sim.getWorkbook();
      await saver.flush();
      const out = await api.post('/attempts/' + v.id + '/exercises/' + ex.id + '/submit', { workbook: snap });
      ex.submitted = true; ex.score = out.score; ex.maxScore = out.maxScore; ex.results = out.results; ex.workbook = snap; ex.needsSave = false;
      savedKey[ex.id] = C.workbookKey(snap);
      Sim.setReadOnly(true);
      R.panelOpen = true;
      setSave('Ejercicio calificado');
      Sim.toast('Ejercicio calificado: ' + C.formatNumber(out.score) + ' de ' + C.formatNumber(out.maxScore) + ' puntos.');
      announce('Ejercicio calificado: ' + C.formatNumber(out.score) + ' de ' + C.formatNumber(out.maxScore) + ' puntos.');
    } catch (err) {
      if (err.code === 'ATTEMPT_EXPIRED' || err.code === 'ATTEMPT_CLOSED') { R.busy = false; busy(submitBtn, false); reloadClosed(); return; }
      if (err.code === 'EXERCISE_ALREADY_SUBMITTED') {
        try { const fresh = await api.get('/attempts/' + v.id); v = fresh; R.cur = Math.min(R.cur, v.exercises.length - 1); loadCurrent(); } catch (e2) { /* keep state */ }
      }
      Sim.toast(C.errorMessage(err));
      await infoDialog('No se pudo enviar el ejercicio', C.errorMessage(err));
    } finally {
      R.busy = false; busy(submitBtn, false); refresh();
    }
  }

  async function finishExam(auto) {
    if (R.ending || (R.busy && !auto)) return;
    if (!auto) {
      const pending = v.exercises.length - submittedCount();
      const ok = await confirmDialog({
        title: 'Finalizar examen',
        message: pending
          ? ['Tienes ' + pending + (pending === 1 ? ' ejercicio' : ' ejercicios') + ' sin enviar. Se calificará lo último que hayas guardado en cada uno.', 'Después no podrás volver a este intento.']
          : ['Todos los ejercicios están enviados. ¿Finalizar el examen y ver el resultado?'],
        confirmLabel: 'Finalizar examen', danger: true,
      });
      if (!ok || R.ending) return;
    }
    R.ending = true; R.busy = true; refresh(); busy(finishBtn, true);
    stopTimer();
    try {
      captureCurrent();
      await Promise.race([saver.flush(), new Promise(r => setTimeout(r, 6000))]);
      const out = await api.post('/attempts/' + v.id + '/finish');
      saver.stop();
      teardown();
      attemptResult(ctx, out);
      showView();
    } catch (err) {
      R.ending = false; R.busy = false; busy(finishBtn, false); refresh();
      if (auto) {
        setSave('No se pudo cerrar el intento; reintentando…', true);
        setTimeout(() => { if (!destroyed) { R.over = false; startTimer(); } }, 5000);
        return;
      }
      startTimer();
      await infoDialog('No se pudo finalizar', C.errorMessage(err));
    }
  }

  /* ----- timer ----- */
  function tick() {
    const rem = clock.remainingMs(v.deadlineAt);
    timerEl.textContent = C.formatDuration(rem);
    const level = C.timerLevel(rem);
    timerEl.className = 'timer' + (level === 'ok' ? '' : ' ' + level);
    if (level === 'warn' && !R.warned5) { R.warned5 = true; Sim.toast('Quedan 5 minutos.'); announce('Quedan cinco minutos.'); }
    if (level === 'danger' && !R.warned1) { R.warned1 = true; Sim.toast('Queda menos de 1 minuto.'); announce('Queda menos de un minuto.'); }
    if (rem <= 0 && !R.over) { R.over = true; announce('El tiempo terminó.'); finishExam(true); }
  }
  function startTimer() { stopTimer(); tick(); timerId = setInterval(tick, 1000); }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = 0; } }

  /* ----- page lifecycle ----- */
  const onVisibility = () => { if (document.visibilityState === 'hidden') { captureCurrent(); saver.flush(); } };
  const onPageHide = () => {
    captureCurrent();
    for (const ex of v.exercises) if (ex.needsSave && !ex.submitted) {
      api.put('/attempts/' + v.id + '/exercises/' + ex.id + '/draft', { workbook: ex.workbook }, { keepalive: true, noAuthRedirect: true }).catch(() => {});
    }
  };
  const onBeforeUnload = e => {
    captureCurrent();
    if (v.exercises.some(x => x.needsSave && !x.submitted)) { onPageHide(); e.preventDefault(); e.returnValue = ''; }
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onBeforeUnload);

  function teardown() {
    if (destroyed) return;
    destroyed = true; stopTimer();
    if (unsub) unsub();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('beforeunload', onBeforeUnload);
  }

  /* ----- start ----- */
  const firstOpen = v.exercises.findIndex(e => !e.submitted);
  R.cur = firstOpen >= 0 ? firstOpen : 0;
  root.replaceChildren();
  showSim(stripNode);
  loadCurrent();
  unsub = Sim.onChange(onSimChange);
  startTimer();

  return {
    async leave() {
      if (!destroyed && !R.ending) {
        captureCurrent();
        await Promise.race([saver.flush(), new Promise(r => setTimeout(r, 3000))]);
      }
      return true;
    },
    destroy() { teardown(); saver.stop(); },
  };
}

/* ================= Boot ================= */
async function probe() {
  if (typeof fetch === 'undefined' || location.protocol === 'file:') return null;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), 6000);
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin', signal: ctl ? ctl.signal : undefined });
    if (res.status !== 200 && res.status !== 401) return null;
    const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (!/json/i.test(type)) return null;
    const data = await res.json();
    if (res.status === 200) return data && data.id ? { user: data } : null;
    return data && data.error && data.error.code ? { user: null } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function start() {
  const found = await probe();
  if (!found) return;          // no API: practice simulator only, nothing else changes
  state.user = found.user;
  buildShell();

  const target = C.deepLinkTarget(location.search, location.hash);
  if (location.search || target) history.replaceState(null, '', location.pathname + (target || location.hash || ''));
  if (!location.hash) history.replaceState(null, '', location.pathname + '#/practica');
  renderBar();
  await route();
}

const LabApp = { h, api, request, ApiError, modal, confirmDialog, infoDialog, busy, withBusy, field, applyErrors, badge, notice, loadingBox, failureBox, fmtDate, checkList, state, screens, navigate, route, showView, showSim, announce, measure, C, Sim, get user() { return state.user; } };
window.LabApp = LabApp;
LabApp.ready = new Promise(resolve => setTimeout(() => { start().then(resolve, e => { console.error(e); resolve(); }); }, 0));
})();

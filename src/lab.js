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

/* Lab screens build children with conditionals (`cond ? node : null`). The native replaceChildren would
   print "null" for those, so inside lab mode it drops null/undefined/false and flattens arrays. */
const nativeReplaceChildren = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...nodes) {
  return nativeReplaceChildren.apply(this, nodes.flat(Infinity).filter(n => n !== null && n !== undefined && n !== false));
};

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

/* Inline SVG icons (24x24 stroke set). Static strings only, never user data. */
const ICONS = {
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 4.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="m2 2 20 20"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  award: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13.9 17 22l-5-3-5 3 1.5-8.1"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>',
  eyeView: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17v-6M13 17V7M18 17v-9"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  chevLeft: '<path d="m15 18-6-6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14 9l2 2"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-15.5-6.2L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.5 6.2L21 16"/><path d="M16 16h5v5"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>',
  more: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  bold: '<path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z"/>',
  italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
  heading: '<path d="M6 4v16M18 4v16M6 12h12"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
};
const SVGNS = 'http://www.w3.org/2000/svg';
function icon(name, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.innerHTML = ICONS[name] || '';
  return s;
}
/** Brand mark: green rounded square with a small spreadsheet and one selected cell. */
function brandMark(cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 28 28');
  s.setAttribute('class', 'mark' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.innerHTML = '<rect class="mk-bg" width="28" height="28" rx="7"/><path class="mk-ln" d="M6 10.5h16M6 17.5h16M12 6v16M18 6v16"/><rect class="mk-hi" x="12.7" y="11.2" width="5.6" height="5.6" rx="1"/>';
  return s;
}
const initials = name => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

const badge = (text, kind) => h('span', { class: 'badge' + (kind ? ' ' + kind : ''), text });
const NOTICE_ICONS = { error: 'alert', warn: 'alert', ok: 'check', info: 'info' };
const notice = (kind, text, extra) => h('div', { class: 'notice ' + kind, role: kind === 'error' ? 'alert' : 'status' },
  icon(NOTICE_ICONS[kind] || 'info', 'nt-ic'), h('div', { class: 'nt' }, text, extra));

function loadingBox(text) {
  return h('div', { class: 'state', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text || 'Cargando…');
}
/** Placeholder cards while a list loads (announced once to screen readers). */
function skeletonCards(n, label) {
  const cards = [];
  for (let i = 0; i < (n || 3); i++) {
    cards.push(h('div', { class: 'card sk-card', 'aria-hidden': 'true' },
      h('div', { class: 'sk sk-line w60' }), h('div', { class: 'sk sk-line w40' }),
      h('div', { class: 'sk sk-block' }), h('div', { class: 'sk sk-btn' })));
  }
  return h('div', { role: 'status' }, h('span', { class: 'sr-only', text: label || 'Cargando…' }), h('div', { class: 'cards' }, cards));
}
function failureBox(err, retry) {
  return h('div', { class: 'state fail', role: 'alert' },
    h('span', { class: 'state-ic bad' }, icon('alert')),
    h('p', { text: C.errorMessage(err) }),
    retry ? h('button', { class: 'lb-btn', type: 'button', onclick: retry, text: 'Reintentar' }) : null);
}
/** Page title block: heading, short description and optional actions on the right. */
function pageHead(title, sub, ...actions) {
  return h('div', { class: 'lab-head' },
    h('div', { class: 'lab-title' }, h('h1', { text: title }), sub ? h('p', { class: 'sub', text: sub }) : null),
    actions.length ? h('div', { class: 'lab-actions' }, actions) : null);
}
/** Empty state with an icon, a message and an optional call to action. */
function emptyBox(iconName, title, text, action) {
  return h('div', { class: 'card state empty' },
    h('span', { class: 'state-ic' }, icon(iconName)),
    h('h2', { text: title }),
    text ? h('p', { class: 'muted', text }) : null,
    action || null);
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
  let toggle = null;
  if (opts.reveal) {
    toggle = h('button', { type: 'button', class: 'reveal', 'aria-label': 'Mostrar contraseña', 'aria-pressed': 'false', onclick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      toggle.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
      toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    } }, icon('eye'));
  }
  const decorated = kind === 'input' && (opts.icon || toggle);
  const control = decorated ? h('div', { class: 'lb-control' }, opts.icon ? h('span', { class: 'lead' }, icon(opts.icon)) : null, input, toggle) : input;
  const wrap = kind === 'check'
    ? h('div', { class: 'lb-check' }, input, h('label', { for: id, text: label }), err)
    : h('div', { class: 'lb-field' }, h('label', { for: id, text: label }), control, hint, err);
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
    const box = h('div', { class: 'box' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'mhead' },
        opts.icon ? h('span', { class: 'mic ' + (opts.tone || '') }, icon(opts.icon)) : null,
        h('h2', { id: titleId, text: opts.title })),
      opts.body ? h('div', { class: 'mbody' }, opts.body) : null,
      h('div', { class: 'actions' }, actions.map(a => h('button', {
        type: 'button', class: 'lb-btn' + (a.kind ? ' ' + a.kind : ''), 'data-autofocus': a.autofocus ? '' : null,
        onclick: e => (a.handler ? a.handler(close, e.currentTarget) : close(a.value)), text: a.label,
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
    icon: o.danger ? 'alert' : 'help', tone: o.danger ? 'bad' : 'ok',
    body: h('div', null, (Array.isArray(o.message) ? o.message : [o.message]).map(t => h('p', { text: t }))),
    actions: [
      { label: o.cancelLabel || 'Cancelar', value: false },
      { label: o.confirmLabel || 'Aceptar', value: true, kind: o.danger ? 'danger solid' : 'primary', autofocus: !o.danger },
    ],
  });
  return r === true;
}
const infoDialog = (title, message) => modal({ title, icon: 'info', tone: 'info', body: h('p', { text: message }), actions: [{ label: 'Entendido', value: true, kind: 'primary', autofocus: true }] });

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
    if (res.status === 403 && er.code === 'PASSWORD_CHANGE_REQUIRED' && state.user && !state.user.mustChangePassword) {
      state.user.mustChangePassword = true;
      setTimeout(() => route(), 0);
    }
    throw err;
  }
  return opts.timing ? { data, t0, t1 } : data;
}
const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
  put: (p, b, o) => request('PUT', p, b, o),
  del: (p, o) => request('DELETE', p, undefined, o),
  patch: (p, b, o) => request('PATCH', p, b, o),
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
  document.body.classList.add('lab-screen');
  measure();
}
/** Shows the simulator, optionally with a context strip above it. */
function showSim(stripNode) {
  view.hidden = true; appEl.hidden = false;
  document.body.classList.remove('lab-screen');
  strip.replaceChildren();
  if (stripNode) { strip.appendChild(stripNode); strip.hidden = false; } else strip.hidden = true;
  measure(); Sim.refresh();
}

const navGroup = name => {
  if (name === 'practice') return 'practice';
  if (['exams', 'exam', 'attempt'].includes(name)) return 'exams';
  if (name === 'results') return 'results';
  if (String(name).startsWith('admin')) return 'admin';
  return '';
};

function renderBar(routeName) {
  const group = navGroup(routeName === undefined ? C.matchRoute(location.hash).name : routeName);
  const u = state.user;
  const locked = !!(u && u.mustChangePassword);
  const link = (key, href, text) => h('a', { href, 'aria-current': group === key ? 'page' : null, text });
  const nav = h('nav', { 'aria-label': 'Principal' },
    u && !locked ? [
      link('practice', '#/practica', 'Práctica libre'),
      link('exams', '#/examenes', 'Exámenes'),
      link('results', '#/resultados', 'Mis resultados'),
      C.isStaff(u) ? [h('span', { class: 'grp' }, icon('shield'), 'Gestión'), link('admin', '#/admin', u.role === 'admin' ? 'Administración' : 'Mi panel')] : null,
    ] : (!u ? [link('practice', '#/practica', 'Práctica libre'), link('exams', '#/examenes', 'Exámenes')] : null));
  const chipBtn = u ? h('button', { class: 'user', type: 'button', title: u.email, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Menú de ' + u.name, onclick: e => profileMenu(e.currentTarget) },
    h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(u.name) }),
    h('span', { class: 'name', text: u.name }),
    u.role !== 'student' ? h('span', { class: 'role ' + u.role, text: C.roleLabel(u.role) }) : null,
    icon('chevron', 'caret')) : null;
  bar.replaceChildren(
    h('a', { class: 'brand', href: '#/practica', 'aria-label': 'GridLab, ir a la práctica libre' }, brandMark(), h('span', { class: 'word', text: 'GridLab' })),
    nav,
    h('div', { class: 'who' },
      u ? [
        chipBtn,
        h('button', { class: 'lb-btn sm ghost out', type: 'button', onclick: logout, title: 'Cerrar sesión' }, icon('logout'), h('span', { class: 'lbl', text: 'Cerrar sesión' })),
      ] : (routeName === 'login' || routeName === 'register' ? [] : [h('a', { class: 'lb-btn sm primary', href: '#/login', text: 'Ingresar' })])));
  const here = nav.querySelector('[aria-current="page"]');
  if (here && nav.scrollWidth > nav.clientWidth) {
    const over = here.getBoundingClientRect().right - nav.getBoundingClientRect().right;
    if (over > -16) nav.scrollLeft += over + 40;
  }
  measure();
}

/* ----- popover menu (profile, row actions). items: { label, icon, onclick, danger } | { header: Node } | 'sep' ----- */
let openMenu = null;
function closeMenu(restore) {
  if (!openMenu) return;
  const m = openMenu; openMenu = null;
  document.removeEventListener('mousedown', m.onDoc, true);
  document.removeEventListener('keydown', m.onKey, true);
  m.el.remove();
  m.anchor.setAttribute('aria-expanded', 'false');
  if (restore && m.anchor.focus) m.anchor.focus();
}
function popMenu(anchor, items, opts) {
  const wasOpen = openMenu && openMenu.anchor === anchor;
  closeMenu(false);
  if (wasOpen) return;
  const el = h('div', { class: 'pop-menu lab-ui', role: 'menu', 'aria-label': (opts && opts.label) || 'Menú' });
  const buttons = [];
  for (const it of items) {
    if (it === 'sep') { el.append(h('div', { class: 'sep', role: 'separator' })); continue; }
    if (it.header) { el.append(h('div', { class: 'pm-head' }, it.header)); continue; }
    const b = h('button', { class: 'mi' + (it.danger ? ' danger' : ''), type: 'button', role: 'menuitem', disabled: it.disabled, onclick: () => { closeMenu(true); it.onclick(); } }, it.icon ? icon(it.icon) : null, h('span', { text: it.label }));
    buttons.push(b); el.append(b);
  }
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth || 220;
  el.style.top = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 6)) + 'px';
  el.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, (opts && opts.alignLeft) ? r.left : r.right - w)) + 'px';
  const onDoc = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(false); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement);
      const n = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i <= 0 ? buttons.length - 1 : i - 1);
      buttons[n].focus();
    } else if (e.key === 'Tab') closeMenu(false);
  };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  openMenu = { el, anchor, onDoc, onKey };
  anchor.setAttribute('aria-expanded', 'true');
  if (buttons[0]) buttons[0].focus();
}

/* ----- clipboard and randomness ----- */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* fall back below */ }
  try {
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0' });
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) { return false; }
}
const randomInt = n => {
  if (window.crypto && window.crypto.getRandomValues) {
    const lim = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    do { window.crypto.getRandomValues(buf); } while (buf[0] >= lim);
    return buf[0] % n;
  }
  return Math.floor(Math.random() * n);
};

/* ----- Markdown-lite renderer: tokens -> elements, text only, never innerHTML ----- */
function mdInline(tokens) {
  return tokens.map(t => (t.k === 'b' ? h('strong', { text: t.s }) : t.k === 'i' ? h('em', { text: t.s }) : t.k === 'code' ? h('code', { text: t.s }) : document.createTextNode(t.s)));
}
function renderMd(text) {
  const blocks = C.parseMarkdownLite(text);
  return h('div', { class: 'md' }, blocks.map(b => {
    if (b.t === 'h') return h('h' + (b.level + 2), { class: 'md-h' }, mdInline(b.inline));
    if (b.t === 'ul') return h('ul', null, b.items.map(it => h('li', null, mdInline(it))));
    return h('p', null, mdInline(b.inline));
  }));
}

/* ----- password fields shared by the forced screen and the profile dialog ----- */
function strengthMeter(input) {
  const bar = h('div', { class: 'pw-bar', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('i')));
  const txt = h('span', { class: 'pw-txt small muted' });
  const el = h('div', { class: 'pw-meter', 'aria-live': 'polite' }, bar, txt);
  const update = () => {
    const r = C.passwordStrength(input.value);
    el.dataset.level = String(r.score);
    [...bar.children].forEach((seg, i) => seg.classList.toggle('on', r.score > i && !!input.value));
    txt.textContent = input.value ? r.label + '. ' + r.hint : 'Mínimo 8 caracteres. Mejor si mezclas letras, números y símbolos.';
  };
  input.addEventListener('input', update); update();
  return el;
}
function passwordFields() {
  const f = {
    current: field('Contraseña actual', 'input', { type: 'password', autocomplete: 'current-password', required: true, icon: 'lock', reveal: true }),
    next: field('Nueva contraseña', 'input', { type: 'password', autocomplete: 'new-password', required: true, icon: 'lock', reveal: true }),
    confirm: field('Repite la nueva contraseña', 'input', { type: 'password', autocomplete: 'new-password', required: true, icon: 'lock', reveal: true }),
  };
  const msg = h('div', { 'aria-live': 'polite' });
  const meter = strengthMeter(f.next.input);
  const nodes = [f.current.wrap, f.next.wrap, meter, f.confirm.wrap, msg];
  async function submit() {
    const values = { current: f.current.input.value, next: f.next.input.value, confirm: f.confirm.input.value };
    const first = applyErrors(f, C.validateChangePassword(values));
    msg.replaceChildren();
    if (first) { first.input.focus(); return false; }
    try {
      await api.post('/auth/change-password', { currentPassword: values.current, newPassword: values.next }, { noAuthRedirect: true });
      return true;
    } catch (err) {
      if (err.code === 'WRONG_CURRENT_PASSWORD') { f.current.setError(C.CODE_MESSAGES.WRONG_CURRENT_PASSWORD); f.current.input.focus(); }
      else if (err.code === 'PASSWORD_UNCHANGED') { f.next.setError(C.CODE_MESSAGES.PASSWORD_UNCHANGED); f.next.input.focus(); }
      else msg.replaceChildren(notice('error', C.errorMessage(err)));
      return false;
    }
  }
  return { f, nodes, submit };
}

/** Full-page "Cambia tu contraseña" shown while the account has a temporary password. */
function forcedPasswordScreen() {
  const pw = passwordFields();
  const submit = h('button', { class: 'lb-btn primary lg block', type: 'submit', text: 'Guardar y continuar' });
  const form = h('form', { novalidate: true, 'aria-label': 'Cambia tu contraseña' }, pw.nodes, submit);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await withBusy(submit, async () => {
      if (await pw.submit()) {
        state.user.mustChangePassword = false;
        Sim.toast('Contraseña actualizada.');
        renderBar();
        const here = C.matchRoute(location.hash);
        navigate(here.name === 'login' || here.name === 'register' || here.name === 'root' ? defaultHome() : location.hash, true);
      }
    });
  });
  const wrap = authShell('Cambia tu contraseña', 'Ingresaste con una contraseña temporal. Elige una nueva para continuar.', [
    form,
    h('p', { class: 'auth-alt' }, h('button', { class: 'lb-btn link', type: 'button', onclick: logout, text: 'Cerrar sesión' })),
  ]);
  setTimeout(() => pw.f.current.input.focus(), 0);
  return wrap;
}

/* ----- profile menu and dialogs ----- */
function profileMenu(anchor) {
  const u = state.user;
  popMenu(anchor, [
    { header: h('div', null, h('strong', { text: u.name }), h('div', { class: 'small muted', text: u.email }), badge(C.roleLabel(u.role), C.ROLE_BADGE[u.role])) },
    'sep',
    { label: 'Mi perfil', icon: 'user', onclick: profileDialog },
    { label: 'Cambiar contraseña', icon: 'lock', onclick: passwordDialog },
    'sep',
    { label: 'Cerrar sesión', icon: 'logout', onclick: logout, danger: true },
  ], { label: 'Cuenta' });
}
function profileDialog() {
  const u = state.user;
  const name = field('Nombre', 'input', { value: u.name, maxlength: 120, required: true, autocomplete: 'name' });
  const msg = h('div', { 'aria-live': 'polite' });
  modal({
    title: 'Mi perfil', icon: 'user', tone: 'info',
    body: h('div', null,
      h('p', { class: 'small muted', text: u.email + ' · ' + C.roleLabel(u.role) }),
      name.wrap, msg,
      h('button', { class: 'lb-btn sm', type: 'button', onclick: () => passwordDialog() }, icon('lock'), 'Cambiar contraseña')),
    actions: [
      { label: 'Cerrar', value: false },
      { label: 'Guardar nombre', kind: 'primary', handler: async (close, btn) => {
        const v = name.input.value.trim();
        if (!v || v.length > 120) { name.setError('Escribe un nombre de hasta 120 caracteres.'); name.input.focus(); return; }
        name.clear();
        await withBusy(btn, async () => {
          try {
            const saved = await api.patch('/auth/profile', { name: v });
            state.user.name = (saved && saved.name) || v;
            renderBar(); Sim.toast('Nombre actualizado.'); close(true);
          } catch (err) { msg.replaceChildren(notice('error', C.errorMessage(err))); }
        });
      } },
    ],
  });
}
function passwordDialog() {
  const pw = passwordFields();
  modal({
    title: 'Cambiar contraseña', icon: 'lock', tone: 'info', body: h('div', null, pw.nodes),
    actions: [
      { label: 'Cancelar', value: false },
      { label: 'Cambiar contraseña', kind: 'primary', handler: async (close, btn) => {
        await withBusy(btn, async () => { if (await pw.submit()) { Sim.toast('Contraseña actualizada.'); close(true); } });
      } },
    ],
  });
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
const defaultHome = () => (C.isStaff(state.user) ? '#/admin' : '#/examenes');

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
  view.dataset.screen = r.name;
  view.dataset.area = r.name.startsWith('admin') ? 'staff' : '';
  if (state.user && state.user.mustChangePassword) {
    showView(); view.dataset.screen = 'password'; view.dataset.area = '';
    view.replaceChildren(forcedPasswordScreen()); view.scrollTop = 0;
    current = {};
    return;
  }

  const root = h('div');
  const ctx = { route: r, params: r.params, query: r.query, root, stale: () => token !== navToken, showView, showSim };
  if (r.name === 'practice') {
    Sim.resetToPractice();
    showSim(null);
    current = {};
    return;
  }
  if ((r.access === 'admin' && !C.isStaff(state.user)) || (r.access === 'sysadmin' && state.user.role !== 'admin')) {
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
/** Decorative spreadsheet backdrop: faint grid, a few sample values and formulas that type themselves. */
function authArt() {
  const COLS = 'ABCDEFGHIJ'.split('');
  const ROWS = 20;
  const data = [
    [0, 0, 'Producto'], [0, 1, 'Cant.'], [0, 2, 'Precio'], [0, 3, 'Total'],
    [1, 0, 'Cuaderno'], [1, 1, '12'], [1, 2, '3,50'], [2, 0, 'Lápiz'], [2, 1, '40'], [2, 2, '0,80'],
    [3, 0, 'Regla'], [3, 1, '8'], [3, 2, '1,20'], [4, 0, 'Carpeta'], [4, 1, '15'], [4, 2, '2,90'],
    [7, 5, 'Ana'], [7, 6, '72'], [8, 5, 'Luis'], [8, 6, '48'], [9, 5, 'Marta'], [9, 6, '91'],
    [12, 1, 'Enero'], [12, 2, '1.240'], [13, 1, 'Febrero'], [13, 2, '1.610'], [14, 1, 'Marzo'], [14, 2, '1.388'],
    [16, 4, 'Zona A'], [16, 5, '310'], [17, 4, 'Zona B'], [17, 5, '275'],
  ];
  const fx = [
    [1, 4, '=SUMA(B2:B9)', '.8s'],
    [4, 1, '=SI(C3>60;"Aprobado";"Revisar")', '4.2s'],
    [7, 3, '=BUSCARV(A4;Tabla;2;FALSO)', '7.4s'],
    [11, 4, '=PROMEDIO(D2:D9)', '10.6s'],
    [14, 5, '=CONTAR.SI(C2:C9;">60")', '3s'],
    [17, 1, '=SUMAR.SI(A:A;"Ana";B:B)', '9s'],
  ];
  return h('div', { class: 'auth-art', 'aria-hidden': 'true' },
    h('div', { class: 'ag' },
      h('div', { class: 'ag-cols' }, COLS.map(c => h('span', { text: c }))),
      h('div', { class: 'ag-rows' }, Array.from({ length: ROWS }, (_, i) => h('span', { text: String(i + 1) }))),
      h('div', { class: 'ag-body' },
        data.map(([r, c, t]) => h('span', { class: 'dv', style: '--r:' + r + ';--c:' + c, text: t })),
        fx.map(([r, c, t, d]) => h('div', { class: 'fx', style: '--r:' + r + ';--c:' + c + ';--n:' + t.length + ';--d:' + d },
          h('span', { class: 't', text: t }))))));
}

/** Split layout used by login and register: form card on the left, spreadsheet art behind and to the right. */
function authShell(title, subtitle, children) {
  return h('div', { class: 'auth' },
    authArt(),
    h('div', { class: 'auth-main' },
      h('div', { class: 'auth-card' },
        h('a', { class: 'auth-brand', href: '#/practica', 'aria-label': 'GridLab, ir a la práctica libre' }, brandMark(), h('span', { text: 'GridLab' })),
        h('h1', { text: title }),
        h('p', { class: 'auth-sub', text: subtitle }),
        children)));
}
const practiceLink = () => h('a', { class: 'lb-btn block', href: '#/practica' }, h('span', { text: 'Seguir con la práctica libre' }), icon('arrowRight'));

screens.login = async ctx => {
  const next = C.safeNext(ctx.query.next);
  const email = field('Correo electrónico', 'input', { type: 'email', autocomplete: 'username', required: true, icon: 'mail', placeholder: 'tu@correo.com' });
  const password = field('Contraseña', 'input', { type: 'password', autocomplete: 'current-password', required: true, icon: 'lock', reveal: true, placeholder: 'Tu contraseña' });
  const msg = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { class: 'lb-btn primary lg block', type: 'submit', text: 'Ingresar' });
  const form = h('form', { novalidate: true, 'aria-label': 'Ingresar' }, email.wrap, password.wrap, msg, submit);
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
  ctx.root.replaceChildren(authShell('Qué bueno verte', 'Ingresa para presentar exámenes y ver tus resultados.', [
    form,
    h('p', { class: 'auth-alt' }, '¿No tienes cuenta? ', h('a', { href: C.registerHash(next), text: 'Crear cuenta' })),
    h('div', { class: 'auth-or', 'aria-hidden': 'true' }, h('span', { text: 'o' })),
    practiceLink(),
  ]));
  email.input.focus();
};

screens.register = async ctx => {
  const next = C.safeNext(ctx.query.next);
  const f = {
    name: field('Nombre completo', 'input', { autocomplete: 'name', required: true, maxlength: 120, icon: 'user' }),
    email: field('Correo electrónico', 'input', { type: 'email', autocomplete: 'email', required: true, icon: 'mail', placeholder: 'tu@correo.com' }),
    password: field('Contraseña', 'input', { type: 'password', autocomplete: 'new-password', required: true, hint: 'Mínimo 8 caracteres.', icon: 'lock', reveal: true }),
    confirm: field('Repite la contraseña', 'input', { type: 'password', autocomplete: 'new-password', required: true, icon: 'lock', reveal: true }),
  };
  const msg = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { class: 'lb-btn primary lg block', type: 'submit', text: 'Crear cuenta' });
  const form = h('form', { novalidate: true, 'aria-label': 'Crear cuenta' }, f.name.wrap, f.email.wrap, f.password.wrap, f.confirm.wrap, msg, submit);
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
  ctx.root.replaceChildren(authShell('Crea tu cuenta', 'Crea tu cuenta de estudiante para presentar exámenes.', [
    form,
    h('p', { class: 'auth-alt' }, '¿Ya tienes cuenta? ', h('a', { href: C.loginHash(next), text: 'Ingresar' })),
    h('div', { class: 'auth-or', 'aria-hidden': 'true' }, h('span', { text: 'o' })),
    practiceLink(),
  ]));
  f.name.input.focus();
};

/* ================= Student: exams list ================= */
function resultLine(exam) {
  const r = exam.result;
  if (!r && exam.resultsVisible === false && exam.attemptsUsed > 0) return h('div', { class: 'res none' }, icon('clock'), h('span', { text: C.hiddenResultMessage(exam.resultMode) }));
  if (!r) return h('div', { class: 'res none' }, icon('award'), h('span', { text: 'Aún no tienes resultados.' }));
  const which = exam.gradePolicy === 'last' ? 'Último intento' : 'Mejor intento';
  return h('div', { class: 'res ' + (r.passed ? 'ok' : 'bad') },
    h('div', null,
      h('div', { class: 'small muted', text: which + ' (n.º ' + r.attemptNumber + ')' }),
      h('strong', { class: 'grade', text: C.formatGrade(r.grade, exam.scale) })),
    h('div', { class: 'res-meta' }, h('span', { class: 'pct', text: C.formatPercent(r.scorePercent) }), badge(r.passed ? 'Aprobado' : 'Reprobado', r.passed ? 'ok' : 'bad')));
}

const chip = (ic, text) => h('span', { class: 'chip' }, icon(ic), text);

function examCard(exam) {
  const st = C.examCardState(exam);
  const kind = { available: 'ok', running: 'info', not_open: 'warn', closed: '', no_attempts: 'warn' }[st.key] || '';
  const action = st.canStart
    ? h('a', { class: 'lb-btn primary block', href: st.resume ? '#/intento/' + exam.inProgressAttemptId : '#/examenes/' + exam.id }, st.cta, icon('arrowRight'))
    : h('button', { class: 'lb-btn block', type: 'button', disabled: true, text: st.cta });
  return h('article', { class: 'card xcard is-' + st.key, 'aria-label': exam.title },
    h('div', { class: 'xcard-head' }, h('h2', { text: exam.title }), badge(st.label, kind)),
    h('div', { class: 'chips' },
      chip('clock', exam.durationMinutes + ' min'),
      chip('list', exam.exerciseCount + (exam.exerciseCount === 1 ? ' ejercicio' : ' ejercicios')),
      chip('repeat', 'Intentos: ' + exam.attemptsUsed + ' de ' + exam.maxAttempts),
      h('span', { class: 'chip', text: 'Quedan: ' + exam.attemptsRemaining }),
      exam.extraAttempts ? chip('plus', exam.extraAttempts + (exam.extraAttempts === 1 ? ' intento extra' : ' intentos extra')) : null,
      exam.requiresCode ? chip('key', 'Con código') : null),
    exam.description ? h('p', { class: 'small muted xdesc', text: exam.description }) : null,
    exam.availableUntil ? h('div', { class: 'small muted', text: 'Disponible hasta ' + fmtDate(exam.availableUntil) }) : null,
    exam.availableFrom && st.key === 'not_open' ? h('div', { class: 'small muted', text: 'Abre el ' + fmtDate(exam.availableFrom) }) : null,
    h('div', { class: 'xfill' }, resultLine(exam)),
    h('div', null, action));
}

screens.exams = async ctx => {
  const root = ctx.root;
  const load = async () => {
    root.replaceChildren(h('div', { class: 'lab-page' }, pageHead('Exámenes', 'Elige un examen para ver sus instrucciones y comenzar.'), skeletonCards(3, 'Cargando exámenes…')));
    try {
      const exams = await api.get('/exams');
      if (ctx.stale()) return;
      root.replaceChildren(h('div', { class: 'lab-page' },
        pageHead('Exámenes', 'Elige un examen para ver sus instrucciones y comenzar.', h('a', { class: 'lb-btn', href: '#/resultados' }, icon('award'), 'Mis resultados')),
        exams.length ? h('div', { class: 'cards' }, exams.map(examCard))
          : emptyBox('inbox', 'Todavía no hay exámenes publicados.', 'Cuando tu docente publique uno, aparecerá aquí.', h('a', { class: 'lb-btn', href: '#/practica' }, 'Ir a la práctica libre'))));
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
    const resultsRule = exam.resultMode === 'after_close' ? 'Tu nota se mostrará cuando el examen cierre o cuando agotes tus intentos.'
      : exam.resultMode === 'hidden' ? 'En este examen la nota no se muestra: la publica tu docente.' : 'Verás tu nota apenas termines el intento.';
    const feedbackRule = exam.feedbackMode === 'none' ? 'Al enviar un ejercicio no verás su puntaje.'
      : exam.feedbackMode === 'score' ? 'Al enviar un ejercicio verás cuántos puntos obtuviste.' : 'Al enviar un ejercicio verás tu puntaje y qué verificaciones fallaron.';
    const rules = [
      'Tienes ' + exam.durationMinutes + ' minutos desde que comienzas. El cronómetro corre en el servidor: si sales de la página o cierras el navegador, el tiempo sigue contando.',
      'Intentos permitidos: ' + exam.maxAttempts + ' (te quedan ' + exam.attemptsRemaining + '). La nota del examen es ' + policy + '.',
      'Recibirás ' + exam.exerciseCount + (exam.exerciseCount === 1 ? ' ejercicio' : ' ejercicios') + ' elegidos al azar; cada intento puede traer ejercicios distintos.',
      'Cada ejercicio se envía una sola vez: al enviarlo se califica al instante y ya no puedes modificarlo.',
      'Tu avance se guarda solo como borrador. Al terminar el tiempo, o al finalizar el examen, se califica automáticamente lo que no hayas enviado.',
      'Se aprueba con ' + C.formatNumber(exam.passPercent) + ' % o más. La nota se expresa sobre ' + C.formatNumber(exam.scale) + '.',
      feedbackRule + ' ' + resultsRule + (exam.allowReview ? ' Al terminar podrás revisar tus respuestas.' : ''),
    ];
    const msg = h('div', { 'aria-live': 'polite' });
    let action;
    if (st.resume) {
      action = h('a', { class: 'lb-btn primary lg block', href: '#/intento/' + exam.inProgressAttemptId }, 'Continuar intento', icon('arrowRight'));
    } else {
      const accept = field('He leído y acepto las instrucciones', 'check', { required: true });
      const start = h('button', { class: 'lb-btn primary lg block', type: 'button', disabled: true, text: 'Comenzar intento' });
      const code = exam.requiresCode ? field('Código de acceso', 'input', { autocomplete: 'off', maxlength: 64, required: true, icon: 'key', hint: 'Tu docente te lo entregó para este examen.' }) : null;
      const sync = () => { start.disabled = !(accept.input.checked && st.canStart) || start.hasAttribute('aria-busy'); };
      accept.input.addEventListener('change', sync);
      if (!st.canStart) { accept.input.disabled = true; if (code) code.input.disabled = true; }
      start.addEventListener('click', () => withBusy(start, async () => {
        msg.replaceChildren();
        if (!accept.input.checked) return;
        const body = { accepted: true };
        if (code) {
          code.clear();
          if (!code.input.value.trim()) { code.setError('Escribe el código de acceso.'); code.input.focus(); return; }
          body.accessCode = code.input.value.trim();
        }
        try {
          const created = await api.post('/exams/' + id + '/attempts', body);
          navigate('#/intento/' + created.id);
        } catch (err) {
          if (code && (err.code === 'ACCESS_CODE_REQUIRED' || err.code === 'INVALID_ACCESS_CODE')) { code.setError(C.CODE_MESSAGES[err.code]); code.input.focus(); }
          else msg.replaceChildren(notice('error', C.errorMessage(err)));
        }
      }));
      action = h('div', { class: 'accept' }, code ? code.wrap : null, accept.wrap, start);
    }
    const blocked = !st.canStart ? notice('warn', st.key === 'closed' ? C.CODE_MESSAGES.EXAM_CLOSED : st.key === 'not_open' ? C.CODE_MESSAGES.EXAM_NOT_OPEN : C.CODE_MESSAGES.NO_ATTEMPTS_LEFT) : null;
    const fact = (ic, label, value) => h('li', null, h('span', { class: 'fi' }, icon(ic)), h('span', { class: 'ft' }, h('span', { class: 'fl', text: label }), h('span', { class: 'fv', text: value })));
    const side = h('aside', { class: 'side card', 'aria-label': 'Resumen del examen' },
      h('h2', { text: 'Resumen' }),
      h('ul', { class: 'facts' },
        fact('clock', 'Tiempo', exam.durationMinutes + ' minutos'),
        fact('repeat', 'Intentos', exam.attemptsUsed + ' usados de ' + exam.maxAttempts + ' · quedan ' + exam.attemptsRemaining + (exam.extraAttempts ? ' (' + exam.extraAttempts + ' extra)' : '')),
        fact('list', 'Ejercicios', exam.exerciseCount + (exam.exerciseCount === 1 ? ' por intento' : ' por intento, sorteados')),
        exam.requiresCode ? fact('key', 'Acceso', 'Necesitas el código del examen') : null,
        fact('send', 'Envío', 'Una sola vez por ejercicio'),
        fact('award', 'Aprobación', C.formatNumber(exam.passPercent) + ' % sobre ' + C.formatNumber(exam.scale))),
      h('div', { class: 'side-action' }, action, msg));
    root.replaceChildren(h('div', { class: 'lab-page wide' },
      h('a', { class: 'back', href: '#/examenes' }, icon('arrowLeft'), 'Volver a los exámenes'),
      pageHead(exam.title, exam.durationMinutes + ' minutos · ' + exam.exerciseCount + (exam.exerciseCount === 1 ? ' ejercicio' : ' ejercicios')),
      st.resume ? notice('ok', 'Tienes un intento en curso. El tiempo sigue corriendo.') : null,
      blocked,
      h('div', { class: 'split' },
        h('div', { class: 'split-main' },
          h('div', { class: 'card' },
            h('h2', { text: 'Instrucciones' }),
            exam.description ? h('p', { class: 'xlead', text: exam.description }) : null,
            exam.instructions ? renderMd(exam.instructions) : h('p', { class: 'muted', text: 'Este examen no tiene instrucciones adicionales.' }),
            h('h3', { class: 'sect', text: 'Reglas' }),
            h('ol', { class: 'rules' }, rules.map(t => h('li', { text: t })))),
          exam.result ? h('div', { class: 'card' }, h('h2', { text: 'Tu resultado actual' }), resultLine(exam)) : null),
        side)));
  }
  await load();
};

/* ================= Student: results ================= */
function attemptRows(attempts, scale) {
  return attempts.map(a => h('tr', null,
    h('td', { text: 'Intento ' + a.number }),
    h('td', null, badge(C.statusLabel(a.status), a.status === 'in_progress' ? 'info' : '')),
    h('td', { class: 'num', text: a.status === 'in_progress' || a.grade === null || a.grade === undefined ? '-' : C.formatGrade(a.grade, scale) }),
    h('td', { class: 'num', text: a.status === 'in_progress' || a.scorePercent === null || a.scorePercent === undefined ? '-' : C.formatPercent(a.scorePercent) }),
    h('td', { class: 'nowrap', text: fmtDate(a.submittedAt || a.startedAt) }),
    h('td', null, h('a', { class: 'lb-btn sm', href: '#/intento/' + a.id, text: a.status === 'in_progress' ? 'Continuar' : 'Ver detalle' }))));
}

screens.results = async ctx => {
  const root = ctx.root;
  const load = async () => {
    root.replaceChildren(h('div', { class: 'lab-page' }, pageHead('Mis resultados', 'Todos tus intentos y la nota que cuenta en cada examen.'), skeletonCards(2, 'Cargando resultados…')));
    try {
      const rows = await api.get('/me/results');
      if (ctx.stale()) return;
      root.replaceChildren(h('div', { class: 'lab-page' },
        pageHead('Mis resultados', 'Todos tus intentos y la nota que cuenta en cada examen.', h('a', { class: 'lb-btn', href: '#/examenes' }, icon('list'), 'Ver exámenes')),
        rows.length ? rows.map(r => h('section', { class: 'card rcard', 'aria-label': r.title },
          h('div', { class: 'rcard-head' },
            h('h2', { text: r.title }),
            chip('repeat', 'Intentos: ' + r.attemptsUsed + ' de ' + r.maxAttempts),
            r.result ? badge(r.result.passed ? 'Aprobado' : 'Reprobado', r.result.passed ? 'ok' : 'bad') : badge('Sin calificar')),
          !r.result && r.resultsVisible === false && r.attempts.length ? h('div', { class: 'res none' }, icon('clock'), h('span', { text: C.hiddenResultMessage(r.resultMode) })) : null,
          r.result ? h('div', { class: 'res ' + (r.result.passed ? 'ok' : 'bad') },
            h('div', null,
              h('div', { class: 'small muted', text: 'Resultado que cuenta (' + (r.gradePolicy === 'last' ? 'último intento' : 'mejor intento') + ', n.º ' + r.result.attemptNumber + ')' }),
              h('strong', { class: 'grade', text: C.formatGrade(r.result.grade, r.scale) })),
            h('div', { class: 'res-meta' }, h('span', { class: 'pct', text: C.formatPercent(r.result.scorePercent) })))
            : (r.resultsVisible === false && r.attempts.length ? null : h('p', { class: 'muted', text: 'Todavía no tienes intentos terminados.' })),
          h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, ['Intento', 'Estado', 'Nota', 'Porcentaje', 'Fecha', ''].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'num' : null, text: t })))),
            h('tbody', null, attemptRows(r.attempts, r.scale)))))
        ) : emptyBox('award', 'Aún no has presentado ningún examen.', 'Tus notas aparecerán aquí cuando termines un intento.', h('a', { class: 'lb-btn primary', href: '#/examenes' }, 'Ir a los exámenes'))));
    } catch (err) { if (!ctx.stale()) root.replaceChildren(h('div', { class: 'lab-page' }, failureBox(err, load))); }
  };
  await load();
};

/* ================= Exam runner ================= */
function checkList(results) {
  return h('ul', { class: 'checks' }, results.map(r => h('li', { class: r.passed ? 'pass' : 'fail' },
    h('span', { class: 'mark', 'aria-hidden': 'true' }, icon(r.passed ? 'check' : 'x')),
    h('span', { class: 'ct' }, r.label, h('span', { class: 'sr-only', text: r.passed ? ' (correcto)' : ' (incorrecto)' })),
    h('span', { class: 'pts', text: C.formatNumber(r.earned) + ' / ' + C.formatNumber(r.points) }))));
}

/** Circular gauge for a percentage; the arc animates in after the first paint. */
function ringGauge(pct, tone) {
  const R = 54, C2 = Math.round(2 * Math.PI * R * 100) / 100;
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 128 128');
  svg.setAttribute('class', 'ring-svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<circle class="trk" cx="64" cy="64" r="' + R + '"/><circle class="val" cx="64" cy="64" r="' + R + '" stroke-dasharray="' + C2 + '" stroke-dashoffset="' + C2 + '"/>';
  const val = svg.querySelector('.val');
  const go = () => val.setAttribute('stroke-dashoffset', String(Math.round(C2 * (1 - p / 100) * 100) / 100));
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(go)); else go();
  return svg;
}

function attemptResult(ctx, v) {
  const root = ctx.root;
  const visible = v.resultsVisible !== false && v.scorePercent !== null && v.scorePercent !== undefined;
  const tone = v.passed === null || v.passed === undefined ? '' : v.passed ? 'ok' : 'bad';
  const gradePct = v.grade === null || v.grade === undefined || !v.scale ? 0 : Math.max(0, Math.min(100, (v.grade / v.scale) * 100));
  const hero = visible ? h('section', { class: 'card hero ' + tone, 'aria-label': 'Resultado' },
    h('div', { class: 'ring ' + tone },
      ringGauge(v.scorePercent, tone),
      h('div', { class: 'ring-v' }, h('div', { class: 'big', text: C.formatPercent(v.scorePercent) }), h('div', { class: 'small muted', text: 'Porcentaje' }))),
    h('div', { class: 'hero-body' },
      h('div', { class: 'small muted', text: 'Nota' }),
      h('div', { class: 'gradeline' },
        h('strong', { class: 'bigger', text: C.formatGrade(v.grade, v.scale) }),
        v.passed === null || v.passed === undefined ? null : badge(v.passed ? 'Aprobado' : 'Reprobado', v.passed ? 'ok' : 'bad')),
      h('div', { class: 'scale', role: 'img', 'aria-label': 'Nota sobre la escala' },
        h('div', { class: 'scale-bar' }, h('i', { class: tone, style: 'width:' + gradePct + '%' }), h('b', { style: 'left:' + Math.max(0, Math.min(100, Number(v.passPercent) || 0)) + '%', title: 'Mínimo para aprobar' })),
        h('div', { class: 'scale-lbl small muted' }, h('span', { text: '0' }), h('span', { text: C.formatNumber(v.scale) }))),
      h('div', { class: 'small muted', text: 'Se aprueba con ' + C.formatNumber(v.passPercent) + ' %' })))
    : h('section', { class: 'card hidden-result', 'aria-label': 'Resultado' },
      h('span', { class: 'state-ic' }, icon('clock')),
      h('h2', { text: 'Tu intento fue enviado' }),
      h('p', { class: 'muted', text: C.hiddenResultMessage(v.resultMode) }));
  const scored = v.exercises.some(e => e.score !== null && e.score !== undefined);
  const detail = visible && scored ? h('section', { class: 'card', 'aria-label': 'Detalle por ejercicio' },
    h('h2', { text: 'Por ejercicio' }),
    h('ul', { class: 'bars' }, v.exercises.map(e => {
      const max = Number(e.maxScore) || 0, got = Number(e.score) || 0;
      const pct = max ? Math.max(0, Math.min(100, (got / max) * 100)) : 0;
      const level = pct >= (Number(v.passPercent) || 60) ? 'ok' : pct > 0 ? 'warn' : 'bad';
      return h('li', null,
        h('div', { class: 'bar-top' }, h('span', { class: 't', text: e.position + '. ' + e.title + (e.block && distinctBlocks(v.exercises) > 1 ? ' · ' + e.block : '') }), h('span', { class: 'v', text: e.score === null || e.score === undefined ? '-' : C.formatNumber(got) + ' / ' + C.formatNumber(e.maxScore) })),
        h('div', { class: 'bar' }, h('i', { class: level, style: 'width:' + pct + '%' })));
    })),
    h('div', { class: 'folds' }, v.exercises.filter(e => e.results && e.results.length).map(e => h('details', { class: 'fold' },
      h('summary', { text: e.position + '. ' + e.title + ' — ' + C.formatNumber(e.score || 0) + ' / ' + C.formatNumber(e.maxScore) }), checkList(e.results))))) : null;
  const body = h('div', { class: 'lab-page mid' },
    h('div', { class: 'lab-head' },
      h('div', { class: 'lab-title' }, h('h1', { text: v.examTitle }), h('div', { class: 'chips' }, h('span', { class: 'chip', text: 'Intento ' + v.number }),
        v.status === 'expired' ? badge('Tiempo agotado', 'warn') : badge('Enviado', 'info')))),
    v.status === 'expired' ? notice('warn', 'El tiempo se agotó: se calificó lo último que habías guardado.') : null,
    hero,
    detail);
  const actions = h('div', { class: 'result-actions' },
    h('a', { class: 'lb-btn primary', href: '#/examenes' }, icon('arrowLeft'), 'Volver a mis exámenes'),
    v.allowReview && visible ? h('a', { class: 'lb-btn', href: '#/intento/' + v.id + '?revisar=1' }, icon('eye'), 'Revisar mis respuestas') : null,
    h('a', { class: 'lb-btn', href: '#/resultados' }, 'Mis resultados'));
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

const distinctBlocks = exercises => new Set(exercises.map(e => e.block || '')).size;

/** Read-only walk through the submitted workbooks (exams with allowReview whose grade is already visible). */
function reviewAttempt(ctx, v) {
  const root = ctx.root;
  let cur = 0;
  const stepper = h('div', { class: 'stepper', role: 'group', 'aria-label': 'Ejercicios del intento' });
  const panel = h('div', { class: 'rn-panel', role: 'region', 'aria-label': 'Resultado del ejercicio' });
  const show = i => {
    cur = i;
    const e = v.exercises[i];
    stepper.replaceChildren(...v.exercises.map((x, j) => h('button', {
      class: 'step' + (x.submitted ? ' done' : ''), type: 'button', 'aria-current': j === cur ? 'true' : null, title: x.title, onclick: () => show(j),
    }, h('span', { class: 'n', text: String(j + 1) }), x.score !== null && x.score !== undefined ? h('span', { class: 'sc', text: C.formatNumber(x.score) + '/' + C.formatNumber(x.maxScore) }) : null)));
    panel.replaceChildren(
      h('div', { class: 'ph' }, h('h3', { text: e.position + '. ' + e.title }), e.score !== null && e.score !== undefined ? badge(C.formatNumber(e.score) + ' / ' + C.formatNumber(e.maxScore) + ' pts', 'info') : badge('Sin puntaje')),
      e.block && distinctBlocks(v.exercises) > 1 ? h('p', { class: 'small muted', text: 'Sección: ' + e.block }) : null,
      e.results && e.results.length ? checkList(e.results) : h('p', { class: 'muted', text: 'No hay detalle de verificaciones para este ejercicio.' }));
    Sim.loadWorkbook(e.workbook || { name: 'Libro1', sheets: [{ name: 'Hoja1', cells: {}, colW: {}, sel: { ar: 0, ac: 0, fr: 0, fc: 0 } }] }, { readOnly: true, title: e.title });
    Sim.setSaveLabel('· Revisión de tus respuestas (solo lectura)');
    measure();
  };
  const strip = h('div', { class: 'rn adm' },
    h('div', { class: 'rn-id' }, h('span', { class: 'title', text: v.examTitle }), h('span', { class: 'chip att', text: 'Intento ' + v.number }), badge('Revisión', 'info')),
    h('div', { class: 'rn-act' }, h('a', { class: 'lb-btn sm', href: '#/intento/' + v.id }, icon('arrowLeft'), 'Volver al resultado')),
    h('div', { class: 'rn-steps' }, stepper),
    panel);
  root.replaceChildren();
  showSim(strip);
  show(0);
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
  if (first.data.status !== 'in_progress') {
    if (ctx.query.revisar && first.data.allowReview && first.data.resultsVisible !== false) return reviewAttempt(ctx, first.data);
    return attemptResult(ctx, first.data);
  }
  return runAttempt(ctx, first.data, first.t0, first.t1);
};

/* ================= Instructions dock (student runner) =================
   A slim tab docked to the left edge opens a small, non-modal card with the current exercise. It
   never blocks the spreadsheet: no backdrop, no focus trap, Escape and the tab close it. */
function createInstructionsDock(attemptId) {
  const compact = () => { try { return window.matchMedia('(max-height: 540px), (max-width: 640px)').matches; } catch (e) { return false; } };
  const key = C.instrPrefKey(attemptId);
  let stored = null;
  try { stored = sessionStorage.getItem(key); } catch (e) { stored = null; }
  let open = C.instrInitialOpen(stored, compact());

  const tab = h('button', {
    class: 'instr-tab lab-ui', id: 'instrTab', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'instrCard',
    'aria-label': 'Instrucciones del ejercicio', title: 'Instrucciones del ejercicio',
    onclick: () => set(!open, true, true, !open),
  }, icon('fileText'), h('span', { class: 'lbl', text: 'Instrucciones' }));
  const titleEl = h('h2', { id: 'instrTitle', class: 'ic-title' });
  const meta = h('div', { class: 'ic-meta' });
  const body = h('div', { class: 'ic-body' });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Cerrar instrucciones', title: 'Cerrar', onclick: () => set(false, true, true) }, icon('x'));
  const card = h('section', { class: 'instr-card lab-ui', id: 'instrCard', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'instrTitle', tabindex: '-1', hidden: true },
    h('div', { class: 'ic-head' }, h('div', { class: 'ic-ttl' }, meta, titleEl), closeBtn), body);

  function set(next, focusTab, persist, focusCard) {
    open = !!next;
    tab.setAttribute('aria-expanded', open ? 'true' : 'false');
    tab.classList.toggle('is-open', open);
    card.hidden = !open;
    if (persist !== false) { try { sessionStorage.setItem(key, open ? 'open' : 'closed'); } catch (e) { /* storage may be blocked */ } }
    if (open && focusCard) card.focus({ preventScroll: true });
    if (!open && focusTab) tab.focus({ preventScroll: true });
  }
  function onKey(e) {
    if (e.key !== 'Escape' || !open || e.defaultPrevented) return;
    if (document.querySelector('.lab-modal')) return;
    const t = e.target;
    const inDock = t && t.closest && (card.contains(t) || tab.contains(t));
    // Escape inside the cell editor or the formula bar belongs to the simulator.
    if (!inDock && t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    set(false, !!inDock, true);
  }
  document.addEventListener('keydown', onKey);
  document.body.append(tab, card);
  set(open, false, false);

  return {
    tab, card,
    get isOpen() { return open; },
    open(focusCard) { set(true, false, true, focusCard); },
    close() { set(false, false, true); },
    /** info: { index, total, ex, showBlock, feedbackMode } */
    update(info) {
      const ex = info.ex;
      titleEl.textContent = (info.index + 1) + '. ' + ex.title;
      meta.replaceChildren(
        info.showBlock && ex.block ? h('span', { class: 'chip', title: 'Sección' }, icon('layers'), ex.block) : null,
        h('span', { class: 'chip' }, 'Ejercicio ' + (info.index + 1) + ' de ' + info.total),
        ex.submitted ? badge('Calificado', 'ok') : badge(C.formatNumber(ex.points) + ' pts', 'info'));
      const pct = ex.submitted && Number(ex.maxScore) && ex.score !== null && ex.score !== undefined ? Math.max(0, Math.min(100, ((Number(ex.score) || 0) / Number(ex.maxScore)) * 100)) : 0;
      body.replaceChildren(
        ex.instructions ? h('p', { class: 'pre', text: ex.instructions }) : h('p', { class: 'muted', text: 'Este ejercicio no tiene instrucciones.' }),
        ex.submitted ? h('div', { class: 'scorecard' },
          ex.score === null || ex.score === undefined
            ? h('div', { class: 'sc-top' }, h('strong', { class: 'sc-big', text: 'Respuesta enviada' }), h('span', { class: 'small muted', text: 'El ejercicio quedó bloqueado' }))
            : [
              h('div', { class: 'sc-top' }, h('strong', { class: 'sc-big', text: 'Puntaje: ' + C.formatNumber(ex.score || 0) + ' / ' + C.formatNumber(ex.maxScore) }), h('span', { class: 'small muted', text: 'El ejercicio quedó bloqueado' })),
              h('div', { class: 'bar' }, h('i', { class: pct >= 60 ? 'ok' : pct > 0 ? 'warn' : 'bad', style: 'width:' + pct + '%' })),
              ex.results ? checkList(ex.results) : null,
            ]) : null);
      body.scrollTop = 0;
    },
    destroy() { document.removeEventListener('keydown', onKey); tab.remove(); card.remove(); },
  };
}

function runAttempt(ctx, initial, t0, t1) {
  const root = ctx.root;
  let v = initial;
  const clock = C.createClock();
  clock.sync(v.serverNow, t0, t1);
  const R = { cur: 0, busy: false, ending: false, over: false, warned5: false, warned1: false };
  const savedKey = {};     // exerciseId -> workbookKey of what the server has
  let unsub = null, timerId = 0, destroyed = false;

  /* ----- strip ----- */
  const titleEl = h('span', { class: 'title' });
  const progressEl = h('span', { class: 'chip prog' });
  const timerEl = h('span', { class: 'timer', role: 'timer', 'aria-label': 'Tiempo restante' });
  const timebox = h('span', { class: 'timebox' }, icon('clock'), timerEl);
  const saveEl = h('span', { class: 'savestate', 'aria-live': 'off' });
  const submitBtn = h('button', { class: 'lb-btn sm primary', type: 'button', title: 'Terminar ejercicio', onclick: () => submitCurrent() }, icon('send'), h('span', { class: 'lbl', text: 'Terminar ejercicio' }));
  const finishBtn = h('button', { class: 'lb-btn sm danger', type: 'button', title: 'Finalizar examen', onclick: () => finishExam(false) }, icon('flag'), h('span', { class: 'lbl', text: 'Finalizar examen' }));
  const stepper = h('div', { class: 'stepper', role: 'group', 'aria-label': 'Ejercicios' });
  const dock = createInstructionsDock(v.id);
  const stripNode = h('div', { class: 'rn' },
    h('div', { class: 'rn-id' }, titleEl, h('span', { class: 'chip att', text: 'Intento ' + v.number }), progressEl),
    timebox,
    h('div', { class: 'rn-act' }, saveEl, submitBtn, finishBtn),
    h('div', { class: 'rn-steps' }, stepper));

  const exercise = () => v.exercises[R.cur];
  const submittedCount = () => v.exercises.filter(e => e.submitted).length;

  function refresh() {
    const ex = exercise();
    titleEl.textContent = v.examTitle; titleEl.title = v.examTitle;
    progressEl.textContent = (R.cur + 1) + ' de ' + v.exercises.length + ' ejercicios';
    progressEl.title = submittedCount() + ' de ' + v.exercises.length + ' ejercicios enviados';
    const stepFocus = stepper.contains(document.activeElement);
    const sections = distinctBlocks(v.exercises) > 1;
    const nodes = [];
    let lastBlock = null;
    const stepBtns = [];
    v.exercises.forEach((e, i) => {
      if (sections && (e.block || '') !== lastBlock) {
        lastBlock = e.block || '';
        nodes.push(h('span', { class: 'step-block', title: 'Sección: ' + lastBlock }, lastBlock || 'Sin sección'));
      }
      const btn = h('button', {
        class: 'step' + (e.submitted ? ' done' : ''), type: 'button', 'aria-current': i === R.cur ? 'true' : null,
        'aria-label': 'Ejercicio ' + (i + 1) + (e.block && sections ? ', sección ' + e.block : '') + (e.submitted ? ', enviado' : ''), title: (e.block && sections ? e.block + ': ' : '') + e.title,
        onclick: () => goTo(i),
      }, h('span', { class: 'n', text: String(i + 1) }), e.submitted ? h('span', { class: 'sc', 'aria-hidden': 'true' }, icon('check'), e.score !== undefined && e.score !== null ? h('span', { text: C.formatNumber(e.score) + '/' + C.formatNumber(e.maxScore) }) : null) : null);
      stepBtns.push(btn); nodes.push(btn);
    });
    stepper.replaceChildren(...nodes);
    if (stepFocus && stepBtns[R.cur]) stepBtns[R.cur].focus();
    const cur = stepBtns[R.cur];
    if (cur && cur.scrollIntoView && stepper.scrollWidth > stepper.clientWidth) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    submitBtn.disabled = R.busy || R.ending || ex.submitted;
    finishBtn.disabled = R.busy || R.ending;
    dock.update({ index: R.cur, total: v.exercises.length, ex, showBlock: sections, feedbackMode: v.feedbackMode });
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
    setSave(ex.submitted ? 'Ejercicio enviado' : 'Borrador en el servidor');
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
      ex.submitted = true; ex.score = out.score; ex.maxScore = out.maxScore; ex.results = out.results || null; ex.workbook = snap; ex.needsSave = false;
      savedKey[ex.id] = C.workbookKey(snap);
      Sim.setReadOnly(true);
      dock.open(false);
      const summary = C.feedbackSummary(out.feedbackMode || v.feedbackMode, out);
      setSave(out.score === null || out.score === undefined ? 'Ejercicio enviado' : 'Ejercicio calificado');
      Sim.toast(summary);
      announce(summary);
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
    timebox.className = 'timebox' + (level === 'ok' ? '' : ' ' + level);
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
    dock.destroy();
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

const LabApp = { renderMd, copyText, randomInt, popMenu, closeMenu, passwordFields, createInstructionsDock, icon, brandMark, pageHead, emptyBox, skeletonCards, h, api, request, ApiError, modal, confirmDialog, infoDialog, busy, withBusy, field, applyErrors, badge, notice, loadingBox, failureBox, fmtDate, checkList, state, screens, navigate, route, showView, showSim, announce, measure, C, Sim, get user() { return state.user; } };
window.LabApp = LabApp;
LabApp.ready = new Promise(resolve => setTimeout(() => { start().then(resolve, e => { console.error(e); resolve(); }); }, 0));
})();

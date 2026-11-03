/* =====================================================================
   GridLab lab UI: staff console (sidebar layout, dashboard, users, exercise bank, exam list,
   results and exam analytics). Plugs into window.LabApp (lab.js). Shared helpers are published as
   LabApp.ui for lab-admin.js (exercise editor) and lab-exam.js (exam builder).
   ===================================================================== */
(() => {
'use strict';
const K = window.LabApp;
if (!K) return;
const { icon, h, api, C, Sim, field, applyErrors, badge, notice, loadingBox, failureBox, confirmDialog, infoDialog, withBusy, fmtDate, screens, navigate, pageHead, emptyBox, modal, copyText, randomInt, popMenu } = K;

/* ================= Shared helpers ================= */
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid !== undefined && kid !== null && kid !== false) el.append(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  return el;
}
const page = (cls, ...kids) => h('div', { class: 'lab-page' + (cls ? ' ' + cls : '') }, ...kids);
const iconBtn = (ic, label, onclick, kind) => h('button', { class: 'icon-btn' + (kind ? ' ' + kind : ''), type: 'button', title: label, 'aria-label': label, onclick }, icon(ic));
const iconLink = (ic, label, href) => h('a', { class: 'icon-btn', href, title: label, 'aria-label': label }, icon(ic));
const secHead = (ic, title, desc) => h('div', { class: 'sec-head' }, h('span', { class: 'si' }, icon(ic)), h('div', null, h('h2', { text: title }), desc ? h('p', { class: 'small muted', text: desc }) : null));
const stat = (label, value, tone) => h('div', { class: 'stat' + (tone ? ' ' + tone : '') }, h('span', { class: 'k', text: label }), h('strong', { text: value }));
const statusBadge = s => badge(C.statusLabel(s), s === 'published' ? 'ok' : 'warn');
const roleBadge = r => badge(C.roleLabel(r), C.ROLE_BADGE[r]);
const diffBadge = d => badge(C.difficultyLabel(d), d === 'easy' ? 'ok' : d === 'hard' ? 'bad' : 'warn');
const tagChips = tags => (tags && tags.length ? h('span', { class: 'tags' }, tags.map(t => h('span', { class: 'tag', text: t }))) : null);
const isAdmin = () => !!K.user && K.user.role === 'admin';

function table(headers, rows, numeric, cls) {
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' + (cls ? ' ' + cls : '') },
    h('thead', null, h('tr', null, headers.map((t, i) => (t && t.nodeType ? t : h('th', { class: numeric && numeric.includes(i) ? 'num' : null, text: t }))))),
    h('tbody', null, rows)));
}
function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
/** Plain input with a label that is not wrapped in a form field (filters). */
function filterInput(label, props) {
  const f = field(label, 'input', props);
  return f;
}
function pager(total, page, pageSize, onPage) {
  const info = C.pageInfo(total, page, pageSize);
  return h('nav', { class: 'pager', 'aria-label': 'Paginación' },
    h('span', { class: 'small muted', text: total ? info.from + '–' + info.to + ' de ' + total : 'Sin resultados' }),
    h('div', { class: 'pg-btns' },
      h('button', { class: 'lb-btn sm', type: 'button', disabled: info.page <= 1, onclick: () => onPage(info.page - 1) }, icon('chevLeft'), 'Anterior'),
      h('span', { class: 'small', text: 'Página ' + info.page + ' de ' + info.pages }),
      h('button', { class: 'lb-btn sm', type: 'button', disabled: info.page >= info.pages, onclick: () => onPage(info.page + 1) }, 'Siguiente', icon('chevRight'))));
}
const ago = iso => {
  const t = Date.parse(iso);
  if (isNaN(t)) return '-';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return 'hace ' + m + ' min';
  const hr = Math.round(m / 60);
  if (hr < 24) return 'hace ' + hr + ' h';
  const d = Math.round(hr / 24);
  return d < 30 ? 'hace ' + d + ' d' : fmtDate(iso);
};
function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const qs = obj => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? '?' + s : '';
};
/** Staff members (teachers and admins) for owner filters/selectors. Admin only; cached per page load. */
let ownersCache = null;
async function loadOwners() {
  if (!isAdmin()) return [];
  if (ownersCache) return ownersCache;
  const [t, a] = await Promise.all([api.get('/admin/users?role=teacher&pageSize=100'), api.get('/admin/users?role=admin&pageSize=100')]);
  ownersCache = [...a.items, ...t.items].filter(u => u.active).sort((x, y) => x.name.localeCompare(y.name, 'es'));
  return ownersCache;
}

/* ================= Sidebar layout ================= */
const NAV = [
  { key: 'dashboard', label: 'Panel', icon: 'dashboard', href: '#/admin' },
  { key: 'exercises', label: 'Ejercicios', icon: 'fileText', href: '#/admin/ejercicios' },
  { key: 'exams', label: 'Exámenes', icon: 'list', href: '#/admin/examenes' },
  { key: 'results', label: 'Resultados', icon: 'chart', href: '#/admin/resultados' },
  { key: 'users', label: 'Usuarios', icon: 'users', href: '#/admin/usuarios', adminOnly: true },
];
const SIDE_KEY = 'gridlab.sidebar';
const navItemsFor = user => NAV.filter(n => !n.adminOnly || (user && user.role === 'admin'));

/** Renders the staff shell into ctx.root and returns the main column element. */
function staffMain(ctx, activeKey) {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDE_KEY) === 'collapsed'; } catch (e) { collapsed = false; }
  const items = navItemsFor(K.user);
  const current = items.find(n => n.key === activeKey);
  const layout = h('div', { class: 'staff' + (collapsed ? ' collapsed' : '') });
  const nav = h('nav', { class: 'st-nav', id: 'stNav', 'aria-label': 'Gestión' }, items.map(n => h('a', {
    href: n.href, title: n.label, 'aria-current': n.key === activeKey ? 'page' : null, onclick: () => layout.classList.remove('open'),
  }, icon(n.icon), h('span', { class: 'lbl', text: n.label }))));
  const menuBtn = h('button', { class: 'lb-btn sm st-menu', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'stNav', onclick: () => {
    const open = layout.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  } }, icon('menu'), h('span', { text: current ? current.label : 'Menú' }), h('span', { class: 'small muted', text: 'Menú de gestión' }));
  const collapse = h('button', { class: 'icon-btn st-collapse', type: 'button', 'aria-label': collapsed ? 'Expandir menú' : 'Contraer menú', 'aria-pressed': collapsed ? 'true' : 'false', title: collapsed ? 'Expandir menú' : 'Contraer menú', onclick: () => {
    const now = layout.classList.toggle('collapsed');
    collapse.setAttribute('aria-pressed', now ? 'true' : 'false');
    const label = now ? 'Expandir menú' : 'Contraer menú';
    collapse.setAttribute('aria-label', label); collapse.title = label;
    try { localStorage.setItem(SIDE_KEY, now ? 'collapsed' : 'open'); } catch (e) { /* storage may be blocked */ }
  } }, icon('chevLeft'));
  const scope = K.user && K.user.role === 'teacher'
    ? h('div', { class: 'st-scope small', title: 'Ves y editas solo el contenido que creaste.' }, icon('shield'), h('span', { class: 'lbl', text: 'Solo tu contenido' }))
    : h('div', { class: 'st-scope small', title: 'Ves el contenido de todos los profesores.' }, icon('shield'), h('span', { class: 'lbl', text: 'Todo el contenido' }));
  const side = h('aside', { class: 'st-side', 'aria-label': 'Navegación de gestión' }, menuBtn, nav, scope, collapse);
  const main = h('div', { class: 'st-main' });
  layout.append(side, main);
  ctx.root.replaceChildren(layout);
  return main;
}

/* ================= Dashboard ================= */
function tile(label, value, sub, ic, href) {
  const body = [h('span', { class: 'kpi-ic' }, icon(ic || 'chart')), h('div', { class: 'kpi-tx' }, h('span', { class: 'k', text: label }), h('strong', { text: String(value) }), sub ? h('span', { class: 'small muted', text: sub }) : null)];
  return href ? h('a', { class: 'kpi', href }, body) : h('div', { class: 'kpi' }, body);
}

function dayLabel(iso) {
  const d = new Date(iso + 'T12:00:00');
  return isNaN(d.getTime()) ? iso : d.getDate() + '/' + (d.getMonth() + 1);
}
/** Bar chart of attempts per day (single series: no legend, hover titles, sr-only table). */
function dailyChart(days) {
  const W = 560, H = 200;
  const values = days.map(d => d.count);
  const L = C.barLayout(values, W, H, { l: 30, r: 6, t: 10, b: 24 });
  const total = values.reduce((a, b) => a + b, 0);
  const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'Intentos por día en los últimos ' + days.length + ' días: ' + total + ' en total.' });
  const ticks = L.max <= 5 ? L.max : 5;
  for (let i = 0; i <= ticks; i++) {
    const v = Math.round((L.max / ticks) * i * 10) / 10;
    const y = L.pad.t + (H - L.pad.t - L.pad.b) * (1 - i / ticks);
    root.append(svg('line', { class: 'grid', x1: L.pad.l, x2: W - L.pad.r, y1: y, y2: y }), svg('text', { class: 'axis', x: L.pad.l - 6, y: y + 3.5, 'text-anchor': 'end' }, Number.isInteger(v) ? v : v.toFixed(1)));
  }
  L.bars.forEach(b => {
    const r = Math.min(4, b.w / 2, b.h);
    const d = b.h > 0 ? 'M' + b.x + ' ' + (b.y + b.h) + 'V' + (b.y + r) + 'Q' + b.x + ' ' + b.y + ' ' + (b.x + r) + ' ' + b.y + 'H' + (b.x + b.w - r) + 'Q' + (b.x + b.w) + ' ' + b.y + ' ' + (b.x + b.w) + ' ' + (b.y + r) + 'V' + (b.y + b.h) + 'Z' : '';
    root.append(svg('g', { class: 'bar-g' },
      svg('rect', { class: 'hit', x: b.x - 2, y: L.pad.t, width: b.w + 4, height: H - L.pad.t - L.pad.b }),
      d ? svg('path', { class: 'mark', d }) : svg('rect', { class: 'mark zero', x: b.x, y: H - L.pad.b - 1.5, width: b.w, height: 1.5 }),
      svg('title', null, dayLabel(days[b.i].date) + ': ' + b.value + (b.value === 1 ? ' intento' : ' intentos'))));
    if (days.length <= 14 || b.i % 2 === 0) root.append(svg('text', { class: 'axis', x: b.x + b.w / 2, y: H - 6, 'text-anchor': 'middle' }, dayLabel(days[b.i].date)));
  });
  return root;
}

screens.adminHome = async ctx => {
  const main = staffMain(ctx, 'dashboard');
  const load = async () => {
    main.replaceChildren(page('', pageHead('Panel', 'Resumen de la actividad.'), K.skeletonCards(3, 'Cargando el panel…')));
    let st;
    try { st = await api.get('/admin/stats'); } catch (err) { if (!ctx.stale()) main.replaceChildren(page('', failureBox(err, load))); return; }
    if (ctx.stale()) return;
    const c = st.counts;
    const own = st.scope === 'own';
    const pct = v => (v === null || v === undefined ? '-' : C.formatPercent(v));
    const tiles = [
      tile(own ? 'Estudiantes en tus exámenes' : 'Estudiantes', c.students, null, 'users', isAdmin() ? '#/admin/usuarios' : '#/admin/resultados'),
      c.teachers !== null && c.teachers !== undefined ? tile('Profesores', c.teachers, null, 'shield', '#/admin/usuarios') : null,
      tile('Ejercicios', c.exercises.total, c.exercises.published + ' publicados · ' + c.exercises.draft + ' borradores', 'fileText', '#/admin/ejercicios'),
      tile('Exámenes', c.exams.total, c.exams.published + ' publicados · ' + c.exams.draft + ' borradores', 'list', '#/admin/examenes'),
      tile('Intentos', c.attempts.total, c.attempts.last7Days + ' en 7 días · ' + c.attempts.last30Days + ' en 30 días', 'repeat', '#/admin/resultados'),
      tile('En curso ahora', c.attempts.inProgress, 'intentos sin terminar', 'clock'),
      tile('Nota promedio', pct(st.averageGradePercent), 'sobre intentos terminados', 'award'),
      tile('Aprobación', pct(st.passRate), 'de intentos calificados', 'check'),
    ];
    const hasDays = st.attemptsPerDay && st.attemptsPerDay.some(d => d.count > 0);
    const maxTop = Math.max(1, ...st.topExams.map(e => e.attempts));
    main.replaceChildren(page('',
      pageHead('Panel', own ? 'Resumen de tus ejercicios, exámenes y estudiantes.' : 'Resumen de toda la plataforma.',
        h('a', { class: 'lb-btn primary', href: '#/admin/ejercicios/nuevo' }, icon('plus'), 'Nuevo ejercicio'),
        h('a', { class: 'lb-btn', href: '#/admin/examenes/nuevo' }, icon('plus'), 'Nuevo examen'),
        h('a', { class: 'lb-btn', href: '#/admin/resultados' }, icon('chart'), 'Ver resultados')),
      h('div', { class: 'kpis' }, tiles),
      h('div', { class: 'dash-grid' },
        h('section', { class: 'card span2', 'aria-label': 'Intentos por día' },
          secHead('chart', 'Intentos por día', 'Últimos 14 días.'),
          hasDays ? h('div', { class: 'chart-box' }, dailyChart(st.attemptsPerDay)) : h('div', { class: 'empty-inline' }, icon('inbox'), h('p', { class: 'muted', text: 'Todavía no hay intentos en los últimos 14 días.' }))),
        h('section', { class: 'card', 'aria-label': 'Exámenes con más intentos' },
          secHead('award', 'Exámenes más usados'),
          st.topExams.length ? h('ul', { class: 'hbars' }, st.topExams.map(e => h('li', null,
            h('div', { class: 'bar-top' }, h('a', { class: 't', href: '#/admin/examenes/' + e.examId + '/analiticas', text: e.title }), h('span', { class: 'v', text: e.attempts + (e.attempts === 1 ? ' intento' : ' intentos') })),
            h('div', { class: 'bar' }, h('i', { class: 'brand', style: 'width:' + Math.round((e.attempts / maxTop) * 100) + '%' })))))
            : h('p', { class: 'muted', text: 'Aún no hay exámenes con intentos.' })),
        h('section', { class: 'card span2', 'aria-label': 'Intentos recientes' },
          secHead('clock', 'Intentos recientes'),
          st.recentAttempts.length ? h('ul', { class: 'feed' }, st.recentAttempts.map(a => h('li', null,
            h('span', { class: 'avatar sm', 'aria-hidden': 'true', text: (a.studentName || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase() }),
            h('div', { class: 'fd' }, h('strong', { text: a.studentName }), h('span', { class: 'small muted', text: a.examTitle })),
            h('div', { class: 'fr' },
              a.status === 'in_progress' ? badge('En curso', 'info') : a.passed === null || a.passed === undefined ? badge(C.statusLabel(a.status)) : badge(C.formatPercent(a.scorePercent) + (a.passed ? ' · Aprobado' : ' · Reprobado'), a.passed ? 'ok' : 'bad'),
              h('span', { class: 'small muted', text: ago(a.submittedAt || a.startedAt) })),
            h('a', { class: 'icon-btn', href: '#/admin/intentos/' + a.id, title: 'Ver detalle', 'aria-label': 'Ver detalle del intento de ' + a.studentName }, icon('chevRight')))))
            : emptyBox('inbox', 'Sin actividad todavía.', 'Cuando tus estudiantes presenten exámenes, los verás aquí.')),
        h('section', { class: 'card', 'aria-label': 'Acciones rápidas' },
          secHead('send', 'Acciones rápidas'),
          h('div', { class: 'quick' },
            h('a', { class: 'lb-btn', href: '#/admin/ejercicios/nuevo' }, icon('plus'), 'Nuevo ejercicio'),
            h('a', { class: 'lb-btn', href: '#/admin/examenes/nuevo' }, icon('plus'), 'Nuevo examen'),
            h('a', { class: 'lb-btn', href: '#/admin/resultados' }, icon('chart'), 'Ver resultados'),
            isAdmin() ? h('a', { class: 'lb-btn', href: '#/admin/usuarios' }, icon('userPlus'), 'Gestionar usuarios') : null)))));
  };
  await load();
  return {};
};

/* ================= Users (admin) ================= */
/** Password input with generate/copy helpers (temporary passwords). */
function passwordGenerator(label) {
  const f = field(label || 'Contraseña temporal', 'input', { type: 'text', autocomplete: 'off', required: true, maxlength: 256, icon: 'key' });
  const gen = h('button', { class: 'lb-btn sm', type: 'button', onclick: () => { f.input.value = C.generatePassword(randomInt, 12); f.setError(''); } }, icon('refresh'), 'Generar');
  const copy = h('button', { class: 'lb-btn sm', type: 'button', onclick: async () => {
    if (!f.input.value) return;
    Sim.toast((await copyText(f.input.value)) ? 'Contraseña copiada.' : 'No se pudo copiar; selecciónala y usa Ctrl+C.');
  } }, icon('copy'), 'Copiar');
  const wrap = h('div', { class: 'pwgen' }, f.wrap, h('div', { class: 'pwgen-btns' }, gen, copy));
  return { f, wrap };
}

function userDialog(existing, onSaved) {
  const editing = !!existing;
  const name = field('Nombre', 'input', { value: existing ? existing.name : '', maxlength: 120, required: true });
  const email = field('Correo electrónico', 'input', { type: 'email', value: existing ? existing.email : '', required: true, disabled: editing, autocomplete: 'off' });
  const role = field('Rol', 'select', { value: existing ? existing.role : 'student', options: Object.entries(C.ROLE_LABELS).map(([value, label]) => ({ value, label })) });
  const pw = editing ? null : passwordGenerator('Contraseña temporal');
  const must = editing ? null : field('Debe cambiar la contraseña al ingresar', 'check', { value: true });
  const msg = h('div', { 'aria-live': 'polite' });
  const fields = { name, email, role };
  if (pw) fields.password = pw.f;
  modal({
    title: editing ? 'Editar usuario' : 'Nuevo usuario', icon: editing ? 'edit' : 'userPlus', tone: 'info', wide: true,
    body: h('div', null, name.wrap, email.wrap, role.wrap, pw ? pw.wrap : null, must ? must.wrap : null, msg),
    actions: [
      { label: 'Cancelar', value: false },
      { label: editing ? 'Guardar cambios' : 'Crear usuario', kind: 'primary', handler: async (close, btn) => {
        const values = { name: name.input.value, email: email.input.value, role: role.input.value, password: pw ? pw.f.input.value : '' };
        const first = applyErrors(fields, C.validateUserForm(values, { needEmail: !editing, needPassword: !editing }));
        msg.replaceChildren();
        if (first) { first.input.focus(); return; }
        await withBusy(btn, async () => {
          try {
            if (editing) await api.patch('/admin/users/' + existing.id, { name: values.name.trim(), role: values.role });
            else await api.post('/admin/users', { name: values.name.trim(), email: values.email.trim(), role: values.role, password: values.password, mustChangePassword: must.input.checked });
            ownersCache = null;
            Sim.toast(editing ? 'Usuario actualizado.' : 'Usuario creado.');
            close(true); onSaved();
          } catch (err) {
            if (err.code === 'EMAIL_TAKEN') { email.setError(C.CODE_MESSAGES.EMAIL_TAKEN); email.input.focus(); }
            else msg.replaceChildren(notice('error', C.errorMessage(err)));
          }
        });
      } },
    ],
  });
}

function resetDialog(user, onSaved) {
  const pw = passwordGenerator('Nueva contraseña temporal');
  const msg = h('div', { 'aria-live': 'polite' });
  modal({
    title: 'Restablecer contraseña', icon: 'key', tone: 'info', wide: true,
    body: h('div', null, h('p', { text: user.name + ' (' + user.email + ') deberá cambiarla al ingresar y sus sesiones abiertas se cerrarán.' }), pw.wrap, msg),
    actions: [
      { label: 'Cancelar', value: false },
      { label: 'Restablecer', kind: 'primary', handler: async (close, btn) => {
        const v = pw.f.input.value;
        if (v.length < 8) { pw.f.setError('La contraseña debe tener al menos 8 caracteres.'); pw.f.input.focus(); return; }
        await withBusy(btn, async () => {
          try {
            await api.post('/admin/users/' + user.id + '/reset-password', { password: v });
            Sim.toast('Contraseña restablecida.');
            close(true); onSaved();
          } catch (err) { msg.replaceChildren(notice('error', C.errorMessage(err))); }
        });
      } },
    ],
  });
}

screens.adminUsers = async ctx => {
  const main = staffMain(ctx, 'users');
  const S = { q: ctx.query.q || '', role: ctx.query.role || '', active: ctx.query.active || '', page: 1 };
  const pageSize = 20;
  const q = filterInput('Buscar', { placeholder: 'Nombre o correo', value: S.q });
  const role = field('Rol', 'select', { value: S.role, options: [{ value: '', label: 'Todos' }, ...Object.entries(C.ROLE_LABELS).map(([value, label]) => ({ value, label }))] });
  const active = field('Estado', 'select', { value: S.active, options: [{ value: '', label: 'Todos' }, { value: 'true', label: 'Activos' }, { value: 'false', label: 'Desactivados' }] });
  const out = h('div', { 'aria-live': 'polite' });
  const newBtn = h('button', { class: 'lb-btn primary', type: 'button', onclick: () => userDialog(null, load) }, icon('userPlus'), 'Nuevo usuario');
  const me = K.user;

  async function load() {
    out.replaceChildren(loadingBox('Cargando usuarios…'));
    let data;
    try { data = await api.get('/admin/users' + qs({ q: S.q.trim(), role: S.role, active: S.active, page: S.page, pageSize })); } catch (err) { if (!ctx.stale()) out.replaceChildren(failureBox(err, load)); return; }
    if (ctx.stale()) return;
    const act = async (u, body, ok) => {
      try { await api.patch('/admin/users/' + u.id, body); ownersCache = null; Sim.toast(ok); await load(); }
      catch (err) { await infoDialog('No se pudo actualizar', C.errorMessage(err)); }
    };
    const rowMenu = (u, anchor) => popMenu(anchor, [
      { label: 'Editar nombre y rol', icon: 'edit', onclick: () => userDialog(u, load) },
      { label: 'Restablecer contraseña', icon: 'key', onclick: () => resetDialog(u, load), disabled: u.id === me.id },
      { label: u.active ? 'Desactivar cuenta' : 'Activar cuenta', icon: u.active ? 'x' : 'check', danger: u.active, disabled: u.id === me.id, onclick: async () => {
        if (u.active) {
          const ok = await confirmDialog({ title: 'Desactivar cuenta', message: [u.name + ' no podrá ingresar y se cerrarán sus sesiones.'], confirmLabel: 'Desactivar', danger: true });
          if (!ok) return;
        }
        act(u, { active: !u.active }, u.active ? 'Cuenta desactivada.' : 'Cuenta activada.');
      } },
    ], { label: 'Acciones de ' + u.name });
    out.replaceChildren(
      data.items.length ? table(['Usuario', 'Rol', 'Estado', 'Alta', ''], data.items.map(u => h('tr', { class: u.active ? null : 'is-off' },
        h('td', null, h('div', { class: 'who-cell' }, h('span', { class: 'avatar sm', 'aria-hidden': 'true', text: u.name.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase() }),
          h('div', null, h('strong', { text: u.name }), u.id === me.id ? h('span', { class: 'small muted', text: ' (tú)' }) : null, h('div', { class: 'small muted', text: u.email })))),
        h('td', null, roleBadge(u.role)),
        h('td', null, u.active ? badge('Activo', 'ok') : badge('Desactivado', 'bad'), u.mustChangePassword ? h('div', { class: 'small muted', text: 'Contraseña temporal' }) : null),
        h('td', { class: 'nowrap muted', text: fmtDate(u.createdAt) }),
        h('td', null, h('div', { class: 'actions' }, h('button', { class: 'icon-btn', type: 'button', title: 'Acciones', 'aria-label': 'Acciones de ' + u.name, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: e => rowMenu(u, e.currentTarget) }, icon('more')))))))
        : emptyBox('users', 'No hay usuarios con estos filtros.', 'Prueba con otra búsqueda o crea un usuario nuevo.'),
      pager(data.total, data.page, data.pageSize, p => { S.page = p; load(); }));
  }
  const reload = debounce(() => { S.page = 1; load(); }, 280);
  q.input.addEventListener('input', () => { S.q = q.input.value; reload(); });
  role.input.addEventListener('change', () => { S.role = role.input.value; S.page = 1; load(); });
  active.input.addEventListener('change', () => { S.active = active.input.value; S.page = 1; load(); });
  main.replaceChildren(page('',
    pageHead('Usuarios', 'Cuentas de estudiantes, profesores y administradores.', newBtn),
    h('div', { class: 'card filters' }, h('div', { class: 'lb-row' }, q.wrap, role.wrap, active.wrap)),
    out));
  await load();
  return { destroy() { reload.cancel(); } };
};

/* ================= Exercise bank ================= */
function importDialog(onDone) {
  const file = h('input', { type: 'file', accept: 'application/json,.json', id: 'impFile' });
  const area = field('O pega el JSON aquí', 'textarea', { rows: 7, placeholder: '[ { "title": "…", "checks": [ … ] } ]' });
  const out = h('div', { 'aria-live': 'polite' });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try { area.input.value = await f.text(); } catch (e) { out.replaceChildren(notice('error', 'No se pudo leer el archivo.')); }
  });
  modal({
    title: 'Importar ejercicios', icon: 'upload', tone: 'info', wide: true,
    body: h('div', null,
      h('p', { class: 'small muted', text: 'Acepta un archivo exportado desde ExcelLab o un arreglo de ejercicios. Se crean como borradores tuyos (máximo 100).' }),
      h('div', { class: 'lb-field' }, h('label', { for: 'impFile', text: 'Archivo JSON' }), file),
      area.wrap, out),
    actions: [
      { label: 'Cerrar', value: false },
      { label: 'Importar', kind: 'primary', handler: async (close, btn) => {
        let data;
        try { data = JSON.parse(area.input.value); } catch (e) { area.setError('Eso no es un JSON válido.'); area.input.focus(); return; }
        area.clear();
        const list = Array.isArray(data) ? data : (data && data.exercises);
        if (!Array.isArray(list) || !list.length) { area.setError('No encontré ejercicios en ese JSON.'); return; }
        await withBusy(btn, async () => {
          try {
            const res = await api.post('/admin/exercises/import', Array.isArray(data) ? data : { exercises: list });
            out.replaceChildren(notice(res.failed ? 'warn' : 'ok', 'Importados: ' + res.imported + ' · Con errores: ' + res.failed),
              h('ul', { class: 'imp-list' }, res.results.map(r => h('li', { class: r.ok ? 'ok' : 'bad' },
                h('span', { class: 'mark', 'aria-hidden': 'true' }, icon(r.ok ? 'check' : 'x')),
                h('span', { text: '#' + (r.index + 1) + ' ' + (r.title || '') + (r.ok ? '' : ' — ' + (r.error ? r.error.message || C.errorMessage(r.error) : 'Error')) })))));
            btn.textContent = 'Importar de nuevo';
            if (res.imported) onDone();
          } catch (err) { out.replaceChildren(notice('error', C.errorMessage(err))); }
        });
      } },
    ],
  });
}

screens.adminExercises = async ctx => {
  const main = staffMain(ctx, 'exercises');
  const S = { q: '', difficulty: '', tag: '', status: '', owner: '', page: 1 };
  const pageSize = 20;
  const selected = new Map();   // id -> exercise row (kept across pages)
  const q = filterInput('Buscar', { placeholder: 'Título o etiqueta' });
  const difficulty = field('Dificultad', 'select', { options: [{ value: '', label: 'Todas' }, ...C.DIFFICULTIES] });
  const tag = filterInput('Etiqueta', { placeholder: 'ej. funciones', maxlength: 30 });
  const status = field('Estado', 'select', { options: [{ value: '', label: 'Todos' }, { value: 'published', label: 'Publicados' }, { value: 'draft', label: 'Borradores' }] });
  const owner = isAdmin() ? field('Propietario', 'select', { options: [{ value: '', label: 'Todos' }] }) : null;
  if (owner) loadOwners().then(list => { if (!ctx.stale()) list.forEach(u => owner.input.append(h('option', { value: u.id, text: u.name }))); }).catch(() => {});
  const bulk = h('div', { class: 'bulk', hidden: true, role: 'region', 'aria-label': 'Acciones sobre la selección' });
  const out = h('div', { 'aria-live': 'polite' });

  const renderBulk = () => {
    bulk.hidden = selected.size === 0;
    if (!selected.size) return;
    const ids = [...selected.keys()];
    const each = async (label, fn) => {
      const fails = [];
      for (const id of ids) { try { await fn(id); } catch (err) { fails.push((selected.get(id).title) + ': ' + C.errorMessage(err)); } }
      if (fails.length) await infoDialog(label + ': ' + (ids.length - fails.length) + ' de ' + ids.length, fails.join('\n'));
      else Sim.toast(label + ': ' + ids.length + (ids.length === 1 ? ' ejercicio.' : ' ejercicios.'));
      selected.clear(); await load();
    };
    bulk.replaceChildren(
      h('strong', { text: selected.size + (selected.size === 1 ? ' seleccionado' : ' seleccionados') }),
      h('button', { class: 'lb-btn sm', type: 'button', onclick: e => withBusy(e.currentTarget, () => each('Duplicados', id => api.post('/admin/exercises/' + id + '/duplicate'))) }, icon('copy'), 'Duplicar'),
      h('button', { class: 'lb-btn sm', type: 'button', onclick: e => withBusy(e.currentTarget, async () => {
        try {
          const data = await api.get('/admin/exercises/export?ids=' + ids.join(','));
          download('ejercicios-excellab.json', JSON.stringify(data, null, 2));
          Sim.toast('Exportados ' + data.exercises.length + ' ejercicios.');
        } catch (err) { await infoDialog('No se pudo exportar', C.errorMessage(err)); }
      }) }, icon('download'), 'Exportar JSON'),
      h('button', { class: 'lb-btn sm', type: 'button', onclick: e => withBusy(e.currentTarget, () => each('Publicados', id => api.patch('/admin/exercises/' + id, { status: 'published' }))) }, icon('send'), 'Publicar'),
      h('button', { class: 'lb-btn sm', type: 'button', onclick: e => withBusy(e.currentTarget, () => each('Pasados a borrador', id => api.patch('/admin/exercises/' + id, { status: 'draft' }))) }, 'Pasar a borrador'),
      h('button', { class: 'lb-btn sm ghost', type: 'button', onclick: () => { selected.clear(); load(); } }, 'Quitar selección'));
  };

  async function load() {
    out.replaceChildren(loadingBox('Cargando ejercicios…'));
    let data;
    try { data = await api.get('/admin/exercises' + qs({ q: S.q.trim(), difficulty: S.difficulty, tag: S.tag.trim().toLowerCase(), status: S.status, owner: S.owner, page: S.page, pageSize })); } catch (err) { if (!ctx.stale()) out.replaceChildren(failureBox(err, load)); return; }
    if (ctx.stale()) return;
    const remove = async ex => {
      const ok = await confirmDialog({ title: 'Eliminar ejercicio', message: ['¿Eliminar "' + ex.title + '"? No se puede deshacer.'], confirmLabel: 'Eliminar', danger: true });
      if (!ok) return;
      try { await api.del('/admin/exercises/' + ex.id); selected.delete(ex.id); Sim.toast('Ejercicio eliminado.'); await load(); }
      catch (err) { await infoDialog('No se pudo eliminar', C.errorMessage(err)); }
    };
    const dup = async ex => {
      try { const c = await api.post('/admin/exercises/' + ex.id + '/duplicate'); Sim.toast('Copia creada como borrador.'); navigate('#/admin/ejercicios/' + c.id); }
      catch (err) { await infoDialog('No se pudo duplicar', C.errorMessage(err)); }
    };
    const allBox = h('input', { type: 'checkbox', 'aria-label': 'Seleccionar todos los de esta página', checked: data.items.length > 0 && data.items.every(e => selected.has(e.id)), onchange: e => {
      data.items.forEach(x => { if (e.currentTarget.checked) selected.set(x.id, x); else selected.delete(x.id); });
      renderBulk(); out.querySelectorAll('tbody input[type=checkbox]').forEach(cb => { cb.checked = e.currentTarget.checked; });
    } });
    const filtered = S.q || S.difficulty || S.tag || S.status || S.owner;
    out.replaceChildren(
      data.items.length ? table([h('th', { class: 'cb' }, allBox), 'Ejercicio', 'Dificultad', 'Estado', 'Verif.', 'Uso', ...(isAdmin() ? ['Propietario'] : []), 'Actualizado', ''], data.items.map(ex => h('tr', null,
        h('td', { class: 'cb' }, h('input', { type: 'checkbox', 'aria-label': 'Seleccionar ' + ex.title, checked: selected.has(ex.id), onchange: e => { if (e.currentTarget.checked) selected.set(ex.id, ex); else selected.delete(ex.id); allBox.checked = data.items.every(x => selected.has(x.id)); renderBulk(); } })),
        h('td', { class: 'ttl' }, h('a', { class: 'row-title', href: '#/admin/ejercicios/' + ex.id, text: ex.title }),
          h('div', { class: 'row-sub' }, h('span', { class: 'small muted', text: C.formatNumber(ex.points) + ' pts' + (ex.estimatedMinutes ? ' · ' + ex.estimatedMinutes + ' min' : '') + (ex.category ? ' · ' + ex.category : '') }), tagChips(ex.tags))),
        h('td', null, diffBadge(ex.difficulty)),
        h('td', null, statusBadge(ex.status)),
        h('td', { class: 'num', text: String(ex.checkCount != null ? ex.checkCount : ex.checksCount) }),
        h('td', null, ex.examCount || ex.attemptsCount ? h('span', { class: 'small', text: ex.examCount + (ex.examCount === 1 ? ' examen' : ' exámenes') + ' · ' + ex.attemptsCount + (ex.attemptsCount === 1 ? ' intento' : ' intentos') }) : h('span', { class: 'muted small', text: 'Sin usar' })),
        ...(isAdmin() ? [h('td', { class: 'small', text: ex.ownerName || '-' })] : []),
        h('td', { class: 'nowrap muted small', text: fmtDate(ex.updatedAt) }),
        h('td', null, h('div', { class: 'actions' },
          iconLink('edit', 'Editar ' + ex.title, '#/admin/ejercicios/' + ex.id),
          iconBtn('copy', 'Duplicar ' + ex.title, () => dup(ex)),
          iconBtn('trash', 'Eliminar ' + ex.title, () => remove(ex), 'danger'))))), [4])
        : (filtered ? emptyBox('search', 'Ningún ejercicio coincide con los filtros.', 'Prueba quitando alguno.')
          : emptyBox('fileText', 'Todavía no hay ejercicios.', 'Crea el primero para poder armar exámenes.', h('a', { class: 'lb-btn primary', href: '#/admin/ejercicios/nuevo', text: 'Crear el primero' }))),
      data.total > pageSize ? pager(data.total, data.page, data.pageSize, p => { S.page = p; load(); }) : '',
      data.items.some(e => e.examCount) ? h('p', { class: 'foot-note' }, icon('info'), 'Los ejercicios que ya se usaron en intentos de estudiantes no se pueden eliminar; pásalos a borrador si ya no deben salir.') : '');
    renderBulk();
  }
  const reload = debounce(() => { S.page = 1; load(); }, 280);
  q.input.addEventListener('input', () => { S.q = q.input.value; reload(); });
  tag.input.addEventListener('input', () => { S.tag = tag.input.value; reload(); });
  difficulty.input.addEventListener('change', () => { S.difficulty = difficulty.input.value; S.page = 1; load(); });
  status.input.addEventListener('change', () => { S.status = status.input.value; S.page = 1; load(); });
  if (owner) owner.input.addEventListener('change', () => { S.owner = owner.input.value; S.page = 1; load(); });
  main.replaceChildren(page('',
    pageHead('Ejercicios', 'Banco de ejercicios con sus verificaciones automáticas.',
      h('button', { class: 'lb-btn', type: 'button', onclick: () => importDialog(load) }, icon('upload'), 'Importar JSON'),
      h('a', { class: 'lb-btn primary', href: '#/admin/ejercicios/nuevo' }, icon('plus'), 'Nuevo ejercicio')),
    h('div', { class: 'card filters' }, h('div', { class: 'lb-row' }, q.wrap, difficulty.wrap, tag.wrap, status.wrap, owner ? owner.wrap : null)),
    bulk, out));
  await load();
  return { destroy() { reload.cancel(); } };
};

/* ================= Exams: list ================= */
const accessMode = ex => (ex.accessCode ? { label: 'Con código', ic: 'key' } : ex.restricted ? { label: 'Restringido', ic: 'shield' } : { label: 'Público', ic: 'users' });

screens.adminExams = async ctx => {
  const main = staffMain(ctx, 'exams');
  const S = { q: '', status: '', owner: '', page: 1 };
  const pageSize = 12;
  const q = filterInput('Buscar', { placeholder: 'Título del examen' });
  const status = field('Estado', 'select', { options: [{ value: '', label: 'Todos' }, { value: 'published', label: 'Publicados' }, { value: 'draft', label: 'Borradores' }] });
  const owner = isAdmin() ? field('Propietario', 'select', { options: [{ value: '', label: 'Todos' }] }) : null;
  if (owner) loadOwners().then(list => { if (!ctx.stale()) list.forEach(u => owner.input.append(h('option', { value: u.id, text: u.name }))); }).catch(() => {});
  const out = h('div', { 'aria-live': 'polite' });

  async function load() {
    out.replaceChildren(K.skeletonCards(3, 'Cargando exámenes…'));
    let data;
    try { data = await api.get('/admin/exams' + qs({ q: S.q.trim(), status: S.status, owner: S.owner, page: S.page, pageSize })); } catch (err) { if (!ctx.stale()) out.replaceChildren(failureBox(err, load)); return; }
    if (ctx.stale()) return;
    const toggle = (ex, btn) => withBusy(btn, async () => {
      try { await api.put('/admin/exams/' + ex.id, { status: ex.status === 'published' ? 'draft' : 'published' }); await load(); }
      catch (err) { await infoDialog(ex.status === 'published' ? 'No se pudo despublicar' : 'No se pudo publicar', C.errorMessage(err)); }
    });
    const dup = async ex => {
      try { const c = await api.post('/admin/exams/' + ex.id + '/duplicate'); Sim.toast('Copia creada como borrador.'); navigate('#/admin/examenes/' + c.id); }
      catch (err) { await infoDialog('No se pudo duplicar', C.errorMessage(err)); }
    };
    const remove = async ex => {
      const ok = await confirmDialog({ title: 'Eliminar examen', message: ['¿Eliminar "' + ex.title + '"? No se puede deshacer.'], confirmLabel: 'Eliminar', danger: true });
      if (!ok) return;
      try { await api.del('/admin/exams/' + ex.id); Sim.toast('Examen eliminado.'); await load(); }
      catch (err) { await infoDialog('No se pudo eliminar', C.errorMessage(err)); }
    };
    const card = ex => {
      const am = accessMode(ex);
      const tbtn = h('button', { class: 'lb-btn sm', type: 'button', text: ex.status === 'published' ? 'Despublicar' : 'Publicar' });
      tbtn.addEventListener('click', () => toggle(ex, tbtn));
      return h('article', { class: 'card xcard exam-card', 'aria-label': ex.title },
        h('div', { class: 'xcard-head' }, h('h2', null, h('a', { class: 'row-title', href: '#/admin/examenes/' + ex.id, text: ex.title })), statusBadge(ex.status)),
        h('div', { class: 'chips' },
          h('span', { class: 'chip' }, icon('clock'), ex.durationMinutes + ' min'),
          h('span', { class: 'chip' }, icon('layers'), ex.blockCount + (ex.blockCount === 1 ? ' sección' : ' secciones')),
          h('span', { class: 'chip' }, icon('list'), ex.exerciseCount + (ex.exerciseCount === 1 ? ' ejercicio' : ' ejercicios')),
          h('span', { class: 'chip' }, icon('repeat'), ex.attemptCount + (ex.attemptCount === 1 ? ' intento' : ' intentos')),
          h('span', { class: 'chip' }, icon(am.ic), am.label)),
        h('div', { class: 'small muted' }, (isAdmin() && ex.ownerName ? 'Propietario: ' + ex.ownerName + ' · ' : '') + (ex.availableFrom || ex.availableUntil ? (ex.availableFrom ? fmtDate(ex.availableFrom) : 'siempre') + ' → ' + (ex.availableUntil ? fmtDate(ex.availableUntil) : 'sin cierre') : 'Disponible siempre')),
        h('div', { class: 'xfill' }),
        h('div', { class: 'card-actions' },
          h('a', { class: 'lb-btn sm', href: '#/admin/examenes/' + ex.id }, icon('edit'), 'Editar'),
          h('a', { class: 'lb-btn sm', href: '#/admin/resultados?examId=' + ex.id }, icon('list'), 'Resultados'),
          h('a', { class: 'lb-btn sm', href: '#/admin/examenes/' + ex.id + '/analiticas' }, icon('chart'), 'Analíticas'),
          tbtn,
          iconBtn('copy', 'Duplicar ' + ex.title, () => dup(ex)),
          iconBtn('trash', 'Eliminar ' + ex.title, () => remove(ex), 'danger')));
    };
    out.replaceChildren(
      data.items.length ? h('div', { class: 'cards' }, data.items.map(card))
        : (S.q || S.status || S.owner ? emptyBox('search', 'Ningún examen coincide con los filtros.') : emptyBox('list', 'Todavía no hay exámenes.', 'Crea uno y agrégale ejercicios publicados.', h('a', { class: 'lb-btn primary', href: '#/admin/examenes/nuevo', text: 'Crear el primero' }))),
      data.total > pageSize ? pager(data.total, data.page, data.pageSize, p => { S.page = p; load(); }) : '');
  }
  const reload = debounce(() => { S.page = 1; load(); }, 280);
  q.input.addEventListener('input', () => { S.q = q.input.value; reload(); });
  status.input.addEventListener('change', () => { S.status = status.input.value; S.page = 1; load(); });
  if (owner) owner.input.addEventListener('change', () => { S.owner = owner.input.value; S.page = 1; load(); });
  main.replaceChildren(page('',
    pageHead('Exámenes', 'Crea, publica y revisa los exámenes que verán tus estudiantes.', h('a', { class: 'lb-btn primary', href: '#/admin/examenes/nuevo' }, icon('plus'), 'Nuevo examen')),
    h('div', { class: 'card filters' }, h('div', { class: 'lb-row' }, q.wrap, status.wrap, owner ? owner.wrap : null)),
    out));
  await load();
  return { destroy() { reload.cancel(); } };
};

/* ================= Exam analytics ================= */
function histogram(dist) {
  const W = 520, H = 190;
  const values = dist.map(d => d.count);
  const L = C.barLayout(values, W, H, { l: 28, r: 6, t: 10, b: 26 });
  const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'Distribución de porcentajes en 10 rangos: ' + dist.map(d => d.from + '-' + d.to + ' %: ' + d.count).join('; ') + '.' });
  const ticks = L.max <= 5 ? L.max : 5;
  for (let i = 0; i <= ticks; i++) {
    const v = Math.round((L.max / ticks) * i * 10) / 10;
    const y = L.pad.t + (H - L.pad.t - L.pad.b) * (1 - i / ticks);
    root.append(svg('line', { class: 'grid', x1: L.pad.l, x2: W - L.pad.r, y1: y, y2: y }), svg('text', { class: 'axis', x: L.pad.l - 6, y: y + 3.5, 'text-anchor': 'end' }, Number.isInteger(v) ? v : v.toFixed(1)));
  }
  L.bars.forEach(b => {
    const d = dist[b.i];
    const r = Math.min(4, b.w / 2, b.h);
    const path = b.h > 0 ? 'M' + b.x + ' ' + (b.y + b.h) + 'V' + (b.y + r) + 'Q' + b.x + ' ' + b.y + ' ' + (b.x + r) + ' ' + b.y + 'H' + (b.x + b.w - r) + 'Q' + (b.x + b.w) + ' ' + b.y + ' ' + (b.x + b.w) + ' ' + (b.y + r) + 'V' + (b.y + b.h) + 'Z' : '';
    root.append(svg('g', { class: 'bar-g' },
      svg('rect', { class: 'hit', x: b.x - 2, y: L.pad.t, width: b.w + 4, height: H - L.pad.t - L.pad.b }),
      path ? svg('path', { class: 'mark', d: path }) : svg('rect', { class: 'mark zero', x: b.x, y: H - L.pad.b - 1.5, width: b.w, height: 1.5 }),
      svg('title', null, d.from + '–' + d.to + ' %: ' + d.count + (d.count === 1 ? ' intento' : ' intentos'))));
    root.append(svg('text', { class: 'axis', x: b.x + b.w / 2, y: H - 8, 'text-anchor': 'middle' }, d.from));
  });
  return root;
}

screens.adminExamAnalytics = async ctx => {
  const main = staffMain(ctx, 'exams');
  const id = ctx.params.id;
  const load = async () => {
    main.replaceChildren(page('', pageHead('Analíticas', 'Cargando…'), K.skeletonCards(2, 'Cargando analíticas…')));
    let a;
    try { a = await api.get('/admin/exams/' + id + '/analytics'); } catch (err) {
      if (!ctx.stale()) main.replaceChildren(page('', failureBox(err, err.status === 404 ? null : load), h('p', { class: 'state' }, h('a', { class: 'lb-btn', href: '#/admin/examenes', text: 'Volver a exámenes' }))));
      return;
    }
    if (ctx.stale()) return;
    const mins = a.averageCompletionSeconds == null ? '-' : (a.averageCompletionSeconds >= 60 ? Math.round(a.averageCompletionSeconds / 60) + ' min' : a.averageCompletionSeconds + ' s');
    const graded = a.exercises.filter(e => e.gradedCount > 0 && e.averagePercent != null);
    const hardest = new Set([...graded].sort((x, y) => x.averagePercent - y.averagePercent).slice(0, Math.min(3, graded.length)).filter(e => e.averagePercent < 70).map(e => e.exerciseId));
    const csv = '/api/admin/exams/' + id + '/results.csv';
    main.replaceChildren(page('',
      h('a', { class: 'back', href: '#/admin/examenes' }, icon('arrowLeft'), 'Volver a los exámenes'),
      pageHead('Analíticas: ' + a.exam.title, 'Resultados agregados de los intentos de este examen.',
        h('a', { class: 'lb-btn', href: csv, download: '' }, icon('download'), 'Exportar CSV'),
        h('a', { class: 'lb-btn', href: '#/admin/resultados?examId=' + id }, icon('list'), 'Ver intentos'),
        h('a', { class: 'lb-btn', href: '#/admin/examenes/' + id }, icon('edit'), 'Editar examen')),
      h('div', { class: 'kpis' },
        tile('Intentos', a.attemptsCount, a.finishedCount + ' terminados · ' + a.inProgressCount + ' en curso', 'repeat'),
        tile('Estudiantes', a.uniqueStudents, null, 'users'),
        tile('Promedio', a.averagePercent == null ? '-' : C.formatPercent(a.averagePercent), null, 'award'),
        tile('Aprobación', a.passRate == null ? '-' : C.formatPercent(a.passRate), null, 'check'),
        tile('Tiempo promedio', mins, 'por intento terminado', 'clock')),
      a.finishedCount === 0 ? emptyBox('inbox', 'Aún no hay intentos terminados.', 'Cuando tus estudiantes terminen el examen verás aquí la distribución de notas y los ejercicios más difíciles.') : [
        h('section', { class: 'card', 'aria-label': 'Distribución de puntajes' }, secHead('chart', 'Distribución de puntajes', 'Intentos terminados por rango de porcentaje.'), h('div', { class: 'chart-box narrow' }, histogram(a.distribution), h('p', { class: 'small muted chart-cap', text: 'Porcentaje del puntaje (inicio de cada rango de 10 puntos)' }))),
        h('section', { class: 'card', 'aria-label': 'Ejercicios' },
          secHead('fileText', 'Ejercicios', 'Los más difíciles aparecen marcados (promedio bajo).'),
          a.exercises.length ? table(['Ejercicio', 'Veces sorteado', 'Promedio', 'Puntaje completo'], a.exercises.map(e => h('tr', { class: hardest.has(e.exerciseId) ? 'hard' : null },
            h('td', null, e.title, hardest.has(e.exerciseId) ? badge('Difícil', 'bad') : null),
            h('td', { class: 'num', text: String(e.timesDrawn) }),
            h('td', null, e.averagePercent == null ? h('span', { class: 'muted', text: '-' }) : h('div', { class: 'inbar' }, h('div', { class: 'bar' }, h('i', { class: e.averagePercent >= 70 ? 'ok' : e.averagePercent >= 40 ? 'warn' : 'bad', style: 'width:' + Math.max(0, Math.min(100, e.averagePercent)) + '%' })), h('span', { class: 'v', text: C.formatPercent(e.averagePercent) }))),
            h('td', { class: 'num', text: e.fullMarksShare == null ? '-' : C.formatPercent(e.fullMarksShare) }))), [1, 3]) : h('p', { class: 'muted', text: 'Sin datos por ejercicio.' })),
        h('section', { class: 'card', 'aria-label': 'Estudiantes' },
          secHead('users', 'Estudiantes'),
          a.students.length ? table(['Estudiante', 'Intentos usados', 'Mejor nota', 'Mejor %', 'Estado', 'Último intento'], a.students.map(s => h('tr', null,
            h('td', null, s.name, h('div', { class: 'small muted', text: s.email })),
            h('td', { class: 'num', text: String(s.attemptsUsed) }),
            h('td', { class: 'num', text: s.bestGrade == null ? '-' : C.formatGrade(s.bestGrade, a.exam.scale) }),
            h('td', { class: 'num', text: s.bestPercent == null ? '-' : C.formatPercent(s.bestPercent) }),
            h('td', null, s.passed == null ? badge('Sin calificar') : badge(s.passed ? 'Aprobado' : 'Reprobado', s.passed ? 'ok' : 'bad')),
            h('td', { class: 'nowrap muted', text: fmtDate(s.lastAttemptAt) }))), [1, 2, 3]) : h('p', { class: 'muted', text: 'Nadie ha presentado este examen.' }))]));
  };
  await load();
  return {};
};

/* ================= Results ================= */
screens.adminResults = async ctx => {
  const main = staffMain(ctx, 'results');
  const filters = { examId: ctx.query.examId || '', userId: ctx.query.userId || '' };
  let all, exams;
  try {
    [all, exams] = await Promise.all([api.get('/admin/results'), api.get('/admin/exams')]);
  } catch (err) { main.replaceChildren(page('', failureBox(err, () => K.route()))); return {}; }
  if (ctx.stale()) return {};
  const students = [...new Map(all.summary.map(s => [s.userId, s])).values()].sort((a, b) => a.userName.localeCompare(b.userName, 'es'));

  const examSel = field('Examen', 'select', { value: filters.examId, options: [{ value: '', label: 'Todos los exámenes' }, ...exams.map(e => ({ value: e.id, label: e.title }))] });
  const userSel = field('Estudiante', 'select', { value: filters.userId, options: [{ value: '', label: 'Todos los estudiantes' }, ...students.map(s => ({ value: s.userId, label: s.userName + ' (' + s.userEmail + ')' }))] });
  const out = h('div', { 'aria-live': 'polite' });
  const csvLink = h('a', { class: 'lb-btn', download: '' }, icon('download'), 'Exportar CSV');
  const anaLink = h('a', { class: 'lb-btn' }, icon('chart'), 'Analíticas');

  const load = async () => {
    out.replaceChildren(loadingBox('Cargando resultados…'));
    const query = qs({ examId: filters.examId, userId: filters.userId });
    history.replaceState(null, '', location.pathname + location.search + '#/admin/resultados' + query);
    csvLink.href = '/api/admin/results.csv' + query;
    anaLink.hidden = !filters.examId;
    if (filters.examId) anaLink.href = '#/admin/examenes/' + filters.examId + '/analiticas';
    let data;
    try { data = await api.get('/admin/results' + query); } catch (err) { if (!ctx.stale()) out.replaceChildren(failureBox(err, load)); return; }
    if (ctx.stale()) return;
    const passedCount = data.summary.filter(x => x.result && x.result.passed).length;
    const gradedCount = data.summary.filter(x => x.result).length;
    out.replaceChildren(
      h('div', { class: 'stats' },
        stat('Estudiantes', String(new Set(data.summary.map(x => x.userId)).size)),
        stat('Intentos', String(data.attempts.length)),
        stat('Aprobados', gradedCount ? passedCount + ' de ' + gradedCount : '-', gradedCount && passedCount === gradedCount ? 'ok' : ''),
        stat('Reprobados', gradedCount ? String(gradedCount - passedCount) : '-', gradedCount - passedCount > 0 ? 'bad' : '')),
      h('h2', { class: 'sect-title', text: 'Resultado por estudiante y examen' }),
      data.summary.length ? table(['Estudiante', 'Examen', 'Intentos', 'Resultado que cuenta', 'Estado'], data.summary.map(s => h('tr', null,
        h('td', null, s.userName, h('div', { class: 'small muted', text: s.userEmail })),
        h('td', { text: s.examTitle }),
        h('td', { class: 'num', text: String(s.attemptsUsed) }),
        h('td', { class: 'num', text: s.result ? C.formatGrade(s.result.grade, s.scale) + ' · ' + C.formatPercent(s.result.scorePercent) : '-' }),
        h('td', null, s.result ? badge(s.result.passed ? 'Aprobado' : 'Reprobado', s.result.passed ? 'ok' : 'bad') : badge('Sin calificar'))))) : emptyBox('inbox', 'No hay resultados con estos filtros.'),
      h('h2', { class: 'sect-title', text: 'Intentos' }),
      data.attempts.length ? table(['Estudiante', 'Examen', 'Intento', 'Estado', '%', 'Nota', 'Resultado', 'Inicio', 'Envío', ''], data.attempts.map(a => h('tr', null,
        h('td', null, a.userName, h('div', { class: 'small muted', text: a.userEmail })),
        h('td', { text: a.examTitle }),
        h('td', { class: 'num', text: String(a.number) }),
        h('td', null, badge(C.statusLabel(a.status), a.status === 'in_progress' ? 'info' : '')),
        h('td', { class: 'num', text: a.status === 'in_progress' ? '-' : C.formatPercent(a.scorePercent) }),
        h('td', { class: 'num', text: a.status === 'in_progress' ? '-' : C.formatGrade(a.grade, a.scale) }),
        h('td', null, a.status === 'in_progress' || a.passed === null || a.passed === undefined ? h('span', { class: 'muted', text: '-' }) : badge(a.passed ? 'Aprobado' : 'Reprobado', a.passed ? 'ok' : 'bad')),
        h('td', { class: 'nowrap', text: fmtDate(a.startedAt) }),
        h('td', { class: 'nowrap', text: fmtDate(a.submittedAt) }),
        h('td', null, h('a', { class: 'lb-btn sm', href: '#/admin/intentos/' + a.id, text: 'Ver detalle' })))), [2, 4, 5]) : emptyBox('inbox', 'No hay intentos con estos filtros.'));
  };
  examSel.input.addEventListener('change', () => { filters.examId = examSel.input.value; load(); });
  userSel.input.addEventListener('change', () => { filters.userId = userSel.input.value; load(); });
  main.replaceChildren(page('',
    pageHead('Resultados', 'Notas por estudiante y detalle de cada intento.', anaLink, csvLink),
    h('div', { class: 'card filters' }, h('div', { class: 'filters-t' }, icon('list'), 'Filtros'), h('div', { class: 'lb-row' }, examSel.wrap, userSel.wrap)),
    h('div', { class: 'results-out' }, out)));
  await load();
  return {};
};

K.ui = { svg, page, iconBtn, iconLink, secHead, stat, statusBadge, roleBadge, diffBadge, tagChips, table, debounce, pager, ago, download, qs, loadOwners, staffMain, passwordGenerator, filterInput, isAdmin };
})();

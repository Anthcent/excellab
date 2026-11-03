/* =====================================================================
   GridLab lab UI: staff screens (exercises, exams, results). Plugs into window.LabApp (lab.js).
   ===================================================================== */
(() => {
'use strict';
const K = window.LabApp;
if (!K) return;
const { h, api, C, Sim, field, applyErrors, badge, notice, loadingBox, failureBox, confirmDialog, infoDialog, withBusy, fmtDate, screens, navigate } = K;

const blankWorkbook = () => ({ name: 'Libro1', sheets: [{ name: 'Hoja1', cells: {}, colW: {}, sel: { ar: 0, ac: 0, fr: 0, fc: 0 } }] });
const countCells = wb => (wb && wb.sheets ? wb.sheets.reduce((n, s) => n + Object.keys(s.cells || {}).length, 0) : 0);
const statusBadge = s => badge(C.statusLabel(s), s === 'published' ? 'ok' : 'warn');
const page = (cls, ...kids) => h('div', { class: 'lab-page' + (cls ? ' ' + cls : '') }, ...kids);

function table(headers, rows, numeric) {
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, headers.map((t, i) => h('th', { class: numeric && numeric.includes(i) ? 'num' : null, text: t })))),
    h('tbody', null, rows)));
}

/** Warns before the page unloads while there are unsaved changes. Returns the remover. */
function guardUnload(isDirty) {
  const fn = e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', fn);
  return () => window.removeEventListener('beforeunload', fn);
}
const confirmLeave = () => confirmDialog({ title: 'Cambios sin guardar', message: 'Tienes cambios sin guardar. Si sales ahora se perderán.', confirmLabel: 'Salir sin guardar', cancelLabel: 'Seguir editando', danger: true });

/* ================= Exercises: list ================= */
screens.adminHome = async () => { navigate('#/admin/ejercicios', true); };

screens.adminExercises = async ctx => {
  const root = ctx.root;
  const load = async () => {
    root.replaceChildren(loadingBox('Cargando ejercicios…'));
    let list;
    try { list = await api.get('/admin/exercises'); } catch (err) { if (!ctx.stale()) root.replaceChildren(page('', failureBox(err, load))); return; }
    if (ctx.stale()) return;
    const remove = async ex => {
      const ok = await confirmDialog({ title: 'Eliminar ejercicio', message: ['¿Eliminar "' + ex.title + '"? No se puede deshacer.'], confirmLabel: 'Eliminar', danger: true });
      if (!ok) return;
      try { await api.del('/admin/exercises/' + ex.id); K.Sim.toast('Ejercicio eliminado.'); await load(); }
      catch (err) { await infoDialog('No se pudo eliminar', C.errorMessage(err)); }
    };
    root.replaceChildren(page('',
      h('div', { class: 'lab-head' }, h('h1', { text: 'Ejercicios' }), h('a', { class: 'lb-btn primary', href: '#/admin/ejercicios/nuevo', text: 'Nuevo ejercicio' })),
      list.length ? table(['Título', 'Puntos', 'Estado', 'Verificaciones', 'Uso', 'Actualizado', ''], list.map(ex => h('tr', null,
        h('td', null, h('a', { href: '#/admin/ejercicios/' + ex.id, text: ex.title })),
        h('td', { class: 'num', text: C.formatNumber(ex.points) }),
        h('td', null, statusBadge(ex.status)),
        h('td', { class: 'num', text: String(ex.checkCount) }),
        h('td', null, ex.examCount ? badge('En ' + ex.examCount + (ex.examCount === 1 ? ' examen' : ' exámenes'), 'info') : h('span', { class: 'muted', text: 'Sin usar' })),
        h('td', { class: 'nowrap', text: fmtDate(ex.updatedAt) }),
        h('td', null, h('div', { class: 'actions' },
          h('a', { class: 'lb-btn sm', href: '#/admin/ejercicios/' + ex.id, text: 'Editar' }),
          h('button', { class: 'lb-btn sm danger', type: 'button', 'aria-label': 'Eliminar ' + ex.title, onclick: () => remove(ex), text: 'Eliminar' }))))), [1, 3])
        : h('div', { class: 'card state' }, h('p', { text: 'Todavía no hay ejercicios.' }), h('a', { class: 'lb-btn primary', href: '#/admin/ejercicios/nuevo', text: 'Crear el primero' })),
      list.some(e => e.examCount) ? h('p', { class: 'small muted', text: 'Los ejercicios que ya se usaron en intentos de estudiantes no se pueden eliminar; despublícalos si ya no deben salir.' }) : null));
  };
  await load();
};

/* ================= Exercises: editor (form + sheet share one draft) ================= */
let exDraft = null;   // { key, id, form, rows, workbook, baseForm, baseWb, keep }

const draftFormKey = d => JSON.stringify({ form: d.form, rows: d.rows });
const draftDirty = d => !!d && (draftFormKey(d) !== d.baseForm || C.workbookKey(d.workbook) !== d.baseWb);

function draftFromApi(ex) {
  const d = {
    key: ex.id, id: ex.id,
    form: { title: ex.title, instructions: ex.instructions, points: String(ex.points), status: ex.status },
    rows: (ex.checks || []).map(C.checkToRow),
    workbook: ex.workbook, keep: false,
  };
  d.baseForm = draftFormKey(d); d.baseWb = C.workbookKey(d.workbook);
  return d;
}
function draftNew() {
  const d = { key: 'new', id: null, form: { title: '', instructions: '', points: '10', status: 'draft' }, rows: [], workbook: blankWorkbook(), keep: false };
  d.baseForm = draftFormKey(d); d.baseWb = C.workbookKey(d.workbook);
  return d;
}
async function ensureDraft(id) {
  const key = id || 'new';
  if (exDraft && exDraft.key === key && exDraft.keep) { exDraft.keep = false; return exDraft; }
  exDraft = id ? draftFromApi(await api.get('/admin/exercises/' + id)) : draftNew();
  return exDraft;
}
const sheetHash = d => (d.id ? '#/admin/ejercicios/' + d.id + '/hoja' : '#/admin/ejercicios/nuevo/hoja');
const formHash = d => (d.id ? '#/admin/ejercicios/' + d.id : '#/admin/ejercicios/nuevo');
const sameExercise = (d, r, sheet) => (d.id
  ? r.name === (sheet ? 'adminExerciseSheet' : 'adminExercise') && r.params.id === d.id
  : r.name === (sheet ? 'adminExerciseNewSheet' : 'adminExerciseNew'));

function checkRowEditor(d, i, rowErrors, rerender) {
  const row = d.rows[i];
  const errs = rowErrors[i] || {};
  const bind = (f, key, isCheck) => {
    f.input.addEventListener(isCheck ? 'change' : 'input', () => { row[key] = isCheck ? f.input.checked : f.input.value; });
    f.setError(errs[key] || '');
    return f;
  };
  const typeSel = field('Tipo', 'select', { options: C.CHECK_TYPES, value: row.type });
  typeSel.input.addEventListener('change', () => { row.type = typeSel.input.value; rerender(); });
  const points = bind(field('Puntos', 'input', { value: row.points, inputmode: 'decimal' }), 'points');
  const label = bind(field('Etiqueta (la ve el estudiante)', 'input', { value: row.label, maxlength: 200, hint: 'No pongas aquí la respuesta.' }), 'label');
  const sheetF = bind(field('Hoja (opcional)', 'input', { value: row.sheet, maxlength: 31, hint: 'Vacío = primera hoja.' }), 'sheet');
  const parts = [];
  if (row.type === 'cell_value') {
    parts.push(h('div', { class: 'lb-row' },
      bind(field('Celda', 'input', { value: row.cell, placeholder: 'B8', maxlength: 8 }), 'cell').wrap,
      bind(field('Valor esperado', 'input', { value: row.expected, hint: 'Número, VERDADERO/FALSO o texto. Entre comillas ("123") fuerza texto.' }), 'expected').wrap,
      bind(field('Tolerancia', 'input', { value: row.tolerance, inputmode: 'decimal', hint: 'Opcional (números).' }), 'tolerance').wrap),
    bind(field('Ignorar mayúsculas y minúsculas', 'check', { value: row.ignoreCase }), 'ignoreCase', true).wrap,
    bind(field('Exigir que la celda tenga una fórmula', 'check', { value: row.requireFormula }), 'requireFormula', true).wrap);
  } else if (row.type === 'cell_formula_uses') {
    parts.push(h('div', { class: 'lb-row' },
      bind(field('Celda', 'input', { value: row.cell, placeholder: 'B8', maxlength: 8 }), 'cell').wrap,
      bind(field('Funciones requeridas', 'input', { value: row.functions, placeholder: 'SUMA, SI', hint: 'Nombres en español, separados por comas.' }), 'functions').wrap));
  } else {
    parts.push(h('div', { class: 'lb-row' },
      bind(field('Rango', 'input', { value: row.range, placeholder: 'C2:C5', maxlength: 17 }), 'range').wrap,
      bind(field('Tolerancia', 'input', { value: row.tolerance, inputmode: 'decimal', hint: 'Opcional (números).' }), 'tolerance').wrap),
    bind(field('Valores esperados', 'textarea', { value: row.matrix, rows: 4, hint: 'Una fila por línea; celdas separadas por ; o tabulador (puedes pegar desde Excel).' }), 'matrix').wrap,
    bind(field('Ignorar mayúsculas y minúsculas', 'check', { value: row.ignoreCase }), 'ignoreCase', true).wrap);
  }
  return h('div', { class: 'check-row', role: 'group', 'aria-label': 'Verificación ' + (i + 1) },
    h('div', { class: 'head' },
      h('strong', { text: 'Verificación ' + (i + 1) }),
      h('button', { class: 'lb-btn sm', type: 'button', onclick: () => { d.rows.splice(i + 1, 0, { ...row }); rerender(); }, text: 'Duplicar' }),
      h('button', { class: 'lb-btn sm danger', type: 'button', 'aria-label': 'Quitar verificación ' + (i + 1), onclick: () => { d.rows.splice(i, 1); rerender(); }, text: 'Quitar' })),
    h('div', { class: 'lb-row' }, typeSel.wrap, points.wrap, label.wrap),
    sheetF.wrap, parts);
}

async function exerciseFormScreen(ctx, id) {
  const root = ctx.root;
  let d;
  try { d = await ensureDraft(id); } catch (err) {
    root.replaceChildren(page('mid', failureBox(err, err.status === 404 ? null : () => K.route()), h('p', { class: 'state' }, h('a', { class: 'lb-btn', href: '#/admin/ejercicios', text: 'Volver a ejercicios' }))));
    return {};
  }
  if (ctx.stale()) return {};
  let rowErrors = {};
  const removeUnload = guardUnload(() => draftDirty(exDraft));

  const f = {
    title: field('Título', 'input', { value: d.form.title, maxlength: 200, required: true }),
    points: field('Puntos del ejercicio', 'input', { value: d.form.points, inputmode: 'decimal', required: true }),
    status: field('Estado', 'select', { value: d.form.status, options: [{ value: 'draft', label: 'Borrador' }, { value: 'published', label: 'Publicado' }], hint: 'Solo los ejercicios publicados se pueden usar en exámenes.' }),
    instructions: field('Instrucciones para el estudiante', 'textarea', { value: d.form.instructions, rows: 5 }),
  };
  for (const k of Object.keys(f)) f[k].input.addEventListener('input', () => { d.form[k] = f[k].input.value; });
  f.status.input.addEventListener('change', () => { d.form.status = f.status.input.value; });

  const checksBox = h('div');
  const summary = h('div', { 'aria-live': 'polite' });
  const renderChecks = () => {
    checksBox.replaceChildren(...(d.rows.length
      ? d.rows.map((_, i) => checkRowEditor(d, i, rowErrors, renderChecks))
      : [h('p', { class: 'muted', text: 'Aún no hay verificaciones. Agrega al menos una para poder publicar el ejercicio.' })]));
  };
  renderChecks();
  const addType = field('Tipo de verificación', 'select', { options: C.CHECK_TYPES });
  const addBtn = h('button', { class: 'lb-btn', type: 'button', text: 'Agregar verificación', onclick: () => { d.rows.push(C.blankCheckRow(addType.input.value)); rowErrors = {}; renderChecks(); const last = checksBox.lastElementChild; if (last) { const i = last.querySelector('input'); if (i) i.focus(); } } });

  const saveBtn = h('button', { class: 'lb-btn primary', type: 'submit', text: d.id ? 'Guardar cambios' : 'Crear ejercicio' });
  const form = h('form', { novalidate: true, 'aria-label': 'Ejercicio' });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    summary.replaceChildren(); rowErrors = {};
    const errors = C.validateExerciseForm(d.form);
    const parsed = C.rowsToChecks(d.rows);
    if (d.form.status === 'published' && !d.rows.length && !errors.status) errors.status = 'Un ejercicio publicado necesita al menos una verificación.';
    parsed.errors.forEach(x => { if (x.index >= 0) rowErrors[x.index] = x.errors; });
    const first = applyErrors(f, errors);
    renderChecks();
    if (first || !parsed.ok) {
      summary.replaceChildren(notice('error', 'Revisa los campos marcados.'));
      if (first) first.input.focus(); else { const bad = checksBox.querySelector('[aria-invalid="true"]'); if (bad) bad.focus(); }
      return;
    }
    const sheetChanged = C.workbookKey(d.workbook) !== d.baseWb;
    const payload = C.exerciseFormToPayload(d.form, parsed.checks, d.id ? (sheetChanged ? d.workbook : null) : d.workbook);
    await withBusy(saveBtn, async () => {
      try {
        if (d.id) {
          const saved = await api.put('/admin/exercises/' + d.id, payload);
          exDraft = draftFromApi(saved);
          Sim.toast('Ejercicio guardado.');
          navigate('#/admin/ejercicios/' + saved.id, true);
        } else {
          const created = await api.post('/admin/exercises', payload);
          exDraft = draftFromApi(created);
          Sim.toast('Ejercicio creado.');
          navigate('#/admin/ejercicios/' + created.id, true);
        }
      } catch (err) {
        const map = {};
        (err.fields || []).forEach(p => {
          const m = /^checks\.(\d+)\.(\w+)/.exec(p);
          if (m) { rowErrors[+m[1]] = { ...(rowErrors[+m[1]] || {}), [m[2]]: 'Valor no válido.' }; }
          else map[p] = 'Valor no válido.';
        });
        applyErrors(f, map); renderChecks();
        summary.replaceChildren(notice('error', C.errorMessage(err)));
      }
    });
  });

  const remove = async () => {
    const ok = await confirmDialog({ title: 'Eliminar ejercicio', message: ['¿Eliminar "' + d.form.title + '"? No se puede deshacer.'], confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await api.del('/admin/exercises/' + d.id); exDraft = null; Sim.toast('Ejercicio eliminado.'); navigate('#/admin/ejercicios'); }
    catch (err) { await infoDialog('No se pudo eliminar', C.errorMessage(err)); }
  };

  form.append(
    h('div', { class: 'card' }, h('h2', { text: 'Datos del ejercicio' }), f.title.wrap, h('div', { class: 'lb-row' }, f.points.wrap, f.status.wrap), f.instructions.wrap),
    h('div', { class: 'card' }, h('h2', { text: 'Hoja inicial' }),
      h('p', { class: 'muted', text: d.workbook.sheets.length + (d.workbook.sheets.length === 1 ? ' hoja' : ' hojas') + ' · ' + countCells(d.workbook) + ' celdas con datos' + (C.workbookKey(d.workbook) !== d.baseWb ? ' · cambios sin guardar' : '') }),
      h('p', { class: 'small muted', text: 'Edita la hoja dentro del simulador real. Allí también puedes probar la calificación con una respuesta de ejemplo.' }),
      h('a', { class: 'lb-btn', href: sheetHash(d), text: 'Editar hoja inicial' })),
    h('div', { class: 'card' }, h('h2', { text: 'Verificaciones' }),
      h('p', { class: 'small muted', text: 'Los puntos de cada verificación se reparten proporcionalmente al total de puntos del ejercicio.' }),
      checksBox,
      h('div', { class: 'lb-row', style: 'align-items:flex-end' }, addType.wrap, h('div', { class: 'lb-field' }, addBtn))),
    summary,
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' },
      saveBtn,
      h('a', { class: 'lb-btn', href: '#/admin/ejercicios', text: 'Volver' }),
      d.id ? h('button', { class: 'lb-btn danger', type: 'button', onclick: remove, text: 'Eliminar' }) : null));

  root.replaceChildren(page('mid', h('div', { class: 'lab-head' }, h('h1', { text: d.id ? 'Editar ejercicio' : 'Nuevo ejercicio' })), form));
  return {
    async leave(next) {
      if (sameExercise(d, next, true)) { exDraft.keep = true; return true; }
      return draftDirty(exDraft) ? confirmLeave() : true;
    },
    destroy() { removeUnload(); },
  };
}
screens.adminExerciseNew = ctx => exerciseFormScreen(ctx, null);
screens.adminExercise = ctx => exerciseFormScreen(ctx, ctx.params.id);

/* ----- exercise sheet (initial workbook + grading preview) ----- */
function previewList(out) {
  return h('div', null,
    h('p', null, h('strong', { text: 'Puntaje de la prueba: ' + C.formatNumber(out.score) + ' / ' + C.formatNumber(out.maxScore) })),
    h('ul', { class: 'checks' }, out.results.map(r => h('li', { class: r.passed ? 'pass' : 'fail' },
      h('span', { class: 'mark', 'aria-hidden': 'true', text: r.passed ? '✓' : '✗' }),
      h('span', null, r.label, h('span', { class: 'small muted', text: ' · ' + (r.ref || '') + (r.actual !== undefined ? ' obtuvo "' + r.actual + '"' : '') }), h('span', { class: 'sr-only', text: r.passed ? ' (correcto)' : ' (incorrecto)' })),
      h('span', { class: 'pts', text: C.formatNumber(r.earned) + ' / ' + C.formatNumber(r.points) })))));
}

async function exerciseSheetScreen(ctx, id) {
  const root = ctx.root;
  let d;
  try { d = await ensureDraft(id); } catch (err) {
    root.replaceChildren(page('mid', failureBox(err, err.status === 404 ? null : () => K.route())));
    return {};
  }
  if (ctx.stale()) return {};
  const removeUnload = guardUnload(() => C.workbookKey(Sim.getWorkbook()) !== d.baseWb);
  const panel = h('div', { class: 'panel', hidden: true, 'aria-live': 'polite' });
  const grab = () => { d.workbook = Sim.getWorkbook(); return d.workbook; };

  const saveBtn = h('button', { class: 'lb-btn sm primary', type: 'button', text: 'Guardar hoja' });
  saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
    const wb = grab();
    if (!d.id) { Sim.toast('La hoja se guardará junto con el ejercicio.'); return; }
    try {
      const saved = await api.put('/admin/exercises/' + d.id, { workbook: wb });
      d.baseWb = C.workbookKey(saved.workbook); d.workbook = saved.workbook;
      Sim.toast('Hoja guardada.');
    } catch (err) { await infoDialog('No se pudo guardar la hoja', C.errorMessage(err)); }
  }));

  const testBtn = h('button', { class: 'lb-btn sm', type: 'button', text: 'Probar calificación', title: d.id ? 'Califica la hoja actual como si fuera la respuesta de un estudiante' : 'Guarda el ejercicio primero para poder probar la calificación' });
  if (!d.id) testBtn.disabled = true;
  testBtn.addEventListener('click', () => withBusy(testBtn, async () => {
    const wb = grab();
    const body = { workbook: wb };
    const parsed = C.rowsToChecks(d.rows);
    const pts = Number(String(d.form.points).replace(',', '.'));
    let note = null;
    if (parsed.ok && parsed.checks.length) { body.checks = parsed.checks; if (pts > 0) body.points = pts; }
    else note = 'Las verificaciones del formulario están vacías o tienen errores: se usan las ya guardadas.';
    panel.hidden = false;
    panel.replaceChildren(loadingBox('Calificando…'));
    K.measure();
    try {
      const out = await api.post('/admin/exercises/' + d.id + '/preview-grade', body);
      panel.replaceChildren(h('h3', { text: 'Resultado de la prueba' }), note ? notice('warn', note) : null, previewList(out));
    } catch (err) { panel.replaceChildren(notice('error', C.errorMessage(err))); }
    K.measure();
  }));

  const strip = h('div', null,
    h('div', { class: 'row' },
      h('span', { class: 'title', text: 'Hoja inicial: ' + (d.form.title || 'Nuevo ejercicio') }),
      h('span', { class: 'spacer' }), saveBtn, testBtn,
      h('a', { class: 'lb-btn sm', href: formHash(d), text: 'Volver al formulario' })),
    h('p', { class: 'small muted', style: 'margin:4px 0 0', text: 'Edita la hoja como quieras. "Probar calificación" usa la hoja actual como respuesta de un estudiante.' }),
    panel);
  root.replaceChildren();
  K.showSim(strip);
  Sim.loadWorkbook(d.workbook, { readOnly: false, title: d.form.title || 'Hoja inicial' });
  Sim.setSaveLabel('· Se guarda con el botón Guardar hoja');
  return {
    async leave(next) {
      grab();
      if (sameExercise(d, next, false)) { exDraft.keep = true; return true; }
      return C.workbookKey(d.workbook) !== d.baseWb || draftDirty(exDraft) ? confirmLeave() : true;
    },
    destroy() { removeUnload(); },
  };
}
screens.adminExerciseNewSheet = ctx => exerciseSheetScreen(ctx, null);
screens.adminExerciseSheet = ctx => exerciseSheetScreen(ctx, ctx.params.id);

/* ================= Exams: list ================= */
screens.adminExams = async ctx => {
  const root = ctx.root;
  const load = async () => {
    root.replaceChildren(loadingBox('Cargando exámenes…'));
    let list;
    try { list = await api.get('/admin/exams'); } catch (err) { if (!ctx.stale()) root.replaceChildren(page('', failureBox(err, load))); return; }
    if (ctx.stale()) return;
    const toggle = async (ex, btn) => withBusy(btn, async () => {
      try { await api.put('/admin/exams/' + ex.id, { status: ex.status === 'published' ? 'draft' : 'published' }); await load(); }
      catch (err) { await infoDialog(ex.status === 'published' ? 'No se pudo despublicar' : 'No se pudo publicar', C.errorMessage(err)); }
    });
    const remove = async ex => {
      const ok = await confirmDialog({ title: 'Eliminar examen', message: ['¿Eliminar "' + ex.title + '"? No se puede deshacer.'], confirmLabel: 'Eliminar', danger: true });
      if (!ok) return;
      try { await api.del('/admin/exams/' + ex.id); Sim.toast('Examen eliminado.'); await load(); }
      catch (err) { await infoDialog('No se pudo eliminar', C.errorMessage(err)); }
    };
    root.replaceChildren(page('',
      h('div', { class: 'lab-head' }, h('h1', { text: 'Exámenes' }), h('a', { class: 'lb-btn primary', href: '#/admin/examenes/nuevo', text: 'Nuevo examen' })),
      list.length ? table(['Título', 'Estado', 'Duración', 'Ejercicios', 'Intentos', 'Disponibilidad', ''], list.map(ex => {
        const tbtn = h('button', { class: 'lb-btn sm', type: 'button', text: ex.status === 'published' ? 'Despublicar' : 'Publicar' });
        tbtn.addEventListener('click', () => toggle(ex, tbtn));
        return h('tr', null,
          h('td', null, h('a', { href: '#/admin/examenes/' + ex.id, text: ex.title })),
          h('td', null, statusBadge(ex.status)),
          h('td', { class: 'num', text: ex.durationMinutes + ' min' }),
          h('td', { class: 'num', text: String(ex.exerciseCount) }),
          h('td', { class: 'num', text: String(ex.attemptCount) }),
          h('td', { class: 'small', text: ex.availableFrom || ex.availableUntil ? (ex.availableFrom ? fmtDate(ex.availableFrom) : 'siempre') + ' → ' + (ex.availableUntil ? fmtDate(ex.availableUntil) : 'sin cierre') : 'Siempre' }),
          h('td', null, h('div', { class: 'actions' },
            h('a', { class: 'lb-btn sm', href: '#/admin/examenes/' + ex.id, text: 'Editar' }), tbtn,
            h('button', { class: 'lb-btn sm danger', type: 'button', 'aria-label': 'Eliminar ' + ex.title, onclick: () => remove(ex), text: 'Eliminar' }))));
      }), [2, 3, 4]) : h('div', { class: 'card state' }, h('p', { text: 'Todavía no hay exámenes.' }), h('a', { class: 'lb-btn primary', href: '#/admin/examenes/nuevo', text: 'Crear el primero' }))));
  };
  await load();
};

/* ================= Exams: editor ================= */
async function examEditor(ctx, id) {
  const root = ctx.root;
  const flash = K.state.flash; K.state.flash = '';
  let exam = null, exercises;
  try {
    const [list, detail] = await Promise.all([api.get('/admin/exercises'), id ? api.get('/admin/exams/' + id) : null]);
    exercises = list; exam = detail;
  } catch (err) {
    root.replaceChildren(page('mid', failureBox(err, err.status === 404 ? null : () => K.route()), h('p', { class: 'state' }, h('a', { class: 'lb-btn', href: '#/admin/examenes', text: 'Volver a exámenes' }))));
    return {};
  }
  if (ctx.stale()) return {};

  const form = exam ? C.examToForm(exam) : C.examToForm({ title: '', instructions: '', status: 'draft' });
  let picked = exam ? exam.exercises.map(e => ({ id: e.id, title: e.title, points: e.points, status: e.status })) : [];
  const baseline = () => JSON.stringify({ form, ids: picked.map(p => p.id) });
  let base = baseline();
  const removeUnload = guardUnload(() => baseline() !== base);

  const f = {
    title: field('Título', 'input', { value: form.title, maxlength: 200, required: true }),
    instructions: field('Instrucciones para el estudiante', 'textarea', { value: form.instructions, rows: 6 }),
    durationMinutes: field('Duración (minutos)', 'input', { value: form.durationMinutes, inputmode: 'numeric', required: true }),
    maxAttempts: field('Intentos máximos', 'input', { value: form.maxAttempts, inputmode: 'numeric', required: true }),
    pickCount: field('Ejercicios por intento', 'input', { value: form.pickCount, inputmode: 'numeric', hint: 'Vacío = todos los ejercicios del examen, en orden aleatorio.' }),
    scale: field('Escala de la nota', 'input', { value: form.scale, inputmode: 'decimal', hint: 'Por ejemplo 20 o 10.' }),
    passPercent: field('Porcentaje para aprobar', 'input', { value: form.passPercent, inputmode: 'decimal' }),
    gradePolicy: field('Nota del examen', 'select', { value: form.gradePolicy, options: [{ value: 'best', label: 'Mejor intento' }, { value: 'last', label: 'Último intento' }] }),
    status: field('Estado', 'select', { value: form.status, options: [{ value: 'draft', label: 'Borrador' }, { value: 'published', label: 'Publicado' }], hint: 'Publicar exige al menos un ejercicio.' }),
    availableFrom: field('Disponible desde', 'input', { type: 'datetime-local', value: form.availableFrom, hint: 'Opcional.' }),
    availableUntil: field('Disponible hasta', 'input', { type: 'datetime-local', value: form.availableUntil, hint: 'Opcional.' }),
  };
  for (const k of Object.keys(f)) {
    f[k].input.addEventListener('input', () => { form[k] = f[k].input.value; });
    f[k].input.addEventListener('change', () => { form[k] = f[k].input.value; });
  }

  const pickedBox = h('ol', { 'aria-label': 'Ejercicios del examen' });
  const availBox = h('ul', { 'aria-label': 'Ejercicios disponibles' });
  const renderPicker = () => {
    const ids = new Set(picked.map(p => p.id));
    pickedBox.replaceChildren(...(picked.length ? picked.map((p, i) => h('li', { class: p.status !== 'published' ? 'off' : null },
      h('span', { class: 't' }, (i + 1) + '. ' + p.title + ' ', h('span', { class: 'small muted', text: '(' + C.formatNumber(p.points) + ' pts)' }), p.status !== 'published' ? badge('Borrador', 'warn') : null),
      h('button', { class: 'lb-btn sm', type: 'button', 'aria-label': 'Subir ' + p.title, disabled: i === 0, onclick: () => { picked = C.moveItem(picked, i, i - 1); renderPicker(); focusItem(i - 1, 'Subir'); }, text: '↑' }),
      h('button', { class: 'lb-btn sm', type: 'button', 'aria-label': 'Bajar ' + p.title, disabled: i === picked.length - 1, onclick: () => { picked = C.moveItem(picked, i, i + 1); renderPicker(); focusItem(i + 1, 'Bajar'); }, text: '↓' }),
      h('button', { class: 'lb-btn sm danger', type: 'button', 'aria-label': 'Quitar ' + p.title, onclick: () => { picked.splice(i, 1); renderPicker(); }, text: 'Quitar' })))
      : [h('li', { class: 'muted', text: 'Aún no agregaste ejercicios.' })]));
    const avail = exercises.filter(e => !ids.has(e.id));
    availBox.replaceChildren(...(avail.length ? avail.map(e => h('li', { class: e.status !== 'published' ? 'off' : null },
      h('span', { class: 't' }, e.title + ' ', h('span', { class: 'small muted', text: '(' + C.formatNumber(e.points) + ' pts)' }), e.status !== 'published' ? badge('Borrador: publícalo para usarlo', 'warn') : null),
      h('button', { class: 'lb-btn sm', type: 'button', disabled: e.status !== 'published', 'aria-label': 'Agregar ' + e.title, onclick: () => { picked.push({ id: e.id, title: e.title, points: e.points, status: e.status }); renderPicker(); }, text: 'Agregar' })))
      : [h('li', { class: 'muted', text: 'No quedan ejercicios por agregar.' })]));
  };
  const focusItem = (i, what) => { const li = pickedBox.children[i]; const b = li && [...li.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').startsWith(what)); if (b && !b.disabled) b.focus(); };
  renderPicker();

  const summary = h('div', { 'aria-live': 'polite' });
  if (flash) summary.append(notice('error', flash));
  const saveBtn = h('button', { class: 'lb-btn primary', type: 'submit', text: id ? 'Guardar cambios' : 'Crear examen' });
  const form_ = h('form', { novalidate: true, 'aria-label': 'Examen' });

  form_.addEventListener('submit', async e => {
    e.preventDefault();
    summary.replaceChildren();
    const first = applyErrors(f, C.validateExamForm(form));
    if (first) { summary.append(notice('error', 'Revisa los campos marcados.')); first.input.focus(); return; }
    if (form.status === 'published' && !picked.length) { f.status.setError('Un examen publicado necesita al menos un ejercicio.'); f.status.input.focus(); summary.append(notice('error', 'Agrega al menos un ejercicio antes de publicar.')); return; }
    const payload = C.examFormToPayload(form);
    const ids = picked.map(p => p.id);
    await withBusy(saveBtn, async () => {
      let createdId = null;
      try {
        if (!id) {
          const created = await api.post('/admin/exams', { ...payload, status: 'draft' });
          createdId = created.id;
          await api.put('/admin/exams/' + createdId + '/exercises', { exerciseIds: ids });
          if (payload.status === 'published') await api.put('/admin/exams/' + createdId, { status: 'published' });
          Sim.toast('Examen creado.');
          base = baseline();
          navigate('#/admin/examenes/' + createdId, true);
        } else {
          if (payload.status === 'published') {
            await api.put('/admin/exams/' + id + '/exercises', { exerciseIds: ids });
            await api.put('/admin/exams/' + id, payload);
          } else {
            await api.put('/admin/exams/' + id, payload);
            await api.put('/admin/exams/' + id + '/exercises', { exerciseIds: ids });
          }
          Sim.toast('Examen guardado.');
          base = baseline();
          navigate('#/admin/examenes/' + id, true);
        }
      } catch (err) {
        if (createdId) {
          // The exam exists as a draft but a later step failed: continue on its edit page with the reason.
          K.state.flash = 'El examen se creó como borrador, pero no se pudo completar: ' + C.errorMessage(err);
          base = baseline();
          navigate('#/admin/examenes/' + createdId, true);
          return;
        }
        const map = {};
        (err.fields || []).forEach(p => { map[p] = 'Valor no válido.'; });
        applyErrors(f, map);
        summary.replaceChildren(notice('error', C.errorMessage(err)));
      }
    });
  });

  const togglePublish = h('button', { class: 'lb-btn', type: 'button', text: exam && exam.status === 'published' ? 'Despublicar' : 'Publicar ahora' });
  togglePublish.addEventListener('click', () => withBusy(togglePublish, async () => {
    summary.replaceChildren();
    try {
      await api.put('/admin/exams/' + id, { status: exam.status === 'published' ? 'draft' : 'published' });
      Sim.toast('Estado actualizado.');
      K.route();
    } catch (err) { summary.replaceChildren(notice('error', C.errorMessage(err))); }
  }));
  const remove = async () => {
    const ok = await confirmDialog({ title: 'Eliminar examen', message: ['¿Eliminar "' + form.title + '"? No se puede deshacer.'], confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await api.del('/admin/exams/' + id); base = baseline(); Sim.toast('Examen eliminado.'); navigate('#/admin/examenes'); }
    catch (err) { await infoDialog('No se pudo eliminar', C.errorMessage(err)); }
  };

  form_.append(
    h('div', { class: 'card' }, h('h2', { text: 'Datos del examen' }), f.title.wrap, f.instructions.wrap,
      h('div', { class: 'lb-row' }, f.durationMinutes.wrap, f.maxAttempts.wrap, f.pickCount.wrap),
      h('div', { class: 'lb-row' }, f.scale.wrap, f.passPercent.wrap, f.gradePolicy.wrap),
      h('div', { class: 'lb-row' }, f.status.wrap, f.availableFrom.wrap, f.availableUntil.wrap)),
    h('div', { class: 'card' }, h('h2', { text: 'Ejercicios' }),
      h('p', { class: 'small muted', text: 'El orden de la lista se usa como referencia; en cada intento se sortean al azar. Solo se pueden agregar ejercicios publicados.' }),
      h('div', { class: 'picker' },
        h('div', null, h('h3', { text: 'En este examen' }), pickedBox),
        h('div', null, h('h3', { text: 'Disponibles' }), availBox))),
    summary,
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' },
      saveBtn,
      id ? togglePublish : null,
      h('a', { class: 'lb-btn', href: '#/admin/examenes', text: 'Volver' }),
      id ? h('button', { class: 'lb-btn danger', type: 'button', onclick: remove, text: 'Eliminar' }) : null));

  root.replaceChildren(page('mid',
    h('div', { class: 'lab-head' }, h('h1', { text: id ? 'Editar examen' : 'Nuevo examen' }), exam ? statusBadge(exam.status) : null),
    id ? h('p', { class: 'small muted' }, 'Enlace directo para estudiantes: ', h('code', { text: location.origin + location.pathname + '?exam=' + id })) : null,
    form_));
  return {
    async leave() { return baseline() !== base ? confirmLeave() : true; },
    destroy() { removeUnload(); },
  };
}
screens.adminExamNew = ctx => examEditor(ctx, null);
screens.adminExam = ctx => examEditor(ctx, ctx.params.id);

/* ================= Results ================= */
screens.adminResults = async ctx => {
  const root = ctx.root;
  const filters = { examId: ctx.query.examId || '', userId: ctx.query.userId || '' };
  let all, exams;
  try {
    [all, exams] = await Promise.all([api.get('/admin/results'), api.get('/admin/exams')]);
  } catch (err) { root.replaceChildren(page('', failureBox(err, () => K.route()))); return {}; }
  if (ctx.stale()) return {};
  const students = [...new Map(all.summary.map(s => [s.userId, s])).values()].sort((a, b) => a.userName.localeCompare(b.userName, 'es'));

  const examSel = field('Examen', 'select', { value: filters.examId, options: [{ value: '', label: 'Todos los exámenes' }, ...exams.map(e => ({ value: e.id, label: e.title }))] });
  const userSel = field('Estudiante', 'select', { value: filters.userId, options: [{ value: '', label: 'Todos los estudiantes' }, ...students.map(s => ({ value: s.userId, label: s.userName + ' (' + s.userEmail + ')' }))] });
  const out = h('div', { 'aria-live': 'polite' });

  const load = async () => {
    out.replaceChildren(loadingBox('Cargando resultados…'));
    const qs = new URLSearchParams();
    if (filters.examId) qs.set('examId', filters.examId);
    if (filters.userId) qs.set('userId', filters.userId);
    history.replaceState(null, '', location.pathname + location.search + '#/admin/resultados' + (qs.toString() ? '?' + qs : ''));
    let data;
    try { data = await api.get('/admin/results' + (qs.toString() ? '?' + qs : '')); } catch (err) { if (!ctx.stale()) out.replaceChildren(failureBox(err, load)); return; }
    if (ctx.stale()) return;
    out.replaceChildren(
      h('h2', { text: 'Resultado por estudiante y examen' }),
      data.summary.length ? table(['Estudiante', 'Examen', 'Intentos', 'Resultado que cuenta', 'Estado'], data.summary.map(s => h('tr', null,
        h('td', null, s.userName, h('div', { class: 'small muted', text: s.userEmail })),
        h('td', { text: s.examTitle }),
        h('td', { class: 'num', text: String(s.attemptsUsed) }),
        h('td', { class: 'num', text: s.result ? C.formatGrade(s.result.grade, s.scale) + ' · ' + C.formatPercent(s.result.scorePercent) : '-' }),
        h('td', null, s.result ? badge(s.result.passed ? 'Aprobado' : 'Reprobado', s.result.passed ? 'ok' : 'bad') : badge('Sin calificar'))))) : h('div', { class: 'card state', text: 'No hay resultados con estos filtros.' }),
      h('h2', { style: 'margin-top:18px', text: 'Intentos' }),
      data.attempts.length ? table(['Estudiante', 'Examen', 'Intento', 'Estado', '%', 'Nota', 'Inicio', 'Envío', ''], data.attempts.map(a => h('tr', null,
        h('td', null, a.userName, h('div', { class: 'small muted', text: a.userEmail })),
        h('td', { text: a.examTitle }),
        h('td', { class: 'num', text: String(a.number) }),
        h('td', null, badge(C.statusLabel(a.status), a.status === 'in_progress' ? 'info' : '')),
        h('td', { class: 'num', text: a.status === 'in_progress' ? '-' : C.formatPercent(a.scorePercent) }),
        h('td', { class: 'num', text: a.status === 'in_progress' ? '-' : C.formatGrade(a.grade, a.scale) }),
        h('td', { class: 'nowrap', text: fmtDate(a.startedAt) }),
        h('td', { class: 'nowrap', text: fmtDate(a.submittedAt) }),
        h('td', null, h('a', { class: 'lb-btn sm', href: '#/admin/intentos/' + a.id, text: 'Ver detalle' })))), [2, 4, 5]) : h('div', { class: 'card state', text: 'No hay intentos con estos filtros.' }));
  };
  examSel.input.addEventListener('change', () => { filters.examId = examSel.input.value; load(); });
  userSel.input.addEventListener('change', () => { filters.userId = userSel.input.value; load(); });
  root.replaceChildren(page('',
    h('div', { class: 'lab-head' }, h('h1', { text: 'Resultados' })),
    h('div', { class: 'card' }, h('div', { class: 'lb-row' }, examSel.wrap, userSel.wrap)),
    h('div', { style: 'margin-top:12px' }, out)));
  await load();
  return {};
};

/* ----- attempt detail ----- */
screens.adminAttempt = async ctx => {
  const root = ctx.root;
  let a;
  try { a = await api.get('/admin/attempts/' + ctx.params.id); } catch (err) {
    root.replaceChildren(page('mid', failureBox(err, err.status === 404 ? null : () => K.route()), h('p', { class: 'state' }, h('a', { class: 'lb-btn', href: '#/admin/resultados', text: 'Volver a resultados' }))));
    return {};
  }
  if (ctx.stale()) return {};
  let cur = 0;
  const stepper = h('div', { class: 'stepper', role: 'group', 'aria-label': 'Ejercicios del intento' });
  const panel = h('div', { class: 'panel', role: 'region', 'aria-label': 'Detalle del ejercicio' });
  const detailList = ans => ans.details && ans.details.length
    ? h('ul', { class: 'checks' }, ans.details.map(r => h('li', { class: r.passed ? 'pass' : 'fail' },
      h('span', { class: 'mark', 'aria-hidden': 'true', text: r.passed ? '✓' : '✗' }),
      h('span', null, r.label, h('span', { class: 'small muted', text: ' · ' + (r.ref || '') + (r.actual !== undefined ? ' obtuvo "' + r.actual + '"' : '') }), h('span', { class: 'sr-only', text: r.passed ? ' (correcto)' : ' (incorrecto)' })),
      h('span', { class: 'pts', text: C.formatNumber(r.earned) + ' / ' + C.formatNumber(r.points) }))))
    : h('p', { class: 'muted', text: 'Sin verificaciones calificadas.' });

  const show = i => {
    cur = i;
    const ans = a.answers[i];
    stepper.replaceChildren(...a.answers.map((x, j) => h('button', {
      class: 'step' + (x.submittedAt ? ' done' : ''), type: 'button', 'aria-current': j === cur ? 'true' : null, title: x.title,
      onclick: () => { show(j); }, text: (j + 1) + ' · ' + (x.score === null ? '-' : C.formatNumber(x.score) + '/' + C.formatNumber(x.maxScore)),
    })));
    if (!ans) { panel.replaceChildren(h('p', { class: 'muted', text: 'Este intento no tiene ejercicios.' })); Sim.loadWorkbook(blankWorkbook(), { readOnly: true }); return; }
    panel.replaceChildren(
      h('h3', null, ans.position + '. ' + ans.title + ' ', ans.score === null ? badge('Sin calificar', 'warn') : badge(C.formatNumber(ans.score) + ' / ' + C.formatNumber(ans.maxScore) + ' pts', 'info')),
      ans.submittedAt ? h('p', { class: 'small muted', text: 'Enviado: ' + fmtDate(ans.submittedAt) }) : h('p', { class: 'small muted', text: 'Sin enviar.' }),
      detailList(ans));
    Sim.loadWorkbook(ans.workbook || blankWorkbook(), { readOnly: true, title: ans.title });
    Sim.setSaveLabel('· Respuesta del estudiante (solo lectura)');
    K.measure();
  };

  const strip = h('div', null,
    h('div', { class: 'row' },
      h('span', { class: 'title', text: a.user.name + ' · ' + a.examTitle }),
      h('span', { class: 'chip', text: 'Intento ' + a.number }),
      badge(C.statusLabel(a.status), a.status === 'in_progress' ? 'info' : ''),
      a.status === 'in_progress' ? null : h('span', { class: 'chip', text: C.formatPercent(a.scorePercent) + ' · ' + C.formatGrade(a.grade, a.scale) }),
      h('span', { class: 'spacer' }),
      h('a', { class: 'lb-btn sm', href: '#/admin/resultados', text: 'Volver a resultados' })),
    h('div', { class: 'row' }, stepper),
    panel);
  root.replaceChildren();
  K.showSim(strip);
  show(0);
  return {};
};
})();

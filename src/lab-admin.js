/* =====================================================================
   GridLab lab UI: staff screens (exercises, exams, results). Plugs into window.LabApp (lab.js).
   ===================================================================== */
(() => {
'use strict';
const K = window.LabApp;
if (!K) return;
const { icon, pageHead, emptyBox, h, api, C, Sim, field, applyErrors, badge, notice, loadingBox, failureBox, confirmDialog, infoDialog, withBusy, fmtDate, screens, navigate } = K;
const U = K.ui;
const { page, iconBtn, iconLink, secHead, stat, statusBadge, table } = U;

const blankWorkbook = () => ({ name: 'Libro1', sheets: [{ name: 'Hoja1', cells: {}, colW: {}, sel: { ar: 0, ac: 0, fr: 0, fc: 0 } }] });
const countCells = wb => (wb && wb.sheets ? wb.sheets.reduce((n, s) => n + Object.keys(s.cells || {}).length, 0) : 0);
const checkMark = ok => h('span', { class: 'mark', 'aria-hidden': 'true' }, icon(ok ? 'check' : 'x'));

/** Warns before the page unloads while there are unsaved changes. Returns the remover. */
function guardUnload(isDirty) {
  const fn = e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', fn);
  return () => window.removeEventListener('beforeunload', fn);
}
const confirmLeave = () => confirmDialog({ title: 'Cambios sin guardar', message: 'Tienes cambios sin guardar. Si sales ahora se perderán.', confirmLabel: 'Salir sin guardar', cancelLabel: 'Seguir editando', danger: true });

/* ================= Exercises: editor (form + sheet share one draft) ================= */
let exDraft = null;   // { key, id, form, rows, workbook, baseForm, baseWb, keep }

const draftFormKey = d => JSON.stringify({ form: d.form, rows: d.rows });
const draftDirty = d => !!d && (draftFormKey(d) !== d.baseForm || C.workbookKey(d.workbook) !== d.baseWb);

function draftFromApi(ex) {
  const d = {
    key: ex.id, id: ex.id,
    form: { title: ex.title, instructions: ex.instructions, points: String(ex.points), status: ex.status, difficulty: ex.difficulty || 'medium', tags: ex.tags || [], estimatedMinutes: ex.estimatedMinutes == null ? '' : String(ex.estimatedMinutes), category: ex.category || '' },
    rows: (ex.checks || []).map(C.checkToRow),
    workbook: ex.workbook, keep: false,
  };
  d.baseForm = draftFormKey(d); d.baseWb = C.workbookKey(d.workbook);
  return d;
}
function draftNew() {
  const d = { key: 'new', id: null, form: { title: '', instructions: '', points: '10', status: 'draft', difficulty: 'medium', tags: [], estimatedMinutes: '', category: '' }, rows: [], workbook: blankWorkbook(), keep: false };
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
  const typeInfo = C.CHECK_TYPES.find(t => t.value === row.type);
  return h('div', { class: 'check-row', role: 'group', 'aria-label': 'Verificación ' + (i + 1) },
    h('div', { class: 'head' },
      h('span', { class: 'num', 'aria-hidden': 'true', text: String(i + 1) }),
      h('strong', { text: 'Verificación ' + (i + 1) }),
      h('span', { class: 'chip', text: typeInfo ? typeInfo.label : row.type }),
      h('span', { class: 'xfill' }),
      h('button', { class: 'lb-btn sm ghost', type: 'button', onclick: () => { d.rows.splice(i + 1, 0, { ...row }); rerender(); } }, icon('copy'), 'Duplicar'),
      h('button', { class: 'lb-btn sm ghost danger', type: 'button', 'aria-label': 'Quitar verificación ' + (i + 1), onclick: () => { d.rows.splice(i, 1); rerender(); } }, icon('trash'), 'Quitar')),
    h('div', { class: 'lb-row' }, typeSel.wrap, points.wrap, label.wrap),
    sheetF.wrap, parts);
}

/** Token input for tags: Enter or comma adds, Backspace on empty removes the last one. */
function tagEditor(d, onChange) {
  const input = h('input', { type: 'text', id: 'tagInput', maxlength: 40, placeholder: 'Escribe y pulsa Enter', 'aria-describedby': 'tagHint' });
  const chips = h('span', { class: 'tag-list' });
  const msg = h('div', { class: 'err', hidden: true });
  const box = h('div', { class: 'tag-box' }, chips, input);
  const render = () => {
    chips.replaceChildren(...d.form.tags.map((t, i) => h('span', { class: 'tag removable' }, t,
      h('button', { type: 'button', 'aria-label': 'Quitar etiqueta ' + t, onclick: () => { d.form.tags.splice(i, 1); render(); onChange(); input.focus(); } }, icon('x')))));
  };
  const add = () => {
    const r = C.addTag(d.form.tags, input.value);
    msg.hidden = !r.reason; msg.textContent = r.reason;
    if (r.added) { d.form.tags = r.tags; render(); onChange(); }
    if (r.added || !r.reason) input.value = '';
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !input.value && d.form.tags.length) { d.form.tags.pop(); render(); onChange(); }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) add(); });
  render();
  return h('div', { class: 'lb-field' },
    h('label', { for: 'tagInput', text: 'Etiquetas' }), box,
    h('div', { class: 'hint', id: 'tagHint', text: 'Hasta 10, en minúsculas. Ayudan a buscar el ejercicio al armar exámenes.' }), msg);
}

async function exerciseFormScreen(ctx, id) {
  const main = U.staffMain(ctx, 'exercises');
  const root = { replaceChildren: (...n) => main.replaceChildren(...n) };
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
    difficulty: field('Dificultad', 'select', { value: d.form.difficulty, options: C.DIFFICULTIES }),
    estimatedMinutes: field('Minutos estimados', 'input', { value: d.form.estimatedMinutes, inputmode: 'numeric', hint: 'Opcional.' }),
    category: field('Categoría', 'input', { value: d.form.category, maxlength: 60, hint: 'Opcional, por ejemplo "Funciones lógicas".' }),
  };
  for (const k of Object.keys(f)) {
    f[k].input.addEventListener('input', () => { d.form[k] = f[k].input.value; });
    f[k].input.addEventListener('change', () => { d.form[k] = f[k].input.value; });
  }
  const tags = tagEditor(d, () => {});

  const checksBox = h('div');
  const summary = h('div', { 'aria-live': 'polite' });
  const renderChecks = () => {
    checksBox.replaceChildren(...(d.rows.length
      ? d.rows.map((_, i) => checkRowEditor(d, i, rowErrors, renderChecks))
      : [h('div', { class: 'empty-inline' }, icon('list'), h('p', { class: 'muted', text: 'Aún no hay verificaciones. Agrega al menos una para poder publicar el ejercicio.' }))]));
  };
  renderChecks();
  const addType = field('Tipo de verificación', 'select', { options: C.CHECK_TYPES });
  const addBtn = h('button', { class: 'lb-btn', type: 'button', onclick: () => { d.rows.push(C.blankCheckRow(addType.input.value)); rowErrors = {}; renderChecks(); const last = checksBox.lastElementChild; if (last) { const i = last.querySelector('input'); if (i) i.focus(); } } }, icon('plus'), 'Agregar verificación');

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
    h('div', { class: 'card' }, secHead('fileText', 'Datos del ejercicio', 'Lo que verá el estudiante y cuántos puntos vale.'), f.title.wrap, h('div', { class: 'lb-row' }, f.points.wrap, f.status.wrap), f.instructions.wrap),
    h('div', { class: 'card' }, secHead('tag', 'Clasificación', 'Para encontrar y reutilizar el ejercicio en el banco.'),
      h('div', { class: 'lb-row' }, f.difficulty.wrap, f.estimatedMinutes.wrap, f.category.wrap), tags),
    h('div', { class: 'card' }, secHead('grid', 'Hoja inicial', 'El libro con el que arranca el estudiante.'),
      h('div', { class: 'chips' },
        h('span', { class: 'chip', text: d.workbook.sheets.length + (d.workbook.sheets.length === 1 ? ' hoja' : ' hojas') + ' · ' + countCells(d.workbook) + ' celdas con datos' }),
        C.workbookKey(d.workbook) !== d.baseWb ? badge('Cambios sin guardar', 'warn') : null),
      h('p', { class: 'small muted', style: 'margin-top:10px', text: 'Edita la hoja dentro del simulador real. Allí también puedes probar la calificación con una respuesta de ejemplo.' }),
      h('a', { class: 'lb-btn', href: sheetHash(d) }, icon('grid'), 'Editar hoja inicial')),
    h('div', { class: 'card' }, secHead('check', 'Verificaciones', 'Los puntos de cada verificación se reparten proporcionalmente al total de puntos del ejercicio.'),
      checksBox,
      h('div', { class: 'add-check' }, addType.wrap, h('div', { class: 'lb-field' }, addBtn))),
    summary,
    h('div', { class: 'form-actions' },
      saveBtn,
      h('a', { class: 'lb-btn', href: '#/admin/ejercicios', text: 'Volver' }),
      d.id ? h('button', { class: 'lb-btn ghost', type: 'button', onclick: async () => {
        try { const c = await api.post('/admin/exercises/' + d.id + '/duplicate'); exDraft = null; Sim.toast('Copia creada como borrador.'); navigate('#/admin/ejercicios/' + c.id); }
        catch (err) { await infoDialog('No se pudo duplicar', C.errorMessage(err)); }
      } }, icon('copy'), 'Duplicar') : null,
      d.id ? h('button', { class: 'lb-btn danger push', type: 'button', onclick: remove }, icon('trash'), 'Eliminar') : null));

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
      checkMark(r.passed),
      h('span', { class: 'ct' }, r.label, h('span', { class: 'small muted', text: ' · ' + (r.ref || '') + (r.actual !== undefined ? ' obtuvo "' + r.actual + '"' : '') }), h('span', { class: 'sr-only', text: r.passed ? ' (correcto)' : ' (incorrecto)' })),
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
  const panel = h('div', { class: 'rn-panel', hidden: true, 'aria-live': 'polite' });
  const grab = () => { d.workbook = Sim.getWorkbook(); return d.workbook; };

  const saveBtn = h('button', { class: 'lb-btn sm primary', type: 'button' }, 'Guardar hoja');
  saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
    const wb = grab();
    if (!d.id) { Sim.toast('La hoja se guardará junto con el ejercicio.'); return; }
    try {
      const saved = await api.put('/admin/exercises/' + d.id, { workbook: wb });
      d.baseWb = C.workbookKey(saved.workbook); d.workbook = saved.workbook;
      Sim.toast('Hoja guardada.');
    } catch (err) { await infoDialog('No se pudo guardar la hoja', C.errorMessage(err)); }
  }));

  const testBtn = h('button', { class: 'lb-btn sm', type: 'button', title: d.id ? 'Califica la hoja actual como si fuera la respuesta de un estudiante' : 'Guarda el ejercicio primero para poder probar la calificación' }, 'Probar calificación');
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

  const strip = h('div', { class: 'rn rn-sheet' },
    h('div', { class: 'rn-id' }, h('span', { class: 'title', text: 'Hoja inicial: ' + (d.form.title || 'Nuevo ejercicio') })),
    h('div', { class: 'rn-act' }, saveBtn, testBtn, h('a', { class: 'lb-btn sm', href: formHash(d) }, icon('arrowLeft'), 'Volver al formulario')),
    h('p', { class: 'rn-tip small muted', text: 'Edita la hoja como quieras. "Probar calificación" usa la hoja actual como respuesta de un estudiante.' }),
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
  const panel = h('div', { class: 'rn-panel', role: 'region', 'aria-label': 'Detalle del ejercicio' });
  const detailList = ans => ans.details && ans.details.length
    ? h('ul', { class: 'checks' }, ans.details.map(r => h('li', { class: r.passed ? 'pass' : 'fail' },
      checkMark(r.passed),
      h('span', { class: 'ct' }, r.label, h('span', { class: 'small muted', text: ' · ' + (r.ref || '') + (r.actual !== undefined ? ' obtuvo "' + r.actual + '"' : '') }), h('span', { class: 'sr-only', text: r.passed ? ' (correcto)' : ' (incorrecto)' })),
      h('span', { class: 'pts', text: C.formatNumber(r.earned) + ' / ' + C.formatNumber(r.points) }))))
    : h('p', { class: 'muted', text: 'Sin verificaciones calificadas.' });

  const show = i => {
    cur = i;
    const ans = a.answers[i];
    stepper.replaceChildren(...a.answers.map((x, j) => h('button', {
      class: 'step' + (x.submittedAt ? ' done' : ''), type: 'button', 'aria-current': j === cur ? 'true' : null, title: x.title,
      onclick: () => { show(j); },
    }, h('span', { class: 'n', text: String(j + 1) }), h('span', { class: 'sc', text: x.score === null ? '-' : C.formatNumber(x.score) + '/' + C.formatNumber(x.maxScore) }))));
    if (!ans) { panel.replaceChildren(h('p', { class: 'muted', text: 'Este intento no tiene ejercicios.' })); Sim.loadWorkbook(blankWorkbook(), { readOnly: true }); return; }
    panel.replaceChildren(
      h('h3', null, ans.position + '. ' + ans.title + ' ', ans.score === null ? badge('Sin calificar', 'warn') : badge(C.formatNumber(ans.score) + ' / ' + C.formatNumber(ans.maxScore) + ' pts', 'info')),
      ans.block ? h('p', { class: 'small muted', text: 'Sección: ' + ans.block }) : null,
      ans.submittedAt ? h('p', { class: 'small muted', text: 'Enviado: ' + fmtDate(ans.submittedAt) }) : h('p', { class: 'small muted', text: 'Sin enviar.' }),
      detailList(ans));
    Sim.loadWorkbook(ans.workbook || blankWorkbook(), { readOnly: true, title: ans.title });
    Sim.setSaveLabel('· Respuesta del estudiante (solo lectura)');
    K.measure();
  };

  const done = a.status !== 'in_progress';
  const strip = h('div', { class: 'rn adm' },
    h('div', { class: 'rn-id' },
      h('span', { class: 'title', text: a.user.name + ' · ' + a.examTitle }),
      h('span', { class: 'chip att', text: 'Intento ' + a.number }),
      badge(C.statusLabel(a.status), a.status === 'in_progress' ? 'info' : ''),
      done && a.passed !== null && a.passed !== undefined ? badge(a.passed ? 'Aprobado' : 'Reprobado', a.passed ? 'ok' : 'bad') : null),
    h('div', { class: 'mini-stats' },
      done ? stat('Porcentaje', C.formatPercent(a.scorePercent)) : null,
      done ? stat('Nota', C.formatGrade(a.grade, a.scale)) : null),
    h('div', { class: 'rn-act' }, h('a', { class: 'lb-btn sm', href: '#/admin/resultados' }, icon('arrowLeft'), 'Volver a resultados')),
    h('div', { class: 'rn-steps' }, stepper),
    panel);
  root.replaceChildren();
  K.showSim(strip);
  show(0);
  return {};
};
})();

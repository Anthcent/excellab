/* =====================================================================
   GridLab lab UI: exam builder for staff (general data, rules, feedback, sections with exercises,
   access list and extra attempts, publish checklist). Plugs into window.LabApp (lab.js).
   Pure mapping (form <-> API payloads, validation, totals, checklist) lives in lab-core.js.
   ===================================================================== */
(() => {
'use strict';
const K = window.LabApp;
if (!K || !K.ui) return;
const { icon, h, api, C, Sim, field, applyErrors, badge, notice, loadingBox, failureBox, confirmDialog, infoDialog, withBusy, fmtDate, screens, navigate, emptyBox, randomInt, copyText } = K;
const U = K.ui;
const { page, secHead, statusBadge, diffBadge, tagChips, table, debounce } = U;

const TABS = [
  { key: 'general', label: 'General', icon: 'fileText' },
  { key: 'rules', label: 'Reglas y tiempo', icon: 'clock' },
  { key: 'feedback', label: 'Resultados', icon: 'award' },
  { key: 'blocks', label: 'Secciones y ejercicios', icon: 'layers' },
  { key: 'access', label: 'Acceso e intentos extra', icon: 'users' },
  { key: 'publish', label: 'Publicación', icon: 'send' },
];
const FIELD_TAB = {
  title: 'general', description: 'general', instructions: 'general', status: 'general', ownerId: 'general',
  durationMinutes: 'rules', maxAttempts: 'rules', scale: 'rules', passPercent: 'rules', gradePolicy: 'rules', availableFrom: 'rules', availableUntil: 'rules', accessCode: 'rules', restricted: 'rules', shuffleBlocks: 'rules',
  feedbackMode: 'feedback', resultMode: 'feedback', allowReview: 'feedback', blocks: 'blocks', exerciseIds: 'blocks',
};
const confirmLeave = () => confirmDialog({ title: 'Cambios sin guardar', message: 'Tienes cambios sin guardar. Si sales ahora se perderán.', confirmLabel: 'Salir sin guardar', cancelLabel: 'Seguir editando', danger: true });

async function examBuilder(ctx, id) {
  const main = U.staffMain(ctx, 'exams');
  const flash = K.state.flash; K.state.flash = '';
  let exam = null;
  try { exam = id ? await api.get('/admin/exams/' + id) : null; } catch (err) {
    main.replaceChildren(page('mid', failureBox(err, err.status === 404 ? null : () => K.route()), h('p', { class: 'state' }, h('a', { class: 'lb-btn', href: '#/admin/examenes', text: 'Volver a exámenes' }))));
    return {};
  }
  if (ctx.stale()) return {};

  const S = {
    form: C.examSettingsToForm(exam || { title: '', instructions: '', status: 'draft' }),
    blocks: exam ? C.blocksFromExam(exam) : [C.newBlock('Sección 1')],
    tab: 'general',
    active: null,
  };
  if (!S.blocks.length && !exam) S.blocks.push(C.newBlock('Sección 1'));
  S.active = S.blocks[0] ? S.blocks[0].key : null;
  const snapshot = () => JSON.stringify({ f: S.form, b: S.blocks.map(b => [b.id, b.title, b.pick, b.shuffle, b.exercises.map(e => [e.exerciseId, e.pointsOverride])]) });
  let base = snapshot();
  const isDirty = () => snapshot() !== base;
  const guard = e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', guard);

  /* ---------- sticky bar ---------- */
  const titleEl = h('h1', { class: 'xb-title' });
  const dirtyEl = h('span', { class: 'badge warn dirty', hidden: true }, 'Cambios sin guardar');
  const statusEl = h('span');
  const todoEl = h('span', { class: 'small muted' });
  const saveBtn = h('button', { class: 'lb-btn primary', type: 'submit', text: id ? 'Guardar cambios' : 'Crear examen' });
  const pubBtn = id ? h('button', { class: 'lb-btn', type: 'button' }) : null;
  const summary = h('div', { 'aria-live': 'polite', class: 'xb-msg' });
  if (flash) summary.append(notice('error', flash));

  /* ---------- general ---------- */
  const f = {
    title: field('Título', 'input', { value: S.form.title, maxlength: 200, required: true }),
    description: field('Descripción corta', 'textarea', { value: S.form.description, rows: 2, maxlength: 500, hint: 'Aparece en la tarjeta del examen (máximo 500 caracteres).' }),
    instructions: field('Instrucciones para el estudiante', 'textarea', { value: S.form.instructions, rows: 8, hint: 'Admite **negrita**, *cursiva*, `código`, "# Título" y listas con "- ". No se acepta HTML.' }),
    status: field('Estado', 'select', { value: S.form.status, options: [{ value: 'draft', label: 'Borrador' }, { value: 'published', label: 'Publicado' }], hint: 'Un examen en borrador no aparece para los estudiantes.' }),
    ownerId: U.isAdmin() ? field('Propietario', 'select', { value: S.form.ownerId, options: [{ value: S.form.ownerId || '', label: exam && exam.ownerName ? exam.ownerName : 'Yo' }] }) : null,
    durationMinutes: field('Duración (minutos)', 'input', { value: S.form.durationMinutes, inputmode: 'numeric', required: true }),
    maxAttempts: field('Intentos máximos', 'input', { value: S.form.maxAttempts, inputmode: 'numeric', required: true, hint: 'Por estudiante. Los intentos extra se suman.' }),
    scale: field('Escala de la nota', 'input', { value: S.form.scale, inputmode: 'decimal', hint: 'Por ejemplo 20 o 10.' }),
    passPercent: field('Porcentaje para aprobar', 'input', { value: S.form.passPercent, inputmode: 'decimal' }),
    gradePolicy: field('Nota del examen', 'select', { value: S.form.gradePolicy, options: [{ value: 'best', label: 'Mejor intento' }, { value: 'last', label: 'Último intento' }] }),
    availableFrom: field('Disponible desde', 'input', { type: 'datetime-local', value: S.form.availableFrom, hint: 'Opcional. Solo limita cuándo se puede iniciar un intento.' }),
    availableUntil: field('Disponible hasta', 'input', { type: 'datetime-local', value: S.form.availableUntil, hint: 'Opcional.' }),
    shuffleBlocks: field('Mezclar el orden de las secciones en cada intento', 'check', { value: S.form.shuffleBlocks }),
    accessCode: field('Código de acceso', 'input', { value: S.form.accessCode, maxlength: 64, autocomplete: 'off', hint: 'Si lo defines, el estudiante debe escribirlo para comenzar. Déjalo vacío para no pedirlo.' }),
    restricted: field('Restringir a los estudiantes de la lista de acceso', 'check', { value: S.form.restricted }),
    feedbackMode: field('Al enviar cada ejercicio, el estudiante ve', 'select', { value: S.form.feedbackMode, options: C.FEEDBACK_MODES }),
    resultMode: field('La nota final se muestra', 'select', { value: S.form.resultMode, options: C.RESULT_MODES }),
    allowReview: field('Permitir revisar las respuestas al terminar', 'check', { value: S.form.allowReview }),
  };
  const formFields = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  for (const [k, fld] of Object.entries(formFields)) {
    const isCheck = fld.input.type === 'checkbox';
    const sync = () => { S.form[k] = isCheck ? fld.input.checked : fld.input.value; refresh(); };
    fld.input.addEventListener('input', sync);
    fld.input.addEventListener('change', sync);
  }
  if (f.ownerId) U.loadOwners().then(list => {
    if (ctx.stale()) return;
    const cur = S.form.ownerId;
    f.ownerId.input.replaceChildren(...list.map(u => h('option', { value: u.id, text: u.name + ' (' + C.roleLabel(u.role) + ')' })));
    if (cur) f.ownerId.input.value = cur; else S.form.ownerId = f.ownerId.input.value;
    base = snapshot();
  }).catch(() => {});

  /* instructions toolbar */
  const ta = f.instructions.input;
  const fmt = kind => {
    const r = C.applyMdFormat(ta.value, ta.selectionStart, ta.selectionEnd, kind);
    ta.value = r.value; ta.focus(); ta.setSelectionRange(r.start, r.end);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const tbtn = (ic, label, kind) => h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick: () => fmt(kind) }, icon(ic));
  const preview = h('div', { class: 'md-preview card', hidden: true, 'aria-label': 'Vista previa de las instrucciones' });
  const previewBtn = h('button', { class: 'lb-btn sm', type: 'button', 'aria-pressed': 'false', onclick: () => {
    preview.hidden = !preview.hidden;
    previewBtn.setAttribute('aria-pressed', preview.hidden ? 'false' : 'true');
    if (!preview.hidden) preview.replaceChildren(h('div', { class: 'small muted', text: 'Así lo verá el estudiante' }), S.form.instructions.trim() ? K.renderMd(S.form.instructions) : h('p', { class: 'muted', text: 'Sin instrucciones.' }));
  } }, icon('eye'), 'Vista previa');
  ta.addEventListener('input', () => { if (!preview.hidden) preview.replaceChildren(h('div', { class: 'small muted', text: 'Así lo verá el estudiante' }), K.renderMd(ta.value)); });
  const toolbar = h('div', { class: 'md-bar', role: 'toolbar', 'aria-label': 'Formato de las instrucciones' },
    tbtn('bold', 'Negrita', 'bold'), tbtn('italic', 'Cursiva', 'italic'), tbtn('code', 'Código', 'code'), tbtn('heading', 'Título', 'heading'), tbtn('list', 'Lista', 'list'), h('span', { class: 'xfill' }), previewBtn);
  f.instructions.wrap.insertBefore(toolbar, ta);
  f.instructions.wrap.append(preview);

  /* access code helpers */
  const genCode = h('button', { class: 'lb-btn sm', type: 'button', onclick: () => { f.accessCode.input.value = C.generateAccessCode(randomInt, 6); f.accessCode.input.dispatchEvent(new Event('input', { bubbles: true })); } }, icon('refresh'), 'Generar');
  const clrCode = h('button', { class: 'lb-btn sm ghost', type: 'button', onclick: () => { f.accessCode.input.value = ''; f.accessCode.input.dispatchEvent(new Event('input', { bubbles: true })); } }, 'Quitar código');
  const cpCode = h('button', { class: 'lb-btn sm ghost', type: 'button', onclick: async () => { if (f.accessCode.input.value) Sim.toast((await copyText(f.accessCode.input.value)) ? 'Código copiado.' : 'No se pudo copiar.'); } }, icon('copy'), 'Copiar');

  /* mode explanations */
  const fbHelp = h('p', { class: 'mode-help small', 'aria-live': 'polite' });
  const rsHelp = h('p', { class: 'mode-help small', 'aria-live': 'polite' });
  const rvHelp = h('p', { class: 'mode-help small', text: 'Al terminar, el estudiante podrá abrir cada ejercicio enviado (solo lectura) con su puntaje y el resultado de cada verificación, siempre que su nota ya sea visible.' });
  const updateHelp = () => {
    fbHelp.textContent = C.modeHelp(C.FEEDBACK_MODES, S.form.feedbackMode);
    rsHelp.textContent = C.modeHelp(C.RESULT_MODES, S.form.resultMode);
    rvHelp.hidden = !S.form.allowReview;
  };

  /* ---------- blocks tab ---------- */
  const totalsEl = h('div', { class: 'xb-totals chips', 'aria-live': 'polite' });
  const blocksBox = h('div', { class: 'xb-blocks' });
  const blockViews = new Map();
  let bErrors = {};
  const activeBlock = () => S.blocks.find(b => b.key === S.active) || S.blocks[0] || null;

  function updateTotals() {
    const t = C.blockTotals(S.blocks);
    totalsEl.replaceChildren(
      h('span', { class: 'chip' }, icon('layers'), S.blocks.length + (S.blocks.length === 1 ? ' sección' : ' secciones')),
      h('span', { class: 'chip', title: 'Ejercicios que recibe cada estudiante en un intento' }, icon('list'), t.exercises + ' por intento'),
      h('span', { class: 'chip', title: 'Ejercicios publicados entre los que se sortea' }, icon('inbox'), 'Banco: ' + t.poolSize + ' publicados'),
      h('span', { class: 'chip', title: 'Promedio estimado cuando se sortea' }, icon('award'), 'Puntos esperados: ' + C.formatNumber(t.expectedPoints)),
      h('span', { class: 'chip', title: 'Suma de todos los ejercicios publicados' }, 'Puntos del banco: ' + C.formatNumber(t.poolPoints)));
    return t;
  }

  function blockCard(b, index) {
    const view = {};
    const title = field('Nombre de la sección', 'input', { value: b.title, maxlength: 120 });
    title.input.addEventListener('input', () => { b.title = title.input.value; refresh(); });
    const pickMode = field('Ejercicios por intento', 'select', { value: b.pick === '' ? 'all' : 'n', options: [{ value: 'all', label: 'Todos los de la sección' }, { value: 'n', label: 'Sortear una cantidad' }] });
    const pickN = field('Cantidad', 'input', { value: b.pick, inputmode: 'numeric', min: 1 });
    const pickErr = h('div', { class: 'err', hidden: true, role: 'alert' });
    const syncPick = () => { pickN.wrap.hidden = pickMode.input.value === 'all'; };
    pickMode.input.value = b.pick === '' ? 'all' : 'n';
    pickMode.input.addEventListener('change', () => {
      if (pickMode.input.value === 'all') b.pick = '';
      else if (b.pick === '') { b.pick = String(Math.max(1, Math.min(C.publishedCount(b), 1))); pickN.input.value = b.pick; }
      syncPick(); refresh();
    });
    pickN.input.addEventListener('input', () => { b.pick = pickN.input.value.trim(); refresh(); });
    syncPick();
    const shuffle = field('Mezclar el orden dentro de la sección', 'check', { value: b.shuffle });
    shuffle.input.addEventListener('change', () => { b.shuffle = shuffle.input.checked; refresh(); });
    const meta = h('div', { class: 'small muted blk-meta' });
    const list = h('ol', { class: 'blk-list', 'aria-label': 'Ejercicios de ' + (b.title || 'la sección') });
    const rowErr = [];
    const renderList = () => {
      list.replaceChildren(...(b.exercises.length ? b.exercises.map((e, i) => {
        const ov = h('input', { type: 'text', inputmode: 'decimal', value: e.pointsOverride, placeholder: C.formatNumber(e.points), 'aria-label': 'Puntos en este examen para ' + e.title, class: 'ov-in' });
        const ovErr = h('span', { class: 'err', hidden: true });
        rowErr[i] = ovErr;
        ov.addEventListener('input', () => { e.pointsOverride = ov.value.trim(); refresh(); });
        return h('li', { class: e.status !== 'published' ? 'off' : null },
          h('span', { class: 'idx', 'aria-hidden': 'true', text: String(i + 1) }),
          h('span', { class: 't' }, e.title, ' ', h('span', { class: 'small muted', text: '(' + C.formatNumber(e.points) + ' pts)' }), e.status !== 'published' ? badge('Borrador: no se sortea', 'warn') : null, ovErr),
          h('label', { class: 'pts-in' }, h('span', { class: 'small muted', text: 'Puntos' }), ov),
          h('button', { class: 'icon-btn', type: 'button', title: 'Subir', 'aria-label': 'Subir ' + e.title, disabled: i === 0, onclick: () => { b.exercises = C.moveItem(b.exercises, i, i - 1); rebuildBlocks(); focusBtn(b, i - 1, 'Subir'); } }, icon('arrowUp')),
          h('button', { class: 'icon-btn', type: 'button', title: 'Bajar', 'aria-label': 'Bajar ' + e.title, disabled: i === b.exercises.length - 1, onclick: () => { b.exercises = C.moveItem(b.exercises, i, i + 1); rebuildBlocks(); focusBtn(b, i + 1, 'Bajar'); } }, icon('arrowDown')),
          h('button', { class: 'icon-btn danger', type: 'button', title: 'Quitar', 'aria-label': 'Quitar ' + e.title, onclick: () => { b.exercises.splice(i, 1); rebuildBlocks(); } }, icon('x')));
      }) : [h('li', { class: 'empty-li muted', text: 'Sin ejercicios. Agrégalos desde el banco.' })]));
    };
    view.update = () => {
      const pool = C.publishedCount(b);
      const draft = b.exercises.length - pool;
      meta.textContent = 'Banco de la sección: ' + pool + ' publicado' + (pool === 1 ? '' : 's') + (draft ? ' · ' + draft + ' en borrador' : '') + (b.pick === '' ? ' · se entregan todos' : '');
      const err = bErrors[b.key] || {};
      pickErr.hidden = !err.pick; pickErr.textContent = err.pick || '';
      if (err.pick) pickN.input.setAttribute('aria-invalid', 'true'); else pickN.input.removeAttribute('aria-invalid');
      title.setError(err.title || '');
      (b.exercises).forEach((e, i) => {
        const m = (err.override && err.override[i]) || (err.dup && err.dup[i]) || '';
        if (rowErr[i]) { rowErr[i].hidden = !m; rowErr[i].textContent = m; }
      });
    };
    renderList();
    const isActive = b.key === S.active;
    const card = h('section', { class: 'card blk' + (isActive ? ' active' : ''), 'aria-label': 'Sección ' + (index + 1) },
      h('div', { class: 'blk-head' },
        h('span', { class: 'num', 'aria-hidden': 'true', text: String(index + 1) }),
        h('div', { class: 'blk-title' }, title.wrap),
        h('div', { class: 'blk-ctl' },
          h('button', { class: 'lb-btn sm' + (isActive ? ' primary' : ''), type: 'button', 'aria-pressed': isActive ? 'true' : 'false', onclick: () => { S.active = b.key; syncActive(); } }, isActive ? 'Agregando aquí' : 'Agregar aquí'),
          h('button', { class: 'icon-btn', type: 'button', title: 'Subir sección', 'aria-label': 'Subir sección ' + (index + 1), disabled: index === 0, onclick: () => { S.blocks = C.moveItem(S.blocks, index, index - 1); rebuildBlocks(); } }, icon('arrowUp')),
          h('button', { class: 'icon-btn', type: 'button', title: 'Bajar sección', 'aria-label': 'Bajar sección ' + (index + 1), disabled: index === S.blocks.length - 1, onclick: () => { S.blocks = C.moveItem(S.blocks, index, index + 1); rebuildBlocks(); } }, icon('arrowDown')),
          h('button', { class: 'icon-btn danger', type: 'button', title: 'Quitar sección', 'aria-label': 'Quitar sección ' + (index + 1), onclick: async () => {
            if (b.exercises.length && !(await confirmDialog({ title: 'Quitar sección', message: ['Se quitará "' + (b.title || 'la sección') + '" con sus ' + b.exercises.length + ' ejercicio(s) de este examen. Los ejercicios no se eliminan del banco.'], confirmLabel: 'Quitar', danger: true }))) return;
            S.blocks.splice(index, 1); if (S.active === b.key) S.active = S.blocks[0] ? S.blocks[0].key : null; rebuildBlocks();
          } }, icon('trash')))),
      h('div', { class: 'lb-row blk-opts' }, pickMode.wrap, pickN.wrap, h('div', { class: 'lb-field' }, shuffle.wrap)),
      pickErr, meta, list);
    view.el = card;
    blockViews.set(b.key, view);
    return card;
  }
  const focusBtn = (b, i, what) => {
    const v = blockViews.get(b.key);
    const li = v && v.el.querySelectorAll('.blk-list > li')[i];
    const btn = li && [...li.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').startsWith(what));
    if (btn && !btn.disabled) btn.focus();
  };
  function syncActive() {
    S.blocks.forEach(b => {
      const v = blockViews.get(b.key); if (!v) return;
      const on = b.key === S.active;
      v.el.classList.toggle('active', on);
      const btn = v.el.querySelector('.blk-ctl .lb-btn');
      btn.className = 'lb-btn sm' + (on ? ' primary' : ''); btn.textContent = on ? 'Agregando aquí' : 'Agregar aquí'; btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderPicker();
  }
  function rebuildBlocks() {
    blockViews.clear();
    blocksBox.replaceChildren(...(S.blocks.length ? S.blocks.map(blockCard) : [h('div', { class: 'empty-inline' }, icon('layers'), h('p', { class: 'muted', text: 'Aún no hay secciones. Agrega una para empezar.' }))]));
    refresh(); renderPicker();
  }
  const addBlockBtn = h('button', { class: 'lb-btn', type: 'button', onclick: () => {
    if (S.blocks.length >= 20) { Sim.toast('Máximo 20 secciones.'); return; }
    const nb = C.newBlock('Sección ' + (S.blocks.length + 1));
    S.blocks.push(nb); S.active = nb.key; rebuildBlocks();
    const v = blockViews.get(nb.key); const inp = v && v.el.querySelector('input'); if (inp) inp.focus();
  } }, icon('plus'), 'Agregar sección');

  /* picker (exercise bank) */
  const pq = U.filterInput('Buscar en el banco', { placeholder: 'Título o etiqueta' });
  const pd = field('Dificultad', 'select', { options: [{ value: '', label: 'Todas' }, ...C.DIFFICULTIES] });
  const pt = U.filterInput('Etiqueta', { placeholder: 'ej. funciones', maxlength: 30 });
  const pList = h('ul', { class: 'pk-list', 'aria-label': 'Ejercicios publicados del banco' });
  const pTarget = h('p', { class: 'small muted pk-target' });
  let bank = [], bankTotal = 0, bankState = 'loading';
  async function loadBank() {
    bankState = 'loading'; renderPicker();
    try {
      const r = await api.get('/admin/exercises' + U.qs({ status: 'published', q: pq.input.value.trim(), difficulty: pd.input.value, tag: pt.input.value.trim().toLowerCase(), page: 1, pageSize: 30 }));
      if (ctx.stale()) return;
      bank = r.items; bankTotal = r.total; bankState = 'ok';
    } catch (err) { if (ctx.stale()) return; bankState = 'error'; bank = []; }
    renderPicker();
  }
  function renderPicker() {
    const ab = activeBlock();
    pTarget.textContent = ab ? 'Se agrega a: ' + (ab.title || 'la sección') : 'Crea una sección primero.';
    if (bankState === 'loading') { pList.replaceChildren(h('li', { class: 'empty-li muted' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Cargando banco…')); return; }
    if (bankState === 'error') { pList.replaceChildren(h('li', { class: 'empty-li' }, h('span', { class: 'err', text: 'No se pudo cargar el banco.' }), h('button', { class: 'lb-btn sm', type: 'button', onclick: loadBank, text: 'Reintentar' }))); return; }
    const used = new Set(S.blocks.flatMap(b => b.exercises.map(e => e.exerciseId)));
    pList.replaceChildren(...(bank.length ? bank.map(e => h('li', null,
      h('div', { class: 'pk-main' }, h('strong', { text: e.title }), h('div', { class: 'pk-sub' }, diffBadge(e.difficulty), h('span', { class: 'small muted', text: C.formatNumber(e.points) + ' pts' }), tagChips(e.tags))),
      used.has(e.id) ? h('span', { class: 'small muted', text: 'Ya incluido' })
        : h('button', { class: 'lb-btn sm', type: 'button', disabled: !ab, 'aria-label': 'Agregar ' + e.title, onclick: () => {
          const blk = activeBlock(); if (!blk) return;
          blk.exercises.push({ exerciseId: e.id, title: e.title, points: e.points, status: e.status, pointsOverride: '' });
          rebuildBlocks();
        } }, icon('plus'), 'Agregar')))
      : [h('li', { class: 'empty-li muted' }, pq.input.value || pd.input.value || pt.input.value ? 'Ningún ejercicio publicado coincide.' : 'No tienes ejercicios publicados. ', h('a', { href: '#/admin/ejercicios/nuevo', text: pq.input.value ? '' : 'Crea uno' }))]));
    if (bankTotal > bank.length) pList.append(h('li', { class: 'empty-li muted small', text: 'Mostrando ' + bank.length + ' de ' + bankTotal + '. Afina la búsqueda para ver otros.' }));
  }
  const reloadBank = debounce(loadBank, 280);
  pq.input.addEventListener('input', reloadBank); pt.input.addEventListener('input', reloadBank); pd.input.addEventListener('change', loadBank);

  /* draw simulation */
  const drawOut = h('div', { 'aria-live': 'polite' });
  const drawBtn = h('button', { class: 'lb-btn', type: 'button' }, icon('shuffle'), 'Simular sorteo');
  const drawNote = h('p', { class: 'small muted' });
  async function simulate() {
    if (!id) return;
    await withBusy(drawBtn, async () => {
      drawOut.replaceChildren(loadingBox('Sorteando…'));
      try {
        const r = await api.post('/admin/exams/' + id + '/draw-preview', {});
        drawBtn.lastChild.textContent = 'Sortear otra vez';
        drawOut.replaceChildren(
          h('div', { class: 'chips' }, h('span', { class: 'chip', text: r.exerciseCount + ' ejercicios' }), h('span', { class: 'chip', text: C.formatNumber(r.totalPoints) + ' puntos en total' }), h('span', { class: 'chip', text: 'Semilla ' + r.seed })),
          r.blocks.map(b => h('div', { class: 'draw-block' },
            h('div', { class: 'draw-head' }, h('strong', { text: b.title }), h('span', { class: 'small muted', text: (b.pickCount == null ? 'todos' : b.pickCount + ' de ' + b.poolSize) + ' · ' + C.formatNumber(b.points) + ' pts' })),
            b.exercises.length ? h('ol', null, b.exercises.map(e => h('li', null, h('span', { text: e.title }), h('span', { class: 'small muted', text: C.formatNumber(e.points) + ' pts' })))) : h('p', { class: 'small muted', text: 'Esta sección no entrega ejercicios.' }))));
      } catch (err) { drawOut.replaceChildren(notice('error', C.errorMessage(err))); }
    });
  }
  drawBtn.addEventListener('click', simulate);

  /* ---------- access + extra attempts (saved immediately; existing exams only) ---------- */
  const accessPanel = h('div');
  async function buildAccess() {
    if (!id) { accessPanel.replaceChildren(notice('info', 'Guarda el examen para gestionar la lista de acceso y los intentos extra.')); return; }
    accessPanel.replaceChildren(loadingBox('Cargando acceso…'));
    let acc, overrides, an;
    try { [acc, overrides, an] = await Promise.all([api.get('/admin/exams/' + id + '/access'), api.get('/admin/exams/' + id + '/overrides'), api.get('/admin/exams/' + id + '/analytics')]); }
    catch (err) { accessPanel.replaceChildren(failureBox(err, buildAccess)); return; }
    if (ctx.stale()) return;
    const people = new Map();
    (acc.entries || []).forEach(e => { if (e && e.userId) people.set(e.userId, { userId: e.userId, name: e.name || e.email, email: e.email }); });
    an.students.forEach(s => people.set(s.userId, { userId: s.userId, name: s.name, email: s.email }));
    const emails = (acc.entries || []).map(e => (typeof e === 'string' ? e : e.email)).filter(Boolean);
    const list = field('Correos de los estudiantes', 'textarea', { rows: 6, value: emails.join('\n'), hint: 'Uno por línea, o separados por coma o espacio. Solo cuentan los correos de cuentas de estudiantes.' });
    const listOut = h('div', { 'aria-live': 'polite' });
    const saveList = h('button', { class: 'lb-btn primary', type: 'button', text: 'Guardar lista' });
    saveList.addEventListener('click', () => withBusy(saveList, async () => {
      const parsed = C.parseEmails(list.input.value);
      list.clear();
      if (parsed.invalid.length) { list.setError('Estos correos no son válidos: ' + parsed.invalid.slice(0, 5).join(', ') + (parsed.invalid.length > 5 ? '…' : '')); list.input.focus(); return; }
      try {
        const r = await api.put('/admin/exams/' + id + '/access', { emails: parsed.valid });
        r.matched.forEach(m => people.set(m.userId, m));
        refreshPeople();
        listOut.replaceChildren(
          notice(r.unknown.length ? 'warn' : 'ok', 'Lista guardada: ' + r.matched.length + ' estudiante(s) encontrados' + (r.unknown.length ? ' y ' + r.unknown.length + ' correo(s) sin cuenta de estudiante.' : '.')),
          r.unknown.length ? h('div', null, h('p', { class: 'small muted', text: 'Sin cuenta de estudiante (no podrán entrar hasta que se registren con ese correo):' }), h('div', { class: 'chips' }, r.unknown.map(u => h('span', { class: 'chip', text: u })))) : null,
          r.matched.length ? h('div', null, h('p', { class: 'small muted', text: 'Encontrados:' }), h('div', { class: 'chips' }, r.matched.map(m => h('span', { class: 'chip', title: m.email, text: m.name })))) : null,
          !S.form.restricted ? notice('info', 'La lista solo se aplica si activas "Restringir a los estudiantes de la lista de acceso" en Reglas y tiempo.') : null);
      } catch (err) { listOut.replaceChildren(notice('error', C.errorMessage(err))); }
    }));

    const who = field('Estudiante', 'input', { placeholder: 'Escribe nombre o correo', autocomplete: 'off', hint: 'Elige de la lista: aparecen los estudiantes de la lista de acceso y quienes ya presentaron el examen.' });
    const dl = h('datalist', { id: 'peopleList' });
    who.input.setAttribute('list', 'peopleList');
    const refreshPeople = () => dl.replaceChildren(...[...people.values()].map(p => h('option', { value: p.email, label: p.name })));
    refreshPeople();
    const extra = field('Intentos extra', 'select', { options: [1, 2, 3, 4, 5].map(n => ({ value: String(n), label: '+' + n })) });
    const reason = field('Motivo (opcional)', 'input', { maxlength: 300 });
    const grantOut = h('div', { 'aria-live': 'polite' });
    const ovBox = h('div');
    const grantBtn = h('button', { class: 'lb-btn primary', type: 'button', text: 'Conceder intentos' });
    const renderOverrides = items => {
      ovBox.replaceChildren(items.length ? table(['Estudiante', 'Extra', 'Motivo', 'Concedido', ''], items.map(o => h('tr', null,
        h('td', null, o.userName, h('div', { class: 'small muted', text: o.userEmail })),
        h('td', { class: 'num', text: '+' + o.extra }),
        h('td', { class: 'small', text: o.reason || '-' }),
        h('td', { class: 'small nowrap muted', text: fmtDate(o.createdAt) + (o.grantedByName ? ' · ' + o.grantedByName : '') }),
        h('td', null, h('button', { class: 'lb-btn sm danger', type: 'button', 'aria-label': 'Revocar intentos de ' + o.userName, onclick: async () => {
          if (!(await confirmDialog({ title: 'Revocar intentos extra', message: ['Se quitarán +' + o.extra + ' intento(s) a ' + o.userName + '.'], confirmLabel: 'Revocar', danger: true }))) return;
          try { await api.del('/admin/exams/' + id + '/overrides/' + o.id); Sim.toast('Intentos revocados.'); await reloadOverrides(); } catch (err) { await infoDialog('No se pudo revocar', C.errorMessage(err)); }
        } }, 'Revocar')))), [1]) : h('p', { class: 'muted small', text: 'No hay intentos extra concedidos.' }));
    };
    const reloadOverrides = async () => { try { renderOverrides(await api.get('/admin/exams/' + id + '/overrides')); } catch (err) { ovBox.replaceChildren(failureBox(err, reloadOverrides)); } };
    renderOverrides(overrides);
    grantBtn.addEventListener('click', () => withBusy(grantBtn, async () => {
      who.clear(); grantOut.replaceChildren();
      const typed = who.input.value.trim().toLowerCase();
      const everyone = [...people.values()];
      let hit = everyone.find(p => p.email.toLowerCase() === typed);
      if (!hit) { const byName = everyone.filter(p => p.name.toLowerCase() === typed); if (byName.length === 1) hit = byName[0]; }
      if (!typed) { who.setError('Elige un estudiante.'); who.input.focus(); return; }
      if (!hit) { who.setError('No encuentro a ese estudiante en la lista de acceso ni entre quienes presentaron el examen. Agrégalo a la lista (con su correo) y vuelve a intentar.'); who.input.focus(); return; }
      try {
        const r = await api.post('/admin/exams/' + id + '/grant-attempt', { userId: hit.userId, extra: Number(extra.input.value), reason: reason.input.value.trim() });
        grantOut.replaceChildren(notice('ok', hit.name + ' ahora puede hacer hasta ' + r.effectiveMaxAttempts + ' intentos.'));
        who.input.value = ''; reason.input.value = '';
        await reloadOverrides();
      } catch (err) { grantOut.replaceChildren(notice('error', C.errorMessage(err))); }
    }));
    accessPanel.replaceChildren(
      h('div', { class: 'card' }, secHead('users', 'Lista de acceso', 'Quiénes pueden ver e iniciar el examen cuando está restringido.'), list.wrap, h('div', { class: 'form-inline' }, saveList), listOut),
      h('div', { class: 'card' }, secHead('plus', 'Intentos extra', 'Concede intentos adicionales a un estudiante (se suman al máximo del examen).'),
        h('div', { class: 'lb-row' }, who.wrap, extra.wrap, reason.wrap), dl, grantBtn, grantOut,
        h('h3', { class: 'sect', text: 'Concedidos' }), ovBox));
  }

  /* ---------- publish tab ---------- */
  const checkBox = h('ul', { class: 'checklist', 'aria-label': 'Requisitos para publicar' });
  const pubMsg = h('div', { 'aria-live': 'polite' });
  const dupBtn = id ? h('button', { class: 'lb-btn', type: 'button' }, icon('copy'), 'Duplicar examen') : null;
  const delBtn = id ? h('button', { class: 'lb-btn danger', type: 'button' }, icon('trash'), 'Eliminar examen') : null;
  const publishPanel = h('div', { class: 'card' },
    secHead('send', 'Publicación', 'Un examen publicado aparece a los estudiantes (según su ventana y su lista de acceso).'),
    checkBox,
    h('div', { class: 'form-inline' }, pubBtn || h('p', { class: 'small muted', text: 'Guarda el examen como borrador y luego publícalo desde aquí.' }), dupBtn, delBtn), pubMsg,
    id ? h('p', { class: 'deeplink small muted' }, icon('send'), 'Enlace directo para estudiantes: ', h('code', { text: location.origin + location.pathname + '?exam=' + id })) : null,
    id ? h('p', { class: 'small' }, h('a', { href: '#/admin/examenes/' + id + '/analiticas', text: 'Ver analíticas' }), ' · ', h('a', { href: '#/admin/resultados?examId=' + id, text: 'Ver intentos' })) : null);
  function renderChecklist() {
    const items = C.publishChecklist(S.form, S.blocks);
    checkBox.replaceChildren(...items.map(i => h('li', { class: i.ok ? 'pass' : (i.warn ? 'warn' : 'fail') },
      h('span', { class: 'mark', 'aria-hidden': 'true' }, icon(i.ok ? 'check' : (i.warn ? 'alert' : 'x'))),
      h('span', { class: 'ct' }, i.label, i.detail ? h('span', { class: 'small muted block', text: i.detail }) : null,
        h('span', { class: 'sr-only', text: i.ok ? ' (cumple)' : (i.warn ? ' (aviso)' : ' (falta)') })))));
    return items;
  }

  /* ---------- refresh (cheap, runs on every edit) ---------- */
  function refresh() {
    titleEl.textContent = S.form.title.trim() || (id ? 'Examen sin título' : 'Nuevo examen');
    const live = id ? (exam.status) : 'draft';
    statusEl.replaceChildren(statusBadge(live));
    dirtyEl.hidden = !isDirty();
    updateHelp();
    updateTotals();
    bErrors = C.validateBlocks(S.blocks).errors;
    S.blocks.forEach(b => { const v = blockViews.get(b.key); if (v) v.update(); });
    const items = renderChecklist();
    const missing = items.filter(i => !i.warn && !i.ok).length;
    todoEl.textContent = missing ? missing + (missing === 1 ? ' requisito pendiente para publicar' : ' requisitos pendientes para publicar') : 'Listo para publicar';
    if (pubBtn) {
      const published = exam.status === 'published';
      pubBtn.replaceChildren(icon(published ? 'x' : 'send'), published ? 'Despublicar' : 'Publicar');
    }
    drawBtn.disabled = !id || isDirty();
    drawNote.textContent = !id ? 'Guarda el examen para poder simular el sorteo.' : isDirty() ? 'Guarda los cambios para simular con la estructura actual.' : 'Simula un intento sin crear nada: así verás qué ejercicios recibiría un estudiante.';
  }
  const tabDots = {};
  function markTabs(tabs) { for (const t of TABS) { if (tabDots[t.key]) tabDots[t.key].hidden = !tabs.has(t.key); } }

  /* ---------- save ---------- */
  async function save(statusOverride) {
    const prev = S.form.status;
    const ok = await doSave(statusOverride);
    if (!ok && statusOverride && S.form.status === statusOverride && prev !== statusOverride) { S.form.status = prev; f.status.input.value = prev; refresh(); }
    return ok;
  }
  async function doSave(statusOverride) {
    summary.replaceChildren();
    if (statusOverride) { S.form.status = statusOverride; f.status.input.value = statusOverride; }
    const errs = C.validateExamSettings(S.form);
    const bv = C.validateBlocks(S.blocks);
    bErrors = bv.errors;
    const first = applyErrors(formFields, errs);
    const badTabs = new Set(Object.keys(errs).map(k => FIELD_TAB[k] || 'general'));
    if (!bv.ok) badTabs.add('blocks');
    markTabs(badTabs); refresh();
    if (S.form.status === 'published' && !C.checklistReady(C.publishChecklist(S.form, S.blocks))) {
      badTabs.add('publish'); markTabs(badTabs);
      summary.append(notice('error', 'No se puede publicar todavía. Revisa los requisitos en la pestaña Publicación.'));
      if (!first && bv.ok) { selectTab('publish'); return false; }
    }
    if (first || !bv.ok) {
      summary.append(notice('error', 'Revisa los campos marcados.'));
      const t = first ? (FIELD_TAB[Object.keys(errs)[0]] || 'general') : 'blocks';
      selectTab(t);
      setTimeout(() => { const el = first ? first.input : document.querySelector('.blk [aria-invalid="true"], .blk .err:not([hidden])'); if (el && el.focus) el.focus(); }, 0);
      return false;
    }
    const payload = C.examSettingsToPayload(S.form, { withOwner: U.isAdmin() });
    const blocksBody = C.blocksToPayload(S.blocks);
    let createdId = null;
    try {
      if (!id) {
        const created = await api.post('/admin/exams', { ...payload, status: 'draft', blocks: blocksBody.blocks });
        createdId = created.id;
        if (payload.status === 'published') await api.put('/admin/exams/' + createdId, { status: 'published' });
        base = snapshot();
        Sim.toast('Examen creado.');
        navigate('#/admin/examenes/' + createdId, true);
      } else {
        if (payload.status === 'published') {
          await api.put('/admin/exams/' + id + '/blocks', blocksBody);
          await api.put('/admin/exams/' + id, payload);
        } else {
          await api.put('/admin/exams/' + id, payload);
          await api.put('/admin/exams/' + id + '/blocks', blocksBody);
        }
        base = snapshot();
        Sim.toast('Examen guardado.');
        navigate('#/admin/examenes/' + id, true);
      }
      return true;
    } catch (err) {
      if (createdId) {
        K.state.flash = 'El examen se creó como borrador, pero no se pudo completar: ' + C.errorMessage(err);
        base = snapshot();
        navigate('#/admin/examenes/' + createdId, true);
        return false;
      }
      const map = {};
      const tabs = new Set();
      (err.fields || []).forEach(p => {
        const top = String(p).split('.')[0];
        map[top] = 'Valor no válido.'; tabs.add(FIELD_TAB[top] || 'general');
      });
      applyErrors(formFields, map);
      if (['PICK_EXCEEDS_POOL', 'DUPLICATE_EXERCISES', 'UNKNOWN_EXERCISE', 'EXERCISE_NOT_PUBLISHED', 'EXAM_EMPTY', 'EXAM_POOL_TOO_SMALL'].includes(err.code)) tabs.add('blocks');
      markTabs(tabs);
      summary.replaceChildren(notice('error', C.errorMessage(err)));
      if (tabs.size && !tabs.has(S.tab)) selectTab([...tabs][0]);
      return false;
    }
  }

  const form = h('form', { novalidate: true, 'aria-label': 'Examen' });
  form.addEventListener('submit', e => { e.preventDefault(); withBusy(saveBtn, () => save()); });
  if (pubBtn) pubBtn.addEventListener('click', () => withBusy(pubBtn, async () => { pubMsg.replaceChildren(); await save(exam.status === 'published' ? 'draft' : 'published'); }));
  if (dupBtn) dupBtn.addEventListener('click', async () => {
    if (isDirty() && !(await confirmDialog({ title: 'Duplicar examen', message: ['Se duplicará la versión guardada; los cambios sin guardar no se copian.'], confirmLabel: 'Duplicar' }))) return;
    await withBusy(dupBtn, async () => {
      try { const c = await api.post('/admin/exams/' + id + '/duplicate'); base = snapshot(); Sim.toast('Copia creada como borrador.'); navigate('#/admin/examenes/' + c.id); }
      catch (err) { pubMsg.replaceChildren(notice('error', C.errorMessage(err))); }
    });
  });
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Eliminar examen', message: ['¿Eliminar "' + S.form.title + '"? No se puede deshacer.'], confirmLabel: 'Eliminar', danger: true }))) return;
    await withBusy(delBtn, async () => {
      try { await api.del('/admin/exams/' + id); base = snapshot(); Sim.toast('Examen eliminado.'); navigate('#/admin/examenes'); }
      catch (err) { pubMsg.replaceChildren(notice(err.code === 'EXAM_IN_USE' || err.status === 409 ? 'warn' : 'error', C.errorMessage(err))); }
    });
  });

  /* ---------- tabs ---------- */
  const panels = {};
  const tabBtns = {};
  const tablist = h('div', { class: 'xb-tabs', role: 'tablist', 'aria-label': 'Secciones del examen' });
  TABS.forEach(t => {
    const dot = h('i', { class: 'dot', hidden: true, title: 'Hay campos por revisar' });
    tabDots[t.key] = dot;
    tabBtns[t.key] = h('button', { type: 'button', role: 'tab', id: 'xt-' + t.key, 'aria-controls': 'xp-' + t.key, 'aria-selected': 'false', tabindex: '-1', onclick: () => selectTab(t.key), onkeydown: e => {
      const i = TABS.findIndex(x => x.key === t.key);
      const go = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
      if (go >= 0) { e.preventDefault(); selectTab(TABS[go].key); tabBtns[TABS[go].key].focus(); }
    } }, icon(t.icon), h('span', { text: t.label }), dot);
    tablist.append(tabBtns[t.key]);
  });
  function selectTab(key) {
    S.tab = key;
    for (const t of TABS) {
      const on = t.key === key;
      tabBtns[t.key].setAttribute('aria-selected', on ? 'true' : 'false');
      tabBtns[t.key].tabIndex = on ? 0 : -1;
      panels[t.key].hidden = !on;
    }
    if (key === 'blocks' && bankState === 'loading' && !bank.length) loadBank();
    if (key === 'access') buildAccess();
    const el = tabBtns[key]; if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* jsdom */ } }
  }
  const panel = (key, ...kids) => { panels[key] = h('div', { class: 'xb-panel', role: 'tabpanel', id: 'xp-' + key, 'aria-labelledby': 'xt-' + key, hidden: true }, ...kids); return panels[key]; };

  const owner = f.ownerId;
  form.append(
    panel('general',
      h('div', { class: 'card' }, secHead('fileText', 'Datos del examen', 'Lo que ve el estudiante antes de comenzar.'), f.title.wrap, f.description.wrap, f.instructions.wrap),
      h('div', { class: 'card' }, secHead('send', 'Estado y propietario'), h('div', { class: 'lb-row' }, f.status.wrap, owner ? owner.wrap : null))),
    panel('rules',
      h('div', { class: 'card' }, secHead('clock', 'Tiempo e intentos'), h('div', { class: 'lb-row' }, f.durationMinutes.wrap, f.maxAttempts.wrap)),
      h('div', { class: 'card' }, secHead('award', 'Calificación'), h('div', { class: 'lb-row' }, f.scale.wrap, f.passPercent.wrap, f.gradePolicy.wrap)),
      h('div', { class: 'card' }, secHead('repeat', 'Disponibilidad', 'Ventana en la que se puede iniciar un intento.'), h('div', { class: 'lb-row' }, f.availableFrom.wrap, f.availableUntil.wrap), f.shuffleBlocks.wrap),
      h('div', { class: 'card' }, secHead('key', 'Acceso', 'Quién puede entrar al examen.'), f.accessCode.wrap, h('div', { class: 'form-inline' }, genCode, cpCode, clrCode), f.restricted.wrap)),
    panel('feedback',
      h('div', { class: 'card' }, secHead('check', 'Retroalimentación al enviar un ejercicio'), f.feedbackMode.wrap, fbHelp),
      h('div', { class: 'card' }, secHead('award', 'Nota final'), f.resultMode.wrap, rsHelp, f.allowReview.wrap, rvHelp)),
    panel('blocks',
      totalsEl,
      h('div', { class: 'xb-split' },
        h('div', { class: 'xb-left' }, blocksBox, h('div', { class: 'form-inline' }, addBlockBtn),
          h('div', { class: 'card' }, secHead('shuffle', 'Simular sorteo', 'Mira qué ejercicios recibiría un estudiante en un intento.'), drawNote, h('div', { class: 'form-inline' }, drawBtn), drawOut)),
        h('aside', { class: 'card xb-picker', 'aria-label': 'Banco de ejercicios' },
          secHead('search', 'Banco de ejercicios', 'Solo ejercicios publicados.'),
          pTarget, pq.wrap, h('div', { class: 'lb-row' }, pd.wrap, pt.wrap), pList))),
    panel('access', accessPanel),
    panel('publish', publishPanel));

  const bar = h('div', { class: 'xb-bar' },
    h('div', { class: 'xb-id' }, h('a', { class: 'back', href: '#/admin/examenes' }, icon('arrowLeft'), 'Exámenes'), titleEl, statusEl, dirtyEl),
    h('div', { class: 'xb-act' }, todoEl, pubBtn, saveBtn));
  const root = h('div', { class: 'xb' }, h('div', { class: 'xb-sticky' }, bar, tablist), summary, form);
  main.replaceChildren(page('', root));
  rebuildBlocks();
  selectTab('general');
  loadBank();
  refresh();
  // wrap the bar buttons in the form so Enter/submit works from the sticky bar
  saveBtn.setAttribute('form', 'xbForm'); form.id = 'xbForm';

  return {
    async leave() { return isDirty() ? confirmLeave() : true; },
    destroy() { window.removeEventListener('beforeunload', guard); reloadBank.cancel(); },
  };
}
screens.adminExamNew = ctx => examBuilder(ctx, null);
screens.adminExam = ctx => examBuilder(ctx, ctx.params.id);
})();

/* =====================================================================
   GridLab UI. All formula logic lives in engine.js (window.GridEngine).
   ===================================================================== */
(() => {
'use strict';
const DEF_W = 64, HEAD_W = 40;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ================= Engine ================= */
const eng = window.GridEngine.createEngine({ decimal: ',' });
const ST = eng.S;   // ST.wb = workbook, ST.cur = active sheet index, ST.DEC = decimal separator
const { ROWS, COLS, colName, A, parseA, parseRangeText, isErr, errText, r15, boolText, parseLiteral, cmp, parseFormula, balanceParens, toCanonFormula, toLocalFormula, shiftFormula, localizeFns, refsInFormula, sheet, cache, circular, astCache, sheetIndex, storedValue, cellValue, FN, resolveFn, MATH, STAT, LOGIC, LOOK, TEXT, DATE, INFO, FIN, esName, FN_LIST, AC_LIST, display, autoFmt, editText, CATS } = eng;

/* ================= Preferences (skin + regional settings) ================= */
const PREF_KEY='gridlab.prefs.v1';
const prefs={skin:'excel', region:'auto'};
try{ Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY))||{}); }catch(e){}
const savePrefs = () => { try{ localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); }catch(e){} };
const autoComma = (() => { try{ return (1.5).toLocaleString().includes(','); }catch(e){ return true; } })();
function applyRegion(){ ST.DEC = prefs.region==='dot' ? '.' : prefs.region==='comma' ? ',' : (autoComma ? ',' : '.'); }
applyRegion();
const SEP = () => ST.DEC===',' ? ';' : ',';
document.documentElement.dataset.skin = prefs.skin;
let isPhone=false, nativeKb=false;

let recentFns=['SUM','AVERAGE','IF','VLOOKUP','COUNTIF','MAX','MIN','SUMIF','XLOOKUP','CONCAT'];
const fnArgs = f => f.args ? f.args.split(', ').join(SEP()+' ') : '';

/* ================= Workbook state ================= */
const KEY='gridlab.workbook.es.v1';
const SCHEMA=2;   // stored payload version; older/odd payloads are sanitized on load
let autosave=true, showFormulas=false, zoom=100;
const view={gridlines:true, headings:true, formulaBar:true};
function blankSheet(name){ return {name, cells:{}, colW:{}, sel:{ar:0,ac:0,fr:0,fc:0}}; }
function sampleWorkbook(){
  const s1=blankSheet('Ventas'), s2=blankSheet('Práctica'), s3=blankSheet('Hoja3');
  const put=(sh,a,v,s)=>{ sh.cells[a]={v:String(v)}; if(s) sh.cells[a].s={...s}; };
  const H={b:true, fill:'#196B24', color:'#FFFFFF'};
  ['Producto','Categoría','Unidades','Precio unitario','Total','Descuento','Estado'].forEach((h,i)=>put(s1,A(0,i),h,H));
  [['Portátil','Computadoras',12,899],['Monitor','Computadoras',25,189.5],['Teclado','Accesorios',40,35],['Mouse','Accesorios',55,19.9],['Auriculares','Audio',18,74],['Cámara web','Accesorios',22,59],['Impresora','Oficina',7,229],['Tableta','Computadoras',15,349]]
  .forEach((r,i)=>{ const n=i+2; put(s1,'A'+n,r[0]); put(s1,'B'+n,r[1]); put(s1,'C'+n,r[2]); put(s1,'D'+n,r[3],{fmt:'currency'});
    put(s1,'E'+n,`=C${n}*D${n}`,{fmt:'currency'}); put(s1,'F'+n,`=SI(E${n}>1000,E${n}*10%,0)`,{fmt:'currency'}); put(s1,'G'+n,`=SI(C${n}>=20,"Alto","Bajo")`); });
  put(s1,'D11','Total',{b:true,ha:'right'}); put(s1,'E11','=SUMA(E2:E9)',{b:true,fmt:'currency',bt:1,bb:1});
  put(s1,'D12','Promedio',{ha:'right'}); put(s1,'E12','=PROMEDIO(E2:E9)',{fmt:'currency'});
  put(s1,'D13','Máximo',{ha:'right'}); put(s1,'E13','=MAX(E2:E9)',{fmt:'currency'});
  put(s1,'D14','Mínimo',{ha:'right'}); put(s1,'E14','=MIN(E2:E9)',{fmt:'currency'});
  put(s1,'D15','Productos',{ha:'right'}); put(s1,'E15','=CONTARA(A2:A9)');
  put(s1,'I1','Búsqueda rápida',{b:true});
  put(s1,'I2','Producto'); put(s1,'J2','Tableta',{fill:'#FFF2CC'});
  put(s1,'I3','Precio unitario'); put(s1,'J3','=BUSCARV(J2,A2:D9,4,FALSO)',{fmt:'currency'});
  put(s1,'I4','Unidades de accesorios'); put(s1,'J4','=SUMAR.SI(B2:B9,"Accesorios",C2:C9)');
  put(s1,'I5','Productos de alto volumen'); put(s1,'J5','=CONTAR.SI(G2:G9,"Alto")');
  put(s1,'I6','Fecha del informe'); put(s1,'J6','=HOY()');
  s1.colW={0:92,1:104,3:96,4:88,5:84,8:156,9:92};
  put(s2,'A1','Práctica de fórmulas',{b:true,size:14});
  put(s2,'A2','Escribe cada fórmula en la columna C. La columna E te indica si tu resultado coincide con el esperado.',{i:true,color:'#595959'});
  put(s2,'A4','Elemento',H); put(s2,'B4','Importe',H);
  [['Primero',25],['Segundo',40],['Tercero',15],['Cuarto',60]].forEach((r,i)=>{ put(s2,'A'+(5+i),r[0]); put(s2,'B'+(5+i),r[1]); });
  ['Tarea','','Tu fórmula','Esperado','Revisión'].forEach((h,i)=>put(s2,A(9,i),h,H));
  [['Suma todos los importes (SUMA)',140],['Importe promedio (PROMEDIO)',35],['Importe más alto (MAX)',60],['¿Cuántos importes son mayores que 20? (CONTAR.SI)',3],['Importe de "Tercero" (BUSCARV)',15],['¿El primer importe es mayor que 30? Responde "Sí" o "No" (SI)','No'],['"Primero" en mayúsculas (MAYUSC)','PRIMERO'],['Segundo importe más el 15 % (usa 15%)',46]]
  .forEach((t,i)=>{ const n=11+i; put(s2,'A'+n,t[0]); put(s2,'C'+n,'',{fill:'#FFF2CC'}); put(s2,'D'+n,t[1],{ha:'right'});
    put(s2,'E'+n,`=SI(C${n}="","",SI(C${n}=D${n},"Correcto","Inténtalo de nuevo"))`); });
  s2.colW={0:330,1:70,2:120,3:84,4:120};
  return {name:'Libro1', sheets:[s1,s2,s3]};
}
function save(){
  if(!autosave) return;
  try{ localStorage.setItem(KEY, JSON.stringify({ver:SCHEMA, wb:ST.wb, cur:ST.cur, view, zoom})); $('#saveState').textContent='· Guardado en este navegador'; }catch(e){ $('#saveState').textContent='· No se pudo guardar'; }
}
function load(){
  try{
    const raw=localStorage.getItem(KEY);
    if(raw){
      const d=JSON.parse(raw);
      if(!d || typeof d!=='object') throw new Error('bad payload');
      ST.wb=window.GridEngine.sanitizeWorkbook(d.wb, {maxSheets:100, maxCells:100000, maxStr:32768});
      ST.cur=clamp(Math.trunc(+d.cur)||0,0,ST.wb.sheets.length-1);
      const v=d.view&&typeof d.view==='object'?d.view:{};
      for(const k of ['gridlines','headings','formulaBar']) if(typeof v[k]==='boolean') view[k]=v[k];
      zoom=clamp(Math.round(+d.zoom)||100,10,400);
      return;
    }
  }catch(e){}
  ST.wb=sampleWorkbook(); ST.cur=0;
}

const undoStack=[], redoStack=[];
const snapshot = () => JSON.stringify({sheets:ST.wb.sheets, cur:ST.cur});
function pushUndo(){ undoStack.push(snapshot()); if(undoStack.length>100) undoStack.shift(); redoStack.length=0; }
function restore(s){ const d=JSON.parse(s); ST.wb.sheets=d.sheets; ST.cur=clamp(d.cur,0,ST.wb.sheets.length-1); sel={...(sheet().sel||{ar:0,ac:0,fr:0,fc:0})}; afterStructure(); }
function undo(){ if(edit) return cancelEdit(); if(!undoStack.length) return toast('No hay nada que deshacer.'); redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo(){ if(!redoStack.length) return toast('No hay nada que rehacer.'); undoStack.push(snapshot()); restore(redoStack.pop()); }

/* ================= Grid ================= */
const grid=$('#grid'), scroller=$('#scroller');
let tds=[], colEls=[], colHeads=[], rowHeads=[], rowEls=[];
let sel={ar:0,ac:0,fr:0,fc:0};
const rng = () => ({r1:Math.min(sel.ar,sel.fr), r2:Math.max(sel.ar,sel.fr), c1:Math.min(sel.ac,sel.fc), c2:Math.max(sel.ac,sel.fc)});
const colW = c => sheet().colW[c] ?? DEF_W;
function buildGrid(){
  let h='<colgroup><col class="hc">'+'<col>'.repeat(COLS)+'</colgroup><thead><tr><th class="corner" title="Seleccionar todo"><span class="corner-tri"></span></th>';
  for(let c=0;c<COLS;c++) h+=`<th class="ch">${colName(c)}<span class="rsz"></span></th>`;
  h+='</tr></thead><tbody>';
  const row='<td></td>'.repeat(COLS);
  for(let r=0;r<ROWS;r++) h+=`<tr><th class="rh">${r+1}</th>${row}</tr>`;
  grid.innerHTML=h+'</tbody>';
  colEls=[...grid.querySelectorAll('col')].slice(1);
  colHeads=[...grid.tHead.rows[0].cells].slice(1);
  const body=grid.tBodies[0].rows;
  for(let r=0;r<ROWS;r++){ rowEls.push(body[r]); rowHeads.push(body[r].cells[0]); tds.push([...body[r].cells].slice(1)); }
}
/* Rows listed in sheet().hiddenRows are not drawn (used by the filter). */
const hiddenSet = () => new Set(sheet().hiddenRows||[]);
function applyRowVisibility(){ const h=hiddenSet(); rowEls.forEach((tr,r)=>{ const v=h.has(r)?'none':''; if(tr.style.display!==v) tr.style.display=v; }); }
function applyColWidths(){
  let sum=view.headings?HEAD_W:0;
  grid.querySelector('col.hc').style.width=view.headings?`calc(${HEAD_W}px * var(--z))`:'0px';
  colEls.forEach((col,c)=>{ const w=colW(c); sum+=w; col.style.width=`calc(${w}px * var(--z))`; });
  grid.style.width=`calc(${sum}px * var(--z))`;
}
function cellFromEl(el){ const td=el && el.closest && el.closest('td'); if(!td || !grid.contains(td)) return null; return {r:td.parentNode.sectionRowIndex, c:td.cellIndex-1}; }
const cellAt = (x,y) => cellFromEl(document.elementFromPoint(x,y));
const hasContent = (r,c) => { const cell=sheet().cells[A(r,c)]; return !!(cell && cell.v!=null && cell.v!==''); };

let painted=new Set();
function clearTd(key){ const p=parseA(key); if(!p) return; const td=tds[p.r][p.c]; td.textContent=''; td.style.cssText=''; td.className=''; }
function paintCell(key){
  const p=parseA(key); if(!p) return; const {r,c}=p; const td=tds[r][c];
  const cell=sheet().cells[key]; const s=cell.s||{}; const raw=cell.v||'';
  const isF = raw[0]==='=' && !cell.str;
  const v = raw==='' ? null : cellValue(ST.cur,r,c);
  let text, type;
  if(showFormulas && isF){ text=toLocalFormula(raw); type='string'; }
  else { text=display(v, s, isF ? autoFmt(raw) : null); type = isErr(v) ? 'err' : typeof v; }
  let st='';
  if(s.b) st+='font-weight:700;';
  if(s.i) st+='font-style:italic;';
  const deco=[s.u&&'underline', s.st&&'line-through'].filter(Boolean).join(' '); if(deco) st+=`text-decoration:${deco};`;
  if(s.font) st+=`font-family:"${s.font}",var(--cell-font);`;
  if(s.size) st+=`font-size:calc(${s.size}pt * var(--z));`;
  if(s.color) st+=`color:${s.color};`;
  if(s.fill) st+=`background:${s.fill};`;
  const ha = s.ha || (type==='number' ? 'right' : (type==='boolean'||type==='err') ? 'center' : 'left');
  st+=`text-align:${ha};`;
  if(s.va) st+=`vertical-align:${s.va};`;
  if(s.ind) st+=`padding-left:calc(${3+s.ind*9}px * var(--z));`;
  const sh=[]; if(s.bt) sh.push('inset 0 1px 0 var(--border-ink)'); if(s.bb) sh.push('inset 0 -1px 0 var(--border-ink)'); if(s.bl) sh.push('inset 1px 0 0 var(--border-ink)'); if(s.br) sh.push('inset -1px 0 0 var(--border-ink)');
  if(sh.length) st+=`box-shadow:${sh.join(',')};`;
  const ovf = !s.wrap && text!=='' && (type==='string'||type==='err') && ha==='left' && c<COLS-1 && !hasContent(r,c+1);
  td.className=(s.wrap?'wrap ':'')+(ovf?'ovf':'');
  td.style.cssText=st;
  if(td.textContent!==text) td.textContent=text;
}
function paintAll(){
  const keys=new Set(Object.keys(sheet().cells));
  for(const k of painted) if(!keys.has(k)) clearTd(k);
  for(const k of keys) paintCell(k);
  painted=keys;
}

/* ================= Overlay ================= */
const rangeBox=$('#rangeBox'), handle=$('#handle'), ants=$('#ants'), fillPrev=$('#fillPrev'), refLayer=$('#refLayer');
const fills=['#f1','#f2','#f3','#f4'].map(s=>$(s));
function rectOf(r1,c1,r2,c2){ const a=tds[r1][c1], b=tds[r2][c2]; return {x:a.offsetLeft, y:a.offsetTop, w:b.offsetLeft+b.offsetWidth-a.offsetLeft, h:b.offsetTop+b.offsetHeight-a.offsetTop}; }
function place(el,R){ el.style.transform=`translate(${R.x}px,${R.y}px)`; el.style.width=Math.max(0,R.w)+'px'; el.style.height=Math.max(0,R.h)+'px'; el.hidden=false; }
const placeRange = (el,R) => { const b=rectOf(R.r1,R.c1,R.r2,R.c2); place(el,{x:b.x-1,y:b.y-1,w:b.w+1,h:b.h+1}); };
let hiCols=[], hiRows=[];
function drawSel(){
  const R=rng(); const box=rectOf(R.r1,R.c1,R.r2,R.c2);
  place(rangeBox,{x:box.x-1,y:box.y-1,w:box.w+1,h:box.h+1});
  const multi=R.r1!==R.r2||R.c1!==R.c2;
  if(multi){
    const a=rectOf(sel.ar,sel.ac,sel.ar,sel.ac);
    const parts=[{x:box.x,y:box.y,w:box.w,h:a.y-box.y},{x:box.x,y:a.y+a.h,w:box.w,h:box.y+box.h-a.y-a.h},{x:box.x,y:a.y,w:a.x-box.x,h:a.h},{x:a.x+a.w,y:a.y,w:box.x+box.w-a.x-a.w,h:a.h}];
    parts.forEach((p,i)=>{ if(p.w>0&&p.h>0) place(fills[i],p); else fills[i].hidden=true; });
  } else fills.forEach(f=>f.hidden=true);
  handle.style.transform=`translate(${box.x+box.w}px,${box.y+box.h}px)`;
  handle.hidden=!!edit;
  handle.classList.toggle('fill', fillMode);
  hiCols.forEach(th=>th.classList.remove('hs','hf')); hiRows.forEach(th=>th.classList.remove('hs','hf'));
  hiCols=colHeads.slice(R.c1,R.c2+1); hiRows=rowHeads.slice(R.r1,R.r2+1);
  const fullCol=R.r1===0&&R.r2===ROWS-1, fullRow=R.c1===0&&R.c2===COLS-1;
  hiCols.forEach(th=>th.classList.add(fullCol?'hf':'hs')); hiRows.forEach(th=>th.classList.add(fullRow?'hf':'hs'));
  if(clip && clip.si===ST.cur) placeRange(ants,clip); else ants.hidden=true;
}
const REF_COLORS=['#4472C4','#C0504D','#8064A2','#2E9E5B','#E07B1A','#1B9BC6','#B8860B'];
function drawRefs(text){
  refLayer.innerHTML='';
  const refs=refsInFormula(text); const colorOf=new Map(); let ci=0;
  for(const rf of refs){
    if(rf.sheet && rf.sheet.toLowerCase()!==sheet().name.toLowerCase()) continue;
    const R=parseRangeText(rf.a+(rf.b?':'+rf.b:'')); if(!R) continue;
    const key=(rf.sheet||'')+'|'+rf.a.replace(/\$/g,'').toUpperCase()+(rf.b?':'+rf.b.replace(/\$/g,'').toUpperCase():'');
    if(!colorOf.has(key)) colorOf.set(key, REF_COLORS[ci++%REF_COLORS.length]);
    const col=colorOf.get(key); const d=document.createElement('div');
    d.className='ov refbox'; d.style.borderColor=col; d.style.background=col+'1f'; placeRange(d,R); refLayer.appendChild(d);
  }
}
function ensureVisible(r,c){
  const td=tds[r][c]; const hh=view.headings?grid.tHead.offsetHeight:0, hw=view.headings?rowHeads[0].offsetWidth:0;
  const x=td.offsetLeft, y=td.offsetTop, w=td.offsetWidth, h=td.offsetHeight;
  if(y-hh<scroller.scrollTop) scroller.scrollTop=y-hh; else if(y+h>scroller.scrollTop+scroller.clientHeight) scroller.scrollTop=y+h-scroller.clientHeight;
  if(x-hw<scroller.scrollLeft) scroller.scrollLeft=x-hw; else if(x+w>scroller.scrollLeft+scroller.clientWidth) scroller.scrollLeft=x+w-scroller.clientWidth;
}

/* ================= Refresh ================= */
const nameBox=$('#nameBox'), fbar=$('#fbar'), ed=$('#cellEditor');
let traceOn=false;
function changed(){
  cache.clear(); circular.clear();
  paintAll(); applyRowVisibility(); drawSel(); updateStatus(); updateFormulaBar(); updateRibbonState(); save();
}
function onSelChange(){
  sheet().sel={...sel};
  if(traceOn){ traceOn=false; refLayer.innerHTML=''; }
  drawSel(); updateFormulaBar(); updateStatus(); updateRibbonState();
}
function afterStructure(){
  for(const k of painted) clearTd(k); painted=new Set();
  applyColWidths(); renderTabs(); changed();
}
function select(r,c,extend){
  r=clamp(r,0,ROWS-1); c=clamp(c,0,COLS-1);
  if(extend){ sel.fr=r; sel.fc=c; } else sel={ar:r,ac:c,fr:r,fc:c};
  if(fillMode && !extend) fillMode=false;
  onSelChange();
}
function updateFormulaBar(){
  if(document.activeElement!==nameBox) nameBox.value=A(sel.ar,sel.ac);
  if(!edit) fbar.value=editText(sheet().cells[A(sel.ar,sel.ac)]);
  $('#fxOk').disabled=$('#fxCancel').disabled=!edit;
}
function updateStatus(){
  const R=rng(); const st=$('#stats');
  $('#circ').textContent=circular.size ? 'Referencias circulares: '+[...circular][0] : '';
  if(R.r1===R.r2&&R.c1===R.c2){ st.textContent=''; return; }
  let cnt=0, nc=0, s=0;
  for(let r=R.r1;r<=R.r2;r++) for(let c=R.c1;c<=R.c2;c++){ const v=cellValue(ST.cur,r,c); if(v!==null&&v!=='') cnt++; if(typeof v==='number'){ nc++; s+=v; } }
  const cell=sheet().cells[A(sel.ar,sel.ac)]; const style=cell&&cell.s; const af=cell&&cell.v&&cell.v[0]==='='&&!cell.str?autoFmt(cell.v):null;
  const f=x=>display(r15(x),style,af);
  st.textContent = cnt ? (nc ? `Promedio: ${f(s/nc)}    Recuento: ${cnt}    Suma: ${f(s)}` : `Recuento: ${cnt}`) : '';
}
const MODES={ready:'Listo', enter:'Introducir', edit:'Modificar', point:'Señalar'};
function setMode(m){ $('#mode').textContent=MODES[m]; }

/* ================= Editing ================= */
let edit=null;
const measureCtx=document.createElement('canvas').getContext('2d');
function startEdit(text, mode, focusBar){
  if(edit) return;
  hidePop();
  const cell=sheet().cells[A(sel.ar,sel.ac)];
  edit={r:sel.ar, c:sel.ac, si:ST.cur, mode, point:null, pc:null, input:focusBar?fbar:ed};
  ed.value=text; fbar.value=text;
  const s=(cell&&cell.s)||{};
  ed.style.fontWeight=s.b?'700':''; ed.style.fontStyle=s.i?'italic':'';
  ed.style.fontSize=s.size?`calc(${s.size}pt * var(--z))`:'';
  ed.style.fontFamily=s.font?`"${s.font}",var(--cell-font)`:'';
  ed.hidden=false; positionEditor(); handle.hidden=true;
  document.body.classList.add('editing');
  const target=edit.input; target.focus({preventScroll:true});
  const L=text.length; try{ target.setSelectionRange(L,L); }catch(e){}
  updateFormulaBar(); onEditInput(false);
  if(isPhone) requestAnimationFrame(()=>{ if(!edit) return; positionEditor(); ensureVisible(edit.r,edit.c); positionPopups(); });
}
function positionEditor(){
  if(!edit) return;
  const R=rectOf(edit.r,edit.c,edit.r,edit.c);
  ed.style.transform=`translate(${R.x-1}px,${R.y-1}px)`; ed.style.minWidth=(R.w+1)+'px'; ed.style.height=(R.h+1)+'px';
  sizeEditor();
}
function sizeEditor(){
  measureCtx.font=getComputedStyle(ed).font;
  const w=measureCtx.measureText(ed.value).width+16;
  ed.style.width=Math.max(parseFloat(ed.style.minWidth)||0, Math.min(w, 900))+'px';
}
function onEditInput(fromUser){
  if(!edit) return;
  if(fromUser) edit.point=null;
  sizeEditor();
  const t=edit.input.value;
  if(t[0]==='=') drawRefs(t); else refLayer.innerHTML='';
  updateAC(); updateSig();
  setMode(canPoint() ? 'point' : edit.mode);
  updateKbHint();
}
function endEdit(){
  edit=null; ed.hidden=true; ed.blur(); fbar.blur();
  hideAC(); $('#sig').hidden=true; refLayer.innerHTML='';
  document.body.classList.remove('editing'); setMode('ready'); updateFormulaBar(); drawSel();
}
function cancelEdit(){ if(!edit) return; endEdit(); }
const FORMULA_ERR='Hay un problema con esta fórmula. Revisa los paréntesis, los separadores entre argumentos ('+'"'+'SEP'+'"'+') y las referencias de celda.';
function prepareFormula(text){
  text=toCanonFormula(balanceParens(text));
  parseFormula(text.slice(1));
  return shiftFormula(localizeFns(text),0,0);
}
function formulaError(){ toast(FORMULA_ERR.replace('SEP', SEP())); }
function commitEdit(dr=1, dc=0){
  if(!edit) return true;
  let text=edit.input.value;
  if(text[0]==='='){ try{ text=prepareFormula(text); }catch(e){ formulaError(); edit.input.focus(); return false; } }
  const {r,c}=edit; endEdit();
  setRaw(r,c,text);
  if(dr||dc){ select(r+dr, c+dc); ensureVisible(sel.ar,sel.ac); }
  return true;
}
function commitFillSelection(){
  if(!edit) return;
  const R=rng(); const {r,c}=edit;
  const inside = r>=R.r1&&r<=R.r2&&c>=R.c1&&c<=R.c2;
  if(!inside || (R.r1===R.r2&&R.c1===R.c2)) return commitEdit(0,0);
  let text=edit.input.value;
  if(text[0]==='='){ try{ text=prepareFormula(text); }catch(e){ formulaError(); return; } }
  endEdit(); pushUndo();
  for(let rr=R.r1;rr<=R.r2;rr++) for(let cc=R.c1;cc<=R.c2;cc++) writeRaw(rr,cc,shiftFormula(text,rr-r,cc-c));
  changed();
}
/* text: canonical formula, or a constant typed in regional format */
function writeRaw(r,c,text){
  const sh=sheet(), k=A(r,c); let cell=sh.cells[k];
  if(text===''){ if(cell && cell.s && Object.keys(cell.s).length){ cell.v=''; delete cell.str; } else delete sh.cells[k]; return; }
  if(!cell) cell=sh.cells[k]={v:''};
  delete cell.str;
  if(text[0]==='=' || text[0]==="'"){ cell.v=text; return; }
  const fmt=cell.s&&cell.s.fmt;
  const p=parseLiteral(text, fmt, 'local');
  if(typeof p.v==='number'){
    cell.v=String(p.v);
    if(p.fmt && (!fmt || fmt==='general')){ cell.s={...(cell.s||{}), fmt:p.fmt}; if(p.dec!=null && (p.fmt!=='percent' || p.dec>0)) cell.s.dec=p.dec; else delete cell.s.dec; }
  } else if(typeof p.v==='boolean') cell.v=p.v?'VERDADERO':'FALSO';
  else { cell.v=text; if(typeof parseLiteral(text, fmt, 'canon').v!=='string') cell.str=1; }
}
function setRaw(r,c,text){ pushUndo(); writeRaw(r,c,text); changed(); }

const POINT_BEFORE=/[=(,;+\-*\/^&<>:]\s*$/;
function canPoint(){
  if(!edit) return false;
  const inp=edit.input; const t=inp.value; if(t[0]!=='=') return false;
  const s=inp.selectionStart??t.length, e=inp.selectionEnd??s;
  if(edit.point && ((s===e && s===edit.point.end) || (s===edit.point.start && e===edit.point.end))) return true;
  return s===e && POINT_BEFORE.test(t.slice(0,s));
}
function setEditText(t, caret){
  ed.value=t; fbar.value=t;
  const inp=edit.input; inp.focus({preventScroll:true}); try{ inp.setSelectionRange(caret,caret); }catch(e){}
}
function insertRef(refText){
  const inp=edit.input; const t=inp.value;
  const s=inp.selectionStart??t.length, e=inp.selectionEnd??s;
  let start=s, end=e;
  if(edit.point && ((s===e && s===edit.point.end) || (s===edit.point.start && e===edit.point.end))){ start=edit.point.start; end=edit.point.end; }
  const nt=t.slice(0,start)+refText+t.slice(end); const ne=start+refText.length;
  setEditText(nt, ne); edit.point={start, end:ne}; onEditInput(false);
}
function insertText(s){
  if(!edit) return;
  const inp=edit.input; const t=inp.value;
  const a=inp.selectionStart??t.length, b=inp.selectionEnd??a;
  setEditText(t.slice(0,a)+s+t.slice(b), a+s.length); onEditInput(true);
}
function pointArrow(dr,dc){
  if(!edit.point || !edit.pc) edit.pc={r:edit.r, c:edit.c};
  edit.pc={r:clamp(edit.pc.r+dr,0,ROWS-1), c:clamp(edit.pc.c+dc,0,COLS-1)};
  insertRef(A(edit.pc.r,edit.pc.c)); ensureVisible(edit.pc.r,edit.pc.c);
}
function cycleAbs(){
  const inp=edit.input; const t=inp.value; const caret=inp.selectionStart??t.length;
  const ref=refsInFormula(t).find(x=>caret>=x.start&&caret<=x.end); if(!ref) return;
  const seg=t.slice(ref.start, ref.end); const bang=seg.lastIndexOf('!');
  const head=seg.slice(0,bang+1), body=seg.slice(bang+1);
  const m=/^(\$?)[A-Za-z]{1,3}(\$?)\d+/.exec(body); const ca=!!m[1], ra=!!m[2];
  const [nc,nr] = (!ca&&!ra)?[true,true] : (ca&&ra)?[false,true] : (!ca&&ra)?[true,false] : [false,false];
  const nb=body.replace(/\$?([A-Za-z]{1,3})\$?(\d+)/g,(x,col,row)=>(nc?'$':'')+col.toUpperCase()+(nr?'$':'')+row);
  const nt=t.slice(0,ref.start)+head+nb+t.slice(ref.end);
  setEditText(nt, ref.start+head.length+nb.length); edit.point=null; onEditInput(false);
}

/* autocomplete + argument tooltip */
const acEl=$('#ac'), acList=$('#acList'), acDesc=$('#acDesc'), sigEl=$('#sig');
let acItems=[], acIdx=0, acNav=false, acStart=0;
function inString(s){ let q=false; for(const ch of s) if(ch==='"') q=!q; return q; }
function anchorRect(){ return edit.input===ed ? ed.getBoundingClientRect() : fbar.getBoundingClientRect(); }
function updateAC(){
  const inp=edit && edit.input; if(!inp || inp.value[0]!=='='){ hideAC(); return; }
  const caret=inp.selectionStart??inp.value.length; const before=inp.value.slice(0,caret);
  if(inString(before)){ hideAC(); return; }
  const m=/(^=|[(,;+\-*\/^&<>:\s=])([A-Za-z_\u00C0-\u024F][A-Za-z0-9_.\u00C0-\u024F]*)$/.exec(before);
  if(!m){ hideAC(); return; }
  const pre=m[2].toUpperCase();
  acItems=AC_LIST.filter(x=>x.name.startsWith(pre)).slice(0,14);
  if(!acItems.length || (acItems.length===1 && acItems[0].name===pre && inp.value[caret]==='(')){ hideAC(); return; }
  acIdx=0; acNav=false; acStart=caret-m[2].length;
  renderAC(); acEl.hidden=false; positionPopups();
}
function renderAC(){
  acList.innerHTML=acItems.map((x,i)=>`<div class="aci${i===acIdx?' on':''}" data-i="${i}" role="option"><span class="ms">function</span><span>${esc(x.name)}</span>${x.en?`<small>en inglés · ${esc(x.f.es)}</small>`:''}</div>`).join('');
  const it=acItems[acIdx]; acDesc.textContent=it ? it.f.desc : '';
  const on=acList.children[acIdx]; if(on) on.scrollIntoView({block:'nearest'});
}
function hideAC(){ acEl.hidden=true; acItems=[]; }
function acceptAC(i){
  const it=acItems[i]; if(!it) return;
  const inp=edit.input; const t=inp.value; const caret=inp.selectionStart??t.length;
  const after=t.slice(caret); const add=after[0]==='(' ? '' : '(';
  const nm=it.f.es||it.f.name;
  const nt=t.slice(0,acStart)+nm+add+after; const pos=acStart+nm.length+1;
  hideAC(); setEditText(nt,pos); onEditInput(true); hideAC();
}
acList.addEventListener('mousedown', e=>e.preventDefault());
acList.addEventListener('click', e=>{ const d=e.target.closest('.aci'); if(d) acceptAC(+d.dataset.i); });
function updateSig(){
  const inp=edit && edit.input; if(!inp || inp.value[0]!=='='){ sigEl.hidden=true; return; }
  const before=inp.value.slice(0, inp.selectionStart??inp.value.length);
  const stack=[]; let q=false;
  for(let i=1;i<before.length;i++){
    const ch=before[i];
    if(ch==='"'){ q=!q; continue; } if(q) continue;
    if(ch==='('){ const m=/([A-Za-z_\u00C0-\u024F][A-Za-z0-9_.\u00C0-\u024F]*)\s*$/.exec(before.slice(0,i)); stack.push({name:m?m[1]:null, arg:0}); }
    else if(ch===')') stack.pop();
    else if((ch===';' || (ch===',' && !(ST.DEC===',' && /\d/.test(before[i-1]||'') && /\d/.test(before[i+1]||'')))) && stack.length) stack[stack.length-1].arg++;
  }
  let top=null; for(let i=stack.length-1;i>=0;i--){ if(stack[i].name && resolveFn(stack[i].name)){ top=stack[i]; break; } }
  if(!top){ sigEl.hidden=true; return; }
  const f=FN[resolveFn(top.name)]; const parts=f.args ? f.args.split(', ') : [];
  let idx=top.arg; if(parts.length && parts[parts.length-1]==='...' && idx>=parts.length-2) idx=parts.length-2;
  sigEl.innerHTML=`<b>${esc(top.name.toUpperCase())}</b>(${parts.map((p,i)=>i===idx?`<span class="cur">${esc(p)}</span>`:esc(p)).join(esc(SEP())+' ')})`;
  sigEl.hidden=false; positionPopups();
}
function positionPopups(){
  if(!edit) return;
  const r=anchorRect(); let y=r.bottom+2; const x=Math.max(8, Math.min(r.left, innerWidth-270));
  if(!sigEl.hidden){ sigEl.style.left=x+'px'; sigEl.style.top=y+'px'; y+=sigEl.offsetHeight+2; }
  if(!acEl.hidden){
    acEl.style.left=x+'px';
    const h=acEl.offsetHeight||200;
    const kbr=$('#kb').getBoundingClientRect(); const limit=kbr.height ? kbr.top : innerHeight;
    acEl.style.top=(y+h>limit-8 ? Math.max(8, r.top-h-2) : y)+'px';
  }
}

ed.addEventListener('input', ()=>{ fbar.value=ed.value; onEditInput(true); });
fbar.addEventListener('input', ()=>{ if(!edit) return; ed.value=fbar.value; onEditInput(true); });
fbar.addEventListener('focus', ()=>{ if(!edit) startEdit(editText(sheet().cells[A(sel.ar,sel.ac)]),'edit',true); else edit.input=fbar; });
ed.addEventListener('focus', ()=>{ if(edit) edit.input=ed; });
const NAV_KEYS=['ArrowUp','ArrowDown','Enter','Tab','Escape'];
['click','keyup'].forEach(ev=>[ed,fbar].forEach(el=>el.addEventListener(ev, e=>{ if(edit && !NAV_KEYS.includes(e.key)){ updateAC(); updateSig(); setMode(canPoint()?'point':edit.mode); } })));
$('#fxOk').addEventListener('click', ()=>commitEdit(0,0));
$('#fxCancel').addEventListener('click', cancelEdit);
['#fxOk','#fxCancel','#fxBtn'].forEach(s=>$(s).addEventListener('mousedown', e=>e.preventDefault()));
$('#fxBtn').addEventListener('click', ()=>openFnDialog());

function editKey(e){
  const k=e.key;
  if(!acEl.hidden && acItems.length){
    if(k==='ArrowDown'){ e.preventDefault(); acIdx=(acIdx+1)%acItems.length; acNav=true; renderAC(); return; }
    if(k==='ArrowUp'){ e.preventDefault(); acIdx=(acIdx-1+acItems.length)%acItems.length; acNav=true; renderAC(); return; }
    if(k==='Tab' || (k==='Enter' && acNav)){ e.preventDefault(); acceptAC(acIdx); return; }
    if(k==='Escape'){ e.preventDefault(); hideAC(); return; }
  }
  if(k==='Enter'){ e.preventDefault(); if(e.ctrlKey||e.metaKey) commitFillSelection(); else commitEdit(e.shiftKey?-1:1,0); return; }
  if(k==='Tab'){ e.preventDefault(); commitEdit(0,e.shiftKey?-1:1); return; }
  if(k==='Escape'){ e.preventDefault(); cancelEdit(); return; }
  if(k==='F2'){ e.preventDefault(); edit.mode=edit.mode==='edit'?'enter':'edit'; onEditInput(false); return; }
  if(k==='F4'){ e.preventDefault(); cycleAbs(); return; }
  const dirs={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};
  if(dirs[k] && edit.mode==='enter' && edit.input===ed && !e.shiftKey){
    e.preventDefault();
    if(canPoint()) pointArrow(...dirs[k]); else commitEdit(...dirs[k]);
  }
}

/* ================= Clipboard, fill, sort ================= */
let clip=null, lastClipText='', fillMode=false, painter=null;
const cloneCell = cell => JSON.parse(JSON.stringify(cell));
function copySel(cut){
  const R=rng(); const sh=sheet(); const cells=[], vals=[], lines=[];
  for(let r=R.r1;r<=R.r2;r++){
    const row=[], vrow=[], line=[];
    for(let c=R.c1;c<=R.c2;c++){
      const cell=sh.cells[A(r,c)]; row.push(cell?cloneCell(cell):null);
      const v=cellValue(ST.cur,r,c); vrow.push(v); line.push(cell ? display(v, cell.s, cell.v&&cell.v[0]==='='&&!cell.str?autoFmt(cell.v):null) : '');
    }
    cells.push(row); vals.push(vrow); lines.push(line.join('\t'));
  }
  clip={si:ST.cur, ...R, cells, vals, cut};
  lastClipText=lines.join('\n'); drawSel();
  return lastClipText;
}
function pasteClip(mode){
  if(!clip) return toast('Primero copia o corta algunas celdas.');
  pushUndo(); const sh=sheet(); const dr=sel.ar-clip.r1, dc=sel.ac-clip.c1;
  const src=ST.wb.sheets[clip.si];
  if(clip.cut) for(let r=clip.r1;r<=clip.r2;r++) for(let c=clip.c1;c<=clip.c2;c++) delete src.cells[A(r,c)];
  clip.cells.forEach((row,i)=>row.forEach((cell,j)=>{
    const r=sel.ar+i, c=sel.ac+j; if(r>=ROWS||c>=COLS) return; const k=A(r,c);
    if(mode==='formats'){ const t=sh.cells[k]||(sh.cells[k]={v:''}); if(cell&&cell.s) t.s={...cell.s}; else delete t.s; if(!t.v&&!t.s) delete sh.cells[k]; return; }
    if(!cell){ delete sh.cells[k]; return; }
    const out=cloneCell(cell);
    if(mode==='values'){
      const x=clip.vals[i][j]; delete out.str;
      if(x===null) out.v=''; else if(typeof x==='number') out.v=String(x); else if(typeof x==='boolean') out.v=boolText(x);
      else { out.v = isErr(x) ? errText(x.e) : x; if(out.v[0]==='=' || typeof parseLiteral(out.v,null,'canon').v!=='string') out.str=1; }
    } else if(!clip.cut && !cell.str) out.v=shiftFormula(cell.v, dr, dc);
    sh.cells[k]=out;
  }));
  sel={ar:sel.ar, ac:sel.ac, fr:Math.min(ROWS-1,sel.ar+clip.cells.length-1), fc:Math.min(COLS-1,sel.ac+clip.cells[0].length-1)};
  if(clip.cut) clip=null;
  sheet().sel={...sel}; compact(); changed();
}
function pasteText(text){
  const rows=text.replace(/\r/g,'').replace(/\n$/,'').split('\n').map(l=>l.split('\t'));
  pushUndo();
  rows.forEach((row,i)=>row.forEach((v,j)=>{ const r=sel.ar+i, c=sel.ac+j; if(r>=ROWS||c>=COLS) return;
    if(v[0]==='='){ try{ v=prepareFormula(v); }catch(e){ v="'"+v; } }
    writeRaw(r,c,v); }));
  sel={ar:sel.ar, ac:sel.ac, fr:Math.min(ROWS-1,sel.ar+rows.length-1), fc:Math.min(COLS-1,sel.ac+rows[0].length-1)};
  changed();
}
function copyCell(sr,scc,tr,tc){
  const sh=sheet(); const src=sh.cells[A(sr,scc)]; const k=A(tr,tc);
  if(!src){ delete sh.cells[k]; return; }
  const out=cloneCell(src); if(!src.str) out.v=shiftFormula(src.v, tr-sr, tc-scc); sh.cells[k]=out;
}
function fillDir(dir){
  const R=rng(); pushUndo();
  if(dir==='down'||dir==='up'){
    const one=R.r1===R.r2; const src= dir==='down' ? (one?R.r1-1:R.r1) : (one?R.r1+1:R.r2); if(src<0||src>=ROWS) return;
    for(let c=R.c1;c<=R.c2;c++) for(let r=R.r1;r<=R.r2;r++) if(r!==src) copyCell(src,c,r,c);
  } else {
    const one=R.c1===R.c2; const src= dir==='right' ? (one?R.c1-1:R.c1) : (one?R.c1+1:R.c2); if(src<0||src>=COLS) return;
    for(let r=R.r1;r<=R.r2;r++) for(let c=R.c1;c<=R.c2;c++) if(c!==src) copyCell(r,src,r,c);
  }
  changed();
}
function doFill(R, dir, n){
  if(n<=0) return;
  pushUndo(); const sh=sheet(); const vertical=dir==='down'||dir==='up';
  const len = vertical ? R.r2-R.r1+1 : R.c2-R.c1+1;
  const lines=[]; if(vertical) for(let c=R.c1;c<=R.c2;c++) lines.push(c); else for(let r=R.r1;r<=R.r2;r++) lines.push(r);
  for(const L of lines){
    const src=[]; for(let i=0;i<len;i++){ const [r,c]=vertical?[R.r1+i,L]:[L,R.c1+i]; src.push({r,c,cell:sh.cells[A(r,c)]}); }
    const vals=src.map(x=>x.cell && x.cell.v && x.cell.v[0]!=='=' && !x.cell.str ? parseLiteral(x.cell.v, x.cell.s&&x.cell.s.fmt, 'canon').v : undefined);
    const series = len>=2 && vals.every(v=>typeof v==='number');
    const step = series ? (vals[len-1]-vals[0])/(len-1) : 0;
    for(let i=1;i<=n;i++){
      let tr, tc, si;
      if(dir==='down'){ tr=R.r2+i; tc=L; si=(i-1)%len; }
      else if(dir==='up'){ tr=R.r1-i; tc=L; si=len-1-((i-1)%len); }
      else if(dir==='right'){ tr=L; tc=R.c2+i; si=(i-1)%len; }
      else { tr=L; tc=R.c1-i; si=len-1-((i-1)%len); }
      if(tr<0||tc<0||tr>=ROWS||tc>=COLS) continue;
      const s=src[si];
      if(series){ const val=(dir==='down'||dir==='right') ? vals[len-1]+step*i : vals[0]-step*i; sh.cells[A(tr,tc)]={v:String(r15(val))}; if(s.cell.s) sh.cells[A(tr,tc)].s={...s.cell.s}; }
      else copyCell(s.r,s.c,tr,tc);
    }
  }
  if(dir==='down') sel={ar:R.r1,ac:R.c1,fr:Math.min(ROWS-1,R.r2+n),fc:R.c2};
  else if(dir==='up') sel={ar:R.r2,ac:R.c1,fr:Math.max(0,R.r1-n),fc:R.c2};
  else if(dir==='right') sel={ar:R.r1,ac:R.c1,fr:R.r2,fc:Math.min(COLS-1,R.c2+n)};
  else sel={ar:R.r1,ac:R.c2,fr:R.r2,fc:Math.max(0,R.c1-n)};
  sheet().sel={...sel}; changed();
}
function region(r,c){
  const R={r1:r,r2:r,c1:c,c2:c};
  const rowHas=(rr,c1,c2)=>{ for(let x=Math.max(0,c1);x<=Math.min(COLS-1,c2);x++) if(hasContent(rr,x)) return true; return false; };
  const colHas=(cc,r1,r2)=>{ for(let y=Math.max(0,r1);y<=Math.min(ROWS-1,r2);y++) if(hasContent(y,cc)) return true; return false; };
  let grew=true;
  while(grew){ grew=false;
    if(R.r1>0 && rowHas(R.r1-1,R.c1-1,R.c2+1)){ R.r1--; grew=true; }
    if(R.r2<ROWS-1 && rowHas(R.r2+1,R.c1-1,R.c2+1)){ R.r2++; grew=true; }
    if(R.c1>0 && colHas(R.c1-1,R.r1-1,R.r2+1)){ R.c1--; grew=true; }
    if(R.c2<COLS-1 && colHas(R.c2+1,R.r1-1,R.r2+1)){ R.c2++; grew=true; }
  }
  return R;
}
function sortSel(desc){
  let R=rng(); if(R.r1===R.r2&&R.c1===R.c2) R=region(sel.ar,sel.ac);
  if(R.r1===R.r2) return toast('Selecciona al menos dos filas para ordenar.');
  const sh=sheet();
  const head=[]; for(let c=R.c1;c<=R.c2;c++) head.push(sh.cells[A(R.r1,c)]);
  const allText=head.every(cell=>!cell || (cell.v[0]!=='=' && typeof storedValue(cell)!=='number'));
  const hdr=allText && (head.some(cell=>cell&&cell.s&&cell.s.b) || typeof cellValue(ST.cur,R.r1+1,sel.ac)!=='string');
  const start=hdr?R.r1+1:R.r1; const key=clamp(sel.ac,R.c1,R.c2);
  const rows=[];
  for(let r=start;r<=R.r2;r++){ const cells=[]; for(let c=R.c1;c<=R.c2;c++) cells.push(sh.cells[A(r,c)]||null); rows.push({r,cells,v:cellValue(ST.cur,r,key)}); }
  rows.sort((a,b)=>{ const ea=a.v===null||a.v==='', eb=b.v===null||b.v===''; if(ea&&eb) return 0; if(ea) return 1; if(eb) return -1; const x=cmp(a.v,b.v); return desc?-x:x; });
  pushUndo();
  rows.forEach((row,i)=>{ const tr=start+i; row.cells.forEach((cell,j)=>{ const k=A(tr,R.c1+j); if(!cell) delete sh.cells[k]; else { const out=cloneCell(cell); if(!cell.str) out.v=shiftFormula(cell.v,tr-row.r,0); sh.cells[k]=out; } }); });
  changed();
}

/* ================= Formatting ================= */
const activeStyle = () => { const cell=sheet().cells[A(sel.ar,sel.ac)]; return (cell&&cell.s)||{}; };
function eachSel(fn){ const R=rng(); for(let r=R.r1;r<=R.r2;r++) for(let c=R.c1;c<=R.c2;c++) fn(r,c,R); }
function styleOf(r,c){ const sh=sheet(), k=A(r,c); const cell=sh.cells[k]||(sh.cells[k]={v:''}); return cell.s||(cell.s={}); }
function compact(){ const sh=sheet(); for(const k in sh.cells){ const cell=sh.cells[k]; if(cell.s && !Object.keys(cell.s).length) delete cell.s; if((cell.v==null||cell.v==='') && !cell.s) delete sh.cells[k]; } }
function setStyle(prop, val){ pushUndo(); eachSel((r,c)=>{ const s=styleOf(r,c); if(val==null||val===false) delete s[prop]; else s[prop]=val; }); compact(); changed(); }
const toggleStyle = prop => setStyle(prop, activeStyle()[prop] ? null : true);
const toggleVal = (prop,val) => setStyle(prop, activeStyle()[prop]===val ? null : val);
function borders(kind){
  pushUndo();
  eachSel((r,c,R)=>{ const s=styleOf(r,c);
    if(kind==='none'){ delete s.bt; delete s.bb; delete s.bl; delete s.br; }
    if(kind==='all'){ if(r===R.r1) s.bt=1; if(c===R.c1) s.bl=1; s.bb=1; s.br=1; }
    if(kind==='out'){ if(r===R.r1) s.bt=1; if(r===R.r2) s.bb=1; if(c===R.c1) s.bl=1; if(c===R.c2) s.br=1; }
    if(kind==='bottom' && r===R.r2) s.bb=1; if(kind==='top' && r===R.r1) s.bt=1;
    if(kind==='left' && c===R.c1) s.bl=1; if(kind==='right' && c===R.c2) s.br=1;
  });
  compact(); changed();
}
function shownDecimals(){ const cell=sheet().cells[A(sel.ar,sel.ac)]; if(!cell) return 0; const t=display(cellValue(ST.cur,sel.ar,sel.ac), cell.s, cell.v&&cell.v[0]==='='&&!cell.str?autoFmt(cell.v):null); const m=new RegExp('\\'+ST.DEC+'(\\d+)').exec(t); return m?m[1].length:0; }
const SIZES=[8,9,10,10.5,11,12,14,16,18,20,22,24,26,28,36,48,72];
function bumpFont(dir){ const s=activeStyle().size||11; const next = dir>0 ? SIZES.find(x=>x>s)||s : [...SIZES].reverse().find(x=>x<s)||s; setStyle('size', next===11?null:next); }
const CELL_STYLES={
  Normal:{}, Bueno:{fill:'#C6EFCE',color:'#006100'}, Incorrecto:{fill:'#FFC7CE',color:'#9C0006'}, Neutral:{fill:'#FFEB9C',color:'#9C5700'},
  'Cálculo':{fill:'#F2F2F2',color:'#FA7D00',b:true,bt:1,bb:1,bl:1,br:1}, Entrada:{fill:'#FFCC99',color:'#3F3F76',bt:1,bb:1,bl:1,br:1},
  Nota:{fill:'#FFFFCC',bt:1,bb:1,bl:1,br:1}, 'Título':{size:18,color:'#0E2841'}, 'Encabezado 1':{b:true,size:15,color:'#0E2841',bb:1}, Total:{b:true,bt:1,bb:1}
};
function cellStyle(name){
  pushUndo();
  eachSel((r,c)=>{ const s=styleOf(r,c); const keep=s.fmt, dec=s.dec; for(const k of Object.keys(s)) delete s[k]; if(keep) s.fmt=keep; if(dec!=null) s.dec=dec; Object.assign(s, CELL_STYLES[name]); });
  compact(); changed();
}
function formatAsTable(){
  let R=rng(); if(R.r1===R.r2&&R.c1===R.c2) R=region(sel.ar,sel.ac);
  pushUndo();
  for(let r=R.r1;r<=R.r2;r++) for(let c=R.c1;c<=R.c2;c++){
    const s=styleOf(r,c);
    if(r===R.r1) Object.assign(s,{b:true,fill:'#156082',color:'#FFFFFF'});
    else { delete s.color; if((r-R.r1)%2===1) s.fill='#C0E4F5'; else delete s.fill; }
    if(r===R.r2) s.bb=1;
  }
  sel={ar:R.r1,ac:R.c1,fr:R.r2,fc:R.c2}; compact(); changed();
}
function autofit(){
  const R=rng(); pushUndo();
  for(let c=R.c1;c<=R.c2;c++){
    let w=0;
    for(let r=0;r<ROWS;r++){
      if(!hasContent(r,c)) continue; const td=tds[r][c]; const cs=getComputedStyle(td);
      measureCtx.font=`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      w=Math.max(w, measureCtx.measureText(td.textContent).width/(zoom/100));
    }
    if(w) sheet().colW[c]=Math.ceil(w+12);
  }
  afterStructure();
}
function applyPainter(){ if(!painter) return; const st=painter; painter=null; document.body.classList.remove('painting'); pushUndo(); eachSel((r,c)=>{ const cell=sheet().cells[A(r,c)]||(sheet().cells[A(r,c)]={v:''}); cell.s={...st}; }); compact(); changed(); }

/* ================= Actions ================= */
let lastFill='#FFFF00', lastFont='#C00000';
function autosum(fnKey){
  const nm=esName(fnKey||'SUM');
  if(edit){ insertText(nm+'('); return; }
  const {ar:r, ac:c}=sel; const isNum=(y,x)=>typeof cellValue(ST.cur,y,x)==='number';
  let range=null;
  if(r>0 && isNum(r-1,c)){ let r1=r-1; while(r1>0 && isNum(r1-1,c)) r1--; range=A(r1,c)+':'+A(r-1,c); }
  else if(c>0 && isNum(r,c-1)){ let c1=c-1; while(c1>0 && isNum(r,c1-1)) c1--; range=A(r,c1)+':'+A(r,c-1); }
  const text='='+nm+'('+(range||'')+')';
  startEdit(text,'enter');
  const st=nm.length+2;
  if(range){ edit.point={start:st,end:st+range.length}; try{ ed.setSelectionRange(st, st+range.length); }catch(e){} }
  else try{ ed.setSelectionRange(st,st); }catch(e){}
  onEditInput(false);
}
function insertFunction(key){
  closeFnDialog();
  recentFns=[key, ...recentFns.filter(x=>x!==key)].slice(0,10);
  const nm=esName(key);
  if(edit){ if(edit.input.value==='') insertText('='+nm+'('); else insertText(nm+'('); }
  else startEdit('='+nm+'(','enter');
}
function setZoom(z){
  zoom=clamp(Math.round(z),10,400);
  document.documentElement.style.setProperty('--z', zoom/100);
  $('#zoomLbl').textContent=zoom+'%'; $('#zoomRange').value=zoom;
  requestAnimationFrame(()=>{ drawSel(); if(edit){ positionEditor(); drawRefs(edit.input.value); } else if(traceOn) traceActive(); });
  prefs[isPhone?'zoomPhone':'zoomDesk']=zoom; savePrefs();
}
function traceActive(){ const cell=sheet().cells[A(sel.ar,sel.ac)]; if(!cell||!cell.v||cell.v[0]!=='='||cell.str) return toast('Selecciona una celda que contenga una fórmula.'); traceOn=true; drawRefs(cell.v); }
function toggleView(key){
  view[key]=!view[key];
  grid.classList.toggle('nogrid', !view.gridlines); grid.classList.toggle('nohead', !view.headings);
  $('#fbarRow').hidden=!view.formulaBar;
  applyColWidths(); drawSel(); updateRibbonState(); save();
}
function setSkin(s){
  prefs.skin=s; savePrefs(); document.documentElement.dataset.skin=s;
  $('#skinLbl').textContent='Tema: '+(s==='white'?'Blanco':'Excel');
  requestAnimationFrame(drawSel);
}
function setRegion(r){
  prefs.region=r; savePrefs(); applyRegion();
  $('#sepKey').textContent=SEP();
  renderRibbon(); changed();
}
function addSheet(){ let n=ST.wb.sheets.length+1; while(sheetIndex('Hoja'+n)>=0) n++; pushUndo(); sheet().sel={...sel}; ST.wb.sheets.push(blankSheet('Hoja'+n)); ST.cur=ST.wb.sheets.length-1; sel={ar:0,ac:0,fr:0,fc:0}; afterStructure(); }
function deleteSheet(i=ST.cur){ if(ST.wb.sheets.length<2) return toast('Un libro debe contener al menos una hoja.'); pushUndo(); const name=ST.wb.sheets[i].name; ST.wb.sheets.splice(i,1); ST.cur=clamp(ST.cur>=i?ST.cur-1:ST.cur,0,ST.wb.sheets.length-1); sel={...(sheet().sel||{ar:0,ac:0,fr:0,fc:0})}; afterStructure(); toast(`Se eliminó "${name}". Presiona Ctrl+Z para deshacer.`); }
function dupSheet(i=ST.cur){ pushUndo(); const s=JSON.parse(JSON.stringify(ST.wb.sheets[i])); const base=s.name+' ('; let n=2; while(sheetIndex(base+n+')')>=0) n++; s.name=base+n+')'; ST.wb.sheets.splice(i+1,0,s); ST.cur=i+1; sel={...s.sel}; afterStructure(); }
const quoteName = n => /^[A-Za-z_\u00C0-\u024F][A-Za-z0-9_.\u00C0-\u024F]*$/.test(n) && !/^[A-Za-z]{1,3}\d+$/.test(n) ? n : `'${n.replace(/'/g,"''")}'`;
function renameSheet(i, name){
  name=name.trim(); const old=ST.wb.sheets[i].name; if(!name||name===old) return;
  if(/[\\\/?*\[\]:]/.test(name) || name.length>31) return toast('El nombre de la hoja no puede contener \\ / ? * [ ] : y debe tener 31 caracteres o menos.');
  const j=sheetIndex(name); if(j>=0 && j!==i) return toast('Ese nombre ya está en uso. Prueba con otro.');
  pushUndo();
  const q=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re=new RegExp(`(?<![A-Za-z0-9_.\\u00C0-\\u024F])(?:'${q(old.replace(/'/g,"''"))}'|${q(old)})!`,'gi');
  for(const sh of ST.wb.sheets) for(const k in sh.cells){ const cell=sh.cells[k]; if(cell.v && cell.v[0]==='=' && !cell.str) cell.v=cell.v.split(/("(?:[^"]|"")*")/).map((seg,ix)=>ix%2?seg:seg.replace(re, quoteName(name)+'!')).join(''); }
  ST.wb.sheets[i].name=name; astCache.clear(); renderTabs(); changed();
}
function newWorkbook(sample){
  pushUndo(); const w=sample?sampleWorkbook():{name:'Libro1', sheets:[blankSheet('Hoja1')]};
  ST.wb.sheets=w.sheets; ST.cur=0; sel={ar:0,ac:0,fr:0,fc:0}; clip=null; closeBackstage(); afterStructure();
  toast(sample ? 'Se cargó el libro de práctica. Ctrl+Z recupera el libro anterior.' : 'Libro en blanco nuevo. Ctrl+Z recupera el libro anterior.');
}
function wbStats(){ let cells=0, f=0; for(const sh of ST.wb.sheets) for(const k in sh.cells){ const v=sh.cells[k].v; if(v){ cells++; if(v[0]==='=') f++; } } toast(`${ST.wb.sheets.length} hojas · ${cells} celdas con datos · ${f} fórmulas`); }
function clearCells(what){
  pushUndo(); const sh=sheet();
  eachSel((r,c)=>{ const k=A(r,c); const cell=sh.cells[k]; if(!cell) return;
    if(what==='all') delete sh.cells[k]; else if(what==='formats') delete cell.s; else { cell.v=''; delete cell.str; } });
  compact(); changed();
}

/* Filter (worked example in GUIA-DESARROLLO.md): keeps the header row of the current
   region and hides every row whose value in the active column differs from the active cell. */
function filterToggle(){
  const sh=sheet();
  if((sh.hiddenRows||[]).length) return filterClear();
  const R=region(sel.ar, sel.ac);
  if(R.r1===R.r2) return toast('Selecciona una celda dentro de una tabla con datos.');
  if(sel.ar===R.r1) return toast('Selecciona una celda con datos (no el encabezado) para filtrar por ese valor.');
  const target=cellValue(ST.cur, sel.ar, sel.ac);
  pushUndo();
  sh.hiddenRows=[];
  for(let r=R.r1+1; r<=R.r2; r++) if(cmp(cellValue(ST.cur, r, sel.ac), target)!==0) sh.hiddenRows.push(r);
  changed();
  toast(`Filtro aplicado: se muestran solo las filas con "${display(target)}". Se ocultaron ${sh.hiddenRows.length} filas.`);
}
function filterClear(){
  const sh=sheet();
  if(!(sh.hiddenRows||[]).length) return toast('No hay ningún filtro aplicado.');
  pushUndo(); sh.hiddenRows=[]; changed(); toast('Se quitó el filtro.');
}
function devCounts(){
  let total=0, done=0;
  const visit=it=>{ if(Array.isArray(it)) return it.forEach(visit); if(!it || it.k==='sel') return; total++; if(it.a && ACTIONS[it.a]) done++; };
  RIBBON.forEach(t=>t.groups.forEach(g=>g.cols.forEach(visit)));
  return {total, done};
}

const EDIT_SAFE=new Set(['fn','insertFn','autosum','undo','redo','save','ribbonToggle','zoomTo','zoom100','toggleView','toggleSkin','bold','italic','underline','strike','fillColor','fontColor','setFill','setFont']);
const ACTIONS={
  undo, redo,
  save:()=>{ const was=autosave; autosave=true; save(); autosave=was; toast('Guardado en este navegador.'); },
  cut:()=>{ copySel(true); clipToSystem(); },
  copy:()=>{ copySel(false); clipToSystem(); },
  paste:()=>pasteClip(), pasteValues:()=>pasteClip('values'), pasteFormats:()=>pasteClip('formats'),
  painter:()=>{ painter={...activeStyle()}; document.body.classList.add('painting'); toast('Selecciona las celdas a las que quieres copiar el formato.'); },
  bold:()=>toggleStyle('b'), italic:()=>toggleStyle('i'), underline:()=>toggleStyle('u'), strike:()=>toggleStyle('st'),
  fontUp:()=>bumpFont(1), fontDown:()=>bumpFont(-1),
  fillColor:()=>setStyle('fill', lastFill), fontColor:()=>setStyle('color', lastFont),
  setFill:c=>{ if(c) lastFill=c; setStyle('fill', c); }, setFont:c=>{ if(c) lastFont=c; setStyle('color', c); },
  alignL:()=>toggleVal('ha','left'), alignC:()=>toggleVal('ha','center'), alignR:()=>toggleVal('ha','right'),
  vTop:()=>toggleVal('va','top'), vMid:()=>toggleVal('va','middle'), vBot:()=>toggleVal('va','bottom'),
  wrap:()=>toggleStyle('wrap'),
  indInc:()=>setStyle('ind', Math.min(15,(activeStyle().ind||0)+1)), indDec:()=>setStyle('ind', Math.max(0,(activeStyle().ind||0)-1)||null),
  fmtCurrency:()=>setStyle('fmt','accounting'), fmtPercent:()=>setStyle('fmt','percent'), fmtComma:()=>setStyle('fmt','comma'), fmtDollar:()=>setStyle('fmt','currency'),
  decInc:()=>setStyle('dec', Math.min(15, shownDecimals()+1)), decDec:()=>setStyle('dec', Math.max(0, shownDecimals()-1)),
  bBottom:()=>borders('bottom'), bTop:()=>borders('top'), bLeft:()=>borders('left'), bRight:()=>borders('right'), bNone:()=>borders('none'), bAll:()=>borders('all'), bOut:()=>borders('out'),
  cellStyle, fmtTable:formatAsTable, autofit,
  autosum, fn:insertFunction, insertFn:()=>openFnDialog(),
  fillDown:()=>fillDir('down'), fillRight:()=>fillDir('right'), fillUp:()=>fillDir('up'), fillLeft:()=>fillDir('left'),
  fillHandle:()=>{ fillMode=true; drawSel(); toast('Arrastra el controlador redondo para rellenar las celdas siguientes.'); },
  clearAll:()=>clearCells('all'), clearFormats:()=>clearCells('formats'), clearContents:()=>clearCells('contents'),
  sortAsc:()=>sortSel(false), sortDesc:()=>sortSel(true),
  goto:()=>{ nameBox.focus(); nameBox.select(); },
  showFormulas:()=>{ showFormulas=!showFormulas; changed(); },
  calcNow:()=>{ changed(); toast('Libro recalculado.'); },
  tracePrec:traceActive, removeArrows:()=>{ traceOn=false; refLayer.innerHTML=''; },
  toggleView, viewNormal:()=>{},
  zoom100:()=>setZoom(100), zoomTo:z=>setZoom(+z),
  zoomSel:()=>{ const R=rng(); const b=rectOf(R.r1,R.c1,R.r2,R.c2); const z=zoom/100; setZoom(Math.min((scroller.clientWidth-60)/(b.w/z), (scroller.clientHeight-40)/(b.h/z))*100); requestAnimationFrame(()=>ensureVisible(R.r1,R.c1)); },
  addSheet, deleteSheet:()=>deleteSheet(), dupSheet:()=>dupSheet(), renameSheet:()=>startRename(ST.cur),
  wbStats, ribbonToggle:()=>{ $('#ribbon').classList.toggle('collapsed'); requestAnimationFrame(drawSel); },
  filterToggle, filterClear,
  goSheet:i=>switchSheet(+i),
  devGuide:()=>openBackstage('dev'),
  toggleSkin:()=>{ setSkin(prefs.skin==='white'?'excel':'white'); toast(prefs.skin==='white'?'Tema Blanco activado.':'Tema Excel activado.'); },
};
function run(a, label, arg){
  if(!a){ toast(`"${label}" todavía no está disponible en este simulador.`); return; }
  if(edit && !EDIT_SAFE.has(a)){ if(!commitEdit(0,0)) return; }
  const f=ACTIONS[a]; if(f) f(arg); else toast(`"${label}" todavía no está disponible en este simulador.`);
}
function clipToSystem(){ try{ const p=navigator.clipboard && navigator.clipboard.writeText(lastClipText); if(p&&p.catch) p.catch(()=>{}); }catch(e){} }

/* ================= Excel-style colored icons (own drawings, 32x32) ================= */
const BL='#0078D4', LB='#9CCBF0', GR='#107C41', LG='#4CAF50', RD='#D13438', YL='#FFB900', OR='#F7630C', PU='#8764B8', TAN='#D9A65B', PK='#F4A7C0';
const T=(x,y,s,txt,ex='')=>`<text x="${x}" y="${y}" font-size="${s}" class="t" ${ex}>${txt}</text>`;
const TC=(y,s,txt,ex='')=>T(16,y,s,txt,'text-anchor="middle" '+ex);
const gridR=(x,y,w,h,cols,rows)=>{ let d=''; for(let i=1;i<cols;i++) d+=`M${x+w*i/cols} ${y}v${h}`; for(let j=1;j<rows;j++) d+=`M${x} ${y+h*j/rows}h${w}`; return `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="p"/><path d="${d}" class="k" stroke-width="1.2"/>`; };
const book=inner=>`<path d="M7 3h18v22H9.5A2.5 2.5 0 0 0 7 27.5z" class="p"/><path d="M7 27.5A2.5 2.5 0 0 0 9.5 30H25v-5" class="k"/>${inner}`;
const page=inner=>`<path d="M7 3h12l6 6v20H7z" class="p"/><path d="M19 3v6h6" class="k"/>${inner}`;
const funnel=(c=BL)=>`<path d="M4 6h24l-9 11v8l-6 3V17z" fill="${c}"/>`;
const xmark=(cx,cy)=>`<circle cx="${cx}" cy="${cy}" r="6.5" fill="${RD}"/><path d="M${cx-2.6} ${cy-2.6}l5.2 5.2m0-5.2-5.2 5.2" stroke="#fff"/>`;
const plus=(cx,cy)=>`<circle cx="${cx}" cy="${cy}" r="6.5" fill="${GR}"/><path d="M${cx} ${cy-3.2}v6.4M${cx-3.2} ${cy}h6.4" stroke="#fff"/>`;
const mag=(cx,cy,r=6)=>`<circle cx="${cx}" cy="${cy}" r="${r}" class="p"/><path d="M${cx+r*.72} ${cy+r*.72}l5 5" class="k" stroke-width="3"/>`;
const clock=(cx,cy,r)=>`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="${BL}"/><path d="M${cx} ${cy-r*.6}V${cy}h${r*.55}" stroke="${BL}" fill="none"/>`;
const globe=(c)=>`<circle cx="16" cy="16" r="12" fill="none" stroke="${c}"/><ellipse cx="16" cy="16" rx="5" ry="12" fill="none" stroke="${c}"/><path d="M4 16h24M6 9h20M6 23h20" stroke="${c}" fill="none" stroke-width="1.5"/>`;
const greenArrows=`<path d="M25 11a10 10 0 1 0 1.5 7" fill="none" stroke="${GR}" stroke-width="2.6"/><path d="M26 4v7h-7" fill="none" stroke="${GR}" stroke-width="2.6"/>`;
const tableIc=`<rect x="3" y="5" width="26" height="22" class="p"/><rect x="3" y="5" width="26" height="6" fill="${BL}"/><rect x="3.8" y="15" width="24.4" height="4" fill="${LB}"/><rect x="3.8" y="23" width="24.4" height="3.2" fill="${LB}"/><path d="M12 11v16M21 11v16" class="k" stroke-width="1"/>`;
const pivotIc=`<rect x="3" y="3" width="26" height="26" class="p"/><rect x="3" y="3" width="26" height="7" fill="${BL}"/><rect x="3" y="10" width="8" height="19" fill="${LB}"/><path d="M3 16h26M3 22h26M18 10v19M24 10v19" class="k" stroke-width="1"/>`;
const columns=(c1,c2,c3)=>`<rect x="5" y="15" width="5" height="13" fill="${c1}"/><rect x="13" y="6" width="5" height="22" fill="${c2}"/><rect x="21" y="18" width="5" height="10" fill="${c3}"/><path d="M3 28.5h26" class="k"/>`;
const sortTxt=(top,bot)=>`${T(2,13,11,top)}${T(2,28,11,bot)}<path d="M19 4v22m-4.5-4.5L19 26l4.5-4.5" fill="none" stroke="${BL}" stroke-width="2.4"/>`;
const XI={
  undo:`<path d="M11 7 5 13l6 6" class="k" stroke-width="2.6"/><path d="M5 13h14a7 7 0 0 1 0 14h-5" class="k" stroke-width="2.6"/>`,
  redo:`<path d="M21 7l6 6-6 6" class="k" stroke-width="2.6"/><path d="M27 13H13a7 7 0 0 0 0 14h5" class="k" stroke-width="2.6"/>`,
  content_paste:`<rect x="4" y="5" width="18" height="23" rx="2" fill="${TAN}" stroke="#8A6327" stroke-width="1.5"/><rect x="9" y="2.5" width="8" height="5" rx="1.5" class="p"/><rect x="13" y="11" width="15" height="18" rx="1" fill="#fff" stroke="${BL}"/><path d="M16 16h9M16 20h9M16 24h6" stroke="${BL}" stroke-width="1.6"/>`,
  content_cut:`<circle cx="9" cy="23" r="4.5" fill="none" stroke="${BL}" stroke-width="2.4"/><circle cx="23" cy="23" r="4.5" fill="none" stroke="${BL}" stroke-width="2.4"/><path d="M12 19.5 23 3M20 19.5 9 3" class="k" stroke-width="2.2"/>`,
  content_copy:`<rect x="4" y="3" width="15" height="19" rx="1.5" class="p"/><rect x="12" y="9" width="15" height="20" rx="1.5" class="p"/><path d="M15 15h9M15 19h9M15 23h6" stroke="${BL}" stroke-width="1.5"/>`,
  format_paint:`<rect x="4" y="3" width="20" height="9" rx="2" fill="${YL}" stroke="#A86F00" stroke-width="1.5"/><path d="M24 7.5h3.5V16H16v4" class="k"/><rect x="13.5" y="19" width="5" height="10" rx="1.5" class="kf"/>`,
  text_increase:`${T(3,26,21,'A')}<path d="M21 11l3.5-4.5L28 11" fill="none" stroke="${BL}" stroke-width="2.2"/>`,
  text_decrease:`${T(4,26,16,'A')}<path d="M21 6.5l3.5 4.5L28 6.5" fill="none" stroke="${BL}" stroke-width="2.2"/>`,
  border_bottom:`<path d="M5 5h22v22M5 5v22M16 5v22M5 16h22" class="k" stroke-width="1.3" stroke-dasharray="1.6 2.6"/><path d="M4 27.5h24" class="k" stroke-width="3"/>`,
  border_top:`<path d="M5 27h22V5M5 5v22M16 5v22M5 16h22" class="k" stroke-width="1.3" stroke-dasharray="1.6 2.6"/><path d="M4 4.5h24" class="k" stroke-width="3"/>`,
  border_left:`<path d="M5 5h22v22H5M16 5v22M5 16h22" class="k" stroke-width="1.3" stroke-dasharray="1.6 2.6"/><path d="M4.5 4v24" class="k" stroke-width="3"/>`,
  border_right:`<path d="M27 5H5v22h22M16 5v22M5 16h22" class="k" stroke-width="1.3" stroke-dasharray="1.6 2.6"/><path d="M27.5 4v24" class="k" stroke-width="3"/>`,
  border_clear:`<path d="M5 5h22v22H5zM16 5v22M5 16h22" class="k" stroke-width="1.3" stroke-dasharray="1.6 2.6"/>`,
  border_all:`<path d="M5 5h22v22H5zM16 5v22M5 16h22" class="k" stroke-width="2.2"/>`,
  border_outer:`<path d="M16 5v22M5 16h22" class="k" stroke-width="1.3" stroke-dasharray="1.6 2.6"/><path d="M5 5h22v22H5z" class="k" stroke-width="2.4"/>`,
  format_color_fill:`<path d="M4 15 13 6l9 9-9 9z" class="p"/><path d="M7 15h15" class="k"/><path d="M25 14c2.2 3.2 3.2 4.8 3.2 6.2a3.2 3.2 0 0 1-6.4 0c0-1.4 1-3 3.2-6.2z" fill="${BL}"/>`,
  format_color_text:TC(23,24,'A'),
  vertical_align_top:`<path d="M5 4.5h22" class="k" stroke-width="2.4"/><path d="M16 27V11m-5.5 5.5L16 11l5.5 5.5" fill="none" stroke="${BL}" stroke-width="2.6"/>`,
  vertical_align_center:`<path d="M5 16h22" class="k" stroke-width="2.4"/><path d="M16 3v9m-4.5-4.5L16 12l4.5-4.5M16 29v-9m-4.5 4.5L16 20l4.5 4.5" fill="none" stroke="${BL}" stroke-width="2.4"/>`,
  vertical_align_bottom:`<path d="M5 27.5h22" class="k" stroke-width="2.4"/><path d="M16 5v16m-5.5-5.5L16 21l5.5-5.5" fill="none" stroke="${BL}" stroke-width="2.6"/>`,
  text_rotate_up:`<text x="3" y="22" font-size="13" class="t" transform="rotate(-40 10 18)">ab</text><path d="M18 28 28 18m0 0v7m0-7h-7" fill="none" stroke="${BL}" stroke-width="2.2"/>`,
  format_align_left:`<path d="M4 6h24M4 11h15M4 16h24M4 21h15M4 26h20" class="k" stroke-width="2.4"/>`,
  format_align_center:`<path d="M4 6h24M8.5 11h15M4 16h24M8.5 21h15M6 26h20" class="k" stroke-width="2.4"/>`,
  format_align_right:`<path d="M4 6h24M13 11h15M4 16h24M13 21h15M8 26h20" class="k" stroke-width="2.4"/>`,
  format_indent_decrease:`<path d="M14 6h14M14 11h14M14 16h14M14 21h14M4 26h24" class="k" stroke-width="2.2"/><path d="M10 9.5 5 13.5l5 4" fill="none" stroke="${BL}" stroke-width="2.6"/>`,
  format_indent_increase:`<path d="M14 6h14M14 11h14M14 16h14M14 21h14M4 26h24" class="k" stroke-width="2.2"/><path d="M5 9.5l5 4-5 4" fill="none" stroke="${BL}" stroke-width="2.6"/>`,
  wrap_text:`<path d="M4 6h24M4 26h8" class="k" stroke-width="2.4"/><path d="M4 16h18a5 5 0 0 1 0 10h-7" fill="none" stroke="${BL}" stroke-width="2.4"/><path d="M18.5 22 14.5 26l4 4" fill="none" stroke="${BL}" stroke-width="2.4"/>`,
  merge:`<rect x="2.5" y="7" width="27" height="18" class="p"/><path d="M9 16h14M9 16l3.8-3.8M9 16l3.8 3.8M23 16l-3.8-3.8M23 16l-3.8 3.8" fill="none" stroke="${BL}" stroke-width="2.4"/>`,
  attach_money:`<rect x="2.5" y="6" width="21" height="13" rx="1" fill="${LG}" stroke="${GR}" stroke-width="1.5"/><circle cx="13" cy="12.5" r="3.4" fill="none" stroke="#fff" stroke-width="1.6"/><ellipse cx="23" cy="26.5" rx="6.5" ry="2.6" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/><ellipse cx="23" cy="22.5" rx="6.5" ry="2.6" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/>`,
  payments:`<rect x="2.5" y="8" width="27" height="16" rx="1" fill="${LG}" stroke="${GR}" stroke-width="1.5"/><circle cx="16" cy="16" r="4.4" fill="none" stroke="#fff" stroke-width="1.8"/>`,
  percent:TC(24,22,'%'),
  comma:TC(21,12,'000'),
  decimal_increase:()=>`${T(1,13,11,'←0')}${T(8,28,11,ST.DEC+'00')}`,
  decimal_decrease:()=>`${T(1,13,11,ST.DEC+'00')}${T(8,28,11,'→0')}`,
  rule:`${gridR(2,3,20,25,2,3)}<rect x="12.6" y="3.6" width="8.8" height="7.2" fill="${RD}"/><rect x="2.6" y="11.9" width="8.8" height="7.2" fill="${BL}"/><rect x="12.6" y="20.2" width="8.8" height="7.2" fill="${RD}"/><rect x="24" y="9" width="5" height="19" fill="${LB}"/><rect x="24" y="17" width="5" height="11" fill="${BL}"/>`,
  table_view:tableIc,
  table:tableIc,
  style:`<rect x="2.5" y="4" width="13" height="10" fill="#C6EFCE" stroke="${GR}" stroke-width="1.2"/><rect x="16.5" y="4" width="13" height="10" fill="#FFC7CE" stroke="${RD}" stroke-width="1.2"/><rect x="2.5" y="16" width="13" height="10" fill="#FFEB9C" stroke="#9C5700" stroke-width="1.2"/><rect x="16.5" y="16" width="13" height="10" fill="${BL}"/>`,
  add_box:`${gridR(2,2,20,20,3,3)}${plus(23,23)}`,
  disabled_by_default:`${gridR(2,2,20,20,3,3)}${xmark(23,23)}`,
  fmtCells:`${gridR(2,3,18,22,2,3)}<path d="M26 6v20m-3.5-16.5L26 6l3.5 3.5m-7 13L26 26l3.5-3.5" fill="none" stroke="${BL}" stroke-width="2"/>`,
  functions:`<path d="M24 8V5H7l10 11L7 27h17v-3" class="k" stroke-width="2.8"/>`,
  arrow_downward:`<rect x="7" y="2.5" width="18" height="27" class="p"/><path d="M16 7v15m-5.5-5.5L16 22l5.5-5.5" fill="none" stroke="${BL}" stroke-width="2.8"/>`,
  ink_eraser:`<path d="M3 20 15 8l11 11-8 8H10z" fill="${PK}" stroke="#B0306A" stroke-width="1.6"/><path d="M9 14l11 11" stroke="#B0306A" stroke-width="1.6"/><path d="M19 28.5h10" class="k"/>`,
  filter_list:`${T(1,13,11,'A')}${T(1,28,11,'Z')}<path d="M11.5 4v22M8 22.5l3.5 3.5 3.5-3.5" fill="none" stroke="${BL}" stroke-width="2"/><path d="M16.5 8h13l-5 6.5v8l-3 2v-10z" fill="${BL}"/>`,
  search:`<circle cx="9" cy="21" r="6" class="p"/><circle cx="23" cy="21" r="6" class="p"/><path d="M5 16 8 5h4l2 11M27 16 24 5h-4l-2 11M15 19h2" class="k"/><circle cx="9" cy="21" r="2.5" fill="${LB}"/><circle cx="23" cy="21" r="2.5" fill="${LB}"/>`,
  insights:`<rect x="3" y="17" width="5.5" height="11" fill="${GR}"/><rect x="11" y="10" width="5.5" height="18" fill="${LG}"/><rect x="19" y="20" width="5.5" height="8" fill="${GR}"/><path d="M25.5 3l1.6 3.9 3.9 1.6-3.9 1.6-1.6 3.9-1.6-3.9-3.9-1.6 3.9-1.6z" fill="${YL}"/>`,
  pivot_table_chart:pivotIc,
  table_chart:`${pivotIc}<circle cx="24" cy="24" r="6.5" fill="${YL}" stroke="#fff" stroke-width="1"/><text x="24" y="28" font-size="10" text-anchor="middle" fill="#fff" font-weight="700" font-family="Segoe UI,Arial">?</text>`,
  image:`<rect x="2.5" y="5" width="27" height="22" rx="1.5" class="p"/><circle cx="10" cy="12" r="3" fill="${YL}"/><path d="M3.5 26l8-9 5.5 5.5 4-4 8 7.5z" fill="${GR}"/>`,
  shapes:`<circle cx="11" cy="11" r="8" fill="${BL}"/><rect x="13" y="13" width="16" height="16" fill="${OR}" fill-opacity=".9"/>`,
  emoji_symbols:`<circle cx="10" cy="8" r="4" fill="${BL}"/><path d="M3 21a7 7 0 0 1 14 0z" fill="${BL}"/><path d="M23 15c-3-3.5-8 0-4 4l4 4 4-4c4-4-1-7.5-4-4z" fill="${RD}"/>`,
  view_in_ar:`<path d="M16 3 28 9v14L16 29 4 23V9z" class="p"/><path d="M16 3 28 9 16 15 4 9z" fill="${LB}" style="stroke:var(--ix)"/><path d="M16 15v14" class="k"/>`,
  account_tree:`<rect x="11" y="3" width="10" height="7" fill="${GR}"/><rect x="2" y="21" width="11" height="7" fill="${LG}"/><rect x="19" y="21" width="11" height="7" fill="${LG}"/><path d="M16 10v5M7.5 15h17M7.5 15v6M24.5 15v6" class="k"/>`,
  screenshot_monitor:`<rect x="2.5" y="4" width="27" height="18" rx="1" class="p"/><path d="M11 28h10M16 22v6" class="k"/><rect x="7" y="8" width="13" height="10" fill="none" stroke="${BL}" stroke-dasharray="2 2"/>`,
  insert_chart:`${columns(BL,OR,GR)}<circle cx="25" cy="7" r="5.5" fill="${YL}"/><text x="25" y="11" font-size="9" text-anchor="middle" fill="#fff" font-weight="700" font-family="Segoe UI,Arial">?</text>`,
  bar_chart:columns(BL,BL,BL),
  show_chart:`<path d="M3 28.5h26" class="k"/><path d="M4 22l7-8 6 5 11-12" fill="none" stroke="${BL}" stroke-width="2.8"/>`,
  pie_chart:`<circle cx="16" cy="16" r="12.5" fill="${BL}"/><path d="M16 16V3.5A12.5 12.5 0 0 1 27.5 21z" fill="${OR}"/><path d="M16 16l11.5 5A12.5 12.5 0 0 1 16 28.5z" fill="${YL}"/>`,
  stacked_bar_chart:`<rect x="3" y="4" width="14" height="24" fill="${BL}"/><rect x="18" y="4" width="11" height="13" fill="${OR}"/><rect x="18" y="18" width="11" height="10" fill="${GR}"/>`,
  waterfall_chart:`<rect x="3" y="15" width="5.5" height="13" fill="${BL}"/><rect x="10.5" y="9" width="5.5" height="6" fill="${GR}"/><rect x="18" y="9" width="5.5" height="9" fill="${RD}"/><rect x="25.5" y="18" width="4" height="10" fill="${BL}"/><path d="M2 28.5h28" class="k"/>`,
  scatter_plot:`<path d="M4 3v25h25" class="k"/><circle cx="10" cy="20" r="2.4" fill="${BL}"/><circle cx="15" cy="13" r="2.4" fill="${BL}"/><circle cx="20" cy="17" r="2.4" fill="${OR}"/><circle cx="25" cy="8" r="2.4" fill="${BL}"/>`,
  map:`<path d="M3 7l8-3 10 4 8-3v20l-8 3-10-4-8 3z" fill="${LB}" stroke="${BL}" stroke-width="1.5"/><path d="M11 4v20M21 8v20" stroke="${BL}" stroke-width="1.5"/>`,
  area_chart:`<path d="M3 28V18l7-6 7 5 12-10v21z" fill="${BL}" fill-opacity=".85"/><path d="M3 28.5h26" class="k"/>`,
  candlestick_chart:`<path d="M8 4v24M16 8v20M24 3v22" class="k" stroke-width="1.5"/><rect x="5" y="9" width="6" height="12" fill="${GR}"/><rect x="13" y="13" width="6" height="9" fill="${RD}"/><rect x="21" y="7" width="6" height="12" fill="${GR}"/>`,
  pivotchart:`${columns(BL,OR,GR)}<rect x="20" y="2" width="10" height="8" class="p" stroke-width="1.2"/><path d="M20 5h10M24 2v8" class="k" stroke-width="1"/>`,
  timeline:`<rect x="2.5" y="8" width="27" height="16" class="p"/><path d="M6 19l5-6 5 4 4-6 6 4" fill="none" stroke="${BL}" stroke-width="2.2"/>`,
  equalizer:`<rect x="2.5" y="8" width="27" height="16" class="p"/><rect x="6" y="15" width="3" height="6" fill="${BL}"/><rect x="11" y="11" width="3" height="10" fill="${BL}"/><rect x="16" y="17" width="3" height="4" fill="${BL}"/><rect x="21" y="12" width="3" height="9" fill="${BL}"/>`,
  swap_vert:`<rect x="2.5" y="6" width="27" height="20" class="p"/><path d="M3 16h26" class="k" stroke-width="1"/><rect x="6" y="10" width="3" height="6" fill="${BL}"/><rect x="11" y="16" width="3" height="6" fill="${RD}"/><rect x="16" y="10" width="3" height="6" fill="${BL}"/><rect x="21" y="10" width="3" height="6" fill="${BL}"/>`,
  slicer:`<rect x="3" y="3" width="19" height="25" class="p"/><rect x="6" y="7" width="13" height="5" fill="${BL}"/><rect x="6" y="14" width="13" height="5" fill="${LB}"/><rect x="6" y="21" width="13" height="4" fill="${LB}"/><path d="M20 17h10l-4 5v6l-2-1v-5z" fill="${BL}"/>`,
  date_range:`<rect x="2.5" y="9" width="27" height="15" class="p"/><path d="M9 9v15M16 9v15M23 9v15" class="k" stroke-width="1"/><rect x="9.5" y="9.5" width="13" height="14" fill="${LB}"/><path d="M6 5h20" stroke="${BL}" stroke-width="2.6"/>`,
  link:`<path d="M12.5 19.5l7-7" class="k" stroke-width="2.4"/><path d="M14 9.5l3-3a5.5 5.5 0 0 1 7.8 7.8l-3 3M18 22.5l-3 3a5.5 5.5 0 0 1-7.8-7.8l3-3" fill="none" stroke="${BL}" stroke-width="2.8"/>`,
  add_comment:`<path d="M3 5h26v16H14l-7 6v-6H3z" class="p"/><path d="M16 8.5v9M11.5 13h9" stroke="${BL}" stroke-width="2.4"/>`,
  textbox:`<rect x="3" y="3" width="26" height="26" class="p" stroke-dasharray="3 2"/>${TC(24,18,'A')}`,
  web_asset:`${page('')}<rect x="8" y="6" width="10" height="4" fill="${BL}"/><rect x="8" y="23" width="16" height="4" fill="${BL}"/>`,
  wordart:`<text x="16" y="27" font-size="26" text-anchor="middle" fill="${BL}" stroke="#004E8C" stroke-width="1" font-weight="700" font-style="italic" font-family="Georgia,serif">A</text>`,
  draw:`<path d="M3 26h26" class="k"/><path d="M5 20l5-5m0 5-5-5" stroke="${BL}" stroke-width="2.2"/><path d="M15 22l2-6 9-9 4 4-9 9z" class="kf"/>`,
  widgets:`${page('')}<rect x="10" y="14" width="10" height="9" fill="${LB}" stroke="${BL}" stroke-width="1.5"/>`,
  equation:`<text x="16" y="25" font-size="24" text-anchor="middle" class="t" style="font-family:Cambria,Georgia,serif">π</text>`,
  omega:`<text x="16" y="26" font-size="24" text-anchor="middle" class="t" style="font-family:Cambria,Georgia,serif">Ω</text>`,
  arrow_selector_tool:`<path d="M8 3v21l5.5-5 4 9 3.5-1.5-4-8.5H24z" class="p"/>`,
  lasso_select:`<ellipse cx="17" cy="11" rx="11" ry="7" fill="none" stroke="${BL}" stroke-dasharray="3 2.5"/><path d="M8 16c-3 3 0 6 3 6s2 4-2 6" class="k"/>`,
  edit:`<path d="M5 27l2-7L21 6l5 5-14 14z" fill="#3b3b3b"/><path d="M5 27l2-7 5 5z" fill="${RD}"/>`,
  stylus:`<path d="M5 27l2-7L21 6l5 5-14 14z" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/><path d="M5 27l2-7 5 5z" fill="#3b3b3b"/>`,
  ink_highlighter:`<path d="M8 23l3-9 9-9 6 6-9 9z" fill="#FFF100" stroke="#A89A00" stroke-width="1.2"/><path d="M8 23l-4 5h8l1-4z" fill="#FFF100" stroke="#A89A00" stroke-width="1.2"/>`,
  add_circle:`<circle cx="16" cy="16" r="12" fill="none" stroke="${BL}" stroke-width="2.4"/><path d="M16 10v12M10 16h12" stroke="${BL}" stroke-width="2.4"/>`,
  interests:`<circle cx="10" cy="10" r="6" fill="none" stroke="${BL}" stroke-width="2.2"/><rect x="16" y="16" width="12" height="12" fill="none" stroke="${OR}" stroke-width="2.2"/><path d="M5 27l4-4" class="k"/>`,
  inkmath:`<text x="12" y="24" font-size="20" text-anchor="middle" class="t" style="font-family:Cambria,Georgia,serif">π</text><path d="M19 26l2-5 6-6 3 3-6 6z" fill="${BL}"/>`,
  replay:`<circle cx="16" cy="16" r="12" fill="none" stroke="${BL}" stroke-width="2.2"/><path d="M13 10v12l9-6z" fill="${BL}"/>`,
  palette:`<rect x="2.5" y="5" width="27" height="22" rx="2" class="p"/>${T(5,22,13,'Aa')}<rect x="20" y="8" width="6" height="4.5" fill="${BL}"/><rect x="20" y="14" width="6" height="4.5" fill="${OR}"/><rect x="20" y="20" width="6" height="4.5" fill="${GR}"/>`,
  themeColors:`<rect x="3" y="3" width="12" height="12" fill="${BL}"/><rect x="17" y="3" width="12" height="12" fill="${OR}"/><rect x="3" y="17" width="12" height="12" fill="${GR}"/><rect x="17" y="17" width="12" height="12" fill="${YL}"/>`,
  font_download:`<text x="16" y="25" font-size="24" text-anchor="middle" class="t" style="font-family:Georgia,serif">A</text>`,
  auto_awesome:`<circle cx="14" cy="17" r="10" fill="${LB}" stroke="${BL}"/><path d="M25 3l1.4 3.6L30 8l-3.6 1.4L25 13l-1.4-3.6L20 8l3.6-1.4z" fill="${YL}"/>`,
  margin:`${page('')}<path d="M10 6v20M22 9v17M7 8h18M7 24h18" stroke="${BL}" stroke-width="1.3" stroke-dasharray="2 2" fill="none"/>`,
  screen_rotation:`<rect x="3" y="3" width="13" height="18" class="p"/><rect x="11" y="16" width="18" height="13" class="p"/><path d="M20 4a7 7 0 0 1 7 7" fill="none" stroke="${BL}" stroke-width="2"/><path d="M25 9l2 2.5L29 9" fill="none" stroke="${BL}" stroke-width="2"/>`,
  description:page(`<path d="M10 14h11M10 18h11M10 22h8" class="k" stroke-width="1.5"/>`),
  csv:page(`<text x="16" y="22" font-size="8" text-anchor="middle" fill="${GR}" font-weight="700" font-family="Segoe UI,Arial">CSV</text>`),
  print:`<rect x="8" y="3" width="16" height="9" class="p"/><rect x="3" y="11" width="26" height="12" rx="2" fill="#7a7a7a"/><rect x="8" y="19" width="16" height="10" class="p"/><path d="M11 23h10M11 26h7" stroke="${BL}" stroke-width="1.4"/>`,
  insert_page_break:`<rect x="6" y="2.5" width="20" height="11" class="p"/><rect x="6" y="18.5" width="20" height="11" class="p"/><path d="M2 16h28" stroke="${BL}" stroke-dasharray="3 2"/>`,
  wallpaper:`<rect x="2.5" y="5" width="27" height="22" class="p"/><path d="M3.5 26l8-9 5.5 5.5 4-4 8 7.5z" fill="${LB}"/><circle cx="10" cy="12" r="3" fill="${YL}"/>`,
  title:page(`<rect x="9" y="11" width="14" height="3.5" fill="${BL}"/><path d="M9 18h14M9 22h14" class="k" stroke-width="1.3"/>`),
  fx:`<text x="16" y="23" font-size="19" text-anchor="middle" class="t" style="font-family:Cambria,Georgia,serif;font-style:italic">fx</text>`,
  history:book(`<path d="M16 7l1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="${YL}"/>`),
  account_balance:book(`<circle cx="16" cy="13" r="6" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/><text x="16" y="16.5" font-size="9" text-anchor="middle" fill="#7a5200" font-weight="700" font-family="Segoe UI,Arial">$</text>`),
  help_center:book(`<text x="16" y="19" font-size="15" text-anchor="middle" fill="${BL}" font-weight="700" font-family="Segoe UI,Arial">?</text>`),
  fnText:book(`<text x="16" y="19" font-size="14" text-anchor="middle" fill="${BL}" font-weight="700" font-family="Segoe UI,Arial">A</text>`),
  calendar_month:book(clock(16,13,6.5)),
  manage_search:book(`<circle cx="14.5" cy="12" r="4.5" fill="#fff" stroke="${BL}" stroke-width="2"/><path d="M18 15.5l3.5 3.5" stroke="${BL}" stroke-width="2.6"/>`),
  fnMath:book(`<text x="16" y="19" font-size="15" text-anchor="middle" fill="${BL}" font-weight="700" style="font-family:Cambria,Georgia,serif">θ</text>`),
  more_horiz:book(`<circle cx="11" cy="14" r="1.8" fill="${BL}"/><circle cx="16" cy="14" r="1.8" fill="${BL}"/><circle cx="21" cy="14" r="1.8" fill="${BL}"/>`),
  badge:`<path d="M3 9h17l9 7-9 7H3z" fill="${LB}" stroke="${BL}" stroke-width="1.6"/><circle cx="9" cy="16" r="2.2" fill="${BL}"/>`,
  label:`<path d="M3 11h14l7 5.5-7 5.5H3z" fill="${LB}" stroke="${BL}" stroke-width="1.6"/>${plus(25,8)}`,
  input:`<text x="12" y="16" font-size="13" text-anchor="middle" class="t" style="font-family:Cambria,Georgia,serif;font-style:italic">fx</text><path d="M24 6v18m-4.5-4.5L24 24l4.5-4.5" fill="none" stroke="${BL}" stroke-width="2.4"/>`,
  select_all:`${gridR(3,3,26,26,3,3)}<rect x="3.6" y="3.6" width="8.6" height="8.6" fill="${LB}"/><rect x="12.2" y="3.6" width="8.6" height="8.6" fill="${LB}"/>`,
  arrow_right_alt:`${gridR(16,16,13,13,1,1)}<circle cx="6" cy="7" r="3.5" fill="${BL}"/><path d="M8.5 9.5 20 21m0 0v-6m0 6h-6" fill="none" stroke="${BL}" stroke-width="2.4"/>`,
  keyboard_backspace:`${gridR(3,3,13,13,1,1)}<path d="M12 12l14 14m0 0v-6.5m0 6.5h-6.5" fill="none" stroke="${BL}" stroke-width="2.4"/><circle cx="9.5" cy="9.5" r="3" fill="${BL}"/>`,
  clear_all:`<path d="M4 6l14 14m0 0v-6.5m0 6.5h-6.5" fill="none" stroke="${BL}" stroke-width="2.4"/>${xmark(23,23)}`,
  showfx:`${gridR(3,3,26,26,2,2)}<rect x="6" y="11" width="20" height="10" style="fill:var(--ip)"/><text x="16" y="20" font-size="11" text-anchor="middle" fill="${BL}" font-weight="700" style="font-family:Cambria,Georgia,serif;font-style:italic">fx</text>`,
  error:`<path d="M16 3 30 28H2z" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/><path d="M16 11v8M16 23.5v.5" stroke="#3b3b3b" stroke-width="2.8"/>`,
  troubleshoot:`<text x="16" y="21" font-size="14" text-anchor="middle" class="t" style="font-family:Cambria,Georgia,serif;font-style:italic">(fx)</text><path d="M5 26h22" stroke="${BL}" stroke-width="2"/>`,
  visibility:`<circle cx="9" cy="19" r="6" class="p"/><circle cx="23" cy="19" r="6" class="p"/><path d="M15 18h2M3.5 17 7 8M28.5 17 25 8" class="k"/><circle cx="9" cy="19" r="2.5" fill="${LB}"/><circle cx="23" cy="19" r="2.5" fill="${LB}"/>`,
  calculate:`<rect x="6" y="2.5" width="20" height="27" rx="2" class="p"/><rect x="9" y="6" width="14" height="6" fill="${LB}"/><path d="M10 16.5h2M15 16.5h2M20 16.5h2M10 21h2M15 21h2M20 21h2M10 25.5h2M15 25.5h2M20 25.5h2" class="k" stroke-width="2.2"/>`,
  tune:`<rect x="3" y="2.5" width="17" height="24" rx="2" class="p"/><rect x="6" y="6" width="11" height="5" fill="${LB}"/><path d="M7 15h2M12 15h2M7 19h2M12 19h2" class="k" stroke-width="2"/><circle cx="23" cy="23" r="6.5" fill="${BL}"/><circle cx="23" cy="23" r="2.4" fill="#fff"/>`,
  refresh:greenArrows,
  sync:`${greenArrows}<rect x="11" y="11" width="10" height="10" class="p" stroke-width="1.4"/>`,
  database:`<ellipse cx="12" cy="7" rx="9" ry="3.5" class="p"/><path d="M3 7v16c0 2 4 3.5 9 3.5s9-1.5 9-3.5V7" class="p"/><path d="M3 15c0 2 4 3.5 9 3.5s9-1.5 9-3.5" class="k"/>${gridR(19,18,11,11,2,2)}`,
  language:globe(BL),
  public:globe(GR),
  schedule:clock(16,16,12),
  cable:`<rect x="10" y="4" width="12" height="11" rx="2" class="p"/><path d="M13 4V1M19 4V1M16 15v6a6 6 0 0 1-6 6H6" class="k" stroke-width="2.4"/>`,
  trending_up:`<path d="M3 24l8-8 6 5 11-12" fill="none" stroke="${GR}" stroke-width="2.8"/><path d="M21 9h7v7" fill="none" stroke="${GR}" stroke-width="2.8"/>`,
  north:sortTxt('A','Z'),
  south:sortTxt('Z','A'),
  sort:`${T(1,13,11,'A')}${T(1,28,11,'Z')}${T(13,13,11,'Z')}${T(13,28,11,'A')}<path d="M26.5 4v22m-3.5-3.5 3.5 3.5 3.5-3.5" fill="none" stroke="${BL}" stroke-width="2"/>`,
  filter_alt:funnel(),
  filter_alt_off:`${funnel()}${xmark(24,24)}`,
  view_week:`<rect x="2.5" y="6" width="11" height="20" class="p"/><rect x="18.5" y="6" width="11" height="20" class="p"/><path d="M13.5 16h5" stroke="${BL}" stroke-width="2.4"/><path d="M5.5 11h5M5.5 16h5M5.5 21h5M21.5 11h5M21.5 16h5M21.5 21h5" class="k" stroke-width="1.5"/>`,
  bolt:`<path d="M18 2 6 18h8l-2 12 12-16h-8z" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/>`,
  layers_clear:`<rect x="3" y="4" width="18" height="8" class="p"/><rect x="3" y="14" width="18" height="8" class="p"/>${xmark(23,23)}`,
  verified:`<rect x="2.5" y="4" width="20" height="11" class="p"/><path d="M6 9.5l3 3 6-6" stroke="${GR}" fill="none" stroke-width="2.6"/><circle cx="23" cy="23" r="6" fill="none" stroke="${RD}" stroke-width="2.4"/><path d="M19 27l8-8" stroke="${RD}" stroke-width="2.4"/>`,
  merge_type:`${gridR(2,3,10,10,2,2)}${gridR(2,19,10,10,2,2)}${gridR(19,11,11,11,2,2)}<path d="M12 8h4v14h-4M16 16h3" class="k" stroke-width="1.6"/>`,
  hub:`<rect x="2.5" y="4" width="10" height="8" fill="${LB}" stroke="${BL}" stroke-width="1.4"/><rect x="19.5" y="4" width="10" height="8" fill="${LB}" stroke="${BL}" stroke-width="1.4"/><rect x="11" y="21" width="10" height="8" fill="${LB}" stroke="${BL}" stroke-width="1.4"/><path d="M7.5 12l8.5 9M24.5 12 16 21" class="k" stroke-width="1.6"/>`,
  dataset:`<path d="M16 3 27 8.5v13L16 27 5 21.5v-13z" fill="${LB}" stroke="${BL}" stroke-width="1.5"/><path d="M5 8.5 16 14l11-5.5M16 14v13" stroke="${BL}" stroke-width="1.5" fill="none"/>`,
  psychology:`${gridR(2,3,20,20,2,2)}<circle cx="24" cy="23" r="6.5" fill="${BL}"/><text x="24" y="27" font-size="10" text-anchor="middle" fill="#fff" font-weight="700" font-family="Segoe UI,Arial">?</text>`,
  query_stats:`<path d="M3 28.5h26" class="k"/><path d="M4 22l6-6 5 4 4-5" fill="none" stroke="${BL}" stroke-width="2.6"/><path d="M19 15l9-8" fill="none" stroke="${OR}" stroke-width="2.6" stroke-dasharray="3 2.5"/>`,
  group:`<path d="M5 4v24M5 4h4M5 28h4" class="k" stroke-width="2.4"/>${gridR(12,6,17,20,1,4)}<path d="M2.5 16h5" stroke="${BL}" stroke-width="2.4"/>`,
  ungroup:`<path d="M5 4v24M5 4h4M5 28h4" class="k" stroke-width="2.4" stroke-dasharray="3 3"/>${gridR(12,6,17,20,1,4)}`,
  subtotal:`${gridR(2,3,18,25,1,4)}<path d="M29 9V6.5H21l5 6.5-5 6.5h8V17" class="k" stroke-width="2.2"/>`,
  spellcheck:`${T(1,14,12,'ABC')}<path d="M8 22l5 5 13-13" fill="none" stroke="${BL}" stroke-width="2.8"/>`,
  menu_book:`<path d="M2.5 6c5-2 9-2 13.5 1v20c-4.5-3-8.5-3-13.5-1z" class="p"/><path d="M29.5 6c-5-2-9-2-13.5 1v20c4.5-3 8.5-3 13.5-1z" class="p"/><path d="M6 11h7M6 15h7M19 11h7M19 15h7" stroke="${BL}" stroke-width="1.4"/>`,
  analytics:`${page('')}<rect x="10" y="17" width="3" height="8" fill="${BL}"/><rect x="15" y="12" width="3" height="13" fill="${BL}"/><rect x="20" y="15" width="3" height="10" fill="${BL}"/>`,
  accessibility_new:`<circle cx="16" cy="16" r="13" fill="${BL}"/><circle cx="16" cy="9" r="2.4" fill="#fff"/><path d="M9 13h14M16 13v6l-3.5 6.5M16 19l3.5 6.5" stroke="#fff" stroke-width="2.2" fill="none"/>`,
  travel_explore:`${globe(BL)}<circle cx="22" cy="22" r="5" fill="#fff" style="stroke:var(--ix)" stroke-width="2"/><path d="M25.5 25.5l4 4" class="k" stroke-width="3"/>`,
  translate:`<rect x="2.5" y="3" width="15" height="15" rx="2" fill="${BL}"/><text x="10" y="15" font-size="11" text-anchor="middle" fill="#fff" font-weight="700" font-family="Segoe UI,Arial">A</text><rect x="14.5" y="14" width="15" height="15" rx="2" class="p"/><text x="22" y="26" font-size="11" text-anchor="middle" class="t">文</text>`,
  delete:`<path d="M6 8h20M12 8V4.5h8V8" class="k" stroke-width="2.2"/><path d="M8 8l1.5 20h13L24 8" class="p"/><path d="M13 13v10M19 13v10" stroke="${RD}" stroke-width="2"/>`,
  arrow_back:`<path d="M3 5h26v16H14l-7 6v-6H3z" class="p"/><path d="M20 13h-9m4-4-4 4 4 4" fill="none" stroke="${BL}" stroke-width="2.2"/>`,
  arrow_forward:`<path d="M3 5h26v16H14l-7 6v-6H3z" class="p"/><path d="M11 13h9m-4-4 4 4-4 4" fill="none" stroke="${BL}" stroke-width="2.2"/>`,
  forum:`<path d="M2.5 4h18v12H11l-5 4.5V16H2.5z" class="p"/><path d="M12 19.5h8.5L26 24v-4.5h3.5V9h-6" fill="${LB}" stroke="${BL}" stroke-width="1.6"/>`,
  sticky_note_2:`<path d="M4 4h24v16l-8 8H4z" fill="#FFF100" stroke="#A89A00" stroke-width="1.4"/><path d="M20 28v-8h8" fill="#E6D800" stroke="#A89A00" stroke-width="1.4"/>`,
  lock:`${gridR(2,2,18,22,2,3)}<rect x="17" y="18" width="12" height="11" rx="1.5" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/><path d="M19.5 18v-3a3.5 3.5 0 0 1 7 0v3" fill="none" stroke="#A86F00" stroke-width="2"/>`,
  enhanced_encryption:`${book('')}<rect x="17" y="18" width="12" height="11" rx="1.5" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/><path d="M19.5 18v-3a3.5 3.5 0 0 1 7 0v3" fill="none" stroke="#A86F00" stroke-width="2"/>`,
  edit_note:`${gridR(2,2,20,20,2,2)}<path d="M15 28l1.5-5L26 13.5l3.5 3.5L20 26.5z" fill="${BL}"/>`,
  lock_open:`${gridR(2,2,18,22,2,3)}<rect x="17" y="18" width="12" height="11" rx="1.5" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/><path d="M19.5 18v-3a3.5 3.5 0 0 1 7 0" fill="none" stroke="#A86F00" stroke-width="2"/>`,
  visibility_off:`<path d="M3 16s5-8 13-8 13 8 13 8-5 8-13 8S3 16 3 16z" class="p"/><circle cx="16" cy="16" r="4" fill="${BL}"/><path d="M5 27 27 5" stroke="${RD}" stroke-width="2.6"/>`,
  grid_on:gridR(3,3,26,26,3,4),
  view_agenda:`<rect x="3" y="3" width="26" height="26" class="p"/><path d="M16 3v26M3 16h26" stroke="${BL}" stroke-width="2.4" stroke-dasharray="3 2"/><text x="9.5" y="12" font-size="7" text-anchor="middle" fill="${BL}" font-family="Segoe UI,Arial" font-weight="700">1</text>`,
  auto_stories:`<path d="M5 6h22" stroke="${BL}" stroke-width="2"/><path d="M5 3v6M27 3v6" stroke="${BL}" stroke-width="1.5"/>${gridR(5,12,22,17,3,3)}`,
  dashboard_customize:`<rect x="3" y="3" width="11" height="11" class="p"/><rect x="18" y="3" width="11" height="11" fill="${LB}" stroke="${BL}" stroke-width="1.5"/><rect x="3" y="18" width="11" height="11" fill="${LB}" stroke="${BL}" stroke-width="1.5"/><rect x="18" y="18" width="11" height="11" class="p"/>`,
  zoom_in:`${mag(13,13,9)}<path d="M13 9v8M9 13h8" stroke="${BL}" stroke-width="2.4"/>`,
  zoom100:`${mag(13,13,9)}<text x="13" y="16" font-size="8" text-anchor="middle" fill="${BL}" font-weight="700" font-family="Segoe UI,Arial">100</text>`,
  center_focus_strong:`${mag(13,13,9)}<rect x="8.5" y="8.5" width="9" height="9" fill="${LB}"/>`,
  open_in_new:`<rect x="2.5" y="8" width="18" height="18" class="p"/><rect x="11.5" y="3" width="18" height="18" class="p"/><path d="M11.5 7h18" stroke="${BL}" stroke-width="2.4"/>`,
  view_quilt:`<rect x="2.5" y="3" width="12" height="26" class="p"/><rect x="17.5" y="3" width="12" height="12" class="p"/><rect x="17.5" y="17" width="12" height="12" class="p"/><path d="M2.5 6h12M17.5 6h12M17.5 20h12" stroke="${BL}" stroke-width="2"/>`,
  ac_unit:`${gridR(3,3,26,26,3,3)}<path d="M3 11.7h26M11.7 3v26" stroke="${BL}" stroke-width="2.6"/>`,
  splitscreen:`${gridR(3,3,26,26,2,2)}<path d="M16 3v26M3 16h26" stroke="${BL}" stroke-width="2.4"/>`,
  compare:`<rect x="2.5" y="5" width="12" height="22" class="p"/><rect x="17.5" y="5" width="12" height="22" class="p"/><path d="M2.5 8h12M17.5 8h12" stroke="${BL}" stroke-width="2"/>`,
  sync_alt:`<rect x="2.5" y="5" width="12" height="22" class="p"/><rect x="17.5" y="5" width="12" height="22" class="p"/><path d="M8.5 11v10m-3-3 3 3 3-3M23.5 11v10m-3-3 3 3 3-3" fill="none" stroke="${BL}" stroke-width="1.8"/>`,
  restart_alt:`<rect x="2.5" y="5" width="12" height="22" class="p"/><rect x="17.5" y="5" width="12" height="22" class="p"/><path d="M12 16h8m-3-3 3 3-3 3" fill="none" stroke="${BL}" stroke-width="1.8"/>`,
  swap_horiz:`<rect x="2.5" y="3" width="18" height="15" class="p"/><rect x="11.5" y="14" width="18" height="15" class="p"/><path d="M11.5 17h18" stroke="${BL}" stroke-width="2.4"/>`,
  code:`${gridR(2,3,20,22,2,3)}<circle cx="24" cy="23" r="7" fill="${BL}"/><path d="M22 19.5v7l5.5-3.5z" fill="#fff"/>`,
  help:`<circle cx="16" cy="16" r="13" fill="${BL}"/><text x="16" y="22" font-size="17" text-anchor="middle" fill="#fff" font-weight="700" font-family="Segoe UI,Arial">?</text>`,
  support_agent:`<path d="M6 17v-3a10 10 0 0 1 20 0v3" class="k" stroke-width="2.4"/><rect x="3" y="15" width="6" height="9" rx="2" fill="${BL}"/><rect x="23" y="15" width="6" height="9" rx="2" fill="${BL}"/><path d="M26 24c0 3-4 4.5-8 4.5" class="k"/>`,
  feedback:`<circle cx="16" cy="16" r="13" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/><circle cx="11.5" cy="13" r="1.8" fill="#5a3d00"/><circle cx="20.5" cy="13" r="1.8" fill="#5a3d00"/><path d="M10 19c3.5 4 8.5 4 12 0" fill="none" stroke="#5a3d00" stroke-width="2"/>`,
  school:`<path d="M16 5 2 12l14 7 14-7z" fill="${BL}"/><path d="M8 15.5V22c4 3.5 12 3.5 16 0v-6.5" fill="${LB}" stroke="${BL}" stroke-width="1.5"/><path d="M28 12v8" class="k"/>`,
  new_releases:`<path d="M16 2l3.5 4.5 5.5-1-.5 5.5L29 14l-4 4 .5 5.5-5.5-.5L16 27l-3.5-4.5-5.5.5.5-5.5L3 14l4.5-3-.5-5.5 5.5 1z" fill="${YL}" stroke="#A86F00" stroke-width="1.2"/><path d="M16 9v7M16 19.5v.5" stroke="#5a3d00" stroke-width="2.6"/>`,
  visibilityKeep:`<path d="M3 16s5-8 13-8 13 8 13 8-5 8-13 8S3 16 3 16z" class="p"/><circle cx="16" cy="16" r="4.5" fill="${BL}"/>`,
  shield:`<path d="M16 3l11 4v8c0 7-5 12-11 14C10 27 5 22 5 15V7z" fill="${LB}" stroke="${BL}" stroke-width="1.6"/>`,
  width:`<rect x="3" y="8" width="26" height="16" class="p"/><path d="M7 16h18m-3.5-3.5L25 16l-3.5 3.5M10.5 12.5 7 16l3.5 3.5" fill="none" stroke="${BL}" stroke-width="2"/>`,
  height:`<rect x="8" y="3" width="16" height="26" class="p"/><path d="M16 7v18m-3.5-3.5L16 25l3.5-3.5M12.5 10.5 16 7l3.5 3.5" fill="none" stroke="${BL}" stroke-width="2"/>`,
  zoom_out_map:`<rect x="5" y="5" width="22" height="22" class="p"/><path d="M9 9l14 14m0 0v-6m0 6h-6M9 9v6m0-6h6" fill="none" stroke="${BL}" stroke-width="2"/>`,
  flip_to_front:`<rect x="3" y="3" width="15" height="15" class="p"/><rect x="11" y="11" width="18" height="18" fill="${BL}"/>`,
  flip_to_back:`<rect x="11" y="11" width="18" height="18" fill="${BL}"/><rect x="3" y="3" width="15" height="15" class="p"/>`,
  align_horizontal_center:`<path d="M16 2v28" class="k"/><rect x="7" y="6" width="18" height="7" fill="${BL}"/><rect x="10" y="19" width="12" height="7" fill="${LB}" stroke="${BL}" stroke-width="1.4"/>`,
  group_work:`<rect x="3" y="3" width="12" height="12" fill="${BL}"/><circle cx="22" cy="22" r="7" fill="${OR}"/><rect x="1.5" y="1.5" width="29" height="29" fill="none" style="stroke:var(--ix)" stroke-dasharray="2.5 2" stroke-width="1.2"/>`,
  rotate_right:`<rect x="5" y="11" width="14" height="14" fill="${BL}"/><path d="M14 5a12 12 0 0 1 13 13" fill="none" style="stroke:var(--ix)" stroke-width="2"/><path d="M23.5 15.5 27 19l3-3.5" fill="none" style="stroke:var(--ix)" stroke-width="2"/>`,
  list:`<path d="M11 8h17M11 16h17M11 24h17" class="k" stroke-width="2.4"/><circle cx="5.5" cy="8" r="2" fill="${BL}"/><circle cx="5.5" cy="16" r="2" fill="${BL}"/><circle cx="5.5" cy="24" r="2" fill="${BL}"/>`,
  settings:`<circle cx="16" cy="16" r="5" fill="none" style="stroke:var(--ix)" stroke-width="2.4"/><path d="M16 3v5M16 24v5M3 16h5M24 16h5M6.8 6.8l3.5 3.5M21.7 21.7l3.5 3.5M6.8 25.2l3.5-3.5M21.7 10.3l3.5-3.5" class="k" stroke-width="2.4"/>`,
  add:`<path d="M16 6v20M6 16h20" stroke="${BL}" stroke-width="3"/>`,
  logout:`<rect x="3" y="4" width="14" height="24" class="p"/><path d="M13 16h15m-5-5 5 5-5 5" fill="none" stroke="${BL}" stroke-width="2.4"/>`,
};
const xiHTML = k => { const v=XI[k]; if(!v) return ''; return `<svg class="xi" viewBox="0 0 32 32" aria-hidden="true">${typeof v==='function'?v():v}</svg>`; };

/* ================= Ribbon ================= */
const B=(ic,l,a,o={})=>({k:'big',ic,l,a,...o}), S=(ic,l,a,o={})=>({k:'sm',ic,l,a,...o}), I=(ic,l,a,o={})=>({k:'ic',ic,l,a,...o});
const G=(name,...cols)=>({name,cols}), GL=(name,...cols)=>({name,cols,launch:true});
const FONTS=['Aptos Narrow','Calibri','Arial','Segoe UI','Times New Roman','Georgia','Verdana','Courier New','Comic Sans MS'];
const FMTS=[['general','General'],['number','Número'],['currency','Moneda'],['accounting','Contabilidad'],['date','Fecha corta'],['longdate','Fecha larga'],['time','Hora'],['percent','Porcentaje'],['scientific','Científica'],['text','Texto'],['comma','Millares']];
const RIBBON=[
 {id:'home',name:'Inicio',groups:[
  G('Deshacer',[I('undo','Deshacer (Ctrl+Z)','undo'),I('redo','Rehacer (Ctrl+Y)','redo')]),
  GL('Portapapeles',B('content_paste','Pegar','paste',{menu:'paste',split:true,tip:'Pegar (Ctrl+V)'}),[S('content_cut','Cortar','cut',{tip:'Cortar (Ctrl+X)'}),S('content_copy','Copiar','copy',{tip:'Copiar (Ctrl+C)'}),S('format_paint','Copiar formato','painter')]),
  GL('Fuente',[[{k:'sel',id:'fontName',w:118,l:'Fuente',opts:FONTS},{k:'sel',id:'fontSize',w:50,l:'Tamaño de fuente',opts:SIZES},I('text_increase','Aumentar tamaño de fuente','fontUp'),I('text_decrease','Disminuir tamaño de fuente','fontDown')],
            [I('format_bold','Negrita (Ctrl+N)','bold',{tog:'b',txt:'N'}),I('format_italic','Cursiva (Ctrl+K)','italic',{tog:'i',txt:'K',tcls:'i'}),I('format_underlined','Subrayado (Ctrl+S)','underline',{tog:'u',txt:'S',tcls:'u'}),I('strikethrough_s','Tachado','strike',{tog:'st',txt:'abc',tcls:'s'}),I('border_bottom','Borde inferior','bBottom',{menu:'borders',split:true}),I('format_color_fill','Color de relleno','fillColor',{color:'fill',menu:'pal-fill',split:true}),I('format_color_text','Color de fuente','fontColor',{color:'font',menu:'pal-font',split:true})]]),
  GL('Alineación',[[I('vertical_align_top','Alinear en la parte superior','vTop',{tog:'va:top'}),I('vertical_align_center','Alinear en el medio','vMid',{tog:'va:middle'}),I('vertical_align_bottom','Alinear en la parte inferior','vBot',{tog:'va:bottom'}),I('text_rotate_up','Orientación',null,{menu:'orient'})],
                 [I('format_align_left','Alinear a la izquierda','alignL',{tog:'ha:left'}),I('format_align_center','Centrar','alignC',{tog:'ha:center'}),I('format_align_right','Alinear a la derecha','alignR',{tog:'ha:right'}),I('format_indent_decrease','Disminuir sangría','indDec'),I('format_indent_increase','Aumentar sangría','indInc')]],
                [S('wrap_text','Ajustar texto','wrap',{tog:'wrap'}),S('merge','Combinar y centrar',null,{menu:'merge',split:true})]),
  GL('Número',[[{k:'sel',id:'numFmt',w:122,l:'Formato de número',opts:FMTS}],[I('attach_money','Formato de número de contabilidad','fmtCurrency',{menu:'currency',split:true}),I('percent','Estilo porcentual','fmtPercent'),I('','Estilo millares','fmtComma',{x:'comma',txt:'000',tcls:'sm'}),I('decimal_increase','Aumentar decimales','decInc'),I('decimal_decrease','Disminuir decimales','decDec')]]),
  G('Estilos',B('rule','Formato condicional',null,{menu:'condfmt'}),B('table_view','Dar formato como tabla','fmtTable'),B('style','Estilos de celda',null,{menu:'cellstyles'})),
  G('Celdas',B('add_box','Insertar',null,{menu:'insertcells'}),B('disabled_by_default','Eliminar',null,{menu:'deletecells'}),B('format_shapes','Formato',null,{menu:'formatcells',x:'fmtCells'})),
  G('Edición',[S('functions','Autosuma','autosum',{menu:'autosum',split:true}),S('arrow_downward','Rellenar',null,{menu:'fill'}),S('ink_eraser','Borrar',null,{menu:'clear'})],B('filter_list','Ordenar y filtrar',null,{menu:'sort'}),B('search','Buscar y seleccionar',null,{menu:'find'})),
  G('Análisis',B('insights','Analizar datos',null)),
 ]},
 {id:'insert',name:'Insertar',groups:[
  G('Tablas',B('pivot_table_chart','Tabla dinámica',null),B('table_chart','Tablas dinámicas recomendadas',null),B('table','Tabla','fmtTable')),
  G('Ilustraciones',B('image','Imágenes',null),[S('shapes','Formas',null),S('emoji_symbols','Iconos',null),S('view_in_ar','Modelos 3D',null)],[S('account_tree','SmartArt',null),S('screenshot_monitor','Captura',null)]),
  GL('Gráficos',B('insert_chart','Gráficos recomendados',null),[[I('bar_chart','Insertar gráfico de columnas o de barras',null),I('show_chart','Insertar gráfico de líneas o de áreas',null),I('pie_chart','Insertar gráfico circular o de anillos',null)],[I('stacked_bar_chart','Insertar gráfico de jerarquía',null),I('waterfall_chart','Insertar gráfico de cascada',null),I('scatter_plot','Insertar gráfico de dispersión',null)],[I('map','Mapas',null),I('area_chart','Insertar gráfico de áreas',null),I('candlestick_chart','Insertar gráfico de cotizaciones',null)]],B('analytics','Gráfico dinámico',null,{x:'pivotchart'})),
  G('Minigráficos',[S('timeline','Línea',null),S('equalizer','Columna',null),S('swap_vert','Ganancia o pérdida',null)]),
  G('Filtros',[S('filter_alt','Segmentación de datos',null,{x:'slicer'}),S('date_range','Escala de tiempo',null)]),
  G('Vínculos',B('link','Vínculo',null)),
  G('Comentarios',B('add_comment','Comentario',null)),
  G('Texto',B('text_fields','Cuadro de texto',null,{x:'textbox'}),B('web_asset','Encabezado y pie de página',null),[S('format_shapes','WordArt',null,{x:'wordart'}),S('draw','Línea de firma',null),S('widgets','Objeto',null)]),
  G('Símbolos',B('function','Ecuación',null,{x:'equation'}),B('emoji_symbols','Símbolo',null,{x:'omega'})),
 ]},
 {id:'draw',name:'Dibujar',groups:[
  G('Herramientas de dibujo',B('arrow_selector_tool','Seleccionar',null),B('lasso_select','Selección de lazo',null),B('ink_eraser','Borrador',null),B('edit','Bolígrafo',null),B('stylus','Lápiz',null),B('ink_highlighter','Resaltador',null),B('add_circle','Agregar lápiz',null)),
  G('Convertir',B('interests','Entrada de lápiz a forma',null),B('calculate','Entrada de lápiz a matemáticas',null,{x:'inkmath'})),
  G('Reproducir',B('replay','Reproducción de lápiz',null)),
 ]},
 {id:'layout',name:'Disposición de página',groups:[
  G('Temas',B('palette','Temas',null),[S('format_color_fill','Colores',null,{x:'themeColors'}),S('font_download','Fuentes',null),S('auto_awesome','Efectos',null)]),
  GL('Configurar página',B('margin','Márgenes',null),B('screen_rotation','Orientación',null),B('description','Tamaño',null),B('print','Área de impresión',null),B('insert_page_break','Saltos',null),B('wallpaper','Fondo',null),B('title','Imprimir títulos',null)),
  GL('Ajustar área de impresión',[S('width','Ancho: Automático',null),S('height','Alto: Automático',null),S('zoom_out_map','Escala: 100%',null)]),
  GL('Opciones de la hoja',[S('','Líneas de cuadrícula: Ver','toggleView',{chk:'gridlines',arg:'gridlines'}),S('','Encabezados: Ver','toggleView',{chk:'headings',arg:'headings'})]),
  G('Organizar',[S('flip_to_front','Traer adelante',null),S('flip_to_back','Enviar atrás',null),S('select_all','Panel de selección',null)],[S('align_horizontal_center','Alinear',null),S('group_work','Agrupar',null),S('rotate_right','Girar',null)]),
 ]},
 {id:'formulas',name:'Fórmulas',groups:[
  G('Biblioteca de funciones',B('function','Insertar función','insertFn',{x:'fx'}),B('functions','Autosuma','autosum',{menu:'autosum',split:true}),B('history','Usadas recientemente',null,{menu:'fn-recent'}),B('account_balance','Financieras',null,{menu:'fn-'+FIN}),B('help_center','Lógicas',null,{menu:'fn-'+LOGIC}),B('text_fields','Texto',null,{menu:'fn-'+TEXT,x:'fnText'}),B('calendar_month','Fecha y hora',null,{menu:'fn-'+DATE}),B('manage_search','Búsqueda y referencia',null,{menu:'fn-'+LOOK}),B('calculate','Matemáticas y trigonométricas',null,{menu:'fn-'+MATH,x:'fnMath'}),B('more_horiz','Más funciones',null,{menu:'fn-more'})),
  G('Nombres definidos',B('badge','Administrador de nombres',null),[S('label','Asignar nombre',null),S('input','Utilizar en la fórmula',null),S('select_all','Crear desde la selección',null)]),
  G('Auditoría de fórmulas',[S('arrow_right_alt','Rastrear precedentes','tracePrec'),S('keyboard_backspace','Rastrear dependientes',null),S('clear_all','Quitar flechas','removeArrows')],[S('code','Mostrar fórmulas','showFormulas',{tog:'showFormulas',x:'showfx'}),S('error','Comprobación de errores',null),S('troubleshoot','Evaluar fórmula',null)],B('visibility','Ventana Inspección',null)),
  G('Cálculo',B('tune','Opciones para el cálculo',null,{menu:'calcopts'}),[S('calculate','Calcular ahora','calcNow'),S('refresh','Calcular hoja','calcNow')]),
 ]},
 {id:'data',name:'Datos',groups:[
  G('Obtener y transformar datos',B('database','Obtener datos',null),[S('description','De texto/CSV',null,{x:'csv'}),S('language','De la web',null),S('table','De una tabla o rango',null)],[S('schedule','Fuentes recientes',null),S('cable','Conexiones existentes',null)]),
  G('Consultas y conexiones',B('sync','Actualizar todo','calcNow'),[S('list','Consultas y conexiones',null),S('settings','Propiedades',null),S('link','Editar vínculos',null)]),
  G('Tipos de datos',B('trending_up','Cotizaciones',null),B('public','Geografía',null)),
  G('Ordenar y filtrar',[S('north','Ordenar de A a Z','sortAsc'),S('south','Ordenar de Z a A','sortDesc')],B('sort','Ordenar',null),B('filter_alt','Filtro','filterToggle',{tog:'filter'}),[S('filter_alt_off','Borrar','filterClear'),S('refresh','Volver a aplicar',null),S('tune','Avanzadas',null)]),
  G('Herramientas de datos',B('view_week','Texto en columnas',null),[S('bolt','Relleno rápido',null),S('layers_clear','Quitar duplicados',null),S('verified','Validación de datos',null)],[S('merge_type','Consolidar',null),S('hub','Relaciones',null),S('dataset','Administrar modelo de datos',null)]),
  G('Previsión',B('psychology','Análisis de hipótesis',null,{menu:'whatif'}),B('query_stats','Hoja de previsión',null)),
  GL('Esquema',B('add_box','Agrupar',null,{x:'group'}),B('indeterminate_check_box','Desagrupar',null,{x:'ungroup'}),B('functions','Subtotal',null,{x:'subtotal'})),
 ]},
 {id:'review',name:'Revisar',groups:[
  G('Revisión',B('spellcheck','Ortografía',null),[S('menu_book','Sinónimos',null),S('analytics','Estadísticas del libro','wbStats')]),
  G('Accesibilidad',B('accessibility_new','Comprobar accesibilidad',null)),
  G('Conclusiones',B('travel_explore','Búsqueda inteligente',null)),
  G('Idioma',B('translate','Traducir',null)),
  G('Comentarios',B('add_comment','Nuevo comentario',null),[S('delete','Eliminar',null),S('arrow_back','Anterior',null),S('arrow_forward','Siguiente',null)],B('forum','Mostrar comentarios',null)),
  G('Notas',B('sticky_note_2','Notas',null)),
  G('Proteger',B('lock','Proteger hoja',null),B('enhanced_encryption','Proteger libro',null),[S('edit_note','Permitir editar rangos',null),S('lock_open','Dejar de compartir libro',null)]),
  G('Entrada de lápiz',B('visibility_off','Ocultar entrada de lápiz',null)),
 ]},
 {id:'view',name:'Vista',groups:[
  G('Vista Hoja',[S('visibility','Mantener',null,{x:'visibilityKeep'}),S('logout','Salir',null),S('add','Nuevo',null)],[S('settings','Opciones',null)]),
  G('Vistas de libro',B('grid_on','Normal','viewNormal'),B('view_agenda','Ver salt. Pág.',null),B('auto_stories','Diseño de página',null),B('dashboard_customize','Vistas personalizadas',null)),
  G('Mostrar',[S('','Regla',null,{chk:'ruler'}),S('','Líneas de cuadrícula','toggleView',{chk:'gridlines',arg:'gridlines'}),S('','Barra de fórmulas','toggleView',{chk:'formulaBar',arg:'formulaBar'})],[S('','Encabezados','toggleView',{chk:'headings',arg:'headings'})]),
  G('Zoom',B('zoom_in','Zoom',null,{menu:'zoom'}),B('crop_free','100%','zoom100',{x:'zoom100'}),B('center_focus_strong','Ampliar selección','zoomSel')),
  G('Ventana',B('open_in_new','Nueva ventana',null),B('view_quilt','Organizar todo',null),B('ac_unit','Inmovilizar',null,{menu:'freeze'}),[S('splitscreen','Dividir',null),S('visibility_off','Ocultar',null),S('visibility','Mostrar',null,{x:'visibilityKeep'})],[S('compare','Ver en paralelo',null),S('sync_alt','Desplazamiento sincrónico',null),S('restart_alt','Restablecer posición de la ventana',null)],B('swap_horiz','Cambiar ventanas',null)),
  G('Macros',B('code','Macros',null)),
 ]},
 {id:'help',name:'Ayuda',groups:[
  G('Ayuda',B('help','Ayuda',null),B('support_agent','Contactar con soporte técnico',null),B('feedback','Comentarios',null),B('school','Mostrar aprendizaje',null),B('new_releases','Novedades',null)),
  G('Desarrollo',B('code','Guía de desarrollo','devGuide')),
 ]},
];
const MENUS={
  paste:[{ic:'content_paste',l:'Pegar',a:'paste',k:'Ctrl+V'},{ic:'123',l:'Pegar valores',a:'pasteValues'},{ic:'function',x:'fx',l:'Fórmulas',a:'paste'},{ic:'format_paint',l:'Formato',a:'pasteFormats'},'-',{ic:'swap_horiz',l:'Transponer'},{ic:'link',l:'Pegar vínculo'},{ic:'more_horiz',l:'Pegado especial...'}],
  borders:[{ic:'border_bottom',l:'Borde inferior',a:'bBottom'},{ic:'border_top',l:'Borde superior',a:'bTop'},{ic:'border_left',l:'Borde izquierdo',a:'bLeft'},{ic:'border_right',l:'Borde derecho',a:'bRight'},'-',{ic:'border_clear',l:'Sin borde',a:'bNone'},{ic:'border_all',l:'Todos los bordes',a:'bAll'},{ic:'border_outer',l:'Bordes externos',a:'bOut'},{ic:'border_style',l:'Borde de cuadro grueso'},'-',{ic:'edit',l:'Dibujar borde'},{ic:'more_horiz',l:'Más bordes...'}],
  orient:[{ic:'text_rotate_up',l:'Girar texto en sentido contrario a las agujas del reloj'},{ic:'text_rotation_down',l:'Girar texto en el sentido de las agujas del reloj'},{ic:'text_rotate_vertical',l:'Texto vertical'},{ic:'north',l:'Girar texto hacia arriba'},{ic:'south',l:'Girar texto hacia abajo'},'-',{l:'Formato de alineación de celdas'}],
  merge:[{ic:'merge',l:'Combinar y centrar'},{ic:'table_rows',l:'Combinar horizontalmente'},{ic:'select_all',l:'Combinar celdas'},{ic:'call_split',l:'Separar celdas'}],
  currency:[{ic:'attach_money',l:'Contabilidad ($ 1.234,00)',a:'fmtCurrency'},{ic:'payments',l:'Moneda ($1.234,00)',a:'fmtDollar'},'-',{l:'Más formatos de contabilidad...'}],
  condfmt:[{ic:'rule',l:'Resaltar reglas de celdas'},{ic:'leaderboard',l:'Reglas superiores e inferiores'},{ic:'data_usage',l:'Barras de datos'},{ic:'gradient',l:'Escalas de color'},{ic:'sentiment_satisfied',l:'Conjuntos de iconos'},'-',{ic:'add',l:'Nueva regla...'},{ic:'ink_eraser',l:'Borrar reglas'},{ic:'list',l:'Administrar reglas...'}],
  cellstyles:[{h:'Bueno, malo y neutral'},...['Normal','Bueno','Incorrecto','Neutral'].map(n=>({l:n,a:'cellStyle',arg:n})),{h:'Datos y modelo'},...['Cálculo','Entrada','Nota'].map(n=>({l:n,a:'cellStyle',arg:n})),{h:'Títulos y encabezados'},...['Título','Encabezado 1','Total'].map(n=>({l:n,a:'cellStyle',arg:n}))],
  insertcells:[{ic:'add',l:'Insertar celdas...'},{ic:'add_row_below',l:'Insertar filas de hoja'},{ic:'add_column_right',l:'Insertar columnas de hoja'},{ic:'post_add',l:'Insertar hoja',a:'addSheet'}],
  deletecells:[{ic:'remove',l:'Eliminar celdas...'},{ic:'table_rows',l:'Eliminar filas de hoja'},{ic:'view_column',l:'Eliminar columnas de hoja'},{ic:'delete',l:'Eliminar hoja',a:'deleteSheet'}],
  formatcells:[{h:'Tamaño de celda'},{l:'Alto de fila...'},{l:'Autoajustar alto de fila'},{l:'Ancho de columna...'},{l:'Autoajustar ancho de columna',a:'autofit'},{l:'Ancho predeterminado...'},{h:'Organizar hojas'},{l:'Cambiar el nombre de la hoja',a:'renameSheet'},{l:'Mover o copiar hoja...',a:'dupSheet'},{l:'Color de etiqueta'},{h:'Protección'},{l:'Proteger hoja...'},'-',{ic:'format_shapes',x:'fmtCells',l:'Formato de celdas...'}],
  autosum:[{ic:'functions',l:'Suma',a:'autosum',arg:'SUM'},{l:'Promedio',a:'autosum',arg:'AVERAGE'},{l:'Contar números',a:'autosum',arg:'COUNT'},{l:'Máx',a:'autosum',arg:'MAX'},{l:'Mín',a:'autosum',arg:'MIN'},'-',{l:'Más funciones...',a:'insertFn'}],
  fill:[{ic:'south',l:'Hacia abajo',a:'fillDown',k:'Ctrl+J'},{ic:'east',l:'Hacia la derecha',a:'fillRight',k:'Ctrl+D'},{ic:'north',l:'Hacia arriba',a:'fillUp'},{ic:'west',l:'Hacia la izquierda',a:'fillLeft'},'-',{l:'Series...'},{ic:'bolt',l:'Relleno rápido'}],
  clear:[{ic:'ink_eraser',l:'Borrar todo',a:'clearAll'},{l:'Borrar formatos',a:'clearFormats'},{l:'Borrar contenido',a:'clearContents',k:'Supr'},{l:'Borrar comentarios y notas'},{l:'Borrar hipervínculos'}],
  sort:[{ic:'north',l:'Ordenar de A a Z',a:'sortAsc'},{ic:'south',l:'Ordenar de Z a A',a:'sortDesc'},{ic:'sort',l:'Orden personalizado...'},'-',{ic:'filter_alt',l:'Filtro',a:'filterToggle'},{ic:'filter_alt_off',l:'Borrar',a:'filterClear'},{ic:'refresh',l:'Volver a aplicar'}],
  find:[{ic:'search',l:'Buscar...',k:'Ctrl+B'},{ic:'find_replace',l:'Reemplazar...',k:'Ctrl+L'},{ic:'arrow_forward',l:'Ir a...',a:'goto',k:'Ctrl+I'},{l:'Ir a Especial...'},'-',{l:'Fórmulas'},{l:'Comentarios'},{l:'Formato condicional'}],
  calcopts:[{ic:'check',l:'Automático'},{ic:'',l:'Automático excepto en las tablas de datos'},{ic:'',l:'Manual'}],
  zoom:[400,200,150,100,75,50,25].map(z=>({l:z+'%',a:'zoomTo',arg:z})),
  whatif:[{l:'Administrador de escenarios...'},{l:'Buscar objetivo...'},{l:'Tabla de datos...'}],
  freeze:[{ic:'ac_unit',l:'Inmovilizar paneles'},{ic:'table_rows',l:'Inmovilizar fila superior'},{ic:'view_column',l:'Inmovilizar primera columna'}],
};
const CELL_MENU=()=>[{ic:'content_cut',l:'Cortar',a:'cut',k:'Ctrl+X'},{ic:'content_copy',l:'Copiar',a:'copy',k:'Ctrl+C'},{ic:'content_paste',l:'Pegar',a:'paste',k:'Ctrl+V'},{ic:'123',l:'Pegar valores',a:'pasteValues'},'-',
  {ic:'south',l:'Rellenar hacia abajo',a:'fillDown'},{ic:'east',l:'Rellenar hacia la derecha',a:'fillRight'},{ic:'drag_pan',l:'Rellenar con el controlador',a:'fillHandle'},'-',
  {ic:'ink_eraser',l:'Borrar contenido',a:'clearContents'},{ic:'north',l:'Ordenar de A a Z',a:'sortAsc'},{ic:'south',l:'Ordenar de Z a A',a:'sortDesc'},'-',
  {ic:'function',x:'fx',l:'Insertar función...',a:'insertFn'},{ic:'arrow_right_alt',l:'Rastrear precedentes',a:'tracePrec'},{ic:'add_comment',l:'Nuevo comentario'},{ic:'format_shapes',x:'fmtCells',l:'Formato de celdas...'}];
function fnMenu(cat){
  const item=f=>({l:esName(f.name),a:'fn',arg:f.name,sub:f.es&&f.es!==f.name?f.name:''});
  const tail=['-',{ic:'function',x:'fx',l:'Insertar función...',a:'insertFn'}];
  if(cat==='recent') return [...recentFns.map(n=>FN[n]).filter(Boolean).map(item),...tail];
  if(cat==='more') return [{h:STAT},...FN_LIST.filter(f=>f.cat===STAT).map(item),{h:INFO},...FN_LIST.filter(f=>f.cat===INFO).map(item),...tail];
  return [...FN_LIST.filter(f=>f.cat===cat).map(item),...tail];
}
function glyphs(it){
  const svg = xiHTML(it.x||it.ic);
  const base = it.txt ? `<span class="ttxt ${it.tcls||''}">${esc(it.txt)}</span>` : (it.ic?`<span class="ms">${it.ic}</span>`:'');
  if(!svg) return base;
  return base.replace(/^<span class="/,'<span class="hasx ')+svg;
}
function itemHTML(it){
  if(it.k==='sel') return `<select class="rsel" id="${it.id}" style="width:${it.w}px" aria-label="${esc(it.l)}" title="${esc(it.l)}">${it.opts.map(o=>Array.isArray(o)?`<option value="${o[0]}">${esc(o[1])}</option>`:`<option value="${o}">${String(o).replace('.',ST.DEC)}</option>`).join('')}</select>`;
  const tip=it.tip||it.l;
  const attrs=`data-act="${it.a||''}" data-label="${esc(it.l)}"${it.menu?` data-menu="${esc(it.menu)}"`:''}${it.tog?` data-tog="${it.tog}"`:''}${it.chk?` data-chk="${it.chk}"`:''}${it.arg!=null?` data-arg="${esc(it.arg)}"`:''} title="${esc(tip)}" aria-label="${esc(tip)}"`;
  let icon;
  if(it.chk) icon='<span class="ms">check_box_outline_blank</span>';
  else if(it.color) icon=`<span class="cic">${glyphs(it)}<i class="cbar" data-cbar="${it.color}"></i></span>`;
  else icon=glyphs(it);
  const caret = (it.menu && !it.split) ? '<span class="ms dd">expand_more</span>' : '';
  const ddBtn = (it.menu && it.split) ? `<button class="rb dd-btn" data-menu="${esc(it.menu)}" data-label="${esc(it.l)}" title="${esc(it.l)}: más opciones" aria-label="${esc(it.l)}: más opciones"><span class="ms dd">expand_more</span></button>` : '';
  if(it.k==='big') return `<button class="rb big" ${attrs}>${icon}<span class="lbl">${esc(it.l)}${(caret||ddBtn)?'<span class="ms dd">expand_more</span>':''}</span></button>`;
  const btn = it.k==='sm' ? `<button class="rb sm" ${attrs}>${icon}<span class="lbl">${esc(it.l)}</span>${caret}</button>` : `<button class="rb ic" ${attrs}>${icon}${caret}</button>`;
  return ddBtn ? `<span class="split">${btn}${ddBtn}</span>` : btn;
}
function groupHTML(g){
  return `<div class="grp" role="group" aria-label="${esc(g.name)}"><div class="gitems">${g.cols.map(col=>{
    if(!Array.isArray(col)) return itemHTML(col);
    return `<div class="gcol">${col.map(row=>`<div class="grow">${(Array.isArray(row)?row:[row]).map(itemHTML).join('')}</div>`).join('')}</div>`;
  }).join('')}</div><div class="glabel">${esc(g.name)}</div>${g.launch?`<button class="launch" data-act="" data-label="${esc(g.name)}: configuración" title="${esc(g.name)}: configuración" aria-label="${esc(g.name)}: configuración"><svg width="9" height="9" viewBox="0 0 9 9"><path d="M1 1v7h7M3.5 5.5 8 1M8 1H5M8 1v3" fill="none" stroke="currentColor" stroke-width="1"/></svg></button>`:''}</div>`;
}
let activeTab='home';
function renderRibbon(){
  $('#tabs').innerHTML=`<button class="tab file" id="fileTab">Archivo</button>`+RIBBON.map(t=>`<button class="tab${t.id===activeTab?' on':''}" data-tab="${t.id}" role="tab" aria-selected="${t.id===activeTab}">${t.name}</button>`).join('')+
    `<span class="grow"></span><span class="tabs-right"><button data-act="" data-label="Comentarios"><span class="ms">chat_bubble</span><span class="lbl">Comentarios</span></button><button class="share" data-act="" data-label="Compartir"><span class="ms">share</span><span class="lbl">Compartir</span></button></span>`;
  $('#ribbon').innerHTML=RIBBON.map(t=>`<div class="panel" data-panel="${t.id}"${t.id===activeTab?'':' hidden'}>${t.groups.map(groupHTML).join('')}</div>`).join('');
  updateRibbonState();
}
function showTab(id){
  const rb=$('#ribbon');
  if(id===activeTab && !rb.classList.contains('collapsed')){ rb.classList.add('collapsed'); requestAnimationFrame(drawSel); return; }
  activeTab=id; rb.classList.remove('collapsed');
  document.querySelectorAll('.tab[data-tab]').forEach(b=>{ b.classList.toggle('on', b.dataset.tab===id); b.setAttribute('aria-selected', b.dataset.tab===id); });
  document.querySelectorAll('.panel').forEach(p=>p.hidden=p.dataset.panel!==id);
  requestAnimationFrame(drawSel);
}
function updateRibbonState(){
  if(!ST.wb) return;
  const s=activeStyle();
  document.querySelectorAll('[data-tog]').forEach(b=>{
    const t=b.dataset.tog; let on;
    if(t==='showFormulas') on=showFormulas; else if(t==='filter') on=!!(sheet().hiddenRows||[]).length; else if(t.includes(':')){ const [p,v]=t.split(':'); on=s[p]===v; } else on=!!s[t];
    b.classList.toggle('on',on); b.setAttribute('aria-pressed',on);
  });
  document.querySelectorAll('[data-chk]').forEach(b=>{ const on=!!view[b.dataset.chk]; const ic=b.querySelector('.ms'); if(ic) ic.textContent=on?'check_box':'check_box_outline_blank'; b.setAttribute('aria-pressed',on); });
  const fn=$('#fontName'), fs=$('#fontSize'), nf=$('#numFmt');
  if(fn && document.activeElement!==fn) fn.value=s.font||'Aptos Narrow';
  if(fs && document.activeElement!==fs) fs.value=String(s.size||11);
  if(nf && document.activeElement!==nf) nf.value=s.fmt||'general';
  document.querySelectorAll('[data-cbar="fill"]').forEach(x=>x.style.background=lastFill);
  document.querySelectorAll('[data-cbar="font"]').forEach(x=>x.style.background=lastFont);
}

/* ================= Popups ================= */
const pop=$('#popup');
let popItems=[];
function menuIcon(it){ const svg=xiHTML(it.x||it.ic); return `<span class="mic">${it.ic?`<span class="ms${svg?' hasx':''}">${it.ic}</span>`:''}${svg}</span>`; }
function showMenu(items, x, y){
  popItems=items;
  pop.className='popup';
  pop.innerHTML=items.map((it,i)=>{
    if(it==='-') return '<div class="msep"></div>';
    if(it.h) return `<div class="mh">${esc(it.h)}</div>`;
    return `<button class="mi" data-i="${i}" role="menuitem">${menuIcon(it)}<span>${esc(it.l)}</span>${it.k?`<kbd>${esc(it.k)}</kbd>`:it.sub?`<small>${esc(it.sub)}</small>`:''}</button>`;
  }).join('');
  openPopAt(x,y);
}
function openPopAt(x,y){
  pop.hidden=false; pop.style.left='0px'; pop.style.top='0px';
  const w=pop.offsetWidth, h=pop.offsetHeight;
  pop.style.left=clamp(x,8,innerWidth-w-8)+'px'; pop.style.top=(y+h>innerHeight-8 ? Math.max(8,innerHeight-h-8) : y)+'px';
}
function hidePop(){ pop.hidden=true; }
const THEME=['#FFFFFF','#000000','#E8E8E8','#0E2841','#156082','#E97132','#196B24','#0F9ED5','#A02B93','#4EA72E'];
const STD=['#C00000','#FF0000','#FFC000','#FFFF00','#92D050','#00B050','#00B0F0','#0070C0','#002060','#7030A0'];
function mix(hex, t){ const n=parseInt(hex.slice(1),16); const r=n>>16, g=(n>>8)&255, b=n&255; const f=v=> t>=0 ? Math.round(v+(255-v)*t) : Math.round(v*(1+t)); return '#'+[f(r),f(g),f(b)].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase(); }
function showPalette(kind, x, y){
  const rows=[THEME,...[.8,.6,.4,-.25,-.5].map(t=>THEME.map(c=>mix(c,t)))];
  pop.className='popup pal';
  pop.innerHTML=`<h4>Colores del tema</h4><div class="pal-grid">${rows.flat().map(c=>`<button class="sw" style="background:${c}" data-c="${c}" title="${c}" aria-label="${c}"></button>`).join('')}</div><h4 style="margin-top:10px">Colores estándar</h4><div class="pal-grid">${STD.map(c=>`<button class="sw" style="background:${c}" data-c="${c}" title="${c}" aria-label="${c}"></button>`).join('')}</div><button class="mi" data-c=""><span class="ms">${kind==='fill'?'format_color_reset':'format_color_text'}</span><span>${kind==='fill'?'Sin relleno':'Automático'}</span></button>`;
  pop.dataset.act=kind==='fill'?'setFill':'setFont'; popItems=null; openPopAt(x,y);
}
pop.addEventListener('mousedown', e=>e.preventDefault());
pop.addEventListener('click', e=>{
  const sw=e.target.closest('[data-c]');
  if(sw && !popItems){ hidePop(); run(pop.dataset.act,'Color',sw.dataset.c||null); if(isPhone) closePhoneRibbon(); return; }
  const b=e.target.closest('.mi'); if(!b||!popItems) return;
  const it=popItems[+b.dataset.i]; hidePop(); run(it.a, it.l, it.arg);
  if(isPhone) closePhoneRibbon();
});
function openMenuFor(btn){
  const id=btn.dataset.menu; const r=btn.getBoundingClientRect();
  if(id==='pal-fill'||id==='pal-font') return showPalette(id.slice(4), r.left, r.bottom+2);
  const items = id.startsWith('fn-') ? fnMenu(id.slice(3)) : MENUS[id];
  if(!items) return run(null, btn.dataset.label);
  showMenu(items, r.left, r.bottom+2);
}
document.addEventListener('pointerdown', e=>{ if(!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-menu]')) hidePop(); }, true);

let toastTimer=0;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.hidden=true, isPhone?2600:3400); }
$('#toast').addEventListener('click', e=>{ e.currentTarget.hidden=true; });

/* ================= Insert Function dialog ================= */
const dlg=$('#fnDialog'); let dlgSel=null;
$('#fnCat').innerHTML=['Usadas recientemente','Todo',...CATS].map(c=>`<option>${esc(c)}</option>`).join('');
function dlgList(){
  const q=$('#fnSearch').value.trim().toLowerCase(); const cat=$('#fnCat').value; let list;
  if(q){ const words=q.split(/\s+/); list=FN_LIST.filter(f=>words.every(w=>(f.name+' '+(f.es||'')+' '+f.desc).toLowerCase().includes(w))); }
  else if(cat==='Usadas recientemente') list=recentFns.map(n=>FN[n]).filter(Boolean);
  else if(cat==='Todo') list=FN_LIST; else list=FN_LIST.filter(f=>f.cat===cat);
  $('#fnList').innerHTML=list.length ? list.map(f=>`<button class="fni" data-n="${f.name}" role="option">${esc(esName(f.name))}${f.es&&f.es!==f.name?`<small>${esc(f.name)}</small>`:''}</button>`).join('') : '<p class="fdesc" style="padding:6px 8px">Ninguna función coincide. Prueba con otra palabra, como "promedio" o "buscar".</p>';
  dlgPick(list[0]&&list[0].name);
}
function dlgPick(name){
  dlgSel=name||null; const f=name&&FN[name];
  document.querySelectorAll('.fni').forEach(b=>b.classList.toggle('on', b.dataset.n===name));
  $('#fnSig').textContent=f?`${esName(f.name)}(${fnArgs(f)})`:''; $('#fnDesc').textContent=f?f.desc:'';
  $('#fnEs').textContent=f&&f.es&&f.es!==f.name?`Nombre en Excel en inglés: ${f.name}`:'';
}
function openFnDialog(q){ hidePop(); $('#fnSearch').value=q||''; $('#fnCat').value=q?'Todo':'Usadas recientemente'; dlg.hidden=false; dlgList(); if(!document.body.classList.contains('touch')) $('#fnSearch').focus(); }
function closeFnDialog(){ dlg.hidden=true; }
$('#fnList').addEventListener('click', e=>{ const b=e.target.closest('.fni'); if(b) dlgPick(b.dataset.n); });
$('#fnList').addEventListener('dblclick', e=>{ const b=e.target.closest('.fni'); if(b) insertFunction(b.dataset.n); });
$('#fnCat').addEventListener('change', ()=>{ $('#fnSearch').value=''; dlgList(); });
$('#fnGo').addEventListener('click', dlgList);
$('#fnSearch').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); dlgList(); } });
$('#fnSearch').addEventListener('input', dlgList);
$('#fnOk').addEventListener('click', ()=>{ if(dlgSel) insertFunction(dlgSel); else closeFnDialog(); });
dlg.addEventListener('click', e=>{ if(e.target===dlg || e.target.closest('[data-close]')) closeFnDialog(); });

/* ================= Backstage (Archivo) ================= */
const bs=$('#backstage');
function openBackstage(v){ if(edit && !commitEdit(0,0)) return; bs.hidden=false; showBs(v||'home'); }
function closeBackstage(){ bs.hidden=true; }
const skinPicker=()=>`<div class="skins">
  <button class="skin${prefs.skin==='excel'?' on':''}" data-skin="excel"><span class="pv"><i style="height:14px;background:#107c41"></i><i style="height:12px;background:#f0f0f0"></i><i style="flex:1;background:#fbfbfb;display:flex;gap:6px;padding:8px"><svg width="22" height="22" viewBox="0 0 32 32">${XI.content_paste}</svg><svg width="22" height="22" viewBox="0 0 32 32">${XI.rule}</svg><svg width="22" height="22" viewBox="0 0 32 32">${XI.table_view}</svg></i></span><span class="n">Excel (íconos a color)</span></button>
  <button class="skin${prefs.skin==='white'?' on':''}" data-skin="white"><span class="pv"><i style="height:14px;background:#fff;border-bottom:1px solid #e8e8e8"></i><i style="height:12px;background:#fff"></i><i style="flex:1;background:#fff;display:flex;gap:6px;padding:8px;color:#3b3b3b"><span class="ms" style="font-size:22px">content_paste</span><span class="ms" style="font-size:22px">rule</span><span class="ms" style="font-size:22px">table_view</span></i></span><span class="n">Blanco (minimalista)</span></button></div>`;
const regionPicker=()=>`<div class="opt"><label for="regionSel">Separador decimal y de argumentos</label><select id="regionSel"><option value="auto"${prefs.region==='auto'?' selected':''}>Automático según el equipo (${autoComma?'coma':'punto'})</option><option value="comma"${prefs.region==='comma'?' selected':''}>Coma decimal: 1.234,56 · =SUMA(A1;B1)</option><option value="dot"${prefs.region==='dot'?' selected':''}>Punto decimal: 1,234.56 · =SUMA(A1,B1)</option></select><small>Elige el mismo que usa el Excel de tus alumnos. España y gran parte de Sudamérica usan coma decimal; México y Centroamérica usan punto.</small></div>`;
function showBs(v){
  document.querySelectorAll('#bsNav [data-bs]').forEach(b=>b.classList.toggle('on', b.dataset.bs===v));
  const body=$('#bsBody'); const hr=new Date().getHours(); const greet=hr<12?'Buenos días':hr<19?'Buenas tardes':'Buenas noches';
  const tiles=`<div class="tiles"><button class="tile" data-bsact="blank"><span class="thumb"><span class="ms">add</span></span><span>Libro en blanco</span></button><button class="tile" data-bsact="sample"><span class="thumb"><span class="ms">school</span></span><span>Libro de práctica</span></button></div>`;
  if(v==='home'||v==='new') body.innerHTML=`<h1>${v==='home'?greet:'Nuevo'}</h1><h2>Nuevo</h2>${tiles}<h2>Recientes</h2><table class="recent"><tbody><tr><td><span class="ms" style="color:var(--brand-fg)">grid_on</span></td><td>${esc(ST.wb.name||'Libro1')}</td><td style="color:var(--text-2)">Este navegador · Abierto ahora</td></tr></tbody></table>`;
  else if(v==='info'){ let cells=0,f=0; for(const sh of ST.wb.sheets) for(const k in sh.cells){ const x=sh.cells[k].v; if(x){ cells++; if(x[0]==='=') f++; } }
    body.innerHTML=`<h1>Información</h1><h2>${esc(ST.wb.name||'Libro1')}</h2><div class="stat-list"><span>Hojas</span><b>${ST.wb.sheets.length}</b><span>Celdas con datos</span><b>${cells}</b><span>Fórmulas</span><b>${f}</b><span>Guardado</span><b>${autosave?'Automático, en este navegador':'El autoguardado está desactivado'}</b></div><p>Tu libro se guarda solo en este navegador. Si borras los datos del sitio, se pierde.</p>`; }
  else if(v==='account') body.innerHTML=`<h1>Cuenta</h1><h2>Tema de Office</h2>${skinPicker()}<p>El tema Excel imita la cinta de opciones real, con íconos a color para que tus alumnos ubiquen los botones a simple vista. El tema Blanco es más sobrio.</p>`;
  else if(v==='options') body.innerHTML=`<h1>Opciones</h1><h2>General</h2><div class="opt"><label>Tema de Office</label>${skinPicker()}</div><h2>Fórmulas</h2>${regionPicker()}`;
  else if(v==='dev'){ const n=devCounts();
    body.innerHTML=`<h1>Desarrollo</h1>
<p>Resumen para habilitar botones de la cinta. La guía completa, con el código paso a paso, está en el archivo <code>GUIA-DESARROLLO.md</code>, junto a <code>gridlab.html</code> e <code>index.html</code>.</p>
<h2>Estado de la cinta</h2>
<p>${n.done} de ${n.total} botones tienen una función real. El resto muestra el aviso "todavía no está disponible". Los menús desplegables también mezclan opciones reales y simuladas.</p>
<button class="btn" data-dev="na">${document.body.classList.contains('show-na')?'Dejar de resaltar':'Resaltar'} los botones sin función</button>
<h2>Cómo habilitar un botón</h2>
<ol class="devlist">
<li>Abre <code>gridlab.html</code> y busca el texto del botón dentro de <code>const RIBBON</code>. Por ejemplo: <code>B('filter_alt','Filtro',null)</code>.</li>
<li>Cambia el tercer valor (<code>null</code>) por el nombre de tu acción: <code>B('filter_alt','Filtro','miFiltro')</code>.</li>
<li>Escribe la función que hace el trabajo. Si modifica datos, llama primero a <code>pushUndo()</code> (para Ctrl+Z) y al final a <code>changed()</code> (recalcula, redibuja y guarda).</li>
<li>Registra la acción en <code>const ACTIONS</code>: <code>miFiltro: ()=>miFiltro(),</code></li>
<li>Si el botón queda "presionado" (como Negrita), agrega <code>{tog:'clave'}</code> y resuelve esa clave en <code>updateRibbonState()</code>.</li>
<li>Si es un menú, agrega o edita la lista en <code>const MENUS</code>: cada opción es <code>{ic:'icono', l:'Texto', a:'accion'}</code>.</li>
<li>Prueba en PC y en teléfono, y vuelve a generar <code>index.html</code> (los pasos están en la guía).</li>
</ol>
<h2>Ejemplo real: Filtro (Datos &gt; Filtro)</h2>
<p>Ya funciona: selecciona una celda con datos y pulsa Filtro. Solo quedan visibles las filas con el mismo valor en esa columna. Vuelve a pulsarlo o usa Borrar para quitarlo. Este es el código que lo hace:</p>
<pre>function filterToggle(){
  const sh = sheet();
  if ((sh.hiddenRows||[]).length) return filterClear();
  const R = region(sel.ar, sel.ac);        // tabla alrededor de la celda activa
  const target = cellValue(ST.cur, sel.ar, sel.ac);
  pushUndo();                              // permite Ctrl+Z
  sh.hiddenRows = [];
  for (let r = R.r1 + 1; r &lt;= R.r2; r++)   // la fila R.r1 es el encabezado
    if (cmp(cellValue(ST.cur, r, sel.ac), target) !== 0) sh.hiddenRows.push(r);
  changed();                               // redibuja y guarda
}</pre>
<h2>Herramientas internas útiles</h2>
<ul class="devlist">
<li><code>rng()</code>: rango seleccionado <code>{r1,c1,r2,c2}</code>. <code>sel.ar</code>/<code>sel.ac</code>: celda activa.</li>
<li><code>cellValue(hoja, fila, col)</code>: valor calculado. <code>setRaw(fila, col, texto)</code>: escribe como si el usuario tecleara.</li>
<li><code>eachSel((fila,col)=>{...})</code>: recorre la selección. <code>styleOf(fila,col)</code>: estilo editable de una celda.</li>
<li><code>region(fila,col)</code>: tabla contigua. <code>toast('mensaje')</code>: aviso breve en pantalla.</li>
<li><code>def(...)</code>: agrega una función de fórmula nueva (ver la guía).</li>
</ul>`; }
  else if(v==='save'){ ACTIONS.save(); closeBackstage(); }
  else if(v==='close'){ closeBackstage(); }
  else { const title={open:'Abrir',saveas:'Guardar como',print:'Imprimir',share:'Compartir',export:'Exportar'}[v]||v;
    body.innerHTML=`<h1>${esc(title)}</h1><p>"${esc(title)}" todavía no está disponible en este simulador. Tu trabajo se guarda solo en este navegador mientras el autoguardado esté activado.</p>`; }
}
$('#bsNav').addEventListener('click', e=>{ const b=e.target.closest('[data-bs]'); if(!b) return; if(b.dataset.bs==='back') return closeBackstage(); showBs(b.dataset.bs); });
$('#bsBody').addEventListener('click', e=>{
  const t=e.target.closest('[data-bsact]'); if(t) return newWorkbook(t.dataset.bsact==='sample');
  if(e.target.closest('[data-dev="na"]')){ const on=document.body.classList.toggle('show-na'); closeBackstage(); toast(on?'Los botones sin función tienen ahora un borde rojo punteado.':'Ya no se resaltan los botones sin función.'); return; }
  const s=e.target.closest('[data-skin]'); if(s){ setSkin(s.dataset.skin); document.querySelectorAll('#bsBody .skin').forEach(x=>x.classList.toggle('on', x.dataset.skin===prefs.skin)); }
});
$('#bsBody').addEventListener('change', e=>{ if(e.target.id==='regionSel'){ setRegion(e.target.value); toast(`Separador de argumentos: "${SEP()}" · decimal: "${ST.DEC}"`); } });

/* ================= Sheet tabs ================= */
const tabsEl=$('#sheetTabs');
function renderTabs(){ const ps=$('#pbSheet'); if(ps) ps.textContent=sheet().name; tabsEl.innerHTML=ST.wb.sheets.map((s,i)=>`<button class="stab${i===ST.cur?' on':''}" data-i="${i}">${esc(s.name)}</button>`).join(''); const on=tabsEl.querySelector('.on'); if(on) on.scrollIntoView({block:'nearest',inline:'nearest'}); }
function switchSheet(i){
  if(i===ST.cur || i<0 || i>=ST.wb.sheets.length) return;
  if(edit && !commitEdit(0,0)) return;
  sheet().sel={...sel}; ST.cur=i; sel={...(sheet().sel||{ar:0,ac:0,fr:0,fc:0})};
  traceOn=false; refLayer.innerHTML=''; afterStructure(); scroller.scrollTo(0,0); ensureVisible(sel.ar,sel.ac);
}
function startRename(i){
  const b=tabsEl.querySelector(`[data-i="${i}"]`); if(!b) return;
  b.innerHTML=`<input value="${esc(ST.wb.sheets[i].name)}" aria-label="Nombre de la hoja" maxlength="31">`;
  const inp=b.querySelector('input'); inp.focus(); inp.select();
  let done=false; const finish=ok=>{ if(done) return; done=true; if(ok) renameSheet(i, inp.value); renderTabs(); };
  inp.addEventListener('keydown', e=>{ e.stopPropagation(); if(e.key==='Enter') finish(true); if(e.key==='Escape') finish(false); });
  inp.addEventListener('blur', ()=>finish(true));
  inp.addEventListener('click', e=>e.stopPropagation());
}
tabsEl.addEventListener('click', e=>{ const b=e.target.closest('.stab'); if(b && !b.querySelector('input')) switchSheet(+b.dataset.i); });
tabsEl.addEventListener('dblclick', e=>{ const b=e.target.closest('.stab'); if(b) startRename(+b.dataset.i); });
tabsEl.addEventListener('contextmenu', e=>{ const b=e.target.closest('.stab'); if(!b) return; e.preventDefault(); switchSheet(+b.dataset.i);
  showMenu([{ic:'post_add',l:'Insertar hoja',a:'addSheet'},{ic:'edit',l:'Cambiar nombre',a:'renameSheet'},{ic:'content_copy',l:'Mover o copiar...',a:'dupSheet'},{ic:'delete',l:'Eliminar',a:'deleteSheet'},'-',{ic:'palette',l:'Color de pestaña'},{ic:'lock',l:'Proteger hoja...'}], e.clientX, e.clientY-10); });
$('#addSheet').addEventListener('click', ()=>{ if(edit && !commitEdit(0,0)) return; addSheet(); });
$('#tabPrev').addEventListener('click', ()=>switchSheet(ST.cur-1));
$('#tabNext').addEventListener('click', ()=>switchSheet(ST.cur+1));

/* ================= Pointer interaction ================= */
let drag=null, tap=null, touchUI=matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', touchUI);
document.addEventListener('pointerdown', e=>{ const t=e.pointerType!=='mouse'; if(t!==touchUI){ touchUI=t; document.body.classList.toggle('touch',t); drawSel(); } }, true);
scroller.addEventListener('pointerdown', e=>{
  if(e.button>0) return;
  if(e.target.classList.contains('rsz')) return startResize(e);
  if(e.target===handle) return startHandle(e);
  if(e.target===ed) return;
  const th=e.target.closest('th'); if(th) return headerDown(th,e);
  const p=cellFromEl(e.target); if(!p) return;
  const touch=e.pointerType!=='mouse';
  if(edit && canPoint()){
    e.preventDefault();
    if(touch) tap={x:e.clientX,y:e.clientY,p,point:true};
    else { drag={type:'point', r:p.r, c:p.c}; insertRef(A(p.r,p.c)); }
    return;
  }
  if(touch){
    tap={x:e.clientX,y:e.clientY,p};
    tap.timer=setTimeout(()=>{ if(!tap) return; const q=tap.p; tap=null; if(edit && !commitEdit(0,0)) return; const R=rng(); if(q.r<R.r1||q.r>R.r2||q.c<R.c1||q.c>R.c2) select(q.r,q.c); showMenu(CELL_MENU(), e.clientX, e.clientY+8); }, 560);
    return;
  }
  if(edit){ if(!commitEdit(0,0)){ e.preventDefault(); return; } }
  e.preventDefault();
  if(document.activeElement && document.activeElement!==document.body) document.activeElement.blur();
  select(p.r,p.c,e.shiftKey); drag={type:'sel'};
});
scroller.addEventListener('dblclick', e=>{
  if(e.target.classList.contains('rsz')){ const c=e.target.parentNode.cellIndex-1; sel={ar:sel.ar,ac:c,fr:sel.fr,fc:c}; autofit(); return; }
  if(e.target===handle){ const R=rng(); let n=0; if(R.c1>0){ while(R.r2+n+1<ROWS && hasContent(R.r2+n+1,R.c1-1)) n++; } doFill(R,'down',n); return; }
  const p=cellFromEl(e.target); if(!p || edit) return;
  startEdit(editText(sheet().cells[A(p.r,p.c)]), 'edit');
});
scroller.addEventListener('contextmenu', e=>{
  e.preventDefault(); if(touchUI) return;
  const p=cellFromEl(e.target); if(!p) return;
  if(edit && !commitEdit(0,0)) return;
  const R=rng(); if(p.r<R.r1||p.r>R.r2||p.c<R.c1||p.c>R.c2) select(p.r,p.c);
  showMenu(CELL_MENU(), e.clientX, e.clientY);
});
function headerDown(th,e){
  if(edit && !commitEdit(0,0)) return;
  e.preventDefault(); const mouse=e.pointerType==='mouse';
  if(th.classList.contains('corner')){ sel={ar:0,ac:0,fr:ROWS-1,fc:COLS-1}; onSelChange(); return; }
  if(th.classList.contains('ch')){ const c=th.cellIndex-1; if(e.shiftKey){ sel.ar=0; sel.fr=ROWS-1; sel.fc=c; } else sel={ar:0,ac:c,fr:ROWS-1,fc:c}; if(mouse) drag={type:'col'}; }
  else if(th.classList.contains('rh')){ const r=th.parentNode.sectionRowIndex; if(e.shiftKey){ sel.ac=0; sel.fc=COLS-1; sel.fr=r; } else sel={ar:r,ac:0,fr:r,fc:COLS-1}; if(mouse) drag={type:'row'}; }
  onSelChange();
}
function startResize(e){
  e.preventDefault(); e.stopPropagation();
  const c=e.target.parentNode.cellIndex-1; pushUndo();
  drag={type:'resize', c, x0:e.clientX, w0:colW(c)};
}
function startHandle(e){
  e.preventDefault();
  if(e.pointerType==='mouse' || fillMode) drag={type:'fill', src:rng()};
  else drag={type:'ext'};
  try{ handle.setPointerCapture(e.pointerId); }catch(err){}
}
function autoScroll(x,y){
  const r=scroller.getBoundingClientRect(); const m=24;
  if(y>r.bottom-m) scroller.scrollTop+=18; else if(y<r.top+m+20) scroller.scrollTop-=18;
  if(x>r.right-m) scroller.scrollLeft+=18; else if(x<r.left+m+30) scroller.scrollLeft-=18;
}
window.addEventListener('pointermove', e=>{
  if(tap && Math.hypot(e.clientX-tap.x, e.clientY-tap.y)>10){ clearTimeout(tap.timer); tap=null; }
  if(!drag) return;
  if(drag.type==='resize'){ const w=Math.max(12, Math.round(drag.w0+(e.clientX-drag.x0)/(zoom/100))); sheet().colW[drag.c]=w; applyColWidths(); drawSel(); if(edit) positionEditor(); return; }
  autoScroll(e.clientX,e.clientY);
  if(drag.type==='col'||drag.type==='row'){ const th=document.elementFromPoint(e.clientX,e.clientY); const h=th&&th.closest('th'); if(!h) return;
    if(drag.type==='col' && h.classList.contains('ch')){ sel.fc=h.cellIndex-1; sel.fr=ROWS-1; onSelChange(); }
    if(drag.type==='row' && h.classList.contains('rh')){ sel.fr=h.parentNode.sectionRowIndex; sel.fc=COLS-1; onSelChange(); }
    return; }
  const p=cellAt(e.clientX,e.clientY); if(!p) return;
  if(drag.type==='sel' || drag.type==='ext'){ if(p.r!==sel.fr||p.c!==sel.fc) select(p.r,p.c,true); }
  else if(drag.type==='point'){ const t=drag.r===p.r&&drag.c===p.c ? A(p.r,p.c) : A(Math.min(drag.r,p.r),Math.min(drag.c,p.c))+':'+A(Math.max(drag.r,p.r),Math.max(drag.c,p.c)); insertRef(t); }
  else if(drag.type==='fill'){
    const R=drag.src; const down=p.r-R.r2, up=R.r1-p.r, right=p.c-R.c2, left=R.c1-p.c;
    const best=Math.max(down,up,right,left);
    if(best<=0){ fillPrev.hidden=true; drag.dir=null; return; }
    let T2;
    if(best===down){ drag.dir='down'; drag.n=down; T2={r1:R.r1,c1:R.c1,r2:p.r,c2:R.c2}; }
    else if(best===up){ drag.dir='up'; drag.n=up; T2={r1:p.r,c1:R.c1,r2:R.r2,c2:R.c2}; }
    else if(best===right){ drag.dir='right'; drag.n=right; T2={r1:R.r1,c1:R.c1,r2:R.r2,c2:p.c}; }
    else { drag.dir='left'; drag.n=left; T2={r1:R.r1,c1:p.c,r2:R.r2,c2:R.c2}; }
    placeRange(fillPrev,T2);
  }
});
window.addEventListener('pointerup', ()=>{
  if(tap){
    clearTimeout(tap.timer); const p=tap.p, pt=tap.point; tap=null;
    if(pt && edit){ insertRef(A(p.r,p.c)); }
    else {
      if(edit && !commitEdit(0,0)) return;
      if(p.r===sel.ar && p.c===sel.ac && sel.ar===sel.fr && sel.ac===sel.fc && !painter){ startEdit(editText(sheet().cells[A(p.r,p.c)]),'edit'); }
      else { select(p.r,p.c); if(painter) applyPainter(); }
    }
  }
  if(!drag) return;
  const d=drag; drag=null;
  if(d.type==='resize'){ save(); return; }
  if(d.type==='fill'){ fillPrev.hidden=true; if(d.dir) doFill(d.src, d.dir, d.n); fillMode=false; drawSel(); return; }
  if(d.type==='sel' && painter) applyPainter();
});
window.addEventListener('pointercancel', ()=>{ if(tap){ clearTimeout(tap.timer); tap=null; } if(drag&&drag.type==='fill') fillPrev.hidden=true; drag=null; });

/* ribbon + titlebar clicks */
$('#tabs').addEventListener('click', e=>{
  const t=e.target.closest('[data-tab]'); if(t) return showTab(t.dataset.tab);
  if(e.target.closest('#fileTab')) return openBackstage('home');
  const b=e.target.closest('[data-act]'); if(b) run(b.dataset.act, b.dataset.label);
});
const ribbonEl=$('#ribbon');
ribbonEl.addEventListener('mousedown', e=>{ if(e.target.closest('button')) e.preventDefault(); });
ribbonEl.addEventListener('click', e=>{
  const b=e.target.closest('button.rb, button.launch'); if(!b) return;
  if(b.dataset.menu && (b.classList.contains('dd-btn') || !b.dataset.act || e.target.closest('.dd'))) return openMenuFor(b);
  run(b.dataset.act, b.dataset.label, b.dataset.arg);
  if(isPhone) closePhoneRibbon();
});
ribbonEl.addEventListener('change', e=>{
  const s=e.target; if(!s.matches('select')) return;
  if(s.id==='fontName') setStyle('font', s.value==='Aptos Narrow'?null:s.value);
  if(s.id==='fontSize') setStyle('size', +s.value===11?null:+s.value);
  if(s.id==='numFmt'){ pushUndo(); eachSel((r,c)=>{ const st=styleOf(r,c); if(s.value==='general') delete st.fmt; else st.fmt=s.value; delete st.dec; }); compact(); changed(); }
  s.blur();
});
document.querySelectorAll('.titlebar [data-act], .status [data-act]').forEach(b=>{ b.addEventListener('mousedown', e=>e.preventDefault()); b.addEventListener('click', ()=>run(b.dataset.act, b.dataset.label)); });
$('#autosave').addEventListener('click', e=>{ autosave=!autosave; e.currentTarget.classList.toggle('on',autosave); e.currentTarget.setAttribute('aria-checked',autosave); $('#saveState').textContent=autosave?'· Guardado en este navegador':'· Autoguardado desactivado'; if(autosave) save(); });
$('#search').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); const q=e.target.value; e.target.value=''; e.target.blur(); openFnDialog(q); } if(e.key==='Escape') e.target.blur(); });

/* mobile formula keys */
const keysEl=$('#keys');
keysEl.addEventListener('mousedown', e=>e.preventDefault());
keysEl.addEventListener('pointerdown', e=>{ if(e.target.closest('button')) e.preventDefault(); });
keysEl.addEventListener('click', e=>{
  const b=e.target.closest('button'); if(!b||!edit) return; const k=b.dataset.k;
  if(k==='gridkb') return setNativeKb(false);
  if(k==='ok') return commitEdit(1,0); if(k==='esc') return cancelEdit(); if(k==='fx') return openFnDialog();
  insertText(k==='sep' ? SEP() : k);
});

/* name box */
nameBox.addEventListener('focus', ()=>nameBox.select());
nameBox.addEventListener('keydown', e=>{
  e.stopPropagation();
  if(e.key==='Escape'){ nameBox.value=A(sel.ar,sel.ac); nameBox.blur(); return; }
  if(e.key!=='Enter') return; e.preventDefault();
  const R=parseRangeText(nameBox.value.replace(/\s/g,''));
  if(!R){ toast('Escribe una celda o un rango, por ejemplo B4 o A1:C10.'); return; }
  if(edit && !commitEdit(0,0)) return;
  sel={ar:R.r1,ac:R.c1,fr:R.r2,fc:R.c2}; nameBox.blur(); onSelChange(); ensureVisible(R.r1,R.c1);
});
nameBox.addEventListener('blur', ()=>{ nameBox.value=A(sel.ar,sel.ac); });

/* zoom */
$('#zoomRange').addEventListener('input', e=>setZoom(+e.target.value));
$('#zoomIn').addEventListener('click', ()=>setZoom(Math.ceil((zoom+1)/10)*10));
$('#zoomOut').addEventListener('click', ()=>setZoom(Math.floor((zoom-1)/10)*10));
scroller.addEventListener('wheel', e=>{ if(e.ctrlKey){ e.preventDefault(); setZoom(zoom*(e.deltaY<0?1.1:0.9)); } }, {passive:false});

/* ================= Keyboard (Spanish Excel shortcuts) ================= */
function jump(r,c,dr,dc){
  const inb=(y,x)=>y>=0&&y<ROWS&&x>=0&&x<COLS; let nr=r, nc=c;
  if(hasContent(r,c) && inb(r+dr,c+dc) && hasContent(r+dr,c+dc)){ while(inb(nr+dr,nc+dc) && hasContent(nr+dr,nc+dc)){ nr+=dr; nc+=dc; } }
  else { nr+=dr; nc+=dc; while(inb(nr,nc) && !hasContent(nr,nc)){ nr+=dr; nc+=dc; } if(!inb(nr,nc)){ nr-=dr; nc-=dc; } }
  return {r:clamp(nr,0,ROWS-1), c:clamp(nc,0,COLS-1)};
}
function move(dr,dc,extend,ctrl){
  const base=extend?{r:sel.fr,c:sel.fc}:{r:sel.ar,c:sel.ac};
  const t=ctrl?jump(base.r,base.c,dr,dc):{r:base.r+dr,c:base.c+dc};
  if(dr){ const h=hiddenSet(); while(h.has(t.r) && t.r+dr>=0 && t.r+dr<ROWS) t.r+=dr; }
  select(t.r,t.c,extend); ensureVisible(clamp(t.r,0,ROWS-1),clamp(t.c,0,COLS-1));
}
function moveInSelection(dr,dc){
  const R=rng(); if(R.r1===R.r2&&R.c1===R.c2) return move(dr,dc,false,false);
  let r=sel.ar, c=sel.ac;
  if(dr){ r+=dr; if(r>R.r2){ r=R.r1; c=c+1>R.c2?R.c1:c+1; } if(r<R.r1){ r=R.r2; c=c-1<R.c1?R.c2:c-1; } }
  else { c+=dc; if(c>R.c2){ c=R.c1; r=r+1>R.r2?R.r1:r+1; } if(c<R.c1){ c=R.c2; r=r-1<R.r1?R.r2:r-1; } }
  sel.ar=r; sel.ac=c; onSelChange(); ensureVisible(r,c);
}
document.addEventListener('keydown', e=>{
  const t=e.target;
  if(e.altKey && (e.key==='q'||e.key==='Q')){ e.preventDefault(); $('#search').focus(); return; }
  if(t===ed || t===fbar){ if(edit) editKey(e); return; }
  if(!dlg.hidden){ if(e.key==='Escape') closeFnDialog(); return; }
  if(!bs.hidden){ if(e.key==='Escape') closeBackstage(); return; }
  if(t.closest && t.closest('input,select,textarea')) return;
  if(!pop.hidden && e.key==='Escape'){ hidePop(); return; }
  if(edit){ edit.input.focus(); editKey(e); return; }
  const k=e.key, ctrl=e.ctrlKey||e.metaKey;
  const dirs={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};
  if(dirs[k]){ e.preventDefault(); move(...dirs[k], e.shiftKey, ctrl); return; }
  if(ctrl){
    const l=k.toLowerCase();
    const selectAll=()=>{ sel={ar:0,ac:0,fr:ROWS-1,fc:COLS-1}; onSelChange(); };
    const map={z:undo,y:redo,n:()=>toggleStyle('b'),k:()=>toggleStyle('i'),s:()=>toggleStyle('u'),e:selectAll,a:selectAll,
      '`':ACTIONS.showFormulas, g:ACTIONS.save, j:()=>fillDir('down'), d:()=>fillDir('right'), i:ACTIONS.goto,
      home:()=>{ select(0,0); ensureVisible(0,0); }, end:()=>{ let mr=0,mc=0; for(const key in sheet().cells){ const p=parseA(key); if(p&&hasContent(p.r,p.c)){ mr=Math.max(mr,p.r); mc=Math.max(mc,p.c); } } select(mr,mc); ensureVisible(mr,mc); }};
    if(map[l]){ e.preventDefault(); map[l](); }
    return;
  }
  if(e.altKey && k==='='){ e.preventDefault(); autosum('SUM'); return; }
  switch(k){
    case 'Enter': e.preventDefault(); moveInSelection(e.shiftKey?-1:1,0); return;
    case 'Tab': e.preventDefault(); moveInSelection(0,e.shiftKey?-1:1); return;
    case 'Delete': e.preventDefault(); clearCells('contents'); return;
    case 'Backspace': e.preventDefault(); startEdit('','enter'); return;
    case 'F2': e.preventDefault(); startEdit(editText(sheet().cells[A(sel.ar,sel.ac)]),'edit'); return;
    case 'Escape': if(clip){ clip=null; drawSel(); } if(painter){ painter=null; document.body.classList.remove('painting'); } return;
    case 'Home': e.preventDefault(); select(sel.ar,0); ensureVisible(sel.ar,0); return;
    case 'PageDown': e.preventDefault(); move(Math.max(1,Math.floor(scroller.clientHeight/22)-1),0,e.shiftKey); return;
    case 'PageUp': e.preventDefault(); move(-Math.max(1,Math.floor(scroller.clientHeight/22)-1),0,e.shiftKey); return;
  }
  if(k.length===1 && !e.altKey){ e.preventDefault(); startEdit(k,'enter'); }
});
document.addEventListener('copy', e=>{ if(edit || (e.target.closest && e.target.closest('input,textarea'))) return; e.preventDefault(); e.clipboardData.setData('text/plain', copySel(false)); });
document.addEventListener('cut', e=>{ if(edit || (e.target.closest && e.target.closest('input,textarea'))) return; e.preventDefault(); e.clipboardData.setData('text/plain', copySel(true)); });
document.addEventListener('paste', e=>{
  if(edit || (e.target.closest && e.target.closest('input,textarea'))) return;
  e.preventDefault(); const text=(e.clipboardData||window.clipboardData).getData('text/plain')||'';
  if(clip && (!text || text.replace(/\r/g,'')===lastClipText)) return pasteClip();
  if(text) pasteText(text); else pasteClip();
});
window.addEventListener('resize', ()=>{ hidePop(); if(edit){ positionEditor(); positionPopups(); } });
scroller.addEventListener('scroll', ()=>{ if(edit) positionPopups(); }, {passive:true});

/* ================= Phone mode: compact layout, floating ribbon, GridLab keyboard ================= */
const phoneMQ=matchMedia('(pointer: coarse) and (max-height: 540px), (pointer: coarse) and (max-width: 760px), (hover: none) and (max-height: 540px)');
/* keep body.rb-open in sync with the ribbon, so the tabs overlay shows only while it is open */
new MutationObserver(()=>document.body.classList.toggle('rb-open', !$('#ribbon').classList.contains('collapsed'))).observe($('#ribbon'), {attributes:true, attributeFilter:['class']});
const kbEl=$('#kb'), kbTop=$('#kbTop'), kbMain=$('#kbMain'), kbSide=$('#kbSide');
function closePhoneRibbon(){ $('#ribbon').classList.add('collapsed'); }
function setInputMode(){ const im=(isPhone && !nativeKb) ? 'none' : 'text'; ed.setAttribute('inputmode',im); fbar.setAttribute('inputmode',im); }
function applyPhone(){
  const was=isPhone; isPhone=phoneMQ.matches;
  document.body.classList.toggle('phone', isPhone);
  setInputMode();
  if(isPhone) closePhoneRibbon(); else $('#ribbon').classList.remove('collapsed');
  if(was!==isPhone || !applyPhone.done) setZoom(isPhone ? (prefs.zoomPhone||85) : (prefs.zoomDesk||zoom||100));
  applyPhone.done=true;
  requestAnimationFrame(()=>{ drawSel(); if(edit){ positionEditor(); ensureVisible(edit.r,edit.c); } });
}
phoneMQ.addEventListener ? phoneMQ.addEventListener('change', applyPhone) : phoneMQ.addListener(applyPhone);
function setNativeKb(v){
  nativeKb=v; document.body.classList.toggle('native-kb', v); setInputMode();
  if(edit){ const inp=edit.input; inp.blur(); inp.focus({preventScroll:true}); requestAnimationFrame(()=>{ if(edit){ ensureVisible(edit.r,edit.c); positionPopups(); } }); }
  toast(v ? 'Teclado del sistema activado. Usa el botón del teclado en la fila superior para volver al teclado GridLab.' : 'Teclado GridLab activado.');
}
document.addEventListener('pointerdown', e=>{
  if(!isPhone) return; const rb=$('#ribbon'); if(rb.classList.contains('collapsed')) return;
  if(rb.contains(e.target) || $('#tabs').contains(e.target) || pop.contains(e.target)) return;
  rb.classList.add('collapsed');
}, true);

/* Keyboard layout. Each key: [value, label, classes]. Special values are handled in kbPress(). */
const KB_NUM=[
  ['7'],['8'],['9'],['/','÷','op'],['(',null,'op'],[')',null,'op'],[':',null,'op'],['$',null,'op'],['%',null,'op'],['^',null,'op'],
  ['4'],['5'],['6'],['*','×','op'],['<',null,'op'],['>',null,'op'],['=',null,'op'],['&',null,'op'],['"',null,'op'],['!',null,'op'],
  ['1'],['2'],['3'],['-','−','op'],['<=','≤','op'],['>=','≥','op'],['<>','≠','op'],['SEP',null,'op'],["'",null,'op'],['#',null,'op'],
  ['0',null,'w2'],['DEC'],['+',null,'op'],['F4','F4 $','sm'],['SUM','Σ','op'],['FX','fx','fn'],[' ','espacio','sm w2'],['?',null,'op'],
];
const KB_FNS=['SUM','AVERAGE','COUNT','COUNTA','MAX','MIN','IF','AND','OR','IFERROR','VLOOKUP','XLOOKUP','MATCH','INDEX','SUMIF','COUNTIF','AVERAGEIF','SUMIFS','COUNTIFS','ROUND','INT','ABS','CONCAT','LEFT','RIGHT','MID','LEN','UPPER','LOWER','PROPER','TRIM','TEXT','TODAY','NOW','DATE','YEAR','MONTH','DAY','TRUE','FALSE'];
const KB_SIDE=[['BS','<span class="ms">backspace</span>','w2',1],['LEFT','<span class="ms">chevron_left</span>','',1],['RIGHT','<span class="ms">chevron_right</span>','',1],['ESC','<span class="ms">close</span>','',1],['TAB','⇥','',0],['OK','<span class="ms">keyboard_return</span>Intro','go w2',1]];
let kbPanel='num', kbUpper=true, kbRep=0, kbRepI=0;
const kbKey=(k,label,cls,html)=>`<button class="k ${cls||''}" data-k="${esc(k)}" aria-label="${esc(k===' '?'espacio':k)}">${html?label:esc(label)}</button>`;
function abcKeys(){
  const cs=s=>kbUpper?s:s.toLowerCase();
  const out=[];
  for(const ch of 'QWERTYUIOP') out.push([ch,cs(ch)]);
  for(const ch of 'ASDFGHJKLÑ') out.push([ch,cs(ch)]);
  out.push(['SHIFT',kbUpper?'⇧ ABC':'⇧ abc','sm '+(kbUpper?'on':'')]);
  for(const ch of 'ZXCVBNM') out.push([ch,cs(ch)]);
  out.push(['.',null,'op'],[',',null,'op']);
  for(const ch of 'ÁÉÍÓÚ') out.push([ch,cs(ch)]);
  out.push([' ','espacio','sm w3'],['_',null,'op'],['@',null,'op']);
  return out;
}
function renderKb(){
  kbTop.innerHTML=[['P:num','123'],['P:abc','ABC'],['P:fx','fx']].map(([k,l])=>`<button data-k="${k}" class="${'P:'+kbPanel===k?'on':''}">${l}</button>`).join('')+
    '<span class="kb-hint" id="kbHint"></span><button data-k="NATIVE" title="Usar el teclado del sistema"><span class="ms">keyboard</span>Sistema</button>';
  kbMain.className='kb-main'+(kbPanel==='fx'?' fxp':'');
  if(kbPanel==='fx') kbMain.innerHTML=KB_FNS.map(k=>kbKey('F:'+k, esName(k), 'fn')).join('')+kbKey('MORE','Más…','sm');
  else {
    const keys=kbPanel==='abc'?abcKeys():KB_NUM;
    kbMain.innerHTML=keys.map(([k,l,c])=>kbKey(k, l!=null?l : k==='SEP'?SEP() : k==='DEC'?ST.DEC : k, c)).join('');
  }
  kbSide.innerHTML=KB_SIDE.map(([k,l,c])=>kbKey(k,l,c,true)).join('');
  updateKbHint();
}
function updateKbHint(){
  const h=$('#kbHint'); if(!h) return;
  if(!edit){ h.textContent=''; return; }
  const t=edit.input.value;
  h.textContent = canPoint() ? 'Toca una celda (o arrastra) para insertar la referencia'
    : t[0]==='=' ? `Separa los argumentos con "${SEP()}" · F4 fija la referencia con $`
    : 'Escribe un valor o empieza con = para una fórmula';
}
function kbBackspace(){
  const inp=edit.input, t=inp.value; let a=inp.selectionStart??t.length; const b=inp.selectionEnd??a;
  if(a===b){ if(a===0) return; a--; }
  setEditText(t.slice(0,a)+t.slice(b), a); onEditInput(true);
}
function kbCaret(d){
  const inp=edit.input; const p=clamp((inp.selectionStart??inp.value.length)+d,0,inp.value.length);
  inp.focus({preventScroll:true}); inp.setSelectionRange(p,p);
  updateAC(); updateSig(); setMode(canPoint()?'point':edit.mode); updateKbHint();
}
function kbPress(k){
  if(k.startsWith('P:')){ kbPanel=k.slice(2); renderKb(); return; }
  if(k==='NATIVE') return setNativeKb(true);
  if(k==='SHIFT'){ kbUpper=!kbUpper; renderKb(); return; }
  if(k==='MORE'||k==='FX') return openFnDialog();
  if(k.startsWith('F:')) return insertFunction(k.slice(2));
  if(!edit) return;
  switch(k){
    case 'OK': commitEdit(1,0); return;
    case 'TAB': commitEdit(0,1); return;
    case 'ESC': cancelEdit(); return;
    case 'F4': cycleAbs(); return;
    case 'SUM': insertText(esName('SUM')+'('); return;
    case 'BS': kbBackspace(); return;
    case 'LEFT': kbCaret(-1); return;
    case 'RIGHT': kbCaret(1); return;
  }
  let t = k==='SEP' ? SEP() : k==='DEC' ? ST.DEC : k;
  if(!kbUpper && /^[A-ZÑÁÉÍÓÚ]$/.test(k)) t=k.toLowerCase();
  insertText(t);
}
const kbStop=()=>{ clearTimeout(kbRep); clearInterval(kbRepI); kbEl.querySelectorAll('.down').forEach(x=>x.classList.remove('down')); };
kbEl.addEventListener('pointerdown', e=>{
  const b=e.target.closest('button'); if(!b || b.closest('.fxp')) return;
  e.preventDefault(); b.classList.add('down'); const k=b.dataset.k; kbPress(k);
  if(k==='BS'||k==='LEFT'||k==='RIGHT') kbRep=setTimeout(()=>{ kbRepI=setInterval(()=>{ if(edit) kbPress(k); else kbStop(); },70); },420);
});
['pointerup','pointercancel','pointerleave'].forEach(ev=>kbEl.addEventListener(ev, kbStop));
kbEl.addEventListener('click', e=>{ const b=e.target.closest('.fxp button'); if(b) kbPress(b.dataset.k); });
kbEl.addEventListener('mousedown', e=>e.preventDefault());
kbEl.addEventListener('touchstart', e=>{ if(!e.target.closest('.fxp')) e.preventDefault(); }, {passive:false});

/* Quick action bar (phone, while not editing) */
let extendMode=false;
$('#pbar').addEventListener('click', e=>{
  const b=e.target.closest('[data-pa]'); if(!b) return; const a=b.dataset.pa;
  const curCell=()=>sheet().cells[A(sel.ar,sel.ac)];
  switch(a){
    case 'type': startEdit('','enter'); break;
    case 'edit': startEdit(editText(curCell()),'edit'); break;
    case 'eq': startEdit('=','enter'); break;
    case 'sum': autosum('SUM'); break;
    case 'fx': openFnDialog(); break;
    case 'clear': clearCells('contents'); break;
    case 'extend': extendMode=!extendMode; b.classList.toggle('go',extendMode); break;
    case 'left': move(0,-1,extendMode); break;
    case 'right': move(0,1,extendMode); break;
    case 'up': move(-1,0,extendMode); break;
    case 'down': move(1,0,extendMode); break;
    case 'ribbon': { const rb=$('#ribbon'); rb.classList.toggle('collapsed'); break; }
    case 'file': openBackstage('home'); break;
    case 'sheets': { const r=b.getBoundingClientRect();
      showMenu([{h:'Hojas'},...ST.wb.sheets.map((s,i)=>({ic:i===ST.cur?'check':'',l:s.name,a:'goSheet',arg:i})),'-',{ic:'post_add',l:'Nueva hoja',a:'addSheet'},{ic:'content_copy',l:'Duplicar hoja',a:'dupSheet'},{ic:'delete',l:'Eliminar hoja',a:'deleteSheet'}], r.left, r.top-8);
      requestAnimationFrame(()=>{ pop.style.top=Math.max(8, r.top-pop.offsetHeight-4)+'px'; }); break; }
    default: run(a, b.title||a);
  }
});

/* Two-finger pinch zoom on the grid */
let pinch=null, pinchZ=0, pinchRaf=0;
const touchDist=t=>Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
scroller.addEventListener('touchstart', e=>{
  if(e.touches.length!==2) return;
  if(tap){ clearTimeout(tap.timer); tap=null; } drag=null;
  pinch={d:touchDist(e.touches), z:zoom};
}, {passive:true});
scroller.addEventListener('touchmove', e=>{
  if(!pinch || e.touches.length!==2) return;
  e.preventDefault(); pinchZ=pinch.z*touchDist(e.touches)/pinch.d;
  if(!pinchRaf) pinchRaf=requestAnimationFrame(()=>{ pinchRaf=0; setZoom(pinchZ); });
}, {passive:false});
scroller.addEventListener('touchend', e=>{ if(e.touches.length<2) pinch=null; });

/* ================= Boot ================= */
load();
buildGrid();
renderRibbon();
setSkin(prefs.skin);
$('#sepKey').textContent=SEP();
grid.classList.toggle('nogrid', !view.gridlines); grid.classList.toggle('nohead', !view.headings); $('#fbarRow').hidden=!view.formulaBar;
sel={...(sheet().sel||{ar:0,ac:0,fr:0,fc:0})};
renderKb();
applyPhone();
afterStructure();
setTimeout(()=>toast(isPhone ? 'Toca una celda dos veces para escribir. Usa = para empezar una fórmula.' : `Consejo: selecciona una celda y escribe = para empezar una fórmula. Los argumentos se separan con "${SEP()}". F4 alterna referencias relativas y absolutas.`), 600);
})();

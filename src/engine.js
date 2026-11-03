/* =====================================================================
   GridLab formula engine (DOM-free)

   One file, two uses:
     - Browser: loaded with a plain <script>; exposes window.GridEngine.
     - Node (server grading): the server wrapper evaluates this file and
       reads the same GridEngine object.

   Usage:
     const eng = GridEngine.createEngine({ workbook, decimal: ',' });
     eng.cellValue(sheetIndex, row, col);       // rows/cols are 0-based
     eng.evalFormulaText('=SUMA(A1:A3)', 0);
   ===================================================================== */
(function (root) {
'use strict';

const ROWS = 200, COLS = 26;

/* ---------- Workbook sanitizer (shared by the browser and the server) ---------- */
const STYLE_SPEC = {
  b: 'bool', i: 'bool', u: 'bool', st: 'bool', wrap: 'bool',
  bt: 'flag', bb: 'flag', bl: 'flag', br: 'flag',
  font: 'str', ha: 'str', va: 'str', fmt: 'str',
  size: 'num', ind: 'num', dec: 'num',
  color: 'color', fill: 'color',
};
function cleanStyle(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const out = {};
  for (const k of Object.keys(STYLE_SPEC)) {
    const v = s[k];
    if (v === undefined || v === null) continue;
    switch (STYLE_SPEC[k]) {
      case 'bool': if (v) out[k] = true; break;
      case 'flag': if (v) out[k] = 1; break;
      case 'str': if (typeof v === 'string' && v.length <= 40) out[k] = v; break;
      case 'num': if (typeof v === 'number' && isFinite(v)) out[k] = Math.max(0, Math.min(400, v)); break;
      case 'color': if (typeof v === 'string' && v.length <= 40 && /^[#\w(),.% -]+$/.test(v)) out[k] = v; break;
    }
  }
  return Object.keys(out).length ? out : null;
}
const isPlain = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const ADDR_RE = /^([A-Z]{1,3})(\d{1,4})$/;
function addrInBounds(key) {
  const m = ADDR_RE.exec(key);
  if (!m) return false;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  c -= 1;
  const r = +m[2] - 1;
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}
const toInt = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, Math.trunc(v))) : d;

/* Returns a clean copy of a stored/received workbook, or throws Error. */
function sanitizeWorkbook(raw, limits) {
  const lim = Object.assign({ maxSheets: 50, maxCells: 20000, maxStr: 2000 }, limits);
  if (!isPlain(raw) || !Array.isArray(raw.sheets) || !raw.sheets.length) throw new Error('invalid workbook');
  if (raw.sheets.length > lim.maxSheets) throw new Error('too many sheets');
  let cellCount = 0;
  const seen = new Set();
  const sheets = raw.sheets.map((sh, idx) => {
    if (!isPlain(sh)) throw new Error('invalid sheet');
    let name = typeof sh.name === 'string' ? sh.name.trim().slice(0, 31) : '';
    if (!name) name = 'Hoja' + (idx + 1);
    let unique = name, n = 2;
    while (seen.has(unique.toLowerCase())) unique = name.slice(0, 27) + ' (' + (n++) + ')';
    seen.add(unique.toLowerCase());
    const cells = {};
    const src = isPlain(sh.cells) ? sh.cells : {};
    for (const key of Object.keys(src)) {
      if (!addrInBounds(key)) continue;
      const c = src[key];
      if (!isPlain(c)) continue;
      let v = c.v;
      if (typeof v === 'number') v = isFinite(v) ? String(v) : '';
      else if (typeof v === 'boolean') v = v ? 'VERDADERO' : 'FALSO';
      else if (typeof v !== 'string') v = '';
      if (v.length > lim.maxStr) throw new Error('cell too long');
      const cell = { v };
      if (c.str) cell.str = 1;
      const s = cleanStyle(c.s);
      if (s) cell.s = s;
      if (v === '' && !s) continue;
      if (++cellCount > lim.maxCells) throw new Error('too many cells');
      cells[key] = cell;
    }
    const colW = {};
    if (isPlain(sh.colW)) {
      for (const k of Object.keys(sh.colW)) {
        const ci = +k, w = sh.colW[k];
        if (Number.isInteger(ci) && ci >= 0 && ci < COLS && typeof w === 'number' && isFinite(w)) colW[ci] = Math.max(10, Math.min(1000, Math.round(w)));
      }
    }
    const s0 = isPlain(sh.sel) ? sh.sel : {};
    const ar = toInt(s0.ar, 0, ROWS - 1, 0), ac = toInt(s0.ac, 0, COLS - 1, 0);
    const out = { name: unique, cells, colW, sel: { ar, ac, fr: toInt(s0.fr, 0, ROWS - 1, ar), fc: toInt(s0.fc, 0, COLS - 1, ac) } };
    if (Array.isArray(sh.hiddenRows)) {
      const hr = sh.hiddenRows.filter(x => Number.isInteger(x) && x >= 0 && x < ROWS);
      if (hr.length) out.hiddenRows = hr;
    }
    return out;
  });
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 100) : 'Libro1';
  return { name, sheets };
}

function createEngine(opts) {
opts = opts || {};
/* Mutable engine state. The UI reads/writes S.wb, S.cur and S.DEC. */
const S = { wb: opts.workbook || { name: 'Libro1', sheets: [] }, cur: opts.current || 0, DEC: opts.decimal || ',', budget: Infinity };
const locNum = s => S.DEC===',' ? s.replace(/[.,]/g, m => m==='.' ? ',' : '.') : s;
/* Work budget: the server sets S.budget so a heavy workbook cannot hang a request. */
function spend(n){ if((S.budget -= n) < 0){ const e = new Error('budget exceeded'); e.budget = true; throw e; } }

/* ================= Addressing ================= */
function colName(c){ let s=''; c++; while(c>0){ const m=(c-1)%26; s=String.fromCharCode(65+m)+s; c=Math.floor((c-1)/26); } return s; }
function colIndex(s){ let n=0; for(const ch of s.toUpperCase()) n=n*26+ch.charCodeAt(0)-64; return n-1; }
const A = (r,c) => colName(c)+(r+1);
function parseA(a){ const m=/^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(a).trim()); if(!m) return null; const r=+m[2]-1, c=colIndex(m[1]); return (r>=0&&r<ROWS&&c>=0&&c<COLS)?{r,c}:null; }
function parseRangeText(t){ const p=String(t).split(':'); if(p.length>2) return null; const a=parseA(p[0]); if(!a) return null; const b=p[1]!=null?parseA(p[1]):a; if(!b) return null; return {r1:Math.min(a.r,b.r),c1:Math.min(a.c,b.c),r2:Math.max(a.r,b.r),c2:Math.max(a.c,b.c)}; }

/* ================= Values ================= */
class XErr { constructor(e){ this.e=e; } toString(){ return errText(this.e); } }
const isErr = v => v instanceof XErr;
const E = { div:()=>new XErr('#DIV/0!'), val:()=>new XErr('#VALUE!'), ref:()=>new XErr('#REF!'), name:()=>new XErr('#NAME?'), na:()=>new XErr('#N/A'), num:()=>new XErr('#NUM!') };
const ERR_ES = {'#DIV/0!':'#¡DIV/0!','#VALUE!':'#¡VALOR!','#REF!':'#¡REF!','#NAME?':'#¿NOMBRE?','#N/A':'#N/D','#NUM!':'#¡NUM!','#NULL!':'#¡NULO!'};
const ERR_IN = Object.fromEntries(Object.entries(ERR_ES).map(([k,v])=>[v,k]));
const errText = e => ERR_ES[e] || e;
const MISSING = Object.freeze({missing:true});
const isArr = v => v!==null && typeof v==='object' && Array.isArray(v.arr);
const r15 = x => (x===0 || !isFinite(x)) ? x : +x.toPrecision(15);
const boolText = b => b ? 'VERDADERO' : 'FALSO';

const EPOCH = Date.UTC(1899,11,30);
const fromSerial = s => new Date(EPOCH + Math.floor(s)*864e5);
const todaySerial = () => { const d=new Date(); return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())-EPOCH)/864e5; };
function parseDateText(t){
  const valid=(y,mo,d)=>{ if(mo<1||mo>12||d<1||d>31) return null; const dt=new Date(Date.UTC(y,mo-1,d)); if(dt.getUTCDate()!==d) return null; return (dt.getTime()-EPOCH)/864e5; };
  let m=/^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t); if(m) return valid(+m[1],+m[2],+m[3]);
  m=/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if(m){ let y=+m[3]; if(y<100) y+=2000; return valid(y,+m[2],+m[1]); }
  return null;
}
/* mode 'canon' = stored values (dot decimal); 'local' = what a person types or sees */
function parseLiteral(raw, fmt, mode){
  if(raw==null || raw==='') return {v:null};
  if(raw[0]==="'") return {v:raw.slice(1)};
  if(fmt==='text') return {v:raw};
  const t=raw.trim(); const up=t.toUpperCase();
  if(up==='TRUE'||up==='VERDADERO') return {v:true};
  if(up==='FALSE'||up==='FALSO') return {v:false};
  const dec = mode==='canon' ? '.' : S.DEC, grp = dec==='.' ? ',' : '.';
  const qd='\\'+dec, qg='\\'+grp;
  const m=new RegExp(`^([+-]?)(\\$?)(\\d{1,3}(?:${qg}\\d{3})+|\\d*)(${qd}\\d+)?(%?)$`).exec(t);
  if(m && /\d/.test(t) && !(m[2] && m[5])){
    let n=parseFloat((m[3].split(grp).join('')||'0')+(m[4]?'.'+m[4].slice(1):'')); if(m[1]==='-') n=-n;
    const decs=m[4]?m[4].length-1:0;
    if(m[5]) return {v:r15(n/100), fmt:'percent', dec:decs};
    if(m[2]) return {v:n, fmt:'currency', dec:decs};
    if(m[3].includes(grp)) return {v:n, fmt:'comma', dec:decs};
    return {v:n};
  }
  if(new RegExp(`^[+-]?\\d+(${qd}\\d+)?[eE][+-]?\\d+$`).test(t)) return {v:parseFloat(t.replace(dec,'.'))};
  const d=parseDateText(t); if(d!==null) return {v:d, fmt:'date'};
  const tm=/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if(tm && +tm[1]<24 && +tm[2]<60) return {v:(+tm[1]*3600 + +tm[2]*60 + +(tm[3]||0))/86400, fmt:'time'};
  return {v:raw};
}
function fmtGeneralCanon(n){
  if(!isFinite(n)) return '#NUM!';
  if(Number.isInteger(n) && Math.abs(n)<1e11) return String(n);
  const a=Math.abs(n);
  if(a!==0 && (a>=1e11 || a<1e-9)) return n.toExponential(5).replace(/\.?0+e/,'e').toUpperCase().replace(/E([+-])(\d)$/,'E$10$2');
  let s=n.toPrecision(10); if(s.includes('e')) return String(+s);
  if(s.includes('.')) s=s.replace(/0+$/,'').replace(/\.$/,'');
  return s;
}
const fmtGeneral = n => locNum(fmtGeneralCanon(n));
function toNum(v){
  if(v===null||v===MISSING) return 0;
  if(typeof v==='number') return v;
  if(typeof v==='boolean') return v?1:0;
  if(isErr(v)) return v;
  if(isArr(v)) return toNum(v.arr[0][0]);
  const p=parseLiteral(String(v)); return typeof p.v==='number' ? p.v : E.val();
}
function toStr(v){
  if(v===null||v===MISSING) return '';
  if(typeof v==='boolean') return boolText(v);
  if(typeof v==='number') return fmtGeneral(v);
  if(isArr(v)) return toStr(v.arr[0][0]);
  if(isErr(v)) return errText(v.e);
  return String(v);
}
function toBool(v){
  if(isErr(v)) return v;
  if(isArr(v)) return toBool(v.arr[0][0]);
  if(v===null||v===MISSING) return false;
  if(typeof v==='boolean') return v;
  if(typeof v==='number') return v!==0;
  const u=String(v).toUpperCase();
  if(u==='TRUE'||u==='VERDADERO') return true;
  if(u==='FALSE'||u==='FALSO') return false;
  return E.val();
}
const typeRank = v => typeof v==='number'?0 : typeof v==='string'?1 : typeof v==='boolean'?2 : 3;
function cmp(a,b){
  if(a===null||a===MISSING) a = typeof b==='string' ? '' : typeof b==='boolean' ? false : 0;
  if(b===null||b===MISSING) b = typeof a==='string' ? '' : typeof a==='boolean' ? false : 0;
  const ra=typeRank(a), rb=typeRank(b);
  if(ra!==rb) return ra<rb?-1:1;
  if(ra===1){ const x=a.toLowerCase(), y=b.toLowerCase(); return x<y?-1:x>y?1:0; }
  if(ra===2) return a===b?0:(a?1:-1);
  return a<b?-1:a>b?1:0;
}
function scalarOp(op,a,b){
  if(isErr(a)) return a; if(isErr(b)) return b;
  switch(op){
    case '&': return toStr(a)+toStr(b);
    case '=': return cmp(a,b)===0;
    case '<>': return cmp(a,b)!==0;
    case '<': return cmp(a,b)<0;
    case '>': return cmp(a,b)>0;
    case '<=': return cmp(a,b)<=0;
    case '>=': return cmp(a,b)>=0;
  }
  const x=toNum(a); if(isErr(x)) return x;
  const y=toNum(b); if(isErr(y)) return y;
  let r;
  switch(op){
    case '+': r=r15(x+y); break;
    case '-': r=r15(x-y); break;
    case '*': r=r15(x*y); break;
    case '/': if(y===0) return E.div(); r=r15(x/y); break;
    case '^': if(x===0&&y===0) return E.num(); r=Math.pow(x,y); break;
    default: return E.val();
  }
  return isFinite(r) ? r : E.num();
}
function arrGet(X,r,c){ const R=X.length, C=X[0].length; const rr=R===1?0:r, cc=C===1?0:c; if(rr>=R||cc>=C) return E.na(); return X[rr][cc]; }
function lift2(a,b,fn){
  if(!isArr(a)&&!isArr(b)) return fn(a,b);
  const X=isArr(a)?a.arr:[[a]], Y=isArr(b)?b.arr:[[b]];
  const R=Math.max(X.length,Y.length), C=Math.max(X[0].length,Y[0].length); const out=[];
  for(let r=0;r<R;r++){ const row=[]; for(let c=0;c<C;c++) row.push(fn(arrGet(X,r,c),arrGet(Y,r,c))); out.push(row); }
  return {arr:out};
}
const lift1 = (a,fn) => isArr(a) ? {arr:a.arr.map(row=>row.map(fn))} : fn(a);

/* ================= Formula parser (canonical text: dot decimal, comma separator) ================= */
function tokenize(src){
  const out=[]; let i=0; const n=src.length;
  while(i<n){
    const ch=src[i];
    if(ch===' '||ch==='\t'||ch==='\n'||ch==='\r'){ i++; continue; }
    const rest=src.slice(i); let m;
    if(ch==='"'){
      let j=i+1, s='';
      for(;;){ if(j>=n) throw new SyntaxError('string'); if(src[j]==='"'){ if(src[j+1]==='"'){ s+='"'; j+=2; continue; } break; } s+=src[j++]; }
      out.push({t:'str',v:s}); i=j+1; continue;
    }
    if(ch==="'"){ m=/^'((?:[^']|'')+)'!/.exec(rest); if(!m) throw new SyntaxError('sheet'); out.push({t:'sheet',v:m[1].replace(/''/g,"'")}); i+=m[0].length; continue; }
    if(ch==='#'){
      m=/^#(¡DIV\/0!|¡VALOR!|¡REF!|¿NOMBRE\?|N\/D|¡NUM!|¡NULO!|DIV\/0!|N\/A|NAME\?|REF!|VALUE!|NUM!|NULL!)/i.exec(rest); if(!m) throw new SyntaxError('err');
      const e=m[0].toUpperCase(); out.push({t:'err',v:ERR_IN[e]||e}); i+=m[0].length; continue;
    }
    if(/[\d.]/.test(ch) && (m=/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest))){ out.push({t:'num',v:parseFloat(m[0])}); i+=m[0].length; continue; }
    if((m=/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_.(!\u00C0-\u024F])/.exec(rest))){ const r=+m[4]-1; if(r<0) throw new SyntaxError('ref'); out.push({t:'ref',r,c:colIndex(m[2])}); i+=m[0].length; continue; }
    if((m=/^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_.(!])/.exec(rest))){ out.push({t:'cols',c1:colIndex(m[2]),c2:colIndex(m[4])}); i+=m[0].length; continue; }
    if((m=/^[A-Za-z_\u00C0-\u024F][A-Za-z0-9_.\u00C0-\u024F]*/.exec(rest))){ i+=m[0].length; if(src[i]==='!'){ out.push({t:'sheet',v:m[0]}); i++; } else out.push({t:'name',v:m[0]}); continue; }
    if((m=/^(<=|>=|<>)/.exec(rest))){ out.push({t:'op',v:m[0]}); i+=2; continue; }
    if('+-*/^&=<>%(),;:'.includes(ch)){ out.push({t:'op',v:ch}); i++; continue; }
    throw new SyntaxError('char');
  }
  return out;
}
function parseFormula(src){
  const T=tokenize(src); let p=0;
  const isOp = v => T[p] && T[p].t==='op' && T[p].v===v;
  const fail = () => { throw new SyntaxError('parse'); };
  const CMP=['=','<>','<','>','<=','>='];
  function expr(){ let l=concat(); while(T[p]&&T[p].t==='op'&&CMP.includes(T[p].v)){ const op=T[p++].v; l={t:'bin',op,l,r:concat()}; } return l; }
  function concat(){ let l=additive(); while(isOp('&')){ p++; l={t:'bin',op:'&',l,r:additive()}; } return l; }
  function additive(){ let l=term(); while(isOp('+')||isOp('-')){ const op=T[p++].v; l={t:'bin',op,l,r:term()}; } return l; }
  function term(){ let l=power(); while(isOp('*')||isOp('/')){ const op=T[p++].v; l={t:'bin',op,l,r:power()}; } return l; }
  function power(){ let l=unary(); while(isOp('^')){ p++; l={t:'bin',op:'^',l,r:unary()}; } return l; }
  function unary(){ if(isOp('-')){ p++; return {t:'neg',e:unary()}; } if(isOp('+')){ p++; return unary(); } return postfix(); }
  function postfix(){ let e=primary(); while(isOp('%')){ p++; e={t:'pct',e}; } return e; }
  function refNode(tk, sheet){
    if(tk.t==='cols') return {t:'range',sheet,r1:0,c1:Math.min(tk.c1,tk.c2),r2:ROWS-1,c2:Math.max(tk.c1,tk.c2)};
    if(tk.t!=='ref') fail();
    if(isOp(':')){ p++; let t2=T[p++]; if(t2&&t2.t==='sheet') t2=T[p++]; if(!t2||t2.t!=='ref') fail();
      return {t:'range',sheet,r1:Math.min(tk.r,t2.r),c1:Math.min(tk.c,t2.c),r2:Math.max(tk.r,t2.r),c2:Math.max(tk.c,t2.c)}; }
    return {t:'ref',sheet,r:tk.r,c:tk.c};
  }
  function primary(){
    const tk=T[p++]; if(!tk) fail();
    switch(tk.t){
      case 'num': return {t:'num',v:tk.v};
      case 'str': return {t:'str',v:tk.v};
      case 'err': return {t:'err',v:tk.v};
      case 'sheet': { const r=T[p++]; if(!r) fail(); return refNode(r, tk.v); }
      case 'ref': case 'cols': return refNode(tk, null);
      case 'name': {
        const nm=tk.v.toUpperCase();
        if(isOp('(')){
          p++; const args=[];
          if(!isOp(')')){ for(;;){ if(isOp(',')||isOp(';')||isOp(')')) args.push({t:'missing'}); else args.push(expr()); if(isOp(',')||isOp(';')){ p++; continue; } break; } }
          if(!isOp(')')) fail(); p++; return {t:'fn',name:nm,args};
        }
        if(nm==='TRUE'||nm==='VERDADERO') return {t:'bool',v:true};
        if(nm==='FALSE'||nm==='FALSO') return {t:'bool',v:false};
        return {t:'name',v:nm};
      }
      case 'op': if(tk.v==='('){ const e=expr(); if(!isOp(')')) fail(); p++; return e; } break;
    }
    fail();
  }
  if(!T.length) fail();
  const ast=expr(); if(p<T.length) fail(); return ast;
}
function balanceParens(t){ let d=0, q=false; for(const ch of t){ if(ch==='"') q=!q; else if(!q){ if(ch==='(') d++; else if(ch===')') d--; } } return d>0 ? t+')'.repeat(d) : t; }
const SPLIT_RE = /("(?:[^"]|"")*"|'(?:[^']|'')*')/;
const mapOutside = (f, fn) => f.split(SPLIT_RE).map((s,i)=> i%2 ? s : fn(s)).join('');
const NUM_LB = '(?<![A-Za-z0-9_$.\\u00C0-\\u024F])';
function toCanonFormula(f){
  if(S.DEC==='.') return mapOutside(f, s=>s.replace(/;/g,','));
  return mapOutside(f, s=>s.replace(/;/g,'\u0001').replace(new RegExp(NUM_LB+'(\\d+),(\\d+)','g'),'$1.$2').replace(/\u0001/g,','));
}
function toLocalFormula(f){
  if(!f || f[0]!=='=' || S.DEC==='.') return f;
  return mapOutside(f, s=>s.replace(/,/g,';').replace(new RegExp(NUM_LB+'(\\d+)\\.(\\d+)','g'),'$1,$2'));
}
function shiftFormula(f, dr, dc){
  if(!f || f[0]!=='=') return f;
  return mapOutside(f, seg=>seg.replace(/(?<![A-Za-z0-9_.\u00C0-\u024F])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_.(!\u00C0-\u024F])/g, (m,ca,col,ra,row)=>{
    let c=colIndex(col), r=+row-1; if(!ca) c+=dc; if(!ra) r+=dr;
    if(c<0||r<0) return '#¡REF!';
    return ca+colName(c)+ra+(r+1);
  }));
}
/* Uppercases function names and writes them the way Spanish Excel shows them (SUM -> SUMA). */
const localizeFns = f => mapOutside(f, s=>s.replace(/[A-Za-z_\u00C0-\u024F][A-Za-z0-9_.\u00C0-\u024F]*(?=\s*\()/g, n=>{ const k=resolveFn(n); return k ? (FN[k].es||k) : n.toUpperCase(); }));
function refsInFormula(text){
  const out=[]; if(!text||text[0]!=='=') return out;
  let off=0;
  text.split(/("(?:[^"]|"")*"?)/).forEach((seg,i)=>{
    if(i%2===0){
      const re=/(?<![A-Za-z0-9_.$\u00C0-\u024F])((?:'(?:[^']|'')+'|[A-Za-z_\u00C0-\u024F][A-Za-z0-9_.\u00C0-\u024F]*)!)?(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?(?![A-Za-z0-9_.(!\u00C0-\u024F])/g; let m;
      while((m=re.exec(seg))) out.push({sheet:m[1]?m[1].slice(0,-1).replace(/^'|'$/g,'').replace(/''/g,"'"):null, a:m[2], b:m[3], start:off+m.index, end:off+m.index+m[0].length});
    }
    off+=seg.length;
  });
  return out;
}

/* ================= Evaluation ================= */
const sheet = () => S.wb.sheets[S.cur];
const cache=new Map(), calcing=new Set(), circular=new Set(), astCache=new Map();
function getAst(src){
  let a=astCache.get(src);
  if(a===undefined){ try{ a=parseFormula(src.slice(1)); }catch(e){ a={t:'err',v:'#NAME?'}; } if(astCache.size>4000) astCache.clear(); astCache.set(src,a); }
  return a;
}
function sheetIndex(name){ const n=name.toLowerCase(); return S.wb.sheets.findIndex(s=>s.name.toLowerCase()===n); }
function storedValue(cell){ if(cell.str) return cell.v; return parseLiteral(cell.v, cell.s&&cell.s.fmt, 'canon').v; }
function cellValue(si,r,c){
  const key=si+'!'+r+','+c;
  if(cache.has(key)) return cache.get(key);
  const sh=S.wb.sheets[si]; const cell=sh.cells[A(r,c)];
  if(!cell || cell.v==null || cell.v==='') return null;
  let v;
  if(cell.v[0]==='=' && cell.v.length>1 && !cell.str){
    if(calcing.has(key)){ circular.add(sh.name+'!'+A(r,c)); return 0; }
    calcing.add(key); spend(1);
    try{ v=evalNode(getAst(cell.v),{si}); }catch(e){ if(e && e.budget) throw e; v = isErr(e) ? e : E.val(); }
    calcing.delete(key);
    if(isArr(v)) v=v.arr[0][0];
    if(v===null||v===MISSING) v=0;
  } else v=storedValue(cell);
  cache.set(key,v); return v;
}
function rangeVal(si,r1,c1,r2,c2){
  r2=Math.min(r2,ROWS-1); c2=Math.min(c2,COLS-1); const out=[]; spend(((r2-r1+1)*(c2-c1+1)/20)|0);
  for(let r=r1;r<=r2;r++){ const row=[]; for(let c=c1;c<=c2;c++) row.push(cellValue(si,r,c)); out.push(row); }
  if(!out.length) out.push([null]);
  return {arr:out};
}
function evalNode(n,ctx){
  switch(n.t){
    case 'num': case 'str': case 'bool': return n.v;
    case 'err': return new XErr(n.v);
    case 'missing': return MISSING;
    case 'name': return E.name();
    case 'ref': { const si=n.sheet==null?ctx.si:sheetIndex(n.sheet); if(si<0 || n.r>=ROWS || n.c>=COLS) return E.ref(); return cellValue(si,n.r,n.c); }
    case 'range': { const si=n.sheet==null?ctx.si:sheetIndex(n.sheet); if(si<0 || n.r1>=ROWS || n.r2>=ROWS || n.c1>=COLS || n.c2>=COLS) return E.ref(); return rangeVal(si,n.r1,n.c1,n.r2,n.c2); }
    case 'neg': return lift1(evalNode(n.e,ctx), x=>{ if(isErr(x)) return x; const y=toNum(x); return isErr(y)?y:-y; });
    case 'pct': return lift1(evalNode(n.e,ctx), x=>{ if(isErr(x)) return x; const y=toNum(x); return isErr(y)?y:r15(y/100); });
    case 'bin': return lift2(evalNode(n.l,ctx), evalNode(n.r,ctx), (a,b)=>scalarOp(n.op,a,b));
    case 'fn': {
      const key=resolveFn(n.name); if(!key) return E.name();
      spend(1); const args=n.args.map(a=>evalNode(a,ctx));
      try{ const r=FN[key].f(args,ctx); return r===undefined ? E.val() : r; }
      catch(e){ if(isErr(e)) return e; throw e; }
    }
  }
  return E.val();
}

/* ================= Function library ================= */
const FN={}, ALIAS={};
function def(name, es, cat, args, desc, f){ FN[name]={name,es,cat,args,desc,f}; if(es && es!==name) ALIAS[es]=name; }
function resolveFn(n){ n=n.toUpperCase(); if(n.startsWith('_XLFN.')) n=n.slice(6); return FN[n] ? n : (ALIAS[n]||null); }
const given = v => v!==undefined && v!==MISSING;
function sc(v){ if(isArr(v)) v=v.arr[0][0]; if(isErr(v)) throw v; return v; }
function N(v,d){ if(!given(v)){ if(d===undefined) throw E.val(); return d; } const x=toNum(sc(v)); if(isErr(x)) throw x; return x; }
function Str(v,d){ if(!given(v)){ if(d===undefined) throw E.val(); return d; } return toStr(sc(v)); }
function Bool(v,d){ if(!given(v)){ if(d===undefined) throw E.val(); return d; } const b=toBool(sc(v)); if(isErr(b)) throw b; return b; }
function Arr2(v){ if(isArr(v)) return v.arr; if(isErr(v)) throw v; if(v===undefined) throw E.val(); return [[v===MISSING?null:v]]; }
const first = v => isArr(v) ? v.arr[0][0] : v;
function flatVals(args){ const out=[]; for(const a of args){ if(a===MISSING) continue; if(isArr(a)){ for(const row of a.arr) for(const v of row) out.push([v,true]); } else out.push([a,false]); } return out; }
function nums(args){
  const out=[];
  for(const [v,inRange] of flatVals(args)){
    if(isErr(v)) throw v;
    if(inRange){ if(typeof v==='number') out.push(v); }
    else { if(v===null) continue; const x=toNum(v); if(isErr(x)) throw x; out.push(x); }
  }
  return out;
}
const total = a => r15(a.reduce((s,x)=>s+x,0));
function roundTo(x,d,mode){
  const f=Math.pow(10,Math.trunc(d)); const s=x<0?-1:1; const ax=+(Math.abs(x)*f).toPrecision(15);
  const y = mode==='up' ? Math.ceil(ax) : mode==='down' ? Math.floor(ax) : Math.round(ax);
  return r15(s*y/f);
}
function wildRe(p, anchored=true){
  const body=p.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/~\*/g,'\u0001').replace(/~\?/g,'\u0002').replace(/\*/g,'.*').replace(/\?/g,'.').replace(/\u0001/g,'\\*').replace(/\u0002/g,'\\?');
  return new RegExp(anchored?'^'+body+'$':body,'is');
}
function makeCrit(c){
  c=sc(c);
  if(typeof c==='number') return v => typeof v==='number' ? v===c : (typeof v==='string' && v!=='' && parseLiteral(v).v===c);
  if(typeof c==='boolean') return v => v===c;
  if(c===null||c===MISSING) return v => v===null||v==='';
  const m=/^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(String(c)); const op=m[1]||'='; const rhs=m[2];
  const pv=parseLiteral(rhs).v;
  if(typeof pv==='number'){
    return v => {
      let x=null;
      if(typeof v==='number') x=v; else if(typeof v==='string' && op==='='){ const q=parseLiteral(v).v; if(typeof q==='number') x=q; }
      if(x===null) return op==='<>';
      switch(op){ case '=': return x===pv; case '<>': return x!==pv; case '<': return x<pv; case '>': return x>pv; case '<=': return x<=pv; case '>=': return x>=pv; }
      return false;
    };
  }
  if(rhs===''){ if(op==='=') return v => v===null||v===''; if(op==='<>') return v => v!==null&&v!==''; }
  if(typeof pv==='boolean') return v => op==='<>' ? v!==pv : (op==='=' ? v===pv : false);
  if(op==='='||op==='<>'){ const re=wildRe(rhs); return v => { const ok = typeof v==='string' && re.test(v); return op==='=' ? ok : !ok; }; }
  const lr=rhs.toLowerCase();
  return v => { if(typeof v!=='string') return false; const x=v.toLowerCase(); switch(op){ case '<': return x<lr; case '>': return x>lr; case '<=': return x<=lr; case '>=': return x>=lr; } return false; };
}
function ifsCore(args, start, target){
  const pairs=[]; for(let i=start;i<args.length;i+=2){ if(args[i+1]===undefined) throw E.val(); pairs.push([Arr2(args[i]), makeCrit(args[i+1])]); }
  const out=[];
  for(let r=0;r<target.length;r++) for(let c=0;c<target[0].length;c++){
    if(pairs.every(([R,f])=>{ const v=R[r]&&R[r][c]; return f(v===undefined?null:v); })) out.push(target[r][c]);
  }
  return out;
}
function findIn(list, lv, mode){
  if(isErr(lv)) throw lv;
  if(mode===0){
    const re = typeof lv==='string' && /[*?]/.test(lv) ? wildRe(lv) : null;
    for(let i=0;i<list.length;i++){ const v=list[i]; if(v===null) continue; if(re ? (typeof v==='string' && re.test(v)) : cmp(v,lv)===0) return i; }
    return -1;
  }
  let best=-1;
  for(let i=0;i<list.length;i++){
    const v=list[i]; if(v===null||typeRank(v)!==typeRank(lv)) continue;
    const c=cmp(v,lv);
    if(mode===1){ if(c<=0) best=i; else break; } else { if(c>=0) best=i; else break; }
  }
  return best;
}
const pad2 = n => String(n).padStart(2,'0');
const swapSeps = f => mapOutside(f, s=>s.replace(/[.,]/g, m=>m==='.'?',':'.'));
function formatText(v, f){
  if(typeof v==='string'){ const p=parseLiteral(v).v; if(typeof p!=='number') return v; v=p; }
  if(typeof v==='boolean') return boolText(v);
  if(v===null) v=0;
  const bare=f.replace(/"[^"]*"/g,'');
  if(/[dmyhsa]/i.test(bare.replace(/am\/pm/ig,'')) || /am\/pm/i.test(bare)){
    f=f.replace(/a{4}/gi,'yyyy').replace(/a{2}/gi,'yy');
    const d=fromSerial(v); const secs=Math.round((v-Math.floor(v))*86400);
    const H=Math.floor(secs/3600), Mi=Math.floor(secs/60)%60, Sx=secs%60; let lastH=false;
    return f.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|"[^"]*"/gi, t=>{
      const lt=t.toLowerCase();
      if(t[0]==='"') return t.slice(1,-1);
      if(lt[0]==='m' && lt.length<=2 && lastH){ lastH=false; return lt==='mm'?pad2(Mi):String(Mi); }
      switch(lt){
        case 'yyyy': return String(d.getUTCFullYear());
        case 'yy': return String(d.getUTCFullYear()).slice(-2);
        case 'mmmm': return d.toLocaleString('es',{month:'long',timeZone:'UTC'});
        case 'mmm': return d.toLocaleString('es',{month:'short',timeZone:'UTC'}).replace('.','');
        case 'mm': return pad2(d.getUTCMonth()+1);
        case 'm': return String(d.getUTCMonth()+1);
        case 'dddd': return d.toLocaleString('es',{weekday:'long',timeZone:'UTC'});
        case 'ddd': return d.toLocaleString('es',{weekday:'short',timeZone:'UTC'}).replace('.','');
        case 'dd': return pad2(d.getUTCDate());
        case 'd': return String(d.getUTCDate());
        case 'hh': lastH=true; return pad2(H);
        case 'h': lastH=true; return String(H);
        case 'ss': return pad2(Sx);
        case 's': return String(Sx);
        case 'am/pm': return H<12?'a. m.':'p. m.';
      }
      return t;
    });
  }
  if(S.DEC===',') f=swapSeps(f);
  if(f.includes('%')) v*=100;
  const m=/[#0,.]+/.exec(f); if(!m) return f.replace(/"/g,'');
  const core=m[0]; const dot=core.indexOf('.');
  const decs = dot<0 ? 0 : (core.slice(dot+1).match(/[0#]/g)||[]).length;
  const group = core.slice(0, dot<0?core.length:dot).includes(',');
  const s=locNum(Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:decs,maximumFractionDigits:decs,useGrouping:group}));
  const deq = x => x.replace(/"/g,'');
  return (v<0?'-':'') + deq(S.DEC===','?swapSeps(f.slice(0,m.index)):f.slice(0,m.index)) + s + deq(S.DEC===','?swapSeps(f.slice(m.index+core.length)):f.slice(m.index+core.length));
}
function logicVals(a){
  const out=[];
  for(const [v,inR] of flatVals(a)){
    if(isErr(v)) throw v;
    if(inR){ if(typeof v==='boolean') out.push(v); else if(typeof v==='number') out.push(v!==0); }
    else { const b=toBool(v); if(isErr(b)) throw b; out.push(b); }
  }
  if(!out.length) throw E.val();
  return out;
}
function dateParts(v){ const d=fromSerial(N(v)); return {y:d.getUTCFullYear(), m:d.getUTCMonth(), d:d.getUTCDate(), dow:d.getUTCDay()}; }
const serialOf = (y,m,d) => (Date.UTC(y,m,d)-EPOCH)/864e5;
function median(n){ if(!n.length) throw E.num(); const s=[...n].sort((x,y)=>x-y); const h=s.length>>1; return s.length%2 ? s[h] : r15((s[h-1]+s[h])/2); }
function variance(n){ if(n.length<2) throw E.div(); const mu=n.reduce((s,x)=>s+x,0)/n.length; return n.reduce((s,x)=>s+(x-mu)**2,0)/(n.length-1); }

const MATH='Matemáticas y trigonométricas', STAT='Estadísticas', LOGIC='Lógicas', LOOK='Búsqueda y referencia', TEXT='Texto', DATE='Fecha y hora', INFO='Información', FIN='Financieras';
def('SUM','SUMA',MATH,'número1, [número2], ...','Suma todos los números de un rango de celdas.', a=>total(nums(a)));
def('PRODUCT','PRODUCTO',MATH,'número1, [número2], ...','Multiplica todos los números especificados como argumentos.', a=>{ const n=nums(a); return n.length ? r15(n.reduce((p,x)=>p*x,1)) : 0; });
def('ROUND','REDONDEAR',MATH,'número, núm_decimales','Redondea un número al número de decimales especificado.', a=>roundTo(N(a[0]),N(a[1]),'round'));
def('ROUNDUP','REDONDEAR.MAS',MATH,'número, núm_decimales','Redondea un número hacia arriba, en dirección contraria a cero.', a=>roundTo(N(a[0]),N(a[1]),'up'));
def('ROUNDDOWN','REDONDEAR.MENOS',MATH,'número, núm_decimales','Redondea un número hacia abajo, hacia cero.', a=>roundTo(N(a[0]),N(a[1]),'down'));
def('INT','ENTERO',MATH,'número','Redondea un número hacia abajo hasta el entero más próximo.', a=>Math.floor(N(a[0])));
def('TRUNC','TRUNCAR',MATH,'número, [núm_decimales]','Convierte un número decimal en entero quitando la parte decimal o fraccionaria.', a=>roundTo(N(a[0]),N(a[1],0),'down'));
def('ABS','ABS',MATH,'número','Devuelve el valor absoluto de un número, es decir, un número sin signo.', a=>Math.abs(N(a[0])));
def('MOD','RESIDUO',MATH,'número, núm_divisor','Devuelve el resto después de dividir un número por un divisor.', a=>{ const x=N(a[0]), d=N(a[1]); if(d===0) throw E.div(); return r15(x-d*Math.floor(x/d)); });
def('POWER','POTENCIA',MATH,'número, potencia','Devuelve el resultado de elevar un número a una potencia.', a=>{ const r=Math.pow(N(a[0]),N(a[1])); if(!isFinite(r)) throw E.num(); return r; });
def('SQRT','RAIZ',MATH,'número','Devuelve la raíz cuadrada de un número.', a=>{ const x=N(a[0]); if(x<0) throw E.num(); return Math.sqrt(x); });
def('PI','PI',MATH,'','Devuelve el valor de Pi, 3,14159265358979, con precisión de 15 dígitos.', ()=>Math.PI);
def('RAND','ALEATORIO',MATH,'','Devuelve un número aleatorio mayor o igual que 0 y menor que 1.', ()=>Math.random());
def('RANDBETWEEN','ALEATORIO.ENTRE',MATH,'inferior, superior','Devuelve un número aleatorio entre los números que especifiques.', a=>{ const lo=Math.ceil(N(a[0])), hi=Math.floor(N(a[1])); if(lo>hi) throw E.num(); return lo+Math.floor(Math.random()*(hi-lo+1)); });
def('CEILING','MULTIPLO.SUPERIOR',MATH,'número, cifra_significativa','Redondea un número hacia arriba, hasta el múltiplo significativo más cercano.', a=>{ const x=N(a[0]), s=N(a[1],1); if(s===0) return 0; return r15(Math.ceil(r15(x/s))*s); });
def('FLOOR','MULTIPLO.INFERIOR',MATH,'número, cifra_significativa','Redondea un número hacia abajo, hasta el múltiplo significativo más cercano.', a=>{ const x=N(a[0]), s=N(a[1],1); if(s===0) throw E.div(); return r15(Math.floor(r15(x/s))*s); });
def('SUMIF','SUMAR.SI',MATH,'rango, criterio, [rango_suma]','Suma las celdas que cumplen determinado criterio o condición.', a=>{
  const R=Arr2(a[0]); const S=given(a[2]) ? Arr2(a[2]) : R; const f=makeCrit(a[1]); let t=0;
  for(let r=0;r<R.length;r++) for(let c=0;c<R[0].length;c++) if(f(R[r][c])){ const v=S[r]&&S[r][c]; if(typeof v==='number') t+=v; }
  return r15(t); });
def('SUMIFS','SUMAR.SI.CONJUNTO',MATH,'rango_suma, rango_criterios1, criterio1, ...','Suma las celdas que cumplen un determinado conjunto de condiciones o criterios.', a=>total(ifsCore(a,1,Arr2(a[0])).filter(v=>typeof v==='number')));
def('SUMPRODUCT','SUMAPRODUCTO',MATH,'matriz1, [matriz2], ...','Devuelve la suma de los productos de rangos o matrices correspondientes.', a=>{
  const arrs=a.filter(given).map(Arr2); if(!arrs.length) throw E.val(); const R=arrs[0].length, C=arrs[0][0].length;
  if(arrs.some(X=>X.length!==R||X[0].length!==C)) throw E.val(); let t=0;
  for(let r=0;r<R;r++) for(let c=0;c<C;c++){ let p=1; for(const X of arrs){ const v=X[r][c]; if(isErr(v)) throw v; p*= typeof v==='number' ? v : 0; } t+=p; }
  return r15(t); });

def('AVERAGE','PROMEDIO',STAT,'número1, [número2], ...','Devuelve el promedio (media aritmética) de los argumentos.', a=>{ const n=nums(a); if(!n.length) throw E.div(); return r15(n.reduce((s,x)=>s+x,0)/n.length); });
def('AVERAGEIF','PROMEDIO.SI',STAT,'rango, criterio, [rango_promedio]','Busca el promedio de las celdas que cumplen un determinado criterio o condición.', a=>{
  const R=Arr2(a[0]); const S=given(a[2]) ? Arr2(a[2]) : R; const f=makeCrit(a[1]); let t=0, n=0;
  for(let r=0;r<R.length;r++) for(let c=0;c<R[0].length;c++) if(f(R[r][c])){ const v=S[r]&&S[r][c]; if(typeof v==='number'){ t+=v; n++; } }
  if(!n) throw E.div(); return r15(t/n); });
def('AVERAGEIFS','PROMEDIO.SI.CONJUNTO',STAT,'rango_promedio, rango_criterios1, criterio1, ...','Busca el promedio de las celdas que cumplen un determinado conjunto de condiciones o criterios.', a=>{ const n=ifsCore(a,1,Arr2(a[0])).filter(v=>typeof v==='number'); if(!n.length) throw E.div(); return r15(n.reduce((s,x)=>s+x,0)/n.length); });
def('COUNT','CONTAR',STAT,'valor1, [valor2], ...','Cuenta el número de celdas de un rango que contienen números.', a=>{
  let n=0; for(const [v,inR] of flatVals(a)){ if(inR){ if(typeof v==='number') n++; } else if(typeof v==='number'||typeof v==='boolean'||(typeof v==='string'&&typeof parseLiteral(v).v==='number')) n++; } return n; });
def('COUNTA','CONTARA',STAT,'valor1, [valor2], ...','Cuenta el número de celdas no vacías de un rango.', a=>flatVals(a).filter(([v])=>v!==null).length);
def('COUNTBLANK','CONTAR.BLANCO',STAT,'rango','Cuenta el número de celdas vacías dentro de un rango especificado.', a=>{ let n=0; for(const row of Arr2(a[0])) for(const v of row) if(v===null||v==='') n++; return n; });
def('COUNTIF','CONTAR.SI',STAT,'rango, criterio','Cuenta las celdas de un rango que coinciden con la condición dada.', a=>{ const R=Arr2(a[0]), f=makeCrit(a[1]); let n=0; for(const row of R) for(const v of row) if(f(v)) n++; return n; });
def('COUNTIFS','CONTAR.SI.CONJUNTO',STAT,'rango_criterios1, criterio1, ...','Cuenta el número de celdas que cumplen un determinado conjunto de condiciones o criterios.', a=>ifsCore(a,0,Arr2(a[0])).length);
def('MAX','MAX',STAT,'número1, [número2], ...','Devuelve el valor máximo de una lista de valores. Omite los valores lógicos y el texto.', a=>{ const n=nums(a); return n.length ? Math.max(...n) : 0; });
def('MIN','MIN',STAT,'número1, [número2], ...','Devuelve el valor mínimo de una lista de valores. Omite los valores lógicos y el texto.', a=>{ const n=nums(a); return n.length ? Math.min(...n) : 0; });
def('MAXIFS','MAX.SI.CONJUNTO',STAT,'rango_max, rango_criterios1, criterio1, ...','Devuelve el valor máximo de las celdas que cumplen un determinado conjunto de condiciones.', a=>{ const n=ifsCore(a,1,Arr2(a[0])).filter(v=>typeof v==='number'); return n.length ? Math.max(...n) : 0; });
def('MINIFS','MIN.SI.CONJUNTO',STAT,'rango_min, rango_criterios1, criterio1, ...','Devuelve el valor mínimo de las celdas que cumplen un determinado conjunto de condiciones.', a=>{ const n=ifsCore(a,1,Arr2(a[0])).filter(v=>typeof v==='number'); return n.length ? Math.min(...n) : 0; });
def('MEDIAN','MEDIANA',STAT,'número1, [número2], ...','Devuelve la mediana, o el número central de un conjunto de números.', a=>median(nums(a)));
def('MODE','MODA',STAT,'número1, [número2], ...','Devuelve el valor más frecuente o que más se repite en una matriz o rango de datos.', a=>{ const n=nums(a); const cnt=new Map(); let best=null, bc=1; for(const x of n){ const k=(cnt.get(x)||0)+1; cnt.set(x,k); if(k>bc){ bc=k; best=x; } } if(best===null) throw E.na(); return best; });
def('STDEV','DESVEST',STAT,'número1, [número2], ...','Calcula la desviación estándar de una muestra (omite los valores lógicos y el texto).', a=>r15(Math.sqrt(variance(nums(a)))));
def('VAR','VAR',STAT,'número1, [número2], ...','Calcula la varianza de una muestra (omite los valores lógicos y el texto).', a=>r15(variance(nums(a))));
def('LARGE','K.ESIMO.MAYOR',STAT,'matriz, k','Devuelve el k-ésimo valor mayor de un conjunto de datos. Por ejemplo, el quinto número más grande.', a=>{ const n=nums([a[0]]).sort((x,y)=>y-x); const k=Math.ceil(N(a[1])); if(k<1||k>n.length) throw E.num(); return n[k-1]; });
def('SMALL','K.ESIMO.MENOR',STAT,'matriz, k','Devuelve el k-ésimo valor menor de un conjunto de datos. Por ejemplo, el quinto número más pequeño.', a=>{ const n=nums([a[0]]).sort((x,y)=>x-y); const k=Math.ceil(N(a[1])); if(k<1||k>n.length) throw E.num(); return n[k-1]; });
def('RANK','JERARQUIA',STAT,'número, referencia, [orden]','Devuelve la jerarquía de un número dentro de una lista: su tamaño en comparación con otros valores de la lista.', a=>{ const x=N(a[0]); const list=nums([a[1]]); const asc=N(a[2],0)!==0; if(!list.includes(x)) throw E.na(); return 1+list.filter(v=> asc ? v<x : v>x).length; });

def('IF','SI',LOGIC,'prueba_lógica, [valor_si_verdadero], [valor_si_falso]','Comprueba si se cumple una condición y devuelve un valor si se evalúa como VERDADERO y otro valor si se evalúa como FALSO.', a=>{
  if(a.length<2) throw E.val(); const t=Bool(a[0]); const pick=t ? a[1] : a[2];
  if(pick===undefined) return false; if(pick===MISSING) return 0; return pick; });
def('IFS','SI.CONJUNTO',LOGIC,'prueba_lógica1, valor_si_verdadero1, ...','Comprueba si se cumplen una o varias condiciones y devuelve el valor correspondiente a la primera condición VERDADERA.', a=>{ for(let i=0;i+1<a.length;i+=2){ if(Bool(a[i])) return a[i+1]===MISSING?0:a[i+1]; } throw E.na(); });
def('IFERROR','SI.ERROR',LOGIC,'valor, valor_si_error','Devuelve valor_si_error si la expresión es un error y, si no, el valor de la propia expresión.', a=>{ const v=first(a[0]); if(isErr(v)) return given(a[1]) ? a[1] : 0; return v===MISSING?0:v; });
def('AND','Y',LOGIC,'valor_lógico1, [valor_lógico2], ...','Comprueba si todos los argumentos son VERDADEROS y devuelve VERDADERO si todos lo son.', a=>logicVals(a).every(Boolean));
def('OR','O',LOGIC,'valor_lógico1, [valor_lógico2], ...','Comprueba si alguno de los argumentos es VERDADERO. Devuelve FALSO solo si todos son FALSOS.', a=>logicVals(a).some(Boolean));
def('XOR','XO',LOGIC,'valor_lógico1, [valor_lógico2], ...','Devuelve un O exclusivo lógico de todos los argumentos.', a=>logicVals(a).filter(Boolean).length%2===1);
def('NOT','NO',LOGIC,'valor_lógico','Cambia FALSO por VERDADERO y VERDADERO por FALSO.', a=>!Bool(a[0]));
def('TRUE','VERDADERO',LOGIC,'','Devuelve el valor lógico VERDADERO.', ()=>true);
def('FALSE','FALSO',LOGIC,'','Devuelve el valor lógico FALSO.', ()=>false);

def('VLOOKUP','BUSCARV',LOOK,'valor_buscado, matriz_buscar_en, indicador_columnas, [rango]','Busca un valor en la primera columna de la izquierda de una tabla y devuelve un valor en la misma fila desde una columna especificada.', a=>{
  const lv=sc(a[0]); const T=Arr2(a[1]); const col=Math.trunc(N(a[2])); const approx=Bool(a[3],true);
  if(col<1) throw E.val(); if(col>T[0].length) throw E.ref();
  const r=findIn(T.map(row=>row[0]), lv, approx?1:0); if(r<0) throw E.na(); return T[r][col-1]; });
def('HLOOKUP','BUSCARH',LOOK,'valor_buscado, matriz_buscar_en, indicador_filas, [ordenado]','Busca en la primera fila de una tabla o matriz de valores y devuelve el valor en la misma columna desde una fila especificada.', a=>{
  const lv=sc(a[0]); const T=Arr2(a[1]); const row=Math.trunc(N(a[2])); const approx=Bool(a[3],true);
  if(row<1) throw E.val(); if(row>T.length) throw E.ref();
  const c=findIn(T[0], lv, approx?1:0); if(c<0) throw E.na(); return T[row-1][c]; });
def('XLOOKUP','BUSCARX',LOOK,'valor_buscado, matriz_buscada, matriz_devuelta, [si_no_se_encuentra], [modo_de_coincidencia]','Busca una coincidencia en un rango o una matriz y devuelve el elemento correspondiente de un segundo rango o matriz.', a=>{
  const lv=sc(a[0]); const L=Arr2(a[1]); const vertical=L[0].length===1; const list=vertical ? L.map(r=>r[0]) : L[0];
  const mm=Math.trunc(N(a[4],0)); let i=findIn(list, lv, 0);
  if(i<0 && (mm===-1||mm===1)){
    list.forEach((v,k)=>{ if(v===null||typeRank(v)!==typeRank(lv)) return; const c=cmp(v,lv);
      if(mm===-1 && c<0 && (i<0 || cmp(v,list[i])>0)) i=k;
      if(mm===1 && c>0 && (i<0 || cmp(v,list[i])<0)) i=k; });
  }
  if(i<0){ if(given(a[3])) return a[3]; throw E.na(); }
  const R=Arr2(a[2]);
  if(vertical){ if(!R[i]) throw E.val(); return R[0].length===1 ? R[i][0] : {arr:[R[i]]}; }
  if(R[0][i]===undefined) throw E.val(); return R.length===1 ? R[0][i] : {arr:R.map(row=>[row[i]])}; });
def('MATCH','COINCIDIR',LOOK,'valor_buscado, matriz_buscada, [tipo_de_coincidencia]','Devuelve la posición relativa de un elemento en una matriz que coincide con un valor especificado en un orden especificado.', a=>{
  const L=Arr2(a[1]); const list=L.length===1 ? L[0] : L.map(r=>r[0]); const i=findIn(list, sc(a[0]), Math.sign(N(a[2],1))); if(i<0) throw E.na(); return i+1; });
def('INDEX','INDICE',LOOK,'matriz, núm_fila, [núm_columna]','Devuelve un valor o la referencia de la celda en la intersección de una fila y una columna, en un rango especificado.', a=>{
  const T=Arr2(a[0]); let r=Math.trunc(N(a[1],0)), c=Math.trunc(N(a[2],0));
  if(T.length===1 && !given(a[2])){ c=r; r=1; }
  if(r===0 && T.length===1) r=1; if(c===0 && T[0].length===1) c=1;
  if(r<1||c<1||r>T.length||c>T[0].length) throw E.ref(); return T[r-1][c-1]; });
def('CHOOSE','ELEGIR',LOOK,'núm_índice, valor1, [valor2], ...','Elige un valor de una lista de valores a partir de un número de índice.', a=>{ const i=Math.trunc(N(a[0])); if(i<1||i>=a.length) throw E.val(); return a[i]===MISSING?0:a[i]; });
def('ROWS','FILAS',LOOK,'matriz','Devuelve el número de filas de una referencia o matriz.', a=>Arr2(a[0]).length);
def('COLUMNS','COLUMNAS',LOOK,'matriz','Devuelve el número de columnas de una matriz o referencia.', a=>Arr2(a[0])[0].length);

def('CONCAT','CONCAT',TEXT,'texto1, [texto2], ...','Concatena una lista o un rango de cadenas de texto.', a=>flatVals(a).map(([v])=>{ if(isErr(v)) throw v; return toStr(v); }).join(''));
def('CONCATENATE','CONCATENAR',TEXT,'texto1, [texto2], ...','Une varios elementos de texto en uno solo.', a=>a.filter(given).map(x=>Str(x)).join(''));
def('TEXTJOIN','UNIRCADENAS',TEXT,'delimitador, ignorar_vacías, texto1, [texto2], ...','Concatena una lista o un rango de cadenas de texto con un delimitador.', a=>{ const d=Str(a[0],''), ig=Bool(a[1],true); const parts=flatVals(a.slice(2)).map(([v])=>{ if(isErr(v)) throw v; return toStr(v); }); return (ig ? parts.filter(s=>s!=='') : parts).join(d); });
def('LEFT','IZQUIERDA',TEXT,'texto, [núm_de_caracteres]','Devuelve el número especificado de caracteres del principio de una cadena de texto.', a=>{ const n=Math.trunc(N(a[1],1)); if(n<0) throw E.val(); return Str(a[0]).slice(0,n); });
def('RIGHT','DERECHA',TEXT,'texto, [núm_de_caracteres]','Devuelve el número especificado de caracteres del final de una cadena de texto.', a=>{ const n=Math.trunc(N(a[1],1)); if(n<0) throw E.val(); const s=Str(a[0]); return n===0 ? '' : s.slice(-n); });
def('MID','EXTRAE',TEXT,'texto, posición_inicial, núm_de_caracteres','Devuelve los caracteres del centro de una cadena de texto, dada una posición y una longitud iniciales.', a=>{ const s=Str(a[0]), st=Math.trunc(N(a[1])), n=Math.trunc(N(a[2])); if(st<1||n<0) throw E.val(); return s.substr(st-1,n); });
def('LEN','LARGO',TEXT,'texto','Devuelve el número de caracteres de una cadena de texto.', a=>Str(a[0]).length);
def('UPPER','MAYUSC',TEXT,'texto','Convierte una cadena de texto en letras mayúsculas.', a=>Str(a[0]).toUpperCase());
def('LOWER','MINUSC',TEXT,'texto','Convierte todas las letras de una cadena de texto en minúsculas.', a=>Str(a[0]).toLowerCase());
def('PROPER','NOMPROPIO',TEXT,'texto','Convierte una cadena de texto en mayúsculas o minúsculas, según corresponda: la primera letra de cada palabra en mayúscula.', a=>Str(a[0]).toLowerCase().replace(/(^|[^a-z\u00E0-\u00FF])([a-z\u00E0-\u00FF])/g,(m,p,ch)=>p+ch.toUpperCase()));
def('TRIM','ESPACIOS',TEXT,'texto','Quita todos los espacios del texto excepto los espacios individuales entre palabras.', a=>Str(a[0]).trim().replace(/ +/g,' '));
def('SUBSTITUTE','SUSTITUIR',TEXT,'texto, texto_original, texto_nuevo, [núm_de_instancia]','Reemplaza el texto existente con texto nuevo en una cadena.', a=>{
  const s=Str(a[0]), o=Str(a[1]), nw=Str(a[2]); if(o==='') return s;
  if(!given(a[3])) return s.split(o).join(nw);
  const k=Math.trunc(N(a[3])); if(k<1) throw E.val(); let idx=-1; for(let i=0;i<k;i++){ idx=s.indexOf(o, idx+1); if(idx<0) return s; }
  return s.slice(0,idx)+nw+s.slice(idx+o.length); });
def('REPLACE','REEMPLAZAR',TEXT,'texto_original, núm_inicial, núm_de_caracteres, texto_nuevo','Reemplaza parte de una cadena de texto por otra.', a=>{ const s=Str(a[0]), st=Math.trunc(N(a[1])), n=Math.trunc(N(a[2])); if(st<1||n<0) throw E.val(); return s.slice(0,st-1)+Str(a[3])+s.slice(st-1+n); });
def('FIND','ENCONTRAR',TEXT,'texto_buscado, dentro_del_texto, [núm_inicial]','Devuelve la posición inicial de una cadena de texto dentro de otra. ENCONTRAR distingue mayúsculas de minúsculas.', a=>{ const st=Math.trunc(N(a[2],1)); const i=Str(a[1]).indexOf(Str(a[0]), st-1); if(st<1||i<0) throw E.val(); return i+1; });
def('SEARCH','HALLAR',TEXT,'texto_buscado, dentro_del_texto, [núm_inicial]','Devuelve el número del carácter en el que se encuentra por primera vez un texto, leyendo de izquierda a derecha (no distingue mayúsculas de minúsculas).', a=>{
  const f=Str(a[0]), w=Str(a[1]); const st=Math.trunc(N(a[2],1)); if(st<1) throw E.val();
  let i; if(/[*?]/.test(f)){ const m=wildRe(f,false).exec(w.slice(st-1)); i=m ? m.index+st-1 : -1; } else i=w.toLowerCase().indexOf(f.toLowerCase(), st-1);
  if(i<0) throw E.val(); return i+1; });
def('TEXT','TEXTO',TEXT,'valor, formato','Convierte un valor en texto con un formato de número específico.', a=>formatText(sc(a[0]), Str(a[1])));
def('VALUE','VALOR',TEXT,'texto','Convierte una cadena de texto que representa un número en un número.', a=>{ const x=toNum(sc(a[0])); if(isErr(x)) throw x; return x; });
def('REPT','REPETIR',TEXT,'texto, núm_de_veces','Repite el texto un número determinado de veces.', a=>{ const n=Math.trunc(N(a[1])); if(n<0||n>32767) throw E.val(); return Str(a[0]).repeat(n); });
def('EXACT','IGUAL',TEXT,'texto1, texto2','Comprueba si dos cadenas de texto son exactamente iguales. Distingue mayúsculas de minúsculas.', a=>Str(a[0])===Str(a[1]));

def('TODAY','HOY',DATE,'','Devuelve la fecha actual con formato de fecha.', ()=>todaySerial());
def('NOW','AHORA',DATE,'','Devuelve la fecha y hora actuales con formato de fecha y hora.', ()=>{ const d=new Date(); return todaySerial()+(d.getHours()*3600+d.getMinutes()*60+d.getSeconds())/86400; });
def('DATE','FECHA',DATE,'año, mes, día','Devuelve el número que representa la fecha en código de fecha y hora.', a=>{ let y=Math.trunc(N(a[0])); if(y<1900) y+=1900; const s=serialOf(y, Math.trunc(N(a[1]))-1, Math.trunc(N(a[2]))); if(s<0) throw E.num(); return s; });
def('YEAR','AÑO',DATE,'núm_de_serie','Devuelve el año de una fecha, un número entero entre 1900 y 9999.', a=>dateParts(a[0]).y);
def('MONTH','MES',DATE,'núm_de_serie','Devuelve el mes, un número entre 1 (enero) y 12 (diciembre).', a=>dateParts(a[0]).m+1);
def('DAY','DIA',DATE,'núm_de_serie','Devuelve el día del mes, un número entre 1 y 31.', a=>dateParts(a[0]).d);
def('WEEKDAY','DIASEM',DATE,'núm_de_serie, [tipo]','Devuelve un número entre 1 y 7 que identifica el día de la semana.', a=>{ const w=dateParts(a[0]).dow; const t=Math.trunc(N(a[1],1)); if(t===2) return ((w+6)%7)+1; if(t===3) return (w+6)%7; return w+1; });
def('DAYS','DIAS',DATE,'fecha_final, fecha_inicial','Devuelve el número de días entre dos fechas.', a=>Math.trunc(N(a[0]))-Math.trunc(N(a[1])));
def('HOUR','HORA',DATE,'núm_de_serie','Devuelve la hora como un número entre 0 (12:00 a. m.) y 23 (11:00 p. m.).', a=>{ const x=N(a[0]); return Math.floor(Math.round((x-Math.floor(x))*86400)/3600); });
def('MINUTE','MINUTO',DATE,'núm_de_serie','Devuelve el minuto, un número entre 0 y 59.', a=>{ const x=N(a[0]); return Math.floor(Math.round((x-Math.floor(x))*86400)/60)%60; });
def('EDATE','FECHA.MES',DATE,'fecha_inicial, meses','Devuelve el número de serie de la fecha que está un número indicado de meses antes o después de la fecha inicial.', a=>{ const p=dateParts(a[0]); const mo=p.m+Math.trunc(N(a[1])); const last=new Date(Date.UTC(p.y,mo+1,0)).getUTCDate(); return serialOf(p.y,mo,Math.min(p.d,last)); });
def('EOMONTH','FIN.MES',DATE,'fecha_inicial, meses','Devuelve el número de serie del último día del mes antes o después de un número especificado de meses.', a=>{ const p=dateParts(a[0]); return serialOf(p.y, p.m+Math.trunc(N(a[1]))+1, 0); });
def('DATEDIF','SIFECHA',DATE,'fecha_inicial, fecha_final, unidad','Calcula el número de días, meses o años entre dos fechas.', a=>{
  const s=Math.trunc(N(a[0])), e=Math.trunc(N(a[1])); if(s>e) throw E.num(); const u=Str(a[2]).toUpperCase();
  const ds=fromSerial(s), de=fromSerial(e);
  let months=(de.getUTCFullYear()-ds.getUTCFullYear())*12+de.getUTCMonth()-ds.getUTCMonth(); if(de.getUTCDate()<ds.getUTCDate()) months--;
  if(u==='D') return e-s; if(u==='M') return months; if(u==='Y'||u==='A') return Math.floor(months/12); if(u==='YM'||u==='AM') return months%12; throw E.num(); });
def('NETWORKDAYS','DIAS.LAB',DATE,'fecha_inicial, fecha_final','Devuelve el número total de días laborables entre dos fechas.', a=>{
  let s=Math.trunc(N(a[0])), e=Math.trunc(N(a[1])); const sign=s<=e?1:-1; if(s>e) [s,e]=[e,s]; if(e-s>200000) throw E.num();
  spend(((e-s)/50)|0); let n=0; for(let d=s; d<=e; d++){ const w=fromSerial(d).getUTCDay(); if(w!==0&&w!==6) n++; } return n*sign; });

def('ISBLANK','ESBLANCO',INFO,'valor','Comprueba si se refiere a una celda vacía y devuelve VERDADERO o FALSO.', a=>first(a[0])===null);
def('ISNUMBER','ESNUMERO',INFO,'valor','Comprueba si un valor es un número y devuelve VERDADERO o FALSO.', a=>typeof first(a[0])==='number');
def('ISTEXT','ESTEXTO',INFO,'valor','Comprueba si un valor es texto y devuelve VERDADERO o FALSO.', a=>typeof first(a[0])==='string');
def('ISERROR','ESERROR',INFO,'valor','Comprueba si un valor es un error y devuelve VERDADERO o FALSO.', a=>isErr(first(a[0])));
def('NA','NOD',INFO,'','Devuelve el valor de error #N/D (valor no disponible).', ()=>E.na());

def('PMT','PAGO',FIN,'tasa, nper, va, [vf], [tipo]','Calcula el pago de un préstamo basándose en pagos y una tasa de interés constantes.', a=>{
  const r=N(a[0]), n=N(a[1]), pv=N(a[2]), fv=N(a[3],0), t=N(a[4],0)?1:0; if(n===0) throw E.num();
  if(r===0) return r15(-(pv+fv)/n); const q=Math.pow(1+r,n); return r15(-(r*(fv+pv*q))/((1+r*t)*(q-1))); });
def('FV','VF',FIN,'tasa, nper, pago, [va], [tipo]','Devuelve el valor futuro de una inversión basándose en pagos periódicos y constantes y una tasa de interés constante.', a=>{
  const r=N(a[0]), n=N(a[1]), p=N(a[2]), pv=N(a[3],0), t=N(a[4],0)?1:0;
  if(r===0) return r15(-(pv+p*n)); const q=Math.pow(1+r,n); return r15(-(pv*q+p*(1+r*t)*(q-1)/r)); });
def('PV','VA',FIN,'tasa, nper, pago, [vf], [tipo]','Devuelve el valor actual de una inversión: la suma total del valor actual de una serie de pagos futuros.', a=>{
  const r=N(a[0]), n=N(a[1]), p=N(a[2]), fv=N(a[3],0), t=N(a[4],0)?1:0;
  if(r===0) return r15(-(fv+p*n)); const q=Math.pow(1+r,n); return r15(-(fv+p*(1+r*t)*(q-1)/r)/q); });

const CATS=[FIN,LOGIC,TEXT,DATE,LOOK,MATH,STAT,INFO];
const esName = k => FN[k].es || k;
const FN_LIST=Object.values(FN).sort((x,y)=>esName(x.name).localeCompare(esName(y.name),'es'));
const AC_LIST=Object.values(FN).flatMap(f=>[{name:f.es||f.name,f}].concat(f.es&&f.es!==f.name?[{name:f.name,f,en:true}]:[])).sort((x,y)=>x.name.localeCompare(y.name,'es'));

/* ================= Display formatting ================= */
const NF = (v,dec,group) => locNum(v.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec,useGrouping:group}));
const dateStr = v => fromSerial(v).toLocaleDateString('es',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'});
const timeStr = v => new Date(Date.UTC(2000,0,1)+Math.round((v-Math.floor(v))*86400)*1000).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'UTC'});
function display(v, s, auto){
  if(v===null) return '';
  if(isErr(v)) return errText(v.e);
  if(typeof v==='boolean') return boolText(v);
  if(typeof v==='string') return v;
  const fmt=(s&&s.fmt&&s.fmt!=='general') ? s.fmt : (auto||'general');
  const dec=(s&&s.dec!=null) ? s.dec : null;
  switch(fmt){
    case 'number': return NF(v,dec??2,false);
    case 'comma': return NF(v,dec??2,true);
    case 'currency': return (v<0?'-':'')+'$'+NF(Math.abs(v),dec??2,true);
    case 'accounting': return v===0 ? '$ -' : v<0 ? '-$ '+NF(-v,dec??2,true) : '$ '+NF(v,dec??2,true);
    case 'percent': return NF(v*100,dec??0,false)+' %'.trim();
    case 'scientific': return locNum(v.toExponential(dec??2).toUpperCase().replace(/E([+-])(\d)$/,'E$10$2'));
    case 'date': return v<0 ? '########' : dateStr(v);
    case 'longdate': return v<0 ? '########' : fromSerial(v).toLocaleDateString('es',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'UTC'});
    case 'time': return timeStr(v);
    case 'datetime': return dateStr(v)+' '+timeStr(v).slice(0,5);
    default: return dec!=null ? NF(v,dec,false) : fmtGeneral(v);
  }
}
const DATE_FNS={TODAY:'date',DATE:'date',EDATE:'date',EOMONTH:'date',NOW:'datetime'};
const MONEY_FNS={PMT:'currency',FV:'currency',PV:'currency'};
function cellFmt(si,r,c){ const sh=S.wb.sheets[si]; const cell=sh&&sh.cells[A(r,c)]; const f=cell&&cell.s&&cell.s.fmt; return (f && f!=='general' && f!=='text') ? f : null; }
function fmtOf(n,depth){
  if(!n||depth>6) return null;
  switch(n.t){
    case 'ref': case 'range': { const si=n.sheet==null?S.cur:sheetIndex(n.sheet); if(si<0) return null; return n.t==='ref' ? cellFmt(si,n.r,n.c) : cellFmt(si,n.r1,n.c1); }
    case 'bin': return ['+','-','*','/'].includes(n.op) ? (fmtOf(n.l,depth+1)||fmtOf(n.r,depth+1)) : null;
    case 'neg': return fmtOf(n.e,depth+1);
    case 'fn': { const k=resolveFn(n.name); if(DATE_FNS[k]) return DATE_FNS[k]; if(MONEY_FNS[k]) return MONEY_FNS[k];
      if(['SUM','AVERAGE','MIN','MAX','ROUND','ROUNDUP','ROUNDDOWN','MEDIAN','LARGE','SMALL','IF','IFERROR','ABS','INT','SUMIFS','AVERAGEIFS','MAXIFS','MINIFS'].includes(k)){
        for(const a of n.args){ const f=fmtOf(a,depth+1); if(f) return f; } }
      if(k==='SUMIF'||k==='AVERAGEIF') return fmtOf(n.args[2]||n.args[0],depth+1);
      return null; }
  }
  return null;
}
const autoFmt = raw => fmtOf(getAst(raw),0);
/* What the formula bar shows for a cell (regional format) */
function editText(cell){
  if(!cell || cell.v==null) return '';
  const v=cell.v;
  if(v[0]==='=' && !cell.str) return toLocalFormula(v);
  if(cell.str) return v;
  const fmt=cell.s&&cell.s.fmt; const p=parseLiteral(v, fmt, 'canon').v;
  if(typeof p==='boolean') return boolText(p);
  if(typeof p!=='number') return v;
  if(fmt==='percent') return fmtGeneral(r15(p*100))+'%';
  if(fmt==='date'||fmt==='longdate') return dateStr(p);
  if(fmt==='time') return timeStr(p);
  if(fmt==='datetime') return dateStr(p)+' '+timeStr(p);
  return fmtGeneral(p);
}

/* ================= Engine helpers ================= */
function recalc(){ cache.clear(); calcing.clear(); circular.clear(); }
function setWorkbook(w, current){ S.wb = w; S.cur = current || 0; recalc(); }
/* Evaluates formula text such as "=SUMA(A1:A3)" (canonical syntax: dot decimal, comma separator). */
function evalFormulaText(text, si){
  const src = String(text)[0] === '=' ? String(text) : '=' + text;
  try{
    const v = evalNode(getAst(src), { si: si || 0 });
    return isArr(v) ? v.arr[0][0] : v;
  }catch(e){ if(isErr(e)) return e; throw e; }
}

return { S, ROWS, COLS, colName, colIndex, A, parseA, parseRangeText, XErr, isErr, E, ERR_ES, ERR_IN, errText, MISSING, isArr, r15, boolText, EPOCH, fromSerial, todaySerial, parseDateText, parseLiteral, fmtGeneralCanon, fmtGeneral, toNum, toStr, toBool, typeRank, cmp, scalarOp, arrGet, lift2, lift1, tokenize, parseFormula, balanceParens, SPLIT_RE, mapOutside, NUM_LB, toCanonFormula, toLocalFormula, shiftFormula, localizeFns, refsInFormula, sheet, cache, calcing, circular, astCache, getAst, sheetIndex, storedValue, cellValue, rangeVal, evalNode, FN, ALIAS, def, resolveFn, given, sc, N, Str, Bool, Arr2, first, flatVals, nums, total, roundTo, wildRe, makeCrit, ifsCore, findIn, pad2, swapSeps, formatText, logicVals, dateParts, serialOf, median, variance, MATH, STAT, LOGIC, LOOK, TEXT, DATE, INFO, FIN, CATS, esName, FN_LIST, AC_LIST, NF, dateStr, timeStr, display, DATE_FNS, MONEY_FNS, cellFmt, fmtOf, autoFmt, editText, locNum, recalc, setWorkbook, evalFormulaText, sanitizeWorkbook, spend };
}

root.GridEngine = { createEngine, sanitizeWorkbook, ROWS, COLS };
})(typeof globalThis !== 'undefined' ? globalThis : this);

// Lógica de negocio pura: saldos, tipos de cambio, reparto mensual y cierre.
import * as db from './db.js';

// ---- Utilidades ----------------------------------------------------------

export const ymOf = (date) => date.slice(0, 7);
export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const curYm = () => ymOf(todayStr());
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const monthName = (ym) => `${MESES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const monthShort = (ym) => MESES[Number(ym.slice(5, 7)) - 1].slice(0, 3);

export function monthsBetween(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

// ---- Configuración -------------------------------------------------------

export const DEFAULT_SETTINGS = {
  id: 'main',
  baseCurrency: 'CLP',
  ownerId: null,
  settleStart: null,
  currencies: [
    { code: 'CLP', symbol: '$', decimals: 0, convertible: true },
    { code: 'USD', symbol: 'US$', decimals: 2, convertible: true },
    { code: 'EUR', symbol: '€', decimals: 2, convertible: true },
    { code: 'UF', symbol: 'UF', decimals: 2, convertible: true },
  ],
};

export function settings() {
  return db.get('settings', 'main') || { ...DEFAULT_SETTINGS };
}
export const base = () => settings().baseCurrency || 'CLP';
export function currencyInfo(code) {
  return settings().currencies.find(c => c.code === code) || { code, symbol: code, decimals: 2, convertible: false };
}

export const people = () => db.all('people').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
export const personName = (id) => (db.get('people', id) || {}).name || '?';
export const ownerId = () => settings().ownerId || (people()[0] || {}).id;

const ME_KEY = 'moni.me';
export function meId() {
  let v = null;
  try { v = localStorage.getItem(ME_KEY); } catch { /* ignore */ }
  return (v && db.get('people', v)) ? v : ownerId();
}
export function setMeId(id) { try { localStorage.setItem(ME_KEY, id); } catch { /* ignore */ } }

export const accounts = () => db.all('accounts').filter(a => !a.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
export const categories = () => db.all('categories').sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
// Una categoría combinada en otra queda archivada con `mergedInto`: se resuelve a su destino, así los
// movimientos que lleguen después desde otro teléfono también suman en la categoría final.
export const category = (id) => {
  let c = db.get('categories', id);
  for (let i = 0; c && c.mergedInto && i < 8; i++) { const n = db.get('categories', c.mergedInto); if (!n) break; c = n; }
  return c;
};
export const account = (id) => db.get('accounts', id);

// ---- Formato y parseo ----------------------------------------------------

export function fmt(n, cur, { sign = false } = {}) {
  const c = currencyInfo(cur || base());
  let v = Number(n) || 0;
  if (Math.abs(v) < Math.pow(10, -c.decimals) / 2) v = 0; // evita "-$0"
  const s = new Intl.NumberFormat('es-CL', { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals }).format(Math.abs(v));
  const pre = v < 0 ? '-' : (sign && v > 0 ? '+' : '');
  const sym = c.symbol === '$' ? '$' : c.symbol + ' ';
  return `${pre}${sym}${s}`;
}

export function parseAmount(str) {
  let s = String(str ?? '').trim().replace(/\s|\$/g, '');
  if (!s) return NaN;
  const hasC = s.includes(','), hasD = s.includes('.');
  if (hasC && hasD) {
    // el separador que va al final es el decimal: "1.234,56" (Chile) o "1,234.56" (EE.UU.)
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (hasC) s = s.replace(',', '.');
  // "12.500" o "-1.478.100" son miles; "0.125" no puede serlo (ningún número parte con 0 de miles)
  else if (hasD && /^-?[1-9]\d{0,2}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// Monto con operaciones simples, como en las celdas del Excel: "7.000+6.900", "45.990-5.000", "12.500*2".
// Cada número usa el formato chileno de parseAmount; * y / van antes que + y -.
export const isAmountExpression = (str) => /[+*/x×÷]|\d\s*-/i.test(String(str ?? '').replace(/^\s*-/, ''));
export function evalAmount(str) {
  const src = String(str ?? '').replace(/\s|\$/g, '').replace(/[x×]/gi, '*').replace(/÷/g, '/');
  if (!src) return NaN;
  if (!isAmountExpression(src)) return parseAmount(src);
  const tokens = src.match(/\d[\d.,]*|[+\-*/]/g);
  if (!tokens || tokens.join('') !== src) return NaN;
  // números (con signo unario) y operadores alternados
  const nums = [], ops = [];
  let expectNum = true, neg = false;
  for (const t of tokens) {
    if (expectNum) {
      if (t === '-' || t === '+') { if (t === '-') neg = !neg; continue; }
      const n = parseAmount(t);
      if (!Number.isFinite(n)) return NaN;
      nums.push(neg ? -n : n); neg = false; expectNum = false;
    } else {
      if (!/^[+\-*/]$/.test(t)) return NaN;
      ops.push(t); expectNum = true;
    }
  }
  if (expectNum) return NaN;                       // termina en operador
  // primero * y /
  for (let i = 0; i < ops.length;) {
    if (ops[i] === '*' || ops[i] === '/') {
      const r = ops[i] === '*' ? nums[i] * nums[i + 1] : nums[i] / nums[i + 1];
      nums.splice(i, 2, r); ops.splice(i, 1);
    } else i++;
  }
  let v = nums[0];
  ops.forEach((o, i) => { v = o === '+' ? v + nums[i + 1] : v - nums[i + 1]; });
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : NaN;
}

// ---- Tipos de cambio -----------------------------------------------------

let rateIdx = null;
db.subscribe((changed) => { if (!changed || changed.has('rates')) rateIdx = null; });

function buildRates() {
  rateIdx = new Map();
  for (const r of db.all('rates')) {
    if (!rateIdx.has(r.cur)) rateIdx.set(r.cur, []);
    rateIdx.get(r.cur).push(r);
  }
  for (const a of rateIdx.values()) a.sort((x, y) => x.date.localeCompare(y.date));
}

// Último valor conocido a la fecha (o el más antiguo si la fecha es anterior a todos).
export function rateFor(cur, date) {
  if (cur === base()) return 1;
  if (!rateIdx) buildRates();
  const arr = rateIdx.get(cur);
  if (!arr || !arr.length) return null;
  date = date || todayStr();
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return arr[best >= 0 ? best : 0].rate;
}

export const txFx = (tx) => (tx.fx != null ? tx.fx : (rateFor(tx.currency, tx.date) ?? 1));
export const txBase = (tx) => tx.amount * txFx(tx);

export function toBase(amount, cur, date) {
  const r = rateFor(cur, date);
  return amount * (r ?? 1);
}

// ---- Movimientos ---------------------------------------------------------

export function txsInMonth(ym) {
  return db.all('tx').filter(t => t.date.slice(0, 7) === ym);
}

export function sortTx(arr) {
  return arr.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
}

// efecto del movimiento sobre una cuenta (en la moneda de la cuenta)
function effects(tx, owner) {
  const out = [];
  switch (tx.kind) {
    case 'out': if (tx.accountId) out.push([tx.accountId, -tx.amount]); break;
    case 'in': if (tx.accountId) out.push([tx.accountId, tx.amount]); break;
    case 'transfer':
      if (tx.accountId) out.push([tx.accountId, -tx.amount]);
      if (tx.toAccountId) out.push([tx.toAccountId, tx.toAmount ?? tx.amount]);
      break;
    case 'settle':
      if (tx.accountId) out.push([tx.accountId, tx.paidBy === owner ? -tx.amount : tx.amount]);
      break;
  }
  return out;
}

export function accountBalances() {
  const owner = ownerId();
  const bal = new Map();
  for (const tx of db.all('tx')) for (const [id, v] of effects(tx, owner)) bal.set(id, (bal.get(id) || 0) + v);
  return bal;
}

export function netWorth() {
  const bal = accountBalances();
  let cash = 0, cards = 0, missing = new Set();
  const noValue = (cur) => currencyInfo(cur).convertible === false;   // millas, puntos: no suman al patrimonio
  for (const a of accounts()) {
    if (noValue(a.currency)) continue;
    const v = bal.get(a.id) || 0;
    const r = rateFor(a.currency, todayStr());
    if (r == null) missing.add(a.currency);
    const b = v * (r ?? 1);
    if (a.type === 'credit') cards += b; else cash += b;
  }
  let inv = 0;
  for (const i of investmentSummaries()) {
    const info = currencyInfo(i.currency);
    if (info.convertible === false) continue;
    const r = rateFor(i.currency, todayStr());
    if (r == null) missing.add(i.currency);
    inv += i.balance * (r ?? 1);
  }
  let debts = 0;
  for (const d of debtSummaries()) {
    if (d.excludeNW || noValue(d.currency)) continue;
    const r = rateFor(d.currency, todayStr());
    if (r == null) missing.add(d.currency);
    debts += (d.direction === 'owe' ? -1 : 1) * d.balance * (r ?? 1);
  }
  return { cash, cards, inv, debts, total: cash + cards + inv + debts, missing: [...missing] };
}

// ---- Inversiones ---------------------------------------------------------

export function investmentSummaries() {
  const entries = db.all('invEntries');
  return db.all('investments').filter(i => !i.archived).map(i => {
    let contrib = 0, withdraw = 0, gain = 0, last = null;
    for (const e of entries) {
      if (e.invId !== i.id) continue;
      if (e.kind === 'contrib') contrib += e.amount;
      else if (e.kind === 'withdraw') withdraw += e.amount;
      else gain += e.amount;
      if (!last || e.date > last) last = e.date;
    }
    const balance = contrib - withdraw + gain;
    const invested = contrib - withdraw;
    return { ...i, contrib, withdraw, gain, balance, invested, last, ret: contrib ? gain / contrib : 0 };
  }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

// ---- Deudas --------------------------------------------------------------

export function debtSummaries() {
  const entries = db.all('debtEntries');
  return db.all('debts').filter(d => !d.archived).map(d => {
    let balance = 0, last = null;
    for (const e of entries) if (e.debtId === d.id) { balance += e.amount; if (!last || e.date > last) last = e.date; }
    return { ...d, balance, last };
  });
}

// ---- Reparto de gastos compartidos --------------------------------------

// % por persona para un mes. Se arrastra el último período definido anterior o igual.
export function splitFor(ym) {
  const ps = people();
  const list = db.all('splits').sort((a, b) => a.ym.localeCompare(b.ym));
  let s = null;
  for (const x of list) if (x.ym <= ym) s = x;
  if (!s) s = list[0];
  const out = {};
  if (s && s.mode === 'pct' && s.pct) {
    const tot = ps.reduce((a, p) => a + (s.pct[p.id] || 0), 0) || 1;
    for (const p of ps) out[p.id] = (s.pct[p.id] || 0) / tot;
  } else if (s && s.incomes) {
    const tot = ps.reduce((a, p) => a + (s.incomes[p.id] || 0), 0);
    for (const p of ps) out[p.id] = tot ? (s.incomes[p.id] || 0) / tot : 1 / ps.length;
  } else for (const p of ps) out[p.id] = 1 / ps.length;
  return { pct: out, source: s || null };
}

function shares(tx, cat, pct, ps) {
  // devuelve {pid: fracción} según la asignación del movimiento
  if (tx.alloc && tx.alloc.startsWith('p:')) return { [tx.alloc.slice(2)]: 1 };
  if (tx.alloc === 'shared') {
    const mode = (cat && cat.splitMode) || 'prop';
    if (mode === 'equal') { const o = {}; for (const p of ps) o[p.id] = 1 / ps.length; return o; }
    if (mode === 'fixed' && cat.fixedPct) {
      const tot = ps.reduce((a, p) => a + (cat.fixedPct[p.id] || 0), 0) || 1;
      const o = {}; for (const p of ps) o[p.id] = (cat.fixedPct[p.id] || 0) / tot; return o;
    }
    return pct;
  }
  return null; // no repartido
}

export const settleMonthOf = (tx) => tx.settleMonth || tx.date.slice(0, 7);

// Cierre de un mes: quién pagó, cuánto le corresponde a cada uno, pagos registrados.
export function statement(ym) {
  const ps = people();
  const { pct, source } = splitFor(ym);
  const paid = {}, owed = {}, gave = {}, got = {};
  for (const p of ps) { paid[p.id] = 0; owed[p.id] = 0; gave[p.id] = 0; got[p.id] = 0; }
  const lines = new Map();
  const settlements = [];
  for (const tx of db.all('tx')) {
    if (tx.kind === 'settle') {
      if (settleMonthOf(tx) !== ym) continue;
      const b = txBase(tx);
      settlements.push(tx);
      if (gave[tx.paidBy] != null) gave[tx.paidBy] += b;
      if (got[tx.to] != null) got[tx.to] += b;
      continue;
    }
    if (tx.date.slice(0, 7) !== ym) continue;
    if (tx.kind !== 'out' && tx.kind !== 'in') continue;
    const cat = category(tx.categoryId);
    const sh = shares(tx, cat, pct, ps);
    if (!sh) continue;
    const sign = tx.kind === 'in' ? -1 : 1;
    const b = txBase(tx) * sign;
    if (paid[tx.paidBy] != null) paid[tx.paidBy] += b;
    const key = tx.categoryId || '_';
    if (!lines.has(key)) lines.set(key, { cat, total: 0, owed: {}, paid: {}, n: 0 });
    const ln = lines.get(key);
    ln.total += b; ln.n++;
    ln.paid[tx.paidBy] = (ln.paid[tx.paidBy] || 0) + b;
    for (const [pid, f] of Object.entries(sh)) {
      if (owed[pid] != null) owed[pid] += b * f;
      ln.owed[pid] = (ln.owed[pid] || 0) + b * f;
    }
  }
  const net = {};
  let total = 0;
  for (const p of ps) { net[p.id] = paid[p.id] - owed[p.id] + gave[p.id] - got[p.id]; }
  for (const l of lines.values()) total += l.total;
  return {
    ym, pct, source, paid, owed, gave, got, net, total, settlements,
    lines: [...lines.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
  };
}

// Saldo acumulado entre las personas desde el mes de inicio del cuadre.
export function ledger(ym) {
  const s = settings();
  const start = s.settleStart && s.settleStart <= ym ? s.settleStart : ym;
  const ps = people();
  const carry = {};
  for (const p of ps) carry[p.id] = 0;
  for (let m = start; m < ym; m = addMonths(m, 1)) {
    const st = statement(m);
    for (const p of ps) carry[p.id] += st.net[p.id];
  }
  const st = statement(ym);
  const balance = {};
  for (const p of ps) balance[p.id] = carry[p.id] + st.net[p.id];
  return { ...st, carry, balance, start };
}

// Traduce saldos a una frase: "B debe a A $X" (2 personas) o lista (n).
export function settleSummary(balance) {
  const ps = people();
  const rows = ps.map(p => ({ id: p.id, name: p.name, v: balance[p.id] || 0 }));
  const pos = rows.filter(r => r.v > 0.5).sort((a, b) => b.v - a.v);
  const neg = rows.filter(r => r.v < -0.5).sort((a, b) => a.v - b.v);
  const transfers = [];
  const p = pos.map(r => ({ ...r })), n = neg.map(r => ({ ...r, v: -r.v }));
  let i = 0, j = 0;
  while (i < p.length && j < n.length) {
    const amt = Math.min(p[i].v, n[j].v);
    transfers.push({ from: n[j].id, to: p[i].id, amount: amt });
    p[i].v -= amt; n[j].v -= amt;
    if (p[i].v < 0.5) i++;
    if (n[j].v < 0.5) j++;
  }
  return transfers;
}

// ---- Reportes ------------------------------------------------------------

// Gasto del mes por categoría, en moneda base. mode 'total' | 'mine'.
export function spendingByCategory(ym, mode = 'total', pid = null) {
  const ps = people();
  const { pct } = splitFor(ym);
  const me = pid || meId();
  const map = new Map();
  let total = 0;
  for (const tx of txsInMonth(ym)) {
    if (tx.kind !== 'out' && tx.kind !== 'in') continue;
    const cat = category(tx.categoryId);
    if (!cat || cat.kind !== 'expense') continue;
    const sign = tx.kind === 'in' ? -1 : 1;
    let b = txBase(tx) * sign;
    if (mode === 'mine') {
      const sh = shares(tx, cat, pct, ps);
      if (sh) b *= (sh[me] || 0);
      else if (tx.paidBy !== me) continue;
    }
    map.set(cat.id, (map.get(cat.id) || 0) + b);
    total += b;
  }
  const rows = [...map.entries()].map(([id, v]) => ({ cat: category(id), v })).sort((a, b) => b.v - a.v);
  return { rows, total };
}

// Ingresos del mes; con pid, solo los que recibió esa persona (para "Mi parte").
export function incomeOfMonth(ym, pid = null) {
  let t = 0;
  for (const tx of txsInMonth(ym)) {
    if (tx.kind !== 'in') continue;
    if (pid && tx.paidBy !== pid) continue;
    const cat = category(tx.categoryId);
    if (cat && cat.kind === 'income') t += txBase(tx);
  }
  return t;
}

// ---- Asistentes: sugerencias por descripción --------------------------------

// quita tildes pero conserva la ñ ("pañales" no debe coincidir con "pantalones")
export const stripAccents = (s) => String(s || '').replace(/ñ/g, '').replace(/Ñ/g, '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(//g, 'ñ').replace(//g, 'Ñ');
const normKey = (s) => stripAccents(String(s || '').toLowerCase()).replace(/\s+/g, ' ').trim();

let descIdx = null;
db.subscribe((ch) => { if (!ch || ch.has('tx') || ch.has('categories')) descIdx = null; });

function buildDescIdx() {
  const m = new Map();
  for (const t of db.all('tx')) {
    if ((t.kind !== 'out' && t.kind !== 'in') || !t.desc) continue;
    const k = normKey(t.desc);
    if (!k) continue;
    // una misma descripción puede tener variantes ("Jumbo" que pagó la otra persona vs "Jumbo" que pagué yo)
    const cat = category(t.categoryId);
    const key = [t.kind, k, cat ? cat.id : '', t.paidBy].join('|');
    const e = m.get(key);
    if (!e) m.set(key, { key: k, kind: t.kind, count: 1, last: t });
    else {
      e.count++;
      if (t.date > e.last.date || (t.date === e.last.date && (t.createdAt || 0) > (e.last.createdAt || 0))) e.last = t;
    }
  }
  descIdx = [...m.values()];
}

// Movimientos anteriores cuya descripción empieza (o tiene una palabra que empieza) con lo escrito.
// Cada sugerencia es una variante (descripción + categoría + quién pagó) y trae su último movimiento:
// cuenta, reparto y monto. Primero las que pagó `payer` (la persona de este teléfono).
export function suggestDescriptions(q, kind = 'out', limit = 4, payer = null) {
  const nq = normKey(q);
  if (nq.length < 2) return [];
  if (!descIdx) buildDescIdx();
  const today = todayStr();
  const ago = (d) => (Date.parse(today) - Date.parse(d)) / 864e5;
  const out = [];
  for (const e of descIdx) {
    if (e.kind !== kind) continue;
    const rank = e.key.startsWith(nq) ? 0 : e.key.includes(' ' + nq) ? 1 : -1;
    if (rank < 0) continue;
    const cat = category(e.last.categoryId);
    if (!cat) continue;
    const age = ago(e.last.date);
    out.push({ ...e, rank, cat, score: e.count * (age < 90 ? 3 : age < 365 ? 1.5 : 1) });
  }
  const mine = (e) => (payer && e.last.paidBy === payer ? 0 : 1);
  out.sort((a, b) => a.rank - b.rank || mine(a) - mine(b) || b.score - a.score || b.last.date.localeCompare(a.last.date));
  return out.slice(0, limit);
}

// Categorías cuyo nombre (o una de sus palabras) empieza con lo escrito.
export function suggestCategories(q, kinds, limit = 2) {
  const nq = normKey(q);
  if (nq.length < 2) return [];
  return categories().filter(c => !c.archived && (!kinds || kinds.includes(c.kind)))
    .filter(c => { const n = normKey(c.name); return n.startsWith(nq) || n.includes(' ' + nq); })
    .slice(0, limit);
}

// ---- Asistentes: ordenar categorías -----------------------------------------

// Nombre "base" para encontrar gemelas heredadas del Excel: "Comida (compartida)" ≈ "Comida",
// "Otros Gastos" ≈ "Otros (compartidos)", "Maite Solo" ≈ "Maite".
const QUALIFIERS = new Set(['compartido', 'compartida', 'compartidos', 'compartidas', 'solo', 'sola', 'gasto', 'gastos']);
function baseName(name) {
  return stripAccents(String(name).replace(/\([^)]*\)/g, ' ').toLowerCase())
    .split(/[^a-z0-9ñ]+/).filter(Boolean)
    .filter(w => !QUALIFIERS.has(w))
    .map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ');
}
const hasQualifier = (name) => /\(/.test(name) || String(name).split(/\s+/).some(w => QUALIFIERS.has(stripAccents(w.toLowerCase())));

export function categoryCleanup() {
  const cats = categories().filter(c => !c.archived);
  const uses = new Map(), recent = new Set();
  const cutoff = addMonths(curYm(), -12) + '-01';
  for (const t of db.all('tx')) {
    if (!t.categoryId) continue;
    uses.set(t.categoryId, (uses.get(t.categoryId) || 0) + 1);
    if (t.date >= cutoff) recent.add(t.categoryId);
  }
  const groups = new Map();
  for (const c of cats) {
    const b = baseName(c.name);
    if (!b) continue;
    const k = c.kind + '|' + b;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const twins = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // destino: el nombre sin "(...)" ni calificativos; si empatan, el más usado
    list.sort((a, b) => (/\(/.test(a.name) - /\(/.test(b.name)) || (hasQualifier(a.name) - hasQualifier(b.name)) || ((uses.get(b.id) || 0) - (uses.get(a.id) || 0)));
    const to = list[0];
    const finalName = /\(/.test(to.name) ? to.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim() : to.name;
    for (const from of list.slice(1)) twins.push({ from, to, count: uses.get(from.id) || 0, finalName });
  }
  const monthAgo = Date.now() - 30 * 864e5;
  const unused = cats.filter(c => !recent.has(c.id) && (uses.has(c.id) || (c.createdAt || 0) < monthAgo));
  return { twins, unused, uses };
}

// Combina "from" en "to": mueve sus movimientos (cada uno conserva su reparto y quién pagó) y deja
// "from" archivada como alias de "to". Devuelve lo necesario para deshacer.
export async function mergeCategory(fromId, toId, { rename } = {}) {
  const from = db.get('categories', fromId), to = db.get('categories', toId);
  if (!from || !to || fromId === toId) throw new Error('Elige dos categorías distintas');
  const moved = db.all('tx').filter(t => t.categoryId === fromId);
  if (moved.length) await db.putMany('tx', moved.map(t => ({ ...t, categoryId: toId })));
  await db.put('categories', { ...from, archived: true, mergedInto: toId });
  const prevName = to.name;
  if (rename && rename !== to.name) await db.put('categories', { ...db.get('categories', toId), name: rename });
  // los pendientes que apuntaban a "from" pasan a "to"
  const st = settings();
  const swap = (arr) => (arr || []).map(id => (id === fromId ? toId : id));
  if ((st.pendingIgnore || []).includes(fromId) || Object.values(st.pendingSkip || {}).some(a => a.includes(fromId))) {
    await db.put('settings', { ...st, pendingIgnore: swap(st.pendingIgnore), pendingSkip: Object.fromEntries(Object.entries(st.pendingSkip || {}).map(([k, v]) => [k, swap(v)])) });
  }
  return { fromId, toId, movedIds: moved.map(t => t.id), prevName };
}

export async function undoMerge({ fromId, toId, movedIds, prevName }) {
  const back = movedIds.map(id => db.get('tx', id)).filter(t => t && t.categoryId === toId).map(t => ({ ...t, categoryId: fromId }));
  if (back.length) await db.putMany('tx', back);
  const from = db.get('categories', fromId);
  if (from) { const { mergedInto, ...rest } = from; await db.put('categories', { ...rest, archived: false }); }
  const to = db.get('categories', toId);
  if (to && to.name !== prevName) await db.put('categories', { ...to, name: prevName });
}

// ---- Asistentes: cuentas fijas y pendientes del mes ----------------------------

// Gastos que se pagan ~1 vez al mes: presentes en 5 de los 6 meses cerrados anteriores, con un solo
// pago en al menos el 70% de esos meses. "fixed" = el monto casi no varía (±5%).
export function recurringBills(ref = curYm()) {
  const months = monthsBetween(addMonths(ref, -6), addMonths(ref, -1));
  const idx = new Map(months.map((m, i) => [m, i]));
  const ignore = new Set(settings().pendingIgnore || []);
  const per = new Map();
  for (const t of db.all('tx')) {
    if (t.kind !== 'out') continue;
    const i = idx.get(t.date.slice(0, 7));
    if (i === undefined) continue;
    const cat = category(t.categoryId);
    if (!cat || cat.kind !== 'expense' || cat.archived || ignore.has(cat.id)) continue;
    let e = per.get(cat.id);
    if (!e) per.set(cat.id, (e = { cat, totals: months.map(() => 0), counts: months.map(() => 0), days: [], last: null }));
    e.totals[i] += txBase(t); e.counts[i]++; e.days.push(Number(t.date.slice(8)));
    if (!e.last || t.date > e.last.date || (t.date === e.last.date && (t.createdAt || 0) > (e.last.createdAt || 0))) e.last = t;
  }
  const out = [];
  for (const e of per.values()) {
    const present = e.counts.filter(n => n > 0).length;
    const single = e.counts.filter(n => n === 1).length;
    if (present < 5 || single / present < 0.7) continue;
    const vals = e.totals.filter(v => v > 0);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
    const sorted = [...vals].sort((a, b) => a - b);
    const days = [...e.days].sort((a, b) => a - b);
    out.push({ catId: e.cat.id, cat: e.cat, median: sorted[Math.floor(sorted.length / 2)], fixed: mean > 0 && sd / mean <= 0.05, day: days[Math.floor(days.length / 2)], template: e.last });
  }
  return out.sort((a, b) => a.day - b.day || a.cat.name.localeCompare(b.cat.name));
}

// Lo que falta hacer este mes: cuentas fijas sin registrar, cierre del mes anterior sin saldar,
// inversiones sin valorizar hace más de 35 días y respaldo atrasado (más de 14 días).
export function pendingItems(ref = curYm(), { lastBackup = null, now = Date.now() } = {}) {
  const items = [];
  const bills = recurringBills(ref);
  const skip = new Set((settings().pendingSkip || {})[ref] || []);
  const paid = new Set();
  for (const t of db.all('tx')) if (t.kind === 'out' && t.date.slice(0, 7) === ref) { const c = category(t.categoryId); if (c) paid.add(c.id); }
  let done = 0;
  for (const b of bills) {
    if (paid.has(b.catId) || skip.has(b.catId)) { done++; continue; }
    items.push({ type: 'bill', key: 'bill:' + b.catId, ...b });
  }
  if (people().length > 1) {
    const prev = addMonths(ref, -1);
    const s = settings();
    if (!s.settleStart || s.settleStart <= prev) {
      const tr = settleSummary(ledger(prev).balance);
      if (tr.length) items.unshift({ type: 'close', key: 'close:' + prev, ym: prev, transfers: tr });
    }
  }
  const lastGain = new Map();
  for (const e of db.all('invEntries')) if (e.kind === 'gain' && (!lastGain.has(e.invId) || e.date > lastGain.get(e.invId))) lastGain.set(e.invId, e.date);
  const stale = investmentSummaries().filter(f => Math.abs(f.balance) > 0 && lastGain.has(f.id))
    .map(f => ({ id: f.id, name: f.name, days: Math.floor((now - Date.parse(lastGain.get(f.id))) / 864e5) }))
    .filter(f => f.days > 35).sort((a, b) => b.days - a.days);
  if (stale.length) items.push({ type: 'invest', key: 'invest', funds: stale });
  if (db.count('tx') >= 20) {
    const days = lastBackup ? Math.floor((now - Date.parse(lastBackup)) / 864e5) : Infinity;
    if (days > 14) items.push({ type: 'backup', key: 'backup', days });
  }
  return { items, bills: bills.length, done };
}

export async function skipPending(catId, ym, { forever = false } = {}) {
  const st = settings();
  if (forever) return db.put('settings', { ...st, pendingIgnore: [...new Set([...(st.pendingIgnore || []), catId])] });
  const skip = { ...(st.pendingSkip || {}) };
  skip[ym] = [...new Set([...(skip[ym] || []), catId])];
  // solo se guardan los últimos meses
  for (const k of Object.keys(skip)) if (k < addMonths(ym, -3)) delete skip[k];
  return db.put('settings', { ...st, pendingSkip: skip });
}

// ---- Series para gráficos ------------------------------------------------

export function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// Meses con movimientos (para elegir períodos): el más antiguo y los años presentes.
export function txYears() {
  const ys = new Set();
  for (const t of db.all('tx')) ys.add(t.date.slice(0, 4));
  return [...ys].sort().reverse();
}

// Matriz categoría (o grupo) × mes en moneda base, para los reportes.
// kind 'expense' | 'income' · mode 'total' (hogar) | 'mine' (mi parte) · by 'category' | 'group'
export function categoryMatrix(months, { kind = 'expense', mode = 'total', by = 'category', pid = null } = {}) {
  const idx = new Map(months.map((m, i) => [m, i]));
  const ps = people();
  const me = pid || meId();
  const pctCache = new Map();
  const pctOf = (ym) => { if (!pctCache.has(ym)) pctCache.set(ym, splitFor(ym).pct); return pctCache.get(ym); };
  const rows = new Map();
  const totals = months.map(() => 0);
  const counts = months.map(() => 0);
  for (const tx of db.all('tx')) {
    if (tx.kind !== 'out' && tx.kind !== 'in') continue;
    const i = idx.get(tx.date.slice(0, 7));
    if (i === undefined) continue;
    const cat = category(tx.categoryId);
    if (!cat || cat.kind !== kind) continue;
    if (kind === 'income' && tx.kind !== 'in') continue;
    // en gastos, una devolución (ingreso en una categoría de gasto) resta
    let v = txBase(tx) * (kind === 'expense' && tx.kind === 'in' ? -1 : 1);
    if (mode === 'mine') {
      if (kind === 'income') { if (tx.paidBy !== me) continue; } else {
        const sh = shares(tx, cat, pctOf(months[i]), ps);
        if (sh) v *= (sh[me] || 0); else if (tx.paidBy !== me) continue;
      }
    }
    const key = by === 'group' ? (cat.group || 'Otras') : cat.id;
    if (!rows.has(key)) {
      rows.set(key, {
        key, label: by === 'group' ? key : cat.name, icon: by === 'group' ? '' : (cat.icon || ''),
        catId: by === 'group' ? null : cat.id, group: by === 'group' ? key : null,
        values: months.map(() => 0), counts: months.map(() => 0), total: 0,
      });
    }
    const r = rows.get(key);
    r.values[i] += v; r.counts[i]++; r.total += v;
    totals[i] += v; counts[i]++;
  }
  const list = [...rows.values()].filter(r => Math.abs(r.total) >= 0.5).sort((a, b) => b.total - a.total);
  return { months, rows: list, totals, counts };
}

// Valor y aportado neto al cierre de cada mes, en la moneda del fondo.
export function fundHistory(invId, months) {
  const entries = db.all('invEntries').filter(e => e.invId === invId).sort((a, b) => a.date.localeCompare(b.date));
  let j = 0, value = 0, invested = 0;
  const cur = curYm();
  return months.map((ym) => {
    const end = ym === cur ? todayStr() : monthEnd(ym);
    while (j < entries.length && entries[j].date <= end) {
      const e = entries[j++];
      const s = e.kind === 'withdraw' ? -1 : 1;
      value += s * e.amount;
      if (e.kind !== 'gain') invested += s * e.amount;
    }
    return { ym, value, invested };
  });
}

// Total de inversiones en moneda base al cierre de cada mes (incluye fondos ya archivados, que
// sí existían en el pasado; excluye monedas sin conversión como millas). El aportado se convierte
// al mismo tipo de cambio que el valor, así la ganancia es la del fondo y no un efecto cambiario.
export function portfolioHistory(months) {
  const out = months.map(ym => ({ ym, value: 0, invested: 0 }));
  const cur = curYm();
  for (const f of db.all('investments')) {
    if (currencyInfo(f.currency).convertible === false) continue;
    const h = fundHistory(f.id, months);
    h.forEach((p, k) => {
      if (!p.value && !p.invested) return;
      const r = rateFor(f.currency, p.ym === cur ? todayStr() : monthEnd(p.ym)) ?? 1;
      out[k].value += p.value * r;
      out[k].invested += p.invested * r;
    });
  }
  return out;
}

// Primer mes con registros de inversión (o de un fondo).
export function firstInvestmentMonth(invId = null) {
  let first = null;
  for (const e of db.all('invEntries')) if ((!invId || e.invId === invId) && (!first || e.date < first)) first = e.date;
  return first ? first.slice(0, 7) : null;
}

// ---- Datos iniciales para una instalación nueva --------------------------

export async function seedDefaults() {
  if (db.count('people') || db.count('categories')) return;
  const p1 = { id: db.uid(), name: 'Yo', order: 0 };
  const p2 = { id: db.uid(), name: 'Pareja', order: 1 };
  await db.putMany('people', [p1, p2]);
  await db.put('settings', { ...DEFAULT_SETTINGS, ownerId: p1.id });
  const mk = (name, kind, extra = {}) => ({ id: db.uid(), name, kind, ...extra });
  const cats = [
    mk('Supermercado', 'expense', { icon: '🛒', defaultAlloc: 'shared' }),
    mk('Comida', 'expense', { icon: '🍽️' }),
    mk('Arriendo / Dividendo', 'expense', { icon: '🏠', defaultAlloc: 'shared' }),
    mk('Gastos comunes', 'expense', { icon: '🏢', defaultAlloc: 'shared' }),
    mk('Luz', 'expense', { icon: '💡', defaultAlloc: 'shared' }),
    mk('Agua', 'expense', { icon: '🚿', defaultAlloc: 'shared' }),
    mk('Gas', 'expense', { icon: '🔥', defaultAlloc: 'shared' }),
    mk('Internet y TV', 'expense', { icon: '📶', defaultAlloc: 'shared' }),
    mk('Transporte', 'expense', { icon: '🚗' }),
    mk('Salud', 'expense', { icon: '💊' }),
    mk('Entretención', 'expense', { icon: '🎬' }),
    mk('Regalos', 'expense', { icon: '🎁' }),
    mk('Otros gastos', 'expense', { icon: '🧾' }),
    mk('Sueldo', 'income', { icon: '💰' }),
    mk('Otros ingresos', 'income', { icon: '➕' }),
    mk('Préstamo', 'loan', { icon: '🤝' }),
    mk('Inversión', 'invest', { icon: '📈' }),
    mk('Ajuste', 'adjust', { icon: '⚖️' }),
  ];
  cats.forEach((c, i) => { c.order = i; });
  await db.putMany('categories', cats);
  await db.putMany('accounts', [
    { id: db.uid(), name: 'Cuenta corriente', type: 'bank', currency: 'CLP', order: 0 },
    { id: db.uid(), name: 'Tarjeta de crédito', type: 'credit', currency: 'CLP', order: 1 },
    { id: db.uid(), name: 'Efectivo', type: 'cash', currency: 'CLP', order: 2 },
  ]);
}

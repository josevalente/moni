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
export const category = (id) => db.get('categories', id);
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
  if (hasC && hasD) s = s.replace(/\./g, '').replace(',', '.');
  else if (hasC) s = s.replace(',', '.');
  else if (hasD && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// ---- Tipos de cambio -----------------------------------------------------

let rateIdx = null;
db.subscribe(() => { rateIdx = null; });

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
  for (const a of accounts()) {
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
    if (d.excludeNW) continue;
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

export function incomeOfMonth(ym) {
  let t = 0;
  for (const tx of txsInMonth(ym)) {
    if (tx.kind !== 'in') continue;
    const cat = category(tx.categoryId);
    if (cat && cat.kind === 'income') t += txBase(tx);
  }
  return t;
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

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
// consultas a internet con tiempo límite: con mala señal no quedan colgadas para siempre
export const timeoutSignal = (ms = 15000) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
export const addDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
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

// enteros con separador de miles: 2577 → "2.577"
export const fmtInt = (n) => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(n || 0);

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

// Compra copiada al portapapeles por un atajo de iPhone (Apple Pay): "MONI|12.990|Jumbo", o un texto
// cualquiera con un monto y el comercio ("$12.990 Jumbo"). Devuelve { amount, desc } o null.
export function parsePurchase(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 300) return null;
  let amountStr, desc;
  const parts = t.split('|').map(x => x.trim());
  if (parts.length >= 3 && /^moni$/i.test(parts[0])) { amountStr = parts[1]; desc = parts.slice(2).join(' '); }
  else {
    const m = t.match(/(?:US\$|\$|CLP|USD)?\s*\d[\d.,]*/i);
    if (!m) return null;
    amountStr = m[0];
    desc = t.replace(m[0], ' ');
  }
  const amount = parseAmount(String(amountStr).replace(/[^\d.,]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  desc = String(desc || '').replace(/[|·:]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { amount, desc };
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

// Último registro de una serie (moneda o precio "px:<inversión>") a la fecha; null si no hay anterior.
export function seriesAt(cur, date) {
  if (!rateIdx) buildRates();
  const arr = rateIdx.get(cur);
  if (!arr || !arr.length) return null;
  date = date || todayStr();
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 ? arr[best] : null;
}

// Último valor conocido a la fecha (o el más antiguo si la fecha es anterior a todos).
export function rateFor(cur, date) {
  if (cur === base()) return 1;
  if (!rateIdx) buildRates();
  const arr = rateIdx.get(cur);
  if (!arr || !arr.length) return null;
  const r = seriesAt(cur, date);
  return (r || arr[0]).rate;
}
// Fecha del último tipo de cambio guardado de una moneda.
export const lastRateDate = (cur) => { if (!rateIdx) buildRates(); const a = rateIdx.get(cur); return a && a.length ? a[a.length - 1].date : null; };

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
  // puntos y millas: no suman, salvo los programas marcados "cuenta en mi patrimonio"
  let points = 0;
  for (const p of pointsSummaries()) if (p.inNetWorth && p.valueBase != null) points += p.valueBase;
  // propiedades: su valor menos la parte del socio en la plusvalía (el crédito ya está en deudas)
  let props = 0;
  for (const p of propertySummaries()) props += (p.value - p.partnerClaim) * (rateFor(p.currency, todayStr()) ?? 1);
  return { cash, cards, inv, debts, points, props, total: cash + cards + inv + debts + points + props, missing: [...missing] };
}

// ---- Inversiones ---------------------------------------------------------

// Tipos: 'fund' (se registra su valor), 'units' (cantidad × precio: acciones, ETF, fondos mutuos,
// cripto) y 'points' (puntos y millas: van en su propia sección y no son inversión).
export const isPoints = (i) => i && i.type === 'points';
export const isUnits = (i) => i && i.type === 'units';
const POINTS_RE = /premio|pass\b|millas|miles|puntos|points|cmr|lanpass/i;
export const isProperty = (i) => i && i.type === 'property';
export const looksLikePoints = (i) => !isPoints(i) && !isProperty(i) && (currencyInfo(i.currency).convertible === false || POINTS_RE.test(i.name || ''));

// Categorías asociadas a una inversión (ej. "AFP"): cada movimiento de la categoría cuenta como aporte
// (gasto) o retiro (ingreso), desde la fecha indicada. No se copian datos: vale para lo histórico y lo futuro,
// y se deshace quitando la asociación.
export function linkedEntries(invId) {
  const inv = db.get('investments', invId);
  if (!inv) return [];
  const cats = new Map(db.all('categories').filter(c => c.invId === invId).map(c => [c.id, c]));
  if (!cats.size) return [];
  const out = [];
  for (const t of db.all('tx')) {
    if (t.kind !== 'out' && t.kind !== 'in') continue;
    const c = cats.get((category(t.categoryId) || {}).id);
    if (!c || (c.invFrom && t.date < c.invFrom)) continue;
    // en la moneda de la inversión (si es otra, vía moneda base al tipo de cambio de esa fecha)
    let amount = t.amount;
    if (t.currency !== inv.currency) { const r = rateFor(inv.currency, t.date); amount = r ? txBase(t) / r : txBase(t); }
    out.push({ id: 'tx:' + t.id, invId, date: t.date, kind: t.kind === 'out' ? 'contrib' : 'withdraw', amount, note: t.desc || c.name,
      fromTx: t.id, fromCat: c.id, createdAt: t.createdAt });
  }
  return out;
}

// Registros de una inversión (los propios y los que vienen de categorías asociadas), en orden.
export const investmentEntries = (id) => [...db.all('invEntries').filter(e => e.invId === id), ...linkedEntries(id)]
  .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
const entriesOf = investmentEntries;

// Precio de una inversión por cantidad a una fecha: el último precio consultado o ingresado, o el de
// la última compra/venta si es más reciente.
export function priceAt(inv, date, entries = null) {
  const r = seriesAt('px:' + inv.id, date);
  let best = r ? { date: r.date, price: r.rate, manual: !!r.manual, at: r.updatedAt || 0 } : null;
  for (const e of entries || entriesOf(inv.id)) {
    if (e.date > date) break;
    // el mismo día gana lo último que se registró (un precio ingresado después de la compra)
    if (e.price && (!best || e.date > best.date || (e.date === best.date && (e.updatedAt || 0) > best.at))) best = { date: e.date, price: e.price, trade: true, at: e.updatedAt || 0 };
  }
  return best;
}

// Estado de una inversión a una fecha. Rentabilidad = valor − aportado neto + dividendos pagados.
// En cantidad, el costo es promedio: una venta saca costo promedio × cantidad y el resto es ganancia realizada.
export function fundStats(inv, asOf = todayStr(), entries = null) {
  entries = entries || entriesOf(inv.id);
  const units = isUnits(inv);
  let contrib = 0, withdraw = 0, gain = 0, divPaid = 0, divReinv = 0, div12 = 0, qty = 0, cost = 0, realized = 0, last = null;
  // valor (por valor): cada valorización fija el valor total de ese día. Las del Excel se guardaron como
  // diferencia: su valor total es la suma de los registros propios hasta ahí (sin los aportes que llegan de
  // una categoría asociada después), así asociar una categoría no infla el valor.
  let bal = 0, manualCum = 0, appraisal = null;
  const cut12 = addDays(asOf, -365);
  // una inversión que se llevaba por valor y pasó a cantidad: hasta esa fecha vale lo registrado;
  // desde ahí, la cantidad inicial × precio (con ese valor como costo)
  let switched = !units || !inv.unitsFrom;
  const doSwitch = () => { qty = inv.unitsStart || 0; cost = bal; switched = true; };
  for (const e of entries) {
    if (e.date > asOf) break;
    if (!switched && e.date >= inv.unitsFrom) doSwitch();
    const a = Number(e.amount) || 0;
    const own = !e.fromTx;
    if (e.kind === 'contrib') {
      contrib += a; bal += a; if (own) manualCum += a;
      if (units && e.units) { qty += e.units; cost += a; }
    } else if (e.kind === 'withdraw') {
      withdraw += a; bal -= a; if (own) manualCum -= a;
      // rescatar más de lo que vale (un depósito a plazo que vence con intereses): lo extra es ganancia
      if (!units && bal < -1e-6) { gain -= bal; manualCum -= bal; bal = 0; }
      if (units && e.units) {
        const avg = qty > 0 ? cost / qty : 0;
        const n = Math.min(e.units, qty);
        realized += a - avg * n; cost -= avg * n; qty -= e.units;
        if (qty < 1e-9) { qty = 0; cost = 0; }
      }
    } else if (e.kind === 'dividend') {
      if (e.reinvested) { divReinv += a; bal += a; manualCum += a; if (units && e.units) { qty += e.units; cost += a; } } else divPaid += a;
      if (e.date > cut12) div12 += a;
    } else {
      const target = e.value != null ? e.value : manualCum + a;
      gain += target - bal; bal = target; manualCum += a;
      if (e.value != null) appraisal = e.value;
    }
    if (!last || e.date > last) last = e.date;
  }
  if (!switched && asOf >= inv.unitsFrom) doSwitch();
  const invested = contrib - withdraw;
  let balance, price = null;
  if (units && switched) {
    price = priceAt(inv, asOf, entries);
    balance = price ? qty * price.price : cost;
  } else if (isProperty(inv)) balance = appraisal ?? (contrib - withdraw);   // costos y arreglos no suben la tasación
  else balance = bal;
  const totalGain = balance - invested + divPaid;
  return {
    contrib, withdraw, gain, invested, balance, last, divPaid, divReinv, div12, totalGain,
    ret: contrib ? totalGain / contrib : 0,
    qty, cost, avgCost: qty ? cost / qty : 0, unrealized: units ? balance - cost : 0, realized, price,
    lastValue: units ? (price ? price.date : null) : (entries.filter(e => e.kind === 'gain').map(e => e.date).sort().at(-1) || null),
  };
}

// Rentabilidad anual (tasa interna de retorno) de los flujos: aportes, retiros, dividendos pagados y el valor de hoy.
export function annualReturn(inv, asOf = todayStr()) {
  const entries = entriesOf(inv.id);
  const flows = [];
  for (const e of entries) {
    if (e.date > asOf) break;
    if (e.kind === 'contrib') flows.push([e.date, -e.amount]);
    else if (e.kind === 'withdraw') flows.push([e.date, e.amount]);
    else if (e.kind === 'dividend' && !e.reinvested) flows.push([e.date, e.amount]);
  }
  if (!flows.length) return null;
  const st = fundStats(inv, asOf, entries);
  flows.push([asOf, st.balance]);
  const t0 = Date.parse(flows[0][0]);
  if ((Date.parse(asOf) - t0) / 864e5 < 90) return null;            // muy poco tiempo: no se anualiza
  const npv = (r) => flows.reduce((a, [d, v]) => a + v / Math.pow(1 + r, (Date.parse(d) - t0) / 864e5 / 365), 0);
  let lo = -0.99, hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let k = 0; k < 100; k++) { const mid = (lo + hi) / 2; if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}

export function investmentSummaries({ archived = false } = {}) {
  return db.all('investments').filter(i => !isPoints(i) && !isProperty(i) && (archived || !i.archived)).map(i => {
    const st = fundStats(i);
    return { ...i, ...st, id: i.id };
  }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

// Cuánto ganó (o perdió) cada inversión: valor − aporte neto + dividendos pagados, en moneda base al tipo de
// cambio de hoy (como el gráfico del total: la ganancia es la del fondo, no un efecto cambiario). Las cerradas
// cuentan con lo que ganaron mientras existieron.
export function gainBreakdown({ closed = true } = {}) {
  const today = todayStr();
  const out = [];
  for (const i of db.all('investments')) {
    if (isPoints(i) || isProperty(i) || (!closed && i.archived) || currencyInfo(i.currency).convertible === false) continue;
    const st = fundStats(i);
    if (!st.contrib && !st.gain && !st.divPaid) continue;
    const r = rateFor(i.currency, today) ?? 1;
    out.push({ id: i.id, name: i.name, closed: !!i.archived, gain: st.totalGain * r });
  }
  return out.sort((a, b) => b.gain - a.gain);
}

// Puntos y millas: saldo en su unidad y, si se puede, su valor en moneda base.
export function pointsSummaries() {
  return db.all('investments').filter(i => isPoints(i) && !i.archived).map(i => {
    const st = fundStats(i);
    const info = currencyInfo(i.currency);
    let valueBase = null;
    if (i.pointValue) valueBase = st.balance * i.pointValue;
    else if (info.convertible !== false) { const r = rateFor(i.currency, todayStr()); valueBase = r == null ? null : st.balance * r; }
    return { ...i, ...st, id: i.id, valueBase };
  }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

// ---- Deudas --------------------------------------------------------------

export function debtSummaries() {
  const entries = db.all('debtEntries');
  const today = todayStr();
  return db.all('debts').filter(d => !d.archived).map(d => {
    let balance = 0, last = null;
    for (const e of entries) if (e.debtId === d.id) { balance += e.amount; if (!last || e.date > last) last = e.date; }
    if (d.mortgage) { balance = debtBalanceAt(d, today); const k = cuotasPaid(d, today); return { ...d, balance, last, cuota: k, cuotas: d.mortgage.rows.length }; }
    return { ...d, balance, last };
  });
}

// Crédito hipotecario: `mortgage = { from, first, rows }`. from = desembolso; first = vencimiento de la cuota 1;
// rows = tabla de desarrollo del banco [n, amortización, interés, dividendo neto, seguro incendio, desgravamen,
// dividendo total, saldo] (UF). El saldo baja solo con cada cuota vencida.
export function cuotasPaid(d, date) {
  const m = d.mortgage;
  if (!m || date < m.first) return 0;
  const [fy, fm] = m.first.slice(0, 7).split('-').map(Number), [y, mo] = date.slice(0, 7).split('-').map(Number);
  const k = (y * 12 + mo) - (fy * 12 + fm) + (Number(date.slice(8)) >= Number(m.first.slice(8)) ? 1 : 0);
  return Math.max(0, Math.min(m.rows.length, k));
}
export function debtBalanceAt(d, date, entries = null) {
  if (d.mortgage) {
    if (date < d.mortgage.from) return 0;
    const k = cuotasPaid(d, date);
    return k ? d.mortgage.rows[k - 1][7] : d.mortgage.principal;
  }
  return (entries || db.all('debtEntries')).filter(e => e.debtId === d.id && e.date <= date).reduce((a, e) => a + e.amount, 0);
}
// Tabla de un crédito nuevo con tasa fija (sistema francés, como el banco): tasa mensual (1+anual)^(1/12)−1.
export function mortgageSchedule({ principal, annualRate, months, insurance = 0 }) {
  const r = Math.pow(1 + annualRate, 1 / 12) - 1;
  const pay = principal * r / (1 - Math.pow(1 + r, -months));
  const rows = [];
  let bal = principal;
  for (let n = 1; n <= months; n++) {
    const int = bal * r, am = pay - int;
    bal = Math.max(0, bal - am);
    const R = (x) => Math.round(x * 1e4) / 1e4;
    rows.push([n, R(am), R(int), R(pay), R(insurance), 0, R(pay + insurance), R(bal)]);
  }
  return rows;
}
// Del dividendo, qué parte es amortización (ahorro: baja la deuda); el resto (interés y seguros) es gasto.
// La cuota sale del número en la descripción ("60.0") o, si no, de la fecha.
export function amortShare(tx, cat) {
  const d = cat && cat.debtId ? db.get('debts', cat.debtId) : null;
  if (!d || !d.mortgage) return 0;
  const byDate = Math.max(1, cuotasPaid(d, addDays(tx.date, 5)));
  const n = parseFloat(String(tx.desc || '').replace(',', '.'));
  const k = Number.isInteger(n) && n >= 1 && Math.abs(n - byDate) <= 3 ? n : byDate;
  const row = d.mortgage.rows[k - 1];
  return row && row[6] ? row[1] / row[6] : 0;
}
export const expenseFactor = (tx, cat) => (cat && cat.debtId ? 1 - amortShare(tx, cat) : 1);

// Propiedades: valor (última tasación, en su moneda), costo total (precio + costos de compra + arreglos),
// crédito asociado y la parte de un socio en la plusvalía (ej. quien aportó a la remodelación).
export function propertyStats(p, asOf = todayStr()) {
  const st = fundStats(p, asOf);
  const debt = p.mortgageId ? db.get('debts', p.mortgageId) : null;
  const r = rateFor(p.currency, asOf) ?? 1;
  const debtCur = debt ? debtBalanceAt(debt, asOf) * ((rateFor(debt.currency, asOf) ?? 1) / r) : 0;
  const value = st.balance, basis = st.invested;
  const share = p.partner && p.partner.contrib && basis ? p.partner.contrib / basis : 0;
  const partnerClaim = share * Math.max(0, value - basis);
  return { value, basis, gain: value - basis, debt: debtCur, share, partnerClaim, equity: value - debtCur - partnerClaim, mortgage: debt, last: st.last };
}
export const propertySummaries = () => db.all('investments').filter(i => isProperty(i) && !i.archived).map(p => ({ ...p, ...propertyStats(p) }));

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
    let b = txBase(tx) * sign * expenseFactor(tx, cat);
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
export function incomeOfMonth(ym, pid = null, { extraordinary = true } = {}) {
  let t = 0;
  for (const tx of txsInMonth(ym)) {
    if (tx.kind !== 'in') continue;
    if (pid && tx.paidBy !== pid) continue;
    const cat = category(tx.categoryId);
    if (cat && cat.kind === 'income' && (extraordinary || !cat.extraordinary)) t += txBase(tx);
  }
  return t;
}

// ---- Ritmo de gasto, calendario de registros, patrimonio en el tiempo -------------------------

// Gasto de cada día del mes (misma regla que spendingByCategory: categorías de gasto, devoluciones restan;
// "mine" = mi parte).
export function dailySpend(ym, mode = 'total', pid = null) {
  const ps = people();
  const { pct } = splitFor(ym);
  const me = pid || meId();
  const n = Number(monthEnd(ym).slice(8));
  const days = new Array(n).fill(0);
  for (const tx of txsInMonth(ym)) {
    if (tx.kind !== 'out' && tx.kind !== 'in') continue;
    const cat = category(tx.categoryId);
    if (!cat || cat.kind !== 'expense') continue;
    let b = txBase(tx) * (tx.kind === 'in' ? -1 : 1) * expenseFactor(tx, cat);
    if (mode === 'mine') {
      const sh = shares(tx, cat, pct, ps);
      if (sh) b *= (sh[me] || 0);
      else if (tx.paidBy !== me) continue;
    }
    days[Number(tx.date.slice(8)) - 1] += b;
  }
  return days;
}

// Gasto acumulado del mes día a día contra un "mes típico": para cada día, la mediana de lo acumulado a esa
// altura en los 6 meses cerrados anteriores (la mediana no se deja arrastrar por un mes con una compra grande).
export function spendPace(ym, mode = 'total') {
  const cum = (arr) => { let a = 0; return arr.map(v => (a += v)); };
  const days = cum(dailySpend(ym, mode));
  const prev = monthsBetween(addMonths(ym, -6), addMonths(ym, -1)).map(m => cum(dailySpend(m, mode)));
  const med = (vals) => { const v = [...vals].sort((a, b) => a - b); const k = v.length; return k ? (k % 2 ? v[(k - 1) / 2] : (v[k / 2 - 1] + v[k / 2]) / 2) : 0; };
  const typical = days.map((_, i) => med(prev.map(p => p[Math.min(i, p.length - 1)])));
  const today = todayStr();
  const upTo = ym === curYm() ? Number(today.slice(8)) : ym < curYm() ? days.length : 0;
  return { days, typical, upTo, typicalTotal: med(prev.map(p => p[p.length - 1])) };
}

// Cuántos movimientos se registraron cada día, para ver los días que quedaron sin registrar.
export function entryCounts(from, to) {
  const m = new Map();
  for (const t of db.all('tx')) if (t.date >= from && t.date <= to) m.set(t.date, (m.get(t.date) || 0) + 1);
  return m;
}

// Patrimonio al cierre de cada mes, por componente, en moneda base con el tipo de cambio de ese mes.
// Cuentas y tarjetas: saldo al cierre; inversiones: su valor (incluye las ya cerradas mientras existieron);
// deudas: saldo según sus registros. No incluye puntos y millas.
export function netWorthHistory(months) {
  const cur = curYm();
  const end = (ym) => (ym === cur ? todayStr() : monthEnd(ym));
  const out = months.map(ym => ({ ym, cash: 0, cards: 0, inv: 0, debts: 0, props: 0, total: 0 }));
  for (const a of db.all('accounts')) {
    if (a.excludeNW || currencyInfo(a.currency).convertible === false) continue;
    const rows = accountLedger(a.id);
    if (!rows.length) continue;
    months.forEach((ym, k) => {
      const v = balanceOn(rows, end(ym));
      if (!v) return;
      const b = v * (rateFor(a.currency, end(ym)) ?? 1);
      if (a.type === 'credit') out[k].cards += b; else out[k].cash += b;
    });
  }
  portfolioHistory(months).forEach((p, k) => { out[k].inv = p.value; });
  const entries = db.all('debtEntries');
  for (const d of db.all('debts')) {
    if (d.excludeNW || currencyInfo(d.currency).convertible === false) continue;
    const es = entries.filter(e => e.debtId === d.id);
    months.forEach((ym, k) => {
      const bal = debtBalanceAt(d, end(ym), es);
      if (bal) out[k].debts += (d.direction === 'owe' ? -1 : 1) * bal * (rateFor(d.currency, end(ym)) ?? 1);
    });
  }
  for (const p of db.all('investments').filter(isProperty)) {
    months.forEach((ym, k) => {
      if (end(ym) < (investmentEntries(p.id)[0] || {}).date) return;
      const s = propertyStats(p, end(ym));
      out[k].props += (s.value - s.partnerClaim) * (rateFor(p.currency, end(ym)) ?? 1);
    });
  }
  for (const p of out) p.total = p.cash + p.cards + p.inv + p.debts + p.props;
  return out;
}

// ¿Le gana a la UF? Rentabilidad anual de cada inversión contra lo que subió la UF (inflación) en el mismo
// período. Real = (1 + rentabilidad) / (1 + UF) − 1.
export function returnsVsInflation() {
  const today = todayStr();
  const ufNow = rateFor('UF', today);
  if (!ufNow) return [];
  const out = [];
  for (const f of investmentSummaries()) {
    if (currencyInfo(f.currency).convertible === false) continue;
    const r = annualReturn(f);
    const first = investmentEntries(f.id)[0];
    if (r == null || !first) continue;
    const yrs = (Date.parse(today) - Date.parse(first.date)) / 864e5 / 365;
    const ufThen = rateFor('UF', first.date);
    if (!ufThen || yrs <= 0) continue;
    const uf = Math.pow(ufNow / ufThen, 1 / yrs) - 1;
    out.push({ id: f.id, name: f.name, ret: r, uf, real: (1 + r) / (1 + uf) - 1, since: first.date, currency: f.currency });
  }
  return out.sort((a, b) => b.real - a.real);
}

// ---- Análisis: ahorro real, proyección de caja, indicadores, comparaciones -------------------------

// Pesos de hoy: un monto de un mes pasado × (UF de hoy / UF de ese mes). Permite comparar años sin la inflación.
export function realFactor(ym) {
  const now = rateFor('UF', todayStr()), then = rateFor('UF', ym === curYm() ? todayStr() : monthEnd(ym));
  return now && then ? now / then : 1;
}
const median = (vals) => { const v = [...vals].sort((a, b) => a - b); const k = v.length; return k ? (k % 2 ? v[(k - 1) / 2] : (v[k / 2 - 1] + v[k / 2]) / 2) : 0; };

// Ahorro de un mes = ingresos recurrentes − consumo. Lo que hoy figura como gasto pero es ahorro cuenta como
// ahorro: los aportes a una inversión asociada a su categoría (ej. la AFP) y la amortización de los créditos
// (que ya no está en el gasto). "mine" = mi parte.
export function savingsOfMonth(ym, mode = 'total') {
  const ps = people();
  const { pct } = splitFor(ym);
  const me = meId();
  const income = incomeOfMonth(ym, mode === 'mine' ? me : null, { extraordinary: false });
  let spend = 0, invest = 0, amort = 0;
  for (const tx of txsInMonth(ym)) {
    if (tx.kind !== 'out' && tx.kind !== 'in') continue;
    const cat = category(tx.categoryId);
    if (!cat || cat.kind !== 'expense') continue;
    let b = txBase(tx) * (tx.kind === 'in' ? -1 : 1);
    if (mode === 'mine') {
      const sh = shares(tx, cat, pct, ps);
      if (sh) b *= (sh[me] || 0); else if (tx.paidBy !== me) continue;
    }
    if (cat.invId) { invest += b; continue; }
    const a = cat.debtId ? amortShare(tx, cat) : 0;
    amort += b * a;
    spend += b * (1 - a);
  }
  const saved = income - spend;
  return { ym, income, spend, invest, amort, saved, rate: income ? saved / income : null };
}

// Proyección de caja de los próximos meses para las cuentas del dueño:
// - ingresos: la mediana mensual de los recurrentes, más los ingresos grandes que se repiten cada año (ej. un
//   reparto de utilidades en mayo) en el mismo mes que el año pasado;
// - gasto propio: el promedio de los últimos 12 meses (incluye contribuciones e impuestos anuales), sin los
//   dividendos, que van exactos según la tabla de cada crédito (en UF, con la UF al ritmo del último año);
// - si se indica, un arriendo. Parte con la liquidez de hoy (cuentas menos tarjetas).
export function cashForecast({ months = 12, rent = null } = {}) {
  const cur = curYm();
  const owner = ownerId();
  const closed = monthsBetween(addMonths(cur, -12), addMonths(cur, -1));
  const debtCats = new Set(db.all('categories').filter(c => c.debtId).map(c => c.id));
  const ownSpend = (ym) => {
    const r = spendingByCategory(ym, 'mine', owner);
    // sin los dividendos (van exactos aparte); la AFP y otros aportes sí quedan: también salen de la cuenta
    return r.total - r.rows.filter(x => debtCats.has(x.cat.id)).reduce((a, x) => a + x.v, 0);
  };
  const incSeries = closed.map(ym => incomeOfMonth(ym, owner, { extraordinary: false }));
  const incomeBase = median(incSeries);
  const lumps = new Map();
  closed.forEach((ym, i) => { const extra = incSeries[i] - incomeBase; if (extra > Math.max(incomeBase, 1)) lumps.set(ym.slice(5), extra); });
  const spendBase = closed.reduce((a, ym) => a + ownSpend(ym), 0) / closed.length;
  const today = todayStr();
  const uf0 = rateFor('UF', today) || 1, uf12 = rateFor('UF', addDays(today, -365)) || uf0;
  const g = Math.pow(uf0 / uf12, 1 / 12);
  const bal0 = accountBalances();
  let liquid = 0;
  for (const a of accounts()) if (currencyInfo(a.currency).convertible !== false) liquid += (bal0.get(a.id) || 0) * (rateFor(a.currency, today) ?? 1);
  const mortgages = db.all('debts').filter(d => d.mortgage && !d.archived);
  const rows = [];
  let balance = liquid;
  for (let k = 1; k <= months; k++) {
    const ym = addMonths(cur, k);
    const uf = uf0 * Math.pow(g, k);
    const dividends = [];
    for (const d of mortgages) {
      const n0 = cuotasPaid(d, monthEnd(addMonths(ym, -1))), n1 = cuotasPaid(d, monthEnd(ym));
      let amt = 0;
      for (let n = n0 + 1; n <= n1; n++) amt += d.mortgage.rows[n - 1][6];
      const rate = d.currency === 'UF' ? uf : (rateFor(d.currency, today) ?? 1);
      if (amt) dividends.push({ name: d.name, amount: amt * rate });
    }
    const div = dividends.reduce((a, x) => a + x.amount, 0);
    const rentNet = rent && rent.uf && ym >= rent.from ? rent.uf * uf * (1 - (rent.adminPct || 0) / 100) : 0;
    const spend = spendBase * (uf / uf0);                       // el gasto sube con la inflación
    const income = incomeBase + (lumps.get(ym.slice(5)) || 0);
    const net = income - spend - div + rentNet;
    balance += net;
    rows.push({ ym, income, lump: lumps.get(ym.slice(5)) || 0, spend, dividends, div, rent: rentNet, net, balance });
  }
  const yearIncome = incSeries.reduce((a, v) => a + v, 0);
  return { incomeBase, yearIncome, lumps: [...lumps.entries()], spendBase, liquid, inflation: Math.pow(g, 12) - 1, rows };
}

// Indicadores de salud financiera con su referencia (tasa de ahorro, fondo de emergencia, carga de los
// dividendos sobre el ingreso —la que miran los bancos en Chile— y endeudamiento sobre los activos).
export function healthIndicators() {
  const cur = curYm();
  const months = monthsBetween(addMonths(cur, -12), addMonths(cur, -1));
  const sv = months.map(ym => savingsOfMonth(ym, 'mine'));
  const inc = sv.reduce((a, x) => a + x.income, 0), saved = sv.reduce((a, x) => a + x.saved, 0);
  const fc = cashForecast({ months: 3 });
  const nextDiv = median(fc.rows.map(r => r.div));                // dividendo de un mes normal (sin la 1ª cuota)
  const monthlyOut = fc.spendBase + nextDiv;
  const nw = netWorth();
  const assets = nw.cash + nw.inv + nw.props + Math.max(0, nw.points);
  const debts = -nw.cards - nw.debts;
  return {
    savings: { value: inc ? saved / inc : null, saved, income: inc, invest: sv.reduce((a, x) => a + x.invest, 0), amort: sv.reduce((a, x) => a + x.amort, 0) },
    emergency: { value: monthlyOut ? Math.max(0, fc.liquid) / monthlyOut : null, liquid: fc.liquid, monthly: monthlyOut },
    // sobre el ingreso mensual promedio del año (incluye un reparto anual); también solo con el ingreso fijo
    mortgage: { value: fc.yearIncome ? nextDiv / (fc.yearIncome / 12) : null, dividend: nextDiv, income: fc.yearIncome / 12, fixedOnly: fc.incomeBase ? nextDiv / fc.incomeBase : null },
    leverage: { value: assets ? debts / assets : null, debts, assets },
  };
}

// Este año contra el anterior, categoría por categoría, en los mismos meses ya cerrados; en pesos de hoy
// (UF) para que la inflación no haga parecer que todo subió.
export function yearOverYear({ kind = 'expense', mode = 'total', real = true } = {}) {
  const cur = curYm();
  const y = cur.slice(0, 4), lastMonth = addMonths(cur, -1);
  if (lastMonth.slice(0, 4) !== y) return null;
  const a = monthsBetween(`${y}-01`, lastMonth), b = a.map(ym => addMonths(ym, -12));
  const A = categoryMatrix(a, { kind, mode, real }), B = categoryMatrix(b, { kind, mode, real });
  const prev = new Map(B.rows.map(r => [r.key, r]));
  const keys = new Set([...A.rows.map(r => r.key), ...B.rows.map(r => r.key)]);
  const rows = [...keys].map(k => {
    const x = A.rows.find(r => r.key === k), z = prev.get(k);
    return { key: k, label: (x || z).label, icon: (x || z).icon, catId: (x || z).catId, now: x ? x.total : 0, before: z ? z.total : 0 };
  }).map(r => ({ ...r, diff: r.now - r.before })).sort((p, q) => Math.abs(q.diff) - Math.abs(p.diff));
  const now = A.totals.reduce((s, v) => s + v, 0), before = B.totals.reduce((s, v) => s + v, 0);
  return { months: a, prevMonths: b, rows, now, before, real };
}

// Mes típico de una categoría: la mediana de los meses en que hubo gasto (así una categoría nueva o una que se
// paga cada tres meses no se ve "fuera de lo normal" cada vez). Con menos de 3 meses no hay historia suficiente.
export function typicalMonth(values) {
  const v = values.filter(x => x > 0);
  return v.length >= 3 ? median(v) : null;
}

// Gastos fuera de lo normal en un mes: categorías que ya superan claramente su mes típico de los 12 meses
// anteriores (1,5 veces y al menos minExcess más).
export function unusualSpending(ym, mode = 'total', { minExcess = 50000 } = {}) {
  const prev = monthsBetween(addMonths(ym, -12), addMonths(ym, -1));
  const mx = categoryMatrix([...prev, ym], { mode });
  const out = [];
  for (const r of mx.rows) {
    const typical = typicalMonth(r.values.slice(0, 12));
    if (typical == null) continue;
    const now = r.values[12];
    const excess = now - typical;
    if (excess >= minExcess && now >= typical * 1.5) out.push({ catId: r.catId, label: r.label, icon: r.icon, now, typical, excess });
  }
  return out.sort((a, b) => b.excess - a.excess);
}

// De qué está hecha una categoría: sus movimientos agrupados por descripción (útil para "Otros").
export function byDescription(txs) {
  const m = new Map();
  for (const t of txs) {
    const k = normKey(t.desc || '').replace(/[^a-zñ ]+/g, ' ').split(' ').filter(Boolean).slice(0, 3).join(' ');
    // se muestra como se escribió la primera vez (con tildes y mayúsculas)
    const label = String(t.desc || '').replace(/[^\p{L} ]+/gu, ' ').split(' ').filter(Boolean).slice(0, 3).join(' ');
    const e = m.get(k) || { key: k, label: k ? label : '(sin descripción)', total: 0, count: 0, txs: [] };
    e.total += txBase(t) * (t.kind === 'in' ? -1 : 1); e.count++; e.txs.push(t);
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

// ---- Asistentes: categoría propia para lo que se repite en "Otros" ----------------------------

// Palabras de una descripción, sin tildes ni signos ("Starlink oct." → ["starlink", "oct"]).
export const descWords = (desc) => normKey(desc || '').replace(/[^a-zñ ]+/g, ' ').split(' ').filter(Boolean);
const startsWithWords = (w, pre) => pre.length <= w.length && pre.every((x, i) => w[i] === x);
// palabras que por sí solas no dicen qué es ("pago", "cargo"…): no bastan para proponer una categoría
const GENERIC_WORDS = new Set(['pago', 'pagos', 'compra', 'compras', 'cargo', 'cobro', 'regalo', 'regalos', 'transferencia', 'transf', 'aporte',
  'devolucion', 'comision', 'abono', 'retiro', 'gasto', 'gastos', 'varios', 'otro', 'otros', 'pedido', 'cuota', 'seguro', 'para', 'con', 'por',
  'del', 'las', 'los', 'una', 'uno', 'mes', 'cuenta']);
const meaningful = (w) => w.length >= 3 && !GENERIC_WORDS.has(w);

// Categorías "cajón de sastre" (Otros, Varios…): ahí es donde conviene separar lo que se repite.
export const isCatchAll = (cat) => !!cat && /\b(otros?|otras?|varios|varias|general|miscelaneos?|sin categoria)\b/.test(normKey(cat.name));

// Lo que se repite en una categoría "Otros" en el último año (al menos 3 veces, en 2 meses distintos o más):
// se agrupa por el comienzo de la descripción ("Starlink", "Starlink oct" → "Starlink") y se propone su
// propia categoría, o mover a una que ya existe con ese nombre. `catId` limita a una categoría.
export function categorySuggestions({ catId = null, minCount = 3, minMonths = 2 } = {}) {
  const since = addDays(todayStr(), -365);
  const ignore = new Set(settings().catSuggestIgnore || []);
  const per = new Map();                                   // catId → prefijo → grupo
  for (const t of db.all('tx')) {
    if ((t.kind !== 'out' && t.kind !== 'in') || t.date < since) continue;
    const cat = category(t.categoryId);
    if (!cat || cat.archived || (catId ? cat.id !== catId : !isCatchAll(cat))) continue;
    const w = descWords(t.desc);
    let m = per.get(cat.id);
    if (!m) per.set(cat.id, (m = new Map()));
    for (let n = 1; n <= Math.min(3, w.length); n++) {
      const key = w.slice(0, n).join(' ');
      let g = m.get(key);
      if (!g) m.set(key, (g = { cat, key, words: w.slice(0, n), count: 0, months: new Set(), total: 0, first: t }));
      g.count++; g.months.add(t.date.slice(0, 7)); g.total += txBase(t) * (t.kind === 'in' ? -1 : 1);
    }
  }
  const byName = new Map(db.all('categories').filter(c => !c.archived).map(c => [descWords(c.name).join(' '), c]));
  const out = [];
  for (const m of per.values()) {
    const chosen = [];
    // del comienzo más corto al más largo: "Starlink" gana sobre "Starlink oct"
    for (const g of [...m.values()].sort((a, b) => a.words.length - b.words.length || b.count - a.count)) {
      if (g.count < minCount || g.months.size < minMonths || !g.words.some(meaningful) || !meaningful(g.words[0]) && g.words.length === 1) continue;
      if (chosen.some(c => startsWithWords(g.words, c.words)) || ignore.has(`${g.cat.id}|${g.key}`)) continue;
      chosen.push(g);
    }
    for (const g of chosen) {
      const label = String(g.first.desc).replace(/[^\p{L} ]+/gu, ' ').split(' ').filter(Boolean).slice(0, g.words.length).join(' ');
      const existing = byName.get(g.key);
      out.push({ catId: g.cat.id, cat: g.cat, key: g.key, label: label === label.toLowerCase() ? label.charAt(0).toUpperCase() + label.slice(1) : label, count: g.count, months: g.months.size, total: g.total,
        existing: existing && existing.id !== g.cat.id && existing.kind === g.cat.kind ? existing : null });
    }
  }
  return out.sort((a, b) => b.count - a.count || b.total - a.total);
}

// Movimientos de una categoría cuya descripción empieza con esas palabras (todo el historial).
export const txsByDescription = (fromId, key) => {
  const pre = key.split(' ');
  return db.all('tx').filter(t => (t.kind === 'out' || t.kind === 'in') && (category(t.categoryId) || {}).id === fromId && startsWithWords(descWords(t.desc), pre));
};

// Mueve esos movimientos a otra categoría, o a una nueva con el mismo reparto que la de origen. Devuelve lo
// necesario para deshacer. Como las sugerencias al registrar aprenden del historial, los próximos con esa
// descripción ya proponen la categoría nueva.
export async function moveByDescription({ fromId, key, toId = null, name = '', icon = '', group = null }) {
  const from = db.get('categories', fromId);
  let created = false;
  if (!toId) {
    const { id, createdAt, updatedAt, mergedInto, archived, invId, invFrom, debtId, icon: _i, name: _n, ...rest } = from;
    const c = await db.put('categories', { ...rest, name, icon, group: group ?? from.group ?? '', order: (from.order ?? 0) + 0.5 });
    toId = c.id; created = true;
  }
  const moved = txsByDescription(fromId, key);
  if (moved.length) await db.putMany('tx', moved.map(t => ({ ...t, categoryId: toId })));
  return { fromId, toId, created, movedIds: moved.map(t => t.id) };
}
export async function undoMoveByDescription({ fromId, toId, created, movedIds }) {
  const back = movedIds.map(id => db.get('tx', id)).filter(t => t && t.categoryId === toId).map(t => ({ ...t, categoryId: fromId }));
  if (back.length) await db.putMany('tx', back);
  if (created && !db.all('tx').some(t => t.categoryId === toId)) await db.del('categories', toId);
}
export async function ignoreCategorySuggestion(catId, key, undo = false) {
  const st = settings();
  const k = `${catId}|${key}`;
  const list = (st.catSuggestIgnore || []).filter(x => x !== k);
  return db.put('settings', { ...st, catSuggestIgnore: undo ? list : [...list, k] });
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
  // los de precio automático se actualizan solos: solo cuentan los que se valorizan a mano
  const stale = investmentSummaries().filter(f => Math.abs(f.balance) > 0 && f.lastValue && !(isUnits(f) && f.priceSource && f.priceSource !== 'manual'))
    .map(f => ({ id: f.id, name: f.name, days: Math.floor((now - Date.parse(f.lastValue)) / 864e5) }))
    .filter(f => f.days > 35).sort((a, b) => b.days - a.days);
  if (stale.length) items.push({ type: 'invest', key: 'invest', funds: stale });
  // cuentas que ya se cuadraron con el banco alguna vez: se recuerda una vez al mes si tuvieron movimientos
  const lastMove = new Map();
  for (const t of db.all('tx')) for (const id of [t.accountId, t.toAccountId]) if (id && !(lastMove.get(id) >= t.date)) lastMove.set(id, t.date);
  for (const a of accounts()) {
    const r = a.reconciled;
    if (!r || !r.date || !(lastMove.get(a.id) > r.date) || skip.has('recon:' + a.id)) continue;
    const days = Math.floor((now - Date.parse(r.date + 'T12:00:00')) / 864e5);
    if (days > 35) items.push({ type: 'recon', key: 'recon:' + a.id, acc: a, days, since: r.date });
  }
  // lo que se repite en "Otros": una sola fila que abre la lista (no cuenta para el número del ícono)
  const sugs = categorySuggestions();
  if (sugs.length) items.push({ type: 'catsug', key: 'catsug', list: sugs });
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

// ---- Cartola por cuenta y cuadre con el banco -----------------------------------

// Redondeo a los decimales de la moneda: es lo que se ve en pantalla y lo que muestra el banco.
export function roundCur(v, cur) {
  const f = 10 ** currencyInfo(cur).decimals;
  return Math.round((Number(v) || 0) * f) / f + 0;   // + 0: sin "-0"
}

// Movimientos de una cuenta en orden cronológico, con su efecto en la cuenta (en su moneda) y el saldo
// después de cada uno. Es el mismo cálculo de accountBalances: el último saldo es el de la cuenta.
export function accountLedger(accId) {
  const owner = ownerId();
  const rows = [];
  for (const tx of db.all('tx')) {
    let delta = 0, hit = false;
    for (const [id, v] of effects(tx, owner)) if (id === accId) { delta += v; hit = true; }
    if (hit) rows.push({ tx, delta });
  }
  rows.sort((a, b) => a.tx.date.localeCompare(b.tx.date) || (a.tx.createdAt || 0) - (b.tx.createdAt || 0) || (a.tx.id < b.tx.id ? -1 : a.tx.id > b.tx.id ? 1 : 0));
  let bal = 0;
  for (const r of rows) { bal = Math.round((bal + r.delta) * 1e6) / 1e6; r.balance = bal; }
  return rows;
}

// Saldo de la cuenta al cierre de un día.
export function balanceOn(rows, date) {
  let lo = 0, hi = rows.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].tx.date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 ? rows[best].balance : 0;
}

// Desde cuándo revisar contra el banco: el día después de la última vez que cuadró o, si nunca se
// ha cuadrado, desde el primer día del mes anterior.
export function reviewStart(acc, date) {
  const r = acc && acc.reconciled;
  if (r && r.date && r.date < date) return addDays(r.date, 1);
  return addMonths(ymOf(date), -1) + '-01';
}

// Compara el saldo de Moni con el que muestra el banco a una fecha. `bank` va con el signo de la app
// (la deuda de una tarjeta es negativa). `ticks`: los movimientos que la persona ya encontró en el banco.
export function compareWithBank(accId, { bank, date = todayStr(), from = null, ticks = [], hints = true, rows = null } = {}) {
  const acc = account(accId);
  if (!acc) return null;
  const cur = acc.currency;
  rows = rows || accountLedger(accId);
  from = from || reviewStart(acc, date);
  const moni = roundCur(balanceOn(rows, date), cur);
  const diff = roundCur(roundCur(bank, cur) - moni, cur);
  const tickSet = new Set(ticks);
  const win = rows.filter(r => r.tx.date >= from && r.tx.date <= date);
  let unticked = 0, nTicked = 0;
  for (const r of win) { if (tickSet.has(r.tx.id)) nTicked++; else unticked += r.delta; }
  unticked = roundCur(unticked, cur);
  // Si lo marcado es justo lo que muestra el banco: banco = saldo antes de la revisión + marcados + lo
  // que falta registrar. Despejando: falta = diferencia + lo no marcado.
  const missing = roundCur(diff + unticked, cur);
  return {
    acc, rows, cur, date, from, bank: roundCur(bank, cur), moni, diff, ok: diff === 0, win, nTicked, unticked, missing,
    hints: diff === 0 || !hints ? [] : reconcileHints(acc, rows, { diff, date, from }),
  };
}

const isFlow = (t) => t.kind === 'out' || t.kind === 'in';
const txKey = (t) => normKey(t.desc) || 'cat:' + ((category(t.categoryId) || {}).id || '');

// ¿Un monto es el otro con un error de tipeo? Dos dígitos vecinos invertidos, o un dígito de más o de menos.
export function isTypo(a, b) {
  const x = String(a), y = String(b);
  if (x === y) return false;
  if (x.length === y.length) {
    for (let i = 0; i < x.length - 1; i++) {
      if (x[i] !== y[i]) return x[i] === y[i + 1] && x[i + 1] === y[i] && x.slice(i + 2) === y.slice(i + 2);
    }
    return false;
  }
  const [lo, hi] = x.length < y.length ? [x, y] : [y, x];
  if (hi.length - lo.length !== 1) return false;
  for (let i = 0; i < hi.length; i++) if (hi.slice(0, i) + hi.slice(i + 1) === lo) return true;
  return false;
}

// Posibles explicaciones de una diferencia con el banco (diff = banco − Moni), de la más a la menos
// probable. Cada una trae el movimiento involucrado para revisarlo o corregirlo en un toque.
export function reconcileHints(acc, rows, { diff, date, from }) {
  const cur = acc.currency;
  const dec = currencyInfo(cur).decimals;
  const unit = 10 ** -dec;
  const r = (v) => roundCur(v, cur);
  const same = (a, b, tol = unit / 2) => Math.abs(r(a) - r(b)) < tol + 1e-9;
  const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
  const owner = ownerId();
  const out = [];
  const used = new Set();
  const add = (x) => { if (x.tx) { if (used.has(x.tx.id)) return; used.add(x.tx.id); } out.push(x); };
  const recent = rows.filter(x => x.tx.date >= from && x.tx.date <= date);
  const newest = [...recent].reverse();   // lo más reciente primero: es lo más probable que el banco aún no muestre

  // diferencia de unos pocos pesos o centavos: redondeos de compras en otra moneda
  if (Math.abs(diff) <= (dec ? 0.05 : 10)) out.push({ type: 'small' });
  // 1. registrado dos veces
  for (const x of newest) {
    if (!same(x.delta, -diff)) continue;
    const twin = rows.find(y => y !== x && same(y.delta, x.delta) && days(y.tx.date, x.tx.date) <= 4 && txKey(y.tx) === txKey(x.tx));
    if (twin) add({ type: 'dup', tx: x.tx, other: twin.tx });
  }
  // 2. lo último que se registró aún no aparece en el banco: todo lo anterior cuadra
  let sum = 0, n = 0, lastOne = null;
  for (const d of [...new Set(recent.map(x => x.tx.date))].sort().reverse()) {
    if (days(d, date) > 10) break;
    const ofDay = recent.filter(x => x.tx.date === d);
    for (const x of ofDay) { sum += x.delta; n++; }
    if (!same(sum, -diff, unit * 1.01)) continue;
    if (n >= 2) out.push({ type: 'later', since: d, count: n, sum: r(sum), checkpoint: addDays(d, -1) });
    else lastOne = { id: ofDay[0].tx.id, checkpoint: addDays(d, -1) };   // uno solo: va con su sugerencia
    break;
  }
  // 3. registrado en otra cuenta (de la misma moneda) o sin cuenta
  const lo = addDays(from, -7);
  for (const t of db.all('tx')) {
    if (!isFlow(t) || t.accountId === acc.id || t.date < lo || t.date > date) continue;
    const other = t.accountId ? account(t.accountId) : null;
    if (t.accountId ? (!other || other.currency !== cur) : (t.paidBy !== owner || t.currency !== cur)) continue;
    if (same((t.kind === 'in' ? 1 : -1) * t.amount, diff)) add({ type: 'elsewhere', tx: t, other });
  }
  // 4. cuenta fija del mes que suele salir de esta cuenta y no se ha registrado
  const billCats = new Set();
  if (diff < 0) {
    for (const b of pendingItems(ymOf(date)).items) {
      if (b.type !== 'bill') continue;
      const t = b.template;
      // solo las que ya debieron cobrarse a esa fecha
      if (t.accountId !== acc.id || t.paidBy !== owner || t.currency !== cur || b.day > Number(date.slice(8)) + 3) continue;
      const fits = b.fixed ? same(t.amount, -diff) : (cur === base() && Math.abs(-diff - b.median) <= 0.12 * b.median);
      if (fits) { billCats.add(b.catId); out.push({ type: 'bill', bill: b, amount: b.fixed ? t.amount : -diff }); }
    }
  }
  // 5. cargo de todos los meses (suscripción, PAC) que este mes aún no aparece y ya debió cobrarse
  const ym = ymOf(date), today = Number(date.slice(8));
  const prev3 = new Set([1, 2, 3].map(k => addMonths(ym, -k)));
  const groups = new Map();
  for (const x of rows) {
    const m = ymOf(x.tx.date);
    if ((m !== ym && !prev3.has(m)) || !isFlow(x.tx) || !same(x.delta, diff)) continue;
    if (billCats.has((category(x.tx.categoryId) || {}).id)) continue;
    const k = txKey(x.tx);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { tx: x.tx, months: new Set(), days: [] }));
    g.months.add(m);
    if (m !== ym) g.days.push(Number(x.tx.date.slice(8)));
    if (x.tx.date > g.tx.date) g.tx = x.tx;
  }
  [...groups.values()]
    .filter(g => !g.months.has(ym) && g.months.size >= 2 && Math.min(...g.days) <= today + 3)
    .sort((a, b) => b.months.size - a.months.size || b.tx.date.localeCompare(a.tx.date)).slice(0, 2)
    .forEach(g => out.push({ type: 'repeat', tx: g.tx, count: g.months.size }));
  // 6. un movimiento es justo la diferencia: no pasó por esta cuenta o el banco aún no lo muestra
  for (const x of newest) if (same(x.delta, -diff)) add({ type: 'extra', tx: x.tx, checkpoint: lastOne && lastOne.id === x.tx.id ? lastOne.checkpoint : null });
  // 7. registrado al revés (gasto como ingreso o al revés): descuadra el doble
  for (const x of newest) if (isFlow(x.tx) && same(2 * x.delta, -diff, unit * 1.01)) add({ type: 'sign', tx: x.tx });
  // 8. monto mal tipeado: con el monto correcto, cuadra
  const f = 10 ** dec;
  let typos = 0;
  for (const x of newest) {
    if (!isFlow(x.tx) || typos >= 3) continue;
    const target = r(x.delta + diff);
    if (!target || Math.sign(target) !== Math.sign(x.delta)) continue;
    if (isTypo(Math.round(Math.abs(x.delta) * f), Math.round(Math.abs(target) * f))) { add({ type: 'typo', tx: x.tx, amount: Math.abs(target) }); typos++; }
  }
  return out.slice(0, 6);
}

// Deja constancia de que la cuenta cuadró con el banco al cierre de `date`, con ese saldo.
export function markReconciled(accId, date, balance) {
  const a = account(accId);
  return db.put('accounts', { ...a, reconciled: { date, balance: roundCur(balance, a.currency), at: Date.now() } });
}

// ¿Cambió algo en lo ya conciliado? Compara el saldo de ese día con el que cuadró y lista los movimientos
// de ese período editados o agregados después (un borrado no deja rastro: solo cambia el saldo).
export function reconciledDrift(acc, rows = accountLedger(acc.id)) {
  const rec = acc && acc.reconciled;
  if (!rec || !rec.date) return null;
  const now = roundCur(balanceOn(rows, rec.date), acc.currency);
  const diff = roundCur(now - rec.balance, acc.currency);
  if (!diff) return null;
  const changed = rows.filter(x => x.tx.date <= rec.date && (x.tx.updatedAt || 0) > (rec.at || 0)).map(x => x.tx);
  return { date: rec.date, was: rec.balance, now, diff, changed };
}

// Categoría para registrar un descuadre: entre las de ajuste ("Ajuste", "Descuadre"), la más usada en
// esa cuenta el último año.
export function adjustCategoryFor(accId) {
  const adj = categories().filter(c => c.kind === 'adjust' && !c.archived);
  const named = adj.filter(c => /ajuste|descuadre/i.test(c.name));
  const pool = named.length ? named : adj;
  if (!pool.length) return null;
  const cut = addDays(todayStr(), -365);
  const n = new Map(pool.map(c => [c.id, 0]));
  for (const t of db.all('tx')) {
    if (t.accountId !== accId || t.date < cut) continue;
    const c = category(t.categoryId);
    if (c && n.has(c.id)) n.set(c.id, n.get(c.id) + 1);
  }
  return category([...n.entries()].sort((a, b) => b[1] - a[1])[0][0]);
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
export function categoryMatrix(months, { kind = 'expense', mode = 'total', by = 'category', pid = null, extraordinary = true, real = false } = {}) {
  const realF = real ? months.map(realFactor) : null;
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
    if (!extraordinary && cat.extraordinary) continue;
    // en gastos, una devolución (ingreso en una categoría de gasto) resta
    let v = txBase(tx) * (kind === 'expense' && tx.kind === 'in' ? -1 : 1) * (kind === 'expense' ? expenseFactor(tx, cat) : 1) * (realF ? realF[i] : 1);
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
  const inv = db.get('investments', invId);
  if (!inv) return months.map(ym => ({ ym, value: 0, invested: 0 }));
  const entries = entriesOf(invId);
  const cur = curYm();
  return months.map((ym) => {
    const st = fundStats(inv, ym === cur ? todayStr() : monthEnd(ym), entries);
    return { ym, value: st.balance, invested: st.invested };
  });
}

// Total de inversiones en moneda base al cierre de cada mes (incluye fondos ya archivados, que
// sí existían en el pasado; excluye monedas sin conversión como millas). El aportado se convierte
// al mismo tipo de cambio que el valor, así la ganancia es la del fondo y no un efecto cambiario.
export function portfolioHistory(months) {
  const out = months.map(ym => ({ ym, value: 0, invested: 0 }));
  const cur = curYm();
  for (const f of db.all('investments')) {
    if (isPoints(f) || isProperty(f) || currencyInfo(f.currency).convertible === false) continue;
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
  const skip = new Set(invId ? [] : db.all('investments').filter(i => isPoints(i) || isProperty(i)).map(i => i.id));
  for (const e of db.all('invEntries')) if ((invId ? e.invId === invId : !skip.has(e.invId)) && (!first || e.date < first)) first = e.date;
  const linked = invId ? [invId] : [...new Set(db.all('categories').filter(c => c.invId).map(c => c.invId))].filter(id => !skip.has(id));
  for (const id of linked) for (const e of linkedEntries(id)) if (!first || e.date < first) first = e.date;
  return first ? first.slice(0, 7) : null;
}

// ---- Datos iniciales para una instalación nueva --------------------------

// Al asociar una categoría: si la inversión ya tiene aportes ingresados a mano en fechas en que la categoría
// también tiene movimientos, contar ambos sería duplicarlos. Devuelve el día siguiente al último aporte manual.
export function linkOverlap(catId, invId) {
  const manual = db.all('invEntries').filter(e => e.invId === invId && e.kind === 'contrib');
  if (!manual.length) return null;
  const last = manual.map(e => e.date).sort().at(-1);
  const txs = db.all('tx').filter(t => (t.kind === 'out' || t.kind === 'in') && (category(t.categoryId) || {}).id === catId);
  const overlap = txs.filter(t => t.date <= last).length;
  if (!overlap) return null;
  return { last, from: addDays(last, 1), manual: manual.length, overlap, total: txs.length };
}

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

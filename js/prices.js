// Precios de inversiones por cantidad, consultados desde el teléfono (sin servidor):
// - Acciones y ETF: Twelve Data, con la clave gratuita de la persona (queda solo en este teléfono,
//   no viaja en los respaldos). A Twelve Data solo le llega el símbolo.
// - Cripto: CoinGecko, sin clave.
// Se guardan como una serie más ("px:<inversión>") junto a los tipos de cambio: precio de hoy y el cierre
// de cada mes desde la primera compra, para los gráficos.
import * as db from './db.js';
import * as M from './model.js';

const TD = 'https://api.twelvedata.com';
const CG = 'https://api.coingecko.com/api/v3';
const KEY = 'moni.tdKey', LAST_AT = 'moni.pxLastAt';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } } };

export const getKey = () => ls.get(KEY) || '';
export const setKey = (k) => ls.set(KEY, (k || '').trim() || null);
export const lastRefreshAt = () => Number(ls.get(LAST_AT)) || null;

export const SOURCES = [
  { v: 'twelve', l: 'Automático: acciones y ETF (Twelve Data)' },
  { v: 'coingecko', l: 'Automático: cripto (CoinGecko)' },
  { v: 'manual', l: 'Manual: lo ingreso yo (ej. valor cuota)' },
];

const getJson = async (url) => {
  const r = await fetch(url, { cache: 'no-store' });
  let j = null;
  try { j = await r.json(); } catch { /* ignore */ }
  if (j && j.status === 'error') { const e = new Error(tdMessage(j)); e.code = j.code; throw e; }
  if (!r.ok) { const e = new Error(r.status === 429 ? 'Demasiadas consultas: espera un minuto' : `Error ${r.status}`); e.code = r.status; throw e; }
  return j;
};
function tdMessage(j) {
  if (j.code === 401) return 'La clave de Twelve Data no es válida';
  if (j.code === 429) return 'Se alcanzó el límite de consultas por minuto de Twelve Data: espera un minuto';
  if (j.code === 404 || j.code === 400 || j.code === 403) return 'Símbolo no encontrado o no incluido en el plan gratis';
  return j.message || 'Error de Twelve Data';
}
const tdParams = (inv) => `symbol=${encodeURIComponent(inv.symbol)}${inv.mic ? `&mic_code=${encodeURIComponent(inv.mic)}` : ''}`;

// Búsqueda de símbolos (no usa clave).
export async function searchSymbols(q, source = 'twelve') {
  q = (q || '').trim();
  if (!q) return [];
  if (source === 'coingecko') {
    const j = await getJson(`${CG}/search?query=${encodeURIComponent(q)}`);
    return (j.coins || []).slice(0, 8).map(c => ({ symbol: c.id, name: `${c.name} (${c.symbol})`, exchange: 'Cripto', currency: 'USD' }));
  }
  const map = (d) => ({ symbol: d.symbol, mic: d.mic_code, name: d.instrument_name, exchange: `${d.exchange} · ${d.country}`, type: d.instrument_type, currency: d.currency, free: isFreeMic(d.mic_code) });
  const j = await getJson(`${TD}/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=10`);
  const syms = new Set((j.data || []).map(d => d.symbol));
  // "BSANTANDER0", "BSANTANDER1": series internas de la bolsa, no la acción
  let list = (j.data || []).filter(d => !(/\d$/.test(d.symbol) && syms.has(d.symbol.slice(0, -1)))).map(map);
  // una acción chilena (u otra bolsa fuera del plan gratis) suele transarse en EE.UU. como ADR: es lo que
  // compras en Zesty y sí tiene precio gratis. Se busca por el nombre de la empresa.
  const local = list.find(r => !r.free);
  if (local && !list.some(r => r.free)) {
    const name = local.name.replace(/[-.,]/g, ' ').replace(/\b(S ?A|Inc|Corp|ADR|Series \w+|Preferred|Common|Stock)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    // el nombre completo y, si no aparece, sus dos primeras palabras ("Sociedad Química…" → SQM)
    for (const qn of [...new Set([name, name.split(' ').slice(0, 2).join(' ')])]) {
      try {
        const j2 = await getJson(`${TD}/symbol_search?symbol=${encodeURIComponent(qn)}&outputsize=10`);
        const adr = (j2.data || []).map(map).filter(r => r.free);
        if (adr.length) { list = [...adr.map(r => ({ ...r, adr: true })), ...list]; break; }
      } catch { /* ignore */ }
    }
  }
  // primero lo que tiene precio gratis; sin repetir la misma acción en dos mercados de EE.UU.
  const seen = new Set();
  return list.sort((a, b) => (b.free ? 1 : 0) - (a.free ? 1 : 0))
    .filter(r => { const k = r.free ? r.symbol : r.symbol + r.mic; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Bolsas de EE.UU.: incluidas en el plan gratis de Twelve Data. Las demás (Santiago, Europa…) requieren plan pagado.
const US_MICS = new Set(['XNYS', 'XNAS', 'XNGS', 'XNCM', 'XNMS', 'ARCX', 'BATS', 'XASE', 'IEXG', 'XCBO', 'OTCM']);
export const isFreeMic = (mic) => !mic || US_MICS.has(mic);

async function fetchCurrent(inv) {
  if (inv.priceSource === 'coingecko') {
    const cur = inv.currency.toLowerCase();
    const j = await getJson(`${CG}/simple/price?ids=${encodeURIComponent(inv.symbol)}&vs_currencies=${cur}`);
    const v = j[inv.symbol] && j[inv.symbol][cur];
    if (v == null) throw new Error('Cripto no encontrada');
    return v;
  }
  const j = await getJson(`${TD}/price?${tdParams(inv)}&apikey=${encodeURIComponent(getKey())}`);
  const v = Number(j.price);
  if (!Number.isFinite(v)) throw new Error('Precio no disponible');
  return v;
}

// Cierres mensuales desde `fromYm` (sin el mes en curso).
async function fetchMonthly(inv, fromYm) {
  const out = [];
  const cur = M.curYm();
  if (inv.priceSource === 'coingecko') {
    const j = await getJson(`${CG}/coins/${encodeURIComponent(inv.symbol)}/market_chart?vs_currency=${inv.currency.toLowerCase()}&days=365&interval=daily`);
    const byMonth = new Map();
    for (const [ms, p] of j.prices || []) { const d = new Date(ms).toISOString().slice(0, 10); byMonth.set(d.slice(0, 7), p); }
    for (const [ym, p] of byMonth) if (ym >= fromYm && ym < cur) out.push([M.monthEnd(ym), p]);
    return out;
  }
  const n = Math.min(500, M.monthsBetween(fromYm, cur).length + 1);
  const j = await getJson(`${TD}/time_series?${tdParams(inv)}&interval=1month&outputsize=${n}&apikey=${encodeURIComponent(getKey())}`);
  for (const v of j.values || []) {
    const ym = v.datetime.slice(0, 7);
    if (ym >= fromYm && ym < cur && Number.isFinite(Number(v.close))) out.push([M.monthEnd(ym), Number(v.close)]);
  }
  return out;
}

export const autoFunds = () => db.all('investments').filter(i => M.isUnits(i) && !i.archived && i.symbol && (i.priceSource === 'twelve' || i.priceSource === 'coingecko'));
export const needsKey = () => autoFunds().some(i => i.priceSource === 'twelve') && !getKey();

let running = null;
// Actualiza los precios (todas o una inversión). Resultado: { updated, errors: [{ name, message }] }.
export function refreshPrices({ only = null, force = false } = {}) {
  if (running) return running;
  running = doRefresh(only, force).finally(() => { running = null; });
  return running;
}

async function doRefresh(only, force) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { updated: 0, errors: [{ name: '', message: 'Sin conexión' }], offline: true };
  if (!force && !only && Date.now() - (lastRefreshAt() || 0) < 60 * 60 * 1000) return { updated: 0, errors: [], skipped: true };
  const today = M.todayStr();
  const recs = [], errors = [];
  let updated = 0, calls = 0;
  for (const inv of autoFunds()) {
    if (only && inv.id !== only) continue;
    if (inv.priceSource === 'twelve' && !getKey()) { errors.push({ name: inv.name, message: 'Falta la clave de Twelve Data' }); continue; }
    // plan gratis de Twelve Data: 8 consultas por minuto
    if (inv.priceSource === 'twelve' && calls >= 7) { errors.push({ name: inv.name, message: 'Límite por minuto: se actualiza en la próxima consulta' }); continue; }
    try {
      const key = 'px:' + inv.id;
      const price = await fetchCurrent(inv);
      if (inv.priceSource === 'twelve') calls++;
      recs.push({ id: `${key}|${today}`, cur: key, date: today, rate: price });
      updated++;
      // historia mensual: si faltan cierres desde la primera compra
      const first = M.firstInvestmentMonth(inv.id);
      if (first && first < M.curYm()) {
        const have = new Set(db.all('rates').filter(r => r.cur === key).map(r => r.date));
        const missing = M.monthsBetween(first, M.addMonths(M.curYm(), -1)).some(ym => !have.has(M.monthEnd(ym)));
        if (missing && !(inv.priceSource === 'twelve' && calls >= 7)) {
          const hist = await fetchMonthly(inv, first);
          if (inv.priceSource === 'twelve') calls++;
          for (const [date, p] of hist) {
            const id = `${key}|${date}`;
            const prev = db.get('rates', id);
            if (!prev || (!prev.manual && prev.rate !== p)) recs.push({ id, cur: key, date, rate: p });
          }
        }
      }
    } catch (e) {
      // bolsa fuera del plan gratis: decir qué hacer en vez de "no encontrado"
      const msg = !isFreeMic(inv.mic) && e.code !== 401 && e.code !== 429
        ? 'esa bolsa no está en el plan gratis de Twelve Data. Si la compraste en Zesty, elige su versión en EE.UU. (ADR) en Editar inversión; si no, usa precio manual.'
        : (e.message || 'Error');
      errors.push({ name: inv.name, message: msg, paid: !isFreeMic(inv.mic) });
      if (e.code === 401 || e.code === 429) break;          // clave mala o límite: no seguir intentando
    }
  }
  if (recs.length) await db.putMany('rates', recs);
  if (!only && !errors.length) ls.set(LAST_AT, String(Date.now()));
  return { updated, errors };
}

// Precio ingresado a mano (fondos mutuos chilenos, acciones sin fuente automática).
export async function setManualPrice(inv, date, price) {
  const key = 'px:' + inv.id;
  await db.put('rates', { id: `${key}|${date}`, cur: key, date, rate: price, manual: true });
}

// Precios de inversiones por cantidad, consultados desde el teléfono (sin servidor):
// - Bolsa de Santiago: lista diaria que publica GitHub Actions en la rama "precios" de este mismo repositorio
//   (ver .github/workflows/precios.yml); sin clave ni configuración.
// - Acciones y ETF de EE.UU.: Twelve Data, con la clave gratuita de la persona (queda solo en este teléfono,
//   no viaja en los respaldos). A Twelve Data solo le llega el símbolo.
// - Cripto: CoinGecko, sin clave.
// Se guardan como una serie más ("px:<inversión>") junto a los tipos de cambio: precio del día y el cierre
// de cada mes desde la primera compra, para los gráficos.
import * as db from './db.js';
import * as M from './model.js';

const TD = 'https://api.twelvedata.com';
const CG = 'https://api.coingecko.com/api/v3';
const KEY = 'moni.tdKey', LAST_AT = 'moni.pxLastAt', FEED = 'moni.pxFeed';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } } };

export const getKey = () => ls.get(KEY) || '';
export const setKey = (k) => ls.set(KEY, (k || '').trim() || null);
export const lastRefreshAt = () => Number(ls.get(LAST_AT)) || null;

export const SOURCES = [
  { v: 'santiago', l: 'Automático: Bolsa de Santiago (precio diario)' },
  { v: 'twelve', l: 'Automático: acciones y ETF de EE.UU. (Twelve Data)' },
  { v: 'coingecko', l: 'Automático: cripto (CoinGecko)' },
  { v: 'manual', l: 'Manual: lo ingreso yo (ej. valor cuota)' },
];
// una acción de Santiago guardada antes con Twelve Data usa la lista diaria
export const sourceOf = (inv) => (inv.mic === 'XSGO' || inv.priceSource === 'santiago' ? 'santiago' : inv.priceSource);

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

// ---- Bolsa de Santiago: lista diaria publicada en GitHub ---------------------------------------
// En GitHub Pages (usuario.github.io/repo) se deduce la dirección; para probar en otro lado, moni.pxFeed.
export function feedUrl() {
  const own = ls.get(FEED);
  if (own) return own;
  if (typeof location !== 'undefined' && location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.split('.')[0];
    const repo = location.pathname.split('/').filter(Boolean)[0];
    if (repo) return `https://raw.githubusercontent.com/${owner}/${repo}/precios/santiago.json`;
  }
  return null;
}
const feedKey = (s) => String(s || '').toUpperCase().replace(/\.SN$/, '').replace(/\./g, '-');   // "SQM.B" (Twelve Data) = "SQM-B" (Yahoo)
let feedCache = null;
async function loadFeed() {
  if (feedCache && Date.now() - feedCache.at < 10 * 60 * 1000) return feedCache.data;
  const url = feedUrl();
  if (!url) throw new Error('la lista diaria de la Bolsa de Santiago se publica junto con la app en GitHub');
  let data;
  try { data = await getJson(url); } catch (e) {
    throw new Error(e.code === 404 ? 'la lista diaria de la Bolsa de Santiago aún no se publica (GitHub la crea minutos después de subir la app)' : 'no se pudo leer la lista de la Bolsa de Santiago');
  }
  feedCache = { at: Date.now(), data };
  return data;
}
async function feedEntry(inv) {
  const f = await loadFeed();
  const e = f.prices && f.prices[feedKey(inv.symbol)];
  if (!e) throw new Error(`${inv.symbol} no está en la lista diaria de la Bolsa de Santiago: usa precio manual`);
  return e;
}

// ---- búsqueda ---------------------------------------------------------------------------------------

// Bolsas con precio gratis: EE.UU. (Twelve Data) y Santiago (lista diaria).
const US_MICS = new Set(['XNYS', 'XNAS', 'XNGS', 'XNCM', 'XNMS', 'ARCX', 'BATS', 'XASE', 'IEXG', 'XCBO', 'OTCM']);
export const isFreeMic = (mic) => !mic || US_MICS.has(mic) || mic === 'XSGO';

// Búsqueda de símbolos (no usa clave).
export async function searchSymbols(q, source = 'twelve') {
  q = (q || '').trim();
  if (!q) return [];
  if (source === 'coingecko') {
    const j = await getJson(`${CG}/search?query=${encodeURIComponent(q)}`);
    return (j.coins || []).slice(0, 8).map(c => ({ symbol: c.id, name: `${c.name} (${c.symbol})`, exchange: 'Cripto', currency: 'USD' }));
  }
  const map = (d) => ({
    symbol: d.symbol, mic: d.mic_code, name: d.instrument_name, exchange: `${d.exchange} · ${d.country}`, type: d.instrument_type,
    currency: d.currency, free: isFreeMic(d.mic_code), source: d.mic_code === 'XSGO' ? 'santiago' : 'twelve',
  });
  let data = [];
  try { data = (await getJson(`${TD}/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=10`)).data || []; } catch { /* sin búsqueda: queda la lista diaria */ }
  const syms = new Set(data.map(d => d.symbol));
  // "BSANTANDER0", "BSANTANDER1": series internas de la bolsa, no la acción
  let list = data.filter(d => !(/\d$/.test(d.symbol) && syms.has(d.symbol.slice(0, -1)))).map(map);
  // acciones de la lista diaria de Santiago que la búsqueda no trajo
  try {
    const f = await loadFeed();
    const nq = feedKey(q);
    for (const [k, e] of Object.entries(f.prices || {})) {
      if (!(k.startsWith(nq) || e.name.toUpperCase().includes(q.toUpperCase()))) continue;
      if (list.some(r => r.source === 'santiago' && feedKey(r.symbol) === k)) continue;
      list.push({ symbol: k, mic: 'XSGO', name: e.name, exchange: 'Bolsa de Santiago · Chile', currency: 'CLP', free: true, source: 'santiago' });
    }
  } catch { /* lista no disponible */ }
  // otra bolsa fuera del plan gratis: se ofrece la versión en EE.UU. (ADR), si existe
  const local = list.find(r => !r.free);
  if (local && !list.some(r => r.free)) {
    const name = local.name.replace(/[-.,]/g, ' ').replace(/\b(S ?A|Inc|Corp|ADR|Series \w+|Preferred|Common|Stock)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    for (const qn of [...new Set([name, name.split(' ').slice(0, 2).join(' ')])]) {
      try {
        const j2 = await getJson(`${TD}/symbol_search?symbol=${encodeURIComponent(qn)}&outputsize=10`);
        const adr = (j2.data || []).map(map).filter(r => r.free);
        if (adr.length) { list = [...adr.map(r => ({ ...r, adr: true })), ...list]; break; }
      } catch { /* ignore */ }
    }
  }
  // primero lo que tiene precio gratis (Santiago antes que EE.UU. si se buscó una acción chilena)
  const seen = new Set();
  const rank = (r) => (r.free ? 0 : 2) + (r.source === 'santiago' && list.some(x => x.source === 'santiago' && feedKey(x.symbol) === feedKey(q)) ? -1 : 0);
  return list.sort((a, b) => rank(a) - rank(b))
    .filter(r => { const k = r.source + (r.free ? feedKey(r.symbol) : r.symbol + r.mic); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---- consulta ---------------------------------------------------------------------------------------

async function fetchCurrent(inv) {
  const src = sourceOf(inv);
  if (src === 'santiago') { const e = await feedEntry(inv); return { price: e.price, date: e.date }; }
  if (src === 'coingecko') {
    const cur = inv.currency.toLowerCase();
    const j = await getJson(`${CG}/simple/price?ids=${encodeURIComponent(inv.symbol)}&vs_currencies=${cur}`);
    const v = j[inv.symbol] && j[inv.symbol][cur];
    if (v == null) throw new Error('Cripto no encontrada');
    return { price: v, date: M.todayStr() };
  }
  const j = await getJson(`${TD}/price?${tdParams(inv)}&apikey=${encodeURIComponent(getKey())}`);
  const v = Number(j.price);
  if (!Number.isFinite(v)) throw new Error('Precio no disponible');
  return { price: v, date: M.todayStr() };
}

// Cierres mensuales desde `fromYm` (sin el mes en curso).
async function fetchMonthly(inv, fromYm) {
  const out = [];
  const cur = M.curYm();
  const src = sourceOf(inv);
  if (src === 'santiago') {
    const e = await feedEntry(inv);
    for (const [ym, p] of Object.entries(e.months || {})) if (ym >= fromYm && ym < cur) out.push([M.monthEnd(ym), p]);
    return out;
  }
  if (src === 'coingecko') {
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

export const autoFunds = () => db.all('investments').filter(i => M.isUnits(i) && !i.archived && i.symbol && i.priceSource && i.priceSource !== 'manual');
export const needsKey = () => autoFunds().some(i => sourceOf(i) === 'twelve') && !getKey();

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
  if (force || only) feedCache = null;
  const recs = [], errors = [];
  let updated = 0, calls = 0;
  for (const inv of autoFunds()) {
    if (only && inv.id !== only) continue;
    const td = sourceOf(inv) === 'twelve';
    if (td && !getKey()) { errors.push({ name: inv.name, message: 'Falta la clave de Twelve Data' }); continue; }
    // plan gratis de Twelve Data: 8 consultas por minuto
    if (td && calls >= 7) { errors.push({ name: inv.name, message: 'Límite por minuto: se actualiza en la próxima consulta' }); continue; }
    try {
      const key = 'px:' + inv.id;
      const { price, date } = await fetchCurrent(inv);
      if (td) calls++;
      const prevDay = db.get('rates', `${key}|${date}`);
      if (!prevDay || (!prevDay.manual && prevDay.rate !== price)) recs.push({ id: `${key}|${date}`, cur: key, date, rate: price });
      updated++;
      // historia mensual: si faltan cierres desde la primera compra
      const first = M.firstInvestmentMonth(inv.id);
      if (first && first < M.curYm()) {
        const have = new Set(db.all('rates').filter(r => r.cur === key).map(r => r.date));
        const missing = M.monthsBetween(first, M.addMonths(M.curYm(), -1)).some(ym => !have.has(M.monthEnd(ym)));
        if (missing && !(td && calls >= 7)) {
          const hist = await fetchMonthly(inv, first);
          if (td) calls++;
          for (const [d, p] of hist) {
            const id = `${key}|${d}`;
            const prev = db.get('rates', id);
            if (!prev || (!prev.manual && prev.rate !== p)) recs.push({ id, cur: key, date: d, rate: p });
          }
        }
      }
    } catch (e) {
      // bolsa fuera del plan gratis: decir qué hacer en vez de "no encontrado"
      const paid = td && !isFreeMic(inv.mic) && e.code !== 401 && e.code !== 429;
      errors.push({ name: inv.name, message: paid ? 'esa bolsa no está en el plan gratis de Twelve Data: usa precio manual o su versión en EE.UU. (ADR).' : (e.message || 'Error'), paid });
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

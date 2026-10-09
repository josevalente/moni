// Tipos de cambio: se consultan cuando hay conexión y se guardan localmente.
// Sin conexión se usa el último valor guardado (ver model.rateFor) y los movimientos registrados así
// quedan "pendientes de tipo de cambio" hasta que se pueda consultar el del día.
import * as db from './db.js';
import { addDays, base, lastRateDate, rateFor, timeoutSignal, todayStr } from './model.js';

const API = 'https://mindicador.cl/api';
const MAP = { USD: 'dolar', EUR: 'euro', UF: 'uf', MUSD: 'dolar' };
const LAST = 'moni.fxLast', LAST_AT = 'moni.fxLastAt';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

export const fetchedToday = () => ls.get(LAST) === todayStr();
export const lastFetchAt = () => { const v = Number(ls.get(LAST_AT)); return v || null; };

let running = null;
// Resultado: { ok, count, failed, reason } — ok = se pudo consultar (aunque no hubiera valores nuevos).
export function refreshRates({ force = false } = {}) {
  if (running) return running;
  running = doRefresh(force).finally(() => { running = null; });
  return running;
}

async function doRefresh(force) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, reason: 'offline' };
  const today = todayStr();
  if (!force && fetchedToday()) return { ok: true, skipped: true, count: 0 };
  const recs = [];
  let failed = 0;
  const codes = [...new Set(Object.values(MAP))];
  for (const code of codes) {
    const curs = Object.entries(MAP).filter(([cur, c]) => c === code && cur !== base()).map(([cur]) => cur);
    if (!curs.length) continue;
    // al día: los últimos ~30 valores; si el último guardado es antiguo, los años que faltan
    const last = curs.map(lastRateDate).filter(Boolean).sort()[0];
    const urls = !last || last < addDays(today, -25)
      ? [...new Set([(last || today).slice(0, 4), today.slice(0, 4)])].map(y => `${API}/${code}/${y}`)
      : [`${API}/${code}`];
    for (const url of urls) {
      try {
        const r = await fetch(url, { cache: 'no-store', signal: timeoutSignal() });
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        for (const p of j.serie || []) {
          const date = p.fecha.slice(0, 10);
          for (const cur of curs) {
            const id = `${cur}|${date}`;
            const cur0 = db.get('rates', id);
            if (cur0 && (cur0.manual || cur0.rate === p.valor)) continue;   // no pisa tasas manuales ni reescribe iguales
            recs.push({ id, cur, date, rate: p.valor });
          }
        }
      } catch { failed++; }
    }
  }
  if (recs.length) await db.putMany('rates', recs);
  const ok = failed < codes.length;            // al menos una fuente respondió
  if (!failed) { ls.set(LAST, today); ls.set(LAST_AT, String(Date.now())); }
  if (ok) await fillPending();
  return { ok, count: recs.length, failed, reason: ok ? null : 'network' };
}

// Tipo de cambio para un movimiento nuevo. Si aún no se consultó el de esa fecha, queda marcado como
// pendiente y se completa en la próxima consulta.
export function fxFields(cur, date) {
  if (!cur || cur === base()) return {};
  const fx = rateFor(cur, date);
  const last = lastRateDate(cur);
  const pending = !fetchedToday() && (!last || last < date) && date >= addDays(todayStr(), -7);
  return fx == null ? { fxPending: true } : pending ? { fx, fxPending: true } : { fx };
}

// Antes de guardar algo en otra moneda: si hay conexión y no se ha consultado hoy, consulta (máx. 3 s).
export async function ensureFresh(cur, ms = 3000) {
  if (!cur || cur === base() || fetchedToday() || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  await Promise.race([refreshRates().catch(() => {}), new Promise(r => setTimeout(r, ms))]);
}

// Completa los movimientos que se guardaron sin el tipo de cambio de su fecha.
async function fillPending() {
  const upd = [];
  for (const t of db.all('tx')) {
    if (!t.fxPending) continue;
    const fx = rateFor(t.currency, t.date);
    const last = lastRateDate(t.currency);
    if (fx == null) continue;
    // ya hay un valor de esa fecha o posterior (o pasó una semana): se fija el que corresponde
    if ((last && last >= t.date) || t.date < addDays(todayStr(), -7) || fetchedToday()) {
      const n = { ...t, fx };
      delete n.fxPending;
      upd.push(n);
    }
  }
  if (upd.length) await db.putMany('tx', upd);
}

export async function setManualRate(cur, date, rate) {
  await db.put('rates', { id: `${cur}|${date}`, cur, date, rate, manual: true });
}

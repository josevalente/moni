// Tipos de cambio: se consultan cuando hay conexión y se guardan localmente.
// Sin conexión se usa el último valor guardado (ver model.rateFor).
import * as db from './db.js';
import { base, todayStr } from './model.js';

const API = 'https://mindicador.cl/api';
const MAP = { USD: 'dolar', EUR: 'euro', UF: 'uf', MUSD: 'dolar' };

export async function refreshRates({ force = false } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, reason: 'offline' };
  const today = todayStr();
  const last = localStorage.getItem('moni.fxLast');
  if (!force && last === today) return { ok: true, skipped: true };
  const year = today.slice(0, 4);
  const recs = [];
  let failed = 0;
  const codes = [...new Set(Object.values(MAP))];
  for (const code of codes) {
    try {
      const r = await fetch(`${API}/${code}/${year}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      for (const p of j.serie || []) {
        const date = p.fecha.slice(0, 10);
        for (const [cur, c] of Object.entries(MAP)) {
          if (c !== code || cur === base()) continue;
          const id = `${cur}|${date}`;
          const cur0 = db.get('rates', id);
          if (cur0 && (cur0.manual || cur0.rate === p.valor)) continue;   // no pisa tasas manuales ni reescribe iguales
          recs.push({ id, cur, date, rate: p.valor });
        }
      }
    } catch { failed++; }
  }
  if (recs.length) await db.putMany('rates', recs);
  if (!failed) localStorage.setItem('moni.fxLast', today);
  return { ok: recs.length > 0, count: recs.length, failed };
}

export async function setManualRate(cur, date, rate) {
  await db.put('rates', { id: `${cur}|${date}`, cur, date, rate, manual: true });
}

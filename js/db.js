// Almacenamiento local: IndexedDB con espejo en memoria (los datos son chicos: ~MBs).
// Cada registro tiene id + updatedAt; los borrados son "tombstones" para poder
// mezclar respaldos entre dispositivos (último cambio gana).
//
// Garantías:
// - Si iOS cierra la conexión (pasa al volver de segundo plano) se reabre y se reintenta.
// - Si una escritura falla igual, se deshace el cambio en memoria y se avisa (evento 'moni:dberror'):
//   la pantalla nunca muestra algo que no quedó guardado.
// - Importar y borrar todo son una sola transacción: o se aplica completo o no se aplica nada.

export const STORES = [
  'tx', 'accounts', 'categories', 'people', 'settings', 'splits',
  'investments', 'invEntries', 'debts', 'debtEntries', 'rates',
];

const DB_NAME = 'moni';
const DB_VERSION = 1;
let idb = null;
let useIdb = false;
const mem = {};
for (const s of STORES) mem[s] = new Map();
const listeners = new Set();
let ready = false;

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// Los suscriptores reciben el conjunto de tiendas que cambiaron.
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let pendingStores = null;
function emit(...stores) {
  const first = !pendingStores;
  pendingStores = pendingStores || new Set();
  for (const s of stores) pendingStores.add(s);
  if (!first) return;
  queueMicrotask(() => { const ch = pendingStores; pendingStores = null; listeners.forEach(f => f(ch)); });
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function openIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onclose = () => { if (idb === d) idb = null; };              // WebKit puede cerrarla sin aviso
      d.onversionchange = () => { d.close(); if (idb === d) idb = null; };
      res(d);
    };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('La base de datos está bloqueada por otra pestaña'));
  });
}

async function getDb() {
  if (!idb) idb = await openIdb();
  return idb;
}

export async function open() {
  if (ready) return;
  if (typeof indexedDB === 'undefined') { ready = true; return; } // modo memoria (tests)
  useIdb = true;
  const d = await getDb();
  for (const s of STORES) {
    const rows = await req(d.transaction(s).objectStore(s).getAll());
    for (const o of rows) mem[s].set(o.id, o);
  }
  ready = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
}

// Ejecuta una transacción de escritura; si la conexión murió, reabre y reintenta una vez.
async function writeTx(stores, fn) {
  if (!useIdb) return;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await getDb();
      await new Promise((res, rej) => {
        const t = d.transaction(stores, 'readwrite');
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('Transacción abortada'));
        try { fn(t); } catch (e) { try { t.abort(); } catch { /* ignore */ } rej(e); }
      });
      return;
    } catch (e) {
      lastErr = e;
      idb = null;           // fuerza reabrir en el reintento
    }
  }
  throw lastErr;
}

function reportError(e) {
  try { globalThis.dispatchEvent && globalThis.dispatchEvent(new CustomEvent('moni:dberror', { detail: e })); } catch { /* ignore */ }
}

// Aplica cambios en memoria, los persiste y, si falla, los revierte.
async function commit(store, objs) {
  const prev = objs.map(o => [o.id, mem[store].get(o.id)]);
  for (const o of objs) mem[store].set(o.id, o);
  emit(store);
  try {
    await writeTx([store], (t) => { const os = t.objectStore(store); for (const o of objs) os.put(o); });
  } catch (e) {
    for (const [id, old] of prev) { if (old) mem[store].set(id, old); else mem[store].delete(id); }
    emit(store);
    reportError(e);
    throw e;
  }
}

export const all = (s) => { const out = []; for (const o of mem[s].values()) if (!o.deleted) out.push(o); return out; };
export const get = (s, id) => { const o = mem[s].get(id); return o && !o.deleted ? o : undefined; };
export const count = (s) => all(s).length;

export async function put(store, obj) {
  if (!obj.id) obj.id = uid();
  if (!obj.createdAt) obj.createdAt = Date.now();
  obj.updatedAt = Date.now();
  await commit(store, [obj]);
  return obj;
}

export async function putMany(store, objs, { touch = true } = {}) {
  if (!objs.length) return;
  const now = Date.now();
  for (const o of objs) {
    if (!o.id) o.id = uid();
    if (!o.createdAt) o.createdAt = now;
    if (touch || !o.updatedAt) o.updatedAt = now;
  }
  await commit(store, objs);
}

const tombstone = (store, id, now) => {
  const cur = mem[store].get(id);
  return { id, deleted: true, updatedAt: now, createdAt: cur ? cur.createdAt : now };
};

export async function del(store, id) { await commit(store, [tombstone(store, id, Date.now())]); }

export async function delMany(store, ids) {
  if (!ids.length) return;
  const now = Date.now();
  await commit(store, ids.map(id => tombstone(store, id, now)));
}

// ---- Respaldo / mezcla --------------------------------------------------

export function exportAll() {
  const data = {};
  for (const s of STORES) data[s] = [...mem[s].values()];
  return { app: 'moni', version: 1, exportedAt: new Date().toISOString(), data };
}

// mode 'merge': por id gana el updatedAt más reciente. mode 'replace': reemplaza todo.
// En 'merge' se rechaza un archivo de otra instalación (personas sin ningún id en común):
// combinarlo duplicaría personas y categorías y pisaría la configuración.
export async function importAll(payload, mode = 'merge', { force = false } = {}) {
  if (!payload || payload.app !== 'moni' || !payload.data || typeof payload.data !== 'object') throw new Error('Archivo no válido');
  const data = {};
  for (const s of STORES) {
    const arr = payload.data[s] || [];
    if (!Array.isArray(arr)) throw new Error(`Archivo no válido (${s})`);
    for (const o of arr) if (!o || typeof o !== 'object' || o.id == null) throw new Error(`Archivo no válido: hay un registro sin id en "${s}"`);
    data[s] = arr;
  }
  if (mode === 'merge' && !force) {
    const localPeople = all('people').map(p => p.id);
    const incoming = data.people.filter(p => !p.deleted).map(p => p.id);
    if (localPeople.length && incoming.length && !incoming.some(id => localPeople.includes(id))) {
      const err = new Error('Este archivo viene de otra instalación de Moni (sus personas no coinciden con las de este teléfono). Combinarlo duplicaría personas y categorías. Usa "Reemplazar todo", o haz que el otro teléfono parta importando un respaldo de este.');
      err.code = 'FOREIGN';
      throw err;
    }
  }
  // calcular el resultado sin tocar nada todavía
  const stats = { added: 0, updated: 0, skipped: 0 };
  const writes = {};
  for (const s of STORES) {
    writes[s] = [];
    for (const o of data[s]) {
      const cur = mode === 'replace' ? undefined : mem[s].get(o.id);
      if (!cur) { writes[s].push(o); stats.added++; continue; }
      if ((o.updatedAt || 0) <= (cur.updatedAt || 0)) { stats.skipped++; continue; }
      if (s === 'settings' && !o.deleted && !cur.deleted) {
        // configuración: gana la más reciente, pero no se pierden monedas agregadas en el otro teléfono
        const codes = new Set((o.currencies || []).map(c => c.code));
        writes[s].push({ ...o, currencies: [...(o.currencies || []), ...(cur.currencies || []).filter(c => !codes.has(c.code))] });
      } else writes[s].push(o);
      stats.updated++;
    }
  }
  await writeTx(STORES, (t) => {
    for (const s of STORES) {
      const os = t.objectStore(s);
      if (mode === 'replace') os.clear();
      for (const o of writes[s]) os.put(o);
    }
  });
  // la transacción se confirmó: recién ahora se refleja en memoria
  for (const s of STORES) {
    if (mode === 'replace') mem[s].clear();
    for (const o of writes[s]) mem[s].set(o.id, o);
  }
  emit(...STORES);
  return stats;
}

export async function wipe() {
  await writeTx(STORES, (t) => { for (const s of STORES) t.objectStore(s).clear(); });
  for (const s of STORES) mem[s].clear();
  emit(...STORES);
}

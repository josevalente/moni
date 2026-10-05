// Almacenamiento local: IndexedDB con espejo en memoria (los datos son chicos: ~MBs).
// Cada registro tiene id + updatedAt; los borrados son "tombstones" para poder
// mezclar respaldos entre dispositivos (último cambio gana).

export const STORES = [
  'tx', 'accounts', 'categories', 'people', 'settings', 'splits',
  'investments', 'invEntries', 'debts', 'debtEntries', 'rates',
];

const DB_NAME = 'moni';
const DB_VERSION = 1;
let idb = null;
const mem = {};
for (const s of STORES) mem[s] = new Map();
const listeners = new Set();
let ready = false;

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let pending = false;
function emit() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => { pending = false; listeners.forEach(f => f()); });
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export async function open() {
  if (ready) return;
  if (typeof indexedDB === 'undefined') { ready = true; return; } // modo memoria (tests)
  idb = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  for (const s of STORES) {
    const rows = await req(idb.transaction(s).objectStore(s).getAll());
    for (const o of rows) mem[s].set(o.id, o);
  }
  ready = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
}

function persist(store, objs) {
  if (!idb) return Promise.resolve();
  return new Promise((res, rej) => {
    const t = idb.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const o of objs) os.put(o);
    t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}

export const all = (s) => { const out = []; for (const o of mem[s].values()) if (!o.deleted) out.push(o); return out; };
export const get = (s, id) => { const o = mem[s].get(id); return o && !o.deleted ? o : undefined; };
export const count = (s) => all(s).length;

export async function put(store, obj) {
  if (!obj.id) obj.id = uid();
  if (!obj.createdAt) obj.createdAt = Date.now();
  obj.updatedAt = Date.now();
  mem[store].set(obj.id, obj);
  emit();
  await persist(store, [obj]);
  return obj;
}

export async function putMany(store, objs, { touch = true } = {}) {
  const now = Date.now();
  for (const o of objs) {
    if (!o.id) o.id = uid();
    if (!o.createdAt) o.createdAt = now;
    if (touch || !o.updatedAt) o.updatedAt = now;
    mem[store].set(o.id, o);
  }
  emit();
  await persist(store, objs);
}

export async function del(store, id) {
  const cur = mem[store].get(id);
  const tomb = { id, deleted: true, updatedAt: Date.now(), createdAt: cur ? cur.createdAt : Date.now() };
  mem[store].set(id, tomb);
  emit();
  await persist(store, [tomb]);
}

// ---- Respaldo / mezcla --------------------------------------------------

export function exportAll() {
  const data = {};
  for (const s of STORES) data[s] = [...mem[s].values()];
  return { app: 'moni', version: 1, exportedAt: new Date().toISOString(), data };
}

// mode 'merge': por id gana el updatedAt más reciente. mode 'replace': borra todo antes.
export async function importAll(payload, mode = 'merge') {
  if (!payload || payload.app !== 'moni' || !payload.data) throw new Error('Archivo no válido');
  const stats = { added: 0, updated: 0, skipped: 0 };
  if (mode === 'replace') {
    for (const s of STORES) {
      mem[s].clear();
      if (idb) await new Promise((res, rej) => {
        const t = idb.transaction(s, 'readwrite'); t.objectStore(s).clear();
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    }
  }
  for (const s of STORES) {
    const incoming = payload.data[s] || [];
    const toWrite = [];
    for (const o of incoming) {
      const cur = mem[s].get(o.id);
      if (!cur) { toWrite.push(o); stats.added++; }
      else if ((o.updatedAt || 0) > (cur.updatedAt || 0)) { toWrite.push(o); stats.updated++; }
      else stats.skipped++;
    }
    for (const o of toWrite) mem[s].set(o.id, o);
    if (toWrite.length) await persist(s, toWrite);
  }
  emit();
  return stats;
}

export async function wipe() {
  for (const s of STORES) {
    mem[s].clear();
    if (idb) await new Promise((res, rej) => {
      const t = idb.transaction(s, 'readwrite'); t.objectStore(s).clear();
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }
  emit();
}

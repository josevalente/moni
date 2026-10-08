import * as db from './db.js';
import * as M from './model.js';
import * as FX from './fx.js';
import { fill, h, toast } from './ui.js';
import { renderHome, pendingNow } from './views/home.js';
import { renderTxs } from './views/txs.js';
import { renderClose } from './views/close.js';
import { renderMore } from './views/settings.js';
import { renderReports } from './views/reports.js';
import { openTxForm } from './views/add.js';

const app = document.getElementById('app');
const TABS = [
  { id: '', title: 'Inicio', icon: '🏠', render: renderHome },
  { id: 'movs', title: 'Movimientos', icon: '🧾', render: renderTxs },
  { id: 'reportes', title: 'Reportes', icon: '📊', render: renderReports },
  { id: 'cierre', title: 'Cierre', icon: '⚖️', render: renderClose },
  { id: 'mas', title: 'Más', icon: '☰', render: renderMore },
];

let refresh = null;
let current = null;

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { tab: parts[0] || '', sub: parts[1] || '' };
}

function welcome() {
  const fileBtn = () => {
    const i = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    i.addEventListener('change', async () => {
      try { const p = JSON.parse(await i.files[0].text()); const s = await db.importAll(p, 'replace'); toast(`Datos cargados (${s.added} registros)`); location.hash = '#/'; draw(); }
      catch (e) { toast(e.message || 'Archivo no válido'); }
    });
    document.body.append(i); i.click();
  };
  return h('div', { class: 'welcome' },
    h('h1', null, 'Moni'),
    h('p', null, 'Tus finanzas, en tu teléfono, con o sin conexión. Los datos se guardan solo en este dispositivo.'),
    h('div', { class: 'actions col' },
      h('button', { class: 'btn primary big', onclick: fileBtn }, 'Importar mis datos (.json)'),
      h('button', { class: 'btn big', onclick: async () => { await M.seedDefaults(); draw(); } }, 'Empezar desde cero')),
    h('p', { class: 'muted small' }, 'Si ya usan Moni en otro teléfono, importa un respaldo de ese teléfono (Más › Respaldo › Exportar) en vez de empezar desde cero: así podrán combinar sus datos.'));
}

function draw() {
  const { tab, sub } = parseHash();
  const t = TABS.find(x => x.id === tab) || TABS[0];
  document.querySelectorAll('.tabbar a[data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === t.id));
  document.getElementById('title').textContent = t.title;
  document.getElementById('fab').hidden = !db.count('people');
  if (!db.count('people')) { fill(app, welcome()); refresh = null; return; }
  const key = location.hash;
  const body = h('div', { class: 'page' });
  fill(app, body);
  const r = t.render(body, sub);
  refresh = typeof r === 'function' ? r : () => t.render(body, sub);
  if (current !== key) window.scrollTo(0, 0);
  current = key;
  updateBadge();
}

// Número de pendientes sobre el ícono de la app (iPhone con iOS 16.4+, si se permitieron notificaciones).
function updateBadge() {
  if (!('setAppBadge' in navigator) || !db.count('people')) return;
  try {
    const n = pendingNow().items.length;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch { /* ignore */ }
}
window.addEventListener('moni:badge', updateBadge);
// al volver a la app: la fecha pudo cambiar (nuevo mes, cuentas que vencen)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && refresh && db.count('people')) { refresh(); updateBadge(); FX.refreshRates().catch(() => {}); }
});

let rafPending = false;
db.subscribe(() => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!db.count('people')) return draw();
    if (refresh) { const y = window.scrollY; refresh(); window.scrollTo(0, y); }
    updateBadge();
  });
});

window.addEventListener('hashchange', draw);
window.addEventListener('online', () => { document.body.classList.remove('offline'); FX.refreshRates().catch(() => {}); });
window.addEventListener('offline', () => document.body.classList.add('offline'));

// Nada falla en silencio: si una escritura no quedó guardada, la pantalla ya se revirtió y se avisa.
window.addEventListener('moni:dberror', (e) => {
  toast('No se pudo guardar en el teléfono: ' + ((e.detail && (e.detail.message || e.detail.name)) || 'error desconocido') + '. Inténtalo de nuevo.', { ms: 8000 });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r && r.name === 'AbortError') return;
  console.error(r);
  toast('Ocurrió un error: ' + ((r && r.message) || r), { ms: 6000 });
});

// Recuperación si la app no puede arrancar (por ejemplo, archivos de versiones mezcladas en caché).
async function resetAppCache() {
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* ignore */ }
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
  location.reload();
}

async function start() {
  await db.open();
  document.getElementById('fab').addEventListener('click', () => {
    // en la cartola de una cuenta, el movimiento nuevo es de esa cuenta
    const { tab, sub } = parseHash();
    const acc = tab === 'movs' && sub ? M.account(sub) : null;
    openTxForm(null, acc && !acc.archived ? { accountId: acc.id, lockAccount: true } : {});
  });
  if (!navigator.onLine) document.body.classList.add('offline');
  draw();
  window.__moniStarted = true;
  FX.refreshRates().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Hay una versión nueva de Moni.', { label: 'Actualizar', onAction: () => location.reload(), ms: 15000 });
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
start().catch((e) => {
  console.error(e);
  window.__moniStarted = true;
  fill(app, h('div', { class: 'welcome' },
    h('h1', null, 'Moni'),
    h('p', null, 'No se pudo iniciar: ' + ((e && e.message) || e)),
    h('p', { class: 'muted small' }, 'Tus datos no se borran con esto. Si el problema sigue, recarga la app desde la red.'),
    h('div', { class: 'actions col' }, h('button', { class: 'btn primary big', onclick: resetAppCache }, 'Recargar la app'))));
});

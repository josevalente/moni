import * as db from './db.js';
import * as M from './model.js';
import * as FX from './fx.js';
import { h, toast } from './ui.js';
import { renderHome } from './views/home.js';
import { renderTxs } from './views/txs.js';
import { renderClose } from './views/close.js';
import { renderMore } from './views/settings.js';
import { openTxForm } from './views/add.js';

const app = document.getElementById('app');
const TABS = [
  { id: '', title: 'Inicio', icon: '🏠', render: renderHome },
  { id: 'movs', title: 'Movimientos', icon: '🧾', render: renderTxs },
  { id: 'cierre', title: 'Cierre', icon: '⚖️', render: renderClose },
  { id: 'mas', title: 'Más', icon: '☰', render: renderMore },
];

let refresh = null;
let current = null;

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { tab: parts[0] || '', sub: parts[1] || '' };
}

function backupBanner() {
  if (db.count('tx') < 20) return null;
  let last = null;
  try { last = localStorage.getItem('moni.lastBackup'); } catch { /* ignore */ }
  const days = last ? (Date.now() - new Date(last).getTime()) / 864e5 : Infinity;
  if (days < 30 || sessionStorage.getItem('moni.hideBackup')) return null;
  return h('div', { class: 'banner' },
    h('span', null, last ? `Hace ${Math.floor(days)} días del último respaldo.` : 'Aún no has hecho un respaldo.'),
    h('a', { href: '#/mas/respaldo' }, 'Respaldar'),
    h('button', { class: 'icon-btn', 'aria-label': 'Ocultar', onclick: () => { sessionStorage.setItem('moni.hideBackup', '1'); draw(); } }, '✕'));
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
    h('p', { class: 'muted small' }, 'Si vienes de tu planilla, genera el archivo con tools/migrate.py y pásalo al teléfono por AirDrop o iCloud Drive.'));
}

function draw() {
  const { tab, sub } = parseHash();
  const t = TABS.find(x => x.id === tab) || TABS[0];
  document.querySelectorAll('.tabbar a[data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === t.id));
  document.getElementById('title').textContent = t.title;
  document.getElementById('fab').hidden = !db.count('people');
  if (!db.count('people')) { app.replaceChildren(welcome()); refresh = null; return; }
  const key = location.hash;
  const body = h('div', { class: 'page' });
  const banner = backupBanner();
  app.replaceChildren(...(banner ? [banner] : []), body);
  const r = t.render(body, sub);
  refresh = typeof r === 'function' ? r : () => t.render(body, sub);
  if (current !== key) window.scrollTo(0, 0);
  current = key;
}

let rafPending = false;
db.subscribe(() => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!db.count('people')) return draw();
    if (refresh) { const y = window.scrollY; refresh(); window.scrollTo(0, y); }
  });
});

window.addEventListener('hashchange', draw);
window.addEventListener('online', () => { document.body.classList.remove('offline'); FX.refreshRates().catch(() => {}); });
window.addEventListener('offline', () => document.body.classList.add('offline'));

async function start() {
  await db.open();
  document.getElementById('fab').addEventListener('click', () => openTxForm(null));
  if (!navigator.onLine) document.body.classList.add('offline');
  draw();
  FX.refreshRates().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
start().catch((e) => { app.replaceChildren(h('pre', { class: 'pre' }, 'Error al iniciar: ' + (e && e.message))); console.error(e); });

// Service worker: la app completa queda guardada para funcionar sin conexión.
// Solo se guardan los archivos de la lista SHELL (nunca datos).
//
// Actualizaciones atómicas: cada versión se descarga completa al instalarse (saltándose la caché del
// CDN con ?v=VERSION) y se sirve solo desde su propia caché. Nunca se mezclan archivos de dos versiones.
// Sube VERSION cada vez que publiques cambios.
const VERSION = 'moni-v9';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/main.js', './js/db.js', './js/model.js', './js/fx.js', './js/prices.js', './js/ui.js', './js/charts.js',
  './js/views/home.js', './js/views/txs.js', './js/views/add.js', './js/views/close.js',
  './js/views/invest.js', './js/views/debts.js', './js/views/settings.js', './js/views/reports.js', './js/views/account.js', './js/views/points.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-180.png',
];
const scope = self.registration.scope;
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, scope).href));

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map(async (p) => {
      const url = new URL(p, scope);
      const fresh = new URL(url); fresh.searchParams.set('v', VERSION);
      const res = await fetch(fresh, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${p}: ${res.status}`);   // si falta un archivo, la versión nueva no se instala
      await cache.put(url.href, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  url.search = ''; url.hash = '';
  const isNav = req.mode === 'navigate' && url.href.startsWith(scope);
  if (!SHELL_URLS.has(url.href) && !isNav) return;     // tipo de cambio y otros: directo a la red
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(isNav ? new URL('./index.html', scope).href : url.href);
    if (hit) return hit;
    try { return await fetch(req); } catch { return Response.error(); }
  })());
});

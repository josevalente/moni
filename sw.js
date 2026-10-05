// Service worker: la app completa queda guardada para funcionar sin conexión.
// Solo se guardan los archivos de la lista SHELL (nunca datos). Sube VERSION cuando cambies
// archivos para que los teléfonos descarguen la versión nueva.
const VERSION = 'moni-v3';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/main.js', './js/db.js', './js/model.js', './js/fx.js', './js/ui.js',
  './js/views/home.js', './js/views/txs.js', './js/views/add.js', './js/views/close.js',
  './js/views/invest.js', './js/views/debts.js', './js/views/settings.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-180.png',
];
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).href));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Archivos de la app: primero caché y se refresca en segundo plano (la próxima apertura usa la versión nueva).
// Todo lo demás (tipos de cambio, otros orígenes) va directo a la red.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  url.search = ''; url.hash = '';
  if (!SHELL_URLS.has(url.href) && !(req.mode === 'navigate' && url.origin === location.origin && url.href.startsWith(self.registration.scope))) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(url.href);
      const net = fetch(req).then((res) => { if (res && res.ok && SHELL_URLS.has(url.href)) cache.put(url.href, res.clone()); return res; }).catch(() => null);
      if (hit) { net.catch(() => {}); return hit; }
      return (await net) || (await cache.match(new URL('./index.html', self.registration.scope).href)) || Response.error();
    }),
  );
});

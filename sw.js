// Service worker: guarda la app para que funcione sin conexión.
// Sirve desde la caché al instante y, en segundo plano, descarga la versión nueva para la próxima vez.
// Cambia CACHE en cada publicación: así el móvil detecta la versión nueva y la app se recarga sola.
const CACHE = 'holgura-v3.5';
const FILES = [
  './', 'index.html', 'conectado.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/calc.js', 'js/store.js', 'js/bank.js', 'js/categories.js', 'js/conectado.js',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' evita coger copias antiguas de la caché del navegador
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});

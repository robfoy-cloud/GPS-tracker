// Fieldline service worker: keeps the app itself and map sprites available offline.
// Map tiles and fonts are cached by app.js in 'fieldline-tiles-v1'.
const SHELL = 'fieldline-shell-v4';
const RUNTIME = 'fieldline-runtime-v1';
const FILES = [
  './', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('fieldline-shell-') && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App files: use the network when it answers within 3 s so updates show at once; otherwise the saved copy.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const net = fetch(req, { cache: 'no-cache' }).then(r => { if (r.ok) cache.put(key, r.clone()); return r; }).catch(() => null);
      const timeout = new Promise(res => setTimeout(() => res(null), 3000));
      const fresh = await Promise.race([net, timeout]);
      if (fresh && fresh.ok) return fresh;
      const hit = await cache.match(key, { ignoreSearch: true });
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // Map icon sprites (tiles and fonts are cached by app.js): cache first.
  if (url.hostname === 'tiles.openfreemap.org' && url.pathname.startsWith('/sprites/')) {
    e.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const hit = await cache.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok) cache.put(req, r.clone()); return r; }
      catch (err) { return new Response('', { status: 504 }); }
    })());
  }
});

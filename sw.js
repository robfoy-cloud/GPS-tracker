// Flightroute service worker.
// The app's own files are stored as one complete set per version and always served from that set,
// so the page and its code can never come from different versions. A new version downloads in full
// in the background and waits; the app shows an Update button, and tapping it switches to the new
// version and reloads. Bump VERSION whenever any file in FILES changes.
// Map tiles and fonts are stored separately by app.js ('fieldline-tiles-v1') and are not touched here.
const VERSION = 31;
const SHELL = 'fieldline-shell-v' + VERSION;
const RUNTIME = 'fieldline-runtime-v1';
const FILES = [
  './', 'app.js', 'app.css', 'config.js', 'manifest.webmanifest', 'airports.json',
  'vendor/supabase.js',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'screenshots/map.jpg', 'screenshots/plan.jpg', 'screenshots/flight.jpg'
];

// Hosts such as Cloudflare redirect /index.html to /. A response that went through a redirect must not
// be served for a page load (Safari then shows nothing), so store a fresh copy without the redirect.
async function clean(r){
  if (!r.redirected) return r;
  return new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers });
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // cache: 'reload' skips the browser's HTTP cache so every file is this version's copy
    await Promise.all(FILES.map(async f => {
      const r = await fetch(f, { cache: 'reload' });
      if (!r.ok) throw new Error(f + ' ' + r.status);
      await cache.put(f, await clean(r));
    }));
    // Versions before 26 had no Update button and can't ask this one to take over, so switch straight away
    // from those. From 26 on, the new version waits until the person taps Update.
    const old = (await caches.keys()).map(k => +(k.match(/^fieldline-shell-v(\d+)$/) || [])[1]).filter(Boolean);
    if (old.length && Math.max(...old.filter(v => v !== VERSION), 0) < 26 && old.some(v => v !== VERSION)) await self.skipWaiting();
  })());
});

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d.type === 'GET_VERSION' && e.ports && e.ports[0]) e.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('fieldline-shell-') && k !== SHELL).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    const scope = new URL(self.registration.scope).pathname;
    const rel = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : url.pathname.replace(/^\//, '');
    if (rel === 'sw.js') return;                       // the browser checks this against the server itself
    const key = req.mode === 'navigate' || rel === '' || rel === 'index.html' ? './' : rel;
    e.respondWith((async () => {
      const hit = await (await caches.open(SHELL)).match(key);
      if (hit && !hit.redirected) return hit;
      try { return await clean(await fetch(req)); }
      catch (err) { return hit ? clean(hit) : new Response('Offline', { status: 503 }); }
    })());
    return;
  }

  // Map icon sprites: from any Flightroute cache, else the network.
  if (url.hostname === 'tiles.openfreemap.org' && url.pathname.startsWith('/sprites/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok) (await caches.open(RUNTIME)).put(req, r.clone()); return r; }
      catch (err) { return new Response('', { status: 504 }); }
    })());
  }
});

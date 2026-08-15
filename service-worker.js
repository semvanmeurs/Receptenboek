const CACHE_VERSION = 'recepten-v4';
const FILES = ['./', 'index.html', 'app.js', 'recipes.json', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

// Network-first voor de app-shell (html/js/json): altijd de nieuwste versie proberen te halen,
// val alleen terug op de cache als er geen internet is.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  const isAppShell = u.pathname.endsWith('/') || u.pathname.endsWith('index.html') || u.pathname.endsWith('app.js') || u.pathname.endsWith('recipes.json');

  if (isAppShell) {
    e.respondWith(
      fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE_VERSION).then(c => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Icons/manifest: cache-first is prima, die veranderen zelden.
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(resp => { const copy = resp.clone(); caches.open(CACHE_VERSION).then(c => c.put(e.request, copy)); return resp; })));
});

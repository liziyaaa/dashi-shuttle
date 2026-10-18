const CACHE = 'dashi-shuttle-v1.1.0';
const ASSETS = ['./', './index.html', './styles.css?v=1.1', './app.js?v=1.1', './core.js', './sync.js', './manifest.webmanifest?v=1.1', './icons/logo.svg?v=1.1', './icons/icon-192.png?v=1.1', './icons/icon-512.png?v=1.1', './icons/maskable-512.png?v=1.1', './icons/apple-touch-icon.png?v=1.1'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('dashi-shuttle-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (!ASSETS.some(asset => new URL(asset, self.registration.scope).pathname === url.pathname)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => { if (!response.ok) throw new Error('Navigation failed'); return response; }).catch(() => caches.match(new URL('./', self.registration.scope))));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});

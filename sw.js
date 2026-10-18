const VERSION = '1.3.2';
const CACHE = `dashi-shuttle-v${VERSION}`;
const ASSETS = ['./', './index.html', `./styles.css?v=${VERSION}`, `./app.js?v=${VERSION}`, `./core.js?v=${VERSION}`, `./sync.js?v=${VERSION}`, `./ui.js?v=${VERSION}`, `./scheduler.js?v=${VERSION}`, `./updates.js?v=${VERSION}`, `./manifest.webmanifest?v=${VERSION}`, `./icons/icon-192.png?v=${VERSION}`, `./icons/icon-512.png?v=${VERSION}`, `./icons/maskable-512.png?v=${VERSION}`, `./icons/apple-touch-icon.png?v=${VERSION}`];
// A new release waits for the user; installation never interrupts data entry.
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(ASSETS.map(asset => cache.add(new Request(asset, { cache: 'reload' }))))));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'GET_VERSION') event.ports?.[0]?.postMessage({ version: VERSION });
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('dashi-shuttle-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  // version.json and sw.js always reach the network. Never cache version checks.
  if (!ASSETS.some(asset => new URL(asset, self.registration.scope).pathname === url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Keep HTML and JS on the same installed release until the user accepts.
    const cached = await cache.match(event.request.mode === 'navigate' ? new URL('./', self.registration.scope) : event.request);
    return cached || fetch(event.request);
  })());
});

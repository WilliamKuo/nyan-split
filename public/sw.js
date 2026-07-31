const CACHE_NAME = 'nyan-split-v1.4.1';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './firebase-config.js',
  './i18n.js',
  './style.css',
  './manifest.json',
  './VERSION',
  './favicon.svg',
  './assets/nyan-cat-loading.gif',
  './vendor/dijkstrajs.mjs',
  './vendor/jszip.mjs',
  './vendor/qrcode.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).then(async (response) => {
      if (response.ok) {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
        } catch {
          // Ignore cache put errors to ensure response is returned
        }
      }
      return response;
    }).catch(async () => (
      await caches.match(event.request)
      || (event.request.mode === 'navigate' ? caches.match('./index.html') : undefined)
      || new Response('Offline', { status: 503 })
    )),
  );
});

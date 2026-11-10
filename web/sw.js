// Offline cache for Scrubgnome-File. Caches only the app's own files;
// your files are never fetched or stored (they're read locally from the picked files).
const VERSION = 'sgfile-v1';
const FILES = ['./', 'index.html', 'js/app.js', 'js/face.js', 'js/file.js', 'js/zip.js', 'js/mp4.js', 'manifest.webmanifest',
  'icons/twig.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});

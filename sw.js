// Höj versionen när filerna ändras så att telefonerna hämtar den nya versionen.
const CACHE = 'stampelklocka-v1';
const FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'vendor/qrcode.js',
  'vendor/jsQR.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Svara direkt från cachen (snabbt även med dålig täckning på jobbet) och hämta
// en ny version i bakgrunden som används nästa gång appen öppnas.
// ignoreSearch gör att QR-länkar som ./?stamp=in hittar den cachade sidan.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  url.search = '';
  const key = url.toString();

  const network = fetch(event.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy));
    }
    return res;
  });

  event.respondWith(
    caches.match(key).then((cached) => cached || network)
  );
  event.waitUntil(network.then(() => {}, () => {}));
});

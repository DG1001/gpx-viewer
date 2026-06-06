// Service Worker – App-Shell-Precache + Runtime-Caches für Leaflet-CDN und OSM-Tiles.
const VERSION = 'v11';
const SHELL_CACHE = `gpxv-shell-${VERSION}`;
const CDN_CACHE = `gpxv-cdn-${VERSION}`;
const TILE_CACHE = `gpxv-tiles-${VERSION}`;
// Versionslos: hält per „Teilen mit…“ empfangene Dateien bis die App sie abholt.
const SHARE_CACHE = 'gpxv-share';

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './map3d.js',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => ![SHELL_CACHE, CDN_CACHE, TILE_CACHE, SHARE_CACHE].includes(k)).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      // Eine opaque Antwort darf NUR an no-cors-Anfragen zurückgegeben werden,
      // sonst wirft der Browser einen Netzwerkfehler.
      const cachedUsable = cached && (request.mode === 'no-cors' || cached.type !== 'opaque') ? cached : null;
      const network = fetch(request)
        .then((resp) => {
          if (resp && (resp.ok || resp.type === 'opaque')) cache.put(request, resp.clone());
          return resp;
        })
        .catch(() => cachedUsable);
      return cachedUsable || network;
    })
  );
}

// Web Share Target: empfängt per „Teilen mit…“ geschickte Dateien, legt sie im
// SHARE_CACHE ab und leitet zur App weiter (die holt sie beim Start ab).
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files').filter((f) => f && typeof f.name === 'string' && f.name);
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    let i = 0;
    for (const file of files) {
      const headers = new Headers({
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
      });
      await cache.put(`./__shared__/${i++}`, new Response(file, { headers }));
    }
  } catch (err) {
    // Ignorieren – die App startet auch ohne Datei.
  }
  return Response.redirect('./?share-target=1', 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(req));
    return;
  }

  if (req.method !== 'GET') return;

  // Karten-Kacheln: OSM, OpenTopoMap, Esri-Satellit, AWS-Terrain (3D-DEM)
  if (/(^|\.)tile\.openstreetmap\.org$/.test(url.hostname) ||
      url.hostname.endsWith('tile.opentopomap.org') ||
      url.hostname === 'server.arcgisonline.com' ||
      (url.hostname === 's3.amazonaws.com' && url.pathname.startsWith('/elevation-tiles-prod'))) {
    event.respondWith(staleWhileRevalidate(req, TILE_CACHE));
    return;
  }

  // Leaflet-CDN (unpkg)
  if (url.hostname === 'unpkg.com') {
    event.respondWith(staleWhileRevalidate(req, CDN_CACHE));
    return;
  }

  // App-Shell (same-origin): cache-first mit Netz-Fallback, Navigationsanfragen -> index.html
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(
        fetch(req).catch(() => caches.match('./index.html'))
      );
      return;
    }
    event.respondWith(
      caches.match(req).then((cached) => cached || staleWhileRevalidate(req, SHELL_CACHE))
    );
  }
});

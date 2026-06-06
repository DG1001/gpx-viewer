// Service Worker – App-Shell-Precache + Runtime-Caches für Leaflet-CDN und OSM-Tiles.
const VERSION = 'v7';
const SHELL_CACHE = `gpxv-shell-${VERSION}`;
const CDN_CACHE = `gpxv-cdn-${VERSION}`;
const TILE_CACHE = `gpxv-tiles-${VERSION}`;

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
        keys.filter((k) => ![SHELL_CACHE, CDN_CACHE, TILE_CACHE].includes(k)).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && (resp.ok || resp.type === 'opaque')) cache.put(request, resp.clone());
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

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

/**
 * service-worker.js
 * Stratégie "cache d'app shell" : les fichiers statiques de l'application
 * (HTML/CSS/JS/icônes) sont mis en cache pour permettre l'installation PWA
 * et un chargement instantané hors connexion. Les appels réseau dynamiques
 * (Nominatim, OpenRouteService, tuiles de carte, météo) restent en ligne
 * uniquement : les mettre en cache indistinctement dégraderait la fraîcheur
 * des itinéraires et dépasserait vite les quotas de stockage sur mobile.
 */

const CACHE_NAME = 'roadplanner-bis-shell-v18';

const APP_SHELL = [
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/mobile.css',
  './css/desktop.css',
  './js/utils.js',
  './js/map.js',
  './js/geocoder.js',
  './js/profiles.js',
  './js/routing.js',
  './js/loops.js',
  './js/poi.js',
  './js/gpx.js',
  './js/weather.js',
  './js/ui.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Uniquement l'app shell de même origine : cache-first avec repli réseau.
  // Tout le reste (tuiles OSM, Nominatim, ORS, Open-Meteo, polices) part
  // directement au réseau, sans interception, pour rester à jour.
  if (!isSameOrigin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

const CACHE_VERSION = 'v1.0.0';
const PRECACHE = `precache-${CACHE_VERSION}`;
const RUNTIME = `runtime-${CACHE_VERSION}`;
const PRECACHE_URLS = [
  './html.تحدى المليون الذهبي .html',
  './questions.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== PRECACHE && key !== RUNTIME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Documents: network-first
  if (url.origin === self.location.origin && url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(request, PRECACHE));
    return;
  }

  // Questions JSON: stale-while-revalidate
  if (url.origin === self.location.origin && url.pathname.endsWith('questions.json')) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME));
    return;
  }

  // Media and fonts: cache-first (works with opaque responses too)
  if (request.destination === 'audio' || request.destination === 'font' || request.destination === 'image') {
    event.respondWith(cacheFirst(request, RUNTIME));
    return;
  }

  // Default: network-first with cache fallback
  event.respondWith(networkFirst(request, RUNTIME));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (e) {
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ? cached : fetchPromise;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = await cache.match(request, { ignoreVary: true });
    return cached || Response.error();
  }
}

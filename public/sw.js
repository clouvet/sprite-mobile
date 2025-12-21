// Service Worker for Sprite Code PWA
// Caches shell for offline-first loading and stores public URL for sprite wake-up

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const CONFIG_CACHE = `config-${CACHE_VERSION}`;

// Files to cache for the app shell
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// CDN resources to cache
const CDN_FILES = [
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js',
];

// Install: cache shell files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      // Cache shell files - don't fail install if some fail
      return Promise.allSettled([
        ...SHELL_FILES.map(url => cache.add(url).catch(() => console.log(`Failed to cache ${url}`))),
        ...CDN_FILES.map(url => cache.add(url).catch(() => console.log(`Failed to cache CDN ${url}`))),
      ]);
    }).then(() => {
      // Activate immediately
      return self.skipWaiting();
    })
  );
});

// Activate: clean old caches and take control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== SHELL_CACHE && key !== CONFIG_CACHE)
          .map(key => caches.delete(key))
      );
    }).then(() => {
      // Take control of all clients immediately
      return self.clients.claim();
    })
  );
});

// Fetch handler with different strategies per resource type
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Navigation requests: serve cached shell immediately
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then((cached) => {
        // Return cached shell, or fetch if not cached
        return cached || fetch(event.request);
      })
    );
    return;
  }

  // /api/config: network-first, cache the result for offline wake-up
  if (url.pathname === '/api/config') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Clone and cache the response
          const clone = response.clone();
          caches.open(CONFIG_CACHE).then((cache) => {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(() => {
          // Network failed, try cache
          return caches.match(event.request);
        })
    );
    return;
  }

  // Other API calls: network-only (need live sprite)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Static assets and CDN: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful responses for static files
        if (response.ok && (url.origin === self.location.origin || url.hostname.includes('cdnjs'))) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    })
  );
});

// Message handler for cache operations from the main app
self.addEventListener('message', (event) => {
  if (event.data.type === 'CACHE_CONFIG') {
    // Store config data directly
    caches.open(CONFIG_CACHE).then((cache) => {
      const response = new Response(JSON.stringify(event.data.config), {
        headers: { 'Content-Type': 'application/json' }
      });
      cache.put('/api/config', response);
    });
  }

  if (event.data.type === 'GET_CACHED_CONFIG') {
    // Return cached config to the requesting client
    caches.open(CONFIG_CACHE).then((cache) => {
      cache.match('/api/config').then((response) => {
        if (response) {
          response.json().then((config) => {
            event.source.postMessage({ type: 'CACHED_CONFIG', config });
          });
        } else {
          event.source.postMessage({ type: 'CACHED_CONFIG', config: null });
        }
      });
    });
  }
});

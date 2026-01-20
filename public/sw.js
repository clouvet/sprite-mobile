// Service Worker for Sprite Mobile PWA
// Caches shell for offline-first loading and stores public URL for sprite wake-up

const CACHE_VERSION = 'v38';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const CONFIG_CACHE = `config-${CACHE_VERSION}`;

// Files to cache for the app shell
const SHELL_FILES = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
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
    caches.open(SHELL_CACHE).then(async (cache) => {
      // Cache shell files sequentially to ensure they complete
      for (const url of SHELL_FILES) {
        try {
          await cache.add(url);
          console.log(`Cached: ${url}`);
        } catch (err) {
          console.log(`Failed to cache ${url}:`, err);
        }
      }
      // CDN files in parallel (less critical)
      await Promise.allSettled(
        CDN_FILES.map(url => cache.add(url).catch(() => console.log(`Failed to cache CDN ${url}`)))
      );
    }).then(() => {
      console.log('Shell cached, activating immediately');
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

// Minimal offline fallback page - tries to wake sprite and reload
const OFFLINE_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sprite Mobile - Offline</title>
<style>
  body{margin:0;background:#1a1a2e;color:#e5e5e5;font-family:-apple-system,sans-serif;
  display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;padding:20px;box-sizing:border-box}
  .spinner{width:40px;height:40px;border:3px solid #333347;border-top-color:#d4a574;
  border-radius:50%;animation:spin 1s linear infinite;margin-bottom:16px}
  @keyframes spin{to{transform:rotate(360deg)}}
  #status{margin-bottom:8px;font-size:18px}
  #substatus{color:#888;font-size:14px;margin-bottom:12px}
  #log{color:#666;font-size:12px;font-family:monospace;max-height:150px;overflow-y:auto;text-align:left;width:100%;max-width:300px}
  .log-entry{margin:4px 0}
  button{margin-top:20px;padding:12px 24px;background:#d4a574;border:none;border-radius:8px;
  color:#1a1a2e;font-size:16px;cursor:pointer}
</style>
</head><body>
<div class="spinner"></div>
<div id="status">Waking sprite...</div>
<div id="substatus">This may take a moment</div>
<div id="log"></div>
<button onclick="location.reload()">Retry Now</button>
<script>
(async function(){
  const status = document.getElementById('status');
  const substatus = document.getElementById('substatus');
  const log = document.getElementById('log');

  function addLog(msg) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = new Date().toLocaleTimeString() + ': ' + msg;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
  }

  addLog('Offline page loaded');
  addLog('SW controller: ' + (navigator.serviceWorker?.controller ? 'yes' : 'no'));

  // Try to get cached config from service worker
  if(navigator.serviceWorker&&navigator.serviceWorker.controller){
    addLog('Requesting cached config...');
    navigator.serviceWorker.controller.postMessage({type:'GET_CACHED_CONFIG'});
    navigator.serviceWorker.addEventListener('message',async(e)=>{
      addLog('SW message: ' + e.data?.type);
      if(e.data?.type==='CACHED_CONFIG'){
        if(e.data.config?.publicUrl){
          const url = e.data.config.publicUrl;
          addLog('Got publicUrl: ' + url);
          substatus.textContent='Pinging ' + url;
          try{
            await fetch(url,{mode:'no-cors',cache:'no-store'});
            addLog('Ping sent');
          }catch(err){
            addLog('Ping error: ' + err.message);
          }
          // Wait a bit then try reloading
          for(let i=5;i>0;i--){
            substatus.textContent='Retrying in '+i+'s...';
            addLog('Retry in ' + i + 's');
            await new Promise(r=>setTimeout(r,1000));
          }
          addLog('Reloading...');
          location.reload();
        } else {
          addLog('No publicUrl in config');
          substatus.textContent='No wake URL cached';
        }
      }
    });
  } else {
    addLog('No SW controller - cannot wake');
    substatus.textContent='Service worker not active';
  }
  // Fallback: just wait and retry
  setTimeout(()=>{
    addLog('Fallback reload');
    location.reload();
  },15000);
})();
</script>
</body></html>`;

// Fetch handler with different strategies per resource type
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Navigation requests: serve cached shell, or offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then((cached) => {
        if (cached) return cached;
        // Try network, fall back to minimal offline page
        return fetch(event.request).catch(() => {
          return new Response(OFFLINE_HTML, {
            headers: { 'Content-Type': 'text/html' }
          });
        });
      })
    );
    return;
  }

  // /api/config: network-only for wake detection, cache via message handler
  // Don't fall back to cache here - we need to know if sprite is actually awake
  if (url.pathname === '/api/config') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Clone and cache under canonical path (no query string) for offline page
          const clone = response.clone();
          caches.open(CONFIG_CACHE).then((cache) => {
            cache.put('/api/config', clone);
          });
          return response;
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

  if (event.data.type === 'REFRESH_CACHE') {
    // Re-cache shell files - called when page loads successfully
    caches.open(SHELL_CACHE).then(async (cache) => {
      for (const url of SHELL_FILES) {
        try {
          const response = await fetch(url, { cache: 'reload' });
          if (response.ok) {
            await cache.put(url, response);
            console.log(`Refreshed cache: ${url}`);
          }
        } catch (err) {
          console.log(`Failed to refresh ${url}:`, err);
        }
      }
      // Also refresh CDN files
      for (const url of CDN_FILES) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            await cache.put(url, response);
          }
        } catch (err) {}
      }
      event.source?.postMessage({ type: 'CACHE_REFRESHED' });
    });
  }
});

const CACHE_NAME = 'songbinder-manager-v11';
const ABSOLUTE_URL = /^https?:\/\//i;
const BASE_PATH = (() => {
  try {
    const scope = self.registration?.scope || self.location.href;
    const origin = self.location.origin;
    if (scope.startsWith(origin)) {
      const suffix = scope.slice(origin.length);
      return suffix.endsWith('/') ? suffix.slice(0, -1) : suffix;
    }
  } catch {}
  return '';
})();
const normalizePath = (path = '/') => {
  if (!path) return '/';
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized === '//' ? '/' : normalized.replace(/\/{2,}/g, '/');
};
const scopePath = (path = '/') => {
  if (ABSOLUTE_URL.test(path)) return path;
  const normalized = normalizePath(path);
  if (!BASE_PATH) return normalized;
  if (normalized === '/') return `${BASE_PATH}/`;
  return `${BASE_PATH}${normalized}`.replace(/\/{2,}/g, '/');
};
const stripBasePath = (pathname) => {
  if (!BASE_PATH) return pathname;
  if (pathname.startsWith(BASE_PATH)) {
    const stripped = pathname.slice(BASE_PATH.length) || '/';
    return stripped.startsWith('/') ? stripped : `/${stripped}`;
  }
  return pathname || '/';
};
const rawCachePaths = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/manifest.json',
    '/performance/performance.html',
    '/performance/performance.js',
    '/performance/performance.css',
    '/assets/icons/icon-192x192.png',
    '/assets/icons/icon-512x512.png',
    '/assets/images/logo-dark.png',
    '/assets/images/logo-light.png',
    '/lib/mammoth.browser.min.js',
    '/lib/sortable.min.js',
    '/lib/fontawesome/css/all.min.css',
    '/lib/fontawesome/css/fa-local.css',
    '/lib/fontawesome/webfonts/fa-solid-900.woff2',
    '/lib/fontawesome/webfonts/fa-solid-900.ttf',
    '/lib/fontawesome/webfonts/fa-regular-400.woff2',
    '/lib/fontawesome/webfonts/fa-regular-400.ttf',
    '/lib/fontawesome/webfonts/fa-brands-400.woff2',
    '/lib/fontawesome/webfonts/fa-brands-400.ttf',
    '/lib/fontawesome/webfonts/fa-v4compatibility.ttf',
    '/assets/fonts/neonderthaw/neonderthaw.css',
    '/assets/fonts/neonderthaw/Neonderthaw.ttf',
    '/lib/idb.min.js',
    '/lib/tesseract/tesseract.min.js',
    '/lib/tesseract/worker.min.js',
    '/lib/tesseract/tesseract-core.wasm',
    '/lib/tesseract/tesseract-core-simd.wasm.js',
    '/lib/tesseract/tesseract-core-simd.wasm',
    // Do NOT precache traineddata to avoid decompression/caching pitfalls
    // Prefer local Fuse build to avoid CDN + redirect issues
    '/lib/fuse.js',
    // Editor assets
    // editor shell will be cached via custom fetch to avoid redirected entries
    '/editor/editor.html',
    '/editor/editor.js',
    '/editor/editor.css',
    '/editor/songs.js',
    '/editor/db.js'
];
const urlsToCache = rawCachePaths.map((path) => new Request(scopePath(path)));

const cacheKeyForPath = (path = '/') => new Request(scopePath(path));

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        try {
            const cache = await caches.open(CACHE_NAME);
            console.log('Opened cache');
            // Fetch each URL with redirect: 'follow' and store a non-redirected copy
            for (const request of urlsToCache) {
                try {
                    const res = await fetch(request, { redirect: 'follow' });
                    const clean = await (async (response) => {
                        try {
                            if (!response || !response.redirected) return response;
                            const body = await response.clone().blob();
                            return new Response(body, {
                                status: response.status,
                                statusText: response.statusText,
                                headers: response.headers
                            });
                        } catch (e) { return response; }
                    })(res);
                    if (clean && clean.ok) await cache.put(request, clean.clone());
                } catch (e) {
                    console.warn('Precaching failed for', request?.url || request, e);
                }
            }
        } catch (err) {
            console.warn('Cache warmup failed', err);
        }
        self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Cache-first strategy with network fallback.
// For navigation (HTML) requests, ignore query string so cached pages work with ?params.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // only cache GET
  // Bypass cross-origin requests entirely to avoid redirect mode issues
  try {
    const u = new URL(req.url);
    if (u.origin !== self.location.origin) return;
  } catch {}

  let waitUntilResolve;
  const waitUntilPromise = new Promise((resolve) => { waitUntilResolve = resolve; });
  event.waitUntil(waitUntilPromise);

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const putTasks = [];
    const queuePut = (key, response) => {
      try { putTasks.push(cache.put(key, response)); } catch {}
    };
    const stripRedirect = async (response) => {
      try {
        if (!response || !response.redirected) return response;
        const body = await response.clone().blob();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch (e) { return response; }
    };
    try {
      const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
      const urlObj = new URL(req.url);
      const relativePath = normalizePath(stripBasePath(urlObj.pathname) || '/');
      const isTrainedData = urlObj.pathname.endsWith('/lib/tesseract/eng.traineddata') || urlObj.pathname.endsWith('/lib/tesseract/eng.traineddata.gz');
      const assetKey = cacheKeyForPath(relativePath);

      // Prefer cached HTML shells ignoring search so /performance/performance.html?x matches
      if (!isTrainedData) {
        if (isHTML) {
          let shellPath = '/index.html';
          if (relativePath.startsWith('/editor/')) shellPath = '/editor/editor.html';
          else if (relativePath.startsWith('/performance/')) shellPath = '/performance/performance.html';
          const shellKey = cacheKeyForPath(shellPath);
          const cachedShell = await cache.match(shellKey);
          if (cachedShell) {
            waitUntilResolve(Promise.all(putTasks));
            return cachedShell;
          }
        } else {
          const cachedAsset = await cache.match(assetKey);
          if (cachedAsset) {
            waitUntilResolve(Promise.all(putTasks));
            return cachedAsset;
          }
        }
      }

      let res;
      if (isHTML) {
        let shellPath = '/index.html';
        if (relativePath.startsWith('/editor/')) shellPath = '/editor/editor.html';
        else if (relativePath.startsWith('/performance/')) shellPath = '/performance/performance.html';
        const shellKey = cacheKeyForPath(shellPath);
        res = await fetch(shellKey, { redirect: 'follow' });
        res = await stripRedirect(res);
        if (res && res.status === 200) queuePut(shellKey, res.clone());
      } else {
        if (isTrainedData) {
          // Always fetch traineddata fresh; do not cache or transform
          res = await fetch(req.url, { redirect: 'follow', cache: 'no-store' });
          res = await stripRedirect(res);
        } else {
          // Ensure we don't return a redirected response to the page
          res = await fetch(new Request(req.url, { redirect: 'follow' }));
          res = await stripRedirect(res);
        }
      }

      // Cache same-origin successful responses
      if (!isTrainedData && res && res.status === 200 && req.url.startsWith(self.location.origin)) {
        if (isHTML) {
          let shellPath = '/index.html';
          if (relativePath.startsWith('/editor/')) shellPath = '/editor/editor.html';
          else if (relativePath.startsWith('/performance/')) shellPath = '/performance/performance.html';
          queuePut(cacheKeyForPath(shellPath), res.clone());
        } else {
          queuePut(assetKey, res.clone());
        }
      }
      waitUntilResolve(Promise.all(putTasks));
      return res;
    } catch (err) {
      waitUntilResolve(Promise.all(putTasks));
      // Offline fallback for navigations
      const fallback = await cache.match(cacheKeyForPath('/index.html'));
      if (fallback) return fallback;
      throw err;
    }
  })());
});

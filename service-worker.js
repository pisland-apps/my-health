// My Health - Service Worker
// ------------------------------------------------------------------
// Provides offline support: after the first successful load, the entire
// app (HTML/CSS/JS, manifest, icons, the JSZip library used by
// "Pack ZIP", and the pdf.js library used to preview PDF attachments)
// keeps working with no network connection at all.
//
// All actual health data lives in localStorage/IndexedDB on the
// user's own device - this worker only caches the STATIC APP FILES needed
// to run the app; it never touches or transmits user data anywhere.
//
// IMPORTANT: bump CACHE_VERSION any time you change index.html (or any
// other app-shell file) and redeploy, so returning visitors get the new
// version instead of a stale cached copy.
//
// NOTE: this is a separate number from APP_VERSION/APP_VERSION_DATE at the
// top of app.js (the display label shown in the version badge). They don't
// sync automatically since they live in different files - bump both on
// every deploy. CACHE_VERSION controls what the Service Worker actually
// serves; APP_VERSION only controls what the badge displays. If the badge
// ever shows a version that doesn't match what you expect after deploying,
// that's the signal to hard-refresh (Ctrl/Cmd+Shift+R) or clear the site's
// Service Worker/cache in devtools - not a sign the deploy failed.
const CACHE_VERSION = 'v56';
const CACHE_NAME = `my-health-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './app.js',
  './merge-engine.js',
  './styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './lib/jszip.min.js',
  // v50: pdf.js lives in a version-named folder (PDFJS_DIR in app.js) so the
  // main file, the worker and the decoders can only ever come from the same
  // release. Keep these lines and PDFJS_DIR in step when pdf.js is updated.
  './lib/pdfjs-6.4.299/pdf.min.mjs',
  './lib/pdfjs-6.4.299/pdf.worker.min.mjs',
  // Image decoders for scanner PDFs. The .wasm files are the normal path; the
  // *_nowasm_fallback.js are what pdf.js loads instead when the CSP does not
  // allow compiling WebAssembly (it does not here) - both must work offline.
  './lib/pdfjs-6.4.299/wasm/jbig2.wasm',
  './lib/pdfjs-6.4.299/wasm/openjpeg.wasm',
  './lib/pdfjs-6.4.299/wasm/qcms_bg.wasm',
  './lib/pdfjs-6.4.299/wasm/jbig2_nowasm_fallback.js',
  './lib/pdfjs-6.4.299/wasm/openjpeg_nowasm_fallback.js'
];
// './index.html' is deliberately NOT in this list. Cloudflare Pages
// redirects /index.html -> / by default (documented behavior for its
// static hosting; GitHub Pages doesn't do this), so fetching that URL here
// would silently follow the redirect and cache a Response with
// redirected: true under the './index.html' key. Chrome enforces a spec
// rule that a Service Worker cannot answer a *navigation* with a
// redirected Response - it fails the whole load with net::ERR_FAILED. That
// poisoned cache entry is exactly what used to make the installed desktop
// shortcut (whose old start_url was "./index.html" - see manifest.json)
// fail to (re)launch every single time. Every navigation now resolves
// through the single canonical './' entry instead - see the dedicated
// 'navigate' branch in the fetch handler below.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each file independently so one failure on first install
      // doesn't abort caching the rest. All app-shell files (including
      // lib/jszip.min.js) are same-origin now, so responses are always
      // inspectable ('basic', not 'opaque').
      await Promise.all(APP_SHELL.map(async (url) => {
        try {
          const req = new Request(url, { cache: 'reload' });
          const res = await fetch(req);
          // Never cache a redirected response under a static app-shell key -
          // same reasoning as leaving './index.html' out of APP_SHELL above.
          // Belt-and-suspenders in case any future entry here turns out to
          // redirect on some host.
          if (res && res.ok && !res.redirected) {
            await cache.put(url, res);
          }
        } catch (err) {
          console.warn('[SW] Could not pre-cache', url, err);
        }
      }));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith('my-health-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Cache-first for everything (works fully offline, and avoids re-fetching
// the app shell on every load); falls back to network for anything not yet
// cached, and finally falls back to the cached app shell for navigations
// so the app still opens even with zero connectivity.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Navigation requests (actual page loads - including the installed
  // shortcut's start_url, a bookmark, a manually typed /index.html, etc.)
  // are handled separately from everything else and ALWAYS resolve through
  // the single canonical './' entry, regardless of which exact URL was
  // requested. This is what actually fixes the redirect trap described
  // above: even a still-installed OLD shortcut whose start_url is the
  // legacy "./index.html" (people who installed the app before this fix
  // won't get the new manifest.json applied to their existing shortcut
  // just from this deploy - only a fresh install picks it up) lands here
  // and gets served './' instead of ever touching the URL Cloudflare
  // redirects.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('./').then((cached) => {
        if (cached) return cached;
        return fetch('./', { cache: 'reload' })
          .then((res) => {
            if (res && res.ok && !res.redirected) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put('./', clone));
            }
            return res;
          })
          .catch(() => new Response(
            'You are offline and the app has not finished caching yet. Please connect to the internet once, then reopen the app.',
            { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' } }
          ));
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          // Opportunistically cache same-origin GETs we haven't seen yet.
          // !res.redirected guard: same reasoning as the install step above.
          if (res && res.ok && !res.redirected && event.request.url.startsWith(self.location.origin)) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => new Response('Offline and not cached.', { status: 503, statusText: 'Offline' }));
    })
  );
});

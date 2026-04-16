// Build script writes the version (md5 of app.js+style.css+index.html) into
// sw-version.js so the cache key invalidates automatically on each release.
try { importScripts("./sw-version.js"); } catch (e) { /* dev fallback below */ }
var VERSION = (typeof SW_VERSION === "string" && SW_VERSION) ? SW_VERSION : "dev";

var APP_CACHE  = "legwork-app-"  + VERSION;   // app shell — versioned, fully replaced on release
var TILE_CACHE = "legwork-tile-v1";           // map raster tiles — long-lived, LRU-trimmed
var API_CACHE  = "legwork-api-v1";            // network-first API responses

var TILE_MAX_ENTRIES = 600;   // ~50–100MB of map tiles
var API_MAX_ENTRIES  = 200;

var APP_SHELL = [
    "./",
    "./index.html",
    "./app.js",
    "./js/cache.js",
    "./js/state.js",
    "./js/helpers.js",
    "./js/router.js",
    "./js/map.js",
    "./js/paths.js",
    "./js/elevation.js",
    "./js/route.js",
    "./js/saved.js",
    "./js/ui.js",
    "./style.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://cdn.jsdelivr.net/npm/chart.js@4",
    "https://cdn.jsdelivr.net/npm/leaflet-hotline@0.4.0/dist/leaflet.hotline.min.js",
];

var TILE_PATTERNS = [
    "tile.openstreetmap.org",
    "server.arcgisonline.com",
    "tile.opentopomap.org",
];

self.addEventListener("install", function (e) {
    e.waitUntil(
        caches.open(APP_CACHE)
            .then(function (cache) { return cache.addAll(APP_SHELL); })
            .then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener("activate", function (e) {
    // Drop only old *app* caches — long-lived tile/API caches survive across releases.
    e.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names
                    .filter(function (n) { return n.indexOf("legwork-app-") === 0 && n !== APP_CACHE; })
                    .map(function (n) { return caches.delete(n); })
            );
        }).then(function () { return self.clients.claim(); })
    );
});

// FIFO trim by cache-insertion order — the Cache API doesn't expose access
// time. Debounced because it enumerates the entire cache; on a fresh map pan
// hundreds of tile puts would otherwise trigger hundreds of full scans.
var _trimTimers = {};
function scheduleTrim(cacheName, maxEntries) {
    if (_trimTimers[cacheName]) return;
    _trimTimers[cacheName] = setTimeout(function () {
        _trimTimers[cacheName] = null;
        caches.open(cacheName).then(function (cache) {
            return cache.keys().then(function (keys) {
                if (keys.length <= maxEntries) return;
                var excess = keys.length - maxEntries;
                return Promise.all(keys.slice(0, excess).map(function (k) { return cache.delete(k); }));
            });
        });
    }, 5000);
}

self.addEventListener("fetch", function (e) {
    var url = e.request.url;

    // App shell: cache-first with background refresh
    if (e.request.mode === "navigate" || APP_SHELL.some(function (u) { return url.indexOf(u) !== -1; })) {
        e.respondWith(
            caches.open(APP_CACHE).then(function (cache) {
                return cache.match(e.request).then(function (cached) {
                    var fetchPromise = fetch(e.request).then(function (resp) {
                        if (resp && resp.ok) cache.put(e.request, resp.clone());
                        return resp;
                    }).catch(function () { return cached; });
                    return cached || fetchPromise;
                });
            })
        );
        return;
    }

    // Map tiles: stale-while-revalidate, capped at TILE_MAX_ENTRIES
    if (TILE_PATTERNS.some(function (p) { return url.indexOf(p) !== -1; })) {
        e.respondWith(
            caches.open(TILE_CACHE).then(function (cache) {
                return cache.match(e.request).then(function (cached) {
                    var fetchPromise = fetch(e.request).then(function (resp) {
                        if (resp && resp.ok) {
                            cache.put(e.request, resp.clone());
                            // Trim opportunistically — don't block the response.
                            scheduleTrim(TILE_CACHE, TILE_MAX_ENTRIES);
                        }
                        return resp;
                    }).catch(function () { return cached; });
                    return cached || fetchPromise;
                });
            })
        );
        return;
    }

    // API calls (Overpass, Photon, Open-Meteo): network-first, cache fallback,
    // capped at API_MAX_ENTRIES.
    e.respondWith(
        fetch(e.request).then(function (resp) {
            if (resp && resp.ok && e.request.method === "GET") {
                var clone = resp.clone();
                caches.open(API_CACHE).then(function (c) {
                    c.put(e.request, clone);
                    scheduleTrim(API_CACHE, API_MAX_ENTRIES);
                });
            }
            return resp;
        }).catch(function () {
            return caches.match(e.request);
        })
    );
});

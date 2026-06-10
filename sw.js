// CACHE_NAME is auto-bumped by .github/workflows/bump-sw.yml on push to main.
// It versions the APP SHELL cache only — bumping it evicts stale HTML/JS/CSS.
var CACHE_NAME = "legwork-9b180a5e";

// Map/path tiles live in a SEPARATE, stable cache that survives shell bumps, so a
// code push doesn't throw away the user's accumulated offline map data. Capped so
// it can't grow without bound (the previous single shared cache did both jobs and
// was wiped on every push).
var TILE_CACHE = "legwork-tiles-v1";
var TILE_CACHE_LIMIT = 1000;

var SHELL_FILES = [
    "./", "./index.html", "./app.js", "./routing.js", "./storage.js",
    "./tiles.js", "./style.css", "./welcome-init.js",
];
var CDN_LIBS = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js",
    "https://cdn.jsdelivr.net/npm/leaflet-hotline@0.4.0/dist/leaflet.hotline.min.js",
];
// Absolute URLs, for exact-match shell lookup. (The old substring match meant
// "./" matched essentially every request and mis-routed cache strategy.)
var SHELL_URLS = SHELL_FILES.map(function (f) { return new URL(f, self.location).href; }).concat(CDN_LIBS);

// Tile hosts served stale-while-revalidate, including our own pre-baked tile repo
// (legwork-tiles) — without this entry our vector tiles fell through to the
// network-first API branch instead of being offline-first.
var TILE_PATTERNS = [
    "tile.openstreetmap.org",
    "server.arcgisonline.com",
    "tile.opentopomap.org",
    "s3.amazonaws.com/elevation-tiles-prod",
    "fractionasian.github.io/legwork-tiles",
];

self.addEventListener("install", function (e) {
    e.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(SHELL_URLS);
        }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener("activate", function (e) {
    e.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names.filter(function (n) { return n !== CACHE_NAME && n !== TILE_CACHE; })
                     .map(function (n) { return caches.delete(n); })
            );
        }).then(function () { return self.clients.claim(); })
    );
});

// FIFO eviction — Cache Storage preserves insertion order, so the oldest tiles
// drop first once we exceed the cap.
function trimCache(cacheName, limit) {
    return caches.open(cacheName).then(function (cache) {
        return cache.keys().then(function (keys) {
            if (keys.length <= limit) return;
            return Promise.all(
                keys.slice(0, keys.length - limit).map(function (k) { return cache.delete(k); })
            );
        });
    });
}

self.addEventListener("fetch", function (e) {
    // Let non-GET (e.g. Overpass POST) pass straight through to the network.
    if (e.request.method !== "GET") return;
    var url = e.request.url;

    // App shell: cache-first (exact URL match, not substring).
    if (e.request.mode === "navigate" || SHELL_URLS.indexOf(url) !== -1) {
        e.respondWith(
            caches.match(e.request).then(function (cached) {
                var fetchPromise = fetch(e.request).then(function (resp) {
                    if (resp && resp.ok) {
                        var clone = resp.clone();
                        caches.open(CACHE_NAME).then(function (c) { c.put(e.request, clone); });
                    }
                    return resp;
                }).catch(function () { return cached; });
                return cached || fetchPromise;
            })
        );
        return;
    }

    // Map/path tiles: stale-while-revalidate from the stable, capped tile cache.
    var isTile = TILE_PATTERNS.some(function (p) { return url.indexOf(p) !== -1; });
    if (isTile) {
        e.respondWith(
            caches.open(TILE_CACHE).then(function (cache) {
                return cache.match(e.request).then(function (cached) {
                    var fetchPromise = fetch(e.request).then(function (resp) {
                        if (resp && resp.ok) {
                            cache.put(e.request, resp.clone()).then(function () {
                                trimCache(TILE_CACHE, TILE_CACHE_LIMIT);
                            });
                        }
                        return resp;
                    }).catch(function () { return cached; });
                    return cached || fetchPromise;
                });
            })
        );
        return;
    }

    // API calls (Overpass GET, Photon, Open-Meteo): network-first, cache fallback.
    e.respondWith(
        fetch(e.request).then(function (resp) {
            if (resp && resp.ok) {
                var clone = resp.clone();
                caches.open(CACHE_NAME).then(function (c) { c.put(e.request, clone); });
            }
            return resp;
        }).catch(function () { return caches.match(e.request); })
    );
});

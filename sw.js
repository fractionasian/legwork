// CACHE_NAME is auto-bumped by .github/workflows/bump-sw.yml on push to main.
var CACHE_NAME = "legwork-spinneruv";
var APP_SHELL = [
    "./",
    "./index.html",
    "./app.js",
    "./routing.js",
    "./storage.js",
    "./tiles.js",
    "./style.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://cdn.jsdelivr.net/npm/chart.js@4",
    "https://cdn.jsdelivr.net/npm/leaflet-hotline@0.4.0/dist/leaflet.hotline.min.js",
];

// Tile URL patterns to cache
var TILE_PATTERNS = [
    "tile.openstreetmap.org",
    "server.arcgisonline.com",
    "tile.opentopomap.org",
];

self.addEventListener("install", function (e) {
    e.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(APP_SHELL);
        }).then(function () {
            return self.skipWaiting();
        })
    );
});

self.addEventListener("activate", function (e) {
    e.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names.filter(function (n) { return n !== CACHE_NAME; })
                     .map(function (n) { return caches.delete(n); })
            );
        }).then(function () {
            return self.clients.claim();
        })
    );
});

self.addEventListener("fetch", function (e) {
    var url = e.request.url;

    // App shell: cache-first
    if (e.request.mode === "navigate" || APP_SHELL.some(function (u) { return url.indexOf(u) !== -1; })) {
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

    // Map tiles: stale-while-revalidate
    var isTile = TILE_PATTERNS.some(function (p) { return url.indexOf(p) !== -1; });
    if (isTile) {
        e.respondWith(
            caches.open(CACHE_NAME).then(function (cache) {
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

    // API calls (Overpass, Photon, Open-Meteo): network-first with cache fallback
    e.respondWith(
        fetch(e.request).then(function (resp) {
            if (resp && resp.ok && e.request.method === "GET") {
                var clone = resp.clone();
                caches.open(CACHE_NAME).then(function (c) { c.put(e.request, clone); });
            }
            return resp;
        }).catch(function () {
            return caches.match(e.request);
        })
    );
});

// CACHE_NAME is auto-bumped by .github/workflows/bump-sw.yml on push to main.
// It versions the APP SHELL cache only — bumping it evicts stale HTML/JS/CSS.
var CACHE_NAME = "legwork-786d4f16";

// Map/path tiles live in SEPARATE, stable caches that survive shell bumps, so a
// code push doesn't throw away the user's accumulated offline map data. One
// cache per source with its own cap, so terrain's bigger images or a city's
// path files can't push the street tiles out. Oldest tiles drop first.
var TILE_CACHE_PREFIX = "legwork-tiles-v2-";
var SHELL_FILES = [
    "./", "./index.html", "./app.js", "./routing.js", "./storage.js",
    "./tiles.js", "./suburbs.js", "./style.css", "./welcome-init.js",
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

// Tile hosts, each with its own cache and cap. Includes our own pre-baked tile
// repo (legwork-tiles) — without it our vector tiles fell through to the
// network-first API branch instead of being offline-first.
// ponytail: caps are guesses from one sample tile each (street ~7 KB, satellite
// ~18 KB, terrain ~50 KB); measure real usage and tune.
var TILE_SOURCES = [
    { host: "tile.openstreetmap.org", name: "street", limit: 3000 },
    { host: "server.arcgisonline.com", name: "satellite", limit: 1500 },
    { host: "tile.opentopomap.org", name: "terrain", limit: 800 },
    { host: "s3.amazonaws.com/elevation-tiles-prod", name: "elevation", limit: 600 },
    { host: "fractionasian.github.io/legwork-tiles", name: "paths", limit: 500 },
];
// A tile with no usable Cache-Control is treated as fresh this long (OSM's
// tile policy: if you can't read the headers, keep a tile at least 7 days).
var TILE_DEFAULT_FRESH_S = 7 * 24 * 3600;

// The server's own freshness rules for a cached tile, per OSM's tile policy
// ("honour server caching headers"). Fresh = no request at all. Stale but
// inside stale-while-revalidate = serve it and refresh behind. Older = fetch.
function tileFreshness(resp) {
    var cc = resp.headers.get("cache-control") || "";
    var maxAge = /max-age=(\d+)/.exec(cc);
    var swr = /stale-while-revalidate=(\d+)/.exec(cc);
    var fresh = maxAge ? +maxAge[1] : TILE_DEFAULT_FRESH_S;
    var dateHdr = resp.headers.get("date");
    var age = dateHdr ? (Date.now() - new Date(dateHdr).getTime()) / 1000 : Infinity;
    if (!(age >= 0)) age = Infinity;
    return { fresh: age < fresh, usable: age < fresh + (swr ? +swr[1] : 0) };
}

self.addEventListener("install", function (e) {
    // Local shell files are the must-have — addAll is atomic, so keep it for
    // those. CDN libs are best-effort: one blipped unpkg/jsdelivr request must
    // not reject the whole install and strand users on the previous shell
    // (they're also fetched at runtime through the shell branch below, so a
    // miss here only costs first-offline-load coverage of that one file).
    e.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            // cache: "reload" bypasses the browser HTTP cache (GitHub Pages sends
            // max-age=600), so a user who loaded the site just before a deploy
            // doesn't seed the NEW shell cache with the OLD app.js/tiles.js.
            return cache.addAll(SHELL_FILES.map(function (u) {
                return new Request(u, { cache: "reload" });
            })).then(function () {
                return Promise.all(CDN_LIBS.map(function (u) {
                    return cache.add(u).catch(function () {});
                }));
            });
        }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener("activate", function (e) {
    e.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names.filter(function (n) { return n !== CACHE_NAME && n.indexOf(TILE_CACHE_PREFIX) !== 0; })
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

    // App shell: cache-first (exact URL match, not substring). Navigations
    // match with ignoreSearch — an offline navigate to "/?s=slug" (short-link
    // resolve) must still hit the cached shell, not respondWith(undefined).
    if (e.request.mode === "navigate" || SHELL_URLS.indexOf(url) !== -1) {
        var isNav = e.request.mode === "navigate";
        // Only a navigation to the app itself ("/" or "/index.html", any query)
        // may refresh the cached shell. Before this guard ANY 200 navigation —
        // /test.html, /manifest.json — was stored under "/", and the next
        // cache-first launch served that page instead of the app.
        var navPath = isNav ? new URL(url).pathname : "";
        var isShellNav = isNav && (navPath === "/" || navPath === "/index.html");
        var matchOpts = isNav ? { ignoreSearch: true } : undefined;
        e.respondWith(
            caches.match(e.request, matchOpts).then(function (cached) {
                var fetchPromise = fetch(e.request).then(function (resp) {
                    if (resp && resp.ok && (!isNav || isShellNav)) {
                        var clone = resp.clone();
                        // Navigations store under the bare shell URL — putting
                        // e.request verbatim would add one cache entry per
                        // distinct "/?s=slug" short-link URL, unbounded until
                        // the next CACHE_NAME bump (lookups ignoreSearch anyway).
                        var putKey = isNav ? SHELL_URLS[0] : e.request;
                        caches.open(CACHE_NAME).then(function (c) { c.put(putKey, clone); });
                    }
                    return resp;
                }).catch(function () {
                    // Offline navigation with no exact entry (a pretty short
                    // link like /Melbourne2027 normally arrives via 404.html):
                    // serve the cached app rather than the browser error page.
                    return cached || (isNav ? caches.match(SHELL_URLS[0]) : undefined);
                });
                return cached || fetchPromise;
            })
        );
        return;
    }

    // The tile manifest is the one legwork-tiles file that must be fresh: it
    // names the current tile version. Stale-first meant a rebuild (or a new
    // city) was invisible until the SECOND fetch. Network-first instead; the
    // tile files themselves carry ?v=<version> and stay stale-first below.
    var isManifest = url.indexOf("fractionasian.github.io/legwork-tiles/manifest.json") !== -1;

    // Map/path tiles, from the stable per-source tile caches: fresh hit = no
    // network request; stale hit inside the server's stale-while-revalidate
    // window = served instantly and refreshed behind; anything older = fetched.
    var source = isManifest ? null : TILE_SOURCES.filter(function (t) { return url.indexOf(t.host) !== -1; })[0];
    if (source) {
        var cacheName = TILE_CACHE_PREFIX + source.name;
        e.respondWith(
            caches.open(cacheName).then(function (cache) {
                return cache.match(e.request).then(function (cached) {
                    var f = cached && tileFreshness(cached);
                    if (f && f.fresh) return cached;
                    var fetchPromise = fetch(e.request).then(function (resp) {
                        if (resp && resp.ok) {
                            cache.put(e.request, resp.clone()).then(function () {
                                trimCache(cacheName, source.limit);
                            });
                        }
                        return resp;
                    }).catch(function () { return cached; });
                    return f && f.usable ? cached : fetchPromise;
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

// ── Legwork tiles — path network loading ─────────────
// Pre-cached city tiles (primary) + live Overpass queries (fallback) build up
// state.graph, state.pathFeatures, state.pathLayer. resetGraphIfCityChanged
// wipes them when the user teleports to a different city. Depends on globals
// from routing.js, storage.js, app.js (state, showBanner, fetchWithTimeout).

var TILES_BASE = "./data/";
var _manifest = null;

async function fetchManifest() {
    if (_manifest) return _manifest;
    try {
        var resp = await fetchWithTimeout(TILES_BASE + "manifest.json", null, 10000);
        if (!resp.ok) return null;
        _manifest = await resp.json();
        return _manifest;
    } catch (e) { return null; }
}

function findCityForLocation(manifest, lat, lon) {
    if (!manifest || !manifest.cities) return null;
    var ids = Object.keys(manifest.cities);
    for (var i = 0; i < ids.length; i++) {
        var city = manifest.cities[ids[i]];
        var b = city.bounds; // [south, west, north, east]
        if (lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]) {
            return { id: ids[i], city: city };
        }
    }
    return null;
}

function tilesInRadius(city, lat, lon, radiusKm) {
    var radiusDeg = radiusKm / 111; // rough km-to-degrees
    var selected = [];
    for (var i = 0; i < city.tiles.length; i++) {
        var t = city.tiles[i];
        var b = t.bounds; // [south, west, north, east]
        var tCenterLat = (b[0] + b[2]) / 2;
        var tCenterLon = (b[1] + b[3]) / 2;
        var dlat = tCenterLat - lat;
        var dlon = (tCenterLon - lon) * Math.cos(lat * Math.PI / 180);
        var dist = Math.sqrt(dlat * dlat + dlon * dlon);
        if (dist < radiusDeg) selected.push(t);
    }
    return selected;
}

// Apply cached tiles immediately, fetch missing ones in parallel, update banner.
async function loadTilesFromList(cityId, manifestVersion, tiles, opts) {
    var toFetch = [];
    var cachedCount = 0;
    for (var i = 0; i < tiles.length; i++) {
        var cacheKey = "tile:" + cityId + ":" + tiles[i].file + ":" + manifestVersion;
        var cached = await cacheGet(cacheKey);
        if (cached) {
            applyPaths(cached, { skipRender: true });
            cachedCount++;
        } else {
            toFetch.push(tiles[i]);
        }
    }

    if (toFetch.length === 0) return { fetched: 0, cached: cachedCount };

    if (opts && opts.banner !== false) {
        var suburbs = [];
        for (var k = 0; k < toFetch.length; k++) {
            for (var s = 0; s < toFetch[k].suburbs.length; s++) {
                if (suburbs.indexOf(toFetch[k].suburbs[s]) === -1) suburbs.push(toFetch[k].suburbs[s]);
            }
        }
        var trimmed = suburbs.length > 5 ? suburbs.slice(0, 5).join(", ") + "..." : suburbs.join(", ");
        showBanner("Loading " + trimmed + "...", "loading");
    }

    var loaded = 0;
    var total = toFetch.length;
    var showProgress = opts && opts.progress;
    var promises = toFetch.map(function (tile) {
        var url = TILES_BASE + "tiles/" + cityId + "/" + tile.file;
        return fetchWithTimeout(url, null, 15000).then(function (resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            return resp.json();
        }).then(function (data) {
            // compactToGeoJSON now accepts both v1 (Array) and v2 ({v,features,nodeAttrs}) tile formats.
            var geojson = compactToGeoJSON(data);
            applyPaths(geojson, { skipRender: true });
            var cacheKey = "tile:" + cityId + ":" + tile.file + ":" + manifestVersion;
            cacheSet(cacheKey, geojson);
            loaded++;
            if (showProgress && loaded < total) {
                showBanner("Loaded " + loaded + "/" + total + " areas...", "loading");
            }
        }).catch(function (e) {
            console.warn("Tile fetch failed: " + tile.file, e.message);
        });
    });

    await Promise.all(promises);
    return { fetched: loaded, cached: cachedCount };
}

async function loadTilesForLocation(lat, lon) {
    var manifest = await fetchManifest();
    if (!manifest) return false;

    var match = findCityForLocation(manifest, lat, lon);
    if (!match) return false;

    var tiles = tilesInRadius(match.city, lat, lon, 5);
    if (tiles.length === 0) return false;

    var result = await loadTilesFromList(match.id, manifest.version, tiles, { progress: true });
    showBanner("");
    console.log("Loaded " + result.fetched + "/" + tiles.length + " tiles for " + match.city.name +
        " (" + result.cached + " from cache)");
    return true;
}

async function loadTilesInViewport() {
    var manifest = await fetchManifest();
    if (!manifest || !state.map) return;

    var bounds = state.map.getBounds();
    var center = bounds.getCenter();
    var match = findCityForLocation(manifest, center.lat, center.lng);
    if (!match) return;

    var city = match.city;
    var south = bounds.getSouth(), north = bounds.getNorth();
    var west = bounds.getWest(), east = bounds.getEast();

    var candidates = [];
    for (var i = 0; i < city.tiles.length; i++) {
        var tb = city.tiles[i].bounds; // [south, west, north, east]
        if (tb[2] < south || tb[0] > north || tb[3] < west || tb[1] > east) continue;
        candidates.push(city.tiles[i]);
        if (candidates.length >= 40) break; // cap per viewport-change event
    }
    if (candidates.length === 0) return;

    var result = await loadTilesFromList(match.id, manifest.version, candidates, {});
    var bannerEl = document.getElementById("info-banner");
    if (bannerEl.dataset.type === "loading") showBanner("");
    if (result.fetched > 0) console.log("Viewport preloaded " + result.fetched + " tiles");
}

async function loadTilesOrPaths(lat, lon) {
    var tilesLoaded = await loadTilesForLocation(lat, lon);
    if (!tilesLoaded) await loadPaths(lat, lon);
}

// Clear the routing graph + cached path features when the user teleports to a
// new city (via search, locate, or saved-route restore). Without this the graph
// accumulates every city the user has touched in one session and both memory
// and rendered overlay grow unbounded.
var _currentCityId = null;
async function resetGraphIfCityChanged(lat, lon) {
    var manifest = await fetchManifest();
    if (!manifest) return;
    var match = findCityForLocation(manifest, lat, lon);
    var newId = match ? match.id : null;
    if (newId === _currentCityId) return;
    _currentCityId = newId;
    // Fire a custom Umami event at the semantic moment "user resolved into a
    // (new) city bucket". Drives the curated cities.json list — hot unknown
    // buckets become candidates for the next pre-cache build. Coarse 0.5°
    // bucketing on unknowns keeps it privacy-preserving.
    try {
        if (window.umami && typeof window.umami.track === "function") {
            if (newId) {
                window.umami.track("city-resolved", { city: newId });
            } else {
                var bLat = (Math.round(lat * 2) / 2).toFixed(1);
                var bLon = (Math.round(lon * 2) / 2).toFixed(1);
                window.umami.track("city-unknown", { bucket: bLat + "," + bLon });
            }
        }
    } catch (e) { /* never let telemetry break the app */ }
    state.graph = null;
    state.pathFeatures = null;
    state.seenIds = {};
    state.edgeMeta = {};
    state.nodeAttrs = {};
    spatialGrid = {};
    if (state.pathLayer) {
        state.map.removeLayer(state.pathLayer);
        state.pathLayer = null;
    }
    // POIs are per-city too — clear and let refreshPois repopulate.
    if (state.poiMarkers) {
        for (var i = 0; i < state.poiMarkers.length; i++) state.map.removeLayer(state.poiMarkers[i]);
        state.poiMarkers = [];
    }
}

function showCityRequest() {
    var el = document.getElementById("city-request-link");
    if (el) el.classList.remove("hidden");
}

function hideCityRequest() {
    var el = document.getElementById("city-request-link");
    if (el) el.classList.add("hidden");
}

// ── Points of interest (toilets, drinking water) ──────
// One Overpass call per ~10km area, cached 7 days in IDB. Keyed by coarse
// lat/lon so panning within the same area hits the cache.
var POIS_TTL = 7 * 24 * 3600 * 1000;

async function loadPois(lat, lon) {
    var radius = 10000;
    // Cache key bumped to v2 when we started including ways + relations.
    var key = "pois2:" + lat.toFixed(2) + ":" + lon.toFixed(2);
    var cached = await cacheGet(key, POIS_TTL);
    if (cached) return cached;

    // nwr = node/way/relation. Many toilet blocks are tagged on a building
    // polygon (way) rather than a single point. `out center` returns a
    // computed centroid for non-node elements so we get a lat/lon either way.
    var query = '[out:json][timeout:25];(' +
        'nwr["amenity"="toilets"](around:' + radius + ',' + lat + ',' + lon + ');' +
        'nwr["amenity"="drinking_water"](around:' + radius + ',' + lat + ',' + lon + ');' +
        ');out center;';

    try {
        var resp = await fetchWithTimeout("https://overpass-api.de/api/interpreter", {
            method: "POST",
            body: "data=" + encodeURIComponent(query),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }, 30000);
        if (!resp.ok) return null;
        var raw = await resp.json();
        var pois = [];
        for (var i = 0; i < (raw.elements || []).length; i++) {
            var el = raw.elements[i];
            if (!el.tags || !el.tags.amenity) continue;
            // Nodes carry lat/lon directly; ways + relations get a computed
            // centroid in el.center thanks to `out center`.
            var plat, plon;
            if (el.type === "node") { plat = el.lat; plon = el.lon; }
            else if (el.center) { plat = el.center.lat; plon = el.center.lon; }
            else continue;
            pois.push({
                id: el.type[0] + el.id, // prefix with type so node/way IDs don't collide
                lat: plat,
                lon: plon,
                amenity: el.tags.amenity,
                name: el.tags.name || "",
                access: el.tags["toilets:access"] || el.tags.access || "",
                fee: el.tags.fee || "",
                wheelchair: el.tags.wheelchair || "",
                opening_hours: el.tags.opening_hours || "",
                male: el.tags.male === "yes",
                female: el.tags.female === "yes",
                unisex: el.tags.unisex === "yes",
                changing_table: el.tags.changing_table === "yes",
            });
        }
        cacheSet(key, pois);
        return pois;
    } catch (e) {
        console.warn("POI fetch failed:", e.message);
        return null;
    }
}

// ── Overpass fallback ─────────────────────────────────
function radiusFromZoom() {
    if (!state.map) return 2000;
    var z = state.map.getZoom();
    if (z >= 16) return 1000;
    if (z >= 14) return 2000;
    if (z >= 12) return 5000;
    return 10000;
}

async function loadPaths(lat, lon) {
    var radius = radiusFromZoom();
    // Bumped from paths: to paths2: when we started carrying node tags through
    // osmToGeoJSON for the runner-friendly preference weighting.
    var cacheKey = "paths2:" + lat.toFixed(3) + ":" + lon.toFixed(3) + ":" + radius;

    showBanner("Loading paths...", "loading");

    var cached = await cacheGet(cacheKey, PATHS_TTL);
    if (cached) {
        applyPaths(cached, { skipRender: true });
        showBanner("");
        return;
    }

    var query = '[out:json][timeout:30];\n(\n' +
        '  way["highway"="footway"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="cycleway"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="path"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="residential"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="living_street"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="pedestrian"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="service"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="unclassified"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="tertiary"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="tertiary_link"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="secondary"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="secondary_link"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="primary"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="primary_link"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="trunk"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="trunk_link"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="crossing"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="steps"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        // `out body qt` on the node recurse (vs skel) brings node tags through
        // — needed for barrier/crossing/traffic-signal weighting in applyPaths.
        ');\nout body;\n>;\nout body qt;';

    var maxRetries = 3, delay = 2000;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            var resp = await fetchWithTimeout("https://overpass-api.de/api/interpreter", {
                method: "POST",
                body: "data=" + encodeURIComponent(query),
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            }, 60000);
            if (resp.status === 429 || resp.status >= 500) {
                if (attempt < maxRetries) {
                    showBanner("Path server busy, retrying (" + (attempt + 1) + "/" + maxRetries + ")...", "loading");
                    await new Promise(function (r) { setTimeout(r, delay * Math.pow(2, attempt)); });
                    continue;
                }
            }
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            var raw = await resp.json();
            var geojson = osmToGeoJSON(raw);
            await cacheSet(cacheKey, geojson);
            applyPaths(geojson, { skipRender: true });
            showBanner("");
            return;
        } catch (e) {
            if (attempt < maxRetries) {
                showBanner("Retrying path load (" + (attempt + 1) + "/" + maxRetries + ")...", "loading");
                await new Promise(function (r) { setTimeout(r, delay * Math.pow(2, attempt)); });
                continue;
            }
            showBannerWithRetry("Failed to load paths: " + e.message, function () {
                loadPaths(lat, lon);
            });
        }
    }
}

// ── Path styling + graph extension ────────────────────
var pathStyles = {
    run: ["footway", "cycleway", "path", "pedestrian", "steps"],
    style: function (feature) {
        if (pathStyles.run.indexOf(feature.properties.highway) !== -1) return { color: "#6ee7b7", weight: 2, opacity: 0.35 };
        return { color: "#6ee7b7", weight: 1, opacity: 0.08 };
    },
    tooltip: function (feature, layer) {
        var p = feature.properties;
        var parts = [];
        if (p.name) parts.push(p.name);
        else parts.push(p.highway || "path");
        if (p.surface) parts.push(p.surface);
        layer.bindTooltip(parts.join(" · "), { sticky: true });
    },
};

function applyPaths(geojson, opts) {
    if (!state.seenIds) state.seenIds = {};
    if (!state.nodeAttrs) state.nodeAttrs = {};

    // Merge any node attrs the geojson carries. Live Overpass paths populate
    // this sidecar; cached compact tiles don't yet (pre-rebuild), so the
    // default-empty dict means node-level prefs simply don't fire for them.
    if (geojson.nodeAttrs) {
        var keys = Object.keys(geojson.nodeAttrs);
        for (var ni = 0; ni < keys.length; ni++) {
            state.nodeAttrs[keys[ni]] = geojson.nodeAttrs[keys[ni]];
        }
    }

    var newFeatures = [];
    for (var i = 0; i < geojson.features.length; i++) {
        var id = geojson.features[i].properties.id;
        if (!state.seenIds[id]) {
            state.seenIds[id] = true;
            newFeatures.push(geojson.features[i]);
        }
    }

    if (newFeatures.length === 0) return;

    if (!state.pathFeatures) {
        state.pathFeatures = { type: "FeatureCollection", features: newFeatures };
    } else {
        state.pathFeatures.features.push.apply(state.pathFeatures.features, newFeatures);
    }

    if (!(opts && opts.skipRender)) {
        if (!state.pathLayer) {
            state.pathLayer = L.geoJSON(null, {
                style: pathStyles.style,
                onEachFeature: pathStyles.tooltip,
            }).addTo(state.map);
        }
        var newGeo = { type: "FeatureCollection", features: newFeatures };
        state.pathLayer.addData(newGeo);
    }

    if (!state.graph) state.graph = {};
    if (!state.edgeMeta) state.edgeMeta = {};
    var adj = state.graph;
    for (var f = 0; f < newFeatures.length; f++) {
        var props = newFeatures[f].properties;
        var coords = newFeatures[f].geometry.coordinates;
        var hw = props.highway || "";
        var named = !!(props.name && props.name.length);
        // Combine base road weight + way-level preferences (P1 named trails, P5 soft surfaces).
        var baseWeight = (ROAD_WEIGHT[hw] || 1.2) * wayPrefMultiplier(hw, props.surface || "", props.name || "");
        for (var c = 1; c < coords.length; c++) {
            var lat1 = coords[c-1][1], lon1 = coords[c-1][0];
            var lat2 = coords[c][1], lon2 = coords[c][0];
            var k1 = nodeKey(lat1, lon1), k2 = nodeKey(lat2, lon2);
            var edgeId = k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
            if (state.edgeMeta[edgeId]) continue;
            // edgeMeta doubles as a dedup set (truthy presence) and the
            // per-edge attribute lookup the recommender's scorer needs.
            state.edgeMeta[edgeId] = { hw: hw, named: named };
            // Node-level preferences (P2 traffic signals, P3 marked crossings, P4 barriers)
            // apply to both endpoints; the worst penalty / best bonus dominates via product.
            var nodeMult = nodePrefMultiplier(state.nodeAttrs[k1]) * nodePrefMultiplier(state.nodeAttrs[k2]);
            var d = haversine(lat1, lon1, lat2, lon2) * baseWeight * nodeMult;
            if (!adj[k1]) { adj[k1] = []; gridInsert(k1, lat1, lon1); }
            if (!adj[k2]) { adj[k2] = []; gridInsert(k2, lat2, lon2); }
            adj[k1].push({ key: k2, lat: lat2, lon: lon2, dist: d });
            adj[k2].push({ key: k1, lat: lat1, lon: lon1, dist: d });
        }
    }

    console.log("Graph: " + Object.keys(adj).length + " nodes (+" + newFeatures.length + " ways)");
}

// ── Gap filling ───────────────────────────────────────
async function fillGapAndRetry(fromWp, toWp) {
    var dist = haversine(fromWp.lat, fromWp.lon, toWp.lat, toWp.lon);
    var steps = Math.max(1, Math.ceil(dist / 1500)); // one load every ~1.5km
    var loaded = false;

    showBanner("Expanding route coverage...", "loading");
    for (var s = 0; s <= steps; s++) {
        var t = steps === 0 ? 0.5 : s / steps;
        var midLat = fromWp.lat + t * (toWp.lat - fromWp.lat);
        var midLon = fromWp.lon + t * (toWp.lon - fromWp.lon);
        if (steps > 1) showBanner("Expanding route coverage (" + (s + 1) + "/" + (steps + 1) + ")...", "loading");
        await loadTilesOrPaths(midLat, midLon);
        loaded = true;
    }

    if (!loaded) return null;

    var newFromKey = closestNode(state.graph, fromWp.lat, fromWp.lon);
    var newToKey = closestNode(state.graph, toWp.lat, toWp.lon);
    if (newFromKey) fromWp.nodeKey = newFromKey;
    if (newToKey) toWp.nodeKey = newToKey;

    return dijkstra(state.graph, fromWp.nodeKey, toWp.nodeKey);
}

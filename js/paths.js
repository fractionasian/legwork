import { state, PATHS_TTL, TILES_BASE, ROAD_WEIGHT } from './state.js';
import { cacheGet, cacheSet } from './cache.js';
import { haversine, nodeKey, showBanner } from './helpers.js';
import { gridInsert } from './router.js';

var _manifest = null;

export async function fetchManifest() {
    if (_manifest) return _manifest;
    try {
        var resp = await fetch(TILES_BASE + "manifest.json");
        if (!resp.ok) return null;
        _manifest = await resp.json();
        return _manifest;
    } catch (e) { return null; }
}

export function findCityForLocation(manifest, lat, lon) {
    if (!manifest || !manifest.cities) return null;
    var ids = Object.keys(manifest.cities);
    for (var i = 0; i < ids.length; i++) {
        var city = manifest.cities[ids[i]];
        var b = city.bounds;
        if (lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]) {
            return { id: ids[i], city: city };
        }
    }
    return null;
}

function tilesInRadius(city, lat, lon, radiusKm) {
    var radiusDeg = radiusKm / 111;
    var selected = [];
    for (var i = 0; i < city.tiles.length; i++) {
        var t = city.tiles[i];
        var b = t.bounds;
        var tCenterLat = (b[0] + b[2]) / 2;
        var tCenterLon = (b[1] + b[3]) / 2;
        var dlat = tCenterLat - lat;
        var dlon = (tCenterLon - lon) * Math.cos(lat * Math.PI / 180);
        var dist = Math.sqrt(dlat * dlat + dlon * dlon);
        if (dist < radiusDeg) selected.push(t);
    }
    return selected;
}

function compactToGeoJSON(compact) {
    var features = [];
    for (var i = 0; i < compact.length; i++) {
        var c = compact[i];
        features.push({
            type: "Feature",
            properties: { id: c[0], highway: c[1], surface: "", name: c[2] },
            geometry: { type: "LineString", coordinates: c[3] },
        });
    }
    return { type: "FeatureCollection", features: features };
}

export async function loadTilesForLocation(lat, lon) {
    var manifest = await fetchManifest();
    if (!manifest) return false;

    var match = findCityForLocation(manifest, lat, lon);
    if (!match) return false;

    var cityId = match.id;
    var city = match.city;
    var tiles = tilesInRadius(city, lat, lon, 5);
    if (tiles.length === 0) return false;

    var cacheKeys = tiles.map(function (t) { return "tile:" + cityId + ":" + t.file + ":" + manifest.version; });
    var cachedAll = await Promise.all(cacheKeys.map(function (k) { return cacheGet(k); }));
    var toFetch = [];
    for (var i = 0; i < tiles.length; i++) {
        if (cachedAll[i]) {
            applyPaths(cachedAll[i], { skipRender: true });
        } else {
            toFetch.push(tiles[i]);
        }
    }

    if (toFetch.length === 0) {
        console.log("All " + tiles.length + " tiles loaded from cache");
        return true;
    }

    var suburbs = [];
    for (var i = 0; i < toFetch.length; i++) {
        for (var s = 0; s < toFetch[i].suburbs.length; s++) {
            if (suburbs.indexOf(toFetch[i].suburbs[s]) === -1) suburbs.push(toFetch[i].suburbs[s]);
        }
    }
    showBanner("Loading " + suburbs.join(", ") + "...", "loading");

    var loaded = 0;
    var total = toFetch.length;
    var promises = toFetch.map(function (tile) {
        var url = TILES_BASE + "tiles/" + cityId + "/" + tile.file;
        return fetch(url).then(function (resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            return resp.json();
        }).then(function (data) {
            var geojson = Array.isArray(data) ? compactToGeoJSON(data) : data;
            applyPaths(geojson, { skipRender: true });
            var cacheKey = "tile:" + cityId + ":" + tile.file + ":" + manifest.version;
            cacheSet(cacheKey, geojson);
            loaded++;
            if (loaded < total) {
                showBanner("Loaded " + loaded + "/" + total + " areas...", "loading");
            }
        }).catch(function (e) {
            console.warn("Tile fetch failed: " + tile.file, e.message);
        });
    });

    await Promise.all(promises);
    showBanner("");
    console.log("Loaded " + loaded + "/" + total + " tiles for " + city.name);
    return true;
}

export async function loadTilesOrPaths(lat, lon) {
    var tilesLoaded = await loadTilesForLocation(lat, lon);
    if (!tilesLoaded) await loadPaths(lat, lon);
}

export function showCityRequest() {
    var el = document.getElementById("city-request-link");
    if (el) el.classList.remove("hidden");
}

export function hideCityRequest() {
    var el = document.getElementById("city-request-link");
    if (el) el.classList.add("hidden");
}

var _viewportLoading = false;
export async function loadTilesInViewport() {
    if (_viewportLoading) return;
    _viewportLoading = true;
    try { await _loadTilesInViewport(); } finally { _viewportLoading = false; }
}
async function _loadTilesInViewport() {
    var manifest = await fetchManifest();
    if (!manifest || !state.map) return;

    var bounds = state.map.getBounds();
    var center = bounds.getCenter();
    var match = findCityForLocation(manifest, center.lat, center.lng);
    if (!match) return;

    var city = match.city;
    var cityId = match.id;
    var south = bounds.getSouth(), north = bounds.getNorth();
    var west = bounds.getWest(), east = bounds.getEast();

    var visible = [];
    for (var i = 0; i < city.tiles.length; i++) {
        var tb = city.tiles[i].bounds;
        if (tb[2] < south || tb[0] > north || tb[3] < west || tb[1] > east) continue;
        visible.push(city.tiles[i]);
    }
    if (visible.length === 0) return;

    var vKeys = visible.map(function (t) { return "tile:" + cityId + ":" + t.file + ":" + manifest.version; });
    var vCached = await Promise.all(vKeys.map(function (k) { return cacheGet(k); }));
    var toFetch = [];
    for (var vi = 0; vi < visible.length; vi++) {
        if (vCached[vi]) {
            applyPaths(vCached[vi], { skipRender: true });
        } else {
            toFetch.push(visible[vi]);
            if (toFetch.length >= 20) break;
        }
    }

    if (toFetch.length === 0) return;

    var suburbs = [];
    for (var i = 0; i < toFetch.length; i++) {
        for (var s = 0; s < toFetch[i].suburbs.length; s++) {
            if (suburbs.indexOf(toFetch[i].suburbs[s]) === -1) suburbs.push(toFetch[i].suburbs[s]);
        }
    }
    showBanner("Loading " + suburbs.slice(0, 5).join(", ") + (suburbs.length > 5 ? "..." : "") + "", "loading");

    var loaded = 0;
    var promises = toFetch.map(function (tile) {
        var url = TILES_BASE + "tiles/" + cityId + "/" + tile.file;
        return fetch(url).then(function (resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            return resp.json();
        }).then(function (data) {
            var geojson = Array.isArray(data) ? compactToGeoJSON(data) : data;
            applyPaths(geojson, { skipRender: true });
            var cacheKey = "tile:" + cityId + ":" + tile.file + ":" + manifest.version;
            cacheSet(cacheKey, geojson);
            loaded++;
        }).catch(function (e) {
            console.warn("Viewport tile fetch failed: " + tile.file, e.message);
        });
    });

    await Promise.all(promises);
    var bannerEl = document.getElementById("info-banner");
    if (bannerEl.dataset.type === "loading") showBanner("");
    if (loaded > 0) console.log("Viewport preloaded " + loaded + " tiles");
}

function radiusFromZoom() {
    if (!state.map) return 2000;
    var z = state.map.getZoom();
    if (z >= 16) return 1000;
    if (z >= 14) return 2000;
    if (z >= 12) return 5000;
    return 10000;
}

export async function loadPaths(lat, lon) {
    var radius = radiusFromZoom();
    var cacheKey = "paths:" + lat.toFixed(3) + ":" + lon.toFixed(3) + ":" + radius;

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
        ');\nout body;\n>;\nout skel qt;';

    var maxRetries = 3, delay = 2000;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            var resp = await fetch("https://overpass-api.de/api/interpreter", {
                method: "POST",
                body: "data=" + encodeURIComponent(query),
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
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
            showBanner("Failed to load paths: " + e.message);
        }
    }
}

function osmToGeoJSON(data) {
    var nodes = {}, features = [];
    for (var i = 0; i < (data.elements || []).length; i++) {
        var el = data.elements[i];
        if (el.type === "node") nodes[el.id] = [el.lon, el.lat];
    }
    for (var i = 0; i < (data.elements || []).length; i++) {
        var el = data.elements[i];
        if (el.type !== "way") continue;
        var coords = [];
        for (var j = 0; j < (el.nodes || []).length; j++) {
            if (nodes[el.nodes[j]]) coords.push(nodes[el.nodes[j]]);
        }
        if (coords.length < 2) continue;
        var tags = el.tags || {};
        features.push({
            type: "Feature",
            properties: { id: el.id, highway: tags.highway || "", surface: tags.surface || "", name: tags.name || "" },
            geometry: { type: "LineString", coordinates: coords },
        });
    }
    return { type: "FeatureCollection", features: features };
}

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

export function applyPaths(geojson, opts) {
    if (!state.seenIds) state.seenIds = {};

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
    if (!state.edgeSet) state.edgeSet = {};
    var adj = state.graph;
    for (var f = 0; f < newFeatures.length; f++) {
        var coords = newFeatures[f].geometry.coordinates;
        var hw = newFeatures[f].properties.highway || "";
        var weight = ROAD_WEIGHT[hw] || 1.2;
        for (var c = 1; c < coords.length; c++) {
            var lat1 = coords[c-1][1], lon1 = coords[c-1][0];
            var lat2 = coords[c][1], lon2 = coords[c][0];
            var k1 = nodeKey(lat1, lon1), k2 = nodeKey(lat2, lon2);
            var edgeId = k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
            if (state.edgeSet[edgeId]) continue;
            state.edgeSet[edgeId] = true;
            var d = haversine(lat1, lon1, lat2, lon2) * weight;
            if (!adj[k1]) { adj[k1] = []; gridInsert(k1, lat1, lon1); }
            if (!adj[k2]) { adj[k2] = []; gridInsert(k2, lat2, lon2); }
            adj[k1].push({ key: k2, lat: lat2, lon: lon2, dist: d });
            adj[k2].push({ key: k1, lat: lat1, lon: lon1, dist: d });
        }
    }

    console.log("Graph: " + Object.keys(adj).length + " nodes (+" + newFeatures.length + " ways)");
}

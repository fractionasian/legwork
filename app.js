// ── Legwork — Static Running Route Planner ─────────────
// All API calls go directly to free external services.
// No backend required. Runs on GitHub Pages.

// ── localStorage Cache ─────────────────────────────────
var CACHE_PREFIX = "lw:";
var PATHS_TTL = 7 * 24 * 3600 * 1000; // 7 days

function cacheGet(key, ttlMs) {
    try {
        var raw = localStorage.getItem(CACHE_PREFIX + key);
        if (!raw) return null;
        var entry = JSON.parse(raw);
        if (ttlMs && Date.now() - entry.ts > ttlMs) {
            localStorage.removeItem(CACHE_PREFIX + key);
            return null;
        }
        return entry.v;
    } catch (e) { return null; }
}

function cacheSet(key, value) {
    try {
        localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ v: value, ts: Date.now() }));
    } catch (e) {
        // localStorage full — clear old entries
        clearOldCache();
        try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ v: value, ts: Date.now() })); } catch (e2) {}
    }
}

function clearOldCache() {
    var keys = [];
    for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
    }
    // Remove oldest half
    keys.sort();
    for (var i = 0; i < Math.floor(keys.length / 2); i++) {
        localStorage.removeItem(keys[i]);
    }
}

// ── State ──────────────────────────────────────────────
var state = {
    map: null,
    pathLayer: null,
    waypoints: [],
    routeSegments: [],
    routeLines: [],
    closingLine: null,
    mode: "loop",
    elevationChart: null,
    pathFeatures: null,
    graph: null,
    startLat: null,
    startLon: null,
    gradientLines: [],
    routeOutline: null,
    distanceMarkers: [],
    totalDistMetres: 0,
};

// ── Routing graph ──────────────────────────────────────
function nodeKey(lat, lon) {
    return lat.toFixed(6) + "," + lon.toFixed(6);
}

function buildGraph(geojson) {
    var adj = {};
    function addEdge(k1, lat1, lon1, k2, lat2, lon2) {
        var d = haversine(lat1, lon1, lat2, lon2);
        if (!adj[k1]) adj[k1] = [];
        if (!adj[k2]) adj[k2] = [];
        adj[k1].push({ key: k2, lat: lat2, lon: lon2, dist: d });
        adj[k2].push({ key: k1, lat: lat1, lon: lon1, dist: d });
    }
    for (var f = 0; f < geojson.features.length; f++) {
        var coords = geojson.features[f].geometry.coordinates;
        for (var c = 1; c < coords.length; c++) {
            addEdge(
                nodeKey(coords[c-1][1], coords[c-1][0]), coords[c-1][1], coords[c-1][0],
                nodeKey(coords[c][1], coords[c][0]), coords[c][1], coords[c][0]
            );
        }
    }
    return adj;
}

function dijkstra(graph, startKey, endKey) {
    if (!graph[startKey] || !graph[endKey]) return null;
    if (startKey === endKey) return { dist: 0, path: [startKey] };
    var dist = {}, prev = {}, visited = {}, queue = [];
    dist[startKey] = 0;
    queue.push({ key: startKey, d: 0 });
    while (queue.length > 0) {
        var minIdx = 0;
        for (var q = 1; q < queue.length; q++) {
            if (queue[q].d < queue[minIdx].d) minIdx = q;
        }
        var current = queue.splice(minIdx, 1)[0];
        if (visited[current.key]) continue;
        visited[current.key] = true;
        if (current.key === endKey) break;
        var neighbors = graph[current.key] || [];
        for (var n = 0; n < neighbors.length; n++) {
            var nb = neighbors[n];
            if (visited[nb.key]) continue;
            var newDist = dist[current.key] + nb.dist;
            if (dist[nb.key] === undefined || newDist < dist[nb.key]) {
                dist[nb.key] = newDist;
                prev[nb.key] = current.key;
                queue.push({ key: nb.key, d: newDist });
            }
        }
    }
    if (dist[endKey] === undefined) return null;
    var path = [];
    var cur = endKey;
    while (cur) { path.unshift(cur); cur = prev[cur]; }
    return { dist: dist[endKey], path: path };
}

function closestNode(graph, lat, lon) {
    var bestKey = null, bestDist = Infinity;
    var keys = Object.keys(graph);
    for (var i = 0; i < keys.length; i++) {
        var parts = keys[i].split(",");
        var d = haversine(lat, lon, parseFloat(parts[0]), parseFloat(parts[1]));
        if (d < bestDist) { bestDist = d; bestKey = keys[i]; }
    }
    return bestKey;
}

function pathToCoords(path) {
    var coords = [];
    for (var i = 0; i < path.length; i++) {
        var parts = path[i].split(",");
        coords.push([parseFloat(parts[0]), parseFloat(parts[1])]);
    }
    return coords;
}

// ── Map init ───────────────────────────────────────────
function initMap() {
    state.map = L.map("map").setView([0, 0], 2);

    var osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://github.com/fractionasian/legwork">Legwork</a>',
        maxZoom: 19,
    });
    var satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        attribution: '&copy; Esri',
        maxZoom: 19,
    });
    var terrain = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenTopoMap',
        maxZoom: 17,
    });

    osm.addTo(state.map);
    L.control.layers({ "Street": osm, "Satellite": satellite, "Terrain": terrain }, null, { position: "topright" }).addTo(state.map);

    // Gradient legend
    var legend = L.control({ position: "bottomright" });
    legend.onAdd = function () {
        var div = L.DomUtil.create("div", "gradient-legend");
        var title = document.createElement("strong");
        title.textContent = "Gradient";
        div.appendChild(title);
        div.appendChild(document.createElement("br"));
        var levels = [
            { color: "#60a5fa", label: "Steep downhill (>5%)" },
            { color: "#93c5fd", label: "Downhill (2-5%)" },
            { color: "#6ee7b7", label: "Flat (<2%)" },
            { color: "#fbbf24", label: "Uphill (2-5%)" },
            { color: "#ef4444", label: "Steep uphill (>5%)" },
        ];
        for (var k = 0; k < levels.length; k++) {
            var icon = document.createElement("i");
            icon.style.background = levels[k].color;
            div.appendChild(icon);
            div.appendChild(document.createTextNode(" " + levels[k].label));
            div.appendChild(document.createElement("br"));
        }
        return div;
    };
    legend.addTo(state.map);

    state.map.on("click", onMapClick);
}

// ── Numbered markers ───────────────────────────────────
function createNumberedMarker(lat, lon, num) {
    var el = document.createElement("div");
    el.style.cssText =
        "background:#2e86de;color:#fff;border:2px solid #fff;border-radius:50%;" +
        "width:28px;height:28px;display:flex;align-items:center;justify-content:center;" +
        "font-size:13px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    el.textContent = num;
    var icon = L.divIcon({ html: el.outerHTML, className: "", iconSize: [28, 28], iconAnchor: [14, 14] });
    return L.marker([lat, lon], { icon: icon, draggable: true }).addTo(state.map);
}

function updateMarkerNumber(marker, num) {
    var el = document.createElement("div");
    el.style.cssText =
        "background:#2e86de;color:#fff;border:2px solid #fff;border-radius:50%;" +
        "width:28px;height:28px;display:flex;align-items:center;justify-content:center;" +
        "font-size:13px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    el.textContent = num;
    marker.setIcon(L.divIcon({ html: el.outerHTML, className: "", iconSize: [28, 28], iconAnchor: [14, 14] }));
}

// ── Autocomplete (Photon) ──────────────────────────────
var autocompleteTimer = null;

function setupAutocomplete() {
    var input = document.getElementById("address-input");
    var list = document.getElementById("autocomplete-list");
    input.addEventListener("input", function () {
        clearTimeout(autocompleteTimer);
        var q = input.value.trim();
        if (q.length < 3) { list.style.display = "none"; return; }
        autocompleteTimer = setTimeout(function () { fetchSuggestions(q); }, 300);
    });
    input.addEventListener("blur", function () {
        setTimeout(function () { list.style.display = "none"; }, 200);
    });
    input.addEventListener("keydown", function (e) {
        if (e.key === "Escape") list.style.display = "none";
    });
}

async function fetchSuggestions(query) {
    var list = document.getElementById("autocomplete-list");
    try {
        var center = state.map ? state.map.getCenter() : { lat: -31.95, lng: 115.86 };
        var resp = await fetch(
            "https://photon.komoot.io/api/?q=" + encodeURIComponent(query) +
            "&limit=5&lat=" + center.lat + "&lon=" + center.lng
        );
        if (!resp.ok) return;
        var data = await resp.json();
        var features = data.features || [];
        while (list.firstChild) list.removeChild(list.firstChild);
        if (features.length === 0) { list.style.display = "none"; return; }

        for (var i = 0; i < features.length; i++) {
            (function (feat) {
                var props = feat.properties;
                var parts = [];
                if (props.name) parts.push(props.name);
                if (props.street) parts.push(props.street);
                if (props.city) parts.push(props.city);
                if (props.state) parts.push(props.state);
                if (props.country) parts.push(props.country);
                var label = parts.join(", ");
                var item = document.createElement("div");
                item.className = "autocomplete-item";
                item.textContent = label;
                item.addEventListener("mousedown", function (e) {
                    e.preventDefault();
                    document.getElementById("address-input").value = label;
                    list.style.display = "none";
                    var coords = feat.geometry.coordinates;
                    goToLocation(coords[1], coords[0]);
                });
                list.appendChild(item);
            })(features[i]);
        }
        list.style.display = "block";
    } catch (e) { console.warn("Autocomplete failed:", e.message); }
}

// ── Geocode (via Photon) ───────────────────────────────
async function geocodeAddress(opts) {
    var q = document.getElementById("address-input").value.trim();
    if (!q) return;
    document.getElementById("autocomplete-list").style.display = "none";
    try {
        var center = state.map ? state.map.getCenter() : { lat: -31.95, lng: 115.86 };
        var resp = await fetch(
            "https://photon.komoot.io/api/?q=" + encodeURIComponent(q) +
            "&limit=1&lat=" + center.lat + "&lon=" + center.lng
        );
        if (!resp.ok) { showBanner("Address not found"); return; }
        var data = await resp.json();
        var features = data.features || [];
        if (features.length === 0) { showBanner("Address not found"); return; }
        var coords = features[0].geometry.coordinates;
        goToLocation(coords[1], coords[0]);
    } catch (e) { showBanner("Geocoding failed: " + e.message); }
}

function goToLocation(lat, lon) {
    state.startLat = lat;
    state.startLon = lon;
    state.map.setView([lat, lon], 15);
    loadPaths(lat, lon).then(function () {
        if (state.graph) addWaypointAt(lat, lon, { exactPosition: true });
    });
}

// ── Load paths (direct Overpass API) ───────────────────
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
    var cacheKey = "paths:" + lat.toFixed(3) + ":" + lon.toFixed(3) + ":" + radius;

    showBanner("Loading paths...", "loading");

    // Check cache
    var cached = cacheGet(cacheKey, PATHS_TTL);
    if (cached) {
        applyPaths(cached);
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
        '  way["highway"="crossing"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="steps"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        ');\nout body;\n>;\nout skel qt;';

    try {
        var resp = await fetch("https://overpass-api.de/api/interpreter", {
            method: "POST",
            body: "data=" + encodeURIComponent(query),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        var raw = await resp.json();
        var geojson = osmToGeoJSON(raw);
        cacheSet(cacheKey, geojson);
        applyPaths(geojson);
        showBanner("");
    } catch (e) {
        showBanner("Failed to load paths: " + e.message);
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

function applyPaths(geojson) {
    state.pathFeatures = geojson;
    if (state.pathLayer) state.map.removeLayer(state.pathLayer);

    var runPaths = ["footway", "cycleway", "path", "pedestrian", "steps"];
    state.pathLayer = L.geoJSON(geojson, {
        style: function (feature) {
            var hw = feature.properties.highway;
            if (runPaths.indexOf(hw) !== -1) return { color: "#6ee7b7", weight: 3, opacity: 0.7 };
            return { color: "#6ee7b7", weight: 1, opacity: 0.15 };
        },
        onEachFeature: function (feature, layer) {
            var p = feature.properties;
            var parts = [];
            if (p.name) parts.push(p.name);
            else parts.push(p.highway || "path");
            if (p.surface) parts.push(p.surface);
            layer.bindTooltip(parts.join(" · "), { sticky: true });
        },
    }).addTo(state.map);

    state.graph = buildGraph(geojson);
    console.log("Graph built: " + Object.keys(state.graph).length + " nodes");
}

// ── Elevation (direct Open-Topo-Data API) ──────────────
async function fetchElevation(points) {
    var results = [];
    var uncached = [];
    var uncachedIdx = [];

    for (var i = 0; i < points.length; i++) {
        var ck = "elev2:" + points[i].lat.toFixed(5) + ":" + points[i].lon.toFixed(5);
        var cached = cacheGet(ck);
        if (cached) { results.push(cached); } else { results.push(null); uncached.push(points[i]); uncachedIdx.push(i); }
    }

    // Open-Meteo elevation API — free, CORS-enabled, no key needed
    for (var b = 0; b < uncached.length; b += 100) {
        var batch = uncached.slice(b, b + 100);
        var lats = batch.map(function (p) { return p.lat.toFixed(5); }).join(",");
        var lons = batch.map(function (p) { return p.lon.toFixed(5); }).join(",");
        try {
            var resp = await fetch("https://api.open-meteo.com/v1/elevation?latitude=" + lats + "&longitude=" + lons);
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            var data = await resp.json();
            var elevArr = data.elevation || [];
            for (var j = 0; j < elevArr.length; j++) {
                var elev = elevArr[j] != null ? elevArr[j] : 0;
                var entry = { lat: batch[j].lat, lon: batch[j].lon, elevation: elev };
                results[uncachedIdx[b + j]] = entry;
                if (elevArr[j] != null) {
                    cacheSet("elev2:" + entry.lat.toFixed(5) + ":" + entry.lon.toFixed(5), entry);
                }
            }
        } catch (e) {
            console.warn("Elevation batch failed:", e.message);
            for (var j = 0; j < batch.length; j++) {
                if (!results[uncachedIdx[b + j]]) results[uncachedIdx[b + j]] = { lat: batch[j].lat, lon: batch[j].lon, elevation: 0 };
            }
        }
    }
    return results;
}

// ── Waypoints ──────────────────────────────────────────
function onMapClick(e) { addWaypointAt(e.latlng.lat, e.latlng.lng); }

async function addWaypointAt(lat, lon, opts) {
    // Auto-load paths if we don't have coverage here
    if (!state.graph) {
        await loadPaths(lat, lon);
        if (!state.graph) { showBanner("Could not load paths for this area"); return; }
    }
    var nk = closestNode(state.graph, lat, lon);
    if (!nk) return;
    // If closest node is >200m away, we probably need more paths
    var nkParts = nk.split(",");
    var snapDist = haversine(lat, lon, parseFloat(nkParts[0]), parseFloat(nkParts[1]));
    if (snapDist > 200) {
        await loadPaths(lat, lon);
        nk = closestNode(state.graph, lat, lon);
        if (!nk) return;
    }
    var parts = nk.split(",");
    var snapLat = parseFloat(parts[0]), snapLon = parseFloat(parts[1]);
    var displayLat = (opts && opts.exactPosition) ? lat : snapLat;
    var displayLon = (opts && opts.exactPosition) ? lon : snapLon;
    var num = state.waypoints.length + 1;
    var marker = createNumberedMarker(displayLat, displayLon, num);

    marker.on("click", function (ev) {
        L.DomEvent.stopPropagation(ev);
        var idx = -1;
        for (var w = 0; w < state.waypoints.length; w++) { if (state.waypoints[w].marker === marker) { idx = w; break; } }
        removeWaypoint(idx);
    });
    marker.on("dragend", function () {
        var pos = marker.getLatLng();
        var newKey = closestNode(state.graph, pos.lat, pos.lng);
        if (newKey) {
            var p = newKey.split(",");
            marker.setLatLng([parseFloat(p[0]), parseFloat(p[1])]);
            for (var w = 0; w < state.waypoints.length; w++) {
                if (state.waypoints[w].marker === marker) {
                    state.waypoints[w].lat = parseFloat(p[0]);
                    state.waypoints[w].lon = parseFloat(p[1]);
                    state.waypoints[w].nodeKey = newKey;
                    break;
                }
            }
        }
        updateRoute();
    });

    state.waypoints.push({ lat: displayLat, lon: displayLon, marker: marker, nodeKey: nk });
    updateRoute();
}

function removeWaypoint(idx) {
    if (idx < 0 || idx >= state.waypoints.length) return;
    state.map.removeLayer(state.waypoints[idx].marker);
    state.waypoints.splice(idx, 1);
    for (var i = 0; i < state.waypoints.length; i++) updateMarkerNumber(state.waypoints[i].marker, i + 1);
    updateRoute();
}

// ── Route drawing ──────────────────────────────────────
function updateRoute() {
    for (var r = 0; r < state.routeLines.length; r++) state.map.removeLayer(state.routeLines[r]);
    state.routeLines = [];
    state.routeSegments = [];
    if (state.closingLine) { state.map.removeLayer(state.closingLine); state.closingLine = null; }
    for (var g = 0; g < state.gradientLines.length; g++) state.map.removeLayer(state.gradientLines[g]);
    state.gradientLines = [];
    if (state.routeOutline) { state.map.removeLayer(state.routeOutline); state.routeOutline = null; }

    if (state.waypoints.length < 2) { updateDistance(); updateElevation([]); return; }

    var allRouteCoords = [];
    var routeOk = true;

    for (var i = 1; i < state.waypoints.length; i++) {
        var result = dijkstra(state.graph, state.waypoints[i-1].nodeKey, state.waypoints[i].nodeKey);
        if (result && result.path.length > 1) {
            var segCoords = pathToCoords(result.path);
            state.routeSegments.push(segCoords);
            var line = L.polyline(segCoords, { color: "#2e86de", weight: 5, opacity: 0.9 }).addTo(state.map);
            state.routeLines.push(line);
            if (allRouteCoords.length === 0) allRouteCoords.push.apply(allRouteCoords, segCoords);
            else allRouteCoords.push.apply(allRouteCoords, segCoords.slice(1));
        } else {
            var from = state.waypoints[i-1], to = state.waypoints[i];
            var fallback = [[from.lat, from.lon], [to.lat, to.lon]];
            state.routeSegments.push(fallback);
            var line = L.polyline(fallback, { color: "#ef4444", weight: 3, opacity: 0.7, dashArray: "8 8" }).addTo(state.map);
            state.routeLines.push(line);
            if (allRouteCoords.length === 0) allRouteCoords.push.apply(allRouteCoords, fallback);
            else allRouteCoords.push.apply(allRouteCoords, fallback.slice(1));
            routeOk = false;
        }
    }

    if (state.mode === "loop" && state.waypoints.length >= 2) {
        var closeResult = dijkstra(state.graph, state.waypoints[state.waypoints.length-1].nodeKey, state.waypoints[0].nodeKey);
        if (closeResult && closeResult.path.length > 1) {
            var closeCoords = pathToCoords(closeResult.path);
            state.closingLine = L.polyline(closeCoords, { color: "#2e86de", weight: 5, opacity: 0.6, dashArray: "10 6" }).addTo(state.map);
            allRouteCoords.push.apply(allRouteCoords, closeCoords.slice(1));
        } else {
            var last = state.waypoints[state.waypoints.length-1], first = state.waypoints[0];
            state.closingLine = L.polyline([[last.lat,last.lon],[first.lat,first.lon]], { color: "#ef4444", weight: 3, opacity: 0.5, dashArray: "8 8" }).addTo(state.map);
        }
    }

    // Dark outline
    if (allRouteCoords.length >= 2) {
        state.routeOutline = L.polyline(allRouteCoords, { color: "#1a1a2e", weight: 9, opacity: 0.85, lineCap: "round", lineJoin: "round" }).addTo(state.map);
        state.routeOutline.bringToBack();
        for (var rl = 0; rl < state.routeLines.length; rl++) state.routeLines[rl].bringToFront();
        if (state.closingLine) state.closingLine.bringToFront();
    }

    if (!routeOk) showBanner("Some segments have no footpath connection (shown in red)");
    else showBanner("");

    updateDistance();
    fetchRouteElevation(allRouteCoords);
}

// ── Distance ───────────────────────────────────────────
function updateDistance() {
    var total = 0;
    for (var s = 0; s < state.routeSegments.length; s++) {
        var seg = state.routeSegments[s];
        for (var i = 1; i < seg.length; i++) total += haversine(seg[i-1][0], seg[i-1][1], seg[i][0], seg[i][1]);
    }
    if (state.mode === "loop" && state.closingLine) {
        var cl = state.closingLine.getLatLngs();
        for (var i = 1; i < cl.length; i++) total += haversine(cl[i-1].lat, cl[i-1].lng, cl[i].lat, cl[i].lng);
    } else if (state.mode === "outback") { total *= 2; }

    state.totalDistMetres = total;
    document.getElementById("distance-display").textContent = (total / 1000).toFixed(1) + " km";
    updateEstimatedTime();
    updateDistanceMarkers();
}

function updateEstimatedTime() {
    var paceStr = document.getElementById("pace-input").value.trim();
    var timeEl = document.getElementById("time-display");
    if (!paceStr || state.totalDistMetres < 100) { timeEl.textContent = ""; return; }
    var pace;
    if (paceStr.indexOf(":") !== -1) {
        var p = paceStr.split(":");
        pace = parseInt(p[0]) + parseInt(p[1] || 0) / 60;
    } else { pace = parseFloat(paceStr); }
    if (isNaN(pace) || pace <= 0) { timeEl.textContent = ""; return; }
    var totalMin = (state.totalDistMetres / 1000) * pace;
    var hrs = Math.floor(totalMin / 60), mins = Math.round(totalMin % 60);
    timeEl.textContent = hrs > 0 ? "~" + hrs + "h " + (mins < 10 ? "0" : "") + mins + "m" : "~" + mins + "m";
}

// ── Distance markers ───────────────────────────────────
function updateDistanceMarkers() {
    for (var m = 0; m < state.distanceMarkers.length; m++) state.map.removeLayer(state.distanceMarkers[m]);
    state.distanceMarkers = [];
    if (state.totalDistMetres < 1000) return;

    var coords = [];
    for (var s = 0; s < state.routeSegments.length; s++) {
        var seg = state.routeSegments[s];
        var start = coords.length === 0 ? 0 : 1;
        for (var ci = start; ci < seg.length; ci++) coords.push(seg[ci]);
    }
    if (state.mode === "loop" && state.closingLine) {
        var cl = state.closingLine.getLatLngs();
        for (var ci = 1; ci < cl.length; ci++) coords.push([cl[ci].lat, cl[ci].lng]);
    }
    if (coords.length < 2) return;

    var accumulated = 0, nextKm = 1000;
    for (var i = 1; i < coords.length; i++) {
        var d = haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
        accumulated += d;
        while (accumulated >= nextKm) {
            var ratio = 1 - (accumulated - nextKm) / d;
            var lat = coords[i-1][0] + ratio * (coords[i][0] - coords[i-1][0]);
            var lon = coords[i-1][1] + ratio * (coords[i][1] - coords[i-1][1]);
            var el = document.createElement("div");
            el.style.cssText = "background:#fff;color:#1a1d28;border-radius:8px;padding:1px 5px;font-size:10px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,0.5);";
            el.textContent = (nextKm/1000) + "k";
            var mkr = L.marker([lat, lon], {
                icon: L.divIcon({ html: el.outerHTML, className: "", iconSize: [30,16], iconAnchor: [15,8] }),
                interactive: false, zIndexOffset: -100,
            }).addTo(state.map);
            state.distanceMarkers.push(mkr);
            nextKm += 1000;
        }
    }
}

// ── Elevation profile ──────────────────────────────────
async function fetchRouteElevation(coords) {
    if (coords.length < 2) { updateElevation([]); return; }
    var sampled = sampleRoute(coords, 50);
    var locations = sampled.map(function (p) { return { lat: p[0], lon: p[1] }; });
    if (locations.length === 0) { updateElevation([]); return; }

    try {
        var results = await fetchElevation(locations);
        updateElevation(results);
        colourRouteByGradient(results);
    } catch (e) {
        console.warn("Elevation fetch failed:", e.message);
        updateElevation([]);
    }
}

function sampleRoute(coords, intervalMetres) {
    var points = [coords[0]], accumulated = 0;
    for (var i = 1; i < coords.length; i++) {
        var d = haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
        accumulated += d;
        if (accumulated >= intervalMetres) { points.push(coords[i]); accumulated = 0; }
    }
    var last = coords[coords.length-1], lastS = points[points.length-1];
    if (last[0] !== lastS[0] || last[1] !== lastS[1]) points.push(last);
    return points;
}

function colourRouteByGradient(elevData) {
    if (elevData.length < 2) return;
    for (var r = 0; r < state.routeLines.length; r++) state.map.removeLayer(state.routeLines[r]);
    state.routeLines = [];
    if (state.closingLine) { state.map.removeLayer(state.closingLine); state.closingLine = null; }

    var outlineCoords = elevData.map(function (e) { return [e.lat, e.lon]; });
    if (state.routeOutline) state.map.removeLayer(state.routeOutline);
    state.routeOutline = L.polyline(outlineCoords, { color: "#1a1a2e", weight: 9, opacity: 0.85, lineCap: "round", lineJoin: "round" }).addTo(state.map);

    for (var i = 1; i < elevData.length; i++) {
        var prev = elevData[i-1], curr = elevData[i];
        var dist = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
        var color = "#6ee7b7";
        if (dist > 0) {
            var gradePct = ((curr.elevation - prev.elevation) / dist) * 100;
            if (gradePct > 5) color = "#ef4444";
            else if (gradePct > 2) color = "#fbbf24";
            else if (gradePct < -5) color = "#60a5fa";
            else if (gradePct < -2) color = "#93c5fd";
        }
        var seg = L.polyline([[prev.lat,prev.lon],[curr.lat,curr.lon]], { color: color, weight: 5, opacity: 1, lineCap: "round", lineJoin: "round" }).addTo(state.map);
        state.gradientLines.push(seg);
    }
}

function updateElevation(elevData) {
    var container = document.getElementById("elevation-container");
    var statsEl = document.getElementById("elevation-stats");
    if (elevData.length < 2) { container.style.display = "none"; statsEl.style.display = "none"; return; }

    container.style.display = "block";
    statsEl.style.display = "flex";

    var distances = [0];
    for (var i = 1; i < elevData.length; i++) {
        distances.push(distances[i-1] + haversine(elevData[i-1].lat, elevData[i-1].lon, elevData[i].lat, elevData[i].lon));
    }
    var elevations = elevData.map(function (e) { return e.elevation; });

    var totalAscent = 0, totalDescent = 0, maxGradient = 0;
    for (var i = 1; i < elevations.length; i++) {
        var diff = elevations[i] - elevations[i-1];
        if (diff > 0) totalAscent += diff; else totalDescent += Math.abs(diff);
        var segDist = distances[i] - distances[i-1];
        if (segDist > 0) { var g = (Math.abs(diff) / segDist) * 100; if (g > maxGradient) maxGradient = g; }
    }
    document.getElementById("stat-ascent").textContent = Math.round(totalAscent) + "m";
    document.getElementById("stat-descent").textContent = Math.round(totalDescent) + "m";
    document.getElementById("stat-gradient").textContent = maxGradient.toFixed(1) + "%";

    var ctx = document.getElementById("elevation-canvas").getContext("2d");
    if (state.elevationChart) state.elevationChart.destroy();
    state.elevationChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: distances.map(function (d) { return (d/1000).toFixed(1); }),
            datasets: [{ data: elevations, borderColor: "#6ee7b7", backgroundColor: "rgba(110,231,183,0.1)", fill: true, pointRadius: 0, tension: 0.3, borderWidth: 2 }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { title: { display: true, text: "Distance (km)", color: "#888" }, ticks: { color: "#888", maxTicksLimit: 10 }, grid: { color: "#1a1a2e" } },
                y: { title: { display: true, text: "Elevation (m)", color: "#888" }, ticks: { color: "#888" }, grid: { color: "#1a1a2e" } },
            },
        },
    });
}

// ── GPX export ─────────────────────────────────────────
function exportGPX() {
    if (state.routeSegments.length === 0) return;
    var coords = [];
    for (var s = 0; s < state.routeSegments.length; s++) {
        var seg = state.routeSegments[s];
        if (coords.length === 0) coords.push.apply(coords, seg);
        else coords.push.apply(coords, seg.slice(1));
    }
    if (state.mode === "loop" && state.closingLine) {
        var cl = state.closingLine.getLatLngs();
        for (var i = 1; i < cl.length; i++) coords.push([cl[i].lat, cl[i].lng]);
    }
    if (state.mode === "outback" && coords.length > 1) {
        coords = coords.concat(coords.slice().reverse().slice(1));
    }
    var km = document.getElementById("distance-display").textContent.replace(" km","");
    var date = new Date().toISOString().split("T")[0];
    var name = "legwork-" + date + "-" + km + "km";
    var gpx = ['<?xml version="1.0" encoding="UTF-8"?>','<gpx version="1.1" creator="Legwork" xmlns="http://www.topografix.com/GPX/1/1">','  <trk>','    <name>'+name+'</name>','    <trkseg>'];
    for (var i = 0; i < coords.length; i++) gpx.push('      <trkpt lat="'+coords[i][0]+'" lon="'+coords[i][1]+'"></trkpt>');
    gpx.push('    </trkseg>','  </trk>','</gpx>');
    var blob = new Blob([gpx.join("\n")], { type: "application/gpx+xml" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = name + ".gpx"; a.click();
    URL.revokeObjectURL(url);
}

// ── Utils ──────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = function(x) { return x * Math.PI / 180; };
    var dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function showBanner(msg, type) {
    var el = document.getElementById("info-banner");
    el.textContent = msg;
    el.className = "info-banner" + (type ? " " + type : " error");
    el.style.display = msg ? "block" : "none";
}

// ── Event bindings ─────────────────────────────────────
document.getElementById("geocode-btn").addEventListener("click", function () { geocodeAddress(); });
document.getElementById("address-input").addEventListener("keydown", function (e) { if (e.key === "Enter") geocodeAddress(); });
document.getElementById("mode-toggle").addEventListener("change", function (e) {
    state.mode = e.target.checked ? "outback" : "loop";
    document.getElementById("mode-label").textContent = e.target.checked ? "Out & Back" : "Loop";
    updateRoute();
});
document.getElementById("pace-input").addEventListener("input", updateEstimatedTime);
document.getElementById("reverse-btn").addEventListener("click", function () {
    if (state.waypoints.length < 2) return;
    state.waypoints.reverse();
    for (var i = 0; i < state.waypoints.length; i++) updateMarkerNumber(state.waypoints[i].marker, i + 1);
    updateRoute();
});
document.getElementById("clear-btn").addEventListener("click", function () {
    for (var i = 0; i < state.waypoints.length; i++) state.map.removeLayer(state.waypoints[i].marker);
    state.waypoints = [];
    updateRoute();
});
document.getElementById("export-btn").addEventListener("click", exportGPX);
document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (state.waypoints.length > 1) removeWaypoint(state.waypoints.length - 1);
    }
});

// ── Share link ─────────────────────────────────────────
function updateShareHash() {
    if (state.waypoints.length < 2) { history.replaceState(null, "", window.location.pathname); return; }
    var pts = state.waypoints.map(function (wp) { return wp.lat.toFixed(5) + "," + wp.lon.toFixed(5); });
    history.replaceState(null, "", "#r=" + pts.join(";") + "&m=" + state.mode);
}

function loadFromHash() {
    var hash = window.location.hash.replace("#", "");
    if (!hash) return false;
    var params = {};
    hash.split("&").forEach(function (part) { var kv = part.split("="); params[kv[0]] = kv[1]; });
    if (!params.r) return false;
    var points = params.r.split(";").map(function (p) {
        var parts = p.split(",");
        return { lat: parseFloat(parts[0]), lon: parseFloat(parts[1]) };
    });
    if (points.length < 2) return false;
    if (params.m === "outback" || params.m === "loop") {
        state.mode = params.m;
        if (params.m === "outback") {
            document.getElementById("mode-toggle").checked = true;
            document.getElementById("mode-label").textContent = "Out & Back";
        }
    }
    return points;
}

var _origUpdateRoute = updateRoute;
updateRoute = function () { _origUpdateRoute(); updateShareHash(); };

// ── Welcome modal ──────────────────────────────────────
function showWelcome() {
    var modal = document.getElementById("welcome-modal");
    if (localStorage.getItem("lw:welcomed")) {
        modal.classList.add("hidden");
        return;
    }
    document.getElementById("welcome-dismiss").addEventListener("click", function () {
        modal.classList.add("hidden");
        localStorage.setItem("lw:welcomed", "1");
    });
}

// ── Boot ───────────────────────────────────────────────
initMap();
setupAutocomplete();
showWelcome();

var sharedPoints = loadFromHash();
if (sharedPoints) {
    var center = sharedPoints[0];
    state.map.setView([center.lat, center.lon], 14);
    loadPaths(center.lat, center.lon).then(function () {
        for (var i = 0; i < sharedPoints.length; i++) addWaypointAt(sharedPoints[i].lat, sharedPoints[i].lon, { exactPosition: i === 0 });
    });
} else if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
        function (pos) {
            state.map.setView([pos.coords.latitude, pos.coords.longitude], 15);
            document.getElementById("address-input").placeholder = "Current location — or type an address";
            loadPaths(pos.coords.latitude, pos.coords.longitude).then(function () {
                if (state.graph) addWaypointAt(pos.coords.latitude, pos.coords.longitude, { exactPosition: true });
            });
        },
        function () { /* no location — user types address */ },
        { enableHighAccuracy: true, timeout: 5000 }
    );
}

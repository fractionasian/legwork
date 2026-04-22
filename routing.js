// ── Legwork routing — pure-ish domain module ─────────
// No DOM, no fetch, no app state object. Stateful only via spatialGrid, which
// is built up by gridInsert() during graph construction in tiles.js.
// Loaded before storage.js, tiles.js, app.js.

function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = function (x) { return x * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Road-type multipliers — Dijkstra favours footpaths/quiet streets over busy roads.
// Displayed distance still uses raw haversine.
var ROAD_WEIGHT = {
    footway: 1.0, path: 1.0, cycleway: 1.0, pedestrian: 1.0, crossing: 1.0,
    living_street: 1.1, residential: 1.1,
    service: 1.2, unclassified: 1.2,
    tertiary: 1.3, tertiary_link: 1.3,
    steps: 1.5,
    secondary: 1.6, secondary_link: 1.6,
    primary: 2.0, primary_link: 2.0,
    trunk: 2.5, trunk_link: 2.5,
};

// Runner-friendly preference nudges — see docs/design/route-preferences.md.
// Combines multiplicatively with ROAD_WEIGHT. Default-on, no UI.
var PATHLIKE_HIGHWAYS = { footway: 1, path: 1, cycleway: 1, pedestrian: 1, track: 1 };
var SOFT_SURFACES = { ground: 1, dirt: 1, grass: 1, compacted: 1, gravel: 1, unpaved: 1, fine_gravel: 1, earth: 1 };

function wayPrefMultiplier(highway, surface, name) {
    var m = 1;
    // P1 — named trail on a foot/path-class way
    if (name && PATHLIKE_HIGHWAYS[highway]) m *= 0.85;
    // P5 — soft surface on a path-class way
    if (PATHLIKE_HIGHWAYS[highway] && SOFT_SURFACES[surface]) m *= 0.95;
    return m;
}

function nodePrefMultiplier(attrs) {
    if (!attrs) return 1;
    // P4 — barrier on the path: strongest penalty
    if (attrs.barrier) return 1.25;
    // P3 — marked crossing (zebra/signals/marked) favoured
    if (attrs.crossingMarked) return 0.9;
    // P2 — bare traffic signal (not paired with a pedestrian crossing)
    if (attrs.trafficSignal) return 1.15;
    // Unmarked crossings are neutral — no nudge.
    return 1;
}

function nodeKey(lat, lon) {
    return lat.toFixed(6) + "," + lon.toFixed(6);
}

function pathToCoords(path) {
    var coords = [];
    for (var i = 0; i < path.length; i++) {
        var parts = path[i].split(",");
        coords.push([parseFloat(parts[0]), parseFloat(parts[1])]);
    }
    return coords;
}

// ── Binary min-heap for Dijkstra ──────────────────────
function MinHeap() {
    this.data = [];
}
MinHeap.prototype.push = function (item) {
    this.data.push(item);
    var i = this.data.length - 1;
    while (i > 0) {
        var parent = (i - 1) >> 1;
        if (this.data[parent].d <= this.data[i].d) break;
        var tmp = this.data[parent]; this.data[parent] = this.data[i]; this.data[i] = tmp;
        i = parent;
    }
};
MinHeap.prototype.pop = function () {
    var top = this.data[0];
    var last = this.data.pop();
    if (this.data.length > 0) {
        this.data[0] = last;
        var i = 0, len = this.data.length;
        while (true) {
            var left = 2 * i + 1, right = 2 * i + 2, smallest = i;
            if (left < len && this.data[left].d < this.data[smallest].d) smallest = left;
            if (right < len && this.data[right].d < this.data[smallest].d) smallest = right;
            if (smallest === i) break;
            var tmp = this.data[smallest]; this.data[smallest] = this.data[i]; this.data[i] = tmp;
            i = smallest;
        }
    }
    return top;
};
MinHeap.prototype.size = function () { return this.data.length; };

function dijkstra(graph, startKey, endKey) {
    if (!graph[startKey] || !graph[endKey]) return null;
    if (startKey === endKey) return { dist: 0, path: [startKey] };
    var dist = {}, prev = {}, visited = {};
    var heap = new MinHeap();
    dist[startKey] = 0;
    heap.push({ key: startKey, d: 0 });
    while (heap.size() > 0) {
        var current = heap.pop();
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
                heap.push({ key: nb.key, d: newDist });
            }
        }
    }
    if (dist[endKey] === undefined) return null;
    var path = [];
    var cur = endKey;
    while (cur) { path.unshift(cur); cur = prev[cur]; }
    return { dist: dist[endKey], path: path };
}

// ── Spatial grid for fast nearest-node lookup ─────────
var GRID_CELL = 0.005; // ~500m cells
var spatialGrid = {};

function gridKey(lat, lon) {
    return (Math.floor(lat / GRID_CELL) * GRID_CELL).toFixed(4) + ":" + (Math.floor(lon / GRID_CELL) * GRID_CELL).toFixed(4);
}

function gridInsert(nk, lat, lon) {
    var gk = gridKey(lat, lon);
    if (!spatialGrid[gk]) spatialGrid[gk] = [];
    spatialGrid[gk].push({ key: nk, lat: lat, lon: lon });
}

function closestNode(graph, lat, lon) {
    var bestKey = null, bestDist = Infinity;
    var cLat = Math.floor(lat / GRID_CELL) * GRID_CELL;
    var cLon = Math.floor(lon / GRID_CELL) * GRID_CELL;
    // Expand outward from a 3x3 window. Stop once the inner ring yields a hit —
    // OSM node density means the answer is almost always in the first ring. Caps
    // at ±7 cells (~3.5km) to prevent runaway scans in sparse areas.
    function ring(radius) {
        for (var dLat = -radius; dLat <= radius; dLat++) {
            for (var dLon = -radius; dLon <= radius; dLon++) {
                if (radius > 1 && Math.abs(dLat) !== radius && Math.abs(dLon) !== radius) continue;
                var gk = (cLat + dLat * GRID_CELL).toFixed(4) + ":" + (cLon + dLon * GRID_CELL).toFixed(4);
                var bucket = spatialGrid[gk];
                if (!bucket) continue;
                for (var i = 0; i < bucket.length; i++) {
                    var d = haversine(lat, lon, bucket[i].lat, bucket[i].lon);
                    if (d < bestDist) { bestDist = d; bestKey = bucket[i].key; }
                }
            }
        }
    }
    for (var r = 1; r <= 7 && !bestKey; r++) ring(r);
    return bestKey;
}

// ── OSM / tile format converters ──────────────────────
function osmToGeoJSON(data) {
    // Overpass returns nodes before ways (out body; >; out body qt;), so one
    // pass is enough. When the query emits `out body qt` for nodes (vs skel),
    // node tags come through — we extract the ones that influence routing
    // preferences (barriers, crossings, traffic signals) into a keyed sidecar.
    var nodes = {}, nodeAttrs = {}, ways = [];
    var elements = data.elements || [];
    for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        if (el.type === "node") {
            nodes[el.id] = [el.lon, el.lat];
            if (el.tags) {
                var a = nodeAttrsFromTags(el.tags);
                if (a) nodeAttrs[nodeKey(el.lat, el.lon)] = a;
            }
        } else if (el.type === "way") {
            ways.push(el);
        }
    }
    var features = [];
    for (var w = 0; w < ways.length; w++) {
        var el = ways[w];
        var refs = el.nodes || [];
        var coords = [];
        for (var j = 0; j < refs.length; j++) {
            if (nodes[refs[j]]) coords.push(nodes[refs[j]]);
        }
        if (coords.length < 2) continue;
        var tags = el.tags || {};
        features.push({
            type: "Feature",
            properties: { id: el.id, highway: tags.highway || "", surface: tags.surface || "", name: tags.name || "" },
            geometry: { type: "LineString", coordinates: coords },
        });
    }
    return { type: "FeatureCollection", features: features, nodeAttrs: nodeAttrs };
}

// Compact per-node routing-relevant flags. Returns null if no flags apply
// (keeps the sidecar small for the 95% of nodes that don't matter).
function nodeAttrsFromTags(tags) {
    var attrs = {};
    var any = false;
    if (tags.barrier === "gate" || tags.barrier === "stile" ||
        tags.barrier === "kissing_gate" || tags.barrier === "turnstile") {
        attrs.barrier = true; any = true;
    }
    if (tags.highway === "traffic_signals") { attrs.trafficSignal = true; any = true; }
    if (tags.highway === "crossing" || tags["footway"] === "crossing") {
        var c = tags.crossing || "";
        if (c === "traffic_signals" || c === "marked" || c === "zebra" || c === "uncontrolled") {
            attrs.crossingMarked = true; any = true;
        } else {
            attrs.crossingUnmarked = true; any = true;
        }
    }
    return any ? attrs : null;
}

function compactToGeoJSON(data) {
    // Accepts either format emitted by build-tiles.js:
    //   v1 (legacy): bare Array of [id, highway, name, coords]
    //   v2:          { v:2, features: [[id, highway, name, coords, surface?], ...], nodeAttrs: {...} }
    // Returns a FeatureCollection plus an optional `nodeAttrs` sidecar (same
    // shape as osmToGeoJSON) so applyPaths can merge it into state.nodeAttrs.
    var compact, nodeAttrs;
    if (Array.isArray(data)) {
        compact = data;
        nodeAttrs = null;
    } else {
        compact = data.features || [];
        nodeAttrs = data.nodeAttrs || null;
    }
    var features = [];
    for (var i = 0; i < compact.length; i++) {
        var c = compact[i];
        features.push({
            type: "Feature",
            properties: {
                id: c[0],
                highway: c[1],
                name: c[2] || "",
                surface: c[4] || "", // v2 adds surface as optional 5th element; v1 leaves it empty
            },
            geometry: { type: "LineString", coordinates: c[3] },
        });
    }
    var fc = { type: "FeatureCollection", features: features };
    if (nodeAttrs) fc.nodeAttrs = nodeAttrs;
    return fc;
}

// ── Route sampling + elevation smoothing ──────────────
function sampleRoute(coords, intervalMetres) {
    var points = [coords[0]], accumulated = 0;
    for (var i = 1; i < coords.length; i++) {
        var d = haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
        accumulated += d;
        if (accumulated >= intervalMetres) { points.push(coords[i]); accumulated = 0; }
    }
    var last = coords[coords.length - 1], lastS = points[points.length - 1];
    if (last[0] !== lastS[0] || last[1] !== lastS[1]) points.push(last);
    return points;
}

function smoothElevations(elevData) {
    if (elevData.length < 2) return elevData;
    var alpha = 0.6;
    var smoothed = [elevData[0]];
    for (var i = 1; i < elevData.length; i++) {
        var prev = smoothed[i-1].elevation;
        var curr = elevData[i].elevation;
        smoothed.push({ lat: elevData[i].lat, lon: elevData[i].lon, elevation: alpha * curr + (1 - alpha) * prev });
    }
    for (var i = smoothed.length - 2; i >= 0; i--) {
        smoothed[i] = { lat: smoothed[i].lat, lon: smoothed[i].lon, elevation: alpha * smoothed[i].elevation + (1 - alpha) * smoothed[i+1].elevation };
    }
    return smoothed;
}

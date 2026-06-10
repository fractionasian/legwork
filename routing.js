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

// Stable string identifier for a waypoint sequence — used for dedup of
// auto-saved shared routes. 5-decimal precision (~1m), order-sensitive.
function waypointHash(waypoints) {
    return JSON.stringify(waypoints.map(function (wp) {
        return [wp.lat.toFixed(5), wp.lon.toFixed(5)];
    }));
}

// Road-type multipliers — Dijkstra favours footpaths/quiet streets over busy roads.
// Displayed distance still uses raw haversine.
var ROAD_WEIGHT = {
    footway: 1.0, path: 1.0, cycleway: 1.0, pedestrian: 1.0, crossing: 1.0,
    track: 1.0, bridleway: 1.0, byway: 1.0,
    living_street: 1.1, residential: 1.1,
    service: 1.2, unclassified: 1.2,
    tertiary: 1.3, tertiary_link: 1.3,
    steps: 1.5,
    secondary: 1.6, secondary_link: 1.6,
    primary: 2.0, primary_link: 2.0,
    trunk: 2.5, trunk_link: 2.5,
};

// Cycling weights: cycleways preferred, primary tolerated, steps soft-banned,
// soft surfaces mildly penalised (commuter-leaning, not MTB).
var BIKE_ROAD_WEIGHT = {
    cycleway: 0.8,
    path: 1.0, track: 1.0, bridleway: 1.1, byway: 1.1, crossing: 1.0,
    living_street: 1.0, residential: 1.0,
    footway: 1.2, pedestrian: 1.2,
    service: 1.1, unclassified: 1.1,
    tertiary: 1.15, tertiary_link: 1.15,
    secondary: 1.3, secondary_link: 1.3,
    primary: 1.6, primary_link: 1.6,
    trunk: 2.2, trunk_link: 2.2,
    steps: 5.0,
};

// Runner-friendly preference nudges — see docs/design/route-preferences.md.
// Combines multiplicatively with ROAD_WEIGHT. Default-on, no UI.
var PATHLIKE_HIGHWAYS = { footway: 1, path: 1, cycleway: 1, pedestrian: 1, track: 1, bridleway: 1, byway: 1 };
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

function bikeWayPrefMultiplier(highway, surface, _name) {
    // Soft surfaces mildly penalised on path-class ways (commuter assumption).
    // Named-trail bonus dropped: cyclists don't get the same coastal-trail benefit.
    if (PATHLIKE_HIGHWAYS[highway] && SOFT_SURFACES[surface]) return 1.05;
    return 1;
}

function bikeNodePrefMultiplier(attrs) {
    if (!attrs) return 1;
    // Barriers are worse for bikes — kissing gates and stiles need dismount.
    if (attrs.barrier) return 1.4;
    if (attrs.crossingMarked) return 0.9;
    if (attrs.trafficSignal) return 1.15;
    return 1;
}

function routingProfile(name) {
    if (name === "bike") {
        return {
            roadWeight: BIKE_ROAD_WEIGHT,
            wayPref: bikeWayPrefMultiplier,
            nodePref: bikeNodePrefMultiplier,
            defaultWeight: 1.15,
        };
    }
    return {
        roadWeight: ROAD_WEIGHT,
        wayPref: wayPrefMultiplier,
        nodePref: nodePrefMultiplier,
        defaultWeight: 1.2,
    };
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

// Geometric (on-the-ground) length of a node-key path in metres. Distinct from
// dijkstra's result.dist, which is the WEIGHTED cost (haversine × road weight ×
// node multipliers) — comparing that against a straight-line distance overstates
// detours on penalised surfaces (trunk ×2.5, bike-over-steps ×5) and falsely
// triggers gap-fill refetches.
function pathGeomLength(path) {
    var total = 0;
    var prev = null;
    for (var i = 0; i < path.length; i++) {
        var parts = path[i].split(",");
        var lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
        if (prev) total += haversine(prev[0], prev[1], lat, lon);
        prev = [lat, lon];
    }
    return total;
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
    // push+reverse, not unshift: unshift is O(n) per call → O(n²) reconstruction
    // on long paths (thousands of nodes on a 20 km leg).
    while (cur) { path.push(cur); cur = prev[cur]; }
    path.reverse();
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

function resetSpatialGrid() {
    spatialGrid = {};
}

function closestNode(graph, lat, lon) {
    var bestKey = null, bestDist = Infinity;
    var cLat = Math.floor(lat / GRID_CELL) * GRID_CELL;
    var cLon = Math.floor(lon / GRID_CELL) * GRID_CELL;
    // Expand outward ring by ring from the centre cell. Caps at ±7 cells
    // (~3.5km) to prevent runaway scans in sparse areas.
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
    // Don't stop at the first ring with a hit: a node just across the boundary
    // in ring r+1 can be closer than one at the far edge of ring r. Scan one
    // extra ring past the first hit before committing to the nearest node.
    var foundAt = -1;
    for (var r = 1; r <= 7; r++) {
        ring(r);
        if (bestKey && foundAt < 0) foundAt = r;
        if (foundAt >= 0 && r >= foundAt + 1) break;
    }
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

// ── Terrarium tile math ────────────────────────────────
// Convert (lat, lon, zoom) to slippy-map tile XYZ + pixel-space (px, py)
// within that tile's 256×256 raster. Used to look up elevation in
// pre-rendered Terrarium PNG tiles served by AWS Open Data Programme.
function tileCoords(lat, lon, z) {
    var n = Math.pow(2, z);
    var x = (lon + 180) / 360 * n;
    var latRad = lat * Math.PI / 180;
    var y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    var xtile = Math.floor(x), ytile = Math.floor(y);
    return { xtile: xtile, ytile: ytile, px: (x - xtile) * 256, py: (y - ytile) * 256 };
}

// Decode a single Terrarium pixel (R, G, B) to metres above WGS84 ellipsoid.
// Encoding: elev = (R*256 + G + B/256) - 32768. See
// https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium
function decodeTerrarium(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}

// Bilinear interpolation. getPixel(x, y) returns the elevation at integer
// pixel (x, y). px, py are fractional coordinates. The caller is responsible
// for clamping or providing cross-tile getPixel — we just blend.
function bilinearSample(getPixel, px, py) {
    var x0 = Math.floor(px), y0 = Math.floor(py);
    var x1 = x0 + 1, y1 = y0 + 1;
    var fx = px - x0, fy = py - y0;
    var a = getPixel(x0, y0), b = getPixel(x1, y0);
    var c = getPixel(x0, y1), d = getPixel(x1, y1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

// Median filter — window must be odd. Replaces each value with the median of
// itself and its (window-1)/2 neighbours on each side. Edges shrink the
// window symmetrically (a value at index 0 with window=9 uses neighbours 0–4).
function medianFilter(arr, window) {
    var half = Math.floor(window / 2);
    var out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
        var lo = Math.max(0, i - half);
        var hi = Math.min(arr.length, i + half + 1);
        var sorted = arr.slice(lo, hi).sort(function (a, b) { return a - b; });
        out[i] = sorted[Math.floor(sorted.length / 2)];
    }
    return out;
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
    // Empirically tuned against the Mosman Park ↔ Subiaco out-and-back
    // (Strava barometric truth: 44.2 m). Median-3 acts as implicit outlier
    // rejection — isolated corrupt Terrarium pixels (observed at tile
    // boundaries, e.g. -3700 m spikes on col 255 of tile 13462/9729) are
    // replaced by their sorted-middle neighbour. Wider windows over-flattened
    // genuine 30–40 m suburban undulations.
    var elevs = elevData.map(function (e) { return e.elevation; });
    var medianed = medianFilter(elevs, 3);
    var alpha = 0.5;
    var smoothed = [{ lat: elevData[0].lat, lon: elevData[0].lon, elevation: medianed[0] }];
    for (var i = 1; i < medianed.length; i++) {
        var prev = smoothed[i - 1].elevation;
        smoothed.push({
            lat: elevData[i].lat, lon: elevData[i].lon,
            elevation: alpha * medianed[i] + (1 - alpha) * prev,
        });
    }
    return smoothed;
}

// Cumulative ascent/descent from a list of elevation samples, with a dead-band
// to reject sensor noise: only commit a run of same-sign change once it exceeds
// `deadBand` metres. Single source of truth for both the elevation panel and the
// saved-routes list (which previously used different dead-bands → divergent gain).
function computeAscent(elevData, deadBand) {
    var ascent = 0, descent = 0, pending = 0;
    for (var i = 1; i < elevData.length; i++) {
        pending += elevData[i].elevation - elevData[i - 1].elevation;
        if (pending > deadBand) { ascent += pending; pending = 0; }
        else if (pending < -deadBand) { descent += Math.abs(pending); pending = 0; }
    }
    return { ascent: ascent, descent: descent };
}

// Export for Node consumption (e.g. scripts/verify-elevation.mjs).
// No-op in browsers (module is undefined there).
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        haversine: haversine,
        tileCoords: tileCoords,
        decodeTerrarium: decodeTerrarium,
        bilinearSample: bilinearSample,
        medianFilter: medianFilter,
        smoothElevations: smoothElevations,
        computeAscent: computeAscent,
        // Routing/graph helpers — exported for the headless test suite and for
        // asserting parity with the duplicated pure functions in build-tiles.js.
        nodeKey: nodeKey,
        pathGeomLength: pathGeomLength,
        dijkstra: dijkstra,
        MinHeap: MinHeap,
        closestNode: closestNode,
        gridInsert: gridInsert,
        resetSpatialGrid: resetSpatialGrid,
        sampleRoute: sampleRoute,
        waypointHash: waypointHash,
        nodeAttrsFromTags: nodeAttrsFromTags,
        compactToGeoJSON: compactToGeoJSON,
        osmToGeoJSON: osmToGeoJSON,
    };
}

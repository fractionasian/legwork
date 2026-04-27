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

function dijkstra(graph, startKey, endKey, edgePenalty) {
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
            var stepCost = nb.dist;
            // Optional per-edge multiplier — used by the recommender's loop
            // closing leg to discourage but not forbid edge re-use, so a
            // dead-end peninsula can still get out.
            if (edgePenalty) {
                var eid = current.key < nb.key ? current.key + "|" + nb.key : nb.key + "|" + current.key;
                var mult = edgePenalty[eid];
                if (mult) stepCost *= mult;
            }
            var newDist = dist[current.key] + stepCost;
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

// ── Route recommender ────────────────────────────────
// Synthesises waypoints to hit a target distance from a chosen start.
// Spec: docs/design/route-recommender.md. MVP scope: jittered-circle
// loop generator, single-anchor out-and-back, sample-and-rank with
// baseQuality + popularityScore + lengthMatch. No vibe chips yet.

// Project a lat/lon by an initial bearing (radians) and great-circle
// distance (metres). Used to pick anchor points around a start.
function projectFromPoint(lat, lon, bearing, distanceM) {
    var R = 6371000;
    var d = distanceM / R;
    var lat1 = lat * Math.PI / 180;
    var lon1 = lon * Math.PI / 180;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
    var lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
}

// Mulberry32 — small deterministic RNG so Shuffle is reproducible per
// seed and the same Plan request returns the same six candidates.
function seededRandom(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
        s = (s + 0x6D2B79F5) >>> 0;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

var WALKWAY_HW = { footway: 1, path: 1, cycleway: 1, pedestrian: 1, steps: 1, track: 1 };
var MAINROAD_HW = { primary: 1, primary_link: 1, trunk: 1, trunk_link: 1, secondary: 1, secondary_link: 1 };

function edgeIdOf(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

// ── Geometry helpers for scenic scoring ──────────────
// All distances assume the points are within ≤ a few km, so an
// equirectangular projection at the local latitude is accurate to
// better than 0.5% and avoids per-point haversine.

function pointInPolygon(lat, lon, poly) {
    // Standard ray-casting; poly is [[lat, lon], ...]. Closed or not.
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var xi = poly[i][1], yi = poly[i][0];
        var xj = poly[j][1], yj = poly[j][0];
        var intersect = ((yi > lat) !== (yj > lat)) &&
                        (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function polygonBBox(poly) {
    var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (var i = 0; i < poly.length; i++) {
        if (poly[i][0] < minLat) minLat = poly[i][0];
        if (poly[i][0] > maxLat) maxLat = poly[i][0];
        if (poly[i][1] < minLon) minLon = poly[i][1];
        if (poly[i][1] > maxLon) maxLon = poly[i][1];
    }
    return [minLat, minLon, maxLat, maxLon];
}

function polygonArea(poly) {
    // Shoelace in equirectangular metres, signed → take abs.
    if (poly.length < 3) return 0;
    var R = 6371000, deg = Math.PI / 180;
    var lat0 = poly[0][0];
    var cosLat0 = Math.cos(lat0 * deg);
    var area = 0;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var x1 = (poly[i][1] - poly[0][1]) * cosLat0 * deg * R;
        var y1 = (poly[i][0] - poly[0][0]) * deg * R;
        var x2 = (poly[j][1] - poly[0][1]) * cosLat0 * deg * R;
        var y2 = (poly[j][0] - poly[0][0]) * deg * R;
        area += x2 * y1 - x1 * y2;
    }
    return Math.abs(area) / 2;
}

function distPointToSegMetres(lat, lon, aLat, aLon, bLat, bLon) {
    // Local equirectangular projection at the midpoint of the segment.
    var R = 6371000, deg = Math.PI / 180;
    var midLat = (aLat + bLat) / 2;
    var cosLat = Math.cos(midLat * deg);
    var px = (lon - aLon) * cosLat * deg * R;
    var py = (lat - aLat) * deg * R;
    var bx = (bLon - aLon) * cosLat * deg * R;
    var by = (bLat - aLat) * deg * R;
    var len2 = bx * bx + by * by;
    if (len2 < 1) return Math.sqrt(px * px + py * py);
    var t = (px * bx + py * by) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var qx = t * bx, qy = t * by;
    var dx = px - qx, dy = py - qy;
    return Math.sqrt(dx * dx + dy * dy);
}

function distPointToPolyline(lat, lon, polyline) {
    var best = Infinity;
    for (var i = 1; i < polyline.length; i++) {
        var d = distPointToSegMetres(lat, lon, polyline[i-1][0], polyline[i-1][1], polyline[i][0], polyline[i][1]);
        if (d < best) best = d;
    }
    return best;
}

// Bin scenic geometries into a coarse grid so per-edge lookups are O(1)
// instead of O(N). One index covers parks, waters, landmarks.
var SCENIC_CELL = 0.005; // ~500 m

function scenicGridKey(lat, lon) {
    return (Math.floor(lat / SCENIC_CELL) * SCENIC_CELL).toFixed(4) + ":" +
           (Math.floor(lon / SCENIC_CELL) * SCENIC_CELL).toFixed(4);
}

function indexScenic(scenic) {
    if (!scenic) return null;
    var idx = { parks: {}, waters: {}, landmarks: {}, raw: scenic };
    function bin(map, key, item) {
        if (!map[key]) map[key] = [];
        map[key].push(item);
    }
    function binBBox(map, bbox, item) {
        // Bin by every cell the bbox touches — bbox-of-polygon is small for
        // typical parks (<2 cells in both axes), so duplication is bounded.
        var lat0 = Math.floor(bbox[0] / SCENIC_CELL);
        var lat1 = Math.floor(bbox[2] / SCENIC_CELL);
        var lon0 = Math.floor(bbox[1] / SCENIC_CELL);
        var lon1 = Math.floor(bbox[3] / SCENIC_CELL);
        for (var la = lat0; la <= lat1; la++) {
            for (var lo = lon0; lo <= lon1; lo++) {
                var k = (la * SCENIC_CELL).toFixed(4) + ":" + (lo * SCENIC_CELL).toFixed(4);
                bin(map, k, item);
            }
        }
    }
    for (var p = 0; p < scenic.parks.length; p++) {
        var poly = scenic.parks[p];
        var bb = polygonBBox(poly);
        binBBox(idx.parks, bb, { poly: poly, bbox: bb, area: polygonArea(poly) });
    }
    for (var w = 0; w < scenic.waters.length; w++) {
        var line = scenic.waters[w];
        binBBox(idx.waters, polygonBBox(line), { line: line });
    }
    for (var l = 0; l < scenic.landmarks.length; l++) {
        var ln = scenic.landmarks[l];
        bin(idx.landmarks, scenicGridKey(ln.lat, ln.lon), ln);
    }
    return idx;
}

// Looks up neighbouring grid cells for a point and yields candidate items.
function scenicNeighbours(map, lat, lon, radiusCells) {
    var out = [];
    var seen = {};
    var lat0 = Math.floor(lat / SCENIC_CELL);
    var lon0 = Math.floor(lon / SCENIC_CELL);
    for (var dla = -radiusCells; dla <= radiusCells; dla++) {
        for (var dlo = -radiusCells; dlo <= radiusCells; dlo++) {
            var k = ((lat0 + dla) * SCENIC_CELL).toFixed(4) + ":" + ((lon0 + dlo) * SCENIC_CELL).toFixed(4);
            var bucket = map[k];
            if (!bucket) continue;
            for (var i = 0; i < bucket.length; i++) {
                if (bucket[i]._uid && seen[bucket[i]._uid]) continue;
                if (!bucket[i]._uid) bucket[i]._uid = ++_uidSeq;
                seen[bucket[i]._uid] = 1;
                out.push(bucket[i]);
            }
        }
    }
    return out;
}
var _uidSeq = 0;

// ── Per-edge scenic flag computation ─────────────────
// Uses the edge midpoint as the sample. Cheap, sufficient for soft
// preference scoring — no need to test every interior coord.

function edgeScenicFlags(midLat, midLon, sceneIdx) {
    if (!sceneIdx) return { in_park: false, near_water: false, landmark_count: 0 };

    var in_park = false;
    var parkCandidates = scenicNeighbours(sceneIdx.parks, midLat, midLon, 1);
    for (var p = 0; p < parkCandidates.length; p++) {
        var bb = parkCandidates[p].bbox;
        if (midLat < bb[0] || midLat > bb[2] || midLon < bb[1] || midLon > bb[3]) continue;
        if (pointInPolygon(midLat, midLon, parkCandidates[p].poly)) { in_park = true; break; }
    }

    var near_water = false;
    var waterCandidates = scenicNeighbours(sceneIdx.waters, midLat, midLon, 1);
    for (var w = 0; w < waterCandidates.length && !near_water; w++) {
        if (distPointToPolyline(midLat, midLon, waterCandidates[w].line) <= 100) near_water = true;
    }

    var landmark_count = 0;
    var landmarkCandidates = scenicNeighbours(sceneIdx.landmarks, midLat, midLon, 1);
    for (var l = 0; l < landmarkCandidates.length; l++) {
        var lm = landmarkCandidates[l];
        // Local equirectangular distance — fast & accurate enough.
        var R = 6371000, deg = Math.PI / 180;
        var dLat = (lm.lat - midLat) * deg * R;
        var dLon = (lm.lon - midLon) * Math.cos(midLat * deg) * deg * R;
        if (dLat * dLat + dLon * dLon <= 80 * 80) landmark_count++;
    }

    return { in_park: in_park, near_water: near_water, landmark_count: landmark_count };
}

function pathRawDistance(path) {
    var total = 0;
    for (var i = 1; i < path.length; i++) {
        var p1 = path[i-1].split(","), p2 = path[i].split(",");
        total += haversine(parseFloat(p1[0]), parseFloat(p1[1]), parseFloat(p2[0]), parseFloat(p2[1]));
    }
    return total;
}

// One generation attempt. Returns null if it can't snap an anchor or
// route between anchors. Caller retries with adjusted slack / heading.
function generateCandidate(graph, startKey, startLat, startLon, distanceM, mode, baseHeading, rng) {
    // 3 anchors form a quadrilateral loop (perimeter ≈ 5.66r) which lands
    // close to the target distance after Dijkstra overhead. 2-anchor
    // triangles (≈5.20r) systematically undershoot by ~8% — see the
    // accuracy harness in scripts/test-recommender-accuracy.js.
    var anchorCount = mode === "outback" ? 1 : 3;

    for (var attempt = 0; attempt < 4; attempt++) {
        // Loop circumference ~ D ⇒ radius D/(2π). Out-and-back: half D.
        // Slack tightens on overshoot, loosens on undershoot.
        var slack = 0.85 + (attempt * 0.05);
        var radius = mode === "outback" ? (distanceM * 0.5 * slack) : (distanceM / (2 * Math.PI) * slack);

        var anchorKeys = [];
        var failed = false;
        for (var a = 0; a < anchorCount; a++) {
            var angle = baseHeading + a * (2 * Math.PI / anchorCount);
            var jitter = 0.85 + rng() * 0.3;
            var coords = projectFromPoint(startLat, startLon, angle, radius * jitter);
            var aKey = closestNode(graph, coords[0], coords[1]);
            if (!aKey) { failed = true; break; }
            var aParts = aKey.split(",");
            var snapDist = haversine(coords[0], coords[1], parseFloat(aParts[0]), parseFloat(aParts[1]));
            if (snapDist > 350) {
                // Perturb heading and try again — sometimes a road just isn't
                // there in the first chosen direction.
                var coords2 = projectFromPoint(startLat, startLon, angle + 0.35, radius * jitter);
                aKey = closestNode(graph, coords2[0], coords2[1]);
                if (!aKey) { failed = true; break; }
            }
            if (aKey === startKey) { failed = true; break; }
            anchorKeys.push(aKey);
        }
        if (failed) continue;

        var keys = [startKey].concat(anchorKeys);
        if (mode !== "outback") keys.push(startKey);

        var paths = [];
        var usedEdges = {};
        var totalWeighted = 0;
        var legFailed = false;
        for (var k = 1; k < keys.length; k++) {
            var fromK = keys[k-1], toK = keys[k];
            // Closing leg in a loop: penalise edges already used 5×, but
            // don't forbid (a peninsula start might need to re-cross a
            // bridge to come home).
            var isClosingLeg = (mode !== "outback") && (k === keys.length - 1);
            var penalty = isClosingLeg ? usedEdges : null;
            var result = dijkstra(graph, fromK, toK, penalty);
            if (!result || result.path.length < 2) { legFailed = true; break; }
            paths.push(result.path);
            totalWeighted += result.dist;
            if (!isClosingLeg) {
                for (var p = 1; p < result.path.length; p++) {
                    var eid = edgeIdOf(result.path[p-1], result.path[p]);
                    usedEdges[eid] = 5;
                }
            }
        }
        if (legFailed) continue;

        var rawTotal = 0;
        for (var pp = 0; pp < paths.length; pp++) rawTotal += pathRawDistance(paths[pp]);
        // Out-and-back display doubles the one-way distance (see
        // updateDistance in app.js), so the target for our generated
        // path is half D. We still validate against D total.
        var measured = mode === "outback" ? rawTotal * 2 : rawTotal;

        if (measured >= distanceM * 0.7 && measured <= distanceM * 1.4) {
            return {
                anchorKeys: anchorKeys,
                paths: paths,
                rawDist: rawTotal,
                displayDist: measured,
                weightedDist: totalWeighted,
                mode: mode,
            };
        }
    }
    return null;
}

// Compute the score components that drive sample-and-rank. Pulls
// per-edge metadata from edgeMeta (populated by applyPaths). The
// optional `vibe` parameter biases the coefficient mix per the
// route-recommender spec §5; the optional `sceneIdx` enables Green /
// Water / Landmarks scoring when scenic data is loaded.
function scoreCandidate(candidate, distanceM, edgeMeta, graph, vibe, sceneIdx) {
    if (!candidate) return -Infinity;

    var walkwayDist = 0, mainRoadDist = 0, namedDist = 0, totalRaw = 0, centralitySum = 0, edgeCount = 0;
    var parkDist = 0, waterDist = 0, landmarkSum = 0;
    for (var pi = 0; pi < candidate.paths.length; pi++) {
        var path = candidate.paths[pi];
        for (var i = 1; i < path.length; i++) {
            var p1 = path[i-1].split(","), p2 = path[i].split(",");
            var lat1 = parseFloat(p1[0]), lon1 = parseFloat(p1[1]);
            var lat2 = parseFloat(p2[0]), lon2 = parseFloat(p2[1]);
            var d = haversine(lat1, lon1, lat2, lon2);
            totalRaw += d;
            var eid = edgeIdOf(path[i-1], path[i]);
            var meta = edgeMeta && edgeMeta[eid];
            if (meta) {
                if (WALKWAY_HW[meta.hw]) walkwayDist += d;
                else if (MAINROAD_HW[meta.hw]) mainRoadDist += d;
                if (meta.named && WALKWAY_HW[meta.hw]) namedDist += d;
            }
            var deg1 = (graph[path[i-1]] || []).length;
            var deg2 = (graph[path[i]] || []).length;
            centralitySum += Math.min(deg1, 8) + Math.min(deg2, 8);
            edgeCount++;
            if (sceneIdx) {
                var midLat = (lat1 + lat2) / 2, midLon = (lon1 + lon2) / 2;
                var flags = edgeScenicFlags(midLat, midLon, sceneIdx);
                if (flags.in_park) parkDist += d;
                if (flags.near_water) waterDist += d;
                if (flags.landmark_count > 0) landmarkSum += Math.min(flags.landmark_count, 3);
            }
        }
    }
    if (totalRaw < 1) return -Infinity;

    var walkwayFrac = walkwayDist / totalRaw;
    var mainRoadFrac = mainRoadDist / totalRaw;
    var namedFrac = namedDist / totalRaw;
    var parkFrac = parkDist / totalRaw;
    var waterFrac = waterDist / totalRaw;
    var landmarkBonus = edgeCount > 0 ? landmarkSum / edgeCount : 0; // 0..3
    var avgCentrality = edgeCount > 0 ? (centralitySum / (edgeCount * 2 * 8)) : 0; // normalised 0..1

    // Vibe coefficients. Default ("surprise") uses the calibrated mix.
    // Quiet triples the main-road penalty; Popular triples the
    // popularityScore weighting; Green/Water/Landmarks each add a
    // dedicated bonus term that's zero unless scenic data is loaded.
    var mainRoadCoef = 0.5, popularityMult = 1;
    var greenBonus = 0, waterBonus = 0, landmarkChipBonus = 0;
    if (vibe === "quiet") mainRoadCoef = 1.5;
    else if (vibe === "popular") popularityMult = 3;
    else if (vibe === "green") greenBonus = 0.6 * parkFrac;
    else if (vibe === "water") waterBonus = 0.6 * waterFrac;
    else if (vibe === "landmarks") landmarkChipBonus = 0.4 * Math.min(landmarkBonus, 1);

    // baseQuality: walkways good, main roads bad. Scaled so a pure
    // footway loop scores ~1.0 and a pure-trunk-road loop scores ~-0.5.
    var baseQuality = walkwayFrac - mainRoadCoef * mainRoadFrac;

    // popularityScore: named-footway fraction + centrality. Both are
    // OSM-derived proxies — see route-recommender.md §4.3. Held small
    // (≤0.35 contribution at default mult) so it nudges, never dominates.
    var popularityScore = popularityMult * (0.25 * namedFrac + 0.10 * avgCentrality);
    var sceneScore = greenBonus + waterBonus + landmarkChipBonus;

    // Triangular length match centred on D, falls to 0.3 at ±25%, 0 at ±40%.
    var lengthRatio = candidate.displayDist / distanceM;
    var lengthMatch;
    var dev = Math.abs(lengthRatio - 1);
    if (dev <= 0.15) lengthMatch = 1 - dev / 0.4;
    else if (dev <= 0.4) lengthMatch = (0.4 - dev) / 0.4 + 0.1;
    else lengthMatch = 0;

    var score = lengthMatch * (baseQuality + popularityScore + sceneScore + 0.5);
    candidate.scoreBreakdown = {
        baseQuality: baseQuality,
        popularityScore: popularityScore,
        sceneScore: sceneScore,
        lengthMatch: lengthMatch,
        walkwayFrac: walkwayFrac,
        mainRoadFrac: mainRoadFrac,
        namedFrac: namedFrac,
        parkFrac: parkFrac,
        waterFrac: waterFrac,
        landmarkBonus: landmarkBonus,
        vibe: vibe || "surprise",
    };
    candidate.score = score;
    return score;
}

// Public entry point. Generates `count` candidates from a seed, scores
// them, returns ranked descending. Caller materialises candidates[0]
// as the displayed route; Shuffle advances through the array and
// regenerates with a rotated seed when exhausted.
function recommendRoute(graph, edgeMeta, startKey, opts) {
    if (!graph[startKey]) return { candidates: [], reason: "no-start-node" };
    var distanceM = opts.distanceM;
    var mode = opts.mode || "loop";
    var seed = (opts.seed | 0) || Math.floor(Math.random() * 0x7fffffff);
    var count = opts.count || 6;
    var vibe = opts.vibe || "surprise";

    var rng = seededRandom(seed);
    var startParts = startKey.split(",");
    var startLat = parseFloat(startParts[0]), startLon = parseFloat(startParts[1]);

    var candidates = [];
    for (var i = 0; i < count; i++) {
        var heading = (i / count) * 2 * Math.PI + rng() * 0.5;
        var c = generateCandidate(graph, startKey, startLat, startLon, distanceM, mode, heading, rng);
        if (c) candidates.push(c);
    }
    if (candidates.length === 0) return { candidates: [], reason: "no-candidates" };

    for (var ci = 0; ci < candidates.length; ci++) {
        scoreCandidate(candidates[ci], distanceM, edgeMeta, graph, vibe, opts.sceneIdx);
    }
    candidates.sort(function (a, b) { return b.score - a.score; });
    // Drop near-duplicate candidates (≥70% shared edges with a higher-
    // ranked one) so Shuffle gives a visibly different route each tap.
    var deduped = [candidates[0]];
    for (var di = 1; di < candidates.length; di++) {
        var keep = true;
        for (var dj = 0; dj < deduped.length; dj++) {
            if (candidateOverlap(candidates[di], deduped[dj]) > 0.7) { keep = false; break; }
        }
        if (keep) deduped.push(candidates[di]);
    }
    return { candidates: deduped, seed: seed };
}

function candidateOverlap(a, b) {
    var aEdges = {};
    var aTotal = 0;
    for (var i = 0; i < a.paths.length; i++) {
        var path = a.paths[i];
        for (var j = 1; j < path.length; j++) { aEdges[edgeIdOf(path[j-1], path[j])] = 1; aTotal++; }
    }
    if (aTotal === 0) return 0;
    var shared = 0, bTotal = 0;
    for (var p2 = 0; p2 < b.paths.length; p2++) {
        var path2 = b.paths[p2];
        for (var k = 1; k < path2.length; k++) {
            bTotal++;
            if (aEdges[edgeIdOf(path2[k-1], path2[k])]) shared++;
        }
    }
    return bTotal === 0 ? 0 : shared / Math.max(aTotal, bTotal);
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

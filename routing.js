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
            oneway: true, // honour bikeOnewayFromTags (pedestrians aren't bound by one-ways)
        };
    }
    return {
        roadWeight: ROAD_WEIGHT,
        wayPref: wayPrefMultiplier,
        nodePref: nodePrefMultiplier,
        defaultWeight: 1.2,
    };
}

// ── One-way streets (bike profile) ─────────────────────
// Modelled on OSRM's bicycle profile (profiles/bicycle.lua): riding against a
// one-way is not forbidden, it becomes "pushing the bike" at walking speed —
// 4 km/h against ~15 km/h riding, so roughly 4× the cost. That keeps short
// legitimate wrong-way pushes (to reach a pin on a one-way street) routable
// while steering real routes onto the right direction. Roundabouts are the
// exception: no one pushes round a roundabout the wrong way, so that direction
// is closed outright (OSRM's "implied oneway").
var ONEWAY_PUSH_MULTIPLIER = 4;

// Bike direction rule for a way, from its OSM tags:
//   0  two-way for bikes        1  forward only (push backward)
//  -1  reverse only (push fwd)  2  forward only, reverse closed (roundabout)
// Precedence follows OSRM: oneway:bicycle first, then a contraflow cycle lane
// (cycleway*=opposite*), then roundabout, then plain oneway.
function bikeOnewayFromTags(tags) {
    if (!tags) return 0;
    function yes(v) { return v === "yes" || v === "1" || v === "true"; }
    function no(v) { return v === "no" || v === "0" || v === "false"; }
    var roundabout = tags.junction === "roundabout" || tags.junction === "circular";
    var ob = tags["oneway:bicycle"];
    if (no(ob)) return 0;
    if (yes(ob)) return roundabout ? 2 : 1;
    if (ob === "-1") return -1;
    var contraflow = /^opposite/;
    if (contraflow.test(tags.cycleway || "") || contraflow.test(tags["cycleway:left"] || "") ||
        contraflow.test(tags["cycleway:right"] || "")) return 0;
    if (roundabout) return 2;
    if (yes(tags.oneway)) return 1;
    if (tags.oneway === "-1") return -1;
    return 0;
}

// Directed costs for one segment of a way whose undirected cost is `d`.
// `rev` is null when that direction is closed. Every multiplier is >= 1, so
// MIN_EDGE_MULTIPLIER (the A* heuristic's floor) stays a valid lower bound.
function onewayEdgeCosts(ow, d) {
    if (ow === 1) return { fwd: d, rev: d * ONEWAY_PUSH_MULTIPLIER };
    if (ow === -1) return { fwd: d * ONEWAY_PUSH_MULTIPLIER, rev: d };
    if (ow === 2) return { fwd: d, rev: null };
    return { fwd: d, rev: d };
}

// ── Climb-aware routing ───────────────────────────────
// Extra cost, in the same weighted-metre units as every other edge cost, for
// each metre climbed. 0 = off (the default): routing is exactly as before.
// `?climb=8` turns it on for testing — see docs/design/climb-aware-routing.md for
// what it bought on real Perth routes and how to read the number. The weight
// multiplies the router's own smoothed climb, which sums ~2-3x the ascent the app
// displays (no dead-band), so 8 here is ~17-25 per DISPLAYED metre; Naismith's
// walking rule (1 m climb ≈ 8 m flat) sits nearer 4. Climb is charged uphill only;
// downhill is free.
// Tiles built without elevation (other cities, live Overpass fallback) carry no
// heights, so they route as before whatever the weight.
var CLIMB_WEIGHT = 8;
var CLIMB_WEIGHT_MAX = 50; // beyond this a route detours kilometres to dodge one hill

function setClimbWeight(w) {
    var n = Number(w);
    CLIMB_WEIGHT = (isFinite(n) && n > 0) ? Math.min(n, CLIMB_WEIGHT_MAX) : 0;
}

// Tile format: a way's heights are decimetres, first value absolute then the
// step to each next vertex (scripts/elevation.js encodeElevations). Returns
// metres per vertex, or null when absent or not one value per coordinate.
function decodeElevations(deltas, n) {
    if (!Array.isArray(deltas) || deltas.length !== n) return null;
    var out = new Array(n), dm = 0;
    for (var i = 0; i < n; i++) { dm += deltas[i]; out[i] = dm / 10; }
    return out;
}

// ── Turn cost ─────────────────────────────────────────
// Extra cost, in weighted metres, for each turn (a change of direction of
// TURN_ANGLE degrees or more at a junction). 0 = off (the default). `?turn=15`
// turns it on for testing; see docs/design/climb-aware-routing.md.
//
// Why it exists: between two diagonal points a street grid has hundreds of equally
// short staircase routes and a plain shortest-path search picks one arbitrarily.
// Climb-aware routing makes it worse (flatter corridors run along side streets: +15%
// turns in testing). A small cost per turn prefers one long diagonal and a single
// corner. It is deliberately a soft cost: some routes have no straight run over
// ~100 m to offer, so a hard minimum would leave them unroutable.
//
// The cost depends on the way you arrived, so the search state is the directed edge
// (not the node): about twice the states, see PackedGraph.searchTurns.
var TURN_COST = 15;
var TURN_COST_MAX = 100;
var TURN_ANGLE = 35;

function setTurnCost(c) {
    var n = Number(c);
    TURN_COST = (isFinite(n) && n > 0) ? Math.min(n, TURN_COST_MAX) : 0;
}

// Direction of travel in degrees (-180..180, 0 = north). Longitude is scaled by
// cos(latitude) so a 45-degree street reads as 45 degrees, not ~53 at Perth's latitude.
function bearingDeg(lat1, lon1, lat2, lon2) {
    var k = Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    return Math.atan2((lon2 - lon1) * k, lat2 - lat1) * 180 / Math.PI;
}
// Cost of going from an edge heading b1 onto one heading b2.
function turnPenalty(b1, b2) {
    var d = Math.abs(b2 - b1);
    if (d > 180) d = 360 - d;
    return d >= TURN_ANGLE ? TURN_COST : 0;
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

// Smallest combined edge multiplier reachable in EITHER routing profile — the
// scale factor that makes a straight-line heuristic admissible (see dijkstra).
// Edge cost in applyPaths is
//   haversine × roadWeight[highway] × wayPref(highway, surface, name)
//             × nodePref(attrs[a]) × nodePref(attrs[b])
// so the cheapest a metre of ground can ever cost is haversine × min(product):
//
//   run  min(roadWeight × wayPref) = 1.0 (footway/path/cycleway…)
//                                  × 0.85 (named trail) × 0.95 (soft surface) = 0.8075
//   bike min(roadWeight × wayPref) = 0.8 (cycleway) × 1.0                     = 0.8
//   both min nodePref              = 0.9 (marked crossing), applied at BOTH ends → 0.81
//
//   run  0.8075 × 0.81 = 0.654075
//   bike 0.8    × 0.81 = 0.648    ← smaller, so bike is the binding bound
//
// A graph is only ever built under one profile at a time (rebuildGraphForProfile
// re-weights on the cycling toggle), but 0.648 is a valid lower bound for both,
// so one constant covers it. ADMISSIBILITY IS LOAD-BEARING: if any road weight,
// wayPref, or nodePref value ever drops below what this product assumes, A*
// starts silently returning suboptimal routes with no error. Re-derive this
// number whenever ROAD_WEIGHT / BIKE_ROAD_WEIGHT / *PrefMultiplier change.
// Climb cost (CLIMB_WEIGHT) is only ever added on top and is never negative, so it
// cannot break the bound — it just makes the search a little less focused.
var MIN_EDGE_MULTIPLIER = 0.648;

// A* — Dijkstra plus a straight-line (haversine) lower bound on the cost still
// to come. Same optimal cost as plain Dijkstra (the heuristic is admissible AND
// consistent, so the visited-set early-exit stays valid); it just stops the
// search fanning out in every direction. Measured on real tiles: 2.0–4.0× faster
// on 1–15 km legs, identical path cost on all 80 pairs tested.
function dijkstra(graph, startKey, endKey) {
    if (graph instanceof PackedGraph) return graph.route(startKey, endKey);
    if (!graph[startKey] || !graph[endKey]) return null;
    if (startKey === endKey) return { dist: 0, path: [startKey] };
    // Goal coordinates come off endKey itself — graph keys ARE "lat,lon"
    // (nodeKey). Deriving them here rather than taking the caller's waypoint
    // lat/lon matters: a waypoint sits up to 200 m from its snapped node, and
    // that offset would let the heuristic overestimate near the goal.
    // Round-tripping through nodeKey is the test that this really is a
    // coordinate key — synthetic graphs (tests) use keys like "A"/"B", where no
    // geometry exists and the heuristic must stay 0 (i.e. plain Dijkstra).
    var goalLat = 0, goalLon = 0, useH = false;
    var gParts = endKey.split(",");
    if (gParts.length === 2) {
        var gLat = parseFloat(gParts[0]), gLon = parseFloat(gParts[1]);
        var probe = graph[startKey][0];
        if (!isNaN(gLat) && !isNaN(gLon) && nodeKey(gLat, gLon) === endKey &&
            probe && typeof probe.lat === "number" && typeof probe.lon === "number") {
            goalLat = gLat; goalLon = gLon; useH = true;
        }
    }
    var dist = {}, prev = {}, visited = {};
    var heap = new MinHeap();
    dist[startKey] = 0;
    // Start is pushed with d = 0 rather than its own h: it's the only entry, so
    // it pops first regardless, and h(start) is a constant offset anyway.
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
                // Heap orders on f = g + h; dist[] stays the true cost g, so the
                // returned dist is identical to Dijkstra's.
                var f = newDist;
                if (useH) f += haversine(nb.lat, nb.lon, goalLat, goalLon) * MIN_EDGE_MULTIPLIER;
                heap.push({ key: nb.key, d: f });
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
    if (graph instanceof PackedGraph) return graph.closest(lat, lon);
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

// ── Packed graph ──────────────────────────────────────
// The routing graph as typed arrays instead of an object of arrays of objects keyed by
// "lat,lon" strings. Measured on all 46 Perth tiles: memory down ~10x and search
// ~4-12x faster, with identical routes (docs/design/climb-aware-routing.md).
//
//   nodes   latQ/lonQ  integer microdegrees (the same 6 dp the string key uses)
//           first      head of the node's edge list (-1 = none)
//   edges   eTo/eFrom  head and tail node;  eNext links the tail's edge list
//           eCost      weighted length (road class, surface, node prefs, one-way)
//           eUp        metres climbed travelling this way (0 if the tile has no heights)
//           eBear      heading, kept only while TURN_COST is on
//
// Edge lists are linked lists, not a CSR block, so tiles can be added as they stream in:
// a node shared with a neighbouring tile is found by coordinate (open-addressing hash)
// and just gains edges. Node keys stay "lat,lon" strings at the API edge (waypoints and
// saved routes store them), converted only when a route is returned.
var PG_CELL = 0.005; // spatial grid cell, ~500 m (same as the plain-object grid)

// Degrees -> integer microdegrees, rounded exactly as nodeKey's toFixed(6) rounds.
// Tile coordinates are 5 dp, so the fast path is exact; live Overpass nodes (7 dp) take
// the slow path.
function quantise6(x) {
    var r = Math.round(x * 1e5);
    if (Math.abs(x * 1e5 - r) < 1e-4) return r * 10;
    return Math.round(parseFloat(x.toFixed(6)) * 1e6);
}
function pgHash(la, lo) {
    var h = Math.imul(la, 0x9E3779B1) ^ Math.imul(lo, 0x85EBCA6B);
    return (h ^ (h >>> 15)) | 0;
}
function pgCell(latDeg, lonDeg) {
    return Math.floor((latDeg + 90) / PG_CELL) * 100000 + Math.floor((lonDeg + 180) / PG_CELL);
}
function pgGrow(arr, Type, len) { var n = new Type(len); n.set(arr); return n; }
function pgTable(size) { var t = new Int32Array(size); t.fill(-1); return t; }

function PackedGraph() {
    this.nodeCap = 1024; this.edgeCap = 2048;
    this.nNodes = 0; this.nEdges = 0;
    this.latQ = new Int32Array(this.nodeCap);
    this.lonQ = new Int32Array(this.nodeCap);
    this.first = new Int32Array(this.nodeCap);
    this.eTo = new Int32Array(this.edgeCap);
    this.eFrom = new Int32Array(this.edgeCap);
    this.eNext = new Int32Array(this.edgeCap);
    this.eCost = new Float64Array(this.edgeCap);
    this.eUp = new Float64Array(this.edgeCap);
    this.eBear = null;
    this.table = pgTable(2048); this.mask = 2047;     // node index by coordinate, load <= 0.5
    this.grid = new Map();                              // spatial cell -> node indices
    this.attrMap = new Map(); this.attrCount = 0;       // latQ -> [{ lo, a }]: signals, crossings, barriers
    // search scratch, stamped per search so nothing is cleared between them; rebuilt on growth
    this.gN = null; this.prevN = null; this.stampN = null; this.closedN = null; this.genN = 0;
    this.gE = null; this.prevE = null; this.stampE = null; this.closedE = null; this.genE = 0;
    this.hk = new Float64Array(1024); this.hv = new Int32Array(1024); this.hn = 0;
}

PackedGraph.prototype.growNodes = function () {
    this.nodeCap *= 2;
    this.latQ = pgGrow(this.latQ, Int32Array, this.nodeCap);
    this.lonQ = pgGrow(this.lonQ, Int32Array, this.nodeCap);
    this.first = pgGrow(this.first, Int32Array, this.nodeCap);
    var size = 1; while (size < this.nodeCap * 2) size <<= 1;
    this.table = pgTable(size); this.mask = size - 1;
    for (var i = 0; i < this.nNodes; i++) {
        var j = pgHash(this.latQ[i], this.lonQ[i]) & this.mask;
        while (this.table[j] >= 0) j = (j + 1) & this.mask;
        this.table[j] = i;
    }
    this.gN = null;
};
PackedGraph.prototype.growEdges = function () {
    this.edgeCap *= 2;
    this.eTo = pgGrow(this.eTo, Int32Array, this.edgeCap);
    this.eFrom = pgGrow(this.eFrom, Int32Array, this.edgeCap);
    this.eNext = pgGrow(this.eNext, Int32Array, this.edgeCap);
    this.eCost = pgGrow(this.eCost, Float64Array, this.edgeCap);
    this.eUp = pgGrow(this.eUp, Float64Array, this.edgeCap);
    if (this.eBear) this.eBear = pgGrow(this.eBear, Float32Array, this.edgeCap);
    this.gE = null;
};

// Node at integer coordinates, or -1.
PackedGraph.prototype.find = function (la, lo) {
    var i = pgHash(la, lo) & this.mask, n;
    while ((n = this.table[i]) >= 0) {
        if (this.latQ[n] === la && this.lonQ[n] === lo) return n;
        i = (i + 1) & this.mask;
    }
    return -1;
};
// Node at integer coordinates, created if new.
PackedGraph.prototype.node = function (la, lo) {
    if (this.nNodes === this.nodeCap) this.growNodes();
    var i = pgHash(la, lo) & this.mask, n;
    while ((n = this.table[i]) >= 0) {
        if (this.latQ[n] === la && this.lonQ[n] === lo) return n;
        i = (i + 1) & this.mask;
    }
    n = this.nNodes++;
    this.latQ[n] = la; this.lonQ[n] = lo; this.first[n] = -1;
    this.table[i] = n;
    var ck = pgCell(la / 1e6, lo / 1e6), b = this.grid.get(ck);
    if (!b) { b = []; this.grid.set(ck, b); }
    b.push(n);
    return n;
};

// Is there already an edge between u and v, in either direction? (A segment seen twice,
// e.g. by two ways or two tiles, is added once, whichever way it was first drawn.)
PackedGraph.prototype.connected = function (u, v) {
    var e;
    for (e = this.first[u]; e >= 0; e = this.eNext[e]) if (this.eTo[e] === v) return true;
    for (e = this.first[v]; e >= 0; e = this.eNext[e]) if (this.eTo[e] === u) return true;
    return false;
};
PackedGraph.prototype.addEdge = function (u, v, cost, up) {
    if (this.nEdges === this.edgeCap) this.growEdges();
    var e = this.nEdges++;
    this.eFrom[e] = u; this.eTo[e] = v; this.eCost[e] = cost; this.eUp[e] = up;
    this.eNext[e] = this.first[u]; this.first[u] = e;
    if (this.eBear) this.eBear[e] = this.bearing(u, v);
    return e;
};
PackedGraph.prototype.bearing = function (u, v) {
    return bearingDeg(this.latQ[u] / 1e6, this.lonQ[u] / 1e6, this.latQ[v] / 1e6, this.lonQ[v] / 1e6);
};
// Headings are needed only by the turn-aware search; build them once, then keep them
// current as edges are added.
PackedGraph.prototype.ensureBearings = function () {
    if (this.eBear) return;
    this.eBear = new Float32Array(this.edgeCap);
    for (var e = 0; e < this.nEdges; e++) this.eBear[e] = this.bearing(this.eFrom[e], this.eTo[e]);
};

// Node attributes (traffic signals, crossings, barriers) arrive keyed "lat,lon".
PackedGraph.prototype.setAttrs = function (key, attrs) {
    var p = key.split(",");
    var la = quantise6(parseFloat(p[0])), lo = quantise6(parseFloat(p[1]));
    var list = this.attrMap.get(la);
    if (!list) { list = []; this.attrMap.set(la, list); }
    for (var i = 0; i < list.length; i++) if (list[i].lo === lo) { list[i].a = attrs; return; }
    list.push({ lo: lo, a: attrs }); this.attrCount++;
};
PackedGraph.prototype.attrsOf = function (n) {
    if (!this.attrCount) return undefined;
    var list = this.attrMap.get(this.latQ[n]);
    if (!list) return undefined;
    for (var i = 0; i < list.length; i++) if (list[i].lo === this.lonQ[n]) return list[i].a;
    return undefined;
};

// ── key <-> index (the API edge) ──
PackedGraph.prototype.keyOf = function (n) { return nodeKey(this.latQ[n] / 1e6, this.lonQ[n] / 1e6); };
PackedGraph.prototype.indexOf = function (key) {
    if (typeof key !== "string") return -1;
    var p = key.split(",");
    if (p.length !== 2) return -1;
    var la = parseFloat(p[0]), lo = parseFloat(p[1]);
    if (isNaN(la) || isNaN(lo)) return -1;
    return this.find(quantise6(la), quantise6(lo));
};
PackedGraph.prototype.hasNode = function (key) { return this.indexOf(key) >= 0; };

// Nearest node to a point, as a key. Same search as the plain-object closestNode: rings of
// cells outward from the point's cell, one ring past the first hit, capped at 7 (~3.5 km).
PackedGraph.prototype.closest = function (lat, lon) {
    var ci = Math.floor((lat + 90) / PG_CELL), cj = Math.floor((lon + 180) / PG_CELL);
    var best = -1, bestD = Infinity, self = this;
    function ring(r) {
        for (var di = -r; di <= r; di++) {
            for (var dj = -r; dj <= r; dj++) {
                if (r > 1 && Math.abs(di) !== r && Math.abs(dj) !== r) continue;
                var b = self.grid.get((ci + di) * 100000 + (cj + dj));
                if (!b) continue;
                for (var k = 0; k < b.length; k++) {
                    var n = b[k], d = haversine(lat, lon, self.latQ[n] / 1e6, self.lonQ[n] / 1e6);
                    if (d < bestD) { bestD = d; best = n; }
                }
            }
        }
    }
    var foundAt = -1;
    for (var r = 1; r <= 7; r++) {
        ring(r);
        if (best >= 0 && foundAt < 0) foundAt = r;
        if (foundAt >= 0 && r >= foundAt + 1) break;
    }
    return best >= 0 ? this.keyOf(best) : null;
};

// ── binary heap on two typed arrays ──
PackedGraph.prototype.hpush = function (f, v) {
    if (this.hn === this.hk.length) { this.hk = pgGrow(this.hk, Float64Array, this.hn * 2); this.hv = pgGrow(this.hv, Int32Array, this.hn * 2); }
    var hk = this.hk, hv = this.hv, i = this.hn++;
    while (i > 0) { var p = (i - 1) >> 1; if (hk[p] <= f) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
    hk[i] = f; hv[i] = v;
};
PackedGraph.prototype.hpop = function () {
    var hk = this.hk, hv = this.hv, top = hv[0], n = --this.hn;
    if (n > 0) {
        var k = hk[n], v = hv[n], i = 0;
        for (;;) {
            var c = 2 * i + 1; if (c >= n) break;
            if (c + 1 < n && hk[c + 1] < hk[c]) c++;
            if (hk[c] >= k) break;
            hk[i] = hk[c]; hv[i] = hv[c]; i = c;
        }
        hk[i] = k; hv[i] = v;
    }
    return top;
};

// ── search ──
// route(startKey, endKey) -> { dist, path: [keys] } or null, like dijkstra() on a plain graph.
// Cost of an edge = eCost + CLIMB_WEIGHT * eUp. With TURN_COST on, each turn adds TURN_COST.
PackedGraph.prototype.route = function (startKey, endKey) {
    var s = this.indexOf(startKey), t = this.indexOf(endKey);
    if (s < 0 || t < 0) return null;
    if (s === t) return { dist: 0, path: [startKey] };
    return TURN_COST ? this.searchTurns(s, t) : this.searchNodes(s, t);
};

// A* over nodes. The straight-line lower bound uses MIN_EDGE_MULTIPLIER (see its note);
// climb and turn costs are never negative, so it stays admissible.
PackedGraph.prototype.searchNodes = function (s, t) {
    if (!this.gN) {
        this.gN = new Float64Array(this.nodeCap); this.prevN = new Int32Array(this.nodeCap);
        this.stampN = new Uint32Array(this.nodeCap); this.closedN = new Uint32Array(this.nodeCap); this.genN = 0;
    }
    var gs = this.gN, prev = this.prevN, stamp = this.stampN, closed = this.closedN, gen = ++this.genN;
    var latQ = this.latQ, lonQ = this.lonQ, first = this.first, eTo = this.eTo, eNext = this.eNext, eCost = this.eCost, eUp = this.eUp;
    var cw = CLIMB_WEIGHT, hav = haversine, hm = MIN_EDGE_MULTIPLIER, gLat = latQ[t] / 1e6, gLon = lonQ[t] / 1e6;
    this.hn = 0; gs[s] = 0; stamp[s] = gen; prev[s] = -1; this.hpush(0, s);
    while (this.hn > 0) {
        var cur = this.hpop();
        if (closed[cur] === gen) continue;
        closed[cur] = gen;
        if (cur === t) break;
        var gc = gs[cur];
        for (var e = first[cur]; e >= 0; e = eNext[e]) {
            var nb = eTo[e];
            if (closed[nb] === gen) continue;
            var nd = gc + eCost[e] + cw * eUp[e];
            if (stamp[nb] !== gen || nd < gs[nb]) {
                stamp[nb] = gen; gs[nb] = nd; prev[nb] = cur;
                this.hpush(nd + hav(latQ[nb] / 1e6, lonQ[nb] / 1e6, gLat, gLon) * hm, nb);
            }
        }
    }
    if (stamp[t] !== gen) return null;
    var path = [];
    for (var c = t; c !== -1; c = prev[c]) path.push(this.keyOf(c));
    path.reverse();
    return { dist: gs[t], path: path };
};

// A* over directed edges: the state is the edge you arrived on, so each junction can
// charge for the angle between the way in and the way out. About twice the states.
PackedGraph.prototype.searchTurns = function (s, t) {
    this.ensureBearings();
    if (!this.gE) {
        this.gE = new Float64Array(this.edgeCap); this.prevE = new Int32Array(this.edgeCap);
        this.stampE = new Uint32Array(this.edgeCap); this.closedE = new Uint32Array(this.edgeCap); this.genE = 0;
    }
    var gs = this.gE, prev = this.prevE, stamp = this.stampE, closed = this.closedE, gen = ++this.genE;
    var latQ = this.latQ, lonQ = this.lonQ, first = this.first, eTo = this.eTo, eFrom = this.eFrom, eNext = this.eNext;
    var eCost = this.eCost, eUp = this.eUp, eBear = this.eBear;
    var cw = CLIMB_WEIGHT, hav = haversine, hm = MIN_EDGE_MULTIPLIER, tp = turnPenalty, gLat = latQ[t] / 1e6, gLon = lonQ[t] / 1e6, e, c;
    this.hn = 0;
    for (e = first[s]; e >= 0; e = eNext[e]) {
        c = eCost[e] + cw * eUp[e];
        gs[e] = c; stamp[e] = gen; prev[e] = -1;
        this.hpush(c + hav(latQ[eTo[e]] / 1e6, lonQ[eTo[e]] / 1e6, gLat, gLon) * hm, e);
    }
    var fin = -1;
    while (this.hn > 0) {
        var cur = this.hpop();
        if (closed[cur] === gen) continue;
        closed[cur] = gen;
        var v = eTo[cur];
        if (v === t) { fin = cur; break; }
        var gc = gs[cur], b1 = eBear[cur];
        for (e = first[v]; e >= 0; e = eNext[e]) {
            if (closed[e] === gen) continue;
            c = gc + eCost[e] + cw * eUp[e] + tp(b1, eBear[e]);
            if (stamp[e] !== gen || c < gs[e]) {
                var w = eTo[e];
                stamp[e] = gen; gs[e] = c; prev[e] = cur;
                this.hpush(c + hav(latQ[w] / 1e6, lonQ[w] / 1e6, gLat, gLon) * hm, e);
            }
        }
    }
    if (fin < 0) return null;
    var path = [], last = fin;
    for (e = fin; e !== -1; e = prev[e]) { path.push(this.keyOf(eTo[e])); last = e; }
    path.push(this.keyOf(eFrom[last]));   // last = the first edge of the route; its tail is the start
    path.reverse();
    return { dist: gs[fin], path: path };
};

// Debug/test view of every node key (cold path, allocates).
PackedGraph.prototype.nodeKeys = function () {
    var out = [];
    for (var n = 0; n < this.nNodes; n++) out.push(this.keyOf(n));
    return out;
};

// Debug/test view of a node's outgoing edges: { key, lat, lon, dist, up, b? }, where dist
// includes the climb charge. Not used by the app (cold path).
PackedGraph.prototype.edgesFrom = function (key) {
    var n = this.indexOf(key), out = [];
    if (n < 0) return out;
    for (var e = this.first[n]; e >= 0; e = this.eNext[e]) {
        var w = this.eTo[e];
        var o = { key: this.keyOf(w), lat: this.latQ[w] / 1e6, lon: this.lonQ[w] / 1e6, dist: this.eCost[e] + CLIMB_WEIGHT * this.eUp[e], up: this.eUp[e] };
        if (this.eBear) o.b = this.eBear[e];
        out.push(o);
    }
    return out;
};

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
            // Round to 5 dp, the precision the pre-baked tiles are built at
            // (build-tiles.js). Overpass returns 7 dp, and nodeKey() keys at
            // 6 dp, so the SAME OSM node got a different key from a tile than
            // from a live fetch — a route leaving a covered city ran onto a
            // separate, unconnected graph and failed or detoured.
            var la = +el.lat.toFixed(5), lo = +el.lon.toFixed(5);
            nodes[el.id] = [lo, la];
            if (el.tags) {
                var a = nodeAttrsFromTags(el.tags);
                if (a) nodeAttrs[nodeKey(la, lo)] = a;
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
        var props = { id: el.id, highway: tags.highway || "", surface: tags.surface || "", name: tags.name || "" };
        var ow = bikeOnewayFromTags(tags);
        if (ow) props.ow = ow;
        features.push({
            type: "Feature",
            properties: props,
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
    //   v2:          { v:2, features: [[id, highway, name, coords, surface?, ow?, elev?], ...], nodeAttrs: {...} }
    //                (ow = bikeOnewayFromTags; when present, surface is "" if unset)
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
        var props = {
            id: c[0],
            highway: c[1],
            name: c[2] || "",
            surface: c[4] || "", // v2 adds surface as optional 5th element; v1 leaves it empty
        };
        if (c[5]) props.ow = c[5]; // tiles built before one-way support have no 6th element
        var elev = decodeElevations(c[6], c[3].length); // 7th element: heights, only on tiles baked with elevation
        if (elev) props.elev = elev;
        features.push({
            type: "Feature",
            properties: props,
            geometry: { type: "LineString", coordinates: c[3] },
        });
    }
    var fc = { type: "FeatureCollection", features: features };
    if (nodeAttrs) fc.nodeAttrs = nodeAttrs;
    return fc;
}

// Map one Overpass element (node/way/relation from an amenity query with
// `out center`) to Legwork's POI shape. Returns null for elements with no
// usable position or amenity tag. Shared by the live loadPois path (tiles.js)
// and the tile builder's pre-baked pois.json (scripts/build-tiles.js) so the
// two sources can never drift.
function poiFromOsmElement(el) {
    if (!el || !el.tags || !el.tags.amenity) return null;
    // Nodes carry lat/lon directly; ways + relations get a computed centroid
    // in el.center thanks to `out center`.
    var plat, plon;
    if (el.type === "node") { plat = el.lat; plon = el.lon; }
    else if (el.center) { plat = el.center.lat; plon = el.center.lon; }
    else return null;
    return {
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
    };
}

// ── POI ↔ route corridor ───────────────────────────────
// Metres per degree of latitude. Longitude uses the same figure scaled by
// cos(lat), which is why every projection below multiplies the lon delta.
var METRES_PER_DEGREE = 111320;

// Shortest distance from a point to a line segment, in metres. Uses an
// equirectangular projection centred on the point rather than haversine per
// segment: sub-metre accurate at the sub-kilometre distances this is asked
// about, and cheap enough to run over a whole route's geometry.
function distPointToSegmentMetres(plat, plon, alat, alon, blat, blon) {
    var k = Math.cos(plat * Math.PI / 180);
    // Segment endpoints relative to the point, so the point sits at the origin.
    var ax = (alon - plon) * k, ay = alat - plat;
    var bx = (blon - plon) * k, by = blat - plat;
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    // t is the projection of the origin onto AB, clamped so a point "past" an
    // endpoint measures to that endpoint rather than to the infinite line.
    var t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var cx = ax + t * dx, cy = ay + t * dy;
    return Math.sqrt(cx * cx + cy * cy) * METRES_PER_DEGREE;
}

// Keep only the POIs within `maxMetres` of any of `polylines` (arrays of
// [lat, lon]). An empty polyline list returns the input untouched — that's the
// "no route yet" case, where the area view is the only thing that can answer
// "what's around here".
//
// Two-stage on purpose: a dense city holds ~1000 POIs and a 10 km route ~3000
// segments, so testing every pair is 3M projections. The whole-route bounding
// box rejects the ~95% that are nowhere near it on four comparisons each,
// leaving only the plausible ones for the per-segment pass.
function filterPoisNearRoute(pois, polylines, maxMetres) {
    if (!pois || !polylines || polylines.length === 0) return pois;
    var lines = [];
    var south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
    for (var i = 0; i < polylines.length; i++) {
        var line = polylines[i];
        if (!line || line.length < 2) continue; // a single point has no segment
        lines.push(line);
        for (var j = 0; j < line.length; j++) {
            if (line[j][0] < south) south = line[j][0];
            if (line[j][0] > north) north = line[j][0];
            if (line[j][1] < west) west = line[j][1];
            if (line[j][1] > east) east = line[j][1];
        }
    }
    if (lines.length === 0) return pois;

    var padLat = maxMetres / METRES_PER_DEGREE;
    // Widen the lon pad using the bbox edge nearest the pole, where a degree of
    // longitude is shortest — so the pad is never narrower than maxMetres.
    var cosLat = Math.cos(Math.max(Math.abs(south), Math.abs(north)) * Math.PI / 180);
    var padLon = padLat / Math.max(cosLat, 1e-6);

    var out = [];
    for (var p = 0; p < pois.length; p++) {
        var poi = pois[p];
        if (poi.lat < south - padLat || poi.lat > north + padLat) continue;
        if (poi.lon < west - padLon || poi.lon > east + padLon) continue;
        if (isNearPolylines(poi.lat, poi.lon, lines, maxMetres)) out.push(poi);
    }
    return out;
}

function isNearPolylines(lat, lon, lines, maxMetres) {
    var padLat = maxMetres / METRES_PER_DEGREE;
    var padLon = padLat / Math.max(Math.cos(lat * Math.PI / 180), 1e-6);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        for (var j = 1; j < line.length; j++) {
            var a = line[j - 1], b = line[j];
            // Per-segment bbox reject before the projection maths.
            if (lat < Math.min(a[0], b[0]) - padLat || lat > Math.max(a[0], b[0]) + padLat) continue;
            if (lon < Math.min(a[1], b[1]) - padLon || lon > Math.max(a[1], b[1]) + padLon) continue;
            if (distPointToSegmentMetres(lat, lon, a[0], a[1], b[0], b[1]) <= maxMetres) return true;
        }
    }
    return false;
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

// Hotline points for the FULL route geometry, coloured by the elevation
// samples. sampleRoute keeps only the first vertex after each 50 m, so drawing
// the samples themselves chorded across corners — a 200 m residential block
// with no intermediate vertices became one straight line through the houses.
// Samples are a subsequence of coords, so walk both in step: each vertex takes
// the grade of the sample segment it sits in. Grade is clamped to ±15% for the
// colour map. Returns [[lat, lon, grade%], ...], one per coords entry.
function gradeAlongRoute(coords, samples) {
    var grades = [0]; // grades[j] = grade of segment samples[j-1] → samples[j]
    for (var i = 1; i < samples.length; i++) {
        var a = samples[i - 1], b = samples[i];
        var dist = haversine(a.lat, a.lon, b.lat, b.lon);
        var g = dist > 0 ? ((b.elevation - a.elevation) / dist) * 100 : 0;
        grades.push(Math.max(-15, Math.min(15, g)));
    }
    var out = [[coords[0][0], coords[0][1], 0]]; // first point is flat
    var j = 0; // index of the last sample passed
    for (var c = 1; c < coords.length; c++) {
        var p = coords[c];
        var nxt = samples[j + 1];
        // Compared at 5 dp: elevation results can come from the cache, which is
        // keyed at 5 dp, so their lat/lon needn't be bit-identical to the vertex.
        var isSample = !!nxt && p[0].toFixed(5) === nxt.lat.toFixed(5) && p[1].toFixed(5) === nxt.lon.toFixed(5);
        if (isSample) j++;
        // A sample vertex takes the grade of the segment it closes (the old
        // per-sample convention); a vertex between samples takes the grade of
        // the segment it's on.
        var g = isSample ? grades[j] : grades[Math.min(j + 1, grades.length - 1)];
        out.push([p[0], p[1], g]);
    }
    return out;
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
        gradeAlongRoute: gradeAlongRoute,
        computeAscent: computeAscent,
        // Routing/graph helpers — exported for the headless test suite and for
        // asserting parity with the duplicated pure functions in build-tiles.js.
        nodeKey: nodeKey,
        pathGeomLength: pathGeomLength,
        dijkstra: dijkstra,
        // Exported so the test suite can re-derive MIN_EDGE_MULTIPLIER from the
        // live weight tables and fail if a future edit breaks A* admissibility.
        routingProfile: routingProfile,
        MIN_EDGE_MULTIPLIER: MIN_EDGE_MULTIPLIER,
        MinHeap: MinHeap,
        closestNode: closestNode,
        gridInsert: gridInsert,
        resetSpatialGrid: resetSpatialGrid,
        sampleRoute: sampleRoute,
        waypointHash: waypointHash,
        nodeAttrsFromTags: nodeAttrsFromTags,
        poiFromOsmElement: poiFromOsmElement,
        distPointToSegmentMetres: distPointToSegmentMetres,
        filterPoisNearRoute: filterPoisNearRoute,
        compactToGeoJSON: compactToGeoJSON,
        bikeOnewayFromTags: bikeOnewayFromTags,
        onewayEdgeCosts: onewayEdgeCosts,
        setClimbWeight: setClimbWeight,
        setTurnCost: setTurnCost,
        bearingDeg: bearingDeg,
        PackedGraph: PackedGraph,
        quantise6: quantise6,
        decodeElevations: decodeElevations,
        ONEWAY_PUSH_MULTIPLIER: ONEWAY_PUSH_MULTIPLIER,
        osmToGeoJSON: osmToGeoJSON,
    };
}

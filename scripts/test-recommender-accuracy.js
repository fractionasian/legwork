#!/usr/bin/env node
// scripts/test-recommender-accuracy.js
//
// Headless characterisation of the route recommender's distance accuracy
// against real city-tile data. Loads a contiguous block of tiles, rebuilds
// the routing graph (mirroring applyPaths in tiles.js), then sweeps
// (start × target distance × mode × seed) running recommendRoute and
// summarising the resulting actual-vs-target error distribution.
//
// Usage:  node scripts/test-recommender-accuracy.js [city]
//         (city defaults to "perth")
//
// Exit code 0 if ≥80% of runs land within ±15% of target (the spec's
// Phase 1 acceptance criterion); 1 otherwise. CI-friendly.

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var CITY = process.argv[2] || "perth";
var REPO = path.resolve(__dirname, "..");
var TILE_DIR = path.join(REPO, "data", "tiles", CITY);
// 6 tiles ≈ what tilesInRadius() picks at 5 km in tiles.js, so the graph
// size matches what a real user session loads. Going wider just makes
// Dijkstra slow without changing the test signal.
var TILE_BUDGET = 6;

// ── Load routing.js into a sandboxed context ──────────
var ctx = { console: console, Math: Math, Date: Date };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(REPO, "routing.js"), "utf8"), ctx);

// ── Build the graph (mirrors applyPaths sans Leaflet) ──
function buildGraph(tilePaths) {
    var graph = {};
    var edgeMeta = {};
    var nodeAttrs = {};
    var seenIds = {};
    var edgeCount = 0;

    for (var t = 0; t < tilePaths.length; t++) {
        var data = JSON.parse(fs.readFileSync(tilePaths[t], "utf8"));
        var fc = ctx.compactToGeoJSON(data);
        if (fc.nodeAttrs) {
            var nks = Object.keys(fc.nodeAttrs);
            for (var nk = 0; nk < nks.length; nk++) nodeAttrs[nks[nk]] = fc.nodeAttrs[nks[nk]];
        }
        for (var fi = 0; fi < fc.features.length; fi++) {
            var f = fc.features[fi];
            if (seenIds[f.properties.id]) continue;
            seenIds[f.properties.id] = true;
            var props = f.properties;
            var coords = f.geometry.coordinates;
            var hw = props.highway || "";
            var named = !!(props.name && props.name.length);
            var baseWeight = (ctx.ROAD_WEIGHT[hw] || 1.2) * ctx.wayPrefMultiplier(hw, props.surface || "", props.name || "");
            for (var c = 1; c < coords.length; c++) {
                var lat1 = coords[c-1][1], lon1 = coords[c-1][0];
                var lat2 = coords[c][1], lon2 = coords[c][0];
                var k1 = ctx.nodeKey(lat1, lon1), k2 = ctx.nodeKey(lat2, lon2);
                var eid = k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
                if (edgeMeta[eid]) continue;
                edgeMeta[eid] = { hw: hw, named: named };
                var nodeMult = ctx.nodePrefMultiplier(nodeAttrs[k1]) * ctx.nodePrefMultiplier(nodeAttrs[k2]);
                var d = ctx.haversine(lat1, lon1, lat2, lon2) * baseWeight * nodeMult;
                if (!graph[k1]) { graph[k1] = []; ctx.gridInsert(k1, lat1, lon1); }
                if (!graph[k2]) { graph[k2] = []; ctx.gridInsert(k2, lat2, lon2); }
                graph[k1].push({ key: k2, lat: lat2, lon: lon2, dist: d });
                graph[k2].push({ key: k1, lat: lat1, lon: lon1, dist: d });
                edgeCount++;
            }
        }
    }
    return { graph: graph, edgeMeta: edgeMeta, edgeCount: edgeCount };
}

// ── Tile selection: pick a contiguous block around centre ──
function pickTiles(tileDir, budget) {
    var files = fs.readdirSync(tileDir).filter(function (f) { return f.endsWith(".json"); });
    // Tile filenames are "row_col.json"; sort by Manhattan distance from
    // a synthetic centre so we get a connected blob, not random scatter.
    var rowCols = files.map(function (f) {
        var m = f.match(/^(-?\d+)_(-?\d+)\.json$/);
        return m ? { f: f, r: parseInt(m[1], 10), c: parseInt(m[2], 10) } : null;
    }).filter(Boolean);
    if (rowCols.length === 0) return [];
    var avgR = rowCols.reduce(function (s, t) { return s + t.r; }, 0) / rowCols.length;
    var avgC = rowCols.reduce(function (s, t) { return s + t.c; }, 0) / rowCols.length;
    rowCols.sort(function (a, b) {
        return (Math.abs(a.r - avgR) + Math.abs(a.c - avgC)) - (Math.abs(b.r - avgR) + Math.abs(b.c - avgC));
    });
    return rowCols.slice(0, budget).map(function (t) { return path.join(tileDir, t.f); });
}

// ── Deterministic random start picks ──────────────────
// Reuse the seededRandom from routing.js so runs are reproducible.
function pickStartNodes(graph, n, seed) {
    var keys = Object.keys(graph);
    // Bias toward nodes with degree ≥3 — actual intersections, not
    // mid-segment vertices — so we model "user opens app at a road
    // junction" rather than "at a random GPS coord on a footpath".
    var hubs = keys.filter(function (k) { return (graph[k] || []).length >= 3; });
    var pool = hubs.length > n * 5 ? hubs : keys;
    var rng = ctx.seededRandom(seed);
    var picks = [];
    var seen = {};
    while (picks.length < n && picks.length < pool.length) {
        var idx = Math.floor(rng() * pool.length);
        var k = pool[idx];
        if (seen[k]) continue;
        seen[k] = true;
        picks.push(k);
    }
    return picks;
}

// ── Run sweep ─────────────────────────────────────────
function fmt(n) { return (n >= 0 ? "+" : "") + n.toFixed(1); }
function pct(n) { return (n * 100).toFixed(1) + "%"; }

function main() {
    if (!fs.existsSync(TILE_DIR)) {
        console.error("No tile dir: " + TILE_DIR);
        process.exit(2);
    }
    var tilePaths = pickTiles(TILE_DIR, TILE_BUDGET);
    console.log("[" + CITY + "] Loading " + tilePaths.length + " tiles…");
    var t0 = Date.now();
    var built = buildGraph(tilePaths);
    var nodes = Object.keys(built.graph).length;
    console.log("[" + CITY + "] Graph: " + nodes + " nodes, " + built.edgeCount + " edges (" + (Date.now() - t0) + "ms)");

    var starts = pickStartNodes(built.graph, 8, 42);
    var targets = [3000, 5000, 8000];
    var modes = ["loop", "outback"];
    var seeds = [1, 2, 3];

    var results = [];
    var t1 = Date.now();
    for (var s = 0; s < starts.length; s++) {
        for (var ti = 0; ti < targets.length; ti++) {
            for (var mi = 0; mi < modes.length; mi++) {
                for (var sd = 0; sd < seeds.length; sd++) {
                    var r = ctx.recommendRoute(built.graph, built.edgeMeta, starts[s], {
                        distanceM: targets[ti], mode: modes[mi], seed: seeds[sd], count: 6,
                    });
                    if (!r.candidates || r.candidates.length === 0) {
                        results.push({ target: targets[ti], mode: modes[mi], seed: seeds[sd], failed: true });
                        continue;
                    }
                    var top = r.candidates[0];
                    results.push({
                        target: targets[ti],
                        mode: modes[mi],
                        seed: seeds[sd],
                        actual: top.displayDist,
                        errorPct: (top.displayDist - targets[ti]) / targets[ti],
                        score: top.score,
                        walkway: top.scoreBreakdown.walkwayFrac,
                        mainRoad: top.scoreBreakdown.mainRoadFrac,
                        named: top.scoreBreakdown.namedFrac,
                        nCandidates: r.candidates.length,
                    });
                }
            }
        }
    }
    console.log("[" + CITY + "] " + results.length + " generations in " + (Date.now() - t1) + "ms");

    summarise(results);
    var withinSpec = results.filter(function (r) { return !r.failed && Math.abs(r.errorPct) <= 0.15; }).length;
    var rate = withinSpec / results.length;
    console.log("\n[" + CITY + "] " + withinSpec + "/" + results.length + " runs within ±15% (spec target ≥80%): " + pct(rate));
    process.exit(rate >= 0.8 ? 0 : 1);
}

function summarise(results) {
    var byBucket = {};
    function bucket(target, mode) { return target / 1000 + "km " + mode; }
    for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var b = bucket(r.target, r.mode);
        if (!byBucket[b]) byBucket[b] = [];
        byBucket[b].push(r);
    }

    console.log("\nBucket           N    Failed   Mean err   Median err   Within ±15%   Walkway%   MainRd%   Named%");
    console.log("──────────────────────────────────────────────────────────────────────────────────────────────────");
    var keys = Object.keys(byBucket).sort();
    for (var k = 0; k < keys.length; k++) {
        var rs = byBucket[keys[k]];
        var ok = rs.filter(function (r) { return !r.failed; });
        var failed = rs.length - ok.length;
        if (ok.length === 0) {
            console.log(pad(keys[k], 16) + " " + pad(rs.length, 4) + " " + pad(failed, 8) + " (all failed)");
            continue;
        }
        var errs = ok.map(function (r) { return r.errorPct; });
        var mean = errs.reduce(function (a, b) { return a + b; }, 0) / errs.length;
        var sorted = errs.slice().sort(function (a, b) { return a - b; });
        var median = sorted[Math.floor(sorted.length / 2)];
        var hits = ok.filter(function (r) { return Math.abs(r.errorPct) <= 0.15; }).length;
        var avgWalk = ok.reduce(function (s, r) { return s + r.walkway; }, 0) / ok.length;
        var avgMain = ok.reduce(function (s, r) { return s + r.mainRoad; }, 0) / ok.length;
        var avgNamed = ok.reduce(function (s, r) { return s + r.named; }, 0) / ok.length;
        console.log(
            pad(keys[k], 16) + " " +
            pad(rs.length, 4) + " " +
            pad(failed, 8) + " " +
            pad(fmt(mean * 100) + "%", 10) + " " +
            pad(fmt(median * 100) + "%", 12) + " " +
            pad(pct(hits / ok.length), 13) + " " +
            pad(pct(avgWalk), 10) + " " +
            pad(pct(avgMain), 9) + " " +
            pad(pct(avgNamed), 7)
        );
    }
}

function pad(s, w) {
    s = String(s);
    while (s.length < w) s += " ";
    return s;
}

main();

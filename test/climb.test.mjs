// Climb-aware routing: heights ride in the tiles, applyPaths charges for the
// climb, and the router takes a flatter street when the weight is on.
//
// applyPaths lives in tiles.js, which is a browser script (shared globals, no
// exports). Rather than copy its edge-cost logic into the test — where it could
// drift from the shipping code — these tests run the REAL routing.js + tiles.js
// in a vm sandbox and call the real applyPaths.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// A fresh app per test: its own module-level CLIMB_WEIGHT, graph and state.
function loadApp(profile = "run") {
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    state: { profile },
  });
  vm.runInContext(read("routing.js"), ctx, { filename: "routing.js" });
  vm.runInContext(read("tiles.js"), ctx, { filename: "tiles.js" });
  // These tests start from the plain router and turn each cost on themselves; the shipped
  // defaults are asserted separately in climb.test.mjs.
  vm.runInContext("setClimbWeight(0); setTurnCost(0);", ctx);
  return ctx;
}

// Heights are decimetres: first value absolute, then the step to each next vertex.
const dm = (metres) => metres.map((m, i) => Math.round(m * 10) - (i ? Math.round(metres[i - 1] * 10) : 0));

// One tile feature in the v2 compact format (surface "" and ow 0 placeholders, then heights).
const way = (id, coords, metres) => [id, "residential", "", coords, "", 0, ...(metres ? [dm(metres)] : [])];

function apply(app, ways) {
  const fc = app.compactToGeoJSON({ v: 2, features: ways });
  app.applyPaths(fc, { skipRender: true });
  return app.state.graph;
}

const A = [115.8600, -31.9500];            // [lon, lat]
const B = [115.8632, -31.9500];            // ~300 m east of A
const M = [115.8616, -31.9500];            // midpoint of the direct street — the hump
const C = [115.8616, -31.9490];            // ~110 m north: the flat way round

test("compactToGeoJSON decodes heights; a bad or missing array is ignored", () => {
  const app = loadApp();
  const good = app.compactToGeoJSON({ v: 2, features: [way(1, [A, M, B], [10, 40.5, 10])] });
  assert.deepEqual(Array.from(good.features[0].properties.elev), [10, 40.5, 10]);
  // old tiles: no 7th element
  assert.equal(app.compactToGeoJSON({ v: 2, features: [way(1, [A, M, B])] }).features[0].properties.elev, undefined);
  // one value per coordinate or nothing — a short array must not misalign the rest
  const short = [1, "residential", "", [A, M, B], "", 0, [100, 50]];
  assert.equal(app.compactToGeoJSON({ v: 2, features: [short] }).features[0].properties.elev, undefined);
  // v1 array tiles still parse
  assert.equal(app.compactToGeoJSON([[1, "residential", "", [A, B]]]).features.length, 1);
});

// The charge on A -> B, a 10 m rise, read back through the graph's own debug view. The
// weight is read live at search time, so one graph answers for every weight.
function climbProbe() {
  const app = loadApp();
  const g = apply(app, [way(1, [A, B], [10, 20])]);
  const ka = app.nodeKey(A[1], A[0]), kb = app.nodeKey(B[1], B[0]);
  const dist = (from, to) => g.edgesFrom(from).find((e) => e.key === to).dist;
  const base = dist(ka, kb);
  return { app, charge: () => dist(ka, kb) - base, back: () => dist(kb, ka), ka, kb };
}

test("setClimbWeight accepts a sane number and treats everything else as off", () => {
  const { app, charge } = climbProbe();
  assert.equal(charge(), 0);                              // off at baseline
  app.setClimbWeight("8");  assert.equal(charge(), 80);   // the ?climb= param arrives as a string
  app.setClimbWeight(0);    assert.equal(charge(), 0);
  for (const bad of [null, undefined, "abc", NaN, -5, "-1", Infinity]) {
    app.setClimbWeight(8);
    app.setClimbWeight(bad);
    assert.equal(charge(), 0, `weight ${String(bad)} should switch it off`);
  }
  app.setClimbWeight(1e6);
  assert.equal(charge(), 50 * 10, "an absurd weight is capped, not obeyed");
});

test("the climb is charged uphill only, in the direction travelled", () => {
  const { app, charge, back } = climbProbe();
  const flatBack = back();
  app.setClimbWeight(8);
  assert.equal(charge(), 80);                 // A -> B climbs 10 m
  assert.equal(back(), flatBack);             // B -> A descends: free
  // an edge with no rise charges nothing either way, at any weight
  const dist = (weight) => {
    const f = loadApp(); f.setClimbWeight(weight);
    const gg = apply(f, [way(2, [A, B], [10, 10])]);
    return gg.edgesFrom(f.nodeKey(A[1], A[0])).find((e) => e.key === f.nodeKey(B[1], B[0]));
  };
  assert.equal(dist(8).dist, dist(0).dist);
  assert.equal(dist(8).up, 0);
});

test("applyPaths stores each edge's rise and the weight adds it on the uphill direction only", () => {
  const edge = (g, from, to) => g.edgesFrom(app.nodeKey(from[1], from[0])).find((e) => e.key === app.nodeKey(to[1], to[0]));
  // weight off: the climb is invisible
  var app = loadApp();
  let g = apply(app, [way(1, [A, B], [10, 20])]);
  const off = edge(g, A, B).dist;
  assert.equal(edge(g, B, A).dist, off, "off: both directions cost the same");
  assert.ok(Math.abs(edge(g, A, B).up - 10) < 1e-9 && edge(g, B, A).up === 0, "rise is recorded one way only");
  // weight on: A→B climbs 10 m, B→A descends
  app = loadApp();
  app.setClimbWeight(8);
  g = apply(app, [way(1, [A, B], [10, 20])]);
  assert.ok(Math.abs(edge(g, A, B).dist - (off + 80)) < 1e-9, "uphill pays 8 per metre");
  assert.ok(Math.abs(edge(g, B, A).dist - off) < 1e-9, "downhill is free");
});

test("with no heights in the tile, the weight changes nothing", () => {
  const dist = (weight) => {
    const app = loadApp();
    app.setClimbWeight(weight);
    apply(app, [way(1, [A, M, B])]);
    return app.dijkstra(app.state.graph, app.nodeKey(A[1], A[0]), app.nodeKey(B[1], B[0])).dist;
  };
  assert.equal(dist(8), dist(0));
});

// A ── hump (+30 m) ── B is the direct street. A → C → B is ~70 m longer but flat.
const hilly = [way(1, [A, M, B], [10, 40, 10]), way(2, [A, C], [10, 10]), way(3, [C, B], [10, 10])];
const route = (app) => app.dijkstra(app.state.graph, app.nodeKey(A[1], A[0]), app.nodeKey(B[1], B[0]));

test("the router goes straight over the hill with the weight off, and round it with the weight on", () => {
  let app = loadApp();
  apply(app, hilly);
  const direct = route(app);
  assert.equal(direct.path.length, 3, "off: A → hump → B");

  app = loadApp();
  app.setClimbWeight(8);
  apply(app, hilly);
  const flat = route(app);
  assert.equal(flat.path.length, 3, "on: A → C → B");
  assert.notDeepEqual(flat.path, direct.path);
  assert.ok(flat.path[1].startsWith("-31.949000"), "the middle stop is the northern flat corner");
});

test("a small weight is not enough to leave the direct street (the preference stays gentle)", () => {
  const app = loadApp();
  app.setClimbWeight(0.5);   // 30 m of climb costs 15 here, less than the ~70 m detour
  apply(app, hilly);
  assert.equal(route(app).path.length, 3);
  assert.ok(route(app).path[1].startsWith("-31.950000"), "still over the hump");
});

test("rebuilding the graph for the other profile keeps the climb charge", () => {
  const app = loadApp("run");
  app.setClimbWeight(8);
  apply(app, hilly);
  app.state.profile = "bike";
  app.rebuildGraphForProfile();
  assert.ok(route(app).path[1].startsWith("-31.949000"), "bike also goes round");
});

test("A* still returns the exact least-cost route with climb costs on (heuristic stays admissible)", () => {
  // 6x6 street grid with lumpy heights. Compare dijkstra() — A*, on the packed graph —
  // against plain Dijkstra over the same edge costs, run on an object graph with no
  // coordinates (so its heuristic is off).
  const app = loadApp();
  app.setClimbWeight(25);
  const N = 6, step = 0.001;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pt = (i, j) => [115.86 + j * step, -31.95 - i * step];
  const h = Array.from({ length: N }, () => Array.from({ length: N }, () => Math.round(rnd() * 400) / 10));
  const ways = [];
  let id = 1;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (j + 1 < N) ways.push(way(id++, [pt(i, j), pt(i, j + 1)], [h[i][j], h[i][j + 1]]));
    if (i + 1 < N) ways.push(way(id++, [pt(i, j), pt(i + 1, j)], [h[i][j], h[i + 1][j]]));
  }
  const graph = apply(app, ways);
  const plain = {};
  for (const k of graph.nodeKeys()) plain[k] = graph.edgesFrom(k).map((e) => ({ key: e.key, dist: e.dist }));
  const key = (i, j) => app.nodeKey(pt(i, j)[1], pt(i, j)[0]);
  for (const [a, b] of [[[0, 0], [5, 5]], [[5, 0], [0, 5]], [[2, 3], [4, 1]], [[0, 5], [5, 0]]]) {
    const star = app.dijkstra(graph, key(...a), key(...b));
    const ref = app.dijkstra(plain, key(...a), key(...b)); // no lat/lon on its edges → heuristic off
    assert.ok(Math.abs(star.dist - ref.dist) < 1e-6, `${a}→${b}: A* ${star.dist} vs Dijkstra ${ref.dist}`);
  }
});

test("a fresh page routes with climb 8 and turn 15 unless ?climb=0 / ?turn=0 say otherwise", () => {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, state: { profile: "run" } });
  vm.runInContext(read("routing.js"), ctx, { filename: "routing.js" });
  assert.equal(vm.runInContext("CLIMB_WEIGHT", ctx), 8);
  assert.equal(vm.runInContext("TURN_COST", ctx), 15);
  vm.runInContext('setClimbWeight("0"); setTurnCost("0");', ctx);   // what the URL params hand over
  assert.equal(vm.runInContext("CLIMB_WEIGHT", ctx), 0);
  assert.equal(vm.runInContext("TURN_COST", ctx), 0);
});

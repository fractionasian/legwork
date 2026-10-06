// PackedGraph: the routing graph as typed arrays. These tests pin the behaviours the app
// relies on: a coordinate is one node whichever way it is spelled, tiles can be added as
// they stream in, and searches give the same costs as the plain-object implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const R = require("../routing.js");
// Baseline for the comparisons below: the plain-object graph has no turn or climb model, so
// switch both off (the shipped defaults are 8 and 15).
R.setClimbWeight(0); R.setTurnCost(0);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
function loadApp(profile = "run") {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, state: { profile } });
  vm.runInContext(read("routing.js"), ctx, { filename: "routing.js" });
  vm.runInContext(read("tiles.js"), ctx, { filename: "tiles.js" });
  // These tests start from the plain router and turn each cost on themselves; the shipped
  // defaults are asserted separately in climb.test.mjs.
  vm.runInContext("setClimbWeight(0); setTurnCost(0);", ctx);
  return ctx;
}
const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

test("a coordinate is the same node however it is spelled, and its key is the one nodeKey makes", () => {
  const rnd = seeded(3), g = new R.PackedGraph();
  for (let i = 0; i < 2000; i++) {
    // half 5 dp (tiles), half 7 dp (live Overpass), including values with a trailing 5 at 7 dp
    const dp = i % 2 ? 5 : 7;
    const lat = Number((-31.9 - rnd() * 0.3).toFixed(dp)), lon = Number((115.7 + rnd() * 0.3).toFixed(dp));
    const n = g.node(R.quantise6(lat), R.quantise6(lon));
    assert.equal(g.keyOf(n), R.nodeKey(lat, lon), `${lat},${lon}`);
    assert.equal(g.indexOf(R.nodeKey(lat, lon)), n, "lookup by the app's own key");
    assert.equal(g.node(R.quantise6(lat), R.quantise6(lon)), n, "same coordinate, same node");
  }
});

test("the node table grows without losing or duplicating nodes", () => {
  const g = new R.PackedGraph(), rnd = seeded(9), seen = new Map();
  for (let i = 0; i < 60000; i++) {
    const la = Math.floor(rnd() * 400) * 1000 - 32000000, lo = Math.floor(rnd() * 400) * 1000 + 115000000; // many repeats
    const n = g.node(la, lo), k = la + "," + lo;
    if (seen.has(k)) assert.equal(n, seen.get(k)); else seen.set(k, n);
  }
  assert.equal(g.nNodes, seen.size, "no duplicates");
  for (const [k, n] of seen) { const [la, lo] = k.split(",").map(Number); assert.equal(g.find(la, lo), n); }
  assert.equal(g.find(1, 1), -1);
});

test("a segment is added once, in whichever direction it is seen first, and one-ways stay one-way", () => {
  const g = new R.PackedGraph(), a = g.node(1000000, 2000000), b = g.node(1000000, 2001000), c = g.node(1001000, 2000000);
  assert.equal(g.connected(a, b), false);
  g.addEdge(a, b, 10, 0);
  assert.ok(g.connected(a, b) && g.connected(b, a), "either direction counts as present");
  assert.equal(g.connected(a, c), false);
  g.addEdge(c, a, 5, 0);                       // a one-way c -> a
  assert.ok(g.connected(a, c));
  assert.equal(g.nEdges, 2);
});

test("applyPaths ignores a segment it has already seen, from another way or another tile", () => {
  const app = loadApp();
  const A = [115.86, -31.95], B = [115.861, -31.95];
  const way = (id, c) => [id, "residential", "", c];
  app.applyPaths(app.compactToGeoJSON({ v: 2, features: [way(1, [A, B])] }), { skipRender: true });
  const n = app.state.graph.nEdges;
  app.applyPaths(app.compactToGeoJSON({ v: 2, features: [way(2, [B, A])] }), { skipRender: true });   // same street, drawn backwards, new id
  assert.equal(app.state.graph.nEdges, n);
});

test("nearest node matches the plain-object search, including 'nothing close enough'", () => {
  // The cloud stays clear of exact 0.005-degree cell boundaries. A node sitting exactly on
  // one can differ: the plain-object grid keys cells by formatted strings, so float fuzz can
  // drop it a cell over (and out of the 7-cell radius); PackedGraph uses one integer formula
  // for nodes and queries, so it is consistent there.
  const rnd = seeded(5), g = new R.PackedGraph(), plain = {};
  R.resetSpatialGrid();
  for (let i = 0; i < 3000; i++) {
    const lat = -31.99 + rnd() * 0.059, lon = 115.80 + rnd() * 0.079;
    const k = R.nodeKey(lat, lon);
    g.node(R.quantise6(lat), R.quantise6(lon));
    if (!plain[k]) { plain[k] = []; R.gridInsert(k, lat, lon); }
  }
  for (let i = 0; i < 400; i++) {
    const lat = -32.05 + rnd() * 0.18, lon = 115.75 + rnd() * 0.2;       // some well outside the cloud
    assert.equal(g.closest(lat, lon), R.closestNode(plain, lat, lon), `${lat},${lon}`);
  }
  R.resetSpatialGrid();
});

// A random planar-ish street graph, built into both representations with the same costs.
function randomGraph(n, seed) {
  const rnd = seeded(seed), pts = [];
  for (let i = 0; i < n; i++) pts.push([-31.99 + rnd() * 0.04, 115.82 + rnd() * 0.05]);
  const edges = [];
  for (let i = 0; i < n; i++) {
    const near = pts.map((p, j) => [R.haversine(pts[i][0], pts[i][1], p[0], p[1]), j]).filter((x) => x[1] !== i).sort((a, b) => a[0] - b[0]).slice(0, 4);
    for (const [d, j] of near) edges.push([i, j, d * (0.7 + rnd() * 1.8)]);       // weight >= 0.7 keeps the heuristic admissible
  }
  const g = new R.PackedGraph(), plain = {};
  const key = (i) => R.nodeKey(pts[i][0], pts[i][1]);
  const idx = pts.map((p) => g.node(R.quantise6(p[0]), R.quantise6(p[1])));
  for (const [i, j, c] of edges) {
    if (!g.connected(idx[i], idx[j])) { g.addEdge(idx[i], idx[j], c, 0); g.addEdge(idx[j], idx[i], c, 0); }
  }
  for (let i = 0; i < n; i++) plain[key(i)] = [];
  const seen = new Set();
  for (const [i, j, c] of edges) {
    const id = Math.min(i, j) + "|" + Math.max(i, j);
    if (seen.has(id)) continue; seen.add(id);
    plain[key(i)].push({ key: key(j), lat: pts[j][0], lon: pts[j][1], dist: c });
    plain[key(j)].push({ key: key(i), lat: pts[i][0], lon: pts[i][1], dist: c });
  }
  return { g, plain, key, n, rnd };
}

test("routes cost exactly what the plain-object A* finds, on random street graphs", () => {
  const { g, plain, key, n, rnd } = randomGraph(400, 21);
  let compared = 0;
  for (let q = 0; q < 60; q++) {
    const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n);
    const want = R.dijkstra(plain, key(a), key(b)), got = R.dijkstra(g, key(a), key(b));
    if (!want) { assert.equal(got, null); continue; }
    assert.ok(Math.abs(got.dist - want.dist) <= 1e-9 * Math.max(1, want.dist), `${a}→${b}: ${got.dist} vs ${want.dist}`);
    assert.equal(got.path[0], key(a)); assert.equal(got.path[got.path.length - 1], key(b));
    compared++;
  }
  assert.ok(compared > 30, "enough connected pairs to mean something");
});

test("route() edge cases: same node, unknown key, unreachable", () => {
  const { g, key } = randomGraph(50, 4);
  assert.deepEqual({ ...R.dijkstra(g, key(3), key(3)), path: undefined }, { dist: 0, path: undefined });
  assert.deepEqual(Array.from(R.dijkstra(g, key(3), key(3)).path), [key(3)]);
  assert.equal(R.dijkstra(g, "-1.000000,1.000000", key(3)), null);
  assert.equal(R.dijkstra(g, "nonsense", key(3)), null);
  const island = g.node(R.quantise6(-31.5), R.quantise6(116.5));
  assert.equal(R.dijkstra(g, key(3), g.keyOf(island)), null);
});

test("tiles streaming in: a route across a shared border node, whichever tile arrives first", () => {
  const way = (id, c) => [id, "residential", "", c];
  const W = [115.860, -31.950], X = [115.861, -31.950], Y = [115.862, -31.950];        // X is the border node
  const tile1 = (app) => app.applyPaths(app.compactToGeoJSON({ v: 2, features: [way(1, [W, X])] }), { skipRender: true });
  const tile2 = (app) => app.applyPaths(app.compactToGeoJSON({ v: 2, features: [way(2, [X, Y])] }), { skipRender: true });
  for (const order of [[tile1, tile2], [tile2, tile1]]) {
    const app = loadApp();
    order[0](app);
    const mid = app.state.graph;
    order[1](app);
    assert.equal(app.state.graph, mid, "same graph object, grown in place");
    const r = app.dijkstra(app.state.graph, app.nodeKey(W[1], W[0]), app.nodeKey(Y[1], Y[0]));
    assert.equal(r.path.length, 3);
    assert.equal(app.state.graph.nNodes, 3, "the border node is shared, not duplicated");
  }
});

test("a search after the graph has outgrown its arrays is still right (scratch is rebuilt)", () => {
  const app = loadApp(), way = (id, c) => [id, "residential", "", c];
  const col = (i) => 115.86 + i * 0.0005;
  app.applyPaths(app.compactToGeoJSON({ v: 2, features: [way(1, [[col(0), -31.95], [col(1), -31.95]])] }), { skipRender: true });
  const k = (i) => app.nodeKey(-31.95, col(i));
  assert.equal(app.dijkstra(app.state.graph, k(0), k(1)).path.length, 2);
  // 5000 more segments: well past the initial 1024-node / 2048-edge capacity
  const feats = []; for (let i = 1; i < 5000; i++) feats.push(way(i + 1, [[col(i), -31.95], [col(i + 1), -31.95]]));
  app.applyPaths(app.compactToGeoJSON({ v: 2, features: feats }), { skipRender: true });
  const r = app.dijkstra(app.state.graph, k(0), k(4999));
  assert.equal(r.path.length, 5000);
  app.setTurnCost(15);                                                          // and the turn search too
  assert.equal(app.dijkstra(app.state.graph, k(0), k(4999)).path.length, 5000);
});

test("traffic signals and crossings still shape costs, and survive a profile rebuild", () => {
  const way = (id, c) => [id, "residential", "", c];
  const A = [115.860, -31.950], B = [115.861, -31.950];
  const costWith = (attrs) => {
    const app = loadApp();
    const gj = app.compactToGeoJSON({ v: 2, features: [way(1, [A, B])], nodeAttrs: attrs });
    app.applyPaths(gj, { skipRender: true });
    return app;
  };
  const key = (app, p) => app.nodeKey(p[1], p[0]);
  const plain = costWith(undefined), sig = costWith({ [R.nodeKey(A[1], A[0])]: { trafficSignal: true } });
  const d = (app) => app.dijkstra(app.state.graph, key(app, A), key(app, B)).dist;
  assert.ok(d(sig) > d(plain), "a signal at one end costs more");
  sig.rebuildGraphForProfile();
  assert.ok(d(sig) > d(plain), "and still does after the profile is rebuilt");
  sig.state.profile = "bike"; sig.rebuildGraphForProfile();
  assert.ok(sig.state.graph.attrsOf(sig.state.graph.indexOf(key(sig, A))), "attributes re-attached to the new graph");
});

test("a one-way street is one edge for the bike profile and two for the run profile", () => {
  const A = [115.860, -31.950], B = [115.861, -31.950];
  const way = [1, "residential", "", [A, B], "", 1];                               // ow = 1: forward only for bikes
  const edgesOf = (profile) => {
    const app = loadApp(profile);
    app.applyPaths(app.compactToGeoJSON({ v: 2, features: [way] }), { skipRender: true });
    return app.state.graph.nEdges;
  };
  assert.equal(edgesOf("run"), 2);
  assert.equal(edgesOf("bike"), 2, "bikes may push against a one-way (4x cost), so both edges exist");
});

test("a tile with no ways leaves the graph unset: 'graph exists' still means 'paths are loaded'", () => {
  // The app skips loading paths when state.graph is set, so an empty graph left behind by an
  // empty tile (or an empty Overpass reply) would read as "loaded, and no paths nearby".
  const app = loadApp();
  app.applyPaths(app.compactToGeoJSON({ v: 2, features: [] }), { skipRender: true });
  assert.ok(!app.state.graph);
  app.applyPaths(app.compactToGeoJSON({ v: 2, features: [], nodeAttrs: { "-31.950000,115.860000": { trafficSignal: true } } }), { skipRender: true });
  assert.ok(!app.state.graph, "attributes alone don't create it either");
  app.applyPaths(app.compactToGeoJSON({ v: 2, features: [[1, "residential", "", [[115.860, -31.950], [115.861, -31.950]]]] }), { skipRender: true });
  assert.ok(app.state.graph && app.state.graph.nEdges === 2);
  assert.ok(app.state.graph.attrsOf(app.state.graph.indexOf("-31.950000,115.860000")), "attributes received earlier are attached");
});

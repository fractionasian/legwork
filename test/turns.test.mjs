// Turn cost: a small charge per change of direction, so routes take one long run and a
// single corner instead of a staircase. Needs a search whose state is the directed edge
// (the cost depends on the way you arrived). Like climb.test.mjs, this runs the REAL
// routing.js + tiles.js in a vm sandbox and calls the real applyPaths.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

function loadApp(profile = "run") {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, state: { profile } });
  vm.runInContext(read("routing.js"), ctx, { filename: "routing.js" });
  vm.runInContext(read("tiles.js"), ctx, { filename: "tiles.js" });
  return ctx;
}
const way = (id, coords, highway = "residential") => [id, highway, "", coords];
function apply(app, ways) {
  app.applyPaths(app.compactToGeoJSON({ v: 2, features: ways }), { skipRender: true });
  return app.state.graph;
}

// A 5 x 5 street grid, ~100 m blocks. The boundary is a busier road (tertiary, weight
// 1.3) and the inside is residential (1.1), so WITHOUT a turn cost the cheapest route
// corner to corner is an interior staircase (~7 turns); the single-corner "L" runs
// along the boundary and costs more. Measured on this grid: no turn cost gives 4
// turns; 40 per turn gives 2; 100 per turn gives the single-corner L.
const N = 5, DLAT = 0.0009, DLON = 0.00106;
const pt = (i, j) => [115.86 + j * DLON, -31.95 - i * DLAT];            // [lon, lat]
const onEdge = (i, j) => i === 0 || i === N - 1 || j === 0 || j === N - 1;
function gridWays() {
  const ws = []; let id = 1;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (j + 1 < N) ws.push(way(id++, [pt(i, j), pt(i, j + 1)], (i === 0 || i === N - 1) ? "tertiary" : "residential"));
    if (i + 1 < N) ws.push(way(id++, [pt(i, j), pt(i + 1, j)], (j === 0 || j === N - 1) ? "tertiary" : "residential"));
  }
  return ws;
}
const key = (app, i, j) => app.nodeKey(pt(i, j)[1], pt(i, j)[0]);
const route = (app) => app.dijkstra(app.state.graph, key(app, 0, 0), key(app, N - 1, N - 1));
function turnsIn(app, p) {
  const c = p.map((k) => k.split(",").map(Number));
  let n = 0;
  for (let i = 2; i < c.length; i++) {
    const a = app.bearingDeg(c[i - 2][0], c[i - 2][1], c[i - 1][0], c[i - 1][1]);
    const b = app.bearingDeg(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
    let d = Math.abs(b - a); if (d > 180) d = 360 - d;
    if (d >= 35) n++;
  }
  return n;
}

test("setTurnCost accepts a sane number and treats everything else as off", () => {
  const app = loadApp();
  const pen = () => app.turnPenalty(0, 90);
  assert.equal(pen(), 0);                                   // off by default
  app.setTurnCost("15"); assert.equal(pen(), 15);           // ?turn= arrives as a string
  app.setTurnCost(0);    assert.equal(pen(), 0);
  for (const bad of [null, undefined, "abc", NaN, -5, "-1", Infinity]) {
    app.setTurnCost(15); app.setTurnCost(bad);
    assert.equal(pen(), 0, `turn cost ${String(bad)} should switch it off`);
  }
  app.setTurnCost(1e6); assert.equal(pen(), 100, "an absurd cost is capped, not obeyed");
});

test("turnPenalty charges for a real change of direction, in both senses, across north", () => {
  const app = loadApp(); app.setTurnCost(15);
  assert.equal(app.turnPenalty(0, 10), 0);        // gentle bend
  assert.equal(app.turnPenalty(0, 34), 0);
  assert.equal(app.turnPenalty(0, 35), 15);
  assert.equal(app.turnPenalty(0, -90), 15);      // left or right
  assert.equal(app.turnPenalty(170, -170), 0);    // 20 degrees, the short way round
  assert.equal(app.turnPenalty(90, -90), 15);     // a U-turn
});

test("bearingDeg: cardinal directions, and a 45-degree street reads as 45 at Perth's latitude", () => {
  const app = loadApp();
  assert.ok(Math.abs(app.bearingDeg(-31.95, 115.86, -31.94, 115.86) - 0) < 1e-9);       // north
  assert.ok(Math.abs(app.bearingDeg(-31.95, 115.86, -31.95, 115.87) - 90) < 1e-6);      // east
  assert.ok(Math.abs(Math.abs(app.bearingDeg(-31.95, 115.86, -31.96, 115.86)) - 180) < 1e-9); // south
  const m = 100;                                                                          // 100 m north-east
  const dlat = m / 111320, dlon = m / (111320 * Math.cos(31.95 * Math.PI / 180));
  assert.ok(Math.abs(app.bearingDeg(-31.95, 115.86, -31.95 + dlat, 115.86 + dlon) - 45) < 0.1);
});

test("graph edges carry headings only while the turn cost is on", () => {
  let app = loadApp();
  apply(app, gridWays());
  assert.equal(Object.values(app.state.graph)[0][0].b, undefined, "off: graph is as light as before");
  app = loadApp(); app.setTurnCost(15);
  const g = apply(app, gridWays());
  const k = key(app, 0, 0), east = g[k].find((e) => e.key === key(app, 0, 1));
  assert.ok(Math.abs(east.b - 90) < 0.5, `east heading ${east.b}`);
  const back = g[key(app, 0, 1)].find((e) => e.key === k);
  assert.ok(Math.abs(Math.abs(back.b) - 90) < 0.5 && back.b < 0, `reverse edge heads west: ${back.b}`);
});

test("the more a turn costs, the fewer turns the route takes, down to one long run and a single corner", () => {
  const turnsAt = (cost) => {
    const app = loadApp(); app.setTurnCost(cost); apply(app, gridWays());
    return turnsIn(app, route(app).path);
  };
  const off = turnsAt(0), mid = turnsAt(40), high = turnsAt(100);
  assert.ok(off >= 3, `expected a staircase, got ${off} turns`);
  assert.ok(mid < off, `40 per turn should cut turns (${mid} vs ${off})`);
  assert.equal(high, 1, "100 per turn: one corner");
});

test("the price is paid in weighted distance, and a gentle cost does not force a detour", () => {
  let app = loadApp(); apply(app, gridWays());
  const off = route(app), offTurns = turnsIn(app, off.path);
  // 5 per turn: the route it picks costs the same as the old one before turn charges
  // (to within 1%: blocks differ by a few centimetres, so near-ties break differently)
  app = loadApp(); app.setTurnCost(5); apply(app, gridWays());
  const gentle = route(app);
  const gentleBase = gentle.dist - 5 * turnsIn(app, gentle.path);
  assert.ok(Math.abs(gentleBase - off.dist) < 0.01 * off.dist, `no detour for a small cost (${gentleBase} vs ${off.dist})`);
  assert.ok(turnsIn(app, gentle.path) <= offTurns);
  // 100 per turn: a real detour is accepted to cut turns
  app = loadApp(); app.setTurnCost(100); apply(app, gridWays());
  const firm = route(app);
  assert.ok(firm.dist - 100 * turnsIn(app, firm.path) > off.dist, "the corner-only route is longer in weighted distance");
});

test("the turn-aware search finds the exact least-cost route (checked against a plain edge-state Dijkstra)", () => {
  // 6 x 6 grid with jittered corners so headings vary, climb on too. The reference is a
  // plain Dijkstra over (previous node, node) with no heuristic.
  const app = loadApp(); app.setTurnCost(25); app.setClimbWeight(8);
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = 6, pts = [], ws = []; let id = 1;
  for (let i = 0; i < n; i++) { pts.push([]); for (let j = 0; j < n; j++) pts[i].push([115.86 + j * 0.001 + (rnd() - 0.5) * 0.0006, -31.95 - i * 0.0009 + (rnd() - 0.5) * 0.0004]); }
  const hts = pts.map((row) => row.map(() => Math.round(rnd() * 300) / 10));
  const dm = (a, b) => [Math.round(a * 10), Math.round(b * 10) - Math.round(a * 10)];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (j + 1 < n) ws.push([id++, "residential", "", [pts[i][j], pts[i][j + 1]], "", 0, dm(hts[i][j], hts[i][j + 1])]);
    if (i + 1 < n) ws.push([id++, "residential", "", [pts[i][j], pts[i + 1][j]], "", 0, dm(hts[i][j], hts[i + 1][j])]);
  }
  const g = apply(app, ws);
  const K = (i, j) => app.nodeKey(pts[i][j][1], pts[i][j][0]);
  function reference(s, t) {
    const dist = new Map(), done = new Set(), q = [];
    for (const e of g[s]) { dist.set(s + ">" + e.key, e.dist); q.push([e.dist, s, e]); }
    while (q.length) {
      q.sort((a, b) => a[0] - b[0]);
      const [d, u, e] = q.shift(), sk = u + ">" + e.key;
      if (done.has(sk)) continue; done.add(sk);
      if (e.key === t) return d;
      for (const e2 of g[e.key]) {
        const c = d + e2.dist + app.turnPenalty(e.b, e2.b), k2 = e.key + ">" + e2.key;
        if (!dist.has(k2) || c < dist.get(k2)) { dist.set(k2, c); q.push([c, e.key, e2]); }
      }
    }
    return null;
  }
  for (const [a, b] of [[[0, 0], [5, 5]], [[5, 0], [0, 5]], [[2, 3], [4, 1]], [[0, 5], [5, 0]], [[1, 1], [4, 4]]]) {
    const got = app.dijkstra(g, K(...a), K(...b)), want = reference(K(...a), K(...b));
    assert.ok(Math.abs(got.dist - want) < 1e-6, `${a}→${b}: ${got.dist} vs reference ${want}`);
  }
});

test("search state does not leak between searches or between pins' legs", () => {
  const app = loadApp(); app.setTurnCost(40); apply(app, gridWays());
  const a = route(app), b = route(app);
  assert.deepEqual(Array.from(a.path), Array.from(b.path));
  assert.equal(a.dist, b.dist);
  const back = app.dijkstra(app.state.graph, key(app, N - 1, N - 1), key(app, 0, 0));
  assert.ok(back && back.path.length === a.path.length);
});

test("start equals end, and unreachable nodes, behave", () => {
  const app = loadApp(); app.setTurnCost(15); apply(app, gridWays());
  const k = key(app, 0, 0);
  const same = app.dijkstra(app.state.graph, k, k);
  assert.equal(same.dist, 0);
  assert.deepEqual(Array.from(same.path), [k]);
  apply(app, [way(900, [[116.5, -32.5], [116.5004, -32.5]])]);                 // island
  assert.equal(app.dijkstra(app.state.graph, k, app.nodeKey(-32.5, 116.5)), null);
});

test("turn cost and climb cost work together; rebuilding for the other profile keeps both", () => {
  // The bike profile weighs roads differently (boundary 1.15 vs interior 1.0), so its
  // cheapest route needn't be the single-corner L; the point is that the headings are
  // rebuilt and the turn cost still bites there.
  let off = loadApp("bike"); apply(off, gridWays());
  const bikeOffTurns = turnsIn(off, route(off).path);
  const app = loadApp(); app.setTurnCost(40); app.setClimbWeight(8);
  apply(app, gridWays());
  app.state.profile = "bike"; app.rebuildGraphForProfile();
  assert.equal(typeof Object.values(app.state.graph)[0][0].b, "number", "headings rebuilt");
  assert.ok(turnsIn(app, route(app).path) <= bikeOffTurns, "no more turns than with the cost off");
  assert.ok(turnsIn(app, route(app).path) <= 2);
});

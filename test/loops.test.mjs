// Target-distance loop generator (docs/design/target-distance-loops.md, PR 1).
// Synthetic graphs only; the real-tile numbers come from scripts/loop-harness.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../routing.js");

const LAT0 = -31.95, LON0 = 115.86, STEP = 100; // metres between grid nodes
const dLat = STEP / 111320, dLon = STEP / (111320 * Math.cos(LAT0 * Math.PI / 180));

// n × n street grid, STEP m apart, centred on (LAT0, LON0). Edge cost = length, so the
// router is the plain shortest path plus the shipped climb (0 here: no heights) and turn cost.
function grid(n) {
  const g = new R.PackedGraph(), id = [];
  const h = Math.floor(n / 2);
  for (let i = 0; i < n; i++) {
    id.push([]);
    for (let j = 0; j < n; j++) {
      id[i].push(g.node(R.quantise6(LAT0 + (i - h) * dLat), R.quantise6(LON0 + (j - h) * dLon)));
    }
  }
  const link = (u, v) => {
    const d = R.haversine(g.latQ[u] / 1e6, g.lonQ[u] / 1e6, g.latQ[v] / 1e6, g.lonQ[v] / 1e6);
    g.addEdge(u, v, d, 0); g.addEdge(v, u, d, 0);
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i + 1 < n) link(id[i][j], id[i + 1][j]);
    if (j + 1 < n) link(id[i][j], id[i][j + 1]);
  }
  return { g, centre: g.keyOf(id[h][h]) };
}
const noPause = () => Promise.resolve();

test("offsetPoint — 1 km north and east land 1 km away on the right heading", () => {
  for (const b of [0, 90, 180, 270, 45]) {
    const [lat, lon] = R.offsetPoint(LAT0, LON0, b, 1000);
    const d = R.haversine(LAT0, LON0, lat, lon);
    assert.ok(Math.abs(d - 1000) < 5, `bearing ${b}: ${d} m`);
    const got = (R.bearingDeg(LAT0, LON0, lat, lon) + 360) % 360;
    assert.ok(Math.abs(((got - b + 540) % 360) - 180) < 0.5, `bearing ${b}: heading ${got}`);
  }
});

test("scaler converges to within 5% in at most 4 routed attempts on a regular grid", () => {
  const { g, centre } = grid(81); // 8 km square
  for (const target of [3000, 5000, 8000, 10000]) {
    for (let bearing = 0; bearing < 360; bearing += 7) {
      const loop = R.scaleLoop(g, centre, target, bearing);
      assert.ok(loop, `${target} m @ ${bearing}°: no loop`);
      assert.ok(loop.tries.length <= 4);
      // The returned loop can trade a little length for less doubling back (betterLoop),
      // so convergence is judged on the attempts, and the pick must still be acceptable.
      const closest = Math.min(...loop.tries.map((t) => Math.abs(t.length - target) / target));
      // On 100 m blocks a loop's length moves in ~200 m steps, so at 3 km only one routable
      // length sits inside ±5% (a ~15 m window of r). Hold 3 km to the 10% accept band;
      // from 5 km a step is under the 5% window and the aim must be reached.
      const aim = target < 5000 ? R.LOOP_ACCEPT : R.LOOP_AIM;
      assert.ok(closest <= aim, `${target} m @ ${bearing}°: ${loop.tries.map((t) => Math.round(t.length)).join(", ")}`);
      assert.ok(loop.error <= R.LOOP_ACCEPT);
    }
  }
});

test("a generated loop's waypoints re-route to exactly the length that was measured", () => {
  // This is the promise that lets PR 2 hand [S, A, B] to the normal pipeline: loop mode
  // routes S→A, A→B and B→S with the same dijkstra(), so the drawn loop is the measured one.
  const { g, centre } = grid(81);
  const loop = R.loopCandidate(g, centre, 5000, 75, 1);
  const [s, a, b] = loop.waypoints;
  const legs = [[s, a], [a, b], [b, s]].map(([u, v]) => R.pathGeomLength(R.dijkstra(g, u, v).path));
  assert.equal(legs.reduce((x, y) => x + y, 0), loop.length);
});

test("overlap — a pure out-and-back is 1, a clean loop is 0, a lollipop is in between", () => {
  const k = (i, j) => R.nodeKey(LAT0 + i * dLat, LON0 + j * dLon);
  const out = [k(0, 0), k(1, 0), k(2, 0), k(3, 0)];
  assert.equal(R.loopOverlap([out, out.slice().reverse()]), 1, "out-and-back");
  const square = [[k(0, 0), k(0, 1), k(0, 2)], [k(0, 2), k(1, 2), k(2, 2)], [k(2, 2), k(2, 1), k(2, 0)], [k(2, 0), k(1, 0), k(0, 0)]];
  assert.equal(R.loopOverlap(square), 0, "square");
  // Stick of 2 edges each way + a 4-edge ring: 4 of 8 edges on doubled ground.
  const lolly = [[k(0, 0), k(1, 0), k(2, 0), k(2, 1), k(3, 1), k(3, 0), k(2, 0), k(1, 0), k(0, 0)]];
  assert.ok(Math.abs(R.loopOverlap(lolly) - 0.5) < 0.01, `lollipop ${R.loopOverlap(lolly)}`);
  assert.ok(R.loopOverlap(lolly) > R.LOOP_OVERLAP_MAX, "and the 15% cap flags it");
});

test("generateLoops — three loops on three headings, sorted closest first, all within 10%", async () => {
  const { g, centre } = grid(81);
  const loops = await R.generateLoops(g, centre, 5000, { theta0: 10, pause: noPause });
  assert.equal(loops.length, 3);
  for (let i = 1; i < loops.length; i++) assert.ok(loops[i - 1].error <= loops[i].error);
  for (const l of loops) {
    assert.ok(l.ok && l.error <= R.LOOP_ACCEPT);
    assert.ok(l.overlap <= R.LOOP_OVERLAP_MAX, `overlap ${l.overlap}`);
    assert.equal(l.waypoints[0], centre, "starts (and so finishes) at the start pin");
  }
  const heads = loops.map((l) => Math.round(l.bearing - 10) % 360).sort((a, b) => a - b);
  assert.deepEqual(heads, [0, 120, 240]);
});

test("generateLoops — a dead-end start still returns its best loop, flagged with the overlap", async () => {
  // A single 3 km street: every "loop" is an out-and-back. Decision 5: show the
  // nearest with its true length, never nothing and never a silently wrong one.
  const g = new R.PackedGraph();
  let prev = -1, startKey = null;
  for (let i = 0; i <= 30; i++) {
    const n = g.node(R.quantise6(LAT0 + i * dLat), R.quantise6(LON0));
    if (i === 0) startKey = g.keyOf(n);
    if (prev >= 0) { g.addEdge(prev, n, STEP, 0); g.addEdge(n, prev, STEP, 0); }
    prev = n;
  }
  const loops = await R.generateLoops(g, startKey, 5000, { theta0: 0, pause: noPause });
  assert.ok(loops.length >= 1);
  const best = loops[0];
  assert.equal(best.overlap, 1);
  assert.ok(best.length > 0 && Number.isFinite(best.length));
  assert.equal(best.ok, Math.abs(best.length - 5000) / 5000 <= R.LOOP_ACCEPT, "ok matches the true length");
});

test("generateLoops — the stale guard drops results when the start moves mid-generation", async () => {
  const { g, centre } = grid(41);
  // The app's pattern: bump a generation counter on every change, capture it at start.
  let gen = 0;
  const mine = ++gen;
  let pauses = 0;
  const pause = () => { if (++pauses === 1) gen++; return Promise.resolve(); }; // start pin dragged after candidate 1
  const res = await R.generateLoops(g, centre, 3000, { theta0: 0, pause, isStale: () => gen !== mine });
  assert.equal(res, null, "stale run returns nothing to draw");
  assert.equal(pauses, 1, "and stops instead of routing the remaining candidates");

  const fresh = await R.generateLoops(g, centre, 3000, { theta0: 0, pause: noPause, isStale: () => false });
  assert.equal(fresh.length, 3);
});

test("generateLoops — no start node or no target gives an empty list, not a throw", async () => {
  const { g } = grid(5);
  assert.deepEqual(await R.generateLoops(g, null, 5000, { pause: noPause }), []);
  assert.deepEqual(await R.generateLoops(g, "1.000000,2.000000", 5000, { pause: noPause }), []);
  const { centre } = grid(5);
  assert.deepEqual(await R.generateLoops(g, centre, 0, { pause: noPause }), []);
});

test("closestNode minDegree — loop corners skip a cul-de-sac end for the junction at its mouth", () => {
  // A T: through street west-east, with a 300 m cul-de-sac running north from its middle.
  const g = new R.PackedGraph();
  const at = (i, j) => g.node(R.quantise6(LAT0 + i * dLat), R.quantise6(LON0 + j * dLon));
  const link = (u, v) => { g.addEdge(u, v, STEP, 0); g.addEdge(v, u, STEP, 0); };
  for (let j = -3; j < 3; j++) link(at(0, j), at(0, j + 1));
  for (let i = 0; i < 3; i++) link(at(i, 0), at(i + 1, 0));
  const tip = R.nodeKey(LAT0 + 3 * dLat, LON0), mouth = R.nodeKey(LAT0, LON0);
  assert.equal(R.closestNode(g, LAT0 + 3.2 * dLat, LON0), tip, "a pin still snaps to the nearest node");
  assert.equal(R.closestNode(g, LAT0 + 3.2 * dLat, LON0, 3), mouth, "a corner snaps to the junction");
});

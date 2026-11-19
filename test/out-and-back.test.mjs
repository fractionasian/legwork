// Out-and-back of N km (docs/design/target-distance-loops.md, decision 7, PR 3).
// Synthetic graphs only; the real-tile numbers come from scripts/loop-harness.mjs --kind outback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../routing.js");

const LAT0 = -31.95, LON0 = 115.86, STEP = 100; // metres between grid nodes
const dLat = STEP / 111320, dLon = STEP / (111320 * Math.cos(LAT0 * Math.PI / 180));
const noPause = () => Promise.resolve();

// n × n street grid, STEP m apart, centred on the start. Row i grows north, column j east
// (relative to the centre). Edge cost = length. Options, each given the two ends as
// (di, dj) offsets from the centre:
//   elev(di, dj): height in metres at a node (default flat: no heights at all);
//   path(a, b): the edge is on a path-class way;
//   main(a, b): the edge is on a main road (no lights anywhere unless lit(di, dj));
//   skip(a, b): leave the edge out;
//   back(a, b): the cost multiplier going b → a (a bike one-way pushed: 4), or null for
//     no edge that way (a roundabout closed the wrong way round). Edges run a → b north
//     or east.
function grid(n, { elev, path, main, lit, skip, back } = {}) {
  const g = new R.PackedGraph(), id = [];
  const h = Math.floor(n / 2);
  for (let i = 0; i < n; i++) {
    id.push([]);
    for (let j = 0; j < n; j++) id[i].push(g.node(R.quantise6(LAT0 + (i - h) * dLat), R.quantise6(LON0 + (j - h) * dLon)));
  }
  const link = (i, j, i2, j2) => {
    const u = id[i][j], v = id[i2][j2], a = [i - h, j - h], b = [i2 - h, j2 - h];
    if (skip && skip(a, b)) return;
    const d = R.haversine(g.latQ[u] / 1e6, g.lonQ[u] / 1e6, g.latQ[v] / 1e6, g.lonQ[v] / 1e6);
    const rise = elev ? elev(...b) - elev(...a) : 0;
    const m = main ? main(a, b) : false, p = path ? path(a, b) : false;
    g.addEdge(u, v, d, rise > 0 ? rise : 0, m, p);
    const bm = back ? back(a, b) : 1;
    if (bm !== null) g.addEdge(v, u, d * bm, rise < 0 ? -rise : 0, m, p);
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i + 1 < n) link(i, j, i + 1, j);
    if (j + 1 < n) link(i, j, i, j + 1);
    if (lit && lit(i - h, j - h)) g.setAttrs(g.keyOf(id[i][j]), { trafficSignal: true });
  }
  const at = (key) => {
    const [la, lo] = key.split(",").map(Number);
    return [Math.round((la - LAT0) / dLat), Math.round((lo - LON0) / dLon)];
  };
  return { g, centre: g.keyOf(id[h][h]), at };
}
const turnaround = (o) => o.waypoints[o.waypoints.length - 1];

test("the turnaround sits at N/2: every option is in the accept window, and its pins re-route to the length measured", async () => {
  const { g, centre } = grid(81);
  for (const target of [3000, 5000, 8000]) {
    const out = await R.generateOutAndBacks(g, centre, target, { theta0: 10, pause: noPause });
    assert.equal(out.length, 3, `${target} m: ${out.length} options`);
    for (const o of out) {
      assert.ok(o.ok, `${target} m: ${Math.round(o.length)} m`);
      assert.ok(o.deviation >= -R.LOOP_UNDER && o.deviation <= R.LOOP_OVER);
      // Out-and-back mode routes pin to pin and runs it back: twice the legs it measured.
      let half = 0;
      for (let i = 1; i < o.waypoints.length; i++) half += R.pathGeomLength(R.dijkstra(g, o.waypoints[i - 1], o.waypoints[i]).path);
      assert.equal(2 * half, o.length);
      assert.equal(o.waypoints[0], centre);
    }
    for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
      assert.ok(R.headingGap(out[a].heading, out[b].heading) >= 90, `${target} m: headings ${out.map((o) => Math.round(o.heading))}`);
    }
  }
});

test("climb ranks first: the flat direction beats the hilly one, even when the hilly one is all path", async () => {
  // North of the start is hilly (waves of 6 m every 200 m); the rest is flat. The
  // eastern half is all path, which would win if climb didn't come first.
  const elev = (di) => (di > 2 ? 6 * (Math.abs(di) % 2) : 0);
  const path = (a, b) => a[1] > 0 && b[1] > 0;
  const { g, centre, at } = grid(81, { elev, path });
  const out = await R.generateOutAndBacks(g, centre, 5000, { theta0: 0, k: 6, pause: noPause });
  assert.ok(out.length >= 3);
  for (let i = 1; i < out.length; i++) assert.ok(R.compareOutAndBacks(out[i - 1], out[i]) <= 0, "sorted best first");
  // Flattest first, never rising by a step.
  const steps = out.map((o) => Math.floor(o.climbPerKm / R.OAB_CLIMB_STEP + 1e-9));
  assert.deepEqual(steps, steps.slice().sort((x, y) => x - y));
  assert.equal(steps[0], 0);
  const last = out[out.length - 1];
  assert.ok(last.climbPerKm > out[0].climbPerKm + R.OAB_CLIMB_STEP, `climbs ${out.map((o) => o.climbPerKm.toFixed(1))}`);
  assert.ok(at(turnaround(last))[0] > 2, "the hilliest one heads north");
});

test("with no heights, path share decides: the option on paths comes first", async () => {
  // Flat everywhere (no heights at all). Paths only east of the start.
  const path = (a, b) => a[1] > 0 && b[1] > 0;
  const { g, centre, at } = grid(81, { path });
  const out = await R.generateOutAndBacks(g, centre, 5000, { theta0: 0, pause: noPause });
  assert.equal(out.length, 3);
  for (const o of out) assert.equal(o.climbPerKm, 0);
  assert.ok(out[0].pathShare > 0.5, `path shares ${out.map((o) => o.pathShare.toFixed(2))}`);
  assert.ok(at(turnaround(out[0]))[1] > 0, "the first option heads east");
  for (let i = 1; i < out.length; i++) assert.ok(out[i].pathShare <= out[0].pathShare);
});

test("an option crossing a main road with no lights is never offered while a clean one is", async () => {
  // A main road east–west 600 m north of the start, unlit: anything heading north crosses it.
  const main = (a, b) => a[0] === 6 && b[0] === 6;
  const { g, centre, at } = grid(81, { main });
  const out = await R.generateOutAndBacks(g, centre, 5000, { theta0: 0, pause: noPause });
  assert.ok(out.length >= 2);
  for (const o of out) {
    assert.deepEqual(o.crossings, []);
    assert.ok(at(turnaround(o))[0] < 6, "no turnaround past the road");
  }
  // With lights at every node of it, north is fair game again.
  const lit = grid(81, { main, lit: (di) => di === 6 });
  const all = await R.generateOutAndBacks(lit.g, lit.centre, 5000, { theta0: 0, k: 6, pause: noPause });
  assert.ok(all.some((o) => lit.at(turnaround(o))[0] > 6), "a lit road doesn't block");
});

test("when every option crosses, the best one alone comes back with its crossings", async () => {
  // A ring of unlit main road 500 m out on every side: no way out without crossing.
  // Its corners join nothing outside it: a path running up one side of the ring and
  // straight on past a corner reads as "straight on, no side to judge" (a known limit of
  // the detector, routing.js loopUnprotectedCrossings), which square corners invite.
  const ring = (p) => Math.max(Math.abs(p[0]), Math.abs(p[1])) === 5;
  const corner = (p) => Math.abs(p[0]) === 5 && Math.abs(p[1]) === 5;
  const main = (a, b) => ring(a) && ring(b);
  const skip = (a, b) => (corner(a) || corner(b)) && !(ring(a) && ring(b));
  const { g, centre } = grid(81, { main, skip });
  const out = await R.generateOutAndBacks(g, centre, 5000, { theta0: 0, pause: noPause });
  assert.equal(out.length, 1);
  assert.ok(out[0].crossings.length > 0);
});

test("a crossing on the way out counts on the way back too", () => {
  const main = (a, b) => a[0] === 2 && b[0] === 2;
  const { g, centre } = grid(11, { main });
  const north = R.dijkstra(g, centre, R.nodeKey(LAT0 + 4 * dLat, LON0)).path;
  assert.equal(R.loopUnprotectedCrossings(g, R.outAndBackPaths([north])).length, 1);
});

test("no ground to reach N/2: the furthest it can go, as a near miss", async () => {
  const { g, centre } = grid(11); // 1 km square: an out-and-back of at most ~2 km
  const out = await R.generateOutAndBacks(g, centre, 6000, { theta0: 0, pause: noPause });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, false);
  assert.ok(out[0].length > 1500 && out[0].length < 6000 * 0.97);
});

test("a pin on a scrap of path gives nothing, not a 40 m near miss", async () => {
  const { g, centre } = grid(2); // four nodes, 100 m apart
  assert.equal((await R.generateOutAndBacks(g, centre, 5000, { theta0: 0, pause: noPause })).length, 0);
});

test("a peninsula never gets two options down the same path", async () => {
  // Only the north-east quarter exists, with a flat path along its diagonal and hills
  // either side (arch review: it used to offer turnarounds 6° and 200 m apart).
  const inQ = (p) => p[0] >= 0 && p[1] >= 0, diag = (p) => Math.abs(p[0] - p[1]) <= 1;
  const { g, centre } = grid(81, {
    skip: (a, b) => !inQ(a) || !inQ(b), path: (a, b) => diag(a) && diag(b),
    elev: (di, dj) => (Math.abs(di - dj) <= 1 ? 0 : 5 * ((di + dj) % 2)),
  });
  for (const theta0 of [-15, 0, 15, 30]) {
    const out = await R.generateOutAndBacks(g, centre, 5000, { theta0, pause: noPause });
    assert.ok(out.length >= 1);
    for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
      assert.ok(R.sharedShare(out[a], out[b]) <= 0.6, `theta0 ${theta0}: ${R.sharedShare(out[a], out[b]).toFixed(2)}`);
      const d = R.haversine(...turnaround(out[a]).split(",").map(Number), ...turnaround(out[b]).split(",").map(Number));
      assert.ok(d >= 0.15 * 2500, `theta0 ${theta0}: turnarounds ${Math.round(d)} m apart`);
    }
  }
});

test("bike: an option that can't be ridden back the way it was drawn is never offered", async () => {
  // East of the start, every east–west street is one-way eastward, closed westward (as a
  // roundabout is for bikes): out is fine, back is not.
  const east = (a, b) => a[0] === b[0] && a[1] >= 1;
  const { g, centre, at } = grid(81, { back: (a, b) => (east(a, b) ? null : 1) });
  const out = await R.generateOutAndBacks(g, centre, 5000, { theta0: 0, k: 6, pause: noPause });
  assert.ok(out.length >= 2);
  for (const o of out) {
    assert.equal(o.closedBack, false);
    // Every step back exists: the reverse of the leg routes along real edges.
    for (const p of o.paths) for (let j = 1; j < p.length; j++) {
      assert.ok(g.edgeBetween(g.indexOf(p[j]), g.indexOf(p[j - 1])) >= 0, `no way back at ${at(p[j])}`);
    }
  }
});

test("bike: a return pushed against one-ways ranks behind one that isn't", async () => {
  // Flat, no paths, so only cost per metre is left to decide. East of the start the
  // east–west streets are one-way eastward with a 4× push back (onewayEdgeCosts).
  const east = (a, b) => a[0] === b[0] && a[1] >= 1;
  const { g, centre } = grid(81, { back: (a, b) => (east(a, b) ? 4 : 1) });
  // Due east and back, hand-placed: the way back is pushed, and it costs for it.
  const pushed = R.dijkstra(g, centre, R.nodeKey(LAT0, LON0 + 25 * dLon));
  let back = 0;
  for (let j = 1; j < pushed.path.length; j++) {
    const e = g.edgeBetween(g.indexOf(pushed.path[j]), g.indexOf(pushed.path[j - 1]));
    back += g.eCost[e];
  }
  assert.ok(back > 3 * R.pathGeomLength(pushed.path));
  // The generator steers every direction's turnaround off pushed returns.
  const out = await R.generateOutAndBacks(g, centre, 5000, { theta0: 0, k: 6, pause: noPause });
  assert.ok(out.length >= 3);
  for (const o of out) assert.ok(o.costPerM < 1.1, `cost per metre ${out.map((x) => x.costPerM.toFixed(2))}`);
  // And between two measured options, the pushed one loses on cost per metre.
  const flat = { ok: true, climbPerKm: 0, pathShare: 0, costPerM: 1, error: 0, crossings: [] };
  assert.ok(R.compareOutAndBacks(flat, { ...flat, costPerM: 2.5 }) < 0);
});

test("stale: a pin moved mid-search drops the result", async () => {
  const { g, centre } = grid(41);
  let calls = 0;
  const out = await R.generateOutAndBacks(g, centre, 3000, { pause: noPause, isStale: () => ++calls > 2 });
  assert.equal(out, null);
});

test("the lengthTree's ground length matches the routed length on a grid", () => {
  const { g, centre } = grid(21);
  const tree = g.lengthTree(centre, 5000);
  const far = R.nodeKey(LAT0 + 5 * dLat, LON0 + 3 * dLon);
  const n = g.indexOf(far);
  assert.ok(Math.abs(tree.len[n] - R.pathGeomLength(R.dijkstra(g, centre, far).path)) < 1);
});

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

test("scaler lands in the aim window (0 to +5% over) in at most 4 routed attempts on a regular grid", async () => {
  const { g, centre } = grid(81); // 8 km square
  for (const target of [3000, 5000, 8000, 10000]) {
    for (let bearing = 0; bearing < 360; bearing += 7) {
      const loop = await R.scaleLoop(g, centre, target, bearing);
      assert.ok(loop, `${target} m @ ${bearing}°: no loop`);
      assert.ok(loop.tries.length <= 4);
      // The returned loop can trade a little length for less doubling back (betterLoop),
      // so convergence is judged on the attempts, and the pick must still be acceptable.
      const dev = (t) => (t.length - target) / target;
      // On 100 m blocks a loop's length moves in ~200 m steps: 6.7% of 3 km and 4% of 5 km,
      // against a 5%-wide aim window, so only one routable length (a sliver of r) is on aim.
      // Below 8 km the accept window (−3% to +10%) must be reached; from 8 km a step is
      // under half the aim window and the aim itself must be.
      const [lo, hi] = target < 8000 ? [-R.LOOP_UNDER, R.LOOP_OVER] : [R.LOOP_AIM_LO, R.LOOP_AIM_HI];
      const hit = loop.tries.some((t) => t.length !== null && dev(t) >= lo && dev(t) <= hi);
      assert.ok(hit, `${target} m @ ${bearing}°: ${loop.tries.map((t) => Math.round(t.length)).join(", ")}`);
      assert.ok(loop.ok);
    }
  }
});

test("a generated loop's waypoints re-route to exactly the length that was measured", async () => {
  // This is the promise that lets PR 2 hand [S, A, B] to the normal pipeline: loop mode
  // routes S→A, A→B and B→S with the same dijkstra(), so the drawn loop is the measured one.
  const { g, centre } = grid(81);
  const loop = await R.loopCandidate(g, centre, 5000, 75, 1);
  const pins = loop.waypoints.concat([loop.waypoints[0]]); // loop mode closes back to the first pin
  let total = 0;
  for (let i = 1; i < pins.length; i++) total += R.pathGeomLength(R.dijkstra(g, pins[i - 1], pins[i]).path);
  assert.equal(total, loop.length);
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

test("generateLoops — three loops on well-separated headings, sorted closest to the aim, all acceptable", async () => {
  const { g, centre } = grid(81);
  const loops = await R.generateLoops(g, centre, 5000, { theta0: 10, pause: noPause });
  assert.equal(loops.length, 3);
  for (let i = 1; i < loops.length; i++) assert.ok(loops[i - 1].error <= loops[i].error);
  for (const l of loops) {
    assert.ok(l.ok && l.deviation >= -R.LOOP_UNDER && l.deviation <= R.LOOP_OVER);
    assert.ok(l.overlap <= R.LOOP_OVERLAP_MAX, `overlap ${l.overlap}`);
    assert.equal(l.waypoints[0], centre, "starts (and so finishes) at the start pin");
  }
  for (let i = 0; i < loops.length; i++) for (let j = i + 1; j < loops.length; j++) {
    const gap = R.headingGap(loops[i].heading, loops[j].heading);
    assert.ok(gap >= 90, `headings ${loops[i].heading} and ${loops[j].heading} only ${gap}° apart`);
  }
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
  const dev = (best.length - 5000) / 5000;
  assert.equal(best.ok, dev >= -R.LOOP_UNDER && dev <= R.LOOP_OVER, "ok matches the true length");
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

test("polygon corners sit on a circle through the start, evenly spaced", () => {
  // Default polygon: LOOP_CORNERS corners + S make a regular polygon on a circle of radius r
  // whose centre is r out along the bearing.
  const r = 1000, bearing = 40, pts = R.loopCornerPoints(LAT0, LON0, bearing, r);
  assert.ok(pts.length >= 3);
  const [cLat, cLon] = R.offsetPoint(LAT0, LON0, bearing, r);
  const ring = [[LAT0, LON0], ...pts, [LAT0, LON0]];
  const side = R.haversine(ring[0][0], ring[0][1], ring[1][0], ring[1][1]);
  for (let i = 1; i < ring.length; i++) {
    assert.ok(Math.abs(R.haversine(cLat, cLon, ring[i][0], ring[i][1]) - r) < 10, "on the circle");
    assert.ok(Math.abs(R.haversine(ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]) - side) < 15, "equal sides");
  }
});

test("pickLoops — keeps the best loops that are 90° apart, then fills from the rest", () => {
  const L = (heading, error, overlap = 0) => ({ heading, bearing: heading, error, overlap, ok: error <= 0.10 });
  const pool = [L(0, 0.01), L(60, 0.02), L(120, 0.03), L(180, 0.20), L(240, 0.04), L(300, 0.05)];
  // 60 and 300 are too close to 0; 120 and 240 are 120° from 0 and each other.
  assert.deepEqual(R.pickLoops(pool, 3).map((l) => l.heading), [0, 120, 240]);
  // A clean loop outranks a closer one that doubles back.
  const dirty = [L(0, 0.01, 0.5), L(120, 0.04), L(240, 0.06)];
  assert.equal(R.pickLoops(dirty, 3)[0].heading, 120);
  // Separation is on the nominal heading: 120 and 240 jittered 20° toward each other still count.
  const jit = [L(0, 0.01), { heading: 120, bearing: 140, error: 0.02, overlap: 0 }, { heading: 240, bearing: 220, error: 0.03, overlap: 0 }];
  assert.deepEqual(R.pickLoops(jit, 3).map((l) => l.heading), [0, 120, 240]);
  // Too few far apart: the best of the rest fill in rather than returning fewer.
  assert.equal(R.pickLoops([L(0, 0.01), L(30, 0.02), L(60, 0.03)], 3).length, 3);
  assert.equal(R.headingGap(350, 10), 20);
});

test("aim slightly over — 5.2 km beats 4.8 km for a 5 km ask, and 4.8 km is a near miss", () => {
  // Decision 6: stop the watch at 5 and walk the rest, rather than invent 200 m.
  const over = R.loopFit({ length: 5200, overlap: 0 }, 5000), under = R.loopFit({ length: 4800, overlap: 0 }, 5000);
  assert.ok(over.ok && over.onAim, "+4% is on aim");
  assert.ok(!under.ok, "−4% is outside the −3% accept edge");
  assert.ok(R.loopFit({ length: 4870, overlap: 0 }, 5000).ok, "−2.6% is still acceptable");
  assert.ok(!R.loopFit({ length: 5510, overlap: 0 }, 5000).ok, "+10.2% is a near miss");
  // Ranking measures from the middle of the aim window (+2.5%), so +2% beats −1%.
  const a = R.loopFit({ length: 5100, overlap: 0 }, 5000), b = R.loopFit({ length: 4950, overlap: 0 }, 5000);
  assert.ok(a.error < b.error);
});

test("generateLoops — easy ground stops after the first spread of three headings", async () => {
  const { g, centre } = grid(81);
  const loops = await R.generateLoops(g, centre, 5000, { theta0: 10, pause: noPause });
  assert.equal(loops.headingsTried, 3, "three clean loops 120° apart, so the other three headings are skipped");
  assert.deepEqual(loops.map((l) => l.heading).sort((x, y) => x - y), [10, 130, 250]);
});

test("generateLoops — pauses between routed attempts, not only between headings", async () => {
  const { g, centre } = grid(81);
  let pauses = 0;
  const loops = await R.generateLoops(g, centre, 8000, { theta0: 10, pause: () => { pauses++; return Promise.resolve(); } });
  const attempts = loops.reduce((n, l) => n + l.tries.length, 0);
  assert.ok(pauses >= attempts, `${pauses} pauses for at least ${attempts} routed attempts`);
});

test("generateLoops — never offers the same loop twice, even reversed", async () => {
  // A lone 4 km ring road with only two junctions (each has a short spur). Every heading's
  // corners snap to those two, in one order or the other: one loop, not three copies.
  const g = new R.PackedGraph(), n = 40, rad = 640, ring = [];
  const at = (b, m) => { const [la, lo] = R.offsetPoint(LAT0, LON0, b, m); return g.node(R.quantise6(la), R.quantise6(lo)); };
  const link = (u, v) => {
    const d = R.haversine(g.latQ[u] / 1e6, g.lonQ[u] / 1e6, g.latQ[v] / 1e6, g.lonQ[v] / 1e6);
    g.addEdge(u, v, d, 0); g.addEdge(v, u, d, 0);
  };
  for (let i = 0; i < n; i++) ring.push(at(i * 360 / n, rad));
  for (let i = 0; i < n; i++) link(ring[i], ring[(i + 1) % n]);
  link(ring[13], at(13 * 360 / n, rad + 100));
  link(ring[27], at(27 * 360 / n, rad + 100));
  const loops = await R.generateLoops(g, g.keyOf(ring[0]), 4000, { theta0: 0, pause: noPause });
  const routes = loops.map((l) => l.waypoints.slice().sort().join(";"));
  assert.ok(loops.length >= 1);
  assert.equal(new Set(routes).size, routes.length, `the same corners offered twice: ${routes.join(" / ")}`);
});

test("loopTurns — counts real turns, not footpath wiggles, and not the finish", () => {
  const k = (i, j) => R.nodeKey(LAT0 + i * dLat, LON0 + j * dLon);   // 100 m grid
  const straight = [[k(0, 0), k(1, 0), k(2, 0), k(3, 0)]];
  assert.equal(R.loopTurns(straight), 0, "a straight line");
  // A 200 m square walked as four legs: turns at the three corners after the start;
  // arriving back at the start is the finish, not a turn.
  const square = [[k(0, 0), k(0, 1), k(0, 2)], [k(0, 2), k(1, 2), k(2, 2)], [k(2, 2), k(2, 1), k(2, 0)], [k(2, 0), k(1, 0), k(0, 0)]];
  assert.equal(R.loopTurns(square), 3);
  // A 5 m sideways jog in the middle of a straight 300 m run is under 15 m: no turn.
  const jog = R.nodeKey(LAT0 + 1.5 * dLat, LON0 + 0.05 * dLon);
  assert.equal(R.loopTurns([[k(0, 0), k(1, 0), jog, k(2, 0), k(3, 0)]]), 0);
  // A staircase (100 m north, 100 m east, repeated) turns at every step.
  assert.equal(R.loopTurns([[k(0, 0), k(1, 0), k(1, 1), k(2, 1), k(2, 2)]]), 3);
});

test("ranking — among acceptable, clean, on-aim loops, fewer turns per km wins", () => {
  const L = (deviation, turnsPerKm, overlap = 0) => {
    const l = R.loopFit({ length: 5000 * (1 + deviation), overlap }, 5000);
    l.turnsPerKm = turnsPerKm;
    return l;
  };
  const easy = L(0.04, 3), fiddly = L(0.02, 8);
  assert.ok(R.compareLoops(easy, fiddly) < 0, "both on aim: 3 turns/km beats 8, though 8's is closer to the aim");
  assert.ok(R.compareLoops(L(0.02, 3.3), L(0.04, 3)) < 0, "within the 0.5 turns/km margin, closer to the aim wins");
  assert.ok(R.compareLoops(L(0.03, 9), L(-0.02, 2)) < 0, "on aim beats off aim (still acceptable) before turns count");
  assert.ok(R.compareLoops(L(0.03, 9), L(0.03, 2, 0.4)) < 0, "a clean loop beats one that doubles back, whatever its turns");
});

test("reachBothWays — marks only nodes you can get to and back from", () => {
  const g = new R.PackedGraph();
  const n = (i, j) => g.node(R.quantise6(LAT0 + i * dLat), R.quantise6(LON0 + j * dLon));
  const two = (u, v) => { g.addEdge(u, v, STEP, 0); g.addEdge(v, u, STEP, 0); };
  const s = n(0, 0), a = n(0, 1), b = n(0, 2), island = n(5, 5), islandB = n(5, 6), oneWayEnd = n(1, 0);
  two(s, a); two(a, b); two(island, islandB);
  g.addEdge(s, oneWayEnd, STEP, 0); // can get there, can't get back
  const m = g.reachBothWays(g.keyOf(s));
  assert.deepEqual([m[s], m[a], m[b]], [1, 1, 1]);
  assert.equal(m[island], 0, "a disconnected island");
  assert.equal(m[oneWayEnd], 0, "a one-way dead end");
  assert.equal(g.reachBothWays("1.000000,2.000000"), null);
});

test("costFrom — route cost outward, Infinity past the bound", () => {
  const g = new R.PackedGraph();
  const row = [];
  for (let j = 0; j < 6; j++) row.push(g.node(R.quantise6(LAT0), R.quantise6(LON0 + j * dLon)));
  for (let j = 1; j < 6; j++) { g.addEdge(row[j - 1], row[j], STEP, 0); g.addEdge(row[j], row[j - 1], STEP, 0); }
  const c = g.costFrom(g.keyOf(row[0]), 350);
  assert.deepEqual([c[row[0]], c[row[1]], c[row[3]]], [0, 100, 300]);
  assert.equal(c[row[4]], Infinity, "400 is past the 350 bound");
});

test("generateLoops — a corner never lands on an island, so no leg's search fails", async () => {
  // A 2.4 km street grid with a separate street grid (an island: plenty of junctions, no
  // connection) just east of it, where the east corners' ideal points fall. Without the
  // reach pass those corners snap onto the island and their legs can never be routed.
  const { g, centre } = grid(25);
  const id = (i, j) => g.node(R.quantise6(LAT0 + i * dLat), R.quantise6(LON0 + j * dLon));
  const two = (u, v) => { g.addEdge(u, v, STEP, 0); g.addEdge(v, u, STEP, 0); };
  for (let i = -20; i <= 20; i++) for (let j = 14; j <= 40; j++) {
    if (i < 20) two(id(i, j), id(i + 1, j));
    if (j < 40) two(id(i, j), id(i, j + 1));
  }
  // dijkstra() hands a PackedGraph search to graph.route(); count the ones that fail.
  let searches = 0, failed = 0;
  const route = g.route.bind(g);
  g.route = (a, b) => { searches++; const r = route(a, b); if (!r) failed++; return r; };
  const loops = await R.generateLoops(g, centre, 8000, { theta0: 90, pause: noPause });
  assert.ok(loops.length >= 1, "still finds loops on the start's own network");
  assert.equal(failed, 0, `${failed} of ${searches} searches failed`);
});

test("legNeedsGapFill — the app's re-fetch rule, shared: over 3× the straight line and over 200 m", () => {
  const k = (i, j) => R.nodeKey(LAT0 + i * dLat, LON0 + j * dLon);
  const uShape = [k(0, 0), k(5, 0), k(5, 1), k(0, 1)];   // 1.1 km round a 100 m gap
  assert.equal(R.legNeedsGapFill(uShape, 100), false, "a 100 m gap is a dog-leg, never re-fetched");
  assert.equal(R.legNeedsGapFill(uShape, 300), true, "1.1 km for a 300 m gap is");
  assert.equal(R.legNeedsGapFill(uShape, 400), false, "under 3× isn't");
});

test("generateLoops — never offers a leg the app would re-fetch (two sides of an inlet)", async () => {
  // A 6 km street grid with a long, narrow inlet running east from just past the start:
  // no streets in rows −1..1 from column 2 to the east edge. Heading east, the two far
  // corners land ~1.2 km out, either side of it; each is close to the start by road, but
  // the leg between them runs back round the inlet's head: over 3× the straight line,
  // which the app's resolveSegment would gap-fill and redraw.
  const g = new R.PackedGraph(), h = 30, id = {};
  const inInlet = (i, j) => Math.abs(i) <= 1 && j >= 2;
  for (let i = -h; i <= h; i++) for (let j = -h; j <= h; j++) {
    if (!inInlet(i, j)) id[i + "," + j] = g.node(R.quantise6(LAT0 + i * dLat), R.quantise6(LON0 + j * dLon));
  }
  const two = (a, b) => { const u = id[a], v = id[b]; if (u === undefined || v === undefined) return; g.addEdge(u, v, STEP, 0); g.addEdge(v, u, STEP, 0); };
  for (let i = -h; i <= h; i++) for (let j = -h; j <= h; j++) { two(i + "," + j, (i + 1) + "," + j); two(i + "," + j, i + "," + (j + 1)); }
  const start = g.keyOf(id["0,0"]);
  let tripped = 0;
  for (const theta0 of [80, 90, 100]) {
    const loops = await R.generateLoops(g, start, 5000, { theta0, pause: noPause });
    assert.ok(loops.length >= 1);
    for (const l of loops) {
      const pins = l.waypoints.concat([l.waypoints[0]]);
      for (let i = 1; i < pins.length; i++) {
        const [a, b] = [pins[i - 1], pins[i]].map((x) => x.split(",").map(Number));
        if (R.legNeedsGapFill(l.paths[i - 1], R.haversine(a[0], a[1], b[0], b[1]))) tripped++;
      }
    }
  }
  assert.equal(tripped, 0, `${tripped} legs the app would re-fetch`);
});

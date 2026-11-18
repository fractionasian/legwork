// Generated loops never cross a main road without lights or a marked crossing
// (Peter, 2026-11-19; docs/design/target-distance-loops.md). Synthetic graphs; the
// real case (Stirling Highway, Nedlands) is in the harness notes in the spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../routing.js");

const LAT0 = -31.95, LON0 = 115.86;
const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));

// Nodes at (x, y) metres from the origin; edges both ways, cost = length.
function graph() {
  const g = new R.PackedGraph(), at = {};
  const n = (name, x, y) => (at[name] = g.node(R.quantise6(LAT0 + y * mLat), R.quantise6(LON0 + x * mLon)));
  const link = (a, b, main) => {
    const u = at[a], v = at[b];
    const d = R.haversine(g.latQ[u] / 1e6, g.lonQ[u] / 1e6, g.latQ[v] / 1e6, g.lonQ[v] / 1e6);
    g.addEdge(u, v, d, 0, main); g.addEdge(v, u, d, 0, main);
  };
  const key = (name) => g.keyOf(at[name]);
  return { g, n, link, key, at };
}

// A main road running east–west along y = 0 (W — X — E, with M 20 m east of X), and a
// footpath crossing it north–south at X (N — X — S). Also a side street off X on the
// north side (X — N2).
function crossroads() {
  const t = graph();
  t.n("W", -100, 0); t.n("X", 0, 0); t.n("M", 20, 0); t.n("E", 100, 0);
  t.n("N", 0, 100); t.n("S", 0, -100); t.n("N2", 70, 70);
  t.link("W", "X", 1); t.link("X", "M", 1); t.link("M", "E", 1);
  t.link("N", "X", 0); t.link("X", "S", 0); t.link("X", "N2", 0);
  return t;
}
const loopThrough = (t, names) => [names.map(t.key)];

test("a footpath straight across a main road with nothing marked is flagged", () => {
  const t = crossroads();
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, loopThrough(t, ["N", "X", "S"])), [t.key("X")]);
});

test("the same crossing at traffic lights or a marked crossing is fine", () => {
  for (const attrs of [{ trafficSignal: true }, { crossingMarked: true }]) {
    const t = crossroads();
    t.g.setAttrs(t.key("X"), attrs);
    assert.deepEqual(R.loopUnprotectedCrossings(t.g, loopThrough(t, ["N", "X", "S"])), []);
  }
});

test("lights on the junction node 20 m along the road count; 100 m away does not", () => {
  const near = crossroads();
  near.g.setAttrs(near.key("M"), { trafficSignal: true });
  assert.deepEqual(R.loopUnprotectedCrossings(near.g, loopThrough(near, ["N", "X", "S"])), []);
  const far = crossroads();
  far.g.setAttrs(far.key("E"), { trafficSignal: true });
  assert.deepEqual(R.loopUnprotectedCrossings(far.g, loopThrough(far, ["N", "X", "S"])), [far.key("X")]);
});

test("an unmarked crossing tag does not protect it", () => {
  const t = crossroads();
  t.g.setAttrs(t.key("X"), { crossingUnmarked: true });
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, loopThrough(t, ["N", "X", "S"])), [t.key("X")]);
});

test("travelling along the main road, or staying on one side of it, is not crossing", () => {
  const t = crossroads();
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, loopThrough(t, ["N", "X", "M", "E"])), [], "turns onto the road");
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, loopThrough(t, ["W", "X", "S"])), [], "turns off the road");
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, loopThrough(t, ["N", "X", "N2"])), [], "both on the north side");
});

test("legs are joined: a crossing at a corner, where one leg ends and the next starts, is seen", () => {
  const t = crossroads();
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, [["N", "X"].map(t.key), ["X", "S"].map(t.key)]), [t.key("X")]);
});

test("a road end (one main edge) is not a crossing", () => {
  const t = graph();
  t.n("X", 0, 0); t.n("E", 100, 0); t.n("N", 0, 100); t.n("S", 0, -100);
  t.link("X", "E", 1); t.link("N", "X", 0); t.link("X", "S", 0);
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, [["N", "X", "S"].map(t.key)]), []);
});

// generateLoops end to end: a 13 × 13 grid, 100 m blocks, with the middle row a main road
// that has lights at one node only. Loops are dropped, never re-routed: anything returned
// is clean, and with the check off the same ground does give loops that cross.
function gridWithMainRoad(lightsAt) {
  const t = graph(), n = 13, h = 6, name = (i, j) => i + ":" + j;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) t.n(name(i, j), (j - h) * 100, (i - h) * 100);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (j + 1 < n) t.link(name(i, j), name(i, j + 1), i === h ? 1 : 0);
    if (i + 1 < n) t.link(name(i, j), name(i + 1, j), 0);
  }
  if (lightsAt !== undefined) t.g.setAttrs(t.key(name(h, lightsAt)), { trafficSignal: true });
  return { t, start: t.key(name(h + 2, h)) };
}

test("generateLoops drops loops with an unprotected crossing and returns only clean ones", async () => {
  const pause = () => Promise.resolve();
  const { t, start } = gridWithMainRoad(6);
  for (const theta0 of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const on = await R.generateLoops(t.g, start, 2400, { theta0, pause });
    assert.ok(on.length >= 1, "a clean loop exists on the start's side of the road");
    for (const l of on) assert.deepEqual(l.crossings, [], "theta0 " + theta0);
  }
  const off = await offRun(t.g, start, pause);
  assert.ok(off.some((l) => l.crossings.length), "with the check off, some loops cross the road");
});

// A second copy of routing.js with LOOP_CROSSING_CHECK = 0, so the shared module stays shipped.
async function offRun(g, start, pause) {
  const fs = await import("node:fs"), vm = await import("node:vm"), path = await import("node:path");
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "routing.js"), "utf8");
  const ctx = vm.createContext({ setTimeout, Promise, console });
  vm.runInContext(src + "\nLOOP_CROSSING_CHECK = 0;", ctx);
  // Rebuild the graph in this scope (instanceof is per scope).
  const g2 = new ctx.PackedGraph();
  for (let n = 0; n < g.nNodes; n++) g2.node(g.latQ[n], g.lonQ[n]);
  for (let e = 0; e < g.nEdges; e++) g2.addEdge(g.eFrom[e], g.eTo[e], g.eCost[e], g.eUp[e], g.eMain[e]);
  for (let n = 0; n < g.nNodes; n++) { const a = g.attrsOf(n); if (a) g2.setAttrs(g.keyOf(n), a); }
  const out = [];
  for (const theta0 of [0, 45, 90, 135, 180, 225, 270, 315]) out.push(...await ctx.generateLoops(g2, start, 2400, { theta0, pause }));
  return out;
}

test("when every loop crosses unprotected, the best one alone comes back, crossings listed", async () => {
  // Start on a short spur north of the road with nothing else on its side: every loop crosses.
  // A street grid south of a main road; the road (W — X — E, dead ends both ways) is met
  // only at X, where the footpath from the spur P north of it runs straight over to the
  // grid. Every loop from P has to cross at X.
  const t = graph(), n = 9, h = 4, name = (i, j) => i + ":" + j;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) t.n(name(i, j), (j - h) * 100, -100 - i * 100);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (j + 1 < n) t.link(name(i, j), name(i, j + 1), 0);
    if (i + 1 < n) t.link(name(i, j), name(i + 1, j), 0);
  }
  t.n("W", -150, 0); t.n("X", 0, 0); t.n("E", 150, 0); t.n("P", 0, 150);
  t.link("W", "X", 1); t.link("X", "E", 1); t.link("P", "X", 0); t.link("X", name(0, h), 0);
  const pause = () => Promise.resolve();
  const out = await R.generateLoops(t.g, t.key("P"), 2400, { theta0: 0, pause });
  assert.equal(out.length, 1);
  assert.ok(out[0].crossings.length > 0);
});

test("joining the road on one side, running along it and leaving on the other is a crossing", () => {
  // Road W — X — Y — E along y = 0; north path N to X, south path S from Y (Y is 100 m east).
  const t = graph();
  t.n("W", -100, 0); t.n("X", 0, 0); t.n("Y", 100, 0); t.n("E", 200, 0);
  t.n("N", 0, 100); t.n("S", 100, -100); t.n("N3", 100, 100);
  t.link("W", "X", 1); t.link("X", "Y", 1); t.link("Y", "E", 1);
  t.link("N", "X", 0); t.link("Y", "S", 0); t.link("Y", "N3", 0);
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, [["N", "X", "Y", "S"].map(t.key)]), [t.key("Y")], "marked where it leaves the road");
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, [["N", "X", "Y", "N3"].map(t.key)]), [], "back off the north side");
  t.g.setAttrs(t.key("Y"), { crossingMarked: true });
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, [["N", "X", "Y", "S"].map(t.key)]), [], "marked crossing on the run");
});

test("lights on a side street near the crossing don't protect it", () => {
  // N — Q — X — S, with Q 20 m north of X on the footpath and lights on Q (a side-street node).
  const t = crossroads();
  t.n("Q", 0, 20); t.link("N", "Q", 0); t.link("Q", "X", 0);
  t.g.setAttrs(t.key("Q"), { trafficSignal: true });
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, loopThrough(t, ["N", "Q", "X", "S"])), [t.key("X")]);
});

test("a U-turn on the main road, back off the side it came from, is not a crossing", () => {
  const t = graph();
  t.n("W", -100, 0); t.n("X", 0, 0); t.n("E", 100, 0); t.n("F", 200, 0);
  t.n("N", 0, 100); t.n("N3", -70, 70);
  t.link("W", "X", 1); t.link("X", "E", 1); t.link("E", "F", 1);
  t.link("N", "X", 0); t.link("N3", "X", 0);
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, [["N", "X", "E", "X", "N3"].map(t.key)]), []);
});

test("turning from one main road onto another at an unsignalled junction crosses the first", () => {
  // A: W — J — E east–west; B: J — B1 north. Joins A from the south at W, runs east to J,
  // turns north onto B (over A), leaves B to the east at B1.
  const t = graph();
  t.n("WW", -200, 0); t.n("W", -100, 0); t.n("J", 0, 0); t.n("E", 100, 0); t.n("B1", 0, 100); t.n("B2", 0, 200);
  t.n("SW", -100, -100); t.n("NE", 100, 100);
  t.link("WW", "W", 1); t.link("W", "J", 1); t.link("J", "E", 1); t.link("J", "B1", 1); t.link("B1", "B2", 1);
  t.link("SW", "W", 0); t.link("B1", "NE", 0);
  // Twice, in fact: over A at J (onto B's west side), then over B at B1 to leave east.
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, [["SW", "W", "J", "B1", "NE"].map(t.key)]), [t.key("J"), t.key("B1")]);
  t.g.setAttrs(t.key("J"), { trafficSignal: true });
  assert.deepEqual(R.loopUnprotectedCrossings(t.g, [["SW", "W", "J", "B1", "NE"].map(t.key)]), [], "lights at the junction");
});

test("a segment shared by a footway and a main road is marked main whichever loads first", () => {
  const t = graph();
  t.n("A", 0, 0); t.n("B", 100, 0);
  t.link("A", "B", 0);
  t.g.markMain(t.at.A, t.at.B);
  for (let e = 0; e < t.g.nEdges; e++) assert.equal(t.g.eMain[e], 1);
});

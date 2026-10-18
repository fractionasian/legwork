// Ported one-for-one from the old browser-opened test.html, which nothing ran
// automatically. Some cases overlap routing.test.mjs; they are kept so this file
// is a faithful move. Its unique cover: the run/bike preference multipliers and
// weight tables, waypointHash, tileCoords, bilinearSample, medianFilter,
// smoothElevations and pathToCoords.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../routing.js");

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const RUN = R.routingProfile("run");
const BIKE = R.routingProfile("bike");
const ROAD_WEIGHT = RUN.roadWeight;
const BIKE_ROAD_WEIGHT = BIKE.roadWeight;
const wayPrefMultiplier = RUN.wayPref;
const nodePrefMultiplier = RUN.nodePref;
const bikeWayPrefMultiplier = BIKE.wayPref;
const bikeNodePrefMultiplier = BIKE.nodePref;

// ── haversine ─────────────────────────────────────
test("haversine: same point is 0", () => {
  assert.ok(near(R.haversine(-31.95, 115.86, -31.95, 115.86), 0));
});
test("haversine: ~1 deg lat ≈ 111km", () => {
  const d = R.haversine(0, 0, 1, 0);
  assert.ok(d > 110000 && d < 112000, "got " + d);
});
test("haversine: Perth → Sydney ≈ 3290 km", () => {
  const d = R.haversine(-31.95, 115.86, -33.87, 151.21);
  assert.ok(d > 3_250_000 && d < 3_350_000, "got " + d);
});

// ── nodeKey / pathToCoords round-trip ─────────────
test("nodeKey + pathToCoords round-trip", () => {
  const k = R.nodeKey(-31.95001, 115.860123);
  const coords = R.pathToCoords([k]);
  assert.ok(near(coords[0][0], -31.95001, 1e-5));
  assert.ok(near(coords[0][1], 115.860123, 1e-5));
});
test("nodeKey truncates to 6 dp", () => {
  assert.equal(R.nodeKey(1.1234567, 2.7654321), "1.123457,2.765432");
});

// ── MinHeap ───────────────────────────────────────
test("MinHeap: pops in ascending order", () => {
  const h = new R.MinHeap();
  [5, 1, 9, 3, 7, 2, 8, 4, 6].forEach((d) => h.push({ d }));
  const out = [];
  while (h.size() > 0) out.push(h.pop().d);
  assert.deepEqual(out, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
test("MinHeap: single push/pop", () => {
  const h = new R.MinHeap();
  h.push({ d: 42 });
  assert.equal(h.pop().d, 42);
  assert.equal(h.size(), 0);
});

// ── Dijkstra ──────────────────────────────────────
// Graph: A —1— B —2— C, plus A —5— C
//   shortest A→C should go via B (cost 3), not direct (cost 5).
test("Dijkstra: picks shorter path via B", () => {
  const graph = {
    A: [{ key: "B", dist: 1 }, { key: "C", dist: 5 }],
    B: [{ key: "A", dist: 1 }, { key: "C", dist: 2 }],
    C: [{ key: "A", dist: 5 }, { key: "B", dist: 2 }],
  };
  const r = R.dijkstra(graph, "A", "C");
  assert.notEqual(r, null);
  assert.equal(r.dist, 3);
  assert.deepEqual(r.path, ["A", "B", "C"]);
});
test("Dijkstra: same start/end returns 0-dist singleton", () => {
  const r = R.dijkstra({ A: [] }, "A", "A");
  assert.ok(r.dist === 0 && r.path.length === 1 && r.path[0] === "A");
});
test("Dijkstra: unreachable returns null", () => {
  const graph = { A: [{ key: "B", dist: 1 }], B: [{ key: "A", dist: 1 }], C: [] };
  assert.equal(R.dijkstra(graph, "A", "C"), null);
});
test("Dijkstra: missing endpoint returns null", () => {
  assert.equal(R.dijkstra({ A: [] }, "A", "Z"), null);
  assert.equal(R.dijkstra({ A: [] }, "Z", "A"), null);
});

// ── spatial grid / closestNode ────────────────────
test("gridInsert + closestNode: exact hit", () => {
  R.resetSpatialGrid();
  R.gridInsert("-31.950000,115.860000", -31.95, 115.86);
  R.gridInsert("-31.951000,115.861000", -31.951, 115.861);
  const k = R.closestNode({ /* unused */ }, -31.9501, 115.8601);
  assert.equal(k, "-31.950000,115.860000");
});
test("closestNode: expands past inner ring if empty", () => {
  R.resetSpatialGrid();
  // Put a node ~1.1km away — fits in ring 2 (at ~500–1000m cell size).
  R.gridInsert("-31.960000,115.860000", -31.96, 115.86);
  const k = R.closestNode({}, -31.95, 115.86);
  assert.equal(k, "-31.960000,115.860000", "expected ring expansion to find far node, got " + k);
});

// ── GeoJSON conversions ───────────────────────────
test("osmToGeoJSON: builds LineString from nodes+ways", () => {
  const gj = R.osmToGeoJSON({
    elements: [
      { type: "node", id: 1, lat: -31.95, lon: 115.86 },
      { type: "node", id: 2, lat: -31.951, lon: 115.861 },
      { type: "way", id: 100, nodes: [1, 2], tags: { highway: "footway" } },
    ],
  });
  assert.equal(gj.features.length, 1);
  assert.equal(gj.features[0].properties.highway, "footway");
  assert.equal(gj.features[0].geometry.coordinates.length, 2);
  assert.ok(near(gj.features[0].geometry.coordinates[0][0], 115.86));
});
test("osmToGeoJSON: skips ways with <2 resolved nodes", () => {
  const gj = R.osmToGeoJSON({
    elements: [
      { type: "node", id: 1, lat: 0, lon: 0 },
      { type: "way", id: 100, nodes: [1, 999], tags: {} }, // 999 missing
    ],
  });
  assert.equal(gj.features.length, 0);
});
test("compactToGeoJSON: unpacks v1 (legacy Array) tile format", () => {
  const gj = R.compactToGeoJSON([[1, "footway", "Main St", [[115.86, -31.95], [115.87, -31.95]]]]);
  assert.equal(gj.features.length, 1);
  assert.equal(gj.features[0].properties.name, "Main St");
  assert.equal(gj.features[0].properties.surface, "");
  assert.equal(gj.features[0].geometry.coordinates.length, 2);
  assert.ok(!gj.nodeAttrs);
});
test("compactToGeoJSON: unpacks v2 tile format with surface + nodeAttrs", () => {
  const gj = R.compactToGeoJSON({
    v: 2,
    features: [[1, "path", "Bibbulmun", [[115.86, -31.95], [115.87, -31.95]], "gravel"]],
    nodeAttrs: { "-31.950000,115.860000": { barrier: true } },
  });
  assert.equal(gj.features.length, 1);
  assert.equal(gj.features[0].properties.surface, "gravel");
  assert.ok(gj.nodeAttrs && gj.nodeAttrs["-31.950000,115.860000"].barrier === true);
});

// ── sampleRoute ───────────────────────────────────
test("sampleRoute: always includes first and last point", () => {
  const coords = [[0, 0], [0, 0.001], [0, 0.002], [0, 0.003]];
  const s = R.sampleRoute(coords, 50);
  assert.equal(s[0], coords[0]);
  assert.equal(s[s.length - 1], coords[coords.length - 1]);
});
test("sampleRoute: reduces point count at coarse intervals", () => {
  // ~1km total route broken into 10 points, sample every 500m ⇒ 2–3 kept.
  const coords = [];
  for (let i = 0; i <= 10; i++) coords.push([0, i * 0.001]); // ~111m apart
  const s = R.sampleRoute(coords, 500);
  assert.ok(s.length < coords.length, "expected fewer samples, got " + s.length);
  assert.ok(s.length >= 2);
});

// ── smoothElevations ──────────────────────────────
test("smoothElevations: short input passes through", () => {
  const r = R.smoothElevations([{ lat: 0, lon: 0, elevation: 5 }]);
  assert.ok(r.length === 1 && r[0].elevation === 5);
});
test("smoothElevations: eliminates a single spike", () => {
  const data = [10, 10, 100, 10, 10].map((elevation) => ({ lat: 0, lon: 0, elevation }));
  const s = R.smoothElevations(data);
  // median prefilter wipes a lone outlier completely
  assert.ok(s[2].elevation < 20, "spike not reduced: " + s[2].elevation);
});

// ── ROAD_WEIGHT ───────────────────────────────────
test("ROAD_WEIGHT: footway is cheaper than trunk", () => {
  assert.ok(ROAD_WEIGHT.footway < ROAD_WEIGHT.trunk);
  assert.equal(ROAD_WEIGHT.path, 1.0);
  assert.equal(ROAD_WEIGHT.trunk, 2.5);
});
test("ROAD_WEIGHT: track/bridleway/byway are first-class trail surfaces", () => {
  assert.equal(ROAD_WEIGHT.track, 1.0);
  assert.equal(ROAD_WEIGHT.bridleway, 1.0);
  assert.equal(ROAD_WEIGHT.byway, 1.0);
});
test("wayPref: named bridleway gets named-trail nudge (PATHLIKE)", () => {
  assert.equal(wayPrefMultiplier("bridleway", "", "Bibbulmun Track"), 0.85);
});
test("wayPref: soft-surface byway gets soft-surface nudge (PATHLIKE)", () => {
  assert.equal(wayPrefMultiplier("byway", "gravel", ""), 0.95);
});

// ── Runner-friendly preferences (P1–P5) ───────────
test("wayPref P1: named footway is cheaper", () => {
  assert.equal(wayPrefMultiplier("footway", "", "Coastal Path"), 0.85);
});
test("wayPref P1: named residential is NOT cheaper", () => {
  assert.equal(wayPrefMultiplier("residential", "", "Baker St"), 1);
});
test("wayPref P5: soft surface on path", () => {
  assert.equal(wayPrefMultiplier("path", "gravel", ""), 0.95);
});
test("wayPref: named + soft stacks multiplicatively", () => {
  assert.ok(near(wayPrefMultiplier("path", "dirt", "Bibbulmun"), 0.85 * 0.95));
});
test("nodePref P4: barrier is strongly penalised", () => {
  assert.equal(nodePrefMultiplier({ barrier: true }), 1.25);
});
test("nodePref P2: bare traffic signal is penalised", () => {
  assert.equal(nodePrefMultiplier({ trafficSignal: true }), 1.15);
});
test("nodePref P3: marked crossing wins over traffic-signal penalty", () => {
  assert.equal(nodePrefMultiplier({ trafficSignal: true, crossingMarked: true }), 0.9);
});
test("nodePref: unmarked crossing neutral", () => {
  assert.equal(nodePrefMultiplier({ crossingUnmarked: true }), 1);
});
test("nodeAttrsFromTags: barrier=gate", () => {
  const a = R.nodeAttrsFromTags({ barrier: "gate" });
  assert.ok(a && a.barrier === true);
});
test("nodeAttrsFromTags: zebra crossing is marked", () => {
  const a = R.nodeAttrsFromTags({ highway: "crossing", crossing: "zebra" });
  assert.ok(a && a.crossingMarked === true);
});
test("nodeAttrsFromTags: plain node returns null", () => {
  assert.equal(R.nodeAttrsFromTags({ name: "Fred" }), null);
});
test("osmToGeoJSON: threads node attrs into sidecar", () => {
  const gj = R.osmToGeoJSON({
    elements: [
      { type: "node", id: 1, lat: -31.95, lon: 115.86, tags: { barrier: "gate" } },
      { type: "node", id: 2, lat: -31.951, lon: 115.861 },
      { type: "way", id: 100, nodes: [1, 2], tags: { highway: "footway" } },
    ],
  });
  assert.ok(gj.nodeAttrs);
  const key = "-31.950000,115.860000";
  assert.ok(gj.nodeAttrs[key] && gj.nodeAttrs[key].barrier === true);
});

// ── Cycling profile ───────────────────────────────
test("BIKE_ROAD_WEIGHT: cycleway is cheapest", () => {
  assert.ok(BIKE_ROAD_WEIGHT.cycleway < BIKE_ROAD_WEIGHT.residential);
  assert.ok(BIKE_ROAD_WEIGHT.cycleway < BIKE_ROAD_WEIGHT.footway);
});
test("BIKE_ROAD_WEIGHT: steps are heavily penalised but not infinite", () => {
  assert.ok(BIKE_ROAD_WEIGHT.steps >= 5 && BIKE_ROAD_WEIGHT.steps < 10);
});
test("BIKE_ROAD_WEIGHT: primary tolerated more than running profile", () => {
  assert.ok(BIKE_ROAD_WEIGHT.primary < ROAD_WEIGHT.primary);
});
test("bikeWayPref: soft surface on path is mildly penalised, not bonused", () => {
  assert.equal(bikeWayPrefMultiplier("path", "gravel", ""), 1.05);
});
test("bikeWayPref: paved path is neutral", () => {
  assert.equal(bikeWayPrefMultiplier("path", "asphalt", "Coastal Path"), 1);
});
test("bikeNodePref: barrier penalty is harsher than running", () => {
  assert.ok(bikeNodePrefMultiplier({ barrier: true }) > nodePrefMultiplier({ barrier: true }));
});
test("routingProfile: bike and run use different tables", () => {
  // test.html compared against the globals directly; headless, the tables are
  // only reachable through routingProfile, so assert the two profiles differ.
  assert.notEqual(BIKE.roadWeight, RUN.roadWeight);
  assert.notEqual(BIKE.wayPref, RUN.wayPref);
  assert.notEqual(BIKE.nodePref, RUN.nodePref);
});
test("routingProfile: defaults to running tables", () => {
  assert.equal(R.routingProfile("nonsense").roadWeight, ROAD_WEIGHT);
});

// ── waypointHash ──────────────────────────────────
test("waypointHash: deterministic for same waypoints", () => {
  const wps = [{ lat: -31.96, lon: 115.83 }, { lat: -31.97, lon: 115.84 }];
  assert.equal(R.waypointHash(wps), R.waypointHash(wps));
});
test("waypointHash: different for different waypoints", () => {
  const a = [{ lat: -31.96, lon: 115.83 }, { lat: -31.97, lon: 115.84 }];
  const b = [{ lat: -31.96, lon: 115.83 }, { lat: -31.97, lon: 115.85 }];
  assert.notEqual(R.waypointHash(a), R.waypointHash(b));
});
test("waypointHash: precision is 5 decimals", () => {
  const a = [{ lat: -31.961234, lon: 115.831234 }];
  const b = [{ lat: -31.961234999, lon: 115.831234999 }]; // differs at 6th+ decimals only
  assert.equal(R.waypointHash(a), R.waypointHash(b));
});
test("waypointHash: order matters", () => {
  const a = [{ lat: -31.96, lon: 115.83 }, { lat: -31.97, lon: 115.84 }];
  const b = [{ lat: -31.97, lon: 115.84 }, { lat: -31.96, lon: 115.83 }];
  assert.notEqual(R.waypointHash(a), R.waypointHash(b));
});

// ── tileCoords ──────────────────────────────────
test("tileCoords: equator at z=0 lands at tile (0,0) pixel (128,128)", () => {
  const r = R.tileCoords(0, 0, 0);
  assert.ok(r.xtile === 0 && r.ytile === 0);
  assert.ok(Math.abs(r.px - 128) < 0.001 && Math.abs(r.py - 128) < 0.001);
});
test("tileCoords: Perth (-31.99510, 115.81148) at z=14", () => {
  const r = R.tileCoords(-31.99510, 115.81148, 14);
  // Known good values computed offline
  assert.ok(r.xtile === 13462 && r.ytile === 9730);
  assert.ok(r.px >= 0 && r.px < 256);
  assert.ok(r.py >= 0 && r.py < 256);
});
test("tileCoords: increasing longitude moves east (larger xtile or px)", () => {
  const a = R.tileCoords(-31.99, 115.80, 14);
  const b = R.tileCoords(-31.99, 115.85, 14);
  assert.ok(b.xtile * 256 + b.px > a.xtile * 256 + a.px);
});

// ── decodeTerrarium ─────────────────────────────
test("decodeTerrarium: (128, 0, 0) decodes to 0 m", () => {
  // R=128 → 128*256 = 32768; minus offset 32768 → 0
  assert.ok(Math.abs(R.decodeTerrarium(128, 0, 0) - 0) < 0.001);
});
test("decodeTerrarium: (128, 100, 0) decodes to 100 m", () => {
  assert.ok(Math.abs(R.decodeTerrarium(128, 100, 0) - 100) < 0.001);
});
test("decodeTerrarium: (127, 0, 0) decodes to -256 m (below sea level)", () => {
  assert.ok(Math.abs(R.decodeTerrarium(127, 0, 0) - (-256)) < 0.001);
});
test("decodeTerrarium: fractional via blue channel", () => {
  // R=128, G=10, B=128 → 32768 + 10 + 0.5 - 32768 = 10.5
  assert.ok(Math.abs(R.decodeTerrarium(128, 10, 128) - 10.5) < 0.001);
});

// ── bilinearSample ─────────────────────────────
const GRID4 = [
  [10, 20, 30, 40],
  [50, 60, 70, 80],
  [90, 100, 110, 120],
  [130, 140, 150, 160],
];
const px4 = (x, y) => GRID4[y][x];
test("bilinearSample: integer-pixel sample equals raw value", () => {
  // px=1, py=1 → pixel (1,1) = 60 exactly
  assert.ok(Math.abs(R.bilinearSample(px4, 1, 1) - 60) < 0.001);
});
test("bilinearSample: midpoint between two pixels averages them", () => {
  // px=1.5, py=1 → average of (1,1)=60 and (2,1)=70 → 65
  assert.ok(Math.abs(R.bilinearSample(px4, 1.5, 1) - 65) < 0.001);
});
test("bilinearSample: center of four corners is their mean", () => {
  const grid = [[0, 10], [20, 30]];
  // px=0.5, py=0.5 → mean of 0,10,20,30 = 15
  assert.ok(Math.abs(R.bilinearSample((x, y) => grid[y][x], 0.5, 0.5) - 15) < 0.001);
});

// ── medianFilter ───────────────────────────────
test("medianFilter window=3: kills single-point spike", () => {
  const out = R.medianFilter([5, 5, 5, 50, 5, 5, 5], 3);
  // Window 3 centered on the spike includes neighbours → median = 5
  assert.equal(out[3], 5);
});
test("medianFilter window=9: kills cluster of 3 zeros amid 30s", () => {
  const out = R.medianFilter([30, 30, 30, 30, 0, 0, 0, 30, 30, 30, 30], 9);
  assert.equal(out[5], 30);
});
test("medianFilter preserves length", () => {
  assert.equal(R.medianFilter([1, 2, 3, 4, 5], 3).length, 5);
});
test("smoothElevations: median+EMA reduces 0-bleed artefacts", () => {
  // Simulate Open-Meteo's failure mode: 5m terrain with random 0 dropouts
  const input = [];
  for (let i = 0; i < 50; i++) input.push({ lat: 0, lon: 0, elevation: i % 4 === 0 ? 0 : 5 });
  const out = R.smoothElevations(input);
  // No element should be near 0 — median+EMA washes the artefacts
  for (let i = 5; i < 45; i++) {
    assert.ok(out[i].elevation > 2, "elevation at " + i + " is " + out[i].elevation);
  }
});

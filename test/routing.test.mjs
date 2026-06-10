// Headless tests for the pure functions in routing.js.
// Run: `npm test` (or `node --test`). Complements the browser-opened test.html
// (which covers DOM/Leaflet-coupled behaviour). This file guards the routing,
// graph, and elevation maths that are easy to regress and hard to eyeball.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../routing.js");

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test("haversine — zero distance", () => {
  assert.ok(near(R.haversine(-31.95, 115.86, -31.95, 115.86), 0));
});

test("haversine — ~1 degree of latitude ≈ 111 km", () => {
  const d = R.haversine(-31.0, 115.86, -32.0, 115.86);
  assert.ok(d > 110_000 && d < 112_000, `got ${d}`);
});

test("nodeKey — 6dp rounding", () => {
  assert.equal(R.nodeKey(1.1234567, 2.7654321), "1.123457,2.765432");
});

test("MinHeap — pops in ascending order", () => {
  const h = new R.MinHeap();
  [5, 1, 4, 2, 8, 3].forEach((d) => h.push({ d }));
  const out = [];
  while (h.size()) out.push(h.pop().d);
  assert.deepEqual(out, [1, 2, 3, 4, 5, 8]);
});

test("dijkstra — shortest path + edge cases", () => {
  const graph = {
    A: [{ key: "B", dist: 1 }, { key: "C", dist: 4 }],
    B: [{ key: "C", dist: 1 }],
    C: [],
  };
  const r = R.dijkstra(graph, "A", "C");
  assert.equal(r.dist, 2);
  assert.deepEqual(r.path, ["A", "B", "C"]);
  assert.deepEqual(R.dijkstra(graph, "A", "A"), { dist: 0, path: ["A"] });
  assert.equal(R.dijkstra({ A: [] }, "A", "Z"), null); // unknown end
  assert.equal(R.dijkstra({ A: [] }, "Z", "A"), null); // unknown start
});

test("pathGeomLength — sums haversine over consecutive nodes, independent of weights", () => {
  // Two legs of ~111 km each (1° latitude steps). dijkstra's weighted dist
  // would differ under road weighting; the geometric length must not.
  const path = ["-31.000000,115.860000", "-32.000000,115.860000", "-33.000000,115.860000"];
  const len = R.pathGeomLength(path);
  assert.ok(len > 220_000 && len < 224_000, `got ${len}`);
  assert.equal(R.pathGeomLength(["-31.000000,115.860000"]), 0); // single node
  assert.equal(R.pathGeomLength([]), 0);
});

test("dijkstra — self-loop edge does not hang reconstruction", () => {
  // visited-guard means a self-edge is skipped; this asserts no infinite loop.
  const graph = { A: [{ key: "A", dist: 0 }, { key: "B", dist: 1 }], B: [] };
  const r = R.dijkstra(graph, "A", "B");
  assert.equal(r.dist, 1);
  assert.deepEqual(r.path, ["A", "B"]);
});

test("closestNode — returns nearest across a cell boundary (regression)", () => {
  // GRID_CELL ≈ 0.005°. Query at the centre of cell [0,0].
  // Node A sits in a ring-1 diagonal cell but far (~1160 m).
  // Node B sits in a ring-2 axial cell but near (~844 m).
  // The old code stopped at the first ring with a hit and wrongly returned A.
  R.resetSpatialGrid();
  const aLat = 0.0099, aLon = 0.0099; // cell [1,1], far corner
  const bLat = 0.0101, bLon = 0.0025; // cell [2,0], near edge
  const aKey = R.nodeKey(aLat, aLon);
  const bKey = R.nodeKey(bLat, bLon);
  R.gridInsert(aKey, aLat, aLon);
  R.gridInsert(bKey, bLat, bLon);
  const got = R.closestNode({}, 0.0025, 0.0025);
  // sanity: B really is the nearer of the two
  assert.ok(
    R.haversine(0.0025, 0.0025, bLat, bLon) < R.haversine(0.0025, 0.0025, aLat, aLon),
    "test setup wrong: B should be nearer than A",
  );
  assert.equal(got, bKey, "closestNode should return the nearer node B, not A");
});

test("computeAscent — dead-band rejects noise, sign-runs commit", () => {
  const elev = [0, 3, 7, 4, 10].map((e) => ({ elevation: e }));
  // dead-band 5: only the 0→7 run and trailing run clear the band
  assert.deepEqual(R.computeAscent(elev, 5), { ascent: 7, descent: 0 });
  // dead-band 2: more runs commit → larger ascent + some descent
  assert.deepEqual(R.computeAscent(elev, 2), { ascent: 13, descent: 3 });
  // empty / single-sample is safe
  assert.deepEqual(R.computeAscent([], 5), { ascent: 0, descent: 0 });
  assert.deepEqual(R.computeAscent([{ elevation: 5 }], 5), { ascent: 0, descent: 0 });
});

test("nodeAttrsFromTags — barriers/crossings/signals", () => {
  assert.deepEqual(R.nodeAttrsFromTags({ barrier: "gate" }), { barrier: true });
  assert.deepEqual(R.nodeAttrsFromTags({ highway: "traffic_signals" }), { trafficSignal: true });
  assert.deepEqual(R.nodeAttrsFromTags({ highway: "crossing", crossing: "marked" }), { crossingMarked: true });
  assert.equal(R.nodeAttrsFromTags({ amenity: "cafe" }), null); // no routing-relevant tag
});

test("compactToGeoJSON — v1 array and v2 object both parse", () => {
  const v1 = [[1, "footway", "Trail", [[-31.9, 115.8], [-31.91, 115.81]]]];
  const fc1 = R.compactToGeoJSON(v1);
  assert.equal(fc1.features[0].properties.highway, "footway");
  assert.equal(fc1.features[0].properties.surface, "");
  const v2 = { v: 2, features: [[2, "path", "X", [[0, 0], [1, 1]], "gravel"]], nodeAttrs: { k: { barrier: true } } };
  const fc2 = R.compactToGeoJSON(v2);
  assert.equal(fc2.features[0].properties.surface, "gravel");
  assert.deepEqual(fc2.nodeAttrs, { k: { barrier: true } });
});

test("sampleRoute — keeps first + last, samples by interval", () => {
  const coords = [[0, 0], [0, 0.01], [0, 0.02], [0, 0.03]];
  const pts = R.sampleRoute(coords, 1); // tiny interval → keep all
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[pts.length - 1], [0, 0.03]);
});

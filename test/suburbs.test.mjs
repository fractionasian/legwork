// The three ray-casting implementations must agree.
//
// Point-in-polygon is written out three times — suburbs.js (`_inRing`, in the
// browser), scripts/build-tiles.js (`pointInRing`, labelling the manifest) and
// scripts/build-suburbs.js (`pointInRing`, backing the build-time overlap
// assertion). They cannot share a module: suburbs.js is a browser global script
// loaded by a <script> tag with no build step, the other two are CommonJS.
//
// That duplication is tolerable only while something checks they agree. Without
// this file the overlap assertion is self-referential — it validates the data
// using its OWN copy, so a divergence in either consumer passes the build and
// shows up as a wrong suburb in production. Flagged by the phase gate
// 2026-08-31: "that's a requirement, not a verified guarantee".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const client = require("../suburbs.js");
const tiles = require("../scripts/build-tiles.js");
const build = require("../scripts/build-suburbs.js");

const CITIES = ["perth", "singapore"];
const dataFor = (c) => `${import.meta.dirname}/../data/suburbs/${c}.json`;
const available = CITIES.filter((c) => existsSync(dataFor(c)));

// A square whose winding order and hole are both unambiguous.
const SQUARE = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
const HOLE = [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]];

test("all three _inRing agree on a known square", () => {
  const cases = [[5, 5, true], [1, 1, true], [9.9, 9.9, true],
                 [-1, 5, false], [5, 11, false], [11, 11, false], [5, -0.5, false]];
  for (const [lat, lon, want] of cases) {
    assert.equal(client._inRing(lat, lon, SQUARE), want, `client ${lat},${lon}`);
    assert.equal(tiles.pointInRing(lat, lon, SQUARE), want, `build-tiles ${lat},${lon}`);
    assert.equal(build.pointInRing(lat, lon, SQUARE), want, `build-suburbs ${lat},${lon}`);
  }
});

// The degenerate case, and the one a uniform grid never reaches: a point whose
// latitude EXACTLY equals a vertex latitude. That is the only input where the
// standard `(lai > lat) !== (laj > lat)` and the subtly-wrong `>=` form differ,
// so without these cases the suite passes a genuinely divergent implementation
// — verified: flipping suburbs.js to `>=` left all 7 tests green before this
// was added.
//
// The correct ANSWER on a boundary is arbitrary (the point is on the edge);
// the invariant is that all three implementations return the SAME thing, so
// this compares them to each other rather than to a fixed expectation.
test("all three agree at vertex latitudes, where ray-casting is degenerate", () => {
  const shapes = {
    square: SQUARE,
    diamond: [[0, 5], [5, 10], [10, 5], [5, 0], [0, 5]],
    notch: [[0, 0], [0, 10], [5, 10], [5, 5], [10, 5], [10, 0], [0, 0]],
  };
  let compared = 0;
  for (const [name, ring] of Object.entries(shapes)) {
    for (const lat of [...new Set(ring.map((p) => p[0]))]) {
      for (let lon = -1; lon <= 11; lon += 0.5) {
        const a = client._inRing(lat, lon, ring);
        const b = tiles.pointInRing(lat, lon, ring);
        const c = build.pointInRing(lat, lon, ring);
        assert.equal(a, b, `${name} lat=${lat} lon=${lon}: client=${a} build-tiles=${b}`);
        assert.equal(a, c, `${name} lat=${lat} lon=${lon}: client=${a} build-suburbs=${c}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 100, `only ${compared} boundary comparisons`);
});

test("all three subtract holes identically", () => {
  const f = { n: "X", p: [SQUARE], h: [HOLE] };
  for (const [lat, lon, want] of [[5, 5, false], [1, 1, true], [4.5, 4.5, false], [3.9, 5, true]]) {
    assert.equal(client._contains(f, lat, lon), want, `client ${lat},${lon}`);
    assert.equal(build.containsPoint(f, lat, lon), want, `build-suburbs ${lat},${lon}`);
  }
});

// build-tiles.js applies holes INLINE inside suburbsForTile rather than through
// a shared helper, so the two tests above cannot reach it — verified: deleting
// its hole clause left them all green. This drives the real entry point.
//
// Big covers the whole area with a hole punched in it; Small fills that hole.
// Big is listed FIRST, so if holes are ignored it wins every sample point (the
// scan breaks on first match) and Small never appears.
test("build-tiles.js suburbsForTile subtracts holes", () => {
  const withBbox = (f) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const ring of f.p) for (const pt of ring) {
      if (pt[0] < a) a = pt[0];
      if (pt[0] > b) b = pt[0];
      if (pt[1] < c) c = pt[1];
      if (pt[1] > d) d = pt[1];
    }
    return { ...f, bbox: [a, c, b, d] };
  };
  const polys = [
    withBbox({ n: "Big", p: [SQUARE], h: [HOLE] }),
    withBbox({ n: "Small", p: [HOLE] }),
  ];
  // A tile entirely inside the hole must be Small alone.
  assert.deepEqual(tiles.suburbsForTile([4.2, 4.2, 5.8, 5.8], polys), ["Small"]);
  // A tile entirely outside the hole must be Big alone.
  assert.deepEqual(tiles.suburbsForTile([0.5, 0.5, 3.5, 3.5], polys), ["Big"]);
  // A tile spanning both must name both, most-covered first.
  const both = tiles.suburbsForTile([0, 0, 10, 10], polys);
  assert.ok(both.includes("Big") && both.includes("Small"), `got ${JSON.stringify(both)}`);
  assert.equal(both[0], "Big", "ordering is by coverage, and Big covers more");
});

test("a feature with no `h` behaves as hole-free in every implementation", () => {
  const f = { n: "X", p: [SQUARE] };
  assert.equal(client._contains(f, 5, 5), true);
  assert.equal(build.containsPoint(f, 5, 5), true);
});

// The real guarantee: same answer on the actual shipped polygons. A synthetic
// square would not catch a divergence that only bites on real coordinate
// magnitudes or on a boundary shared between two suburbs.
for (const city of available) {
  test(`client and builder agree across a grid over ${city}`, () => {
    const list = JSON.parse(readFileSync(dataFor(city), "utf-8"));
    const withBbox = JSON.parse(JSON.stringify(list));
    for (const f of withBbox) {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const ring of f.p) for (const pt of ring) {
        if (pt[0] < a) a = pt[0];
        if (pt[0] > b) b = pt[0];
        if (pt[1] < c) c = pt[1];
        if (pt[1] > d) d = pt[1];
      }
      f.bbox = [a, c, b, d];
    }
    client._suburbs[city] = withBbox;

    let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
    for (const f of list) for (const ring of f.p) for (const pt of ring) {
      if (pt[0] < lo) lo = pt[0];
      if (pt[0] > hi) hi = pt[0];
      if (pt[1] < lo2) lo2 = pt[1];
      if (pt[1] > hi2) hi2 = pt[1];
    }

    // Uniform rows, PLUS rows drawn from real vertex latitudes — the uniform
    // grid alone cannot land on a vertex, which is the one place the
    // implementations can diverge.
    const N = 60;
    const rows = [];
    for (let i = 0; i < N; i++) rows.push(lo + (hi - lo) * (i + 0.5) / N);
    const verts = [];
    for (const f of list) for (const ring of f.p) for (const pt of ring) verts.push(pt[0]);
    for (let k = 0; k < verts.length; k += Math.ceil(verts.length / N)) rows.push(verts[k]);

    let checked = 0, named = 0;
    for (const lat of rows) {
      for (let j = 0; j < N; j++) {
        const lon = lo2 + (hi2 - lo2) * (j + 0.5) / N;
        const c = client.suburbForPoint(city, lat, lon);
        const b = list.find((f) => build.containsPoint(f, lat, lon))?.n ?? null;
        assert.equal(c, b, `${city} ${lat.toFixed(5)},${lon.toFixed(5)}: client=${c} builder=${b}`);
        checked++;
        if (c) named++;
      }
    }
    // Guard against a vacuous pass: null === null agrees everywhere, so a
    // broken loader would sail through. Demand real hits.
    assert.ok(named > checked * 0.2, `only ${named}/${checked} points landed in a suburb — data not loaded?`);
  });

  test(`${city} polygons have no overlaps`, () => {
    const list = JSON.parse(readFileSync(dataFor(city), "utf-8"));
    const bounds = JSON.parse(readFileSync(`${import.meta.dirname}/../data/cities.json`, "utf-8"))
      .find((c) => c.id === city).bounds;
    assert.deepEqual(build.findOverlaps(list, bounds), [],
      "a point matching two suburbs makes first-match resolution order-dependent");
  });
}

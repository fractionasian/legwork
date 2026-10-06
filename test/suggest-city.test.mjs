// The weekly "which city next" suggestion: pure selection logic, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const S = createRequire(import.meta.url)("../scripts/suggest-city.js");
const cities = JSON.parse(fs.readFileSync(new URL("../data/cities.json", import.meta.url)));

test("bucket maths matches the client's Math.round(x * 2) / 2 bucketing", () => {
  assert.deepEqual(S.bucketBox("-32.0,116.0"), { south: -32.25, north: -31.75, west: 115.75, east: 116.25 });
  assert.ok(S.cellInBucket("-32.100:116.100", "-32.0,116.0"));
  assert.ok(!S.cellInBucket("-31.700:116.100", "-32.0,116.0"));
});

test("picks the busiest uncovered bucket and centres on its busiest cell", () => {
  const buckets = [{ bucket: "-33.5,115.5", n: 40 }, { bucket: "-34.5,138.5", n: 25 }];
  const demand = [
    { cell: "-33.650:115.560", hits: 3 },
    { cell: "-33.640:115.600", hits: 9 },          // busiest in the first bucket
    { cell: "-34.900:138.600", hits: 5 },
  ];
  const got = S.pickCandidate(buckets, demand, cities);
  assert.equal(got.bucket, "-33.5,115.5");
  assert.equal(got.n, 40);
  assert.deepEqual([got.lat, got.lon], [-33.64, 115.6]);
  assert.deepEqual(got.bounds, [-33.79, 115.45, -33.49, 115.75]);
});

test("below the threshold, or already inside a seeded city, nothing is suggested", () => {
  assert.equal(S.pickCandidate([{ bucket: "-33.5,115.5", n: S.MIN_EVENTS - 1 }], [{ cell: "-33.640:115.600", hits: 9 }], cities), null);
  // a pin cell in Perth's box, in a bucket that straddles it
  const inPerth = [{ cell: "-31.950:115.860", hits: 50 }];
  assert.equal(S.pickCandidate([{ bucket: "-32.0,116.0", n: 100 }], inPerth, cities), null);
});

test("a box that would overlap a seeded city is skipped, and the next bucket gets its turn", () => {
  const nearPerth = { cell: "-31.700:115.800", hits: 99 };     // just north of Perth's box, within 0.15 of it
  const far = { cell: "-33.640:115.600", hits: 1 };
  const got = S.pickCandidate([{ bucket: "-31.5,116.0", n: 90 }, { bucket: "-33.5,115.5", n: 30 }], [nearPerth, far], cities);
  assert.equal(got.bucket, "-33.5,115.5");
});

test("a bucket with no demand rows is skipped, never guessed at", () => {
  assert.equal(S.pickCandidate([{ bucket: "-33.5,115.5", n: 90 }], [], cities), null);
});

test("slugify gives a plain ascii id", () => {
  assert.equal(S.slugify("Zürich"), "zurich");
  assert.equal(S.slugify("São Paulo"), "sao-paulo");
  assert.equal(S.slugify("Newcastle upon Tyne"), "newcastle-upon-tyne");
});

test("appendCity keeps the file valid and in its one-line-bounds style", () => {
  const text = fs.readFileSync(new URL("../data/cities.json", import.meta.url), "utf8");
  const out = S.appendCity(text, { id: "bunbury", name: "Bunbury", bounds: [-33.43, -115.75, -33.13, -115.45] });
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, cities.length + 1);
  assert.deepEqual(parsed.at(-1), { id: "bunbury", name: "Bunbury", bounds: [-33.43, -115.75, -33.13, -115.45], elevation: true });
  assert.deepEqual(parsed.slice(0, -1), cities, "existing entries untouched");
  assert.ok(out.includes('"bounds": [-33.43, -115.75, -33.13, -115.45],'));
  assert.ok(out.endsWith("}\n]\n") || out.endsWith("}\n]"));
});

test("describeTop reports the leaders, with where their busiest cell sits", () => {
  assert.deepEqual(S.describeTop([], [], cities), ["  none recorded"]);
  const lines = S.describeTop(
    [{ bucket: "-33.5,115.5", n: 14 }, { bucket: "-32.0,116.0", n: 9 }, { bucket: "-34.5,138.5", n: 2 }, { bucket: "0.0,0.0", n: 1 }],
    [{ cell: "-33.640:115.600", hits: 9 }, { cell: "-31.950:115.860", hits: 5 }],
    cities);
  assert.equal(lines.length, 3, "top three only");
  assert.equal(lines[0], "  -33.5,115.5: 14 events; busiest cell -33.64, 115.6 (outside all seeded cities)");
  assert.equal(lines[1], "  -32.0,116.0: 9 events; busiest cell -31.95, 115.86 (inside a seeded city)");
  assert.equal(lines[2], "  -34.5,138.5: 2 events; no pin cells recorded");
});

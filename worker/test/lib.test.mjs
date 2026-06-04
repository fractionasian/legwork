import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOverpassQuery, parseGraphParams, cacheKey, OVERPASS_URL, snap, GRID_DEG } from "../src/lib.js";

test("buildOverpassQuery includes runner highway types and the around clause", () => {
  const q = buildOverpassQuery(-31.95, 115.86, 2000);
  for (const hw of ["footway", "cycleway", "path", "residential", "primary", "trunk", "steps", "crossing"]) {
    assert.ok(q.includes('"highway"="' + hw + '"'), "missing highway type: " + hw);
  }
  assert.ok(q.includes("around:2000,-31.95,115.86"), "missing around clause");
  assert.ok(q.startsWith("[out:json][timeout:30];"), "missing query header");
  assert.ok(q.includes("out body qt;"), "missing node-recurse tail");
});

test("cacheKey rounds coords to 3dp and is profile-independent", () => {
  assert.equal(cacheKey(-31.95012, 115.86098, 2000), "g:-31.950:115.861:2000");
  // No profile term: key is exactly g:lat:lon:radius (4 colon-separated parts, "g" first).
  const parts = cacheKey(-31.95012, 115.86098, 2000).split(":");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "g");
  // Different radius → different key (radius is part of the key).
  assert.notEqual(cacheKey(-31.95012, 115.86098, 2000), cacheKey(-31.95012, 115.86098, 5000));
});

test("parseGraphParams accepts valid params", () => {
  const u = new URL("https://w.dev/v1/graph?lat=-31.95&lon=115.86&radius=2000");
  assert.deepEqual(parseGraphParams(u), { ok: true, lat: -31.95, lon: 115.86, radius: 2000 });
});

test("parseGraphParams rejects out-of-range and NaN", () => {
  const bad = [
    "?lat=abc&lon=115&radius=2000",
    "?lat=-31.95&lon=115.86&radius=999999",
    "?lat=200&lon=115&radius=2000",
    "?lat=-31.95&lon=400&radius=2000",
    "?lat=-31.95&lon=115.86&radius=50",
  ];
  for (const qs of bad) {
    const r = parseGraphParams(new URL("https://w.dev/v1/graph" + qs));
    assert.equal(r.ok, false, "should reject: " + qs);
  }
});

test("parseGraphParams boundary values", () => {
  // Endpoints accepted
  for (const [lat, lon, radius] of [[90, 180, 100], [-90, -180, 30000]]) {
    const u = new URL(`https://w.dev/v1/graph?lat=${lat}&lon=${lon}&radius=${radius}`);
    assert.equal(parseGraphParams(u).ok, true, `should accept ${lat},${lon},${radius}`);
  }
  // Just outside / wrong type rejected
  for (const qs of ["?lat=-31.95&lon=115.86&radius=99", "?lat=-31.95&lon=115.86&radius=30001", "?lat=-31.95&lon=115.86&radius=2000.5"]) {
    assert.equal(parseGraphParams(new URL("https://w.dev/v1/graph" + qs)).ok, false, "should reject: " + qs);
  }
});

test("OVERPASS_URL points at the interpreter endpoint", () => {
  assert.equal(OVERPASS_URL, "https://overpass-api.de/api/interpreter");
});

test("snap collapses nearby pins to one grid cell, separates distant ones", () => {
  // Two pins ~220 m apart → same cell.
  assert.equal(snap(-36.849).toFixed(3), snap(-36.851).toFixed(3));
  assert.equal(snap(-36.849).toFixed(3), "-36.850");
  // A pin in the next cell → distinct.
  assert.notEqual(snap(-36.849).toFixed(3), snap(-36.856).toFixed(3));
});

test("snap output lands on a GRID_DEG multiple", () => {
  const s = snap(174.7632);
  assert.ok(Math.abs(s / GRID_DEG - Math.round(s / GRID_DEG)) < 1e-9);
  assert.equal(GRID_DEG, 0.005);
});

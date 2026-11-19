// Pure helpers behind the "Loop ▸" chip (docs/design/target-distance-loops.md, PR 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../routing.js");

test("parseLoopKm — reads a typed distance, comma or point, with or without km", () => {
  assert.deepEqual(R.parseLoopKm("12.5", 42), { km: 12.5, clamped: false });
  assert.deepEqual(R.parseLoopKm("12,5", 42), { km: 12.5, clamped: false });
  assert.deepEqual(R.parseLoopKm(" 7 km ", 42), { km: 7, clamped: false });
  assert.deepEqual(R.parseLoopKm(".5", 42), { km: 1, clamped: true });
  assert.deepEqual(R.parseLoopKm("6.66", 42), { km: 6.7, clamped: false });
});

test("parseLoopKm — clamps to 1–32 km, or 10 km outside a pre-baked city", () => {
  assert.equal(R.LOOP_MAX_KM, 32);
  assert.deepEqual(R.parseLoopKm("42", R.LOOP_MAX_KM), { km: 32, clamped: true });
  assert.deepEqual(R.parseLoopKm("0.4", R.LOOP_MAX_KM), { km: 1, clamped: true });
  assert.deepEqual(R.parseLoopKm("15", R.LOOP_MAX_KM_LIVE), { km: 10, clamped: true });
  assert.deepEqual(R.parseLoopKm("10", R.LOOP_MAX_KM_LIVE), { km: 10, clamped: false });
});

test("parseLoopKm — not a number gives null, so nothing is generated", () => {
  for (const s of ["", "  ", "abc", "5k", "-3", "0", "1e3", "5..2", null, undefined]) {
    assert.equal(R.parseLoopKm(s, 42), null, JSON.stringify(s));
  }
});

test("loopBucket — the preset tapped, else other; never a raw distance", () => {
  for (const km of R.LOOP_PRESETS_KM) assert.equal(R.loopBucket(km, false), String(km));
  assert.equal(R.loopBucket(5, true), "other");       // typed 5 is still "other"
  assert.equal(R.loopBucket(12.5, false), "other");
  assert.deepEqual(R.LOOP_PRESETS_KM, [3, 5, 8, 10, 15, 21]);
});

test("loopResult — ok if any loop is acceptable, near_miss if none, failed if empty", () => {
  assert.equal(R.loopResult([]), "failed");
  assert.equal(R.loopResult(null), "failed");
  assert.equal(R.loopResult([{ ok: false }, { ok: false }]), "near_miss");
  assert.equal(R.loopResult([{ ok: false }, { ok: true }]), "ok");
});

test("loopInWindow — the generator's −3% / +10% accept window", () => {
  assert.equal(R.loopInWindow(5000, 5000), true);
  assert.equal(R.loopInWindow(4850, 5000), true);
  assert.equal(R.loopInWindow(4840, 5000), false);
  assert.equal(R.loopInWindow(5500, 5000), true);
  assert.equal(R.loopInWindow(5510, 5000), false);
  assert.equal(R.loopInWindow(7200, 8000), false);   // the spec's near-miss example
});

test("loopGroundKm — never below a first pin's 5 km, grows for long loops", () => {
  assert.equal(R.loopGroundKm(3), 5);
  assert.equal(R.loopGroundKm(5), 5);
  assert.ok(R.loopGroundKm(21) > 8 && R.loopGroundKm(21) < 10);
  assert.ok(R.loopGroundKm(42) > R.loopGroundKm(21));
});

test("loopLiveRadiusM — whole km, never under 2 km (a zoom-16 first pin loads only 1 km)", () => {
  assert.equal(R.loopLiveRadiusM(1), 2000);
  assert.equal(R.loopLiveRadiusM(3), 2000);
  assert.equal(R.loopLiveRadiusM(5), 2000);
  assert.equal(R.loopLiveRadiusM(10), 4000);
  assert.ok(/^\d{4,5}$/.test(String(R.loopLiveRadiusM(10))), "the Worker's radius format");
});

test("loopSnapshotStale — drops results after the start moves or anything it measured changes", () => {
  const graph = {}, start = {};
  const base = { run: 1, graph, profile: "run", mode: "loop", count: 1, start, key: "-31.95,115.86" };
  assert.equal(R.loopSnapshotStale(base, { ...base }), false);
  const changes = {
    run: 2,                              // cancelled (chip tap, Esc, Undo)
    graph: {},                           // city change or run/bike rebuild
    profile: "bike",
    mode: "outback",
    count: 2,                            // a pin added mid-generation
    start: {},                           // Clear → Undo put a new start pin down
    key: "-31.951,115.861",              // start pin dragged
  };
  for (const [k, v] of Object.entries(changes)) {
    assert.equal(R.loopSnapshotStale(base, { ...base, [k]: v }), true, k);
  }
});

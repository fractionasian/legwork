#!/usr/bin/env node
// Real-tile harness for the target-distance loop generator
// (docs/design/target-distance-loops.md, "Harness results").
//
// For each city: 20 seeded starts, each a random point that snaps to a path within
// 200 m (the pin rule), with the tiles the app would load for a first pin there
// (tilesInRadius 5 km). For each start and target, generateLoops() with the shipped
// router settings and the run profile, exactly as the app's own scripts run it: routing.js
// and tiles.js are evaluated in one browser-like global scope, and tiles go through
// compactToGeoJSON + applyPaths.
//
// Usage:
//   node scripts/loop-harness.mjs --tiles <dir> [--cities perth,melbourne,sydney,brisbane]
//                                 [--targets 5000,10000] [--starts 20] [--seed 1] [--profile run]
// <dir> holds a legwork-tiles checkout's manifest.json and tiles/<city>/*.json, e.g.
//   git -C ~/legwork-tiles archive origin/master manifest.json tiles/perth | tar -x -C /tmp/t
//
// Gate (spec, success metrics): at least 18 of 20 starts per city give 3 loops within 10%.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
if (!args.tiles) { console.error("--tiles <dir> is required (see the header of this file)"); process.exit(2); }
const TILES = args.tiles;
const CITIES = (args.cities || "perth,melbourne,sydney,brisbane").split(",");
const TARGETS = (args.targets || "5000,10000").split(",").map(Number);
const STARTS = Number(args.starts || 20);
const SEED = Number(args.seed || 1);
const PROFILE = args.profile || "run";
const GATE_MIN = Math.ceil(STARTS * 0.9);
// --set "LOOP_SPREAD=50;LOOP_DETOUR=1.4": override generator constants for a tuning run.
// Recorded in the report header so a tuned run is never mistaken for the shipped one.
const SET = args.set || "";

const manifest = JSON.parse(fs.readFileSync(path.join(TILES, "manifest.json"), "utf8"));
const src = (f) => fs.readFileSync(path.join(root, f), "utf8");
const ROUTING = src("routing.js"), TILESJS = src("tiles.js");

// A fresh app scope per start: a first pin dropped on a cold app.
function appScope() {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, state: { profile: PROFILE }, setTimeout, Promise });
  vm.runInContext(ROUTING, ctx, { filename: "routing.js" });
  vm.runInContext(TILESJS, ctx, { filename: "tiles.js" });
  if (SET) vm.runInContext(SET, ctx);
  return ctx;
}
const tileCache = new Map();
function tileData(city, file) {
  const k = city + "/" + file;
  if (!tileCache.has(k)) tileCache.set(k, JSON.parse(fs.readFileSync(path.join(TILES, "tiles", city, file), "utf8")));
  return tileCache.get(k);
}
function loadStart(cityId, lat, lon) {
  const ctx = appScope();
  const tiles = ctx.tilesInRadius(manifest.cities[cityId], lat, lon, 5);
  for (const t of tiles) ctx.applyPaths(ctx.compactToGeoJSON(tileData(cityId, t.file)), { skipRender: true });
  return { ctx, nTiles: tiles.length };
}
const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// Random point inside the city, 3 km in from the edge so the 5 km tile ring is whole,
// kept only if a path is within 200 m (anything further would not take a pin).
function pickStarts(cityId, rnd) {
  const [s, w, n, e] = manifest.cities[cityId].bounds;
  const mLat = 3000 / 111320, mLon = 3000 / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
  const probe = appScope();
  for (const t of manifest.cities[cityId].tiles) probe.applyPaths(probe.compactToGeoJSON(tileData(cityId, t.file)), { skipRender: true });
  const out = [];
  for (let tries = 0; out.length < STARTS && tries < 5000; tries++) {
    const lat = s + mLat + rnd() * (n - s - 2 * mLat), lon = w + mLon + rnd() * (e - w - 2 * mLon);
    const key = probe.closestNode(probe.state.graph, lat, lon);
    if (!key) continue;
    const [kl, ko] = key.split(",").map(Number);
    if (probe.haversine(lat, lon, kl, ko) <= 200) out.push({ lat, lon });
  }
  return out;
}

const pct = (x) => (100 * x).toFixed(0) + "%";
const results = [];
const t0 = Date.now();
for (const cityId of CITIES) {
  const rnd = seeded(SEED * 7919 + cityId.length * 31 + cityId.charCodeAt(0));
  const starts = pickStarts(cityId, rnd);
  for (let si = 0; si < starts.length; si++) {
    const { lat, lon } = starts[si];
    const { ctx, nTiles } = loadStart(cityId, lat, lon);
    const startKey = ctx.closestNode(ctx.state.graph, lat, lon);
    for (const target of TARGETS) {
      const theta0 = rnd() * 360;
      const w0 = performance.now();
      const loops = await ctx.generateLoops(ctx.state.graph, startKey, target, { theta0 });
      const ms = performance.now() - w0;
      results.push({
        city: cityId, start: si, lat, lon, nTiles, target, ms,
        loops: loops.map((l) => ({ length: l.length, error: l.error, overlap: l.overlap, ok: l.ok, jittered: !!l.jittered, tries: l.tries.length })),
      });
    }
  }
}
const wall = (Date.now() - t0) / 1000;

// ── report ──
const rows = [];
let gatePass = true;
for (const cityId of CITIES) for (const target of TARGETS) {
  const rs = results.filter((r) => r.city === cityId && r.target === target);
  const loops = rs.flatMap((r) => r.loops);
  const three10 = rs.filter((r) => r.loops.length === 3 && r.loops.every((l) => l.error <= 0.10)).length;
  const three5 = rs.filter((r) => r.loops.length === 3 && r.loops.every((l) => l.error <= 0.05)).length;
  const in5 = loops.filter((l) => l.error <= 0.05).length, in10 = loops.filter((l) => l.error <= 0.10).length;
  const ov = loops.reduce((a, l) => a + l.overlap, 0) / (loops.length || 1);
  const ovOver = loops.filter((l) => l.overlap > 0.15).length;
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  const pass = three10 >= GATE_MIN;
  if (!pass) gatePass = false;
  rows.push({
    city: cityId, km: target / 1000, starts: rs.length,
    "3 loops ≤10%": `${three10}/${rs.length}${pass ? "" : " ✗"}`,
    "3 loops ≤5%": `${three5}/${rs.length}`,
    "loops ≤5%": `${in5}/${loops.length} (${pct(in5 / (loops.length || 1))})`,
    "loops ≤10%": `${in10}/${loops.length} (${pct(in10 / (loops.length || 1))})`,
    "mean overlap": pct(ov), "overlap >15%": ovOver,
    "ms median": Math.round(ms[Math.floor(ms.length / 2)]), "ms max": Math.round(ms[ms.length - 1]),
  });
}
console.log(`tiles ${manifest.version} (built ${manifest.built}), profile ${PROFILE}, seed ${SEED}, ${STARTS} starts per city` +
  (SET ? `, OVERRIDES: ${SET}` : ", shipped constants"));
console.table(rows);
const all = results.flatMap((r) => r.loops);
console.log(`all: ${all.filter((l) => l.error <= 0.05).length}/${all.length} loops within 5%, ` +
  `${all.filter((l) => l.error <= 0.10).length}/${all.length} within 10%, ` +
  `mean overlap ${pct(all.reduce((a, l) => a + l.overlap, 0) / all.length)}, ` +
  `jitter retries ${all.filter((l) => l.jittered).length}, wall ${wall.toFixed(1)} s (includes tile loading)`);
const misses = results.filter((r) => r.loops.length < 3 || r.loops.some((l) => l.error > 0.10));
if (misses.length) {
  console.log("\nstarts short of 3 loops within 10%:");
  for (const r of misses) console.log(`  ${r.city} #${r.start} (${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}) ${r.target / 1000} km: ` +
    r.loops.map((l) => `${(l.length / 1000).toFixed(2)} km ov ${pct(l.overlap)}`).join(" | ") + (r.loops.length < 3 ? ` (${r.loops.length} found)` : ""));
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify(results, null, 1));
console.log(`\ngate (≥${GATE_MIN}/${STARTS} starts per city and target give 3 loops within 10%): ${gatePass ? "PASS" : "MISS"}`);
process.exit(gatePass ? 0 : 1);

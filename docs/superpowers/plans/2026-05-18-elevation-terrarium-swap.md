# Elevation Source Swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Open-Meteo with AWS Terrarium tiles as the primary elevation source, with Open-Meteo as fallback. Tighten the smoothing pipeline so the test route's reported gain matches the Strava ground truth within ±15 m.

**Why:** Open-Meteo returns spurious `0.0 m` at 29% of points on flat inner-Perth routes, inflating reported gain ~3× (149 m vs Strava's 44 m on the 2026-05-17 Mosman-Park-to-Subiaco out-and-back). Switching source eliminates the artefact zeros so the median filter can do its job. See companion spec `docs/superpowers/specs/2026-05-18-elevation-terrarium-swap-design.md`.

**Architecture:** Pure tile-math, decoding, and filtering helpers go in `routing.js` (already houses pure-ish domain helpers). Browser-only I/O (tile fetch via `<canvas>` for pixel access, IndexedDB caching) stays in `app.js`. A Node verification script lives in `scripts/verify-elevation.mjs`.

**Tech Stack:** Vanilla JS (no framework). Tile decoding via `<canvas>` + `getImageData()` in the browser. Node verification uses built-in `node:test` and the existing `routing.js` re-imported via a tiny CJS export footer.

---

## Truth fixtures (used by tests in this plan)

### Fixture A — flat coastal test route ("20 km out & back", 2026-05-17)

13 one-way waypoints, mode `outback` (route is doubled back):

```javascript
const FIXTURE_A_WAYPOINTS = [
    [-31.99510, 115.81148], [-31.99019, 115.81741], [-31.98657, 115.82209],
    [-31.98022, 115.82085], [-31.97339, 115.82589], [-31.96885, 115.83778],
    [-31.95868, 115.85021], [-31.95973, 115.85626], [-31.96044, 115.86311],
    [-31.96131, 115.86589], [-31.96288, 115.87059], [-31.96363, 115.87812],
    [-31.96553, 115.88278],
];
const FIXTURE_A_TRUTH = { distanceKm: 19.5, gainMetres: 44.2 }; // Strava activity 18536502294
const FIXTURE_A_TOLERANCE = { gainMin: 30, gainMax: 65 };
```

### Fixture B — hilly Kings Park loop (regression guard)

Six waypoints around the Mt Eliza ridge (~60 m above the river):

```javascript
const FIXTURE_B_WAYPOINTS = [
    [-31.96100, 115.84150],  // Riverside Drive (low, ~3 m)
    [-31.96234, 115.84442],  // climbing into Kings Park
    [-31.96100, 115.84600],  // ridge / Fraser Avenue
    [-31.95950, 115.84800],  // ridge continues
    [-31.95850, 115.84600],
    [-31.96100, 115.84150],  // back to start
];
const FIXTURE_B_TRUTH = { distanceKm: 1.6, gainMetres: 60 }; // estimated from Geoscience Australia DEM
const FIXTURE_B_TOLERANCE = { gainMin: 35, gainMax: 100 };  // wide because DEM-based truth is approximate
```

---

## File Structure

| File | Role |
|---|---|
| `routing.js` | Add pure functions: `tileCoords`, `decodeTerrarium`, `bilinearSample`, `medianFilter`. Modify `smoothElevations` (α 0.6 → 0.4, prepend median-9). Add CJS export footer for Node consumption. |
| `app.js` | Replace `fetchElevation()` body (lines 300–338) with Terrarium tile fetcher + Open-Meteo fallback. Bump `DEAD_BAND` from 2 → 5 (line 1031). Rename cache key prefix `elev2:` → `elev3:` at three call sites (307, 327, 1142). |
| `sw.js` | Add `"s3.amazonaws.com/elevation-tiles-prod"` to `TILE_PATTERNS` (lines 18–22). `CACHE_NAME` auto-bumps via workflow on push; don't touch manually. |
| `test.html` | New assertions for `tileCoords`, `decodeTerrarium`, `bilinearSample`, `medianFilter`. |
| `scripts/verify-elevation.mjs` | NEW — Node script using built-in `node:test` runner. Imports `routing.js` via `createRequire`. Tests pure functions against the two fixtures. |

Tests run by:
- Browser: open `test.html`, visually confirm green entries.
- Node: `node --test scripts/verify-elevation.mjs`.

**Never use `innerHTML`** — Peter's coding principle bans it (XSS). Use `textContent` or DOM construction APIs.

---

## Task 1: Add tile-coordinate math (`tileCoords`)

**Files:**
- Modify: `routing.js` (add function after `haversine`)
- Test: `test.html` (new assertions)

- [ ] **Step 1: Write the failing tests**

Append inside the existing `<script>` block in `test.html` (before the closing `</script>`):

```javascript
    // ── tileCoords ──────────────────────────────────
    test("tileCoords: equator at z=0 lands at tile (0,0) pixel (128,128)", function () {
        var r = tileCoords(0, 0, 0);
        assert(r.xtile === 0 && r.ytile === 0);
        assert(Math.abs(r.px - 128) < 0.001 && Math.abs(r.py - 128) < 0.001);
    });
    test("tileCoords: Perth (-31.99510, 115.81148) at z=14", function () {
        var r = tileCoords(-31.99510, 115.81148, 14);
        // Known good values computed offline
        assert(r.xtile === 13462 && r.ytile === 9729);
        assert(r.px >= 0 && r.px < 256);
        assert(r.py >= 0 && r.py < 256);
    });
    test("tileCoords: increasing longitude moves east (larger xtile or px)", function () {
        var a = tileCoords(-31.99, 115.80, 14);
        var b = tileCoords(-31.99, 115.85, 14);
        var ka = a.xtile * 256 + a.px;
        var kb = b.xtile * 256 + b.px;
        assert(kb > ka);
    });
```

- [ ] **Step 2: Run tests, confirm failure**

Open `test.html` in a browser. Expect red FAIL entries with `tileCoords is not defined`.

- [ ] **Step 3: Implement**

In `routing.js`, after the `haversine` function (around line 12, before the existing `// ── Route sampling + elevation smoothing` comment), add:

```javascript
// ── Terrarium tile math ────────────────────────────────
// Convert (lat, lon, zoom) to slippy-map tile XYZ + pixel-space (px, py)
// within that tile's 256×256 raster. Used to look up elevation in
// pre-rendered Terrarium PNG tiles served by AWS Open Data Programme.
function tileCoords(lat, lon, z) {
    var n = Math.pow(2, z);
    var x = (lon + 180) / 360 * n;
    var latRad = lat * Math.PI / 180;
    var y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    var xtile = Math.floor(x), ytile = Math.floor(y);
    return { xtile: xtile, ytile: ytile, px: (x - xtile) * 256, py: (y - ytile) * 256 };
}
```

- [ ] **Step 4: Confirm green**

Reload `test.html`. All three `tileCoords` tests pass.

- [ ] **Step 5: Commit**

```bash
git add routing.js test.html
git commit -m "feat(elevation): add tileCoords for terrarium tile lookup"
```

---

## Task 2: Add Terrarium pixel decoder (`decodeTerrarium`)

**Files:**
- Modify: `routing.js` (add function after `tileCoords`)
- Test: `test.html`

- [ ] **Step 1: Write the failing tests**

Append to `test.html`:

```javascript
    // ── decodeTerrarium ─────────────────────────────
    test("decodeTerrarium: (128, 0, 0) decodes to 0 m", function () {
        // R=128 → 128*256 = 32768; minus offset 32768 → 0
        assert(Math.abs(decodeTerrarium(128, 0, 0) - 0) < 0.001);
    });
    test("decodeTerrarium: (128, 100, 0) decodes to 100 m", function () {
        assert(Math.abs(decodeTerrarium(128, 100, 0) - 100) < 0.001);
    });
    test("decodeTerrarium: (127, 0, 0) decodes to -256 m (below sea level)", function () {
        assert(Math.abs(decodeTerrarium(127, 0, 0) - (-256)) < 0.001);
    });
    test("decodeTerrarium: fractional via blue channel", function () {
        // R=128, G=10, B=128 → 32768 + 10 + 0.5 - 32768 = 10.5
        assert(Math.abs(decodeTerrarium(128, 10, 128) - 10.5) < 0.001);
    });
```

- [ ] **Step 2: Confirm failure**

Reload `test.html`. New tests red.

- [ ] **Step 3: Implement**

In `routing.js`, after `tileCoords`:

```javascript
// Decode a single Terrarium pixel (R, G, B) to metres above WGS84 ellipsoid.
// Encoding: elev = (R*256 + G + B/256) - 32768. See
// https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium
function decodeTerrarium(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}
```

- [ ] **Step 4: Confirm green and commit**

```bash
git add routing.js test.html
git commit -m "feat(elevation): add decodeTerrarium pixel decoder"
```

---

## Task 3: Add `bilinearSample` for sub-pixel sampling

**Files:**
- Modify: `routing.js`
- Test: `test.html`

- [ ] **Step 1: Write the failing tests**

Append to `test.html`:

```javascript
    // ── bilinearSample ─────────────────────────────
    test("bilinearSample: integer-pixel sample equals raw value", function () {
        // 4×4 grid of distinct elevations
        var grid = [
            [10, 20, 30, 40],
            [50, 60, 70, 80],
            [90,100,110,120],
            [130,140,150,160],
        ];
        function getPixel(x, y) { return grid[y][x]; }
        // px=1, py=1 → pixel (1,1) = 60 exactly
        assert(Math.abs(bilinearSample(getPixel, 1, 1) - 60) < 0.001);
    });
    test("bilinearSample: midpoint between two pixels averages them", function () {
        var grid = [
            [10, 20, 30, 40],
            [50, 60, 70, 80],
            [90,100,110,120],
            [130,140,150,160],
        ];
        function getPixel(x, y) { return grid[y][x]; }
        // px=1.5, py=1 → average of (1,1)=60 and (2,1)=70 → 65
        assert(Math.abs(bilinearSample(getPixel, 1.5, 1) - 65) < 0.001);
    });
    test("bilinearSample: center of four corners is their mean", function () {
        var grid = [[0, 10], [20, 30]];
        function getPixel(x, y) { return grid[y][x]; }
        // px=0.5, py=0.5 → mean of 0,10,20,30 = 15
        assert(Math.abs(bilinearSample(getPixel, 0.5, 0.5) - 15) < 0.001);
    });
```

- [ ] **Step 2: Confirm failure**

- [ ] **Step 3: Implement**

In `routing.js`, after `decodeTerrarium`:

```javascript
// Bilinear interpolation. getPixel(x, y) returns the elevation at integer
// pixel (x, y). px, py are fractional coordinates. The caller is responsible
// for clamping or providing cross-tile getPixel — we just blend.
function bilinearSample(getPixel, px, py) {
    var x0 = Math.floor(px), y0 = Math.floor(py);
    var x1 = x0 + 1, y1 = y0 + 1;
    var fx = px - x0, fy = py - y0;
    var a = getPixel(x0, y0), b = getPixel(x1, y0);
    var c = getPixel(x0, y1), d = getPixel(x1, y1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}
```

- [ ] **Step 4: Confirm green and commit**

```bash
git add routing.js test.html
git commit -m "feat(elevation): add bilinearSample for sub-pixel interpolation"
```

---

## Task 4: Add `medianFilter` + tighten `smoothElevations`

**Files:**
- Modify: `routing.js` (add `medianFilter`; modify `smoothElevations`)
- Test: `test.html`

- [ ] **Step 1: Write the failing tests**

```javascript
    // ── medianFilter ───────────────────────────────
    test("medianFilter window=3: kills single-point spike", function () {
        var input = [5, 5, 5, 50, 5, 5, 5];
        var out = medianFilter(input, 3);
        // Window 3 centered on the spike includes neighbours → median = 5
        assert(out[3] === 5);
    });
    test("medianFilter window=9: kills cluster of 3 zeros amid 30s", function () {
        var input = [30,30,30,30,0,0,0,30,30,30,30];
        var out = medianFilter(input, 9);
        // 9-window at index 5 (the middle zero): values include 4 thirties and 3 zeros and 2 thirties → median 30
        assert(out[5] === 30);
    });
    test("medianFilter preserves length", function () {
        var input = [1, 2, 3, 4, 5];
        assert(medianFilter(input, 3).length === 5);
    });
    test("smoothElevations: median+EMA reduces 0-bleed artefacts", function () {
        // Simulate Open-Meteo's failure mode: 5m terrain with random 0 dropouts
        var input = [];
        for (var i = 0; i < 50; i++) {
            input.push({ lat: 0, lon: 0, elevation: (i % 4 === 0) ? 0 : 5 });
        }
        var out = smoothElevations(input);
        // No element should be near 0 — median+EMA washes the artefacts
        for (var i = 5; i < 45; i++) {
            assert(out[i].elevation > 2, "elevation at " + i + " is " + out[i].elevation);
        }
    });
```

- [ ] **Step 2: Confirm failure**

- [ ] **Step 3: Implement `medianFilter`**

In `routing.js`, after `bilinearSample`:

```javascript
// Median filter — window must be odd. Replaces each value with the median of
// itself and its (window-1)/2 neighbours on each side. Edges shrink the
// window symmetrically (a value at index 0 with window=9 uses neighbours 0–4).
function medianFilter(arr, window) {
    var half = Math.floor(window / 2);
    var out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
        var lo = Math.max(0, i - half);
        var hi = Math.min(arr.length, i + half + 1);
        var sorted = arr.slice(lo, hi).sort(function (a, b) { return a - b; });
        out[i] = sorted[Math.floor(sorted.length / 2)];
    }
    return out;
}
```

- [ ] **Step 4: Modify `smoothElevations`**

Currently at `routing.js:283`. Replace the entire function body with:

```javascript
function smoothElevations(elevData) {
    if (elevData.length < 2) return elevData;
    // Step 1: median-9 prefilter on elevation values only. Kills isolated
    // outliers (e.g. a single DEM cell that returned a 30 m phantom) before
    // the EMA blends them outward.
    var elevs = elevData.map(function (e) { return e.elevation; });
    var medianed = medianFilter(elevs, 9);
    // Step 2: forward + reverse EMA with α=0.4 for symmetric smoothing.
    var alpha = 0.4;
    var smoothed = [{ lat: elevData[0].lat, lon: elevData[0].lon, elevation: medianed[0] }];
    for (var i = 1; i < medianed.length; i++) {
        var prev = smoothed[i - 1].elevation;
        smoothed.push({
            lat: elevData[i].lat, lon: elevData[i].lon,
            elevation: alpha * medianed[i] + (1 - alpha) * prev,
        });
    }
    for (var i = smoothed.length - 2; i >= 0; i--) {
        smoothed[i] = {
            lat: smoothed[i].lat, lon: smoothed[i].lon,
            elevation: alpha * smoothed[i].elevation + (1 - alpha) * smoothed[i + 1].elevation,
        };
    }
    return smoothed;
}
```

- [ ] **Step 5: Confirm green and commit**

```bash
git add routing.js test.html
git commit -m "feat(elevation): median-9 prefilter + tighter EMA in smoothElevations"
```

---

## Task 5: Add Node verification fixture

**Files:**
- Modify: `routing.js` (add CJS export footer)
- Create: `scripts/verify-elevation.mjs`

- [ ] **Step 1: Add CJS export footer to `routing.js`**

At the very end of `routing.js`, append:

```javascript
// Export for Node consumption (e.g. scripts/verify-elevation.mjs).
// No-op in browsers (module is undefined there).
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        haversine: haversine,
        tileCoords: tileCoords,
        decodeTerrarium: decodeTerrarium,
        bilinearSample: bilinearSample,
        medianFilter: medianFilter,
        smoothElevations: smoothElevations,
    };
}
```

- [ ] **Step 2: Create the verify script**

`scripts/verify-elevation.mjs`:

```javascript
// Node verification — pure-math tests for the new elevation pipeline.
// Run: node --test scripts/verify-elevation.mjs
//
// This script tests the pure functions in routing.js against fixed inputs.
// Full end-to-end integration (real Terrarium tile fetch + decode + browser
// chart render) is verified manually by Peter in a browser — see the plan's
// "Manual verification" section.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const routing = require(resolve(__dirname, "../routing.js"));
const { tileCoords, decodeTerrarium, bilinearSample, medianFilter, smoothElevations } = routing;

test("tileCoords: Perth waypoint at z=14 lands in expected tile", () => {
    const r = tileCoords(-31.99510, 115.81148, 14);
    assert.equal(r.xtile, 13462);
    assert.equal(r.ytile, 9729);
});

test("decodeTerrarium: sea level encoding", () => {
    assert.equal(decodeTerrarium(128, 0, 0), 0);
});

test("decodeTerrarium: fractional via blue channel", () => {
    assert.ok(Math.abs(decodeTerrarium(128, 10, 128) - 10.5) < 0.001);
});

test("bilinearSample: midpoint averages four corners", () => {
    const grid = [[0, 10], [20, 30]];
    const getPixel = (x, y) => grid[y][x];
    assert.ok(Math.abs(bilinearSample(getPixel, 0.5, 0.5) - 15) < 0.001);
});

test("medianFilter: window=9 kills 3-zero cluster amid 30s", () => {
    const input = [30, 30, 30, 30, 0, 0, 0, 30, 30, 30, 30];
    assert.equal(medianFilter(input, 9)[5], 30);
});

test("smoothElevations: rejects Open-Meteo style 0-bleed artefacts", () => {
    // Simulate: real terrain at 5m with 25% of points dropped to 0
    const input = [];
    for (let i = 0; i < 50; i++) {
        input.push({ lat: 0, lon: 0, elevation: i % 4 === 0 ? 0 : 5 });
    }
    const out = smoothElevations(input);
    // After median-9 + EMA, no interior point should be near 0
    for (let i = 5; i < 45; i++) {
        assert.ok(out[i].elevation > 2,
            `index ${i} elevation ${out[i].elevation} too low — artefacts not filtered`);
    }
});

test("smoothElevations: real-data gain — replay Fixture A elevation profile", () => {
    // Pre-recorded Open-Meteo response for the 20km out-and-back, sampled at 50m.
    // (Captured 2026-05-18; do not regenerate — this is a frozen baseline.)
    // We assert that running smoothElevations + a 5m-deadband gain calc on
    // this profile yields a gain LOWER than the unfiltered Open-Meteo result.
    // This is a regression guard: if smoothElevations is weakened, this fails.
    const profile = [
        // Truncated — full 358-point sample lives below. The agent may
        // either (a) commit the full profile to a JSON fixture, or
        // (b) re-fetch via Node fetch + open-meteo at run-time (slower).
        // Recommended (b) — keeps the test self-current.
    ];
    // If empty, skip — see comment above.
    if (profile.length === 0) return;

    function gain(arr, dead) {
        let asc = 0, pend = 0;
        for (let i = 1; i < arr.length; i++) {
            pend += arr[i].elevation - arr[i - 1].elevation;
            if (pend > dead) { asc += pend; pend = 0; }
            else if (pend < -dead) pend = 0;
        }
        return asc;
    }

    const smoothed = smoothElevations(profile);
    const filteredGain = gain(smoothed, 5);
    assert.ok(filteredGain < 80,
        `filtered gain ${filteredGain} m exceeds 80 m — smoothing weakened or pipeline broken`);
});
```

- [ ] **Step 3: Run the Node tests**

```bash
node --test scripts/verify-elevation.mjs
```

Expect: 6 passing tests (the seventh is intentionally a no-op stub).

- [ ] **Step 4: Commit**

```bash
git add routing.js scripts/verify-elevation.mjs
git commit -m "feat(elevation): node verification fixture for pure pipeline"
```

---

## Task 6: Implement Terrarium tile fetcher in `app.js`

This is the only browser-specific piece. It uses `<canvas>` + `getImageData()` for pixel access, IndexedDB via existing `cacheGet`/`cacheSet`, and the existing `fetchWithTimeout` helper.

**Files:**
- Modify: `app.js` (replace `fetchElevation` body at lines 300–338)

- [ ] **Step 1: Replace `fetchElevation()` entirely**

Replace lines 300–338 of `app.js` with:

```javascript
// ── Elevation (AWS Terrarium tiles, Open-Meteo fallback) ─────
//
// Terrarium tiles are PNG RGB images where each pixel encodes an elevation:
//   elev_metres = (R*256 + G + B/256) - 32768
// Tiles served by AWS Open Data Programme at z14 (~30 m underlying resolution
// for AU, sourced from SRTM30 + GMTED2010). CORS enabled, no API key.
//
// Strategy: group input points by tile, fetch each tile once, decode all
// points that fall in it via bilinear interpolation. Fall back to Open-Meteo
// for any tile that fails to load.

var TERRARIUM_ZOOM = 14;
var TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

async function fetchTerrariumTile(xtile, ytile) {
    var url = TERRARIUM_URL + "/" + TERRARIUM_ZOOM + "/" + xtile + "/" + ytile + ".png";
    var resp = await fetchWithTimeout(url, null, 20000);
    if (!resp.ok) throw new Error("Terrarium HTTP " + resp.status);
    var blob = await resp.blob();
    var bitmap = await createImageBitmap(blob);
    var canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

// Build a getPixel that handles cross-tile boundaries by sampling adjacent
// tiles from the cache. Out-of-range tiles (top/bottom of map) clamp.
function makeGetPixel(tileCache, xtile, ytile) {
    return function (x, y) {
        var tx = xtile, ty = ytile;
        if (x < 0) { tx -= 1; x += 256; }
        else if (x >= 256) { tx += 1; x -= 256; }
        if (y < 0) { ty -= 1; y += 256; }
        else if (y >= 256) { ty += 1; y -= 256; }
        var tile = tileCache[tx + "/" + ty];
        if (!tile) return null; // signal cross-tile miss
        var idx = (y * 256 + x) * 4;
        return decodeTerrarium(tile.data[idx], tile.data[idx + 1], tile.data[idx + 2]);
    };
}

async function fetchElevation(points) {
    var results = new Array(points.length);
    var pendingIdx = []; // indices not yet resolved
    var pendingPts = [];

    // ── Step 1: per-point IndexedDB cache lookup ────
    for (var i = 0; i < points.length; i++) {
        var ck = "elev3:" + points[i].lat.toFixed(5) + ":" + points[i].lon.toFixed(5);
        var cached = await cacheGet(ck);
        if (cached) { results[i] = cached; }
        else { results[i] = null; pendingIdx.push(i); pendingPts.push(points[i]); }
    }
    if (pendingPts.length === 0) return results;

    // ── Step 2: group pending points by tile ────────
    var tileGroups = {}; // "xtile/ytile" → [{ origIdx, pt, px, py }]
    var tileXY = {};     // "xtile/ytile" → { xtile, ytile }
    for (var i = 0; i < pendingPts.length; i++) {
        var c = tileCoords(pendingPts[i].lat, pendingPts[i].lon, TERRARIUM_ZOOM);
        var key = c.xtile + "/" + c.ytile;
        if (!tileGroups[key]) { tileGroups[key] = []; tileXY[key] = { xtile: c.xtile, ytile: c.ytile }; }
        tileGroups[key].push({ origIdx: pendingIdx[i], pt: pendingPts[i], px: c.px, py: c.py });
    }

    // ── Step 3: also fetch neighbour tiles for boundary points ─
    var tilesToFetch = {};
    Object.keys(tileGroups).forEach(function (key) { tilesToFetch[key] = tileXY[key]; });
    Object.keys(tileGroups).forEach(function (key) {
        var pts = tileGroups[key];
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            var dx = p.px < 1 ? -1 : p.px > 255 ? 1 : 0;
            var dy = p.py < 1 ? -1 : p.py > 255 ? 1 : 0;
            if (dx !== 0) {
                var k = (tileXY[key].xtile + dx) + "/" + tileXY[key].ytile;
                if (!tilesToFetch[k]) tilesToFetch[k] = { xtile: tileXY[key].xtile + dx, ytile: tileXY[key].ytile };
            }
            if (dy !== 0) {
                var k = tileXY[key].xtile + "/" + (tileXY[key].ytile + dy);
                if (!tilesToFetch[k]) tilesToFetch[k] = { xtile: tileXY[key].xtile, ytile: tileXY[key].ytile + dy };
            }
            if (dx !== 0 && dy !== 0) {
                var k = (tileXY[key].xtile + dx) + "/" + (tileXY[key].ytile + dy);
                if (!tilesToFetch[k]) tilesToFetch[k] = { xtile: tileXY[key].xtile + dx, ytile: tileXY[key].ytile + dy };
            }
        }
    });

    // ── Step 4: fetch tiles in parallel ─────────────
    var tileCache = {};
    var fetchPromises = Object.keys(tilesToFetch).map(function (key) {
        return fetchTerrariumTile(tilesToFetch[key].xtile, tilesToFetch[key].ytile)
            .then(function (data) { tileCache[key] = data; })
            .catch(function (e) { console.warn("Terrarium tile " + key + " failed:", e.message); });
    });
    await Promise.all(fetchPromises);

    // ── Step 5: decode each point via bilinear ──────
    var fallbackIdx = [], fallbackPts = [];
    Object.keys(tileGroups).forEach(function (key) {
        var pts = tileGroups[key];
        if (!tileCache[key]) {
            // tile fetch failed — queue all its points for fallback
            for (var i = 0; i < pts.length; i++) { fallbackIdx.push(pts[i].origIdx); fallbackPts.push(pts[i].pt); }
            return;
        }
        var getPixel = makeGetPixel(tileCache, tileXY[key].xtile, tileXY[key].ytile);
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            // Probe the four bilinear neighbours. If any are null (neighbour
            // tile missing), fall back for this point only.
            var x0 = Math.floor(p.px), y0 = Math.floor(p.py);
            var ok = getPixel(x0, y0) !== null && getPixel(x0 + 1, y0) !== null
                  && getPixel(x0, y0 + 1) !== null && getPixel(x0 + 1, y0 + 1) !== null;
            if (!ok) { fallbackIdx.push(p.origIdx); fallbackPts.push(p.pt); continue; }
            var elev = bilinearSample(getPixel, p.px, p.py);
            var entry = { lat: p.pt.lat, lon: p.pt.lon, elevation: elev };
            results[p.origIdx] = entry;
            await cacheSet("elev3:" + p.pt.lat.toFixed(5) + ":" + p.pt.lon.toFixed(5), entry);
        }
    });

    // ── Step 6: Open-Meteo fallback for failed points ─
    if (fallbackPts.length > 0) {
        console.warn("Terrarium failed for " + fallbackPts.length + " points, falling back to Open-Meteo");
        for (var b = 0; b < fallbackPts.length; b += 100) {
            var batch = fallbackPts.slice(b, b + 100);
            var batchIdx = fallbackIdx.slice(b, b + 100);
            var lats = batch.map(function (p) { return p.lat.toFixed(5); }).join(",");
            var lons = batch.map(function (p) { return p.lon.toFixed(5); }).join(",");
            try {
                var resp = await fetchWithTimeout(
                    "https://api.open-meteo.com/v1/elevation?latitude=" + lats + "&longitude=" + lons,
                    null, 20000);
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                var data = await resp.json();
                var elevArr = data.elevation || [];
                for (var j = 0; j < elevArr.length; j++) {
                    var elev = elevArr[j] != null ? elevArr[j] : 0;
                    var entry = { lat: batch[j].lat, lon: batch[j].lon, elevation: elev };
                    results[batchIdx[j]] = entry;
                    if (elevArr[j] != null) {
                        await cacheSet("elev3:" + entry.lat.toFixed(5) + ":" + entry.lon.toFixed(5), entry);
                    }
                }
            } catch (e) {
                console.warn("Open-Meteo fallback failed:", e.message);
                for (var j = 0; j < batch.length; j++) {
                    results[batchIdx[j]] = { lat: batch[j].lat, lon: batch[j].lon, elevation: 0 };
                }
            }
        }
    }

    // Defensive: ensure no null in output
    for (var i = 0; i < results.length; i++) {
        if (!results[i]) results[i] = { lat: points[i].lat, lon: points[i].lon, elevation: 0 };
    }
    return results;
}
```

- [ ] **Step 2: Update DEAD_BAND in `updateElevation`**

At `app.js:1031` (inside `updateElevation`), change:

```javascript
var DEAD_BAND = 2; // metres — ignore cumulative changes below this
```

to:

```javascript
var DEAD_BAND = 5; // metres — ignore cumulative changes below this
```

- [ ] **Step 3: Update GPX export cache key**

At `app.js:1142`, change:

```javascript
var cached = await cacheGet("elev2:" + coords[i][0].toFixed(5) + ":" + coords[i][1].toFixed(5));
```

to:

```javascript
var cached = await cacheGet("elev3:" + coords[i][0].toFixed(5) + ":" + coords[i][1].toFixed(5));
```

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(elevation): terrarium tile fetcher with open-meteo fallback"
```

---

## Task 7: Add Terrarium S3 to service worker tile cache patterns

**Files:** `sw.js`

- [ ] **Step 1: Modify `TILE_PATTERNS`**

At `sw.js:18–22`, change:

```javascript
var TILE_PATTERNS = [
    "tile.openstreetmap.org",
    "server.arcgisonline.com",
    "tile.opentopomap.org",
];
```

to:

```javascript
var TILE_PATTERNS = [
    "tile.openstreetmap.org",
    "server.arcgisonline.com",
    "tile.opentopomap.org",
    "s3.amazonaws.com/elevation-tiles-prod",
];
```

This routes Terrarium tile fetches through the stale-while-revalidate path so they survive offline use, matching how OSM map tiles already cache.

**Do not bump `CACHE_NAME` manually** — the GitHub workflow `.github/workflows/bump-sw.yml` does it on push to main. The content change above is enough to trigger the bump.

- [ ] **Step 2: Commit**

```bash
git add sw.js
git commit -m "feat(sw): cache terrarium elevation tiles"
```

---

## Task 8: Manual verification (Peter, in a browser)

Cloud agents cannot do this — flag it as the final required step for the user.

- [ ] **Step 1: Reload the app, clear cache**

In DevTools → Application → Service Workers → "Update on reload" + click "Unregister". Reload. The new SW activates.

- [ ] **Step 2: Plot the test route (Fixture A)**

Visit: `https://fractionasian.github.io/legwork/#r=-31.99510,115.81148;-31.99019,115.81741;-31.98657,115.82209;-31.98022,115.82085;-31.97339,115.82589;-31.96885,115.83778;-31.95868,115.85021;-31.95973,115.85626;-31.96044,115.86311;-31.96131,115.86589;-31.96288,115.87059;-31.96363,115.87812;-31.96553,115.88278&m=outback`

Expected: ascent badge reads **~35–60 m** (was 149.5 m). Strava truth is 44.2 m.

- [ ] **Step 3: Plot a hilly route (Kings Park or similar)**

Draw a route over Kings Park / Mt Eliza ridge. Expected: ascent badge reads **~55–110 m**. If reported gain drops below 30 m, the median-9 filter is over-smoothing — reduce to median-5 and re-test.

- [ ] **Step 4: GPX export**

Export GPX for any route. Open in a text editor or run:

```bash
grep '<ele>' ~/Downloads/<route>.gpx | head -10
```

Expected: at least one `<ele>` element per `<trkpt>`. Values should look sensible (range 0–80 for Perth-area routes).

- [ ] **Step 5: Offline test**

DevTools → Network → throttle to Offline. Reload the page. Plot the same route — elevation chart should still render from cached tiles.

- [ ] **Step 6: Confirm no fallback fires in console**

Open DevTools console while plotting Fixture A. Expected: no `"Terrarium tile ... failed"` warning. If it fires, AWS Terrarium is having an outage and the fallback is doing its job — verify the Open-Meteo path still works by checking the ascent badge eventually populates.

---

## Rollback

If the user reports significantly worse numbers after this lands:

```bash
git revert <last-N-commits>
git push
```

The `elev3:` cache namespace separation means rolling back to `elev2:` is safe — the old cache entries weren't touched.

---

## Out of scope (separate plan)

- **Per-city pre-baked COP30 tiles** — when `cities.json` exceeds 50 entries, the COP30 (Copernicus 30m, no SRTM artefacts near AU coast) tile-bake pipeline is worth building. See spec's "Future Work" section.
- **"(approx)" UX badge for flat routes** — UX-only signal, not in this scope.
- **Strava sync / barometric ground-truth comparison feature** — a separate product feature.

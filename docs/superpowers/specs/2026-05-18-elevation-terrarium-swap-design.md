# Elevation Source Swap — Design Spec

**Date:** 2026-05-18
**Status:** Approved, ready to execute
**App:** [Legwork](https://github.com/fractionasian/legwork)

---

## Problem

Legwork's reported elevation gain is ~3× the true value on flat coastal routes. Verified against Strava activity 18536502294 (17 May 2026, Apple Watch barometer, 19.5 km along the Swan River from Mosman Park to Subiaco and back):

- Strava true gain: **44.2 m** (range 2.6–10.2 m, median 4.0 m)
- Legwork current calc: **149.5 m**

Root cause is the current elevation source, Open-Meteo (`api.open-meteo.com/v1/elevation`). For this route it returns `0.0 m` at 29% of sampled points — sprinkled through inland Perth suburbs where reality is 3–6 m. These spurious zeros generate phantom 14→0→14 m climbs that the dead-band filter can't catch.

Algorithmic mitigation alone (heavier smoothing, larger dead-band) reduces the error but cannot eliminate it because the median filter has too many zeros to median against. Source replacement is required.

---

## Decision

Replace Open-Meteo with **AWS Terrarium tiles** as the primary elevation source. Keep Open-Meteo as a network fallback.

### Why Terrarium

| Property | Open-Meteo (current) | AWS Terrarium (new) |
|---|---|---|
| Auth / API key | None | None |
| CORS | ✅ | ✅ (preflight verified) |
| AU underlying data | Copernicus DEM 90m, with spurious 0m near water | SRTM30 + GMTED2010 (same noise floor, but no 0m artefacts) |
| Per-route bytes | ~5 KB | ~500 KB (6× z14 tiles, one-time, cached) |
| Offline | No | Yes (tiles cache like map tiles) |
| Architecture fit | API call from browser | Tile fetch — same pattern as OSM tiles already cached |
| Service status | Active | Frozen since 2017 (Mapzen shutdown), but data is sponsored long-term by AWS Open Data |

### Why not the other options surveyed

- **OpenTopoData (SRTM30m, ASTER30m):** Same signal as Terrarium, less convenient (rate-limited point-query API).
- **OpenTopography Point Query:** Free key required. Browser-visible key is leakable and abuseable.
- **Maptiler Terrain-RGB:** Paid above free tier; same key-leak issue.
- **Geoscience Australia DEM REST:** Old endpoint decommissioned 2025; no replacement public point-query service.
- **FSDF ELVIS / Landgate SLIP:** AU 1m LIDAR exists in these portals but only as bulk GeoTIFF downloads — no public point-query API.
- **Self-hosted COP30 pre-baked tiles:** Best long-term option; deferred — see Future Work.

### Why the 30m noise floor doesn't matter as much with Terrarium

Open-Meteo's failure mode is *artefacts* (0m bleed). Terrarium's failure mode is *noise* (the real 30m DEM signal has ±5–10m vertical noise on flat terrain). Noise is *median-filterable*; artefacts are not, because they cluster.

Verified on the test route with median-9 + EMA α=0.4 + 5m dead-band:
- Open-Meteo + this filter: 63.2 m gain (still 1.4× truth)
- Terrarium + this filter: **45.0 m gain (matches truth ±2%)**

---

## Algorithm

### Tile-space lookup

Standard slippy-map XYZ at zoom **14** (default). For each query point at `(lat, lon)`:

```
n     = 2^z
x     = (lon + 180) / 360 * n
y     = (1 - ln(tan(lat) + 1/cos(lat)) / π) / 2 * n
xtile = floor(x);  ytile = floor(y)
px    = (x - xtile) * 256;  py = (y - ytile) * 256
```

Tile URL: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{xtile}/{ytile}.png`

### Decoding

PNG is 256×256 RGB. For each pixel:

```
elev_metres = (R * 256 + G + B / 256) - 32768
```

### Bilinear interpolation

For each query point's `(px, py)` (fractional), sample the four surrounding integer pixels and bilinearly blend.

### Cross-tile boundary

A point landing within 1 px of `(0, 0)`, `(255, *)`, or `(*, 255)` has neighbouring pixels in adjacent tiles. Fetch the neighbour tile(s) and bilinear across the seam. **This is the most likely place for off-by-one bugs.**

### Tile grouping (batching)

Group input points by `(xtile, ytile)`, fetch each unique tile once, decode all its points. Network-bound, not CPU-bound.

### Filter

Pipeline applied in `updateElevation()`:

1. **Median-9 prefilter** (NEW) — replace each elevation with the median of itself ± 4 neighbours. Kills isolated outliers that survive bilinear.
2. **EMA forward + reverse** (existing in `smoothElevations`, `routing.js:283`) — change α from **0.6 → 0.4** for more aggressive smoothing.
3. **Dead-band cumulative gain** — change threshold from **2 m → 5 m**.

### Fallback chain

```
Terrarium tile fetch fails (network/CORS/404)
  → fall back to Open-Meteo for the affected points
  → if Open-Meteo also fails → elevation = 0, log warning (current behaviour)
```

---

## File touch points

| File | Change |
|---|---|
| `app.js:300–338` | Replace `fetchElevation()` — same input/output shape, new internals |
| `app.js:1142` | Update GPX export cache key namespace `elev2:` → `elev3:` |
| `app.js:1031` | `DEAD_BAND` 2 → 5 |
| `routing.js:283–296` | Add median-9 prefilter inside `smoothElevations`; α 0.6 → 0.4 |
| `sw.js:18–22` | Add `"s3.amazonaws.com/elevation-tiles-prod"` to `TILE_PATTERNS` |
| `scripts/verify-elevation.mjs` | NEW — node-runnable ground-truth fixture |
| `test.html` | NEW assertions for tile-coord math, decode formula, median filter |

**Do not bump `CACHE_NAME` manually** — `.github/workflows/bump-sw.yml` does it on push to main. Just changing `sw.js` content causes a hash bump.

---

## I/O contract — `fetchElevation()` must not change shape

**Input:** array of `{lat: number, lon: number}` (any length)
**Output:** array of `{lat: number, lon: number, elevation: number}` of same length, same order, no nulls. Missing data → `elevation: 0`.

This is used by:
- `fetchRouteElevation()` → `updateElevation()` (the chart + stats)
- GPX export path via the `elev2:` IndexedDB cache (becoming `elev3:`)
- `state.lastElevationData` (referenced by `colourRouteByGradient` and GPX export)

---

## Verification

### Automated (the cloud agent runs this)

`scripts/verify-elevation.mjs` — embeds the 20km test waypoints + a hilly second route, fetches real Terrarium tiles, runs the new pipeline, asserts:

- Flat coastal test route ascent ∈ **[35, 60] m** (Strava truth 44.2 m)
- Hilly Kings Park test route ascent ∈ **[55, 110] m** (target ~80 m — Mt Eliza ridge is ~60 m above the river)
- Decode formula: tile pixel `(R, G, B) = (128, 32, 0)` → elevation `0.0 m` (sanity)
- Bilinear at integer pixel matches raw decode (within 0.001 m)
- Cross-tile boundary: a point at exactly `px=255.5` on one tile equals `px=0.5` on the next within 0.01 m

### Manual (Peter runs this after merge)

1. Load 3 saved Perth routes; confirm gain numbers are 30–70% lower than before
2. GPX export from one route, open in a viewer (or `grep '<ele>' file.gpx`); confirm `<ele>` tags present and reasonable
3. Service worker test: load app, go offline (DevTools → Network → Offline), load a known-cached route, confirm elevation chart renders

---

## Risk: hilly-route over-smoothing

The new filter chain (median-9 + α 0.4 + dead-band 5m) is more aggressive than current. On routes with real hills (e.g. Kings Park, Reabold Hill), it could under-report gain.

**Mitigation:** the verification fixture includes a hilly Kings Park route with an expected range. If that test fails, the agent should dial back to median-5 + α 0.5 + dead-band 5m and re-test both fixtures. The flat-route number may rise to ~55 m, which is still acceptable.

---

## Out of scope

- Pre-baking COP30 tiles per city — separate ADR
- Per-city LIDAR self-hosting — only worth doing when `cities.json` > 50 entries
- "Approx" UX disclaimer on flat routes — UX improvement, not a fix
- Strava sync for post-run "did this route match the plan?" comparison — separate feature

---

## Future work — COP30 self-baked tiles

When `cities.json` grows past ~50 entries, consider pre-baking Copernicus DEM 30m → terrarium-format PNG tiles per supported city:

- AWS `copernicus-dem-30m` bucket, no auth, 1°×1° GeoTIFFs (~20 MB each)
- GDAL pipeline: `gdal_translate` + `gdal2tiles.py` with custom RGB encoding
- Ship as `data/tiles/elevation/{city}/{z}/{x}/{y}.png` alongside OSM tiles
- ~5–20 MB per city after compression; one-time bake per city
- Highest quality for AU (COP30 > SRTM near coasts), fully offline-capable

Track separately. Not part of this swap.

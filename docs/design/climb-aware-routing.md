# Climb-aware routing

Status: **built, off by default.** Perth tiles carry heights; the router charges
for climbing only when the page is opened with `?climb=8`.

## What it does

A hidden preference, like the road-type weights in `route-preferences.md`: when
two routes are close in length, take the one with less climbing. There is no
slider and nothing to explain to the user. A route may be a few percent longer
and a lot flatter; it never gets longer just to shave a metre of climb.

Cost of an edge = existing weighted length + `CLIMB_WEIGHT` × metres climbed
(uphill only, downhill is free). `CLIMB_WEIGHT = 8` means one metre of climb
costs as much as 8 m of flat walking — Naismith's rule for walking, and a
plateau: weights 5 and 10 gave almost the same routes.

## How it works

1. `scripts/elevation.js` fetches Terrarium z14 tiles (the same source and zoom as
   the elevation panel, so what the app shows and what the router avoids agree),
   stitches and smooths them (Gaussian, 40 m), and returns a height for any point.
2. `scripts/build-tiles.js` writes one height per vertex into each way as a 7th
   field (decimetres, delta-coded). Only cities with `"elevation": true` in
   `data/cities.json` get it — currently Perth. Elevation failure never fails the
   build: the city ships without heights and routes as before.
3. `routing.js` decodes the field (`decodeElevations`); `applyPaths` in `tiles.js`
   adds `climbCosts()` to each edge. Tiles without heights (other cities, the
   live-Overpass fallback, tiles cached before the rebuild) route as before.
4. Old app versions ignore the 7th field, so tiles can ship before the app does.

The A* heuristic stays admissible: climb cost is added on top and is never
negative. `test/climb.test.mjs` checks A* against plain Dijkstra with climb on.

## Why 40 m smoothing

Raw heights jitter by a metre or two between neighbouring vertices. Summed per
edge that jitter is "climb" the router chases: at 20 m smoothing, CBD → Kings Park
summed to 164 m of per-edge climb where the app's own panel reports 67 m, and at
a higher weight (16) flat routes started drifting slightly worse. Comparing five
variants on 12 Perth routes at weight 8, smoothing to 40 m saved 44 m of climb
across the four hill routes (20 m smoothing: 27 m), with no route made worse by
more than 3 m. A per-edge "ignore slopes under 1–2%" floor saved 31 m, barely
better than none, so it isn't used.

## What it bought (Perth, 11 routes, weight 8, run profile)

Measured by the app's own ascent calculation (5 m dead-band) on the unsmoothed
raster, not the numbers the router optimised, through the real tile pipeline.

| Route | Ascent | Distance |
|---|---|---|
| Cottesloe → CBD | 80 → 59 m | +3.9% |
| Scarborough → CBD | 101 → 79 m | +0.2% |
| CBD → Kings Park | 67 → 63 m | +0.5% |
| 8 other routes (flat suburbs, Fremantle legs, Applecross, Scarborough → Fremantle) | within ±2 m | ≤ +0.1% |

Perth is mostly flat, so most routes don't change. Expect more from Hobart,
Sydney, Seoul (none measured). A forced climb stays forced: in an earlier run the
Maida Vale scarp route (+219 m) moved by 1 m.

## Costs

- **Tile size:** Perth's 46 tiles went 6.8 → 8.3 MB gzipped (+22%), 34.7 → 38.8 MB
  raw. About 33 KB gzipped per tile on average; the first load (4 central, denser
  tiles) is ~130 KB heavier or more.
- **Search time:** about +5% (module-scope measurement) to +20% (vm sandbox,
  which is ~2× slower overall) across the test routes. Worst long leg
  (20 km): +5–110 ms on a server CPU. Not measured on a phone.
- **Build:** Perth sampler 17 s and at least ~380 MB of RAM (two float buffers);
  encoding 5 s. Perth is the largest city, so the others are cheaper.

## Testing it

Automated: `npm test` (`test/climb.test.mjs`, `test/elevation.test.mjs`).

By hand, after the new tiles are live (the flag does nothing until Perth tiles
carry heights — run the **Build City Tiles** workflow in `legwork-tiles`, or
wait for Sunday's schedule):

1. Open `legwork.day/?climb=8` and `legwork.day/` in two tabs.
2. In each, plan the same route and compare the ascent in the elevation panel:
   Cottesloe beach → Elizabeth Quay (about 80 m → 59 m), Scarborough →
   Elizabeth Quay (about 101 m → 79 m). Pins land a few metres differently, so
   expect ±5 m.
3. Look at the line itself. The flatter route should look like something a
   local would run, not a zig-zag.
4. Plan something flat (Victoria Park → CBD). It should look identical.

## To turn it on for everyone

Change `var CLIMB_WEIGHT = 0` to `8` in `routing.js` and make `?climb=0` the
off-switch (it already is: `setClimbWeight(0)`). One line plus a test update.

## Known gaps

- Heavy smoothing flattens short steep ramps, so they are under-weighted.
  Untested.
- No steepness penalty: a route can still contain a 20% pitch if it saves climb
  overall. Flatten SF has a separate steepness term for this.
- The bike profile uses the same weight. It wasn't re-measured at the final
  settings; at 20 m smoothing its effect was smaller (Fremantle → CBD −16 m,
  most other routes unchanged).
- Other cities are off until someone adds `"elevation": true` and checks the result.

## Not done: packed graph

Measured separately: a packed (typed-array) graph searches 4–12× faster, loads a
whole city in ~0.2 s instead of ~9 s, uses ~10× less memory, and could download
at about half today's size. It also needs a tile-border stitching design and
carries no street names. Parked until phone measurements show where it's slow.

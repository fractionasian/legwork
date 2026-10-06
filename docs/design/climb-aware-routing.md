# Climb-aware routing

Status: **built, on by default** (climb 8, turn 15; switched on 2026-10-06 after a
phone test). Perth tiles carry heights. `?climb=0` and `?turn=0` switch either off
for comparison; other cities have no heights yet, so climb changes nothing there.

## What it does

A hidden preference, like the road-type weights in `route-preferences.md`: when
two routes are close in length, take the one with less climbing. There is no
slider and nothing to explain to the user. A route may be a few percent longer
and a lot flatter; it never gets longer just to shave a metre of climb.

Cost of an edge = existing weighted length + `CLIMB_WEIGHT` × metres climbed
(uphill only, downhill is free).

**Reading the number.** The weight multiplies the router's own smoothed climb,
which has no dead-band and so sums 1.6–4.4× the ascent the app displays (CBD →
Kings Park 110 m vs 67 m, Cottesloe → CBD 168 vs 80, Fremantle → CBD 230 vs 77).
So weight 8 acts like roughly 17–25 weighted metres per *displayed* metre.
Naismith's rule (W. W. Naismith, 1892: 1 hour per 5 km plus 1 hour per 600 m of
ascent, so one metre of climb ≈ 8 m of flat; Scarf's form uses 7.92) corresponds
to about **4** in the router's units, not 8.

**Choosing it.** On fixed start/end routes, weights 4–12 give nearly the same
routes (Cottesloe flips at any weight from 1; Scarborough at 4). On 120 random
pin sets in central Perth (below), weight 4 kept about 60% of weight 8's
ascent saving (12.3 of 19.5 m, summed over the five route types) for about a third of the extra distance (0.6 vs 1.9 percentage points), and made fewer routes worse.
The default is still 0 (off). With the turn cost on (below), 8 is the better pairing:
at climb 4 + turn 15 Scarborough → CBD loses its whole climb saving (100 m vs 79 m),
at climb 8 + turn 15 it keeps it (75 m).

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

## With pins and loops

The app routes each leg between consecutive pins separately (and closes a loop
back to the first pin), so the router only chooses *between* pins. Pins placed on
the shortest line remove the choice. 120 random routes in central Perth, 24 per
type, through the real app code, mean change in displayed ascent / distance:

| Route type (mean length, mean ascent) | Weight 4 | Weight 8 |
|---|---|---|
| open, 2 pins (4.9 km, 23 m) | −1.0 m / 0.0% | −0.8 m / +0.2% |
| open, 3 pins (10.6 km, 41 m) | −1.3 m / +0.3% | −3.1 m / +0.6% |
| open, 4 pins (16.2 km, 68 m) | −2.1 m / 0.0% | −3.0 m / +0.1% |
| loop, 3 pins (18.1 km, 68 m) | −5.2 m / +0.3% | −8.3 m / +0.6% |
| loop, 4 pins (21.0 km, 100 m) | −2.7 m / +0.1% | −4.3 m / +0.3% |

The average effect is small and lumpy: a few routes improve by 10–38 m and most
barely move. Some routes show *more* ascent in the app's panel (≥3 m worse on 0–3
of 24 at weight 4, 1–6 of 24 at weight 8), because the router optimises its own
smoothed climb, not the displayed figure. A dead-band at bake time (as Flatten
SF does) would narrow that gap; not done.

## The trade-off per route

Some pairs have only two real choices, so no weight gives a smaller detour.
Cottesloe → CBD is 11,944 m / 80 m ascent or 12,414 m / 59 m at every weight
from 1 to 20 (22 m of extra distance per metre of climb saved). Scarborough →
CBD is cheap (+34 m for 22 m less climb, from weight 4). Fremantle → CBD only
flips at weight 16+, at 37–41 m per metre saved; weight 8 correctly declines it.
The knob that would cap a detour directly (reject a flatter route more than N%
longer than the shortest) needs a second search per leg; not built.

## Turn cost

A second hidden preference: `?turn=15` charges 15 weighted metres for each change of
direction of 35° or more at a junction (`TURN_COST` in `routing.js`; capped at 100).

**Why.** Between two diagonal points a street grid has hundreds of equally short
staircase routes and a plain shortest-path search picks one arbitrarily (Scarborough →
Elizabeth Quay ends in one, with the climb weight off). Climb-aware routing makes it
worse: the flatter corridors run along side streets, and over the seven test routes
kinks went from 193 to 214 (+11%). A small cost per turn wins that back.

**Why soft, not a minimum run.** Some routes have no straight run over ~100 m to
offer (block-by-block CBD), so a hard minimum would leave them unroutable. A "short
legs cost extra" variant was also tested and was no better than a flat cost per turn
(more distance, more ascent).

**How.** The cost depends on the way you arrived, so the search state is the
directed edge, not the node (`dijkstraTurns`): about twice the states. Edges carry a
heading and scratch fields only while the turn cost is on. Checked against an
independent edge-state Dijkstra in `test/turns.test.mjs`.

**What it did (7 Perth routes, real app code and tiles):**

| | Kinks | Total ascent | Distance | Scarborough → CBD |
|---|---|---|---|---|
| Today | 193 | 440 m | 83.2 km | 101 m, 14,017 m |
| Climb 8 | 214 | 392 m | 83.8 km | 79 m, 14,050 m |
| Climb 8 + turn 15 | 185 | 381 m | 84.6 km | 75 m, 14,101 m |

A kink is a heading change over 35° between legs of at least 15 m.

**What it did not do, measurably.** Two whole-route measures that try to capture
"does it hold a line" show no difference between the three settings: sustained
direction changes (heading toward the point 200 m ahead moves more than 45° and stays
there) 29 / 27 / 32, and sideways wobble from a smoothed copy of the route 12.2 / 12.2 /
12.3 m. On the last 2.5 km of Scarborough → CBD wobble is 18 / 22 / 22 m, so it did
not fall there either. The visible gain is local: with climb 8 + turn 15 the final
approach becomes a near-straight diagonal with small jogs instead of a staircase, which
reads as one line to a runner even though the jogs still count as kinks. No
measure here captures that, so it has to be judged by eye on real routes.

**Settings tried (climb weight 4, 7 routes).** 10 per turn is too gentle to clear the
Scarborough staircase; 20+ cleans it up fully but is the hillier corridor and gives the
climb saving back (101 m) at climb 8. 15 sits between.

## Costs

The routing graph is now a packed (typed-array) graph; see below. These are the numbers
for the code as it stands, measured on all 46 Perth tiles through the app's own scripts
in a browser-like global context (one fresh process per setting; the older figures that
came from a `vm` sandbox were roughly 2× too pessimistic on speed).

| 46 Perth tiles | Before (object graph) | Now (packed) |
|---|---|---|
| Load all tiles, settings off | 12.1 s | 1.3 s |
| Memory, settings off | 812 MB | 286 MB |
| Memory, climb 8 + turn 15 | 981 MB | 315 MB |
| 11 routes, settings off | 966 ms | 106 ms |
| 11 routes, climb 8 | 985 ms | 123 ms |
| 11 routes, climb 8 + turn 15 | 1,065 ms | 335 ms |
| First load (4 central tiles): time, memory | 0.63 s, 103 MB | 0.19 s, 39 MB |

Memory counts typed-array buffers. Not measured on a phone.

- **Tile size:** Perth's 46 tiles went 6.8 → 8.3 MB gzipped (+22%), 34.7 → 38.8 MB
  raw. About 33 KB gzipped per tile on average; the first load (4 central, denser
  tiles) is ~130 KB heavier or more.
- **Search time, turn cost:** about 2.7× the climb-only search on the packed graph
  (335 vs 123 ms over the 11 routes): it searches directed edges, about twice the
  states. Every pin drag re-routes two legs. If it ever bites, route with the plain
  search while dragging and refine on release.
- **Heights in the tiles** add about 24 MB of memory for all 46 tiles (+3%).
- **Build:** Perth sampler 17 s and at least ~380 MB of RAM (two float buffers);
  encoding 5 s. Perth is the largest city, so the others are cheaper.

## Testing it

Automated: `npm test` (`test/climb.test.mjs`, `test/elevation.test.mjs`,
`test/turns.test.mjs`, `test/packed-graph.test.mjs`).

By hand, after the new tiles are live (the flag does nothing until Perth tiles
carry heights — run the **Build City Tiles** workflow in `legwork-tiles`, or
wait for Sunday's schedule):

1. Open `legwork.day/?climb=8` and `legwork.day/` in two tabs.
2. In each (try `?climb=4`, `?climb=8` and `?climb=8&turn=15` as well), plan the same
   route and compare the ascent in the elevation panel. The app starts in loop mode,
   so the panel includes the way back; the one-way figures are about half. Real-browser
   run, default → `?climb=8&turn=15`: Cottesloe beach → Elizabeth Quay 23.9 km, 162 m →
   24.9 km, 120 m; Scarborough → Elizabeth Quay 28.0 km, 187 m → 28.2 km, 165 m. Pins
   land a few metres differently, so expect ±5 m.
3. Look at the line itself. The flatter route should look like something a
   local would run, not a zig-zag. Scarborough → Elizabeth Quay is the one to check
   for the turn cost: its last stretch should be a near-straight diagonal with
   `turn=15` (one way: 14,101 m and 75 m with `climb=8&turn=15`; 14,017 m and 101 m today).
4. Plan something flat (Victoria Park → CBD). It should look identical.

## Defaults

`CLIMB_WEIGHT = 8` and `TURN_COST = 15` in `routing.js`. `?climb=0` and `?turn=0`
are the off-switches, handy for comparing a route with and without.

## Known gaps

- Heavy smoothing flattens short steep ramps, so they are under-weighted.
  Untested.
- No steepness penalty: a route can still contain a 20% pitch if it saves climb
  overall. Flatten SF has a separate steepness term for this.
- The bike profile uses the same weight. It wasn't re-measured at the final
  settings; at 20 m smoothing its effect was smaller (Fremantle → CBD −16 m,
  most other routes unchanged).
- The packed graph is on for everyone once merged (there is no switch back to the
  old structure). Costs and routes were checked identical to the old code on real
  tiles and in a real browser, but not on a phone.
- Other cities are off until someone adds `"elevation": true` and checks the result.
- The turn cost is not applied at a pin: each leg between pins is routed alone, so a
  corner exactly at a pin is free.
- Turn costs use the straight edge-to-edge heading, so a gentle curve made of many
  small bends is not charged and a sharp corner split across two vertices can slip
  under the 35° threshold. Fine for city grids; untested on trail networks.

## Packed graph

The routing graph (`PackedGraph` in `routing.js`) is typed arrays instead of an object
of arrays of objects keyed by `"lat,lon"` strings. Tiles still arrive one at a time:
nodes are found by coordinate in an open-addressing hash, so a node shared with a
neighbouring tile simply gains edges, and edge lists are linked lists so they can grow.
The download is unchanged (still the JSON tiles; no tile rebuild is needed for it).

- **Keys stay strings at the edges.** Waypoints and saved routes store `"lat,lon"`
  keys; the graph converts to and from them only at the API (`indexOf`, `keyOf`), so
  saved routes keep working. Integer microdegrees are rounded exactly as `nodeKey`'s
  `toFixed(6)` rounds.
- **Costs.** Each edge stores its weighted length and its raw rise in metres; the climb
  weight and the turn cost are applied at search time, so they are read live and never
  baked into edges.
- **Result.** Identical routes: over 11 Perth routes × 3 settings the worst difference
  in cost against the old code was 3×10⁻¹⁵ and all 33 routes had the same length. Plus
  a real-browser run (headless Chromium, the app's own scripts, fake network): default
  and `?climb=8&turn=15`, 2 and 3 pins, run → bike → run, no console errors.
- **One behavioural difference.** Nearest-node lookup cells are assigned by one integer
  formula for nodes and queries. The old string-keyed grid could drop a node sitting
  exactly on a cell boundary into the next cell (float fuzz); the new one doesn't.
- **What is left in memory.** About 185 MB of the 286 MB is the tile features kept for
  drawing the map and for rebuilding the graph when the profile changes. That is the next
  target if memory matters.
- **Not done:** a packed tile format on the server (about half the download, needs
  border stitching and a rebuild); testing on a phone; the live Overpass fallback path
  (unreachable from the dev container, but it goes through the same `applyPaths`).

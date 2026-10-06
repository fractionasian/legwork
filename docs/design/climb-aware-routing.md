# Climb-aware routing

Status: **built, off by default.** Perth tiles carry heights; the router charges
for climbing only when the page is opened with `?climb=8`, and for turns only with
`?turn=15`. The two are meant to be tried together: `?climb=8&turn=15`.

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

- **Tile size:** Perth's 46 tiles went 6.8 → 8.3 MB gzipped (+22%), 34.7 → 38.8 MB
  raw. About 33 KB gzipped per tile on average; the first load (4 central, denser
  tiles) is ~130 KB heavier or more.
- **Search time, climb weight:** about +5% (module-scope measurement) to +20% (vm
  sandbox, which is ~2× slower overall) across the test routes. Worst long leg
  (20 km): +5–110 ms on a server CPU. Not measured on a phone.
- **Search time, turn cost:** about 2.1× on top of that (7 routes, sandbox:
  1.74 s today, 1.96 s climb 8, 4.08 s with turn 15 added; Fremantle → CBD 0.7 s →
  1.4 s). Every pin drag re-routes two legs, so this is the cost to watch. Options if
  it bites: route with the plain search while dragging and refine on release, or
  pack the graph first (the search is ~4–12× faster on typed arrays).
- **Memory (all 46 Perth tiles, app's real code, one process per setting):** 787 MB
  today; heights add 24 MB (+3%), climb adds nothing, the turn cost adds 158 MB (+20%)
  for per-edge headings and scratch fields. A typical session loads a handful of tiles.
- **Build:** Perth sampler 17 s and at least ~380 MB of RAM (two float buffers);
  encoding 5 s. Perth is the largest city, so the others are cheaper.

## Testing it

Automated: `npm test` (`test/climb.test.mjs`, `test/elevation.test.mjs`).

By hand, after the new tiles are live (the flag does nothing until Perth tiles
carry heights — run the **Build City Tiles** workflow in `legwork-tiles`, or
wait for Sunday's schedule):

1. Open `legwork.day/?climb=8` and `legwork.day/` in two tabs.
2. In each (try `?climb=4`, `?climb=8` and `?climb=8&turn=15` as well), plan the same route and compare the ascent in the elevation panel:
   Cottesloe beach → Elizabeth Quay (about 80 m → 59 m), Scarborough →
   Elizabeth Quay (about 101 m → 79 m). Pins land a few metres differently, so
   expect ±5 m.
3. Look at the line itself. The flatter route should look like something a
   local would run, not a zig-zag. Scarborough → Elizabeth Quay is the one to check
   for the turn cost: its last stretch should be a near-straight diagonal with
   `turn=15` (about 14,101 m and 75 m with `climb=8&turn=15`; 14,017 m and 101 m today).
4. Plan something flat (Victoria Park → CBD). It should look identical.

## To turn it on for everyone

Change `var CLIMB_WEIGHT = 0` to `8` and `var TURN_COST = 0` to `15` in
`routing.js`; `?climb=0` and `?turn=0` stay the off-switches. Two lines plus test
updates. Consider the search-time cost above first.

## Known gaps

- Heavy smoothing flattens short steep ramps, so they are under-weighted.
  Untested.
- No steepness penalty: a route can still contain a 20% pitch if it saves climb
  overall. Flatten SF has a separate steepness term for this.
- The bike profile uses the same weight. It wasn't re-measured at the final
  settings; at 20 m smoothing its effect was smaller (Fremantle → CBD −16 m,
  most other routes unchanged).
- Other cities are off until someone adds `"elevation": true` and checks the result.
- The turn cost is not applied at a pin: each leg between pins is routed alone, so a
  corner exactly at a pin is free.
- Turn costs use the straight edge-to-edge heading, so a gentle curve made of many
  small bends is not charged and a sharp corner split across two vertices can slip
  under the 35° threshold. Fine for city grids; untested on trail networks.

## Not done: packed graph

Measured separately: a packed (typed-array) graph searches 4–12× faster, loads a
whole city in ~0.2 s instead of ~9 s, uses ~10× less memory, and could download
at about half today's size. It also needs a tile-border stitching design and
carries no street names. Parked until phone measurements show where it's slow.

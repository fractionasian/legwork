---
status: approved — Peter accepted all five Layer-1 defaults and the Assumed list, 2026-11-18
next: PR 1 on branch claude/loop-generator-engine-e71d07; on the changed metric 7/8 rows pass, Sydney 5 km misses (16/20); your call before the PR
created: 2026-11-18
trigger: Three Routes (iOS) OzBargain freebie, ozbargain.com.au/node/983771, 2026-11-17
---

# Target-distance loops — "give me a 5 km loop from here"

## Layer 1 — Decision summary

**Building:** drop one pin, pick a distance, and Legwork draws a loop of about
that length starting and finishing at the pin.

**Problem:** today a runner who wants "5 km from home, somewhere new" has to
place pins by trial and error until the distance pill reads right. The
OzBargain thread for a competing app is mostly people saying they're sick of
running the same block. Legwork already does the hard part (good paths, parks,
fewer lights, climbs), but you have to steer it by hand.

**Goals:** one pin plus one tap gives a loop within 10% of the asked distance,
usually within 5%. Offer more than one option, because any single generated
loop will sometimes be a dud.

**Non-goals (v1):**
- Out-and-back or one-way of N km. Loop only. Out-and-back is a cheap follow-up.
- Time-based ("30 minutes"). Needs a pace, and Legwork stores nothing per user.
- Learned or popular routes. Still on the not-built list.
- A new routing engine. The loops come from the same router as hand-drawn ones.

**Success metrics:** on 20 test starts in each of 4 cities, at each distance, at
least 18 give three loops, at least two of them within 10% of target. The third
may be a near miss shown with its true length (decision 5). No loop should run the
same street out and back for more than a short stretch. You try it from home and
would actually run one. *(Changed 2026-11-18 from "three loops within 10%", after
two tuning rounds showed the third heading is the one that misses: Peter, "Yes,
change metric". The 15% overlap measure is unchanged.)*

**Decisions for you:**

1. **Where do you start it?** → **A chip beside the distance pill that appears
   once there's exactly one pin ("Loop ▸")** / an item in the side menu /
   long-press on the map. Why: your own rule for new controls is a contextual
   chip near the distance pill, never a floating button.
   Done when: you drop one pin on your phone and the chip is there without
   opening any menu.

2. **How do you pick the distance?** → **A row of preset buttons (3, 5, 8, 10,
   15, 21 km) plus "Other" that takes a typed number** / a slider / typed number
   only. Why: thumb-friendly, no dropdown, and the presets cover most runs.
   Done when: you can ask for 5 km in two taps and 12.5 km by typing it.

3. **How are the options shown?** → **One loop at a time on the map, with
   "1 of 3 ›" to flip to the next** / all three drawn together and you tap
   one. Why: three gradient-coloured routes on top of each other is hard to
   read on a phone. *I'm least sure about this one.* Three Routes shows all
   three. What would settle it is trying both on a phone.
   Done when: you can look at three different loops in three taps and keep one.

4. **What happens once you pick one?** → **It becomes ordinary pins you can
   drag, undo and export, like any route you drew** / a locked route you can
   only export or throw away. Why: it reuses everything (GPX, share links,
   elevation, undo) and lets you fix a dud stretch by dragging one pin.
   Done when: you drag a pin on a generated loop and it reroutes like a
   hand-drawn one.

5. **What if it can't get close to the distance?** → **Show the nearest it
   found, label it with the real length ("7.2 km — couldn't find a closer 8
   km loop here")** / show nothing and say it failed. Why: a near miss is
   usually still runnable, and the label keeps it honest.
   Done when: a start on a peninsula or a dead-end suburb still shows a loop
   with its true distance, never a silently wrong one.

**Assumed (say if wrong):**
- Run or bike follows whatever mode is already selected, and so do scenic,
  climb-aware and traffic-light settings.
- Works offline in the 12 pre-baked cities for loops up to about 25 km. Outside
  them it uses the live path download, which is slower; I'd cap it at 10 km
  there and say so on screen.
- The three options head off in different directions from the start, so they
  feel different rather than three versions of the same block.
- Analytics records only "a loop was generated" and which preset bucket
  (3/5/8/10/15/21/other). No exact distance, no location finer than today.
- Nothing new is stored on the server. A generated loop is saved and shared
  exactly like any other route.

---

## Layer 2 — Technical spec

### Fit with existing code

- Graph: `PackedGraph` / `dijkstra()` (A*) in `routing.js`; nodes snapped with
  `closestNode()`. Tiles load in a 5 km radius around the start
  (`loadTilesForLocation`, `tilesInRadius(..., 5)`), which covers a loop of
  ~25 km (radius ≈ L / (2π × detour)). Above that, call
  `ensureTilesAlongRoute()` per candidate or cap the preset list.
- Output: candidates are expressed as waypoints and fed through
  `addWaypointAt()` so the normal pipeline (segments, hotline, elevation,
  share hash `#r=…&m=loop`) renders them. **The generator must use the same
  router and weights as the pipeline**, or the drawn route will differ from
  the one measured. So no generator-only edge penalties.

### Algorithm (polygon waypoints, scaled to target)

For target length L, start S, and k = 3 candidate bearings θ ∈ {θ0, θ0+120°,
θ0+240°} (θ0 random, so "Try again" gives new loops):

1. Place two virtual points A, B at radius r from S, at bearings θ − 35° and
   θ + 35°, which makes a fat triangle S→A→B→S. Initial r = L / (2π × 1.3)
   (1.3 = typical street detour; tune on real tiles).
2. Snap A and B with `closestNode()`. Route S→A, A→B, B→S with `dijkstra()`.
   Measure the summed geometry length (`pathGeomLength`), not the weighted cost.
3. If |len − L| / L > 5%, set r ← r × L / len and repeat, at most 4 times.
   Keep the best attempt.
4. **Reject on overlap:** if more than 15% of the loop's length runs on edges
   used twice (lollipop or out-and-back), try a ±20° bearing jitter once, then
   accept the best with the overlap noted.
5. Return candidates sorted by |len − L|. A candidate outside 10% is shown
   only as the decision-5 fallback, with its true length.

Cost: ≤ 3 candidates × 4 iterations × 3 legs = 36 A* calls; on packed tiles
1–15 km legs are ms to tens of ms each. Run candidates sequentially with an
`await` between them, and check a generation counter (`gen`) after each one,
the same stale-guard pattern as `addWaypointAt`, so moving the start pin or
pressing Undo mid-generation drops the stale results.

### UI

- Chip renders only when `liveWaypoints().length === 1`. It hides on 0 or ≥ 2
  pins and while generating, when it turns into a spinner.
- Preset row: plain `<button>`s, no `<select>`. "Other" opens a numeric
  `<input inputmode="decimal">`, clamped 1–42 km (10 km outside tiled cities).
- Candidate view: the selected candidate is drawn via the normal pipeline. The
  "1 of 3 ›" control swaps the waypoint set. "Keep" leaves the pins in place
  and dismisses the control. Undo after Keep removes the generated pins but
  must respect "Undo cannot remove the last pin" (the start stays).
- Mode is forced to `loop` on generation. If the user then cycles mode, the
  pins stay and the router redraws as out-and-back / one-way. That's
  acceptable and needs no special handling.

### Telemetry

One `/v1/event` enum: `loop_generated` with `bucket ∈ {3,5,8,10,15,21,other}`
and `result ∈ {ok, near_miss, failed}`. No raw distance (privacy invariant),
location at the existing 0.005° grid only.

### Edge cases

- Start on an island or headland: B→S fails or the overlap check fails
  everywhere. Fall back to the best candidate and label it. All legs failing
  gives "No loop found from here — try moving the pin onto a path."
- Graph not loaded yet (first pin still fetching tiles): the chip is disabled
  until the start node snaps.
- Untiled area via Overpass: one bbox fetch at radius r × 1.5 before
  generating; reuse `loadPaths` retry and fail-loud behaviour.
- One-way bike edges: legs are directed, so S→A→B and the reverse can differ.
  That's fine, because a loop is directional anyway.

### Tests

- Unit (synthetic grid graph in `test/`): the scaler converges within 4
  iterations to ±5% on a regular grid; the overlap detector flags a pure
  out-and-back; the stale guard drops results after the start moves.
- Real-tile harness (like the climb-aware 80-pair run): 20 starts × 4 cities ×
  presets {5, 10}. Report the hit rate within 5% and 10%, mean overlap, and
  wall time. This is the success metric above.
- `verifier-legwork` drive: one pin → chip → 5 km → flip three → Keep → drag
  a pin → export GPX.

### As built in PR 1 (differences from the algorithm above)

- **Six headings, keep three (tuning round 2, approved 2026-11-18).** Six
  headings 60° apart are each scaled to L, and the best three that are ≥ 90°
  apart are kept. Every valid set of three is scored, not picked greedily: taking
  the single best first can lock in a pair with no third heading 90° from both.
  A set scores on loops within 10% and under the overlap cap, then on loops
  within 10%, then on total error. Separation is measured on the nominal heading,
  not the ±20° retry's bearing. If no valid three exist, the best of the rest fill in.
- **A 5-point polygon, not a triangle (round 2).** Four corners plus S, evenly
  spaced round a circle through S whose centre is r out along the heading. There
  are shorter legs between neighbouring corners. These are still ordinary pins
  on the same router and weights. `LOOP_CORNERS = 2` brings back the ±35° triangle.
  A corner that snaps onto S or onto another corner is dropped, and fewer than two
  left counts as no loop.
- **Corners snap to junctions.** Each corner snaps to the nearest node with at
  least 3 edges (`closestNode(..., 3)`), so it never sits at the end of a
  cul-de-sac the loop has to run into and back out of. Pins still snap to the
  nearest node. This places waypoints only. The router and weights are unchanged,
  and a node key dropped back in as a pin snaps to itself, so the pipeline draws
  what was measured (unit test: the waypoints re-route to exactly the measured
  length).
- **The first radius comes from the shape's own perimeter** (regular polygon, or
  the triangle's two spokes plus chord) × 1.3 detour. The spec's L / (2π × 1.3)
  starts about 50% short for the triangle.
- **Bracketing, not just r × L / len.** Routed length is a step function of r, so
  plain rescaling can bounce between a loop just short and one just long. Once
  there's an attempt each side of L, the next r is interpolated between them.
- **Ranking within one heading.** Inside 10%, a loop under the 15% overlap cap
  beats one over it, then the closer one wins. Outside 10%, the closer one wins.
- **The ±20° retry also fires on a length miss**, not only on overlap.
- **Tried and dropped: trimming spurs at corners.** Moving a corner back to the
  junction where the two legs split, then re-routing, cut mean overlap by only
  3–5 points on 8 Perth starts. It also lost 5% hits and doubled the time.
- API: `generateLoops(graph, startKey, L, { k, theta0, isStale, pause })` returns
  candidates `{ waypoints: [S, corners…], length, error, overlap, ok, heading,
  tries, … }` sorted by error, or `null` if `isStale()` turned true at any await.

### Harness results

`node scripts/loop-harness.mjs --tiles <dir> --set "…"`, 2026-11-18. Tiles
b6173198 (built 2026-11-15), run profile, shipped climb 8 and turn 15, seed 1, so
every row uses the same 80 starts. Each city gets 20 random starts that snap to a
path within 200 m, at least 3 km inside the city bounds, with the tiles a first pin
would load (5 km radius). Mac, Node 22, six runs in parallel, so the times are
inflated relative to one another but comparable.

**Gate rows: starts out of 20 with 3 loops within 10%** (≥ 18 needed in every row):

| Setting (`--set`) | Per 5 | Per 10 | Mel 5 | Mel 10 | Syd 5 | Syd 10 | Bri 5 | Bri 10 |
|---|---|---|---|---|---|---|---|---|
| Baseline: 3 headings, triangle (`LOOP_HEADINGS=3;LOOP_CORNERS=2`) | 15 | 14 | 15 | 17 | 14 | 14 | 13 | 13 |
| Option 1 only: 6 headings, triangle (`6;2`) | 16 | 16 | 16 | **18** | 14 | 15 | 15 | 16 |
| Option 2 only: 4-point polygon (`3;3`) | 15 | 14 | 14 | 15 | 12 | 14 | 14 | 15 |
| Option 2 only: 5-point polygon (`3;4`) | 16 | 15 | 13 | 15 | 12 | 12 | 13 | 16 |
| Both: 6 headings, 4-point (`6;3`) | 15 | 17 | 14 | **18** | 14 | 16 | 14 | 15 |
| **Both: 6 headings, 5-point (`6;4`, shipped)** | 16 | 17 | 14 | **19** | 12 | 15 | 14 | 16 |

**Starts with 3 loops within 10% *and* under 15% overlap:**

| Setting | Per 5 | Per 10 | Mel 5 | Mel 10 | Syd 5 | Syd 10 | Bri 5 | Bri 10 |
|---|---|---|---|---|---|---|---|---|
| Baseline | 1 | 0 | 4 | 8 | 2 | 3 | 2 | 6 |
| Option 1 only | 2 | 4 | 5 | 10 | 2 | 5 | 2 | 6 |
| Option 2 only, 5-point | 6 | 6 | 8 | 9 | 5 | 5 | 5 | 8 |
| Both, 5-point (shipped) | 6 | 9 | 10 | 12 | 7 | 7 | 8 | 10 |

**All loops:**

| Setting | ≤ 5% | ≤ 10% | Mean overlap | Median overlap | > 15% overlap | Median ms (5 / 10 km, range over cities) |
|---|---|---|---|---|---|---|
| Baseline | 63% | 88% | 29% | 18% | 259/473 | 340–620 / 1,160–1,600 |
| Option 1 only | 68% | 92% | 28% | 14% | 208/474 | 770–1,050 / 1,880–2,740 |
| Option 2 only, 4-point | 68% | 87% | 22% | 11% | 184/473 | 350–670 / 840–1,530 |
| Option 2 only, 5-point | 68% | 86% | 20% | 11% | 176/472 | 360–620 / 790–1,280 |
| Both, 4-point | 74% | 90% | 21% | 10% | 143/474 | 720–1,150 / 1,760–2,300 |
| Both, 5-point (shipped) | 75% | 90% | 19% | 10% | 137/474 | 710–950 / 1,670–2,550 |

The shipped setting's slowest single generation was 15.7 s (Sydney, 10 km), and
its per-city max is 3–16 s.

**Gate: still MISSED.** With both options, 12–19 of 20 starts per row get three
loops within 10%. Only Melbourne 10 km passes. Tolerances and the 15% overlap
metric are unchanged.

What each option did:

- **Option 1 (more headings)** fixes length more than overlap. Loops within 10%
  go from 88% to 92%, and every row gains 0–3 starts. Median overlap goes from
  18% to 14%. It roughly doubles the time.
- **Option 2 (polygon)** fixes overlap, not length. Median overlap falls from 18%
  to 11% and clean-loop starts roughly double. Within 10% is flat to slightly
  worse (86–87%), because more corners give more chances for one of them to land
  across water. It's no slower, since the legs are shorter.
- **Together** they stack on overlap (median 10%, under half the baseline's loops
  over the cap) and 5% hits (63% → 75%). The 10% gate count moves only 0–4 per row.

What the remaining misses are (shipped setting): 146 of 160 runs have at least two
loops within 10%. 35 have three loops with one outside 10%, and 2 found fewer than
three. So the miss is still the weakest of the three. Sydney 5 km is the worst row
(12/20) and got no better with tuning. Its starts sit near the harbour and its inlets
(going by the coordinates, not traced one by one).

Speed is now the larger concern for PR 2. A median of about 2 s on a Mac for 10 km,
with a tail to 16 s, means roughly 5–10 s and worse on a phone. Ten headings'
worth of A* calls are the cost.

**Changed metric (2026-11-18): 3 loops, at least 2 within 10%.** Same shipped run,
re-run with the new gate, and it gave identical loops:

| | Per 5 | Per 10 | Mel 5 | Mel 10 | Syd 5 | Syd 10 | Bri 5 | Bri 10 |
|---|---|---|---|---|---|---|---|---|
| Starts out of 20 (≥ 18 needed) | 19 | 18 | 19 | 20 | **16 ✗** | 18 | 18 | 18 |

**Gate: MISSED in one row, Sydney 5 km.** Five of the passing rows sit at exactly
18. The four Sydney 5 km misses are real geography: two on the edge of Lane Cove
National Park (#3, #10), Vaucluse/Watsons Bay on its harbour peninsula (#13), and
#6, a start that snapped onto a 2-node path fragment joined to nothing. A hand-drawn
route from that pin fails too, and "No loop found from here" is the right answer.

Ruled out: **tiles truncating the graph.** A first pin loads tiles whose *centres*
are within 5 km. That's 2.9 tiles on average and as few as 1, so about 5 × 10 km of
ground, not the "loop of ~25 km" assumed under Fit with existing code. Loading
within 8 km (7.4 tiles on average) left Sydney 5 km at 16/20 and 10 km at 18/20, so
it isn't behind the misses. It still matters for PR 2 at 15–21 km
(`--tile-km` in the harness measures it).

What would move the gate next (not done; each changes the spec, so it's your call):

1. **Let a near-miss heading try a different radius direction.** A heading whose
   best attempt is short could retry with corners pulled inward on the water
   side. That's speculative, and I haven't measured it.
2. **Accept "2 good + 1 labelled near miss" for v1.** That's 146/160 runs today.
   Decision 5 already shows a near miss with its true length, so the user sees
   2 loops near the target and a third clearly labelled. This changes the success
   metric, not the code.
3. **Fix the speed independently** before PR 2: stop early once three clean loops
   ≥ 90° apart are in hand, rather than always routing all six headings.

### Sequencing (one PR per idea)

1. `routing.js` generator + unit tests + real-tile harness numbers (no UI).
   Gate: harness hits the success metric.
2. Chip, preset row, candidate flipper, telemetry enum. `/review-pass`, then
   `/first-users` (public app, visible change).

### Handover (PR 1, 2026-11-18)

Generator, unit tests and harness are on branch `claude/loop-generator-engine-e71d07`,
not pushed and with no PR. Shipped constants are tuning round 2's best (6 headings,
5-point polygon). On the changed metric (3 loops, 2+ within 10%), 7 of 8 rows pass and
Sydney 5 km misses at 16/20 (Harness results). Next: you decide whether that one row
blocks PR 1. If not, open it and run `/review-pass`. If it does, pick from "What would
move the gate next". To reproduce: export the tiles with `git -C ~/legwork-tiles
archive origin/master manifest.json tiles/perth tiles/melbourne tiles/sydney
tiles/brisbane | tar -x -C <dir>`, then `node scripts/loop-harness.mjs --tiles <dir>`.
`--set "NAME=value"` and `--tile-km` are for tuning runs, and the report header says
when either is in use.

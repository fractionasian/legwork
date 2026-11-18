---
status: proposed — awaiting Peter's Layer-1 decisions
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

**Success metrics:** on 20 test starts across 4 cities, at least 18 give three
loops within 10% of target, with no loop that runs the same street out and back
for more than a short stretch. You try it from home and would actually run one.

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

### Sequencing (one PR per idea)

1. `routing.js` generator + unit tests + real-tile harness numbers (no UI).
   Gate: harness hits the success metric.
2. Chip, preset row, candidate flipper, telemetry enum. `/review-pass`, then
   `/first-users` (public app, visible change).

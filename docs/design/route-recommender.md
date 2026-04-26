# Route recommender — design spec

Pick a starting point, pick a distance, get a route. Loop or out-and-back.
Optional one-tap "vibe" steering. Re-roll until happy.

Author: Claude (drafted from Peter / Jim's idea, 2026-04-26).
Status: Spec — not implemented.

## 1. Goal

Today Legwork makes you place every waypoint. That's fine when you know
the area but a dead-end when you don't ("I'm in Adelaide for a conference,
where do I run?"). The recommender lets a user say "8 km loop from here"
and get a route that respects the existing P1–P5 walkway preferences and
feels like something a local would have chosen.

The interaction is:

1. Tap-and-hold on the map (or a "Plan a route" entry) at the start point.
2. Choose distance (already picked elsewhere, reuse `#distance-menu`).
3. Choose loop or out-and-back (existing mode toggle).
4. Optionally tap a vibe chip.
5. Tap **Plan**. See a route. Tap **Shuffle** for another. Save / share /
   GPX as today.

## 2. Non-goals

- Not a turn-by-turn navigator.
- Not a heatmap-driven router (no Strava popularity data).
- Not a multi-day route planner.
- Not curated routes — we synthesise, not retrieve.
- Not adding ML / learned preferences.
- Not exposing every preference as a slider; vibes are presets, not dials.

## 3. Current state

- `routing.js` runs Dijkstra over an edge-weighted graph; weights come
  from `ROAD_WEIGHT[highway]` plus the P1/P5 way-level preferences
  (`wayPrefMultiplier`, `tiles.js:420`). When the route-preferences spec
  lands, P2–P4 and the scenic toggle add more weight nuance.
- Modes are `loop` / `outback` / `oneway` (`app.js:1056`). The user
  places waypoints; Dijkstra connects them.
- Distance is computed *post-hoc* from the placed waypoints. There is no
  notion of a *target* distance.
- Elevation is fetched only after a route exists, via Open-Meteo
  (`fetchElevation`, `app.js:288`).

## 4. Generation algorithm

### 4.1 Multi-waypoint loop on a jittered circle (the workhorse)

For target distance `D` from start `S`:

**Loop**:

1. Decide anchor count: 2 anchors for `D ≤ 5 km`, 3 for `D > 5 km`.
2. Compute base radius `r = D / (2π) × s` where `s` is a slack factor
   (start at 0.85 — Dijkstra paths are longer than crow-flight).
3. Pick a base heading `θ₀` (random, or rotated on Shuffle).
4. Place anchors at headings `θ₀, θ₀ + 2π/N, …` from `S`, each at
   distance `r × jitter` where `jitter ∈ [0.85, 1.15]`.
5. **Snap each anchor to the nearest graph node** (reuse
   `findNearestNode` logic). If no node within 250 m, perturb the
   heading by ±15° and retry up to 3×.
6. Route `S → A₁ → A₂ → … → S`. On the closing leg, forbid edges used
   on prior legs (penalise with a high multiplier rather than hard-ban —
   we don't want disconnection).
7. Measure total length. If outside `D ± 15%`, adjust `s` and retry up
   to 3×. If still outside, return the closest attempt and let the user
   shuffle.

**Out-and-back**:

1. Pick a heading `θ₀`.
2. Place a single anchor at distance `D / 2 × 0.9` along that heading.
3. Snap to nearest node, route `S → A`, mirror the path for the return.

### 4.2 Sample-and-rank (the polish layer)

Generate `N = 6` candidates per request, each with a different `θ₀` (or
jitter pattern). Score each candidate, surface the highest. Shuffle
button cycles through the remaining ranked candidates before generating
a fresh batch.

`N = 6` is the budget — 6× Dijkstra on a typical loaded graph completes
in under 2 s on mid-range mobile.

### 4.3 Score function

```
score = lengthMatch × vibeMultiplier × baseQuality
```

- `lengthMatch`: triangular function peaking at 1.0 when `actual = D`,
  falling to 0.5 at `D ± 25%`, 0 beyond.
- `baseQuality`: weighted sum of `(walkway %) + (named-trail %) - (main-road %)`.
  Always applied; encodes "feels runnable".
- `vibeMultiplier`: 1.0 by default. Each vibe chip overrides this —
  see §5.

Scores are normalised within a batch so Shuffle always returns a
*relatively* good candidate even if all six are mediocre.

## 5. Vibe chips

A row of optional chips on the recommender sheet. Tap one to bias scoring;
none selected = Surprise. Chips are **context-detected** at sheet-open
time and hidden when the surrounding tile lacks the data they need (see
§5.2).

### 5.1 Vocabulary

| Chip | Boosts when route… | Data |
|---|---|---|
| 🎲 Surprise | (no override; uses baseQuality only) | — |
| 🌳 Green | passes through `leisure=park`, `landuse=recreation_ground`, `landuse=forest` polygons | scenic-spec polygons |
| 💧 Water | runs within 100 m of `natural=coastline`, `natural=water`, `natural=beach`, or `waterway=river` | Overpass natural+waterway stanza |
| 🏛️ Landmarks | passes ≥2 `tourism=viewpoint/artwork/monument/memorial` or `historic=*` nodes | scenic-spec landmark nodes |
| 🤫 Quiet | minimises edges with `maxspeed > 50` or `highway=primary/trunk`; bonuses `traffic_calming=*` and `living_street` | already in graph |
| 🏞️ Flat | minimises total ascent | elevation grid (see §6.2) |

Names are deliberately feel-based, not location-based — Water covers
rivers and lakes too, so it works in Canberra (Lake Burley Griffin) and
Melbourne (Yarra) just as well as Perth (Swan, foreshore). Green covers
parks AND street-tree-dense landuse, so it's not just a "have a big
park nearby" chip.

### 5.2 Context-aware visibility

When the recommender sheet opens, scan the currently loaded tile data:

- 💧 Water: hide if no water polygon or `waterway=river` line within
  `D` of the start.
- 🏛️ Landmarks: hide if fewer than 4 landmark nodes within `D / 2`.
- 🌳 Green: hide if total park area within `D / 2` is < 0.1 km².
- 🤫 Quiet: always show (urban-centric chip; the tag data is universal).
- 🏞️ Flat: always show.
- 🎲 Surprise: always show.

This means a runner starting in Perth CBD sees `🎲 🌳 💧 🏛️ 🤫 🏞️`
(everything — Swan River, Kings Park, lots of heritage). A runner in
the suburbs of Mt Lawley sees `🎲 🌳 🤫 🏞️` (Hyde Park is close enough,
no water). A runner deep in the Pilbara backblocks sees `🎲 🤫 🏞️`.

### 5.3 No persisted state

Vibe selection lives only for the current generation. We do **not**
persist it as a user preference. Reasons:

- Encourages experimentation ("try a different one").
- Avoids the toggle-fatigue problem the route-preferences spec already
  cautioned against.
- Avoids having to migrate the chip vocabulary if it changes.

## 6. Data requirements

### 6.1 Reused from route-preferences spec

The recommender does **not** invent new Overpass queries beyond what the
route-preferences spec already adds:

- Way tags: `surface`, `name`, `lit`, `maxspeed`, `traffic_calming`
  (already extended for P1–P5).
- Node tags: `tourism=*`, `historic=*` (scenic spec landmark stanza).
- Polygons: `leisure=park`, `natural=beach`, `landuse=recreation_ground`
  (scenic spec polygon stanza).

What's new:

- `natural=water` and `waterway=river` lines, for the Water chip. One
  extra Overpass stanza, ~50–200 KB per typical city tile.

### 6.2 Elevation grid (Flat chip)

Per-edge elevation at runtime is too chatty. Two-tier strategy:

**Pre-cached cities** (`build-tiles.js`): bake a coarse elevation grid
into each tile. Resolution ~100 m. For a 10 km × 10 km tile that's a
100×100 grid = 10,000 floats ≈ 40 KB raw, ~10 KB gzipped. Lookup at
runtime: bilinear interpolation per edge endpoint, sum per route.

**Uncached areas** (free-roaming user, no city match): fall back to
post-rank — pick top 3 candidates by `baseQuality × lengthMatch`, fetch
elevation for each via Open-Meteo (already wired), pick flattest.
Adds ~3× the current single-route elevation call. Acceptable for an
opt-in chip.

When the user is in a pre-cached city, the runtime cost of Flat is zero
beyond a grid lookup. When they aren't, it's a 3× elevation fetch — but
they explicitly asked for it.

## 7. UX surface

### 7.1 Entry point

Two paths in:

- **Long-press a map point** → context menu with "Plan a route from
  here". Discoverable for users who already tap-place waypoints.
- **Distance menu**, when no waypoints exist → adds a "✨ Plan from my
  location" affordance below the distance options.

The recommender modal:

```
  ┌────────────────────────────────┐
  │ Plan a route                   │
  │                                │
  │  Distance:  5 km          [v]  │
  │  Mode:      ↻ Loop        [v]  │
  │                                │
  │  Vibe (optional):              │
  │  [🎲][🌳][💧][🏛️][🤫][🏞️]   │
  │                                │
  │           [ Plan ]             │
  └────────────────────────────────┘
```

After Plan: the route appears as today (existing route-rendering path),
with a **Shuffle** chip near the distance pill. Tap Shuffle → next
ranked candidate; after exhausting the batch, regenerate with a new
heading seed.

### 7.2 Re-edit handoff

A recommended route uses the same data structures as a manually planned
one — anchor nodes become normal waypoints. The user can drag any
waypoint to nudge the route, exactly as today. The recommender is just
a waypoint-synthesiser.

### 7.3 Failure modes

- **Sparse graph** (rural, edge of city): the algorithm can't hit `D`.
  Show "Closest I could find: 6.2 km loop. Use it?" with `[ Use ]`
  `[ Try smaller area ]`.
- **All anchors fail to snap**: degrade to `outback` mode silently;
  if that fails, surface error.
- **No graph at all** (tiles still loading): defer Plan button until
  paths load, with the existing `Loading paths…` indicator.

## 8. Phasing

### Phase 1 — MVP generator (~300 LoC)

- Implement §4.1 loop + out-and-back generators with multi-attempt slack
  adjustment.
- Implement §4.3 score function with `baseQuality` only (no vibes yet).
- Implement Shuffle (cycle ranked candidates, regenerate when exhausted).
- Wire entry point (long-press OR distance-menu affordance, pick one).
- No vibe chips. Hard-code Surprise behaviour.

Validation: 5 known Perth start points × 5 km loops. Manual check that
results are within ±15% of target ≥80% of the time, and that they
visibly prefer footways over arterials.

### Phase 2 — Vibes minus Flat (~200 LoC)

- Add chip row to recommender sheet. Surprise / Green / Water /
  Landmarks / Quiet.
- Context-aware chip visibility.
- Score-function `vibeMultiplier` per chip.

Depends on the route-preferences spec's scenic-data stanza already being
in place. If it isn't yet, ship Phase 2 as part of (or after) it.

### Phase 3 — Flat chip (~250 LoC)

- Extend `build-tiles.js` to bake elevation grid per tile.
- Runtime lookup helper (bilinear interp).
- Post-rank fallback path for uncached areas.
- Tile-format version bump + cache invalidation.

### Phase 4 — Polish (optional)

- Direction picker (drag a heading arrow on the map preview before
  generating). Only build if Shuffle alone proves insufficient.
- "Save vibe as default" if real users keep picking the same one.
- Multi-distance preview ("here's 5 km, here's 8 km, here's 10 km").

Total: ~750 LoC across Phases 1–3.

## 9. Risks and open questions

### 9.1 Distance accuracy

The crow-flight `r = D / (2π) × s` heuristic fights real graph topology.
Cul-de-sacs, river barriers, and unwalkable industrial zones all distort
actual route length. Mitigations: slack-factor retry loop in §4.1, and
the soft `±15%` target. Worst case the user gets 6 km when they asked
for 8 — still useful.

### 9.2 Boring routes in monoculture suburbs

A flat residential grid produces routes that *look* fine on the map but
are dull to run. The vibe chips help (Quiet, Green) but can't conjure
landmarks that aren't there. Not a bug; not all neighbourhoods are
runnable. Document it in the welcome modal hint.

### 9.3 Shuffle exhaustion

After 6 candidates the user might still be unhappy. Plan: regenerate a
fresh batch with a rotated heading and stronger jitter. After three
regenerations show "Out of fresh ideas — try a different distance or
vibe".

### 9.4 Vibe chip vocabulary creep

Tempting to add more chips ("Hills", "Stairs", "Beach", "Heritage").
Resist until real-use data shows the existing six don't cover what
people actually want. Each additional chip is more visual noise on a
small screen.

### 9.5 Long-press conflict

iOS Safari hijacks long-press for image-save / link-share menus. Tap-
and-hold on the map needs to `preventDefault` carefully. Alternatively,
expose only the distance-menu entry point and skip long-press.

### 9.6 Coupling to route-preferences spec

The vibe chips lean heavily on data the route-preferences spec adds.
Don't ship the recommender before that spec's Phase 2 (named trails)
and Phase 3 (scenic data) land — otherwise Green / Water / Landmarks
have nothing to score against.

### 9.7 Pre-cached tile schema bump

The Flat chip's elevation grid is a tile-format change. Bump
`tile2:` → `tile3:` (or whatever's current) and document the rebuild
needed in `build-tiles.js`. One-time cost per cached city.

### 9.8 Aesthetic vs accurate naming

"Quiet" technically means *low traffic noise*, but we're using it as a
proxy for "feels safe / pleasant to run". If users misread it as a
literal noise-meter feature, rename to "Calm streets" or similar. Worth
testing with one or two real users.

## 10. Acceptance criteria (Phase 1)

- For 10 manually-picked Perth start points + a 5 km loop request:
  - 8/10 routes within `±15%` of target distance.
  - 10/10 routes form a valid loop (no self-intersecting in a way that
    breaks Dijkstra's contract).
  - Shuffle produces a *visibly different* route ≥80% of the time
    (overlapping <50% of edge-distance).
- p95 generation time < 3 s on a mid-range mobile with paths loaded.
- No regression in manual route-planning UX — the recommender is purely
  additive, never intercepts an existing flow.

## 11. Future extensions (not in this spec)

- **Direction-controlled generation**: drag a compass arrow to bias
  heading.
- **Time-budget mode**: "I have 45 min" → infer target distance from
  user's stated pace (or default 5:30 /km).
- **Multi-stop**: "loop that passes a coffee shop at km 4". Needs POI
  scheduling, beyond MVP.
- **Save-and-share recommendations**: today's saved-route format
  already supports this; recommender output uses the same shape.
- **Group runs**: multiple start points, single meeting end. Probably
  out of scope forever.

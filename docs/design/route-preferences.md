# Route preferencing — design spec

Behind-the-scenes weighting improvements to make Legwork's Dijkstra produce
more runner-friendly routes than pure shortest-path with road-type weights
allows.

Author: Claude (drafted from Peter's request, 2026-04-23).
Status: Spec — not implemented.

## 1. Goal

Runners choose routes based on more than distance and road type. A named
coastal trail beats a 200m-shorter residential cut-through. A crossing at
a zebra beats dodging traffic at a 4-way stop. An AED-equipped foreshore
beats an isolated industrial backstreet. Legwork's current Dijkstra only
knows `highway=` type; every other signal in OSM is invisible.

This spec extends the graph to carry a small vocabulary of extra
attributes, and the edge-weight function to consider them. The user sees
no new complexity — routes just feel better. A single optional toggle
("Prefer scenic routes") opens up stronger preferences for users who
want them.

## 2. Non-goals

- Not building a full multimodal router (no transit, no bike modes).
- Not competing with dedicated trail-running apps (Komoot, Strava Routes).
  Legwork stays the "3-click plan a loop near me" tool.
- Not adding turn-by-turn navigation or live re-routing.
- Not supporting heatmap/popularity-based weighting (would need user data
  we don't collect).
- Not adding ML / learned preferences.

## 3. Current state

`routing.js` defines `ROAD_WEIGHT`, a multiplier per `highway=` value
(footway=1.0, trunk=2.5). In `applyPaths` (tiles.js), each edge's stored
weight is `haversine × ROAD_WEIGHT[highway]`. Dijkstra minimises total
weighted distance.

Limits:

- Only `highway=` influences routing. `surface=`, `foot=`, `bicycle=`,
  `smoothness=`, `name=` are fetched but unused.
- No node-level attributes participate. Barriers, crossings, traffic
  lights exist in OSM but are invisible to the router.
- No way-relation membership. A way that's part of a `route=foot` relation
  (a named walking trail like "Heritage Trail") is not distinguished from
  an anonymous footway.
- No proximity-to-landmark bonus. The router can't prefer corridors
  passing viewpoints.

## 4. Preference catalog

Each preference maps to a **multiplicative weight adjustment** applied
during graph construction. A preference pulls the multiplier toward 0
(more attractive) or away from 1 (less attractive).

### 4.1 Default-on (low-risk, no detours)

These apply automatically — no UI toggle. They nudge the router among
equivalent alternatives; they never force large detours.

**P1. Prefer named walking/running trails.** ×0.85 for ways tagged
`name=*` AND belonging to a `route=foot` or `route=hiking` relation,
OR ways with tags suggesting trail identity (`foot=designated`,
`trail_visibility=excellent`). A named coastal path is almost always
more runnable than a parallel unnamed footway.

**P2. Penalise traffic lights on the path.** ×1.15 per edge whose
endpoint node is tagged `highway=traffic_signals` (and no pedestrian
crossing override). Waiting at lights breaks running rhythm. The
penalty is small (15%) so a route that genuinely needs to cross a
signaled intersection still can.

**P3. Prefer marked/signalled pedestrian crossings when crossing a
major road.** When the router chooses between two edges that both
cross a `highway=primary|secondary|trunk`, prefer the one whose node
is tagged `highway=crossing` with `crossing=traffic_signals|zebra|marked`.
Implementation: ×0.9 bonus on edges whose endpoint node matches that
tag combo.

**P4. Avoid ways with trail obstacles.** ×1.25 for edges whose endpoint
node is tagged `barrier=gate`, `barrier=stile`, `barrier=kissing_gate`,
`barrier=turnstile`. These break stride and are often locked outside
business hours.

**P5. Prefer softer surfaces on paths.** Where multiple `footway`-class
ways are available, ×0.95 for `surface=ground|dirt|grass|compacted|gravel`
(easier on joints); no change for `surface=paved|asphalt|concrete`.
Only applies if the way's `highway` is already footway/path/track (we
don't want to push runners onto gravel roads).

### 4.2 Optional: "Prefer scenic routes" (toggle)

A single side-menu toggle that, when on, applies more opinionated
weightings. Defaults OFF so new users get a sensible shortest-path
experience.

**S1. Landmark proximity bonus.** For each edge within 50m of a node
tagged `tourism=viewpoint|attraction|monument|artwork|memorial` or
`historic=*`, apply ×0.9. Edges 50–150m away get ×0.95. Beyond 150m,
no effect. Compounds for multiple landmarks.

**S2. Park/foreshore corridor bonus.** For edges whose geometry lies
inside a `leisure=park`, `leisure=nature_reserve`, `natural=beach`, or
`landuse=recreation_ground` polygon, ×0.85. Running through a park or
along a beach is almost always preferred.

**S3. Track preference.** Bump `leisure=track` (athletics tracks) ×0.8
so Dijkstra happily detours through them if nearby. Niche but useful for
interval sessions.

### 4.3 Explicitly excluded (too opinionated or too expensive)

- **Avoid steep climbs**: elevation-aware routing is a different algorithm
  (Dijkstra with elevation cost needs per-edge elevation, which we only
  fetch post-route). Out of scope.
- **Safety-by-time-of-day**: no data.
- **Air quality / shade**: no reliable OSM data.
- **Water-fountain proximity bonus**: tempting but would make routes
  detour for water stops; probably annoying. User can already add manual
  waypoints near their preferred fountains.

## 5. Data model changes

### 5.1 Overpass query extensions

`loadPaths` in `tiles.js` currently fetches `way["highway"=X]` for a
fixed highway list. We extend to also carry:

- Way tags we already fetch but ignore: `surface`, `foot`, `bicycle`,
  `name`. No query change needed; just retain them in properties.
- Node tags for barrier / crossing / traffic signals. Current query
  uses `>` recurse-down to fetch member nodes, which returns just their
  positions. Change to `(._;>;)` to fetch referenced node tags too.
  Alternatively, a separate `nwr[...](around:...); out body; >; out body;`
  brings back node tags for all referenced nodes. Payload roughly
  doubles for a typical 2km-radius fetch (~1.2MB → ~2MB).
- Ways by relation membership (`route=foot|hiking`). Requires a second
  Overpass stanza: `relation["route"~"foot|hiking"](around:...); ` and
  then union the member ways. Adds ~300KB per city.
- Landmark nodes (viewpoint / monument / attraction / etc). Third stanza.
- Park/foreshore polygons. Fourth stanza, selective — only if S2 is
  enabled.

### 5.2 Graph-edge schema extension

Current edge (neighbour entry): `{ key, lat, lon, dist }`.

Extended: `{ key, lat, lon, dist, rawDist, attrs }` where `attrs` is a
small bitfield of compiled preferences applied to this edge:

```
attrs: {
    ntrail: bool,          // belongs to a named trail relation
    traffic_signal: bool,  // endpoint is a signaled intersection
    ped_crossing: bool,    // endpoint is a marked crossing
    barrier: bool,         // endpoint is a barrier (gate/stile)
    soft_surface: bool,    // surface=dirt/gravel/grass on a path
    in_park: bool,         // geometry intersects a park polygon
    landmark_near: number, // distance in metres to nearest landmark, null if >150m
}
```

`rawDist` preserves the haversine for distance-display; `dist` is the
weighted cost Dijkstra uses.

### 5.3 Node-level data carry-over

Graph nodes currently have no metadata (just a string key). Extend the
`spatialGrid` entries (or add a sibling `nodeAttrs` map) keyed by node
key, storing `{ traffic_signal, ped_crossing, barrier }` flags. Edges
look up their endpoint nodes when computing `attrs`.

## 6. Algorithm changes

### 6.1 Weight computation

Option A — **pre-compute at graph-build time**: apply all preference
multipliers when the edge is created in `applyPaths`. Store the final
weighted `dist`. Fast at route-time; any preference change forces a full
graph rebuild.

Option B — **per-route weight function**: store raw `attrs` on each edge,
pass a weight closure to `dijkstra()`. Slower (typically 5–15%) but
preferences toggle live.

**Recommendation: Option A plus a `preferencesKey` on the graph.** The
graph knows which preference set it was built against. Toggling a
preference invalidates the graph and triggers a rebuild from
`state.pathFeatures` (fast — we don't re-fetch, just re-weight). Avoids
per-edge closure overhead in Dijkstra; keeps toggle response under 500ms
on a typical loaded graph.

### 6.2 Weight combination

Per-edge final multiplier is the product of all active preference
adjustments:

```
weight = ROAD_WEIGHT[highway]
       × (ntrail ? 0.85 : 1)
       × (traffic_signal && !ped_crossing ? 1.15 : 1)
       × (ped_crossing_on_major ? 0.9 : 1)
       × (barrier ? 1.25 : 1)
       × (soft_surface ? 0.95 : 1)
       × (scenic && in_park ? 0.85 : 1)
       × (scenic && landmark_near != null
          ? (landmark_near < 50 ? 0.9 : 0.95)
          : 1)
```

Worst-case compounding: an edge with every penalty stacked tops out
around `×1.5`. Worst-case bonus: a park-interior named trail near a
landmark gets around `×0.66`. Both are within the dynamic range
Dijkstra handles cleanly.

### 6.3 Rebuild budget

Changing the scenic toggle triggers a graph re-weight. For a typical
Perth-radius graph (~40k edges), the re-weight loop is a linear scan:
expected <200ms on desktop, <500ms on mid-range mobile. No network
calls. Acceptable; shows the `Loading paths…` banner for a moment.

## 7. UI surface

### 7.1 Default-on prefs (P1–P5)

No UI. Baked into the router. Users never see these settings.

### 7.2 Scenic toggle

One new side-menu entry beneath "🚻 Toilets" / "💧 Drinking water":

```
  🗺️ Prefer scenic routes       [On/Off]
```

State persisted to `localStorage` as `lw:scenic`. Default OFF. Toggling
triggers `updateRoute()` to re-weight + re-route.

### 7.3 Debug/inspect (nice-to-have, not MVP)

A developer-only URL-hash flag `#debug=weights` that hovers each edge
with a tooltip showing its computed weight multiplier. Useful for
tuning coefficients without opening the console.

## 8. Phasing

### Phase 1 — MVP (1 session, ~200 LoC)

- Extend Overpass query to include node tags for barriers, crossings,
  traffic signals. Same for `name=*` ways.
- Build a per-node attribute map during `applyPaths`.
- Implement P2 (traffic signals), P4 (barriers). These are the two
  most impactful and easiest.
- Ship default-on; no toggle.

### Phase 2 — Named trails + crossings (1 session, ~150 LoC)

- Add relation fetch for `route=foot|hiking`. Mark member ways.
- Implement P1 (named trails) and P3 (pedestrian crossings on major roads).
- Verify against a known Perth route (Kings Park Law Walk, Bibbulmun Track).

### Phase 3 — Scenic toggle (1 session, ~200 LoC)

- Fetch landmark nodes and park polygons per city tile.
- Implement S1 + S2. Toggle wired to side menu.
- Graph re-weight path wired.

### Phase 4 — Tuning + debug view (optional, 1 session)

- Debug weights visualisation.
- Adjust coefficients based on real-use feedback.

Total: ~550 LoC across 3 required phases. Can be shipped incrementally.

## 9. Risks and open questions

### 9.1 Data quality variance

OSM tagging completeness varies wildly by region. Perth is well-mapped;
regional WA and remote NT less so. `barrier=*` tags in particular are
patchy. The router shouldn't require these to be present — preferences
are soft nudges, not hard constraints.

### 9.2 Overpass payload size

Adding node tags and relation members roughly doubles the Overpass
response. For a 10km-radius Perth query today (~1.5MB), this is fine;
for a sparse rural query it's insignificant; for a dense inner-city
query (Manhattan-scale, should Legwork ever go there) this could exceed
5MB and hit timeouts. Mitigation: tiered radius already exists in
`radiusFromZoom()` — the tile-builder for pre-cached cities uses fixed
bounds so no runtime risk there.

### 9.3 Preference tuning

The multipliers (0.85, 1.15, etc.) are guesses. Wrong values either
produce no effect or distort routes badly. Needs iterative testing on
known routes. Recommend building the debug view (Phase 4) early to
support this.

### 9.4 Scenic toggle distortion

S1 + S2 can produce materially longer routes (5–20%). Users may be
surprised. The toggle label "Prefer scenic routes" is honest but a
subtitle hint ("may add distance for nicer paths") reduces
surprise.

### 9.5 Cache invalidation

Existing cached tile / Overpass-path responses don't include node tags.
Phase 1 needs a cache-key bump (`paths:` → `paths2:`, `tile:` → `tile2:`)
to force re-fetch. One-time cost per user; handled the same way as
`pois:` → `pois2:` was.

### 9.6 Pre-cached city tiles

`build-tiles.js` would need the extended Overpass query and updated
tile schema too. Existing pre-cached tiles stay valid for old clients
but new clients need a rebuild. Coordinate with the manifest version
bump.

### 9.7 Named trails with `route=foot` relations

Relation fetches from Overpass can be expensive and occasionally slow.
Mitigation: fetch relation members ONCE per city in `build-tiles.js`,
bake a `ntrail=true` property onto the relevant ways in the compact tile
format. Runtime Overpass never touches relations.

## 10. Acceptance criteria (MVP — Phase 1)

- Routes in a Perth suburb with traffic lights vs zebra-crossing
  alternatives prefer the zebra crossing in >70% of A-B pairs tested.
- Routes through parks with gates are routed around the gate when a
  nearby open path exists.
- A/B test: 5 runner-chosen routes (existing regular routes Peter knows)
  vs Legwork's planned routes. Qualitative "does this feel more like
  what a local would pick?" check.
- No route rendering is materially slower (p95 < 1.5× current Dijkstra
  time).
- No mandatory UI changes for default users; they see better routes with
  no new controls.

## 11. Future extensions (not in this spec)

- **Popularity-based weighting** (would require user-contributed heatmap
  data or a partnership with Strava).
- **Time-aware preferences** (avoid main roads during rush hour).
- **Community-tagged obstacles** (waterlogged paths in wet season).
- **Accessibility profiles** (wheelchair-friendly surfaces).

These each add substantial complexity and data-source risk. Park them
until the core preferencing is proven useful.

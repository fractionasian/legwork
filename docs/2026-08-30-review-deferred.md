# Deferred items — 2026-08-30 review (security / UI / functionality / speed)

Five-agent review pass (worker+client security, functionality, UI + water
visibility, A*-vs-Dijkstra benchmark, free-tier storage). Everything urgent
shipped on this branch. These items were deliberately NOT done; each lists why
and what would trigger picking it up.

## Peter's call (product/architecture decisions, not bugs)

- **Finish the Umami → self-hosted analytics migration.** The 2026-06-10
  deferral of the missing SRI had the pickup trigger "if analytics ever
  expands" — it has (own `/v1/event` ingest, migration 0002 describes itself
  as the Umami replacement). `cloud.umami.is/script.js` is now the only
  script that can change without a repo change. Finishing = move
  `city-resolved`/`city-unknown` to `track()`, add them to `EVENT_NAMES`/
  `PROP_SCHEMA`, drop the script tag + 4 CSP sources. ~30 min; the cost is
  losing the Umami dashboard for those two events.
- **`/v1/graph` demand counter undercounts popular cells.** An edge-cache hit
  never invokes the Worker, so `bumpDemand` doesn't run — the more popular a
  cell, the more its demand is undercounted, and it feeds the "next city to
  pre-bake" ranking. Cheapest fix: a coarse cell prop on the `pin-drop` event
  (`/v1/event` is no-store). Until then treat demand as directionally useful,
  biased low on hot cells. The in-code comment claiming "a HIT counts as much
  as a MISS" holds for R2 hits only.
- **R2 graph cache + D1 `links` still grow with no ceiling** (carried forward
  from June, still open; the new `g2:` generation also orphans all `g:*`
  objects). Dashboard-side lifecycle rule for R2 and a TTL/cleanup decision
  for `links` remain config work. Trigger: dashboard shows R2 trending toward
  10 GB or D1 row counts growing meaningfully.
- **`navigator.storage.persist()` is never requested.** On iPhone the offline
  cache survives only for the installed-PWA (Home Screen) case; a plain
  Safari tab loses everything after 7 days of disuse. Calling persist() on
  first route-save would harden the tab case. One line + a UX decision about
  when to ask.

## Cheap speedups measured but not taken (A* shipped instead)

- **`dist`/`prev`/`visited` as `Map`/`Set` in dijkstra:** measured a further
  1.14–1.23× on top of A* (500k-key object literals hit V8 dictionary mode).
  ~10 lines. Take it if routing ever feels slow again.
- **Per-segment route cache on waypoint drag:** a drag re-routes all N−1
  legs; only the 2 adjacent to the dragged pin can change. Biggest win on
  multi-waypoint routes; app.js state work.
- **Bidirectional A*:** would roughly halve the search again, but a genuine
  rewrite with a subtle termination condition. Only if the two above aren't
  enough.
- **Integer-interned node keys** would speed up graph construction (the
  current bottleneck at ~13 s for a full-city graph in Node) and every
  search, but touches tiles.js broadly.

## Correctness notes, accepted as-is

- **`closestNode` can return a non-nearest node** in pathological sparse
  graphs (28/2790 synthetic trials, worst 688 m excess). Never fires at real
  graph density and the 200 m snap gate caps the damage. Correct rule if it
  ever matters: keep scanning rings until ring start distance > bestDist.
- **Terrarium edge-pixel redirect comment is wrong** (app.js ~471): adjacent
  XYZ tiles do not share a geographic column; the redirect substitutes a
  neighbouring sample ~9.5 m away and only when the neighbour tile is cached.
  Median-3 absorbs it. Fix the comment before trusting it for future work.
- **`applyPaths` node weighting is tile-order-dependent** for ways crossing
  tile boundaries (edge built before the neighbour tile's nodeAttrs arrive →
  barrier/crossing multipliers missed for those edges). Small, not a crash.
- **`scripts/lint.sh` prints "eslint not installed" and this session couldn't
  run the pinned 9.x** (no network for npm ci) — the gate was run with global
  eslint 10.1.0 + the repo config instead, clean. Worth confirming CI fails
  (not passes) when eslint is missing.

## UI findings (report-only, from the UI pass)

1. Default Leaflet chrome (zoom control, layer switcher, attribution) is
   unstyled stock white over the dark theme — reads as an oversight.
2. `.banner-retry` / `.info-banner-action` tap targets ~18–20 px tall with no
   `::before` hit-extender — the two outliers from the file's own pattern,
   on exactly the error-recovery buttons.
3. Side menu (`role="dialog"`) has no focus management (no focus-in on open,
   no return on close, no trap).
4. Primary toolbar buttons are ~37×40 px, a few px under the ~44 px
   guideline. Low confidence it matters on real devices.
5. `.elevation-stats` label contrast computes 4.45:1 vs the 4.5:1 AA
   threshold — marginal, likely fine over blur.

## Needs a manual check (can't verify headlessly)

- **Water visibility fix** (`grayscale(0.4)` on the street layer): chosen by
  palette math (water-vs-urban ΔRGB +26%, land byte-identical); eyeball it
  in Singapore/Perth on a real phone. If water still reads weak, 0.2–0.3
  pushes further at the cost of a visible warm/green cast on buildings/parks.
- **Deploy steps for the worker changes:** `wrangler d1 migrations apply
  legwork-links --remote` (new hash index), then deploy — the `g2:` key
  bump means a cold graph cache (first fetch per cell re-hits Overpass).
- iOS standalone GPX export (carried forward from June, still untested).

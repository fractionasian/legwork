@~/.claude/principles/coding.md

# Legwork — running and cycling route planner (legwork.day)

> **DRAFT 2026-11-11, not yet reviewed by Peter.** Written by Claude from the code
> and `docs/`. Each line is tagged with where it came from:
> **[doc]** a dated decision in `docs/`, **[code]** a comment or constant in the
> source, **[commit]** a commit message, **(inferred)** my reading with no
> statement behind it. Peter removes the tags as he confirms each line.

**Read this before touching anything.** If behaviour has moved and this file has
not, fix this file in the same commit.

## What it is

Drop pins on a map and Legwork snaps a route to real paths, colours it by
gradient, and hands back a GPX file or a share link. Loop, out-and-back or
one-way; run or bike. No account, no ads. It works offline once a city's tiles
are cached. (inferred from the app and `docs/show-hn-draft.md`)

## How it is built

- **Client:** plain JavaScript in classic `<script>` tags sharing one global
  scope. No build step, no framework. Leaflet, leaflet-hotline and Chart.js
  load from CDNs at pinned versions. Hosted on GitHub Pages, which publishes
  every push to `main`. [code]
- **Worker** (`worker/`): Cloudflare Worker with D1 and R2. Caches Overpass
  graph fetches (`/v1/graph`), takes analytics events (`/v1/event`), and
  stores short links (`/api/links`, `/api/vanity`). [code]
- **Path tiles:** pre-baked per city in the separate `legwork-tiles` repo,
  rebuilt weekly. Anywhere else loads live from Overpass. [doc 2026-10-01]
- **Checks:** `npm test` and `npm run lint` in the root, and the Worker's own
  tests in `worker/`. Use the `verifier-legwork` skill to drive the real app.

## Invariants — do not drift

### Privacy

- **Nothing reaches D1 finer than the 0.005° grid (about 500 m), no raw
  distance, and no per-user identifier.** Every stored value is an enum or a
  bucket. [code, `worker/src/analytics-lib.js`]
- **The "What Legwork counts" text in the menu must stay true.** A new event
  or property changes that text in the same commit. [commit 2df484c] (the
  same-commit rule is inferred)
- **No third-party analytics script.** Umami was the last one and is gone.
  [code]
- **No account, no cookies, no device ID.** [code, menu text]

### Routing

- **Routing rules live in `routing.js` and are shared by the app and the tile
  builder.** A rule written in only one of them makes baked cities and live
  areas route differently. [doc 2026-10-01]
- **A new graph field only reaches baked cities at the next tile build.**
  Until then only live Overpass areas have it, and old cached tiles must still
  route. [doc 2026-10-01, climb doc]
- **Re-derive `MIN_EDGE_MULTIPLIER` whenever a road weight or preference
  multiplier changes.** If any multiplier drops below what it assumes, routes
  go quietly suboptimal with no error. [code, `routing.js`]
- **Preferences are hidden.** Road-type weights, climb (8) and turn cost (15)
  have no slider and nothing to explain. `?climb=0` and `?turn=0` exist for
  comparison only. [doc, climb-aware-routing]
- **A missing height never fails a route or a build.** The area routes as it
  did before climb-aware routing. [doc, climb-aware-routing]
- **A pin snaps only to a path within 200 m.** One rule for every snap: drop,
  drag, shared route. [code, `app.js`]
- **A pin that fails to snap is skipped, and the app keeps saying so.**
  [commit e356c67]
- **Bike: riding against a one-way costs 4×; run ignores one-ways.**
  [doc 2026-10-01]
- **Reversing a loop keeps the start where it is.** [commit d5aa130]

### Offline and caching

- **Never hand-edit `CACHE_NAME` in `sw.js`.** CI bumps it, and only after
  lint and tests pass. [code, `bump-sw.yml`]
- **Map and path tile caches survive an app update.** Only the app shell is
  evicted on a bump. [code, `sw.js`]
- **No opaque tile caching.** A base layer is cached offline only if its host
  sends CORS headers. Street does; satellite and terrain are unverified.
  [doc 2026-10-01]
- **A city whose tile build fails keeps its previous tiles.** [commit 8757032]

### Worker

- **Order is migrations, then Worker, then client.** Keep every `/v1/event`
  change additive so an old client or an old Worker drops nothing.
  [doc 2026-08-30, `deploy-worker.yml`]
- **Count the D1 row-writes before adding an index** to `events`, `demand` or
  `links`. The free tier is 100,000 a day across the account; workings are in
  `worker/wrangler.toml`. [doc 2026-10-01]
- **Short links never expire.** A TTL would break links already shared. New
  links are capped at 500 per rolling 24 h. [doc 2026-10-01]

### Interface

- **Toilet and water toggles stay in the side menu.** If that proves too slow,
  build a contextual chip near the distance pill, never a FAB.
  [doc 2026-04-23]
- **Undo cannot remove the last pin.** [doc 2026-06-10]
- **Pinch zooms the map, never the page** (`user-scalable=no`).
  [doc 2026-06-10]
- **Share and Shorten live only in the pill dropdown.** [doc 2026-06-10]
- **The elevation stats bar is always on; the chart slides up from it.**
  [commit 94b9083]

## Deliberately not built

| Not built | Why | Source |
|---|---|---|
| Social feed, leaderboards, segments, saved-route folders, training analytics | Other apps do these; Legwork hands over a route and gets out of the way | Peter, 2026-11-11 (first written in `show-hn-draft.md`) |
| Turn-by-turn navigation, live re-routing | Stays the "plan a loop near me" tool | [doc, route-preferences §2] |
| Popularity or heatmap weighting, learned preferences | Needs user data Legwork does not collect | [doc, route-preferences §2] |
| Routes that detour toward water fountains | Annoying; add a pin instead | [doc, route-preferences §4.3] |
| A TTL on short links | See Worker, above | [doc 2026-10-01] |
| A FAB for map layers | See Interface, above | [doc 2026-04-23] |

## Known stale docs

- `docs/design/route-preferences.md` §2 says "no bike modes" and §4.3 rules out
  avoiding climbs. Both have since shipped (bike profile; climb-aware routing,
  on by default since 2026-10-06). The code and `climb-aware-routing.md` win.
- `docs/design/climb-aware-routing.md` says in one place that only Perth has
  heights and the default is off, and in its status line that all 12 cities
  have them and it is on. The status line is the current one.

## Open items live elsewhere

The three `docs/*-review-deferred.md` files hold what was deliberately left and
what would trigger picking each up. Read the newest first; later files do not
repeat earlier ones.

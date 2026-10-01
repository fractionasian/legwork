# Deferred items — 2026-10-01 review

Three-agent review pass (app.js; routing/tiles/storage/SW/CI; Worker). Findings
were spot-checked against the code before fixing. Everything below was
deliberately NOT done. Each item says why, and what would trigger picking it up.
Items already in the 06-10 and 08-30 docs are not repeated here.

## Base map offline caching: done for street; satellite and terrain still open

Researched 2026-10-01. The review container's proxy blocks all three tile
hosts, so none of these headers were observed live.

- **OSM (street, the default layer): shipped `crossOrigin: true`.** OSM's own
  production config sets `Access-Control-Allow-Origin: *` on every tile
  response (`openstreetmap/chef`, `cookbooks/tile/templates/default/apache.erb`,
  last changed 2026-09-30). That holds for both the Fastly-fronted vhost and
  the direct one.
- **Esri satellite: likely, unverified.** A search snippet reports that the
  ArcGIS JS API lists `server.arcgisonline.com` as a CORS-enabled server by
  default. That's second-hand, and the source wasn't readable from here.
- **OpenTopoMap terrain: likely NO.** In the project's own setup guide, the
  CORS line is commented out (`mapnik/HOWTO_Ubuntu_18.04`:
  `# Header set Access-Control-Allow-Origin "*"`). There is also a public
  report of `c.tile.opentopomap.org` failing for lack of CORS.
- **Opaque caching is ruled out.** Chrome counts each cached opaque response
  as at least ~7 MB of quota (Chrome Workbox docs, "Understanding storage
  quota"), so 1,000 tiles would claim ~7 GB.
- Changes if: Esri or OpenTopoMap start or stop sending the header.
- Re-check: before enabling either layer. Load the app, switch to the layer,
  and look for `access-control-allow-origin` on a tile in DevTools → Network.

## Product decisions

- **The bike profile ignores one-way streets.** Researched 2026-10-01.
  - Every edge is added in both directions, and `oneway`, `oneway:bicycle`
    and `cycleway=opposite*` are neither fetched nor kept.
  - OSRM's bicycle profile (`profiles/bicycle.lua`) does NOT forbid riding
    against a one-way. It turns that direction into "pushing bike" at walking
    speed (4 km/h, roughly 4× the cost). The exceptions are implied one-ways
    (roundabouts, motorways), which stay closed.
  - OSRM's override order: `oneway:bicycle=no` (or a `cycleway=opposite*`
    lane) first, then `oneway:bicycle=yes`, then plain `oneway`.
  - Matching that in Legwork:
    - Multiply the reverse edge's weight by about 4 for the bike profile.
      A multiplier ≥ 1 keeps A* admissible.
    - Drop the reverse edge entirely for roundabouts.
    - No change for the run profile: one-ways don't bind pedestrians.
  - Cost:
    - The tile compact format needs a field for the one-way tags, plus a
      rebuild of every city's tiles.
    - The rebuild needs Overpass access, which the review container doesn't
      have.
    - About 2–3 hours of Claude time plus the rebuild run.
- **Short links still never expire.** The new global cap (500 new rows per
  rolling 24 h, `DAILY_LINK_CAP` in links-db.js, agreed 2026-10-01) bounds
  abuse growth to about 8 MB/day. Adding a TTL would break links people have
  already shared. Revisit if the links table actually grows.
  - The cap's cost: a sustained flood pauses link creation for everyone until
    the window rolls over (503 → the client copies the full link instead).
    Re-shares of an existing route still dedup and are unaffected.

## D1 write budget: confirmed over the cap

Cloudflare's D1 docs ("Use indexes", via search, 2026-10-01) say each index on
a written column adds one more row written. Billed per day from one IP, per
colo:

| Source | Ceiling | Rows each | Billed rows/day |
|---|---|---|---|
| events | 43,200 | 3 | 129,600 |
| demand | 7,200 | ≤3 | ≤21,600 |
| links | 500 | ≤5 | 2,500 |
| **Total** | | | **≈153,700** |

That is above the free tier's 100k/day account-wide cap. (The 08-30 "503 rows
written for 283 events" pairs a 24 h figure with an all-time table count, so
it says nothing about the multiplier.)

Options, cheapest first:
1. **Drop `idx_events_ts`.** Its only user is the weekly
   `DELETE … WHERE ts < ?`, which can scan the small table instead.
   Events go to 2 rows each, and the total drops to about 110k.
2. **Lower `EVENT_RL` from 30 to 15 per minute.** With (1), the total is about
   67k.
3. **Paid Workers plan** (50M rows written per month included).

- Changes if: Cloudflare changes how D1 counts rows written.
- Re-check: whenever a migration adds or drops an index.

## Verify, then maybe act

- **Deploy secrets.** `deploy-worker.yml` needs `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`. Migration 0004 (`idx_links_created`) must apply
  before the new Worker code runs; the workflow already does migrations first.

## Small, left as-is

- `scripts/verify-elevation.mjs` isn't in the `node --test` discovery, so CI
  never runs it.
  - Its "real-data gain" test has an empty fixture and passes vacuously.
  - Its comments describe median-9; the code uses median-3.
- `npx eslint scripts/build-tiles.js` reports a parse error: a top-level
  `return` in CommonJS, which Node accepts. The lint gate doesn't cover
  `scripts/`.
- Duplicate helpers in app.js:
  - `inlineInputFallback` duplicates `copyText`'s fallback.
  - `setMarkerState` duplicates `updateMarkerNumber`.
  - Harmless; fold them together next time either is touched.
- `poiIcon` puts `amenity` into a class attribute unescaped. That's safe only
  while the Overpass query stays restricted to `toilets|drinking_water` and
  the baked POI file stays first-party.

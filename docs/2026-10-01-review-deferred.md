# Deferred items — 2026-10-01 review

Three-agent review pass (app.js; routing/tiles/storage/SW/CI; Worker). Findings
were spot-checked against the code before fixing. Everything below was
deliberately NOT done. Each item says why, and what would trigger picking it up.
Items already in the 06-10 and 08-30 docs are not repeated here.

## Needs a real-browser check before shipping

- **The base map isn't cached for offline use.** The street, satellite and
  terrain layers load as no-cors images. The service worker only caches
  `resp.ok` responses, and those come back opaque (status 0), so they are never
  stored. Offline, you get route lines over a blank map.
  - The fix is `crossOrigin: true` on the three `L.tileLayer` calls (app.js
    ~192–207). But if a tile host sends no `Access-Control-Allow-Origin`
    header, that layer stops loading entirely.
  - Couldn't verify this from the review container: its proxy blocks all
    three hosts. A web search turned up reports of OpenTopoMap tiles failing
    for lack of CORS.
  - Check each layer in DevTools, look for an `access-control-allow-origin`
    header on its tiles, and enable the option only on layers that send it.
  - Don't cache the opaque responses instead: Chrome pads each opaque cache
    entry to several MB of quota, so 1,000 tiles would blow the storage budget.

## Product decisions

- **The bike profile ignores one-way streets.** Every edge is added in both
  directions, and `oneway` / `oneway:bicycle` are neither fetched nor kept, so
  cycling routes can go the wrong way up a one-way street or a trunk_link ramp.
  - Fix: carry `oneway` through the tile compact format and the Overpass
    path, and skip the reverse edge when profile = bike.
  - The fix needs a tile rebuild, and `oneway:bicycle=no` contraflow lanes
    have to be honoured.
- **Short links still never expire.** The new global cap (500 new rows per
  rolling 24 h, `DAILY_LINK_CAP` in links-db.js) bounds abuse growth to about
  8 MB/day. Adding a TTL would break links people have already shared. Revisit
  if the links table actually grows.
  - The cap's cost: a sustained flood pauses link creation for everyone until
    the window rolls over (503 → the client copies the full link instead).
    Re-shares of an existing route still dedup and are unaffected.

## Verify, then maybe act

- **D1 row-write multiplier.** The write budget in wrangler.toml counts one
  write per INSERT. If D1 bills each secondary-index update as a further row
  written, the `events` line is ~2–3× larger. The live figure (503 rows written
  for 283 events in 24 h) suggests it might. Check Cloudflare's D1 pricing page,
  and if it does, lower `EVENT_RL` or drop an index on `events`.
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

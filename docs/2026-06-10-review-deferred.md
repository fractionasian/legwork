# Deferred items — 2026-06-10 codebase review

The full-codebase review (4-agent pass: client correctness, worker security,
repo-wide security sweep, UI/UX) shipped ~18 commits closing everything urgent.
These items were deliberately NOT done. Each lists why, and what would trigger
picking it up.

## Needs a manual check (can't verify headlessly)

- **iOS standalone GPX export.** The blob-anchor download (`exportGPX`,
  app.js) is historically flaky in `display-mode: standalone` on iOS. Test
  once on an installed PWA; if it misbehaves, switch to
  `navigator.share({ files: [gpxFile] })` — the better mobile path anyway
  (shares straight into Strava/Garmin apps).

## Accepted-risk security notes (revisit only if threat model changes)

- **Umami script has no SRI** (`cloud.umami.is/script.js` rotates, so SRI is
  impractical). CSP path-pinning limits blast radius to that one file.
  Closing it fully means self-hosting the tracker script. Pickup trigger:
  any report of Umami CDN compromise, or if analytics ever expands.
- **Clickjacking is unmitigable via meta CSP** (`frame-ancestors` ignored in
  `<meta>`; GH Pages can't send headers). No auth, no destructive one-click
  actions → negligible impact. The only option is a JS framebust
  (`if (top !== self) top.location = self.location`) if it ever matters.
- **`adminOk` comparison is not constant-time** (index.js). Impractical to
  exploit over the network through Cloudflare. Note only.
- **test.html is deployed** at legwork.day/test.html. Content is benign
  (static unit tests, no network calls, no secrets). Delete or exclude at
  preference.

## Cost/scale backstops (revisit when traffic justifies)

- **R2 lifecycle expiry rule** for the graph cache bucket. Radius bucketing
  (shipped) caps key cardinality, but objects still never expire. A
  dashboard-side lifecycle rule (expire after N days) is the backstop —
  config, not code. Pickup trigger: R2 storage trending toward the free-tier
  cap.
- **Random short-links never expire.** Dedup (shipped) cuts organic growth
  substantially; there is still no TTL/cleanup path for stale rows. Pickup
  trigger: D1 row count growing meaningfully (check via admin/Cloudflare
  dashboard after launch).
- **sw.js API-fallthrough branch** caches every unique Photon autocomplete
  URL into CACHE_NAME, unbounded between deploys. Harmless at current scale
  (the cache is wiped on every shell bump). Pickup trigger: long-lived
  deploys + heavy autocomplete use; fix is a cap or an exclusion for
  photon.komoot.io.

## Deliberate UX non-changes

- **Cmd+Z can't remove the last waypoint** (`length > 1` guard) while
  tap-delete can remove any. Kept: preserving a start point is plausible
  intent, and changing it is one keystroke from emptying the map. Revisit
  only if it generates real confusion.
- **`user-scalable=no`** is acceptable for a map app — pinch must go to the
  map, not page zoom.
- **Share/Shorten live only in the pill dropdown** (not duplicated into the
  side menu like Save/Export). Minor asymmetry; the dropdown is the share
  surface. Revisit if share discoverability proves weak post-launch.

# Popular routes nearby — design spec

A curated list of well-known runs/walks in the user's current city,
shown as a "🔥 Popular routes nearby" entry. The Strava-discovery
moment, without Strava's data.

Author: Claude (drafted from Peter's request, 2026-04-26).
Status: Spec — not implemented.

## 1. Goal

When a user opens Legwork in Adelaide for the first time, they want to
know "where do people run here?". Strava's heatmap answers that with
trillions of GPS points; we don't have that data and can't get it.
Instead we curate.

For each supported city we ingest 10–30 routes from public sources
(council pages, parkrun courses, Heart Foundation Walks, Trails WA,
similar) and bake them into the city tile. The user opens a side-menu
entry and sees a list of named routes, with a one-tap "Use this route"
that loads it into the planner exactly like a saved route.

This is a *discovery* feature. It complements but does not replace the
route-recommender's 🔥 Popular chip (which is a *scoring* feature
operating on OSM-derived proxies).

## 2. Non-goals

- Not a heatmap visualisation. We don't have the data.
- Not a community upload feature. No backend, no user accounts.
- Not editorial route-blogging. Each entry is a route + minimal
  metadata; the source page does the storytelling.
- Not coverage of every Australian city day-one. Curation is manual;
  start with cities Peter knows or where parkrun coverage is dense.
- Not real-time popularity. The list is static between tile rebuilds.

## 3. Why curated, not crowdsourced or scraped

| Source | Why we're not using it |
|---|---|
| Strava heatmap / API | ToS forbids scraping; OAuth ties us to Strava users. |
| OSM GPS traces | Free + legal, but signal is mapper-biased and weak in Australia. |
| Our own crowdsource | Requires backend, privacy review, and a year of cold-start. |
| Komoot / AllTrails | ToS forbids redistribution. |
| **Council / parkrun / Heart Foundation pages** | Publicly published, often explicitly licensed for reuse, naturally curated. |

Curation gives us: high signal-to-noise per city, clean licensing, and
a feature on day one. It costs us: per-city manual effort, refresh
cadence (years, not days), and a coverage gap outside curated cities.

## 4. Data shape

Each route is a small JSON object baked into the city tile (or
adjacent tile asset):

```json
{
  "id": "perth-city-foreshore-loop",
  "name": "Perth Foreshore Loop",
  "distance_km": 5.2,
  "loop": true,
  "geometry": [[lon, lat], [lon, lat], ...],
  "source": {
    "name": "City of Perth",
    "url": "https://www.perth.wa.gov.au/...",
    "licence": "CC-BY-4.0"
  },
  "tags": ["river", "city", "flat"],
  "blurb": "Loop along the Swan foreshore via Elizabeth Quay.",
  "added": "2026-04-26"
}
```

Notes on fields:

- **`geometry`**: a polyline in `[lon, lat]` order, matching Leaflet's
  expectation when reversed. Resolution ~10 m between points;
  Douglas-Peucker simplified at ingest time. A typical 5 km route
  is 200–500 points = ~10 KB raw.
- **`tags`**: free-form string tags for filtering. Curated vocabulary:
  `river`, `coast`, `forest`, `city`, `hills`, `flat`, `family`,
  `parkrun`, `heritage`. Used for the chip-style filter row in §6.
- **`source`**: must always be populated. The "Open original" link is
  shown in the route detail view — both for attribution and as an
  out-link if the user wants the council's narrative.
- **`licence`**: tracked per route. We refuse to ingest anything
  without a clear redistribution clause (see §8.1).
- **`distance_km`** + **`loop`**: pre-computed at ingest, so the list
  view doesn't need to walk geometry to show stats.

## 5. Ingestion pipeline

Per supported city:

1. **Source discovery.** Manually identify candidate sources:
   council "active travel" pages, parkrun event pages, Heart
   Foundation Walks, Trails WA, Bicycle Network, similar. Document
   the list in `data/curated/<city>/sources.md`.
2. **Licence check.** Each source's licence terms are recorded.
   Reject anything that prohibits redistribution or modification.
   Heart Foundation Walks is CC-BY-NC-SA; parkrun GPX files are
   permissively shared; council GPX/KML varies.
3. **Format conversion.** Source files are GPX, KML, or screen-scraped
   coordinates. A `scripts/ingest-curated.js` helper converts them to
   the schema in §4, applies Douglas-Peucker simplification at 5 m
   tolerance, and writes a per-city JSON.
4. **Manual review.** Peter eyeballs each route on the map (a small
   dev preview HTML page) and either accepts, edits the blurb, or
   rejects. Editorial filter — we don't ship every council route, just
   the good ones.
5. **Tile bake.** `build-tiles.js` bundles the curated routes into the
   city tile under a new `curatedRoutes` key, version-bumped.

Refresh cadence: when Peter remembers, or when a council adds new
trails. Quarterly is fine. Stale routes are not a quality risk because
the underlying paths rarely change.

## 6. UX surface

### 6.1 Entry point

Side menu entry beneath the existing toggles:

```
  🚻 Toilets
  💧 Drinking water
  🗺️ Prefer scenic routes
  ─────────────────────
  🔥 Popular routes nearby   ›
```

Tapping opens a **list sheet**, not a modal — the map stays visible so
the user can preview each route on hover/tap.

### 6.2 List view

```
  ┌──────────────────────────────────────┐
  │ Popular routes near you              │
  │                                      │
  │  Filter: [All] [parkrun] [river]…    │
  │                                      │
  │  Perth Foreshore Loop      5.2 km ↻  │
  │  Loop along the Swan foreshore…      │
  │  via City of Perth                   │
  │ ──────────────────────────────────── │
  │  Kings Park Law Walk        3.8 km ↻ │
  │  Heritage trail through Kings Park.  │
  │  via BGPA                            │
  │ ──────────────────────────────────── │
  │  Claisebrook Cove parkrun   5.0 km ↻ │
  │  …                                   │
  └──────────────────────────────────────┘
```

Each item shows: name, distance, mode glyph (loop / out-and-back /
one-way), 1-line blurb, source attribution. Tap → preview on map. Tap
again or "Use this route" → loads it into the planner.

### 6.3 Loaded as a planner route

A loaded curated route becomes a normal multi-waypoint route in the
existing data model — anchor nodes are placed along the polyline, the
user can drag any of them to nudge, save it as their own, share it,
or export GPX. The "via Council of Perth" attribution persists in the
saved-route metadata.

### 6.4 No coverage state

Cities without curated data show an empty state:

```
  No curated routes for Subiaco yet.

  Try the route planner instead:
  ✨ Plan a route from here
```

Linking directly to the recommender. This is the natural fallback —
Shape 1 (recommender) covers the long tail, Shape 2 (curated) covers
the well-known cities.

## 7. Coverage strategy

Day-one cities (mirroring `data/cities.json`'s pre-cached set):

1. **Perth** — most Heart Foundation Walks coverage in WA, parkrun
   density, multiple council route pages. Probably 25–30 routes.
2. **Fremantle** — ~10 routes, heritage trails dominate.
3. **One Eastern-states city** — Melbourne or Sydney, to validate
   the pipeline isn't Perth-shaped.

Cities 4+ are added opportunistically as Peter (or contributors) can
ingest them.

## 8. Risks and open questions

### 8.1 Licensing

Different sources have wildly different licences. Heart Foundation
Walks is CC-BY-NC-SA — which restricts commercial use. Legwork is
free and open-source, so NC is fine for now, but if Legwork ever
adds a paid tier we'd have to drop those routes. Council GPX files
are usually unmarked; we treat unmarked as "ask permission" not
"public domain". Each source needs a per-source decision and the
licence string travels with the data.

### 8.2 Source link rot

Council CMS migrations break URLs. Routes themselves don't break —
the geometry is intact — but the "via X" out-link does. Mitigation:
the link is a nicety, not core. A broken link degrades to a plain
attribution string.

### 8.3 Curation bias

Editorial curation means Peter's taste defines "popular" in v1.
That's fine for a small set of cities; it doesn't scale. If
contributor-driven curation becomes interesting, structure the
ingestion so a PR can add a city without core changes — keep curated
JSON in `data/curated/<city>/routes.json` and have `build-tiles.js`
glob over them.

### 8.4 Overlap with recommender

A user looking at the curated list and the recommender's 🔥 Popular
chip might wonder which is "the popular routes". They serve different
needs:

- **Curated list**: "show me what locals run". Editorial, fixed,
  named.
- **🔥 Popular chip**: "synthesise me a 7 km route that prefers
  popular corridors". Generative, distance-controlled, infinite.

The side-menu wording ("Popular routes nearby") and the recommender
chip wording ("Popular corridors") should be different enough that
this is rarely confusing in practice.

### 8.5 Parkrun naming + IP

"parkrun" is a registered trademark with strict usage rules. If a
curated route is officially the Claisebrook Cove parkrun, name it
that with care: "Claisebrook Cove parkrun course" is descriptive and
accurate. Don't imply endorsement.

### 8.6 Tile size growth

Adding ~25 curated routes × ~10 KB = 250 KB per Perth-class city
tile. Current tile is ~1.5 MB; this is +17%. Acceptable but worth
gzipping and considering whether curated routes should be a separate
fetch (lazy-loaded only when the side-menu entry is opened). Lazy
load is probably the right call:

- `data/tiles/perth.json` — paths + POIs (existing).
- `data/curated/perth.json` — curated routes (new, lazy).

The curated JSON is fetched on first open of the side-menu entry,
cached in `localStorage` like the existing tiles.

### 8.7 Cold-start cities

If we ship without enough cities curated, the side-menu entry shows
the empty state to most users — possibly a worse experience than not
having the entry at all. Mitigation: only show the entry when the
user is in a curated city (matched via `data/cities.json` like the
existing tile resolver). Outside a curated city, the entry is
hidden.

### 8.8 Refresh cadence honesty

A "Last updated" line on the list view ("Routes refreshed 2026-04-26")
is honest about staleness. Skip if it makes the UI fiddly; revisit if
users complain.

## 9. Phasing

### Phase 1 — Pipeline + Perth (~150 LoC + ingestion effort)

- Ingest helper (`scripts/ingest-curated.js`) — GPX/KML → schema.
- Curated JSON format + per-city directory.
- `build-tiles.js` extension to bundle curated JSON per city.
- Lazy fetch from `app.js` on side-menu entry open.
- List sheet UI + filter chips.
- "Use this route" handoff into planner.
- Ingest 25 Perth routes by hand.

### Phase 2 — Coverage (no engineering)

- Ingest Fremantle (~10 routes).
- Ingest one Eastern-states city.
- Tag vocabulary refinement based on what real routes need.

### Phase 3 — Polish (optional)

- Map-preview-on-hover in the list sheet.
- Per-route elevation profile (reuse existing component).
- "Did you do this route?" → soft prompt to save it as personal.
- Contributor docs for adding a new city.

## 10. Acceptance criteria (Phase 1)

- 25 routes ingested for Perth, all rendering correctly on the map.
- Each route has a non-empty `name`, `source.url`, `licence`.
- Side-menu entry only visible inside curated cities.
- Loading a curated route into the planner produces a route the user
  can save, share, and export as GPX, indistinguishable from a
  manually planned one.
- Curated tile asset adds < 300 KB to the lazy fetch.
- Attribution is visible both in the list ("via City of Perth") and
  in the saved-route metadata.

## 11. Future extensions (not in this spec)

- **Map heatmap layer** — if we ever build a backend and crowdsource
  routes, that data slots into a separate heatmap-tiles asset and
  layers visually under the curated list.
- **OSM GPS traces** as a heatmap fallback for non-curated cities.
  Free and legal but signal-weak; probably not worth it.
- **User-submitted curated routes** via PR. Would need a JSON schema
  validator + a city-bootstrap CLI; doable when contributor demand
  exists.
- **Strava OAuth** as a personal-routes source. Different scope —
  it's "your own routes", not "popular routes".
- **Multi-city bundles** — "best running cities in Australia"
  marketing collateral driven from this data.

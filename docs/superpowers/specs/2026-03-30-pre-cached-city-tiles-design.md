# Pre-cached City Tiles

## Context

Legwork is a client-side running route planner on GitHub Pages. It currently fetches path data from Overpass API on every visit, which is slow (~10s for a metro area), flaky (rate-limited, sometimes down), and requires an internet connection. The app already has IndexedDB caching (added 2026-03-29), but first visits to any area still hit Overpass.

**Goal:** Pre-download and tile the path network for configured cities. Serve tiles as static files from GitHub Pages so first-time users in those cities get near-instant loading with no Overpass dependency. Show suburb names during loading for a polished UX.

## Data Profile (Perth metro, measured)

- Bounding box: -32.15, 115.65 to -31.75, 116.05 (~45x35km)
- 184,058 ways, 888,157 nodes
- Raw Overpass JSON: 122 MB
- Converted GeoJSON: ~32 MB
- Gzipped: ~8 MB
- Split into 64 tiles (~5.5km each): ~125 KB gzipped per tile avg
- 5km radius load (4-9 tiles): ~1 MB, <1s on 4G

## Architecture

### 1. City Configuration (`data/cities.json`)

Owner-editable list of cities to pre-cache.

```json
[
  {
    "id": "perth",
    "name": "Perth",
    "bounds": [-32.15, 115.65, -31.75, 116.05]
  },
  {
    "id": "melbourne",
    "name": "Melbourne",
    "bounds": [-37.95, 144.75, -37.65, 145.15]
  }
]
```

Adding a city: edit this file and push. The weekly build generates tiles automatically.

### 2. Build Script (`scripts/build-tiles.js`)

Node.js script, runs in GitHub Actions. No browser dependencies.

For each city in `cities.json`:
1. Query Overpass API with the city's bounding box for all 18 highway types (footway, cycleway, path, residential, living_street, pedestrian, service, unclassified, tertiary, tertiary_link, secondary, secondary_link, primary, primary_link, trunk, trunk_link, crossing, steps)
2. Convert raw OSM JSON to the app's GeoJSON format (same `osmToGeoJSON` logic)
3. Split features into ~5.5km grid tiles based on feature centroid
4. For each tile, reverse geocode the centre via Photon to get suburb names
5. Write tiles to `data/tiles/{cityId}/{row}_{col}.json`
6. Write `data/manifest.json` with full tile index

Rate limiting: 1s delay between Photon reverse geocode calls. Overpass queries use 60s timeout.

### 3. Generated Manifest (`data/manifest.json`)

```json
{
  "built": "2026-03-30T02:00:00Z",
  "version": "abc123",
  "cities": {
    "perth": {
      "name": "Perth",
      "bounds": [-32.15, 115.65, -31.75, 116.05],
      "tileSize": 0.05,
      "grid": [8, 8],
      "tiles": [
        {
          "file": "0_0.json",
          "bounds": [-32.15, 115.65, -32.10, 115.70],
          "suburbs": ["Joondalup", "Currambine"],
          "ways": 2134
        }
      ]
    }
  }
}
```

`version` is a short hash of the manifest content, used for cache busting.

### 4. GitHub Actions Workflow (`.github/workflows/build-tiles.yml`)

- **Schedule:** Weekly, Sunday 02:00 UTC (10:00 AWST)
- **Manual trigger:** `workflow_dispatch` for on-demand builds
- **Steps:**
  1. Checkout repo
  2. Run `node scripts/build-tiles.js`
  3. If any files changed: commit to `main` and push
  4. If nothing changed: skip commit
- **Timeout:** 30 minutes (Overpass can be slow)

### 5. App Integration (`app.js`)

#### Boot sequence (after geolocation)

1. Fetch `data/manifest.json` from GitHub Pages
2. Find which city (if any) contains the user's location
3. If city match:
   - Select tiles within 5km radius of user
   - Check IndexedDB for each tile (keyed by `{cityId}/{row}_{col}` + manifest version)
   - For uncached tiles: fetch from GitHub Pages in parallel
   - Banner: `"Loading Maylands, Bayswater, Mount Lawley..."` (suburb names from manifest)
   - As tiles arrive: `applyPaths()` incrementally, update banner `"Loaded 4/7 areas"`
   - Seed IndexedDB with each tile
4. If no city match: fall back to Overpass (current behaviour)

#### Cache invalidation

- Each tile cached in IndexedDB is keyed with the manifest `version`
- On boot, if manifest version differs from cached version, re-fetch all tiles for that city
- Old-version tiles cleaned up on next boot

#### Interaction with existing features

- "Save Area" button: still works for ad-hoc areas outside cached cities
- "Saved Routes": unchanged, stores full route data independently
- Live Overpass: still used when routing needs gap-filling or user is outside all cities

### 6. City Request Flow (user-facing)

When a user geolocates outside all cached cities:
1. After Overpass fallback loads, show a subtle banner link: `"Want faster loading here? Request this city"`
2. Clicking opens a pre-filled GitHub Issue:
   - Title: `City request: {reverse-geocoded city name}`
   - Body: `Bounding box: {computed bbox around user location}`
   - Labels: `city-request`
3. Peter reviews, adds to `cities.json`, pushes. Next build picks it up.

### 7. Analytics (Plausible)

Add Plausible analytics script to `index.html`:
- Privacy-focused, no cookies, GDPR-compliant
- Captures city-level geographic data from visitors
- Peter checks the dashboard periodically to identify popular uncached cities
- Free tier (10k pageviews/month) is sufficient

### 8. Loading UX Detail

```
[Geolocation resolves to Maylands, Perth]
  ↓
[Manifest fetched — Perth city found]
  ↓
[5km radius → tiles 3_4, 3_5, 4_4, 4_5, 5_4, 5_5 selected]
  ↓
[Banner: "Loading Maylands, Bayswater, Mount Lawley, Bassendean, Bedford, Morley..."]
  ↓
[Tiles arrive in parallel, applyPaths() on each]
[Banner updates: "Loaded 2/6 areas..."]
  ↓
[All tiles loaded]
[Banner clears, graph ready, first waypoint placed]
```

For returning users with cached tiles: no banner, instant load.

## Files to Create

| File | Purpose |
|------|---------|
| `data/cities.json` | City configuration (owner-editable) |
| `data/manifest.json` | Generated tile index with suburbs |
| `data/tiles/{cityId}/*.json` | Pre-built GeoJSON tiles |
| `scripts/build-tiles.js` | Build script (Overpass → tiles) |
| `.github/workflows/build-tiles.yml` | Weekly cron workflow |

## Files to Modify

| File | Changes |
|------|---------|
| `app.js` | Tile loading on boot, suburb banner, cache versioning, city request link |
| `index.html` | Plausible analytics script tag |
| `.gitignore` | Ensure `data/tiles/` is NOT ignored (must be committed) |

## Verification

1. **Build script:** Run `node scripts/build-tiles.js` locally. Check `data/tiles/perth/` has 64 JSON files. Check `data/manifest.json` has suburb names.
2. **Tile loading:** Open app, verify it fetches tiles from GitHub Pages (not Overpass). Check Network tab — requests should be to `data/tiles/perth/*.json`.
3. **Suburb banner:** Verify loading banner shows suburb names, updates with progress count.
4. **Cache hit:** Reload page — verify no network requests for tiles (served from IndexedDB).
5. **Outside Perth:** Spoof geolocation to Melbourne — verify Overpass fallback works and "Request this city" link appears.
6. **GitHub Actions:** Push a change to `cities.json`, verify workflow runs and commits updated tiles.

# Pre-cached City Tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-download OSM path data for Perth and Melbourne, serve as static tiles from GitHub Pages, and load them on boot with suburb-level loading UX.

**Architecture:** A Node.js build script queries Overpass for each configured city, splits results into ~5.5km GeoJSON tiles with suburb metadata, and writes them to `data/tiles/`. GitHub Actions runs this weekly. The app fetches the manifest on boot, loads nearby tiles from GitHub Pages (not Overpass), and shows suburb names during loading.

**Tech Stack:** Node.js (build script), GitHub Actions (CI), Plausible (analytics), IndexedDB (client cache), existing Leaflet/Chart.js app.

**Spec:** `docs/superpowers/specs/2026-03-30-pre-cached-city-tiles-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `data/cities.json` | Owner-editable city config (id, name, bounds) |
| `data/manifest.json` | Generated tile index with suburb names, way counts, version hash |
| `data/tiles/{cityId}/{row}_{col}.json` | Pre-built GeoJSON tile files |
| `scripts/build-tiles.js` | Build script: Overpass query → GeoJSON conversion → tiling → manifest |
| `.github/workflows/build-tiles.yml` | Weekly cron + manual trigger workflow |
| `app.js` | Modified: tile loading on boot, suburb banner, city request link |
| `index.html` | Modified: Plausible script tag |

---

### Task 1: City Config and Build Script Foundation

**Files:**
- Create: `data/cities.json`
- Create: `scripts/build-tiles.js`

- [ ] **Step 1: Create city config**

Create `data/cities.json`:

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

- [ ] **Step 2: Create build script with Overpass query**

Create `scripts/build-tiles.js`. This is the full build script — it reads `cities.json`, queries Overpass for each city, converts to GeoJSON, splits into tiles, reverse geocodes suburb names, and writes the manifest.

```javascript
#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TILE_SIZE = 0.05; // ~5.5km in degrees
const HIGHWAYS = [
    "footway","cycleway","path","residential","living_street","pedestrian",
    "service","unclassified","tertiary","tertiary_link","secondary","secondary_link",
    "primary","primary_link","trunk","trunk_link","crossing","steps"
];

// ── Helpers ──────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, opts) {
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
    return resp.json();
}

function osmToGeoJSON(data) {
    const nodes = {};
    const features = [];
    for (const el of data.elements || []) {
        if (el.type === "node") nodes[el.id] = [el.lon, el.lat];
    }
    for (const el of data.elements || []) {
        if (el.type !== "way") continue;
        const coords = (el.nodes || []).map(n => nodes[n]).filter(Boolean);
        if (coords.length < 2) continue;
        const tags = el.tags || {};
        features.push({
            type: "Feature",
            properties: { id: el.id, highway: tags.highway || "", surface: tags.surface || "", name: tags.name || "" },
            geometry: { type: "LineString", coordinates: coords },
        });
    }
    return { type: "FeatureCollection", features };
}

function featureCentroid(feature) {
    const coords = feature.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    return { lat: mid[1], lon: mid[0] };
}

// ── Core ─────────────────────────────────────────────

async function queryOverpass(bounds) {
    const [south, west, north, east] = bounds;
    const regex = `^(${HIGHWAYS.join("|")})$`;
    const query = `[out:json][timeout:120];\n(way["highway"~"${regex}"](${south},${west},${north},${east}););\nout body;\n>;\nout skel qt;`;

    console.log(`  Querying Overpass (${(north-south).toFixed(2)}° x ${(east-west).toFixed(2)}°)...`);
    const data = await fetchJSON("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    console.log(`  Got ${(data.elements || []).length} elements`);
    return osmToGeoJSON(data);
}

function splitIntoTiles(geojson, bounds) {
    const [south, west, north, east] = bounds;
    const rows = Math.ceil((north - south) / TILE_SIZE);
    const cols = Math.ceil((east - west) / TILE_SIZE);
    const tiles = {};

    for (const feature of geojson.features) {
        const c = featureCentroid(feature);
        const row = Math.min(Math.floor((c.lat - south) / TILE_SIZE), rows - 1);
        const col = Math.min(Math.floor((c.lon - west) / TILE_SIZE), cols - 1);
        const key = `${row}_${col}`;
        if (!tiles[key]) {
            tiles[key] = {
                row, col,
                bounds: [
                    south + row * TILE_SIZE,
                    west + col * TILE_SIZE,
                    Math.min(south + (row + 1) * TILE_SIZE, north),
                    Math.min(west + (col + 1) * TILE_SIZE, east),
                ],
                features: [],
            };
        }
        tiles[key].features.push(feature);
    }

    return { rows, cols, tiles };
}

async function reverseGeocode(lat, lon) {
    try {
        const data = await fetchJSON(
            `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=3`
        );
        const suburbs = [];
        for (const feat of data.features || []) {
            const p = feat.properties;
            const name = p.name || p.district || p.city;
            if (name && !suburbs.includes(name)) suburbs.push(name);
        }
        return suburbs.length > 0 ? suburbs : ["Unknown"];
    } catch (e) {
        return ["Unknown"];
    }
}

async function buildCity(city, dataDir) {
    console.log(`\nBuilding ${city.name}...`);

    // 1. Query Overpass
    const geojson = await queryOverpass(city.bounds);
    console.log(`  ${geojson.features.length} features`);

    // 2. Split into tiles
    const { rows, cols, tiles } = splitIntoTiles(geojson, city.bounds);
    console.log(`  Grid: ${rows}x${cols} = ${Object.keys(tiles).length} non-empty tiles`);

    // 3. Write tile files and collect metadata
    const tileDir = path.join(dataDir, "tiles", city.id);
    fs.mkdirSync(tileDir, { recursive: true });

    const tileMeta = [];
    for (const [key, tile] of Object.entries(tiles)) {
        const tileGeoJSON = { type: "FeatureCollection", features: tile.features };
        const filePath = path.join(tileDir, `${key}.json`);
        fs.writeFileSync(filePath, JSON.stringify(tileGeoJSON));

        // Reverse geocode tile centre for suburb names
        const centerLat = (tile.bounds[0] + tile.bounds[2]) / 2;
        const centerLon = (tile.bounds[1] + tile.bounds[3]) / 2;
        const suburbs = await reverseGeocode(centerLat, centerLon);
        await sleep(1100); // Rate limit Photon

        tileMeta.push({
            file: `${key}.json`,
            bounds: tile.bounds,
            suburbs,
            ways: tile.features.length,
        });

        console.log(`  Tile ${key}: ${tile.features.length} ways — ${suburbs.join(", ")}`);
    }

    return { rows, cols, tiles: tileMeta };
}

async function main() {
    const dataDir = path.join(__dirname, "..", "data");
    const citiesPath = path.join(dataDir, "cities.json");

    if (!fs.existsSync(citiesPath)) {
        console.error("Missing data/cities.json");
        process.exit(1);
    }

    const cities = JSON.parse(fs.readFileSync(citiesPath, "utf-8"));
    const manifest = { built: new Date().toISOString(), version: "", cities: {} };

    for (const city of cities) {
        const result = await buildCity(city, dataDir);
        manifest.cities[city.id] = {
            name: city.name,
            bounds: city.bounds,
            tileSize: TILE_SIZE,
            grid: [result.rows, result.cols],
            tiles: result.tiles,
        };
        // Pause between cities to be kind to Overpass
        if (cities.indexOf(city) < cities.length - 1) {
            console.log("\n  Waiting 30s before next city...");
            await sleep(30000);
        }
    }

    // Version hash from manifest content (excluding version field itself)
    const content = JSON.stringify(manifest.cities);
    manifest.version = crypto.createHash("md5").update(content).digest("hex").substring(0, 8);

    const manifestPath = path.join(dataDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\nManifest written: ${manifestPath}`);
    console.log(`Version: ${manifest.version}`);
    console.log("Done.");
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run build script locally for Perth only**

To test without waiting for Melbourne too, temporarily edit `cities.json` to only include Perth, then run:

```bash
cd ~/legwork && node scripts/build-tiles.js
```

Expected output:
```
Building Perth...
  Querying Overpass (0.40° x 0.40°)...
  Got ~1072000 elements
  184058 features
  Grid: 8x8 = ~50 non-empty tiles
  Tile 0_0: 2134 ways — Joondalup, Currambine
  ...
Manifest written: data/manifest.json
Version: abc12345
Done.
```

Verify files exist:
```bash
ls data/tiles/perth/ | head -10
cat data/manifest.json | head -20
```

- [ ] **Step 4: Restore full cities.json and run for both cities**

Restore Melbourne in `cities.json`, then run again:
```bash
node scripts/build-tiles.js
```

This will take ~3-5 minutes (Overpass queries + Photon rate limiting).

- [ ] **Step 5: Commit**

```bash
git add data/cities.json scripts/build-tiles.js data/manifest.json data/tiles/
git commit -m "feat: build script for pre-cached city tiles (Perth + Melbourne)"
```

---

### Task 2: GitHub Actions Workflow

**Files:**
- Create: `.github/workflows/build-tiles.yml`

- [ ] **Step 1: Create workflow file**

```bash
mkdir -p ~/legwork/.github/workflows
```

Create `.github/workflows/build-tiles.yml`:

```yaml
name: Build City Tiles

on:
  schedule:
    # Weekly: Sunday 02:00 UTC (10:00 AWST)
    - cron: '0 2 * * 0'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Build tiles
        run: node scripts/build-tiles.js

      - name: Commit changes
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/
          if git diff --cached --quiet; then
            echo "No changes to commit"
          else
            git commit -m "chore: update city tiles [automated]"
            git push
          fi
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/build-tiles.yml
git commit -m "ci: weekly GitHub Actions workflow for city tile builds"
```

---

### Task 3: App Integration — Tile Loading on Boot

**Files:**
- Modify: `app.js` (add tile loading functions, modify boot sequence)

This is the largest task. It adds three things to `app.js`:
1. `loadTilesForLocation(lat, lon)` — fetches manifest, finds city, loads tiles
2. Modified boot sequence that tries tiles before Overpass
3. "Request this city" link for uncached locations

- [ ] **Step 1: Add tile loading functions to app.js**

Add this block after the `migrateLocalStorage` function (after line ~73) and before the `// ── State` section:

```javascript
// ── Pre-cached tile loading ───────────────────────────
var TILES_BASE = "./data/";
var _manifest = null;

async function fetchManifest() {
    if (_manifest) return _manifest;
    try {
        var resp = await fetch(TILES_BASE + "manifest.json");
        if (!resp.ok) return null;
        _manifest = await resp.json();
        return _manifest;
    } catch (e) { return null; }
}

function findCityForLocation(manifest, lat, lon) {
    if (!manifest || !manifest.cities) return null;
    var ids = Object.keys(manifest.cities);
    for (var i = 0; i < ids.length; i++) {
        var city = manifest.cities[ids[i]];
        var b = city.bounds; // [south, west, north, east]
        if (lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]) {
            return { id: ids[i], city: city };
        }
    }
    return null;
}

function tilesInRadius(city, lat, lon, radiusKm) {
    var radiusDeg = radiusKm / 111; // rough km-to-degrees
    var selected = [];
    for (var i = 0; i < city.tiles.length; i++) {
        var t = city.tiles[i];
        var b = t.bounds; // [south, west, north, east]
        var tCenterLat = (b[0] + b[2]) / 2;
        var tCenterLon = (b[1] + b[3]) / 2;
        var dlat = tCenterLat - lat;
        var dlon = (tCenterLon - lon) * Math.cos(lat * Math.PI / 180);
        var dist = Math.sqrt(dlat * dlat + dlon * dlon);
        if (dist < radiusDeg) selected.push(t);
    }
    return selected;
}

async function loadTilesForLocation(lat, lon) {
    var manifest = await fetchManifest();
    if (!manifest) return false;

    var match = findCityForLocation(manifest, lat, lon);
    if (!match) return false;

    var cityId = match.id;
    var city = match.city;
    var tiles = tilesInRadius(city, lat, lon, 5);
    if (tiles.length === 0) return false;

    // Check which tiles need fetching (not already in IndexedDB with current version)
    var toFetch = [];
    for (var i = 0; i < tiles.length; i++) {
        var cacheKey = "tile:" + cityId + ":" + tiles[i].file + ":" + manifest.version;
        var cached = await cacheGet(cacheKey);
        if (cached) {
            applyPaths(cached);
        } else {
            toFetch.push(tiles[i]);
        }
    }

    if (toFetch.length === 0) {
        console.log("All " + tiles.length + " tiles loaded from cache");
        return true;
    }

    // Collect suburb names for banner
    var suburbs = [];
    for (var i = 0; i < toFetch.length; i++) {
        for (var s = 0; s < toFetch[i].suburbs.length; s++) {
            if (suburbs.indexOf(toFetch[i].suburbs[s]) === -1) suburbs.push(toFetch[i].suburbs[s]);
        }
    }
    showBanner("Loading " + suburbs.join(", ") + "...", "loading");

    // Fetch tiles in parallel
    var loaded = 0;
    var total = toFetch.length;
    var promises = toFetch.map(function (tile) {
        var url = TILES_BASE + "tiles/" + cityId + "/" + tile.file;
        return fetch(url).then(function (resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            return resp.json();
        }).then(function (geojson) {
            applyPaths(geojson);
            var cacheKey = "tile:" + cityId + ":" + tile.file + ":" + manifest.version;
            cacheSet(cacheKey, geojson);
            loaded++;
            if (loaded < total) {
                showBanner("Loaded " + loaded + "/" + total + " areas...", "loading");
            }
        }).catch(function (e) {
            console.warn("Tile fetch failed: " + tile.file, e.message);
        });
    });

    await Promise.all(promises);
    showBanner("");
    console.log("Loaded " + loaded + "/" + total + " tiles for " + city.name);
    return true;
}

function showCityRequest() {
    // Show "Request your city" link in side menu when outside cached cities
    var el = document.getElementById("city-request-link");
    if (el) el.classList.remove("hidden");
}

function hideCityRequest() {
    var el = document.getElementById("city-request-link");
    if (el) el.classList.add("hidden");
}
```

- [ ] **Step 2: Modify boot sequence to try tiles first**

Replace the boot section (lines 1784-1843) in `app.js`. The key change: wrap the geolocation callback in an async function that tries `loadTilesForLocation` first, falling back to `loadPaths` (Overpass).

Find the existing boot code starting at `// ── Boot` and replace the geolocation block. The full boot section becomes:

```javascript
// ── Boot ───────────────────────────────────────────────
initMap();
setupAutocomplete();
buildMenuLegend();
updateReverseVisibility();
showWelcome();
updateOnlineStatus();
setupInstallPrompt();

// Migrate old localStorage cache to IndexedDB, then render saved lists
migrateLocalStorage().then(function () {
    renderSavedAreas();
    renderSavedRoutes();
});

var sharedPoints = loadFromHash();
var savedRoute = !sharedPoints ? loadSavedRoute() : null;

if (sharedPoints) {
    // Restore from share link
    var center = sharedPoints[0];
    state.map.setView([center.lat, center.lon], 14);
    autoDetectUnits(center.lat, center.lon);
    loadTilesForLocation(center.lat, center.lon).then(function (loaded) {
        if (!loaded) return loadPaths(center.lat, center.lon);
    }).then(function () {
        for (var i = 0; i < sharedPoints.length; i++) addWaypointAt(sharedPoints[i].lat, sharedPoints[i].lon, { exactPosition: i === 0 });
    });
} else if (savedRoute && savedRoute.waypoints && savedRoute.waypoints.length > 0) {
    // Restore last session's route
    if (savedRoute.mode) {
        state.mode = savedRoute.mode;
        document.getElementById("mode-btn").textContent = state.mode === "loop" ? "\u21BB Loop" : "\u21C4 Out & Back";
        updateReverseVisibility();
    }
    var sw = savedRoute.waypoints;
    var ctr = sw[0];
    state.map.setView([ctr.lat, ctr.lon], savedRoute.zoom || 14);
    autoDetectUnits(ctr.lat, ctr.lon);
    loadTilesForLocation(ctr.lat, ctr.lon).then(function (loaded) {
        if (!loaded) return loadPaths(ctr.lat, ctr.lon);
    }).then(function () {
        for (var i = 0; i < sw.length; i++) addWaypointAt(sw[i].lat, sw[i].lon, { exactPosition: i === 0 });
    });
} else if (navigator.geolocation) {
    // Fresh start — geolocate
    navigator.geolocation.getCurrentPosition(
        function (pos) {
            var lat = pos.coords.latitude;
            var lon = pos.coords.longitude;
            state.startLat = lat;
            state.startLon = lon;
            autoDetectUnits(lat, lon);
            state.map.setView([lat, lon], 15);
            loadTilesForLocation(lat, lon).then(function (loaded) {
                if (!loaded) {
                    showCityRequest();
                    return loadPaths(lat, lon);
                }
            }).then(function () {
                if (state.graph) addWaypointAt(lat, lon, { exactPosition: true });
            });
        },
        function () { /* no location — user types address */ },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
}
```

- [ ] **Step 3: Verify syntax**

```bash
cd ~/legwork && node -c app.js && echo "Syntax OK"
```

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: load pre-cached city tiles on boot with suburb banner"
```

---

### Task 4: HTML Updates — City Request Container and Plausible

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add city request link to side menu and Plausible script**

In `index.html`, add the city request link inside the side menu, after the install prompt div (after the last `menu-divider`):

```html
            <a id="city-request-link" class="menu-item menu-request hidden" href="https://forms.gle/REPLACE_WITH_REAL_FORM_ID" target="_blank">Request your city</a>
```

Note: Peter will create the Google Form and replace the URL before deploying.

Add Plausible analytics script before the closing `</head>` tag (after line 18):

```html
    <script defer data-domain="fractionasian.github.io/legwork" src="https://plausible.io/js/script.js"></script>
```

- [ ] **Step 2: Add CSS for city request link**

In `style.css`, add after the `.menu-progress.hidden` rule:

```css
/* ── City request link ───────────────────────────── */
.menu-request {
    color: #6b6e7a;
    font-size: 12px;
}

.menu-request:hover {
    color: #6ee7b7;
}

.menu-request.hidden {
    display: none;
}
```

- [ ] **Step 3: Commit**

```bash
git add index.html style.css
git commit -m "feat: city request link container and Plausible analytics"
```

---

### Task 5: Integration Test and Push

**Files:** None new — testing existing changes together.

- [ ] **Step 1: Verify the full build locally**

```bash
cd ~/legwork && node scripts/build-tiles.js
```

Confirm `data/tiles/perth/` and `data/tiles/melbourne/` have tile files.

- [ ] **Step 2: Check all file syntax**

```bash
node -c app.js && echo "JS OK"
```

- [ ] **Step 3: Verify manifest structure**

```bash
node -e "const m = require('./data/manifest.json'); console.log('Version:', m.version); console.log('Cities:', Object.keys(m.cities)); for (const [id, c] of Object.entries(m.cities)) console.log(id + ':', c.tiles.length, 'tiles,', c.grid, 'grid');"
```

Expected:
```
Version: abc12345
Cities: [ 'perth', 'melbourne' ]
perth: ~50 tiles, [8, 8] grid
melbourne: ~40 tiles, [6, 8] grid
```

- [ ] **Step 4: Verify tile file sizes**

```bash
du -sh data/tiles/perth/ data/tiles/melbourne/
```

Expected: ~15-20 MB per city (uncompressed). GitHub Pages serves with gzip, so actual transfer will be ~3-5 MB per city.

- [ ] **Step 5: Commit all generated data and push**

```bash
git add -A
git commit -m "feat: pre-cached city tiles for Perth and Melbourne

Build script queries Overpass for configured cities, splits into ~5.5km
GeoJSON tiles with suburb metadata, generates manifest. App loads tiles
from GitHub Pages on boot with suburb-level loading banner. Falls back
to Overpass for uncached cities. Weekly GitHub Actions cron refreshes
data. Plausible analytics for visitor geography."
git push
```

- [ ] **Step 6: Trigger GitHub Actions to verify workflow**

```bash
gh workflow run build-tiles.yml
```

Check the run completes successfully:
```bash
gh run list --workflow=build-tiles.yml --limit=1
```

- [ ] **Step 7: Test in browser**

Open `https://fractionasian.github.io/legwork/` (or local server). Verify:
1. Loading banner shows suburb names (e.g., "Loading Maylands, Bayswater...")
2. Network tab shows requests to `data/tiles/perth/*.json` (not Overpass)
3. Reload — tiles load from IndexedDB (no network requests for tiles)
4. Spoof geolocation outside Perth/Melbourne — verify Overpass fallback and city request link

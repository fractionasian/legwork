// ── Legwork — Static Running Route Planner ─────────────
// All API calls go directly to free external services.
// No backend required. Runs on GitHub Pages.

// ── IndexedDB Cache ───────────────────────────────────
var DB_NAME = "legwork";
var DB_VERSION = 2;
var PATHS_TTL = 30 * 24 * 3600 * 1000; // 30 days

var _db = null;
function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains("pathCache")) db.createObjectStore("pathCache");
            if (!db.objectStoreNames.contains("elevCache")) db.createObjectStore("elevCache");
            if (!db.objectStoreNames.contains("savedRoutes")) {
                db.createObjectStore("savedRoutes", { keyPath: "id", autoIncrement: true });
            }
            if (db.objectStoreNames.contains("savedAreas")) db.deleteObjectStore("savedAreas");
        };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { reject(req.error); };
    });
}

async function cacheGet(key, ttlMs) {
    try {
        var db = await openDB();
        var store = key.indexOf("elev2:") === 0 ? "elevCache" : "pathCache";
        return new Promise(function (resolve) {
            var tx = db.transaction(store, "readonly");
            var req = tx.objectStore(store).get(key);
            req.onsuccess = function () {
                var entry = req.result;
                if (!entry) return resolve(null);
                if (ttlMs && Date.now() - entry.ts > ttlMs) return resolve(null);
                resolve(entry.v);
            };
            req.onerror = function () { resolve(null); };
        });
    } catch (e) { return null; }
}

async function cacheSet(key, value) {
    try {
        var db = await openDB();
        var store = key.indexOf("elev2:") === 0 ? "elevCache" : "pathCache";
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put({ v: value, ts: Date.now() }, key);
    } catch (e) { /* IndexedDB write failed — degrade silently */ }
}

// Migrate localStorage cache to IndexedDB on first run
async function migrateLocalStorage() {
    var migrated = false;
    for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (!k || k.indexOf("lw:") !== 0) continue;
        // Skip non-cache keys
        if (k === "lw:savedRoute" || k === "lw:welcomed") continue;
        try {
            var raw = JSON.parse(localStorage.getItem(k));
            var cacheKey = k.substring(3); // strip "lw:" prefix
            await cacheSet(cacheKey, raw.v);
            localStorage.removeItem(k);
            migrated = true;
        } catch (e) {}
    }
    if (migrated) console.log("Migrated localStorage cache to IndexedDB");
}

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

function compactToGeoJSON(compact) {
    // Convert compact [id, highway, name, [[lon,lat],...]] to GeoJSON FeatureCollection
    var features = [];
    for (var i = 0; i < compact.length; i++) {
        var c = compact[i];
        features.push({
            type: "Feature",
            properties: { id: c[0], highway: c[1], surface: "", name: c[2] },
            geometry: { type: "LineString", coordinates: c[3] },
        });
    }
    return { type: "FeatureCollection", features: features };
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
            applyPaths(cached, { skipRender: true });
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
        }).then(function (data) {
            // Convert compact tile format to GeoJSON
            var geojson = Array.isArray(data) ? compactToGeoJSON(data) : data;
            applyPaths(geojson, { skipRender: true });
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

async function loadTilesOrPaths(lat, lon) {
    var tilesLoaded = await loadTilesForLocation(lat, lon);
    if (!tilesLoaded) await loadPaths(lat, lon);
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

// ── State ──────────────────────────────────────────────
var state = {
    map: null,
    pathLayer: null,
    waypoints: [],
    routeSegments: [],
    routeLines: [],
    closingLine: null,
    mode: "loop",
    elevationChart: null,
    pathFeatures: null,
    graph: null,
    startLat: null,
    startLon: null,
    gradientLines: [],
    routeOutline: null,
    distanceMarkers: [],
    totalDistMetres: 0,
    midpointMarkers: [],  // draggable midpoints for inserting waypoints
    useMiles: false,
    lastElevationData: [], // cached elevation results for GPX export
};

// ── Road-type weights (runner preference) ────────────
// Multipliers penalise busy roads so Dijkstra favours footpaths/quiet streets.
// Only affects path selection — displayed distance uses actual haversine.
var ROAD_WEIGHT = {
    footway: 1.0, path: 1.0, cycleway: 1.0, pedestrian: 1.0, crossing: 1.0,
    living_street: 1.1, residential: 1.1,
    service: 1.2, unclassified: 1.2,
    tertiary: 1.3, tertiary_link: 1.3,
    steps: 1.5,
    secondary: 1.6, secondary_link: 1.6,
    primary: 2.0, primary_link: 2.0,
    trunk: 2.5, trunk_link: 2.5,
};

// ── Routing graph ──────────────────────────────────────
function nodeKey(lat, lon) {
    return lat.toFixed(6) + "," + lon.toFixed(6);
}

function buildGraph(geojson) {
    var adj = {};
    function addEdge(k1, lat1, lon1, k2, lat2, lon2) {
        var d = haversine(lat1, lon1, lat2, lon2);
        if (!adj[k1]) adj[k1] = [];
        if (!adj[k2]) adj[k2] = [];
        adj[k1].push({ key: k2, lat: lat2, lon: lon2, dist: d });
        adj[k2].push({ key: k1, lat: lat1, lon: lon1, dist: d });
    }
    for (var f = 0; f < geojson.features.length; f++) {
        var coords = geojson.features[f].geometry.coordinates;
        for (var c = 1; c < coords.length; c++) {
            addEdge(
                nodeKey(coords[c-1][1], coords[c-1][0]), coords[c-1][1], coords[c-1][0],
                nodeKey(coords[c][1], coords[c][0]), coords[c][1], coords[c][0]
            );
        }
    }
    return adj;
}

// ── Binary min-heap for Dijkstra ──────────────────────
function MinHeap() {
    this.data = [];
}
MinHeap.prototype.push = function (item) {
    this.data.push(item);
    var i = this.data.length - 1;
    while (i > 0) {
        var parent = (i - 1) >> 1;
        if (this.data[parent].d <= this.data[i].d) break;
        var tmp = this.data[parent]; this.data[parent] = this.data[i]; this.data[i] = tmp;
        i = parent;
    }
};
MinHeap.prototype.pop = function () {
    var top = this.data[0];
    var last = this.data.pop();
    if (this.data.length > 0) {
        this.data[0] = last;
        var i = 0, len = this.data.length;
        while (true) {
            var left = 2 * i + 1, right = 2 * i + 2, smallest = i;
            if (left < len && this.data[left].d < this.data[smallest].d) smallest = left;
            if (right < len && this.data[right].d < this.data[smallest].d) smallest = right;
            if (smallest === i) break;
            var tmp = this.data[smallest]; this.data[smallest] = this.data[i]; this.data[i] = tmp;
            i = smallest;
        }
    }
    return top;
};
MinHeap.prototype.size = function () { return this.data.length; };

function dijkstra(graph, startKey, endKey) {
    if (!graph[startKey] || !graph[endKey]) return null;
    if (startKey === endKey) return { dist: 0, path: [startKey] };
    var dist = {}, prev = {}, visited = {};
    var heap = new MinHeap();
    dist[startKey] = 0;
    heap.push({ key: startKey, d: 0 });
    while (heap.size() > 0) {
        var current = heap.pop();
        if (visited[current.key]) continue;
        visited[current.key] = true;
        if (current.key === endKey) break;
        var neighbors = graph[current.key] || [];
        for (var n = 0; n < neighbors.length; n++) {
            var nb = neighbors[n];
            if (visited[nb.key]) continue;
            var newDist = dist[current.key] + nb.dist;
            if (dist[nb.key] === undefined || newDist < dist[nb.key]) {
                dist[nb.key] = newDist;
                prev[nb.key] = current.key;
                heap.push({ key: nb.key, d: newDist });
            }
        }
    }
    if (dist[endKey] === undefined) return null;
    var path = [];
    var cur = endKey;
    while (cur) { path.unshift(cur); cur = prev[cur]; }
    return { dist: dist[endKey], path: path };
}

// ── Spatial grid for fast nearest-node lookup ─────────
var GRID_CELL = 0.005; // ~500m cells
var spatialGrid = {};

function gridKey(lat, lon) {
    return (Math.floor(lat / GRID_CELL) * GRID_CELL).toFixed(4) + ":" + (Math.floor(lon / GRID_CELL) * GRID_CELL).toFixed(4);
}

function gridInsert(nk, lat, lon) {
    var gk = gridKey(lat, lon);
    if (!spatialGrid[gk]) spatialGrid[gk] = [];
    spatialGrid[gk].push({ key: nk, lat: lat, lon: lon });
}

function closestNode(graph, lat, lon) {
    var bestKey = null, bestDist = Infinity;
    var cLat = Math.floor(lat / GRID_CELL) * GRID_CELL;
    var cLon = Math.floor(lon / GRID_CELL) * GRID_CELL;
    // Search 3x3 neighborhood of grid cells
    for (var dLat = -1; dLat <= 1; dLat++) {
        for (var dLon = -1; dLon <= 1; dLon++) {
            var gk = (cLat + dLat * GRID_CELL).toFixed(4) + ":" + (cLon + dLon * GRID_CELL).toFixed(4);
            var bucket = spatialGrid[gk];
            if (!bucket) continue;
            for (var i = 0; i < bucket.length; i++) {
                var d = haversine(lat, lon, bucket[i].lat, bucket[i].lon);
                if (d < bestDist) { bestDist = d; bestKey = bucket[i].key; }
            }
        }
    }
    // Fallback to full scan if grid miss (shouldn't happen often)
    if (!bestKey) {
        var keys = Object.keys(graph);
        for (var i = 0; i < keys.length; i++) {
            var parts = keys[i].split(",");
            var d = haversine(lat, lon, parseFloat(parts[0]), parseFloat(parts[1]));
            if (d < bestDist) { bestDist = d; bestKey = keys[i]; }
        }
    }
    return bestKey;
}

function pathToCoords(path) {
    var coords = [];
    for (var i = 0; i < path.length; i++) {
        var parts = path[i].split(",");
        coords.push([parseFloat(parts[0]), parseFloat(parts[1])]);
    }
    return coords;
}

// ── Map init ───────────────────────────────────────────
function initMap() {
    state.map = L.map("map").setView([0, 0], 2);

    var osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://github.com/fractionasian/legwork">Legwork</a>',
        maxZoom: 19,
    });
    var satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        attribution: '&copy; Esri',
        maxZoom: 19,
    });
    var terrain = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenTopoMap',
        maxZoom: 17,
    });

    osm.addTo(state.map);
    L.control.layers({ "Street": osm, "Satellite": satellite, "Terrain": terrain }, null, { position: "topright" }).addTo(state.map);

    state.map.on("click", onMapClick);

    // ── Viewport tile preloading ──────────────────────
    var _viewportTimer = null;
    state.map.on("moveend", function () {
        clearTimeout(_viewportTimer);
        _viewportTimer = setTimeout(loadTilesInViewport, 500);
    });
}

async function loadTilesInViewport() {
    var manifest = await fetchManifest();
    if (!manifest || !state.map) return;

    var bounds = state.map.getBounds();
    var center = bounds.getCenter();
    var match = findCityForLocation(manifest, center.lat, center.lng);
    if (!match) return;

    var city = match.city;
    var cityId = match.id;
    var south = bounds.getSouth(), north = bounds.getNorth();
    var west = bounds.getWest(), east = bounds.getEast();

    // Find tiles whose bounds intersect the viewport
    var toFetch = [];
    for (var i = 0; i < city.tiles.length; i++) {
        var tb = city.tiles[i].bounds; // [south, west, north, east]
        // AABB intersection test
        if (tb[2] < south || tb[0] > north || tb[3] < west || tb[1] > east) continue;
        var cacheKey = "tile:" + cityId + ":" + city.tiles[i].file + ":" + manifest.version;
        var cached = await cacheGet(cacheKey);
        if (cached) {
            applyPaths(cached, { skipRender: true });
        } else {
            toFetch.push(city.tiles[i]);
        }
        if (toFetch.length >= 20) break; // cap concurrent fetches
    }

    if (toFetch.length === 0) return;

    var suburbs = [];
    for (var i = 0; i < toFetch.length; i++) {
        for (var s = 0; s < toFetch[i].suburbs.length; s++) {
            if (suburbs.indexOf(toFetch[i].suburbs[s]) === -1) suburbs.push(toFetch[i].suburbs[s]);
        }
    }
    showBanner("Loading " + suburbs.slice(0, 5).join(", ") + (suburbs.length > 5 ? "..." : "") + "", "loading");

    var loaded = 0;
    var promises = toFetch.map(function (tile) {
        var url = TILES_BASE + "tiles/" + cityId + "/" + tile.file;
        return fetch(url).then(function (resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            return resp.json();
        }).then(function (data) {
            var geojson = Array.isArray(data) ? compactToGeoJSON(data) : data;
            applyPaths(geojson, { skipRender: true });
            var cacheKey = "tile:" + cityId + ":" + tile.file + ":" + manifest.version;
            cacheSet(cacheKey, geojson);
            loaded++;
        }).catch(function (e) {
            console.warn("Viewport tile fetch failed: " + tile.file, e.message);
        });
    });

    await Promise.all(promises);
    // Only clear banner if we showed it (avoid clearing route error banners)
    var bannerEl = document.getElementById("info-banner");
    if (bannerEl.dataset.type === "loading") showBanner("");
    if (loaded > 0) console.log("Viewport preloaded " + loaded + " tiles");
}

// ── Build gradient legend in side menu ────────────────
function buildMenuLegend() {
    var container = document.getElementById("menu-legend");
    var title = document.createElement("strong");
    title.textContent = "Gradient";
    container.appendChild(title);
    container.appendChild(document.createElement("br"));
    var levels = [
        { color: "#3b82f6", label: "Very steep down (>10%)" },
        { color: "#60a5fa", label: "Steep downhill (5-10%)" },
        { color: "#93c5fd", label: "Downhill (2-5%)" },
        { color: "#6ee7b7", label: "Flat (<2%)" },
        { color: "#fbbf24", label: "Uphill (2-5%)" },
        { color: "#f87171", label: "Steep uphill (5-10%)" },
        { color: "#dc2626", label: "Very steep up (>10%)" },
    ];
    for (var k = 0; k < levels.length; k++) {
        var icon = document.createElement("i");
        icon.style.background = levels[k].color;
        container.appendChild(icon);
        container.appendChild(document.createTextNode(" " + levels[k].label));
        container.appendChild(document.createElement("br"));
    }
}

// ── Numbered markers ───────────────────────────────────
function createNumberedMarker(lat, lon, num) {
    var el = document.createElement("div");
    el.style.cssText =
        "background:#2e86de;color:#fff;border:2px solid #fff;border-radius:50%;" +
        "width:28px;height:28px;display:flex;align-items:center;justify-content:center;" +
        "font-size:13px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    el.textContent = num;
    var icon = L.divIcon({ html: el.outerHTML, className: "", iconSize: [28, 28], iconAnchor: [14, 14] });
    return L.marker([lat, lon], { icon: icon, draggable: true }).addTo(state.map);
}

function updateMarkerNumber(marker, num) {
    var el = document.createElement("div");
    el.style.cssText =
        "background:#2e86de;color:#fff;border:2px solid #fff;border-radius:50%;" +
        "width:28px;height:28px;display:flex;align-items:center;justify-content:center;" +
        "font-size:13px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    el.textContent = num;
    marker.setIcon(L.divIcon({ html: el.outerHTML, className: "", iconSize: [28, 28], iconAnchor: [14, 14] }));
}

// ── Autocomplete (Photon) ──────────────────────────────
var autocompleteTimer = null;

function setAutocompleteOpen(open) {
    var wrapper = document.querySelector(".menu-search");
    var list = document.getElementById("autocomplete-list");
    list.style.display = open ? "block" : "none";
    if (wrapper) wrapper.setAttribute("aria-expanded", open ? "true" : "false");
}

function setupAutocomplete() {
    var input = document.getElementById("address-input");
    var list = document.getElementById("autocomplete-list");
    var activeIdx = -1;

    input.addEventListener("input", function () {
        clearTimeout(autocompleteTimer);
        activeIdx = -1;
        var q = input.value.trim();
        if (q.length < 3) { setAutocompleteOpen(false); return; }
        autocompleteTimer = setTimeout(function () { fetchSuggestions(q); }, 300);
    });
    input.addEventListener("blur", function () {
        setTimeout(function () { setAutocompleteOpen(false); }, 200);
    });
    input.addEventListener("keydown", function (e) {
        var items = list.querySelectorAll("[role='option']");
        if (e.key === "Escape") { setAutocompleteOpen(false); return; }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, items.length - 1);
            updateActiveItem(items, activeIdx, input);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, 0);
            updateActiveItem(items, activeIdx, input);
        } else if (e.key === "Enter" && activeIdx >= 0 && items[activeIdx]) {
            e.preventDefault();
            items[activeIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        }
    });
}

function updateActiveItem(items, idx, input) {
    for (var i = 0; i < items.length; i++) {
        items[i].classList.remove("active");
        items[i].setAttribute("aria-selected", "false");
    }
    if (items[idx]) {
        items[idx].classList.add("active");
        items[idx].setAttribute("aria-selected", "true");
        input.setAttribute("aria-activedescendant", items[idx].id);
    } else {
        input.removeAttribute("aria-activedescendant");
    }
}

async function fetchSuggestions(query) {
    var list = document.getElementById("autocomplete-list");
    try {
        var center = state.map ? state.map.getCenter() : { lat: -31.95, lng: 115.86 };
        var resp = await fetch(
            "https://photon.komoot.io/api/?q=" + encodeURIComponent(query) +
            "&limit=5&lat=" + center.lat + "&lon=" + center.lng
        );
        if (!resp.ok) return;
        var data = await resp.json();
        var features = data.features || [];
        while (list.firstChild) list.removeChild(list.firstChild);
        if (features.length === 0) { setAutocompleteOpen(false); return; }

        for (var i = 0; i < features.length; i++) {
            (function (feat, idx) {
                var props = feat.properties;
                var parts = [];
                if (props.name) parts.push(props.name);
                if (props.street) parts.push(props.street);
                if (props.city) parts.push(props.city);
                if (props.state) parts.push(props.state);
                if (props.country) parts.push(props.country);
                var label = parts.join(", ");
                var item = document.createElement("div");
                item.className = "autocomplete-item";
                item.id = "ac-option-" + idx;
                item.setAttribute("role", "option");
                item.setAttribute("aria-selected", "false");
                item.textContent = label;
                item.addEventListener("mousedown", function (e) {
                    e.preventDefault();
                    document.getElementById("address-input").value = label;
                    setAutocompleteOpen(false);
                    var coords = feat.geometry.coordinates;
                    goToLocation(coords[1], coords[0]);
                });
                list.appendChild(item);
            })(features[i], i);
        }
        setAutocompleteOpen(true);
    } catch (e) { console.warn("Autocomplete failed:", e.message); }
}

// ── Geocode (via Photon) ───────────────────────────────
async function geocodeAddress(opts) {
    var q = document.getElementById("address-input").value.trim();
    if (!q) return;
    setAutocompleteOpen(false);
    try {
        var center = state.map ? state.map.getCenter() : { lat: -31.95, lng: 115.86 };
        var resp = await fetch(
            "https://photon.komoot.io/api/?q=" + encodeURIComponent(q) +
            "&limit=1&lat=" + center.lat + "&lon=" + center.lng
        );
        if (!resp.ok) { showBanner("Address not found"); return; }
        var data = await resp.json();
        var features = data.features || [];
        if (features.length === 0) { showBanner("Address not found"); return; }
        var coords = features[0].geometry.coordinates;
        goToLocation(coords[1], coords[0]);
    } catch (e) { showBanner("Geocoding failed: " + e.message); }
}

function goToLocation(lat, lon) {
    // Clear existing waypoints — this sets a new starting point
    for (var i = 0; i < state.waypoints.length; i++) state.map.removeLayer(state.waypoints[i].marker);
    state.waypoints = [];
    updateRoute();

    state.startLat = lat;
    state.startLon = lon;
    state.map.setView([lat, lon], 15);
    closeMenu();
    loadTilesOrPaths(lat, lon).then(function () {
        if (state.graph) addWaypointAt(lat, lon, { exactPosition: true });
    });
}

// ── Load paths (direct Overpass API) ───────────────────
function radiusFromZoom() {
    if (!state.map) return 2000;
    var z = state.map.getZoom();
    if (z >= 16) return 1000;
    if (z >= 14) return 2000;
    if (z >= 12) return 5000;
    return 10000;
}

async function loadPaths(lat, lon) {
    var radius = radiusFromZoom();
    var cacheKey = "paths:" + lat.toFixed(3) + ":" + lon.toFixed(3) + ":" + radius;

    showBanner("Loading paths...", "loading");

    // Check cache
    var cached = await cacheGet(cacheKey, PATHS_TTL);
    if (cached) {
        applyPaths(cached, { skipRender: true });
        showBanner("");
        return;
    }

    var query = '[out:json][timeout:30];\n(\n' +
        '  way["highway"="footway"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="cycleway"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="path"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="residential"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="living_street"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="pedestrian"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="service"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="unclassified"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="tertiary"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="tertiary_link"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="secondary"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="secondary_link"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="primary"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="primary_link"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="trunk"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="trunk_link"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="crossing"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        '  way["highway"="steps"](around:' + radius + ',' + lat + ',' + lon + ');\n' +
        ');\nout body;\n>;\nout skel qt;';

    var maxRetries = 3, delay = 2000;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            var resp = await fetch("https://overpass-api.de/api/interpreter", {
                method: "POST",
                body: "data=" + encodeURIComponent(query),
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
            if (resp.status === 429 || resp.status >= 500) {
                if (attempt < maxRetries) {
                    showBanner("Path server busy, retrying (" + (attempt + 1) + "/" + maxRetries + ")...", "loading");
                    await new Promise(function (r) { setTimeout(r, delay * Math.pow(2, attempt)); });
                    continue;
                }
            }
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            var raw = await resp.json();
            var geojson = osmToGeoJSON(raw);
            await cacheSet(cacheKey, geojson);
            applyPaths(geojson, { skipRender: true });
            showBanner("");
            return;
        } catch (e) {
            if (attempt < maxRetries) {
                showBanner("Retrying path load (" + (attempt + 1) + "/" + maxRetries + ")...", "loading");
                await new Promise(function (r) { setTimeout(r, delay * Math.pow(2, attempt)); });
                continue;
            }
            showBanner("Failed to load paths: " + e.message);
        }
    }
}

function osmToGeoJSON(data) {
    var nodes = {}, features = [];
    for (var i = 0; i < (data.elements || []).length; i++) {
        var el = data.elements[i];
        if (el.type === "node") nodes[el.id] = [el.lon, el.lat];
    }
    for (var i = 0; i < (data.elements || []).length; i++) {
        var el = data.elements[i];
        if (el.type !== "way") continue;
        var coords = [];
        for (var j = 0; j < (el.nodes || []).length; j++) {
            if (nodes[el.nodes[j]]) coords.push(nodes[el.nodes[j]]);
        }
        if (coords.length < 2) continue;
        var tags = el.tags || {};
        features.push({
            type: "Feature",
            properties: { id: el.id, highway: tags.highway || "", surface: tags.surface || "", name: tags.name || "" },
            geometry: { type: "LineString", coordinates: coords },
        });
    }
    return { type: "FeatureCollection", features: features };
}

var pathStyles = {
    run: ["footway", "cycleway", "path", "pedestrian", "steps"],
    style: function (feature) {
        if (pathStyles.run.indexOf(feature.properties.highway) !== -1) return { color: "#6ee7b7", weight: 2, opacity: 0.35 };
        return { color: "#6ee7b7", weight: 1, opacity: 0.08 };
    },
    tooltip: function (feature, layer) {
        var p = feature.properties;
        var parts = [];
        if (p.name) parts.push(p.name);
        else parts.push(p.highway || "path");
        if (p.surface) parts.push(p.surface);
        layer.bindTooltip(parts.join(" · "), { sticky: true });
    },
};

function applyPaths(geojson, opts) {
    // Track seen feature IDs to avoid duplicates
    if (!state.seenIds) state.seenIds = {};

    var newFeatures = [];
    for (var i = 0; i < geojson.features.length; i++) {
        var id = geojson.features[i].properties.id;
        if (!state.seenIds[id]) {
            state.seenIds[id] = true;
            newFeatures.push(geojson.features[i]);
        }
    }

    if (newFeatures.length === 0) return;

    // Merge into pathFeatures
    if (!state.pathFeatures) {
        state.pathFeatures = { type: "FeatureCollection", features: newFeatures };
    } else {
        state.pathFeatures.features.push.apply(state.pathFeatures.features, newFeatures);
    }

    // Add new features to map layer (skip for tile-loaded data — OSM tiles show streets already)
    if (!(opts && opts.skipRender)) {
        if (!state.pathLayer) {
            state.pathLayer = L.geoJSON(null, {
                style: pathStyles.style,
                onEachFeature: pathStyles.tooltip,
            }).addTo(state.map);
        }
        var newGeo = { type: "FeatureCollection", features: newFeatures };
        state.pathLayer.addData(newGeo);
    }

    // Extend the routing graph (don't rebuild — just add new edges)
    if (!state.graph) state.graph = {};
    if (!state.edgeSet) state.edgeSet = {};
    var adj = state.graph;
    for (var f = 0; f < newFeatures.length; f++) {
        var coords = newFeatures[f].geometry.coordinates;
        var hw = newFeatures[f].properties.highway || "";
        var weight = ROAD_WEIGHT[hw] || 1.2;
        for (var c = 1; c < coords.length; c++) {
            var lat1 = coords[c-1][1], lon1 = coords[c-1][0];
            var lat2 = coords[c][1], lon2 = coords[c][0];
            var k1 = nodeKey(lat1, lon1), k2 = nodeKey(lat2, lon2);
            // Deduplicate edges
            var edgeId = k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
            if (state.edgeSet[edgeId]) continue;
            state.edgeSet[edgeId] = true;
            var d = haversine(lat1, lon1, lat2, lon2) * weight;
            if (!adj[k1]) { adj[k1] = []; gridInsert(k1, lat1, lon1); }
            if (!adj[k2]) { adj[k2] = []; gridInsert(k2, lat2, lon2); }
            adj[k1].push({ key: k2, lat: lat2, lon: lon2, dist: d });
            adj[k2].push({ key: k1, lat: lat1, lon: lon1, dist: d });
        }
    }

    console.log("Graph: " + Object.keys(adj).length + " nodes (+" + newFeatures.length + " ways)");
}

// ── Elevation (direct Open-Topo-Data API) ──────────────
async function fetchElevation(points) {
    var results = [];
    var uncached = [];
    var uncachedIdx = [];

    for (var i = 0; i < points.length; i++) {
        var ck = "elev2:" + points[i].lat.toFixed(5) + ":" + points[i].lon.toFixed(5);
        var cached = await cacheGet(ck);
        if (cached) { results.push(cached); } else { results.push(null); uncached.push(points[i]); uncachedIdx.push(i); }
    }

    // Open-Meteo elevation API — free, CORS-enabled, no key needed
    for (var b = 0; b < uncached.length; b += 100) {
        var batch = uncached.slice(b, b + 100);
        var lats = batch.map(function (p) { return p.lat.toFixed(5); }).join(",");
        var lons = batch.map(function (p) { return p.lon.toFixed(5); }).join(",");
        try {
            var resp = await fetch("https://api.open-meteo.com/v1/elevation?latitude=" + lats + "&longitude=" + lons);
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            var data = await resp.json();
            var elevArr = data.elevation || [];
            for (var j = 0; j < elevArr.length; j++) {
                var elev = elevArr[j] != null ? elevArr[j] : 0;
                var entry = { lat: batch[j].lat, lon: batch[j].lon, elevation: elev };
                results[uncachedIdx[b + j]] = entry;
                if (elevArr[j] != null) {
                    await cacheSet("elev2:" + entry.lat.toFixed(5) + ":" + entry.lon.toFixed(5), entry);
                }
            }
        } catch (e) {
            console.warn("Elevation batch failed:", e.message);
            for (var j = 0; j < batch.length; j++) {
                if (!results[uncachedIdx[b + j]]) results[uncachedIdx[b + j]] = { lat: batch[j].lat, lon: batch[j].lon, elevation: 0 };
            }
        }
    }
    return results;
}

// ── Waypoints ──────────────────────────────────────────
function wireMarkerEvents(marker) {
    marker.on("click", function (ev) {
        L.DomEvent.stopPropagation(ev);
        var idx = -1;
        for (var w = 0; w < state.waypoints.length; w++) { if (state.waypoints[w].marker === marker) { idx = w; break; } }
        removeWaypoint(idx);
    });
    marker.on("dragend", async function () {
        var pos = marker.getLatLng();
        var newKey = closestNode(state.graph, pos.lat, pos.lng);
        // If closest node is >200m away, load tiles/paths at drag target first
        if (newKey) {
            var nkParts = newKey.split(",");
            var snapDist = haversine(pos.lat, pos.lng, parseFloat(nkParts[0]), parseFloat(nkParts[1]));
            if (snapDist > 200) {
                showBanner("Loading paths for this area...", "loading");
                await loadTilesOrPaths(pos.lat, pos.lng);
                newKey = closestNode(state.graph, pos.lat, pos.lng);
            }
        } else if (state.graph) {
            // No node found at all — load tiles at drag target
            showBanner("Loading paths for this area...", "loading");
            await loadTilesOrPaths(pos.lat, pos.lng);
            newKey = closestNode(state.graph, pos.lat, pos.lng);
        }
        if (newKey) {
            var p = newKey.split(",");
            marker.setLatLng([parseFloat(p[0]), parseFloat(p[1])]);
            for (var w = 0; w < state.waypoints.length; w++) {
                if (state.waypoints[w].marker === marker) {
                    state.waypoints[w].lat = parseFloat(p[0]);
                    state.waypoints[w].lon = parseFloat(p[1]);
                    state.waypoints[w].nodeKey = newKey;
                    break;
                }
            }
        }
        updateRoute();
    });
}

function onMapClick(e) { addWaypointAt(e.latlng.lat, e.latlng.lng); }

async function addWaypointAt(lat, lon, opts) {
    // Auto-load paths if we don't have coverage here
    if (!state.graph) {
        showBanner("Loading paths for this area...", "loading");
        await loadTilesOrPaths(lat, lon);
        if (!state.graph) { showBanner("Could not load paths for this area"); return; }
    }
    var nk = closestNode(state.graph, lat, lon);
    if (!nk) return;
    // If closest node is >200m away, we probably need more paths (tiles already tried above)
    var nkParts = nk.split(",");
    var snapDist = haversine(lat, lon, parseFloat(nkParts[0]), parseFloat(nkParts[1]));
    if (snapDist > 200) {
        showBanner("Loading paths for this area...", "loading");
        await loadPaths(lat, lon);
        nk = closestNode(state.graph, lat, lon);
        if (!nk) return;
    }
    var parts = nk.split(",");
    var snapLat = parseFloat(parts[0]), snapLon = parseFloat(parts[1]);
    var displayLat = (opts && opts.exactPosition) ? lat : snapLat;
    var displayLon = (opts && opts.exactPosition) ? lon : snapLon;
    var num = state.waypoints.length + 1;
    var marker = createNumberedMarker(displayLat, displayLon, num);
    wireMarkerEvents(marker);

    state.waypoints.push({ lat: displayLat, lon: displayLon, marker: marker, nodeKey: nk });
    updateRoute();
}

function removeWaypoint(idx) {
    if (idx < 0 || idx >= state.waypoints.length) return;
    state.map.removeLayer(state.waypoints[idx].marker);
    state.waypoints.splice(idx, 1);
    for (var i = 0; i < state.waypoints.length; i++) updateMarkerNumber(state.waypoints[i].marker, i + 1);
    updateRoute();
}

// ── Gap filling ────────────────────────────────────────
async function fillGapAndRetry(fromWp, toWp) {
    // Load paths at intermediate points between two waypoints
    var dist = haversine(fromWp.lat, fromWp.lon, toWp.lat, toWp.lon);
    var steps = Math.max(1, Math.ceil(dist / 1500)); // one load every ~1.5km
    var loaded = false;

    showBanner("Expanding route coverage...", "loading");
    for (var s = 0; s <= steps; s++) {
        var t = steps === 0 ? 0.5 : s / steps;
        var midLat = fromWp.lat + t * (toWp.lat - fromWp.lat);
        var midLon = fromWp.lon + t * (toWp.lon - fromWp.lon);
        if (steps > 1) showBanner("Expanding route coverage (" + (s + 1) + "/" + (steps + 1) + ")...", "loading");
        await loadTilesOrPaths(midLat, midLon);
        loaded = true;
    }

    if (!loaded) return null;

    // Re-snap waypoints to potentially closer nodes in expanded graph
    var newFromKey = closestNode(state.graph, fromWp.lat, fromWp.lon);
    var newToKey = closestNode(state.graph, toWp.lat, toWp.lon);
    if (newFromKey) fromWp.nodeKey = newFromKey;
    if (newToKey) toWp.nodeKey = newToKey;

    return dijkstra(state.graph, fromWp.nodeKey, toWp.nodeKey);
}

// ── Route drawing ──────────────────────────────────────
var _routeGen = 0;
async function updateRoute() {
    var gen = ++_routeGen;
    for (var r = 0; r < state.routeLines.length; r++) state.map.removeLayer(state.routeLines[r]);
    state.routeLines = [];
    state.routeSegments = [];
    if (state.closingLine) { state.map.removeLayer(state.closingLine); state.closingLine = null; }
    for (var g = 0; g < state.gradientLines.length; g++) state.map.removeLayer(state.gradientLines[g]);
    state.gradientLines = [];
    if (state.routeOutline) { state.map.removeLayer(state.routeOutline); state.routeOutline = null; }
    for (var mp = 0; mp < state.midpointMarkers.length; mp++) state.map.removeLayer(state.midpointMarkers[mp]);
    state.midpointMarkers = [];

    if (state.waypoints.length < 2) { updateDistance(); updateElevation([]); return; }

    var allRouteCoords = [];
    var routeOk = true;

    for (var i = 1; i < state.waypoints.length; i++) {
        var fromWp = state.waypoints[i-1], toWp = state.waypoints[i];
        var result = dijkstra(state.graph, fromWp.nodeKey, toWp.nodeKey);

        // Check if path is missing OR unreasonably indirect (>3x straight-line distance)
        var straightDist = haversine(fromWp.lat, fromWp.lon, toWp.lat, toWp.lon);
        var needsGapFill = !result || result.path.length < 2 ||
            (result.dist > straightDist * 3 && straightDist > 200);

        if (needsGapFill) {
            result = await fillGapAndRetry(fromWp, toWp);
            if (gen !== _routeGen) return; // superseded by newer call
        }

        if (result && result.path.length > 1) {
            var segCoords = pathToCoords(result.path);
            state.routeSegments.push(segCoords);
            var line = L.polyline(segCoords, { color: "#6ee7b7", weight: 4, opacity: 0.9 }).addTo(state.map);
            state.routeLines.push(line);
            if (allRouteCoords.length === 0) allRouteCoords.push.apply(allRouteCoords, segCoords);
            else allRouteCoords.push.apply(allRouteCoords, segCoords.slice(1));
        } else {
            var fallback = [[fromWp.lat, fromWp.lon], [toWp.lat, toWp.lon]];
            state.routeSegments.push(fallback);
            var line = L.polyline(fallback, { color: "#ef4444", weight: 3, opacity: 0.7, dashArray: "8 8" }).addTo(state.map);
            state.routeLines.push(line);
            if (allRouteCoords.length === 0) allRouteCoords.push.apply(allRouteCoords, fallback);
            else allRouteCoords.push.apply(allRouteCoords, fallback.slice(1));
            routeOk = false;
        }
    }

    if (state.mode === "loop" && state.waypoints.length >= 2) {
        var lastWp = state.waypoints[state.waypoints.length-1], firstWp = state.waypoints[0];
        var closeResult = dijkstra(state.graph, lastWp.nodeKey, firstWp.nodeKey);
        var closeStraight = haversine(lastWp.lat, lastWp.lon, firstWp.lat, firstWp.lon);
        var closeNeedsGap = !closeResult || closeResult.path.length < 2 ||
            (closeResult.dist > closeStraight * 3 && closeStraight > 200);
        if (closeNeedsGap) {
            closeResult = await fillGapAndRetry(lastWp, firstWp);
            if (gen !== _routeGen) return; // superseded by newer call
        }
        if (closeResult && closeResult.path.length > 1) {
            var closeCoords = pathToCoords(closeResult.path);
            state.closingLine = L.polyline(closeCoords, { color: "#6ee7b7", weight: 4, opacity: 0.6, dashArray: "10 6" }).addTo(state.map);
            allRouteCoords.push.apply(allRouteCoords, closeCoords.slice(1));
        } else {
            state.closingLine = L.polyline([[lastWp.lat,lastWp.lon],[firstWp.lat,firstWp.lon]], { color: "#ef4444", weight: 3, opacity: 0.5, dashArray: "8 8" }).addTo(state.map);
        }
    }

    if (!routeOk) showBanner("Some segments have no footpath connection (shown in red)");
    else showBanner("");

    addMidpointMarkers();
    updateDistance();
    debouncedFetchElevation(allRouteCoords);
    updateShareHash();
    saveRoute();
}

var _elevationTimer = null;
function debouncedFetchElevation(coords) {
    clearTimeout(_elevationTimer);
    _elevationTimer = setTimeout(function () { fetchRouteElevation(coords); }, 400);
}

// ── Midpoint markers (drag to insert waypoint) ─────────
function addMidpointMarkers() {
    // Clear old midpoints
    for (var m = 0; m < state.midpointMarkers.length; m++) {
        state.map.removeLayer(state.midpointMarkers[m]);
    }
    state.midpointMarkers = [];

    if (state.waypoints.length < 2) return;

    // Add midpoint between each consecutive pair
    var pairs = [];
    for (var i = 0; i < state.waypoints.length - 1; i++) {
        pairs.push({ afterIdx: i });
    }
    // Loop closing midpoint
    if (state.mode === "loop" && state.waypoints.length >= 2) {
        pairs.push({ afterIdx: state.waypoints.length - 1, closing: true });
    }

    for (var p = 0; p < pairs.length; p++) {
        (function (pair) {
            var fromIdx = pair.afterIdx;
            var toIdx = pair.closing ? 0 : fromIdx + 1;

            // Find midpoint along the actual routed segment
            var segCoords;
            if (pair.closing && state.closingLine) {
                var cls = state.closingLine.getLatLngs();
                segCoords = cls.map(function (ll) { return [ll.lat, ll.lng]; });
            } else if (!pair.closing && state.routeSegments[fromIdx]) {
                segCoords = state.routeSegments[fromIdx];
            }

            var midLat, midLon;
            if (segCoords && segCoords.length >= 2) {
                // Walk along segment to find the geographic midpoint
                var totalDist = 0;
                for (var s = 1; s < segCoords.length; s++) {
                    totalDist += haversine(segCoords[s-1][0], segCoords[s-1][1], segCoords[s][0], segCoords[s][1]);
                }
                var halfDist = totalDist / 2, acc = 0;
                midLat = segCoords[0][0];
                midLon = segCoords[0][1];
                for (var s = 1; s < segCoords.length; s++) {
                    var d = haversine(segCoords[s-1][0], segCoords[s-1][1], segCoords[s][0], segCoords[s][1]);
                    if (acc + d >= halfDist) {
                        var ratio = (halfDist - acc) / d;
                        midLat = segCoords[s-1][0] + ratio * (segCoords[s][0] - segCoords[s-1][0]);
                        midLon = segCoords[s-1][1] + ratio * (segCoords[s][1] - segCoords[s-1][1]);
                        break;
                    }
                    acc += d;
                }
            } else {
                // Fallback to straight-line midpoint
                var from = state.waypoints[fromIdx];
                var to = state.waypoints[toIdx];
                midLat = (from.lat + to.lat) / 2;
                midLon = (from.lon + to.lon) / 2;
            }

            var el = document.createElement("div");
            el.style.cssText =
                "background:rgba(110,231,183,0.4);border:2px dashed #6ee7b7;border-radius:50%;" +
                "width:18px;height:18px;cursor:grab;";

            var icon = L.divIcon({
                html: el.outerHTML,
                className: "",
                iconSize: [18, 18],
                iconAnchor: [9, 9],
            });

            var mid = L.marker([midLat, midLon], {
                icon: icon,
                draggable: true,
                zIndexOffset: -50,
            }).addTo(state.map);

            mid.on("dragend", function () {
                var pos = mid.getLatLng();
                // Insert a new waypoint after fromIdx
                var insertIdx = pair.closing ? state.waypoints.length : fromIdx + 1;

                // Snap to graph
                var nk = state.graph ? closestNode(state.graph, pos.lat, pos.lng) : null;
                var snapLat = pos.lat, snapLon = pos.lng;
                if (nk) {
                    var parts = nk.split(",");
                    snapLat = parseFloat(parts[0]);
                    snapLon = parseFloat(parts[1]);
                }

                var num = insertIdx + 1;
                var marker = createNumberedMarker(snapLat, snapLon, num);
                wireMarkerEvents(marker);

                var wp = { lat: snapLat, lon: snapLon, marker: marker, nodeKey: nk || nodeKey(snapLat, snapLon) };
                state.waypoints.splice(insertIdx, 0, wp);

                // Renumber all markers
                for (var i = 0; i < state.waypoints.length; i++) {
                    updateMarkerNumber(state.waypoints[i].marker, i + 1);
                }

                updateRoute();
            });

            state.midpointMarkers.push(mid);
        })(pairs[p]);
    }
}

// ── Distance ───────────────────────────────────────────
function updateDistance() {
    var total = 0;
    for (var s = 0; s < state.routeSegments.length; s++) {
        var seg = state.routeSegments[s];
        for (var i = 1; i < seg.length; i++) total += haversine(seg[i-1][0], seg[i-1][1], seg[i][0], seg[i][1]);
    }
    if (state.mode === "loop" && state.closingLine) {
        var cl = state.closingLine.getLatLngs();
        for (var i = 1; i < cl.length; i++) total += haversine(cl[i-1].lat, cl[i-1].lng, cl[i].lat, cl[i].lng);
    } else if (state.mode === "outback") { total *= 2; }
    // oneway: use raw total as-is

    state.totalDistMetres = total;
    var distText;
    if (state.useMiles) {
        distText = (total / 1609.344).toFixed(1) + " mi";
    } else {
        distText = (total / 1000).toFixed(1) + " km";
    }
    document.getElementById("distance-display").textContent = distText;
    updateDistanceMarkers();
}

// ── Distance markers ───────────────────────────────────
function updateDistanceMarkers() {
    for (var m = 0; m < state.distanceMarkers.length; m++) state.map.removeLayer(state.distanceMarkers[m]);
    state.distanceMarkers = [];
    var interval = state.useMiles ? 1609.344 : 1000; // 1 mile or 1 km
    var suffix = state.useMiles ? "mi" : "k";
    if (state.totalDistMetres < interval) return;

    var coords = [];
    for (var s = 0; s < state.routeSegments.length; s++) {
        var seg = state.routeSegments[s];
        var start = coords.length === 0 ? 0 : 1;
        for (var ci = start; ci < seg.length; ci++) coords.push(seg[ci]);
    }
    if (state.mode === "loop" && state.closingLine) {
        var cl = state.closingLine.getLatLngs();
        for (var ci = 1; ci < cl.length; ci++) coords.push([cl[ci].lat, cl[ci].lng]);
    }
    if (coords.length < 2) return;

    var accumulated = 0, nextMark = interval, markNum = 1;
    for (var i = 1; i < coords.length; i++) {
        var d = haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
        accumulated += d;
        while (accumulated >= nextMark) {
            var ratio = 1 - (accumulated - nextMark) / d;
            var lat = coords[i-1][0] + ratio * (coords[i][0] - coords[i-1][0]);
            var lon = coords[i-1][1] + ratio * (coords[i][1] - coords[i-1][1]);
            var el = document.createElement("div");
            el.style.cssText = "background:#fff;color:#1a1d28;border-radius:8px;padding:1px 5px;font-size:10px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,0.5);";
            el.textContent = markNum + suffix;
            var mkr = L.marker([lat, lon], {
                icon: L.divIcon({ html: el.outerHTML, className: "", iconSize: [30,16], iconAnchor: [15,8] }),
                interactive: false, zIndexOffset: -100,
            }).addTo(state.map);
            state.distanceMarkers.push(mkr);
            markNum++;
            nextMark += interval;
        }
    }
}

// ── Elevation profile ──────────────────────────────────
async function fetchRouteElevation(coords) {
    if (coords.length < 2) { updateElevation([]); return; }
    var sampled = sampleRoute(coords, 50);
    var locations = sampled.map(function (p) { return { lat: p[0], lon: p[1] }; });
    if (locations.length === 0) { updateElevation([]); return; }

    try {
        var results = await fetchElevation(locations);
        state.lastElevationData = results;
        updateElevation(results);
        colourRouteByGradient(results);
    } catch (e) {
        console.warn("Elevation fetch failed:", e.message);
        state.lastElevationData = [];
        updateElevation([]);
    }
}

function sampleRoute(coords, intervalMetres) {
    var points = [coords[0]], accumulated = 0;
    for (var i = 1; i < coords.length; i++) {
        var d = haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
        accumulated += d;
        if (accumulated >= intervalMetres) { points.push(coords[i]); accumulated = 0; }
    }
    var last = coords[coords.length-1], lastS = points[points.length-1];
    if (last[0] !== lastS[0] || last[1] !== lastS[1]) points.push(last);
    return points;
}

function smoothElevations(elevData) {
    if (elevData.length < 2) return elevData;
    var alpha = 0.6;
    var smoothed = [elevData[0]];
    for (var i = 1; i < elevData.length; i++) {
        var prev = smoothed[i-1].elevation;
        var curr = elevData[i].elevation;
        smoothed.push({ lat: elevData[i].lat, lon: elevData[i].lon, elevation: alpha * curr + (1 - alpha) * prev });
    }
    // Reverse pass to remove lag
    for (var i = smoothed.length - 2; i >= 0; i--) {
        smoothed[i] = { lat: smoothed[i].lat, lon: smoothed[i].lon, elevation: alpha * smoothed[i].elevation + (1 - alpha) * smoothed[i+1].elevation };
    }
    return smoothed;
}

function colourRouteByGradient(elevData) {
    elevData = smoothElevations(elevData);
    if (elevData.length < 2) return;
    for (var r = 0; r < state.routeLines.length; r++) state.map.removeLayer(state.routeLines[r]);
    state.routeLines = [];
    if (state.closingLine) { state.map.removeLayer(state.closingLine); state.closingLine = null; }
    if (state.routeOutline) { state.map.removeLayer(state.routeOutline); state.routeOutline = null; }

    // Build [lat, lon, grade%] array for hotline
    // First point has no grade — use 0 (flat)
    var coords = [[elevData[0].lat, elevData[0].lon, 0]];
    for (var i = 1; i < elevData.length; i++) {
        var prev = elevData[i-1], curr = elevData[i];
        var dist = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
        var grade = 0;
        if (dist > 0) grade = ((curr.elevation - prev.elevation) / dist) * 100;
        // Clamp to ±15% for colour mapping
        grade = Math.max(-15, Math.min(15, grade));
        coords.push([curr.lat, curr.lon, grade]);
    }

    // Hotline palette: blue (downhill) → green (flat) → yellow → red (uphill)
    // min=-15 maps to 0.0, 0 maps to 0.5, max=+15 maps to 1.0
    var hotline = L.hotline(coords, {
        min: -15,
        max: 15,
        palette: {
            0.0:  '#3b82f6',  // very steep downhill
            0.17: '#60a5fa',  // steep downhill
            0.33: '#93c5fd',  // moderate downhill
            0.43: '#6ee7b7',  // flat
            0.57: '#6ee7b7',  // flat
            0.67: '#fbbf24',  // moderate uphill
            0.83: '#f87171',  // steep uphill
            1.0:  '#dc2626',  // very steep uphill
        },
        weight: 5,
        outlineWidth: 1,
        outlineColor: '#000',
    }).addTo(state.map);
    state.gradientLines.push(hotline);
}

function updateElevation(elevData) {
    var container = document.getElementById("elevation-container");
    var statsEl = document.getElementById("elevation-stats");
    if (elevData.length < 2) {
        container.style.display = "none";
        statsEl.style.display = "none";
        return;
    }

    container.style.display = "block";
    statsEl.style.display = "flex";

    var distances = [0];
    for (var i = 1; i < elevData.length; i++) {
        distances.push(distances[i-1] + haversine(elevData[i-1].lat, elevData[i-1].lon, elevData[i].lat, elevData[i].lon));
    }
    elevData = smoothElevations(elevData);
    var elevations = elevData.map(function (e) { return e.elevation; });

    var totalAscent = 0, totalDescent = 0, maxGradient = 0;
    var DEAD_BAND = 2; // metres — ignore cumulative changes below this
    var pending = 0;
    var segGradients = [0]; // signed grade% per point; index 0 has no prior segment
    for (var i = 1; i < elevations.length; i++) {
        var diff = elevations[i] - elevations[i-1];
        pending += diff;
        if (pending > DEAD_BAND) { totalAscent += pending; pending = 0; }
        else if (pending < -DEAD_BAND) { totalDescent += Math.abs(pending); pending = 0; }
        var segDist = distances[i] - distances[i-1];
        var gradePct = 0;
        if (segDist > 0) { gradePct = (diff / segDist) * 100; var g = Math.abs(gradePct); if (g > maxGradient) maxGradient = g; }
        segGradients.push(gradePct);
    }
    document.getElementById("stat-ascent").textContent = Math.round(totalAscent) + "m";
    document.getElementById("stat-descent").textContent = Math.round(totalDescent) + "m";
    document.getElementById("stat-gradient").textContent = maxGradient.toFixed(1) + "%";

    // Grade-to-colour mapping matching the hotline palette on the map
    function gradeColor(grade) {
        var g = Math.max(-15, Math.min(15, grade));
        if (g <= -10) return "#3b82f6";  // very steep downhill
        if (g <= -5)  return "#60a5fa";  // steep downhill
        if (g <= -2)  return "#93c5fd";  // moderate downhill
        if (g <= 2)   return "#6ee7b7";  // flat
        if (g <= 5)   return "#fbbf24";  // moderate uphill
        if (g <= 10)  return "#f87171";  // steep uphill
        return "#dc2626";                // very steep uphill
    }
    function gradeFill(grade) {
        var g = Math.max(-15, Math.min(15, grade));
        if (g <= -10) return "rgba(59,130,246,0.18)";
        if (g <= -5)  return "rgba(96,165,250,0.15)";
        if (g <= -2)  return "rgba(147,197,253,0.12)";
        if (g <= 2)   return "rgba(110,231,183,0.1)";
        if (g <= 5)   return "rgba(251,191,36,0.15)";
        if (g <= 10)  return "rgba(248,113,113,0.15)";
        return "rgba(220,38,38,0.18)";
    }

    var ctx = document.getElementById("elevation-canvas").getContext("2d");
    if (state.elevationChart) state.elevationChart.destroy();
    state.elevationChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: distances.map(function (d) { return (d/1000).toFixed(1); }),
            datasets: [{
                data: elevations, borderColor: "#6ee7b7", backgroundColor: "rgba(110,231,183,0.1)",
                fill: true, pointRadius: 0, tension: 0.3, borderWidth: 2,
                segment: {
                    borderColor: function (ctx) { return gradeColor(segGradients[ctx.p1DataIndex]); },
                    backgroundColor: function (ctx) { return gradeFill(segGradients[ctx.p1DataIndex]); },
                },
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { title: { display: true, text: "Distance (km)", color: "#888" }, ticks: { color: "#888", maxTicksLimit: 10 }, grid: { color: "#1a1a2e" } },
                y: { title: { display: true, text: "Elevation (m)", color: "#888" }, ticks: { color: "#888" }, grid: { color: "#1a1a2e" } },
            },
        },
    });
}

// ── GPX export ─────────────────────────────────────────
async function exportGPX() {
    if (state.routeSegments.length === 0) return;
    var coords = [];
    for (var s = 0; s < state.routeSegments.length; s++) {
        var seg = state.routeSegments[s];
        if (coords.length === 0) coords.push.apply(coords, seg);
        else coords.push.apply(coords, seg.slice(1));
    }
    if (state.mode === "loop" && state.closingLine) {
        var cl = state.closingLine.getLatLngs();
        for (var i = 1; i < cl.length; i++) coords.push([cl[i].lat, cl[i].lng]);
    }
    if (state.mode === "outback" && coords.length > 1) {
        coords = coords.concat(coords.slice().reverse().slice(1));
    }
    var km = (state.totalDistMetres / 1000).toFixed(1);
    var date = new Date().toISOString().split("T")[0];
    var name = "legwork-" + date + "-" + km + "km";
    // Build elevation lookup from cached data
    var elevLookup = {};
    for (var e = 0; e < state.lastElevationData.length; e++) {
        var ed = state.lastElevationData[e];
        if (ed) elevLookup[ed.lat.toFixed(5) + "," + ed.lon.toFixed(5)] = ed.elevation;
    }

    var gpx = ['<?xml version="1.0" encoding="UTF-8"?>','<gpx version="1.1" creator="Legwork" xmlns="http://www.topografix.com/GPX/1/1">','  <trk>','    <name>'+name+'</name>','    <trkseg>'];
    for (var i = 0; i < coords.length; i++) {
        var elevKey = coords[i][0].toFixed(5) + "," + coords[i][1].toFixed(5);
        var elev = elevLookup[elevKey];
        // Also check IndexedDB elevation cache
        if (elev === undefined) {
            var cached = await cacheGet("elev2:" + coords[i][0].toFixed(5) + ":" + coords[i][1].toFixed(5));
            if (cached) elev = cached.elevation;
        }
        if (elev !== undefined) {
            gpx.push('      <trkpt lat="'+coords[i][0]+'" lon="'+coords[i][1]+'"><ele>'+elev.toFixed(1)+'</ele></trkpt>');
        } else {
            gpx.push('      <trkpt lat="'+coords[i][0]+'" lon="'+coords[i][1]+'"></trkpt>');
        }
    }
    gpx.push('    </trkseg>','  </trk>','</gpx>');
    var blob = new Blob([gpx.join("\n")], { type: "application/gpx+xml" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = name + ".gpx"; a.click();
    URL.revokeObjectURL(url);
}

// ── Utils ──────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = function(x) { return x * Math.PI / 180; };
    var dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function showBanner(msg, type) {
    var el = document.getElementById("info-banner");
    el.textContent = msg;
    el.className = "info-banner" + (type ? " " + type : " error");
    el.dataset.type = type || "";
    el.style.display = msg ? "block" : "none";
}

// ── Event bindings ─────────────────────────────────────
document.getElementById("address-input").addEventListener("keydown", function (e) { if (e.key === "Enter") geocodeAddress(); });
var MODE_LABELS = { loop: "\u21BB Loop", outback: "\u21C4 Out & Back", oneway: "\u2192 One Way" };
function setModeButton() {
    document.getElementById("mode-btn").textContent = MODE_LABELS[state.mode] || MODE_LABELS.loop;
}

// ── Reverse button visibility ─────────────────────────
function updateReverseVisibility() {
    var btn = document.getElementById("reverse-btn");
    btn.style.display = state.mode === "loop" ? "" : "none";
}

document.getElementById("mode-btn").addEventListener("click", function () {
    state.mode = state.mode === "loop" ? "outback" : state.mode === "outback" ? "oneway" : "loop";
    setModeButton();
    this.setAttribute("aria-label", "Route mode: " + state.mode);
    updateReverseVisibility();
    updateRoute();
});
document.getElementById("reverse-btn").addEventListener("click", function () {
    if (state.waypoints.length < 2) return;
    state.waypoints.reverse();
    for (var i = 0; i < state.waypoints.length; i++) updateMarkerNumber(state.waypoints[i].marker, i + 1);
    updateRoute();
});
document.getElementById("clear-btn").addEventListener("click", function () {
    for (var i = 0; i < state.waypoints.length; i++) state.map.removeLayer(state.waypoints[i].marker);
    state.waypoints = [];
    updateRoute();
});
document.getElementById("export-btn").addEventListener("click", function () {
    closeMenu();
    exportGPX();
});

// ── GPS location dot ──────────────────────────────────
var gpsDotMarker = null;

function showGpsDot(lat, lon) {
    if (gpsDotMarker) state.map.removeLayer(gpsDotMarker);
    var icon = L.divIcon({
        html: '<div class="gps-dot"></div>',
        className: "",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
    });
    gpsDotMarker = L.marker([lat, lon], { icon: icon, interactive: false, zIndexOffset: -200 }).addTo(state.map);
}

document.getElementById("locate-btn").addEventListener("click", function () {
    function startHere(lat, lon) {
        // Clear existing route
        for (var i = 0; i < state.waypoints.length; i++) state.map.removeLayer(state.waypoints[i].marker);
        state.waypoints = [];
        updateRoute();
        state.startLat = lat;
        state.startLon = lon;
        state.map.setView([lat, lon], 15);
        showGpsDot(lat, lon);
        loadTilesOrPaths(lat, lon).then(function () {
            if (state.graph) addWaypointAt(lat, lon, { exactPosition: true });
        });
    }
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function (pos) { startHere(pos.coords.latitude, pos.coords.longitude); },
            function () { showBanner("Could not get your location"); },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    }
});

// ── Distance action dropdown ──────────────────────────
var distWrapper = document.querySelector(".distance-wrapper");
var distMenu = document.getElementById("distance-menu");

function closeDistMenu() {
    distMenu.classList.add("hidden");
    distWrapper.classList.remove("open");
}

distWrapper.addEventListener("click", function () {
    if (state.waypoints.length < 2) return;
    if (!distMenu.classList.contains("hidden")) {
        closeDistMenu();
    } else {
        distMenu.classList.remove("hidden");
        distWrapper.classList.add("open");
    }
});

document.addEventListener("click", function (e) {
    if (!distMenu.classList.contains("hidden") && !distWrapper.contains(e.target)) {
        closeDistMenu();
    }
});

document.getElementById("dm-save").addEventListener("click", function (e) {
    e.stopPropagation(); closeDistMenu(); saveNamedRoute();
});

document.getElementById("dm-export").addEventListener("click", function (e) {
    e.stopPropagation(); closeDistMenu(); exportGPX();
});

document.getElementById("dm-share").addEventListener("click", function (e) {
    e.stopPropagation(); closeDistMenu();
    var url = window.location.href;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
            showBanner("Link copied!");
            setTimeout(function () { showBanner(""); }, 2000);
        });
    } else {
        prompt("Copy this link:", url);
    }
});
document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (state.waypoints.length > 1) removeWaypoint(state.waypoints.length - 1);
    }
});

// ── Hamburger menu ────────────────────────────────────
function openMenu() {
    document.getElementById("side-menu").classList.add("open");
    document.getElementById("menu-overlay").classList.remove("hidden");
    document.getElementById("menu-btn").setAttribute("aria-expanded", "true");
}
function closeMenu() {
    document.getElementById("side-menu").classList.remove("open");
    document.getElementById("menu-overlay").classList.add("hidden");
    document.getElementById("menu-btn").setAttribute("aria-expanded", "false");
}
document.getElementById("menu-btn").addEventListener("click", openMenu);
document.getElementById("menu-close").addEventListener("click", closeMenu);
document.getElementById("menu-overlay").addEventListener("click", closeMenu);

// ── Unit toggle (in menu) ─────────────────────────────
document.getElementById("unit-toggle").addEventListener("click", function () {
    state.useMiles = !state.useMiles;
    document.getElementById("unit-label").textContent = state.useMiles ? "mi" : "km";
    updateDistance();
});

// ── Auto-detect miles for US/UK/MM/LR ─────────────────
var MILES_COUNTRIES = ["US", "GB", "MM", "LR"];
function autoDetectUnits(lat, lon) {
    fetch("https://photon.komoot.io/reverse?lat=" + lat + "&lon=" + lon + "&limit=1")
        .then(function (r) { return r.json(); })
        .then(function (data) {
            var feat = (data.features || [])[0];
            if (feat && feat.properties && feat.properties.countrycode) {
                var code = feat.properties.countrycode.toUpperCase();
                if (MILES_COUNTRIES.indexOf(code) !== -1) {
                    state.useMiles = true;
                    document.getElementById("unit-label").textContent = "mi";
                    updateDistance();
                }
            }
        })
        .catch(function () {});
}

// ── New route ─────────────────────────────────────────
document.getElementById("save-route-btn").addEventListener("click", saveNamedRoute);
// ── Route persistence ─────────────────────────────────
function saveRoute() {
    if (state.waypoints.length === 0) {
        localStorage.removeItem("lw:savedRoute");
        return;
    }
    var data = {
        waypoints: state.waypoints.map(function (wp) {
            return { lat: wp.lat, lon: wp.lon, nodeKey: wp.nodeKey };
        }),
        mode: state.mode,
        zoom: state.map.getZoom(),
    };
    try { localStorage.setItem("lw:savedRoute", JSON.stringify(data)); } catch (e) {}
}

function loadSavedRoute() {
    try {
        var raw = localStorage.getItem("lw:savedRoute");
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) { return null; }
}

// ── Install prompt ────────────────────────────────────
var deferredInstallPrompt = null;

function setupInstallPrompt() {
    var el = document.getElementById("install-prompt");
    // Already running as installed PWA
    if (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone) return;

    // Android/Chrome: capture the beforeinstallprompt event
    window.addEventListener("beforeinstallprompt", function (e) {
        e.preventDefault();
        deferredInstallPrompt = e;
        el.textContent = "Install app";
        el.classList.remove("hidden");
        el.style.cursor = "pointer";
        el.addEventListener("click", function () {
            deferredInstallPrompt.prompt();
            deferredInstallPrompt.userChoice.then(function () {
                deferredInstallPrompt = null;
                el.classList.add("hidden");
            });
        });
    });

    // iOS Safari: show manual hint
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|FxiOS/.test(navigator.userAgent);
    if (isIOS && isSafari) {
        el.innerHTML = 'Add to Home Screen: tap <strong>Share</strong> → <strong>Add to Home Screen</strong>';
        el.classList.remove("hidden");
    }
}

// ── Share link ─────────────────────────────────────────
function updateShareHash() {
    if (state.waypoints.length < 2) { history.replaceState(null, "", window.location.pathname); return; }
    var pts = state.waypoints.map(function (wp) { return wp.lat.toFixed(5) + "," + wp.lon.toFixed(5); });
    history.replaceState(null, "", "#r=" + pts.join(";") + "&m=" + state.mode);
}

function loadFromHash() {
    var hash = window.location.hash.replace("#", "");
    if (!hash) return false;
    var params = {};
    hash.split("&").forEach(function (part) { var kv = part.split("="); params[kv[0]] = kv[1]; });
    if (!params.r) return false;
    var points = params.r.split(";").map(function (p) {
        var parts = p.split(",");
        return { lat: parseFloat(parts[0]), lon: parseFloat(parts[1]) };
    });
    if (points.length < 2) return false;
    if (params.m === "outback" || params.m === "loop" || params.m === "oneway") {
        state.mode = params.m;
        setModeButton();
        updateReverseVisibility();
    }
    return points;
}

// ── Welcome modal ──────────────────────────────────────
function showWelcome() {
    var modal = document.getElementById("welcome-modal");
    try {
        if (localStorage.getItem("lw:welcomed")) {
            modal.classList.add("hidden");
            return;
        }
    } catch (e) { /* blocked storage — show modal every time */ }
    // Only reached for first-time users
    var isMacDesktop = /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;
    var undoKey = document.getElementById("undo-key");
    if (undoKey && isMacDesktop) undoKey.textContent = "\u2318";
    function onEsc(e) {
        if (e.key === "Escape" && !modal.classList.contains("hidden")) dismiss();
    }
    function dismiss() {
        modal.classList.add("hidden");
        document.removeEventListener("keydown", onEsc);
        try { localStorage.setItem("lw:welcomed", "1"); } catch (e) { /* blocked storage */ }
    }
    document.getElementById("welcome-dismiss").addEventListener("click", dismiss);
    modal.addEventListener("click", function (e) {
        if (e.target === modal) dismiss();
    });
    document.addEventListener("keydown", onEsc);
}

// ── Saved Routes ──────────────────────────────────────
function saveNamedRoute() {
    if (state.waypoints.length < 2) { showBanner("Add at least 2 waypoints first"); return; }

    var inputRow = document.getElementById("save-route-input");
    var nameInput = document.getElementById("save-route-name");
    var dist = document.getElementById("distance-display").textContent;

    // Show input immediately with distance, then update with geocoded name in background
    nameInput.value = "Route \u2014 " + dist;
    inputRow.classList.remove("hidden");
    nameInput.focus();
    nameInput.select();

    var startWp = state.waypoints[0];
    if (navigator.onLine) {
        fetch("https://photon.komoot.io/reverse?lat=" + startWp.lat + "&lon=" + startWp.lon + "&limit=1")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var feat = (data.features || [])[0];
                if (feat && feat.properties) {
                    var p = feat.properties;
                    var name = p.name || p.street || p.city;
                    if (name && inputRow.classList.contains("hidden") === false) {
                        nameInput.value = name + " \u2014 " + dist;
                        nameInput.select();
                    }
                }
            })
            .catch(function () {});
    }
}

async function confirmSaveRoute() {
    var inputRow = document.getElementById("save-route-input");
    var nameInput = document.getElementById("save-route-name");
    var name = nameInput.value.trim();
    if (!name) return;

    inputRow.classList.add("hidden");

    var dist = document.getElementById("distance-display").textContent;
    var routeData = {
        name: name,
        distance: dist,
        waypoints: state.waypoints.map(function (wp) {
            return { lat: wp.lat, lon: wp.lon, nodeKey: wp.nodeKey };
        }),
        mode: state.mode,
        zoom: state.map.getZoom(),
        center: { lat: state.map.getCenter().lat, lon: state.map.getCenter().lng },
        routeSegments: state.routeSegments,
        elevationData: state.lastElevationData,
        ts: Date.now(),
    };

    try {
        var db = await openDB();
        await new Promise(function (resolve, reject) {
            var tx = db.transaction("savedRoutes", "readwrite");
            tx.objectStore("savedRoutes").add(routeData);
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
        });
        showBanner("Route saved: " + name);
        renderSavedRoutes();
    } catch (e) {
        showBanner("Failed to save route: " + e.message);
    }
}

document.getElementById("save-route-confirm").addEventListener("click", confirmSaveRoute);
document.getElementById("save-route-name").addEventListener("keydown", function (e) {
    if (e.key === "Enter") confirmSaveRoute();
    if (e.key === "Escape") document.getElementById("save-route-input").classList.add("hidden");
});

async function loadSavedRoutes() {
    try {
        var db = await openDB();
        return new Promise(function (resolve) {
            var tx = db.transaction("savedRoutes", "readonly");
            var req = tx.objectStore("savedRoutes").getAll();
            req.onsuccess = function () { resolve(req.result || []); };
            req.onerror = function () { resolve([]); };
        });
    } catch (e) { return []; }
}

async function restoreSavedRoute(id) {
    try {
        var db = await openDB();
        var route = await new Promise(function (resolve) {
            var tx = db.transaction("savedRoutes", "readonly");
            var req = tx.objectStore("savedRoutes").get(id);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { resolve(null); };
        });
        if (!route) { showBanner("Route not found"); return; }

        // Clear existing state
        for (var i = 0; i < state.waypoints.length; i++) state.map.removeLayer(state.waypoints[i].marker);
        state.waypoints = [];
        for (var r = 0; r < state.routeLines.length; r++) state.map.removeLayer(state.routeLines[r]);
        state.routeLines = [];
        for (var g = 0; g < state.gradientLines.length; g++) state.map.removeLayer(state.gradientLines[g]);
        state.gradientLines = [];
        if (state.routeOutline) { state.map.removeLayer(state.routeOutline); state.routeOutline = null; }
        if (state.closingLine) { state.map.removeLayer(state.closingLine); state.closingLine = null; }
        for (var mp = 0; mp < state.midpointMarkers.length; mp++) state.map.removeLayer(state.midpointMarkers[mp]);
        state.midpointMarkers = [];
        for (var dm = 0; dm < state.distanceMarkers.length; dm++) state.map.removeLayer(state.distanceMarkers[dm]);
        state.distanceMarkers = [];

        // Restore mode
        state.mode = route.mode || "loop";
        setModeButton();
        updateReverseVisibility();

        // Restore map position
        state.map.setView([route.center.lat, route.center.lon], route.zoom || 14);

        // Restore path network from tiles or Overpass
        await loadTilesOrPaths(route.center.lat, route.center.lon);

        // Restore waypoints
        for (var i = 0; i < route.waypoints.length; i++) {
            var wp = route.waypoints[i];
            var marker = createNumberedMarker(wp.lat, wp.lon, i + 1);
            wireMarkerEvents(marker);
            state.waypoints.push({ lat: wp.lat, lon: wp.lon, marker: marker, nodeKey: wp.nodeKey });
        }

        // Rebuild route fully (includes closing segment, elevation, gradient colours)
        await updateRoute();
        closeMenu();
        showBanner("Loaded: " + route.name);
    } catch (e) {
        showBanner("Failed to load route: " + e.message);
    }
}

async function deleteSavedRoute(id) {
    try {
        var db = await openDB();
        await new Promise(function (resolve, reject) {
            var tx = db.transaction("savedRoutes", "readwrite");
            tx.objectStore("savedRoutes").delete(id);
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
        });
    } catch (e) {}
    renderSavedRoutes();
}

async function renderSavedRoutes() {
    var list = document.getElementById("saved-routes-list");
    if (!list) return;
    var routes = await loadSavedRoutes();
    while (list.firstChild) list.removeChild(list.firstChild);
    if (routes.length === 0) {
        list.classList.add("hidden");
        return;
    }
    list.classList.remove("hidden");
    for (var i = 0; i < routes.length; i++) {
        (function (route) {
            var row = document.createElement("div");
            row.className = "saved-item";
            var info = document.createElement("div");
            info.style.cssText = "flex:1;overflow:hidden;cursor:pointer;";
            var label = document.createElement("div");
            label.className = "saved-item-name";
            label.textContent = route.name;
            var detail = document.createElement("div");
            detail.className = "saved-item-detail";
            var parts = [];
            if (route.distance) parts.push(route.distance);
            parts.push(new Date(route.ts).toLocaleDateString());
            detail.textContent = parts.join(" \u00b7 ");
            info.appendChild(label);
            info.appendChild(detail);
            info.addEventListener("click", function () {
                restoreSavedRoute(route.id);
            });
            var del = document.createElement("button");
            del.className = "saved-item-delete";
            del.textContent = "\u00d7";
            del.title = "Delete saved route";
            del.addEventListener("click", function (e) {
                e.stopPropagation();
                deleteSavedRoute(route.id);
            });
            row.appendChild(info);
            row.appendChild(del);
            list.appendChild(row);
        })(routes[i]);
    }
}

// ── Offline indicator ──────────────────────────────────
function updateOnlineStatus() {
    var searchEl = document.getElementById("address-input");
    if (!navigator.onLine) {
        showBanner("You're offline \u2014 saved routes still work", "offline");
        if (searchEl) {
            searchEl.placeholder = "Search unavailable offline";
            searchEl.disabled = true;
        }
    } else {
        var banner = document.getElementById("info-banner");
        if (banner && banner.dataset.type === "offline") showBanner("");
        if (searchEl) {
            searchEl.placeholder = "Set starting point...";
            searchEl.disabled = false;
        }
    }
}
window.addEventListener("online", updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);

// ── Service worker ────────────────────────────────────
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function (e) {
        console.warn("SW registration failed:", e.message);
    });
}

// ── Responsive resize ─────────────────────────────────
window.addEventListener("resize", function () {
    if (state.map) state.map.invalidateSize();
});

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
    renderSavedRoutes();
});

var sharedPoints = loadFromHash();
var savedRoute = !sharedPoints ? loadSavedRoute() : null;

if (sharedPoints) {
    // Restore from share link
    var center = sharedPoints[0];
    state.map.setView([center.lat, center.lon], 14);
    autoDetectUnits(center.lat, center.lon);
    loadTilesOrPaths(center.lat, center.lon).then(async function () {
        for (var i = 0; i < sharedPoints.length; i++) await addWaypointAt(sharedPoints[i].lat, sharedPoints[i].lon, { exactPosition: i === 0 });
    });
} else if (savedRoute && savedRoute.waypoints && savedRoute.waypoints.length > 0) {
    // Restore last session's route
    if (savedRoute.mode) {
        state.mode = savedRoute.mode;
        setModeButton();
        updateReverseVisibility();
    }
    var sw = savedRoute.waypoints;
    var ctr = sw[0];
    state.map.setView([ctr.lat, ctr.lon], savedRoute.zoom || 14);
    autoDetectUnits(ctr.lat, ctr.lon);
    loadTilesOrPaths(ctr.lat, ctr.lon).then(async function () {
        for (var i = 0; i < sw.length; i++) await addWaypointAt(sw[i].lat, sw[i].lon, { exactPosition: i === 0 });
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
            showGpsDot(lat, lon);
            loadTilesForLocation(lat, lon).then(function (loaded) {
                if (!loaded) {
                    showCityRequest();
                    return loadPaths(lat, lon);
                }
            }).then(function () {
                if (state.graph) addWaypointAt(lat, lon, { exactPosition: true });
            });
        },
        function () {
            // Geolocation failed — prompt user to search
            openMenu();
            var input = document.getElementById("address-input");
            if (input) { input.focus(); input.placeholder = "Search for your location to get started"; }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
}

// ── Legwork — Static Running Route Planner ─────────────
// All API calls go directly to free external services.
// No backend required. Runs on GitHub Pages.
//
// Load order (see index.html): routing.js → storage.js → tiles.js → app.js.
// Pure domain code lives in routing.js; IndexedDB wrappers in storage.js; tile
// + Overpass loading and graph extension in tiles.js.

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
    poiMarkers: [],
    showToilets: false,
    showWater: false,
    profile: "run",
};
// Read per-type toggle state. Migrate the old unified lw:showPois flag if present.
try {
    var _legacyPois = localStorage.getItem("lw:showPois");
    if (_legacyPois !== null) {
        var _on = _legacyPois === "1";
        state.showToilets = _on;
        state.showWater = _on;
        localStorage.setItem("lw:showToilets", _on ? "1" : "0");
        localStorage.setItem("lw:showWater", _on ? "1" : "0");
        localStorage.removeItem("lw:showPois");
    } else {
        state.showToilets = localStorage.getItem("lw:showToilets") === "1";
        state.showWater = localStorage.getItem("lw:showWater") === "1";
    }
    var _savedProfile = localStorage.getItem("lw:profile");
    if (_savedProfile === "bike" || _savedProfile === "run") state.profile = _savedProfile;
} catch (e) {}
function anyPoisVisible() { return state.showToilets || state.showWater; }

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
        if (anyPoisVisible()) debouncedRefreshPois();
    });
}

// Single source of truth for the gradient scale. `max` is the upper grade-%
// bound (inclusive) of each discrete band; the last band catches everything
// steeper. Drives gradeColor/gradeFill (elevation chart), the side-menu legend,
// and the colours of the continuous hotline palette (whose stop positions are
// tuned separately in updateGradientLine).
var GRADE_BANDS = [
    { max: -10,      color: "#3b82f6", fill: "rgba(59,130,246,0.18)",  label: "Very steep down (>10%)" },
    { max: -5,       color: "#60a5fa", fill: "rgba(96,165,250,0.15)",  label: "Steep downhill (5-10%)" },
    { max: -2,       color: "#93c5fd", fill: "rgba(147,197,253,0.12)", label: "Downhill (2-5%)" },
    { max: 2,        color: "#6ee7b7", fill: "rgba(110,231,183,0.1)",  label: "Flat (<2%)" },
    { max: 5,        color: "#fbbf24", fill: "rgba(251,191,36,0.15)",  label: "Uphill (2-5%)" },
    { max: 10,       color: "#f87171", fill: "rgba(248,113,113,0.15)", label: "Steep uphill (5-10%)" },
    { max: Infinity, color: "#dc2626", fill: "rgba(220,38,38,0.18)",   label: "Very steep up (>10%)" },
];

function gradeBand(grade) {
    for (var i = 0; i < GRADE_BANDS.length; i++) if (grade <= GRADE_BANDS[i].max) return GRADE_BANDS[i];
    return GRADE_BANDS[GRADE_BANDS.length - 1];
}

// ── Build gradient legend in side menu ────────────────
function buildMenuLegend() {
    var container = document.getElementById("menu-legend");
    var title = document.createElement("strong");
    title.textContent = "Gradient";
    container.appendChild(title);
    container.appendChild(document.createElement("br"));
    var levels = GRADE_BANDS;
    for (var k = 0; k < levels.length; k++) {
        var icon = document.createElement("i");
        icon.style.background = levels[k].color;
        container.appendChild(icon);
        container.appendChild(document.createTextNode(" " + levels[k].label));
        container.appendChild(document.createElement("br"));
    }
}

// ── Numbered markers ───────────────────────────────────
function numberedMarkerIcon(num, markerState) {
    markerState = markerState || "ready";
    var stateClass = markerState === "ready" ? "" : " wp-marker--" + markerState;
    var safeNum = String(num).replace(/[<>&"']/g, "");
    var overlay = "";
    if (markerState === "pending") overlay = '<div class="wp-spinner"></div>';
    else if (markerState === "failed") overlay = '<div class="wp-retry">↻</div>';
    return L.divIcon({
        html: '<div class="wp-marker' + stateClass + '">' + safeNum + overlay + '</div>',
        className: "",
        iconSize: [28, 28],
        iconAnchor: [14, 14],
    });
}

function createNumberedMarker(lat, lon, num, markerState) {
    return L.marker([lat, lon], { icon: numberedMarkerIcon(num, markerState), draggable: true }).addTo(state.map);
}

// Takes the waypoint (not the bare marker) so a renumber re-renders the icon in
// the waypoint's CURRENT state — the old marker-only version always rendered
// "ready", erasing the spinner/retry affordance on a still-pending/failed
// waypoint whenever a sibling was removed, reversed, or midpoint-inserted.
function updateMarkerNumber(wp, num) {
    var markerState = wp.pending ? "pending" : wp.failed ? "failed" : null;
    wp.marker.setIcon(numberedMarkerIcon(num, markerState));
}

function setMarkerState(marker, num, markerState) {
    marker.setIcon(numberedMarkerIcon(num, markerState));
}

// ── Autocomplete (Photon) ──────────────────────────────
var autocompleteTimer = null;
var autocompleteController = null;

function setAutocompleteOpen(open) {
    var wrapper = document.querySelector(".menu-search");
    var list = document.getElementById("autocomplete-list");
    list.style.display = open ? "block" : "none";
    if (wrapper) wrapper.setAttribute("aria-expanded", open ? "true" : "false");
}

function setupAutocomplete() {
    var input = document.getElementById("address-input");
    var list = document.getElementById("autocomplete-list");
    var clearBtn = document.getElementById("address-clear");
    var activeIdx = -1;

    function syncClearBtn() {
        if (!clearBtn) return;
        clearBtn.classList.toggle("hidden", input.value.length === 0);
    }

    input.addEventListener("input", function () {
        clearTimeout(autocompleteTimer);
        activeIdx = -1;
        syncClearBtn();
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
    if (clearBtn) clearBtn.addEventListener("click", function () {
        input.value = "";
        syncClearBtn();
        setAutocompleteOpen(false);
        input.focus();
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
    // Cancel any in-flight suggestion request so slow responses can't overwrite fast ones.
    if (autocompleteController) autocompleteController.abort();
    autocompleteController = new AbortController();
    var ctl = autocompleteController;
    try {
        var center = state.map ? state.map.getCenter() : { lat: -31.95, lng: 115.86 };
        var resp = await fetch(
            "https://photon.komoot.io/api/?q=" + encodeURIComponent(query) +
            "&limit=5&lat=" + center.lat + "&lon=" + center.lng,
            { signal: ctl.signal }
        );
        if (!resp.ok) return;
        var data = await resp.json();
        // Ignore this response if a newer request has started.
        if (ctl !== autocompleteController) return;
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
    } catch (e) {
        if (e.name === "AbortError") return;
        console.warn("Autocomplete failed:", e.message);
    }
}

// ── Geocode (via Photon) ───────────────────────────────
async function geocodeAddress(opts) {
    var q = document.getElementById("address-input").value.trim();
    if (!q) return;
    setAutocompleteOpen(false);
    try {
        var center = state.map ? state.map.getCenter() : { lat: -31.95, lng: 115.86 };
        var resp = await fetchWithTimeout(
            "https://photon.komoot.io/api/?q=" + encodeURIComponent(q) +
            "&limit=1&lat=" + center.lat + "&lon=" + center.lng,
            null, 10000
        );
        if (!resp.ok) { showBanner("Address not found"); return; }
        var data = await resp.json();
        var features = data.features || [];
        if (features.length === 0) { showBanner("Address not found"); return; }
        var coords = features[0].geometry.coordinates;
        goToLocation(coords[1], coords[0]);
    } catch (e) {
        console.error("geocode:", e);
        showBanner("Couldn't search that address — check your connection");
    }
}

function goToLocation(lat, lon) {
    // Clear existing waypoints — this sets a new starting point
    clearRouteLayers(false);
    updateRoute();

    state.startLat = lat;
    state.startLon = lon;
    state.map.setView([lat, lon], 15);
    closeMenu();
    resetGraphIfCityChanged(lat, lon).then(function () {
        return loadTilesOrPaths(lat, lon);
    }).then(function () {
        if (state.graph) addWaypointAt(lat, lon, { exactPosition: true });
    });
}

// ── Elevation (AWS Terrarium tiles, Open-Meteo fallback) ─────
//
// Terrarium tiles are PNG RGB images where each pixel encodes an elevation:
//   elev_metres = (R*256 + G + B/256) - 32768
// Tiles served by AWS Open Data Programme at z14 (~30 m underlying resolution
// for AU, sourced from SRTM30 + GMTED2010). CORS enabled, no API key.
//
// Strategy: group input points by tile, fetch each tile once, decode all
// points that fall in it via bilinear interpolation. Fall back to Open-Meteo
// for any tile that fails to load.

var TERRARIUM_ZOOM = 14;
var TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

async function fetchTerrariumTile(xtile, ytile) {
    var url = TERRARIUM_URL + "/" + TERRARIUM_ZOOM + "/" + xtile + "/" + ytile + ".png";
    var resp = await fetchWithTimeout(url, null, 20000);
    if (!resp.ok) throw new Error("Terrarium HTTP " + resp.status);
    var blob = await resp.blob();
    var bitmap = await createImageBitmap(blob);
    var canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

// Build a getPixel that handles cross-tile boundaries by sampling adjacent
// tiles from the cache. Out-of-range tiles (top/bottom of map) clamp.
//
// Shared-boundary redirect: col 255 of tile X and col 0 of tile X+1 are the
// same geographic column under Web Mercator XYZ convention. Some Terrarium
// tiles ship with corrupt right/bottom edges (observed Perth tile 13462/9729
// col 255 → -3700 m artefacts) while the neighbour's col 0 reads correctly.
// Always prefer the neighbour's edge pixel if its tile is in cache.
function makeGetPixel(tileCache, xtile, ytile) {
    return function (x, y) {
        var tx = xtile, ty = ytile;
        if (x < 0) { tx -= 1; x += 256; }
        else if (x >= 256) { tx += 1; x -= 256; }
        if (y < 0) { ty -= 1; y += 256; }
        else if (y >= 256) { ty += 1; y -= 256; }
        if (x === 255 && tileCache[(tx + 1) + "/" + ty]) { tx += 1; x = 0; }
        if (y === 255 && tileCache[tx + "/" + (ty + 1)]) { ty += 1; y = 0; }
        var tile = tileCache[tx + "/" + ty];
        if (!tile) return null; // signal cross-tile miss
        var idx = (y * 256 + x) * 4;
        return decodeTerrarium(tile.data[idx], tile.data[idx + 1], tile.data[idx + 2]);
    };
}

async function fetchElevation(points) {
    var results = new Array(points.length);
    var pendingIdx = []; // indices not yet resolved
    var pendingPts = [];

    // ── Step 1: batched IndexedDB cache lookup (one transaction, not one per point) ──
    var cacheKeys = points.map(function (p) { return "elev4:" + p.lat.toFixed(5) + ":" + p.lon.toFixed(5); });
    var cachedVals = await cacheGetMany(cacheKeys);
    for (var i = 0; i < points.length; i++) {
        if (cachedVals[i]) { results[i] = cachedVals[i]; }
        else { results[i] = null; pendingIdx.push(i); pendingPts.push(points[i]); }
    }
    if (pendingPts.length === 0) return results;
    var toCache = []; // accumulated {key, value}; written once at the end

    // ── Step 2: group pending points by tile ────────
    var tileGroups = {}; // "xtile/ytile" → [{ origIdx, pt, px, py }]
    var tileXY = {};     // "xtile/ytile" → { xtile, ytile }
    for (var i = 0; i < pendingPts.length; i++) {
        var c = tileCoords(pendingPts[i].lat, pendingPts[i].lon, TERRARIUM_ZOOM);
        var key = c.xtile + "/" + c.ytile;
        if (!tileGroups[key]) { tileGroups[key] = []; tileXY[key] = { xtile: c.xtile, ytile: c.ytile }; }
        tileGroups[key].push({ origIdx: pendingIdx[i], pt: pendingPts[i], px: c.px, py: c.py });
    }

    // ── Step 3: also fetch neighbour tiles for boundary points ─
    var tilesToFetch = {};
    Object.keys(tileGroups).forEach(function (key) { tilesToFetch[key] = tileXY[key]; });
    Object.keys(tileGroups).forEach(function (key) {
        var pts = tileGroups[key];
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            var dx = p.px < 1 ? -1 : p.px > 255 ? 1 : 0;
            var dy = p.py < 1 ? -1 : p.py > 255 ? 1 : 0;
            if (dx !== 0) {
                var k = (tileXY[key].xtile + dx) + "/" + tileXY[key].ytile;
                if (!tilesToFetch[k]) tilesToFetch[k] = { xtile: tileXY[key].xtile + dx, ytile: tileXY[key].ytile };
            }
            if (dy !== 0) {
                var k = tileXY[key].xtile + "/" + (tileXY[key].ytile + dy);
                if (!tilesToFetch[k]) tilesToFetch[k] = { xtile: tileXY[key].xtile, ytile: tileXY[key].ytile + dy };
            }
            if (dx !== 0 && dy !== 0) {
                var k = (tileXY[key].xtile + dx) + "/" + (tileXY[key].ytile + dy);
                if (!tilesToFetch[k]) tilesToFetch[k] = { xtile: tileXY[key].xtile + dx, ytile: tileXY[key].ytile + dy };
            }
        }
    });

    // ── Step 4: fetch tiles in parallel ─────────────
    var tileCache = {};
    var fetchPromises = Object.keys(tilesToFetch).map(function (key) {
        return fetchTerrariumTile(tilesToFetch[key].xtile, tilesToFetch[key].ytile)
            .then(function (data) { tileCache[key] = data; })
            .catch(function (e) { console.warn("Terrarium tile " + key + " failed:", e.message); });
    });
    await Promise.all(fetchPromises);

    // ── Step 5: decode each point via bilinear ──────
    var fallbackIdx = [], fallbackPts = [];
    var tileKeys = Object.keys(tileGroups);
    for (var t = 0; t < tileKeys.length; t++) {
        var key = tileKeys[t];
        var pts = tileGroups[key];
        if (!tileCache[key]) {
            // tile fetch failed — queue all its points for fallback
            for (var i = 0; i < pts.length; i++) { fallbackIdx.push(pts[i].origIdx); fallbackPts.push(pts[i].pt); }
            continue;
        }
        var getPixel = makeGetPixel(tileCache, tileXY[key].xtile, tileXY[key].ytile);
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            // Probe the four bilinear neighbours. If any are null (neighbour
            // tile missing), fall back for this point only.
            var x0 = Math.floor(p.px), y0 = Math.floor(p.py);
            var ok = getPixel(x0, y0) !== null && getPixel(x0 + 1, y0) !== null
                  && getPixel(x0, y0 + 1) !== null && getPixel(x0 + 1, y0 + 1) !== null;
            if (!ok) { fallbackIdx.push(p.origIdx); fallbackPts.push(p.pt); continue; }
            var elev = bilinearSample(getPixel, p.px, p.py);
            var entry = { lat: p.pt.lat, lon: p.pt.lon, elevation: elev };
            results[p.origIdx] = entry;
            toCache.push({ key: "elev4:" + p.pt.lat.toFixed(5) + ":" + p.pt.lon.toFixed(5), value: entry });
        }
    }

    // ── Step 6: Open-Meteo fallback for failed points ─
    if (fallbackPts.length > 0) {
        console.warn("Terrarium failed for " + fallbackPts.length + " points, falling back to Open-Meteo");
        for (var b = 0; b < fallbackPts.length; b += 100) {
            var batch = fallbackPts.slice(b, b + 100);
            var batchIdx = fallbackIdx.slice(b, b + 100);
            var lats = batch.map(function (p) { return p.lat.toFixed(5); }).join(",");
            var lons = batch.map(function (p) { return p.lon.toFixed(5); }).join(",");
            try {
                var resp = await fetchWithTimeout(
                    "https://api.open-meteo.com/v1/elevation?latitude=" + lats + "&longitude=" + lons,
                    null, 20000);
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                var data = await resp.json();
                var elevArr = data.elevation || [];
                for (var j = 0; j < elevArr.length; j++) {
                    var elev = elevArr[j] != null ? elevArr[j] : 0;
                    var entry = { lat: batch[j].lat, lon: batch[j].lon, elevation: elev };
                    results[batchIdx[j]] = entry;
                    if (elevArr[j] != null) {
                        toCache.push({ key: "elev4:" + entry.lat.toFixed(5) + ":" + entry.lon.toFixed(5), value: entry });
                    }
                }
            } catch (e) {
                console.warn("Open-Meteo fallback failed:", e.message);
                for (var j = 0; j < batch.length; j++) {
                    results[batchIdx[j]] = { lat: batch[j].lat, lon: batch[j].lon, elevation: 0 };
                }
            }
        }
    }

    // One batched write for everything resolved this call (don't await — the
    // caller needs the repaint, not the cache commit).
    cacheSetMany(toCache);

    // Defensive: ensure no null in output
    for (var i = 0; i < results.length; i++) {
        if (!results[i]) results[i] = { lat: points[i].lat, lon: points[i].lon, elevation: 0 };
    }
    return results;
}

// ── Waypoints ──────────────────────────────────────────
function wireMarkerEvents(marker) {
    marker.on("click", function (ev) {
        L.DomEvent.stopPropagation(ev);
        var idx = -1;
        for (var w = 0; w < state.waypoints.length; w++) { if (state.waypoints[w].marker === marker) { idx = w; break; } }
        if (idx < 0) return;
        var wp = state.waypoints[idx];
        if (wp.failed) {
            retryFailedWaypoint(wp);
        } else {
            removeWaypoint(idx);
        }
    });
    marker.on("dragend", async function () {
        var pos = marker.getLatLng();
        var newKey = closestNode(state.graph, pos.lat, pos.lng);
        // If closest node is >200m away, load tiles/paths at drag target first
        if (newKey) {
            var _nk = parseNodeKey(newKey);
            var snapDist = haversine(pos.lat, pos.lng, _nk.lat, _nk.lon);
            if (snapDist > 200) {
                showBanner("Loading paths for this area", "loading");
                await loadTilesOrPaths(pos.lat, pos.lng);
                newKey = closestNode(state.graph, pos.lat, pos.lng);
            }
        } else if (state.graph) {
            // No node found at all — load tiles at drag target
            showBanner("Loading paths for this area", "loading");
            await loadTilesOrPaths(pos.lat, pos.lng);
            newKey = closestNode(state.graph, pos.lat, pos.lng);
        }
        // Enforce the 200 m snap rule on whatever we ended with — the post-load
        // closestNode used to be accepted unconditionally, so a drag into a
        // lake could bind the waypoint to a node far from the pin.
        if (newKey) {
            var _nkCheck = parseNodeKey(newKey);
            if (haversine(pos.lat, pos.lng, _nkCheck.lat, _nkCheck.lon) > 200) newKey = null;
        }
        var wp = null;
        for (var w = 0; w < state.waypoints.length; w++) {
            if (state.waypoints[w].marker === marker) { wp = state.waypoints[w]; break; }
        }
        if (!wp) return;
        if (newKey) {
            var _nk = parseNodeKey(newKey);
            marker.setLatLng([_nk.lat, _nk.lon]);
            wp.lat = _nk.lat;
            wp.lon = _nk.lon;
            wp.nodeKey = newKey;
        } else {
            // Nothing routable at the drop point — snap the pin back so marker
            // and drawn route can't silently disagree, and say why.
            marker.setLatLng([wp.lat, wp.lon]);
            showBanner("No path near there — drop the pin on a road or footpath", "hint");
            setTimeout(function () {
                var el = document.getElementById("info-banner");
                if (el.dataset.type === "hint" && el.textContent.indexOf("No path near there") === 0) showBanner("");
            }, 2500);
        }
        updateRoute();
    });
}

function onMapClick(e) { addWaypointAt(e.latlng.lat, e.latlng.lng); }

async function addWaypointAt(lat, lon, opts) {
    var num = state.waypoints.length + 1;

    // Synchronous fast path: if state.graph already has a usable node within 200m
    // of the tap, create the marker directly in ready state — no red flash.
    var fastNk = null;
    if (state.graph) {
        fastNk = closestNode(state.graph, lat, lon);
        if (fastNk) {
            var _fnk = parseNodeKey(fastNk);
            var fastDist = haversine(lat, lon, _fnk.lat, _fnk.lon);
            if (fastDist > 200) fastNk = null;
        }
    }

    if (fastNk) {
        var _fnk = parseNodeKey(fastNk);
        var fastSnapLat = _fnk.lat;
        var fastSnapLon = _fnk.lon;
        var fastDisplayLat = (opts && opts.exactPosition) ? lat : fastSnapLat;
        var fastDisplayLon = (opts && opts.exactPosition) ? lon : fastSnapLon;
        var fastMarker = createNumberedMarker(fastDisplayLat, fastDisplayLon, num);
        wireMarkerEvents(fastMarker);
        state.waypoints.push({ lat: fastDisplayLat, lon: fastDisplayLon, marker: fastMarker, nodeKey: fastNk });
        updateRoute();
        return;
    }

    // Slow path: paths need to be loaded. Render marker in pending state immediately,
    // resolve async, transition to ready or failed.
    var marker = createNumberedMarker(lat, lon, num, "pending");
    wireMarkerEvents(marker);

    var wp = { lat: lat, lon: lon, marker: marker, nodeKey: null, pending: true };
    state.waypoints.push(wp);

    try {
        var nk = await resolveWaypointNode(lat, lon);
        if (!nk) {
            markWaypointFailed(wp, await failedReason(lat, lon));
            return;
        }
        var liveIdx = state.waypoints.indexOf(wp);
        if (liveIdx < 0) return;

        var _nk = parseNodeKey(nk);
        var snapLat = _nk.lat;
        var snapLon = _nk.lon;
        var displayLat = (opts && opts.exactPosition) ? lat : snapLat;
        var displayLon = (opts && opts.exactPosition) ? lon : snapLon;

        wp.lat = displayLat;
        wp.lon = displayLon;
        wp.nodeKey = nk;
        wp.pending = false;
        marker.setLatLng([displayLat, displayLon]);
        setMarkerState(marker, liveIdx + 1, "ready");
        updateRoute();
    } catch (e) {
        console.warn("addWaypointAt failed:", e);
        markWaypointFailed(wp);
    }
}

// Inside a tiled city the failure is geographic ("no path here"), not a
// network/Overpass issue, so the default banner would mislead.
async function failedReason(lat, lon) {
    return (await isInTiledCity(lat, lon))
        ? "No path nearby — tap a road or footpath"
        : null;
}

// Helper: run the existing 3-stage path-resolution logic and return the closest-node key,
// or null if no usable node could be found.
async function resolveWaypointNode(lat, lon) {
    if (!state.graph) {
        await loadTilesOrPaths(lat, lon);
        if (!state.graph) return null;
    }
    var nk = closestNode(state.graph, lat, lon);
    if (!nk) {
        await loadTilesOrPaths(lat, lon);
        nk = closestNode(state.graph, lat, lon);
        if (!nk) return null;
    }
    var _nk = parseNodeKey(nk);
    var snapDist = haversine(lat, lon, _nk.lat, _nk.lon);
    if (snapDist > 200) {
        // In a tiled city, coverage is already complete — Overpass would just
        // re-fetch the same bank paths (e.g. tap in the middle of the Swan
        // River) and flicker the retry banner. Skip it.
        if (await isInTiledCity(lat, lon)) {
            await loadTilesForLocation(lat, lon);
        } else {
            await loadPaths(lat, lon);
        }
        nk = closestNode(state.graph, lat, lon);
        if (!nk) return null;
        var _nk2 = parseNodeKey(nk);
        var snapDist2 = haversine(lat, lon, _nk2.lat, _nk2.lon);
        if (snapDist2 > 200) return null;
    }
    return nk;
}

// Helper: mark a waypoint as failed, attaching the visual amber retry state.
function markWaypointFailed(wp, reason) {
    var idx = state.waypoints.indexOf(wp);
    if (idx < 0) return;
    wp.pending = false;
    wp.failed = true;
    setMarkerState(wp.marker, idx + 1, "failed");
    showBanner(reason || "Could not load paths — tap pin to retry");
}

async function retryFailedWaypoint(wp) {
    if (!wp.failed) return;
    var idx = state.waypoints.indexOf(wp);
    if (idx < 0) return;

    wp.failed = false;
    wp.pending = true;
    setMarkerState(wp.marker, idx + 1, "pending");

    try {
        var nk = await resolveWaypointNode(wp.lat, wp.lon);
        if (!nk) {
            markWaypointFailed(wp, await failedReason(wp.lat, wp.lon));
            return;
        }
        var liveIdx = state.waypoints.indexOf(wp);
        if (liveIdx < 0) return;
        var _nk = parseNodeKey(nk);
        var snapLat = _nk.lat;
        var snapLon = _nk.lon;
        wp.lat = snapLat;
        wp.lon = snapLon;
        wp.nodeKey = nk;
        wp.pending = false;
        wp.marker.setLatLng([snapLat, snapLon]);
        setMarkerState(wp.marker, liveIdx + 1, "ready");
        updateRoute();
    } catch (e) {
        console.warn("retryFailedWaypoint failed:", e);
        markWaypointFailed(wp);
    }
}

function removeWaypoint(idx) {
    if (idx < 0 || idx >= state.waypoints.length) return;
    state.map.removeLayer(state.waypoints[idx].marker);
    state.waypoints.splice(idx, 1);
    for (var i = 0; i < state.waypoints.length; i++) updateMarkerNumber(state.waypoints[i], i + 1);
    updateRoute();
    // Awareness for accidental taps mid-pan (tap-to-delete is deliberate — no
    // undo — but the deletion shouldn't be silent). Below 2 waypoints the
    // emptied map + the updateRoute nudge already make it obvious.
    if (state.waypoints.length >= 2) {
        showBanner("Waypoint " + (idx + 1) + " removed", "hint");
        setTimeout(function () {
            var el = document.getElementById("info-banner");
            if (el.dataset.type === "hint" && el.textContent.indexOf("removed") !== -1) showBanner("");
        }, 1500);
    }
}

// ── Route drawing ──────────────────────────────────────
// Parse a "lat,lon" node-key string into floats. Centralises the split+parseFloat
// idiom that was repeated ~10× (each an index-fiddling bug surface).
function parseNodeKey(nk) {
    var parts = nk.split(",");
    return { lat: parseFloat(parts[0]), lon: parseFloat(parts[1]) };
}

// Append src[start..] onto dst in place. Avoids `dst.push.apply(dst, src)` /
// `dst.push(...src)`, both of which spread the source as call arguments and
// throw RangeError once a route gets long enough to exceed the engine arg cap.
function pushAll(dst, src, start) {
    for (var i = start || 0; i < src.length; i++) dst.push(src[i]);
}

var _routeGen = 0;

// A segment needs the Overpass gap-fill if the direct graph route is missing or
// implausibly indirect — a detour > MAX_DETOUR_RATIO× the straight line, and only
// for gaps longer than MIN_DETOUR_DIST m so short legitimate dog-legs aren't refetched.
var MAX_DETOUR_RATIO = 3;
var MIN_DETOUR_DIST = 200;

// Resolve a routed path between two waypoints, gap-filling if needed. Returns
// { result } normally, or { superseded: true } if a newer updateRoute() bumped the
// generation while we awaited the gap-fill — the caller MUST then bail without
// mutating shared route state. This is the concurrency guard; the gen check stays
// immediately after the await and before any caller-side mutation.
async function resolveSegment(fromWp, toWp, gen) {
    // A pending/failed endpoint (nodeKey null) can't be routed — dijkstra would
    // return null and we'd fire the multi-fetch gap-fill for a leg whose
    // endpoint was never resolved. Draw the red fallback and let the waypoint's
    // own resolution (or tap-to-retry) trigger the re-route.
    if (!fromWp.nodeKey || !toWp.nodeKey) return { result: null };
    var result = dijkstra(state.graph, fromWp.nodeKey, toWp.nodeKey);
    var straight = haversine(fromWp.lat, fromWp.lon, toWp.lat, toWp.lon);
    // Compare GEOMETRIC path length against the straight line — result.dist is
    // the weighted cost (road weights × node multipliers), which overstates
    // "detour" on penalised surfaces (trunk ×2.5, bike-over-steps ×5) and made
    // perfectly valid legs re-trigger the multi-fetch gap-fill on every recompute.
    var needsGapFill = !result || result.path.length < 2 ||
        (pathGeomLength(result.path) > straight * MAX_DETOUR_RATIO && straight > MIN_DETOUR_DIST);
    if (needsGapFill) {
        result = await fillGapAndRetry(fromWp, toWp);
        if (gen !== _routeGen) return { superseded: true };
    }
    return { result: result };
}

// Post-draw tail: banner, markers, distance, elevation (with out-&-back doubling),
// share hash, autosave. Runs after all awaits/gen-checks, so it's race-free.
function finalizeRoute(allRouteCoords, routeOk) {
    if (!routeOk) showBanner("Red segments have no footpath connection — try dragging a waypoint onto a nearby road");
    else showBanner("");
    addMidpointMarkers();
    updateDistance();
    var elevCoords = allRouteCoords;
    if (state.mode === "outback" && allRouteCoords.length > 1) {
        elevCoords = allRouteCoords.concat(allRouteCoords.slice().reverse().slice(1));
    }
    debouncedFetchElevation(elevCoords);
    updateShareHash();
    saveRoute();
}

async function updateRoute() {
    var gen = ++_routeGen;
    clearRouteLayers(true); // keep waypoints; we're redrawing the geometry between them
    document.getElementById("distance-pill").disabled = state.waypoints.length < 2;

    if (state.waypoints.length < 2) {
        updateDistance();
        updateElevation([]);
        // Keep the share hash and autosave in sync even below 2 waypoints —
        // otherwise Clear (or deleting down to 1) leaves the old route in the
        // URL and in autosave, and it resurrects on the next reload. Safe at
        // boot: loadFromHash() has already read the incoming hash before any
        // updateRoute() can run.
        updateShareHash();
        saveRoute();
        // First-run nudge: one marker on the map, no route yet. Only show if no
        // louder banner is up (loading / error), and clear when we dismiss later.
        var bannerEl = document.getElementById("info-banner");
        if (state.waypoints.length === 1 && (!bannerEl.dataset.type || bannerEl.dataset.type === "hint")) {
            showBanner("Tap the map to add a destination", "hint");
        } else if (bannerEl.dataset.type === "hint") {
            showBanner("");
        }
        return;
    }

    // Clear the single-waypoint hint once the user has added a second point.
    var hintBanner = document.getElementById("info-banner");
    if (hintBanner.dataset.type === "hint") showBanner("");

    var allRouteCoords = [];
    var routeOk = true;

    // Draw each leg between consecutive waypoints.
    for (var i = 1; i < state.waypoints.length; i++) {
        var fromWp = state.waypoints[i-1], toWp = state.waypoints[i];
        var seg = await resolveSegment(fromWp, toWp, gen);
        if (seg.superseded) return;
        var result = seg.result;
        if (result && result.path.length > 1) {
            var segCoords = pathToCoords(result.path);
            state.routeSegments.push(segCoords);
            var line = L.polyline(segCoords, { color: "#6ee7b7", weight: 4, opacity: 0.9 }).addTo(state.map);
            state.routeLines.push(line);
            pushAll(allRouteCoords, segCoords, allRouteCoords.length === 0 ? 0 : 1);
        } else {
            var fallback = [[fromWp.lat, fromWp.lon], [toWp.lat, toWp.lon]];
            state.routeSegments.push(fallback);
            var fline = L.polyline(fallback, { color: "#ef4444", weight: 3, opacity: 0.7, dashArray: "8 8" }).addTo(state.map);
            state.routeLines.push(fline);
            pushAll(allRouteCoords, fallback, allRouteCoords.length === 0 ? 0 : 1);
            routeOk = false;
        }
    }

    // Loop mode: close the loop from last waypoint back to the first.
    if (state.mode === "loop" && state.waypoints.length >= 2) {
        var lastWp = state.waypoints[state.waypoints.length-1], firstWp = state.waypoints[0];
        var closeSeg = await resolveSegment(lastWp, firstWp, gen);
        if (closeSeg.superseded) return;
        var closeResult = closeSeg.result;
        if (closeResult && closeResult.path.length > 1) {
            var closeCoords = pathToCoords(closeResult.path);
            state.closingLine = L.polyline(closeCoords, { color: "#6ee7b7", weight: 4, opacity: 0.6, dashArray: "10 6" }).addTo(state.map);
            pushAll(allRouteCoords, closeCoords, 1);
        } else {
            state.closingLine = L.polyline([[lastWp.lat,lastWp.lon],[firstWp.lat,firstWp.lon]], { color: "#ef4444", weight: 3, opacity: 0.5, dashArray: "8 8" }).addTo(state.map);
        }
    }

    finalizeRoute(allRouteCoords, routeOk);
}

var _elevationTimer = null;
function debouncedFetchElevation(coords) {
    clearTimeout(_elevationTimer);
    _elevationTimer = setTimeout(function () { fetchRouteElevation(coords); }, 400);
}

// ── Points of interest: public toilets + drinking water ──
function poiIcon(amenity) {
    var glyph = amenity === "toilets" ? "🚻" : "💧";
    return L.divIcon({
        html: '<div class="poi-marker poi-' + amenity + '">' + glyph + '</div>',
        className: "",
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    });
}

function poiPopupHtml(p) {
    var heading = p.amenity === "toilets" ? "Public toilet" : "Drinking water";
    var parts = [];
    if (p.name) parts.push("<strong>" + escapeText(p.name) + "</strong>");
    parts.push(heading);
    var tags = [];
    if (p.access && p.access !== "yes") tags.push("Access: " + escapeText(p.access));
    if (p.fee === "yes") tags.push("Fee applies");
    else if (p.fee === "no") tags.push("Free");
    if (p.wheelchair === "yes") tags.push("♿ Wheelchair accessible");
    else if (p.wheelchair === "limited") tags.push("♿ Limited access");
    if (p.changing_table) tags.push("Changing table");
    if (p.opening_hours) tags.push(escapeText(p.opening_hours));
    if (tags.length) parts.push('<span style="color:#808390;font-size:12px;">' + tags.join(" · ") + '</span>');
    return parts.join("<br>");
}

function escapeText(s) {
    var d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
}

var _poiGen = 0;
async function refreshPois() {
    // Generation guard: two overlapping refreshes (toggle click + moveend
    // debounce, with loadPois taking seconds on an Overpass miss) both read
    // state.poiMarkers before either wrote it — the later finisher overwrote
    // the array and orphaned the earlier call's markers on the map, untracked
    // and unremovable by the toggle-off loop.
    var gen = ++_poiGen;
    if (!state.map) return;
    // If neither type is visible, clear immediately and stop.
    if (!anyPoisVisible()) {
        for (var i = 0; i < state.poiMarkers.length; i++) state.map.removeLayer(state.poiMarkers[i]);
        state.poiMarkers = [];
        return;
    }
    var c = state.map.getCenter();
    var pois = await loadPois(c.lat, c.lng);
    if (gen !== _poiGen) return; // a newer refresh owns reconciliation
    // User may have toggled everything off during the fetch.
    if (!anyPoisVisible()) {
        for (var j = 0; j < state.poiMarkers.length; j++) state.map.removeLayer(state.poiMarkers[j]);
        state.poiMarkers = [];
        return;
    }
    if (!pois) return;
    // Reconcile by id: keep markers already on the map that still apply, add
    // new ones, drop old ones. Avoids the mid-pan "disappear then reappear"
    // flicker caused by the old clear-then-refetch order.
    var keep = {};
    for (var k = 0; k < pois.length; k++) {
        var p = pois[k];
        if (p.amenity === "toilets" && !state.showToilets) continue;
        if (p.amenity === "drinking_water" && !state.showWater) continue;
        keep[p.id] = p;
    }
    // Remove markers for POIs no longer in the visible set.
    var surviving = [];
    for (var m = 0; m < state.poiMarkers.length; m++) {
        var existing = state.poiMarkers[m];
        if (keep[existing._poiId]) {
            surviving.push(existing);
            delete keep[existing._poiId]; // mark as already rendered
        } else {
            state.map.removeLayer(existing);
        }
    }
    state.poiMarkers = surviving;
    // Add markers for newly-in-scope POIs.
    var ids = Object.keys(keep);
    for (var n = 0; n < ids.length; n++) {
        var p2 = keep[ids[n]];
        var marker = L.marker([p2.lat, p2.lon], {
            icon: poiIcon(p2.amenity),
            zIndexOffset: -150,
        });
        marker._poiId = p2.id;
        marker.bindPopup(poiPopupHtml(p2), { maxWidth: 240 });
        marker.addTo(state.map);
        state.poiMarkers.push(marker);
    }
}

var _poiTimer = null;
function debouncedRefreshPois() {
    clearTimeout(_poiTimer);
    _poiTimer = setTimeout(refreshPois, 800);
}

// ── Midpoint markers (drag to insert waypoint) ─────────
function addMidpointMarkers() {
    clearLayerArray("midpointMarkers");
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

            var icon = L.divIcon({
                html: '<div class="wp-midpoint"></div>',
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
                    var _nk = parseNodeKey(nk);
                    snapLat = _nk.lat;
                    snapLon = _nk.lon;
                }

                var num = insertIdx + 1;
                var marker = createNumberedMarker(snapLat, snapLon, num);
                wireMarkerEvents(marker);

                var wp = { lat: snapLat, lon: snapLon, marker: marker, nodeKey: nk || nodeKey(snapLat, snapLon) };
                state.waypoints.splice(insertIdx, 0, wp);

                // Renumber all markers
                for (var i = 0; i < state.waypoints.length; i++) {
                    updateMarkerNumber(state.waypoints[i], i + 1);
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
    clearLayerArray("distanceMarkers");
    var unitMetres = state.useMiles ? 1609.344 : 1000;
    var suffix = state.useMiles ? "mi" : "k";
    var totalUnits = state.totalDistMetres / unitMetres;
    if (totalUnits < 1) return;

    // Scale interval by total distance so long routes don't crowd the map.
    var intervalUnits;
    if (state.useMiles) {
        intervalUnits = totalUnits <= 10 ? 1 : totalUnits <= 25 ? 2 : totalUnits <= 50 ? 5 : 10;
    } else {
        intervalUnits = totalUnits <= 15 ? 1 : totalUnits <= 40 ? 2 : totalUnits <= 80 ? 5 : 10;
    }
    var interval = intervalUnits * unitMetres;

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

    var accumulated = 0, nextMark = interval, markNum = intervalUnits;
    for (var i = 1; i < coords.length; i++) {
        var d = haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
        accumulated += d;
        if (d < 1e-6) continue;
        while (accumulated >= nextMark) {
            var ratio = 1 - (accumulated - nextMark) / d;
            var lat = coords[i-1][0] + ratio * (coords[i][0] - coords[i-1][0]);
            var lon = coords[i-1][1] + ratio * (coords[i][1] - coords[i-1][1]);
            var mkr = L.marker([lat, lon], {
                icon: L.divIcon({
                    html: '<div class="km-pill">' + (markNum + suffix) + '</div>',
                    className: "",
                    iconSize: [30, 16],
                    iconAnchor: [15, 8],
                }),
                interactive: false,
                zIndexOffset: -100,
            }).addTo(state.map);
            state.distanceMarkers.push(mkr);
            markNum += intervalUnits;
            nextMark += interval;
        }
    }

    // End marker: show the total distance at the route's final coord, but only if
    // the last interval marker didn't already land exactly there.
    var lastIntervalUnits = markNum - intervalUnits;
    var totalUnitsOneDp = Math.round(totalUnits * 10) / 10;
    if (totalUnitsOneDp > lastIntervalUnits + 0.05) {
        var endCoord = coords[coords.length - 1];
        var endLabel = totalUnitsOneDp.toFixed(1) + suffix;
        var endMkr = L.marker([endCoord[0], endCoord[1]], {
            icon: L.divIcon({
                html: '<div class="km-pill">' + endLabel + '</div>',
                className: "",
                iconSize: [40, 16],
                iconAnchor: [20, 8],
            }),
            interactive: false,
            zIndexOffset: -100,
        }).addTo(state.map);
        state.distanceMarkers.push(endMkr);
    }
}

// ── Elevation profile ──────────────────────────────────
async function fetchRouteElevation(coords) {
    // Same generation guard as updateRoute/resolveSegment: an in-flight fetch
    // for route A must not repaint after route B has redrawn — without this,
    // A's late resolve cleared B's lines and drew A's gradient over them (and
    // left state.lastElevationData, used for GPX <ele>, holding A's samples).
    var gen = _routeGen;
    if (coords.length < 2) { updateElevation([]); return; }
    var sampled = sampleRoute(coords, 50);
    var locations = sampled.map(function (p) { return { lat: p[0], lon: p[1] }; });
    if (locations.length === 0) { updateElevation([]); return; }

    try {
        var results = await fetchElevation(locations);
        if (gen !== _routeGen) return; // a newer route owns the map now
        state.lastElevationData = results;
        updateElevation(results);
        colourRouteByGradient(results);
    } catch (e) {
        if (gen !== _routeGen) return;
        console.warn("Elevation fetch failed:", e.message);
        state.lastElevationData = [];
        updateElevation([]);
    }
}

function colourRouteByGradient(elevData) {
    elevData = smoothElevations(elevData);
    if (elevData.length < 2) return;
    clearLayerArray("routeLines");
    clearLayerSingle("closingLine");
    clearLayerSingle("routeOutline");

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
        // Stop positions are tuned for a smooth flat plateau (-2..+2 ≈ 0.43..0.57);
        // colours come from GRADE_BANDS so a recolour is a single-source edit.
        palette: {
            0.0:  GRADE_BANDS[0].color,  // very steep downhill
            0.17: GRADE_BANDS[1].color,  // steep downhill
            0.33: GRADE_BANDS[2].color,  // moderate downhill
            0.43: GRADE_BANDS[3].color,  // flat
            0.57: GRADE_BANDS[3].color,  // flat (plateau)
            0.67: GRADE_BANDS[4].color,  // moderate uphill
            0.83: GRADE_BANDS[5].color,  // steep uphill
            1.0:  GRADE_BANDS[6].color,  // very steep uphill
        },
        weight: 5,
        outlineWidth: 1,
        outlineColor: '#000',
    }).addTo(state.map);
    // Fade in the hotline canvas to mask the flicker when the plain green route
    // is replaced by the gradient-coloured version.
    var canvas = hotline.getElement && hotline.getElement();
    if (canvas) {
        canvas.style.opacity = "0";
        canvas.style.transition = "opacity 220ms ease";
        requestAnimationFrame(function () { canvas.style.opacity = "1"; });
    }
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
    var absoluteElevations = elevData.map(function (e) { return e.elevation; });
    // Plot relative to the start point — runners care about climb from where they
    // began, not metres above sea level. Stats below use deltas so are unaffected.
    var baseline = absoluteElevations[0];
    var elevations = absoluteElevations.map(function (e) { return e - baseline; });

    // Ascent/descent via the shared dead-band accumulator (routing.js) — same
    // function the saved-routes list uses, so the two never diverge. Diffs are
    // unaffected by the baseline subtraction above.
    var ASCENT_DEAD_BAND = 5; // metres — ignore cumulative changes below this
    var ad = computeAscent(elevData, ASCENT_DEAD_BAND);
    var totalAscent = ad.ascent, totalDescent = ad.descent, maxGradient = 0;
    var segGradients = [0]; // signed grade% per point; index 0 has no prior segment
    for (var i = 1; i < elevations.length; i++) {
        var diff = elevations[i] - elevations[i-1];
        var segDist = distances[i] - distances[i-1];
        var gradePct = 0;
        if (segDist > 0) { gradePct = (diff / segDist) * 100; var g = Math.abs(gradePct); if (g > maxGradient) maxGradient = g; }
        segGradients.push(gradePct);
    }
    document.getElementById("stat-ascent").textContent = Math.round(totalAscent) + " m";
    document.getElementById("stat-descent").textContent = Math.round(totalDescent) + " m";
    document.getElementById("stat-gradient").textContent = maxGradient.toFixed(1) + "%";

    // Grade → discrete colour/fill via the shared GRADE_BANDS table.
    function gradeColor(grade) { return gradeBand(grade).color; }
    function gradeFill(grade) { return gradeBand(grade).fill; }

    var labels = distances.map(function (d) { return (d/1000).toFixed(1); });
    if (state.elevationChart) {
        // Reuse the chart — cheaper than destroy/rebuild and avoids canvas flash.
        var chart = state.elevationChart;
        chart.data.labels = labels;
        chart.data.datasets[0].data = elevations;
        // Segment callbacks close over segGradients via the outer scope of the
        // previous build; rebind them against the fresh array on each update.
        chart.data.datasets[0].segment = {
            borderColor: function (ctx) { return gradeColor(segGradients[ctx.p1DataIndex]); },
            backgroundColor: function (ctx) { return gradeFill(segGradients[ctx.p1DataIndex]); },
        };
        chart.update("none");
        return;
    }
    var ctx = document.getElementById("elevation-canvas").getContext("2d");
    state.elevationChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: labels,
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
                x: { title: { display: true, text: "Distance (km)", color: "#888", padding: { top: 8 } }, ticks: { color: "#888", maxTicksLimit: 10 }, grid: { color: "#1a1a2e" } },
                y: { title: { display: true, text: "Climb (m)", color: "#888", padding: { bottom: 6 } }, ticks: { color: "#888" }, grid: { color: "#1a1a2e" } },
            },
        },
    });
}

// ── GPX export ─────────────────────────────────────────
async function exportGPX() {
    // Say why nothing happened — the side-menu Export closes the menu first,
    // so a silent early-return read as a broken button.
    if (state.routeSegments.length === 0) {
        showBanner("Add at least 2 waypoints first");
        return;
    }
    var coords = [];
    for (var s = 0; s < state.routeSegments.length; s++) {
        var seg = state.routeSegments[s];
        pushAll(coords, seg, coords.length === 0 ? 0 : 1);
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

    var trkType = state.profile === "bike" ? "cycling" : "running";
    var gpx = ['<?xml version="1.0" encoding="UTF-8"?>','<gpx version="1.1" creator="Legwork" xmlns="http://www.topografix.com/GPX/1/1">','  <trk>','    <name>'+name+'</name>','    <type>'+trkType+'</type>','    <trkseg>'];
    // One batched IDB probe for every coordinate missing from elevLookup — the
    // old per-point awaited cacheGet serialised 1000+ transactions per export
    // (and almost all missed: the cache is keyed at sampled points, not raw
    // route coordinates).
    var missingIdx = [];
    for (var m = 0; m < coords.length; m++) {
        if (elevLookup[coords[m][0].toFixed(5) + "," + coords[m][1].toFixed(5)] === undefined) missingIdx.push(m);
    }
    var probed = await cacheGetMany(missingIdx.map(function (mi) {
        return "elev4:" + coords[mi][0].toFixed(5) + ":" + coords[mi][1].toFixed(5);
    }));
    for (var pm = 0; pm < missingIdx.length; pm++) {
        if (probed[pm]) {
            var mc = coords[missingIdx[pm]];
            elevLookup[mc[0].toFixed(5) + "," + mc[1].toFixed(5)] = probed[pm].elevation;
        }
    }
    for (var i = 0; i < coords.length; i++) {
        var elevKey = coords[i][0].toFixed(5) + "," + coords[i][1].toFixed(5);
        var elev = elevLookup[elevKey];
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
    maybeShowTipNudge();
}

// ── Tip nudge (post-export delight moment) ─────────────
// Surface the Ko-fi link only once the user has gotten real repeat value
// (their 2nd export), then back off for 90 days. The menu link stays for
// anyone who wants to tip sooner. Storage-blocked (private mode) → never nag.
var TIP_NUDGE_AFTER = 2;                                  // exports before first nudge
var TIP_NUDGE_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;    // re-show at most every 90 days
var tipToast = document.getElementById("tip-toast");
var tipToastTimer = null;

function hideTipToast() {
    if (!tipToast) return;
    clearTimeout(tipToastTimer);
    tipToast.classList.remove("show");
    setTimeout(function () { tipToast.classList.add("hidden"); }, 300);
}

function showTipToast() {
    if (!tipToast) return;
    tipToast.classList.remove("hidden");
    requestAnimationFrame(function () { tipToast.classList.add("show"); });
    clearTimeout(tipToastTimer);
    tipToastTimer = setTimeout(hideTipToast, 12000);   // never linger
}

function maybeShowTipNudge() {
    var count, seen;
    try {
        count = parseInt(localStorage.getItem("lw_export_count") || "0", 10) + 1;
        localStorage.setItem("lw_export_count", String(count));
        seen = parseInt(localStorage.getItem("lw_tip_seen") || "0", 10);
    } catch (e) { return; }
    if (count < TIP_NUDGE_AFTER) return;
    if (seen && (Date.now() - seen) < TIP_NUDGE_COOLDOWN_MS) return;
    try { localStorage.setItem("lw_tip_seen", String(Date.now())); } catch (e) {}
    showTipToast();
}

(function wireTipToast() {
    var closeBtn = document.getElementById("tip-toast-close");
    if (closeBtn) closeBtn.addEventListener("click", hideTipToast);
    var link = document.getElementById("tip-toast-link");
    if (link) link.addEventListener("click", hideTipToast);   // click-through counts as handled
})();

// ── Utils ──────────────────────────────────────────────
// Abort any external fetch after ms to prevent stuck-spinner states.
function fetchWithTimeout(url, opts, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms || 20000);
    var merged = Object.assign({}, opts || {}, { signal: ctl.signal });
    return fetch(url, merged).finally(function () { clearTimeout(t); });
}

// Remove every entry in a state-held layer array and reset the array.
function clearLayerArray(arrName) {
    var arr = state[arrName];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) state.map.removeLayer(arr[i]);
    state[arrName] = [];
}

// Remove a single layer held on state and null the slot.
function clearLayerSingle(fieldName) {
    if (state[fieldName]) { state.map.removeLayer(state[fieldName]); state[fieldName] = null; }
}

// Wipe route geometry and markers. `keepWaypoints=true` leaves waypoint markers
// untouched (used during route recomputation); false clears everything.
function clearRouteLayers(keepWaypoints) {
    clearLayerArray("routeLines");
    clearLayerArray("gradientLines");
    clearLayerArray("midpointMarkers");
    clearLayerArray("distanceMarkers");
    clearLayerSingle("closingLine");
    clearLayerSingle("routeOutline");
    state.routeSegments = [];
    if (!keepWaypoints) {
        for (var i = 0; i < state.waypoints.length; i++) state.map.removeLayer(state.waypoints[i].marker);
        state.waypoints = [];
    }
}

function showBanner(msg, type) {
    var el = document.getElementById("info-banner");
    el.textContent = msg;
    el.className = "info-banner" + (type ? " " + type : " error");
    el.dataset.type = type || "";
    el.style.display = msg ? "block" : "none";
}

// Auto-dismiss for success toasts. Guarded on the current banner type so a
// stale timer can't wipe an error that appeared during the dismiss window.
function clearBannerAfter(ms) {
    setTimeout(function () {
        var el = document.getElementById("info-banner");
        if (el.dataset.type === "success") showBanner("");
    }, ms);
}

// Error banner with an inline "Retry" chip. onRetry fires with the banner
// cleared; caller re-triggers the failing operation.
function showBannerWithRetry(msg, onRetry) {
    var el = document.getElementById("info-banner");
    el.textContent = "";
    el.className = "info-banner error";
    el.dataset.type = "error";
    el.style.display = "block";
    var text = document.createElement("span");
    text.textContent = msg + " ";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "banner-retry";
    btn.textContent = "Retry";
    btn.addEventListener("click", function () { showBanner(""); onRetry(); });
    el.appendChild(text);
    el.appendChild(btn);
}

// Toast with an inline action button (e.g. "Route deleted · Undo").
// onAction fires only if the user clicks the button before the timeout;
// otherwise the banner clears silently.
function showActionBanner(text, actionLabel, onAction, durationMs) {
    var banner = document.getElementById("info-banner");
    while (banner.firstChild) banner.removeChild(banner.firstChild);
    banner.dataset.type = "action";
    var span = document.createElement("span");
    span.textContent = text + " ";
    var btn = document.createElement("button");
    btn.className = "info-banner-action";
    btn.textContent = actionLabel;
    var dismissed = false;
    btn.addEventListener("click", function () {
        if (dismissed) return;
        dismissed = true;
        try { onAction(); } finally { showBanner(""); }
    });
    banner.appendChild(span);
    banner.appendChild(btn);
    banner.className = "info-banner action";
    banner.style.display = "block";
    setTimeout(function () {
        if (!dismissed && banner.dataset.type === "action") showBanner("");
    }, durationMs || 5000);
}

// ── Event bindings ─────────────────────────────────────
document.getElementById("address-input").addEventListener("keydown", function (e) { if (e.key === "Enter") geocodeAddress(); });
// Single source of truth for route-mode display strings \u2014 `label` for the mode
// button (with leading glyph), `word` for prose (share text, saved-routes list).
var MODE_META = {
    loop:    { label: "\u21BB Loop",       word: "loop" },
    outback: { label: "\u21C4 Out & Back", word: "out & back" },
    oneway:  { label: "\u2192 One Way",    word: "one way" },
};
function setModeButton() {
    document.getElementById("mode-btn").textContent = (MODE_META[state.mode] || MODE_META.loop).label;
}

// ── Reverse button enable/disable ──────────────────────
// HIG #9 (perceived stability): disabled stays visible, doesn't disappear,
// so the toolbar shape doesn't shift when the user cycles modes.
function updateReverseVisibility() {
    document.getElementById("reverse-btn").disabled = state.mode !== "loop";
}

document.getElementById("mode-btn").addEventListener("click", function () {
    state.mode = state.mode === "loop" ? "outback" : state.mode === "outback" ? "oneway" : "loop";
    setModeButton();
    this.setAttribute("aria-label", "Route mode: " + state.mode + " (tap to cycle)");
    updateReverseVisibility();
    updateRoute();
});
document.getElementById("reverse-btn").addEventListener("click", function () {
    if (state.waypoints.length < 2) return;
    state.waypoints.reverse();
    for (var i = 0; i < state.waypoints.length; i++) updateMarkerNumber(state.waypoints[i], i + 1);
    updateRoute();
    showBanner("Route reversed", "hint");
    setTimeout(function () {
        var el = document.getElementById("info-banner");
        if (el.dataset.type === "hint" && el.textContent === "Route reversed") showBanner("");
    }, 1500);
});
document.getElementById("clear-btn").addEventListener("click", function () {
    if (state.waypoints.length === 0) {
        clearRouteLayers(false);
        updateRoute();
        return;
    }
    var snapshot = state.waypoints.map(function (w) { return { lat: w.lat, lon: w.lon }; });
    clearRouteLayers(false);
    updateRoute();
    showActionBanner("Route cleared", "Undo", async function () {
        for (var i = 0; i < snapshot.length; i++) {
            await addWaypointAt(snapshot[i].lat, snapshot[i].lon, { exactPosition: i === 0 });
        }
    }, 5000);
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
        clearRouteLayers(false);
        updateRoute();
        state.startLat = lat;
        state.startLon = lon;
        state.map.setView([lat, lon], 15);
        showGpsDot(lat, lon);
        resetGraphIfCityChanged(lat, lon).then(function () {
            return loadTilesOrPaths(lat, lon);
        }).then(function () {
            if (state.graph) addWaypointAt(lat, lon, { exactPosition: true });
        });
    }
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function (pos) { startHere(pos.coords.latitude, pos.coords.longitude); },
            function () { showBanner("Couldn't get your location — check that location is enabled for this site"); },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    }
});

// ── Distance action dropdown ──────────────────────────
var distWrapper = document.querySelector(".distance-wrapper");
var distPill = document.getElementById("distance-pill");
var distMenu = document.getElementById("distance-menu");

function closeDistMenu() {
    distMenu.classList.add("hidden");
    distWrapper.classList.remove("open");
    distPill.setAttribute("aria-expanded", "false");
}

distPill.addEventListener("click", function () {
    if (state.waypoints.length < 2) return;
    if (!distMenu.classList.contains("hidden")) {
        closeDistMenu();
    } else {
        distMenu.classList.remove("hidden");
        distWrapper.classList.add("open");
        distPill.setAttribute("aria-expanded", "true");
    }
});

document.addEventListener("click", function (e) {
    if (!distMenu.classList.contains("hidden") && !distWrapper.contains(e.target)) {
        closeDistMenu();
    }
});

document.getElementById("dm-save").addEventListener("click", function (e) {
    // saveNamedRoute reveals the name input INSIDE the side menu — open it
    // first, or the tap is an invisible no-op (keyboard pops for a field the
    // user can't see) and the saved route lands in a list they aren't shown.
    e.stopPropagation(); closeDistMenu(); openMenu(); saveNamedRoute();
});

document.getElementById("dm-export").addEventListener("click", function (e) {
    e.stopPropagation(); closeDistMenu(); exportGPX();
});

document.getElementById("dm-share").addEventListener("click", function (e) {
    e.stopPropagation(); closeDistMenu();
    var url = window.location.href;

    // Compose a plain-text summary for share sheets: "5.2 km loop on Legwork".
    function shareText() {
        var modeWord = (MODE_META[state.mode] || {}).word || "route";
        var dist = document.getElementById("distance-display").textContent || "";
        return (dist ? dist + " " : "") + modeWord + " on Legwork";
    }

    function inlineInputFallback() {
        // Put the URL in a read-only input appended to the banner so the user
        // can triple-tap/select-all and copy. No blocking prompt().
        var banner = document.getElementById("info-banner");
        banner.textContent = "";
        var label = document.createElement("span");
        label.textContent = "Copy: ";
        var input = document.createElement("input");
        input.type = "text";
        input.readOnly = true;
        input.value = url;
        input.className = "share-input";
        banner.appendChild(label);
        banner.appendChild(input);
        banner.dataset.type = "share";
        banner.className = "info-banner share";
        banner.style.display = "block";
        input.focus();
        input.select();
        setTimeout(function () {
            if (banner.dataset.type === "share") showBanner("");
        }, 8000);
    }

    function clipboardFallback() {
        if (navigator.clipboard) {
            navigator.clipboard.writeText(url).then(function () {
                showBanner("Link copied!", "success");
                clearBannerAfter(2000);
            }).catch(inlineInputFallback);
        } else {
            inlineInputFallback();
        }
    }

    // Native share sheet (iOS/Android): opens iMessage/WhatsApp/etc. directly.
    // AbortError is thrown when the user dismisses the sheet — silent no-op.
    if (navigator.share) {
        var payload = { title: "Legwork route", text: shareText(), url: url };
        if (!navigator.canShare || navigator.canShare(payload)) {
            navigator.share(payload).catch(function (err) {
                if (err && err.name === "AbortError") return;
                clipboardFallback();
            });
            return;
        }
    }
    clipboardFallback();
});

document.getElementById("dm-shorten").addEventListener("click", function (e) {
    e.stopPropagation(); closeDistMenu(); shortenCurrentRoute();
});
document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (state.waypoints.length > 1) removeWaypoint(state.waypoints.length - 1);
    }
    // Esc closes the distance dropdown, then the side menu — previously it
    // only dismissed the welcome modal and autocomplete, which read as
    // inconsistent. Inputs keep their own Esc semantics (clear/hide).
    if (e.key === "Escape" && !(e.target && e.target.tagName === "INPUT")) {
        if (!distMenu.classList.contains("hidden")) { closeDistMenu(); return; }
        if (document.getElementById("side-menu").classList.contains("open")) closeMenu();
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

// Re-open the welcome modal from the side menu for users who've dismissed it.
var tipsBtn = document.getElementById("show-tips-btn");
if (tipsBtn) tipsBtn.addEventListener("click", function () {
    closeMenu();
    openWelcomeModal();
});

// Elevation-panel collapse toggle — remembered across sessions via localStorage.
var elevationCollapsed = false;
try { elevationCollapsed = localStorage.getItem("lw:elevCollapsed") === "1"; } catch (e) {}
function applyElevationCollapsed() {
    var panel = document.getElementById("elevation-panel");
    var toggle = document.getElementById("elevation-toggle");
    if (!panel || !toggle) return;
    panel.classList.toggle("collapsed", elevationCollapsed);
    toggle.setAttribute("aria-expanded", elevationCollapsed ? "false" : "true");
    toggle.setAttribute("aria-label", elevationCollapsed ? "Expand elevation chart" : "Collapse elevation chart");
    // Chevron points down when expanded (▾), up when collapsed (▴).
    toggle.textContent = elevationCollapsed ? "▴" : "▾";
    // Chart.js needs a redraw when its container changes size.
    if (state.elevationChart) state.elevationChart.resize();
}
var elevToggle = document.getElementById("elevation-toggle");
if (elevToggle) elevToggle.addEventListener("click", function () {
    elevationCollapsed = !elevationCollapsed;
    try { localStorage.setItem("lw:elevCollapsed", elevationCollapsed ? "1" : "0"); } catch (e) {}
    applyElevationCollapsed();
});
applyElevationCollapsed();

// ── Unit toggle (in menu) ─────────────────────────────
// A manual choice persists; autoDetectUnits only runs while lw:useMiles is unset.
try {
    if (localStorage.getItem("lw:useMiles") === "1") {
        state.useMiles = true;
        document.getElementById("unit-label").textContent = "mi";
    }
} catch (e) { /* blocked storage */ }
document.getElementById("unit-toggle").addEventListener("click", function () {
    state.useMiles = !state.useMiles;
    try { localStorage.setItem("lw:useMiles", state.useMiles ? "1" : "0"); } catch (e) {}
    document.getElementById("unit-label").textContent = state.useMiles ? "mi" : "km";
    updateDistance();
});

// ── Cycling toggle (in menu) ──────────────────────────
function syncCyclingLabel() {
    var c = document.getElementById("cycling-label");
    if (c) c.textContent = state.profile === "bike" ? "On" : "Off";
}
syncCyclingLabel();
document.getElementById("cycling-toggle").addEventListener("click", function () {
    state.profile = state.profile === "bike" ? "run" : "bike";
    try { localStorage.setItem("lw:profile", state.profile); } catch (e) {}
    syncCyclingLabel();
    rebuildGraphForProfile();
    updateRoute();
});

// ── POI toggles (in menu) ─────────────────────────────
function syncPoiLabels() {
    var t = document.getElementById("toilets-label");
    var w = document.getElementById("water-label");
    if (t) t.textContent = state.showToilets ? "On" : "Off";
    if (w) w.textContent = state.showWater ? "On" : "Off";
}
syncPoiLabels();
document.getElementById("toilets-toggle").addEventListener("click", function () {
    state.showToilets = !state.showToilets;
    try { localStorage.setItem("lw:showToilets", state.showToilets ? "1" : "0"); } catch (e) {}
    syncPoiLabels();
    refreshPois();
});
document.getElementById("water-toggle").addEventListener("click", function () {
    state.showWater = !state.showWater;
    try { localStorage.setItem("lw:showWater", state.showWater ? "1" : "0"); } catch (e) {}
    syncPoiLabels();
    refreshPois();
});
// If either was on in a previous session, paint once the map is ready.
if (anyPoisVisible()) setTimeout(refreshPois, 1200);

// ── Auto-detect miles for US/UK/MM/LR ─────────────────
var MILES_COUNTRIES = ["US", "GB", "MM", "LR"];
function autoDetectUnits(lat, lon) {
    // The user's explicit toggle beats geo-detection — without this, a manual
    // override reset on every boot.
    try { if (localStorage.getItem("lw:useMiles") !== null) return; } catch (e) {}
    fetchWithTimeout("https://photon.komoot.io/reverse?lat=" + lat + "&lon=" + lon + "&limit=1", null, 10000)
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
// ── Route persistence (session autosave, IndexedDB) ───
function saveRoute() {
    if (state.waypoints.length === 0) {
        autosaveClear();
        return;
    }
    var data = {
        waypoints: state.waypoints.map(function (wp) {
            return { lat: wp.lat, lon: wp.lon, nodeKey: wp.nodeKey };
        }),
        mode: state.mode,
        zoom: state.map.getZoom(),
    };
    autosaveSet(data);
}

// ── Install prompt ────────────────────────────────────
var deferredInstallPrompt = null;

function setupInstallPrompt() {
    var el = document.getElementById("install-prompt");
    // Already running as installed PWA
    if (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone) return;

    function handleInstall() {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then(function () {
            deferredInstallPrompt = null;
            el.classList.add("hidden");
        });
    }
    // Wire handlers once — beforeinstallprompt can refire and would otherwise stack listeners.
    el.addEventListener("click", handleInstall);
    el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleInstall(); }
    });

    // Android/Chrome: capture the beforeinstallprompt event
    window.addEventListener("beforeinstallprompt", function (e) {
        e.preventDefault();
        deferredInstallPrompt = e;
        el.textContent = "Install app";
        el.classList.remove("hidden");
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
    });

    // iOS Safari: show manual hint (informational, not a button — no install API)
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|FxiOS/.test(navigator.userAgent);
    if (isIOS && isSafari) {
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(document.createTextNode("Add to Home Screen: tap "));
        var s1 = document.createElement("strong");
        s1.textContent = "Share";
        el.appendChild(s1);
        el.appendChild(document.createTextNode(" → "));
        var s2 = document.createElement("strong");
        s2.textContent = "Add to Home Screen";
        el.appendChild(s2);
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
    var hash = window.location.hash.replace(/^#/, "");
    if (!hash) return false;
    var params = new URLSearchParams(hash);
    var r = params.get("r");
    if (!r) return false;
    var points = r.split(";").map(function (p) {
        return parseNodeKey(p);
    });
    if (points.length < 2) return false;
    // Reject any non-finite or out-of-range coordinate. parseNodeKey uses
    // parseFloat, so a malformed "#r=foo;bar" yields NaN points that would
    // otherwise pass the length check and feed NaN into setView/addWaypointAt
    // (dead-boots the map). Defends the restore path against a bad share link.
    for (var pi = 0; pi < points.length; pi++) {
        var pt = points[pi];
        if (!isFinite(pt.lat) || !isFinite(pt.lon) ||
            pt.lat < -90 || pt.lat > 90 || pt.lon < -180 || pt.lon > 180) return false;
    }
    var m = params.get("m");
    if (m === "outback" || m === "loop" || m === "oneway") {
        state.mode = m;
        setModeButton();
        updateReverseVisibility();
    }
    return points;
}

// ── Welcome modal ──────────────────────────────────────
// Wired once at boot; openWelcomeModal() can be re-invoked from the Tips
// menu item and the dismiss listeners are already in place.

// Resolves when the welcome modal is dismissed. The boot geolocate awaits this
// on first run so the OS location prompt doesn't stack on top of the welcome
// modal — permission asked after "Start planning" has given it context.
var _welcomeDismissResolve = null;
var _welcomeDismissed = new Promise(function (res) { _welcomeDismissResolve = res; });

function wireWelcomeModal() {
    var modal = document.getElementById("welcome-modal");
    var isMacDesktop = /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;
    var undoKey = document.getElementById("undo-key");
    if (undoKey && isMacDesktop) undoKey.textContent = "\u2318";

    function dismiss() {
        modal.classList.add("hidden");
        if (_welcomeDismissResolve) _welcomeDismissResolve();
        try { localStorage.setItem("lw:welcomed", "1"); } catch (e) { /* blocked storage */ }
    }
    document.getElementById("welcome-dismiss").addEventListener("click", dismiss);
    modal.addEventListener("click", function (e) {
        if (e.target === modal) dismiss();
    });
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !modal.classList.contains("hidden")) dismiss();
    });
}

function openWelcomeModal() {
    document.getElementById("welcome-modal").classList.remove("hidden");
}

function showWelcome() {
    wireWelcomeModal();
    try {
        if (localStorage.getItem("lw:welcomed")) {
            document.getElementById("welcome-modal").classList.add("hidden");
            if (_welcomeDismissResolve) _welcomeDismissResolve(); // never shown → nothing to wait for
            return;
        }
    } catch (e) { /* blocked storage — show modal every time */ }
    // First-time user: modal is already visible by default.
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
        fetchWithTimeout("https://photon.komoot.io/reverse?lat=" + startWp.lat + "&lon=" + startWp.lon + "&limit=1", null, 10000)
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
    // Re-entry guard: Enter + a fast second Enter (or Enter + button click)
    // both fire before the first async save completes, writing two records.
    if (inputRow.classList.contains("hidden")) return;
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
        waypointHash: waypointHash(state.waypoints),
    };

    try {
        var db = await openDB();
        await new Promise(function (resolve, reject) {
            var tx = db.transaction("savedRoutes", "readwrite");
            tx.objectStore("savedRoutes").add(routeData);
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
        });
        showBanner("Route saved: " + name, "success");
        clearBannerAfter(2500);
        renderSavedRoutes();
    } catch (e) {
        console.error("save route:", e);
        showBanner("Couldn't save route — your browser storage may be full");
    }
}

document.getElementById("save-route-confirm").addEventListener("click", confirmSaveRoute);
document.getElementById("save-route-name").addEventListener("keydown", function (e) {
    if (e.key === "Enter") confirmSaveRoute();
    if (e.key === "Escape") document.getElementById("save-route-input").classList.add("hidden");
});

async function autoSaveSharedRoute() {
    if (state.waypoints.length < 2) return;
    var hash = waypointHash(state.waypoints);
    var existing = await findSavedRouteByHash(hash);
    if (existing) return; // dedup hit — silent

    var dist = document.getElementById("distance-display").textContent;
    var routeData = {
        name: "Route — " + dist, // placeholder; replaced by geocode below
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
        waypointHash: hash,
    };

    var savedId;
    try {
        var db = await openDB();
        savedId = await new Promise(function (resolve, reject) {
            var tx = db.transaction("savedRoutes", "readwrite");
            var req = tx.objectStore("savedRoutes").add(routeData);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(tx.error); };
        });
    } catch (e) {
        return; // storage failure — don't toast, don't crash
    }

    showBanner("Saved to your routes", "success");
    clearBannerAfter(3000);
    renderSavedRoutes();

    // Async geocode replacement of the placeholder name.
    var startWp = state.waypoints[0];
    if (navigator.onLine) {
        fetchWithTimeout("https://photon.komoot.io/reverse?lat=" + startWp.lat + "&lon=" + startWp.lon + "&limit=1", null, 10000)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var feat = (data.features || [])[0];
                if (feat && feat.properties) {
                    var p = feat.properties;
                    var name = p.name || p.street || p.city;
                    if (name) {
                        updateSavedRouteName(savedId, name + " — " + dist).then(renderSavedRoutes);
                    }
                }
            })
            .catch(function () {});
    }
}

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

async function findSavedRouteByHash(hash) {
    if (!hash) return null;
    try {
        var db = await openDB();
        return new Promise(function (resolve) {
            var tx = db.transaction("savedRoutes", "readonly");
            var req = tx.objectStore("savedRoutes").getAll();
            req.onsuccess = function () {
                var match = (req.result || []).find(function (r) {
                    return r.waypointHash === hash;
                });
                resolve(match || null);
            };
            req.onerror = function () { resolve(null); };
        });
    } catch (e) {
        return null;
    }
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
        if (!route) { showBanner("That saved route is no longer here — it may have been deleted"); return; }

        // Clear existing state
        clearRouteLayers(false);

        // Restore mode
        state.mode = route.mode || "loop";
        setModeButton();
        updateReverseVisibility();

        // Restore map position
        state.map.setView([route.center.lat, route.center.lon], route.zoom || 14);

        // Reset graph if restoring into a different city than current session.
        await resetGraphIfCityChanged(route.center.lat, route.center.lon);

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
        showBanner("Loaded: " + route.name, "success");
        clearBannerAfter(2500);
    } catch (e) {
        console.error("load route:", e);
        showBanner("Couldn't open that route — try again");
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

async function updateSavedRouteName(id, newName) {
    var name = (newName || "").trim();
    if (!name) return false;
    try {
        var db = await openDB();
        await new Promise(function (resolve, reject) {
            var tx = db.transaction("savedRoutes", "readwrite");
            var store = tx.objectStore("savedRoutes");
            var req = store.get(id);
            req.onsuccess = function () {
                var rec = req.result;
                if (!rec) { resolve(); return; }
                rec.name = name;
                store.put(rec);
            };
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
        });
        return true;
    } catch (e) {
        return false;
    }
}

async function restoreSavedRouteRecord(record) {
    try {
        var db = await openDB();
        await new Promise(function (resolve, reject) {
            var tx = db.transaction("savedRoutes", "readwrite");
            tx.objectStore("savedRoutes").put(record);
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
        });
    } catch (e) {}
}

async function renderSavedRoutes() {
    var list = document.getElementById("saved-routes-list");
    if (!list) return;
    var routes = await loadSavedRoutes();
    routes.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    // Lazy hash backfill — older entries pre-dedup get their hash on first render.
    var needsBackfill = routes.filter(function (r) { return !r.waypointHash && r.waypoints; });
    if (needsBackfill.length > 0) {
        var db = await openDB();
        await new Promise(function (resolve) {
            var tx = db.transaction("savedRoutes", "readwrite");
            var store = tx.objectStore("savedRoutes");
            needsBackfill.forEach(function (r) {
                r.waypointHash = waypointHash(r.waypoints);
                store.put(r);
            });
            tx.oncomplete = resolve;
            tx.onerror = resolve;
        });
    }
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
            // Mode chip — short label without the leading unicode symbol.
            var modeShort = (MODE_META[route.mode] || {}).word || route.mode;
            if (modeShort) parts.push(modeShort);
            // Ascent from stored elevation samples, if any. Same shared accumulator
            // + dead-band as the elevation panel, so the list and panel agree.
            if (route.elevationData && route.elevationData.length > 1) {
                var ascent = computeAscent(route.elevationData, 5).ascent;
                if (ascent > 0) parts.push("\u2191" + Math.round(ascent) + "m");
            }
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
                var snapshot = route; // closure captures full record for restore
                deleteSavedRoute(route.id);
                showActionBanner("Route deleted", "Undo", function () {
                    restoreSavedRouteRecord(snapshot).then(renderSavedRoutes);
                }, 5000);
            });
            var edit = document.createElement("button");
            edit.className = "saved-item-edit";
            edit.textContent = "\u270e";
            edit.title = "Rename saved route";
            edit.addEventListener("click", function (e) {
                e.stopPropagation();
                startInlineRename(label, route.id);
            });
            row.appendChild(info);
            row.appendChild(edit);
            row.appendChild(del);
            list.appendChild(row);
        })(routes[i]);
    }
}

function startInlineRename(labelEl, routeId) {
    var oldName = labelEl.textContent;
    var input = document.createElement("input");
    input.type = "text";
    input.value = oldName;
    input.className = "saved-item-rename-input";
    input.autocomplete = "off";

    var committed = false;
    function commit() {
        if (committed) return;
        committed = true;
        var newName = input.value.trim();
        if (newName && newName !== oldName) {
            updateSavedRouteName(routeId, newName).then(renderSavedRoutes);
        } else {
            labelEl.textContent = oldName;
            input.replaceWith(labelEl);
        }
    }
    function cancel() {
        if (committed) return;
        committed = true;
        labelEl.textContent = oldName;
        input.replaceWith(labelEl);
    }

    input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") cancel();
    });
    input.addEventListener("blur", commit);

    labelEl.replaceWith(input);
    input.focus();
    input.select();
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
setupOsmIssueLink();
buildMenuLegend();
updateReverseVisibility();
showWelcome();
updateOnlineStatus();
setupInstallPrompt();

// Ensure the routing graph covers every leg of a just-restored route. Each
// waypoint's tiles may not have been loaded (addWaypointAt's fast path reuses
// whatever graph is already present), leaving mid-corridor gaps that make
// Dijkstra detour. loadTilesForLocation pulls a 5 km radius and merges into the
// graph — but a 5 km disc per waypoint only covers the corridor where waypoints
// are <10 km apart. For a sparse route (e.g. a shared start+end 42 km apart)
// that leaves a huge mid-leg hole and the detour bug persists. So we step ALONG
// each leg (~4 km spacing), not just at the waypoints, deduping at 3 km so dense
// routes don't re-load overlapping discs. Idempotent: cached tiles return fast.
async function ensureTilesAlongRoute() {
    var loaded = [];
    async function loadOnce(lat, lon) {
        var covered = loaded.some(function (p) { return haversine(p.lat, p.lon, lat, lon) < 3000; });
        if (covered) return;
        await loadTilesForLocation(lat, lon);
        loaded.push({ lat: lat, lon: lon });
    }
    for (var j = 0; j < state.waypoints.length; j++) {
        var w = state.waypoints[j];
        await loadOnce(w.lat, w.lon);
        if (j + 1 < state.waypoints.length) {
            var n = state.waypoints[j + 1];
            var dist = haversine(w.lat, w.lon, n.lat, n.lon);
            var steps = Math.ceil(dist / 4000); // one load every ~4 km along the leg
            for (var s = 1; s < steps; s++) {
                var t = s / steps;
                await loadOnce(w.lat + t * (n.lat - w.lat), w.lon + t * (n.lon - w.lon));
            }
        }
    }
}

// ── Share short-links (?s=<slug>) ──────────────────────
// Copy `text` to the clipboard with a banner confirmation; fall back to a
// read-only input the user can select if the Clipboard API is unavailable.
function copyText(text, okMsg) {
    function fallback() {
        var banner = document.getElementById("info-banner");
        banner.textContent = "";
        var label = document.createElement("span");
        label.textContent = "Copy: ";
        var input = document.createElement("input");
        input.type = "text"; input.readOnly = true; input.value = text; input.className = "share-input";
        banner.appendChild(label); banner.appendChild(input);
        banner.dataset.type = "share"; banner.className = "info-banner share"; banner.style.display = "block";
        input.focus(); input.select();
        setTimeout(function () { if (banner.dataset.type === "share") showBanner(""); }, 8000);
    }
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
            showBanner(okMsg, "success"); clearBannerAfter(2500);
        }).catch(fallback);
    } else {
        fallback();
    }
}

// "Shorten link" menu action: POST the current route hash to the Worker and copy
// the returned short URL. Opt-in (stores the route server-side); if the Worker is
// unreachable the full #r= link still works, so we copy that instead.
async function shortenCurrentRoute() {
    var hash = window.location.hash;
    if (!hash || hash.indexOf("r=") === -1) {
        showBanner("Add at least 2 waypoints first");
        return;
    }
    showBanner("Shortening…", "loading");
    try {
        var resp = await fetch(WORKER_BASE + "/api/links", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hash: hash }),
        });
        if (!resp.ok) throw new Error("status " + resp.status);
        var data = await resp.json();
        // Trust boundary: the resolve path validates data.hash strictly, but this
        // path copied data.url verbatim — a compromised/buggy Worker could put an
        // arbitrary string (e.g. a phishing URL) straight onto the clipboard.
        if (typeof data.url !== "string" || data.url.indexOf("https://legwork.day/") !== 0) {
            throw new Error("unexpected url shape");
        }
        copyText(data.url, "Short link copied!");
    } catch (e) {
        copyText(window.location.href, "Couldn't shorten — copied the full link");
    }
}

// Boot: if the URL is a short link (?s=<slug>), resolve it to the route hash and
// hand it to the existing #r= restore path. Worker/network failure falls through
// to a normal boot — short links degrade, the app doesn't.
async function maybeResolveShortLink() {
    var s = new URLSearchParams(window.location.search).get("s");
    if (!s || !/^[A-Za-z0-9-]{3,40}$/.test(s)) return;
    try {
        var resp = await fetch(WORKER_BASE + "/api/links/" + encodeURIComponent(s));
        if (resp.ok) {
            var data = await resp.json();
            // Validate the server-returned hash shape before trusting it into the
            // address bar — defense in depth, so a compromised/buggy resolve can't
            // forge an arbitrary same-origin path via replaceState. It must be a
            // bare "#r=<coords>&m=<mode>" route fragment, nothing else.
            if (data && typeof data.hash === "string" &&
                /^#r=[-0-9.,;]+&m=(loop|outback|oneway)$/.test(data.hash)) {
                // Replace ?s=… with the resolved #r=… (clean URL, no extra history entry).
                window.history.replaceState(null, "", window.location.pathname + data.hash);
            } else {
                showBanner("That short link wasn't found");
            }
        } else if (resp.status === 404) {
            showBanner("That short link wasn't found");
        }
    } catch (e) {
        /* Worker/network down — fall through to normal boot. */
    }
}

// Migrate old localStorage to IndexedDB first so autosaveGet sees migrated data.
(async function () {
    await migrateLocalStorage();
    renderSavedRoutes();

    await maybeResolveShortLink();

    var sharedPoints = loadFromHash();
    var savedRoute = !sharedPoints ? await autosaveGet() : null;

    if (sharedPoints) {
        // Restore from share link
        var center = sharedPoints[0];
        state.map.setView([center.lat, center.lon], 14);
        autoDetectUnits(center.lat, center.lon);
        await resetGraphIfCityChanged(center.lat, center.lon);
        await loadTilesOrPaths(center.lat, center.lon);
        for (var i = 0; i < sharedPoints.length; i++) {
            await addWaypointAt(sharedPoints[i].lat, sharedPoints[i].lon, { exactPosition: i === 0 });
        }
        // addWaypointAt only loads tiles *near* each waypoint, so a long route can
        // be missing the mid-corridor tiles between far-apart waypoints. Routing
        // then detours wildly through whatever IS loaded (e.g. 400 km for a 41 km
        // route) and only corrected when a later map click re-routed against a graph
        // that had since background-loaded. Eagerly load tiles spanning every leg,
        // then route once against the now-complete graph. (~3 km dedup: each load
        // covers a 5 km radius, so nearby waypoints don't refetch.)
        await ensureTilesAlongRoute();
        await updateRoute();
        await autoSaveSharedRoute();
        return;
    }

    if (savedRoute && savedRoute.waypoints && savedRoute.waypoints.length > 0) {
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
        await resetGraphIfCityChanged(ctr.lat, ctr.lon);
        await loadTilesOrPaths(ctr.lat, ctr.lon);
        for (var i = 0; i < sw.length; i++) {
            await addWaypointAt(sw[i].lat, sw[i].lon, { exactPosition: i === 0 });
        }
        // Same incomplete-graph race as the share-restore path: load tiles across
        // every leg, then route once against the complete graph.
        await ensureTilesAlongRoute();
        await updateRoute();
        return;
    }

    if (navigator.geolocation) {
        // Fresh start — geolocate. On first run the welcome modal is still up;
        // wait for "Start planning" so the OS permission prompt arrives with
        // context instead of stacked on top of the modal (the classic cause of
        // a reflexive "Don't Allow"). Returning users resolve immediately.
        if (!document.getElementById("welcome-modal").classList.contains("hidden")) {
            await _welcomeDismissed;
        }
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                var lat = pos.coords.latitude;
                var lon = pos.coords.longitude;
                state.startLat = lat;
                state.startLon = lon;
                autoDetectUnits(lat, lon);
                state.map.setView([lat, lon], 15);
                showGpsDot(lat, lon);
                resetGraphIfCityChanged(lat, lon).then(function () {
                    return loadTilesForLocation(lat, lon);
                }).then(function (loaded) {
                    if (!loaded) {
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
})();

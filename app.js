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

function updateMarkerNumber(marker, num) {
    marker.setIcon(numberedMarkerIcon(num));
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
    } catch (e) { showBanner("Geocoding failed: " + e.message); }
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
            var resp = await fetchWithTimeout("https://api.open-meteo.com/v1/elevation?latitude=" + lats + "&longitude=" + lons, null, 20000);
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
    // Render the marker IMMEDIATELY at the tap location in pending state.
    // Path loading happens after, with the marker transitioning to ready or failed.
    var num = state.waypoints.length + 1;
    var marker = createNumberedMarker(lat, lon, num, "pending");
    wireMarkerEvents(marker);

    // Push a placeholder waypoint so renumbering and removal work even while pending.
    var wp = { lat: lat, lon: lon, marker: marker, nodeKey: null, pending: true };
    state.waypoints.push(wp);

    try {
        var nk = await resolveWaypointNode(lat, lon);
        if (!nk) {
            markWaypointFailed(wp);
            return;
        }
        // If the user removed this waypoint while we were resolving, do nothing.
        var liveIdx = state.waypoints.indexOf(wp);
        if (liveIdx < 0) return;

        var nkParts = nk.split(",");
        var snapLat = parseFloat(nkParts[0]);
        var snapLon = parseFloat(nkParts[1]);
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
    var nkParts = nk.split(",");
    var snapDist = haversine(lat, lon, parseFloat(nkParts[0]), parseFloat(nkParts[1]));
    if (snapDist > 200) {
        await loadPaths(lat, lon);
        nk = closestNode(state.graph, lat, lon);
        if (!nk) return null;
    }
    return nk;
}

// Helper: mark a waypoint as failed, attaching the visual amber retry state.
function markWaypointFailed(wp) {
    var idx = state.waypoints.indexOf(wp);
    if (idx < 0) return;
    wp.pending = false;
    wp.failed = true;
    setMarkerState(wp.marker, idx + 1, "failed");
    showBanner("Could not load paths — tap pin to retry");
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
            markWaypointFailed(wp);
            return;
        }
        var liveIdx = state.waypoints.indexOf(wp);
        if (liveIdx < 0) return;
        var nkParts = nk.split(",");
        var snapLat = parseFloat(nkParts[0]);
        var snapLon = parseFloat(nkParts[1]);
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
    for (var i = 0; i < state.waypoints.length; i++) updateMarkerNumber(state.waypoints[i].marker, i + 1);
    updateRoute();
}

// ── Route drawing ──────────────────────────────────────
var _routeGen = 0;
async function updateRoute() {
    var gen = ++_routeGen;
    clearRouteLayers(true); // keep waypoints; we're redrawing the geometry between them

    if (state.waypoints.length < 2) {
        updateDistance();
        updateElevation([]);
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
    var bannerEl = document.getElementById("info-banner");
    if (bannerEl.dataset.type === "hint") showBanner("");

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
    if (p.access && p.access !== "yes") tags.push("Access: " + p.access);
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

async function refreshPois() {
    if (!state.map) return;
    // If neither type is visible, clear immediately and stop.
    if (!anyPoisVisible()) {
        for (var i = 0; i < state.poiMarkers.length; i++) state.map.removeLayer(state.poiMarkers[i]);
        state.poiMarkers = [];
        return;
    }
    var c = state.map.getCenter();
    var pois = await loadPois(c.lat, c.lng);
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
    clearLayerArray("distanceMarkers");
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
            var mkr = L.marker([lat, lon], {
                icon: L.divIcon({
                    html: '<div class="distance-pill">' + (markNum + suffix) + '</div>',
                    className: "",
                    iconSize: [30, 16],
                    iconAnchor: [15, 8],
                }),
                interactive: false,
                zIndexOffset: -100,
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
    this.setAttribute("aria-label", "Route mode: " + state.mode + " (tap to cycle)");
    updateReverseVisibility();
    updateRoute();
});
document.getElementById("reverse-btn").addEventListener("click", function () {
    if (state.waypoints.length < 2) return;
    state.waypoints.reverse();
    for (var i = 0; i < state.waypoints.length; i++) updateMarkerNumber(state.waypoints[i].marker, i + 1);
    updateRoute();
    showBanner("Route reversed", "hint");
    setTimeout(function () {
        var el = document.getElementById("info-banner");
        if (el.dataset.type === "hint" && el.textContent === "Route reversed") showBanner("");
    }, 1500);
});
document.getElementById("clear-btn").addEventListener("click", function () {
    clearRouteLayers(false);
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

    // Compose a plain-text summary for share sheets: "5.2 km loop on Legwork".
    function shareText() {
        var modeWord = { loop: "loop", outback: "out & back", oneway: "one-way" }[state.mode] || "route";
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
                showBanner("Link copied!");
                setTimeout(function () { showBanner(""); }, 2000);
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
document.getElementById("unit-toggle").addEventListener("click", function () {
    state.useMiles = !state.useMiles;
    document.getElementById("unit-label").textContent = state.useMiles ? "mi" : "km";
    updateDistance();
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
    var hash = window.location.hash.replace(/^#/, "");
    if (!hash) return false;
    var params = new URLSearchParams(hash);
    var r = params.get("r");
    if (!r) return false;
    var points = r.split(";").map(function (p) {
        var parts = p.split(",");
        return { lat: parseFloat(parts[0]), lon: parseFloat(parts[1]) };
    });
    if (points.length < 2) return false;
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
function wireWelcomeModal() {
    var modal = document.getElementById("welcome-modal");
    var isMacDesktop = /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;
    var undoKey = document.getElementById("undo-key");
    if (undoKey && isMacDesktop) undoKey.textContent = "\u2318";

    function dismiss() {
        modal.classList.add("hidden");
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
            // Mode chip — short label without the leading unicode symbol.
            var modeShort = { loop: "loop", outback: "out & back", oneway: "one way" }[route.mode] || route.mode;
            if (modeShort) parts.push(modeShort);
            // Ascent from stored elevation samples, if any.
            if (route.elevationData && route.elevationData.length > 1) {
                var ascent = 0, pending = 0;
                for (var ei = 1; ei < route.elevationData.length; ei++) {
                    var diff = route.elevationData[ei].elevation - route.elevationData[ei-1].elevation;
                    pending += diff;
                    if (pending > 2) { ascent += pending; pending = 0; }
                    else if (pending < -2) { pending = 0; }
                }
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
setupOsmIssueLink();
buildMenuLegend();
updateReverseVisibility();
showWelcome();
updateOnlineStatus();
setupInstallPrompt();

// Migrate old localStorage to IndexedDB first so autosaveGet sees migrated data.
(async function () {
    await migrateLocalStorage();
    renderSavedRoutes();

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
        return;
    }

    if (navigator.geolocation) {
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

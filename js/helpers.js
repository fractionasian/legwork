import { state, GRAPH_RESET_METRES } from './state.js';
import { resetSpatialGrid } from './router.js';

export function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = function(x) { return x * Math.PI / 180; };
    var dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export function nodeKey(lat, lon) {
    return lat.toFixed(6) + "," + lon.toFixed(6);
}

export function elevKey(lat, lon) {
    return "elev2:" + lat.toFixed(5) + ":" + lon.toFixed(5);
}

export function pathToCoords(path) {
    var coords = [];
    for (var i = 0; i < path.length; i++) {
        var parts = path[i].split(",");
        coords.push([parseFloat(parts[0]), parseFloat(parts[1])]);
    }
    return coords;
}

export function showBanner(msg, type) {
    var el = document.getElementById("info-banner");
    el.textContent = msg;
    el.className = "info-banner" + (type ? " " + type : " error");
    el.dataset.type = type || "";
    el.style.display = msg ? "block" : "none";
}

export function clearLayers(layers) {
    if (!layers || !state.map) return;
    for (var i = 0; i < layers.length; i++) state.map.removeLayer(layers[i]);
    layers.length = 0;
}

export function clearWaypoints() {
    if (!state.map) { state.waypoints = []; return; }
    for (var i = 0; i < state.waypoints.length; i++) state.map.removeLayer(state.waypoints[i].marker);
    state.waypoints = [];
}

export function clearRouteOverlays() {
    clearLayers(state.routeLines);
    clearLayers(state.gradientLines);
    clearLayers(state.midpointMarkers);
    clearLayers(state.distanceMarkers);
    if (state.closingLine) { state.map.removeLayer(state.closingLine); state.closingLine = null; }
    if (state.routeOutline) { state.map.removeLayer(state.routeOutline); state.routeOutline = null; }
    state.routeSegments = [];
    state.routeFlatCoords = null;
    state.cumDist = null;
}

export function clearGraphState() {
    if (state.pathLayer) { state.map.removeLayer(state.pathLayer); state.pathLayer = null; }
    state.pathFeatures = null;
    state.graph = null;
    state.edgeSet = null;
    state.seenIds = null;
    resetSpatialGrid();
}

export function maybeResetGraphFor(lat, lon) {
    if (state.startLat == null) return;
    if (haversine(lat, lon, state.startLat, state.startLon) > GRAPH_RESET_METRES) clearGraphState();
}

export function rebuildCumulativeDist() {
    var coords = [];
    for (var s = 0; s < state.routeSegments.length; s++) {
        var seg = state.routeSegments[s];
        var start = coords.length === 0 ? 0 : 1;
        for (var ci = start; ci < seg.length; ci++) coords.push(seg[ci]);
    }
    if (state.mode === "loop" && state.closingLine) {
        var cl = state.closingLine.getLatLngs();
        for (var ci2 = 1; ci2 < cl.length; ci2++) coords.push([cl[ci2].lat, cl[ci2].lng]);
    }
    var cum = new Float64Array(coords.length);
    for (var i = 1; i < coords.length; i++) {
        cum[i] = cum[i-1] + haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
    }
    state.routeFlatCoords = coords;
    state.cumDist = cum;
}

export function findCumIndex(target) {
    var cum = state.cumDist; if (!cum || cum.length === 0) return -1;
    var lo = 1, hi = cum.length - 1;
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cum[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
}

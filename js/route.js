import { state } from './state.js';
import { cacheGet } from './cache.js';
import { haversine, nodeKey, elevKey, pathToCoords, showBanner, clearLayers, clearRouteOverlays, rebuildCumulativeDist, findCumIndex } from './helpers.js';
import { dijkstra, closestNode } from './router.js';
import { loadTilesOrPaths, loadPaths } from './paths.js';
import { debouncedFetchElevation, updateElevation } from './elevation.js';
import { updateShareHash } from './ui.js';
import { saveRoute } from './saved.js';

export function createNumberedMarker(lat, lon, num) {
    var el = document.createElement("div");
    el.style.cssText =
        "background:#2e86de;color:#fff;border:2px solid #fff;border-radius:50%;" +
        "width:28px;height:28px;display:flex;align-items:center;justify-content:center;" +
        "font-size:13px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    el.textContent = num;
    var icon = L.divIcon({ html: el.outerHTML, className: "", iconSize: [28, 28], iconAnchor: [14, 14] });
    return L.marker([lat, lon], { icon: icon, draggable: true }).addTo(state.map);
}

export function updateMarkerNumber(marker, num) {
    var el = document.createElement("div");
    el.style.cssText =
        "background:#2e86de;color:#fff;border:2px solid #fff;border-radius:50%;" +
        "width:28px;height:28px;display:flex;align-items:center;justify-content:center;" +
        "font-size:13px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    el.textContent = num;
    marker.setIcon(L.divIcon({ html: el.outerHTML, className: "", iconSize: [28, 28], iconAnchor: [14, 14] }));
}

export function wireMarkerEvents(marker) {
    marker.on("click", function (ev) {
        L.DomEvent.stopPropagation(ev);
        var idx = -1;
        for (var w = 0; w < state.waypoints.length; w++) { if (state.waypoints[w].marker === marker) { idx = w; break; } }
        removeWaypoint(idx);
    });
    marker.on("dragend", async function () {
        var pos = marker.getLatLng();
        var newKey = closestNode(state.graph, pos.lat, pos.lng);
        if (newKey) {
            var nkParts = newKey.split(",");
            var snapDist = haversine(pos.lat, pos.lng, parseFloat(nkParts[0]), parseFloat(nkParts[1]));
            if (snapDist > 200) {
                showBanner("Loading paths for this area...", "loading");
                await loadTilesOrPaths(pos.lat, pos.lng);
                newKey = closestNode(state.graph, pos.lat, pos.lng);
            }
        } else if (state.graph) {
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

export function onMapClick(e) { addWaypointAt(e.latlng.lat, e.latlng.lng); }

export async function addWaypointAt(lat, lon, opts) {
    if (!state.graph) {
        showBanner("Loading paths for this area...", "loading");
        await loadTilesOrPaths(lat, lon);
        if (!state.graph) { showBanner("Could not load paths for this area"); return; }
    }
    var nk = closestNode(state.graph, lat, lon);
    if (!nk) return;
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

export function removeWaypoint(idx) {
    if (idx < 0 || idx >= state.waypoints.length) return;
    state.map.removeLayer(state.waypoints[idx].marker);
    state.waypoints.splice(idx, 1);
    for (var i = 0; i < state.waypoints.length; i++) updateMarkerNumber(state.waypoints[i].marker, i + 1);
    updateRoute();
}

async function fillGapAndRetry(fromWp, toWp) {
    var dist = haversine(fromWp.lat, fromWp.lon, toWp.lat, toWp.lon);
    var steps = Math.max(1, Math.ceil(dist / 1500));
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

    var newFromKey = closestNode(state.graph, fromWp.lat, fromWp.lon);
    var newToKey = closestNode(state.graph, toWp.lat, toWp.lon);
    if (newFromKey) fromWp.nodeKey = newFromKey;
    if (newToKey) toWp.nodeKey = newToKey;

    return dijkstra(state.graph, fromWp.nodeKey, toWp.nodeKey);
}

var _routeGen = 0;
export async function updateRoute() {
    var gen = ++_routeGen;
    clearRouteOverlays();

    if (state.waypoints.length < 2) { updateDistance(); updateElevation([]); return; }

    var allRouteCoords = [];
    var routeOk = true;

    for (var i = 1; i < state.waypoints.length; i++) {
        var fromWp = state.waypoints[i-1], toWp = state.waypoints[i];
        var result = dijkstra(state.graph, fromWp.nodeKey, toWp.nodeKey);

        var straightDist = haversine(fromWp.lat, fromWp.lon, toWp.lat, toWp.lon);
        var needsGapFill = !result || result.path.length < 2 ||
            (result.dist > straightDist * 3 && straightDist > 200);

        if (needsGapFill) {
            result = await fillGapAndRetry(fromWp, toWp);
            if (gen !== _routeGen) return;
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
            if (gen !== _routeGen) return;
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
    rebuildCumulativeDist();
    updateDistance();
    debouncedFetchElevation(allRouteCoords);
    updateShareHash();
    saveRoute();
}

function addMidpointMarkers() {
    clearLayers(state.midpointMarkers);
    if (state.waypoints.length < 2) return;

    var pairs = [];
    for (var i = 0; i < state.waypoints.length - 1; i++) {
        pairs.push({ afterIdx: i });
    }
    if (state.mode === "loop" && state.waypoints.length >= 2) {
        pairs.push({ afterIdx: state.waypoints.length - 1, closing: true });
    }

    for (var p = 0; p < pairs.length; p++) {
        (function (pair) {
            var fromIdx = pair.afterIdx;
            var toIdx = pair.closing ? 0 : fromIdx + 1;

            var segCoords;
            if (pair.closing && state.closingLine) {
                var cls = state.closingLine.getLatLngs();
                segCoords = cls.map(function (ll) { return [ll.lat, ll.lng]; });
            } else if (!pair.closing && state.routeSegments[fromIdx]) {
                segCoords = state.routeSegments[fromIdx];
            }

            var midLat, midLon;
            if (segCoords && segCoords.length >= 2) {
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
                var insertIdx = pair.closing ? state.waypoints.length : fromIdx + 1;

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

                for (var i = 0; i < state.waypoints.length; i++) {
                    updateMarkerNumber(state.waypoints[i].marker, i + 1);
                }

                updateRoute();
            });

            state.midpointMarkers.push(mid);
        })(pairs[p]);
    }
}

export function updateDistance() {
    var cum = state.cumDist;
    var oneWayLen = cum && cum.length > 0 ? cum[cum.length - 1] : 0;
    var total = state.mode === "outback" ? oneWayLen * 2 : oneWayLen;
    state.totalDistMetres = total;
    var distText = state.useMiles
        ? (total / 1609.344).toFixed(1) + " mi"
        : (total / 1000).toFixed(1) + " km";
    document.getElementById("distance-display").textContent = distText;
    updateDistanceMarkers();
}

function updateDistanceMarkers() {
    clearLayers(state.distanceMarkers);
    var interval = state.useMiles ? 1609.344 : 1000;
    var suffix = state.useMiles ? "mi" : "k";
    var coords = state.routeFlatCoords;
    var cum = state.cumDist;
    if (!coords || coords.length < 2) return;
    var routeLen = cum[cum.length - 1];
    if (routeLen < interval) return;

    var maxMark = Math.floor(routeLen / interval);
    for (var n = 1; n <= maxMark; n++) {
        var target = n * interval;
        var i = findCumIndex(target);
        if (i <= 0) continue;
        var segDist = cum[i] - cum[i-1];
        var ratio = segDist > 0 ? (target - cum[i-1]) / segDist : 0;
        var lat = coords[i-1][0] + ratio * (coords[i][0] - coords[i-1][0]);
        var lon = coords[i-1][1] + ratio * (coords[i][1] - coords[i-1][1]);
        var el = document.createElement("div");
        el.style.cssText = "background:#fff;color:#1a1d28;border-radius:8px;padding:1px 5px;font-size:10px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,0.5);";
        el.textContent = n + suffix;
        var mkr = L.marker([lat, lon], {
            icon: L.divIcon({ html: el.outerHTML, className: "", iconSize: [30,16], iconAnchor: [15,8] }),
            interactive: false, zIndexOffset: -100,
        }).addTo(state.map);
        state.distanceMarkers.push(mkr);
    }
}

export async function exportGPX() {
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
    var elevLookup = {};
    for (var e = 0; e < state.lastElevationData.length; e++) {
        var ed = state.lastElevationData[e];
        if (ed) elevLookup[ed.lat.toFixed(5) + "," + ed.lon.toFixed(5)] = ed.elevation;
    }

    var gpx = ['<?xml version="1.0" encoding="UTF-8"?>','<gpx version="1.1" creator="Legwork" xmlns="http://www.topografix.com/GPX/1/1">','  <trk>','    <name>'+name+'</name>','    <trkseg>'];
    for (var i = 0; i < coords.length; i++) {
        var ek = coords[i][0].toFixed(5) + "," + coords[i][1].toFixed(5);
        var elev = elevLookup[ek];
        if (elev === undefined) {
            var cached = await cacheGet(elevKey(coords[i][0], coords[i][1]));
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

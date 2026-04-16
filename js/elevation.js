import { state } from './state.js';
import { cacheGet, cacheSet } from './cache.js';
import { haversine, elevKey, clearLayers } from './helpers.js';

export async function fetchElevation(points) {
    var keys = points.map(function (p) { return elevKey(p.lat, p.lon); });
    var cachedAll = await Promise.all(keys.map(function (k) { return cacheGet(k); }));

    var results = new Array(points.length);
    var uncached = [];
    var uncachedIdx = [];
    for (var i = 0; i < points.length; i++) {
        if (cachedAll[i]) results[i] = cachedAll[i];
        else { results[i] = null; uncached.push(points[i]); uncachedIdx.push(i); }
    }

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
                if (elevArr[j] != null) cacheSet(elevKey(entry.lat, entry.lon), entry);
            }
        } catch (e) {
            console.warn("Elevation batch failed:", e.message);
            for (var k = 0; k < batch.length; k++) {
                if (!results[uncachedIdx[b + k]]) results[uncachedIdx[b + k]] = { lat: batch[k].lat, lon: batch[k].lon, elevation: 0 };
            }
        }
    }
    return results;
}

export function sampleRoute(coords, intervalMetres) {
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

var _smoothCache = { src: null, out: null };
export function smoothElevations(elevData) {
    if (_smoothCache.src === elevData) return _smoothCache.out;
    if (elevData.length < 2) { _smoothCache = { src: elevData, out: elevData }; return elevData; }
    var alpha = 0.6;
    var smoothed = [elevData[0]];
    for (var i = 1; i < elevData.length; i++) {
        var prev = smoothed[i-1].elevation;
        var curr = elevData[i].elevation;
        smoothed.push({ lat: elevData[i].lat, lon: elevData[i].lon, elevation: alpha * curr + (1 - alpha) * prev });
    }
    for (var j = smoothed.length - 2; j >= 0; j--) {
        smoothed[j] = { lat: smoothed[j].lat, lon: smoothed[j].lon, elevation: alpha * smoothed[j].elevation + (1 - alpha) * smoothed[j+1].elevation };
    }
    _smoothCache = { src: elevData, out: smoothed };
    return smoothed;
}

export function colourRouteByGradient(elevData) {
    elevData = smoothElevations(elevData);
    if (elevData.length < 2) return;
    clearLayers(state.routeLines);
    if (state.closingLine) { state.map.removeLayer(state.closingLine); state.closingLine = null; }
    if (state.routeOutline) { state.map.removeLayer(state.routeOutline); state.routeOutline = null; }

    var coords = [[elevData[0].lat, elevData[0].lon, 0]];
    for (var i = 1; i < elevData.length; i++) {
        var prev = elevData[i-1], curr = elevData[i];
        var dist = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
        var grade = 0;
        if (dist > 0) grade = ((curr.elevation - prev.elevation) / dist) * 100;
        grade = Math.max(-15, Math.min(15, grade));
        coords.push([curr.lat, curr.lon, grade]);
    }

    var hotline = L.hotline(coords, {
        min: -15,
        max: 15,
        palette: {
            0.0:  '#3b82f6',
            0.17: '#60a5fa',
            0.33: '#93c5fd',
            0.43: '#6ee7b7',
            0.57: '#6ee7b7',
            0.67: '#fbbf24',
            0.83: '#f87171',
            1.0:  '#dc2626',
        },
        weight: 5,
        outlineWidth: 1,
        outlineColor: '#000',
    }).addTo(state.map);
    state.gradientLines.push(hotline);
}

export function updateElevation(elevData) {
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
    var DEAD_BAND = 2;
    var pending = 0;
    var segGradients = [0];
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

    function gradeColor(grade) {
        var g = Math.max(-15, Math.min(15, grade));
        if (g <= -10) return "#3b82f6";
        if (g <= -5)  return "#60a5fa";
        if (g <= -2)  return "#93c5fd";
        if (g <= 2)   return "#6ee7b7";
        if (g <= 5)   return "#fbbf24";
        if (g <= 10)  return "#f87171";
        return "#dc2626";
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

var _elevationTimer = null;
export function debouncedFetchElevation(coords) {
    clearTimeout(_elevationTimer);
    _elevationTimer = setTimeout(function () { fetchRouteElevation(coords); }, 400);
}

export async function fetchRouteElevation(coords) {
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

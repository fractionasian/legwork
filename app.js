// ── Legwork — Static Running Route Planner ─────────────
// All API calls go directly to free external services.
// No backend required. Runs on GitHub Pages.

import { state } from './js/state.js';
import { migrateLocalStorage } from './js/cache.js';
import { showBanner } from './js/helpers.js';
import { initMap, buildMenuLegend } from './js/map.js';
import { loadTilesForLocation, loadTilesOrPaths, loadPaths, showCityRequest } from './js/paths.js';
import { addWaypointAt } from './js/route.js';
import { renderSavedRoutes, loadSavedRoute } from './js/saved.js';
import {
    setupAutocomplete, updateReverseVisibility, showWelcome, updateOnlineStatus,
    setupInstallPrompt, loadFromHash, setModeButton, autoDetectUnits, showGpsDot,
    openMenu, bindEvents,
} from './js/ui.js';

// ── Service worker ────────────────────────────────────
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function (e) {
        console.warn("SW registration failed:", e.message);
    });
}

// ── Boot ───────────────────────────────────────────────
initMap();
setupAutocomplete();
buildMenuLegend();
updateReverseVisibility();
showWelcome();
updateOnlineStatus();
setupInstallPrompt();
bindEvents();

// Migrate old localStorage cache to IndexedDB, then render saved lists
migrateLocalStorage().then(function () {
    renderSavedRoutes();
});

var sharedPoints = loadFromHash();
var savedRoute = !sharedPoints ? loadSavedRoute() : null;

if (sharedPoints) {
    var center = sharedPoints[0];
    state.map.setView([center.lat, center.lon], 14);
    autoDetectUnits(center.lat, center.lon);
    loadTilesOrPaths(center.lat, center.lon).then(async function () {
        for (var i = 0; i < sharedPoints.length; i++) await addWaypointAt(sharedPoints[i].lat, sharedPoints[i].lon, { exactPosition: i === 0 });
    });
} else if (savedRoute && savedRoute.waypoints && savedRoute.waypoints.length > 0) {
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
            openMenu();
            var input = document.getElementById("address-input");
            if (input) { input.focus(); input.placeholder = "Search for your location to get started"; }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
}

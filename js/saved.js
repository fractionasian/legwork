import { state } from './state.js';
import { openDB } from './cache.js';
import { showBanner, clearWaypoints, clearRouteOverlays, maybeResetGraphFor } from './helpers.js';
import { createNumberedMarker, wireMarkerEvents, updateRoute } from './route.js';
import { loadTilesOrPaths } from './paths.js';
import { setModeButton, updateReverseVisibility, closeMenu } from './ui.js';

export function saveRoute() {
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

export function loadSavedRoute() {
    try {
        var raw = localStorage.getItem("lw:savedRoute");
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) { return null; }
}

export function saveNamedRoute() {
    if (state.waypoints.length < 2) { showBanner("Add at least 2 waypoints first"); return; }

    var inputRow = document.getElementById("save-route-input");
    var nameInput = document.getElementById("save-route-name");
    var dist = document.getElementById("distance-display").textContent;

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
            .catch(function (e) { console.warn("Reverse-geocode for save-name failed:", e.message); });
    }
}

export async function confirmSaveRoute() {
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

        clearWaypoints();
        clearRouteOverlays();
        maybeResetGraphFor(route.center.lat, route.center.lon);

        state.mode = route.mode || "loop";
        setModeButton();
        updateReverseVisibility();

        state.map.setView([route.center.lat, route.center.lon], route.zoom || 14);
        state.startLat = route.center.lat;
        state.startLon = route.center.lon;

        await loadTilesOrPaths(route.center.lat, route.center.lon);

        for (var i = 0; i < route.waypoints.length; i++) {
            var wp = route.waypoints[i];
            var marker = createNumberedMarker(wp.lat, wp.lon, i + 1);
            wireMarkerEvents(marker);
            state.waypoints.push({ lat: wp.lat, lon: wp.lon, marker: marker, nodeKey: wp.nodeKey });
        }

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
    } catch (e) { console.warn("Delete saved route failed:", e.message); }
    renderSavedRoutes();
}

function ensureSavedRoutesDelegation(list) {
    if (list._delegated) return;
    list._delegated = true;
    list.addEventListener("click", function (e) {
        var del = e.target.closest && e.target.closest(".saved-item-delete");
        if (del) {
            e.stopPropagation();
            var dId = parseInt(del.dataset.id, 10);
            if (!isNaN(dId)) deleteSavedRoute(dId);
            return;
        }
        var item = e.target.closest && e.target.closest(".saved-item");
        if (item && item.dataset.id) {
            var rId = parseInt(item.dataset.id, 10);
            if (!isNaN(rId)) restoreSavedRoute(rId);
        }
    });
}

export async function renderSavedRoutes() {
    var list = document.getElementById("saved-routes-list");
    if (!list) return;
    var routes = await loadSavedRoutes();
    ensureSavedRoutesDelegation(list);
    while (list.firstChild) list.removeChild(list.firstChild);
    if (routes.length === 0) {
        list.classList.add("hidden");
        return;
    }
    list.classList.remove("hidden");
    var frag = document.createDocumentFragment();
    for (var i = 0; i < routes.length; i++) {
        var route = routes[i];
        var row = document.createElement("div");
        row.className = "saved-item";
        row.dataset.id = route.id;
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
        var del = document.createElement("button");
        del.className = "saved-item-delete";
        del.textContent = "\u00d7";
        del.title = "Delete saved route";
        del.dataset.id = route.id;
        row.appendChild(info);
        row.appendChild(del);
        frag.appendChild(row);
    }
    list.appendChild(frag);
}

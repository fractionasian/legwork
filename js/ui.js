import { state, MODE_LABELS, MILES_COUNTRIES } from './state.js';
import { showBanner, clearWaypoints, maybeResetGraphFor } from './helpers.js';
import { updateRoute, addWaypointAt, removeWaypoint, exportGPX, updateDistance, updateMarkerNumber } from './route.js';
import { loadTilesOrPaths } from './paths.js';
import { saveNamedRoute, confirmSaveRoute } from './saved.js';

// ── Autocomplete (Photon) ──────────────────────────────
var autocompleteTimer = null;

function setAutocompleteOpen(open) {
    var wrapper = document.querySelector(".menu-search");
    var list = document.getElementById("autocomplete-list");
    list.style.display = open ? "block" : "none";
    if (wrapper) wrapper.setAttribute("aria-expanded", open ? "true" : "false");
}

export function setupAutocomplete() {
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

var _autocompleteAbort = null;
async function fetchSuggestions(query) {
    var list = document.getElementById("autocomplete-list");
    if (_autocompleteAbort) _autocompleteAbort.abort();
    _autocompleteAbort = new AbortController();
    var signal = _autocompleteAbort.signal;
    try {
        var center = state.map ? state.map.getCenter() : { lat: -31.95, lng: 115.86 };
        var resp = await fetch(
            "https://photon.komoot.io/api/?q=" + encodeURIComponent(query) +
            "&limit=5&lat=" + center.lat + "&lon=" + center.lng,
            { signal: signal }
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
    } catch (e) {
        if (e.name === "AbortError") return;
        console.warn("Autocomplete failed:", e.message);
    }
}

// ── Geocode ──────────────────────────────────────────────
export async function geocodeAddress(opts) {
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

export function goToLocation(lat, lon) {
    clearWaypoints();
    maybeResetGraphFor(lat, lon);
    updateRoute();

    state.startLat = lat;
    state.startLon = lon;
    state.map.setView([lat, lon], 15);
    closeMenu();
    loadTilesOrPaths(lat, lon).then(function () {
        if (state.graph) addWaypointAt(lat, lon, { exactPosition: true });
    });
}

// ── Mode button ──────────────────────────────────────────
export function setModeButton() {
    document.getElementById("mode-btn").textContent = MODE_LABELS[state.mode] || MODE_LABELS.loop;
}

export function updateReverseVisibility() {
    var btn = document.getElementById("reverse-btn");
    btn.style.display = state.mode === "loop" ? "" : "none";
}

// ── GPS dot ──────────────────────────────────────────────
var gpsDotMarker = null;

export function showGpsDot(lat, lon) {
    if (gpsDotMarker) state.map.removeLayer(gpsDotMarker);
    var icon = L.divIcon({
        html: '<div class="gps-dot"></div>',
        className: "",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
    });
    gpsDotMarker = L.marker([lat, lon], { icon: icon, interactive: false, zIndexOffset: -200 }).addTo(state.map);
}

// ── Menu ─────────────────────────────────────────────────
export function openMenu() {
    document.getElementById("side-menu").classList.add("open");
    document.getElementById("menu-overlay").classList.remove("hidden");
    document.getElementById("menu-btn").setAttribute("aria-expanded", "true");
}
export function closeMenu() {
    document.getElementById("side-menu").classList.remove("open");
    document.getElementById("menu-overlay").classList.add("hidden");
    document.getElementById("menu-btn").setAttribute("aria-expanded", "false");
}

// ── Share hash ───────────────────────────────────────────
export function updateShareHash() {
    if (state.waypoints.length < 2) { history.replaceState(null, "", window.location.pathname); return; }
    var pts = state.waypoints.map(function (wp) { return wp.lat.toFixed(5) + "," + wp.lon.toFixed(5); });
    history.replaceState(null, "", "#r=" + pts.join(";") + "&m=" + state.mode);
}

export function loadFromHash() {
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

// ── Units ────────────────────────────────────────────────
export function autoDetectUnits(lat, lon) {
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

// ── Welcome modal ────────────────────────────────────────
export function showWelcome() {
    var modal = document.getElementById("welcome-modal");
    try {
        if (localStorage.getItem("lw:welcomed")) {
            modal.classList.add("hidden");
            return;
        }
    } catch (e) {}
    var isMacDesktop = /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;
    var undoKey = document.getElementById("undo-key");
    if (undoKey && isMacDesktop) undoKey.textContent = "\u2318";
    function onEsc(e) {
        if (e.key === "Escape" && !modal.classList.contains("hidden")) dismiss();
    }
    function dismiss() {
        modal.classList.add("hidden");
        document.removeEventListener("keydown", onEsc);
        try { localStorage.setItem("lw:welcomed", "1"); } catch (e) {}
    }
    document.getElementById("welcome-dismiss").addEventListener("click", dismiss);
    modal.addEventListener("click", function (e) {
        if (e.target === modal) dismiss();
    });
    document.addEventListener("keydown", onEsc);
}

// ── Install prompt ───────────────────────────────────────
var deferredInstallPrompt = null;

export function setupInstallPrompt() {
    var el = document.getElementById("install-prompt");
    if (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone) return;

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

    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|FxiOS/.test(navigator.userAgent);
    if (isIOS && isSafari) {
        el.innerHTML = 'Add to Home Screen: tap <strong>Share</strong> \u2192 <strong>Add to Home Screen</strong>';
        el.classList.remove("hidden");
    }
}

// ── Online/offline ───────────────────────────────────────
export function updateOnlineStatus() {
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

// ── Event bindings (called once from boot) ───────────────
export function bindEvents() {
    document.getElementById("address-input").addEventListener("keydown", function (e) { if (e.key === "Enter") geocodeAddress(); });

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
        clearWaypoints();
        updateRoute();
    });
    document.getElementById("export-btn").addEventListener("click", function () {
        closeMenu();
        exportGPX();
    });

    document.getElementById("locate-btn").addEventListener("click", function () {
        function startHere(lat, lon) {
            clearWaypoints();
            maybeResetGraphFor(lat, lon);
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

    // Distance action dropdown
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

    document.getElementById("menu-btn").addEventListener("click", openMenu);
    document.getElementById("menu-close").addEventListener("click", closeMenu);
    document.getElementById("menu-overlay").addEventListener("click", closeMenu);

    document.getElementById("unit-toggle").addEventListener("click", function () {
        state.useMiles = !state.useMiles;
        document.getElementById("unit-label").textContent = state.useMiles ? "mi" : "km";
        updateDistance();
    });

    document.getElementById("save-route-btn").addEventListener("click", saveNamedRoute);
    document.getElementById("save-route-confirm").addEventListener("click", confirmSaveRoute);
    document.getElementById("save-route-name").addEventListener("keydown", function (e) {
        if (e.key === "Enter") confirmSaveRoute();
        if (e.key === "Escape") document.getElementById("save-route-input").classList.add("hidden");
    });

    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    window.addEventListener("resize", function () {
        if (state.map) state.map.invalidateSize();
    });
}

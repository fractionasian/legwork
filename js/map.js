import { state } from './state.js';
import { onMapClick } from './route.js';
import { loadTilesInViewport } from './paths.js';

export function initMap() {
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

    var _viewportTimer = null;
    state.map.on("moveend", function () {
        clearTimeout(_viewportTimer);
        _viewportTimer = setTimeout(loadTilesInViewport, 500);
    });
}

export function buildMenuLegend() {
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

#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TILE_SIZE = 0.05;
const HIGHWAYS = [
    "footway","cycleway","path","residential","living_street","pedestrian",
    "service","unclassified","tertiary","tertiary_link","secondary","secondary_link",
    "primary","primary_link","trunk","trunk_link","crossing","steps",
    "track","bridleway","byway"
];

const USER_AGENT = "legwork-tile-builder/1.0 (+https://github.com/fractionasian/legwork)";

const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, opts, retries = 3) {
    // User-Agent alone resolves the 406 from Overpass; avoid Accept so strict
    // mirrors don't reject on content-negotiation.
    const mergedOpts = {
        ...opts,
        headers: {
            "User-Agent": USER_AGENT,
            ...(opts && opts.headers ? opts.headers : {}),
        },
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await fetch(url, mergedOpts);
            if (resp.status === 429 || resp.status === 406 || resp.status >= 500) {
                if (attempt < retries) {
                    const delay = 10000 * Math.pow(2, attempt); // 10s, 20s, 40s
                    console.log(`  HTTP ${resp.status}, retrying in ${delay/1000}s...`);
                    await sleep(delay);
                    continue;
                }
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
            return resp.json();
        } catch (e) {
            // Retry any network-layer error. HTTP-level errors were handled above.
            if (attempt < retries) {
                const delay = 10000 * Math.pow(2, attempt);
                console.log(`  ${e.message}, retrying in ${delay/1000}s...`);
                await sleep(delay);
                continue;
            }
            throw e;
        }
    }
    throw new Error(`fetchJSON: retry loop exhausted for ${url}`);
}

// Extract routing-relevant flags from an OSM node's tags. Kept in sync with
// the client-side nodeAttrsFromTags() in routing.js so keys stay stable.
function nodeAttrsFromTags(tags) {
    const attrs = {};
    let any = false;
    if (tags.barrier === "gate" || tags.barrier === "stile" ||
        tags.barrier === "kissing_gate" || tags.barrier === "turnstile") {
        attrs.barrier = true; any = true;
    }
    if (tags.highway === "traffic_signals") { attrs.trafficSignal = true; any = true; }
    if (tags.highway === "crossing" || tags.footway === "crossing") {
        const c = tags.crossing || "";
        if (c === "traffic_signals" || c === "marked" || c === "zebra" || c === "uncontrolled") {
            attrs.crossingMarked = true; any = true;
        } else {
            attrs.crossingUnmarked = true; any = true;
        }
    }
    return any ? attrs : null;
}

// Produce the same nodeKey() string that routing.js will compute for a way
// coord rounded to 5dp. Way coords in tiles are truncated to 5dp for bytes,
// so we must key node attrs the same way.
function nodeKey5dp(lat, lon) {
    return parseFloat(lat.toFixed(5)).toFixed(6) + "," + parseFloat(lon.toFixed(5)).toFixed(6);
}

function osmToGeoJSON(data) {
    const nodes = {};
    const nodeAttrs = {};
    const features = [];
    for (const el of data.elements || []) {
        if (el.type === "node") {
            nodes[el.id] = [el.lon, el.lat];
            if (el.tags) {
                const a = nodeAttrsFromTags(el.tags);
                if (a) nodeAttrs[nodeKey5dp(el.lat, el.lon)] = a;
            }
        }
    }
    for (const el of data.elements || []) {
        if (el.type !== "way") continue;
        const coords = (el.nodes || []).map(n => nodes[n]).filter(Boolean);
        if (coords.length < 2) continue;
        const tags = el.tags || {};
        features.push({
            type: "Feature",
            properties: { id: el.id, highway: tags.highway || "", surface: tags.surface || "", name: tags.name || "" },
            geometry: { type: "LineString", coordinates: coords },
        });
    }
    return { featureCollection: { type: "FeatureCollection", features }, nodeAttrs };
}

function featureCentroid(feature) {
    const coords = feature.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    return { lat: mid[1], lon: mid[0] };
}

async function queryOverpass(bounds) {
    const [south, west, north, east] = bounds;
    const regex = `^(${HIGHWAYS.join("|")})$`;
    // `out body qt` on the node recurse (vs `out skel qt`) brings back node
    // tags, which we mine for barriers, crossings, and traffic signals.
    const query = `[out:json][timeout:120];\n(way["highway"~"${regex}"](${south},${west},${north},${east}););\nout body;\n>;\nout body qt;`;

    console.log(`  Querying Overpass (${(north-south).toFixed(2)}° x ${(east-west).toFixed(2)}°)...`);

    let lastError;
    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            const data = await fetchJSON(endpoint, {
                method: "POST",
                body: "data=" + encodeURIComponent(query),
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
            console.log(`  Got ${(data.elements || []).length} elements from ${endpoint}`);
            return osmToGeoJSON(data);
        } catch (e) {
            lastError = e;
            console.log(`  Endpoint ${endpoint} failed: ${e.message}`);
        }
    }
    throw lastError;
}

function splitIntoTiles(geojson, bounds) {
    const [south, west, north, east] = bounds;
    const rows = Math.ceil((north - south) / TILE_SIZE);
    const cols = Math.ceil((east - west) / TILE_SIZE);
    const tiles = {};

    for (const feature of geojson.features) {
        const c = featureCentroid(feature);
        const row = Math.min(Math.floor((c.lat - south) / TILE_SIZE), rows - 1);
        const col = Math.min(Math.floor((c.lon - west) / TILE_SIZE), cols - 1);
        const key = `${row}_${col}`;
        if (!tiles[key]) {
            tiles[key] = {
                row, col,
                bounds: [
                    south + row * TILE_SIZE,
                    west + col * TILE_SIZE,
                    Math.min(south + (row + 1) * TILE_SIZE, north),
                    Math.min(west + (col + 1) * TILE_SIZE, east),
                ],
                features: [],
            };
        }
        tiles[key].features.push(feature);
    }

    return { rows, cols, tiles };
}

async function reverseGeocode(lat, lon) {
    try {
        const data = await fetchJSON(
            `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=3`
        );
        const suburbs = [];
        for (const feat of data.features || []) {
            const p = feat.properties;
            const name = p.name || p.district || p.city;
            if (name && !suburbs.includes(name)) suburbs.push(name);
        }
        return suburbs.length > 0 ? suburbs : ["Unknown"];
    } catch (e) {
        return ["Unknown"];
    }
}

function boundsKey(bounds) {
    return bounds.map(n => n.toFixed(6)).join(",");
}

function buildSuburbCache(previousCity) {
    const cache = new Map();
    if (!previousCity || !Array.isArray(previousCity.tiles)) return cache;
    for (const t of previousCity.tiles) {
        if (t && t.bounds && Array.isArray(t.suburbs) && t.suburbs.length && t.suburbs[0] !== "Unknown") {
            cache.set(boundsKey(t.bounds), t.suburbs);
        }
    }
    return cache;
}

async function buildCity(city, dataDir, options) {
    const { skipGeocode, suburbCache } = options;
    console.log(`\nBuilding ${city.name}...`);

    const { featureCollection, nodeAttrs } = await queryOverpass(city.bounds);
    console.log(`  ${featureCollection.features.length} features, ${Object.keys(nodeAttrs).length} tagged nodes`);

    const { rows, cols, tiles } = splitIntoTiles(featureCollection, city.bounds);
    console.log(`  Grid: ${rows}x${cols} = ${Object.keys(tiles).length} non-empty tiles`);

    const tileDir = path.join(dataDir, "tiles", city.id);
    // Clear old tiles so a shrunk bounds doesn't leave orphaned .json files.
    if (fs.existsSync(tileDir)) fs.rmSync(tileDir, { recursive: true, force: true });
    fs.mkdirSync(tileDir, { recursive: true });

    const tileMeta = [];
    let geocodeGate = Promise.resolve();
    for (const [key, tile] of Object.entries(tiles)) {
        // v2 compact format per feature: [id, highway, name, coords, surface?]
        // (surface omitted when empty to save bytes)
        const features = tile.features.map(f => {
            const base = [
                f.properties.id,
                f.properties.highway,
                f.properties.name || "",
                f.geometry.coordinates.map(c => [
                    parseFloat(c[0].toFixed(5)),
                    parseFloat(c[1].toFixed(5))
                ]),
            ];
            const surface = f.properties.surface || "";
            if (surface) base.push(surface);
            return base;
        });

        // Per-tile nodeAttrs: filter to nodes whose coords fall within this
        // tile's bounds. Keys are already nodeKey5dp strings from osmToGeoJSON.
        const tileNodeAttrs = {};
        const [tSouth, tWest, tNorth, tEast] = tile.bounds;
        for (const [nk, attrs] of Object.entries(nodeAttrs)) {
            const comma = nk.indexOf(",");
            const lat = parseFloat(nk.substring(0, comma));
            const lon = parseFloat(nk.substring(comma + 1));
            if (lat >= tSouth && lat <= tNorth && lon >= tWest && lon <= tEast) {
                tileNodeAttrs[nk] = attrs;
            }
        }

        const payload = { v: 2, features };
        if (Object.keys(tileNodeAttrs).length > 0) payload.nodeAttrs = tileNodeAttrs;

        const filePath = path.join(tileDir, `${key}.json`);
        fs.writeFileSync(filePath, JSON.stringify(payload));

        const cached = suburbCache.get(boundsKey(tile.bounds));
        let suburbs;
        if (cached) {
            suburbs = cached;
            console.log(`  Tile ${key}: ${tile.features.length} ways — ${suburbs.join(", ")} (cached)`);
        } else if (skipGeocode) {
            suburbs = ["Unknown"];
            console.log(`  Tile ${key}: ${tile.features.length} ways — skipped geocode`);
        } else {
            // Rate-limit Photon to ~1 req/s by serializing starts 1.1s apart,
            // but let each fetch overlap the next tile's wait.
            await geocodeGate;
            const centerLat = (tile.bounds[0] + tile.bounds[2]) / 2;
            const centerLon = (tile.bounds[1] + tile.bounds[3]) / 2;
            const fetchP = reverseGeocode(centerLat, centerLon);
            geocodeGate = sleep(1100);
            suburbs = await fetchP;
            console.log(`  Tile ${key}: ${tile.features.length} ways — ${suburbs.join(", ")}`);
        }

        tileMeta.push({
            file: `${key}.json`,
            bounds: tile.bounds,
            suburbs,
            ways: tile.features.length,
        });
    }

    return { rows, cols, tiles: tileMeta };
}

function parseArgs(argv) {
    const args = { cities: null, skipGeocode: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--city" || a === "--cities") {
            const val = argv[++i];
            if (!val) { console.error(`${a} requires a value`); process.exit(1); }
            args.cities = val.split(",").map(s => s.trim()).filter(Boolean);
        } else if (a.startsWith("--city=") || a.startsWith("--cities=")) {
            args.cities = a.slice(a.indexOf("=") + 1).split(",").map(s => s.trim()).filter(Boolean);
        } else if (a === "--skip-geocode") {
            args.skipGeocode = true;
        } else if (a === "--help" || a === "-h") {
            console.log("Usage: build-tiles.js [--city|--cities <id>[,<id>...]] [--skip-geocode]");
            console.log("       build-tiles.js [--city=<id>[,<id>...]] [--skip-geocode]");
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${a}`);
            process.exit(1);
        }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const dataDir = path.join(__dirname, "..", "data");
    const citiesPath = path.join(dataDir, "cities.json");
    const manifestPath = path.join(dataDir, "manifest.json");

    if (!fs.existsSync(citiesPath)) {
        console.error("Missing data/cities.json");
        process.exit(1);
    }

    const allCities = JSON.parse(fs.readFileSync(citiesPath, "utf-8"));
    let cities = allCities;
    if (args.cities) {
        const ids = new Set(args.cities);
        cities = allCities.filter(c => ids.has(c.id));
        const missing = args.cities.filter(id => !allCities.some(c => c.id === id));
        if (missing.length) {
            console.error(`Unknown city id(s): ${missing.join(", ")}`);
            process.exit(1);
        }
        console.log(`Building subset: ${cities.map(c => c.id).join(", ")}`);
    }

    let previousManifest = null;
    if (fs.existsSync(manifestPath)) {
        try { previousManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")); } catch {}
    }

    const manifest = { built: new Date().toISOString(), version: "", cities: {} };
    if (args.cities && previousManifest && previousManifest.cities) {
        for (const [id, entry] of Object.entries(previousManifest.cities)) {
            if (!args.cities.includes(id)) manifest.cities[id] = entry;
        }
    }

    for (let i = 0; i < cities.length; i++) {
        const city = cities[i];
        const prevCity = previousManifest && previousManifest.cities && previousManifest.cities[city.id];
        const prevBoundsMatch = prevCity && JSON.stringify(prevCity.bounds) === JSON.stringify(city.bounds);
        const suburbCache = prevBoundsMatch ? buildSuburbCache(prevCity) : new Map();
        if (suburbCache.size) console.log(`  Suburb cache: ${suburbCache.size} tiles`);

        const result = await buildCity(city, dataDir, {
            skipGeocode: args.skipGeocode,
            suburbCache,
        });
        manifest.cities[city.id] = {
            name: city.name,
            bounds: city.bounds,
            tileSize: TILE_SIZE,
            grid: [result.rows, result.cols],
            tiles: result.tiles,
        };
        if (i < cities.length - 1) {
            // Spacing Overpass queries — individual endpoints rate-limit per-IP.
            console.log("\n  Waiting 30s before next Overpass query...");
            await sleep(30000);
        }
    }

    // Sort city keys alphabetically before hashing so partial rebuilds produce
    // a stable version hash when content hasn't changed.
    const orderedCities = {};
    for (const id of Object.keys(manifest.cities).sort()) orderedCities[id] = manifest.cities[id];
    manifest.cities = orderedCities;
    manifest.version = crypto.createHash("md5").update(JSON.stringify(orderedCities)).digest("hex").substring(0, 8);

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\nManifest written: ${manifestPath}`);
    console.log(`Version: ${manifest.version}`);
    console.log("Done.");
}

main().catch(e => { console.error(e); process.exit(1); });

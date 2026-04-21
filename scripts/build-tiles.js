#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TILE_SIZE = 0.05;
const HIGHWAYS = [
    "footway","cycleway","path","residential","living_street","pedestrian",
    "service","unclassified","tertiary","tertiary_link","secondary","secondary_link",
    "primary","primary_link","trunk","trunk_link","crossing","steps"
];

const USER_AGENT = "legwork-tile-builder/1.0 (+https://github.com/fractionasian/legwork)";

const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, opts, retries = 3) {
    const mergedOpts = {
        ...opts,
        headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
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
            if (attempt < retries && (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.message.includes('fetch failed'))) {
                const delay = 10000 * Math.pow(2, attempt);
                console.log(`  ${e.message}, retrying in ${delay/1000}s...`);
                await sleep(delay);
                continue;
            }
            throw e;
        }
    }
}

function osmToGeoJSON(data) {
    const nodes = {};
    const features = [];
    for (const el of data.elements || []) {
        if (el.type === "node") nodes[el.id] = [el.lon, el.lat];
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
    return { type: "FeatureCollection", features };
}

function featureCentroid(feature) {
    const coords = feature.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    return { lat: mid[1], lon: mid[0] };
}

async function queryOverpass(bounds) {
    const [south, west, north, east] = bounds;
    const regex = `^(${HIGHWAYS.join("|")})$`;
    const query = `[out:json][timeout:120];\n(way["highway"~"${regex}"](${south},${west},${north},${east}););\nout body;\n>;\nout skel qt;`;

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

async function buildCity(city, dataDir) {
    console.log(`\nBuilding ${city.name}...`);

    const geojson = await queryOverpass(city.bounds);
    console.log(`  ${geojson.features.length} features`);

    const { rows, cols, tiles } = splitIntoTiles(geojson, city.bounds);
    console.log(`  Grid: ${rows}x${cols} = ${Object.keys(tiles).length} non-empty tiles`);

    const tileDir = path.join(dataDir, "tiles", city.id);
    fs.mkdirSync(tileDir, { recursive: true });

    const tileMeta = [];
    for (const [key, tile] of Object.entries(tiles)) {
        // Compact format: [id, highway, name, [[lon5dp,lat5dp],...]] per feature
        const compact = tile.features.map(f => [
            f.properties.id,
            f.properties.highway,
            f.properties.name || "",
            f.geometry.coordinates.map(c => [
                parseFloat(c[0].toFixed(5)),
                parseFloat(c[1].toFixed(5))
            ])
        ]);
        const filePath = path.join(tileDir, `${key}.json`);
        fs.writeFileSync(filePath, JSON.stringify(compact));

        const centerLat = (tile.bounds[0] + tile.bounds[2]) / 2;
        const centerLon = (tile.bounds[1] + tile.bounds[3]) / 2;
        const suburbs = await reverseGeocode(centerLat, centerLon);
        await sleep(1100);

        tileMeta.push({
            file: `${key}.json`,
            bounds: tile.bounds,
            suburbs,
            ways: tile.features.length,
        });

        console.log(`  Tile ${key}: ${tile.features.length} ways — ${suburbs.join(", ")}`);
    }

    return { rows, cols, tiles: tileMeta };
}

async function main() {
    const dataDir = path.join(__dirname, "..", "data");
    const citiesPath = path.join(dataDir, "cities.json");

    if (!fs.existsSync(citiesPath)) {
        console.error("Missing data/cities.json");
        process.exit(1);
    }

    const cities = JSON.parse(fs.readFileSync(citiesPath, "utf-8"));
    const manifest = { built: new Date().toISOString(), version: "", cities: {} };

    for (const city of cities) {
        const result = await buildCity(city, dataDir);
        manifest.cities[city.id] = {
            name: city.name,
            bounds: city.bounds,
            tileSize: TILE_SIZE,
            grid: [result.rows, result.cols],
            tiles: result.tiles,
        };
        if (cities.indexOf(city) < cities.length - 1) {
            console.log("\n  Waiting 30s before next city...");
            await sleep(30000);
        }
    }

    const content = JSON.stringify(manifest.cities);
    manifest.version = crypto.createHash("md5").update(content).digest("hex").substring(0, 8);

    const manifestPath = path.join(dataDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\nManifest written: ${manifestPath}`);
    console.log(`Version: ${manifest.version}`);
    console.log("Done.");
}

main().catch(e => { console.error(e); process.exit(1); });

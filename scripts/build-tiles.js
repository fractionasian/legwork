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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, opts, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await fetch(url, opts);
            if (resp.status === 429 || resp.status >= 500) {
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
    const data = await fetchJSON("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    console.log(`  Got ${(data.elements || []).length} elements`);
    return osmToGeoJSON(data);
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

// Parse simple --flag value args. Supports --city <id> for incremental builds
// and --cities a,b,c for a subset.
function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--city" || a === "--cities") args.cities = (argv[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
        else if (a === "--help" || a === "-h") args.help = true;
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        console.log("Usage: build-tiles.js [--city <id> | --cities <id1,id2>]");
        console.log("  Without --city, all cities are rebuilt.");
        console.log("  With --city, only the specified city is built and merged into the existing manifest.");
        return;
    }

    const dataDir = path.join(__dirname, "..", "data");
    const citiesPath = path.join(dataDir, "cities.json");
    const manifestPath = path.join(dataDir, "manifest.json");

    if (!fs.existsSync(citiesPath)) {
        console.error("Missing data/cities.json");
        process.exit(1);
    }

    const allCities = JSON.parse(fs.readFileSync(citiesPath, "utf-8"));
    const targetCities = args.cities && args.cities.length
        ? allCities.filter(c => args.cities.includes(c.id))
        : allCities;

    if (targetCities.length === 0) {
        console.error(`No matching cities for: ${args.cities.join(", ")}`);
        console.error(`Available: ${allCities.map(c => c.id).join(", ")}`);
        process.exit(1);
    }

    // Start from the existing manifest if we're doing an incremental build,
    // otherwise rebuild from scratch.
    const incremental = !!(args.cities && args.cities.length);
    const manifest = incremental && fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
        : { built: new Date().toISOString(), version: "", cities: {} };
    manifest.built = new Date().toISOString();

    console.log(`Building ${targetCities.length} ${incremental ? "(incremental) " : ""}cit${targetCities.length === 1 ? "y" : "ies"}: ${targetCities.map(c => c.id).join(", ")}`);

    for (const city of targetCities) {
        const result = await buildCity(city, dataDir);
        manifest.cities[city.id] = {
            name: city.name,
            bounds: city.bounds,
            tileSize: TILE_SIZE,
            grid: [result.rows, result.cols],
            tiles: result.tiles,
        };
        if (targetCities.indexOf(city) < targetCities.length - 1) {
            console.log("\n  Waiting 30s before next city...");
            await sleep(30000);
        }
    }

    // Hash all city metadata so the version stays deterministic across
    // incremental and full builds.
    const content = JSON.stringify(manifest.cities);
    manifest.version = crypto.createHash("md5").update(content).digest("hex").substring(0, 8);

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\nManifest written: ${manifestPath}`);
    console.log(`Version: ${manifest.version}`);
    console.log("Done.");
}

main().catch(e => { console.error(e); process.exit(1); });

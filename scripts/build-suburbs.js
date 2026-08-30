#!/usr/bin/env node
//
// Build per-city suburb polygons for true suburb-level attribution.
//
//   node scripts/build-suburbs.js --city perth
//
// Writes data/suburbs/<city>.json — a compact [{n, p}] list where `n` is the
// suburb name and `p` is an array of closed rings of [lat, lon] pairs. The
// client point-in-polygons a route's start point against it.
//
// ## Why polygons and not a geocode
//
// The tile manifest labels a whole 0.05-degree tile (~5.5 x 4.7 km) with the
// suburb at its centre, which spans a dozen real suburbs — Crawley and Nedlands
// collapse into whichever the centre lands in. That is tile granularity wearing
// a suburb's name. Polygons give the actual answer, offline, with no coordinate
// ever leaving the device: the client resolves a NAME and sends only the name.
//
// ## admin_level is per-country and there is no universal "suburb"
//
// Measured against OSM 2026-08-31:
//
//   AU  9   Dalkeith, Willetton, Rivervale        <- what a local calls a suburb
//   SG  6   Novena, Orchard, Toa Payoh            (planning areas)
//   JP  7   Shibuya, Shinjuku, Minato             (wards; 9 = districts, 10 = blocks)
//   GB  8   London Borough of Hackney, Camden     (no clean neighbourhood layer)
//
// Perth's 9 in London yields "Inner and Middle Temples"; in Tokyo it yields
// Roppongi and 10 yields block-level "Shibuya 1". So the level is a per-city
// judgement about what you want to READ, not a constant. It lives in
// ADMIN_LEVEL below, and a city absent from it is refused rather than guessed —
// a wrong level produces plausible names at the wrong scale, which is the
// failure that would survive review.
const fs = require("fs");
const path = require("path");

// `level` is the OSM admin_level that means "suburb" in that country; `iso` is
// the ISO3166-1 code the query is confined to.
//
// The `iso` constraint is not optional bookkeeping. A city bbox does not stop at
// a border: Singapore's reaches into Johor, and a bbox-only query returned the
// Malaysian DISTRICTS "Johor Bahru" and "Kota Tinggi" alongside the 55 planning
// areas — same admin_level, completely different geographic scale, and no
// failure signal. That is the LGA-scale trap (a "City of Rockingham" swallowing
// a dozen suburbs), arriving from the other side of a border.
const ADMIN_LEVEL = {
    // AU 9 — Dalkeith, Willetton, Rivervale.
    perth: { level: 9, iso: "AU" },
    // SG 6 — planning areas: Novena, Orchard, Toa Payoh, Bukit Merah. These are
    // the names locals use and what Photon returns as `district`. Level 7 is
    // finer (subzones: Sungei Road, Little India), below what anyone would call
    // the area they ran in.
    singapore: { level: 6, iso: "SG" },
    // Singapore's bbox crosses the Johor Strait, so some tiles are in Malaysia
    // and label "Unknown". DELIBERATE — probed 2026-08-31 and rejected, not
    // pending:
    //
    //   MY al=6  Johor Bahru        <- district. The LGA trap: one name over a
    //                                 whole region, exactly what admin_level=9
    //                                 exists to avoid on the Australian side.
    //   MY al=7  Iskandar Puteri    <- municipality, and the FINEST level that
    //                                 exists there. One entity across the whole
    //                                 western strip. Nothing at al=8.
    //
    // So the only labels on offer are coarser than a suburb, for what is bbox
    // OVERSPILL rather than anywhere anyone routes: the Malaysian tiles are the
    // top row at lat 1.46-1.47 — a ~1.1 km sliver along the bbox edge — plus the
    // 4_0 corner. Every recorded demand cell sits at lat 1.28-1.32, well inside
    // Singapore. "Unknown" is the honest answer for a sliver we cover only
    // because a bounding box is a rectangle and a border is not.
    //
    // Revisit only if usage actually appears in Johor, and then by adding a
    // proper Johor Bahru city entry rather than by relabelling the sliver.
    // Add a city only after eyeballing its names at the chosen level.
    // melbourne/adelaide/brisbane/sydney/canberra/darwin/hobart: { level: 9, iso: "AU" },
    // tokyo: { level: 7, iso: "JP" }, london: { level: 8, iso: "GB" },
};

// ~11 m at Perth's latitude. Suburb boundaries do not need better, and 5 dp
// costs 45% more gzipped for precision nothing consumes.
const COORD_DP = 4;

// Same UA and endpoint list as build-tiles.js. The UA is not cosmetic: without
// it overpass-api.de answers 406 and kumi 429 ("legacy-ua-limit"), because
// Node's default fetch UA is blocklisted. build-tiles.js:29 records this — it
// cost a build there first.
const USER_AGENT = "legwork-tile-builder/1.0 (+https://github.com/fractionasian/legwork)";

const ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];

function parseArgs(argv) {
    const args = { cities: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--city" || a === "--cities") {
            const v = argv[++i];
            if (!v) { console.error(`${a} requires a value`); process.exit(1); }
            args.cities = v.split(",").map(s => s.trim()).filter(Boolean);
        } else if (a.startsWith("--city=") || a.startsWith("--cities=")) {
            args.cities = a.slice(a.indexOf("=") + 1).split(",").map(s => s.trim()).filter(Boolean);
        } else if (a === "--help" || a === "-h") {
            console.log("Usage: build-suburbs.js --city <id>[,<id>...]");
            console.log(`Known: ${Object.keys(ADMIN_LEVEL).join(", ")}`);
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${a}`); process.exit(1);
        }
    }
    return args;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Overpass rate-limits per IP (2 slots) and answers a throttled request with a
// 200 carrying an HTML error body, not a 4xx. Parsing that as JSON throws, and
// a looser reader would have taken it as "this city has no suburbs" — so the
// content-type check is load-bearing, not defensive noise.
async function overpass(query) {
    let lastErr;
    for (const url of ENDPOINTS) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const resp = await fetch(url, {
                    method: "POST",
                    body: query,
                    headers: {
                        "User-Agent": USER_AGENT,
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                });
                const text = await resp.text();
                if (!text.trim().startsWith("{")) {
                    throw new Error(`non-JSON body (${resp.status}): ${text.slice(0, 160).replace(/\s+/g, " ")}`);
                }
                return JSON.parse(text);
            } catch (e) {
                lastErr = e;
                console.log(`  ${url.split("/")[2]} attempt ${attempt} failed: ${e.message}`);
                await sleep(attempt * 15000);
            }
        }
    }
    throw lastErr;
}

// Chain member ways into closed rings, matching endpoints in EITHER direction:
// Overpass returns a relation's members unordered and arbitrarily reversed. A
// naive head-to-tail stitch silently emits open rings, and an open ring fails
// point-in-polygon for most of its own area — which reads as "this point is in
// no suburb" rather than as a bug. Every ring is asserted closed below.
function assembleRings(el, role) {
    const wanted = role === "inner"
        ? (m) => m.role === "inner"
        : (m) => m.role === "outer" || m.role === "";
    const segs = (el.members || [])
        .filter(m => wanted(m) && m.geometry)
        .map(m => m.geometry.map(p => [p.lat, p.lon]));
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    const rings = [];
    const pool = segs.slice();
    while (pool.length) {
        let cur = pool.shift();
        let changed = true;
        while (changed && !same(cur[0], cur[cur.length - 1])) {
            changed = false;
            for (let i = 0; i < pool.length; i++) {
                const s = pool[i];
                if      (same(s[0], cur[cur.length - 1])) { cur = cur.concat(s.slice(1)); }
                else if (same(s[s.length - 1], cur[cur.length - 1])) { cur = cur.concat(s.slice().reverse().slice(1)); }
                else if (same(s[s.length - 1], cur[0])) { cur = s.slice(0, -1).concat(cur); }
                else if (same(s[0], cur[0])) { cur = s.slice().reverse().slice(0, -1).concat(cur); }
                else continue;
                pool.splice(i, 1); changed = true; break;
            }
        }
        if (cur.length >= 4) rings.push(cur);
    }
    return rings;
}

function round(rings) {
    const out = [];
    for (const r of rings) {
        const pts = []; let last = null;
        for (const [la, lo] of r) {
            const c = [Number(la.toFixed(COORD_DP)), Number(lo.toFixed(COORD_DP))];
            if (!last || c[0] !== last[0] || c[1] !== last[1]) { pts.push(c); last = c; }
        }
        if (pts.length >= 4) out.push(pts);
    }
    return out;
}

function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const lai = ring[i][0], loi = ring[i][1];
        const laj = ring[j][0], loj = ring[j][1];
        if ((lai > lat) !== (laj > lat)) {
            if (lon < (loj - loi) * (lat - lai) / (laj - lai) + loi) inside = !inside;
        }
    }
    return inside;
}

// Inside an outer ring AND outside every hole. This is the definition both
// consumers must share; a divergence here is the bug the assertion below exists
// to catch at build time rather than in the field.
function containsPoint(f, lat, lon) {
    if (!f.p.some(r => pointInRing(lat, lon, r))) return false;
    if (f.h && f.h.some(r => pointInRing(lat, lon, r))) return false;
    return true;
}

// 400x400 over a city bbox is ~150 m spacing at Perth's latitude — fine enough
// to land inside a small enclave (the Kings Park hole is ~248 x 267 m).
const OVERLAP_SAMPLES = 400;

function findOverlaps(feats, bounds) {
    const [s, w, n, e] = bounds;
    for (const f of feats) {
        let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
        for (const ring of f.p) for (const pt of ring) {
            if (pt[0] < a) a = pt[0];
            if (pt[0] > b) b = pt[0];
            if (pt[1] < c) c = pt[1];
            if (pt[1] > d) d = pt[1];
        }
        f._bbox = [a, c, b, d];
    }
    const hits = [];
    for (let i = 0; i < OVERLAP_SAMPLES && hits.length < 20; i++) {
        const lat = s + (n - s) * (i + 0.5) / OVERLAP_SAMPLES;
        for (let j = 0; j < OVERLAP_SAMPLES; j++) {
            const lon = w + (e - w) * (j + 0.5) / OVERLAP_SAMPLES;
            const names = [];
            for (const f of feats) {
                const bb = f._bbox;
                if (lat < bb[0] || lat > bb[2] || lon < bb[1] || lon > bb[3]) continue;
                if (containsPoint(f, lat, lon)) names.push(f.n);
                if (names.length > 1) break;
            }
            if (names.length > 1) hits.push({ lat, lon, names });
        }
    }
    for (const f of feats) delete f._bbox;
    return hits;
}

async function buildCity(city, outDir) {
    const cfg = ADMIN_LEVEL[city.id];
    if (!cfg) {
        console.error(`\n${city.name}: no admin_level configured — refusing to guess.`);
        console.error(`  Probe it first, then add to ADMIN_LEVEL. A wrong level yields`);
        console.error(`  plausible names at the wrong scale (LGAs, or city blocks).`);
        return null;
    }
    const { level, iso } = cfg;
    console.log(`\n${city.name} (admin_level=${level}, ${iso})...`);
    const [s, w, n, e] = city.bounds;
    const data = await overpass(
        `[out:json][timeout:180];\n` +
        `area["ISO3166-1"="${iso}"]["admin_level"="2"]->.country;\n` +
        `relation["boundary"="administrative"]["admin_level"="${level}"](area.country)(${s},${w},${n},${e});\n` +
        `out geom;`
    );

    const feats = [];
    let openRings = 0;
    for (const el of data.elements || []) {
        const name = (el.tags || {}).name;
        if (!name) continue;
        const rings = assembleRings(el, "outer");
        const holes = assembleRings(el, "inner");
        for (const r of rings.concat(holes)) {
            const closed = r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
            if (!closed) openRings++;
        }
        const p = round(rings);
        const h = round(holes);
        // Holes are enclaves: Kings Park has West Perth carved out of it. Drop
        // them and the enclosing suburb claims the enclave, so a point there
        // matches TWO suburbs and the answer depends on array order — which
        // nothing in the consumers enforces, since both take the first match.
        if (p.length) feats.push(h.length ? { n: name, p, h } : { n: name, p });
    }

    // Fail loudly rather than shipping a file that silently answers "nowhere".
    if (!feats.length) throw new Error(`${city.name}: no suburbs found at admin_level=${level}`);
    if (openRings) throw new Error(`${city.name}: ${openRings} unclosed ring(s) — ring assembly is wrong`);

    // A point may belong to exactly ONE suburb. Both consumers (suburbs.js in
    // the client, suburbsForTile here) take the FIRST match and stop, so any
    // overlap makes the answer depend on OSM's relation ordering — silently,
    // and differently between the two. Perth satisfies this only because its
    // one enclave (West Perth inside Kings Park) is now subtracted as a hole.
    // A new city with genuine overlaps must fail here, not ship.
    const overlaps = findOverlaps(feats, city.bounds);
    if (overlaps.length) {
        console.error(`\n${city.name}: ${overlaps.length} sample point(s) match more than one suburb.`);
        for (const o of overlaps.slice(0, 5)) {
            console.error(`  ${o.lat.toFixed(5)}, ${o.lon.toFixed(5)} -> ${o.names.join(" + ")}`);
        }
        throw new Error(`${city.name}: overlapping suburb polygons — first-match resolution would be order-dependent`);
    }
    console.log(`  overlap check: clean (${OVERLAP_SAMPLES}x${OVERLAP_SAMPLES} grid)`);

    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${city.id}.json`);
    fs.writeFileSync(file, JSON.stringify(feats));
    const verts = feats.reduce((a, f) => a + f.p.reduce((b, r) => b + r.length, 0), 0);
    const kb = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`  ${feats.length} suburbs, ${verts} vertices, ${kb} KB -> ${file}`);
    console.log(`  sample: ${feats.slice(0, 6).map(f => f.n).join(", ")}`);
    return feats.length;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const dataDir = path.join(__dirname, "..", "data");
    const all = JSON.parse(fs.readFileSync(path.join(dataDir, "cities.json"), "utf-8"));
    const cities = args.cities ? all.filter(c => args.cities.includes(c.id)) : all;
    if (!cities.length) { console.error("No matching cities."); process.exit(1); }

    for (const city of cities) {
        await buildCity(city, path.join(dataDir, "suburbs"));
        await sleep(2000);   // stay well inside Overpass's 2-slot budget
    }
}

// Guarded so the geometry helpers can be imported and tested without the script
// running an Overpass build on require.
module.exports = { containsPoint, pointInRing, findOverlaps, assembleRings };

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}

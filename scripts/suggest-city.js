// Suggest the next city to pre-bake, from where people actually pin outside the
// seeded cities. Run weekly by .github/workflows/suggest-city.yml, which opens a
// PR for a human to merge — this script never decides on its own.
//
// Signal: `city-unknown` events (a 0.5° bucket, sent when someone lands outside
// every city in data/cities.json). The densest `demand` cell inside that bucket
// says where in the bucket they were routing, so the box is centred on people,
// not on the bucket.
//
// Needs CLOUDFLARE_API_TOKEN (D1 read only) and CLOUDFLARE_ACCOUNT_ID.
const fs = require("fs");
const path = require("path");

const D1_DATABASE_ID = "38de93c4-53dc-408c-afb0-9c647979f354";   // worker/wrangler.toml
// ponytail: fixed thresholds, tune from real numbers once a few weeks of
// city-unknown data exist. Per-user dedupe is impossible (no ids are stored), so
// MIN_EVENTS is a guard against one person's session, not a popularity vote.
const MIN_EVENTS = 20;
const WINDOW_DAYS = 56;
const BOX = 0.3;                       // degrees each way across; edit in the PR if the city is bigger

// ── pure helpers (unit-tested) ──────────────────────────────────────────────
// Same bucketing as tiles.js: Math.round(x * 2) / 2, so a bucket spans ±0.25°.
function bucketBox(bucket) {
    const [lat, lon] = bucket.split(",").map(Number);
    return { south: lat - 0.25, north: lat + 0.25, west: lon - 0.25, east: lon + 0.25 };
}

function cellInBucket(cell, bucket) {
    const [lat, lon] = cell.split(":").map(Number);
    const b = bucketBox(bucket);
    return lat >= b.south && lat < b.north && lon >= b.west && lon < b.east;
}

function insideCity(cities, lat, lon) {
    return cities.some((c) => lat >= c.bounds[0] && lat <= c.bounds[2] && lon >= c.bounds[1] && lon <= c.bounds[3]);
}

function boxAround(lat, lon) {
    const h = BOX / 2, r = (x) => Math.round(x * 100) / 100;
    return [r(lat - h), r(lon - h), r(lat + h), r(lon + h)];
}

function overlaps(cities, box) {
    return cities.some((c) => box[0] < c.bounds[2] && box[2] > c.bounds[0] && box[1] < c.bounds[3] && box[3] > c.bounds[1]);
}

// bucketRows: [{ bucket, n }] busiest first. demandRows: [{ cell, hits }].
// Returns { bucket, n, lat, lon, bounds } for the first bucket that clears the
// threshold and whose busiest cell is not already inside (or touching) a city.
function pickCandidate(bucketRows, demandRows, cities, minEvents = MIN_EVENTS) {
    for (const row of bucketRows) {
        if (row.n < minEvents) return null;           // sorted: nothing further qualifies
        const cells = demandRows.filter((d) => cellInBucket(d.cell, row.bucket)).sort((a, b) => b.hits - a.hits);
        if (!cells.length) continue;                  // no demand rows to place it: skip rather than guess
        const [lat, lon] = cells[0].cell.split(":").map(Number);
        if (insideCity(cities, lat, lon)) continue;
        const bounds = boxAround(lat, lon);
        if (overlaps(cities, bounds)) continue;
        return { bucket: row.bucket, n: row.n, lat, lon, bounds };
    }
    return null;
}

// One line per leading bucket, so every weekly run shows how close the leader is to
// the threshold even when nothing qualifies. Same rules as pickCandidate for "busiest cell".
function describeTop(bucketRows, demandRows, cities, n = 3) {
    if (!bucketRows.length) return ["  none recorded"];
    return bucketRows.slice(0, n).map((row) => {
        const cells = demandRows.filter((d) => cellInBucket(d.cell, row.bucket)).sort((a, b) => b.hits - a.hits);
        if (!cells.length) return `  ${row.bucket}: ${row.n} events; no pin cells recorded`;
        const [lat, lon] = cells[0].cell.split(":").map(Number);
        const where = insideCity(cities, lat, lon) ? "inside a seeded city" : "outside all seeded cities";
        return `  ${row.bucket}: ${row.n} events; busiest cell ${lat}, ${lon} (${where})`;
    });
}

function slugify(name) {
    return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Append one city to cities.json text, matching the file's one-line bounds style
// (JSON.stringify would explode the bounds array over five lines).
function appendCity(text, city) {
    const entry = `  {\n    "id": ${JSON.stringify(city.id)},\n    "name": ${JSON.stringify(city.name)},\n` +
        `    "bounds": [${city.bounds.join(", ")}],\n    "elevation": true\n  }`;
    const end = text.lastIndexOf("}\n]");
    if (end < 0) throw new Error("cities.json: unexpected shape");
    return text.slice(0, end + 1) + ",\n" + entry + text.slice(end + 1);
}

// ── network ─────────────────────────────────────────────────────────────────
async function d1(sql, params) {
    const acct = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
    if (!acct || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
    const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/${D1_DATABASE_ID}/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ sql, params }),
    });
    const body = await resp.json();
    if (!resp.ok || !body.success) throw new Error("D1 query failed: " + JSON.stringify(body.errors || resp.status));
    return body.result[0].results;
}

// Nominatim asks for a real User-Agent and at most 1 request per second; this is 1 per week.
async function placeName(lat, lon) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lon}`;
    const resp = await fetch(url, { headers: { "user-agent": "legwork-suggest-city (https://github.com/fractionasian/legwork)" } });
    if (!resp.ok) return null;
    const a = (await resp.json()).address || {};
    return a.city || a.town || a.municipality || a.county || a.state || null;
}

async function main() {
    const citiesPath = path.join(__dirname, "..", "data", "cities.json");
    const text = fs.readFileSync(citiesPath, "utf8");
    const cities = JSON.parse(text);
    const since = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;

    const bucketRows = await d1(
        "SELECT json_extract(props, '$.bucket') AS bucket, COUNT(*) AS n FROM events " +
        "WHERE name = 'city-unknown' AND ts >= ? AND bucket IS NOT NULL GROUP BY bucket ORDER BY n DESC LIMIT 20", [since]);
    const demandRows = await d1("SELECT cell, SUM(hits) AS hits FROM demand GROUP BY cell", []);

    console.log(`Leading city-unknown buckets, last ${WINDOW_DAYS} days (threshold ${MIN_EVENTS} events):\n` + describeTop(bucketRows, demandRows, cities).join("\n"));
    const pick = pickCandidate(bucketRows, demandRows, cities);
    if (!pick) { console.log("No candidate: nothing outside the seeded cities cleared " + MIN_EVENTS + " events in " + WINDOW_DAYS + " days."); return; }

    const found = await placeName(pick.lat, pick.lon);
    let name = found || `Unnamed (${pick.lat}, ${pick.lon})`;
    let id = slugify(found || `city-${pick.lat}-${pick.lon}`);
    if (cities.some((c) => c.id === id)) throw new Error(`id "${id}" already in cities.json`);

    const city = { id, name, bounds: pick.bounds };
    fs.writeFileSync(citiesPath, appendCity(text, city));
    const summary = `Suggested city: **${name}** (\`${id}\`)\n\n` +
        `- ${pick.n} \`city-unknown\` events in the last ${WINDOW_DAYS} days in bucket ${pick.bucket}\n` +
        `- Busiest pin cell: ${pick.lat}, ${pick.lon}; box ${pick.bounds.join(", ")} (${BOX}° square, edit if the city is bigger)\n` +
        (found ? "" : "- Place name lookup failed, so the name and id are placeholders: rename before merging\n");
    fs.writeFileSync(process.env.SUMMARY_FILE || "suggest-city-summary.md", summary);
    console.log(summary);
}

module.exports = { describeTop, bucketBox, cellInBucket, insideCity, boxAround, overlaps, pickCandidate, slugify, appendCity, MIN_EVENTS, BOX };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

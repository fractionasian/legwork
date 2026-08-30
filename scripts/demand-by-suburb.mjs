#!/usr/bin/env node
// Which suburbs is Legwork actually being used in?
//
// Reads the `demand` table the Worker has been writing since the August
// analytics ship (one row per ~550 m grid cell per ISO week, hit counts only),
// rolls the cells up to suburb names, and prints a ranked table.
//
//   node scripts/demand-by-suburb.mjs                  # last 8 weeks
//   node scripts/demand-by-suburb.mjs --weeks 26
//   node scripts/demand-by-suburb.mjs --input rows.json --no-geocode
//
// Collects nothing. Every number here is already in D1; this only aggregates
// UPWARDS, so the output is strictly less granular than what is stored.
//
// Privacy: `demand` holds no user identifier, session, IP, or route geometry —
// a row is (cell, week, count). The one residual risk is a cell so quiet that
// its count is effectively one person's outing, so cells below --min-hits are
// pooled into a single "(below threshold)" line rather than named.
//
// Suburb names come from Photon reverse geocoding, preferring `district`/`city`
// over `name`. build-tiles.js prefers `name`, which is why the manifest's
// "suburbs" are often a road or a golf club rather than a suburb — do not reuse
// those labels here.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isoWeek } from "../worker/src/analytics-lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_NAME = "legwork-links"; // demand shares the links database
const PHOTON = "https://photon.komoot.io/reverse";

function parseArgs(argv) {
    const a = { weeks: 8, minHits: 5, limit: 25, input: null, geocode: true, maxGeocode: 60 };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === "--weeks") a.weeks = Number(argv[++i]);
        else if (k === "--min-hits") a.minHits = Number(argv[++i]);
        else if (k === "--limit") a.limit = Number(argv[++i]);
        else if (k === "--input") a.input = argv[++i];
        else if (k === "--max-geocode") a.maxGeocode = Number(argv[++i]);
        else if (k === "--no-geocode") a.geocode = false;
        else if (k === "--help" || k === "-h") { usage(); process.exit(0); }
        else { console.error("Unknown argument: " + k); usage(); process.exit(1); }
    }
    for (const n of ["weeks", "minHits", "limit", "maxGeocode"]) {
        if (!Number.isFinite(a[n]) || a[n] < 0) { console.error(`--${n} must be a non-negative number`); process.exit(1); }
    }
    return a;
}

function usage() {
    console.log(`Usage: node scripts/demand-by-suburb.mjs [options]

  --weeks N        how far back to look (default 8; the table keeps 104)
  --min-hits N     pool cells quieter than this instead of naming them (default 5)
  --limit N        how many suburbs to print (default 25)
  --max-geocode N  cap on reverse-geocode calls, ~1/s (default 60)
  --no-geocode     skip geocoding; report raw cells (no network needed)
  --input FILE     read rows from a JSON file instead of querying D1`);
}

// Pull (cell, hits) from D1, summed over the window. Exported shape:
// [{ cell: "-31.950:115.860", hits: 42 }, ...]
function fetchRows(weeks) {
    const cutoff = isoWeek(Math.floor(Date.now() / 1000) - weeks * 7 * 24 * 3600);
    const sql = `SELECT cell, SUM(hits) AS hits FROM demand WHERE week >= '${cutoff}' GROUP BY cell ORDER BY hits DESC`;
    const r = spawnSync("wrangler", ["d1", "execute", DB_NAME, "--remote", "--json", "--command", sql], {
        cwd: resolve(__dirname, "..", "worker"),
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error && r.error.code === "ENOENT") {
        console.error("wrangler not found — run this from a machine with the Cloudflare CLI installed and authenticated.");
        process.exit(1);
    }
    if (r.status !== 0) {
        console.error("wrangler failed:\n" + (r.stderr || r.stdout || "").trim());
        process.exit(1);
    }
    // `--json` prints an array of statement results; the rows are on [0].results.
    // Wrangler has been known to prepend banner lines, so start at the first "[".
    const out = r.stdout.slice(r.stdout.indexOf("["));
    let parsed;
    try { parsed = JSON.parse(out); } catch (e) {
        console.error("could not parse wrangler --json output: " + e.message);
        process.exit(1);
    }
    const rows = (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) || [];
    return rows.map((x) => ({ cell: String(x.cell), hits: Number(x.hits) }));
}

// "lat:lon" -> { lat, lon }. Returns null for anything that isn't two numbers,
// so a malformed row can't silently geocode as 0,0 (the Gulf of Guinea).
function cellToLatLon(cell) {
    const parts = String(cell).split(":");
    if (parts.length !== 2) return null;
    const lat = Number(parts[0]), lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Photon's `district` is the suburb/locality layer; `city` is the next level up.
// `name` is the nearest named FEATURE (road, park, club) and is deliberately the
// last resort — preferring it is what makes the tile manifest's labels useless
// for this question.
async function suburbFor(lat, lon) {
    try {
        const resp = await fetch(`${PHOTON}?lat=${lat}&lon=${lon}&limit=1`, {
            headers: { "User-Agent": "legwork-demand-report/1.0 (+https://github.com/fractionasian/legwork)" },
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const p = (data.features && data.features[0] && data.features[0].properties) || null;
        if (!p) return null;
        const label = p.district || p.city || p.county || p.name;
        if (!label) return null;
        return p.state && p.state !== label ? `${label}, ${p.state}` : label;
    } catch (e) {
        return null;
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const rows = args.input
        ? JSON.parse(readFileSync(args.input, "utf-8"))
        : fetchRows(args.weeks);

    if (rows.length === 0) {
        console.log("No demand rows in the window. Either nobody has routed in the last " +
            args.weeks + " weeks, or the Worker writing them isn't deployed.");
        return;
    }

    const totalHits = rows.reduce((s, r) => s + r.hits, 0);
    const loud = rows.filter((r) => r.hits >= args.minHits && cellToLatLon(r.cell));
    const quietHits = totalHits - loud.reduce((s, r) => s + r.hits, 0);

    console.log(`${rows.length} cells, ${totalHits} routing requests over the last ${args.weeks} weeks.`);
    console.log(`${loud.length} cells at or above the ${args.minHits}-hit threshold.\n`);

    if (!args.geocode) {
        console.log("cell (≈550 m)              hits");
        for (const r of loud.slice(0, args.limit)) {
            console.log(`  ${r.cell.padEnd(24)} ${String(r.hits).padStart(5)}`);
        }
        // Account for the tail too, so the column sums to the stated total
        // instead of quietly dropping whatever --limit cut off.
        const cutHits = loud.slice(args.limit).reduce((s, r) => s + r.hits, 0);
        if (cutHits > 0) console.log(`  ${"(other cells)".padEnd(24)} ${String(cutHits).padStart(5)}`);
        if (quietHits > 0) console.log(`  ${"(below threshold)".padEnd(24)} ${String(quietHits).padStart(5)}`);
        return;
    }

    const toGeocode = loud.slice(0, args.maxGeocode);
    if (loud.length > toGeocode.length) {
        console.log(`Geocoding the top ${toGeocode.length} cells (--max-geocode); the rest fold into "(other)".`);
    }
    const bySuburb = new Map();
    let ungeocoded = 0;
    for (let i = 0; i < toGeocode.length; i++) {
        const { lat, lon } = cellToLatLon(toGeocode[i].cell);
        const name = await suburbFor(lat, lon);
        if (name) bySuburb.set(name, (bySuburb.get(name) || 0) + toGeocode[i].hits);
        else ungeocoded += toGeocode[i].hits;
        process.stderr.write(`\r  geocoding ${i + 1}/${toGeocode.length}...`);
        if (i < toGeocode.length - 1) await sleep(1100); // Photon asks for ~1 req/s
    }
    process.stderr.write("\r" + " ".repeat(40) + "\r");

    const ranked = [...bySuburb.entries()].sort((a, b) => b[1] - a[1]);
    const width = Math.max(20, ...ranked.slice(0, args.limit).map(([n]) => n.length));
    console.log("suburb".padEnd(width) + "   hits   share");
    console.log("-".repeat(width + 15));
    for (const [name, hits] of ranked.slice(0, args.limit)) {
        const pct = ((hits / totalHits) * 100).toFixed(1) + "%";
        console.log(name.padEnd(width) + String(hits).padStart(7) + pct.padStart(8));
    }
    const otherHits = loud.slice(toGeocode.length).reduce((s, r) => s + r.hits, 0);
    if (otherHits > 0) console.log("(other cells)".padEnd(width) + String(otherHits).padStart(7));
    if (ungeocoded > 0) console.log("(no suburb found)".padEnd(width) + String(ungeocoded).padStart(7));
    if (quietHits > 0) console.log("(below threshold)".padEnd(width) + String(quietHits).padStart(7));
}

main().catch((e) => { console.error(e); process.exit(1); });

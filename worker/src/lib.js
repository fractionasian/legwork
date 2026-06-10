// Pure, dependency-free helpers for the Legwork graph-cache Worker.
// No Worker globals at module scope so node --test can import this directly.

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Verbatim from tiles.js:320-337 (loadPaths). The set is identical for run and
// bike — profile only changes edge WEIGHTING client-side, not what is fetched —
// so the Worker cache key omits profile.
const HIGHWAY_TYPES = [
  "footway", "cycleway", "path", "residential", "living_street",
  "pedestrian", "service", "unclassified", "tertiary", "tertiary_link",
  "secondary", "secondary_link", "primary", "primary_link", "trunk",
  "trunk_link", "crossing", "steps",
];

export function buildOverpassQuery(lat, lon, radius) {
  let query = "[out:json][timeout:30];\n(\n";
  for (const hw of HIGHWAY_TYPES) {
    query += '  way["highway"="' + hw + '"](around:' + radius + "," + lat + "," + lon + ");\n";
  }
  // `out body; >; out body qt;` brings node tags through for client-side
  // crossing/barrier/signal weighting (tiles.js:338-340).
  query += ");\nout body;\n>;\nout body qt;";
  return query;
}

export function cacheKey(lat, lon, radius) {
  return "g:" + lat.toFixed(3) + ":" + lon.toFixed(3) + ":" + radius;
}

export function parseGraphParams(url) {
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const radius = Number(url.searchParams.get("radius"));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: "bad lat" };
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { ok: false, error: "bad lon" };
  // Floor is 1000 m, not an arbitrary small value: snap() can shift the fetch
  // centre up to the cell half-diagonal (~390 m) from the requested pin, so a
  // radius smaller than that could return a graph that misses the pin entirely.
  // 1000 m keeps the snapped circle comfortably over the pin and matches the
  // smallest radius the client ever sends (radiusFromZoom in tiles.js).
  if (!Number.isInteger(radius) || radius < 1000 || radius > 30000) return { ok: false, error: "bad radius" };
  return { ok: true, lat, lon, radius };
}

// Cache-key / fetch-centre grid. Pins are snapped to this grid before BOTH the
// cache key and the Overpass `around:` centre, so a whole ~550 m neighbourhood
// shares one cached fetch instead of one fetch per ~110 m pin. Coverage-safe at
// every zoom: the worst-case offset from a snapped centre is the cell half-
// diagonal ≈ 0.005·√2/2 ≈ 390 m, well inside the 1000 m minimum radius enforced
// by parseGraphParams. This can be widened toward 0.01 (~1.1 km) once hit-rate
// telemetry
// justifies bigger cells — a one-line change here + a Worker redeploy, no
// client change.
export const GRID_DEG = 0.005;

// Snap a coordinate to the nearest GRID_DEG multiple. Applied server-side so the
// grid is tunable by redeploying the Worker alone (the client keeps sending
// exact coords). Snapping both the key and the query centre makes a cell's
// cached graph deterministically centred on the cell, not on whoever fetched
// first.
export function snap(coord) {
  return Math.round(coord / GRID_DEG) * GRID_DEG;
}

// Radius buckets. snap() collapses coordinates to ~550 m cells, but the cache
// key also embeds the radius — and parseGraphParams accepts ANY integer
// 1000–30000, so one grid cell could mint up to 29,000 distinct R2 objects
// (each a guaranteed cache miss → an Overpass fetch + an R2 write that never
// expires). Bucketing the radius server-side caps that at |RADIUS_BUCKETS|
// per cell. The set is the exact values radiusFromZoom (tiles.js) sends, plus
// the 30 km ceiling; any other value rounds UP to the next bucket so coverage
// is never smaller than requested, and a future client tweak can't be broken
// by a server-side allowlist.
export const RADIUS_BUCKETS = [1000, 1500, 2000, 4000, 5000, 10000, 20000, 30000];

export function snapRadius(radius) {
  for (const b of RADIUS_BUCKETS) {
    if (radius <= b) return b;
  }
  return RADIUS_BUCKETS[RADIUS_BUCKETS.length - 1];
}

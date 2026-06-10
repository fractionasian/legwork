// Pure functions for the share short-link service. No Worker globals at module
// scope so this is unit-testable under `node --test`.

// Lookalike-free base32-ish alphabet: omits 0/O/1/l/I/o/i so a code is safe to
// read aloud or hand-type. 31 chars → 31^6 ≈ 8.9e8 random codes (ample headroom
// over 6-hex's 1.7e7; collisions are handled by retry on insert regardless).
export const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const SLUG_LEN = 6;

// Default RNG returns a float in [0,1). Injectable for deterministic tests.
function defaultRng() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

export function genSlug(rng = defaultRng) {
  let s = "";
  for (let i = 0; i < SLUG_LEN; i++) {
    s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return s;
}

const MODES = new Set(["oneway", "loop", "outback"]);
const MAX_POINTS = 500;
// MAX_POINTS bounds the point COUNT but not the string length — Number()
// accepts arbitrarily long numeric strings, so without a length cap a single
// "valid" 500-point hash could be tens of MB written verbatim to D1. A legit
// 500-point hash at the client's 5-decimal precision is ~10 KB; 16 KB is ample.
const MAX_HASH_LEN = 16384;
// Each coordinate must look like what the client emits (toFixed(5), optional
// sign). The digit caps also bound per-coordinate length, and the strict shape
// rejects Number()'s lax accepts ("" → 0, "0x41" → 65, exponent forms).
const COORD_RE = /^-?\d{1,3}(\.\d{1,7})?$/;

// Validate that a string is a well-formed Legwork route hash and nothing else.
// This is the security boundary: the stored payload can ONLY be a route, never
// an arbitrary URL, so a short link can never become an open redirector.
// Accepts "#r=...&m=..." or the bare "r=...&m=...". Returns { ok, hash } with a
// normalised leading-# hash, or { ok:false, reason }.
export function validateRouteHash(input) {
  if (typeof input !== "string") return { ok: false, reason: "not a string" };
  if (input.length > MAX_HASH_LEN) return { ok: false, reason: "hash too long (max " + MAX_HASH_LEN + " chars)" };
  const body = input.startsWith("#") ? input.slice(1) : input;
  const params = new URLSearchParams(body);
  const r = params.get("r");
  const m = params.get("m");
  if (!r) return { ok: false, reason: "missing r=" };
  if (!m || !MODES.has(m)) return { ok: false, reason: "bad or missing mode" };

  const points = r.split(";");
  if (points.length < 2) return { ok: false, reason: "need >= 2 points" };
  if (points.length > MAX_POINTS) return { ok: false, reason: "too many points" };

  for (const p of points) {
    const parts = p.split(",");
    if (parts.length !== 2) return { ok: false, reason: "malformed point: " + p };
    if (!COORD_RE.test(parts[0]) || !COORD_RE.test(parts[1])) return { ok: false, reason: "malformed coordinate: " + p };
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (lat < -90 || lat > 90) return { ok: false, reason: "lat out of range: " + p };
    if (lon < -180 || lon > 180) return { ok: false, reason: "lon out of range: " + p };
  }

  return { ok: true, hash: "#r=" + r + "&m=" + m };
}

// Words a user-chosen vanity slug may not take. Two groups:
//  (a) app route prefixes + obvious confusables, and
//  (b) names of real static files/routes served at the site root — GitHub Pages
//      serves those files BEFORE the 404.html short-link router runs, so a vanity
//      slug colliding with one would be shadowed (and could silently break if the
//      host's static set ever changes). Keep this in sync with the repo root.
// Trademark squatting can't be fully pre-blocked here — that's why vanity is
// approval-gated, not auto-granted.
export const RESERVED = new Set([
  // route prefixes + confusables
  "api", "r", "admin", "official", "legwork", "app", "www", "help", "about",
  // real root files/assets (shadow the slug if requested)
  "index", "sw", "tiles", "routing", "storage", "style", "data", "docs",
  "scripts", "test", "cname", "manifest", "welcome-init", "robots", "sitemap",
  "assets", "static", "favicon", "icons", "og",
]);

const VANITY_RE = /^[a-z0-9-]{3,40}$/i;

// Returns { ok, slug } with a canonical LOWERCASE slug on success. Slugs are
// stored and resolved case-insensitively (D1 PK is case-sensitive, the 404.html
// router forwards the path as-typed, and users will type any case) — so we
// canonicalise to lowercase here, the single source of truth.
export function validateVanitySlug(slug) {
  if (typeof slug !== "string") return { ok: false, reason: "not a string" };
  if (!VANITY_RE.test(slug)) return { ok: false, reason: "must be 3-40 chars of a-z 0-9 -" };
  const canonical = slug.toLowerCase();
  if (RESERVED.has(canonical)) return { ok: false, reason: "reserved word" };
  return { ok: true, slug: canonical };
}

// Response helpers shared by the /api handlers.
// ACAO is "*" — the API is public (graph cache + short links), responses carry
// no secrets and no cookie/credentialed auth (admin is Bearer-gated, which CORS
// doesn't govern). "*" lets both legwork.day and the github.io alias call it
// without an origin allowlist.
export function apiCors(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    ...extra,
  };
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: apiCors({ "content-type": "application/json" }),
  });
}

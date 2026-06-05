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

// Validate that a string is a well-formed Legwork route hash and nothing else.
// This is the security boundary: the stored payload can ONLY be a route, never
// an arbitrary URL, so a short link can never become an open redirector.
// Accepts "#r=...&m=..." or the bare "r=...&m=...". Returns { ok, hash } with a
// normalised leading-# hash, or { ok:false, reason }.
export function validateRouteHash(input) {
  if (typeof input !== "string") return { ok: false, reason: "not a string" };
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
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, reason: "non-numeric: " + p };
    if (lat < -90 || lat > 90) return { ok: false, reason: "lat out of range: " + p };
    if (lon < -180 || lon > 180) return { ok: false, reason: "lon out of range: " + p };
  }

  return { ok: true, hash: "#r=" + r + "&m=" + m };
}

// Words a user-chosen vanity slug may not take: app route prefixes + obvious
// confusables. Trademark squatting can't be fully pre-blocked here — that's why
// vanity is approval-gated, not auto-granted.
export const RESERVED = new Set([
  "api", "r", "admin", "official", "legwork", "app", "www", "help", "about",
]);

const VANITY_RE = /^[a-z0-9-]{3,40}$/i;

export function validateVanitySlug(slug) {
  if (typeof slug !== "string") return { ok: false, reason: "not a string" };
  if (!VANITY_RE.test(slug)) return { ok: false, reason: "must be 3-40 chars of a-z 0-9 -" };
  if (RESERVED.has(slug.toLowerCase())) return { ok: false, reason: "reserved word" };
  return { ok: true };
}

// Response helpers shared by the /api handlers.
const APP_ORIGIN = "https://fractionasian.github.io";

export function apiCors(extra = {}) {
  return {
    "access-control-allow-origin": APP_ORIGIN,
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

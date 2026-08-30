// Pure helpers for Legwork's self-hosted analytics. No Worker globals at module
// scope so node --test can import this directly (same pattern as lib.js).
//
// Privacy invariant: nothing here accepts or emits a coordinate finer than the
// existing 0.005 deg cache grid, a raw distance, or any per-user identifier.
// Every value that reaches D1 is an enum or a bucket.

import { snap } from "./lib.js";

export const EVENT_NAMES = new Set([
  "pin-drop", "route-built", "route-export", "route-save", "route-share",
  // Moved off Umami Cloud, which was the last third-party script in the app.
  // These two answer "which city do we pre-bake next": city-resolved when the
  // user lands inside a catalogued city, city-unknown with a coarse 0.5-degree
  // bucket when they do not.
  "city-resolved", "city-unknown",
]);

// Coarse 0.5-degree bucket, e.g. "-32.0,116.0" — deliberately imprecise: this
// says "somebody routes around here", never where. Validated by shape for the
// same reason as `city` below, and bounded in length so cardinality is capped.
const BUCKET_RE = /^-?\d{1,3}\.\d,-?\d{1,3}\.\d$/;

const KM_BUCKETS = ["0-5", "5-10", "10-20", "20+"];
const MODES = new Set(["loop", "outback", "oneway"]);
const PROFILES = new Set(["run", "bike"]);

// City slug for `route-built`, e.g. "perth" — or the sentinel "uncovered" when
// the route is outside every catalogue city.
//
// Validated by SHAPE, not by membership in a hardcoded list, and that is the
// whole design. The tile catalogue lives in a DIFFERENT REPO
// (fractionasian/legwork-tiles) and gains cities without any Worker deploy, so
// an allowlist here would silently discard every route-built from city #11 on
// the day it ships. An allowlist also buys little: this endpoint is
// unauthenticated, so a hostile client can send an allowlisted value just as
// easily as any other. The real exposure is unbounded cardinality in the table,
// and length + charset bound that. Unrecognised slugs are bucketed as "other"
// at READ time by joining against the current manifest.
const CITY_RE = /^[a-z][a-z0-9-]{1,30}$/;
function isCitySlug(v) { return typeof v === "string" && CITY_RE.test(v); }

// Suburb name for `route-built`, e.g. "Dalkeith" — the OSM boundary name the
// client resolved the route's start point to, by point-in-polygon against a
// per-city suburb file. Soft, and by shape, for exactly the same reasons as
// `city`: the polygons ship in the legwork-tiles repo and change without a
// Worker deploy.
//
// Looser charset than a slug because these are real place names, not slugs:
// they carry spaces, hyphens, apostrophes ("O'Connor"), periods ("St. Kilda")
// and non-Latin scripts. Unicode letter/number classes rather than [a-z] so a
// Tokyo or Singapore rollout doesn't silently drop every name. Cardinality is
// bounded by the 60-char cap and by the polygon file being a fixed list.
const SUBURB_RE = /^[\p{L}\p{N}][\p{L}\p{N} '\u2019\-.()\/]{0,59}$/u;
function isSuburbName(v) { return typeof v === "string" && SUBURB_RE.test(v); }

// Per-event prop schema. A prop absent from its event's schema is DROPPED, not
// rejected — a newer client can add a field without 400ing against an older
// Worker. A prop that IS in the schema but carries a bad value is rejected, so
// a bug cannot quietly write garbage.
//
// `soft: true` inverts that last rule for props whose valid set lives OUTSIDE
// this Worker. For those, a bad value drops the PROP and keeps the EVENT: a
// missing dimension is recoverable, a missing event is not. Only `city`
// qualifies today — every other prop comes from an enum that changes only when
// this file changes, so a bad value there is a real bug and must still reject.
const PROP_SCHEMA = {
  "pin-drop": { n: { test: (v) => Number.isInteger(v) && v >= 0 && v <= 1000 } },
  // `soft` for the same reason route-built's city is soft: the catalogue lives
  // in the legwork-tiles repo and gains cities with no Worker deploy, so a bad
  // value must drop the PROP, never the EVENT.
  "city-resolved": { city: { test: isCitySlug, soft: true } },
  "city-unknown": { bucket: { test: (v) => typeof v === "string" && BUCKET_RE.test(v), soft: true } },
  "route-built": {
    km_bucket: { test: (v) => KM_BUCKETS.includes(v) },
    mode: { test: (v) => MODES.has(v) },
    profile: { test: (v) => PROFILES.has(v) },
    city: { test: isCitySlug, soft: true },
    suburb: { test: isSuburbName, soft: true },
  },
  "route-export": {},
  "route-save": {},
  "route-share": {},
};

// Distance -> coarse bucket. Defensive by design: this runs on client-supplied
// numbers, so NaN/negative fall to the smallest bucket rather than throwing.
export function kmBucket(metres) {
  const m = Number(metres);
  if (!(m > 0)) return KM_BUCKETS[0];      // covers NaN, 0, negatives
  if (m < 5000) return KM_BUCKETS[0];
  if (m < 10000) return KM_BUCKETS[1];
  if (m < 20000) return KM_BUCKETS[2];
  return KM_BUCKETS[3];
}

// ISO-8601 week string, e.g. "2026-W32". Weeks start Monday and week 1 is the
// week containing the first Thursday, so late-December dates can belong to week
// 1 of the NEXT year and early-January dates to week 52/53 of the previous one.
// Getting this wrong would silently split one week's demand across two rows.
export function isoWeek(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  // Shift to the Thursday of this ISO week; that Thursday's year IS the ISO year.
  const day = (d.getUTCDay() + 6) % 7;                       // Mon=0 .. Sun=6
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 24 * 3600 * 1000));
  return isoYear + "-W" + String(week).padStart(2, "0");
}

// Demand key for a pin. Reuses the SAME snap() the R2 cache key uses, so this
// records a value handleGraph already computes — it introduces no new precision.
export function demandCell(lat, lon) {
  return snap(lat).toFixed(3) + ":" + snap(lon).toFixed(3);
}

// Validate an inbound event body. Returns the sanitised props — callers must
// write r.props, never the raw input, or the drop-unknown-props guarantee is void.
export function validateEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "body must be an object" };
  }
  const name = body.name;
  if (typeof name !== "string" || !EVENT_NAMES.has(name)) {
    return { ok: false, reason: "unknown event name" };
  }
  const schema = PROP_SCHEMA[name];
  const raw = (body.props && typeof body.props === "object" && !Array.isArray(body.props)) ? body.props : {};
  const props = {};
  for (const key of Object.keys(schema)) {
    if (!(key in raw)) continue;
    const rule = schema[key];
    if (!rule.test(raw[key])) {
      // Soft props drop and carry on; hard props still reject the whole event.
      if (rule.soft) continue;
      return { ok: false, reason: "bad value for prop: " + key };
    }
    props[key] = raw[key];
  }
  return { ok: true, name, props };
}

// Pure helpers for Legwork's self-hosted analytics. No Worker globals at module
// scope so node --test can import this directly (same pattern as lib.js).
//
// Privacy invariant: nothing here accepts or emits a coordinate finer than the
// existing 0.005 deg cache grid, a raw distance, or any per-user identifier.
// Every value that reaches D1 is an enum or a bucket.

import { snap } from "./lib.js";

export const EVENT_NAMES = new Set([
  "pin-drop", "route-built", "route-export", "route-save", "route-share",
]);

const KM_BUCKETS = ["0-5", "5-10", "10-20", "20+"];
const MODES = new Set(["loop", "outback", "oneway"]);
const PROFILES = new Set(["run", "bike"]);

// Per-event prop schema. A prop absent from its event's schema is DROPPED, not
// rejected — a newer client can add a field without 400ing against an older
// Worker. A prop that IS in the schema but carries a bad value is rejected, so
// a bug cannot quietly write garbage.
const PROP_SCHEMA = {
  "pin-drop": { n: (v) => Number.isInteger(v) && v >= 0 && v <= 1000 },
  "route-built": {
    km_bucket: (v) => KM_BUCKETS.includes(v),
    mode: (v) => MODES.has(v),
    profile: (v) => PROFILES.has(v),
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
    if (!schema[key](raw[key])) return { ok: false, reason: "bad value for prop: " + key };
    props[key] = raw[key];
  }
  return { ok: true, name, props };
}

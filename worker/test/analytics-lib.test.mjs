import test from "node:test";
import assert from "node:assert/strict";
import { validateEvent, kmBucket, isoWeek, demandCell, EVENT_NAMES } from "../src/analytics-lib.js";

test("kmBucket maps metres to the four buckets", () => {
  assert.equal(kmBucket(0), "0-5");
  assert.equal(kmBucket(4999), "0-5");
  assert.equal(kmBucket(5000), "5-10");
  assert.equal(kmBucket(9999), "5-10");
  assert.equal(kmBucket(10000), "10-20");
  assert.equal(kmBucket(19999), "10-20");
  assert.equal(kmBucket(20000), "20+");
  assert.equal(kmBucket(999999), "20+");
});

test("kmBucket is defensive about non-finite and negative input", () => {
  assert.equal(kmBucket(NaN), "0-5");
  assert.equal(kmBucket(-1), "0-5");
  assert.equal(kmBucket(Infinity), "20+");
});

test("isoWeek derives ISO-8601 week strings, including year-boundary cases", () => {
  // 2026-08-03 is a Monday in ISO week 32.
  assert.equal(isoWeek(Date.UTC(2026, 7, 3) / 1000), "2026-W32");
  // 2027-01-01 is a Friday, which ISO-8601 assigns to week 53 of 2026.
  assert.equal(isoWeek(Date.UTC(2027, 0, 1) / 1000), "2026-W53");
  // 2026-01-01 is a Thursday -> week 1 of 2026.
  assert.equal(isoWeek(Date.UTC(2026, 0, 1) / 1000), "2026-W01");
});

test("demandCell reuses the 0.005 grid and formats to 3dp", () => {
  assert.equal(demandCell(-31.9523, 115.8613), "-31.950:115.860");
  // Two pins inside one cell collapse to the same key.
  assert.equal(demandCell(-31.9510, 115.8590), demandCell(-31.9523, 115.8613));
});

test("EVENT_NAMES is the closed allowlist", () => {
  assert.deepEqual(
    [...EVENT_NAMES].sort(),
    // city-resolved / city-unknown joined when those two moved off Umami Cloud.
    ["city-resolved", "city-unknown", "pin-drop", "route-built", "route-export",
     "route-save", "route-share"],
  );
});

test("validateEvent accepts a well-formed route-built event", () => {
  const r = validateEvent({ name: "route-built", props: { km_bucket: "5-10", mode: "loop", profile: "run" } });
  assert.equal(r.ok, true);
  assert.equal(r.name, "route-built");
  assert.deepEqual(r.props, { km_bucket: "5-10", mode: "loop", profile: "run" });
});

test("validateEvent rejects an unknown event name", () => {
  const r = validateEvent({ name: "evil-event", props: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown event/);
});

test("validateEvent rejects a non-object body", () => {
  assert.equal(validateEvent(null).ok, false);
  assert.equal(validateEvent("pin-drop").ok, false);
  assert.equal(validateEvent(42).ok, false);
});

test("validateEvent drops unexpected props rather than storing them", () => {
  const r = validateEvent({
    name: "route-built",
    props: { km_bucket: "0-5", mode: "loop", profile: "run", evil: "x".repeat(5000), ip: "1.2.3.4" },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.props).sort(), ["km_bucket", "mode", "profile"]);
});

test("validateEvent rejects out-of-enum prop values", () => {
  assert.equal(validateEvent({ name: "route-built", props: { km_bucket: "99-100", mode: "loop", profile: "run" } }).ok, false);
  assert.equal(validateEvent({ name: "route-built", props: { km_bucket: "0-5", mode: "teleport", profile: "run" } }).ok, false);
  assert.equal(validateEvent({ name: "route-built", props: { km_bucket: "0-5", mode: "loop", profile: "jetpack" } }).ok, false);
});

test("validateEvent accepts a catalogue city slug and the uncovered sentinel", () => {
  for (const city of ["perth", "sydney", "london", "tokyo", "uncovered"]) {
    const r = validateEvent({ name: "route-built", props: { km_bucket: "5-10", mode: "loop", profile: "run", city } });
    assert.equal(r.ok, true, city);
    assert.equal(r.props.city, city);
  }
});

test("an unrecognised city DROPS THE PROP and KEEPS THE EVENT", () => {
  // The point of soft-fail. The tile catalogue lives in another repo and gains
  // cities without a Worker deploy — a hard reject here would silently discard
  // 100% of route-built from a new city until someone redeployed the Worker.
  for (const bad of ["Perth", "a", "x".repeat(40), "perth!", "1perth", "", 42, null, {}]) {
    const r = validateEvent({ name: "route-built", props: { km_bucket: "5-10", mode: "loop", profile: "run", city: bad } });
    assert.equal(r.ok, true, "event must survive city=" + JSON.stringify(bad));
    assert.equal("city" in r.props, false, "bad city must not be stored: " + JSON.stringify(bad));
    // The rest of the event must be intact — a dropped dimension, not a dropped row.
    assert.deepEqual(
      { km_bucket: r.props.km_bucket, mode: r.props.mode, profile: r.props.profile },
      { km_bucket: "5-10", mode: "loop", profile: "run" },
    );
  }
});

test("validateEvent accepts real suburb names, including non-Latin", () => {
  // Real names carry spaces, hyphens, apostrophes, periods and non-Latin
  // scripts. A slug-shaped rule would drop most of them silently.
  const good = ["Dalkeith", "South Perth", "O'Connor", "Mount Lawley",
                "St. Kilda", "Hampstead Garden Suburb", "Toa Payoh",
                "\u6E0B\u8C37", "Bassendean"];
  for (const suburb of good) {
    const r = validateEvent({ name: "route-built", props: { km_bucket: "5-10", mode: "loop", profile: "run", city: "perth", suburb } });
    assert.equal(r.ok, true, suburb);
    assert.equal(r.props.suburb, suburb);
  }
});

test("a malformed suburb DROPS THE PROP and KEEPS THE EVENT", () => {
  // Same soft-fail contract as `city`: the polygon files live in the tiles repo
  // and change with no Worker deploy, so a name this Worker cannot parse must
  // cost the dimension, never the event.
  const bad = ["", " leading space", "x".repeat(61), "<script>", 42, null, {}];
  for (const suburb of bad) {
    const r = validateEvent({ name: "route-built", props: { km_bucket: "5-10", mode: "loop", profile: "run", city: "perth", suburb } });
    assert.equal(r.ok, true, "event must survive suburb=" + JSON.stringify(suburb));
    assert.equal("suburb" in r.props, false, "bad suburb must not be stored: " + JSON.stringify(suburb));
    assert.equal(r.props.city, "perth", "the other props must be intact");
  }
});

test("soft-fail does NOT leak to the hard props", () => {
  // A bad `mode` must still reject the whole event even when `city` is valid —
  // otherwise adding one soft prop quietly weakens every other guarantee.
  const r = validateEvent({ name: "route-built", props: { km_bucket: "5-10", mode: "teleport", profile: "run", city: "perth" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /mode/);
});

test("route-built without a city is still valid (older client, or manifest not loaded)", () => {
  const r = validateEvent({ name: "route-built", props: { km_bucket: "0-5", mode: "oneway", profile: "bike" } });
  assert.equal(r.ok, true);
  assert.equal("city" in r.props, false);
});

test("city is not accepted on events that do not declare it", () => {
  const r = validateEvent({ name: "pin-drop", props: { n: 1, city: "perth" } });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.props), ["n"]);
});

test("validateEvent constrains pin-drop n to a sane integer range", () => {
  assert.equal(validateEvent({ name: "pin-drop", props: { n: 3 } }).props.n, 3);
  assert.equal(validateEvent({ name: "pin-drop", props: { n: -5 } }).ok, false);
  assert.equal(validateEvent({ name: "pin-drop", props: { n: 10000 } }).ok, false);
  assert.equal(validateEvent({ name: "pin-drop", props: { n: 1.5 } }).ok, false);
});

test("validateEvent accepts events that carry no props", () => {
  for (const name of ["route-export", "route-share", "route-save"]) {
    const r = validateEvent({ name });
    assert.equal(r.ok, true, name);
    assert.deepEqual(r.props, {});
  }
});

test("city-resolved / city-unknown are accepted with their props", () => {
  assert.equal(EVENT_NAMES.has("city-resolved"), true);
  assert.equal(EVENT_NAMES.has("city-unknown"), true);

  const r = validateEvent({ name: "city-resolved", props: { city: "singapore" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.props, { city: "singapore" });

  // The client emits one-decimal 0.5-degree buckets, negatives included.
  for (const bucket of ["-32.0,116.0", "1.5,104.0", "51.5,0.0", "0.0,0.0", "-12.5,131.0"]) {
    const u = validateEvent({ name: "city-unknown", props: { bucket } });
    assert.equal(u.ok, true, bucket);
    assert.deepEqual(u.props, { bucket }, bucket);
  }
});

test("city event props are soft — a bad value drops the prop, never the event", () => {
  // The catalogue lives in another repo and gains cities with no Worker
  // deploy, so an unrecognised value must not cost us the event itself.
  const r = validateEvent({ name: "city-resolved", props: { city: "Not A Slug!" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.props, {});

  // Full coordinates would defeat the point of bucketing, so they must not pass.
  for (const bad of ["-31.9505,115.8605", "-32,116", "abc", "-32.0", "1e3.0,2.0"]) {
    const u = validateEvent({ name: "city-unknown", props: { bucket: bad } });
    assert.equal(u.ok, true, bad);
    assert.deepEqual(u.props, {}, "should have dropped: " + bad);
  }
});

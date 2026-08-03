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
    ["pin-drop", "route-built", "route-export", "route-save", "route-share"],
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

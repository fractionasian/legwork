import test from "node:test";
import assert from "node:assert/strict";
import { makeD1Mock } from "./_d1mock.mjs";
import { insertEvent, bumpDemand, pruneOld } from "../src/analytics-db.js";

test("insertEvent writes one row with JSON-serialised props", async () => {
  const db = makeD1Mock();
  await insertEvent(db, { ts: 1000, name: "route-built", props: { km_bucket: "5-10" }, country: "AU" });
  assert.equal(db._events.length, 1);
  assert.equal(db._events[0].name, "route-built");
  assert.equal(db._events[0].country, "AU");
  assert.deepEqual(JSON.parse(db._events[0].props), { km_bucket: "5-10" });
});

test("insertEvent tolerates a null country (cf.country absent in local dev)", async () => {
  const db = makeD1Mock();
  await insertEvent(db, { ts: 1000, name: "pin-drop", props: {}, country: null });
  assert.equal(db._events[0].country, null);
});

test("bumpDemand inserts on first hit and increments on repeat", async () => {
  const db = makeD1Mock();
  await bumpDemand(db, { cell: "-31.950:115.860", week: "2026-W32" });
  assert.equal(db._demand.get("-31.950:115.860|2026-W32"), 1);
  await bumpDemand(db, { cell: "-31.950:115.860", week: "2026-W32" });
  assert.equal(db._demand.get("-31.950:115.860|2026-W32"), 2);
});

test("bumpDemand keeps different weeks and different cells separate", async () => {
  const db = makeD1Mock();
  await bumpDemand(db, { cell: "-31.950:115.860", week: "2026-W32" });
  await bumpDemand(db, { cell: "-31.950:115.860", week: "2026-W33" });
  await bumpDemand(db, { cell: "-37.815:144.965", week: "2026-W32" });
  assert.equal(db._demand.size, 3);
});

test("pruneOld deletes events past the retention window and leaves fresh rows", async () => {
  const db = makeD1Mock();
  const now = 1_800_000_000;
  const old = now - 200 * 24 * 3600;   // 200 days -> past the 180-day window
  const fresh = now - 10 * 24 * 3600;
  await insertEvent(db, { ts: old, name: "pin-drop", props: {}, country: "AU" });
  await insertEvent(db, { ts: fresh, name: "pin-drop", props: {}, country: "AU" });
  const res = await pruneOld(db, { nowSeconds: now });
  assert.equal(res.events, 1);
  assert.equal(db._events.length, 1);
  assert.equal(db._events[0].ts, fresh);
});

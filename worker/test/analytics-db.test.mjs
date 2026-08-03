import test from "node:test";
import assert from "node:assert/strict";
import { makeD1Mock } from "./_d1mock.mjs";
import { insertEvent, bumpDemand, pruneOld } from "../src/analytics-db.js";
import { isoWeek } from "../src/analytics-lib.js";

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

test("pruneOld deletes demand rows past the 104-week ISO-week cutoff, including a same-calendar-year row", async () => {
  const db = makeD1Mock();
  const now = 1_800_000_000;                              // isoWeek(now) = "2027-W02"
  const cutoffSec = now - 104 * 7 * 24 * 3600;             // the real 104-week-back cutoff, isoWeek = "2025-W03"

  // Same calendar year as the cutoff, but an earlier week (isoWeek = "2025-W01"). This is the case
  // a hand-built "<year>-W00" cutoff gets wrong: "2025-W01" string-sorts ABOVE "2025-W00", so that
  // buggy cutoff never deletes it even though it is outside the 104-week window. isoWeek()'s real
  // "2025-W03" cutoff correctly catches it: "2025-W01" < "2025-W03".
  const sameYearBeforeCutoff = cutoffSec - 2 * 7 * 24 * 3600;
  // Different (earlier) year, well outside the window (isoWeek = "2024-W45"). A year-crossing cutoff
  // catches this under both the buggy and the fixed implementation, so on its own it would NOT have
  // caught the bug — included per the brief's "well outside" requirement, not as the differentiator.
  const wellOutside = cutoffSec - 10 * 7 * 24 * 3600;
  // Just inside the window (isoWeek = "2025-W04") -- must survive under both implementations.
  const justInside = cutoffSec + 8 * 24 * 3600;

  const cell = "-31.950:115.860";
  await bumpDemand(db, { cell, week: isoWeek(sameYearBeforeCutoff) });
  await bumpDemand(db, { cell, week: isoWeek(wellOutside) });
  await bumpDemand(db, { cell, week: isoWeek(justInside) });

  const res = await pruneOld(db, { nowSeconds: now });

  // Under the old "<year>-W00" cutoff this would be res.demand === 1 (only wellOutside deleted) and
  // db._demand.size === 2 (sameYearBeforeCutoff wrongly surviving alongside justInside).
  assert.equal(res.demand, 2);
  assert.equal(db._demand.size, 1);
  assert.equal(db._demand.has(`${cell}|${isoWeek(justInside)}`), true);
});

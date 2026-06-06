import { test } from "node:test";
import assert from "node:assert/strict";
import { createRandomLink, getActive, requestVanity, setStatus, listPending, bumpHits } from "../src/links-db.js";
import { makeD1Mock } from "./_d1mock.mjs";

const NOW = 1_750_000_000_000;

test("createRandomLink stores an active random row and getActive returns it", async () => {
  const db = makeD1Mock();
  const slug = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW });
  const row = await getActive(db, slug);
  assert.equal(row.hash, "#r=a;b&m=oneway");
  assert.equal(row.type, "random");
  assert.equal(row.status, "active");
});

test("createRandomLink retries on slug collision", async () => {
  const db = makeD1Mock();
  await createRandomLink(db, { hash: "x", now: NOW, genSlug: () => "taken1" });
  let i = 0;
  const slug = await createRandomLink(db, {
    hash: "y", now: NOW,
    genSlug: () => (i++ === 0 ? "taken1" : "free01"), // first collides, second is free
  });
  assert.equal(slug, "free01");
});

test("createRandomLink gives up after the retry cap", async () => {
  const db = makeD1Mock();
  await createRandomLink(db, { hash: "x", now: NOW, genSlug: () => "dupdup" });
  await assert.rejects(
    () => createRandomLink(db, { hash: "y", now: NOW, genSlug: () => "dupdup", tries: 3 }),
  );
});

test("getActive ignores non-active rows (pending vanity not resolvable)", async () => {
  const db = makeD1Mock();
  await requestVanity(db, { slug: "Melbourne2027", hash: "#r=a;b&m=loop", contact: "a@b.c", note: "Melb", now: NOW });
  assert.equal(await getActive(db, "Melbourne2027"), null);
  await setStatus(db, "Melbourne2027", "active");
  const row = await getActive(db, "Melbourne2027");
  assert.ok(row);
  assert.equal(row.hash, "#r=a;b&m=loop");
});

test("requestVanity refuses an already-taken slug", async () => {
  const db = makeD1Mock();
  await requestVanity(db, { slug: "Boston", hash: "#r=a;b&m=oneway", now: NOW });
  await assert.rejects(() => requestVanity(db, { slug: "Boston", hash: "#r=a;b&m=oneway", now: NOW }));
});

test("listPending returns only pending vanity rows, oldest first", async () => {
  const db = makeD1Mock();
  await requestVanity(db, { slug: "Race2", hash: "#r=a;b&m=oneway", now: NOW + 10 });
  await requestVanity(db, { slug: "Race1", hash: "#r=a;b&m=oneway", now: NOW });
  await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW });
  const pending = await listPending(db);
  assert.equal(pending.length, 2);
  // requestVanity canonicalises slugs to lowercase (case-insensitive resolution).
  assert.deepEqual(pending.map((r) => r.slug), ["race1", "race2"]);
});

test("bumpHits increments the hit counter", async () => {
  const db = makeD1Mock();
  const slug = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW });
  await bumpHits(db, slug);
  await bumpHits(db, slug);
  assert.equal(db._rows.get(slug).hits, 2);
});

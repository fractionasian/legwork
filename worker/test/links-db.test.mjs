import { test } from "node:test";
import assert from "node:assert/strict";
import { createRandomLink, getActive, requestVanity, setStatus, deleteLink, purgeLink, listPending, bumpHits } from "../src/links-db.js";
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

test("createRandomLink is idempotent for an identical hash (re-share returns the same slug)", async () => {
  const db = makeD1Mock();
  const a = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW });
  const b = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW + 1 });
  assert.equal(b, a);
  assert.equal(db._rows.size, 1, "re-share must not mint a second row");
  const c = await createRandomLink(db, { hash: "#r=c;d&m=loop", now: NOW });
  assert.notEqual(c, a, "a different route gets its own slug");
});

test("createRandomLink dedup only matches ACTIVE random rows (purged route re-shares fresh)", async () => {
  const db = makeD1Mock();
  const a = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW });
  await purgeLink(db, a); // random → hard delete
  const b = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW + 1 });
  assert.notEqual(b, a, "deleted row must not be returned by the dedup lookup");
});

test("setStatus reports matched rows: 1 for a pending vanity, 0 for an unknown slug", async () => {
  const db = makeD1Mock();
  await requestVanity(db, { slug: "Boston", hash: "#r=a;b&m=oneway", now: NOW });
  assert.equal(await setStatus(db, "Boston", "active"), 1);
  assert.equal(await setStatus(db, "nosuch", "active"), 0);
});

test("setStatus cannot flip an active random link or re-judge a decided vanity", async () => {
  const db = makeD1Mock();
  const slug = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW });
  assert.equal(await setStatus(db, slug, "rejected"), 0, "random rows are out of scope");
  assert.equal(db._rows.get(slug).status, "active", "random link must be untouched");

  await requestVanity(db, { slug: "Boston", hash: "#r=a;b&m=oneway", now: NOW });
  await setStatus(db, "Boston", "rejected");
  assert.equal(await setStatus(db, "Boston", "active"), 0, "already-decided vanity must not transition again");
  assert.equal(db._rows.get("boston").status, "rejected");
});

test("purgeLink tombstones a vanity slug (reserved forever, never resolves)", async () => {
  const db = makeD1Mock();
  await requestVanity(db, { slug: "Melbourne2027", hash: "#r=a;b&m=loop", now: NOW });
  await setStatus(db, "Melbourne2027", "active");
  assert.equal(await purgeLink(db, "Melbourne2027"), "tombstoned");
  const row = db._rows.get("melbourne2027");
  assert.ok(row, "row must be retained as a tombstone");
  assert.equal(row.status, "purged");
  assert.equal(await getActive(db, "Melbourne2027"), null);
  // The slug stays reserved: a new vanity request for it must be refused.
  await assert.rejects(() => requestVanity(db, { slug: "Melbourne2027", hash: "#r=x;y&m=oneway", now: NOW }));
});

test("purgeLink hard-deletes a random slug and 404s a missing one", async () => {
  const db = makeD1Mock();
  const slug = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW });
  assert.equal(await purgeLink(db, slug), "deleted");
  assert.equal(db._rows.has(slug), false, "random rows reclaim storage");
  assert.equal(await purgeLink(db, "nosuch"), null);
});

test("deleteLink reports how many rows it removed", async () => {
  const db = makeD1Mock();
  const slug = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW });
  assert.equal(await deleteLink(db, slug), 1);
  assert.equal(await deleteLink(db, slug), 0, "second delete matches nothing");
});

test("bumpHits increments the hit counter", async () => {
  const db = makeD1Mock();
  const slug = await createRandomLink(db, { hash: "#r=a;b&m=oneway", now: NOW });
  await bumpHits(db, slug);
  await bumpHits(db, slug);
  assert.equal(db._rows.get(slug).hits, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1Mock } from "./_d1mock.mjs";
import { backupLinks, backupKey } from "../src/backup.js";
import { createRandomLink, requestVanity } from "../src/links-db.js";
import { restoreSql } from "../scripts/restore-links.mjs";

// In-memory R2 with the list/put/delete surface backupLinks uses. pageSize
// forces pagination so the cursor loop is exercised.
function makeBucket(pageSize = 2) {
  const store = new Map();
  return {
    store,
    async put(k, v) { store.set(k, v); },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
    async list({ prefix, cursor }) {
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const objects = all.slice(start, start + pageSize).map((key) => ({ key }));
      const truncated = start + pageSize < all.length;
      return { objects, truncated, cursor: truncated ? String(start + pageSize) : undefined };
    },
  };
}

const NOW = Date.UTC(2026, 10, 1, 17); // Sunday cron, 2026-11-01
const WEEK = 7 * 24 * 3600 * 1000;

test("backup writes every link row without contact or note", async () => {
  const db = makeD1Mock();
  const bucket = makeBucket();
  await createRandomLink(db, { hash: "#r=a", now: 1 });
  await requestVanity(db, { slug: "perth10k", hash: "#r=b", contact: "x@example.com", note: "club", now: 2 });

  const res = await backupLinks(db, bucket, { nowMs: NOW });
  assert.equal(res.key, "backups/links/2026-11-01.json");
  const body = JSON.parse(bucket.store.get(res.key));
  assert.equal(body.count, 2);
  assert.equal(body.rows.length, 2);
  for (const r of body.rows) {
    assert.ok(!("contact" in r) && !("note" in r), "personal fields must not be copied");
  }
  assert.ok(!bucket.store.get(res.key).includes("x@example.com"));
});

test("prune keeps 8 weeks of copies and never touches graph-cache keys", async () => {
  const db = makeD1Mock();
  const bucket = makeBucket();
  for (let w = 1; w <= 10; w++) bucket.store.set(backupKey(NOW - w * WEEK), "{}");
  bucket.store.set("g2:-31.950:115.860:2000", "{}");

  const res = await backupLinks(db, bucket, { nowMs: NOW });
  const kept = [...bucket.store.keys()].filter((k) => k.startsWith("backups/")).sort();
  assert.equal(res.deleted, 2, "weeks 9 and 10 go");
  assert.equal(kept.length, 9, "today + the previous 8 weeks");
  assert.ok(bucket.store.has("g2:-31.950:115.860:2000"));
});

test("prune refuses to delete when an unexpected key sits under the prefix", async () => {
  const db = makeD1Mock();
  const bucket = makeBucket();
  bucket.store.set("backups/links/notes.txt", "x");
  bucket.store.set(backupKey(NOW - 20 * WEEK), "{}");
  await assert.rejects(backupLinks(db, bucket, { nowMs: NOW }), /unexpected key/);
  assert.ok(bucket.store.has(backupKey(NOW - 20 * WEEK)), "nothing deleted after the refusal");
});

test("restore SQL round-trips rows and escapes quotes", () => {
  const backup = {
    version: 1, taken_at: NOW, count: 1,
    rows: [{ slug: "o'neil", hash: "#r=x'y", type: "vanity", status: "active", created_at: 5, hits: 3 }],
  };
  assert.equal(
    restoreSql(backup),
    "INSERT OR IGNORE INTO links (slug, hash, type, status, created_at, hits) VALUES ('o''neil', '#r=x''y', 'vanity', 'active', 5, 3);\n",
  );
});

test("restore rejects a truncated or malformed backup", () => {
  assert.throws(() => restoreSql({ version: 1, count: 2, rows: [] }), /row count/);
  assert.throws(() => restoreSql({ version: 2, count: 0, rows: [] }), /v1/);
  assert.throws(() => restoreSql({ version: 1, count: 1, rows: [{ slug: "a", hash: "h", type: "evil", status: "active", created_at: 1, hits: 0 }] }), /type/);
  assert.throws(() => restoreSql({ version: 1, count: 1, rows: [{ slug: "a", hash: "h", type: "random", status: "active", created_at: "1); DROP TABLE links;--", hits: 0 }] }), /integer/);
});

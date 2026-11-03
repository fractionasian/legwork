import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1Mock } from "./_d1mock.mjs";
import { backupLinks, backupKey, newestBackup } from "../src/backup.js";
import worker from "../src/index.js";
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
const GOOD = "#r=-37.81710,144.97313;-37.81919,144.98498&m=oneway";

test("backup writes every link row without contact or note", async () => {
  const db = makeD1Mock();
  const bucket = makeBucket();
  await createRandomLink(db, { hash: GOOD, now: 1 });
  await requestVanity(db, { slug: "perth10k", hash: GOOD, contact: "x@example.com", note: "club", now: 2 });

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
  await createRandomLink(db, { hash: GOOD, now: 1 });
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
  await createRandomLink(db, { hash: GOOD, now: 1 });
  const bucket = makeBucket();
  bucket.store.set("backups/links/notes.txt", "x");
  bucket.store.set("backups/links/2026-13-40.json", "{}");
  bucket.store.set("backups/links/2099-01-01.json", "{}");
  bucket.store.set(backupKey(NOW - 20 * WEEK), "{}");
  await assert.rejects(backupLinks(db, bucket, { nowMs: NOW }), /unexpected key/);
  assert.ok(bucket.store.has(backupKey(NOW - 20 * WEEK)), "nothing deleted after the refusal");
});

test("an empty table still gets a copy but never prunes the good ones", async () => {
  const db = makeD1Mock();
  const bucket = makeBucket();
  for (let w = 1; w <= 10; w++) bucket.store.set(backupKey(NOW - w * WEEK), "{}");
  const res = await backupLinks(db, bucket, { nowMs: NOW });
  assert.equal(res.count, 0);
  assert.equal(res.deleted, 0);
  assert.equal([...bucket.store.keys()].length, 11);
});

test("restore SQL round-trips a row", () => {
  const backup = {
    version: 1, taken_at: NOW, count: 1,
    rows: [{ slug: "perth10k", hash: GOOD, type: "vanity", status: "active", created_at: 5, hits: 3 }],
  };
  assert.equal(
    restoreSql(backup),
    `INSERT OR IGNORE INTO links (slug, hash, type, status, created_at, hits) VALUES ('perth10k', '${GOOD}', 'vanity', 'active', 5, 3);\n`,
  );
});

test("restore writes a purged tombstone with a blank hash, whatever the copy holds", () => {
  const backup = {
    version: 1, taken_at: NOW, count: 2,
    rows: [
      { slug: "abc234", hash: "", type: "random", status: "purged", created_at: 1, hits: 0 },
      // An older vanity tombstone that still carried its route.
      { slug: "perth10k", hash: GOOD, type: "vanity", status: "purged", created_at: 2, hits: 4 },
    ],
  };
  assert.equal(
    restoreSql(backup),
    "INSERT OR IGNORE INTO links (slug, hash, type, status, created_at, hits) VALUES ('abc234', '', 'random', 'purged', 1, 0);\n" +
    "INSERT OR IGNORE INTO links (slug, hash, type, status, created_at, hits) VALUES ('perth10k', '', 'vanity', 'purged', 2, 4);\n",
  );
});

test("restore refuses a planted redirect or a malformed slug", () => {
  const row = (o) => ({ version: 1, count: 1, rows: [{ slug: "abc234", hash: GOOD, type: "random", status: "active", created_at: 1, hits: 0, ...o }] });
  assert.doesNotThrow(() => restoreSql(row({})));
  assert.throws(() => restoreSql(row({ hash: "javascript:alert(1)" })), /bad hash/);
  assert.throws(() => restoreSql(row({ hash: "#r=1,2;3,4&m=oneway'); DROP TABLE links;--" })), /bad hash/);
  assert.throws(() => restoreSql(row({ slug: "o'neil" })), /bad slug/);
  assert.throws(() => restoreSql(row({ slug: "admin", type: "vanity" })), /bad slug/);
});

test("restore rejects a truncated or malformed backup", () => {
  assert.throws(() => restoreSql({ version: 1, count: 2, rows: [] }), /row count/);
  assert.throws(() => restoreSql({ version: 2, count: 0, rows: [] }), /v1/);
  assert.throws(() => restoreSql({ version: 1, count: 1, rows: [{ slug: "abc234", hash: GOOD, type: "evil", status: "active", created_at: 1, hits: 0 }] }), /type/);
  assert.throws(() => restoreSql({ version: 1, count: 1, rows: [{ slug: "abc234", hash: GOOD, type: "random", status: "active", created_at: "1); DROP TABLE links;--", hits: 0 }] }), /integer/);
});

test("newestBackup is null on an empty bucket", async () => {
  assert.deepEqual(await newestBackup(makeBucket(), { nowMs: NOW }), { newest: null });
});

test("newestBackup returns the latest date across pages, ignoring stray keys", async () => {
  const bucket = makeBucket();
  for (const w of [3, 2, 1]) bucket.store.set(backupKey(NOW - w * WEEK), "{}");
  bucket.store.set("backups/links/notes.txt", "x");
  bucket.store.set("backups/links/2026-13-40.json", "{}");
  bucket.store.set("backups/links/2099-01-01.json", "{}");
  bucket.store.set("g2:-31.950:115.860:2000", "{}");
  const status = await newestBackup(bucket, { nowMs: NOW + 2 * 24 * 3600 * 1000 });
  assert.deepEqual(status, { newest: "2026-10-25", age_days: 9 });
});

test("newestBackup skips a rolled-over date like Feb 31", async () => {
  const bucket = makeBucket();
  bucket.store.set("backups/links/2026-02-28.json", "{}");
  bucket.store.set("backups/links/2026-02-31.json", "{}"); // Date.parse makes this 3 March
  const status = await newestBackup(bucket, { nowMs: Date.UTC(2026, 3, 1) });
  assert.equal(status.newest, "2026-02-28");
});

test("GET /v1/backup-status returns only the date and age, no-store, CORS", async () => {
  const bucket = makeBucket();
  bucket.store.set(backupKey(Date.now()), JSON.stringify({ count: 3, rows: [{ slug: "abc234" }] }));
  const res = await worker.fetch(new Request("https://w.dev/v1/backup-status"), { BACKUP: bucket }, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["age_days", "newest"]);
  assert.equal(body.age_days, 0);
});

test("GET /v1/backup-status is rate limited and errors as a no-store 500", async () => {
  const limited = await worker.fetch(new Request("https://w.dev/v1/backup-status"),
    { BACKUP: makeBucket(), STATUS_RL: { limit: async () => ({ success: false }) } }, {});
  assert.equal(limited.status, 429);
  const broken = { list: async () => { throw new Error("r2 down"); } };
  const realError = console.error;
  console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://w.dev/v1/backup-status"), { BACKUP: broken }, {});
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally { console.error = realError; }
});

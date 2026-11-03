// Weekly copy of the share-links table into R2.
//
// Why: D1 Time Travel only reaches back 7 days on Workers Free (30 on Paid,
// developers.cloudflare.com/d1/reference/time-travel/, checked 2026-10-31). A
// deleted database, or damage noticed after a week, would break every shared
// link. One copy a week plus that 7-day window leaves no gap.
//
// Own bucket (BACKUP), not the graph cache: the cache is planned to get a
// bucket-wide expiry rule and is the kind of bucket people empty to clean up
// (docs/2026-06-10-review-deferred.md, 2026-08-30-review-deferred.md). Either
// would silently cut the backups back to nothing. No request handler reads
// this bucket.
//
// contact/note are left out on purpose: they're the only personal fields, and
// all they'd let us recover is pending vanity requests. Everything a working
// link needs (slug -> hash, plus status so purged tombstones keep their slug
// reserved) is in the copy.

export const BACKUP_PREFIX = "backups/links/";
export const BACKUP_KEEP_WEEKS = 8;
export const BACKUP_KEY_RE = /^backups\/links\/\d{4}-\d{2}-\d{2}\.json$/;

export function backupKey(nowMs) {
  return BACKUP_PREFIX + new Date(nowMs).toISOString().slice(0, 10) + ".json";
}

export async function backupLinks(db, bucket, { nowMs, keepWeeks = BACKUP_KEEP_WEEKS }) {
  const { results } = await db
    .prepare("SELECT slug, hash, type, status, created_at, hits FROM links ORDER BY slug")
    .all();
  const key = backupKey(nowMs);
  const body = JSON.stringify({ version: 1, taken_at: nowMs, count: results.length, rows: results });
  await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });

  // An empty table is the disaster this exists for (database recreated, rows
  // gone). Keep writing the weekly copy, but never prune then — or 8 weeks on
  // the last copies with real rows would age out.
  if (results.length === 0) {
    console.error(`links backup: ${key} rows=0 — table empty, prune skipped`);
    return { key, count: 0, deleted: 0 };
  }

  // Prune old copies. Scope is enforced twice: the list is prefix-filtered, and
  // every key must match the exact backup filename shape before it can be
  // deleted — so a bug here can never touch a graph-cache object.
  const cutoff = backupKey(nowMs - keepWeeks * 7 * 24 * 3600 * 1000);
  const old = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    for (const obj of page.objects) {
      if (!BACKUP_KEY_RE.test(obj.key)) throw new Error("backup prune: unexpected key " + obj.key);
      if (obj.key < cutoff) old.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (old.length) await bucket.delete(old);

  // ponytail: one .all() + one JSON string, fine to low thousands of rows; past
  // that, page the SELECT and use a multipart put. count/bytes logged to watch.
  console.log(`links backup: ${key} rows=${results.length} bytes=${body.length} pruned=${old.length}`);
  return { key, count: results.length, deleted: old.length };
}

// Newest backup date for GET /v1/backup-status, so the morning briefing can
// warn when the weekly copy stops landing (cron failures only reach
// console.error). Returns the date and nothing else: no keys, counts or rows.
// Keys sort by date, so the last matching key is the newest; anything not
// shaped like a backup filename is ignored rather than reported.
export async function newestBackup(bucket, { nowMs }) {
  let newest = null;
  let cursor;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    for (const obj of page.objects) {
      if (BACKUP_KEY_RE.test(obj.key) && (newest === null || obj.key > newest)) newest = obj.key;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (newest === null) return { newest: null };
  const date = newest.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
  return { newest: date, age_days: Math.floor((nowMs - Date.parse(date)) / 86400000) };
}

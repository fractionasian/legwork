// Weekly copy of the share-links table into R2.
//
// Why: D1 Time Travel only reaches back 7 days on Workers Free (30 on Paid,
// developers.cloudflare.com/d1/reference/time-travel/, checked 2026-10-31). A
// deleted database, or damage noticed after a week, would break every shared
// link. One copy a week plus that 7-day window leaves no gap.
//
// Lives in the existing GRAPH bucket under its own prefix. Graph cache keys are
// "g2:<lat>:<lon>:<r>", built only from snapped numbers in handleGraph, so no
// request can read a backup key.
//
// contact/note are left out on purpose: they're the only personal fields, and
// all they'd let us recover is pending vanity requests. Everything a working
// link needs (slug -> hash, plus status so purged tombstones keep their slug
// reserved) is in the copy.

export const BACKUP_PREFIX = "backups/links/";
export const BACKUP_KEEP_WEEKS = 8;
const BACKUP_KEY_RE = /^backups\/links\/\d{4}-\d{2}-\d{2}\.json$/;

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

  return { key, count: results.length, deleted: old.length };
}

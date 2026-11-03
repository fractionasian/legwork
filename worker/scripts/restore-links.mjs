#!/usr/bin/env node
// Turn a weekly share-links backup (see src/backup.js) into SQL for D1.
//
//   npx wrangler r2 object get legwork-links-backup/backups/links/<date>.json --remote --file backup.json
//   node scripts/restore-links.mjs backup.json > restore.sql
//   npx wrangler d1 execute legwork-links --remote --file restore.sql
//
// INSERT OR IGNORE: rows already in the table win, so restoring onto a partly
// damaged table only fills the gaps and never rolls a live link back.
//
// Before restoring:
//  - Damage within the last 7 days? Use D1 Time Travel instead
//    (`wrangler d1 time-travel restore`) — it's exact; this is a week old.
//  - A purge after `taken_at` isn't in the copy, so that link comes back as
//    it was. Purged rows stay in the table as tombstones (src/links-db.js
//    purgeLink), so on a partial restore INSERT OR IGNORE skips them; on a
//    restore into an empty table, re-apply any admin purges made after
//    `taken_at` (printed to stderr below).
//  - Random links purged before tombstoning landed (PR #46, 2026-11-03) were
//    hard-deleted and have no tombstone, so a copy older than that purge
//    brings them back active even on a partial restore. Until every copy
//    postdates PR #46 (BACKUP_KEEP_WEEKS after deploy), re-apply those purges.
//  - Purged rows are written with a blank hash whatever the copy holds, so a
//    restore never puts a taken-down route back in the table.
//  - Not in a copy: links made since `taken_at`, and contact/note on pending
//    vanity requests (excluded on purpose).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateRouteHash, validateVanitySlug, ALPHABET } from "../src/links-lib.js";

const TYPES = new Set(["random", "vanity"]);
const STATUSES = new Set(["active", "pending", "rejected", "purged"]);
const RANDOM_SLUG_RE = new RegExp(`^[${ALPHABET}]{6}$`);

const sqlText = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sqlInt = (n) => {
  if (!Number.isSafeInteger(n)) throw new Error("not an integer: " + n);
  return String(n);
};

export function restoreSql(backup) {
  if (backup?.version !== 1 || !Array.isArray(backup.rows)) throw new Error("not a v1 links backup");
  if (backup.rows.length !== backup.count) throw new Error(`row count ${backup.rows.length} != header ${backup.count}`);
  const lines = backup.rows.map((r) => {
    if (!TYPES.has(r.type) || !STATUSES.has(r.status)) throw new Error("bad type/status on " + r.slug);
    // A tombstone keeps only its slug. Older copies can hold a purged row's
    // route (vanity tombstones kept it before purge blanked the hash), so drop
    // it here rather than validate it.
    const hash = r.status === "purged" ? "" : r.hash;
    // Same boundary the live API enforces: a restored link can only ever be a
    // route under a well-formed slug, so an edited backup can't plant a redirect.
    if (r.status !== "purged") {
      const v = validateRouteHash(hash);
      if (!v.ok) throw new Error(`bad hash on ${r.slug}: ${v.reason}`);
    }
    const slugOk = r.type === "vanity" ? validateVanitySlug(r.slug).ok : RANDOM_SLUG_RE.test(r.slug);
    if (!slugOk) throw new Error("bad slug " + r.slug);
    return "INSERT OR IGNORE INTO links (slug, hash, type, status, created_at, hits) VALUES (" +
      [sqlText(r.slug), sqlText(hash), sqlText(r.type), sqlText(r.status), sqlInt(r.created_at), sqlInt(r.hits)].join(", ") +
      ");";
  });
  return lines.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("usage: restore-links.mjs <backup.json>"); process.exit(2); }
  const backup = JSON.parse(readFileSync(file, "utf8"));
  const sql = restoreSql(backup);
  console.error(`backup taken ${new Date(backup.taken_at).toISOString()}, ${backup.count} rows — re-apply purges made after this`);
  process.stdout.write(sql);
}

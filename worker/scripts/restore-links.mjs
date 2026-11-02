#!/usr/bin/env node
// Turn a weekly share-links backup (see src/backup.js) into SQL for D1.
//
//   npx wrangler r2 object get legwork-graph-cache/backups/links/<date>.json --remote --file backup.json
//   node scripts/restore-links.mjs backup.json > restore.sql
//   npx wrangler d1 execute legwork-links --remote --file restore.sql
//
// INSERT OR IGNORE: rows already in the table win, so restoring onto a partly
// damaged table only fills the gaps and never rolls a live link back.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TYPES = new Set(["random", "vanity"]);
const STATUSES = new Set(["active", "pending", "rejected", "purged"]);

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
    return "INSERT OR IGNORE INTO links (slug, hash, type, status, created_at, hits) VALUES (" +
      [sqlText(r.slug), sqlText(r.hash), sqlText(r.type), sqlText(r.status), sqlInt(r.created_at), sqlInt(r.hits)].join(", ") +
      ");";
  });
  return lines.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("usage: restore-links.mjs <backup.json>"); process.exit(2); }
  process.stdout.write(restoreSql(JSON.parse(readFileSync(file, "utf8"))));
}

// D1 data-access for share short-links. Thin prepared-statement calls; the SQL
// strings here are the real ones wrangler runs against D1. Pure orchestration
// (collision retry, status filtering) is exercised against an in-memory mock in
// links-db.test.mjs; SQL correctness is checked at integration (wrangler d1).
import { genSlug as defaultGenSlug } from "./links-lib.js";

function isUniqueViolation(e) {
  return /UNIQUE constraint failed/i.test(String(e && e.message));
}

export class TakenError extends Error {
  constructor(slug) {
    super("slug taken: " + slug);
    this.name = "TakenError";
    this.slug = slug;
  }
}

// Mint a random active link. Retries on the (astronomically rare) slug collision
// up to `tries` times; throws if it somehow can't find a free code.
export async function createRandomLink(db, { hash, now, genSlug = defaultGenSlug, tries = 5 }) {
  // Idempotent re-share: the same route shared twice gets the SAME slug instead
  // of minting a fresh row each time (re-sharing is common — same user, or two
  // people sharing one route). Only active random rows dedup; vanity slugs are
  // user-chosen names, not content-addressed.
  const existing = await db
    .prepare("SELECT slug FROM links WHERE hash = ? AND type = 'random' AND status = 'active' LIMIT 1")
    .bind(hash)
    .first();
  if (existing) return existing.slug;

  for (let i = 0; i < tries; i++) {
    const slug = genSlug();
    try {
      await db
        .prepare("INSERT INTO links (slug, hash, type, status, created_at, hits) VALUES (?, ?, 'random', 'active', ?, 0)")
        .bind(slug, hash, now)
        .run();
      return slug;
    } catch (e) {
      if (isUniqueViolation(e)) continue; // collision — try a fresh code
      throw e;
    }
  }
  throw new Error("could not allocate a free slug after " + tries + " tries");
}

// Resolve a slug — only 'active' rows resolve, so pending/rejected/purged are 404.
// Slugs are stored lowercase (random codes already are; vanity is canonicalised
// in validateVanitySlug), so lowercase the lookup to make resolution
// case-insensitive regardless of how the user typed the URL.
export async function getActive(db, slug) {
  return db
    .prepare("SELECT * FROM links WHERE slug = ? AND status = 'active'")
    .bind(String(slug).toLowerCase())
    .first();
}

// Park a custom vanity request as 'pending' (reserves the slug without making it
// live). Throws TakenError if the slug already exists in any status.
export async function requestVanity(db, { slug, hash, contact = null, note = null, now }) {
  try {
    await db
      .prepare("INSERT INTO links (slug, hash, type, status, created_at, hits, contact, note) VALUES (?, ?, 'vanity', 'pending', ?, 0, ?, ?)")
      .bind(String(slug).toLowerCase(), hash, now, contact, note)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) throw new TakenError(slug);
    throw e;
  }
}

// Approve/reject a vanity request. The WHERE clause is deliberately narrow:
// only pending vanity rows can transition, so a typo'd slug in the admin call
// can never flip an active random link (or re-judge an already-decided one).
// Returns the matched-row count so the handler can 404 a no-op.
export async function setStatus(db, slug, status) {
  const { meta } = await db
    .prepare("UPDATE links SET status = ? WHERE slug = ? AND type = 'vanity' AND status = 'pending'")
    .bind(status, String(slug).toLowerCase())
    .run();
  return meta.changes;
}

// Hard-delete a link row. Returns the deleted-row count so callers can 404 a
// miss. Only safe for RANDOM slugs — see purgeLink for why vanity must not be
// hard-deleted.
export async function deleteLink(db, slug) {
  const { meta } = await db.prepare("DELETE FROM links WHERE slug = ?").bind(String(slug).toLowerCase()).run();
  return meta.changes;
}

// Admin purge, split by type:
//  - VANITY → tombstone (status='purged', the status the schema documents).
//    Hard-deleting would free the slug, and a previously circulated vanity URL
//    could later resolve to someone else's route — the slug stays reserved.
//  - RANDOM → hard DELETE. Storage is actually reclaimed, and the 31^6 keyspace
//    makes a reuse collision on a re-minted code negligible.
// Returns "tombstoned" | "deleted", or null when the slug doesn't exist.
export async function purgeLink(db, slug) {
  const s = String(slug).toLowerCase();
  const row = await db.prepare("SELECT type FROM links WHERE slug = ?").bind(s).first();
  if (!row) return null;
  if (row.type === "vanity") {
    await db.prepare("UPDATE links SET status = ? WHERE slug = ?").bind("purged", s).run();
    return "tombstoned";
  }
  await deleteLink(db, s);
  return "deleted";
}

export async function listPending(db) {
  const { results } = await db
    .prepare("SELECT slug, hash, contact, note, created_at FROM links WHERE status = 'pending' ORDER BY created_at")
    .all();
  return results || [];
}

export async function bumpHits(db, slug) {
  await db.prepare("UPDATE links SET hits = hits + 1 WHERE slug = ?").bind(String(slug).toLowerCase()).run();
}

-- Idempotent re-share dedup looks links up by hash (links-db.js getActiveBy
-- Hash); without an index every unauthenticated POST /api/links full-scans the
-- table, and rows never expire, so the per-request rows-read cost grows
-- monotonically against the shared D1 daily read quota.
CREATE INDEX IF NOT EXISTS idx_links_hash ON links(hash);

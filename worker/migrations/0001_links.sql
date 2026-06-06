-- Share short-links. One row per link; one namespace for random + vanity slugs.
CREATE TABLE IF NOT EXISTS links (
  slug        TEXT PRIMARY KEY,          -- random 6-char code OR a requested vanity word
  hash        TEXT NOT NULL,             -- route payload: "#r=...&m=..." (compressed form preferred)
  type        TEXT NOT NULL,             -- 'random' | 'vanity'
  status      TEXT NOT NULL,             -- 'active' | 'pending' | 'rejected' | 'purged'
  created_at  INTEGER NOT NULL,          -- epoch ms
  hits        INTEGER NOT NULL DEFAULT 0,
  contact     TEXT,                      -- vanity requests: who to reach re approval
  note        TEXT                       -- vanity: event name / admin note
);
CREATE INDEX IF NOT EXISTS idx_status ON links(status);

-- Supports the daily link-creation cap (countCreatedSince in links-db.js):
-- a COUNT over the last 24 h reads only that window's index entries instead of
-- scanning the whole table on every create.
CREATE INDEX IF NOT EXISTS idx_links_created ON links(created_at);

-- Vanity tombstones purged before purgeLink blanked the hash (links-db.js)
-- still hold their route, and each weekly R2 copy carries it again. Drop it
-- so every tombstone is the same: slug reserved, no route stored.
UPDATE links SET hash = '' WHERE status = 'purged' AND hash != '';

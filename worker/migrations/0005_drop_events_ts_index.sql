-- D1 bills one extra row written per index on a written column, so every
-- `events` insert cost 3 billed rows. idx_events_ts served only the weekly
-- retention DELETE (analytics-db.js pruneOld), which can scan the table
-- instead: one scan a week is cheap reads, while the index cost a write on
-- every event. Dropping it takes an insert from 3 billed rows to 2.
-- idx_events_name stays: it serves queries filtered by event name.
DROP INDEX IF EXISTS idx_events_ts;

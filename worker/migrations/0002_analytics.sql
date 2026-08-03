-- Legwork self-hosted analytics. Replaces the Umami Cloud API path, which moved
-- behind a paid tier in June 2026.
--
-- Privacy: no session id, no IP, no route geometry, no exact distances. `props`
-- holds enum/bucket values only, validated against a server-side allowlist
-- before insert. `country` is request.cf.country — country granularity only.

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  name    TEXT    NOT NULL,
  props   TEXT,
  country TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, ts);

-- One row per (grid cell, ISO week). The cell reuses the existing 0.005 deg
-- cache grid, so this stores no coordinate the Worker was not already computing.
CREATE TABLE IF NOT EXISTS demand (
  cell TEXT    NOT NULL,
  week TEXT    NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cell, week)
);

CREATE INDEX IF NOT EXISTS idx_demand_week ON demand(week);

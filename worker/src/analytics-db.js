// D1 statements for analytics. Deliberately thin: every value reaching here has
// already been validated by analytics-lib.js. Do not add validation in this file
// — one validation site is the point.

const EVENT_RETENTION_DAYS = 180;
const DEMAND_RETENTION_WEEKS = 104;

export async function insertEvent(db, { ts, name, props, country }) {
  await db
    .prepare("INSERT INTO events (ts, name, props, country) VALUES (?, ?, ?, ?)")
    .bind(ts, name, JSON.stringify(props ?? {}), country ?? null)
    .run();
}

// First hit inserts, subsequent hits increment. ON CONFLICT against the
// (cell, week) primary key keeps this a single round trip — a read-then-write
// would race under concurrent pin drops in the same cell and lose counts.
export async function bumpDemand(db, { cell, week }) {
  await db
    .prepare(
      "INSERT INTO demand (cell, week, hits) VALUES (?, ?, 1) " +
      "ON CONFLICT(cell, week) DO UPDATE SET hits = hits + 1",
    )
    .bind(cell, week)
    .run();
}

// Retention. Without this an unbounded table eventually meets D1's 5 GB ceiling
// — remote at Legwork's volume, but the job is cheap and removes the need to
// think about it again.
export async function pruneOld(db, { nowSeconds }) {
  const cutoffTs = nowSeconds - EVENT_RETENTION_DAYS * 24 * 3600;
  const ev = await db.prepare("DELETE FROM events WHERE ts < ?").bind(cutoffTs).run();

  const cutoffDate = new Date((nowSeconds - DEMAND_RETENTION_WEEKS * 7 * 24 * 3600) * 1000);
  const cutoffWeek = cutoffDate.getUTCFullYear() + "-W00";
  const dm = await db.prepare("DELETE FROM demand WHERE week < ?").bind(cutoffWeek).run();

  return { events: ev.meta.changes ?? 0, demand: dm.meta.changes ?? 0 };
}

// Minimal in-memory stand-in for a Cloudflare D1 binding. It pattern-matches the
// specific statements links-db.js issues (real SQL strings — wrangler runs the
// same ones against actual D1) and enforces the slug PRIMARY KEY so the
// collision-retry and vanity-taken paths are exercised. Not a general SQL engine.
export function makeD1Mock() {
  const rows = new Map(); // slug -> row
  const events = [];              // event rows, insertion-ordered
  const demand = new Map();       // "cell|week" -> hits

  function prepare(sql) {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },

      async run() {
        if (/^\s*INSERT\s+INTO\s+events/i.test(sql)) {
          const [ts, name, props, country] = args;
          events.push({ id: events.length + 1, ts, name, props, country: country ?? null });
          return { success: true, meta: { changes: 1 } };
        }
        if (/^\s*INSERT\s+INTO\s+demand/i.test(sql)) {
          const [cell, week] = args;
          const key = cell + "|" + week;
          demand.set(key, (demand.get(key) ?? 0) + 1);
          return { success: true, meta: { changes: 1 } };
        }
        if (/^\s*DELETE\s+FROM\s+events/i.test(sql)) {
          const [cutoff] = args;
          const before = events.length;
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].ts < cutoff) events.splice(i, 1);
          }
          return { success: true, meta: { changes: before - events.length } };
        }
        if (/^\s*DELETE\s+FROM\s+demand/i.test(sql)) {
          const [cutoffWeek] = args;
          let changes = 0;
          for (const key of [...demand.keys()]) {
            if (key.split("|")[1] < cutoffWeek) { demand.delete(key); changes++; }
          }
          return { success: true, meta: { changes } };
        }
        if (/^\s*INSERT\s+INTO\s+links/i.test(sql)) {
          const isVanity = sql.includes("'vanity'");
          const slug = args[0];
          if (rows.has(slug)) {
            throw new Error("D1_ERROR: UNIQUE constraint failed: links.slug");
          }
          const row = isVanity
            ? { slug, hash: args[1], type: "vanity", status: "pending",
                created_at: args[2], hits: 0, contact: args[3] ?? null, note: args[4] ?? null }
            : { slug, hash: args[1], type: "random", status: "active",
                created_at: args[2], hits: 0, contact: null, note: null };
          rows.set(slug, row);
          return { success: true, meta: { changes: 1 } };
        }
        if (/^\s*UPDATE\s+links\s+SET\s+status/i.test(sql)) {
          const [status, slug] = args;
          const r = rows.get(slug);
          // setStatus constrains to pending vanity rows; purge's tombstone
          // update is unconstrained. Honour whichever WHERE the SQL carries.
          const constrained = /type\s*=\s*'vanity'/i.test(sql) && /status\s*=\s*'pending'/i.test(sql);
          const matched = !!r && (!constrained || (r.type === "vanity" && r.status === "pending"));
          if (matched) r.status = status;
          return { success: true, meta: { changes: matched ? 1 : 0 } };
        }
        if (/^\s*UPDATE\s+links\s+SET\s+hits/i.test(sql)) {
          const [slug] = args;
          if (rows.has(slug)) rows.get(slug).hits += 1;
          return { success: true, meta: { changes: rows.has(slug) ? 1 : 0 } };
        }
        if (/^\s*DELETE\s+FROM\s+links/i.test(sql)) {
          const [slug] = args;
          const existed = rows.delete(slug);
          return { success: true, meta: { changes: existed ? 1 : 0 } };
        }
        throw new Error("d1mock: unhandled run() sql: " + sql);
      },

      async first() {
        // Dedup lookup (createRandomLink): WHERE hash = ?. Must be checked
        // BEFORE the slug+active branch — this SQL also says status='active'.
        if (/WHERE\s+hash\s*=\s*\?/i.test(sql)) {
          const hash = args[0];
          const r = [...rows.values()].find(
            (x) => x.hash === hash && x.type === "random" && x.status === "active",
          );
          return r ? { ...r } : null;
        }
        if (/status\s*=\s*'active'/i.test(sql)) {
          const slug = args[0];
          const r = rows.get(slug);
          return r && r.status === "active" ? { ...r } : null;
        }
        if (/WHERE\s+slug\s*=\s*\?/i.test(sql)) {
          const r = rows.get(args[0]);
          return r ? { ...r } : null;
        }
        throw new Error("d1mock: unhandled first() sql: " + sql);
      },

      async all() {
        if (/status\s*=\s*'pending'/i.test(sql)) {
          const results = [...rows.values()]
            .filter((r) => r.status === "pending")
            .sort((a, b) => a.created_at - b.created_at)
            .map((r) => ({ ...r }));
          return { results, success: true };
        }
        throw new Error("d1mock: unhandled all() sql: " + sql);
      },
    };
    return stmt;
  }

  return { prepare, _rows: rows, _events: events, _demand: demand };
}

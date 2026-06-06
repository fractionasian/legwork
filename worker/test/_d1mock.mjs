// Minimal in-memory stand-in for a Cloudflare D1 binding. It pattern-matches the
// specific statements links-db.js issues (real SQL strings — wrangler runs the
// same ones against actual D1) and enforces the slug PRIMARY KEY so the
// collision-retry and vanity-taken paths are exercised. Not a general SQL engine.
export function makeD1Mock() {
  const rows = new Map(); // slug -> row

  function prepare(sql) {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },

      async run() {
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
          if (rows.has(slug)) rows.get(slug).status = status;
          return { success: true, meta: { changes: rows.has(slug) ? 1 : 0 } };
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

  return { prepare, _rows: rows };
}

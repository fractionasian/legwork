import { OVERPASS_URL, buildOverpassQuery, parseGraphParams, cacheKey, snap, snapRadius } from "./lib.js";
import { validateRouteHash, validateVanitySlug, apiCors, json } from "./links-lib.js";
import { createRandomLink, getActive, requestVanity, setStatus, purgeLink, listPending, bumpHits, TakenError } from "./links-db.js";

// App now lives at legwork.day (github.io/legwork stays as a working alias).
// APP_BASE builds the short-link URLs returned by POST /api/links.
const APP_BASE = "https://legwork.day";

// Overpass-api.de returns HTTP 406 to requests with a missing or generic
// User-Agent (its usage policy requires an identifying UA). A browser sends its
// own UA so the client path works; a Worker subrequest must set one explicitly.
// (Workers — unlike browsers — allow setting User-Agent on outbound fetch.)
const OVERPASS_UA = "Legwork/1.0 (+https://legwork.day)";

// Workers Cache is enabled worker-wide (wrangler.toml [cache]), so every GET
// response's Cache-Control decides its own cacheability — there's no per-route
// opt-out otherwise. R2 has no TTL (path geometry changes slowly enough that
// staleness is acceptable — see the R2-cache rationale below), so a "revalidate"
// during the stale-while-revalidate window always re-hits R2, never Overpass;
// it does not refresh the underlying data. What it buys is edge latency: past
// the 1-day fresh window, requests get the last-known response immediately
// while one background request re-warms the edge cache, instead of blocking
// on a live R2 lookup. Every other response is explicitly no-store so a
// transient error or a mutable /api/* read is never served stale from the edge.
const GRAPH_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=2592000";

function cors(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    // Stops browsers MIME-sniffing the graph JSON into something executable.
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

async function handleGraph(request, url, env, ctx) {
  // Per-IP rate limit (native Workers binding). Guarded so the handler still
  // works if the binding is absent (e.g. in unit tests without it).
  if (env.GRAPH_RL) {
    const ip = request.headers.get("cf-connecting-ip") || "anon";
    const { success } = await env.GRAPH_RL.limit({ key: ip });
    if (!success) {
      return new Response("rate limited", { status: 429, headers: cors({ "retry-after": "60", "cache-control": "no-store" }) });
    }
  }

  const p = parseGraphParams(url);
  if (!p.ok) return new Response(p.error, { status: 400, headers: cors({ "cache-control": "no-store" }) });

  // Snap the pin to the shared grid: nearby pins collapse to one cell so they
  // share a single cached fetch. Both the key and the Overpass centre use the
  // snapped coords (see snap()/GRID_DEG in lib.js). The radius is bucketed for
  // the same reason — see snapRadius()/RADIUS_BUCKETS.
  const slat = snap(p.lat);
  const slon = snap(p.lon);
  const sradius = snapRadius(p.radius);
  const key = cacheKey(slat, slon, sradius);

  const hit = await env.GRAPH.get(key);
  if (hit) {
    return new Response(hit.body, {
      status: 200,
      headers: cors({ "content-type": "application/json", "cache-status": "hit", "cache-control": GRAPH_CACHE_CONTROL }),
    });
  }

  const query = buildOverpassQuery(slat, slon, sradius);
  let r;
  try {
    r = await fetch(OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": OVERPASS_UA,
      },
    });
  } catch (e) {
    return new Response("overpass unreachable", { status: 502, headers: cors({ "cache-status": "miss-overpass-error", "cache-control": "no-store" }) });
  }
  if (!r.ok) {
    return new Response("overpass " + r.status, { status: 502, headers: cors({ "cache-status": "miss-overpass-error", "cache-control": "no-store" }) });
  }

  const text = await r.text();
  // Don't block the response on the R2 write — fire it after the response flushes.
  ctx.waitUntil(env.GRAPH.put(key, text));
  return new Response(text, {
    status: 200,
    headers: cors({ "content-type": "application/json", "cache-status": "miss", "cache-control": GRAPH_CACHE_CONTROL }),
  });
}

// ── Share short-links (/api/*) ──────────────────────────────────────────────

async function readJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

function adminOk(request, env) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return !!env.ADMIN_SECRET && !!m && m[1] === env.ADMIN_SECRET;
}

async function rateLimited(request, env) {
  if (!env.LINKS_RL) return false; // binding absent (e.g. tests) → don't block
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  const { success } = await env.LINKS_RL.limit({ key: ip });
  return !success;
}

// Exported for unit tests. Handles every /api/* route; leaves /v1/* to handleGraph.
// Wraps the real handler so an uncaught error (D1 outage, bug) returns a JSON
// 500 WITH CORS headers — without this it surfaces as a Workers 1101, which has
// no CORS headers, so the browser reports an opaque network failure instead of
// a server error the client can show. console.error keeps the underlying cause
// visible in `wrangler tail`.
export async function handleApi(request, env, ctx) {
  try {
    return await handleApiInner(request, env, ctx);
  } catch (e) {
    console.error("handleApi:", e);
    return json({ error: "server error" }, 500);
  }
}

async function handleApiInner(request, env, ctx) {
  const url = new URL(request.url);
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: apiCors() });

  const seg = url.pathname.split("/").filter(Boolean); // ["api", ...]

  // POST /api/links { hash } → mint a random short code
  if (method === "POST" && seg.length === 2 && seg[1] === "links") {
    if (await rateLimited(request, env)) return json({ error: "rate limited" }, 429);
    const body = await readJson(request);
    if (!body) return json({ error: "bad json" }, 400);
    const v = validateRouteHash(body.hash);
    if (!v.ok) return json({ error: "not a valid route: " + v.reason }, 400);
    const slug = await createRandomLink(env.DB, { hash: v.hash, now: Date.now() });
    // Pretty bare path (legwork.day/<slug>); 404.html routes it to the ?s= resolver.
    return json({ slug, url: APP_BASE + "/" + slug }, 200);
  }

  // GET /api/links/:slug → resolve (active only)
  if (method === "GET" && seg.length === 3 && seg[1] === "links") {
    // Same per-IP limit as the creates: an unthrottled resolve loop would burn
    // D1 read quota. 20/60s is generous for the legitimate hot path — a human
    // opening shared links uses far fewer than 20/min.
    if (await rateLimited(request, env)) return json({ error: "rate limited" }, 429);
    const row = await getActive(env.DB, seg[2]);
    if (!row) return json({ error: "not found" }, 404);
    // Sample hit-counting: a write on EVERY resolve would let an unauthenticated
    // GET flood exhaust D1's daily write quota (account-wide). At 1% the count is
    // a ~100× undercount (multiply for an estimate) but the write rate is bounded.
    if (Math.random() < 0.01) ctx.waitUntil(bumpHits(env.DB, seg[2]));
    return json({ hash: row.hash }, 200);
  }

  // POST /api/vanity { slug, hash, contact?, note? } → park a pending request
  if (method === "POST" && seg.length === 2 && seg[1] === "vanity") {
    if (await rateLimited(request, env)) return json({ error: "rate limited" }, 429);
    const body = await readJson(request);
    if (!body) return json({ error: "bad json" }, 400);
    const sv = validateVanitySlug(body.slug || "");
    if (!sv.ok) return json({ error: "bad slug: " + sv.reason }, 400);
    const rv = validateRouteHash(body.hash);
    if (!rv.ok) return json({ error: "not a valid route: " + rv.reason }, 400);
    // contact/note are free-text and admin-reviewed — bound their size so a
    // request can't write an oversized blob to D1 (and keep the admin list sane).
    const contact = body.contact == null ? null : String(body.contact);
    const note = body.note == null ? null : String(body.note);
    if (contact !== null && contact.length > 200) return json({ error: "contact too long (max 200)" }, 400);
    if (note !== null && note.length > 1000) return json({ error: "note too long (max 1000)" }, 400);
    try {
      await requestVanity(env.DB, {
        slug: sv.slug, hash: rv.hash,
        contact, note, now: Date.now(),
      });
    } catch (e) {
      if (e instanceof TakenError) return json({ error: "slug taken" }, 409);
      throw e;
    }
    return json({ status: "pending" }, 200);
  }

  // Admin (Bearer ADMIN_SECRET): approve/reject vanity, purge, list pending
  if (seg[1] === "admin") {
    if (!adminOk(request, env)) return json({ error: "unauthorized" }, 401);
    if (method === "GET" && seg.length === 3 && seg[2] === "pending") {
      return json({ pending: await listPending(env.DB) }, 200);
    }
    if (method === "POST" && seg.length === 4 && seg[2] === "vanity") {
      const body = (await readJson(request)) || {};
      // Explicit allowlist: a typo'd action ("aprove") must not silently
      // reject someone's request.
      if (body.action !== "approve" && body.action !== "reject") {
        return json({ error: "action must be 'approve' or 'reject'" }, 400);
      }
      const status = body.action === "approve" ? "active" : "rejected";
      // 0 changes ⇒ no pending vanity row by that slug (unknown, already
      // decided, or a random link) — tell the admin instead of a phantom 200.
      const changes = await setStatus(env.DB, seg[3], status);
      if (changes === 0) return json({ error: "not found" }, 404);
      return json({ slug: seg[3], status }, 200);
    }
    if (method === "POST" && seg.length === 4 && seg[2] === "purge") {
      const op = await purgeLink(env.DB, seg[3]);
      if (!op) return json({ error: "not found" }, 404);
      return json({ slug: seg[3], status: "purged", op }, 200);
    }
    return json({ error: "not found" }, 404);
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors({ "cache-control": "no-store" }) });
    if (url.pathname === "/v1/health") return new Response("ok", { status: 200, headers: cors({ "cache-control": "no-store" }) });
    if (url.pathname === "/v1/graph" && request.method === "GET") return handleGraph(request, url, env, ctx);
    return new Response("not found", { status: 404, headers: cors({ "cache-control": "no-store" }) });
  },
};

import { OVERPASS_URL, buildOverpassQuery, parseGraphParams, cacheKey, snap } from "./lib.js";
import { validateRouteHash, validateVanitySlug, apiCors, json } from "./links-lib.js";
import { createRandomLink, getActive, requestVanity, setStatus, listPending, bumpHits, TakenError } from "./links-db.js";

const APP_ORIGIN = "https://fractionasian.github.io";
const APP_BASE = "https://fractionasian.github.io/legwork";

// Overpass-api.de returns HTTP 406 to requests with a missing or generic
// User-Agent (its usage policy requires an identifying UA). A browser sends its
// own UA so the client path works; a Worker subrequest must set one explicitly.
// (Workers — unlike browsers — allow setting User-Agent on outbound fetch.)
const OVERPASS_UA = "Legwork/1.0 (+https://fractionasian.github.io/legwork)";

function cors(extra = {}) {
  return {
    "access-control-allow-origin": APP_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
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
      return new Response("rate limited", { status: 429, headers: cors({ "retry-after": "60" }) });
    }
  }

  const p = parseGraphParams(url);
  if (!p.ok) return new Response(p.error, { status: 400, headers: cors() });

  // Snap the pin to the shared grid: nearby pins collapse to one cell so they
  // share a single cached fetch. Both the key and the Overpass centre use the
  // snapped coords (see snap()/GRID_DEG in lib.js).
  const slat = snap(p.lat);
  const slon = snap(p.lon);
  const key = cacheKey(slat, slon, p.radius);

  const hit = await env.GRAPH.get(key);
  if (hit) {
    return new Response(hit.body, {
      status: 200,
      headers: cors({ "content-type": "application/json", "cache-status": "hit" }),
    });
  }

  const query = buildOverpassQuery(slat, slon, p.radius);
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
    return new Response("overpass unreachable", { status: 502, headers: cors({ "cache-status": "miss-overpass-error" }) });
  }
  if (!r.ok) {
    return new Response("overpass " + r.status, { status: 502, headers: cors({ "cache-status": "miss-overpass-error" }) });
  }

  const text = await r.text();
  // Don't block the response on the R2 write — fire it after the response flushes.
  ctx.waitUntil(env.GRAPH.put(key, text));
  return new Response(text, {
    status: 200,
    headers: cors({ "content-type": "application/json", "cache-status": "miss" }),
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
export async function handleApi(request, env, ctx) {
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
    return json({ slug, url: APP_BASE + "/?s=" + slug }, 200);
  }

  // GET /api/links/:slug → resolve (active only)
  if (method === "GET" && seg.length === 3 && seg[1] === "links") {
    const row = await getActive(env.DB, seg[2]);
    if (!row) return json({ error: "not found" }, 404);
    ctx.waitUntil(bumpHits(env.DB, seg[2]));
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
    try {
      await requestVanity(env.DB, {
        slug: body.slug, hash: rv.hash,
        contact: body.contact ?? null, note: body.note ?? null, now: Date.now(),
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
      const status = body.action === "approve" ? "active" : "rejected";
      await setStatus(env.DB, seg[3], status);
      return json({ slug: seg[3], status }, 200);
    }
    if (method === "POST" && seg.length === 4 && seg[2] === "purge") {
      await setStatus(env.DB, seg[3], "purged");
      return json({ slug: seg[3], status: "purged" }, 200);
    }
    return json({ error: "not found" }, 404);
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (url.pathname === "/v1/health") return new Response("ok", { status: 200, headers: cors() });
    if (url.pathname === "/v1/graph" && request.method === "GET") return handleGraph(request, url, env, ctx);
    return new Response("not found", { status: 404, headers: cors() });
  },
};

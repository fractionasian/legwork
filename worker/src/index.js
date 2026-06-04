import { OVERPASS_URL, buildOverpassQuery, parseGraphParams, cacheKey, snap } from "./lib.js";

const APP_ORIGIN = "https://fractionasian.github.io";

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (url.pathname === "/v1/health") return new Response("ok", { status: 200, headers: cors() });
    if (url.pathname === "/v1/graph" && request.method === "GET") return handleGraph(request, url, env, ctx);
    return new Response("not found", { status: 404, headers: cors() });
  },
};

import { OVERPASS_URL, buildOverpassQuery, parseGraphParams, cacheKey } from "./lib.js";

const APP_ORIGIN = "https://fractionasian.github.io";

function cors(extra = {}) {
  return {
    "access-control-allow-origin": APP_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    ...extra,
  };
}

async function handleGraph(url, env, ctx) {
  const p = parseGraphParams(url);
  if (!p.ok) return new Response(p.error, { status: 400, headers: cors() });

  const key = cacheKey(p.lat, p.lon, p.radius);

  const hit = await env.GRAPH.get(key);
  if (hit) {
    return new Response(hit.body, {
      status: 200,
      headers: cors({ "content-type": "application/json", "cache-status": "hit" }),
    });
  }

  const query = buildOverpassQuery(p.lat, p.lon, p.radius);
  let r;
  try {
    r = await fetch(OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      headers: { "content-type": "application/x-www-form-urlencoded" },
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
    if (url.pathname === "/v1/graph" && request.method === "GET") return handleGraph(url, env, ctx);
    return new Response("not found", { status: 404, headers: cors() });
  },
};

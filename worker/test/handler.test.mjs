import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeD1Mock } from "./_d1mock.mjs";

// Minimal R2 mock: in-memory map. .get returns an object whose .body is the
// stored string (Response accepts a string body, mirroring R2's stream body).
function mockEnv(initial = {}, rlSuccess = true) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    GRAPH: {
      get: async (k) => (store.has(k) ? { body: store.get(k) } : null),
      put: async (k, v) => { store.set(k, v); },
    },
    GRAPH_RL: { limit: async () => ({ success: rlSuccess }) },
  };
}
const ctx = { waitUntil: (p) => p };

function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}

test("health endpoint returns 200 ok", async () => {
  const res = await worker.fetch(new Request("https://w.dev/v1/health"), mockEnv(), ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("graph cache HIT returns stored body, never calls Overpass", async () => {
  // Request lon 115.861 snaps to the grid cell keyed 115.860 (GRID_DEG 0.005).
  const env = mockEnv({ "g:-31.950:115.860:2000": '{"elements":[1]}' });
  let called = false;
  const res = await withFetch(async () => { called = true; return new Response("nope"); }, () =>
    worker.fetch(new Request("https://w.dev/v1/graph?lat=-31.95&lon=115.861&radius=2000"), env, ctx));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-status"), "hit");
  assert.equal(await res.text(), '{"elements":[1]}');
  assert.equal(called, false, "Overpass must not be called on a hit");
});

test("graph cache MISS fetches Overpass, returns it, and writes R2", async () => {
  const env = mockEnv();
  const res = await withFetch(async () => new Response('{"elements":[42]}', { status: 200 }), () =>
    worker.fetch(new Request("https://w.dev/v1/graph?lat=-31.95&lon=115.861&radius=2000"), env, ctx));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-status"), "miss");
  assert.equal(await res.text(), '{"elements":[42]}');
  assert.equal(env.store.get("g:-31.950:115.860:2000"), '{"elements":[42]}', "R2 should be written under the snapped key");
});

test("nearby pins in the same grid cell share one cached fetch", async () => {
  const env = mockEnv();
  let overpassCalls = 0;
  const impl = async () => { overpassCalls++; return new Response('{"elements":[9]}', { status: 200 }); };
  // Pin A: miss → fetches Overpass, caches under the snapped key.
  await withFetch(impl, () =>
    worker.fetch(new Request("https://w.dev/v1/graph?lat=-36.849&lon=174.763&radius=2000"), env, ctx));
  // Pin B: ~220 m away, same cell → must HIT, no second Overpass call.
  const res = await withFetch(impl, () =>
    worker.fetch(new Request("https://w.dev/v1/graph?lat=-36.851&lon=174.764&radius=2000"), env, ctx));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-status"), "hit");
  assert.equal(overpassCalls, 1, "the two nearby pins should share one Overpass fetch");
});

test("graph returns 502 when Overpass errors (client will fall back)", async () => {
  const env = mockEnv();
  const res = await withFetch(async () => new Response("busy", { status: 504 }), () =>
    worker.fetch(new Request("https://w.dev/v1/graph?lat=-31.95&lon=115.861&radius=2000"), env, ctx));
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("cache-status"), "miss-overpass-error");
});

test("graph returns 502 when the Overpass fetch THROWS (network unreachable)", async () => {
  const env = mockEnv();
  const res = await withFetch(async () => { throw new Error("network down"); }, () =>
    worker.fetch(new Request("https://w.dev/v1/graph?lat=-31.95&lon=115.861&radius=2000"), env, ctx));
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("cache-status"), "miss-overpass-error");
  // Nothing should have been cached on a failed fetch.
  assert.equal(env.store.has("g:-31.950:115.861:2000"), false);
});

test("graph MISS sends a descriptive User-Agent to Overpass (avoids 406)", async () => {
  const env = mockEnv();
  let sentInit = null;
  const res = await withFetch(async (u, init) => { sentInit = init; return new Response('{"elements":[7]}', { status: 200 }); }, () =>
    worker.fetch(new Request("https://w.dev/v1/graph?lat=-31.95&lon=115.861&radius=2000"), env, ctx));
  assert.equal(res.status, 200);
  const ua = sentInit && sentInit.headers && (sentInit.headers["user-agent"] || sentInit.headers["User-Agent"]);
  assert.ok(ua && /legwork/i.test(ua), "Overpass fetch must send a descriptive Legwork User-Agent");
});

test("graph returns 429 when the rate limit is exceeded, and skips Overpass", async () => {
  const env = mockEnv({}, false); // rate limiter denies
  let called = false;
  const res = await withFetch(async () => { called = true; return new Response("x"); }, () =>
    worker.fetch(new Request("https://w.dev/v1/graph?lat=-31.95&lon=115.861&radius=2000"), env, ctx));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(called, false, "must not call Overpass when rate-limited");
});

test("graph returns 400 on bad params", async () => {
  const res = await worker.fetch(new Request("https://w.dev/v1/graph?lat=abc&lon=1&radius=2000"), mockEnv(), ctx);
  assert.equal(res.status, 400);
});

test("unknown path returns 404", async () => {
  const res = await worker.fetch(new Request("https://w.dev/nope"), mockEnv(), ctx);
  assert.equal(res.status, 404);
});

test("CORS header allows any origin (public API)", async () => {
  const res = await worker.fetch(new Request("https://w.dev/v1/health"), mockEnv(), ctx);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("graph responses carry x-content-type-options: nosniff", async () => {
  const env = mockEnv({ "g:-31.950:115.860:2000": '{"elements":[1]}' });
  const res = await worker.fetch(new Request("https://w.dev/v1/graph?lat=-31.95&lon=115.861&radius=2000"), env, ctx);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

// Router-level coverage: the analytics-handler tests all call handleEvent()
// directly, which bypasses the OPTIONS-preflight branch in fetch() entirely.
// The app is served from legwork.day but calls the *.workers.dev origin, so a
// POST with a JSON content-type triggers a REAL cross-origin preflight — it
// must be answered with POST allowed and content-type allowed, or a real
// browser blocks the actual request even though every direct-call test passes.
test("OPTIONS /v1/event answers the preflight with POST and content-type allowed", async () => {
  const res = await worker.fetch(new Request("https://w.dev/v1/event", { method: "OPTIONS" }), mockEnv(), ctx);
  assert.equal(res.status, 204);
  const methods = res.headers.get("access-control-allow-methods") || "";
  const headers = res.headers.get("access-control-allow-headers") || "";
  assert.ok(methods.includes("POST"), "access-control-allow-methods must include POST, got: " + methods);
  assert.ok(headers.includes("content-type"), "access-control-allow-headers must include content-type, got: " + headers);
});

test("POST /v1/event reaches handleEvent through the router and returns 204", async () => {
  const DB = makeD1Mock();
  const req = new Request("https://w.dev/v1/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "pin-drop", props: { n: 1 } }),
  });
  const res = await worker.fetch(req, { ...mockEnv(), DB }, ctx);
  assert.equal(res.status, 204);
  assert.equal(DB._events.length, 1, "the router must have dispatched to handleEvent, which wrote one row");
});

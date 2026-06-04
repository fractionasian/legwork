import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// Minimal R2 mock: in-memory map. .get returns an object whose .body is the
// stored string (Response accepts a string body, mirroring R2's stream body).
function mockEnv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    GRAPH: {
      get: async (k) => (store.has(k) ? { body: store.get(k) } : null),
      put: async (k, v) => { store.set(k, v); },
    },
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
  const env = mockEnv({ "g:-31.950:115.861:2000": '{"elements":[1]}' });
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
  assert.equal(env.store.get("g:-31.950:115.861:2000"), '{"elements":[42]}', "R2 should be written");
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

test("graph returns 400 on bad params", async () => {
  const res = await worker.fetch(new Request("https://w.dev/v1/graph?lat=abc&lon=1&radius=2000"), mockEnv(), ctx);
  assert.equal(res.status, 400);
});

test("unknown path returns 404", async () => {
  const res = await worker.fetch(new Request("https://w.dev/nope"), mockEnv(), ctx);
  assert.equal(res.status, 404);
});

test("CORS header allows the app origin", async () => {
  const res = await worker.fetch(new Request("https://w.dev/v1/health"), mockEnv(), ctx);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://fractionasian.github.io");
});

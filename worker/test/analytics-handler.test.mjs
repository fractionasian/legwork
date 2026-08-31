import test from "node:test";
import assert from "node:assert/strict";
import { makeD1Mock } from "./_d1mock.mjs";
import { handleEvent, handleGraph } from "../src/index.js";

function req(body, { method = "POST", country = "AU" } = {}) {
  const r = new Request("https://w.example/v1/event", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  Object.defineProperty(r, "cf", { value: { country }, configurable: true });
  return r;
}

const ctx = { waitUntil: (p) => p };

test("a valid event returns 204 and writes one row", async () => {
  const DB = makeD1Mock();
  const res = await handleEvent(req({ name: "route-built", props: { km_bucket: "5-10", mode: "loop", profile: "run" } }), { DB }, ctx);
  assert.equal(res.status, 204);
  assert.equal(DB._events.length, 1);
  assert.equal(DB._events[0].name, "route-built");
});

test("an unknown event name is dropped with 204 and writes nothing", async () => {
  const DB = makeD1Mock();
  const res = await handleEvent(req({ name: "evil", props: {} }), { DB }, ctx);
  assert.equal(res.status, 204, "must not 4xx — a beacon failure must never surface to the user");
  assert.equal(DB._events.length, 0);
});

test("malformed JSON is dropped with 204 and writes nothing", async () => {
  const r = new Request("https://w.example/v1/event", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
  });
  Object.defineProperty(r, "cf", { value: { country: "AU" }, configurable: true });
  const DB = makeD1Mock();
  const res = await handleEvent(r, { DB }, ctx);
  assert.equal(res.status, 204);
  assert.equal(DB._events.length, 0);
});

test("an oversized body is dropped without being parsed", async () => {
  const DB = makeD1Mock();
  const big = { name: "route-built", props: { km_bucket: "0-5", mode: "loop", profile: "run" }, pad: "x".repeat(20000) };
  const res = await handleEvent(req(big), { DB }, ctx);
  assert.equal(res.status, 204);
  assert.equal(DB._events.length, 0);
});

test("country is taken from cf, never from a client-supplied field", async () => {
  const DB = makeD1Mock();
  await handleEvent(req({ name: "pin-drop", props: { n: 1 }, country: "XX" }), { DB }, ctx);
  assert.equal(DB._events[0].country, "AU");
});

test("a rate-limited request writes nothing but still returns 204", async () => {
  const DB = makeD1Mock();
  const EVENT_RL = { limit: async () => ({ success: false }) };
  const res = await handleEvent(req({ name: "pin-drop", props: { n: 1 } }), { DB, EVENT_RL }, ctx);
  assert.equal(res.status, 204);
  assert.equal(DB._events.length, 0);
});

test("no stored row ever carries a coordinate or identifier field", async () => {
  const DB = makeD1Mock();
  await handleEvent(req({ name: "route-built", props: { km_bucket: "0-5", mode: "loop", profile: "run", lat: -31.95, lon: 115.86, session: "abc" } }), { DB }, ctx);
  const stored = JSON.parse(DB._events[0].props);
  assert.deepEqual(Object.keys(stored).sort(), ["km_bucket", "mode", "profile"]);
});

test("handleGraph records one demand hit per request, including on a cache hit", async () => {
  const DB = makeD1Mock();
  const GRAPH = { get: async () => ({ body: '{"elements":[]}' }) };  // force a cache HIT: no Overpass call
  const url = new URL("https://w.example/v1/graph?lat=-31.9523&lon=115.8613&radius=2000");
  const res = await handleGraph(new Request(url), url, { GRAPH, DB }, ctx);
  assert.equal(res.status, 200);
  assert.equal(DB._demand.size, 1);
  assert.equal([...DB._demand.keys()][0].split("|")[0], "-31.950:115.860");
});

test("covered=1 still routes, but records NO demand", async () => {
  // The client sets this when it resolved the point inside a catalogue city and
  // still fell through to the graph — coverage exists, it just could not load
  // the tiles. Counting that as demand makes a network failure look like a
  // request for new coverage, which is what `demand` is read to mean.
  const DB = makeD1Mock();
  const GRAPH = { get: async () => ({ body: '{"elements":[]}' }) };
  const url = new URL("https://w.example/v1/graph?lat=-31.9523&lon=115.8613&radius=2000&covered=1");
  const res = await handleGraph(new Request(url), url, { GRAPH, DB }, ctx);
  assert.equal(res.status, 200, "the graph must still be served");
  assert.equal(DB._demand.size, 0, "covered=1 must not write a demand row");
});

test("only the exact string \"1\" suppresses demand", async () => {
  // Fail CLOSED: anything else counts. A truthy-ish value must not silently
  // switch the metric off, and an absent param is the overwhelmingly common
  // case (every older client).
  for (const q of ["", "&covered=0", "&covered=true", "&covered=yes", "&covered="]) {
    const DB = makeD1Mock();
    const GRAPH = { get: async () => ({ body: '{"elements":[]}' }) };
    const url = new URL(`https://w.example/v1/graph?lat=-31.9523&lon=115.8613&radius=2000${q}`);
    await handleGraph(new Request(url), url, { GRAPH, DB }, ctx);
    assert.equal(DB._demand.size, 1, `demand must still be recorded for "${q}"`);
  }
});

test("two pins in the same cell collapse to one demand row with two hits", async () => {
  const DB = makeD1Mock();
  const GRAPH = { get: async () => ({ body: '{"elements":[]}' }) };
  for (const [lat, lon] of [[-31.9523, 115.8613], [-31.9510, 115.8590]]) {
    const url = new URL(`https://w.example/v1/graph?lat=${lat}&lon=${lon}&radius=2000`);
    await handleGraph(new Request(url), url, { GRAPH, DB }, ctx);
  }
  assert.equal(DB._demand.size, 1);
  assert.equal([...DB._demand.values()][0], 2);
});

test("a graph request over the demand write budget still routes, but records no demand", async () => {
  const DB = makeD1Mock();
  const GRAPH = { get: async () => ({ body: '{"elements":[]}' }) };
  const DEMAND_RL = { limit: async () => ({ success: false }) };
  const url = new URL("https://w.example/v1/graph?lat=-31.9523&lon=115.8613&radius=2000");
  const res = await handleGraph(new Request(url), url, { GRAPH, DB, DEMAND_RL }, ctx);
  assert.equal(res.status, 200, "the write budget must never degrade the routing response");
  assert.equal(await res.text(), '{"elements":[]}');
  assert.equal(DB._demand.size, 0);
});

test("a graph request under the demand write budget records demand as normal", async () => {
  const DB = makeD1Mock();
  const GRAPH = { get: async () => ({ body: '{"elements":[]}' }) };
  const DEMAND_RL = { limit: async () => ({ success: true }) };
  const url = new URL("https://w.example/v1/graph?lat=-31.9523&lon=115.8613&radius=2000");
  await handleGraph(new Request(url), url, { GRAPH, DB, DEMAND_RL }, ctx);
  assert.equal(DB._demand.size, 1);
});

test("the demand write budget is keyed by client IP, not globally", async () => {
  const DB = makeD1Mock();
  const GRAPH = { get: async () => ({ body: '{"elements":[]}' }) };
  const keys = [];
  const DEMAND_RL = { limit: async ({ key }) => { keys.push(key); return { success: true }; } };
  const url = new URL("https://w.example/v1/graph?lat=-31.9523&lon=115.8613&radius=2000");
  await handleGraph(new Request(url, { headers: { "cf-connecting-ip": "203.0.113.7" } }), url, { GRAPH, DB, DEMAND_RL }, ctx);
  assert.deepEqual(keys, ["203.0.113.7"]);
});

test("a bad-parameter graph request records no demand", async () => {
  const DB = makeD1Mock();
  const GRAPH = { get: async () => null };
  const url = new URL("https://w.example/v1/graph?lat=999&lon=115.86&radius=2000");
  const res = await handleGraph(new Request(url), url, { GRAPH, DB }, ctx);
  assert.equal(res.status, 400);
  assert.equal(DB._demand.size, 0);
});

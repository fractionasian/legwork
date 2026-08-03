import test from "node:test";
import assert from "node:assert/strict";
import { makeD1Mock } from "./_d1mock.mjs";
import { handleEvent } from "../src/index.js";

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

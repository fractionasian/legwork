import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/index.js";
import { makeD1Mock } from "./_d1mock.mjs";

const CTX = { waitUntil() {} };
const GOOD_HASH = "#r=-37.81710,144.97313;-37.81919,144.98498&m=oneway";

function env(extra = {}) {
  return {
    DB: makeD1Mock(),
    ADMIN_SECRET: "s3cret",
    LINKS_RL: { limit: async () => ({ success: true }) },
    ...extra,
  };
}
function req(method, path, { body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) headers["authorization"] = "Bearer " + auth;
  return new Request("https://w.dev" + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test("POST /api/links mints a resolvable short link", async () => {
  const e = env();
  const res = await handleApi(req("POST", "/api/links", { body: { hash: GOOD_HASH } }), e, CTX);
  assert.equal(res.status, 200);
  const { slug, url } = await res.json();
  assert.match(url, new RegExp("/" + slug + "$")); // bare pretty path: legwork.day/<slug>

  const got = await handleApi(req("GET", "/api/links/" + slug), e, CTX);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).hash, GOOD_HASH);
});

test("POST /api/links rejects a non-route payload (open-redirector closed)", async () => {
  const res = await handleApi(req("POST", "/api/links", { body: { hash: "https://evil.example" } }), env(), CTX);
  assert.equal(res.status, 400);
});

test("GET /api/links/:slug 404s an unknown slug", async () => {
  const res = await handleApi(req("GET", "/api/links/nosuch"), env(), CTX);
  assert.equal(res.status, 404);
});

test("POST /api/vanity parks a pending slug that does not resolve", async () => {
  const e = env();
  const res = await handleApi(req("POST", "/api/vanity", { body: { slug: "Melbourne2027", hash: GOOD_HASH, contact: "a@b.c" } }), e, CTX);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "pending");

  const resolve = await handleApi(req("GET", "/api/links/Melbourne2027"), e, CTX);
  assert.equal(resolve.status, 404); // pending != active
});

test("admin approve (with secret) makes a vanity slug resolve", async () => {
  const e = env();
  await handleApi(req("POST", "/api/vanity", { body: { slug: "Melbourne2027", hash: GOOD_HASH } }), e, CTX);
  const approve = await handleApi(req("POST", "/api/admin/vanity/Melbourne2027", { body: { action: "approve" }, auth: "s3cret" }), e, CTX);
  assert.equal(approve.status, 200);
  const resolve = await handleApi(req("GET", "/api/links/Melbourne2027"), e, CTX);
  assert.equal(resolve.status, 200);
  assert.equal((await resolve.json()).hash, GOOD_HASH);
});

test("admin routes require the secret", async () => {
  const e = env();
  const noAuth = await handleApi(req("POST", "/api/admin/purge/anything", { body: {} }), e, CTX);
  assert.equal(noAuth.status, 401);
  const badAuth = await handleApi(req("POST", "/api/admin/purge/anything", { body: {}, auth: "wrong" }), e, CTX);
  assert.equal(badAuth.status, 401);
});

test("duplicate vanity request returns 409", async () => {
  const e = env();
  await handleApi(req("POST", "/api/vanity", { body: { slug: "Boston", hash: GOOD_HASH } }), e, CTX);
  const dup = await handleApi(req("POST", "/api/vanity", { body: { slug: "Boston", hash: GOOD_HASH } }), e, CTX);
  assert.equal(dup.status, 409);
});

test("rate limiter blocks creates with 429", async () => {
  const e = env({ LINKS_RL: { limit: async () => ({ success: false }) } });
  const res = await handleApi(req("POST", "/api/links", { body: { hash: GOOD_HASH } }), e, CTX);
  assert.equal(res.status, 429);
});

test("OPTIONS preflight returns CORS 204", async () => {
  const res = await handleApi(req("OPTIONS", "/api/links"), env(), CTX);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("vanity slugs resolve case-insensitively (typed-case independence)", async () => {
  const e = env();
  // Request with mixed case, approve via a DIFFERENT case, resolve via lowercase.
  await handleApi(req("POST", "/api/vanity", { body: { slug: "Melbourne2027", hash: GOOD_HASH } }), e, CTX);
  const approve = await handleApi(req("POST", "/api/admin/vanity/MELBOURNE2027", { body: { action: "approve" }, auth: "s3cret" }), e, CTX);
  assert.equal(approve.status, 200);
  for (const cased of ["melbourne2027", "Melbourne2027", "MELBOURNE2027"]) {
    const r = await handleApi(req("GET", "/api/links/" + cased), e, CTX);
    assert.equal(r.status, 200, "should resolve regardless of case: " + cased);
    assert.equal((await r.json()).hash, GOOD_HASH);
  }
});

test("vanity rejects slugs that collide with real root asset names", async () => {
  for (const word of ["sw", "tiles", "index", "manifest"]) {
    const res = await handleApi(req("POST", "/api/vanity", { body: { slug: word, hash: GOOD_HASH } }), env(), CTX);
    assert.equal(res.status, 400, word + " should be reserved");
  }
});

test("vanity rejects an oversized note", async () => {
  const res = await handleApi(req("POST", "/api/vanity", { body: { slug: "bigrace", hash: GOOD_HASH, note: "x".repeat(1001) } }), env(), CTX);
  assert.equal(res.status, 400);
});

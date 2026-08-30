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

test("admin purge hard-deletes a RANDOM row (storage reclaimed, not just flagged)", async () => {
  const e = env();
  const mint = await handleApi(req("POST", "/api/links", { body: { hash: GOOD_HASH } }), e, CTX);
  const { slug } = await mint.json();
  const purge = await handleApi(req("POST", "/api/admin/purge/" + slug, { body: {}, auth: "s3cret" }), e, CTX);
  assert.equal(purge.status, 200);
  assert.equal((await purge.json()).op, "deleted");
  assert.equal(e.DB._rows.has(slug), false, "row should be deleted, not retained with a status flag");
  const resolve = await handleApi(req("GET", "/api/links/" + slug), e, CTX);
  assert.equal(resolve.status, 404);
});

test("admin purge tombstones a VANITY row (slug stays reserved, never re-resolvable)", async () => {
  const e = env();
  await handleApi(req("POST", "/api/vanity", { body: { slug: "Melbourne2027", hash: GOOD_HASH } }), e, CTX);
  await handleApi(req("POST", "/api/admin/vanity/Melbourne2027", { body: { action: "approve" }, auth: "s3cret" }), e, CTX);
  const purge = await handleApi(req("POST", "/api/admin/purge/Melbourne2027", { body: {}, auth: "s3cret" }), e, CTX);
  assert.equal(purge.status, 200);
  assert.equal((await purge.json()).op, "tombstoned");
  assert.equal(e.DB._rows.get("melbourne2027").status, "purged", "row retained as a tombstone");
  // The circulated URL must never resolve to different content later:
  const resolve = await handleApi(req("GET", "/api/links/Melbourne2027"), e, CTX);
  assert.equal(resolve.status, 404);
  const reReq = await handleApi(req("POST", "/api/vanity", { body: { slug: "Melbourne2027", hash: GOOD_HASH } }), e, CTX);
  assert.equal(reReq.status, 409, "tombstoned slug stays taken");
});

test("admin purge 404s an unknown slug", async () => {
  const res = await handleApi(req("POST", "/api/admin/purge/nosuch", { body: {}, auth: "s3cret" }), env(), CTX);
  assert.equal(res.status, 404);
});

test("admin vanity rejects a typo'd action with 400 naming the valid actions", async () => {
  const e = env();
  await handleApi(req("POST", "/api/vanity", { body: { slug: "Boston", hash: GOOD_HASH } }), e, CTX);
  // "aprove" must NOT silently map to rejected — that's the bug this guards.
  const res = await handleApi(req("POST", "/api/admin/vanity/Boston", { body: { action: "aprove" }, auth: "s3cret" }), e, CTX);
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /approve/);
  assert.match(error, /reject/);
  assert.equal(e.DB._rows.get("boston").status, "pending", "request must be left undecided");
});

test("admin vanity 404s when no pending vanity row matches", async () => {
  const e = env();
  // Unknown slug:
  const unknown = await handleApi(req("POST", "/api/admin/vanity/nosuch", { body: { action: "approve" }, auth: "s3cret" }), e, CTX);
  assert.equal(unknown.status, 404);
  // Active random link: must not be flippable via the vanity route.
  const mint = await handleApi(req("POST", "/api/links", { body: { hash: GOOD_HASH } }), e, CTX);
  const { slug } = await mint.json();
  const flip = await handleApi(req("POST", "/api/admin/vanity/" + slug, { body: { action: "reject" }, auth: "s3cret" }), e, CTX);
  assert.equal(flip.status, 404);
  assert.equal(e.DB._rows.get(slug).status, "active", "random link must be untouched");
});

test("rate limiter blocks resolves with 429 (quota-burn guard on the GET)", async () => {
  const e = env({ LINKS_RL: { limit: async () => ({ success: false }) } });
  const res = await handleApi(req("GET", "/api/links/abcdef"), e, CTX);
  assert.equal(res.status, 429);
});

test("POST /api/links re-share of the same route returns the same slug", async () => {
  const e = env();
  const a = await (await handleApi(req("POST", "/api/links", { body: { hash: GOOD_HASH } }), e, CTX)).json();
  const b = await (await handleApi(req("POST", "/api/links", { body: { hash: GOOD_HASH } }), e, CTX)).json();
  assert.equal(b.slug, a.slug);
});

test("an uncaught DB error returns a JSON 500 with CORS headers (not an opaque 1101)", async () => {
  const e = env({ DB: { prepare() { throw new Error("D1_ERROR: storage caught fire"); } } });
  // Silence the intentional console.error so test output stays readable.
  const realErr = console.error;
  console.error = () => {};
  try {
    const res = await handleApi(req("POST", "/api/links", { body: { hash: GOOD_HASH } }), e, CTX);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("access-control-allow-origin"), "*", "browser must be able to read the failure");
    assert.deepEqual(await res.json(), { error: "server error" });
  } finally {
    console.error = realErr;
  }
});

test("API responses carry x-content-type-options: nosniff", async () => {
  const res = await handleApi(req("GET", "/api/links/nosuch"), env(), CTX);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("POST /api/links rejects a body over the 32 KB cap without minting", async () => {
  const e = env();
  const res = await handleApi(req("POST", "/api/links", { body: { hash: GOOD_HASH, note: "x".repeat(64 * 1024) } }), e, CTX);
  assert.equal(res.status, 400);
});

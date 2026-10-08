// Service-worker tile cache: freshness follows the server's Cache-Control
// (OSM tile policy), each source has its own cache, and the shell is untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function load() {
    const caches = new Map(); // name -> Map(url -> resp)
    let handler, fetches = 0;
    const open = async (name) => {
        if (!caches.has(name)) caches.set(name, new Map());
        const m = caches.get(name);
        return { match: async (r) => m.get(r.url), put: async (r, resp) => { m.set(r.url, resp); },
                 keys: async () => [...m.keys()], delete: async (k) => m.delete(k) };
    };
    const resp = (cc, ageS) => ({ ok: true, clone() { return this; },
        headers: { get: (h) => h === "cache-control" ? cc : h === "date" ? new Date(Date.now() - ageS * 1000).toUTCString() : null } });
    const ctx = { self: { location: "https://legwork.day/", addEventListener: (t, f) => { if (t === "fetch") handler = f; }, skipWaiting() {}, clients: { claim() {} } },
        caches: { open, match: async () => undefined, keys: async () => [...caches.keys()] },
        URL, Request: class {}, Promise, Date, Infinity, console,
        fetch: async () => { fetches++; return resp("max-age=1000, stale-while-revalidate=5000", 0); } };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8"), ctx);
    const run = (url) => new Promise((res) => handler({ request: { method: "GET", url, mode: "cors" }, respondWith: (p) => p.then(res) }));
    return { caches, run, resp, fetches: () => fetches };
}
const OSM = "https://tile.openstreetmap.org/14/1/1.png";

test("miss fetches once and stores in the street cache", async () => {
    const t = load();
    await t.run(OSM);
    assert.equal(t.fetches(), 1);
    assert.ok(t.caches.get("legwork-tiles-v2-street").has(OSM));
});

test("fresh hit makes no request", async () => {
    const t = load();
    await t.run(OSM);
    await t.run(OSM);
    assert.equal(t.fetches(), 1);
});

test("stale inside stale-while-revalidate is served and refreshed behind", async () => {
    const t = load();
    await t.run(OSM);
    const stale = t.resp("max-age=1000, stale-while-revalidate=5000", 3000);
    t.caches.get("legwork-tiles-v2-street").set(OSM, stale);
    const got = await t.run(OSM);
    assert.equal(got, stale);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.fetches(), 2);
});

test("older than max-age + stale-while-revalidate is fetched, not served", async () => {
    const t = load();
    await t.run(OSM);
    const old = t.resp("max-age=1000, stale-while-revalidate=5000", 9000);
    t.caches.get("legwork-tiles-v2-street").set(OSM, old);
    const got = await t.run(OSM);
    assert.notEqual(got, old);
});

test("no Cache-Control: kept 7 days, refetched after", async () => {
    const t = load();
    await t.run(OSM);
    const c = t.caches.get("legwork-tiles-v2-street");
    const day = 24 * 3600;
    c.set(OSM, t.resp("", 6 * day));
    await t.run(OSM);
    assert.equal(t.fetches(), 1);
    c.set(OSM, t.resp("", 8 * day));
    await t.run(OSM);
    assert.equal(t.fetches(), 2);
});

test("each source gets its own cache", async () => {
    const t = load();
    await t.run("https://server.arcgisonline.com/x/14/1/1");
    await t.run("https://a.tile.opentopomap.org/14/1/1.png");
    assert.ok(t.caches.has("legwork-tiles-v2-satellite"));
    assert.ok(t.caches.has("legwork-tiles-v2-terrain"));
});

// ── Legwork storage — IndexedDB wrapper ──────────────
// DB layout:
//   pathCache   — Overpass results + pre-built tiles (TTL: 30 days)
//   elevCache   — elevation samples (indefinite)
//   savedRoutes — named routes (autoIncrement id)
//   autosave    — singleton key "current": in-progress route for session resume
// Loaded before tiles.js, app.js.

var DB_NAME = "legwork";
var DB_VERSION = 3;
var PATHS_TTL = 30 * 24 * 3600 * 1000; // 30 days

var _db = null;
function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains("pathCache")) db.createObjectStore("pathCache");
            if (!db.objectStoreNames.contains("elevCache")) db.createObjectStore("elevCache");
            if (!db.objectStoreNames.contains("savedRoutes")) {
                db.createObjectStore("savedRoutes", { keyPath: "id", autoIncrement: true });
            }
            if (!db.objectStoreNames.contains("autosave")) db.createObjectStore("autosave");
            if (db.objectStoreNames.contains("savedAreas")) db.deleteObjectStore("savedAreas");
        };
        req.onblocked = function () {
            // Another tab holds an older-version connection open. The upgrade
            // can't proceed until it closes; surface rather than hang silently.
            console.warn("IndexedDB upgrade blocked — another Legwork tab is open at an older version.");
        };
        req.onsuccess = function () {
            _db = req.result;
            // If another tab bumps DB_VERSION, close this connection and drop the
            // cache so the next call re-opens cleanly (avoids a dead connection
            // that throws on every transaction).
            _db.onversionchange = function () { _db.close(); _db = null; };
            resolve(_db);
        };
        req.onerror = function () { reject(req.error); };
    });
}

function cacheStoreFor(key) {
    return key.indexOf("elev") === 0 ? "elevCache" : "pathCache";
}

async function cacheGet(key, ttlMs) {
    try {
        var db = await openDB();
        var store = cacheStoreFor(key);
        return new Promise(function (resolve) {
            var tx = db.transaction(store, "readonly");
            var req = tx.objectStore(store).get(key);
            req.onsuccess = function () {
                var entry = req.result;
                if (!entry) return resolve(null);
                if (ttlMs && Date.now() - entry.ts > ttlMs) return resolve(null);
                resolve(entry.v);
            };
            req.onerror = function () { resolve(null); };
        });
    } catch (e) { return null; }
}

async function cacheSet(key, value) {
    try {
        var db = await openDB();
        var store = cacheStoreFor(key);
        return await new Promise(function (resolve) {
            var tx = db.transaction(store, "readwrite");
            tx.objectStore(store).put({ v: value, ts: Date.now() }, key);
            // Resolve on commit, not on the synchronous put() — a QuotaExceededError
            // aborts the transaction asynchronously and would otherwise be a silent
            // write loss (cache never persists → every session re-fetches).
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = tx.onabort = function () {
                if (tx.error && tx.error.name === "QuotaExceededError") {
                    console.warn("IndexedDB quota exceeded — tile/path cache write dropped.");
                }
                resolve(false);
            };
        });
    } catch (e) { return false; }
}

// Sweep stale pathCache rows: pre-baked tile entries whose trailing
// ":<version>" doesn't match the current manifest version, plus retired key
// generations. Nothing else ever deletes pathCache rows, so without this a
// manifest rebuild orphaned every cached tile until QuotaExceededError.
// Called fire-and-forget from fetchManifest (tiles.js) on a version change.
var STALE_KEY_PREFIXES = ["paths:", "paths2:", "pois:", "pois2:"];
async function cachePruneStale(currentTileVersion) {
    try {
        var db = await openDB();
        return await new Promise(function (resolve) {
            var tx = db.transaction("pathCache", "readwrite");
            var req = tx.objectStore("pathCache").openCursor();
            var removed = 0;
            req.onsuccess = function () {
                var cur = req.result;
                if (!cur) return;
                var key = String(cur.key);
                var stale = false;
                if (key.indexOf("tile:") === 0) {
                    stale = key.slice(key.lastIndexOf(":") + 1) !== String(currentTileVersion);
                } else {
                    for (var i = 0; i < STALE_KEY_PREFIXES.length; i++) {
                        if (key.indexOf(STALE_KEY_PREFIXES[i]) === 0) { stale = true; break; }
                    }
                }
                if (stale) { cur.delete(); removed++; }
                cur.continue();
            };
            req.onerror = function () { resolve(removed); };
            tx.oncomplete = function () { resolve(removed); };
            tx.onerror = tx.onabort = function () { resolve(removed); };
        });
    } catch (e) { return 0; }
}

// Batched variants of cacheGet/cacheSet: one transaction per store instead of
// one per key. A 10 km route samples ~200 elevation points; per-key
// transactions serialised hundreds of IDB round-trips on the warm-cache path,
// delaying the gradient repaint for no reason.
async function cacheGetMany(keys, ttlMs) {
    var out = new Array(keys.length);
    for (var z = 0; z < out.length; z++) out[z] = null;
    try {
        var db = await openDB();
        var byStore = {};
        for (var i = 0; i < keys.length; i++) {
            var store = cacheStoreFor(keys[i]);
            (byStore[store] = byStore[store] || []).push(i);
        }
        await Promise.all(Object.keys(byStore).map(function (store) {
            return new Promise(function (resolve) {
                var tx = db.transaction(store, "readonly");
                var os = tx.objectStore(store);
                byStore[store].forEach(function (idx) {
                    var req = os.get(keys[idx]);
                    req.onsuccess = function () {
                        var entry = req.result;
                        if (entry && (!ttlMs || Date.now() - entry.ts <= ttlMs)) out[idx] = entry.v;
                    };
                });
                tx.oncomplete = resolve;
                tx.onerror = tx.onabort = function () { resolve(); };
            });
        }));
    } catch (e) { /* all-null result reads as a clean miss */ }
    return out;
}

async function cacheSetMany(pairs) { // [{ key, value }]
    if (!pairs.length) return;
    try {
        var db = await openDB();
        var byStore = {};
        for (var i = 0; i < pairs.length; i++) {
            var store = cacheStoreFor(pairs[i].key);
            (byStore[store] = byStore[store] || []).push(pairs[i]);
        }
        await Promise.all(Object.keys(byStore).map(function (store) {
            return new Promise(function (resolve) {
                var tx = db.transaction(store, "readwrite");
                var os = tx.objectStore(store);
                var ts = Date.now();
                byStore[store].forEach(function (p) { os.put({ v: p.value, ts: ts }, p.key); });
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = tx.onabort = function () {
                    if (tx.error && tx.error.name === "QuotaExceededError") {
                        console.warn("IndexedDB quota exceeded — batched cache write dropped.");
                    }
                    resolve(false);
                };
            });
        }));
    } catch (e) { /* ignore */ }
}

// ── Autosave store ────────────────────────────────────
async function autosaveGet() {
    try {
        var db = await openDB();
        return new Promise(function (resolve) {
            var tx = db.transaction("autosave", "readonly");
            var req = tx.objectStore("autosave").get("current");
            req.onsuccess = function () { resolve(req.result || null); };
            req.onerror = function () { resolve(null); };
        });
    } catch (e) { return null; }
}

async function autosaveSet(data) {
    try {
        var db = await openDB();
        var tx = db.transaction("autosave", "readwrite");
        tx.objectStore("autosave").put(data, "current");
    } catch (e) { /* ignore */ }
}

async function autosaveClear() {
    try {
        var db = await openDB();
        var tx = db.transaction("autosave", "readwrite");
        tx.objectStore("autosave").delete("current");
    } catch (e) { /* ignore */ }
}

// Migrate legacy localStorage cache + autosave into IndexedDB on first run.
async function migrateLocalStorage() {
    var migratedCache = false;
    // Cache entries — keys prefixed with "lw:" that map into pathCache/elevCache.
    for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (!k || k.indexOf("lw:") !== 0) continue;
        if (k === "lw:savedRoute" || k === "lw:welcomed") continue;
        try {
            var raw = JSON.parse(localStorage.getItem(k));
            // Only legacy cache entries have the {v, ts} shape. Live preference
            // keys (lw:showToilets "1"/"0", lw:profile, lw:elevCollapsed, ...)
            // also parse as JSON, and without this guard the loop "migrated"
            // them as junk and DELETED them — silently resetting preferences on
            // every boot, since this migration is not gated to first run.
            if (!raw || typeof raw !== "object" || !("v" in raw)) continue;
            var cacheKey = k.substring(3);
            await cacheSet(cacheKey, raw.v);
            localStorage.removeItem(k);
            migratedCache = true;
        } catch (e) {}
    }
    if (migratedCache) console.log("Migrated localStorage cache to IndexedDB");

    // Autosave — single record "lw:savedRoute" → autosave store.
    try {
        var rawAuto = localStorage.getItem("lw:savedRoute");
        if (rawAuto) {
            var parsed = JSON.parse(rawAuto);
            await autosaveSet(parsed);
            localStorage.removeItem("lw:savedRoute");
            console.log("Migrated autosave to IndexedDB");
        }
    } catch (e) {}
}

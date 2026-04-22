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
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { reject(req.error); };
    });
}

function cacheStoreFor(key) {
    return key.indexOf("elev2:") === 0 ? "elevCache" : "pathCache";
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
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put({ v: value, ts: Date.now() }, key);
    } catch (e) { /* IndexedDB write failed — degrade silently */ }
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

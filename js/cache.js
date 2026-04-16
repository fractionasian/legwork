var DB_NAME = "legwork";
var DB_VERSION = 2;

var _db = null;
export function openDB() {
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
            if (db.objectStoreNames.contains("savedAreas")) db.deleteObjectStore("savedAreas");
        };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { reject(req.error); };
    });
}

export async function cacheGet(key, ttlMs) {
    try {
        var db = await openDB();
        var store = key.indexOf("elev2:") === 0 ? "elevCache" : "pathCache";
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

export async function cacheSet(key, value) {
    try {
        var db = await openDB();
        var store = key.indexOf("elev2:") === 0 ? "elevCache" : "pathCache";
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put({ v: value, ts: Date.now() }, key);
    } catch (e) { /* IndexedDB write failed — degrade silently */ }
}

export async function migrateLocalStorage() {
    var migrated = false;
    for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (!k || k.indexOf("lw:") !== 0) continue;
        if (k === "lw:savedRoute" || k === "lw:welcomed") continue;
        try {
            var raw = JSON.parse(localStorage.getItem(k));
            var cacheKey = k.substring(3);
            await cacheSet(cacheKey, raw.v);
            localStorage.removeItem(k);
            migrated = true;
        } catch (e) {}
    }
    if (migrated) console.log("Migrated localStorage cache to IndexedDB");
}

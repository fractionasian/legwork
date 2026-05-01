# Receive Shared Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-save received shared routes into the saved-routes library, with adjacent UX fixes (rename, toast-with-undo delete, sort, bounded layout).

**Architecture:** Tap a Legwork share URL → existing `loadFromHash` path renders the route → after waypoints fully resolve, hash the waypoints (5-decimal lat/lon), look up in `savedRoutes` IndexedDB store, and `put()` a new record if not present. Toast confirms first save; silent on dedup hit. Adjacent saved-routes UX gets pencil-icon rename, toast-with-undo on delete, reverse-chronological sort, and bounded scroll with the gradient legend reordered above the list.

**Tech Stack:** Vanilla JS (no framework), IndexedDB via existing `storage.js` helpers, Leaflet for map, plain HTML test page (`test.html`) loaded in a browser.

---

## File Structure

| File | Role |
|---|---|
| `routing.js` | Add `waypointHash(waypoints)` pure function (lives here because `routing.js` already houses pure-ish domain helpers and is loaded before storage and app). |
| `app.js` | New: `findSavedRouteByHash`, `updateSavedRouteName`, `restoreSavedRouteRecord`, `autoSaveSharedRoute`, `showActionBanner`, pencil-icon rename, replaced delete handler with toast-with-undo. Modified: `renderSavedRoutes` sorts and lazy-backfills hash; boot path calls `autoSaveSharedRoute` after waypoints resolve. (These helpers go in `app.js` rather than `storage.js` because the existing `loadSavedRoutes` / `restoreSavedRoute` / `deleteSavedRoute` already live in `app.js`. Locality wins over layering for this small surface.) |
| `index.html` | Reorder gradient legend above saved-routes section. |
| `style.css` | `#saved-routes-list { max-height: 40vh; overflow-y: auto }`. Pencil icon style. Action-banner button style. Inline-rename input style. |
| `test.html` | New unit assertions for `waypointHash` determinism, dedup blocking, rename, restore. |

Tests run by opening `test.html` in a browser and visually confirming green pass entries. No CI framework.

**Never use `innerHTML`** anywhere in this plan — Peter's coding principle bans it. Use `textContent` with unicode character literals (`"✎"` = ✎) for icons.

---

## Task 1: Add `waypointHash()` pure function

**Files:**
- Modify: `routing.js` (add function near top, after `haversine`)
- Test: `test.html` (add assertions after existing `wayPref` tests)

- [ ] **Step 1: Write the failing tests**

Append these tests inside the existing `<script>` block in `test.html`, after the `nodeAttrsFromTags` tests (around line 250):

```javascript
    // ── waypointHash ──────────────────────────────────
    test("waypointHash: deterministic for same waypoints", function () {
        var wps = [{ lat: -31.96, lon: 115.83 }, { lat: -31.97, lon: 115.84 }];
        assert(waypointHash(wps) === waypointHash(wps));
    });
    test("waypointHash: different for different waypoints", function () {
        var a = [{ lat: -31.96, lon: 115.83 }, { lat: -31.97, lon: 115.84 }];
        var b = [{ lat: -31.96, lon: 115.83 }, { lat: -31.97, lon: 115.85 }];
        assert(waypointHash(a) !== waypointHash(b));
    });
    test("waypointHash: precision is 5 decimals", function () {
        var a = [{ lat: -31.961234, lon: 115.831234 }];
        var b = [{ lat: -31.961235, lon: 115.831235 }]; // differs at 6th decimal only
        assert(waypointHash(a) === waypointHash(b));
    });
    test("waypointHash: order matters", function () {
        var a = [{ lat: -31.96, lon: 115.83 }, { lat: -31.97, lon: 115.84 }];
        var b = [{ lat: -31.97, lon: 115.84 }, { lat: -31.96, lon: 115.83 }];
        assert(waypointHash(a) !== waypointHash(b));
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Open `test.html` in a browser. Scroll to the bottom of the test list. Expected: four red FAIL entries for the new tests, with `waypointHash is not defined` errors in the console.

- [ ] **Step 3: Implement `waypointHash`**

In `routing.js`, after the `haversine` function (around line 12), add:

```javascript
// Stable string identifier for a waypoint sequence — used for dedup of
// auto-saved shared routes. 5-decimal precision (~1m), order-sensitive.
function waypointHash(waypoints) {
    return JSON.stringify(waypoints.map(function (wp) {
        return [wp.lat.toFixed(5), wp.lon.toFixed(5)];
    }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Reload `test.html`. Expected: all four `waypointHash` tests now green.

- [ ] **Step 5: Commit**

```bash
git add routing.js test.html
git commit -m "feat: add waypointHash for shared-route dedup

5-decimal precision (~1m), order-sensitive. Pure function in routing.js
so storage and app layers can both use it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `findSavedRouteByHash` helper

**Files:**
- Modify: `app.js` (add immediately after the existing `loadSavedRoutes` — confirm location with `grep -n "function loadSavedRoutes" app.js`)

**No unit test:** `test.html`'s `test()` harness (lines 28-49) is synchronous-only. Async I/O helpers like this one are verified manually via the integration smoke test in Task 10. Per Peter's principle "test what matters, skip what doesn't — pure domain logic gets tight tests, I/O gets manual."

- [ ] **Step 1: Implement `findSavedRouteByHash`**

In `app.js`, immediately after the existing `loadSavedRoutes` function:

```javascript
async function findSavedRouteByHash(hash) {
    if (!hash) return null;
    try {
        var db = await openDB();
        return new Promise(function (resolve) {
            var tx = db.transaction("savedRoutes", "readonly");
            var req = tx.objectStore("savedRoutes").getAll();
            req.onsuccess = function () {
                var match = (req.result || []).find(function (r) {
                    return r.waypointHash === hash;
                });
                resolve(match || null);
            };
            req.onerror = function () { resolve(null); };
        });
    } catch (e) {
        return null;
    }
}
```

- [ ] **Step 2: Manual verification**

Open the app. In the browser console:

```javascript
// Should return null on a fresh DB or unknown hash
findSavedRouteByHash("xyz-nonexistent").then(console.log);
// Save a route via the UI, then in the console get its hash and look it up:
loadSavedRoutes().then(rs => console.log(rs[0]?.waypointHash, rs[0]));
findSavedRouteByHash(/* paste hash from above */).then(console.log);
```

Expected: first call logs `null`. Third call (with a hash that exists) logs the matching route record. (If existing routes don't yet have `waypointHash` — they won't until Task 4's backfill runs — set one manually in the IndexedDB inspector for this verification, or skip and verify in Task 8's integration test.)

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: add findSavedRouteByHash for dedup lookup

Linear scan over getAll(); fine for the realistic library size (<100
entries). Wrap in try/catch so storage failures don't propagate to
callers — matches existing helper conventions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `updateSavedRouteName` and `restoreSavedRouteRecord` helpers

**Files:**
- Modify: `app.js` (add next to existing `deleteSavedRoute` around line 1725-1736)

**No unit test:** same reason as Task 2 — async I/O, sync test harness. Verified via Tasks 7 (rename UI) and 6 (delete-with-undo) integration verification.

- [ ] **Step 1: Implement both helpers**

In `app.js`, immediately after the existing `deleteSavedRoute` function (around line 1736):

```javascript
async function updateSavedRouteName(id, newName) {
    var name = (newName || "").trim();
    if (!name) return false;
    try {
        var db = await openDB();
        await new Promise(function (resolve, reject) {
            var tx = db.transaction("savedRoutes", "readwrite");
            var store = tx.objectStore("savedRoutes");
            var req = store.get(id);
            req.onsuccess = function () {
                var rec = req.result;
                if (!rec) { resolve(); return; }
                rec.name = name;
                store.put(rec);
            };
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
        });
        return true;
    } catch (e) {
        return false;
    }
}

async function restoreSavedRouteRecord(record) {
    try {
        var db = await openDB();
        await new Promise(function (resolve, reject) {
            var tx = db.transaction("savedRoutes", "readwrite");
            tx.objectStore("savedRoutes").put(record);
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
        });
    } catch (e) {}
}
```

`put()` (not `add()`) is the upsert — preserves the original `id` keypath.

- [ ] **Step 2: Manual smoke (optional — full verification in Tasks 6 and 7)**

In console: `updateSavedRouteName(/* an existing id */, "smoke test").then(loadSavedRoutes).then(console.log)`. Expected: the route's name shows "smoke test".

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: add updateSavedRouteName + restoreSavedRouteRecord

Rename writes the new name through put() preserving id. Restore takes
a full record (used by the toast-with-undo flow) and put()s it back
with original id intact.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Sort `renderSavedRoutes` by `ts` desc + lazy hash backfill

**Files:**
- Modify: `app.js:1738-1795` (`renderSavedRoutes` function)

- [ ] **Step 1: Read current `renderSavedRoutes`**

Read `app.js` lines 1738-1795 to confirm the loop structure before editing.

- [ ] **Step 2: Modify to sort and backfill hash**

In `renderSavedRoutes()`, immediately after the line `var routes = await loadSavedRoutes();` (line 1741), insert:

```javascript
    routes.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    // Lazy hash backfill — older entries pre-dedup get their hash on first render.
    var needsBackfill = routes.filter(function (r) { return !r.waypointHash && r.waypoints; });
    if (needsBackfill.length > 0) {
        var db = await openDB();
        await new Promise(function (resolve) {
            var tx = db.transaction("savedRoutes", "readwrite");
            var store = tx.objectStore("savedRoutes");
            needsBackfill.forEach(function (r) {
                r.waypointHash = waypointHash(r.waypoints);
                store.put(r);
            });
            tx.oncomplete = resolve;
            tx.onerror = resolve;
        });
    }
```

- [ ] **Step 3: Manual verification**

1. Open `index.html` in a browser (or hit your local dev server). Open the side menu.
2. If you have existing saved routes, confirm they render in reverse-chronological order (newest at top). Save a fresh route — it should jump to the top.
3. Open the IndexedDB inspector in DevTools (Application tab → IndexedDB → legwork → savedRoutes). Confirm older entries gained a `waypointHash` field after the first render.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: sort saved routes by ts desc + lazy hash backfill

Sort fixes the 'where is the route I just saved' problem — newest at
top. Backfill seeds waypointHash on existing entries so dedup works
against pre-feature library content. Backfill is idempotent and runs
once per entry (skipped on subsequent renders).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add `showActionBanner` toast-with-undo helper

**Files:**
- Modify: `app.js` (add near other banner helpers — search for `function showBanner` to locate)
- Modify: `style.css` (add action-button style at end of info-banner section)

- [ ] **Step 1: Find existing `showBanner` for reference**

Run: `grep -n "function showBanner" app.js`. Read the function and the surrounding 30 lines to understand banner state management.

- [ ] **Step 2: Add `showActionBanner` immediately after `showBanner`**

```javascript
// Toast with an inline action button (e.g. "Route deleted · Undo").
// onAction fires only if the user clicks the button before the timeout;
// otherwise the banner clears silently.
function showActionBanner(text, actionLabel, onAction, durationMs) {
    var banner = document.getElementById("info-banner");
    while (banner.firstChild) banner.removeChild(banner.firstChild);
    banner.dataset.type = "action";
    var span = document.createElement("span");
    span.textContent = text + " ";
    var btn = document.createElement("button");
    btn.className = "info-banner-action";
    btn.textContent = actionLabel;
    var dismissed = false;
    btn.addEventListener("click", function () {
        if (dismissed) return;
        dismissed = true;
        try { onAction(); } finally { showBanner(""); }
    });
    banner.appendChild(span);
    banner.appendChild(btn);
    banner.className = "info-banner action";
    banner.style.display = "block";
    setTimeout(function () {
        if (!dismissed && banner.dataset.type === "action") showBanner("");
    }, durationMs || 5000);
}
```

- [ ] **Step 3: Add the action-button CSS**

In `style.css`, find the `.info-banner` rules (search for `.info-banner {`). Append:

```css
.info-banner-action {
    background: transparent;
    border: 1px solid currentColor;
    color: inherit;
    padding: 2px 10px;
    margin-left: 4px;
    border-radius: 4px;
    font: inherit;
    cursor: pointer;
}
.info-banner-action:hover {
    background: rgba(255, 255, 255, 0.1);
}
```

- [ ] **Step 4: Manual verification**

In the browser console on the live app:

```javascript
showActionBanner("Test message", "Click me", function () { console.log("clicked"); }, 5000);
```

Expected: banner appears with "Test message Click me" button. Clicking the button logs "clicked" and dismisses. Letting it sit 5s dismisses silently.

- [ ] **Step 5: Commit**

```bash
git add app.js style.css
git commit -m "feat: add showActionBanner for toast-with-undo pattern

Inline action button on the info-banner. Dismisses on click (firing
callback) or on timeout (silent). Single 'action' slot — concurrent
calls overwrite each other, matching standard productivity-tool
behaviour (Gmail, Linear).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Replace immediate delete with toast-with-undo

**Files:**
- Modify: `app.js` (the `del.addEventListener` block inside `renderSavedRoutes`, around line 1786)

- [ ] **Step 1: Locate the existing delete click handler**

Run: `grep -n "saved-item-delete" app.js`. The handler is the `del.addEventListener("click", ...)` block — read it and the surrounding 5 lines.

- [ ] **Step 2: Replace with toast-with-undo flow**

Change the existing handler:

```javascript
del.addEventListener("click", function (e) {
    e.stopPropagation();
    deleteSavedRoute(route.id);
});
```

to:

```javascript
del.addEventListener("click", function (e) {
    e.stopPropagation();
    var snapshot = route; // closure captures full record for restore
    deleteSavedRoute(route.id);
    showActionBanner("Route deleted", "Undo", function () {
        restoreSavedRouteRecord(snapshot).then(renderSavedRoutes);
    }, 5000);
});
```

- [ ] **Step 3: Manual verification**

1. Open the app, save a route, then tap × on it.
2. Expected: row disappears immediately, banner shows "Route deleted Undo".
3. Tap Undo → row reappears with same name and details.
4. Repeat: tap × on another row, do nothing for 5s. Banner clears, row stays gone (verify with reload).

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: toast-with-undo on saved-route delete

Tap × → instant removal + 5s 'Route deleted · Undo' toast. Undo
restores the record with original id intact. Recoverable mistake
without modal friction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Pencil-icon rename UI

**Files:**
- Modify: `app.js` (inside `renderSavedRoutes`, after `del` button creation)
- Modify: `style.css` (add pencil-icon and inline-rename styles)

- [ ] **Step 1: Add pencil button in `renderSavedRoutes`**

Inside the `for` loop in `renderSavedRoutes`, after the `del.addEventListener(...)` block and before `row.appendChild(info)`, insert:

```javascript
            var edit = document.createElement("button");
            edit.className = "saved-item-edit";
            edit.textContent = "✎"; // ✎ U+270E LOWER RIGHT PENCIL
            edit.title = "Rename saved route";
            edit.addEventListener("click", function (e) {
                e.stopPropagation();
                startInlineRename(label, route.id);
            });
```

Then change `row.appendChild(info); row.appendChild(del);` to:

```javascript
            row.appendChild(info);
            row.appendChild(edit);
            row.appendChild(del);
```

- [ ] **Step 2: Add `startInlineRename` helper**

Immediately after `renderSavedRoutes()` (around line 1795), add:

```javascript
function startInlineRename(labelEl, routeId) {
    var oldName = labelEl.textContent;
    var input = document.createElement("input");
    input.type = "text";
    input.value = oldName;
    input.className = "saved-item-rename-input";
    input.autocomplete = "off";

    var committed = false;
    function commit() {
        if (committed) return;
        committed = true;
        var newName = input.value.trim();
        if (newName && newName !== oldName) {
            updateSavedRouteName(routeId, newName).then(renderSavedRoutes);
        } else {
            labelEl.textContent = oldName;
            input.replaceWith(labelEl);
        }
    }
    function cancel() {
        if (committed) return;
        committed = true;
        labelEl.textContent = oldName;
        input.replaceWith(labelEl);
    }

    input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") cancel();
    });
    input.addEventListener("blur", commit);

    labelEl.replaceWith(input);
    input.focus();
    input.select();
}
```

- [ ] **Step 3: Add CSS**

In `style.css`, find `.saved-item-delete` and add immediately before it:

```css
.saved-item-edit {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 14px;
    padding: 4px 6px;
    opacity: 0.6;
}
.saved-item-edit:hover {
    opacity: 1;
}
.saved-item-rename-input {
    flex: 1;
    background: transparent;
    border: 1px solid currentColor;
    color: inherit;
    padding: 2px 6px;
    border-radius: 3px;
    font: inherit;
}
```

- [ ] **Step 4: Manual verification**

1. Open the app, ensure you have a saved route.
2. Open the side menu → tap pencil icon next to a route name.
3. Expected: name swaps to a focused input with text selected.
4. Type a new name, press Enter → list re-renders with the new name. Reload page — name persists.
5. Tap pencil again, press Escape → input vanishes, original name returns.
6. Tap pencil, type a name, click outside the input → commits (blur).
7. Verify clicking the rest of the row still triggers restore (it should — pencil's stopPropagation isolates it).

- [ ] **Step 5: Commit**

```bash
git add app.js style.css
git commit -m "feat: pencil-icon inline rename for saved routes

Tap pencil → name swaps to an inline input. Enter commits, Escape
cancels, blur commits (Finder pattern). Pencil's stopPropagation keeps
the row-click → restore behaviour intact.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `autoSaveSharedRoute` and boot-path wiring

**Files:**
- Modify: `app.js` (add function near other route-persistence helpers; add boot-path call after waypoints render)

- [ ] **Step 1: Find the boot path that loads shared routes**

Run: `grep -n "sharedPoints\|loadFromHash" app.js`. The relevant block is around line 1845-1860 — read it to understand the waypoint loop.

- [ ] **Step 2: Add `autoSaveSharedRoute` helper**

Add this function in `app.js` near `confirmSaveRoute` (around line 1660), since it shares the same save-record shape:

```javascript
async function autoSaveSharedRoute() {
    if (state.waypoints.length < 2) return;
    var hash = waypointHash(state.waypoints);
    var existing = await findSavedRouteByHash(hash);
    if (existing) return; // dedup hit — silent

    var dist = document.getElementById("distance-display").textContent;
    var routeData = {
        name: "Route — " + dist, // placeholder; replaced by geocode below
        distance: dist,
        waypoints: state.waypoints.map(function (wp) {
            return { lat: wp.lat, lon: wp.lon, nodeKey: wp.nodeKey };
        }),
        mode: state.mode,
        zoom: state.map.getZoom(),
        center: { lat: state.map.getCenter().lat, lon: state.map.getCenter().lng },
        routeSegments: state.routeSegments,
        elevationData: state.lastElevationData,
        ts: Date.now(),
        waypointHash: hash,
    };

    var savedId;
    try {
        var db = await openDB();
        savedId = await new Promise(function (resolve, reject) {
            var tx = db.transaction("savedRoutes", "readwrite");
            var req = tx.objectStore("savedRoutes").add(routeData);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(tx.error); };
        });
    } catch (e) {
        return; // storage failure — don't toast, don't crash
    }

    showBanner("Saved to your routes");
    setTimeout(function () { showBanner(""); }, 3000);
    renderSavedRoutes();

    // Async geocode replacement of the placeholder name.
    var startWp = state.waypoints[0];
    if (navigator.onLine) {
        fetchWithTimeout("https://photon.komoot.io/reverse?lat=" + startWp.lat + "&lon=" + startWp.lon + "&limit=1", null, 10000)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var feat = (data.features || [])[0];
                if (feat && feat.properties) {
                    var p = feat.properties;
                    var name = p.name || p.street || p.city;
                    if (name) {
                        updateSavedRouteName(savedId, name + " — " + dist).then(renderSavedRoutes);
                    }
                }
            })
            .catch(function () {});
    }
}
```

- [ ] **Step 3: Wire into boot path**

Locate the boot block around line 1845. After the existing waypoint-replay loop completes — i.e. after `for (var i = 0; i < sharedPoints.length; i++) { await addWaypointAt(...); }` finishes — and after the route fully resolves (look for the next call after the loop, likely an `updateRoute()`-equivalent or a settled state), add:

```javascript
        await autoSaveSharedRoute();
```

The exact insertion point depends on the existing boot structure. Verify by reading the block carefully and placing the call after waypoints AND segments are settled. If the code uses an event/callback pattern instead of a sequential await, hook into the equivalent "route ready" signal.

- [ ] **Step 4: Manual verification**

1. With existing data, share your current route via the dm-share button → copy the resulting URL.
2. Open a new private/incognito window. Paste the URL.
3. Expected: route renders, "Saved to your routes" toast appears for 3s, side menu shows the new entry.
4. Reload the same URL in the same window. Expected: route renders, NO toast (dedup), no duplicate entry.
5. Modify a waypoint, share, paste new URL in new private window → new entry, no dedup.
6. Test offline: disable network, paste URL → entry saves with placeholder name "Route — X.X km". Re-enable network → name doesn't auto-update (intentional; geocode only runs at save time).

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: auto-save received shared routes with hash dedup

Tap a Legwork share URL -> route renders -> if waypointHash isn't
already in savedRoutes, write a new entry and toast 'Saved to your
routes'. Geocoded name fills in async. Dedup hit -> silent no-op.

The receive-side half of the saved-routes-and-sharing work. Sharing
itself unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Layout — bound saved-routes scroll + reorder gradient legend

**Files:**
- Modify: `index.html` (around lines 71-76 — saved routes / divider / legend block)
- Modify: `style.css` (add `#saved-routes-list` rule)

- [ ] **Step 1: Reorder in `index.html`**

Locate the side-menu body section (around lines 71-76 in `index.html`). Currently:

```html
            <div class="menu-divider"></div>
            <div class="menu-section-title">Saved routes</div>
            <div id="saved-routes-list" class="saved-list hidden"></div>
            <div class="menu-divider"></div>
            <div class="menu-legend" id="menu-legend"></div>
            <div class="menu-divider"></div>
```

Change to:

```html
            <div class="menu-divider"></div>
            <div class="menu-legend" id="menu-legend"></div>
            <div class="menu-divider"></div>
            <div class="menu-section-title">Saved routes</div>
            <div id="saved-routes-list" class="saved-list hidden"></div>
            <div class="menu-divider"></div>
```

- [ ] **Step 2: Bound saved-routes height in `style.css`**

Locate `.saved-list` (search `grep -n "saved-list" style.css`). Add a new `#saved-routes-list` rule near it:

```css
#saved-routes-list {
    max-height: 40vh;
    overflow-y: auto;
}
```

- [ ] **Step 3: Manual verification**

1. Open the app, open the side menu.
2. Verify the order is now: address search → save/export/toggles → divider → gradient legend → divider → saved routes → divider → tips → support → credits.
3. Save 10+ test routes (fastest: open the console and call `saveNamedRoute` repeatedly with different start positions, or programmatically `confirmSaveRoute`).
4. Confirm the saved-routes list has its own internal scrollbar inside the menu — items beyond ~6 rows scroll within the section, and the gradient legend stays anchored above, Tips/Support/Credits stay anchored below.
5. On phone viewport (DevTools responsive mode 375x667), confirm the legend is visible without scrolling the menu.

- [ ] **Step 4: Commit**

```bash
git add index.html style.css
git commit -m "fix: bound saved-routes section + legend above

40vh max-height with internal scroll on #saved-routes-list. Move the
gradient legend above the saved-routes section so reference info stays
anchored as the route library grows. Was: 30 saved routes pushed
legend, tips, support, and credits below the fold.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Final integration test + push

**Files:** none modified

- [ ] **Step 1: Run all unit tests in browser**

Open `test.html`. Confirm every test entry is green (no red FAILs anywhere). Take a screenshot or note any failures.

- [ ] **Step 2: Run the manual smoke test (full receive + library workflow)**

1. Fresh private/incognito window. Open app via prod URL or localhost.
2. Plan a 3-waypoint loop. Click dm-share → copy URL.
3. Open new private window with the URL → confirm route loads, toast fires, library has the entry with a sensible name.
4. Open library → tap pencil → rename → reload → confirm persistence.
5. Tap × on the route → toast appears → tap Undo → route reappears.
6. Tap × again → wait 5s → confirm gone after reload.
7. Save 8 routes manually → confirm sort order (newest first), bounded scroll, legend stays visible above the list.

- [ ] **Step 3: Push**

```bash
git push
```

Expected: all 9 commits land on `origin/main`. CACHE_NAME auto-bumps via the existing GitHub Actions workflow on push.

- [ ] **Step 4: Verify deploy**

Visit the prod URL in a private window after CI completes (~1-2 min). Confirm a fresh app load picks up all changes (look for the new pencil icons in saved-routes rows).

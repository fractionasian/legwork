# Receive Shared Routes — Design Spec

**Date:** 2026-05-01
**Status:** Draft (awaiting review)
**App:** [Legwork](https://github.com/fractionasian/legwork)

---

## Problem

When a friend shares a Legwork URL (e.g. Brandon sends his Sunday loop via iMessage), tapping it opens the app and renders the route — but the route is transient. To keep it, the recipient must manually use Save Route, name it, and confirm. If they close the tab without saving, the route is gone unless they revisit the original message.

The motivating use case: receiving a route from a friend you'd like to make a regular run, without ceremony.

Two adjacent gaps surface as soon as auto-save lands:
1. The saved-routes list has no rename or delete — auto-named entries with poor geocoding stick around forever.
2. As the list grows, it pushes the gradient legend and other static menu sections below the fold.

This spec covers all three.

---

## Feature 1: Auto-save received shared routes

### Behaviour

When the app boots from a URL containing a `#r=...` hash:

1. Existing flow: `loadFromHash()` parses the points, app replays waypoints, route renders.
2. After all waypoints resolve to a fully-rendered route (segments computed, elevation queried), compute `waypointHash` of the loaded waypoints (5-decimal lat/lon, joined). Look up existing entries in `savedRoutes` by hash.
3. If hash matches an existing entry: silent no-op.
4. If no match: write new entry to `savedRoutes` with the same shape as a self-saved route (`name`, `distance`, `waypoints`, `mode`, `zoom`, `center`, `routeSegments`, `elevationData`, `ts`, plus new `waypointHash`).
5. Default name: same Photon reverse-geocode pattern as `saveNamedRoute()` — show placeholder (`"Route — 5.2 km loop"`) immediately, replace with geocoded name (`"Royal Park — 5.2 km loop"`) when Photon returns within 10s. Offline / Photon failure → keep placeholder.
6. Show single brief toast: **"Saved to your routes"** (3s, auto-dismiss).

### What this does NOT do

- **Pre-existing condition not in scope:** if the user has unsaved waypoints when the shared link replaces state, those are lost (current behaviour). Worth a follow-up but out of this spec.
- **Sharer attribution:** no `&n=Brandon` URL param, no "received from" badge. Geocoded name is the only identifier.
- **Open-in-PWA deep linking:** no service-worker change. Existing PWA install handling applies.
- **Sync across devices:** out of scope. IndexedDB is per-browser, as today.

---

## Feature 2: Rename + Delete-confirmation + Sort for saved routes

### Rename (new)

Each row gains a small pencil icon to the right of the name (mirrors the existing `×` delete button pattern). Tap pencil → swap the name span for an inline `<input>` pre-filled with the current name. Enter commits, Escape cancels, click-away commits. Empty name → reject silently, keeps old.

Pencil + `e.stopPropagation()` ensures the row-click → restore behaviour is unaffected. Putting rename on the name itself would conflict with the existing whole-row restore click target.

Implementation: new `updateSavedRouteName(id, newName)` in `storage.js`; pencil icon and inline-input swap in `app.js`.

### Delete confirmation (modify existing)

`deleteSavedRoute(id)` and the `×` button already exist in `app.js:1725` and `app.js:1782` — but tapping `×` deletes immediately with no confirmation. Mistakes are unrecoverable.

Replace immediate-delete with **toast-with-undo** pattern (Gmail-style):
1. Tap `×` → row is removed from the DOM and from IndexedDB (so the user sees instant feedback).
2. Toast appears: **"Route deleted · [Undo]"** (5s).
3. If Undo tapped → re-insert the record.
4. If toast times out → no-op (deletion is permanent).

Rationale: Peter's principle 2 ("toasts beat modals"; modals only for destructive confirmations) technically allows a modal here, but the spirit leans non-blocking. Toast-with-undo gives recoverability without the friction of a confirmation step every time. Matches Gmail / Linear / modern productivity-tool conventions.

Implementation: keep `deleteSavedRoute(id)` shape; add a paired `restoreSavedRouteRecord(record)` to re-insert with same id; add toast-with-action banner state (extension of existing `info-banner`).

### Sort (new)

`renderSavedRoutes()` currently renders entries in IndexedDB iteration order (whatever `getAll()` returns). Add `routes.sort((a, b) => b.ts - a.ts)` before the loop. New received routes always appear at the top — no scrolling to find what just landed.

---

## Feature 3: Side-menu layout fix

The Saved Routes section grows with use; today this pushes the gradient legend, tips, support, credits and version below the fold on phones once the list exceeds ~6 rows.

### Two changes

1. **Bound saved-routes height.** CSS on `#saved-routes-list`:
   ```css
   max-height: 40vh;
   overflow-y: auto;
   ```
   Internal scroll inside the list; static items below stay anchored.

2. **Reorder menu.** Move the gradient legend *above* Saved Routes. Reference info (legend) belongs near the top; browse info (saved routes) belongs lower. New order:

   ```
   address search → save/export → toggles → divider →
   gradient legend → divider →
   saved routes (bounded) → divider →
   tips → report → support → credits/version
   ```

   HTML reorder only — no logic change.

---

## Data model

No schema migration. The `savedRoutes` IndexedDB store gains one new field on each new entry:

```
waypointHash: string   // JSON.stringify(waypoints.map(wp => [wp.lat.toFixed(5), wp.lon.toFixed(5)]))
```

Existing self-saved entries get `waypointHash` backfilled lazily — on next list-render, any entry missing the field has it computed and written back.

Dedup key is exact-string match. Off-by-2m re-shares produce duplicate entries (B-strict per Q4 — fuzzy dedup deferred).

---

## Files Changed

| File | Changes |
|---|---|
| `app.js` | `autoSaveSharedRoute()` called from boot path after hash-loaded waypoints render. Pencil-icon rename handler and inline-input swap. Replace immediate delete with toast-with-undo flow (re-insertable record). Sort `renderSavedRoutes()` by `ts` desc. Hash backfill on render. |
| `storage.js` | `findSavedRouteByHash(hash)`, `updateSavedRouteName(id, name)`, `restoreSavedRouteRecord(record)` for undo. (`deleteSavedRoute(id)` already exists.) |
| `index.html` | Reorder gradient legend above saved routes. Saved-routes row markup gains a pencil-icon button. (Trash button and CSS for it already exist.) |
| `style.css` | `#saved-routes-list { max-height: 40vh; overflow-y: auto }`. Pencil icon + inline-rename input style. Toast-with-undo button styling extension on `.info-banner`. |
| `test.html` | `waypointHash` determinism, dedup blocks identical hash, rename mutates record, undo re-inserts a deleted record, sort order is reverse-chronological. |
| `routing.js` / `tiles.js` / `sw.js` / `scripts/build-tiles.js` | Untouched. |

---

## Edge cases

- **Geocoding offline / fails:** placeholder name (`"Route — 5.2 km loop"`) persists. User can rename later.
- **Shared link < 2 waypoints:** existing `loadFromHash` returns false. No save attempted.
- **Self-saved entry hash backfill collides with received entry:** very unlikely in practice (you'd need to have manually built the same exact route Brandon shared). If it happens, the older entry wins and the receive becomes a silent no-op. Acceptable.
- **Rename to empty string:** rejected silently, keeps old name.
- **Undo tapped after toast already timed out:** undo target is gone; tap is no-op (button removed with toast). Acceptable.
- **Multiple deletes in quick succession:** each delete shows its own toast in sequence; the most recent toast's Undo restores the most recent deletion. (Only one undo "stack slot" at a time — this is the standard Gmail behaviour and matches user expectation.)
- **Bounded scroll on small screens:** `40vh` is ~360px on a 900px phone (~6 rows visible). On very short screens (e.g. landscape phone), 40vh may show only 2-3 rows — acceptable, internal scroll handles the rest.

---

## Testing

Unit (`test.html`):
- `waypointHash` is deterministic and round-trips.
- Dedup blocks an entry with matching hash.
- Rename writes the new name; empty rename is rejected.
- `restoreSavedRouteRecord(record)` re-inserts with the original id intact.
- List renders in `ts` descending order.

Manual:
1. Self-share own route → tap link in fresh tab → entry appears in side menu, toast fires, list scrolled to top entry.
2. Tap same link again → no toast, no duplicate.
3. Modify one waypoint, re-share, tap the modified link → new entry, no dedup.
4. Tap pencil icon → input appears, type new name, Enter → name updates and persists across reload. Repeat with Escape → unchanged.
5. Tap × → row disappears immediately, "Route deleted · Undo" toast appears. Tap Undo within 5s → row reappears. Repeat without tapping Undo → toast dismisses, deletion is permanent (verify on reload).
6. Save 10+ routes → confirm gradient legend stays visible above the list, Tips/Support/Credits visible below the bounded list.

---

## Out of scope (deferred follow-ups)

- In-progress route preservation when a shared link replaces current state.
- Sharer-side opt-in name field (`&n=Brandon` in URL hash).
- "Share this saved route" button in library (gap C from Q1).
- Cross-device sync (gap A).
- Search/filter in saved-routes list — trigger when list reliably exceeds ~20 entries.
- Source attribution / provenance badge.
- Send-to-watch (separate Garmin SKU work).

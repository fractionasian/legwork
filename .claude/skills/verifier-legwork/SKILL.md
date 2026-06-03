---
name: verifier-legwork
description: Use when verifying a legwork change by running the real app in a browser — confirming a fix works, reproducing a routing/map bug, or checking for console/network errors before committing. Legwork-specific launch + drive recipe for Playwright.
---

# Verifier — Legwork

Legwork is a vanilla-JS Leaflet PWA. It exposes its internals on `window`
(`state`, `addWaypointAt`, `loadTilesOrPaths`, `state.map`, …), so you drive
real app functions and read real state — no flaky pixel-clicking. This skill is
the proven recipe for getting a handle and driving the surface. For the verdict
format and the "push on it" discipline, follow `verify`.

## Launch

Static site, no build step. Serve on localhost (geolocation + service worker
need a secure context; `127.0.0.1` counts as secure):

```bash
python3 -m http.server 8753 --bind 127.0.0.1 >/tmp/legwork-srv.log 2>&1 &
```

Then navigate to `http://127.0.0.1:8753/index.html`. Kill the server
(`pkill -f "http.server 8753"`) when done.

Browser tools below are the **Playwright MCP** family
(`mcp__plugin_playwright_playwright__browser_*`) — load them with `ToolSearch`
first. The JS in the Drive/drag blocks runs inside `browser_evaluate`.

External deps load from the network and work in-browser: tiles from
`fractionasian.github.io/legwork-tiles`, Overpass (POIs/on-demand graph),
Photon (reverse geocode), S3 terrarium tiles (elevation).

## Drive

Load a real graph and add waypoints via the app's own functions (same ones
`onMapClick` calls). Perth is the densest pre-baked city:

```js
const A = [-31.960, 115.830], B = [-31.955, 115.840];
state.map.setView(A, 15);
await resetGraphIfCityChanged(A[0], A[1]);
await loadTilesOrPaths(A[0], A[1]);          // state.graph now ~100k nodes
await addWaypointAt(A[0], A[1]);
await addWaypointAt(B[0], B[1]);
await new Promise(r => setTimeout(r, 1200));  // let async routing settle
// read: state.waypoints, document.getElementById('distance-display').textContent
```

**Marker drag** (the dragend handler) — set the position, then fire Leaflet's
real event. The handler is `async` (may await tile load), so wait after:

```js
const wp = state.waypoints[0];
wp.marker.setLatLng([-31.970, 115.825]);
wp.marker.fire('dragend');
await new Promise(r => setTimeout(r, 2000));
```

The handler **re-snaps the marker to the nearest graph node**, so don't assert
exact-coordinate equality with the drop point. Correct assertions:
- `wp.lat`/`wp.lon` and `wp.nodeKey` *changed* to a node near the drop (was the
  bug: a `ReferenceError` left them stale — see app.js:526–527);
- `wp.marker.getLatLng()` matches `wp.lat`/`wp.lon` (marker ↔ waypoint
  consistency, both = the snapped node);
- `distance-display` text changed (route actually recomputed).

This drives handler *logic*, not the touch gesture itself — good enough for
routing/state bugs; geolocation (the locate button) needs Playwright geo-mock.

## Capture errors

```
browser_console_messages(level: "warning", all: true)   # errors + warnings
browser_network_requests(static: false)                 # non-static, shows FAILED
```

**Known-benign — do NOT report as bugs:**
- `cloud.umami.is/script.js` → `ERR_CONNECTION_REFUSED`/`ERR_FAILED`. The test
  browser blocks the tracker host. CSP *allows* umami (script-src + connect-src
  in index.html), and every other external host returns 200, so it's
  environment, not code. Loads fine in production.
- `apple-mobile-web-app-capable is deprecated` warning — cosmetic meta nag.

A real JS bug shows as an uncaught exception / `ReferenceError` in console, or a
`FLOW ERROR:` if you wrap the drive in try/catch.

## Gotchas

- **URL hash persists waypoints across reloads.** `#r=...` restores prior
  waypoints on load, so `state.waypoints.length` may be >0 before you add any,
  and accumulates across test runs. Navigate to bare `index.html` (no hash) or
  account for the pre-existing count.
- **`dragend` fires before async settles.** Always `await` a timeout after
  `fire('dragend')` before asserting — the handler may reload tiles first.
- Welcome modal is present on first load but doesn't block `window`-driven calls.

## Transfers

The `window`-globals trick is a vanilla-app affordance (also fits **tienlen**).
React siblings (**quorum**, future ronin/mantle) have module-scoped internals —
drive their real DOM (roles/test-ids) instead. Apps with their own backends
(tienlen, quorum Worker+D1) need that backend running too, not just a static
server.

# updateRoute concurrency guard (manual browser check)

`updateRoute()` is re-entrant: every waypoint edit fires a new call, and a call
can be superseded mid-flight while it `await`s the Overpass gap-fill. The
generation counter (`_routeGen`) + `clearRouteLayers` must ensure a **stale call
bails before mutating** `state.routeLines` / `state.routeSegments`, so a
superseded route never leaks onto the map.

This can't be a headless `node:test` — `updateRoute` is coupled to Leaflet + the
DOM and the repo is intentionally dependency-free (no jsdom). Run it in the
browser instead, on the deployed site or a local `python3 -m http.server`.

## How to run

Open the app, then paste this into the devtools console:

```js
(async () => {
  const realFill = window.fillGapAndRetry;
  const resolvers = [];
  window.fillGapAndRetry = (from, to) => new Promise(res =>
    resolvers.push(() => res({ dist: 100, path: [from.nodeKey, to.nodeKey] })));
  state.graph = {};                         // empty → dijkstra null → forces gap-fill
  state.routeSegments = []; state.routeLines = [];
  state.mode = "oneway";
  state.waypoints = [
    { lat: -31.9500, lon: 115.8600, nodeKey: "-31.95,115.86" },
    { lat: -31.9600, lon: 115.8700, nodeKey: "-31.96,115.87" },
  ];
  const pA = updateRoute();                 // call A: suspends at fillGapAndRetry (gen 1)
  const pB = updateRoute();                 // call B: clears layers, suspends (gen 2)
  resolvers[0] && resolvers[0]();           // resume stale A first
  resolvers[1] && resolvers[1]();           // then current B
  await pA; await pB;
  console.log({
    routeLines: state.routeLines.length,     // EXPECT 1 (only B; A must not leak)
    routeSegments: state.routeSegments.length, // EXPECT 1
    fillCalls: resolvers.length,             // EXPECT 2 (both calls interleaved)
  });
  window.fillGapAndRetry = realFill;
})();
```

## Expected result

```
{ routeLines: 1, routeSegments: 1, fillCalls: 2 }
```

`routeLines > 1` (or `routeSegments > 1`) means the stale call leaked geometry —
the generation guard is broken. This was the baseline before the
`resolveSegment`/`finalizeRoute` refactor (2026-06-03) and must stay green after
any change to `updateRoute`, `resolveSegment`, or `clearRouteLayers`.

Note: read these counts immediately. Once route elevation loads, the plain
`routeLines` are intentionally swapped for the gradient `state.gradientLines`, so
`routeLines` returns to 0 in normal use — that's the hotline render, not a leak.

## Fast-path case (no gap-fill)

A superseded call can also resume after an `await resolveSegment(...)` that did
no gap-fill. Every `await` yields. Restoring a route re-adds its pins back to
back, and each one fires `updateRoute()`. Before 2026-11-14, a stale pass then
drew its dashed "back to start" leg into the single `state.closingLine` slot. The
newer pass overwrote the slot, and the old line stayed on the map for good.

Open the app with a loop of 3+ pins in a pre-baked city (e.g. a Perth share
link ending `&m=loop`), wait for it to draw, then paste:

```js
(async () => {
  state.mode = "loop";
  await Promise.all([updateRoute(), updateRoute(), updateRoute()]);
  let dashed = 0;
  state.map.eachLayer(l => { if (l instanceof L.Polyline && l.options.dashArray === "10 6") dashed++; });
  console.log({ dashedClosingLines: dashed }); // EXPECT 1
})();
```

`dashedClosingLines > 1` means stale passes are drawing onto the newer route.
The fix is the `gen !== _routeGen` re-check after each await in `updateRoute`.
Measured 2026-11-14 on a 4-pin Dalkeith loop: 4 without the re-check, 1 with it.
Read the count straight away: once elevation loads, the gradient repaint removes
`state.closingLine`, so the count drops to 0 in normal use.

// The tile grid must not invent a row or column the bounds don't reach.
//
// `rows = Math.ceil(span / TILE_SIZE)` is wrong for a span that is an exact
// multiple of TILE_SIZE, because such a span is not exactly representable in
// binary floating point: 37.70 - 37.40 is 0.30000000000000426, which divides to
// just above 6 and ceils to 7. Nothing in-bounds can land in that last row, so
// it stays empty — until splitIntoTiles clamps an out-of-bbox feature into it
// (Overpass bleeds past the bbox, and the clamp exists to catch that). What
// comes out is a tile of zero area holding ways from the next city over, under
// a suburb label for somewhere outside the bounds entirely.
//
// It shipped that way: 61 zero-area tiles across the 12 cities in the
// 2026-09-11 manifest — 15 in Seoul, 14 in Melbourne, 7 in Perth — every one of
// them at a phantom index, and every phantom-index tile degenerate. Only the
// three cities whose spans dodge the artefact (Brisbane, Canberra, Tokyo) were
// clean. Cheap in bytes, wrong in the manifest, and invisible without a test
// that asserts area.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { gridSteps, splitIntoTiles } = require("../scripts/build-tiles.js");
const cities = require("../data/cities.json");

const TILE_SIZE = 0.05;
const line = (lat, lon) => ({
    type: "Feature",
    properties: { id: 1, highway: "footway", surface: "", name: "" },
    geometry: { type: "LineString", coordinates: [[lon, lat], [lon + 0.0001, lat + 0.0001]] },
});

test("gridSteps counts an exact multiple without rounding up", () => {
    // Each of these is a real city span; the naive ceil returns one too many.
    for (const [span, want] of [[0.30, 6], [0.45, 9], [0.40, 8], [0.60, 12],
                                [0.20, 4], [0.15, 3], [0.26, 6], [0.05, 1]]) {
        assert.equal(gridSteps(span), want, `span ${span}`);
    }
});

test("gridSteps still adds a step for any real remainder", () => {
    // The epsilon must not swallow a step a city genuinely needs. 1e-7 degrees
    // is ~1 cm — orders of magnitude above the 1e-9-of-a-tile tolerance.
    for (const [span, want] of [[0.3000001, 7], [0.051, 2], [0.2500001, 6], [0.0500001, 2]]) {
        assert.equal(gridSteps(span), want, `span ${span}`);
    }
});

test("every configured city's grid matches its bounds exactly", () => {
    for (const c of cities) {
        const [south, west, north, east] = c.bounds;
        const rows = gridSteps(north - south);
        const cols = gridSteps(east - west);
        // The last row/col must start strictly inside the bounds, or it has no
        // area — the exact condition that produced the 61 shipped slivers.
        assert.ok(south + (rows - 1) * TILE_SIZE < north,
            `${c.id}: row ${rows - 1} starts at or past the north edge`);
        assert.ok(west + (cols - 1) * TILE_SIZE < east,
            `${c.id}: col ${cols - 1} starts at or past the east edge`);
    }
});

test("no tile is emitted with zero area, including from out-of-bbox overspill", () => {
    // Seoul: both spans are exact multiples, so it trips the artefact on both
    // axes — the worst case in the city list.
    const bounds = [37.40, 126.75, 37.70, 127.20];
    const features = [
        line(37.41, 126.76),      // in bounds, first cell
        line(37.69, 127.19),      // in bounds, last real cell
        line(37.7004, 127.01),    // north of the bbox — Overpass overspill
        line(37.55, 127.2006),    // east of the bbox
        line(37.3994, 126.90),    // south of the bbox
        line(37.55, 126.7494),    // west of the bbox
    ];
    const { rows, cols, tiles } = splitIntoTiles({ features }, bounds);
    assert.equal(rows, 6);
    assert.equal(cols, 9);
    for (const [key, t] of Object.entries(tiles)) {
        assert.ok(t.bounds[2] - t.bounds[0] > 0, `tile ${key} has zero height`);
        assert.ok(t.bounds[3] - t.bounds[1] > 0, `tile ${key} has zero width`);
        assert.ok(t.row >= 0 && t.row < rows, `tile ${key} row out of grid`);
        assert.ok(t.col >= 0 && t.col < cols, `tile ${key} col out of grid`);
    }
    // Overspill is clamped into the edge tiles rather than dropped, which is
    // what the clamp is for; it must not create a cell of its own.
    const all = Object.values(tiles).reduce((n, t) => n + t.features.length, 0);
    assert.equal(all, features.length);
});

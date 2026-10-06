// The tile builder's elevation step: PNG decode → smoothed sampler → per-way heights
// in the tile, and back out through the app's own decoder. No network: Terrarium
// tiles are synthesised and injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const E = require("../scripts/elevation.js");
const { compactFeature } = require("../scripts/build-tiles.js");
const R = require("../routing.js");

// ── a tiny PNG writer, enough to feed the decoder every filter type ──────────
function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 255;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, body) {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
// rgb: Uint8Array w*h*3. filters: filter type per row (cycled).
function png(w, h, rgb, filters = [0], opts = {}) {
  const ch = 3, stride = w * ch, rows = [];
  for (let y = 0; y < h; y++) {
    const ft = filters[y % filters.length], row = Buffer.alloc(stride + 1);
    row[0] = ft;
    for (let i = 0; i < stride; i++) {
      const cur = rgb[y * stride + i];
      const left = i >= ch ? rgb[y * stride + i - ch] : 0, up = y ? rgb[(y - 1) * stride + i] : 0;
      const ul = y && i >= ch ? rgb[(y - 1) * stride + i - ch] : 0;
      const pred = ft === 1 ? left : ft === 2 ? up : ft === 3 ? (left + up) >> 1 : ft === 4 ? paeth(left, up, ul) : 0;
      row[i + 1] = (cur - pred) & 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = opts.depth || 8; ihdr[9] = 2; ihdr[12] = opts.interlace || 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
// metres → Terrarium RGB: v = m + 32768; R = v>>8, G = v&255, B = fraction*256
function terrariumPixel(m) {
  const v = m + 32768, whole = Math.floor(v);
  return [whole >> 8, whole & 255, Math.min(255, Math.floor((v - whole) * 256))];
}
function terrariumPng(heightAt) {
  const rgb = new Uint8Array(256 * 256 * 3);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) rgb.set(terrariumPixel(heightAt(x, y)), (y * 256 + x) * 3);
  return png(256, 256, rgb, [0, 1, 2, 3, 4]);   // every filter type appears
}

test("decodePng unfilters every PNG filter type", () => {
  const w = 7, h = 10, rgb = new Uint8Array(w * h * 3);
  let seed = 3; for (let i = 0; i < rgb.length; i++) rgb[i] = (seed = (seed * 48271) % 2147483647) & 255;
  for (const f of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
    const out = E.decodePng(png(w, h, rgb, f));
    assert.equal(out.width, w); assert.equal(out.height, h);
    assert.deepEqual(Array.from(out.data), Array.from(rgb), `filters ${f}`);
  }
});

test("decodePng refuses what it can't read instead of returning junk", () => {
  assert.throws(() => E.decodePng(Buffer.from("not a png at all")), /not a PNG/);
  assert.throws(() => E.decodePng(png(2, 2, new Uint8Array(12), [0], { depth: 16 })), /unsupported PNG/);
  assert.throws(() => E.decodePng(png(2, 2, new Uint8Array(12), [0], { interlace: 1 })), /unsupported PNG/);
});

test("decodeTerrariumPng reads metres the same way the client's decodeTerrarium does", () => {
  const heights = [0, 12.5, 49.75, 389.5, -3.25];
  const rgb = new Uint8Array(heights.length * 3);
  heights.forEach((m, i) => rgb.set(terrariumPixel(m), i * 3));
  const { elev } = E.decodeTerrariumPng(png(heights.length, 1, rgb));
  heights.forEach((m, i) => {
    assert.ok(Math.abs(elev[i] - m) < 0.01, `${m} → ${elev[i]}`);
    assert.equal(elev[i], R.decodeTerrarium(...terrariumPixel(m)));
  });
});

// ── sampler ──────────────────────────────────────────────────────────────────
// A ramp rising 0.01 m per mosaic pixel eastward. Tiles are numbered globally so
// the ramp is continuous across tile seams — and smoothing a straight ramp must
// leave it unchanged, so any wobble is a stitching bug.
const BOUNDS = [-31.955, 115.855, -31.945, 115.865];     // ~1 km box in Perth
const X0 = Math.floor(((115.855 + 180) / 360) * 2 ** 14) * 255;
const ramp = (z, tx, ty) => terrariumPng((x) => 0.01 * (tx * 255 + x - X0) + 20);

test("sampler stitches tiles into a continuous surface", async () => {
  const s = await E.buildSampler(BOUNDS, { fetchTile: async (...a) => ramp(...a) });
  const at = (lon) => s.sample(-31.95, lon);
  const px = (lon) => ((lon + 180) / 360) * 2 ** 14 * 255 - X0;   // mosaic column
  for (const lon of [115.856, 115.8575, 115.859, 115.8613, 115.8638]) {
    assert.ok(Math.abs(at(lon) - (0.01 * px(lon) + 20)) < 0.03, `lon ${lon}: ${at(lon)}`);
  }
  assert.equal(at(115.86), at(115.86), "same point, same height");
});

test("sampler smooths away vertex-to-vertex jitter", async () => {
  // checkerboard of ±1 m on a flat 50 m surface — the noise that, summed per
  // edge, looks like hills to the router
  const noisy = async () => terrariumPng((x, y) => 50 + ((x + y) % 2 ? 1 : -1));
  const s = await E.buildSampler(BOUNDS, { fetchTile: noisy });
  for (let i = 0; i < 20; i++) {
    const h = s.sample(-31.95 + i * 0.0001, 115.858 + i * 0.0002);
    assert.ok(Math.abs(h - 50) < 0.1, `jitter survived: ${h}`);
  }
});

test("sampler fails loudly when a tile can't be fetched or is the wrong size", async () => {
  await assert.rejects(E.buildSampler(BOUNDS, { fetchTile: async () => { throw new Error("HTTP 503"); } }), /503/);
  await assert.rejects(E.buildSampler(BOUNDS, { fetchTile: async () => png(2, 2, new Uint8Array(12)) }), /unexpected tile size/);
});

// ── tile format round trip ───────────────────────────────────────────────────
test("heights written by compactFeature come back out of the app's compactToGeoJSON", async () => {
  const s = await E.buildSampler(BOUNDS, { fetchTile: async (...a) => ramp(...a) });
  const f = {
    type: "Feature",
    properties: { id: 5, highway: "residential", name: "Hay St", surface: "asphalt", ow: 1 },
    geometry: { type: "LineString", coordinates: [[115.8571234, -31.9512345], [115.8581234, -31.9502345], [115.8591234, -31.9492345]] },
  };
  const packed = compactFeature(f, s);
  assert.equal(packed.length, 7);
  assert.equal(packed[4], "asphalt"); assert.equal(packed[5], 1);          // surface and ow keep their slots
  const back = R.compactToGeoJSON({ v: 2, features: [packed] }).features[0];
  assert.equal(back.properties.ow, 1);
  assert.equal(back.properties.surface, "asphalt");
  assert.equal(back.properties.elev.length, 3);
  back.geometry.coordinates.forEach(([lon, lat], i) => {
    assert.ok(Math.abs(back.properties.elev[i] - s.sample(lat, lon)) <= 0.05 + 1e-9, `vertex ${i}`);   // decimetre rounding
  });
  // a plain way gets "" and 0 placeholders so the heights still land in slot 7
  const plain = compactFeature({ ...f, properties: { id: 6, highway: "footway" } }, s);
  assert.deepEqual(plain.slice(4, 6), ["", 0]);
  assert.equal(R.compactToGeoJSON({ v: 2, features: [plain] }).features[0].properties.elev.length, 3);
});

test("the same coordinate gets the same height from two different ways", async () => {
  const s = await E.buildSampler(BOUNDS, { fetchTile: async (...a) => ramp(...a) });
  const shared = [115.85712, -31.95123];
  const mk = (id, others) => ({ type: "Feature", properties: { id, highway: "footway" },
    geometry: { type: "LineString", coordinates: [shared, ...others] } });
  const a = R.compactToGeoJSON({ v: 2, features: [compactFeature(mk(1, [[115.8581, -31.9502]]), s)] }).features[0];
  const b = R.compactToGeoJSON({ v: 2, features: [compactFeature(mk(2, [[115.8561, -31.9522]]), s)] }).features[0];
  assert.equal(a.properties.elev[0], b.properties.elev[0]);
});

test("without a sampler, tiles are byte-for-byte what they were before elevation existed", () => {
  const f = { type: "Feature", properties: { id: 7, highway: "residential", name: "Hay St", surface: "" },
    geometry: { type: "LineString", coordinates: [[115.8571234, -31.9512345], [115.8581234, -31.9522345]] } };
  assert.equal(compactFeature(f).length, 4);
  assert.equal(compactFeature(f, null).length, 4);
});

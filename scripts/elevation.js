// Elevation for the tile builder — Terrarium PNGs → one smoothed height per vertex.
//
// Why this exists: Legwork's router can charge for climbing (routing.js,
// CLIMB_WEIGHT), but only if every tile vertex carries a height. Heights are
// baked here, at build time, so the client does no elevation work for routing.
// docs/design/climb-aware-routing.md has the experiment behind the numbers.
//
// Three choices that matter:
//  - Same source and zoom as the client's elevation panel (Terrarium, z14), so
//    the ascent the app DISPLAYS and the climb the router AVOIDS agree.
//  - Heavy smoothing (~40 m). Raw heights jitter by a metre or two between
//    neighbouring vertices; summed per edge that is "climb" the router chases
//    instead of real hills. At 20 m smoothing, one test route counted 164 m of
//    climb against the 67 m the app reports; 40 m closed most of that gap.
//  - One value per coordinate, sampled at the 5 dp-rounded position the tile
//    stores, so the same vertex gets the same height from every way and tile.
const zlib = require("zlib");

const ZOOM = 14;                       // = TERRARIUM_ZOOM in app.js
const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const SMOOTH_METRES = 40;
const MIN_ELEV = -50;                  // Terrarium holds ocean depths; streets are never below this
const MAX_ELEV = 9000;
const STRIDE = 255;                    // column/row 255 duplicates the neighbour's 0 — see the mosaic loop in buildSampler

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── PNG (8-bit RGB/RGBA, non-interlaced — what Terrarium serves) ─────────────
function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

// Returns { width, height, data } with data = width*height*channels bytes.
function decodePng(buf) {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
    let pos = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
    const idat = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8);
        const body = buf.subarray(pos + 8, pos + 8 + len);
        if (type === "IHDR") {
            width = body.readUInt32BE(0); height = body.readUInt32BE(4);
            depth = body[8]; colour = body[9]; interlace = body[12];
        } else if (type === "IDAT") idat.push(body);
        else if (type === "IEND") break;
        pos += 12 + len;
    }
    const channels = colour === 2 ? 3 : colour === 6 ? 4 : 0;
    if (!channels || depth !== 8 || interlace !== 0) {
        throw new Error(`unsupported PNG (colour ${colour}, depth ${depth}, interlace ${interlace})`);
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < height * (stride + 1)) throw new Error("truncated PNG");
    const out = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        const ft = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
        for (let i = 0; i < stride; i++) {
            const left = i >= channels ? out[dst + i - channels] : 0;
            const up = y > 0 ? out[dst - stride + i] : 0;
            const upLeft = (y > 0 && i >= channels) ? out[dst - stride + i - channels] : 0;
            let v = raw[src + i];
            if (ft === 1) v += left;
            else if (ft === 2) v += up;
            else if (ft === 3) v += (left + up) >> 1;
            else if (ft === 4) v += paeth(left, up, upLeft);
            else if (ft !== 0) throw new Error("bad PNG filter " + ft);
            out[dst + i] = v & 255;
        }
    }
    return { width, height, channels, data: out };
}

// Terrarium: metres = (R*256 + G + B/256) - 32768 — same formula as decodeTerrarium in routing.js.
function decodeTerrariumPng(buf) {
    const { width, height, channels, data } = decodePng(buf);
    const out = new Float32Array(width * height);
    for (let i = 0, j = 0; i < out.length; i++, j += channels) {
        out[i] = data[j] * 256 + data[j + 1] + data[j + 2] / 256 - 32768;
    }
    return { width, height, elev: out };
}

// ── tile maths (slippy map, same as tileCoords in routing.js) ────────────────
function tileFrac(lat, lon, z) {
    const n = Math.pow(2, z), r = lat * Math.PI / 180;
    return { x: (lon + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n };
}

async function fetchTilePng(z, x, y) {
    const url = `${TERRARIUM_URL}/${z}/${x}/${y}.png`;
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return Buffer.from(await resp.arrayBuffer());
        } catch (e) {
            lastErr = e;
            await sleep(1000 * Math.pow(2, attempt));
        }
    }
    throw new Error(`Terrarium ${z}/${x}/${y}: ${lastErr.message}`);
}

// Separable Gaussian blur, edges clamped. In place on `a` (w*h); `tmp` is scratch.
function gaussBlur(a, tmp, w, h, sigma) {
    const r = Math.max(1, Math.ceil(3 * sigma)), k = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigma) * (i / sigma)); sum += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let i = -r; i <= r; i++) s += k[i + r] * a[row + Math.min(w - 1, Math.max(0, x + i))];
            tmp[row + x] = s;
        }
    }
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            let s = 0;
            for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
            a[y * w + x] = s;
        }
    }
}

// Fetch every Terrarium tile covering `bounds` (+1 tile margin so the blur has
// real neighbours at the edge), stitch, smooth, and return { sample(lat, lon) }.
// `opts.fetchTile(z, x, y) → Buffer` is injectable for tests.
async function buildSampler(bounds, opts = {}) {
    const [south, west, north, east] = bounds;
    const fetchTile = opts.fetchTile || fetchTilePng;
    const smoothMetres = opts.smoothMetres || SMOOTH_METRES;
    const nw = tileFrac(north, west, ZOOM), se = tileFrac(south, east, ZOOM);
    const tx0 = Math.floor(nw.x) - 1, tx1 = Math.floor(se.x) + 1;
    const ty0 = Math.floor(nw.y) - 1, ty1 = Math.floor(se.y) + 1;
    const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
    const W = nx * STRIDE + 1, H = ny * STRIDE + 1;

    // Column/row 255 of a tile is the same ground as column/row 0 of its
    // neighbour, and some Terrarium tiles ship corrupt right/bottom edges
    // (see makeGetPixel in app.js). So keep each tile's 0..254 and take the
    // last column/row from the neighbour — only the outermost tiles use their own.
    const mosaic = new Float32Array(W * H);
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
    let next = 0;
    async function worker() {
        while (next < jobs.length) {
            const [tx, ty] = jobs[next++];
            const png = decodeTerrariumPng(await fetchTile(ZOOM, tx, ty));
            if (png.width !== 256 || png.height !== 256) throw new Error(`unexpected tile size ${png.width}x${png.height}`);
            const ox = (tx - tx0) * STRIDE, oy = (ty - ty0) * STRIDE;
            for (let y = 0; y < 256; y++) {
                if (y === 255 && ty !== ty1) continue;
                for (let x = 0; x < 256; x++) {
                    if (x === 255 && tx !== tx1) continue;
                    const v = png.elev[y * 256 + x];
                    mosaic[(oy + y) * W + ox + x] = v < MIN_ELEV ? MIN_ELEV : v > MAX_ELEV ? MAX_ELEV : v;
                }
            }
        }
    }
    await Promise.all(Array.from({ length: opts.concurrency || 12 }, worker));

    // Pixel size shrinks with cos(latitude), so set the blur in metres, not pixels.
    const midLat = (south + north) / 2;
    const metresPerPx = 156543.03392 * Math.cos(midLat * Math.PI / 180) / Math.pow(2, ZOOM);
    gaussBlur(mosaic, new Float32Array(W * H), W, H, smoothMetres / metresPerPx);

    return {
        // Elevation in metres at (lat, lon), bilinear on the smoothed mosaic.
        sample(lat, lon) {
            const f = tileFrac(lat, lon, ZOOM);
            const px = (f.x - tx0) * STRIDE, py = (f.y - ty0) * STRIDE;
            const ix = Math.max(0, Math.min(W - 2, Math.floor(px))), iy = Math.max(0, Math.min(H - 2, Math.floor(py)));
            const fx = Math.min(1, Math.max(0, px - ix)), fy = Math.min(1, Math.max(0, py - iy));
            return mosaic[iy * W + ix] * (1 - fx) * (1 - fy) + mosaic[iy * W + ix + 1] * fx * (1 - fy) +
                mosaic[(iy + 1) * W + ix] * (1 - fx) * fy + mosaic[(iy + 1) * W + ix + 1] * fx * fy;
        },
    };
}

// Tile encoding for a way's heights: decimetres, first value absolute then the
// step to each next vertex (small ints, so they gzip well). Decoded by
// decodeElevations in routing.js. `coords` are [lon, lat] already rounded to 5 dp.
function encodeElevations(coords, sampler) {
    const out = [];
    let prev = 0;
    for (let i = 0; i < coords.length; i++) {
        const dm = Math.round(sampler.sample(coords[i][1], coords[i][0]) * 10);
        out.push(i === 0 ? dm : dm - prev);
        prev = dm;
    }
    return out;
}

module.exports = { buildSampler, encodeElevations, decodePng, decodeTerrariumPng, SMOOTH_METRES, ZOOM };

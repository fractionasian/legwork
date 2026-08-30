// Suburb resolution for analytics — point-in-polygon against per-city OSM
// boundaries served from the legwork-tiles repo.
//
// Why this file exists: the tile manifest labels a whole 0.05-degree tile
// (~5.5 x 4.7 km) with the suburb at its centre, so Crawley and Nedlands
// collapse into whichever the centre happened to land in. That is tile
// granularity wearing a suburb's name. This resolves the actual suburb.
//
// Privacy: the polygons are fetched and evaluated ON THE DEVICE. What leaves
// the browser is a suburb NAME from a fixed published list — never a
// coordinate. The analytics invariant ("every value that reaches D1 is an enum
// or a bucket") holds: a name from a shipped polygon file is an enum.

var _suburbs = {};        // cityId -> [{n, p, bbox}] | null (known-absent)
var _suburbsPending = {}; // cityId -> true while a fetch is in flight

// Kick off the fetch for a city and cache the result. Fire-and-forget: callers
// never await this. A city with no polygon file yet 404s and is cached as null
// so we ask once, not once per route.
function primeSuburbs(cityId) {
    if (!cityId || cityId === "uncovered") return;
    if (cityId in _suburbs || _suburbsPending[cityId]) return;
    _suburbsPending[cityId] = true;
    fetchWithTimeout(TILES_BASE + "suburbs/" + cityId + ".json", null, 15000)
        .then(function (resp) {
            if (!resp.ok) { _suburbs[cityId] = null; return null; }
            return resp.json();
        })
        .then(function (list) {
            if (!list) return;
            // Precompute a bbox per suburb: 299 polygons x ~114 vertices is
            // 34k edge tests per lookup without it, and this runs inside the
            // route-built debounce where the main thread is already busy.
            for (var i = 0; i < list.length; i++) {
                var minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
                for (var r = 0; r < list[i].p.length; r++) {
                    var ring = list[i].p[r];
                    for (var k = 0; k < ring.length; k++) {
                        if (ring[k][0] < minLa) minLa = ring[k][0];
                        if (ring[k][0] > maxLa) maxLa = ring[k][0];
                        if (ring[k][1] < minLo) minLo = ring[k][1];
                        if (ring[k][1] > maxLo) maxLo = ring[k][1];
                    }
                }
                list[i].bbox = [minLa, minLo, maxLa, maxLo];
            }
            _suburbs[cityId] = list;
        })
        .catch(function () { _suburbs[cityId] = null; })
        .then(function () { delete _suburbsPending[cityId]; });
}

// Ray casting. Counts crossings of the horizontal line at `lat`; odd = inside.
function _inRing(lat, lon, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var lai = ring[i][0], loi = ring[i][1];
        var laj = ring[j][0], loj = ring[j][1];
        if ((lai > lat) !== (laj > lat)) {
            if (lon < (loj - loi) * (lat - lai) / (laj - lai) + loi) inside = !inside;
        }
    }
    return inside;
}

// SYNCHRONOUS by design: this is called from inside the route-built debounce
// timer, where an await could outlive the page. Returns null when the polygons
// are not loaded yet, which is honest ("we don't know") rather than wrong.
function suburbForPoint(cityId, lat, lon) {
    var list = _suburbs[cityId];
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) {
        var b = list[i].bbox;
        if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
        for (var r = 0; r < list[i].p.length; r++) {
            if (_inRing(lat, lon, list[i].p[r])) return list[i].n;
        }
    }
    return null;
}

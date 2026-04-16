import { haversine } from './helpers.js';

function MinHeap() {
    this.data = [];
}
MinHeap.prototype.push = function (item) {
    this.data.push(item);
    var i = this.data.length - 1;
    while (i > 0) {
        var parent = (i - 1) >> 1;
        if (this.data[parent].d <= this.data[i].d) break;
        var tmp = this.data[parent]; this.data[parent] = this.data[i]; this.data[i] = tmp;
        i = parent;
    }
};
MinHeap.prototype.pop = function () {
    var top = this.data[0];
    var last = this.data.pop();
    if (this.data.length > 0) {
        this.data[0] = last;
        var i = 0, len = this.data.length;
        while (true) {
            var left = 2 * i + 1, right = 2 * i + 2, smallest = i;
            if (left < len && this.data[left].d < this.data[smallest].d) smallest = left;
            if (right < len && this.data[right].d < this.data[smallest].d) smallest = right;
            if (smallest === i) break;
            var tmp = this.data[smallest]; this.data[smallest] = this.data[i]; this.data[i] = tmp;
            i = smallest;
        }
    }
    return top;
};
MinHeap.prototype.size = function () { return this.data.length; };

export function dijkstra(graph, startKey, endKey) {
    if (!graph[startKey] || !graph[endKey]) return null;
    if (startKey === endKey) return { dist: 0, path: [startKey] };
    var dist = {}, prev = {}, visited = {};
    var heap = new MinHeap();
    dist[startKey] = 0;
    heap.push({ key: startKey, d: 0 });
    while (heap.size() > 0) {
        var current = heap.pop();
        if (visited[current.key]) continue;
        visited[current.key] = true;
        if (current.key === endKey) break;
        var neighbors = graph[current.key] || [];
        for (var n = 0; n < neighbors.length; n++) {
            var nb = neighbors[n];
            if (visited[nb.key]) continue;
            var newDist = dist[current.key] + nb.dist;
            if (dist[nb.key] === undefined || newDist < dist[nb.key]) {
                dist[nb.key] = newDist;
                prev[nb.key] = current.key;
                heap.push({ key: nb.key, d: newDist });
            }
        }
    }
    if (dist[endKey] === undefined) return null;
    var path = [];
    var cur = endKey;
    while (cur) { path.push(cur); cur = prev[cur]; }
    path.reverse();
    return { dist: dist[endKey], path: path };
}

var GRID_CELL = 0.005;
var spatialGrid = {};

function gridKey(lat, lon) {
    return (Math.floor(lat / GRID_CELL) * GRID_CELL).toFixed(4) + ":" + (Math.floor(lon / GRID_CELL) * GRID_CELL).toFixed(4);
}

export function gridInsert(nk, lat, lon) {
    var gk = gridKey(lat, lon);
    if (!spatialGrid[gk]) spatialGrid[gk] = [];
    spatialGrid[gk].push({ key: nk, lat: lat, lon: lon });
}

export function closestNode(graph, lat, lon) {
    var bestKey = null, bestDist = Infinity;
    var cLat = Math.floor(lat / GRID_CELL) * GRID_CELL;
    var cLon = Math.floor(lon / GRID_CELL) * GRID_CELL;
    for (var dLat = -1; dLat <= 1; dLat++) {
        for (var dLon = -1; dLon <= 1; dLon++) {
            var gk = (cLat + dLat * GRID_CELL).toFixed(4) + ":" + (cLon + dLon * GRID_CELL).toFixed(4);
            var bucket = spatialGrid[gk];
            if (!bucket) continue;
            for (var i = 0; i < bucket.length; i++) {
                var d = haversine(lat, lon, bucket[i].lat, bucket[i].lon);
                if (d < bestDist) { bestDist = d; bestKey = bucket[i].key; }
            }
        }
    }
    if (!bestKey) {
        var keys = Object.keys(graph);
        for (var i = 0; i < keys.length; i++) {
            var parts = keys[i].split(",");
            var d = haversine(lat, lon, parseFloat(parts[0]), parseFloat(parts[1]));
            if (d < bestDist) { bestDist = d; bestKey = keys[i]; }
        }
    }
    return bestKey;
}

export function resetSpatialGrid() {
    spatialGrid = {};
}

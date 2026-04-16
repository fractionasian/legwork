export var PATHS_TTL = 30 * 24 * 3600 * 1000;
export var TILES_BASE = "./data/";
export var GRAPH_RESET_METRES = 20000;
export var MODE_LABELS = { loop: "\u21BB Loop", outback: "\u21C4 Out & Back", oneway: "\u2192 One Way" };
export var MILES_COUNTRIES = ["US", "GB", "MM", "LR"];

export var ROAD_WEIGHT = {
    footway: 1.0, path: 1.0, cycleway: 1.0, pedestrian: 1.0, crossing: 1.0,
    living_street: 1.1, residential: 1.1,
    service: 1.2, unclassified: 1.2,
    tertiary: 1.3, tertiary_link: 1.3,
    steps: 1.5,
    secondary: 1.6, secondary_link: 1.6,
    primary: 2.0, primary_link: 2.0,
    trunk: 2.5, trunk_link: 2.5,
};

export var state = {
    map: null,
    pathLayer: null,
    waypoints: [],
    routeSegments: [],
    routeLines: [],
    closingLine: null,
    mode: "loop",
    elevationChart: null,
    pathFeatures: null,
    graph: null,
    startLat: null,
    startLon: null,
    gradientLines: [],
    routeOutline: null,
    distanceMarkers: [],
    totalDistMetres: 0,
    midpointMarkers: [],
    useMiles: false,
    lastElevationData: [],
};

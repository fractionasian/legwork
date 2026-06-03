// Minimal lint gate — catches undefined-reference bugs (the class that shipped
// the dragend `p` ReferenceError: valid syntax, undefined at runtime, only
// throws on a specific gesture). `npm run lint` concatenates the app scripts
// into one scope (exactly how index.html loads them) and runs no-undef on the
// bundle, so genuine cross-file globals resolve and only real undefined
// references are flagged — zero per-function maintenance.
const browser = [
  "window", "document", "navigator", "console", "fetch", "setTimeout",
  "clearTimeout", "setInterval", "clearInterval", "localStorage", "indexedDB",
  "location", "history", "URL", "URLSearchParams", "Blob", "FileReader",
  "requestAnimationFrame", "cancelAnimationFrame", "performance", "screen",
  "matchMedia", "btoa", "atob", "alert", "confirm", "prompt", "Headers",
  "Response", "Request", "XMLHttpRequest", "CustomEvent", "Event", "MouseEvent",
  "getComputedStyle", "DOMParser", "AbortController", "createImageBitmap",
  "ImageData", "OffscreenCanvas", "caches", "self", "module", "TextEncoder",
  "TextDecoder",
  "L",      // Leaflet (CDN)
  "Chart",  // Chart.js (CDN, elevation profile)
];
const globals = {};
browser.forEach((n) => { globals[n] = "readonly"; });

export default [
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals },
    rules: { "no-undef": "error" },
  },
];

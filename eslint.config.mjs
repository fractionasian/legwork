// Minimal lint gate — catches undefined-reference bugs (the class that shipped
// the dragend `p` ReferenceError: valid syntax, undefined at runtime, only
// throws on a specific gesture).
//
// The app scripts are classic (non-module) <script>s sharing one global scope,
// so per-file ESLint can't tell a real undefined ref from a legit cross-file
// global. scripts/lint.sh concatenates them (in index.html load order) into
// .eslint-bundle.js and lints that single scope — so cross-file globals resolve
// and only genuine undefined references are flagged. Zero per-function upkeep.
//
// sw.js runs in a SERVICE-WORKER scope, not the browser scope, so it is linted
// separately with SW globals — mixing the two would let each scope's globals
// mask real undefined refs in the other.
function readonly(names) {
  const o = {};
  names.forEach((n) => { o[n] = "readonly"; });
  return o;
}

const browser = readonly([
  "window", "document", "navigator", "console", "fetch", "setTimeout",
  "clearTimeout", "setInterval", "clearInterval", "localStorage", "indexedDB",
  "location", "history", "URL", "URLSearchParams", "Blob", "FileReader",
  "requestAnimationFrame", "cancelAnimationFrame", "performance", "screen",
  "matchMedia", "btoa", "atob", "alert", "confirm", "prompt", "Headers",
  "Response", "Request", "XMLHttpRequest", "CustomEvent", "Event", "MouseEvent",
  "getComputedStyle", "DOMParser", "AbortController", "createImageBitmap",
  "ImageData", "OffscreenCanvas", "TextEncoder", "TextDecoder",
  "module",  // CommonJS test-export shim (typeof module guard for node:test)
  "L",       // Leaflet (CDN)
  "Chart",   // Chart.js (CDN, elevation profile)
]);

const serviceWorker = readonly([
  "self", "caches", "clients", "registration", "skipWaiting", "importScripts",
  "addEventListener", "fetch", "Response", "Request", "Headers", "URL",
  "URLSearchParams", "location", "console", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "Blob", "TextEncoder", "TextDecoder",
  "createImageBitmap", "atob", "btoa",
]);

export default [
  {
    files: [".eslint-bundle.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: browser },
    rules: { "no-undef": "error" },
  },
  {
    files: ["sw.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: serviceWorker },
    rules: { "no-undef": "error" },
  },
];

import { test } from "node:test";
import assert from "node:assert/strict";
import { genSlug, validateRouteHash, validateVanitySlug, RESERVED, ALPHABET } from "../src/links-lib.js";

test("ALPHABET is lookalike-free", () => {
  for (const bad of ["0", "O", "1", "l", "I", "o", "i"]) {
    assert.ok(!ALPHABET.includes(bad), "alphabet must omit " + bad);
  }
});

test("genSlug is 6 chars, all from ALPHABET", () => {
  for (let i = 0; i < 1000; i++) {
    const s = genSlug();
    assert.equal(s.length, 6);
    for (const ch of s) assert.ok(ALPHABET.includes(ch), "bad char: " + ch);
  }
});

test("genSlug accepts an injected RNG and is deterministic under it", () => {
  assert.equal(genSlug(() => 0), ALPHABET[0].repeat(6));
});

test("validateRouteHash accepts well-formed routes (# and bare, all modes)", () => {
  assert.equal(validateRouteHash("#r=-37.81710,144.97313;-37.81919,144.98498&m=oneway").ok, true);
  for (const m of ["oneway", "loop", "outback"]) {
    assert.equal(validateRouteHash("r=-37.8,144.9;-37.9,145.0&m=" + m).ok, true, m);
  }
});

test("validateRouteHash normalises to a leading-# hash", () => {
  const r = validateRouteHash("r=-37.8,144.9;-37.9,145.0&m=loop");
  assert.equal(r.ok, true);
  assert.ok(r.hash.startsWith("#r="), "normalised hash should start with #r=");
  assert.ok(r.hash.endsWith("&m=loop"));
});

test("validateRouteHash rejects non-routes, the open-redirector attack, and bad coords", () => {
  for (const bad of [
    "https://evil.example",                      // arbitrary URL — open-redirector attempt
    "javascript:alert(1)",
    "#r=&m=oneway",                              // no points
    "#r=-37.8,144.9&m=oneway",                   // single point (need >= 2)
    "#r=999,144.9;-37.9,145.0&m=oneway",         // lat out of range
    "#r=-37.8,400;-37.9,145.0&m=oneway",         // lon out of range
    "#r=-37.8,144.9;-37.9,145.0&m=teleport",     // bad mode
    "#r=abc,def;-37.9,145.0&m=oneway",           // non-numeric
    "#m=oneway",                                 // missing r=
    "#r=-37.8,144.9;-37.9,145.0",                // missing m=
  ]) {
    assert.equal(validateRouteHash(bad).ok, false, "should reject: " + bad);
  }
});

test("validateRouteHash enforces a sane max point count", () => {
  const many = Array.from({ length: 501 }, () => "-37.8,144.9").join(";");
  assert.equal(validateRouteHash("#r=" + many + "&m=oneway").ok, false);
});

test("validateVanitySlug enforces pattern, length and blocklist", () => {
  assert.equal(validateVanitySlug("Melbourne2027").ok, true);
  assert.equal(validateVanitySlug("perth-city-2027").ok, true);
  for (const bad of ["ab", "x".repeat(41), "has space", "bad/slash", "emoji\u{1F642}", "dot.dot"]) {
    assert.equal(validateVanitySlug(bad).ok, false, "should reject: " + bad);
  }
  for (const word of RESERVED) {
    assert.equal(validateVanitySlug(word).ok, false, "reserved: " + word);
    assert.equal(validateVanitySlug(word.toUpperCase()).ok, false, "reserved (case-insensitive): " + word);
  }
});

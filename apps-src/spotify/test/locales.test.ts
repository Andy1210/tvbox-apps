// The two locales, held to each other and to the SDK's interpolation syntax.
//
// Both failures here render: a missing key falls back to the key NAME, and a
// double-braced variable substitutes the inner pair and leaves the outer ones on
// screen. Neither throws, so neither shows up in a typecheck or a read - only in
// front of the television.
//
// This app earned the test the hard way: a round of error messages was hand-added
// to both files and wired to a mapping in Browser.tsx, and nothing offline would
// have caught a key that reached only one of them, or a mapping pointing at a key
// neither had.
import { describe, expect, it } from "vitest";
import hu from "../locales/hu.json";
import en from "../locales/en.json";

const flatten = (o: unknown, prefix = ""): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (v && typeof v === "object") Object.assign(out, flatten(v, prefix + k + "."));
    else out[prefix + k] = String(v);
  }
  return out;
};

const HU = flatten(hu);
const EN = flatten(en);

describe("the locales", () => {
  it("carry exactly the same keys", () => {
    // A key present in one and not the other renders as its own name.
    expect(Object.keys(HU).sort()).toEqual(Object.keys(EN).sort());
  });

  it("use single braces, which is what the SDK substitutes", () => {
    // interpolate() in app-sdk/src/i18n.tsx matches /\{(\w+)\}/.
    for (const [key, value] of [...Object.entries(HU), ...Object.entries(EN)]) {
      expect(value, key).not.toMatch(/\{\{/);
    }
  });

  it("name the same variables in both languages", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(HU)) {
      expect(vars(HU[key]), key).toEqual(vars(EN[key]));
    }
  });

  it("leave no value empty", () => {
    for (const [key, value] of [...Object.entries(HU), ...Object.entries(EN)]) {
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  // Every key the error mappings name has to exist, in both files. These are the
  // strings a person sees only when something has already gone wrong, which is
  // exactly when nobody is in a position to notice that the screen is showing a
  // key name instead of a sentence.
  it("carry every message the play and transport paths can choose", () => {
    const named = [
      "boxNotFound",
      "boxSignedOut",
      "recoveryFailed",
      "recoveryCooling",
      "boxUnreachable",
      "lookupFailed",
      "otherAccount",
      "connectOff",
      "inUse",
      "notConnected",
      "playError",
      "starting",
      "startingSlow",
      "ctrlUnreachable",
      "ctrlError",
      "notRegistered",
    ];
    for (const k of named) {
      expect(HU["spotify." + k], k).toBeTruthy();
      expect(EN["spotify." + k], k).toBeTruthy();
    }
  });

  // The fall-through message must not ask for a variable: the codes that reach it
  // include Spotify's own `HTTP <status> <body>`, and interpolating that put raw
  // JSON on a television.
  it("state the generic failures without interpolating a code", () => {
    for (const k of ["spotify.playError", "spotify.ctrlError"]) {
      expect(HU[k], k).not.toMatch(/\{/);
      expect(EN[k], k).not.toMatch(/\{/);
    }
  });
});

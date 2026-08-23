// The two locales, held to each other and to the SDK's interpolation syntax.
//
// Both failures here render: a missing key falls back to the key NAME, and a
// double-braced variable substitutes the inner pair and leaves the outer ones on
// screen ("Signed in as {Andy1210LIVE}"). Neither throws, so neither shows up in a
// typecheck or a read - only in front of the television.
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
});

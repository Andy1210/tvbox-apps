import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

// Every string this app shows exists in both languages. A missing key falls back
// to English silently, so without this test a Hungarian box quietly grows English
// sentences - the kind of regression nobody files a bug for.
function keys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj)
    .filter(([k]) => k !== "_meta") // locale metadata, not a translatable string
    .flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? keys(v as Record<string, unknown>, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    )
    .sort();
}

describe("locales", () => {
  it("has the same keys in en and hu", () => {
    expect(keys(hu)).toEqual(keys(en));
  });

  it("has no empty strings", () => {
    for (const [name, dict] of [
      ["en", en],
      ["hu", hu],
    ] as const) {
      const empty = keys(dict).filter((k) => {
        const v = k.split(".").reduce<unknown>((o, part) => (o as Record<string, unknown>)?.[part], dict);
        return typeof v !== "string" || v.trim() === "";
      });
      expect(empty, `${name} has empty values`).toEqual([]);
    }
  });

  it("declares its locale metadata", () => {
    expect(en._meta.tag).toBe("en-GB");
    expect(hu._meta.tag).toBe("hu-HU");
  });
});

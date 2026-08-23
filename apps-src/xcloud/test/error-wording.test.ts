// Every error code the plugin can emit has words in both languages.
//
// This exists because the SDK's `translate()` returns the KEY when it is missing,
// and a key is truthy - so the `|| t("errors.generic")` written at each call site
// could never fire. Measured on the television: `errors.http_500` in warn yellow,
// as the only text on the screen. `locales.test.ts` cannot see it, because en and
// hu were missing the same keys and it only checks that they agree.
//
// The codes are read out of the plugin's own source rather than listed here: a
// list would go stale the first time somebody adds a `throw`.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import hu from "../locales/hu.json";
import en from "../locales/en.json";

// Codes the regex below cannot see, because they are not written as a literal at
// a `code:` key. `errorPayload` in plugin.js falls back to `"error"` for anything
// thrown without one, so that string reaches `errorText` like any other.
const EXTRA = ["error"];
import { errorText } from "../errors";

const PLUGIN = join(__dirname, "..", "..", "..", "apps", "xcloud");

function codesInSource(): string[] {
  const files = [
    join(PLUGIN, "plugin.js"),
    ...readdirSync(join(PLUGIN, "lib"))
      .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
      .map((f) => join(PLUGIN, "lib", f)),
  ];
  const found = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // `new AuthError("code", …)`, `new ApiError("code", …)`,
    // `new SessionError("code", …)`, and the plugin's own `code: "…"` payloads.
    for (const m of src.matchAll(/new (?:Auth|Api|Session)Error\(\s*"([a-z_0-9]+)"/g)) found.add(m[1]);
    for (const m of src.matchAll(/\bcode:\s*"([a-z_0-9]+)"/g)) found.add(m[1]);
  }
  for (const c of EXTRA) found.add(c);
  return [...found].sort();
}

describe("error wording", () => {
  const codes = codesInSource();

  it("finds the codes in the plugin at all", () => {
    // If this drops to nothing the check below passes vacuously.
    expect(codes.length).toBeGreaterThan(15);
    expect(codes).toContain("token_rejected");
    expect(codes).toContain("xsts_failed");
    expect(codes).toContain("error");
  });

  it("has a Hungarian and an English sentence for every one of them", () => {
    const missing = codes.filter((c) => !(c in (hu.errors as Record<string, string>)) || !(c in (en.errors as Record<string, string>)));
    expect(missing).toEqual([]);
  });

  it("falls back for a code nobody wrote words for, instead of printing it", () => {
    // Including every `http_<status>` the API client makes up.
    const t = (key: string) => (key === "errors.generic" ? "Something went wrong." : key);
    expect(errorText(t, "http_500")).toBe("Something went wrong.");
    expect(errorText(t, undefined)).toBe("Something went wrong.");
    expect(errorText(t, "a_code_from_the_future")).toBe("Something went wrong.");
  });

  it("uses the wording when there is one", () => {
    const t = (key: string) => (key === "errors.token_rejected" ? "The access expired." : key);
    expect(errorText(t, "token_rejected")).toBe("The access expired.");
  });
});

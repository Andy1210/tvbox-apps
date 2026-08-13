import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import en from "../locales/en.json";

// The locale files against the CODE, not against each other.
//
// Parity between hu and en catches a missing translation. It cannot catch a
// string that never reached the locale files at all - a template literal in a
// component renders identically in both languages, which on a Hungarian
// television means an English word in the middle of the screen. Nor can it catch
// a key that no longer exists in the code, which then reads as a promise of a
// feature that was never built.

const SRC = join(__dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "test" || entry === "locales" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj)
    .filter(([k]) => k !== "_meta")
    .flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    );
}

const code = sources(SRC)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const declared = new Set(flatten(en as unknown as Record<string, unknown>));

// Direct calls, plus any bare string literal that happens to BE a declared key -
// which is how a key chosen by a condition reaches `t`, e.g.
// `t(expired ? "login.expired" : "login.failed")`. Matching against the declared
// set rather than a namespace list keeps this from needing an update every time
// a namespace is added.
const used = new Set([...code.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]));
for (const [, literal] of code.matchAll(/"([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)"/g)) {
  if (declared.has(literal)) used.add(literal);
}

describe("locale keys", () => {
  it("every key the code asks for exists", () => {
    const missing = [...used].filter((k) => !declared.has(k));
    // A missing key renders as the key itself, which looks like a bug in the
    // data rather than in the translation.
    expect(missing).toEqual([]);
  });

  it("every declared key is used somewhere", () => {
    const unused = [...declared].filter((k) => !used.has(k));
    expect(unused).toEqual([]);
  });

  it("no user-visible text is built from a template in a component", () => {
    // The specific shapes that got through before: a units suffix and a source
    // label, both concatenated in a component and therefore English everywhere.
    const offenders = sources(SRC)
      .map((f) => [f, readFileSync(f, "utf8")] as const)
      .filter(([, s]) => /`\$\{[^}]+\}\s*(h|m|·)\s/.test(s) || /`\$\{[^}]+\} · viewers`/.test(s))
      .map(([f]) => f.replace(SRC, ""));

    expect(offenders).toEqual([]);
  });
});

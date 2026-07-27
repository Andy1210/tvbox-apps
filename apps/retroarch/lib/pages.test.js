// Consistency between the phone pages and the plugin's string tables.
//
// These pages are rendered by substituting {{placeholders}}, and their scripts then
// read the same strings back out of a hand-written `T` object. That is two lists to
// keep in step with a third (the plugin's tables), and drifting is silent: a missing
// entry in `T` renders the raw "{n}" to the user AND throws where it is used, which
// takes the rest of that function with it. Both of those shipped before this test
// existed, so the drift is checked rather than trusted.
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const PKG = path.join(__dirname, "..");
const PAGES_DIR = path.join(PKG, "pairing");
// page file -> the plugin table that renders it
const TABLES = { "roms.html": "STR", "share.html": "SHARE_STR", "cores.html": "CORES_STR" };
const LOCALES = ["hu", "en"];

const plugin = fs.readFileSync(path.join(PKG, "plugin.js"), "utf8");
const pages = fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith(".html"));

// The keys of one locale inside one `const <NAME> = { hu: {...}, en: {...} }` table.
function tableKeys(name, locale) {
  const start = plugin.indexOf("const " + name + " = {");
  assert.notStrictEqual(start, -1, "no table named " + name + " in plugin.js");
  const block = plugin.slice(start);
  const localeAt = block.indexOf(locale + ": {");
  assert.notStrictEqual(localeAt, -1, name + " has no " + locale + " locale");
  const seg = block.slice(localeAt);
  return new Set([...seg.slice(0, seg.indexOf("\n  },")).matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]));
}
const placeholders = (html) => new Set([...html.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));

test("every page has a string table", () => {
  for (const f of pages) assert.ok(TABLES[f], f + " renders with no known table (add it to TABLES)");
});

for (const f of pages) {
  const html = fs.readFileSync(path.join(PAGES_DIR, f), "utf8");
  const used = placeholders(html);
  used.delete("lang"); // supplied by the plugin, not part of the copy

  test(f + ": every placeholder exists in both locales", () => {
    for (const locale of LOCALES) {
      const keys = tableKeys(TABLES[f], locale);
      const missing = [...used].filter((k) => !keys.has(k)).sort();
      assert.deepStrictEqual(missing, [], f + " (" + locale + ") is missing: " + missing.join(", "));
    }
  });

  test(f + ": no string in the table is unused (dead copy rots)", () => {
    const keys = tableKeys(TABLES[f], LOCALES[0]);
    const dead = [...keys].filter((k) => !used.has(k)).sort();
    assert.deepStrictEqual(dead, [], f + " has strings nothing renders: " + dead.join(", "));
  });

  test(f + ": both locales define exactly the same keys", () => {
    const [a, b] = LOCALES.map((l) => tableKeys(TABLES[f], l));
    assert.deepStrictEqual([...a].sort(), [...b].sort(), "locale drift in " + TABLES[f]);
  });

  test(f + ": every T.key the script reads is defined in its T object", () => {
    const m = /const T = \{([\s\S]*?)\n\s*\};/.exec(html);
    assert.ok(m, f + " has no `const T = {...}` literal");
    const defined = new Set([...m[1].matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)].map((x) => x[1]));
    const body = html.slice(m.index + m[0].length);
    const read = new Set([...body.matchAll(/\bT\.([A-Za-z_]\w*)/g)].map((x) => x[1]));
    const missing = [...read].filter((k) => !defined.has(k)).sort();
    // A missing key is not a cosmetic problem: the raw text reaches the screen and
    // the expression throws, so whatever ran after it never happened.
    assert.deepStrictEqual(missing, [], f + ": T is missing " + missing.join(", "));
  });

  // A page that shows a raw code when it has no string for it must have one for
  // every code its library can produce, or the phone gets "Hiba: no_index".
  const lib = { "share.html": "share.js", "cores.html": "cores.js" }[f];
  if (lib && /errPrefix/.test(html)) {
    test(f + ": every error code " + lib + " returns has a sentence", () => {
      const src = fs.readFileSync(path.join(PKG, "lib", lib), "utf8");
      const codes = new Set([...src.matchAll(/error:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
      codes.add("failed"); // the page's own fallback when a response carries no code
      const m = /const T = \{([\s\S]*?)\n\s*\};/.exec(html);
      const defined = new Set([...m[1].matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)].map((x) => x[1]));
      const raw = [...codes].filter((c) => !defined.has(c)).sort();
      assert.deepStrictEqual(raw, [], f + " would show these codes raw: " + raw.join(", "));
    });
  }

  test(f + ": nothing is built into the page as markup", () => {
    // Values here come back from the box and include free text (a share name, a
    // folder), so the pages build DOM nodes instead of concatenating HTML.
    assert.ok(!/\binnerHTML\b/.test(html), f + " uses innerHTML");
  });
}

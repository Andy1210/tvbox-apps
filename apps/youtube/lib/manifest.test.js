// What this app PROMISES a box, pinned.
//
// The manifest is the part of a package that acts without anybody pressing anything:
// an app update lands unattended overnight, and whatever it declares is in force the
// next morning. So the two properties that decide what a release does on its own get an
// assertion each, rather than a reviewer's attention.
// Run: node --test apps/youtube/lib/manifest.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
const cast = (m.switches || []).find((s) => s.key === "cast");

test("the cast receiver ships OFF", () => {
  // It opens a listening socket on the LAN that takes an unauthenticated launch. A
  // `default: true` here would have both boxes advertising the night this publishes,
  // with nobody having asked for it - which is exactly what a review caught once.
  assert.ok(cast, "the cast switch is gone");
  assert.strictEqual(cast.default, false);
});

test("it needs the plugin that acts on it", () => {
  // Nothing in the shell acts on a switch; without a service it is a row that writes
  // config and changes nothing, and the box refuses the manifest for it.
  assert.strictEqual(m.service, "youtube");
});

test("every user-facing string is text, non-empty, and within what the box accepts", () => {
  // The box REFUSES a manifest that breaks these, and a refused manifest takes the app
  // off every box that has it - so a length is not a style rule here.
  const leaves = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v) : [null]);
  const within = (v, max) => leaves(v).every((s) => typeof s === "string" && s.length > 0 && s.length <= max);
  assert.ok(within(m.name, 80), "name");
  assert.ok(within(m.tagline, 240), "tagline");
  assert.ok(within(m.description, 1200), "description");
  for (const s of m.switches || []) {
    assert.ok(within(s.label, 80), "switches[].label");
    assert.ok(s.hint === undefined || within(s.hint, 240), "switches[].hint");
  }
});

test("the label is the word the phone uses, in both languages", () => {
  // The whole value of this label is that somebody recognises the thing they saw on
  // their phone: Hungarian YouTube says "Átküldés", not the loanword we say in code.
  assert.match(cast.label.hu, /Átküldés/);
  assert.match(cast.label.en, /Cast/i);
});

test("every release note is bilingual, and the one that introduced casting tells the owner where the switch is", () => {
  // The store shows this text, and for the release that brought the feature the menu
  // path in it is the only instruction anybody gets - an English-only path on a
  // Hungarian box names rows that do not exist. Later notes are fixes and need no path,
  // but they still have to be readable on this box.
  const notes = m.changelog || [];
  assert.ok(
    notes.find((c) => c.version === m.version),
    "no release note for the current version",
  );
  for (const c of notes.filter((c) => c.version.startsWith("1.1"))) {
    assert.match(c.notes, / \/ /, c.version + " is not bilingual");
    assert.match(c.notes, /[áéíóöőúüű]/i, c.version + " has no Hungarian half");
  }
  const intro = notes.find((c) => c.version === "1.1.0");
  assert.match(intro.notes, /Beállítások/, "no Hungarian path");
  assert.match(intro.notes, /Settings/, "no English path");
  assert.match(intro.notes, /wifi/i, "does not say who else can send to the TV");
});

// The settings store. Short, and every assertion is about a value that leaves
// this box: the numbers go into a session request to Microsoft and into the SDP
// offer, and a settings write is the one place a bad one can enter through an
// API that is unauthenticated on loopback.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-xcloud-settings-"));
const FILE = path.join(DIR, "xcloud-settings.json");
process.env.TVBOX_XCLOUD_SETTINGS = FILE;

const settings = require("./settings");

const fresh = () => {
  settings.reset();
  settings._reload();
};

test("the defaults decide nothing", () => {
  fresh();
  const s = settings.get();
  // 0 is "no cap" on both: the stream negotiates what the link allows, which is
  // the only default that cannot make things worse than not having the setting.
  assert.equal(s.maxVideoKbps, 0);
  assert.equal(s.maxHeight, 0);
  assert.equal(s.gameLocale, "");
  assert.equal(s.stereo, true);
});

test("a value outside the offered set is REFUSED, not clamped", () => {
  fresh();
  // Silently storing something else is worse than saying no: the screen would
  // show a choice that is not what the session will use.
  for (const bad of [{ maxVideoKbps: 12345 }, { maxHeight: 4320 }, { gameLocale: "xx-XX" }, { stereo: "yes" }]) {
    assert.throws(() => settings.set(bad), /bad value/, JSON.stringify(bad));
  }
  assert.deepEqual(settings.get(), settings.DEFAULTS);
});

test("an unknown key is refused by name", () => {
  fresh();
  assert.throws(() => settings.set({ nope: 1 }), /unknown setting: nope/);
});

test("the offending key is named, so a screen can point at it", () => {
  fresh();
  assert.throws(() => settings.set({ maxHeight: 1440 }), /maxHeight/);
});

test("a partial write leaves the rest alone", () => {
  fresh();
  settings.set({ maxVideoKbps: 10000 });
  settings.set({ stereo: false });
  assert.equal(settings.get().maxVideoKbps, 10000);
  assert.equal(settings.get().stereo, false);
});

test("one bad key in a write stores NONE of it", () => {
  fresh();
  settings.set({ maxVideoKbps: 10000 });
  assert.throws(() => settings.set({ maxHeight: 720, gameLocale: "nope" }));
  // Half-applying a form is how a screen ends up disagreeing with the box.
  assert.equal(settings.get().maxHeight, 0);
  assert.equal(settings.get().maxVideoKbps, 10000);
});

test("what is written survives a reload", () => {
  fresh();
  settings.set({ maxHeight: 720, gameLocale: "hu-HU" });
  settings._reload();
  assert.equal(settings.get().maxHeight, 720);
  assert.equal(settings.get().gameLocale, "hu-HU");
});

test("a file holding a value we no longer offer falls back to the default", () => {
  fresh();
  // An older build's setting, or a hand-edited file. The stored value reaches a
  // session request, so an unrecognised one is dropped rather than passed on.
  fs.writeFileSync(FILE, JSON.stringify({ maxHeight: 1440, stereo: false }));
  settings._reload();
  assert.equal(settings.get().maxHeight, 0);
  assert.equal(settings.get().stereo, false, "the valid half is still honoured");
});

test("an unreadable file is the defaults, not a crash", () => {
  fresh();
  fs.writeFileSync(FILE, "{not json");
  settings._reload();
  assert.deepEqual(settings.get(), settings.DEFAULTS);
});

test("get returns a copy, so a caller cannot edit the store", () => {
  fresh();
  const s = settings.get();
  s.maxVideoKbps = 99999;
  assert.equal(settings.get().maxVideoKbps, 0);
});

test("reset forgets the file too", () => {
  fresh();
  settings.set({ maxHeight: 720 });
  settings.reset();
  assert.equal(fs.existsSync(FILE), false);
  assert.deepEqual(settings.get(), settings.DEFAULTS);
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// Linking games in from elsewhere on the box.
//
// The library is a real directory of uploads AND a set of links to other places,
// so most of what matters here is what must not happen: a link must never take
// the place of a folder somebody uploaded games into, and it must never point at
// the library itself.
//
// HOME is redirected before the require: the roms dir resolves at import.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-folders-test-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const ROMS = path.join(HOME, ".tvbox", "roms");
const STICK = path.join(HOME, "stick", "games");
fs.mkdirSync(STICK, { recursive: true });
fs.mkdirSync(path.join(ROMS, "snes"), { recursive: true }); // uploaded games

const folders = require("./folders");

function reset() {
  try {
    fs.unlinkSync(folders.CONFIG_FILE);
  } catch (e) {
    /* first run */
  }
  for (const n of fs.readdirSync(ROMS)) {
    const p = path.join(ROMS, n);
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
  }
}

test("a folder somewhere else on the box becomes a link inside the library", () => {
  reset();
  assert.deepStrictEqual(folders.add({ name: "usb", path: STICK }), { ok: true, name: "usb" });
  const link = path.join(ROMS, "usb");
  assert.strictEqual(fs.lstatSync(link).isSymbolicLink(), true);
  assert.strictEqual(fs.realpathSync(link), fs.realpathSync(STICK));
  assert.deepStrictEqual(
    folders.status().map((f) => [f.name, f.present, f.linked]),
    [["usb", true, true]],
  );
});

test("a name a real folder already uses is refused, not overwritten", () => {
  // roms/snes holds uploaded games. Taking that name would hide somebody's
  // library behind a link, and removing the link later would not bring it back.
  reset();
  assert.deepStrictEqual(folders.add({ name: "snes", path: STICK }), { ok: false, error: "name_taken" });
  assert.strictEqual(fs.lstatSync(path.join(ROMS, "snes")).isDirectory(), true);
});

test("the library cannot be linked into itself", () => {
  reset();
  assert.strictEqual(folders.add({ name: "loop", path: ROMS }).error, "bad_path");
  assert.strictEqual(folders.add({ name: "inner", path: path.join(ROMS, "snes") }).error, "bad_path");
});

test("only ground the box offers as a source may be linked", () => {
  // The screen only ever shows the box's own sources, but this is the route: every
  // app here shares the shell's origin, so "the UI would never send that" is not a
  // rule. /etc is not a game library.
  reset();
  assert.strictEqual(folders.add({ name: "sys", path: "/etc" }).error, "bad_path");
  assert.strictEqual(folders.add({ name: "root", path: "/" }).error, "bad_path");
  assert.strictEqual(folders.add({ name: "usb", path: STICK }).ok, true, "the home directory is fine");
});

test("a path that is not a directory on this box is refused", () => {
  reset();
  assert.strictEqual(folders.add({ name: "gone", path: path.join(HOME, "nope") }).error, "bad_path");
  assert.strictEqual(folders.add({ name: "rel", path: "stick/games" }).error, "bad_path");
  const file = path.join(HOME, "afile");
  fs.writeFileSync(file, "x");
  assert.strictEqual(folders.add({ name: "file", path: file }).error, "bad_path");
});

test("a name that is not a path segment is refused", () => {
  reset();
  for (const name of ["", "../up", "Nagy Betű", "a/b", "x".repeat(40)]) {
    assert.strictEqual(folders.add({ name, path: STICK }).ok, false, JSON.stringify(name));
  }
});

test("adding the same name again re-points it instead of piling up", () => {
  reset();
  const other = path.join(HOME, "stick", "more");
  fs.mkdirSync(other, { recursive: true });
  folders.add({ name: "usb", path: STICK });
  folders.add({ name: "usb", path: other });
  assert.strictEqual(folders.read().length, 1);
  assert.strictEqual(fs.realpathSync(path.join(ROMS, "usb")), fs.realpathSync(other));
});

test("removing takes the link away and leaves the games where they were", () => {
  reset();
  folders.add({ name: "usb", path: STICK });
  assert.strictEqual(folders.remove("usb").ok, true);
  assert.strictEqual(fs.existsSync(path.join(ROMS, "usb")), false);
  assert.strictEqual(fs.existsSync(STICK), true);
  assert.deepStrictEqual(folders.status(), []);
});

test("a stick that is not plugged in keeps its name and says it is missing", () => {
  // The link is the user's chosen name, and that name is written into every
  // playlist entry. Dropping it because a stick is out would invalidate a scanned
  // library that comes back the moment the stick does.
  reset();
  const gone = path.join(HOME, "stick", "temporary");
  fs.mkdirSync(gone, { recursive: true });
  folders.add({ name: "temp", path: gone });
  fs.rmSync(gone, { recursive: true });
  const st = folders.apply();
  assert.deepStrictEqual(
    st.map((f) => [f.name, f.present]),
    [["temp", false]],
  );
  assert.strictEqual(folders.read().length, 1, "the folder is remembered, not forgotten");
});

test.after(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

// Library tests for the ROM store. The upload route is reachable from a phone on
// the LAN (behind the pairing code), so the name and offset rules are the only
// thing keeping an upload inside its folder and a retried chunk from corrupting a
// game. HOME is redirected to a temp dir BEFORE the module loads, because it
// resolves its base directory at require time.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-roms-test-"));
process.env.HOME = HOME;
const roms = require("./roms");

const b64 = (s) => Buffer.from(s).toString("base64");
const reset = () => fs.rmSync(roms.ROMS_DIR, { recursive: true, force: true });

test("the base dir really is the redirected HOME (the tests are not touching a real library)", () => {
  assert.ok(roms.ROMS_DIR.startsWith(HOME), roms.ROMS_DIR);
});

test("a single-chunk upload lands as a playable file", () => {
  reset();
  const r = roms.writeChunk({ system: "nes", name: "game.nes", offset: 0, data: b64("ABCD"), last: true });
  assert.deepStrictEqual({ ok: r.ok, done: r.done, size: r.size }, { ok: true, done: true, size: 4 });
  assert.strictEqual(fs.readFileSync(path.join(roms.ROMS_DIR, "nes", "game.nes"), "utf8"), "ABCD");
});

test("chunks append in order and the file only appears when the last one lands", () => {
  reset();
  assert.ok(roms.writeChunk({ system: "psx", name: "disc.chd", offset: 0, data: b64("aaa") }).ok);
  const final = path.join(roms.ROMS_DIR, "psx", "disc.chd");
  assert.ok(!fs.existsSync(final), "an unfinished upload must not look like a game");
  assert.ok(fs.existsSync(final + ".part"));
  assert.ok(roms.writeChunk({ system: "psx", name: "disc.chd", offset: 3, data: b64("bbb"), last: true }).ok);
  assert.strictEqual(fs.readFileSync(final, "utf8"), "aaabbb");
  assert.ok(!fs.existsSync(final + ".part"), "the partial file is renamed, not left behind");
});

test("a chunk at the wrong offset is refused, so a retry cannot double-append", () => {
  reset();
  roms.writeChunk({ system: "gba", name: "x.gba", offset: 0, data: b64("0123") });
  const again = roms.writeChunk({ system: "gba", name: "x.gba", offset: 0, data: b64("0123") });
  assert.ok(again.ok, "offset 0 restarts the upload cleanly");
  const wrong = roms.writeChunk({ system: "gba", name: "x.gba", offset: 99, data: b64("zz") });
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(wrong.error, "offset_mismatch");
  assert.strictEqual(wrong.size, 4, "the caller is told where to resume from");
});

test("a name cannot escape its system folder", () => {
  reset();
  for (const name of [
    "../escaped.nes",
    "../../escaped.nes",
    "sub/dir.nes",
    "back\\slash.nes",
    ".hidden",
    "",
    "a".repeat(200),
    "already.part",
  ]) {
    const r = roms.writeChunk({ system: "nes", name, offset: 0, data: b64("x"), last: true });
    assert.strictEqual(r.ok, false, JSON.stringify(name) + " must be refused");
    assert.strictEqual(r.error, "bad_name");
  }
  // nothing was created anywhere above the library
  assert.ok(!fs.existsSync(path.join(HOME, ".tvbox", "escaped.nes")));
  assert.ok(!fs.existsSync(path.join(HOME, "escaped.nes")));
});

test("a system is a plain slug, not a path", () => {
  for (const system of ["../nes", "NES", "ne s", "nes/sub", "", "-nes", "a".repeat(40)]) {
    assert.strictEqual(roms.systemOk(system), false, JSON.stringify(system) + " must be refused");
  }
  for (const system of ["nes", "megadrive", "psx", "n64", "gb", "arcade1", "a"]) {
    assert.strictEqual(roms.systemOk(system), true, system + " should be fine");
  }
});

test("a control character in a name is refused rather than stripped", () => {
  assert.strictEqual(roms.nameOk("ok.nes"), true);
  assert.strictEqual(roms.nameOk("bad\x00.nes"), false);
  assert.strictEqual(roms.nameOk("bad\n.nes"), false);
  assert.strictEqual(roms.nameOk("bad\x7f.nes"), false);
});

test("an offset that would run past the size cap is refused", () => {
  reset();
  const r = roms.writeChunk({ system: "nes", name: "huge.nes", offset: roms.MAX_FILE_BYTES, data: b64("x") });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "too_big");
});

test("list groups by system and flags unfinished uploads", () => {
  reset();
  roms.writeChunk({ system: "nes", name: "done.nes", offset: 0, data: b64("aa"), last: true });
  roms.writeChunk({ system: "nes", name: "half.nes", offset: 0, data: b64("a") });
  roms.writeChunk({ system: "gb", name: "other.gb", offset: 0, data: b64("aaa"), last: true });
  const groups = roms.list();
  assert.deepStrictEqual(
    groups.map((g) => g.system),
    ["gb", "nes"],
  );
  const nes = groups.find((g) => g.system === "nes");
  assert.strictEqual(nes.files.find((f) => f.name === "half.nes").partial, true);
  assert.strictEqual(nes.files.find((f) => f.name === "done.nes").partial, false);
  assert.strictEqual(roms.count(), 2, "partial uploads are not counted as games");
});

test("remove deletes the game, its partial, and an emptied system folder", () => {
  reset();
  roms.writeChunk({ system: "n64", name: "g.z64", offset: 0, data: b64("aa"), last: true });
  fs.writeFileSync(path.join(roms.ROMS_DIR, "n64", "g.z64.part"), "a"); // an abandoned partial beside it
  assert.strictEqual(roms.remove("n64", "g.z64"), true);
  assert.strictEqual(fs.existsSync(path.join(roms.ROMS_DIR, "n64")), false);
  assert.strictEqual(roms.remove("n64", "g.z64"), false, "already gone");
});

test("remove refuses a traversing name instead of deleting outside the library", () => {
  reset();
  const victim = path.join(HOME, "victim.txt");
  fs.writeFileSync(victim, "keep me");
  assert.strictEqual(roms.remove("nes", "../../victim.txt"), false);
  assert.strictEqual(fs.readFileSync(victim, "utf8"), "keep me");
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test("uploads and deletes never reach through a linked-in folder", () => {
  reset();
  const elsewhere = path.join(HOME, "elsewhere");
  fs.rmSync(elsewhere, { recursive: true, force: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "keep.txt"), "mine");
  fs.mkdirSync(roms.ROMS_DIR, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(roms.ROMS_DIR, "linked"));
  const w = roms.writeChunk({ system: "linked", name: "plugin.js", offset: 0, data: b64("x"), last: true });
  assert.deepStrictEqual(w, { ok: false, error: "is_link" });
  assert.ok(!fs.existsSync(path.join(elsewhere, "plugin.js")));
  assert.deepStrictEqual(roms.removeSystem("linked"), { ok: false, error: "is_link" });
  assert.strictEqual(roms.remove("linked", "keep.txt"), false);
  assert.strictEqual(fs.readFileSync(path.join(elsewhere, "keep.txt"), "utf8"), "mine");
});

test("an upload does not write through a link planted in a real system folder", () => {
  reset();
  const target = path.join(HOME, "victim.txt");
  fs.writeFileSync(target, "mine");
  fs.mkdirSync(path.join(roms.ROMS_DIR, "nes"), { recursive: true });
  fs.symlinkSync(target, path.join(roms.ROMS_DIR, "nes", "game.nes.part"));
  const w = roms.writeChunk({ system: "nes", name: "game.nes", offset: 0, data: b64("x"), last: true });
  assert.strictEqual(w.ok, false);
  assert.strictEqual(fs.readFileSync(target, "utf8"), "mine");
});

test("an upload never replaces a game that is already there", () => {
  reset();
  assert.ok(roms.writeChunk({ system: "gba", name: "z.gba", offset: 0, data: b64("GOOD"), last: true }).ok);
  const again = roms.writeChunk({ system: "gba", name: "z.gba", offset: 0, data: b64("EVIL"), last: true });
  assert.deepStrictEqual(again, { ok: false, error: "exists" });
  assert.strictEqual(fs.readFileSync(path.join(roms.ROMS_DIR, "gba", "z.gba"), "utf8"), "GOOD");
});

test("an upload that another one finished first does not replace it on its last chunk", () => {
  reset();
  assert.ok(roms.writeChunk({ system: "gba", name: "r.gba", offset: 0, data: b64("aa") }).ok);
  fs.writeFileSync(path.join(roms.ROMS_DIR, "gba", "r.gba"), "FIRST");
  const last = roms.writeChunk({ system: "gba", name: "r.gba", offset: 2, data: b64("cc"), last: true });
  assert.deepStrictEqual(last, { ok: false, error: "exists" });
  assert.strictEqual(fs.readFileSync(path.join(roms.ROMS_DIR, "gba", "r.gba"), "utf8"), "FIRST");
  assert.ok(!fs.existsSync(path.join(roms.ROMS_DIR, "gba", "r.gba.part")), "the refused partial is removed");
});

test("a game that lands between the check and the final move is kept", () => {
  reset();
  assert.ok(roms.writeChunk({ system: "gba", name: "g.gba", offset: 0, data: b64("aa") }).ok);
  const final = path.join(roms.ROMS_DIR, "gba", "g.gba");
  // The other upload finishes while this one appends its last chunk, i.e. after
  // the existence check has already passed.
  const append = fs.appendFileSync;
  fs.appendFileSync = (...args) => {
    append(...args);
    fs.writeFileSync(final, "FIRST");
  };
  let last;
  try {
    last = roms.writeChunk({ system: "gba", name: "g.gba", offset: 2, data: b64("cc"), last: true });
  } finally {
    fs.appendFileSync = append;
  }
  assert.deepStrictEqual(last, { ok: false, error: "exists" });
  assert.strictEqual(fs.readFileSync(final, "utf8"), "FIRST");
  assert.ok(!fs.existsSync(final + ".part"), "the finished partial of a refused upload is removed");
});

test("on a file system with no hard links, a refused last chunk also drops its partial", () => {
  reset();
  assert.ok(roms.writeChunk({ system: "gba", name: "f.gba", offset: 0, data: b64("aa") }).ok);
  const final = path.join(roms.ROMS_DIR, "gba", "f.gba");
  const link = fs.linkSync;
  fs.linkSync = () => {
    fs.writeFileSync(final, "FIRST");
    throw Object.assign(new Error("no links"), { code: "EPERM" });
  };
  let last;
  try {
    last = roms.writeChunk({ system: "gba", name: "f.gba", offset: 2, data: b64("cc"), last: true });
  } finally {
    fs.linkSync = link;
  }
  assert.deepStrictEqual(last, { ok: false, error: "exists" });
  assert.strictEqual(fs.readFileSync(final, "utf8"), "FIRST");
  assert.ok(!fs.existsSync(final + ".part"));
});

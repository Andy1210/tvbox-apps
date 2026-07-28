// Tests for the core catalogue. The buildbot's index is the only thing that says
// whether an installed core is stale, and its CRC32 is also what a download is
// verified against, so the parsing and the comparison are worth pinning. HOME is
// redirected before the module loads: it resolves the cores directory at require
// time. Nothing here reaches the network.
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-cores-test-"));
const REAL_HOME = process.env.HOME; // put back in teardown: a deleted HOME would follow us
process.env.HOME = HOME;
const cores = require("./cores");

// CRC32("123456789") is a standard test vector, so this pins the checksum against
// something external rather than against the implementation itself.
const CRC_VECTOR = { data: "123456789", crc: "cbf43926" };

function putCore(name, data) {
  fs.mkdirSync(cores.CORES_DIR, { recursive: true });
  fs.writeFileSync(path.join(cores.CORES_DIR, name + "_libretro.so"), data);
}
const reset = () => fs.rmSync(cores.CORES_DIR, { recursive: true, force: true });

test("the cores directory is under the redirected HOME", () => {
  assert.ok(cores.CORES_DIR.startsWith(HOME), cores.CORES_DIR);
});

test("the buildbot url carries the arch libretro publishes under, not Node's name", () => {
  const url = cores.baseUrl();
  assert.match(url, /^https:\/\/buildbot\.libretro\.com\/nightly\/linux\/(aarch64|x86_64)\/latest\/$/);
  assert.ok(!url.includes("arm64"), "libretro has no linux/arm64 path; that one 404s");
});

test("the index is parsed by line, and anything malformed is skipped", () => {
  const idx = cores.parseIndex(
    [
      "2026-07-26 689507b9 fceumm_libretro.so.zip",
      "2026-07-23 6e303f26 genesis_plus_gx_libretro.so.zip",
      "not an index line at all",
      "2026-07-26 SHORT snes9x_libretro.so.zip",
      "2026-07-24 f70b63c9 some_other_file.txt",
      "",
    ].join("\n"),
  );
  assert.strictEqual(idx.size, 2);
  assert.deepStrictEqual(idx.get("fceumm"), { date: "2026-07-26", crc: "689507b9" });
  assert.strictEqual(idx.has("snes9x"), false, "a malformed checksum must not be trusted");
});

test("an installed core reports its own CRC32", () => {
  reset();
  putCore("fceumm", CRC_VECTOR.data);
  assert.deepStrictEqual(cores.installed(), ["fceumm"]);
  // with an index present: the checksum exists to be compared against it, and is
  // not read when there is nothing to compare with (see the offline test below)
  const entry = cores
    .list(cores.parseIndex("2026-07-26 deadbeef fceumm_libretro.so.zip"))
    .find((c) => c.core === "fceumm");
  assert.strictEqual(entry.crc, CRC_VECTOR.crc);
});

test("a core is updatable only when the index advertises a different build", () => {
  reset();
  putCore("fceumm", CRC_VECTOR.data);
  const same = cores.parseIndex("2026-07-26 " + CRC_VECTOR.crc + " fceumm_libretro.so.zip");
  const moved = cores.parseIndex("2026-07-27 deadbeef fceumm_libretro.so.zip");
  const of = (index) => cores.list(index).find((c) => c.core === "fceumm");
  assert.strictEqual(of(same).installed, true);
  assert.strictEqual(of(same).updatable, false, "the same checksum is not an update");
  assert.strictEqual(of(moved).updatable, true);
  assert.strictEqual(of(moved).remoteDate, "2026-07-27");
});

test("with no index (offline) nothing claims to be updatable", () => {
  reset();
  putCore("fceumm", CRC_VECTOR.data);
  const entry = cores.list(null).find((c) => c.core === "fceumm");
  assert.strictEqual(entry.installed, true, "what is on disk is still reported");
  assert.strictEqual(entry.updatable, false, "guessing an update while offline would be a lie");
  assert.strictEqual(entry.remoteDate, null);
});

test("a core that is not installed is neither installed nor updatable", () => {
  reset();
  const entry = cores
    .list(cores.parseIndex("2026-07-26 deadbeef fceumm_libretro.so.zip"))
    .find((c) => c.core === "fceumm");
  assert.strictEqual(entry.installed, false);
  assert.strictEqual(entry.updatable, false);
});

test("install refuses a core name that is not a plain slug", async () => {
  const idx = cores.parseIndex("2026-07-26 deadbeef fceumm_libretro.so.zip");
  for (const bad of ["../../etc/passwd", "core; rm -rf /", "Core", "a b", ""]) {
    const r = await cores.install(bad, {}, idx);
    assert.strictEqual(r.ok, false, JSON.stringify(bad));
    assert.strictEqual(r.error, "bad_core");
  }
});

test("install only accepts what the index actually publishes", async () => {
  // The list is dynamic, so the index IS the allowlist: a well-formed name that
  // libretro does not publish must not turn into a download attempt.
  const idx = cores.parseIndex("2026-07-26 deadbeef fceumm_libretro.so.zip");
  assert.deepStrictEqual(await cores.install("no_such_core", {}, idx), { ok: false, error: "not_published" });
  assert.deepStrictEqual(await cores.install("fceumm", {}, null), { ok: false, error: "no_index" });
});

test("the info files give a core its human name, and a nameless core still lists", () => {
  const parsed = cores.parseInfo(
    'display_name = "Sony - PlayStation 2 (LRPS2)"\ncorename = "LRPS2"\nsystemname = "Sony PlayStation 2"\n',
  );
  assert.deepStrictEqual(parsed, {
    display: "Sony - PlayStation 2 (LRPS2)",
    name: "LRPS2",
    system: "Sony PlayStation 2",
    api: "",
  });
  reset();
  const entry = cores
    .list(cores.parseIndex("2026-07-26 deadbeef weird_core_libretro.so.zip"))
    .find((c) => c.core === "weird_core");
  assert.strictEqual(entry.label, "weird_core", "with no info file the file name is the label");
  assert.strictEqual(entry.available, true);
});

test("the list carries everything the index publishes, plus what is installed", () => {
  reset();
  putCore("gone_from_buildbot", CRC_VECTOR.data);
  const l = cores.list(cores.parseIndex("2026-07-26 deadbeef fceumm_libretro.so.zip"));
  const byCore = new Map(l.map((c) => [c.core, c]));
  assert.ok(byCore.has("fceumm"), "published but not installed");
  assert.strictEqual(byCore.get("fceumm").installed, false);
  // an installed core the buildbot no longer offers must not vanish from the list
  assert.strictEqual(byCore.get("gone_from_buildbot").installed, true);
  assert.strictEqual(byCore.get("gone_from_buildbot").available, false);
  assert.strictEqual(byCore.get("gone_from_buildbot").updatable, false);
  assert.strictEqual(l[0].installed, true, "installed cores sort first");
});

test("remove refuses a traversing name and only deletes inside the cores dir", () => {
  reset();
  putCore("fceumm", CRC_VECTOR.data);
  const victim = path.join(HOME, "victim.txt");
  fs.writeFileSync(victim, "keep me");
  assert.deepStrictEqual(cores.remove("../../victim"), { ok: false, error: "bad_core" });
  assert.strictEqual(fs.readFileSync(victim, "utf8"), "keep me");
  assert.deepStrictEqual(cores.remove("fceumm"), { ok: true, core: "fceumm" });
  assert.deepStrictEqual(cores.installed(), []);
  // an error CODE, not a bare false: the phone page has a sentence per code
  assert.deepStrictEqual(cores.remove("fceumm"), { ok: false, error: "remove_failed" }, "already gone");
});

test("the info dir follows the box's architecture", () => {
  // Hard-coding aarch64 here would leave an x86_64 box with no core metadata at
  // all, so every core would show as its bare file name.
  for (const dir of cores.INFO_DIRS) assert.match(dir, /\/(aarch64|x86_64)\//);
});

// The list checksums every installed core, and a core is tens of MB, so the read is
// chunked. Chunking is easy to get subtly wrong (the running value has to carry
// between pieces), and the consequence would be a core that always looks stale.
test("a file larger than one chunk checksums the same as reading it whole", () => {
  reset();
  const big = Buffer.alloc(200 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  putCore("bigcore", big);
  const p = path.join(cores.CORES_DIR, "bigcore_libretro.so");
  const entry = cores
    .list(cores.parseIndex("2026-07-26 deadbeef bigcore_libretro.so.zip"))
    .find((c) => c.core === "bigcore");
  // zlib over the whole buffer is an independent oracle, not this implementation
  assert.strictEqual(entry.crc, (zlib.crc32(fs.readFileSync(p)) >>> 0).toString(16).padStart(8, "0"));
  assert.ok(big.length > 65536, "the file has to span more than one chunk to prove anything");
});

test("a changed core is checksummed again, not served from the cache", () => {
  reset();
  putCore("fceumm", CRC_VECTOR.data);
  const idx = cores.parseIndex("2026-07-26 " + CRC_VECTOR.crc + " fceumm_libretro.so.zip");
  const of = () => cores.list(idx).find((c) => c.core === "fceumm");
  assert.strictEqual(of().updatable, false, "the installed core matches the index");
  // Same length, different bytes, and an explicitly bumped mtime - a cache keyed on
  // size alone (or on a same-millisecond mtime) would keep answering the old value.
  const p = path.join(cores.CORES_DIR, "fceumm_libretro.so");
  fs.writeFileSync(p, "987654321");
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(p, t, t);
  assert.strictEqual(of().updatable, true, "the file changed, so it no longer matches");
});

test("with no index the checksum is not computed at all", () => {
  reset();
  putCore("fceumm", CRC_VECTOR.data);
  const entry = cores.list(null).find((c) => c.core === "fceumm");
  assert.strictEqual(entry.installed, true);
  assert.strictEqual(entry.crc, null, "nothing to compare against, so nothing is read");
});

// ---- which driver a core gets ----
//
// This hardware serves desktop GL 3.1 (compat), GLES 3.1 and Vulkan, but no GL
// core profile above 3.1, and RetroArch asks for exactly what a core declares. So
// the rule reads the core's own `required_hw_api`; getting it wrong means a core
// that either refuses to start or runs on the CPU.
test("the video driver comes from what the core says it needs", () => {
  const cases = [
    ["OpenGL >= 3.0 | OpenGL ES >= 2.0", "gl"], // OpenLara
    ["OpenGL Core >= 3.3 | Vulkan >= 1.0", "vulkan"], // Beetle PSX HW: its GL needs a core profile we do not have
    ["OpenGL >= 3.0 | OpenGL ES >= 2.0 | Vulkan >= 1.0", "gl"], // both work; GL is the global default
    ["OpenGL Core >= 3.3 | OpenGL ES >= 2.0", "gl"], // the ES option is the way in
    ["OpenGL Core >= 4.5", null], // nothing here can serve it - not ours to force
    ["Direct3D11 >= 11.0", null],
    ["", null], // undeclared (a software core): the global driver is fine
    [undefined, null],
  ];
  for (const [api, want] of cases) assert.strictEqual(cores.videoDriverFor(api), want, JSON.stringify(api));
});

test("an override sets only video_driver and leaves the rest of the file alone", () => {
  // RetroArch writes these files itself for core options and input remaps, so
  // anything else in there is the user's.
  const dir = path.join(cores.OVERRIDES_DIR, "Beetle PSX HW");
  const file = path.join(dir, "Beetle PSX HW.cfg");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, 'input_player1_analog_dpad_mode = "1"\nvideo_driver = "gl"\n');
  assert.strictEqual(cores.setOverrideDriver("Beetle PSX HW", "vulkan"), true);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /input_player1_analog_dpad_mode = "1"/, "the user's own line must survive");
  assert.match(after, /video_driver = "vulkan"/);
  assert.strictEqual((after.match(/video_driver/g) || []).length, 1, "no duplicate key");
  // clearing it leaves the file (the other key is still wanted)
  cores.setOverrideDriver("Beetle PSX HW", null);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /video_driver/);
});

test("an override file that only carried our key is removed, not left empty", () => {
  const file = path.join(cores.OVERRIDES_DIR, "Craft", "Craft.cfg");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'video_driver = "vulkan"\n');
  cores.setOverrideDriver("Craft", null);
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(fs.existsSync(path.dirname(file)), false, "and the directory goes with it");
});

test("a corename that could escape its directory is refused", () => {
  for (const bad of ["../../etc", "a/b", "..", ""]) assert.strictEqual(cores.setOverrideDriver(bad, "gl"), false);
});

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

test("only a regular file is accepted as a core", () => {
  // A zip entry can be a symlink. If one named like the core were accepted, the
  // checksum would be of its TARGET and the install would copy that file into the
  // cores dir - so the extracted entry is checked with lstat, not existsSync.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-entry-"));
  const real = path.join(dir, "real.so");
  fs.writeFileSync(real, CRC_VECTOR.data);
  const link = path.join(dir, "link.so");
  fs.symlinkSync(real, link);
  assert.strictEqual(cores.isRegularFile(real), true);
  assert.strictEqual(cores.isRegularFile(link), false, "a symlink must not pass as a core");
  assert.strictEqual(cores.isRegularFile(dir), false, "nor a directory");
  assert.strictEqual(cores.isRegularFile(path.join(dir, "missing.so")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

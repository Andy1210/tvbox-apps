// Tests for the core catalogue. The buildbot's index is the only thing that says
// whether an installed core is stale, and its CRC32 is also what a download is
// verified against, so the parsing and the comparison are worth pinning. HOME is
// redirected before the module loads: it resolves the cores directory at require
// time. Nothing here reaches the network.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-cores-test-"));
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
  const entry = cores.list(null).find((c) => c.core === "fceumm");
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
  assert.strictEqual(cores.remove("../../victim"), false);
  assert.strictEqual(fs.readFileSync(victim, "utf8"), "keep me");
  assert.strictEqual(cores.remove("fceumm"), true);
  assert.deepStrictEqual(cores.installed(), []);
  assert.strictEqual(cores.remove("fceumm"), false, "already gone");
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

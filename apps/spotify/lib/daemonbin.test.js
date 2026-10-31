const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { refreshBinary } = require("./daemonbin");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const url = "https://example.invalid/librespot";

function setup(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daemonbin-"));
  const file = path.join(dir, "librespot");
  if (content !== undefined) fs.writeFileSync(file, content);
  return { dir, file };
}
const writes = (content) => async (u, dest) => fs.writeFileSync(dest, content);
const replaces = [sha("old")];
const forbidden = async () => assert.fail("nothing should be downloaded");

test("the wanted build is left alone", async () => {
  const { file } = setup("new");
  assert.equal(await refreshBinary({ file, spec: { url, sha256: sha("new") }, replaces, download: forbidden }), false);
});

test("somebody's own build is left alone", async () => {
  const { file } = setup("own");
  assert.equal(await refreshBinary({ file, spec: { url, sha256: sha("new") }, replaces, download: forbidden }), false);
  assert.equal(fs.readFileSync(file, "utf8"), "own");
});

test("a binary that is not there is not this app's to replace", async () => {
  const { file } = setup();
  assert.equal(await refreshBinary({ file, spec: { url, sha256: sha("new") }, replaces, download: forbidden }), false);
  assert.equal(fs.existsSync(file), false);
});

test("an older build is replaced and stays executable", async () => {
  const { dir, file } = setup("old");
  assert.equal(
    await refreshBinary({ file, spec: { url, sha256: sha("new") }, replaces, download: writes("new") }),
    true,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.ok(fs.statSync(file).mode & 0o100);
  assert.deepEqual(fs.readdirSync(dir), ["librespot"]);
});

test("a download with the wrong hash keeps the old build", async () => {
  const { dir, file } = setup("old");
  assert.equal(
    await refreshBinary({ file, spec: { url, sha256: sha("new") }, replaces, download: writes("evil") }),
    false,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["librespot"]);
});

test("overlapping updates do not share a temp file", async () => {
  const { file } = setup("old");
  const seen = [];
  const download = async (u, dest) => {
    seen.push(dest);
    fs.writeFileSync(dest, "new");
  };
  const spec = { url, sha256: sha("new") };
  await Promise.all([
    refreshBinary({ file, spec, replaces, download }),
    refreshBinary({ file, spec, replaces, download }),
  ]);
  assert.equal(new Set(seen).size, 2);
  assert.equal(fs.readFileSync(file, "utf8"), "new");
});

test("a binary that changed during the download is left alone", async () => {
  const { dir, file } = setup("old");
  const download = async (u, dest) => {
    fs.writeFileSync(file, "own");
    fs.writeFileSync(dest, "new");
  };
  assert.equal(await refreshBinary({ file, spec: { url, sha256: sha("new") }, replaces, download }), false);
  assert.equal(fs.readFileSync(file, "utf8"), "own");
  assert.deepEqual(fs.readdirSync(dir), ["librespot"]);
});

test("a failed download keeps the old build", async () => {
  const { dir, file } = setup("old");
  const download = async (u, dest) => {
    fs.writeFileSync(dest, "part");
    throw new Error("network");
  };
  const logged = [];
  const log = (m) => logged.push(m);
  assert.equal(await refreshBinary({ file, spec: { url, sha256: sha("new") }, replaces, download, log }), false);
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["librespot"]);
  assert.match(logged[0], /network/);
});

test("a malformed spec never downloads", async () => {
  const { file } = setup("old");
  for (const spec of [undefined, { url, sha256: "x" }, { url: "http://example.invalid/a", sha256: sha("new") }])
    assert.equal(await refreshBinary({ file, spec, replaces, download: forbidden }), false);
});

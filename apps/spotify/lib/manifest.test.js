// The plugin starts the binary by name and the box downloads it by the manifest's
// name, so a mismatch leaves the box with a daemon that cannot start.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const plugin = fs.readFileSync(path.join(dir, "plugin.js"), "utf8");

test("the plugin starts the binary the manifest downloads", () => {
  const name = plugin.match(/const LIBRESPOT_BIN = "([^"]+)"/)[1];
  assert.deepStrictEqual(manifest.requires.bin, [name]);
  assert.deepStrictEqual(
    manifest.requires.download.map((d) => d.bin),
    [name],
  );
});

// pkill -x matches the kernel's process name, which is cut at 15 characters.
test("the binary's name fits the process name pkill matches", () => {
  assert.ok(manifest.requires.bin[0].length <= 15);
});

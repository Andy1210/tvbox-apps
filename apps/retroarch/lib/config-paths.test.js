// RetroArch's bundled content must stay pinned to the flatpak prefix.
//
// A retroarch.cfg that RetroArch generates for itself points assets, gamepad
// autoconfig, core info and the content database at user directories under
// ~/.var that nothing ever fills. The plugin therefore pins all four to
// /app/share/libretro, where the flatpak actually ships them.
//
// This is guarded because losing it does not look like a path problem. On a fresh
// box it reads as three unrelated faults: the menu draws black squares instead of
// icons, the interface is missing its furniture, and a paired controller logs
// "not configured" - no autoconfig profile matched, so no button is mapped and
// NOTHING drives the UI, neither pad nor remote. Diagnosing that from the symptoms
// costs hours; a failing assertion here costs seconds.
//
// Source-text assertions, the same technique pages.test.js uses: requiredSettings
// is module-private, and reaching it would mean loading the plugin with a fake host.
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const PKG = path.join(__dirname, "..");
const plugin = fs.readFileSync(path.join(PKG, "plugin.js"), "utf8");

// The block requiredSettings() returns - assert inside it, so a mention in a
// comment somewhere else cannot satisfy these.
function requiredSettingsBlock() {
  const start = plugin.indexOf("function requiredSettings()");
  assert.notStrictEqual(start, -1, "no requiredSettings() in plugin.js");
  const end = plugin.indexOf("\n}", start);
  assert.notStrictEqual(end, -1, "requiredSettings() is not closed");
  return plugin.slice(start, end);
}

test("the flatpak's own assets, autoconfig, core info and database stay pinned", () => {
  const block = requiredSettingsBlock();
  const pinned = {
    assets_directory: "/app/share/libretro/assets",
    joypad_autoconfig_dir: "/app/share/libretro/autoconfig",
    libretro_info_path: "/app/share/libretro/info",
    content_database_path: "/app/share/libretro/database/rdb",
  };
  for (const [key, prefix] of Object.entries(pinned)) {
    const m = new RegExp("\\b" + key + ':\\s*"([^"]*)"').exec(block);
    assert.ok(m, key + " is not set in requiredSettings() - a fresh box would get RetroArch's empty user dir");
    assert.ok(m[1].startsWith(prefix), key + ' points at "' + m[1] + "\" instead of the flatpak's " + prefix);
  }
});

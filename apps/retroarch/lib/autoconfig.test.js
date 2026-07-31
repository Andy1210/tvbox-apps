// Tests for the controller-profile directory. Two things must hold or the menu button
// silently stops working: the mirror has to point at the SANDBOX path (RetroArch reads
// it from inside its flatpak, where the host's install dir does not exist), and a
// correction has to REPLACE the symlink rather than write through it - writing through
// would edit the read-only original's path and fail, or worse, succeed against a copy
// nothing reads. HOME is redirected before the module loads, because it resolves its
// directories at require time.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-autoconfig-test-"));
process.env.HOME = HOME;
const autoconfig = require("./autoconfig");

const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64";
const SRC = path.join(
  HOME,
  ".local/share/flatpak/app/org.libretro.RetroArch",
  ARCH,
  "stable/active/files/share/libretro/autoconfig",
);

const PAD = 'input_device = "Xbox One S Wireless Controller"\ninput_vendor_id = "1118"\ninput_product_id = "2835"\n';

function fakeFlatpak(profiles) {
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.mkdirSync(path.join(SRC, "udev"), { recursive: true });
  fs.mkdirSync(path.join(SRC, "sdl2"), { recursive: true });
  for (const [name, text] of Object.entries(profiles)) fs.writeFileSync(path.join(SRC, "udev", name), text);
  fs.writeFileSync(path.join(SRC, "sdl2", "Other.cfg"), 'input_device = "Other"\n');
}

const reset = () => fs.rmSync(autoconfig.DIR, { recursive: true, force: true });
// existsSync FOLLOWS symlinks, and every link in the mirror points into the sandbox and
// so dangles on the host - listing the directory is the only honest way to ask.
const mirrored = (driver, file) => {
  try {
    return fs.readdirSync(path.join(autoconfig.DIR, driver)).includes(file);
  } catch (e) {
    return false;
  }
};

test("the directories really are under the redirected HOME", () => {
  assert.ok(autoconfig.DIR.startsWith(HOME), autoconfig.DIR);
});

test("without RetroArch installed there is nothing to mirror, and that is not an error", () => {
  reset();
  fs.rmSync(SRC, { recursive: true, force: true });
  assert.strictEqual(autoconfig.hostSource(), "");
  assert.strictEqual(autoconfig.sync(), false);
  assert.deepStrictEqual(autoconfig.fixMenuToggle([{ name: "x", vendor: 1, product: 1, guide: 12 }]), []);
});

test("the mirror links every driver's profiles at their SANDBOX path", () => {
  reset();
  fakeFlatpak({ "Pad.cfg": PAD });
  assert.strictEqual(autoconfig.sync(), true);
  const link = path.join(autoconfig.DIR, "udev", "Pad.cfg");
  assert.strictEqual(fs.readlinkSync(link), autoconfig.SANDBOX_SRC + "/udev/Pad.cfg");
  assert.strictEqual(
    fs.readlinkSync(path.join(autoconfig.DIR, "sdl2", "Other.cfg")),
    autoconfig.SANDBOX_SRC + "/sdl2/Other.cfg",
  );
  // The link is dangling on the host by design; that must not read as "missing".
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test("a rebuild happens when the flatpak moves, and drops a profile it no longer ships", () => {
  reset();
  fakeFlatpak({ "Pad.cfg": PAD, "Gone.cfg": 'input_device = "Gone"\n' });
  autoconfig.sync();
  assert.ok(mirrored("udev", "Gone.cfg"));
  const marker = fs.readFileSync(autoconfig.MARKER, "utf8");
  // Same source: no work, same marker.
  autoconfig.sync();
  assert.strictEqual(fs.readFileSync(autoconfig.MARKER, "utf8"), marker);
  // A new install root behind `active` looks like an update.
  fakeFlatpak({ "Pad.cfg": PAD });
  fs.utimesSync(SRC, new Date(0), new Date(0));
  fs.writeFileSync(autoconfig.MARKER, "something-else\n");
  autoconfig.sync();
  assert.strictEqual(mirrored("udev", "Gone.cfg"), false);
});

test("the profile for a pad is only picked when the answer is not in doubt", () => {
  reset();
  fakeFlatpak({
    "Pad.cfg": PAD,
    "ByName.cfg": 'input_device = "Nacon"\ninput_vendor_id = "9999"\ninput_product_id = "1"\n',
    "AlsoNacon.cfg": 'input_device = "Nacon"\ninput_vendor_id = "8888"\ninput_product_id = "2"\n',
  });
  const byId = autoconfig.profileFor({ name: "Xbox Wireless Controller", vendor: 1118, product: 2835 });
  assert.strictEqual(byId.file, "Pad.cfg");
  // Name is the fallback, and only a UNIQUE name counts: two profiles claiming
  // "Nacon" means a correction could land on the wrong one.
  assert.strictEqual(autoconfig.profileFor({ name: "Nacon", vendor: 1, product: 1 }), null);
  assert.strictEqual(autoconfig.profileFor({ name: "Unknown Pad", vendor: 1, product: 1 }), null);
});

test("a correction replaces the symlink with a real file, and only when the value differs", () => {
  reset();
  fakeFlatpak({ "Pad.cfg": PAD + 'input_menu_toggle_btn = "8"\n' });
  const pad = { name: "Xbox Wireless Controller", vendor: 1118, product: 2835, guide: 12 };
  const fixed = autoconfig.fixMenuToggle([pad]);
  assert.deepStrictEqual(
    fixed.map((f) => [f.profile, f.from, f.to]),
    [["Pad.cfg", "8", 12]],
  );
  const dst = path.join(autoconfig.DIR, "udev", "Pad.cfg");
  assert.strictEqual(fs.lstatSync(dst).isSymbolicLink(), false, "the link was replaced, not written through");
  const text = fs.readFileSync(dst, "utf8");
  assert.match(text, /^input_menu_toggle_btn = "12"$/m);
  assert.strictEqual(/input_menu_toggle_btn = "8"/.test(text), false);
  assert.match(text, /input_vendor_id = "1118"/, "the rest of the profile is kept");
  // Already correct: nothing to do, and the source is what is compared against.
  assert.deepStrictEqual(autoconfig.fixMenuToggle([{ ...pad, guide: 8 }]), []);
});

test("a profile with no menu-toggle line gets one appended", () => {
  reset();
  fakeFlatpak({ "Pad.cfg": PAD });
  autoconfig.fixMenuToggle([{ name: "Xbox Wireless Controller", vendor: 1118, product: 2835, guide: 12 }]);
  const text = fs.readFileSync(path.join(autoconfig.DIR, "udev", "Pad.cfg"), "utf8");
  assert.match(text, /^input_menu_toggle_btn = "12"$/m);
  assert.match(text, /^input_device = /m);
});

test("a pad whose Guide button the kernel does not report is left alone", () => {
  reset();
  fakeFlatpak({ "Pad.cfg": PAD + 'input_menu_toggle_btn = "8"\n' });
  assert.deepStrictEqual(
    autoconfig.fixMenuToggle([{ name: "Xbox Wireless Controller", vendor: 1118, product: 2835, guide: null }]),
    [],
  );
  assert.ok(fs.lstatSync(path.join(autoconfig.DIR, "udev", "Pad.cfg")).isSymbolicLink());
});

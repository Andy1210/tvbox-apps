// The box owns RetroArch's controller-profile directory.
//
// RetroArch reads ONE autoconfig directory, and in a flatpak that directory is
// inside the read-only app (`/app/share/libretro/autoconfig`). Nothing can be
// corrected there and RetroArch's own "Save Controller Profile" cannot write to it
// either. So the plugin builds a directory of its own next to RetroArch's config,
// mirrors the flatpak's profiles into it as SYMLINKS, and replaces the individual
// profiles it has a correction for with real files.
//
// The symlinks point at the SANDBOX path (`/app/...`), not at the host path the
// flatpak happens to be installed under: RetroArch reads them from inside its
// sandbox, where the host's ~/.local/share/flatpak does not exist. They therefore
// dangle when read from the host, which is why a correction is copied from the host
// source rather than by following our own link.
//
// The one correction so far is the menu-toggle button - see lib/pads.js for why a
// profile's index can be wrong for the very device it was written for.
//
// This is the ONLY place that can fix it, which is worth knowing before reaching for
// retroarch.cfg instead: a profile's hotkey bind applies only while the global
// `input_menu_toggle_btn` is unset, and a concrete global value overrides every
// profile at once (measured). One global number cannot serve two pads whose Guide
// button sits at different indices, so the correction has to be per device.

const fs = require("fs");
const path = require("path");
const os = require("os");

const FLATPAK_REF = "org.libretro.RetroArch";
const RA_DIR = path.join(os.homedir(), ".var", "app", FLATPAK_REF, "config", "retroarch");
// Ours, and named so it is obvious in a directory listing that it is not RetroArch's.
const DIR = path.join(RA_DIR, "autoconfig-tvbox");
const MARKER = path.join(DIR, ".source");
// Where the flatpak keeps the originals, on the host and inside the sandbox.
const SANDBOX_SRC = "/app/share/libretro/autoconfig";
const HOST_SRC = [
  path.join(os.homedir(), ".local", "share", "flatpak", "app", FLATPAK_REF),
  path.join("/var/lib/flatpak/app", FLATPAK_REF),
];

function arch() {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

// The installed app's autoconfig tree, or "" when RetroArch is not installed.
function hostSource() {
  for (const base of HOST_SRC) {
    const p = path.join(base, arch(), "stable", "active", "files", "share", "libretro", "autoconfig");
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch (e) {
      /* not this install root */
    }
  }
  return "";
}

// What the mirror was built from. The `active` symlink moves on every flatpak
// update, so its real path is enough to notice one - no version parsing.
function sourceStamp(src) {
  try {
    return fs.realpathSync(src);
  } catch (e) {
    return src;
  }
}

// Mirror the flatpak's profiles as symlinks into our directory, one subdirectory per
// input driver, exactly as RetroArch expects to find them. Rebuilt from scratch when
// the flatpak moves, so a profile that upstream dropped cannot linger.
function sync(log) {
  const src = hostSource();
  if (!src) return false;
  const stamp = sourceStamp(src);
  let built = "";
  try {
    built = fs.readFileSync(MARKER, "utf8").trim();
  } catch (e) {
    /* never built */
  }
  if (built === stamp) return true;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  let drivers = [];
  try {
    drivers = fs.readdirSync(src, { withFileTypes: true });
  } catch (e) {
    return false;
  }
  let n = 0;
  for (const d of drivers) {
    if (!d.isDirectory()) continue;
    const from = path.join(src, d.name);
    const to = path.join(DIR, d.name);
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      if (!f.endsWith(".cfg")) continue;
      try {
        fs.symlinkSync(path.posix.join(SANDBOX_SRC, d.name, f), path.join(to, f));
        n++;
      } catch (e) {
        /* a name we cannot represent as a link is skipped, not fatal */
      }
    }
  }
  fs.writeFileSync(MARKER, stamp + "\n");
  if (log) log("controller profiles mirrored: " + n);
  return true;
}

const NUM = (s) => (/^\d+$/.test(String(s || "")) ? Number(s) : null);
function field(text, key) {
  const m = new RegExp("^" + key + '\\s*=\\s*"([^"]*)"', "m").exec(text);
  return m ? m[1] : null;
}

// Read the profiles of one driver from the HOST source (our own copies are symlinks
// into the sandbox and cannot be followed here).
function profiles(driver) {
  const src = hostSource();
  if (!src) return [];
  const dir = path.join(src, driver);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".cfg"));
  } catch (e) {
    return [];
  }
  const out = [];
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch (e) {
      continue;
    }
    out.push({
      file,
      text,
      device: field(text, "input_device"),
      vendor: NUM(field(text, "input_vendor_id")),
      product: NUM(field(text, "input_product_id")),
      menu: field(text, "input_menu_toggle_btn"),
    });
  }
  return out;
}

// The profile RetroArch will use for a pad, but only when the answer is not in
// doubt: an exact vendor+product match, or failing that a single profile carrying
// exactly this device name. RetroArch's own matcher also scores partial name
// matches; reimplementing that would be guessing, and a correction written for the
// wrong profile is worse than none.
function profileFor(pad, driver) {
  const all = profiles(driver || "udev");
  const byId = all.filter((p) => p.vendor === pad.vendor && p.product === pad.product);
  if (byId.length === 1) return byId[0];
  const name = String(pad.name || "").toLowerCase();
  const byName = all.filter((p) => String(p.device || "").toLowerCase() === name);
  return byName.length === 1 ? byName[0] : null;
}

// Make each connected pad's profile bind the menu toggle to the button that pad
// actually has. Writes a real file over the mirror's symlink, and only when the
// value differs, so a profile upstream gets right is left alone.
function fixMenuToggle(pads, log) {
  if (!sync(log)) return [];
  const fixed = [];
  for (const pad of pads || []) {
    if (pad.guide === null || pad.guide === undefined) continue;
    const profile = profileFor(pad);
    if (!profile) continue;
    if (NUM(profile.menu) === pad.guide) continue;
    const line = 'input_menu_toggle_btn = "' + pad.guide + '"';
    const text =
      profile.menu === null
        ? profile.text.replace(/\n*$/, "\n") + line + "\n"
        : profile.text.replace(/^input_menu_toggle_btn\s*=\s*".*"$/m, line);
    const dst = path.join(DIR, "udev", profile.file);
    try {
      fs.rmSync(dst, { force: true }); // replace the symlink, never write through it
      fs.writeFileSync(dst, text);
    } catch (e) {
      if (log) log("could not correct " + profile.file + ": " + e.message);
      continue;
    }
    fixed.push({ pad: pad.name, profile: profile.file, from: profile.menu, to: pad.guide });
    if (log)
      log('menu button for "' + pad.name + '": ' + profile.file + " " + (profile.menu || "unset") + " -> " + pad.guide);
  }
  return fixed;
}

module.exports = { DIR, MARKER, SANDBOX_SRC, hostSource, sync, profiles, profileFor, fixMenuToggle };

// Games that live somewhere else on the box, linked into the library.
//
// A library does not have to be a copy. A stick full of ROMs, a folder on a
// network share the box already mounts, a directory someone dropped in over the
// file server - all of them are already on this machine, and the scanner follows
// symlinks on purpose (scan.js: "a library assembled out of them is normal"). So
// "add a folder" is a SYMLINK under ~/.tvbox/roms/<name>, and everything
// downstream - scanning, playlists, artwork - carries on as if the games were
// there.
//
// That is also why the NAME matters more than it looks: it is a path segment in
// every playlist entry RetroArch writes. Renaming a folder invalidates a scanned
// list, so a name is chosen once and kept.
//
// What this deliberately does NOT do is mount anything. Mounting is the box's
// job (a USB stick, a network share) and it is the box that knows how; this
// links what is already there, which is why a stick and a NAS need no code of
// their own here.
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const ROMS_DIR = path.join(HOME, ".tvbox", "roms");
const CONFIG_FILE = path.join(HOME, ".tvbox", "retroarch-folders.json");
const MAX_FOLDERS = 12;

// A path segment, and the name the user will see. Same shape as a system folder.
function nameOk(n) {
  return typeof n === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(n);
}

// Where a link may point: the same ground the box offers as a source. The screen
// only ever shows those, but the route is what has to enforce it - every app on
// this box shares the shell's origin, so "the UI would never send that" is not a
// rule, it is a hope.
//
// The shell's sources are the user's own folders (~, and the mount points it puts
// under ~/.tvbox), plus removable media, which udisks mounts under /media/<user>
// or /run/media/<user>. So the ground is HOME plus those two, and nothing else -
// /etc is not a game library.
function allowedRoots() {
  const user = path.basename(HOME);
  return [HOME, path.join("/media", user), path.join("/run/media", user)];
}

// Absolute, real (so a link cannot be aimed through another link at something
// else later), a directory, inside one of those roots, and NOT inside the library
// itself - linking roms/ into roms/ is a loop the scanner would have to defend
// against and a user would never mean.
function targetOk(p) {
  if (typeof p !== "string" || !path.isAbsolute(p)) return false;
  let real;
  try {
    real = fs.realpathSync(p);
    if (!fs.statSync(real).isDirectory()) return false;
  } catch (e) {
    return false;
  }
  const inside = (root) => real === root || real.startsWith(root + path.sep);
  if (!allowedRoots().some(inside)) return false;
  const roms = fs.existsSync(ROMS_DIR) ? fs.realpathSync(ROMS_DIR) : ROMS_DIR;
  return real !== roms && !real.startsWith(roms + path.sep);
}

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return Array.isArray(d.folders) ? d.folders : [];
  } catch (e) {
    return [];
  }
}

function write(folders) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ folders }, null, 2) + "\n");
}

const linkPath = (name) => path.join(ROMS_DIR, name);

// Is this name free to link? A real directory under roms/ is somebody's uploaded
// games, and a link must never take its place - so the answer is no, and the UI
// says the name is taken rather than quietly swallowing a library.
function nameFree(name) {
  const p = linkPath(name);
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (e) {
    return true; // nothing there at all
  }
}

// Point roms/<name> at `target`. Replacing an existing LINK of the same name is
// how an edit works; replacing a directory is refused above.
function link(name, target) {
  fs.mkdirSync(ROMS_DIR, { recursive: true });
  const p = linkPath(name);
  try {
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
  } catch (e) {
    /* nothing there, which is the normal case */
  }
  fs.symlinkSync(target, p);
}

function unlink(name) {
  try {
    if (fs.lstatSync(linkPath(name)).isSymbolicLink()) fs.unlinkSync(linkPath(name));
  } catch (e) {
    /* already gone */
  }
}

// Add or update one. Returns { ok } or { ok: false, error } with a reason the UI
// can translate.
function add(input) {
  const name = String((input && input.name) || "")
    .trim()
    .toLowerCase();
  const target = String((input && input.path) || "");
  if (!nameOk(name)) return { ok: false, error: "bad_name" };
  if (!targetOk(target)) return { ok: false, error: "bad_path" };
  const folders = read().filter((f) => f.name !== name);
  if (folders.length >= MAX_FOLDERS) return { ok: false, error: "too_many" };
  if (!nameFree(name)) return { ok: false, error: "name_taken" };
  const real = fs.realpathSync(target);
  try {
    link(name, real);
  } catch (e) {
    return { ok: false, error: "link_failed" };
  }
  write([...folders, { name, path: real }]);
  return { ok: true, name };
}

function remove(name) {
  const folders = read();
  if (!folders.some((f) => f.name === name)) return { ok: false, error: "unknown" };
  unlink(name);
  write(folders.filter((f) => f.name !== name));
  return { ok: true };
}

// Re-create every link. Called at boot: a link whose target went away (a stick
// pulled out, a share not mounted yet) is left in place but reported as missing,
// because the games come back when the target does - and removing the link would
// take the user's chosen name with it.
function apply() {
  const out = [];
  for (const f of read()) {
    let present = false;
    try {
      present = fs.statSync(f.path).isDirectory();
    } catch (e) {
      present = false;
    }
    if (present) {
      try {
        link(f.name, f.path);
      } catch (e) {
        /* a directory of the same name now sits there; status reports it */
      }
    }
    out.push({ ...f, present, linked: isLinked(f.name, f.path) });
  }
  return out;
}

function isLinked(name, target) {
  try {
    return fs.readlinkSync(linkPath(name)) === target;
  } catch (e) {
    return false;
  }
}

// What the app's screen shows: the folders, whether their target is there right
// now, and whether the link is in place.
function status() {
  return read().map((f) => {
    let present = false;
    try {
      present = fs.statSync(f.path).isDirectory();
    } catch (e) {
      present = false;
    }
    return { name: f.name, path: f.path, present, linked: isLinked(f.name, f.path) };
  });
}

module.exports = {
  ROMS_DIR,
  CONFIG_FILE,
  MAX_FOLDERS,
  nameOk,
  targetOk,
  nameFree,
  read,
  write,
  add,
  remove,
  apply,
  status,
  linkPath,
};

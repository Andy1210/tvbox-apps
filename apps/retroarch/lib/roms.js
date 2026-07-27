// The box's game library on local disk: ~/.tvbox/roms/<system>/<file>.
//
// Uploads arrive in CHUNKS rather than as one body. A single game can be several
// hundred megabytes, and the pairing server buffers a request body in memory
// before handing it over, so a whole-file upload would need more RAM than the box
// has. Each chunk carries the offset it belongs at, which also makes a retried
// chunk harmless: the offset has to match what is already on disk, so a repeat is
// rejected instead of being appended twice.
//
// Everything is written to `<file>.part` and renamed only when the last chunk
// lands, so an interrupted upload never looks like a playable game.
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROMS_DIR = path.join(os.homedir(), ".tvbox", "roms");
const PART_SUFFIX = ".part";
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024; // disk guard; a full-size disc image still fits
const MAX_NAME_LEN = 160;

// A system is just a folder name under roms/. Kept to a plain slug: it is a path
// segment, and it is also what the user sees, so no spaces or case games.
function systemOk(system) {
  return typeof system === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(system);
}

// A file name that cannot escape its system folder. Rejects separators, dotfiles,
// traversal, and control characters rather than sanitising them: a silently
// renamed upload is worse than a refused one.
function nameOk(name) {
  if (typeof name !== "string" || !name || name.length > MAX_NAME_LEN) return false;
  if (name.startsWith(".") || name.endsWith(PART_SUFFIX)) return false;
  if (/[/\\]/.test(name) || name.includes("..")) return false;
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  return true;
}

// Resolve to an absolute path inside ROMS_DIR, or "" if anything is off. The
// startsWith check is the belt to the validation's braces.
function romPath(system, name, part) {
  if (!systemOk(system) || !nameOk(name)) return "";
  const dir = path.join(ROMS_DIR, system);
  const p = path.join(dir, name + (part ? PART_SUFFIX : ""));
  return p.startsWith(dir + path.sep) ? p : "";
}

function ensureDir(system) {
  const dir = path.join(ROMS_DIR, system);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return -1; // absent
  }
}

// Append one chunk. `offset` must equal what is already written, `data` is base64.
// Returns { ok, size } or { ok: false, error }.
function writeChunk({ system, name, offset, data, last }) {
  const part = romPath(system, name, true);
  const final = romPath(system, name, false);
  if (!part || !final) return { ok: false, error: "bad_name" };
  const off = Number(offset);
  if (!Number.isInteger(off) || off < 0) return { ok: false, error: "bad_offset" };
  let buf;
  try {
    buf = Buffer.from(String(data || ""), "base64");
  } catch (e) {
    return { ok: false, error: "bad_data" };
  }
  if (off + buf.length > MAX_FILE_BYTES) return { ok: false, error: "too_big" };
  ensureDir(system);
  const have = sizeOf(part);
  if (off === 0) {
    fs.writeFileSync(part, buf); // (re)start: truncates a stale partial
  } else {
    if (have !== off) return { ok: false, error: "offset_mismatch", size: Math.max(have, 0) };
    fs.appendFileSync(part, buf);
  }
  const size = sizeOf(part);
  if (last) {
    fs.renameSync(part, final);
    return { ok: true, size, done: true, name };
  }
  return { ok: true, size };
}

// Directories under the library that are actually MOUNTS, e.g. a network share.
// Those are somebody else's file system: walking one would stat every remote file
// on every status call, so the local listing stops at them.
function mountedDirs() {
  const mounts = new Set();
  try {
    for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const point = line.split(" ")[4];
      if (point && point.startsWith(ROMS_DIR + path.sep)) mounts.add(point);
    }
  } catch (e) {
    /* no procfs: treat everything as local */
  }
  return mounts;
}

// Everything in the LOCAL library, grouped by system, newest first within a
// system. Partial uploads are reported separately so a phone (or a settings
// screen) can show "unfinished" instead of silently listing a broken file.
function list() {
  const out = [];
  let systems = [];
  try {
    systems = fs.readdirSync(ROMS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    return out;
  }
  const mounts = mountedDirs();
  for (const dir of systems) {
    if (!systemOk(dir.name)) continue;
    if (mounts.has(path.join(ROMS_DIR, dir.name))) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(ROMS_DIR, dir.name), { withFileTypes: true });
    } catch (e) {
      continue;
    }
    const files = [];
    for (const f of entries) {
      if (!f.isFile() || f.name.startsWith(".")) continue;
      const p = path.join(ROMS_DIR, dir.name, f.name);
      let st;
      try {
        st = fs.statSync(p);
      } catch (e) {
        continue;
      }
      const partial = f.name.endsWith(PART_SUFFIX);
      files.push({
        name: partial ? f.name.slice(0, -PART_SUFFIX.length) : f.name,
        size: st.size,
        mtime: st.mtimeMs,
        partial,
      });
    }
    if (files.length) {
      files.sort((a, b) => b.mtime - a.mtime);
      out.push({ system: dir.name, files });
    }
  }
  out.sort((a, b) => a.system.localeCompare(b.system));
  return out;
}

// Delete a game (or an abandoned partial upload of it).
function remove(system, name) {
  let gone = false;
  for (const part of [false, true]) {
    const p = romPath(system, name, part);
    if (!p) return false;
    try {
      fs.unlinkSync(p);
      gone = true;
    } catch (e) {
      /* not there, fine */
    }
  }
  // Leave no empty folder behind: an empty system reads as "this console is set
  // up" everywhere the library is shown.
  try {
    fs.rmdirSync(path.join(ROMS_DIR, system));
  } catch (e) {
    /* not empty, fine */
  }
  return gone;
}

// Delete every game of one console at once. Deleting hundreds of files one tap at
// a time is not a usable way to clear a library.
//
// A mounted directory is refused outright: the network share appears under the
// library too, and "delete all" there would mean deleting the files on the server.
// The mount is read-only so the writes would fail anyway, but a destructive action
// must not depend on that for its safety.
function removeSystem(system) {
  if (!systemOk(system)) return { ok: false, error: "bad_system" };
  const dir = path.join(ROMS_DIR, system);
  if (mountedDirs().has(dir)) return { ok: false, error: "is_mount" };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: "not_found" };
  }
  let removed = 0;
  for (const f of entries) {
    if (!f.isFile()) continue; // never recurse: a subdirectory here is not ours to flatten
    try {
      fs.unlinkSync(path.join(dir, f.name));
      removed++;
    } catch (e) {
      /* skip what we cannot remove and report the rest */
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch (e) {
    /* something non-file is left; leaving the folder is the safe outcome */
  }
  return { ok: true, removed };
}

function count() {
  return list().reduce((n, s) => n + s.files.filter((f) => !f.partial).length, 0);
}

module.exports = { ROMS_DIR, MAX_FILE_BYTES, systemOk, nameOk, writeChunk, list, remove, removeSystem, count };

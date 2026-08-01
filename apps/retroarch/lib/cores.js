// Installing and updating libretro cores from the box, instead of leaving it to
// RetroArch's own Online Updater.
//
// Why: in this flatpak build the Core Downloader never starts a fetch at all (no
// network attempt appears in RetroArch's log, and the URL setting it does keep has
// no effect), so a console cannot be added from inside the app.
//
// Nothing about which cores exist is written down here. Two sources are joined:
//
//   the buildbot's `.index-extended`  what can be downloaded, one line per core as
//                                     `<date> <crc32> <file>.zip`
//   the flatpak's own `.info` files    what each core is CALLED and which system it
//                                     emulates (display_name / systemname)
//
// So the list is whatever libretro publishes today, named the way RetroArch names
// it, and a new core appears without anyone editing this file.
//
// The CRC32 in the index is of the `.so` INSIDE the zip, which does two jobs at
// once: it verifies a download, and it says whether an installed core is out of
// date. There is therefore no bookkeeping file that could drift - the installed
// `.so` is the truth, compared against what the index advertises.
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { execFile } = require("child_process");

const FLATPAK_REF = "org.libretro.RetroArch";
const CORES_DIR = path.join(os.homedir(), ".var", "app", FLATPAK_REF, "config", "retroarch", "cores");
// The core metadata RetroArch ships with itself. Read-only, and the only place a
// core's human name lives; the buildbot index carries file names only.
const INFO_SUBPATH = [FLATPAK_REF, arch(), "stable", "active", "files", "share", "libretro", "info"];
const INFO_DIRS = [
  path.join(os.homedir(), ".local", "share", "flatpak", "app", ...INFO_SUBPATH),
  path.join("/var/lib/flatpak/app", ...INFO_SUBPATH),
];
const SUFFIX = "_libretro.so";
const DOWNLOAD_TIMEOUT_MS = 180000; // a core can be tens of MB; a slow link should not fail it
const INDEX_TIMEOUT_MS = 30000;

// libretro's buildbot calls this architecture aarch64, not Node's arm64.
function arch() {
  return process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
}
function baseUrl() {
  return "https://buildbot.libretro.com/nightly/linux/" + arch() + "/latest/";
}
function coreFile(core) {
  return core + SUFFIX;
}
// A core name is a path segment and part of a URL, so it stays a plain slug. What
// actually limits the choice is the index: only a core the buildbot lists can be
// installed (see install()).
function coreNameOk(core) {
  return typeof core === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(core);
}

// Only a regular file can be a core. A zip entry can be a symlink, and everything
// after extraction would follow it: the checksum would be of its target, and the
// install would copy THAT file into the cores dir for RetroArch to load.
function isRegularFile(p) {
  try {
    return fs.lstatSync(p).isFile();
  } catch (e) {
    return false; // nothing was extracted under that name
  }
}

// The checksum of every installed core is what the list compares against the
// index, and a core is tens of MB. So it is read in CHUNKS rather than whole (a
// dozen cores would otherwise be a few hundred MB of allocation in the shell's own
// process), and cached against size+mtime: a file's checksum cannot change while
// the file does not, and this list is rebuilt every time the page is opened.
const CRC_CHUNK = 1 << 16;
const crcCache = new Map(); // path -> { size, mtimeMs, crc }
function crc32OfFile(p) {
  let st = null;
  try {
    st = fs.statSync(p);
  } catch (e) {
    return null;
  }
  const hit = crcCache.get(p);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.crc;
  let fd = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.allocUnsafe(CRC_CHUNK);
    let crc = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CRC_CHUNK, null);
      if (n <= 0) break;
      crc = crc32Chunk(buf.subarray(0, n), crc);
    }
    crcCache.set(p, { size: st.size, mtimeMs: st.mtimeMs, crc });
    return crc;
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* already gone */
      }
    }
  }
}
// zlib.crc32 landed in Node 20.15; keep working on an older runtime. Both forms
// continue from a running value, which is what lets a file be read in pieces.
function crc32Chunk(buf, prev) {
  if (zlib.crc32) return zlib.crc32(buf, prev >>> 0);
  let c = ~(prev >>> 0) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
const hex8 = (n) => (n >>> 0).toString(16).padStart(8, "0");

// `<date> <crc32> <file>.zip` per line -> Map(core -> { date, crc }).
function parseIndex(text) {
  const out = new Map();
  for (const line of String(text).split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2})\s+([0-9a-f]{8})\s+(\S+)_libretro\.so\.zip$/.exec(line.trim());
    if (m && coreNameOk(m[3])) out.set(m[3], { date: m[1], crc: m[2] });
  }
  return out;
}

function fetchIndex(env) {
  return new Promise((resolve) => {
    execFile(
      "curl",
      [
        "-fsSL",
        "--proto",
        "=https",
        "--max-time",
        String(Math.round(INDEX_TIMEOUT_MS / 1000)),
        baseUrl() + ".index-extended",
      ],
      { env, maxBuffer: 8e6, timeout: INDEX_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : parseIndex(stdout)),
    );
  });
}

// One `.info` file: `key = "value"` lines. Only the naming fields are of interest.
function parseInfo(text) {
  const get = (key) => {
    const m = new RegExp("^" + key + '\\s*=\\s*"([^"]*)"', "m").exec(text);
    return m ? m[1] : "";
  };
  return {
    display: get("display_name"),
    name: get("corename"),
    system: get("systemname"),
    // The core's own id for the console it is FOR - the tie-break when its database
    // list names several (lib/scan.js).
    systemid: get("systemid"),
    api: get("required_hw_api"),
    // The libretro DATABASE names this core plays, pipe-separated in the file
    // ("Nintendo - Game Boy|Nintendo - Game Boy Color"). Worth having next to
    // `systemname`, which is a human label in whatever shape the core author chose
    // ("PSP", "Sega 8/16-bit (Various)"): the database names are the very names
    // RetroArch names its playlists after, so they are what maps a console to a
    // core (lib/games.js).
    databases: get("database")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean),
    // What the core can load, for a scan that does not go through RetroArch.
    extensions: get("supported_extensions")
      .split("|")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

// core -> { display, name, system }, from whichever info dir exists.
function infoIndex() {
  const out = new Map();
  for (const dir of INFO_DIRS) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".info"));
    } catch (e) {
      continue;
    }
    for (const f of files) {
      const core = f.replace(/_libretro\.info$/, "");
      if (!coreNameOk(core) || out.has(core)) continue;
      try {
        out.set(core, parseInfo(fs.readFileSync(path.join(dir, f), "utf8")));
      } catch (e) {
        /* unreadable info file: the core still lists, just without a nice name */
      }
    }
    if (out.size) break; // the first dir that had metadata wins
  }
  return out;
}

// ---- which video driver a core can actually use on this hardware ----
//
// V3D gives desktop OpenGL 3.1 (compatibility profile), OpenGL ES 3.1, and Vulkan
// through v3dv. What it does NOT give is a GL CORE profile above 3.1 - and RetroArch
// asks for exactly what a core declares, so a core whose only GL option is
// "OpenGL Core >= 3.3" cannot run on GL here at all (Beetle PSX HW is the one that
// matters: its GL attempt dies with EGL_BAD_MATCH). Vulkan is its way in.
//
// The declaration is the core's own `required_hw_api`, so no list of cores is
// written down here either.
// EVERY driver the core can use here, not just a favourite: a core that declares
// both GL and Vulkan must keep whichever one the box runs globally. Picking for it
// would be worse than doing nothing on a box whose global driver is Vulkan because
// GL does not reach the GPU there (hardwareGl() in plugin.js) - an override would
// then move a perfectly good core onto llvmpipe.
const GL_COMPAT_MAX = 3.1; // desktop GL, compatibility profile
const GLES_MAX = 3.1;
function videoDriversFor(api) {
  const s = String(api || "");
  if (!s) return []; // undeclared: leave whatever the global driver is
  const atMost = (re, cap) => {
    const m = re.exec(s);
    return m ? parseFloat(m[1]) <= cap : false;
  };
  const out = [];
  // "OpenGL >= 3.0" is the compatibility profile; "OpenGL Core >= 3.3" is not the
  // same thing and deliberately does not match here.
  if (atMost(/OpenGL\s*>=\s*([\d.]+)/, GL_COMPAT_MAX) || atMost(/OpenGL ES\s*>=\s*([\d.]+)/, GLES_MAX)) out.push("gl");
  if (/Vulkan/i.test(s)) out.push("vulkan");
  return out; // empty: nothing this hardware can serve, and not ours to force
}

// RetroArch loads a per-core override from config/<corename>/<corename>.cfg (its
// `auto_overrides_enable` default). It writes those files itself for core options
// and remaps, so only the one key is ever touched here - the rest is the user's.
const OVERRIDES_DIR = path.join(path.dirname(CORES_DIR), "config");
function overridePath(coreName) {
  // The corename is RetroArch's own display name ("Beetle PSX HW"); it becomes a
  // directory, so anything that could leave it is refused.
  if (!coreName || /[\\/]|\.\./.test(coreName)) return null;
  return path.join(OVERRIDES_DIR, coreName, coreName + ".cfg");
}
// Set (or clear) video_driver in one core's override, keeping every other line.
function setOverrideDriver(coreName, driver) {
  const file = overridePath(coreName);
  if (!file) return false;
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch (e) {
    if (!driver) return false; // nothing to clear
  }
  const kept = lines.filter((l) => !/^\s*video_driver\s*=/.test(l) && l.trim() !== "");
  if (driver) kept.push('video_driver = "' + driver + '"');
  try {
    if (!kept.length) {
      fs.rmSync(file, { force: true });
      // Tidying the directory is best-effort and must not be mistaken for the
      // clear failing: RetroArch also keeps per-content overrides, remaps and
      // core options in here, and then it is not ours to remove.
      try {
        fs.rmdirSync(path.dirname(file));
      } catch (e) {
        /* something else of RetroArch's still lives there */
      }
      return true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, kept.join("\n") + "\n");
    return true;
  } catch (e) {
    return false;
  }
}

// Give every installed core the driver its own metadata says it needs, relative to
// the driver the plugin sets globally: a core the global driver already suits gets
// no override (and loses one we wrote earlier). Returns what changed, for the log.
function syncDriverOverrides(globalDriver) {
  const info = infoIndex();
  const out = [];
  for (const core of installed()) {
    const meta = info.get(core);
    if (!meta || !meta.name) continue; // no metadata: nothing to name a file after
    const can = videoDriversFor(meta.api);
    if (!can.length) continue;
    // the global driver already suits the core: no override (and drop one we wrote
    // earlier, e.g. after the box gained hardware GL and the global driver changed)
    const driver = can.includes(globalDriver) ? null : can[0];
    const file = overridePath(meta.name);
    if (!file) continue;
    let have = null;
    try {
      const m = /^\s*video_driver\s*=\s*"?([a-z_]+)"?/m.exec(fs.readFileSync(file, "utf8"));
      have = m ? m[1] : null;
    } catch (e) {
      /* no override yet */
    }
    if (have === driver) continue;
    if (setOverrideDriver(meta.name, driver)) out.push(meta.name + " -> " + (driver || globalDriver));
  }
  return out;
}

// What is on disk, each with its own CRC32 so it can be compared to the index.
function installed() {
  try {
    return fs
      .readdirSync(CORES_DIR)
      .filter((f) => f.endsWith(SUFFIX))
      .map((f) => f.slice(0, -SUFFIX.length))
      .filter(coreNameOk)
      .sort();
  } catch (e) {
    return [];
  }
}

// The whole list the box can offer: every core the buildbot publishes, plus
// anything already installed that it no longer publishes (so nothing on disk is
// hidden). `index` may be null when offline: then what is installed is still
// listed, and nothing claims to be updatable rather than guessing.
function list(index) {
  const info = infoIndex();
  const have = new Set(installed());
  const names = new Set([...(index ? index.keys() : []), ...have]);
  const out = [];
  for (const core of names) {
    const meta = info.get(core) || {};
    const remote = index ? index.get(core) || null : null;
    // No index (offline) means nothing to compare against, so the read is skipped
    // rather than done for a value nobody looks at.
    const crc = have.has(core) && index ? crc32OfFile(path.join(CORES_DIR, coreFile(core))) : null;
    out.push({
      core,
      // display_name is the fullest ("Sony - PlayStation 2 (LRPS2)"); fall back to
      // the shorter name, then to the file name, so a core is never nameless.
      label: meta.display || meta.name || core,
      system: meta.system || "",
      installed: have.has(core),
      crc: crc === null ? null : hex8(crc),
      available: !!remote,
      remoteDate: remote ? remote.date : null,
      updatable: !!(remote && crc !== null && hex8(crc) !== remote.crc),
    });
  }
  // Installed first (that is what the user manages), then by name.
  return out.sort((a, b) => Number(b.installed) - Number(a.installed) || a.label.localeCompare(b.label));
}

// ---- the files a core needs beside itself ----
//
// Some cores cannot run on their own binary: PPSSPP needs its font atlas and a
// flash0 image, ScummVM its engine data, Dolphin its sys files. RetroArch keeps
// them in the SYSTEM directory, and without them the core loads and then says
// "core system files are missing" - which names nothing and leaves the owner of a
// TV with no idea what to add. libretro publishes those packs itself, so
// installing a core can simply bring them.
//
// The buildbot names each pack after the core's own `corename` ("PPSSPP.zip"),
// sometimes with a note in brackets ("FinalBurn Neo (hiscore).zip"), so the
// listing IS the mapping and there is no table here to fall out of date.
const SYSTEM_DIR = path.join(os.homedir(), ".var", "app", FLATPAK_REF, "config", "retroarch", "system");
const ASSETS_URL = "https://buildbot.libretro.com/assets/system/";
const ASSETS_TIMEOUT_MS = 180000;
let assetListCache = null; // [{ name, url }], fetched once per shell run

function fetchAssetList(env) {
  if (assetListCache) return Promise.resolve(assetListCache);
  return new Promise((resolve) => {
    execFile(
      "curl",
      ["-fsSL", "--proto", "=https", "--max-time", "30", ASSETS_URL],
      { env, timeout: 35000, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => {
        if (err) return resolve([]); // offline, or the buildbot is down: no packs, no failure
        const list = [];
        const re = /href="([^"]+\.zip)"/gi;
        let m;
        while ((m = re.exec(out))) {
          let file;
          try {
            file = decodeURIComponent(m[1].split("/").pop());
          } catch (e) {
            continue; // a href we cannot decode is not a pack we can ask for
          }
          list.push({ name: file.slice(0, -4), file });
        }
        assetListCache = list;
        resolve(list);
      },
    );
  });
}

// The pack for this core, or null. Matched on the core's own name, either exactly
// or with the buildbot's bracketed note after it.
function assetForCore(core, index, list) {
  const info = (index && index.get(core)) || {};
  const name = String(info.name || info.display || "").trim();
  if (!name) return null;
  return list.find((a) => a.name === name || a.name.startsWith(name + " (")) || null;
}

// Unpack into the system dir. The archive decides its own paths, so they are read
// FIRST and anything absolute or climbing out is refused - the core zip above can
// name the one entry it wants, and this one cannot. There is no checksum to check
// (the index covers cores only), so the guarantee here is https to the same host
// the core itself came from, and the path check.
function unpackAssets(zip, env) {
  return new Promise((resolve) => {
    execFile("unzip", ["-Z1", zip], { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve({ ok: false, error: "bad_archive" });
      const entries = String(out).split("\n").filter(Boolean);
      if (!entries.length) return resolve({ ok: false, error: "bad_archive" });
      for (const e of entries) {
        if (e.startsWith("/") || e.split("/").includes("..")) return resolve({ ok: false, error: "unsafe_archive" });
      }
      fs.mkdirSync(SYSTEM_DIR, { recursive: true });
      execFile("unzip", ["-o", "-q", zip, "-d", SYSTEM_DIR], { env, timeout: 120000 }, (uerr) =>
        resolve(uerr ? { ok: false, error: "unpack_failed" } : { ok: true, entries: entries.length }),
      );
    });
  });
}

// Best effort by design: a core with no pack is the normal case, and a pack that
// cannot be fetched still leaves a working core for everything that needs no
// system files. It reports what happened so the caller can say so.
async function installSystemAssets(core, env, index) {
  const list = await fetchAssetList(env);
  const pack = assetForCore(core, index, list);
  if (!pack) return { pack: null };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-assets-"));
  const zip = path.join(tmp, "assets.zip");
  try {
    const got = await new Promise((resolve) =>
      execFile(
        "curl",
        [
          "-fsSL",
          "--proto",
          "=https",
          "--max-time",
          String(Math.round(ASSETS_TIMEOUT_MS / 1000)),
          "-o",
          zip,
          ASSETS_URL + encodeURIComponent(pack.file),
        ],
        { env, timeout: ASSETS_TIMEOUT_MS },
        (err) => resolve(!err),
      ),
    );
    if (!got) return { pack: pack.name, ok: false, error: "download_failed" };
    const r = await unpackAssets(zip, env);
    return { pack: pack.name, ...r };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Download one core and put its .so in place. Only a core the index actually
// publishes is accepted, and the CRC32 the index advertised is verified against the
// extracted file, so a truncated or swapped download is refused rather than handed
// to RetroArch to load.
function install(core, env, index) {
  return new Promise((resolve) => {
    if (!coreNameOk(core)) return resolve({ ok: false, error: "bad_core" });
    if (!index) return resolve({ ok: false, error: "no_index" });
    const want = index.get(core);
    if (!want) return resolve({ ok: false, error: "not_published" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-core-"));
    const zip = path.join(tmp, "core.zip");
    const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    execFile(
      "curl",
      [
        "-fsSL",
        "--proto",
        "=https",
        "--max-time",
        String(Math.round(DOWNLOAD_TIMEOUT_MS / 1000)),
        "-o",
        zip,
        baseUrl() + coreFile(core) + ".zip",
      ],
      { env, timeout: DOWNLOAD_TIMEOUT_MS },
      (err) => {
        if (err) {
          cleanup();
          return resolve({ ok: false, error: "download_failed" });
        }
        // Extract ONLY the file we came for. A zip is a list of paths the archive
        // chooses, so extracting all of it would let a crafted archive write
        // wherever it likes; naming the entry means anything else in there is
        // never unpacked, and a missing entry fails as a bad archive.
        execFile("unzip", ["-o", "-q", zip, coreFile(core), "-d", tmp], { env, timeout: 60000 }, (uerr) => {
          const out = path.join(tmp, coreFile(core));
          if (uerr || !isRegularFile(out)) {
            cleanup();
            return resolve({ ok: false, error: "bad_archive" });
          }
          const got = crc32OfFile(out);
          if (got === null || hex8(got) !== want.crc) {
            cleanup();
            return resolve({ ok: false, error: "crc_mismatch" });
          }
          // Land it with a rename: a copy that fails halfway would leave a
          // truncated .so where a working one used to be, and RetroArch loads
          // whatever is at that path.
          const dst = path.join(CORES_DIR, coreFile(core));
          const staging = dst + ".incoming-" + process.pid;
          try {
            fs.mkdirSync(CORES_DIR, { recursive: true });
            fs.copyFileSync(out, staging);
            fs.renameSync(staging, dst);
          } catch (e) {
            fs.rmSync(staging, { force: true });
            cleanup();
            return resolve({ ok: false, error: "write_failed" });
          }
          cleanup();
          // The core is in place; its system files are a separate, best-effort
          // step so a buildbot hiccup cannot undo a working install.
          installSystemAssets(core, env, index).then(
            (assets) => resolve({ ok: true, core, crc: hex8(got), assets }),
            () => resolve({ ok: true, core, crc: hex8(got), assets: { pack: null } }),
          );
        });
      },
    );
  });
}

// Same shape as install(): the phone page turns the error CODE into a sentence,
// so a bare false would reach it as an untranslated "failed".
function remove(core) {
  if (!coreNameOk(core)) return { ok: false, error: "bad_core" };
  try {
    fs.unlinkSync(path.join(CORES_DIR, coreFile(core)));
    return { ok: true, core };
  } catch (e) {
    return { ok: false, error: "remove_failed" };
  }
}

module.exports = {
  CORES_DIR,
  SYSTEM_DIR,
  installSystemAssets,
  _test: { assetForCore },
  OVERRIDES_DIR,
  videoDriversFor,
  setOverrideDriver,
  syncDriverOverrides,
  INFO_DIRS,
  isRegularFile,
  baseUrl,
  coreNameOk,
  parseIndex,
  parseInfo,
  fetchIndex,
  infoIndex,
  installed,
  list,
  install,
  remove,
};

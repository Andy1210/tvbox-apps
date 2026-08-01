// Finding the games, in two passes - because one of them is not enough.
//
// RetroArch's own scanner (`retroarch --scan=<dir>`, which runs headless and exits by
// itself) matches every file against its content database and adds ONLY what it
// recognises: the log marks the rest `??` and the game is silently dropped. That is
// exactly what a library made of bad dumps, hacks, homebrew or translations runs into -
// on this box a `[b]`-tagged DS game produced no playlist at all, and with no playlist
// there is no console in the grid and nothing for the cover fetcher to work with. Its
// menu has a "Manual Scan" for that case, and no command line reaches it.
//
// So a scan here is:
//
//   1. RetroArch's own pass, for the labels. A recognised game gets the database's
//      name ("Maestro! - Jump in Music (Europe)") rather than whatever the file is
//      called, and the right console with it.
//   2. Ours, for everything it left behind: every file the folder holds whose
//      extension an INSTALLED core claims, that no playlist mentions yet, appended to
//      the console that core declares. The label is the file name without extension,
//      which is what lib/art.js's loose matcher was built to work with anyway.
//
// The console comes from the cores' own metadata (`supported_extensions` +
// `database` in each .info), so nothing here has a list of consoles or file types
// written down. Where the extension alone cannot decide - `.bin`, `.cue`, `.iso`, `.zip`
// are claimed by several - the folder needs the console chosen once, which is the same
// question RetroArch's own manual scan asks.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const cores = require("./cores");
const art = require("./art");
const roms = require("./roms");
const games = require("./games");

const FLATPAK_REF = "org.libretro.RetroArch";
const SCAN_TIMEOUT_MS = 45 * 60 * 1000; // a big folder over a network share, hashed file by file
const WALK_MAX = 20000; // a runaway walk stops being about games at some point
// Files that live next to a game and are not one.
const NOT_GAMES = new Set([".sav", ".srm", ".state", ".png", ".jpg", ".txt", ".nfo", ".xml", ".dat", ".sbi", ".db"]);
// Raw disc tracks: playable only through the descriptor that names them, so they are
// skipped when one is present. (A folder with a .bin and no .cue keeps the .bin.)
const TRACKS = new Set([".bin", ".img", ".iso", ".mdf", ".ccd", ".sub"]);
const DESCRIPTORS = new Set([".cue", ".m3u", ".toc", ".gdi", ".pbp", ".chd"]);

function ext(p) {
  return path.extname(p).toLowerCase();
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
const tail = (db) => (db.includes(" - ") ? db.slice(db.indexOf(" - ") + 3) : db);

// The console a core is FOR. Almost every core declares several databases - melonDS
// lists five for the DS and DSi variants, mGBA lists Game Boy, Color and Advance,
// FCEUmm lists the NES and the Disk System - so "the extension names one console" is
// almost never true, and treating them all as equal candidates would make every folder
// undecidable. The core's own `systemname`/`systemid` says which one it is really for,
// and that is the one a scan files games under; the rest stay available as a choice.
function primaryDatabase(info) {
  const dbs = (info.databases || []).filter((s) => art.nameOk(s));
  if (!dbs.length) return "";
  for (const key of [norm(info.system), norm(info.systemid)]) {
    if (!key) continue;
    const hit = dbs.find((db) => norm(tail(db)) === key || norm(db) === key);
    if (hit) return hit;
  }
  // Then a looser one, because a database name often carries both regional names
  // ("Sega - Mega Drive - Genesis" for systemid `mega_drive`) and an exact match on
  // either field can only miss it.
  for (const key of [norm(info.systemid), norm(info.system)]) {
    if (key.length < 4) continue; // "nes" would match half the list
    const hit = dbs.find((db) => norm(tail(db)).includes(key) || key.includes(norm(tail(db))));
    if (hit) return hit;
  }
  return dbs[0]; // no self-description to go on: its first claim
}

// extension -> the console each INSTALLED core would file it under. Built from the same
// .info metadata lib/games.js resolves a core with, so the two cannot disagree about
// what this box is able to run. One console = a scan can just do it; several = the
// cores disagree and the folder needs the answer chosen once.
function extensionMap(opts) {
  const installed = (opts && opts.installed) || cores.installed();
  const index = (opts && opts.index) || cores.infoIndex();
  const map = new Map();
  for (const core of installed) {
    const info = index.get(core);
    if (!info) continue;
    const primary = primaryDatabase(info);
    if (!primary) continue; // a core that publishes no database cannot place a game
    for (const e of info.extensions || []) {
      const key = "." + e.replace(/^\./, "");
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(primary);
    }
  }
  return map;
}

// Every console the installed cores can file games under - the primary ones and their
// variants both, because "which console" is a question about the library, not about
// which core happens to be for it (a DSi game belongs in the DSi list).
function consoles(opts) {
  const installed = (opts && opts.installed) || cores.installed();
  const index = (opts && opts.index) || cores.infoIndex();
  const out = new Set();
  for (const core of installed) {
    const info = index.get(core);
    if (!info) continue;
    for (const db of info.databases || []) if (art.nameOk(db)) out.add(db);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

// Everything under a folder that could be a game, with the descriptor rule applied.
// Returns [{ path, ext }], depth-first and capped.
function walk(dir, allowed, seenDirs) {
  const out = [];
  const stack = [dir];
  const guard = seenDirs || new Set();
  while (stack.length && out.length < WALK_MAX) {
    const here = stack.pop();
    let real = here;
    try {
      real = fs.realpathSync(here);
    } catch (e) {
      continue;
    }
    if (guard.has(real)) continue; // a symlinked loop is not worth a stack overflow
    guard.add(real);
    let entries = [];
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch (e) {
      continue; // an unreadable folder is skipped, not fatal
    }
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(here, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) files.push(full);
    }
    // Per directory, because a disc's descriptor and its tracks live together.
    const descriptors = new Set(
      files.filter((f) => DESCRIPTORS.has(ext(f))).map((f) => path.basename(f, path.extname(f)).toLowerCase()),
    );
    for (const f of files) {
      const e = ext(f);
      if (!e || NOT_GAMES.has(e)) continue;
      if (allowed && !allowed.has(e)) continue;
      if (TRACKS.has(e) && descriptors.has(path.basename(f, path.extname(f)).toLowerCase())) continue;
      out.push({ path: f, ext: e });
    }
  }
  return out;
}

// The folders a scan can be pointed at, TWO levels deep. A library is laid out one of
// two ways here and both have to be pointable at: `roms/<console>/…`, where uploads
// land, and `roms/network/<console>/…`, because the share is mounted among them - so
// offering only the top level would offer "the whole share" and nothing else.
const FOLDER_MAX = 200; // a share with a thousand directories is not a menu
function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((c) => c.isDirectory() && !c.name.startsWith("."))
      .map((c) => c.name)
      .sort();
  } catch (e) {
    return []; // unreadable: the folder itself is still offered
  }
}

function folders() {
  const out = [];
  for (const name of subdirs(roms.ROMS_DIR)) {
    // Checked at BOTH levels: a library whose own root holds hundreds of
    // directories would otherwise sail past the cap, which exists so the menu
    // stays a menu.
    if (out.length >= FOLDER_MAX) return out;
    const dir = path.join(roms.ROMS_DIR, name);
    const children = subdirs(dir);
    out.push({ name, path: dir, depth: 0, folders: children });
    for (const child of children) {
      if (out.length >= FOLDER_MAX) return out;
      out.push({ name: child, path: path.join(dir, child), depth: 1, parent: name, folders: [] });
    }
  }
  return out;
}

// Is this path one of the folders a scan may be pointed at? The UI sends a path back,
// so it is checked against the list rather than trusted - and a path outside the roms
// folder must never reach a command line.
function resolveFolder(input) {
  const want = path.resolve(String(input || ""));
  const root = path.resolve(roms.ROMS_DIR);
  if (want !== root && !want.startsWith(root + path.sep)) return "";
  try {
    if (!fs.statSync(want).isDirectory()) return "";
    // Compare what the paths REALLY are, not what they spell. A subdirectory of
    // the library that is a symlink elsewhere passes the string test above while
    // pointing anywhere on the box, and this value goes on RetroArch's command
    // line. The root is resolved too, so a library that is itself a link (an
    // external drive, say) keeps working - only escaping from inside it does not.
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(want);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return "";
    return real;
  } catch (e) {
    return "";
  }
}

// What a folder holds, and what a scan would do with it: how many games, which
// consoles they resolve to, and how many are already in a playlist. This is what the
// screen shows before anyone presses anything.
function inspect(folder, opts) {
  const dir = resolveFolder(folder);
  // Same shape as a good answer, so a caller can read the counts without
  // checking for an error first: a folder that vanished (or turned unreadable)
  // between the listing and this call holds no games, which is also true.
  if (!dir) return { folder: "", error: "bad_folder", games: 0, already: 0, ambiguous: 0, systems: [] };
  const map = extensionMap(opts);
  const found = walk(dir, new Set(map.keys()));
  const known = knownPaths();
  const systems = new Map(); // console -> count
  let ambiguous = 0;
  let already = 0;
  for (const f of found) {
    if (known.has(f.path)) already++;
    const claim = map.get(f.ext);
    if (!claim || claim.size !== 1) {
      ambiguous++;
      continue;
    }
    const system = [...claim][0];
    systems.set(system, (systems.get(system) || 0) + 1);
  }
  return {
    folder: dir,
    games: found.length,
    already,
    ambiguous, // an extension several installed cores claim: the console must be chosen
    systems: [...systems.entries()].map(([system, n]) => ({ system, games: n })).sort((a, b) => b.games - a.games),
  };
}

// Every ROM path any playlist already lists. One read of each playlist, so a rescan
// adds what is missing instead of duplicating what is there.
function knownPaths() {
  const out = new Set();
  for (const system of games.systemNames()) for (const g of games.games(system)) out.add(g.rom);
  // games() dedupes by label; the raw entries are what must not be added twice.
  let files = [];
  try {
    files = fs.readdirSync(art.PLAYLISTS_DIR).filter((f) => f.endsWith(".lpl"));
  } catch (e) {
    return out;
  }
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(art.PLAYLISTS_DIR, f), "utf8"));
      for (const item of (doc && doc.items) || []) if (item && item.path) out.add(String(item.path));
    } catch (e) {
      /* unreadable playlist: its entries just look missing, and a rescan re-adds them */
    }
  }
  return out;
}

// RetroArch's own scanner. Headless: it prints its progress, writes what it
// recognised into the playlists, and exits on its own.
function retroarchScan(dir, env, onChild) {
  return new Promise((resolve) => {
    const child = execFile(
      "flatpak",
      ["run", "--die-with-parent", FLATPAK_REF, "--scan=" + dir],
      { env, timeout: SCAN_TIMEOUT_MS, maxBuffer: 8e6 },
      (err, stdout, stderr) => {
        const out = (stdout || "") + (stderr || "");
        // Its own tally: one line per file, `??` for the ones it did not recognise.
        const seen = (out.match(/^\d+\/\d+:/gm) || []).length;
        const missed = (out.match(/\?\?/g) || []).length;
        resolve({ ok: !err, seen, missed });
      },
    );
    if (onChild) onChild(child);
  });
}

// Read a playlist, or the shape RetroArch writes when it makes one.
function readPlaylist(system) {
  const file = path.join(art.PLAYLISTS_DIR, system + ".lpl");
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc && Array.isArray(doc.items)) return doc;
  } catch (e) {
    /* missing or unreadable: a fresh one, below */
  }
  return {
    version: "1.5",
    default_core_path: "",
    default_core_name: "",
    label_display_mode: 0,
    right_thumbnail_mode: 0,
    left_thumbnail_mode: 0,
    thumbnail_match_mode: 0,
    sort_mode: 0,
    items: [],
  };
}

// Written temp-then-rename: RetroArch reads these files whenever it starts, and a
// half-written playlist is a console that vanishes.
function writePlaylist(system, doc) {
  const file = path.join(art.PLAYLISTS_DIR, system + ".lpl");
  const tmp = file + ".tvbox-tmp";
  fs.mkdirSync(art.PLAYLISTS_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// The pass that catches what RetroArch dropped. `system` forces a console for the
// whole folder (what the screen asks for when the extension is ambiguous).
function addMissing(dir, opts) {
  const map = extensionMap(opts);
  const forced = (opts && opts.system) || "";
  if (forced && !art.nameOk(forced)) return { added: 0, skipped: 0, systems: [] };
  const found = walk(dir, forced ? null : new Set(map.keys()));
  const known = knownPaths();
  const bySystem = new Map();
  let skipped = 0;
  for (const f of found) {
    if (known.has(f.path)) continue;
    let system = forced;
    if (!system) {
      const claim = map.get(f.ext);
      if (!claim || claim.size !== 1) {
        skipped++; // the console cannot be told from the extension alone
        continue;
      }
      system = [...claim][0];
    }
    if (!bySystem.has(system)) bySystem.set(system, []);
    bySystem.get(system).push(f.path);
  }
  let added = 0;
  for (const [system, paths] of bySystem) {
    const doc = readPlaylist(system);
    for (const p of paths) {
      doc.items.push({
        path: p,
        label: path.basename(p, path.extname(p)),
        // DETECT is RetroArch's own "work it out": our launcher resolves the core from
        // the console's metadata anyway (lib/games.js), so nothing here pins one.
        core_path: "DETECT",
        core_name: "DETECT",
        crc32: "00000000|crc",
        db_name: system + ".lpl",
      });
      added++;
    }
    writePlaylist(system, doc);
  }
  // A console that just gained games has to be looked at again by the cover fetcher:
  // its last answer was about a list that no longer exists.
  if (bySystem.size) art.forget([...bySystem.keys()]);
  return { added, skipped, systems: [...bySystem.keys()] };
}

// One folder, both passes. `onProgress` is called with the stage so a screen can say
// what is happening: RetroArch's pass is the long one.
async function scan(folder, opts) {
  const o = opts || {};
  const dir = resolveFolder(folder);
  if (!dir) return { ok: false, error: "bad_folder" };
  if (o.onProgress) o.onProgress({ stage: "retroarch", folder: dir });
  const ra = await retroarchScan(dir, o.env, o.onChild);
  if (o.stopped && o.stopped()) return { ok: true, stopped: true, matched: ra.seen - ra.missed, added: 0 };
  if (o.onProgress) o.onProgress({ stage: "adding", folder: dir, matched: ra.seen - ra.missed });
  let mine = { added: 0, skipped: 0, systems: [] };
  try {
    mine = addMissing(dir, o);
  } catch (e) {
    return { ok: false, error: "write_failed", detail: String((e && e.message) || e) };
  }
  return {
    ok: true,
    folder: dir,
    seen: ra.seen,
    matched: Math.max(0, ra.seen - ra.missed),
    added: mine.added,
    skipped: mine.skipped,
    systems: mine.systems,
  };
}

module.exports = {
  primaryDatabase,
  consoles,
  extensionMap,
  walk,
  folders,
  resolveFolder,
  inspect,
  knownPaths,
  readPlaylist,
  writePlaylist,
  addMissing,
  retroarchScan,
  scan,
  NOT_GAMES,
  TRACKS,
  DESCRIPTORS,
};

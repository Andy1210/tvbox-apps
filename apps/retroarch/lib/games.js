// The box's own game list, and which core plays each game.
//
// RetroArch keeps one playlist per console (playlists/<System>.lpl, JSON) with the
// ROM path and label of every scanned game, and lib/art.js has already put a cover
// next to almost all of them. That is everything a grid needs, so the list is READ
// from those files instead of being kept a second time: a console scanned in
// RetroArch is simply there, and RetroArch's own UI keeps working unchanged.
//
// What a playlist is NOT good for is the core. `core_path` is whatever core the
// folder happened to be scanned with, and a wrong one is normal - this box's own
// PlayStation list points half its entries at an arcade core. So the core is
// resolved from each installed core's OWN `.info` metadata (lib/cores.js), whose
// `systemname` is the same name the playlist file carries, with the playlist's
// choice used only to break a tie between cores that both claim the console, and a
// per-console override the user can set from the UI.

const fs = require("fs");
const path = require("path");
const os = require("os");

const cores = require("./cores");
const art = require("./art");
const share = require("./share");

const OVERRIDES_FILE = path.join(os.homedir(), ".tvbox", "retroarch-systems.json");

// Playlists RetroArch keeps for its own bookkeeping, not for a console.
const INTERNAL = /^content_/;

// Which file to launch when several entries share a label. A disc game is scanned
// once per track file as well as per .cue, and launching a raw track plays silence
// or nothing at all; the descriptor files are the ones that work. Anything not
// listed sorts after these in file-name order, so a system with no discs is
// unaffected.
const EXT_RANK = { ".m3u": 0, ".cue": 1, ".chd": 2, ".pbp": 3 };
function extRank(p) {
  const e = path.extname(String(p || "")).toLowerCase();
  return e in EXT_RANK ? EXT_RANK[e] : 9;
}

// A whole ROM set commonly exists twice - once copied onto the box, once on the
// network share it came from (this box has all 787 of its NES games in both) - and
// the local copy is the one to launch: it loads faster and it is there when the
// share is not mounted.
// The share's mount point, read once per playlist pass - not per comparison, which
// on this box's NES list would be 1568 config reads.
function sharePoint() {
  try {
    return share.mountPoint(share.readConfig()) || "";
  } catch (e) {
    return "";
  }
}
function onShare(p, point) {
  return !!point && String(p || "").startsWith(point + path.sep);
}

// Whether a ROM's FOLDER is still there, which is what tells a live copy from a
// stale playlist entry. Deliberately not a stat of the file itself: a playlist
// records every game a folder ever held, so this box's NES entries still point at a
// local set that was deleted after the same games appeared on the share - and
// statting 1568 files, half of them over a FUSE mount, to find that out is not
// something a grid can do on every open. One stat per folder, memoised per pass.
function dirLives(rom, seen) {
  const dir = path.dirname(String(rom || ""));
  if (seen.has(dir)) return seen.get(dir);
  let ok = false;
  try {
    ok = fs.statSync(dir).isDirectory();
  } catch (e) {
    ok = false;
  }
  seen.set(dir, ok);
  return ok;
}

// Of two entries with the same label, which one to launch: a folder that still
// exists before one that is gone, then local before the network share (faster, and
// there when the share is not mounted), then a disc DESCRIPTOR before a raw track (a
// game scanned per track as well as per .cue plays silence or nothing from the
// track), then the shorter path - so the choice is stable rather than dependent on
// scan order.
function better(a, b, point, seen) {
  const [al, bl] = [dirLives(a.rom, seen), dirLives(b.rom, seen)];
  if (al !== bl) return al ? a : b;
  if (onShare(a.rom, point) !== onShare(b.rom, point)) return onShare(a.rom, point) ? b : a;
  if (extRank(a.rom) !== extRank(b.rom)) return extRank(a.rom) < extRank(b.rom) ? a : b;
  return a.rom.length <= b.rom.length ? a : b;
}

function readOverrides() {
  try {
    const d = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
    return d && typeof d === "object" ? d : {};
  } catch (e) {
    return {}; // no overrides yet, or a file someone hand-edited into invalid JSON
  }
}

function writeOverride(system, core) {
  if (!art.nameOk(system)) return false;
  if (core !== null && !cores.coreNameOk(core)) return false;
  const all = readOverrides();
  if (core === null) delete all[system];
  else all[system] = core;
  fs.mkdirSync(path.dirname(OVERRIDES_FILE), { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(all, null, 2) + "\n");
  return true;
}

// ---- reading the playlists ----

// A playlist file is a few hundred kB of JSON and the grid asks for it on every
// view change, so it is parsed once per file version (mtime+size, so an edit is
// always picked up) rather than per request.
const cache = new Map(); // system -> { key, games, hints }

function playlistFile(system) {
  return path.join(art.PLAYLISTS_DIR, system + ".lpl");
}

function systemNames() {
  let files = [];
  try {
    files = fs.readdirSync(art.PLAYLISTS_DIR).filter((f) => f.endsWith(".lpl"));
  } catch (e) {
    return []; // RetroArch has never run
  }
  return files
    .map((f) => f.slice(0, -4))
    .filter((s) => art.nameOk(s) && !INTERNAL.test(s))
    .sort((a, b) => a.localeCompare(b));
}

// One console's games: deduplicated by label, sorted by label, each with the ROM
// path that should actually be launched and the core the playlist scanned it with
// (a hint, see coreFor).
function read(system) {
  const empty = { games: [], hints: new Map() };
  if (!art.nameOk(system) || INTERNAL.test(system)) return empty;
  const file = playlistFile(system);
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return empty;
  }
  const key = st.mtimeMs + ":" + st.size;
  const hit = cache.get(system);
  if (hit && hit.key === key) return hit;
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return empty; // half-written or hand-broken playlist: an empty console, not a crash
  }
  const byLabel = new Map();
  const hints = new Map();
  const point = sharePoint();
  const dirs = new Map(); // folder -> does it still exist (one stat each, this pass only)
  for (const item of (doc && doc.items) || []) {
    const label = String((item && item.label) || "").trim();
    const rom = String((item && item.path) || "");
    if (!label || !rom) continue;
    // Counted over every entry, INCLUDING the ones dedup drops: a disc game's
    // playable .cue is often the one that was scanned with no core while its raw
    // track carries the right one, and dropping that would lose the only signal
    // there is about which of two equally valid cores the user meant.
    const hint = corePathName(item.core_path);
    if (hint) hints.set(hint, (hints.get(hint) || 0) + 1);
    const prev = byLabel.get(label);
    byLabel.set(label, prev ? better(prev, { label, rom }, point, dirs) : { label, rom });
  }
  const games = [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
  // The index IS the id the UI sends back (for a cover or a launch), so it must be
  // assigned after the sort and read from the same cached array.
  games.forEach((g, i) => {
    g.i = i;
  });
  const entry = { key, games, hints };
  cache.set(system, entry);
  return entry;
}

function games(system) {
  return read(system).games;
}

// "…/cores/pcsx_rearmed_libretro.so" -> "pcsx_rearmed"; "DETECT" -> null.
function corePathName(p) {
  const base = path.basename(String(p || ""));
  const m = /^(.+)_libretro\.so$/.exec(base);
  return m && cores.coreNameOk(m[1]) ? m[1] : null;
}

// ---- which core plays a console ----

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

// The consoles a core answers to.
//
// `database` is the authoritative field - it lists the very libretro database
// names RetroArch names its playlists after ("Sony - PlayStation Portable"), so it
// matches without any interpretation. `systemname` is a human label in whatever
// shape the core author chose ("PSP", "Game Boy/Game Boy Color", "Sega 8/16-bit
// (Various)"), and is only a fallback for a core whose info file has no database
// line: split on "/" and offer each part with and without the "Vendor - " prefix,
// which is what lets a two-console core resolve at all.
function systemAliases(info) {
  const out = new Set();
  const meta = typeof info === "string" ? { system: info } : info || {};
  for (const db of meta.databases || []) out.add(norm(db));
  const whole = String(meta.system || "").trim();
  if (!whole) return out;
  out.add(norm(whole));
  const vendor = /^([^-]+)-/.exec(whole);
  for (const part of whole.split("/")) {
    const p = part.trim();
    if (!p) continue;
    out.add(norm(p));
    const tail = p.includes(" - ") ? p.slice(p.indexOf(" - ") + 3) : p;
    out.add(norm(tail));
    if (vendor) out.add(norm(vendor[1] + " - " + tail));
  }
  return out;
}

// Every installed core that claims this console, best first. Metadata decides who
// is a candidate at all; the playlist's own choice only orders them, because it is
// often simply wrong (a PlayStation list scanned with an arcade core) but when it
// names a core that DOES claim the console it is the closest thing to a user
// preference we have.
function coreCandidates(system, opts) {
  const installed = (opts && opts.installed) || cores.installed();
  const index = (opts && opts.index) || cores.infoIndex();
  const hints = (opts && opts.hints) || new Map();
  const want = new Set([norm(system), norm(system.includes(" - ") ? system.slice(system.indexOf(" - ") + 3) : system)]);
  const out = [];
  for (const core of installed) {
    const info = index.get(core) || {};
    const aliases = systemAliases(info);
    let match = false;
    for (const a of want) if (a && aliases.has(a)) match = true;
    if (!match) continue;
    out.push({ core, name: info.display || info.name || core, hits: hints.get(core) || 0 });
  }
  return out.sort((a, b) => b.hits - a.hits || a.core.localeCompare(b.core));
}

// How many entries of this console's playlist were scanned with each core.
function coreHints(system) {
  return read(system).hints;
}

// The core this console plays with: the user's override if it is still installed,
// otherwise the best candidate. Returns null when no installed core claims the
// console - the UI then says which one to add instead of launching something that
// cannot load the ROM.
function coreFor(system, opts) {
  const installed = (opts && opts.installed) || cores.installed();
  const override = readOverrides()[system];
  if (override && installed.includes(override)) return override;
  const list = coreCandidates(system, { ...opts, installed, hints: (opts && opts.hints) || coreHints(system) });
  return list.length ? list[0].core : null;
}

function corePath(core) {
  return path.join(cores.CORES_DIR, core + "_libretro.so");
}

// ---- what the UI asks for ----

// The console rail: how many games, how many have a cover, and which core will
// play them. One directory listing per console for the covers (art.localNames),
// not a stat per game.
function systems() {
  const installed = cores.installed();
  const index = cores.infoIndex();
  const overrides = readOverrides();
  return systemNames().map((system) => {
    const list = games(system);
    const covers = art.localNames(system);
    const hints = coreHints(system);
    const candidates = coreCandidates(system, { installed, index, hints });
    const chosen = overrides[system] && installed.includes(overrides[system]) ? overrides[system] : null;
    const core = chosen || (candidates.length ? candidates[0].core : null);
    return {
      system,
      games: list.length,
      withCover: list.filter((g) => covers.has(art.scrubLabel(g.label))).length,
      core,
      coreName: (candidates.find((c) => c.core === core) || {}).name || null,
      override: chosen,
      candidates,
    };
  });
}

// One console's games for the grid. `cover` is whether a file is already on disk,
// so the UI can show a titled placeholder instead of a broken image.
function list(system) {
  const covers = art.localNames(system);
  return games(system).map((g) => ({
    i: g.i,
    label: g.label,
    cover: covers.has(art.scrubLabel(g.label)),
  }));
}

// The cover file for one game, or null. Built from the playlist's own label
// through art.js's scrubbing - never from anything the UI sends - so the id is all
// the UI is trusted with.
function coverFile(system, i) {
  const g = games(system)[Number(i)];
  if (!g) return null;
  const p = art.boxartPath(system, art.scrubLabel(g.label));
  if (!p) return null;
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch (e) {
    return null;
  }
}

// Everything needed to launch one game: the ROM as the playlist records it and the
// core resolved for its console. `error` says which of the two is missing, because
// "nothing happened" on a TV is the worst possible answer.
function launchSpec(system, i) {
  const g = games(system)[Number(i)];
  if (!g) return { error: "unknown_game" };
  const core = coreFor(system);
  if (!core) return { error: "no_core" };
  const so = corePath(core);
  if (!cores.isRegularFile(so)) return { error: "no_core" };
  try {
    if (!fs.statSync(g.rom).isFile()) return { error: "rom_missing", rom: g.rom };
  } catch (e) {
    // A network share that is not mounted right now is the common case, and it is
    // worth saying so rather than starting an emulator that shows a black screen.
    return { error: "rom_missing", rom: g.rom };
  }
  return { label: g.label, rom: g.rom, core, corePath: so };
}

module.exports = {
  OVERRIDES_FILE,
  extRank,
  better,
  systemAliases,
  corePathName,
  readOverrides,
  writeOverride,
  systemNames,
  games,
  coreCandidates,
  coreHints,
  coreFor,
  corePath,
  systems,
  list,
  coverFile,
  launchSpec,
};

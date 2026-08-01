// Tests for finding games. The rules here decide what ends up in a playlist, and a
// wrong one is not visible on a TV: a game silently missing, a raw disc track offered
// as if it were playable, or a save file listed as a game. HOME is redirected before
// the modules load, because they resolve their directories at require time.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-scan-test-"));
process.env.HOME = HOME;
const art = require("./art");
const cores = require("./cores");
const roms = require("./roms");
const scan = require("./scan");

const GBA = "Nintendo - Game Boy Advance";
const PSX = "Sony - PlayStation";

function installCore(core, info) {
  fs.mkdirSync(cores.CORES_DIR, { recursive: true });
  fs.writeFileSync(path.join(cores.CORES_DIR, core + "_libretro.so"), "so");
  const dir = cores.INFO_DIRS[0];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, core + "_libretro.info"), info);
}

function folder(name, files) {
  const dir = path.join(roms.ROMS_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body || "x");
  }
  return dir;
}

const reset = () => {
  fs.rmSync(art.PLAYLISTS_DIR, { recursive: true, force: true });
  fs.rmSync(cores.CORES_DIR, { recursive: true, force: true });
  fs.rmSync(cores.INFO_DIRS[0], { recursive: true, force: true });
};

test("the roms folder really is under the redirected HOME", () => {
  assert.ok(roms.ROMS_DIR.startsWith(HOME), roms.ROMS_DIR);
});

test("a scan can only be pointed inside the roms folder", () => {
  folder("gba", { "A.gba": "" });
  assert.ok(scan.resolveFolder(path.join(roms.ROMS_DIR, "gba")));
  assert.strictEqual(scan.resolveFolder("/etc"), "");
  assert.strictEqual(scan.resolveFolder(path.join(roms.ROMS_DIR, "..", "..", "etc")), "");
  assert.strictEqual(scan.resolveFolder(path.join(roms.ROMS_DIR, "nope")), "");
  assert.strictEqual(scan.resolveFolder(""), "");
});

test("the walk keeps games, drops what sits next to them, and skips a disc's raw tracks", () => {
  const dir = folder("psx", {
    "Game.cue": "",
    "Game.bin": "", // named by the .cue: launching it plays nothing
    "Game.sav": "",
    "Loose.bin": "", // no descriptor: this one IS the game
    "notes.txt": "",
    ".hidden.iso": "",
    "sub/Deep.chd": "",
  });
  const got = scan
    .walk(dir, null)
    .map((f) => path.basename(f.path))
    .sort();
  assert.deepStrictEqual(got, ["Deep.chd", "Game.cue", "Loose.bin"]);
});

test("extensions map to consoles through the installed cores' own metadata", () => {
  reset();
  installCore(
    "mgba",
    'systemname = "Game Boy Advance"\ndatabase = "' + GBA + '"\nsupported_extensions = "gb|gbc|gba"\n',
  );
  const map = scan.extensionMap();
  assert.deepStrictEqual([...(map.get(".gba") || [])], [GBA]);
  assert.strictEqual(map.has(".nes"), false, "a console with no installed core claims nothing");
  // A core that publishes no database name cannot place a game anywhere.
  installCore("weird", 'systemname = "Weird"\nsupported_extensions = "wrd"\n');
  assert.strictEqual(scan.extensionMap().has(".wrd"), false);
});

test("inspect says what would happen before anything runs", () => {
  reset();
  installCore("mgba", 'database = "' + GBA + '"\nsupported_extensions = "gba"\n');
  installCore("pcsx_rearmed", 'database = "' + PSX + '"\nsupported_extensions = "cue|bin"\n');
  const dir = folder("mixed", { "A.gba": "", "B.gba": "", "Disc.cue": "", "readme.txt": "" });
  const look = scan.inspect(dir);
  assert.strictEqual(look.games, 3);
  assert.deepStrictEqual(
    look.systems.map((s) => [s.system, s.games]),
    [
      [GBA, 2],
      [PSX, 1],
    ],
  );
  assert.strictEqual(look.ambiguous, 0);
  assert.strictEqual(look.already, 0);
});

test("an extension several consoles claim is reported as undecidable, not guessed", () => {
  reset();
  installCore("pcsx_rearmed", 'database = "' + PSX + '"\nsupported_extensions = "cue|chd"\n');
  installCore("flycast", 'database = "Sega - Dreamcast"\nsupported_extensions = "cue|chd|gdi"\n');
  const dir = folder("discs", { "Game.chd": "" });
  const look = scan.inspect(dir);
  assert.strictEqual(look.ambiguous, 1);
  assert.deepStrictEqual(look.systems, []);
  // ... and nothing is added on a scan pass either.
  const r = scan.addMissing(dir);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.skipped, 1);
  // Unless the console is named, which is what the screen asks for.
  const forced = scan.addMissing(dir, { system: PSX });
  assert.strictEqual(forced.added, 1);
  assert.deepStrictEqual(scan.readPlaylist(PSX).items[0].label, "Game");
});

test("adding writes a playlist RetroArch's own format, and never twice", () => {
  reset();
  installCore("mgba", 'database = "' + GBA + '"\nsupported_extensions = "gba"\n');
  const dir = folder("gba2", { "Zelda (USA).gba": "", "sub/Metroid (Europe).gba": "" });
  const first = scan.addMissing(dir);
  assert.strictEqual(first.added, 2);
  const doc = scan.readPlaylist(GBA);
  assert.strictEqual(doc.version, "1.5");
  const labels = doc.items.map((i) => i.label).sort();
  assert.deepStrictEqual(labels, ["Metroid (Europe)", "Zelda (USA)"]);
  for (const item of doc.items) {
    assert.strictEqual(item.db_name, GBA + ".lpl");
    assert.strictEqual(item.core_path, "DETECT", "the core is resolved at launch, not pinned at scan time");
    assert.ok(path.isAbsolute(item.path));
  }
  // Re-running adds nothing: the paths are already listed.
  assert.strictEqual(scan.addMissing(dir).added, 0);
  assert.strictEqual(scan.readPlaylist(GBA).items.length, 2);
});

test("an existing playlist is added to, not replaced", () => {
  reset();
  installCore("mgba", 'database = "' + GBA + '"\nsupported_extensions = "gba"\n');
  fs.mkdirSync(art.PLAYLISTS_DIR, { recursive: true });
  const existing = {
    version: "1.5",
    items: [{ path: "/somewhere/Old.gba", label: "Old Game (USA)", core_path: "DETECT", db_name: GBA + ".lpl" }],
  };
  fs.writeFileSync(path.join(art.PLAYLISTS_DIR, GBA + ".lpl"), JSON.stringify(existing));
  const dir = folder("gba3", { "New.gba": "" });
  scan.addMissing(dir);
  const items = scan.readPlaylist(GBA).items;
  assert.strictEqual(items.length, 2);
  assert.ok(
    items.some((i) => i.label === "Old Game (USA)"),
    "RetroArch's own entry survives",
  );
  assert.ok(items.some((i) => i.label === "New"));
});

test("a playlist is written whole, so a half-written file cannot be read", () => {
  reset();
  installCore("mgba", 'database = "' + GBA + '"\nsupported_extensions = "gba"\n');
  scan.addMissing(folder("gba4", { "A.gba": "" }));
  const left = fs.readdirSync(art.PLAYLISTS_DIR).filter((f) => f.includes("tmp"));
  assert.deepStrictEqual(left, [], "no temp file left behind");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(art.PLAYLISTS_DIR, GBA + ".lpl"), "utf8")));
});

test("the folder list is what a scan can be pointed at, with the folders inside it", () => {
  folder("nes", { "A.nes": "", "USA/B.nes": "" });
  const list = scan.folders();
  const nes = list.find((f) => f.name === "nes");
  assert.ok(nes, "the folder is offered");
  assert.deepStrictEqual(nes.folders, ["USA"]);
  assert.ok(list.every((f) => f.path.startsWith(roms.ROMS_DIR)));
});

test("a console that gains games is re-checked for covers instead of trusting the last answer", () => {
  reset();
  installCore("mgba", 'database = "' + GBA + '"\nsupported_extensions = "gba"\n');
  // The cover fetcher concluded "nothing on the server" for this console; that answer
  // was about a list that is about to change.
  fs.mkdirSync(path.dirname(art.STATE_FILE), { recursive: true });
  fs.writeFileSync(art.STATE_FILE, JSON.stringify({ systems: { [GBA]: { checkedAt: Date.now(), unavailable: 5 } } }));
  scan.addMissing(folder("gba5", { "New.gba": "" }));
  const state = JSON.parse(fs.readFileSync(art.STATE_FILE, "utf8"));
  assert.strictEqual(state.systems[GBA], undefined, "the stale conclusion is dropped");
});

test("a re-release variant playlist is folded back into its console", () => {
  // RetroArch writes "Sony - PlayStation Portable (PSN)" beside the plain list
  // because libretro matched a different content database, and the grid then
  // showed one console twice - the second with no emulator, because no core
  // names the variant.
  const base = "Sony - PlayStation Portable";
  const psn = base + " (PSN)";
  fs.mkdirSync(art.PLAYLISTS_DIR, { recursive: true });
  const item = (label, file) => ({ label, path: path.join(HOME, file), core_path: "DETECT", db_name: "x.lpl" });
  scan.writePlaylist(base, { ...scan.readPlaylist(base), items: [item("Plain", "a.iso")] });
  scan.writePlaylist(psn, { ...scan.readPlaylist(psn), items: [item("Digital", "b.pkg")] });
  installCore("ppsspp", 'corename = "PPSSPP"\nsystemname = "PSP"\ndatabase = "Sony - PlayStation Portable"\n');

  assert.strictEqual(scan.foldVariants(), 1, "one console folded away");
  assert.strictEqual(fs.existsSync(path.join(art.PLAYLISTS_DIR, psn + ".lpl")), false, "the variant is gone");
  const items = scan.readPlaylist(base).items;
  assert.deepStrictEqual(
    items.map((i) => i.label).sort(),
    ["Digital", "Plain"],
    "both games are on the one console now",
  );
  // The moved entry says which playlist it belongs to, or RetroArch's own views
  // disagree with the file it sits in.
  assert.strictEqual(items.find((i) => i.label === "Digital").db_name, base + ".lpl");
  // Idempotent: nothing left to fold, and the base is not touched again.
  assert.strictEqual(scan.foldVariants(), 0);
});

test("a variant whose base console nobody plays is left alone", () => {
  const orphan = "Nintendo - Nintendo DS (Download Play)";
  fs.mkdirSync(art.PLAYLISTS_DIR, { recursive: true });
  scan.writePlaylist(orphan, {
    ...scan.readPlaylist(orphan),
    items: [{ label: "G", path: path.join(HOME, "g.nds"), core_path: "DETECT", db_name: "x.lpl" }],
  });
  assert.strictEqual(scan.foldVariants(), 0);
  assert.strictEqual(fs.existsSync(path.join(art.PLAYLISTS_DIR, orphan + ".lpl")), true, "still there");
});

test("an empty variant console is folded away too", () => {
  // Nothing to merge is not nothing to do: the FILE is what makes a console, so
  // leaving it there keeps a second, permanently empty console on the grid.
  const base = "Sony - PlayStation Portable";
  const empty = base + " (PSN)";
  fs.mkdirSync(art.PLAYLISTS_DIR, { recursive: true });
  scan.writePlaylist(empty, { ...scan.readPlaylist(empty), items: [] });
  installCore("ppsspp", 'corename = "PPSSPP"\nsystemname = "PSP"\ndatabase = "Sony - PlayStation Portable"\n');
  assert.strictEqual(scan.foldVariants(), 1);
  assert.strictEqual(fs.existsSync(path.join(art.PLAYLISTS_DIR, empty + ".lpl")), false);
});

test("a playlist entry with no path is not carried over", () => {
  const base = "Sony - PlayStation Portable";
  const psn = base + " (PSN)";
  fs.mkdirSync(art.PLAYLISTS_DIR, { recursive: true });
  scan.writePlaylist(base, { ...scan.readPlaylist(base), items: [] });
  scan.writePlaylist(psn, {
    ...scan.readPlaylist(psn),
    items: [{ label: "Broken" }, { label: "Real", path: path.join(HOME, "r.iso") }],
  });
  installCore("ppsspp", 'corename = "PPSSPP"\nsystemname = "PSP"\ndatabase = "Sony - PlayStation Portable"\n');
  scan.foldVariants();
  const items = scan.readPlaylist(base).items;
  assert.deepStrictEqual(
    items.map((i) => i.label),
    ["Real"],
    "only the entry that names a game came across",
  );
});

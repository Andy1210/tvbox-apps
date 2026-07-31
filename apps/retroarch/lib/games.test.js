// Library tests for the game list. Two things here decide whether pressing OK on a
// tile actually plays anything, and neither is obvious from the playlist: WHICH of
// several entries sharing a label is the one to launch, and WHICH core the console
// resolves to. HOME is redirected before the modules load, because they resolve
// their directories at require time.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-games-test-"));
process.env.HOME = HOME;
const art = require("./art");
const cores = require("./cores");
const games = require("./games");

const PLAYLISTS = art.PLAYLISTS_DIR;
const SYS = "Sony - PlayStation";

function playlist(system, items) {
  fs.mkdirSync(PLAYLISTS, { recursive: true });
  fs.writeFileSync(path.join(PLAYLISTS, system + ".lpl"), JSON.stringify({ version: "1.5", items }));
}

function installCore(core, info) {
  fs.mkdirSync(cores.CORES_DIR, { recursive: true });
  fs.writeFileSync(path.join(cores.CORES_DIR, core + "_libretro.so"), "so");
  const dir = cores.INFO_DIRS[0];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, core + "_libretro.info"), info);
}

const reset = () => {
  fs.rmSync(PLAYLISTS, { recursive: true, force: true });
  fs.rmSync(games.OVERRIDES_FILE, { force: true });
};

test("the playlists really are under the redirected HOME (the tests are not reading a real library)", () => {
  assert.ok(PLAYLISTS.startsWith(HOME), PLAYLISTS);
});

test("entries sharing a label collapse to one game, and the launchable file wins", () => {
  reset();
  const live = path.join(HOME, "roms", "psx");
  fs.mkdirSync(live, { recursive: true });
  playlist(SYS, [
    // Same game, three ways: a raw track, its descriptor, and a copy in a folder
    // that no longer exists (a playlist keeps every game a folder ever held).
    { label: "Hercules", path: path.join(live, "Hercules.bin"), core_path: "DETECT" },
    { label: "Hercules", path: path.join(live, "Hercules.cue"), core_path: "DETECT" },
    { label: "Hercules", path: path.join(HOME, "gone", "Hercules.cue"), core_path: "DETECT" },
    { label: "Toy Story", path: path.join(live, "Toy Story.bin"), core_path: "DETECT" },
  ]);
  const list = games.list(SYS);
  assert.deepStrictEqual(
    list.map((g) => g.label),
    ["Hercules", "Toy Story"],
  );
  assert.strictEqual(games.games(SYS)[0].rom, path.join(live, "Hercules.cue"));
});

test("a dead folder loses to a live one even when its file looks better", () => {
  reset();
  const live = path.join(HOME, "roms", "live");
  fs.mkdirSync(live, { recursive: true });
  playlist(SYS, [
    { label: "Game", path: path.join(HOME, "roms", "dead", "Game.cue"), core_path: "DETECT" },
    { label: "Game", path: path.join(live, "Game.bin"), core_path: "DETECT" },
  ]);
  assert.strictEqual(games.games(SYS)[0].rom, path.join(live, "Game.bin"));
});

test("a console resolves to a core that declares its DATABASE name, not its systemname", () => {
  reset();
  // ppsspp calls itself "PSP" while the playlist is "Sony - PlayStation Portable" -
  // only the database line connects the two.
  installCore("ppsspp", 'corename = "PPSSPP"\nsystemname = "PSP"\ndatabase = "Sony - PlayStation Portable"\n');
  playlist("Sony - PlayStation Portable", [{ label: "G", path: path.join(HOME, "g.iso"), core_path: "DETECT" }]);
  assert.strictEqual(games.coreFor("Sony - PlayStation Portable"), "ppsspp");
});

test("a two-console core resolves for each of its consoles (systemname fallback)", () => {
  reset();
  installCore("gambatte", 'corename = "Gambatte"\nsystemname = "Game Boy/Game Boy Color"\n');
  for (const s of ["Nintendo - Game Boy", "Nintendo - Game Boy Color"]) {
    playlist(s, [{ label: "G", path: path.join(HOME, "g.gb"), core_path: "DETECT" }]);
    assert.strictEqual(games.coreFor(s), "gambatte", s);
  }
});

test("between two cores that both claim the console, the one the playlist used wins", () => {
  reset();
  installCore("mednafen_psx_hw", 'corename = "Beetle PSX HW"\nsystemname = "PlayStation"\ndatabase = "' + SYS + '"\n');
  installCore("pcsx_rearmed", 'corename = "PCSX-ReARMed"\nsystemname = "PlayStation"\ndatabase = "' + SYS + '"\n');
  const rearmed = path.join(cores.CORES_DIR, "pcsx_rearmed_libretro.so");
  playlist(SYS, [
    { label: "A", path: path.join(HOME, "a.cue"), core_path: rearmed },
    // A wrong core in the playlist must not make it a candidate at all.
    { label: "B", path: path.join(HOME, "b.cue"), core_path: path.join(cores.CORES_DIR, "fbneo_libretro.so") },
  ]);
  assert.strictEqual(games.coreFor(SYS), "pcsx_rearmed");
  assert.deepStrictEqual(
    games.coreCandidates(SYS, { hints: games.coreHints(SYS) }).map((c) => c.core),
    ["pcsx_rearmed", "mednafen_psx_hw"],
  );
});

test("an override wins over the metadata, and only while its core is installed", () => {
  reset();
  installCore("mednafen_psx_hw", 'systemname = "PlayStation"\ndatabase = "' + SYS + '"\n');
  installCore("pcsx_rearmed", 'systemname = "PlayStation"\ndatabase = "' + SYS + '"\n');
  playlist(SYS, [{ label: "A", path: path.join(HOME, "a.cue"), core_path: "DETECT" }]);
  assert.ok(games.writeOverride(SYS, "mednafen_psx_hw"));
  assert.strictEqual(games.coreFor(SYS), "mednafen_psx_hw");
  fs.rmSync(path.join(cores.CORES_DIR, "mednafen_psx_hw_libretro.so"));
  assert.strictEqual(games.coreFor(SYS), "pcsx_rearmed");
  assert.ok(games.writeOverride(SYS, null));
  assert.strictEqual(games.readOverrides()[SYS], undefined);
});

test("a launch is refused with a reason rather than starting something broken", () => {
  reset();
  const live = path.join(HOME, "roms", "psx2");
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "A.cue"), "x");
  playlist(SYS, [
    { label: "A", path: path.join(live, "A.cue"), core_path: "DETECT" },
    { label: "Gone", path: path.join(live, "Gone.cue"), core_path: "DETECT" },
  ]);
  fs.rmSync(path.join(cores.CORES_DIR, "pcsx_rearmed_libretro.so"), { force: true });
  assert.strictEqual(games.launchSpec(SYS, 0).error, "no_core");
  installCore("pcsx_rearmed", 'systemname = "PlayStation"\ndatabase = "' + SYS + '"\n');
  assert.strictEqual(games.launchSpec(SYS, 0).error, undefined);
  assert.strictEqual(games.launchSpec(SYS, 1).error, "rom_missing");
  assert.strictEqual(games.launchSpec(SYS, 99).error, "unknown_game");
  assert.strictEqual(games.launchSpec("../etc", 0).error, "unknown_game");
});

test("a half-written playlist is an empty console, not a crash", () => {
  reset();
  fs.mkdirSync(PLAYLISTS, { recursive: true });
  fs.writeFileSync(path.join(PLAYLISTS, "Broken.lpl"), '{"items": [{"label": "x"');
  assert.deepStrictEqual(games.list("Broken"), []);
  assert.ok(games.systemNames().includes("Broken"));
});

test("the covers a console has are counted through art.js's own scrubbing", () => {
  reset();
  const scrubbed = art.scrubLabel('Rock: N "Roll');
  const dir = path.dirname(art.boxartPath("Sega - Mega Drive", scrubbed));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(art.boxartPath("Sega - Mega Drive", scrubbed), "png");
  playlist("Sega - Mega Drive", [
    { label: 'Rock: N "Roll', path: path.join(HOME, "r.md"), core_path: "DETECT" },
    { label: "No Cover", path: path.join(HOME, "n.md"), core_path: "DETECT" },
  ]);
  const byLabel = new Map(games.list("Sega - Mega Drive").map((g) => [g.label, g.cover]));
  assert.strictEqual(byLabel.get('Rock: N "Roll'), true);
  assert.strictEqual(byLabel.get("No Cover"), false);
  const row = games.systems().find((s) => s.system === "Sega - Mega Drive");
  assert.strictEqual(row.withCover, 1);
});

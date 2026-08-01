// tvbox RetroArch plugin. The app ships its own 10-foot UI (web/, built from
// apps-src/retroarch): the box browses the games, and RetroArch is the program it
// launches per game (`runtime.native` + host.launchNative, see shell/native.js) -
// which is why the plugin serves a games list and a cover for every tile, on top of
// the SETUP that RetroArch cannot be expected to get right by itself here:
//
//   1. the video driver. RetroArch asks for whatever a core declares, and this
//      hardware serves desktop GL 3.1 (compatibility), GLES 3.1 and Vulkan - but
//      NOT a GL core profile above 3.1. So the driver is chosen here rather than
//      left to chance: GL globally (it covers the most cores) once the box renders
//      GL on the GPU at all, and a per-core override from the core's own
//      `required_hw_api` for the ones GL cannot serve. Whether GL reaches the GPU
//      is a session-level matter, not RetroArch's: see hardwareGl() below.
//   2. where the games are. RetroArch's file browser is pointed at the box's own
//      roms folder so "Load Content" opens somewhere useful on a TV.
//   3. how games and consoles GET there. `roms` uploads files into roms/<system>/
//      (lib/roms.js), `share` points the box at an SMB server so several boxes can
//      read one library (lib/share.js), `cores` installs the emulators themselves
//      (lib/cores.js) - RetroArch's own Core Downloader cannot fetch anything in
//      this build, so its menu is hidden - and `art` fetches the games' covers
//      (lib/art.js), which the same dead Online Updater would otherwise be
//      responsible for. Each is a phone form AND, where a remote can drive it
//      (consoles, covers), a screen in the app: the same handlers serve both, so the
//      two can never answer differently. File upload and share credentials stay
//      phone-only - a file picker and a password are miserable on a remote.
//   4. the covers themselves, in the background: a pass over the playlists runs
//      while the box is idle, so a freshly scanned console fills in without anyone
//      asking (lib/art.js does the work; the phone page is for watching it).
//
// Settings are MERGED into RetroArch's own retroarch.cfg, never overwritten:
// RetroArch saves its config on exit, so anything the user changes in its menus
// has to survive. Only the keys above are re-asserted, and only while RetroArch
// is not running (this runs at shell boot, or right after the app is installed).
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const roms = require("./lib/roms");
const share = require("./lib/share"); // optional SMB game library shared by several boxes
const cores = require("./lib/cores"); // the box installs and updates libretro cores itself
const art = require("./lib/art"); // boxart for the playlists, fetched by the box
const games = require("./lib/games"); // the game list the app's own grid renders, and which core plays what
const pads = require("./lib/pads"); // where a pad's Guide button sits, per device
const autoconfig = require("./lib/autoconfig"); // our own controller-profile dir, mirrored from the flatpak's
const scan = require("./lib/scan"); // finding the games: RetroArch's own scanner, plus what it drops

const FLATPAK_REF = "org.libretro.RetroArch";
// RetroArch's flatpak keeps its config under the standard per-app data dir.
const CFG_DIR = path.join(os.homedir(), ".var", "app", FLATPAK_REF, "config", "retroarch");
const CFG_FILE = path.join(CFG_DIR, "retroarch.cfg");
// One chunk of an upload, base64 in a JSON body, plus room for the envelope.
const CHUNK_MAX_BODY = 8e6;

const STR = {
  hu: {
    title: "tvbox - Játékok feltöltése",
    hint: "Válaszd ki a játékfájlokat. A konzolt a kiterjesztésből felismeri, de át tudod állítani.",
    system: "Konzol",
    other: "Egyéb",
    pick: "Fájlok kiválasztása",
    uploading: "Feltöltés",
    done: "Kész, a TV-n zárd be.",
    failed: "Néhány fájl nem töltődött fel",
    current: "A boxon lévő játékok",
    empty: "Még nincs feltöltött játék.",
    del: "Törlés",
    delConfirm: "Törlöd ezt a játékot?",
    unfinished: "befejezetlen",
    delAll: "Összes törlése",
    delAllConfirm: "Töröljön a box {n} játékot a(z) {sys} mappából? Ez nem visszavonható.",
    deleted: "{n} játék törölve.",
  },
  en: {
    title: "tvbox - Upload games",
    hint: "Pick your game files. The console is detected from the extension, but you can change it.",
    system: "Console",
    other: "Other",
    pick: "Choose files",
    uploading: "Uploading",
    done: "Done, close on the TV.",
    failed: "Some files did not upload",
    current: "Games on the box",
    empty: "No games uploaded yet.",
    del: "Delete",
    delConfirm: "Delete this game?",
    unfinished: "unfinished",
    delAll: "Delete all",
    delAllConfirm: "Delete {n} games from {sys}? This cannot be undone.",
    deleted: "{n} games deleted.",
  },
};

// Strings for the network-share form. Kept apart from the upload page's table so
// each page's copy stands on its own.
const SHARE_STR = {
  hu: {
    title: "tvbox - Hálózati megosztás",
    hint: "A játékok maradhatnak a NAS-on, a box onnan olvassa őket, és több box is ugyanezt a megosztást használhatja. SMB kell hozzá: NFS-t csak rendszergazdaként lehet csatolni, amit a box szándékosan nem tesz.",
    host: "Kiszolgáló (IP vagy név)",
    share: "Megosztás neve",
    user: "Felhasználó",
    pass: "Jelszó",
    passKeep: "változatlan",
    folder: "Mappa neve a játékok között",
    advNote: "Ezen a néven jelenik meg a RetroArch fájlböngészőjében.",
    testBtn: "Kapcsolat tesztelése",
    saveBtn: "Mentés és csatolás",
    clearBtn: "Megosztás törlése",
    testing: "Tesztelés...",
    testOk: "Sikeres kapcsolat.",
    saving: "Mentés...",
    saved: "Elmentve, a csatolás folyamatban.",
    cleared: "Törölve.",
    clearConfirm: "Törlöd a hálózati megosztás beállítását?",
    mounted: "Csatolva",
    notMounted: "Nincs csatolva",
    notConfigured: "Még nincs beállítva.",
    errPrefix: "Hiba:",
    errFailed: "Nem sikerült.",
    errNetwork: "Nem érem el a boxot. Ugyanazon a wifin vagy?",
    badHost: "Hibás kiszolgálónév.",
    badShare: "Hibás megosztásnév.",
    badFolder: "A mappanév csak kisbetű, szám és kötőjel lehet.",
    badUser: "Túl hosszú felhasználónév.",
    pickShare: "Válaszd ki a megosztást:",
    domain: "Tartomány (domain, opcionális)",
    domainHint: "csak tartományi fiókhoz",
    passCleared: "nincs mentve",
    pathLabel: "Alútvonal a megosztáson (opcionális)",
    pathPlaceholder: "Emulators/roms",
    pathNote: "Ha üresen hagyod, a megosztás gyökere csatolódik. A gombokkal le tudsz lépni a mappákba.",
    pickFolder: "Válassz mappát, vagy mentsd el itt:",
    emptyHere: "Itt nincs mappa. Ha ez a jó hely, nyomj Mentést.",
    up: ".. vissza",
    mountedOk: "Csatolva, a játékok megjelentek a boxon.",
    mountFailed: "Nem sikerült csatolni. Ellenőrizd a jelszót és az útvonalat.",
    badPath: "Hibás alútvonal.",
    rcloneMissing: "Az rclone nincs telepítve. Nyisd meg a RetroArch csempét egyszer, hogy a box letöltse.",
  },
  en: {
    title: "tvbox - Network share",
    hint: "Games can stay on the NAS and the box reads them from there, so several boxes can use the same share. This needs SMB: mounting NFS requires root, which the box deliberately never uses.",
    host: "Server (IP or name)",
    share: "Share name",
    user: "Username",
    pass: "Password",
    passKeep: "unchanged",
    folder: "Folder name among the games",
    advNote: "This is the name it appears under in RetroArch's file browser.",
    testBtn: "Test connection",
    saveBtn: "Save and mount",
    clearBtn: "Remove share",
    testing: "Testing...",
    testOk: "Connected.",
    saving: "Saving...",
    saved: "Saved, mounting now.",
    cleared: "Removed.",
    clearConfirm: "Remove the network share settings?",
    mounted: "Mounted",
    notMounted: "Not mounted",
    notConfigured: "Not set up yet.",
    errPrefix: "Error:",
    errFailed: "That did not work.",
    errNetwork: "Cannot reach the box. Are you on the same wifi?",
    badHost: "That server name is not valid.",
    badShare: "That share name is not valid.",
    badFolder: "The folder name may use lower-case letters, digits and dashes.",
    badUser: "That username is too long.",
    pickShare: "Pick a share:",
    domain: "Domain (optional)",
    domainHint: "only for a domain account",
    passCleared: "none saved",
    pathLabel: "Sub-folder in the share (optional)",
    pathPlaceholder: "Emulators/roms",
    pathNote: "Leave it empty to mount the share's root. Use the buttons to step into folders.",
    pickFolder: "Pick a folder, or save at this level:",
    emptyHere: "No folders here. If this is the right place, press Save.",
    up: ".. back",
    mountedOk: "Mounted, the games are on the box.",
    mountFailed: "Could not mount. Check the password and the path.",
    badPath: "That sub-folder path is not valid.",
    rcloneMissing: "rclone is not installed. Open the RetroArch tile once so the box downloads it.",
  },
};

// Strings for the console (core) page. The box installs cores itself, so this is
// where a console is added, updated or removed.
const CORES_STR = {
  hu: {
    title: "tvbox - Konzolok",
    hint: "Írd be, mit keresel, vagy nézd végig a listát. A box letölti a kiválasztott emulátort és ellenőrzi is, plusz jelzi, ha újabb build jelent meg. Nem minden emulátor fut jól ezen a hardveren.",
    offline: "A core-lista most nem elérhető, ezért a frissítések nem látszanak. A telepítés is hálózatot igényel.",
    installBtn: "Telepítés",
    updateBtn: "Frissítés",
    removeBtn: "Törlés",
    installedTag: "telepítve",
    updatableTag: "frissíthető",
    updateAll: "Mind a {n} frissítése",
    working: "Folyamatban:",
    doneOne: "{name} kész.",
    doneMany: "{n} core frissítve.",
    removeConfirm: "Törlöd a(z) {name} emulátorát?",
    newBuild: "build: {date}",
    errPrefix: "Hiba:",
    errFailed: "Nem sikerült.",
    errNetwork: "Nem érem el a boxot. Ugyanazon a wifin vagy?",
    errBadCore: "Ismeretlen core.",
    errDownload: "A letöltés nem sikerült. Van hálózat a boxon?",
    errArchive: "A letöltött csomag hibás.",
    errUnsafeArchive: "A csomag olyan helyre írna, ahova nem szabad. Nem csomagoltuk ki.",
    errUnpack: "A rendszerfájlokat nem sikerült kicsomagolni.",
    errCrc: "A letöltött fájl ellenőrzőösszege nem egyezik, ezért nem telepítettem.",
    errWrite: "Nem sikerült a helyére írni.",
    errRemove: "Nem sikerült törölni.",
    errNoIndex: "A core-lista nem elérhető, ezért nem tudok telepíteni. Van hálózat a boxon?",
    errNotPublished: "Ezt az emulátort a libretro már nem kínálja letöltésre.",
    searchPlaceholder: "Keresés (pl. ps2, sony, snes)",
    counting: "{shown} / {total} emulátor",
    nothingFound: "Nincs találat.",
    notPublishedTag: "már nem kínált",
  },
  en: {
    title: "tvbox - Consoles",
    hint: "Search, or scroll the list. The box downloads the emulator you pick and verifies it, and tells you when a newer build appears. Not every emulator runs well on this hardware.",
    offline: "The core list is unreachable right now, so updates are not shown. Installing also needs the network.",
    installBtn: "Install",
    updateBtn: "Update",
    removeBtn: "Remove",
    installedTag: "installed",
    updatableTag: "update",
    updateAll: "Update all {n}",
    working: "Working:",
    doneOne: "{name} done.",
    doneMany: "{n} cores updated.",
    removeConfirm: "Remove the emulator for {name}?",
    newBuild: "build: {date}",
    errPrefix: "Error:",
    errFailed: "That did not work.",
    errNetwork: "Cannot reach the box. Are you on the same wifi?",
    errBadCore: "Unknown core.",
    errDownload: "The download failed. Does the box have network?",
    errArchive: "The downloaded archive is broken.",
    errUnsafeArchive: "The archive wanted to write outside its own folder, so it was not unpacked.",
    errUnpack: "The system files could not be unpacked.",
    errCrc: "The downloaded file's checksum did not match, so it was not installed.",
    errWrite: "Could not write it into place.",
    errRemove: "Could not remove it.",
    errNoIndex: "The core list is unreachable, so nothing can be installed. Does the box have network?",
    errNotPublished: "libretro no longer offers this emulator for download.",
    searchPlaceholder: "Search (e.g. ps2, sony, snes)",
    counting: "{shown} of {total} emulators",
    nothingFound: "Nothing matches.",
    notPublishedTag: "no longer offered",
  },
};

// Strings for the artwork page. The box fetches the covers itself in the
// background, so this page is mostly a report: which console has how many, and a
// button for "do it now" when someone does not want to wait for an idle moment.
const ART_STR = {
  hu: {
    title: "tvbox - Borítók",
    hint: "A RetroArch csak a beolvasott listákban lévő játékoknak tud borítót mutatni, magától viszont nem tölti le őket. A box ezt megteszi: átnézi a listákat, és amihez van kép, azt a helyére teszi. Magától is fut, amikor a box épp nem dolgozik.",
    startBtn: "Hiányzók letöltése",
    stopBtn: "Leállítás",
    idle: "Minden borító megvan.",
    summary: "{have} / {total} játéknak van borítója",
    missingNote: "{n} hiányzik",
    unavailableNote: "{n} játékhoz nincs kép a szerveren",
    working: "Letöltés: {system}",
    workingCount: "{done} / {todo}",
    listing: "Lista kérése: {system}",
    savedNote: "{n} kép letöltve.",
    offline: "Nincs hálózat a boxon, ezért most nem tudok képeket letölteni.",
    stopped: "Leállítva. A már letöltött képek megmaradnak.",
    noGames: "Még nincs beolvasott játéklista. A RetroArch-ban a játékok beolvasása után lesz mit ide tenni.",
    done: "kész",
    errNetwork: "Nem érem el a boxot. Ugyanazon a wifin vagy?",
  },
  en: {
    title: "tvbox - Artwork",
    hint: "RetroArch can only show a cover for games in a scanned list, and it does not fetch them by itself. The box does: it walks the lists and puts a cover in place wherever one exists. It also runs on its own whenever the box is not busy.",
    startBtn: "Download missing",
    stopBtn: "Stop",
    idle: "Every cover is in place.",
    summary: "{have} of {total} games have a cover",
    missingNote: "{n} missing",
    unavailableNote: "no cover exists for {n} games",
    working: "Downloading: {system}",
    workingCount: "{done} of {todo}",
    listing: "Listing: {system}",
    savedNote: "{n} covers downloaded.",
    offline: "The box has no network, so nothing can be downloaded right now.",
    stopped: "Stopped. What was downloaded stays.",
    noGames: "No game list has been scanned yet. Scan your games in RetroArch and there will be something to fetch.",
    done: "done",
    errNetwork: "Cannot reach the box. Are you on the same wifi?",
  },
};

// Settings this plugin insists on. Everything else in retroarch.cfg is the
// user's (or RetroArch's) business.
// Whether OpenGL reaches the GPU on this box, which is not a given: the Pi renders
// on v3d and scans out on vc4, and unless the compositor advertises the RENDER node
// a flatpak's Mesa finds no driver and silently uses llvmpipe. The shell settles
// that at session start (its labwc environment file); until a box has that, Vulkan
// is the faster global default even though it locks GL-only cores out.
function hardwareGl() {
  try {
    const f = path.join(os.homedir(), ".config", "labwc", "environment");
    return /^\s*WLR_RENDER_DRM_DEVICE=\S/m.test(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return false;
  }
}

function requiredSettings() {
  return {
    // GL covers far more cores (and every software one), so it is the default as
    // soon as it is real; cores that need something else get a per-core override
    // from their own metadata (lib/cores.js).
    video_driver: hardwareGl() ? "gl" : "vulkan",
    audio_driver: "pulse",
    rgui_browser_directory: roms.ROMS_DIR,
    video_fullscreen: "true",
    // Where RetroArch's OWN bundled content lives. It ships menu icons, gamepad
    // autoconfig profiles, core info and the content database inside the flatpak,
    // but a retroarch.cfg it generates from scratch points all four at user
    // directories under ~/.var that nothing ever fills. On a fresh box that reads
    // as three separate faults and none of them look like a path: the menu draws
    // black squares where the icons should be, the UI is missing its furniture,
    // and a plugged-in controller logs "not configured" - no profile matched, so
    // no button is mapped and NOTHING drives the interface, pad or remote.
    // /app is the flatpak's own prefix, so it is stable for as long as this app
    // is a flatpak (requires.flatpak in the manifest) - and if RetroArch is ever
    // run some other way, these are the paths that have to move with it.
    assets_directory: "/app/share/libretro/assets/",
    // Controller profiles come from OUR directory, which mirrors the flatpak's as
    // symlinks and holds a corrected copy of any profile whose menu-toggle button is
    // wrong for the device it matches (lib/autoconfig.js, lib/pads.js). The flatpak's
    // own directory is read-only, so nothing could be corrected there - and
    // RetroArch's "Save Controller Profile" could not write there either.
    joypad_autoconfig_dir: autoconfig.DIR,
    libretro_info_path: "/app/share/libretro/info",
    content_database_path: "/app/share/libretro/database/rdb",
    // RetroArch's own Online Updater is hidden, because in this build it does not
    // work and cannot be made to: opening the Core Downloader starts no network
    // request at all (nothing appears in its log), and setting the buildbot URL,
    // which this build does not compile in, changes nothing. A menu entry that can
    // only ever answer "failed to retrieve core list" is worse than no entry, so
    // consoles are added from the box instead (lib/cores.js).
    menu_show_online_updater: "false",
    // The Core Downloader has its own switch and is the same dead machinery, so it
    // goes too - otherwise the one route into it that is left still answers
    // "failed to retrieve core list".
    menu_show_core_updater: "false",
    // Nothing on this box can play a disc, so the two entries that ask for one are
    // dead ends on a TV.
    menu_show_load_disc: "false",
    menu_show_dump_disc: "false",
    // The pictures/music/videos tabs are RetroArch's own media player, pointed at
    // its own empty folders - and they sit in the sidebar ABOVE the consoles. The
    // box plays media itself, so hiding them is what puts the games first.
    content_show_images: "false",
    content_show_music: "false",
    content_show_video: "false",
    // Explore is a second way to the same games, built by indexing the whole
    // library on a Pi. The playlists are the fast one.
    content_show_explore: "false",
    // Show the boxart the box downloads (lib/art.js). 3 is RetroArch's own value
    // for "Boxarts" as the main thumbnail.
    menu_thumbnails: "3",
    // The Guide button opens RetroArch's Quick Menu mid-game - resume, save states,
    // close content - and RetroArch pauses the game while it is up, which is the only
    // in-game affordance a pad has here. Which BUTTON that is cannot be one value:
    // the index depends on the key set the pad's kernel driver reports (8 on a pad
    // reporting the eleven keys an Xbox layout has, 12 on one reporting the full
    // gamepad set - see lib/pads.js), so it is set per device, in that device's
    // autoconfig profile (lib/autoconfig.js).
    //
    // This key must therefore stay UNSET: measured on this box, a concrete value here
    // overrides EVERY profile's bind, so setting it to any one index breaks the menu
    // button on every pad that does not happen to match it. "nul" is written rather
    // than left alone because that is what clears a value already in the file.
    input_menu_toggle_btn: "nul",
    // Closing the content ends RetroArch, which is what puts the games grid back on
    // screen: the shell brings the app's own window back when the process exits.
    // "1" is RetroArch's "only when content came from the command line", and every
    // game the grid starts does - so opening RetroArch's own UI by hand still
    // behaves the way it always did.
    quit_on_close_content: "1",
  };
}

// RetroArch's config is a flat `key = "value"` file. Rewrite the keys we own and
// append the ones that aren't there yet, leaving every other line untouched
// (comments and unknown keys included) so a user's own settings are preserved.
function mergeConfig(text, settings) {
  const lines = text ? text.split("\n") : [];
  const remaining = { ...settings };
  const out = lines.map((line) => {
    const m = /^(\s*)([A-Za-z0-9_]+)(\s*=\s*)/.exec(line);
    if (!m) return line;
    const key = m[2];
    if (!(key in remaining)) return line;
    const value = remaining[key];
    delete remaining[key];
    return m[1] + key + ' = "' + value + '"';
  });
  for (const [key, value] of Object.entries(remaining)) out.push(key + ' = "' + value + '"');
  return out.join("\n").replace(/\n*$/, "\n");
}

function renderTemplate(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars && vars[k] != null ? String(vars[k]) : "";
    return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  });
}

module.exports = (host) => {
  function applyConfig() {
    fs.mkdirSync(roms.ROMS_DIR, { recursive: true });
    fs.mkdirSync(CFG_DIR, { recursive: true });
    let text = "";
    try {
      text = fs.readFileSync(CFG_FILE, "utf8");
    } catch (e) {
      // No config yet: RetroArch has never been started. Writing a partial file
      // is fine, it fills in the rest of its defaults on first run.
    }
    const merged = mergeConfig(text, requiredSettings());
    if (merged === text) return false;
    fs.writeFileSync(CFG_FILE, merged);
    return true;
  }

  // ---- network share ----
  // The mount runs under the shell's service supervisor rather than rclone's own
  // --daemon: a share that goes away with the network then comes back on its own
  // (capped backoff), and the shell owns the process so a shell restart cannot
  // leave an orphaned mount behind.
  const SHARE_SVC = "retroarch-share";
  function mountShare() {
    const cfg = share.readConfig();
    if (!cfg) return false;
    if (!rcloneInstalled()) {
      host.log("retroarch: network share configured but rclone is missing");
      return false;
    }
    share.unmount(cfg); // clear a stale FUSE mount from an unclean shutdown
    share.ensureMountPoint(cfg);
    host.spawnService(SHARE_SVC, {
      argv: () => {
        const live = share.readConfig() || cfg; // pick up an edit without re-registering
        return ["rclone", ...share.mountArgs(live)];
      },
      env: share.envFor(cfg, host.childEnv()),
      minUptimeMs: 8000, // a mount that dies inside 8s is a failure, not a normal exit
      log: (m) => host.log("share:", m),
    });
    return true;
  }
  function unmountShare() {
    const cfg = share.readConfig();
    host.stopService(SHARE_SVC);
    if (cfg) share.unmount(cfg);
  }
  // rclone lives in ~/.tvbox/bin (the app's own no-root download), which the shell
  // has already put on PATH; this only reports whether the install has happened.
  function rcloneInstalled() {
    return (process.env.PATH || "").split(path.delimiter).some((d) => {
      try {
        fs.accessSync(path.join(d, "rclone"), fs.constants.X_OK);
        return true;
      } catch (e) {
        return false;
      }
    });
  }

  // ---- artwork ----
  // A pass fetches the covers the playlists are missing (lib/art.js). It runs by
  // itself as well as on demand, because a console scanned in RetroArch should
  // simply have pictures by the time anyone looks at it again.
  //
  // Idleness is what it waits for: a full library is a few hundred megabytes over
  // the same link a game on the network share is being read through. `host.idle` is
  // shell 1.6+; on an older shell the pass just runs, since the alternative - never
  // running unless someone finds the phone page - is a box with no covers and
  // nothing saying why.
  const ART_FIRST_MS = 90000; // let the box finish coming up before touching the network
  const ART_EVERY_MS = 30 * 60 * 1000;
  const boxIdle = () => (typeof host.idle === "function" ? host.idle() : true);
  let artKick = null;
  let artTimer = null;
  let artRunning = false;
  let artStop = false;
  let artProgress = { running: false, system: null, listing: false, done: 0, todo: 0, saved: 0, failed: 0 };

  function startArtSweep(force) {
    if (artRunning) return false;
    artRunning = true;
    artStop = false;
    artProgress = {
      ...artProgress,
      running: true,
      saved: 0,
      failed: 0,
      unavailable: 0,
      offline: false,
      stopped: false,
    };
    art
      .sweep({
        env: host.childEnv(),
        force,
        idle: boxIdle,
        stopped: () => artStop,
        log: (m) => host.log("retroarch: " + m),
        // `listing` is only ever sent as true, so it is cleared on every update
        // rather than left to linger through the download that follows.
        onProgress: (p) => {
          artProgress = { ...artProgress, listing: false, ...p, running: true };
        },
      })
      .then((r) => {
        if (r.saved || r.failed)
          host.log(
            "retroarch: artwork: " +
              r.saved +
              " downloaded, " +
              r.failed +
              " failed" +
              (r.unavailable ? ", " + r.unavailable + " with no cover upstream" : ""),
          );
        artProgress = { ...artProgress, ...r, running: false, listing: false, system: null };
      })
      .catch((e) => {
        host.log("retroarch: artwork pass failed:", String((e && e.message) || e));
        artProgress = { ...artProgress, running: false, listing: false, system: null };
      })
      .finally(() => {
        artRunning = false;
      });
    return true;
  }

  const routes = {
    // What the box knows about the retro setup: enough for a settings screen to
    // say "no consoles added yet" or "no games found" instead of sending the user
    // into an empty RetroArch.
    "GET /state": (req, res) =>
      host.json(res, {
        romsDir: roms.ROMS_DIR,
        roms: roms.count(),
        library: roms.list(),
        share: share.status(share.readConfig()),
        rclone: rcloneInstalled(),
        cores: cores.installed(), // what is on disk, without a network call
        art: art.status(), // per console: how many games have a cover
      }),
  };

  // ---- scanning a folder for games ----
  // A scan is minutes long on a network share (RetroArch hashes every file), so it runs
  // as a background job with progress, like the artwork sweep - and only one at a time.
  let scanning = null; // { folder, system, stage, ... } while a scan runs
  let scanChild = null; // RetroArch's own scanner process, so a launch can end it
  let scanResult = null; // what the last one did, for the screen to show afterwards

  function stopScan() {
    if (!scanning) return false;
    scanning = { ...scanning, stopping: true };
    if (scanChild) {
      try {
        scanChild.kill("SIGTERM");
      } catch (e) {
        /* already gone */
      }
    }
    return true;
  }

  // The inspection walks a folder and reads every playlist, synchronously, and
  // this code runs in the shell's Electron MAIN process - so doing it here would
  // freeze the UI for as long as the walk takes, on every folder the cursor lands
  // on. Electron's own binary as Node (ELECTRON_RUN_AS_NODE), the way the shell
  // runs its CLI out of process for the same reason.
  const INSPECT_TIMEOUT_MS = 60000;
  function inspectOutOfProcess(folder) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "lib", "inspect-cli.js"), String(folder || "")], {
        env: { ...host.childEnv(), ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(arg);
      };
      // A share that has gone away can block the walk indefinitely; a folder the
      // user has already moved off must not hold a process for ever.
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (e) {
          /* already gone */
        }
        finish(reject, new Error("timeout"));
      }, INSPECT_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.on("error", (e) => finish(reject, e));
      child.on("close", () => {
        try {
          finish(resolve, JSON.parse(out));
        } catch (e) {
          finish(reject, e);
        }
      });
    });
  }

  function startScan(folder, system) {
    if (scanning) return { ok: false, error: "busy" };
    const dir = scan.resolveFolder(folder);
    if (!dir) return { ok: false, error: "bad_folder" };
    // Two RetroArch processes on one box fight over config and controllers, so a scan
    // waits for the game to end rather than starting underneath it.
    if (host.nativeRunning && host.nativeRunning() === "retroarch") return { ok: false, error: "playing" };
    scanning = { folder: dir, system: system || null, stage: "retroarch", matched: 0 };
    scanResult = null;
    scan
      .scan(dir, {
        system: system || "",
        env: host.childEnv(),
        onChild: (child) => {
          scanChild = child;
        },
        stopped: () => !!(scanning && scanning.stopping),
        onProgress: (p) => {
          scanning = { ...scanning, ...p };
        },
      })
      .then((r) => {
        scanResult = r;
        if (r.ok)
          host.log(
            "retroarch: scan of " +
              path.basename(dir) +
              (r.stopped ? " STOPPED after " : ": ") +
              (r.matched || 0) +
              " recognised, " +
              (r.added || 0) +
              " added" +
              (r.skipped ? ", " + r.skipped + " need a console" : ""),
          );
        else host.log("retroarch: scan failed:", r.error || "?");
      })
      .catch((e) => {
        scanResult = { ok: false, error: "failed", detail: String((e && e.message) || e) };
        host.log("retroarch: scan threw:", String((e && e.message) || e));
      })
      .finally(() => {
        scanning = null;
        scanChild = null;
      });
    return { ok: true, started: true };
  }

  // ---- controller profiles ----
  // Mirror the flatpak's profiles into a directory of ours and correct the
  // menu-toggle button for whatever pad is connected. Cheap and idempotent (the
  // mirror is rebuilt only when the flatpak moves, a correction written only when
  // the value differs), so it can run at boot AND before every launch.
  function applyPadProfiles() {
    try {
      return autoconfig.fixMenuToggle(pads.pads(), (m) => host.log("retroarch: " + m));
    } catch (e) {
      // A pad we cannot read is not a reason to refuse a game: without a correction
      // the Guide button is what it was before, and everything else still works.
      host.log("retroarch: controller profiles:", String((e && e.message) || e));
      return [];
    }
  }

  // ---- the app's own UI: the game list, its covers, and starting a game ----
  //
  // The launch is the reason this is a route at all. Only the shell may spawn the
  // emulator, and only the plugin can be trusted with a path: the UI sends a console
  // and an INDEX, and the ROM and core are resolved here from RetroArch's own
  // playlist (lib/games.js), so nothing the renderer says ever reaches a command
  // line.
  const gameRoutes = {
    "GET /systems": (req, res, ctx) =>
      ctx.json(res, {
        systems: games.systems(),
        playing: host.nativeRunning ? host.nativeRunning() === "retroarch" : false,
      }),
    "GET /games": (req, res, ctx) => {
      const system = String(new URL(req.url, "http://x").searchParams.get("system") || "");
      ctx.json(res, { system, games: games.list(system) });
    },
    // One cover, straight off the disk lib/art.js filled. Cached hard: a tile's image
    // never changes under a given index, and a grid asks for dozens at once.
    //
    // STREAMED, not read: a plugin runs in the shell's own Electron main process, and a
    // cover is a few hundred kB - reading dozens of them synchronously would block the
    // process that draws the UI and answers every other route.
    "GET /cover": (req, res) => {
      const q = new URL(req.url, "http://x").searchParams;
      const file = games.coverFile(String(q.get("system") || ""), q.get("i"));
      if (!file) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      const png = fs.createReadStream(file);
      // The header is already out by the time a read can fail (the file was there a
      // moment ago), so a truncated response is all there is to give.
      png.on("error", () => res.end());
      png.pipe(res);
    },
    "POST /play": (req, res, ctx) => {
      const body = ctx.body || {};
      const spec = games.launchSpec(String(body.system || ""), body.i);
      if (spec.error) return ctx.json(res, { ok: false, error: spec.error, rom: spec.rom || null });
      if (!host.launchNative) return ctx.json(res, { ok: false, error: "shell_too_old" });
      // A scan runs RetroArch too, and two of them on one box fight over the config and
      // the controllers - so the game wins and the scan is ended. A scan is re-runnable
      // and writes as it goes, so nothing is lost by stopping it here.
      if (scanning) {
        stopScan();
        host.log("retroarch: scan stopped - a game is starting");
      }
      // A pad that connected since boot needs its profile corrected before RetroArch
      // reads it, and this is the last moment we own: a launch is the one point where
      // the set of connected pads is known and RetroArch is not running yet.
      applyPadProfiles();
      // --fullscreen comes from the manifest; the core and the ROM are this launch.
      const ok = host.launchNative("retroarch", ["-L", spec.corePath, spec.rom]);
      if (ok) host.log("retroarch: play", spec.core, "-", spec.label);
      else host.log("retroarch: launch refused for", spec.label);
      ctx.json(res, { ok, core: spec.core, label: spec.label });
    },
    // The folders a scan can be pointed at, and what one would find in the one being
    // looked at. The inspection walks the folder, so it is per request rather than part
    // of the list - over a network share that walk is the expensive part.
    "GET /scan-folders": (req, res, ctx) =>
      ctx.json(res, { romsDir: roms.ROMS_DIR, folders: scan.folders(), consoles: scan.consoles() }),
    "GET /scan-inspect": (req, res, ctx) => {
      const folder = new URL(req.url, "http://x").searchParams.get("folder") || "";
      inspectOutOfProcess(folder)
        .then((r) => ctx.json(res, r))
        .catch(() => ctx.json(res, { folder: "", error: "inspect_failed", games: 0, already: 0, ambiguous: 0, systems: [] }));
    },
    "GET /scan": (req, res, ctx) => ctx.json(res, { running: !!scanning, progress: scanning, last: scanResult }),
    "POST /scan-start": (req, res, ctx) => {
      const body = ctx.body || {};
      ctx.json(res, startScan(String(body.folder || ""), String(body.system || "")));
    },
    "POST /scan-stop": (req, res, ctx) => ctx.json(res, { ok: stopScan() }),
    // Which emulator a console uses, when more than one is installed for it. `core`
    // null clears the choice and goes back to what the metadata picks.
    "POST /system-core": (req, res, ctx) => {
      const body = ctx.body || {};
      const core = body.core === null || body.core === "" ? null : String(body.core);
      ctx.json(res, { ok: games.writeOverride(String(body.system || ""), core) });
    },
  };

  const romsPage = fs.readFileSync(path.join(__dirname, "pairing", "roms.html"), "utf8");
  const sharePage = fs.readFileSync(path.join(__dirname, "pairing", "share.html"), "utf8");
  const coresPage = fs.readFileSync(path.join(__dirname, "pairing", "cores.html"), "utf8");
  const artPage = fs.readFileSync(path.join(__dirname, "pairing", "art.html"), "utf8");

  // The share form's own routes. Saving remounts, so a corrected password takes
  // effect without the user going anywhere else.
  const shareRoutes = {
    "GET /share-status": (req, res, ctx) => ctx.json(res, share.status(share.readConfig())),
    "POST /share-test": (req, res, ctx) => {
      const body = ctx.body || {};
      if (!rcloneInstalled()) return ctx.json(res, { ok: false, error: "rclone_missing" });
      // No share name yet: list what the server offers instead of failing. A NAS
      // does not necessarily name its SMB shares the way it names anything else,
      // so guessing is worse than asking the server.
      if (!String(body.share || "").trim()) {
        return share.listShares(body, host.childEnv()).then((r) => ctx.json(res, r));
      }
      let cfg;
      try {
        cfg = share.configFrom(body);
      } catch (e) {
        return ctx.json(res, { ok: false, error: e.message });
      }
      share.test(cfg, host.childEnv()).then((r) => ctx.json(res, r));
    },
    "POST /share-save": (req, res, ctx) => {
      // Saving obscures the password with rclone, so without the binary this would
      // throw an opaque ENOENT instead of the message /share-test already gives.
      if (!rcloneInstalled()) return ctx.json(res, { ok: false, error: "rclone_missing" });
      let cfg;
      try {
        cfg = share.configFrom(ctx.body || {});
      } catch (e) {
        return ctx.json(res, { ok: false, error: e.message });
      }
      // A changed folder name leaves the old mount behind otherwise.
      unmountShare();
      share.writeConfig(cfg);
      const mounted = mountShare();
      ctx.json(res, { ok: true, mounting: mounted });
    },
    "POST /share-clear": (req, res, ctx) => {
      unmountShare();
      ctx.json(res, { ok: share.clearConfig() });
    },
  };

  // The consoles page. Installing reaches the network, so every handler is async
  // and reports a short error code the page turns into a sentence.
  const coresRoutes = {
    "GET /cores": (req, res, ctx) =>
      cores
        .fetchIndex(host.childEnv())
        .then((index) => ctx.json(res, { offline: index === null, cores: cores.list(index) })),
    "POST /core-install": (req, res, ctx) => {
      const core = String((ctx.body || {}).core || "");
      cores
        .fetchIndex(host.childEnv())
        .then((index) => cores.install(core, host.childEnv(), index))
        .then((r) => {
          if (r.ok) {
            const a = r.assets || {};
            // Say which of the two things happened, because "installed" alone
            // hides the case that used to strand a core: the binary landed and
            // the files it cannot run without did not.
            host.log(
              "retroarch: core installed:",
              core,
              a.pack ? (a.ok ? "+ system files (" + a.pack + ")" : "BUT system files failed: " + a.error) : "",
            );
            const changed = cores.syncDriverOverrides(requiredSettings().video_driver);
            if (changed.length) host.log("retroarch: per-core driver:", changed.join(", "));
          }
          ctx.json(res, r);
        })
        .catch((e) => {
          // The page has a sentence for every code, so an unexpected throw reports
          // the generic one and the detail goes to the shell log, not to the phone.
          host.log("retroarch: core install failed:", core, String(e.message || e));
          ctx.json(res, { ok: false, error: "failed" });
        });
    },
    "POST /core-remove": (req, res, ctx) => ctx.json(res, cores.remove(String((ctx.body || {}).core || ""))),
  };

  // The artwork page. Starting is `force`: someone asking from the phone means now,
  // idle or not, and even for a console that was listed recently.
  const artRoutes = {
    "GET /art": (req, res, ctx) => ctx.json(res, { systems: art.status(), progress: artProgress }),
    "POST /art-start": (req, res, ctx) => ctx.json(res, { ok: true, started: startArtSweep(true) }),
    "POST /art-stop": (req, res, ctx) => {
      artStop = true;
      ctx.json(res, { ok: true });
    },
  };

  // The same handler, serving both servers. A pairing route gets `json` and `body`
  // on its ctx from the pairing server; the shell's own server passes only `body`,
  // so `json` is filled in here. Registering the tables instead of copying them is
  // what keeps the phone page and the on-screen page from ever drifting apart.
  const onScreen = (table) =>
    Object.fromEntries(
      Object.entries(table).map(([key, fn]) => [
        key,
        (req, res, ctx) => fn(req, res, { json: host.json, ...(ctx || {}) }),
      ]),
    );

  return {
    start() {
      host.registerRoutes("/tvbox/api/retroarch", {
        ...routes,
        ...onScreen(gameRoutes),
        // Consoles and covers are things a remote can drive, so the app has screens
        // for them too - the same routes the phone pages call.
        ...onScreen(coresRoutes),
        ...onScreen(artRoutes),
        ...onScreen({ "GET /share-status": shareRoutes["GET /share-status"] }),
      });
      // Phone upload. The pairing server is only up while the TV shows the code,
      // and every route below it is code-gated by the shell.
      host.pairing.register("roms", {
        page: (ctx) => renderTemplate(romsPage, { lang: ctx.locale, ...(STR[ctx.locale] || STR.en) }),
        routes: {
          "POST /rom-chunk": {
            maxBody: CHUNK_MAX_BODY,
            handler: (req, res, ctx) => ctx.json(res, roms.writeChunk(ctx.body || {})),
          },
          "GET /roms": (req, res, ctx) => ctx.json(res, roms.list()),
          "POST /rom-delete-system": (req, res, ctx) =>
            ctx.json(res, roms.removeSystem(String((ctx.body || {}).system || ""))),
          "POST /rom-delete": (req, res, ctx) =>
            ctx.json(res, {
              ok: roms.remove(String((ctx.body || {}).system || ""), String((ctx.body || {}).name || "")),
            }),
        },
      });
      host.pairing.register("cores", {
        page: (ctx) => renderTemplate(coresPage, { lang: ctx.locale, ...(CORES_STR[ctx.locale] || CORES_STR.en) }),
        routes: coresRoutes,
      });
      host.pairing.register("share", {
        page: (ctx) => renderTemplate(sharePage, { lang: ctx.locale, ...(SHARE_STR[ctx.locale] || SHARE_STR.en) }),
        routes: shareRoutes,
      });
      host.pairing.register("art", {
        page: (ctx) => renderTemplate(artPage, { lang: ctx.locale, ...(ART_STR[ctx.locale] || ART_STR.en) }),
        routes: artRoutes,
      });
      // Before applyConfig, which points RetroArch's joypad_autoconfig_dir at it.
      applyPadProfiles();
      try {
        if (applyConfig())
          host.log(
            "retroarch: settings applied (" +
              requiredSettings().video_driver +
              " video, roms at " +
              roms.ROMS_DIR +
              ")",
          );
      } catch (e) {
        host.log("retroarch: could not write settings:", e.message);
      }
      host.log("retroarch: " + cores.installed().length + " core(s) installed, " + roms.count() + " game(s)");
      // Every installed core gets the driver its own metadata says it needs,
      // relative to the global one above.
      const driver = requiredSettings().video_driver;
      const changed = cores.syncDriverOverrides(driver);
      host.log("retroarch: video driver " + driver + (changed.length ? ", per-core: " + changed.join(", ") : ""));
      // A configured share comes up with the box, so the games are simply there.
      if (share.readConfig()) {
        if (mountShare()) host.log("retroarch: mounting network share at " + share.mountPoint(share.readConfig()));
      }
      // Covers, in the background. A pass over a library that is already complete
      // reads a few directories and makes no network request, so a tick is cheap
      // enough to be regular: what it is really waiting for is a console the user
      // scanned while the box was busy.
      const artTick = () => {
        if (boxIdle()) startArtSweep(false);
      };
      artKick = setTimeout(artTick, ART_FIRST_MS);
      artTimer = setInterval(artTick, ART_EVERY_MS);
    },
    stop() {
      unmountShare();
      artStop = true;
      clearTimeout(artKick);
      clearInterval(artTimer);
      // A scan owns a RetroArch child and writes playlists when it finishes. Left
      // running it would go on doing both on behalf of a plugin that is gone, and
      // a shell restart would come back to a scanner nobody is tracking.
      stopScan();
    },
  };
};

// tvbox RetroArch plugin. RetroArch is a `type: native` app: it runs its own
// full-screen interface and the shell only spawns it (see shell/native.js), so
// this plugin owns no window and no daemon. What it does own is the SETUP that
// RetroArch cannot be expected to get right by itself on this hardware:
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
//   3. how games and consoles GET there. A TV has no file manager, so the plugin
//      registers three phone-pairing kinds: `roms` uploads files into
//      roms/<system>/ (lib/roms.js), `share` points the box at an SMB server so
//      several boxes can read one library (lib/share.js), and `cores` installs the
//      emulators themselves (lib/cores.js) - RetroArch's own Core Downloader cannot
//      fetch anything in this build, so its menu is hidden. All three are forms on
//      a phone rather than screens on the TV, because a native app has no screen of
//      its own here and typing a password with a remote is miserable.
//
// Settings are MERGED into RetroArch's own retroarch.cfg, never overwritten:
// RetroArch saves its config on exit, so anything the user changes in its menus
// has to survive. Only the keys above are re-asserted, and only while RetroArch
// is not running (this runs at shell boot, or right after the app is installed).
const fs = require("fs");
const path = require("path");
const os = require("os");
const roms = require("./lib/roms");
const share = require("./lib/share"); // optional SMB game library shared by several boxes
const cores = require("./lib/cores"); // the box installs and updates libretro cores itself

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
    // RetroArch's own Online Updater is hidden, because in this build it does not
    // work and cannot be made to: opening the Core Downloader starts no network
    // request at all (nothing appears in its log), and setting the buildbot URL,
    // which this build does not compile in, changes nothing. A menu entry that can
    // only ever answer "failed to retrieve core list" is worse than no entry, so
    // consoles are added from the box instead (lib/cores.js).
    menu_show_online_updater: "false",
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
      }),
  };

  const romsPage = fs.readFileSync(path.join(__dirname, "pairing", "roms.html"), "utf8");
  const sharePage = fs.readFileSync(path.join(__dirname, "pairing", "share.html"), "utf8");
  const coresPage = fs.readFileSync(path.join(__dirname, "pairing", "cores.html"), "utf8");

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
            host.log("retroarch: core installed:", core);
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

  return {
    start() {
      host.registerRoutes("/tvbox/api/retroarch", routes);
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
      try {
        if (applyConfig()) host.log("retroarch: settings applied (vulkan video, roms at " + roms.ROMS_DIR + ")");
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
    },
    stop() {
      unmountShare();
    },
  };
};

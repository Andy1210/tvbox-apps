// tvbox Spotify plugin — the whole Spotify subsystem, loaded by the shell only
// when this app package is installed AND its declared binary (librespot)
// resolves. It ships in the app PACKAGE, not the core shell (Kodi model): the
// shell only provides the SDK (`host`), the package brings the implementation.
//
// It owns everything Spotify:
//   • the librespot Connect daemon (via host.spawnService — capped backoff),
//   • the on-box OAuth login window + the phone-as-keyboard DOM injection,
//   • the ~/tvbox/api/spotify/* HTTP routes (cast state SSE + optional Web API),
//   • the cast rising-edge -> "open the Spotify screen" behaviour,
//   • the "spotify" (API keys) and "keyboard" (phone-as-keyboard) phone-pairing
//     kinds — their pages ship in this package (pairing/*.html).
// A box without librespot simply never loads this: no routes, no daemon, no
// respawn loop — the launcher greys the tile from the manifest's deps status.
// librespot is a no-root `requires.download` binary the Spotify app installs
// from the UI (into ~/.tvbox/bin); once present the plugin loads at the next
// boot. Even then the Connect daemon is OPT-IN: it runs only when
// config.spotify.enabled is true (the launcher's enable toggle / first-run
// screen) — presence of the binary alone never makes the box advertise.
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { execFile } = require("child_process");
const spotify = require("./lib/spotify"); // cast-only bridge: librespot events -> SSE state
const spotifyApi = require("./lib/spotify_api"); // OPTIONAL Spotify Web API (account features)
const { createAutoplay } = require("./lib/autoplay"); // what plays when a playlist runs out
const { createCredGuard, isSupervisorExit, isCredentialRejection, authenticatedAs } = require("./lib/credguard"); // what the daemon's own output says
const { createCredVault } = require("./lib/credvault"); // one saved login per linked account

const SPOTIFY_HOOK = path.join(__dirname, "spotify_event_hook.sh"); // librespot --onevent target
// Where librespot keeps the saved session credentials (and the Connect volume).
const LIBRESPOT_CACHE = path.join(os.homedir(), ".tvbox", "librespot-cache");
// The hook arrives over HTTP as plain bytes (installPackage writes 0644), but
// librespot must be able to exec it — ensure it's executable. (installPackage
// also +x's *.sh now; this is defensive so an older install self-heals on boot.)
try {
  fs.chmodSync(SPOTIFY_HOOK, 0o755);
} catch (e) {
  /* not installed yet / read-only — best effort */
}

// HTML-escape an interpolated value so a {{var}} can never inject markup. All
// current values are trusted constants (localized strings + static URIs), but a
// future user-derived var would otherwise be stored/reflected XSS.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
// {{token}} substitution — same contract as the shell's pairing renderPage, but
// reading the page from THIS package (the core PAGES_DIR no longer carries them).
function renderTemplate(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] != null ? escapeHtml(vars[k]) : ""));
}

// Pick 'hu' or 'en' from a request's Accept-Language, the same locale selection
// the pairing pages use (ctx.locale); defaults to 'en' like the rest of this file.
function localeFrom(req) {
  const al = String((req && req.headers && req.headers["accept-language"]) || "").toLowerCase();
  return /\bhu\b/.test(al) ? "hu" : "en";
}

// Phone-pairing page strings. Ported from shell/pairing/spotify.js and
// shell/pairing/keyboard.js so the whole pairing surface ships in this package.
const SPOTIFY_STR = {
  hu: {
    title: "tvbox — Spotify összekötés",
    code: "Kód (a TV-ről)",
    cid: "Client ID",
    secret: "Client Secret",
    hint: "A developer.spotify.com-on létrehozott alkalmazásod adatai. Másold be ide a telefonról.",
    redir: "Átirányítási cím — ezt add hozzá az alkalmazásodhoz",
    copy: "Másolás",
    copied: "Másolva ✓",
    save: "Mentés",
    done: "Kész! A TV-n kösd össze a fiókod.",
    errCode: "Hibás kód",
    err: "Hiba a mentéskor",
    authOk: "✓ Spotify összekötve — térj vissza a TV-hez.",
    authFail: "A Spotify összekötés nem sikerült. Próbáld újra a TV-ről.",
  },
  en: {
    title: "tvbox — Connect Spotify",
    code: "Code (from the TV)",
    cid: "Client ID",
    secret: "Client Secret",
    hint: "From the app you created at developer.spotify.com. Paste them here from your phone.",
    redir: "Redirect URI — add this to your app",
    copy: "Copy",
    copied: "Copied ✓",
    save: "Save",
    done: "Done! Connect your account on the TV.",
    errCode: "Wrong code",
    err: "Failed to save",
    authOk: "✓ Spotify connected — return to the TV.",
    authFail: "Spotify connection failed. Try again from the TV.",
  },
};
const KEYBOARD_STR = {
  hu: {
    title: "tvbox — Spotify bejelentkezés",
    hint: "Töltsd ki, és nyomd meg a Küldést — a TV-n a Spotify űrlapjába kerül. E-mail → Küldés → az e-mailben kapott kód (vagy jelszó) → Küldés.",
    email: "E-mail",
    secret: "Kód (e-mailből) vagy jelszó",
    send: "Küldés",
    enter: "Tovább",
    manual: "Kézi billentyűzet (ha kell)",
    tab: "Tab ↹",
    back: "⌫ Törlés",
    ph: "Kézi gépelés…",
    sent: "Elküldve ✓",
  },
  en: {
    title: "tvbox — Spotify login",
    hint: "Fill in and press Send — it goes into the Spotify form on the TV. Email → Send → the code you get by email (or password) → Send.",
    email: "Email",
    secret: "Code (from email) or password",
    send: "Send",
    enter: "Continue",
    manual: "Manual keyboard (if needed)",
    tab: "Tab ↹",
    back: "⌫ Delete",
    ph: "Type manually…",
    sent: "Sent ✓",
  },
};

// ---- lyrics via LRCLIB (lrclib.net) ----
// Spotify's Web API has NO lyrics endpoint; LRCLIB is a free, no-auth, open lyrics
// DB queried by track metadata (title/artist/album/duration) — which the cast
// state already has, so lyrics work even without a connected account. Returns
// time-synced LRC when available. Results cached per track key.
const lyricsCache = new Map(); // "artist|title|dur" -> { synced, plain, instrumental }
function parseLrc(lrc) {
  const out = [];
  for (const line of String(lrc || "").split("\n")) {
    // [mm:ss.xx] text  (a line may carry multiple timestamps)
    const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();
    const stamps = line.match(/\[(\d+):(\d+(?:\.\d+)?)\]/g) || [];
    for (const s of stamps) {
      const m = /\[(\d+):(\d+(?:\.\d+)?)\]/.exec(s);
      if (m) out.push({ ms: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}
function fetchLrclib(query) {
  return new Promise((resolve) => {
    const req = https.get(
      "https://lrclib.net/api/get?" + query,
      { headers: { "User-Agent": "tvbox (https://github.com/Andy1210/tvbox)" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => req.destroy());
  });
}

// /api/get is an EXACT-match lookup (album + duration participate), so a track
// whose librespot album string differs from LRCLIB's record (single vs
// soundtrack naming, deluxe editions) misses even for very popular songs.
// Fallback: full-text /api/search by track+artist, then pick the closest
// duration (prefer entries that carry synced lyrics).
function searchLrclib(title, artist, durSec) {
  const params = new URLSearchParams({ track_name: title, artist_name: artist });
  return new Promise((resolve) => {
    const req = https.get(
      "https://lrclib.net/api/search?" + params.toString(),
      { headers: { "User-Agent": "tvbox (https://github.com/Andy1210/tvbox)" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let list;
          try {
            list = JSON.parse(d);
          } catch (e) {
            return resolve(null);
          }
          if (!Array.isArray(list) || !list.length) return resolve(null);
          const want = Number(durSec) || 0;
          const score = (e) => (want && Math.abs((e.duration || 0) - want) <= 7 ? 0 : 100) + (e.syncedLyrics ? 0 : 10);
          list.sort((a, b) => score(a) - score(b));
          const best = list[0];
          // a wildly different duration is a different song/version - reject
          if (want && Math.abs((best.duration || 0) - want) > 20) return resolve(null);
          resolve(best);
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => req.destroy());
  });
}

module.exports = (host) => {
  spotify.setConfig(host.config); // read the Connect device name from the shell config store
  spotifyApi.setConfig(host.config); // read the Spotify Web API credentials from the shell config store

  // ---- Spotify Connect (librespot) ----
  // The shell owns librespot directly (like mpv): the device name is just a
  // config value passed as --name, so renaming the box is a config write +
  // respawn — NO root, NO system service, NO sudo at runtime. The binary is the
  // app's own requires.download (installed on demand into ~/.tvbox/bin), so the
  // box runs exactly one Connect device — ours. Supervision (backoff + give-up)
  // is host.spawnService's job.
  let librespotLog = null; // append fd, opened once and reused across respawns
  // Reads the daemon's own output and clears a saved login Spotify has started
  // refusing — the one failure that never recovers on its own, not even across a
  // reboot. Its module header has the incident and the bounds.
  const credGuard = createCredGuard({
    fs,
    path,
    cacheDir: LIBRESPOT_CACHE,
    log: (m) => host.log("librespot " + m),
  });
  // Keeps a copy of every account's saved login beside the live one, so the box
  // can be signed in as the account whose library is on screen instead of as
  // whoever cast to it last. Its module header has the mechanism.
  const credVault = createCredVault({
    fs,
    path,
    cacheDir: LIBRESPOT_CACHE,
    log: (m) => host.log("spotify: " + m),
  });
  // What the daemon has said about signing in, counted so a sign-in can read the
  // DIFFERENCE across its own restart. Two questions need that and no device
  // listing can answer either:
  //   • was the login refused - librespot exits within a second of being told so,
  //     while a listing would have to be waited out;
  //   • which account did it come up as. Spotify goes on listing the registration
  //     of an instance that has died for seconds afterwards, so a listing hit
  //     right after a restart can be about the daemon that is gone.
  let credRefusals = 0;
  let signIns = 0;
  let signedInAs = "";
  // The credentials file was deliberately replaced. Both counts are about the file
  // that WAS there - the guard's strikes and the refusals a sign-in reads - so they
  // move together: a refusal still draining out of the dying daemon's pipe would
  // otherwise count towards the two this login is allowed.
  function credentialsReplaced() {
    credGuard.fileReplaced();
    credRefusals = 0;
  }
  // What makes an event's `user_name` trustworthy. The rest of an event draws a
  // screen, and /tvbox/api/spotify/event has always been reachable by anything
  // served from this box's own origin. The owner is different in kind: it decides
  // which account the TV's buttons act as, so it is honoured only when the event
  // carries the key this process handed to librespot in its environment. Without
  // it the event still renders; it just cannot name an account.
  //
  // What that is worth, exactly: it stops a REMOTE app's renderer and anything in
  // a flatpak sandbox (no host /proc). It does not stop another installed local
  // app package — a manifest `runtime.bridge` gets Node in its own renderer, and
  // SECURITY.md already puts that inside the trust boundary — nor any process
  // running as this user, since both can read the daemon's environment.
  const eventKey = crypto.randomBytes(24).toString("hex");
  let lastKeylessLog = 0;
  function fromOurDaemon(k) {
    const a = Buffer.from(String(k || ""));
    const b = Buffer.from(eventKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  // The Connect device name, as it reaches librespot's argv - and therefore the
  // supervisor's spawn line, which is on the same stream the credential guard
  // reads. A control character in it would end one log record and begin another,
  // which is the one way text somebody chose can be made to look like a line the
  // daemon wrote: the guard's three classifiers all require the daemon's own
  // prefix, and a forged newline is what supplies one. The app's own rename route
  // strips CR and LF, but the shell's generic config route does not, so the strip
  // belongs here - where the value becomes argv - rather than only there.
  function spotifyDeviceName() {
    const raw = String((host.config.rawSpotify() || {}).deviceName || "");
    const clean = raw
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 64);
    return clean || "tvbox";
  }
  function librespotArgv() {
    const args = [
      "librespot",
      "--name",
      spotifyDeviceName(),
      "--device-type",
      "tv",
      "--backend",
      "pulseaudio",
      "--bitrate",
      "320",
      // librespot's softvol defaults to 50% (u16 32767) on a taper, so a fresh
      // Connect device plays much quieter than mpv (which is at unity). Start at
      // full with a linear (predictable: slider % ≈ loudness) taper.
      // NOTE: --initial-volume only applies when NO volume is cached yet — an
      // existing box keeps its last Connect volume in <cache>/volume, so bump it
      // once from the phone (or clear that file) after upgrading.
      "--initial-volume",
      "100",
      "--volume-ctrl",
      "linear",
      "--cache",
      LIBRESPOT_CACHE,
      "--disable-audio-cache", // cache credentials/metadata, not audio
      "--onevent",
      SPOTIFY_HOOK,
    ];
    // Target the detected HDMI sink explicitly (the pulseaudio backend can't
    // resolve "default" here — it errors "PulseAudioSink: No such entity").
    // host.audioSink() is the node.name from audio-default.sh, which pipewire-pulse
    // exposes as the sink name; it's set before start() runs.
    const sink = host.audioSink();
    if (sink) args.push("--device", sink);
    // NO --access-token here, deliberately. librespot accepts one and the AP
    // handshake even succeeds with it ("Authenticated as '<id>'"), but Connect
    // registration a step later is refused - `could not initialize spirc: Invalid
    // state { Login request was denied: INVALID_CREDENTIALS }` - because login5
    // registers a device for Spotify's own client, not for a third-party app's
    // token. The scopes are not the reason: measured refused with `streaming` and
    // `app-remote-control` both present on the token.
    //
    // It is not merely useless but destructive: librespot writes the
    // token-derived credential into <cache>/credentials.json BEFORE that refusal,
    // overwriting the box's working saved login with one that can never register.
    // The next start then fails on the poisoned file, the credential guard moves
    // it aside, and the box is left signed out - discoverable, but in no
    // account's device list, which is the one state only a phone cast can undo.
    // The box signs itself back in from its CACHED credentials instead; see
    // reRegisterBox.
    return args;
  }
  // Spotify Connect is opt-in (config.spotify.enabled): this gate — not the
  // binary's presence — decides whether the box advertises a Connect target.
  // (The plugin only loads at all once librespot is on PATH, installed on
  // demand from the UI; see the header.) Default off.
  function enabled() {
    return !!(host.config.rawSpotify() || {}).enabled;
  }
  function startLibrespot() {
    if (!enabled()) return; // disabled: never spawn the daemon
    if (librespotLog === null) {
      try {
        librespotLog = fs.openSync(path.join(os.homedir(), ".tvbox", "librespot.log"), "a");
      } catch (e) {
        librespotLog = "ignore";
      }
    }
    const out = librespotLog === "ignore" ? "ignore" : librespotLog;
    // librespot writes its ENTIRE log to stderr, so the supervisor's pipe is the
    // only place that log can be read — and reading it is the point. Pointing
    // stderr straight at the file (what this did until 1.5.3) left shell.log with
    // `exited code 1` and nothing else, which reads exactly like a missing binary
    // while the real reason sat in a file nobody thought to open. Everything still
    // reaches ~/.tvbox/librespot.log verbatim; shell.log gets the supervisor's own
    // lines and the daemon's ERRORs, never the per-track INFO chatter.
    const logLine = (m) => {
      // Redact FIRST, for every sink: the supervisor's spawn line carries the
      // whole argv. Nothing here passes a credential on the command line any more
      // - and it must not, because argv is readable from /proc long before it
      // reaches a log - so this is belt and braces against that coming back.
      const line = String(m).replace(/(--access-token)\s+\S+/, "$1 ***");
      if (out !== "ignore") {
        try {
          fs.writeSync(librespotLog, line + "\n");
        } catch (e) {
          /* the log file is a convenience; losing a line must not kill the daemon */
        }
      }
      // A line starting with "[" is the daemon's own (env_logger prints
      // "[<ts> LEVEL  target] …"); anything else is the supervisor talking about
      // it. Both matter in shell.log, but only the daemon's errors do.
      if (!line.startsWith("[") || line.includes(" ERROR ")) host.log("librespot " + line);
      // Wrapped because this runs inside the supervisor's stderr handler, which
      // does not guard it: anything thrown here would surface as an unhandled
      // exception in the shell's main process rather than as a log line.
      try {
        // The daemon has gone. A supervisor respawn - a crash, or the reap of a
        // leftover - goes through neither stopLibrespot nor restartLibrespot,
        // which are the only other places this happens, so both of the claims a
        // dead daemon leaves behind used to stand until something else cleared
        // them:
        //   • the cached device id, for up to its 30s TTL. The id itself does NOT
        //     change across a restart - librespot derives it from the device name
        //     - so this is about the device being down, not about the id being
        //     wrong. It does not remove every symptom either: Spotify keeps
        //     LISTING a departed daemon for seconds afterwards, so a play in that
        //     window still meets a 404 or 502 from Spotify's own side, which no
        //     cache of ours can shorten.
        //   • the now-playing claim, which keeps ADVANCING: measured after a
        //     kill -9 mid-track, position_ms climbed past four minutes with
        //     nothing audible, and that claim feeds the box's media_player in
        //     Home Assistant and the HOME sound card.
        // Hooked on the exit rather than on the next start because that is when
        // both stop being true, and because no line on the start side reliably
        // marks the moment the box becomes addressable: `Published zeroconf
        // service` is the LAN advert, not the Connect registration, and it lands
        // after authentication on a warm respawn but 19 s before it on a cold
        // start. An exit is unambiguous.
        if (isCredentialRejection(line)) credRefusals++;
        const authed = authenticatedAs(line);
        if (authed) {
          signIns++;
          signedInAs = authed;
        }
        if (isSupervisorExit(line)) {
          spotify.clear(); // also drops the owner: the daemon that held the session is the one that died
          spotifyApi.forgetBoxDevice();
        }
        if (credGuard.note(line, { withToken: false })) {
          // The box has just been signed out, so the same two things a deliberate
          // teardown does have to happen: the now-playing claim is no longer true
          // (it feeds the HOME sound card and the box's media_player, both of
          // which would keep showing a track from an account that no longer holds
          // the box), and the cached Connect device id belongs to an instance that
          // is gone. Before the guard existed, the supervisor's give-up ceiling
          // did the first of these - five failures in, not two - so leaving it out
          // would have made the recovery quieter AND less correct than the
          // failure it replaces.
          spotify.clear();
          spotifyApi.forgetBoxDevice();
          // Spotify refused that exact blob, so the vaulted copy of it is no
          // better: kept, every later press would swap it back in and take the
          // box down for the length of a poll before failing the same way.
          const gone = credVault.dropRejected();
          if (gone) host.log("spotify: Spotify refused the saved login for " + gone + " - cast from that phone once");
        }
      } catch (e) {
        host.log("librespot credential guard failed: " + e.message);
      }
    };
    host.spawnService("librespot", {
      argv: librespotArgv, // recomputed each (re)start -> picks up rename + sink
      env: { ...host.childEnv(), TVBOX_SPOTIFY_EVENT_KEY: eventKey },
      stdio: ["ignore", out, "pipe"],
      minUptimeMs: 5000,
      ceiling: 5,
      onGiveUp: () => spotify.clear(), // give up -> reset now-playing to idle
      log: logLine,
    });
  }
  // Killing the process emits no disconnect event, so reset now-playing to idle
  // whenever we tear it down ourselves. The cached device id goes too: it is
  // still the right id (librespot derives it from the device name) but there is
  // no daemon behind it, and Spotify accepts a command addressed to a departed
  // device and silently does nothing with it.
  function stopLibrespot() {
    host.stopService("librespot");
    spotifyApi.forgetBoxDevice();
    spotify.clear();
  }
  // Apply a new --name: respawn after a beat so the old instance releases its
  // zeroconf port + audio device before the new one binds.
  function restartLibrespot() {
    spotify.clear();
    spotifyApi.forgetBoxDevice();
    if (!enabled()) return stopLibrespot(); // disabled mid-flight -> ensure it's down
    host.restartService("librespot", 900);
  }
  // Turn Spotify Connect on/off at runtime (config write + start/stop the
  // daemon). No root — this is the "install/uninstall" for the built-in app.
  function setEnabled(on) {
    host.config.setSpotify({ enabled: !!on });
    if (on) startLibrespot();
    else stopLibrespot();
  }

  // ---- Spotify Web API OAuth (on-box) ----
  // Connecting an account opens a separate window on the Spotify login/consent
  // page (scan the QR with a phone — no TV typing). Spotify only allows a loopback
  // redirect, so it comes back to the shell's own callback route, which exchanges
  // the code. The window uses an ephemeral partition so each connect logs in fresh.
  let authWin = null;
  let authState = "";
  function closeAuthWin() {
    if (authWin && !authWin.isDestroyed()) {
      try {
        authWin.close();
      } catch (e) {}
    }
    authWin = null;
  }
  function startSpotifyAuth() {
    if (!spotifyApi.configured()) return { ok: false, error: "no_credentials" };
    authState = crypto.randomBytes(8).toString("hex");
    closeAuthWin();
    authWin = new host.BrowserWindow({
      fullscreen: true,
      frame: false,
      backgroundColor: "#0b0f14",
      autoHideMenuBar: true,
      webPreferences: {
        partition: "spotify-auth", // ephemeral session, cleared below so each connect logs in fresh
        enableBlinkFeatures: "SpatialNavigation", // D-pad arrows move focus on the raw Spotify page; Enter activates
      },
    });
    authWin.setAlwaysOnTop(true, "screen-saver");
    // Clear any prior Spotify session so adding a DIFFERENT account (family boxes)
    // always prompts a fresh login instead of silently reusing the last one.
    authWin.webContents.session
      .clearStorageData()
      .catch(() => {})
      .then(() => {
        if (authWin && !authWin.isDestroyed()) authWin.loadURL(spotifyApi.authUrl(authState));
      });
    // Make spatial-nav focus visible and grab focus so the remote drives the page.
    authWin.webContents.on("did-finish-load", () => {
      authWin.webContents
        .insertCSS(
          ":focus,:focus-visible{outline:0.4vh solid #1DB954 !important;outline-offset:0.2vh;border-radius:4px}",
        )
        .catch(() => {});
      try {
        authWin.webContents.focus();
      } catch (e) {}
    });
    authWin.on("closed", () => {
      authWin = null;
    });
    return { ok: true };
  }
  function authResultHtml(ok, locale) {
    const s = SPOTIFY_STR[locale] || SPOTIFY_STR.en;
    const msg = ok ? s.authOk : s.authFail;
    return (
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
      `<body style="margin:0;background:#0b0f14;color:#f4f6fa;font:20px system-ui,sans-serif;` +
      `display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px">` +
      `<div>${msg}</div></body>`
    );
  }
  // Handle the loopback callback: verify state, exchange the code, show a result
  // page in the auth window, then close it. The launcher polls /auth/status.
  function handleSpotifyCallback(req, res) {
    const params = new URL(req.url, host.base).searchParams;
    const code = params.get("code"),
      st = params.get("state"),
      err = params.get("error");
    const locale = localeFrom(req);
    const finish = (ok) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(authResultHtml(ok, locale));
      setTimeout(closeAuthWin, 1800);
    };
    if (err || !code || !authState || st !== authState) {
      finish(false);
      return;
    }
    authState = "";
    spotifyApi
      .exchangeCode(code)
      .then((r) => finish(!!r.ok))
      .catch(() => finish(false));
  }

  // ---- phone-as-keyboard: forward the phone's keystrokes into the login window ----
  // Spotify offers no QR/device login and the box has no keyboard, so the pairing
  // server forwards email/password/OTP here and we inject them as real input
  // events. Click Spotify's primary action button (Continue / Log in / Agree):
  // its buttons are React onClick handlers (Enter on the input doesn't submit), so
  // we click the real button — preferring submit/primary, excluding social-login
  // buttons so we never pick "Continue with Google" etc.
  const CLICK_PRIMARY_JS = `(function(){
    var bs = Array.prototype.slice.call(document.querySelectorAll('button:not([disabled]),[role=button]:not([aria-disabled=true])'));
    function t(b){return (b.textContent||'').trim();}
    var c = bs.filter(function(b){return !/google|apple|facebook|sign ?up|regisztr/i.test(t(b));});
    var p = c.filter(function(b){return b.type==='submit';})[0]
      || c.filter(function(b){return /continue|tov\\u00e1bb|log ?in|bejelentkez|next|agree|elfogad|authorize|enged/i.test(t(b));})[0]
      || c.filter(function(b){return (b.className||'').indexOf('button-primary')>=0;})[0]
      || c[c.length-1];
    if(p){p.click();return 'clicked:'+t(p).slice(0,40);} return 'none';
  })()`;
  function injectAuthKey(ev) {
    if (!authWin || authWin.isDestroyed() || !ev) return;
    const wc = authWin.webContents;
    try {
      if (typeof ev.char === "string" && ev.char.length) {
        wc.insertText(ev.char); // reliable for accented/non-ASCII chars (unlike a char keyCode)
      } else if (ev.special === "submit") {
        wc.executeJavaScript(CLICK_PRIMARY_JS, true).catch(() => {});
      } else if (ev.special) {
        const kc = { backspace: "Backspace", tab: "Tab", enter: "Enter" }[ev.special];
        if (kc) {
          wc.sendInputEvent({ type: "keyDown", keyCode: kc });
          wc.sendInputEvent({ type: "keyUp", keyCode: kc });
        }
      }
    } catch (e) {}
  }
  function clickPrimarySoon() {
    setTimeout(() => {
      if (authWin && !authWin.isDestroyed())
        authWin.webContents.executeJavaScript(CLICK_PRIMARY_JS, true).catch(() => {});
    }, 300);
  }
  // Type a string as real char events (spaced out) so multi-box OTP inputs
  // auto-advance and React state keeps up; click the primary button when done.
  function typeString(str, i) {
    if (!authWin || authWin.isDestroyed()) return;
    if (i >= str.length) {
      clickPrimarySoon();
      return;
    }
    try {
      authWin.webContents.sendInputEvent({ type: "char", keyCode: str.charAt(i) });
    } catch (e) {}
    setTimeout(() => typeString(str, i + 1), 70);
  }
  // Auto-fill the real Spotify login form from the phone's Email / Secret fields:
  // set the matching input's value (React-compatible) and click the primary button.
  // The "secret" field targets a password input if present, else the OTP code
  // input(s). Tied to Spotify's login DOM (may need selector tweaks if they
  // redesign it) — the manual keyboard remains the fallback.
  function fillAuthField(d) {
    if (!authWin || authWin.isDestroyed() || !d || d.value == null) return;
    const wc = authWin.webContents;
    const val = String(d.value);
    if (d.field === "secret") {
      // Focus the password field OR the first OTP box, then TYPE (real key events)
      // so a 6-box code input auto-advances — value injection doesn't trigger it.
      const focusJs =
        "(function(){var pw=document.querySelector('input[type=password]');if(pw){pw.focus();return 'pw';}" +
        "var s=document.querySelector('input[maxlength=\"1\"],input[autocomplete=one-time-code],input[inputmode=numeric],input[type=tel],input[type=number]');if(s){s.focus();return 'code';}" +
        "var a=document.querySelectorAll('input:not([type=hidden])');for(var i=0;i<a.length;i++){if(a[i].offsetParent){a[i].focus();return 'fb';}}return 'none';})()";
      wc.executeJavaScript(focusJs, true)
        .then(() => typeString(val, 0))
        .catch(() => {});
    } else {
      const v = JSON.stringify(val);
      const js =
        "(function(){function set(el,x){try{var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;" +
        "Object.getOwnPropertyDescriptor(p,'value').set.call(el,x);}catch(e){el.value=x;}" +
        "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}" +
        "var el=document.querySelector('input[type=email],input[autocomplete=username],input[name=username],input#login-username,input[type=text]');" +
        "if(el){el.focus();set(el," +
        v +
        ");}})()";
      wc.executeJavaScript(js, true)
        .then(() => clickPrimarySoon())
        .catch(() => {});
    }
  }

  // ---- play, and signing the box back in when it is not addressable ----
  // A play from the TV is addressed to the box by Connect device id, and the box
  // only HAS one while librespot holds a session with Spotify. That session is
  // what the saved login in <cache>/credentials.json buys, and it does not last
  // forever: `Connection to server closed.` is a normal line in this daemon's log
  // and librespot can take tens of minutes to notice and reconnect (measured on
  // this fleet: gaps of 4 to 41 minutes). While it is down the box is in no
  // account's device list, every play is refused, and casting from a phone is
  // what put it back - which is the complaint this exists to answer.
  //
  // Restarting the daemon signs it in again from the SAME cached file, in about
  // two seconds, so the cast is not needed. That is the whole recovery; the box
  // is not being taken off anyone and no new credential is minted.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const REREGISTER_COOLDOWN_MS = 60000;
  let lastReRegister = 0;
  // A recovery IN FLIGHT. Separate from the cooldown because they bound different
  // things and the cooldown cannot do this job: it is read before an eighteen
  // second poll and armed after it, so two presses two seconds apart both passed
  // it and both restarted the daemon - the second one SIGTERMing the instance the
  // first was waiting for. Measured on the box, and a twenty second spinner is
  // exactly when somebody presses again. `starting` in the browser cannot cover
  // it either: it is per-component, and the voice path is a second call site.
  let recovering = false;
  // Whether there is anything to sign back in WITH. Only a real ENOENT counts as
  // "no": `existsSync` answers false for a cache directory it cannot READ too,
  // and taking that as an absent login makes the one claim this file is careful
  // not to make - it tells the user the box is signed out, on the strength of a
  // permissions problem, and sends them to cast over a login that is fine.
  const savedLoginExists = () => {
    try {
      fs.accessSync(path.join(LIBRESPOT_CACHE, "credentials.json"), fs.constants.F_OK);
      return true;
    } catch (e) {
      return e.code !== "ENOENT";
    }
  };
  // ---- signing the box in as the account whose library is on screen ----
  // The box holds ONE Spotify session and the launcher may be browsing another
  // account. A play from the TV means "play this, from this library, in this
  // room", so the account being browsed is the one the box should be playing as -
  // and the only credential that can get it there is that account's own saved
  // login, kept by credvault.js. Nothing here can mint one: a Web API token is
  // refused at Connect registration and destroys the file it is handed to.
  //
  // With no vaulted login for the browsed account the play still goes out as the
  // account holding the box, which is what this did before; the result names that
  // account so the screen can say whose music started.
  const accountName = (id) => (spotifyApi.listAccounts().find((a) => a.id === id) || {}).name || "";
  // Is this account one the household has LINKED on this box? The vault must not
  // decide that for itself, and two things turn on it: a guest who cast once has a
  // reusable credential in `<cache>/credentials.json` like anyone else, and it must
  // neither be kept for later nor be a candidate the box signs itself into weeks
  // afterwards - their session, their history, their stream.
  //
  // Answers TRUE whenever it cannot tell, and that direction is deliberate: an
  // account whose real id was never resolved (a `legacy` or `acc-N` row, /me
  // unreachable when it was linked) is filed in the vault under its librespot
  // username, which no row here carries - so a confident "not linked" would drop
  // or refuse a login that is linked.
  // Two questions, and they need opposite defaults, which is why they are two
  // functions. `isLinked` gates what may be KEPT or USED, so it answers no unless
  // a row says otherwise: a box with no linked account at all (Connect-only, which
  // this app supports by design) would otherwise archive every guest's credential
  // for ever, and an unresolved row would let the signed-out recovery sign the box
  // into one of them. `knownUnlinked` gates a DELETE, so it answers no unless the
  // row list is complete and trustworthy - a synthetic id (`legacy`, `acc-N`, from
  // a /me that never answered) names a real account under a name the vault does
  // not use, and reading that as "not linked" deletes a login that is.
  function isLinked(id) {
    if (!id) return false;
    return spotifyApi.listAccounts().some((a) => a.id === id);
  }
  function knownUnlinked(id) {
    if (!id) return false;
    const rows = spotifyApi.listAccounts();
    if (!rows.length) return false;
    if (rows.some((a) => a.id === "legacy" || String(a.id).indexOf("acc-") === 0)) return false;
    return !rows.some((a) => a.id === id);
  }
  // Keep a copy of the live login, unless it belongs to somebody this box has not
  // linked. Called wherever a login may have just been written.
  function archiveLogin() {
    const who = credVault.owner();
    if (who && isLinked(who)) credVault.archive();
  }
  // A saved login that did not bring the box back is not tried again at once:
  // every attempt takes the daemon down for the length of a poll.
  const SIGNIN_FAIL_COOLDOWN_MS = 60000;
  const signInFailed = new Map(); // accountId -> when its saved login last failed to register
  const signInCooling = (id) => Date.now() - (signInFailed.get(id) || 0) < SIGNIN_FAIL_COOLDOWN_MS;
  // Is the box somebody's right now? Two senses, and both have to stop a restart:
  // music is audibly playing on it, or an account this box has not linked holds a
  // live session - a guest's cast, which nothing we send could reach anyway and
  // which a restart would simply end. `is_playing` outlives a daemon that was
  // killed, which is why this only gates the pre-emptive swap: once Spotify says
  // the box is not one of its devices, the recovery below acts on that instead.
  function boxTaken() {
    if (spotify.getState().is_playing) return true;
    const holder = spotify.sessionUser();
    if (!holder || !spotify.sessionActive()) return false;
    return !spotifyApi.listAccounts().some((a) => a.id === holder);
  }
  // Swap in an account's saved login, restart the daemon under it, and wait for
  // the box to appear in THAT account's device list. Returns whether it did.
  //
  // The login it displaces was archived by the vault before the swap, so a blob
  // Spotify no longer accepts costs the box nothing: it goes back and the box
  // returns to the account it was signed into. Without that, one stale vault
  // entry would leave the box signed out - discoverable but in no account's
  // device list - which is the single state only a phone cast can undo.
  const SIGNIN_TRIES = 6; // a warm respawn registers in ~2s; the rest is for a slow AP
  const SIGNIN_STEP_MS = 1500;
  // Wait out a restart, and say what it came back as. Four answers, because each
  // calls for something different:
  //
  //   up             the daemon signed in as `id` AND that account can address it
  //   wrong_account  it signed in as somebody else - the blob is not this
  //                  account's, whatever the name in the file says
  //   refused        Spotify refused the credential, twice
  //   absent         nothing conclusive inside the budget
  //
  // The DAEMON's own word is what proves an account, not a device listing: Spotify
  // lists a departed registration for seconds, so a listing hit at the first poll
  // can be the instance that just died - which is what made a play right after a
  // sign-in answer 502. Both are required, in that order, and neither on its own.
  //
  // A refusal is counted TWICE for the same reason the credential guard does: one
  // can be Spotify's answer to a bad moment, and being wrong here deletes the only
  // copy of a household member's login. It costs a second poll step, not a budget.
  async function waitForBox(id, tries) {
    const refusalsBefore = credRefusals;
    const signInsBefore = signIns;
    for (let i = 0; i < tries; i++) {
      await sleep(SIGNIN_STEP_MS);
      if (signIns > signInsBefore && signedInAs && signedInAs !== id) return "wrong_account";
      if (signIns > signInsBefore && signedInAs === id && (await spotifyApi.boxSeenBy(id))) return "up";
      if (credRefusals - refusalsBefore >= 2) return "refused";
    }
    return "absent";
  }
  async function signInAs(id) {
    const swap = credVault.use(id);
    if (!swap.ok) {
      // Nothing was touched, but the reason will not have changed by the next
      // press either (a slot filed under the wrong account, a login in place this
      // cannot read, a card that cannot be written): cooled like a failure, or the
      // vault says the same thing into the log on every press for ever. Not
      // dropped - none of those is Spotify refusing the credential.
      signInFailed.set(id, Date.now());
      return false;
    }
    // The strikes so far were counted against the file that has just been
    // replaced; charged to this one they would move IT aside on a single refusal.
    credentialsReplaced();
    host.log("spotify: signing the box in as " + id + " - the account whose library is on screen");
    restartLibrespot();
    const how = await waitForBox(id, SIGNIN_TRIES);
    if (how === "up") {
      signInFailed.delete(id);
      // A login displaced by this one that belongs to nobody linked here is a
      // guest's, kept only so it could be put back if this failed. It did not.
      if (swap.displaced && swap.displaced !== id && knownUnlinked(swap.displaced)) credVault.drop(swap.displaced);
      return true;
    }
    signInFailed.set(id, Date.now());
    host.log("spotify: the saved login for " + id + " did not bring the box back (" + how + ")");
    if (swap.displaced && swap.displaced !== id && credVault.use(swap.displaced).ok) {
      credentialsReplaced();
      restartLibrespot();
      // Waited for, not fired and forgotten: the play that follows is answered by
      // the box being addressable, and returning before it is would restart the
      // daemon a second time for the same press.
      await waitForBox(swap.displaced, SIGNIN_TRIES);
    }
    // Spotify refused this blob TWICE, the bar the credential guard holds itself
    // to, so the copy is worth nothing: kept, every press a minute apart would
    // take the box down to be told the same thing. Only the COPY goes - if that
    // account is signed in anywhere else it is untouched, and one cast from its
    // phone puts a working login back here.
    //
    // After the restore rather than before it: putting the previous login back
    // archives whatever is live at that moment, which is the blob being dropped,
    // so a drop first is undone by the copy taken a line later.
    //
    // `wrong_account` deliberately does NOT drop it. One "Authenticated as" naming
    // somebody else is not proof the blob is theirs: a phone casting inside the
    // poll window logs exactly that line, and the two strings being compared are
    // a credential's own `username` field and login5's canonical username, which
    // this vault already expects to exist in more than one form. Being wrong costs
    // a household member their only login here, against a press that is slow once
    // a minute - so it is left alone and merely cooled.
    if (how === "refused") credVault.drop(id);
    return false;
  }
  // A play, and the one thing the screen cannot work out for itself: WHOSE
  // session started. With no vaulted login for the account being browsed the
  // music goes out as the one holding the box, and a person who pressed a row in
  // their own library is owed that sentence rather than left wondering whose
  // songs these are. Only on a play that started - a refusal has its own message.
  async function playOnBox(body) {
    const want = spotifyApi.activeAccountInfo();
    const r = await startOnBox(want, body);
    if (!r || !r.ok || !want || !r.account || r.account === want.id) return r;
    // Only a NAME. This sentence is read off a television, and an account whose
    // display name was never resolved would put a base62 id on the screen - worse
    // than saying nothing, which is what the account label beside the gear already
    // does in that case.
    const named = r.accountName || accountName(r.account);
    return named ? { ...r, startedAs: named } : r;
  }
  async function startOnBox(want, body) {
    // An idle box registered under another linked account: bring it to the one
    // being browsed before the play, so the press starts THAT account's session
    // rather than playing its songs inside somebody else's. Refused while the box
    // is taken, and never on a login that has just failed to register.
    //
    // `enabled()` FIRST, before anything is swapped or restarted. With Connect
    // switched off, restartLibrespot() degrades to stopLibrespot(), so both of a
    // sign-in's polls would run out against a daemon that was deliberately not
    // started - the 19.5 s hang the refusal further down was written to stop, from
    // the other end.
    let signedIn = false;
    if (
      enabled() &&
      want &&
      credVault.owner() !== want.id &&
      credVault.has(want.id) &&
      !signInCooling(want.id) &&
      !boxTaken() &&
      !recovering
    ) {
      recovering = true;
      try {
        signedIn = await signInAs(want.id);
      } finally {
        recovering = false;
      }
    }
    let r = await spotifyApi.play(body);
    // A play right after a sign-in can meet Spotify's own gateway rather than the
    // box: the daemon has authenticated and the device is listed, and the command
    // path is a second or so behind that (measured: HTTP 502 on 2 presses in 3
    // before the readiness above required the daemon's own word). One retry, only
    // on the turn that restarted the daemon, and only for a 5xx - `attempt()`
    // retries a 404 and nothing else, and a refusal from Spotify is not a timing
    // problem.
    if (signedIn && !r.ok && /^HTTP 5\d\d/.test(String(r.error || ""))) {
      await sleep(SIGNIN_STEP_MS);
      r = await spotifyApi.play(body);
    }
    // Both answers mean the same thing about the DEVICE - no linked account can
    // address it - and differ only in whether librespot has named an owner since
    // this shell started. `box_unreachable` is the commoner one by far, because
    // naming an owner is what a cast does, so the old code healed only the state
    // a user who had never cast could reach.
    // Neither is reached unless every linked account was actually asked and none
    // of them lists the box: a listing that failed says `box_lookup_failed`
    // instead, and is never healed. That is what makes the two guards below
    // decidable at all.
    if (r.error !== "box_not_found" && r.error !== "box_unreachable") return r;
    // What the box last told us about itself is NOT evidence here, and this is
    // the trap that has to be stated. `is_playing` and the session flag are set
    // by librespot's own events and cleared by events that a dying session never
    // sends - measured: a daemon killed mid-track leaves `is_playing` true, with
    // position_ms still advancing past four minutes, for as long as the shell
    // lives. Read literally they say "somebody is listening" on a box Spotify has
    // just told us is not one of its devices, so the state that outlives a silent
    // drop is exactly the state that would veto the recovery for it.
    //
    // Dropping them on `box_unreachable` is a BET, not a proof, and it is worth
    // stating as one. It rests on Spotify's device listing being consistent: if
    // the account holding the box ever answers 200 with the box missing WHILE
    // somebody is playing on it, this restarts the daemon under them. Two things
    // bound that. The state is only reached when a listing actually answered
    // (`box_lookup_failed` covers the rest), and `named` is a linked account
    // whose id came from a key-gated `session_connected` - a forged event cannot
    // manufacture one, and an UNLINKED account holding the box is a different
    // answer (`box_other_account`) which is never healed. So the blast radius is
    // one household member's playback, on a press by somebody at the TV who is
    // taking the box anyway.
    //
    // `box_not_found` keeps the guards, because there they are not stale: boxOwner
    // reaches that state with `casting` true only when a guest's
    // session_connected was lost (the hook swallows a failed post), and
    // restarting there ends a cast nobody could see was happening.
    if (r.error === "box_not_found") {
      if (spotify.getState().is_playing) return { ok: false, error: "in_use" };
      if (spotify.sessionActive()) return r;
    }
    // Connect is switched off for this box, so there is no daemon to sign in and
    // restartLibrespot() would stop one rather than start it - measured before
    // this check: the press hung for 19.5 s polling for a daemon it had
    // deliberately not started, then blamed the login. Nothing here can fix it and
    // a cast cannot either: with Connect off the box advertises nothing.
    if (!enabled()) return { ok: false, error: "connect_off" };
    // Nothing cached to sign in with: the box has never been signed in, or the
    // credential guard cleared a login Spotify refused. A vaulted login is the way
    // out of that - it is a credential Spotify itself wrote on this box, so
    // putting one back is a sign-in rather than a claim - and a phone cast is only
    // genuinely the only way back when there is not one of those either.
    // Only accounts this box has LINKED, and none whose login has just failed to
    // register: a guest who cast once leaves a reusable credential here too, and
    // signing the box into a stranger's account weeks later - their session, their
    // history, their stream - is not a recovery.
    // In the household's OWN order - the accounts as they were linked - rather than
    // the vault's: which member a signed-out box comes back as must not depend on
    // how a directory happens to enumerate, and sorting the ids is no better an
    // answer to that question than random is. The account being BROWSED still wins
    // over all of them; this is only the order of the fallback. Taking the ids from
    // the account list is also what holds this to the linked accounts, so a guest's
    // saved login is never one of the candidates.
    const vaulted = spotifyApi
      .listAccounts()
      .map((a) => a.id)
      .filter((id) => credVault.has(id) && !signInCooling(id));
    if (!savedLoginExists() && !vaulted.length) return { ok: false, error: "box_signed_out" };
    // A press must not become a restart loop when the box cannot come back: the
    // supervisor has its own ceiling, but this is what keeps a person leaning on
    // the button from spending it - and every restart takes down whatever cast is
    // live at that moment. The window has its OWN answer rather than the refusal
    // that opened it: an attempt has just been made and failed, so repeating
    // "try again shortly" invites the one thing that cannot work for a minute.
    if (recovering || Date.now() - lastReRegister < REREGISTER_COOLDOWN_MS) {
      return { ok: false, error: "recovery_cooling" };
    }
    host.log("spotify: box is not addressable (" + r.error + ") - signing it back in from its saved login");
    recovering = true;
    try {
      // Which login it comes back on. The daemon has to be restarted either way,
      // so coming back as the account whose library is on screen is what the press
      // asked for; failing that, any login this box holds beats a box that is
      // signed out. `displaced` is the login this replaced - archived by the vault
      // before the swap - so one that does not register can be put back below.
      let displaced = "";
      let broughtIn = "";
      const pick =
        want && credVault.has(want.id) && !signInCooling(want.id) ? want.id : savedLoginExists() ? "" : vaulted[0];
      if (pick && credVault.owner() !== pick) {
        const swap = credVault.use(pick);
        if (swap.ok) {
          displaced = swap.displaced;
          broughtIn = pick;
          // Same reason as in signInAs: strikes counted against the file that has
          // just been replaced would move THIS one aside on a single refusal - and
          // below, they would move aside the login being put BACK, which is the one
          // that was working.
          credentialsReplaced();
          host.log("spotify: bringing the box back as " + pick);
        }
      }
      restartLibrespot();
      const signInsBefore = signIns;
      let seen = false;
      let answered = false; // did any listing actually come back?
      for (let i = 0; i < 12 && !seen; i++) {
        // login + Connect registration is ~2s on a healthy box; the rest of the
        // budget is for a slow access point, and a miss is never cached.
        await sleep(1500);
        // The daemon has to have signed in SINCE the restart before a listing means
        // anything: Spotify lists a departed registration for seconds, so a hit at
        // the first poll can be the instance that just died - and a play sent then
        // meets Spotify's gateway rather than the box (HTTP 502). The account is
        // not compared here, unlike in a sign-in: on this path the box may be
        // coming back on whatever login it already had, whoever that is.
        if (signIns === signInsBefore) continue;
        try {
          const found = await spotifyApi.findBoxAccount();
          seen = !!found.account;
          // `answered`, NOT `complete`: complete means EVERY linked account
          // replied, so one family account rate-limited for the whole poll would
          // turn a real "it did not come back" into "Spotify is unreachable" -
          // the same mistake boxOwner was just taught not to make, one function
          // along.
          answered = answered || found.answered;
        } catch (e) {
          /* keep polling */
        }
      }
      if (!seen) {
        lastReRegister = Date.now();
        host.log("spotify: the box did not come back as a Connect device");
        if (broughtIn) {
          // Put back what was there: the login brought in did not register, and
          // left in place it would answer every later press the same way. Waited
          // for, like the same restore in signInAs - the box being addressable
          // again is what makes the NEXT press work rather than restart the daemon.
          signInFailed.set(broughtIn, Date.now());
          if (displaced && displaced !== broughtIn && credVault.use(displaced).ok) {
            credentialsReplaced();
            restartLibrespot();
            await waitForBox(displaced, SIGNIN_TRIES);
          }
        }
        // Same distinction the refusals above turn on: with nothing having come
        // back from Spotify, "it did not come back" is not something we know.
        // Saying the saved login is bad - and asking for a cast - would be a
        // claim about a credential that was never tested.
        return { ok: false, error: answered ? "recovery_failed" : "box_lookup_failed" };
      }
      // The box IS back, so the restart did its job - but the play can still be
      // refused (a 429, a 502, an account without Premium), and arming the
      // cooldown only on the branch above left that case with no rate limit at
      // all: every press restarted the daemon, which is what this exists to stop.
      let out = await spotifyApi.play(body);
      // A 5xx here is the same "registered, not yet reachable" second as after a
      // sign-in: the command path lags the registration, and nothing else retries
      // one (`attempt()` retries a 404 and nothing more).
      if (!out.ok && /^HTTP 5\d\d/.test(String(out.error || ""))) {
        await sleep(SIGNIN_STEP_MS);
        out = await spotifyApi.play(body);
      }
      if (!out.ok) lastReRegister = Date.now();
      return out;
    } finally {
      recovering = false;
    }
  }

  // ---- autoplay ----
  // Off unless the owner turned it on: it starts music nobody asked for, in a
  // room that just went quiet. The flag lives in the raw spotify config section
  // (the shell's sanitized publicConfig carries only the three fields it knows
  // about, so this app serves its own through the routes below).
  const autoplayEnabled = () => !!(host.config.rawSpotify() || {}).autoplay;
  const autoplay = createAutoplay({
    api: spotifyApi,
    // spotifyApi.play, NOT playOnBox: autoplay must never restart the daemon.
    // The guard that normally protects a live cast
    // (`spotify.getState().is_playing`) is false by construction here, because
    // end_of_track is what sets it false - so a guest casting from an unlinked
    // account, whose own playlist happened to end, would have the box taken out
    // from under them by a timer nobody set. With a plain play, a box no linked
    // account can see answers `box_not_found` and autoplay simply stays quiet,
    // which is the right answer to "somebody else is using this".
    play: (body) => spotifyApi.play(body),
    isEnabled: autoplayEnabled,
    log: (m) => host.log(m),
  });

  // ---- HTTP routes (registered below via host.registerRoutes) ----
  // Kept at the historical /tvbox/api/spotify/* paths: the OAuth redirect URI
  // (spotify_api.REDIRECT_URI) is registered verbatim in the user's Spotify
  // developer dashboard, so the callback path must not move.
  const routes = {
    // cast state (always available)
    "GET /state": (req, res) => host.json(res, spotify.getState()),
    "GET /stream": (req, res) => {
      // SSE: push state on every change
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(spotify.getState())}\n\n`);
      const off = spotify.subscribe((s) => {
        try {
          res.write(`data: ${JSON.stringify(s)}\n\n`);
        } catch (e) {}
      });
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch (e) {}
      }, 20000);
      req.on("close", () => {
        off();
        clearInterval(ping);
      });
    },
    "POST /event": (req, res, ctx) => {
      const ev = ctx.body || {};
      const trusted = fromOurDaemon(ev.key);
      if (ev.user_name && !trusted) {
        // Anything on this origin can post an event; only our daemon can say who
        // the box belongs to. A forged one would otherwise strand the transport
        // controls on a box "somebody else is driving".
        //
        // Logged at most once a minute. The other way to get here is a librespot
        // that outlived the shell that started it (its environment holds the old
        // key), and that one keeps sending: unthrottled it would write a line per
        // player event, for as long as that daemon lives. The box still works -
        // with no owner named, the device lists answer instead.
        const now = Date.now();
        if (now - lastKeylessLog > 60000) {
          lastKeylessLog = now;
          host.log("spotify: ignoring events that name an account without the daemon key");
        }
        delete ev.user_name;
      }
      delete ev.key;
      spotify.handleEvent(ev, trusted);
      // The same events, raw: autoplay needs the event NAME (a context running out
      // is an end_of_track with nothing after it), which the rendered SSE state
      // does not carry.
      autoplay.onEvent(String(ev.player_event || "").toLowerCase(), ev.track_id);
      host.json(res, { ok: true });
    }, // librespot --onevent
    "POST /device-name": (req, res, ctx) => {
      // rename the Connect device (no root)
      const name = String((ctx.body || {}).name || "")
        .trim()
        .replace(/[\r\n"]/g, "")
        .slice(0, 64);
      if (name) {
        host.config.setSpotify({ deviceName: name });
        spotify.pushState();
        restartLibrespot();
      }
      host.json(res, { ok: !!name, config: host.config.publicConfig() });
    },
    // enable/disable Spotify Connect on this box (starts/stops librespot). No
    // root — the on/off switch (the librespot binary is the app's download dep).
    "POST /enable": (req, res, ctx) => {
      setEnabled(!!(ctx.body || {}).enabled);
      host.json(res, { ok: true, config: host.config.publicConfig() });
    },
    // optional Web API (account features)
    "POST /credentials": (req, res, ctx) => {
      const clientId = String((ctx.body || {}).clientId || "").trim();
      const clientSecret = String((ctx.body || {}).clientSecret || "").trim();
      if (clientId && clientSecret) host.config.setSpotify({ clientId, clientSecret });
      host.json(res, { ok: !!(clientId && clientSecret) });
    },
    "POST /disconnect": (req, res) => {
      spotifyApi.disconnect();
      host.json(res, { ok: true });
    },
    "POST /account/switch": (req, res, ctx) =>
      host.json(res, { ok: spotifyApi.switchAccount(String((ctx.body || {}).id || "")) }),
    "POST /account/remove": (req, res, ctx) => {
      const id = String((ctx.body || {}).id || "");
      spotifyApi.removeAccount(id);
      // The saved librespot login goes with the link: it is a credential for an
      // account the household has just unlinked from this box, and a later press
      // could otherwise sign the box back in as them. The id in the REQUEST, not a
      // sweep of everything unlinked: a row also disappears on its own when a Web
      // API refresh is refused (a rotated or revoked token), and that account's
      // librespot login is a different credential which still works and which
      // nobody asked to delete. It does not sign the box out either - the live
      // login stays until something else replaces it.
      credVault.drop(id);
      host.json(res, { ok: true });
    },
    "POST /control": (req, res, ctx) => {
      const b = ctx.body || {};
      // Somebody pressed a transport button, so somebody is in the room. That is
      // the signal autoplay's unattended bound resets on, and unlike recognising
      // its own tracks by id it cannot be fooled.
      autoplay.userPlayed();
      spotifyApi
        .control(String(b.action || ""), b.state)
        .then((r) => host.json(res, r))
        .catch((e) => host.json(res, { ok: false, error: String(e.message || e) }));
    },
    // What is coming next, for the panel on the player screen. Its own route
    // rather than part of /player: that one is polled every twenty seconds by a
    // screen that is always up, and this is a heavier answer nobody needs unless
    // the panel is on display.
    "GET /queue": (req, res) => {
      const n = new URL(req.url, "http://x").searchParams.get("limit");
      spotifyApi
        .queue(n)
        .then((q) => host.json(res, q))
        .catch((e) => host.json(res, { ok: false, items: [], error: String(e.message || e) }));
    },
    // Shuffle and repeat are player-wide settings the cast metadata does not
    // carry, so the transport toggles read them from here.
    "GET /player": (req, res) => {
      spotifyApi
        .playerState()
        .then((s) => host.json(res, s))
        .catch((e) => host.json(res, { connected: false, error: String(e.message || e) }));
    },
    "POST /play": (req, res, ctx) => {
      const b = ctx.body || {};
      autoplay.userPlayed(); // a play the user asked for is not a link in an autoplay chain
      playOnBox({ contextUri: b.contextUri, uris: b.uris, offset: b.offset, collection: b.collection })
        .then((r) => host.json(res, r))
        .catch((e) => host.json(res, { ok: false, error: String(e.message || e) }));
    },
    // Autoplay on/off. The shell's publicConfig does not carry this app's own
    // flags, so the app serves its own state rather than reading it from there.
    "GET /autoplay": (req, res) => host.json(res, { enabled: autoplayEnabled() }),
    "POST /autoplay": (req, res, ctx) => {
      const on = !!(ctx.body || {}).enabled;
      host.config.setSpotify({ autoplay: on });
      if (!on) autoplay.stop();
      host.json(res, { ok: true, enabled: on });
    },
    "GET /auth/status": (req, res) => {
      spotifyApi
        .status()
        .then((s) => host.json(res, s))
        .catch(() => host.json(res, { configured: false, connected: false, user: "" }));
    },
    "GET /auth/start": (req, res) => host.json(res, startSpotifyAuth()),
    // NOT a route to put in `registerRoutes`' `guard` list, however much it looks
    // like one. Spotify's own page navigates down to this URL after the consent
    // screen, and a page-initiated navigation carries `Sec-Fetch-Site:
    // cross-site` - measured - so the same-origin gate would answer 403 and the
    // sign-in window would just sit there with nothing said.
    "GET /auth/callback": (req, res) => handleSpotifyCallback(req, res),
    // { tracks, total, truncated }: `truncated` so a library past the paging
    // bound can say so on screen. A list that simply ends cannot be told from a
    // shorter library.
    "GET /liked": (req, res) => {
      spotifyApi
        .getLiked()
        .then((r) => host.json(res, r))
        .catch((e) => host.json(res, { error: String(e.message || e), tracks: [] }));
    },
    "GET /playlists": (req, res) => {
      spotifyApi
        .getPlaylists()
        .then((playlists) => host.json(res, { playlists }))
        .catch((e) => host.json(res, { error: String(e.message || e), playlists: [] }));
    },
    "GET /playlist": (req, res) => {
      const id = new URL(req.url, host.base).searchParams.get("id") || "";
      spotifyApi
        .getPlaylistItems(id)
        .then((r) => host.json(res, r))
        .catch((e) => host.json(res, { error: String(e.message || e), tracks: [] }));
    },
    "GET /search": (req, res) => {
      const q = new URL(req.url, host.base).searchParams.get("q") || "";
      spotifyApi
        .search(q)
        .then((r) => host.json(res, r))
        .catch((e) => host.json(res, { error: String(e.message || e), tracks: [], playlists: [] }));
    },
    // lyrics (LRCLIB proxy; no Spotify account needed — matched by track metadata)
    "GET /lyrics": (req, res) => {
      const q = new URL(req.url, host.base).searchParams;
      const title = (q.get("title") || "").trim(),
        artist = (q.get("artist") || "").trim();
      const album = (q.get("album") || "").trim(),
        dur = q.get("duration") || "";
      if (!title || !artist) return host.json(res, { synced: [], plain: "", instrumental: false });
      const key = artist.toLowerCase() + "|" + title.toLowerCase() + "|" + dur;
      if (lyricsCache.has(key)) return host.json(res, lyricsCache.get(key));
      const params = new URLSearchParams({ track_name: title, artist_name: artist });
      if (album) params.set("album_name", album);
      if (dur) params.set("duration", dur);
      const bare = new URLSearchParams({ track_name: title, artist_name: artist });
      if (dur) bare.set("duration", dur);
      // exact (album+duration) -> exact without album -> full-text search
      fetchLrclib(params.toString())
        .then((d) => d || (album ? fetchLrclib(bare.toString()) : null))
        .then((d) => d || searchLrclib(title, artist, dur))
        .then((d) => {
          const out = d
            ? { synced: parseLrc(d.syncedLyrics || ""), plain: d.plainLyrics || "", instrumental: !!d.instrumental }
            : { synced: [], plain: "", instrumental: false };
          if (lyricsCache.size > 100) lyricsCache.clear(); // bound the cache
          lyricsCache.set(key, out);
          host.json(res, out);
        });
    },
  };

  host.registerRoutes("/tvbox/api/spotify", routes);

  // Spotify's phone-pairing pages: the API-keys form and the phone-as-keyboard
  // that types into our OAuth login window. Registered here (not in core) so they
  // exist only when Spotify is installed; the pages ship in THIS package
  // (pairing/*.html) — the keyboard provider gets OUR handlers since only we own
  // that login window's state.
  const spotifyPageHtml = fs.readFileSync(path.join(__dirname, "pairing", "spotify.html"), "utf8");
  host.pairing.register("spotify", {
    page: (ctx) =>
      renderTemplate(spotifyPageHtml, {
        lang: ctx.locale,
        redirUri: spotifyApi.REDIRECT_URI,
        ...(SPOTIFY_STR[ctx.locale] || SPOTIFY_STR.en),
      }),
    routes: {
      "POST /save": (req, res, ctx) => {
        const clientId = String((ctx.body || {}).clientId || "").trim();
        const clientSecret = String((ctx.body || {}).clientSecret || "").trim();
        if (!clientId || !clientSecret) return ctx.json(res, { ok: false, error: "invalid" });
        host.config.setSpotify({ clientId, clientSecret });
        ctx.json(res, { ok: true });
        ctx.stopSoon(); // the TV polls config/status and closes; then pairing shuts down
      },
    },
  });
  const keyboardPageHtml = fs.readFileSync(path.join(__dirname, "pairing", "keyboard.html"), "utf8");
  host.pairing.register("keyboard", {
    page: (ctx) =>
      renderTemplate(keyboardPageHtml, { lang: ctx.locale, ...(KEYBOARD_STR[ctx.locale] || KEYBOARD_STR.en) }),
    routes: {
      "POST /key": (req, res, ctx) => {
        try {
          injectAuthKey(ctx.body);
        } catch (e) {
          /* ignore */
        }
        ctx.json(res, { ok: true });
      },
      "POST /fill": (req, res, ctx) => {
        try {
          fillAuthField(ctx.body);
        } catch (e) {
          /* ignore */
        }
        ctx.json(res, { ok: true });
      },
    },
  });

  return {
    // Called by the shell after the audio sink is detected and the window exists.
    start() {
      // Reap a stray/previous librespot before we spawn ours (a crashed prior
      // shell can leave one holding the Connect name + zeroconf port).
      try {
        execFile("pkill", ["-9", "-x", "librespot"], () => {});
      } catch (e) {}
      // A cast started on the box (Connect): open the Spotify app (its own
      // webclient window now) and stop other playback. Fires once per cast
      // session. host.navTo opens the app by id; older shells fall back to the
      // launcher hash deep-link.
      spotify.onCastStart(() => {
        host.log("cast started -> open Spotify, stop other playback");
        if (host.navTo) host.navTo("spotify");
        else host.showLauncher("#spotify");
        // Music started here, so whoever started it is holding the box. The
        // session event below is the direct signal, but it does not always come;
        // this asks Spotify instead, and both end in the same place.
        spotifyApi
          .followBox()
          .then((moved) => moved && host.log("spotify: following the account that cast to the box"))
          .catch(() => {});
      });
      // The box changed hands. Whoever picked it in their Spotify app now owns
      // the session, so the launcher follows them: their library is the one that
      // matches the music, and their player is the one the buttons reach. A
      // household with two linked accounts had neither — the screen stayed on
      // whichever account was linked last, and its pause never stopped the cast.
      spotify.onSessionUser((userId) => {
        if (spotifyApi.boxSignedInAs(userId))
          host.log("spotify: the box changed hands; following the account playing on it");
        // A cast is how a login gets onto this box at all: librespot writes the
        // credential it just authenticated with, and this is the first moment
        // after that write which is certainly past it. Keeping a copy is what
        // lets the box be signed back in as this account later without a second
        // cast. The file names its own account, so a lost or late event costs a
        // copy rather than filing one under the wrong person.
        archiveLogin();
      });
      // HOME widget: the playing track as a card while a cast is active (shell
      // 1.5+ host API; older shells simply have no host.widget). Keyed so the
      // per-position state pushes don't re-send an unchanged card.
      let lastWidgetKey = "";
      spotify.subscribe((s) => {
        if (!host.widget) return;
        const key = s.is_playing && (s.title || s.artist) ? (s.title || "Spotify") + "\n" + (s.artist || "") : "";
        if (key === lastWidgetKey) return;
        lastWidgetKey = key;
        if (key) host.widget.set({ title: s.title || "Spotify", subtitle: s.artist || "" });
        else host.widget.clear();
      });
      // Enrich the now-playing background with the primary artist's photo (Web API,
      // when connected) — like the old client. Fetch once per new track.
      let lastArtistTrack = "";
      spotify.subscribe((s) => {
        const id = (s.uri || "").split(":").pop() || s.track_id; // base62 id (URI is the reliable source)
        if (!id || id === lastArtistTrack || !spotifyApi.connected()) return;
        lastArtistTrack = id;
        spotifyApi
          .artistImageForTrack(id)
          .then((url) => {
            if (url) spotify.setArtistImage(url);
          })
          .catch(() => {});
      });
      // Whatever login the box is holding, on the way up: a box upgraded to this
      // version has one and no copy of it, and until there is a copy the account
      // it belongs to cannot be signed back in after another one takes the file.
      archiveLogin();
      startLibrespot();
    },
    // The app was closed from the Running row (or by its own Exit), and the
    // music has to go with it - it did not, because the sound is librespot's and
    // the shell only ever ended its own mpv.
    //
    // PAUSE, not stop: librespot is the Connect DEVICE, and it runs whenever the
    // box has Spotify enabled, whether or not this app is open - that is what
    // lets a phone cast here and have `onCastStart` open the app. Stopping the
    // daemon would take the box off Spotify Connect until something started it
    // again, so closing the app would quietly cost the household the feature.
    //
    // Gated on the BOX being the device that is playing, because the pause goes
    // to the account, not to the speaker: without the check, closing the app
    // here would stop the same account's music on somebody's phone in another
    // room. `boxPlayerState` answers both halves in one read, and answers
    // `box: false` for every case it cannot tell - no account linked, nobody we
    // know holding the player - which is the safe direction.
    appClosed() {
      spotifyApi
        .boxPlayerState()
        .then((s) => {
          if (!s || !s.box || !s.is_playing) return;
          host.log("spotify: the app was closed while the box was playing - pausing");
          return spotifyApi.control("pause");
        })
        .catch((e) => host.log("spotify: could not pause on close:", String(e.message || e)));
    },
    stop() {
      if (host.widget) host.widget.clear();
      autoplay.stop();
      stopLibrespot();
    },
  };
};

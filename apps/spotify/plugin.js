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

const SPOTIFY_HOOK = path.join(__dirname, "spotify_event_hook.sh"); // librespot --onevent target
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
          const score = (e) =>
            (want && Math.abs((e.duration || 0) - want) <= 7 ? 0 : 100) + (e.syncedLyrics ? 0 : 10);
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
  // One-shot OAuth token for the next librespot start: logs the Connect device
  // into the launcher's ACTIVE Web API account (the play path's "adopt" step), so
  // playback from the TV needs no prior phone cast. librespot caches the session
  // credentials, so this sticks across restarts; zeroconf stays on, so any phone
  // can still cast and take the box over as usual.
  let adoptToken = "";
  function spotifyDeviceName() {
    return (host.config.rawSpotify() || {}).deviceName || "tvbox";
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
      path.join(os.homedir(), ".tvbox", "librespot-cache"),
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
    if (adoptToken) args.push("--access-token", adoptToken);
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
    host.spawnService("librespot", {
      argv: librespotArgv, // recomputed each (re)start -> picks up rename + sink
      env: host.childEnv(),
      stdio: ["ignore", out, out],
      minUptimeMs: 5000,
      ceiling: 5,
      onGiveUp: () => spotify.clear(), // give up -> reset now-playing to idle
      log: (m) => host.log("librespot " + String(m).replace(/(--access-token)\s+\S+/, "$1 ***")), // never log the token
    });
  }
  // Killing the process emits no disconnect event, so reset now-playing to idle
  // whenever we tear it down ourselves.
  function stopLibrespot() {
    host.stopService("librespot");
    spotify.clear();
  }
  // Apply a new --name: respawn after a beat so the old instance releases its
  // zeroconf port + audio device before the new one binds.
  function restartLibrespot() {
    spotify.clear();
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

  // ---- play with adoption ----
  // If no linked account can see the box, the box's librespot is signed into
  // someone else's (or no) account. Instead of asking the user to cast first,
  // ADOPT: restart librespot with a fresh --access-token for the active account,
  // wait until the box shows up in that account's device list, then retry the
  // play. Skipped while a cast is actively playing (don't steal a live session).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function playOnBox(body) {
    let r = await spotifyApi.play(body);
    if (r.error !== "box_not_found") return r;
    if (spotify.getState().is_playing) return { ok: false, error: "in_use" };
    let token = "";
    try {
      token = await spotifyApi.activeAccessToken();
    } catch (e) {
      /* not connected */
    }
    if (!token) return r;
    host.log("spotify: adopting box into the active account");
    adoptToken = token;
    restartLibrespot();
    let seen = false;
    for (let i = 0; i < 12 && !seen; i++) {
      // librespot login + Connect registration can take a few seconds
      await sleep(1500);
      try {
        seen = !!(await spotifyApi.findBoxAccount());
      } catch (e) {
        /* keep polling */
      }
    }
    adoptToken = ""; // one-shot: after a successful login librespot's cached credentials take over
    if (!seen) {
      // token login failed (or too slow) — restore plain zeroconf so casting keeps working
      host.log("spotify: adoption failed; restoring discovery-only librespot");
      restartLibrespot();
      return { ok: false, error: "adopt_failed" };
    }
    return spotifyApi.play(body);
  }

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
      spotify.handleEvent(ctx.body || {});
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
      spotifyApi.removeAccount(String((ctx.body || {}).id || ""));
      host.json(res, { ok: true });
    },
    "POST /control": (req, res, ctx) => {
      spotifyApi
        .control(String((ctx.body || {}).action || ""))
        .then((r) => host.json(res, r))
        .catch((e) => host.json(res, { ok: false, error: String(e.message || e) }));
    },
    "POST /play": (req, res, ctx) => {
      const b = ctx.body || {};
      playOnBox({ contextUri: b.contextUri, uris: b.uris })
        .then((r) => host.json(res, r))
        .catch((e) => host.json(res, { ok: false, error: String(e.message || e) }));
    },
    "GET /auth/status": (req, res) => {
      spotifyApi
        .status()
        .then((s) => host.json(res, s))
        .catch(() => host.json(res, { configured: false, connected: false, user: "" }));
    },
    "GET /auth/start": (req, res) => host.json(res, startSpotifyAuth()),
    "GET /auth/callback": (req, res) => handleSpotifyCallback(req, res),
    "GET /liked": (req, res) => {
      spotifyApi
        .getLiked()
        .then((tracks) => host.json(res, { tracks }))
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
        .then((tracks) => host.json(res, { tracks }))
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
    page: (ctx) => renderTemplate(keyboardPageHtml, { lang: ctx.locale, ...(KEYBOARD_STR[ctx.locale] || KEYBOARD_STR.en) }),
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
      startLibrespot();
    },
    stop() {
      if (host.widget) host.widget.clear();
      stopLibrespot();
    },
  };
};

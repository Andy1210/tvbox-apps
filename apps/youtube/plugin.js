// tvbox YouTube plugin - the cast receiver for the app, loaded by the shell at boot
// whether or not the app is open. That is the whole point: a phone can only cast to
// a television it can find, and it has to be findable while nothing is on screen.
//
// What happens on a cast: the phone finds the box over SSDP, POSTs a DIAL launch
// request carrying a pairing code, and this plugin opens the app at
// youtube.com/tv?pairingCode=… - YouTube's own TV page is what joins the phone's
// session from there. Nothing here speaks to YouTube, holds a token, or plays
// anything.
//
// It is a switch, not a consequence of installing the app: `switches` in the
// manifest puts "Cast from phone" in Settings -> Apps -> App settings, and the box
// advertises nothing while it is off.
const crypto = require("crypto");
const os = require("os");
const { createDialReceiver } = require("./lib/dial");

const APP_ID = "youtube";
const DIAL_APP = "YouTube"; // the name senders address; case is part of it
const SWITCH = "cast";
// What reaches the television, in the language the box is set to (`host.config`
// carries it - every other plugin in the registry does the same). Short: it is a
// corner overlay, not a dialog. The cast note says who did it, because the person in
// the room did not; the failure note says what to do about it, because "it did not
// start" is not actionable on its own.
const STR = {
  hu: {
    castTitle: "Átküldés telefonról",
    cast: "Valaki a telefonjáról indított egy videót – a YouTube átveszi a képernyőt.",
    fail: "Nem indult el, így a box most nem látszik a telefonokon. Kapcsold ki, majd be a beállítást.",
  },
  en: {
    castTitle: "Cast from phone",
    cast: "Someone started a video from their phone - YouTube is taking the screen.",
    fail: "It did not start, so the box will not show up on phones. Turn the setting off and on again.",
  },
};
// A port worth asking for rather than one worth relying on: it travels inside the
// LOCATION a sender reads, so a taken port costs nothing (dial.js falls back to any
// free one). Kept clear of 8008/8009, which are Cast's.
const PREFERRED_PORT = 17954;

// What the phone lists. The hostname is what the household already calls the box
// (tvbox-livingroom), and it is what its Plex client and its Spotify device are
// named after, so a cast list that says something else would be a fourth name for
// one television.
function boxName() {
  return String(os.hostname() || "tvbox").replace(/\.local$/i, "");
}

// A device id a phone can remember. Derived from the hostname rather than random,
// because a receiver that changes identity on reboot shows up as a second, dead
// television in the phone's list.
function deviceUuid() {
  const h = crypto
    .createHash("sha1")
    .update("tvbox-dial:" + os.hostname())
    .digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), "5" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
}

module.exports = (host) => {
  let dial = null;

  const castOn = () => {
    try {
      return !!host.switchOn(SWITCH);
    } catch (e) {
      // An older shell has no manifest switches. Advertising in that case would be a
      // feature nobody could turn off, so the receiver stays down instead.
      return false;
    }
  };

  // Whether the app is on screen, which is what DIAL means by "running". A shell
  // without appState is old enough not to have the per-launch url either, so a cast
  // could not reach the page anyway - answering "stopped" keeps the sender's
  // behaviour honest for what this build can actually do.
  const onScreen = () => {
    try {
      return !!(host.appState && host.appState(APP_ID).foreground);
    } catch (e) {
      return false;
    }
  };

  // The box's language, for the two sentences below. Falls back to English like the
  // other plugins in the registry; an older shell without uiLocale gets English too.
  function str() {
    let locale = "";
    try {
      locale = String((host.config && host.config.uiLocale && host.config.uiLocale()) || "");
    } catch (e) {
      locale = "";
    }
    return locale.startsWith("hu") ? STR.hu : STR.en;
  }

  function open(launchData) {
    // The launch body IS the query: `pairingCode=<uuid>&theme=cl`. The shell bounds
    // it (withLaunchQuery) and can only ever put it on the manifest's own url, so
    // there is nothing to sanitize here that it would not sanitize again.
    host.log("youtube: cast -> opening the app");
    // Was anybody watching anything? Asked BEFORE the launch, because the launch is
    // what changes the answer.
    let interrupting = false;
    try {
      interrupting = host.idle ? !host.idle() : false;
    } catch (e) {
      interrupting = false;
    }
    // Whether the app actually came up decides what the sender is told (a phone
    // connected to a television that is doing nothing is the worst answer). An
    // older shell returns undefined here, which reads as "cannot tell" rather than
    // as a failure.
    const opened = host.navTo(APP_ID, { query: String(launchData || "") });
    // A note in the room only when the cast took the screen from something. AFTER
    // the launch, because that is what wakes a panel that was off - a note shown to
    // a dark television has faded by the time it can be read, and nobody's viewing
    // was interrupted in that case anyway.
    if (opened !== false && interrupting) {
      const s = str();
      try {
        host.notify({ title: s.castTitle, message: s.cast, duration: 5000 });
      } catch (e) {
        /* an older shell has no notify; a cast must not fail on a toast */
      }
    }
    return opened !== false;
  }

  function start() {
    if (dial || !castOn()) return;
    dial = createDialReceiver({
      app: DIAL_APP,
      friendlyName: boxName,
      uuid: deviceUuid(),
      port: PREFERRED_PORT,
      isRunning: onScreen,
      onLaunch: open,
      log: (m) => host.log("youtube: " + m),
    });
    dial.start((e) => {
      if (!e) return;
      host.log("youtube: cast receiver did not start: " + e.message);
      const d = dial;
      dial = null;
      if (d) d.stop();
      // Otherwise the switch reads ON while no phone can see the box, and the only
      // trace is a line in a log nobody on a sofa will read.
      const s = str();
      try {
        host.notify({ title: s.castTitle, message: s.fail, duration: 10000 });
      } catch (x) {
        /* best effort */
      }
    });
  }

  function stop() {
    const d = dial;
    dial = null;
    if (d) d.stop();
  }

  // Settings writes the switch, and the box has to follow it without a restart. The
  // shell names the sections that changed, but the state is RE-READ rather than
  // matched against them: what matters is the value now in force, and re-reading it
  // costs one config load.
  // Guarded like the two calls above, and for the same reason: an older shell has
  // no onConfigChange, and a plugin factory that throws is a plugin the shell drops
  // entirely - the switch would then be a row that does nothing, with the app's tile
  // still on HOME.
  try {
    host.onConfigChange(() => {
      if (castOn()) start();
      else stop();
    });
  } catch (e) {
    host.log("youtube: this shell cannot report config changes; the switch needs a restart");
  }

  return { start, stop };
};

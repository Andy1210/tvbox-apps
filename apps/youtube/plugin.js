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

  function open(launchData) {
    // The launch body IS the query: `pairingCode=<uuid>&theme=cl`. The shell bounds
    // it (withLaunchQuery) and can only ever put it on the manifest's own url, so
    // there is nothing to sanitize here that it would not sanitize again.
    host.log("youtube: cast -> opening the app");
    host.navTo(APP_ID, { query: String(launchData || "") });
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
  host.onConfigChange(() => {
    if (castOn()) start();
    else stop();
  });

  return { start, stop };
};

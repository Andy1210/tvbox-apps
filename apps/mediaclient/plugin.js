// tvbox media client plugin - the box's Plex player while the app is not open.
//
// A phone can only cast to a television it can find, and a Plex player is
// findable only while something polls the server for commands. That something
// used to be the app's own page, so the box was a player only after somebody
// had walked to the television and opened it - the one thing casting exists to
// avoid, and not how this box's other receivers work: YouTube's DIAL listener
// and Spotify's librespot both live in the shell and are up whether or not
// their app is.
//
// So the receiver is out here, and it does exactly two things: be reachable,
// and get out of the way. A cast opens the app and is handed to it; this file
// holds no player and decides no track.
//
// Exactly one of the two polls at a time. They share the app's client
// identifier - they are the same player - and two pollers take each other's
// commands, so this one stands down while the app is running and comes back
// when it is not.
const path = require("path");
const os = require("os");
const { startCompanion, readSession, leaveCast } = require("./lib/companion");

const APP_ID = "mediaclient";
const STORE = path.join(os.homedir(), ".tvbox", "appdata", APP_ID + ".json");
/** How often to look at whether this should be listening at all. */
const WATCH_MS = 15_000;
/** A moment after boot: the shell is busiest then, and a poll can wait. */
const START_DELAY_MS = 10_000;

module.exports = (host) => {
  let timer = null;
  let stopCompanion = null;
  let handedOver = false;

  const appRunning = () => {
    try {
      return !!(host.appState && host.appState(APP_ID).running);
    } catch (e) {
      // An older shell cannot say, and guessing "running" would keep this
      // silent for ever. Guess the other way: two pollers cost a retry, a
      // missing one costs the feature.
      return false;
    }
  };

  const stopListening = () => {
    const s = stopCompanion;
    stopCompanion = null;
    if (s) s();
  };

  /**
   * A cast arrived while the app was not running.
   *
   * The command is left in the app's own store and the app is opened; it runs it
   * once its page is up, which is also when its own poll takes over from this
   * one. Returning true tells the receiver to stand down.
   *
   * Everything but a cast is refused rather than launched: a phone asking a
   * sleeping television to pause is asking about something that is not
   * happening, and answering by turning the app on would be a box that wakes up
   * to do nothing.
   */
  const onCommand = (cmd) => {
    if (String(cmd.path || "") !== "/player/playback/playMedia") return false;
    if (!leaveCast(STORE, cmd)) {
      host.log("mediaclient: could not leave the cast for the app to pick up");
      return false;
    }
    handedOver = true;
    host.log("mediaclient: a cast arrived with the app closed - opening it");
    const opened = host.navTo(APP_ID);
    if (opened === false) {
      handedOver = false;
      host.log("mediaclient: the box would not open the app for a cast");
      return false;
    }
    return true;
  };

  const tick = () => {
    timer = setTimeout(tick, WATCH_MS);
    // The app is up: it is the player, and this must not be.
    if (appRunning()) {
      handedOver = false;
      return stopListening();
    }
    // Handed a cast a moment ago; the window is still coming up.
    if (handedOver || stopCompanion) return;
    // Re-read every tick rather than once. This is also where the app's own
    // "Cast from phone" setting lives, so turning it off in Settings takes the
    // box off the list within a tick and turning it back on brings it back,
    // with no restart. `readSession` answers null for both "nobody has signed
    // in" and "the household said no".
    const found = readSession(STORE);
    if (!found) return;
    stopCompanion = startCompanion({
      ...found,
      onCommand,
      log: (m) => host.log("mediaclient: " + m),
    });
    host.log("mediaclient: listening for a cast");
  };

  return {
    start() {
      if (timer) clearTimeout(timer);
      handedOver = false;
      timer = setTimeout(tick, START_DELAY_MS);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      stopListening();
    },
  };
};

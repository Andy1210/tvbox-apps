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
// What the room is told when a phone takes the screen, in the box's language.
// Short: it is a corner overlay, not a dialog. It says who did it, because the
// person sitting there did not - and this path is the one with no warning at
// all, since the app was closed a moment ago.
const STR = {
  hu: {
    title: "Átküldés telefonról",
    took: "Valaki a telefonjáról küldött ide valamit – a médiaapp átveszi a képernyőt.",
  },
  en: {
    title: "Cast from phone",
    took: "Someone sent this from their phone - the media app is taking the screen.",
  },
};
const STORE = path.join(os.homedir(), ".tvbox", "appdata", APP_ID + ".json");
/** How often to look at whether this should be listening at all. */
const WATCH_MS = 15_000;
/** A moment after boot: the shell is busiest then, and a poll can wait. */
const START_DELAY_MS = 10_000;

module.exports = (host) => {
  let timer = null;
  let stopCompanion = null;
  let handedOver = false;
  /**
   * Whether the app's own poll is live.
   *
   * The app says so itself, over the routes below, and that word is what this
   * receiver stands down on. Guessing was the bug: it stood down the instant it
   * handed a cast over, while the app's page took a few seconds to boot - and a
   * phone sends `subscribe` immediately after casting, into a gap where nobody
   * was polling. The server held that command until it timed out, so the phone
   * spun, gave up, and only stuck on a second try; sometimes it fell back to
   * playing the song on the phone itself.
   */
  let appPolling = false;

  function str() {
    let locale = "";
    try {
      locale = String((host.config && host.config.uiLocale && host.config.uiLocale()) || "");
    } catch (e) {
      locale = "";
    }
    return locale.startsWith("hu") ? STR.hu : STR.en;
  }

  /** `leaving` = for good, so the account is told this box is no longer a
   *  player. A handover is not leaving: the app registers again at once. */
  const stopListening = (leaving) => {
    const s = stopCompanion;
    stopCompanion = null;
    if (s) s(!!leaving);
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
  // Who the receiver is currently signed in as, for the stash.
  let session = null;

  const onCommand = (cmd) => {
    const p = String(cmd.path || "");
    // A phone that has just found the box subscribes BEFORE it casts, and the
    // app's own receiver records what refusing that costs: the server answers
    // the refusal 400 and the phone gives up - "it appears in the list but will
    // not connect". Nothing has to be pushed for it either, because the player
    // that answers from here is not playing anything; the app publishes its own
    // state the moment it takes over.
    if (p === "/player/timeline/subscribe" || p === "/player/timeline/unsubscribe") return "ok";
    if (p !== "/player/playback/playMedia") return false;
    // Stashing a command for an app whose poll is already live leaves it in the
    // store unread - the app picks one up when it OPENS, not when it resumes -
    // and that app can answer for itself anyway. Refused, so the controller sees
    // a failure it can retry rather than a success that played nothing.
    if (appPolling) {
      host.log("mediaclient: the app took the poll while a cast was arriving; letting the controller retry");
      return false;
    }
    if (!leaveCast(STORE, cmd, session.profileId)) {
      host.log("mediaclient: could not leave the cast for the app to pick up");
      return false;
    }
    // NOT a stand-down. The receiver keeps answering until the app says its own
    // poll is live, because everything a phone sends in between - the subscribe
    // it sends right after a cast, above all - would otherwise reach nobody.
    handedOver = true;
    host.log("mediaclient: a cast arrived with the app closed - opening it");
    // Asked BEFORE the launch, because the launch is what changes the answer.
    let interrupting = false;
    try {
      interrupting = host.idle ? !host.idle() : false;
    } catch (e) {
      interrupting = false;
    }
    const opened = host.navTo(APP_ID);
    if (opened === false) {
      handedOver = false;
      host.log("mediaclient: the box would not open the app for a cast");
      return false;
    }
    // Only when it took the screen from something. Opening the app ends a
    // native app - a game, with whatever was unsaved in it - and stops another
    // app's film, and nobody in the room asked for that.
    if (interrupting) {
      const s = str();
      try {
        host.notify({ title: s.title, message: s.took, duration: 5000 });
      } catch (e) {
        /* an older shell has no notify; a cast must not fail on a toast */
      }
    }
    return true;
  };

  const tick = () => {
    timer = setTimeout(tick, WATCH_MS);
    // The app's own poll is live: it is the player, and this must not be.
    if (appPolling) {
      handedOver = false;
      return stopListening(false);
    }
    // A window with no live poll is not a player - it may be booting, or
    // sitting on the profile picker, or signed out. Keep answering for it.
    if (stopCompanion) return;
    // Re-read every tick rather than once. This is also where the app's own
    // "Cast from phone" setting lives, so turning it off in Settings takes the
    // box off the list within a tick and turning it back on brings it back,
    // with no restart. `readSession` answers null for both "nobody has signed
    // in" and "the household said no".
    const found = readSession(STORE);
    if (!found) return;
    session = found;
    stopCompanion = startCompanion({
      ...found,
      onCommand,
      log: (m) => host.log("mediaclient: " + m),
      // A refused credential ends the loop, and without this the handle stayed
      // set - so the next tick saw "already listening" and the box quietly
      // stopped being a player until the shell restarted, with the setting
      // still reading on. Cleared instead, so the next tick re-reads the store
      // and tries again with whatever is in it.
      // Whichever way the loop ends, the handle has to go with it or the next
      // tick reads it as "already listening" for the life of the box.
      onEnded: () => {
        stopCompanion = null;
      },
    });
    host.log("mediaclient: listening for a cast");
  };

  // The app's word on who is polling. One local round trip, and it is what
  // closes the handover gap: the app says "mine" BEFORE it starts its loop and
  // "yours" when it tears one down, so the two never both poll and never both
  // stay silent.
  host.registerRoutes("/tvbox/api/mediaclient", {
    "POST /poll-taken": (req, res) => {
      appPolling = true;
      stopListening(false);
      host.json(res, { ok: true });
    },
    "POST /poll-released": (req, res) => {
      appPolling = false;
      // Straight away rather than at the next tick: the app has just stopped
      // answering, and until this receiver does the box is not a player.
      tick();
      host.json(res, { ok: true });
    },
  });

  return {
    start() {
      if (timer) clearTimeout(timer);
      handedOver = false;
      timer = setTimeout(tick, START_DELAY_MS);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      stopListening(true);
    },
  };
};

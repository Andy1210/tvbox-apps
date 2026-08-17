// tvbox media client plugin - one job: make the box castable before anybody has
// opened the app.
//
// The app IS the Plex player. It registers this box with the account, polls the
// server for commands, and answers them - all from its page, which only exists
// while the app is running. So a box that had been rebooted was not a player at
// all: a phone offered nothing to cast to until somebody walked to the
// television and opened the media client, which is the one thing casting exists
// to avoid.
//
// So the shell starts it hidden (`host.startHidden`, tvbox >= 3.7.0). It is an
// ordinary background app from then on: it costs a window, the box may evict it
// under memory pressure, Home brings it forward, and quitting it from the
// Running row really quits it.
//
// Nothing here speaks Plex. The credentials, the poll and the protocol all live
// in the page, where they already were - this only decides WHEN that page exists.
const APP_ID = "mediaclient";

// A moment after the shell is up, not with it. Boot is the busiest the box ever
// is - the launcher is loading, plugins are starting, the registry is being
// read - and a second Chromium window in the middle of that costs the launcher's
// own first paint, which is the one thing somebody is watching at that moment.
const START_DELAY_MS = 20_000;
// And only while the box is doing nothing. A box that came up into a film (or
// into a game holding the GPU) has better uses for 300 MB than a page nobody has
// asked for yet; it is retried rather than dropped.
const RETRY_MS = 60_000;
// Given up on after this long. Something is playing for an hour, so the box is
// in use and the app can start when whoever is using it opens it.
const GIVE_UP_MS = 60 * 60_000;

module.exports = (host) => {
  let timer = null;
  let waitedMs = 0;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const tryStart = () => {
    timer = null;
    // An older shell has neither call. Nothing is lost: the box behaves as it
    // did before, i.e. castable once somebody opens the app.
    if (typeof host.startHidden !== "function") {
      host.log("mediaclient: this shell cannot start an app hidden; the box is castable once the app is opened");
      return;
    }
    let alive = false;
    try {
      alive = !!(host.appState && host.appState(APP_ID).running);
    } catch (e) {
      alive = false;
    }
    // Somebody opened it first, which is the outcome this was for.
    if (alive) return;

    let free = true;
    try {
      free = host.idle ? !!host.idle() : true;
    } catch (e) {
      free = true;
    }
    if (!free) {
      waitedMs += RETRY_MS;
      if (waitedMs >= GIVE_UP_MS) {
        host.log("mediaclient: the box has been busy for an hour; not starting the player in the background");
        return;
      }
      timer = setTimeout(tryStart, RETRY_MS);
      return;
    }

    try {
      host.startHidden(APP_ID);
    } catch (e) {
      host.log("mediaclient: could not start hidden: " + (e && e.message));
    }
  };

  return {
    start() {
      stop();
      waitedMs = 0;
      timer = setTimeout(tryStart, START_DELAY_MS);
    },
    stop,
  };
};

// A saved Spotify login that Spotify no longer accepts, and how the box gets out
// of it by itself.
//
// librespot caches the session credentials it was last logged in with
// (<cache>/credentials.json) and uses them on every start. When that blob goes
// stale the failure is the worst shape there is: the AP handshake still SUCCEEDS
// ("Authenticated as '…'"), and the Connect registration a step later does not -
//
//   ERROR librespot] could not initialize spirc:
//     Invalid state { Login request was denied: INVALID_CREDENTIALS }
//
// - so librespot exits 1 BEFORE it publishes its zeroconf service. The box then
// vanishes from every phone's device list, nothing can be cast to it, and the
// file that causes it survives a reboot, so the box never comes back on its own.
// Measured on tvbox-livingroom 2026-08-23: 52 consecutive failures over six
// hours, through a reboot, while the same account worked on the other box.
//
// The supervisor cannot see any of this - an exit code of 1 reads exactly like a
// missing binary - so it keeps retrying the same poisoned file once a minute
// forever. This module reads the daemon's own output instead and, once it is sure,
// moves the credentials aside so the next start comes up in discovery-only mode:
// a Connect speaker with no account, which is what a fresh box is, and which any
// phone can log in again by casting to it once.
//
// Four bounds, and each one is a way of being wrong that costs more than the bug:
//
//   - A start that carried --access-token is IGNORED: librespot uses the token
//     INSTEAD of the cached credentials, so the denial is about the token and
//     throwing away a good saved login for it would cost the user the account
//     features they were trying to use. Nothing passes `withToken: true` any
//     more - the start that did was the "adopt" step, removed once it was
//     measured to be the CAUSE of this failure rather than a bystander: a
//     third-party app's token is always refused at Connect registration, and
//     librespot writes the token-derived credential into credentials.json before
//     being refused, which is what turned a working login into a rejected one.
//     The bound stays because the option does, and a poisoned file from an older
//     build is exactly what this module still has to clean up.
//   - TWO consecutive denials, not one. A single denial could be Spotify's own
//     answer to a bad moment; two, seconds apart, with the same blob, is the blob.
//     The wait costs about six seconds.
//   - Only INVALID_CREDENTIALS. login5 denies for transient reasons too
//     (TRY_AGAIN_LATER), and a box that clears its login every time the service
//     hiccups is worse than one that waits.
//   - A bounded number of heals per shell run, one fixed backup slot. The moved
//     file is kept rather than deleted (it is the only evidence of what failed),
//     but a loop must not fill the cache directory with them.
//
// A published zeroconf service means the daemon got past all of this, so it
// clears the strikes: the count is about ONE bad file, not about the box's life.

const REJECTION = "INVALID_CREDENTIALS";
const PUBLISHED = "Published zeroconf service";
// The supervisor's own line for a child that has gone (service_supervisor.js
// prints "exited code <n> sig <s>"), matched WHOLE rather than by prefix.
//
// It lives here because this is already the module that reads the daemon's
// output, and because it needs to be checkable offline: the plugin acts on it by
// clearing the box's now-playing claim and its cached device id.
//
// A daemon line normally cannot be mistaken for it - env_logger prefixes each
// with "[<ts> LEVEL target]" - but "normally" is doing work there, and the shape
// of the exception is worth naming: the supervisor splits the child's stderr on
// newlines and trims each fragment, so a multi-line record can produce one with
// no prefix at all. Hence the exact form, which a librespot line cannot take
// without also carrying a plausible exit code and signal.
const SUPERVISOR_EXIT = /^exited code (\d+|null) sig (\S+)$/;

// The saved login was refused. Narrow on purpose - see the bounds above.
function isCredentialRejection(line) {
  return String(line || "").includes(REJECTION);
}

// The daemon is up and discoverable. True for a discovery-only start as well as
// a logged-in one, which is what makes it a usable "we are past the login" mark.
function isUp(line) {
  return String(line || "").includes(PUBLISHED);
}

// The daemon has gone, by any route the supervisor reports.
function isSupervisorExit(line) {
  return SUPERVISOR_EXIT.test(String(line || "").trim());
}

// deps: { fs, path, cacheDir, log, threshold, maxHeals }
function createCredGuard(deps) {
  const fs = deps.fs;
  const path = deps.path;
  const cacheDir = deps.cacheDir;
  const log = deps.log || (() => {});
  const threshold = deps.threshold || 2;
  const maxHeals = deps.maxHeals || 3;
  const file = () => path.join(cacheDir, "credentials.json");
  const backup = () => path.join(cacheDir, "credentials.json.rejected");

  let strikes = 0;
  let heals = 0; // completed resets, and nothing else - see gaveUpLogged
  let saidMissing = false;
  let gaveUpLogged = false;

  // Feed every line of the daemon's output through here. `withToken` says whether
  // the instance that produced it was started with --access-token.
  // Returns true exactly when the cached credentials were moved aside.
  function note(line, opts) {
    if (isUp(line)) {
      strikes = 0;
      return false;
    }
    if (!isCredentialRejection(line)) return false;
    // The token was refused, not the file. Deliberately does not touch the
    // strikes either: an adoption is a separate question from a poisoned cache.
    if (opts && opts.withToken) return false;
    strikes++;
    if (strikes < threshold) return false;
    strikes = 0;
    if (heals >= maxHeals) {
      // A latch of its own rather than one more heal: a stuck box has to log the
      // reason once instead of a line per start, and counting that as a reset
      // would make the number this reports a different thing from the number of
      // times credentials were actually cleared.
      if (!gaveUpLogged) {
        gaveUpLogged = true;
        log("saved login refused again after " + maxHeals + " resets - leaving it alone");
      }
      return false;
    }
    let exists = false;
    try {
      exists = fs.existsSync(file());
    } catch (e) {
      exists = false;
    }
    if (!exists) {
      // Nothing cached, no token, and still refused: not something this can fix,
      // and worth saying once rather than on every start.
      if (!saidMissing) {
        saidMissing = true;
        log("login refused with no saved credentials to clear");
      }
      return false;
    }
    try {
      fs.renameSync(file(), backup());
    } catch (e) {
      log("could not clear the refused login: " + e.message);
      return false;
    }
    heals++;
    log(
      "saved login refused by Spotify - moved it to credentials.json.rejected; " +
        "coming back as a Connect speaker, cast to the box once to sign it in again",
    );
    return true;
  }

  return { note, stats: () => ({ strikes, heals }) };
}

module.exports = { createCredGuard, isCredentialRejection, isUp, isSupervisorExit };

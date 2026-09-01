// One saved librespot login per linked account, so the box can sign in as the
// account whose library is on screen.
//
// librespot keeps exactly ONE session credential (<cache>/credentials.json,
// written on every successful login) and signs in with it on every start. On a
// household box with two linked accounts that file belongs to whoever cast last,
// which is not necessarily the account the launcher is browsing - and there is no
// way to mint a new one from our side: librespot's --access-token is refused at
// Connect registration (login5 registers a device for Spotify's own client id,
// not for a third-party app's token) and overwrites the working file on the way.
// So the only credential this box can sign in with is one Spotify itself wrote
// here, and the only place to keep several is beside the live one.
//
// The blob is stable across a login - a restart re-authenticates and rewrites the
// same bytes (verified on this fleet) - so a copy taken while an account was
// signed in stays usable after another account has taken the file over. That is
// what makes a vault possible at all; without it, switching accounts on the TV
// would still need a phone cast.
//
// Four things shape this module:
//
//   - A file is attributed by the `username` INSIDE it, never by who we think was
//     signing in. That field is the account id the Web API uses (verified on this
//     fleet: it equals both the id in spotify-accounts.json and the USER_NAME
//     librespot reports on session_connected), so a copy cannot be filed under
//     the wrong account by a lost or late event.
//   - The id has to be a safe file name before it is joined onto a path, and it
//     comes from a JSON file we did not write. Anything outside the Spotify id
//     charset is refused rather than sanitised - a name that needed repair is a
//     file we should not be reading.
//   - Credentials, so 0700 on the directory and 0600 on every file, and a write is
//     a temp file + fsync + rename: a half-written credentials.json is a box that
//     cannot sign in at all, and this module's whole job is not being that.
//   - Putting a login in place ARCHIVES the one it displaces first. That is the
//     only copy of the displaced account's login, and the caller needs it to put
//     the box back if the new one turns out to be refused.
//
// No require()s: fs and path are injected so every branch is checkable offline.

// Spotify account ids are base62; older canonical usernames also carry dots,
// hyphens and underscores. Length-bounded because this becomes a file name.
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LIVE = "credentials.json";
// The file the credential guard moves a refused login to. Read here so a heal can
// name the account whose saved login Spotify rejected.
const REJECTED = "credentials.json.rejected";

// A valid account id, safe as a file name. The two dot names match the charset
// and would resolve to a directory, so they are excluded by name.
function validId(id) {
  const s = String(id || "");
  return s !== "." && s !== ".." && ID_RE.test(s);
}

// deps: { fs, path, cacheDir, log }
function createCredVault(deps) {
  const fs = deps.fs;
  const path = deps.path;
  const cacheDir = deps.cacheDir;
  const log = deps.log || (() => {});
  const dir = () => path.join(cacheDir, "logins");
  const live = () => path.join(cacheDir, LIVE);
  const slot = (id) => path.join(dir(), id + ".json");

  // The account a credentials file belongs to, and the bytes to copy. Returns
  // null for anything that is not one: no file, unreadable, not JSON, or a
  // username this cannot use. A parse failure is not logged - a box that has
  // never been signed in has no file, and that is an ordinary state.
  function readCred(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      return null;
    }
    let user = "";
    try {
      user = String((JSON.parse(raw) || {}).username || "");
    } catch (e) {
      return null;
    }
    return validId(user) ? { raw, user } : null;
  }

  // Which account the box is signed in as (or will be on its next start), read
  // from the live file. "" means there is nothing to sign in with, which is a
  // different answer from "somebody else": a caller must not read it as one.
  function owner() {
    const c = readCred(live());
    return c ? c.user : "";
  }

  // Is there a login in place at all? Only a real ENOENT counts as no: a file this
  // cannot READ is still a file, and the difference decides whether `use` may
  // overwrite it.
  function liveExists() {
    try {
      fs.accessSync(live(), fs.constants.F_OK);
      return true;
    } catch (e) {
      return e.code !== "ENOENT";
    }
  }

  function has(id) {
    if (!validId(id)) return false;
    try {
      fs.accessSync(slot(id), fs.constants.F_OK);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Which accounts this box can sign in as without a cast.
  function list() {
    let names = [];
    try {
      names = fs.readdirSync(dir());
    } catch (e) {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -5))
      .filter(validId)
      .sort(); // readdir order is the filesystem's; a caller choosing one must not be
  }

  // Write `raw` to `file` so that a reader either sees the previous content or all
  // of the new: a truncated credentials.json is a box that cannot sign in, and the
  // rename can otherwise reach the disk before the bytes it points at.
  // The vault's own directory, and only ever that: `writeAtomic` deliberately
  // creates no directory, so nothing here can widen or tighten the librespot cache
  // dir the live file sits in - that one is librespot's.
  function ensureVaultDir() {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir(), 0o700); // mkdir's mode does not tighten a directory that exists
    } catch (e) {
      /* not ours to fix; the file mode below is what protects the blob */
    }
  }

  function writeAtomic(file, raw) {
    const tmp = file + ".tmp";
    try {
      // "wx" and an unlink first, because the path is predictable: a symlink left
      // at it would otherwise be followed, and the credential written wherever it
      // points - a file this box serves over its own origin, say.
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        /* the ordinary case: there is nothing there */
      }
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, raw);
        // On the descriptor, not the path: a chmod by name follows a symlink, and
        // between the create and the mode this path is predictable. This is a
        // credential, and the mode has to hold whatever the umask stripped.
        fs.fchmodSync(fd, 0o600);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch (e2) {
        /* nothing left to clean up */
      }
      log("could not write " + path.basename(file) + ": " + e.message);
      return false;
    }
  }

  // Keep a copy of the live login under the account it belongs to. Returns that
  // account's id, or "" if there was nothing to copy.
  //
  // Called whenever a login may have changed (shell start, a cast naming an owner)
  // and before every swap, rather than on a file watch: the file is
  // self-describing, so a late archive still files it correctly and a missed one
  // costs only the next opportunity.
  function archive() {
    return copyToVault(readCred(live())).id;
  }

  // The copy itself. Returns the account and whether the vault now holds this
  // exact blob — which the two answers "there was nothing to copy" and "the copy
  // could not be written" must not share: a caller that is about to REPLACE the
  // live login has to refuse when it could not keep it, or it destroys a
  // household member's only login on this box (a full card, a read-only card, a
  // stray root-owned file are all enough).
  function copyToVault(c) {
    if (!c) return { id: "", saved: false };
    const existing = readCred(slot(c.user));
    if (existing && existing.raw === c.raw) return { id: c.user, saved: true }; // already vaulted
    try {
      ensureVaultDir();
    } catch (e) {
      log("could not make the logins directory: " + e.message);
      return { id: c.user, saved: false };
    }
    if (!writeAtomic(slot(c.user), c.raw)) return { id: c.user, saved: false };
    log("saved the Spotify login for " + c.user + " so the box can sign back in as them");
    return { id: c.user, saved: true };
  }

  // Put `id`'s saved login in place as the one librespot will use. The caller
  // restarts the daemon; nothing here touches it.
  //
  // `displaced` is the account whose login this replaced, archived just now, so a
  // login that turns out to be refused can be undone. A slot whose content names a
  // different account is refused rather than used: that can only come from an
  // edited or truncated vault, and signing the box in as somebody nobody asked for
  // is the one outcome this module exists to prevent.
  function use(id) {
    if (!validId(id)) return { ok: false, displaced: "" };
    const c = readCred(slot(id));
    if (!c) return { ok: false, displaced: "" };
    if (c.user !== id) {
      log("the saved login filed under " + id + " belongs to " + c.user + " - not using it");
      return { ok: false, displaced: "" };
    }
    const liveCred = readCred(live());
    // A file that is THERE but cannot be attributed - unreadable, not JSON, a
    // username outside the charset, a field name a future librespot renames - is
    // not the same as no login at all, and `readCred` answers null to both. Taken
    // as "nothing to keep", it was overwritten: the only copy of somebody's login,
    // gone, with `displaced: ""` telling the caller there was nothing to put back.
    if (!liveCred && liveExists()) {
      log("not signing in as " + id + ": there is a login in place that this cannot read");
      return { ok: false, displaced: "" };
    }
    const kept = copyToVault(liveCred);
    if (kept.id === id) return { ok: true, displaced: kept.id }; // already in place
    if (kept.id && !kept.saved) {
      // There is a login in place and this could not keep a copy of it. Replacing
      // it now would be the one unrecoverable thing here.
      log("not signing in as " + id + ": the login for " + kept.id + " could not be saved first");
      return { ok: false, displaced: "" };
    }
    if (!writeAtomic(live(), c.raw)) return { ok: false, displaced: kept.id };
    return { ok: true, displaced: kept.id };
  }

  // Forget an account's saved login: it was refused, or the account was unlinked
  // from the box. Returns whether there was one.
  function drop(id) {
    if (!validId(id)) return false;
    try {
      fs.unlinkSync(slot(id));
      log("dropped the saved Spotify login for " + id);
      return true;
    } catch (e) {
      return false;
    }
  }

  // The account whose login the credential guard has just moved aside, dropped
  // from the vault as well. Spotify refused that exact blob, so the copy is no
  // better than the original and a retry would only take the box down again.
  // Read from the rejected file rather than from what we remember signing in as:
  // the file says whose it was, and a heal can also be triggered by a login this
  // process never put there.
  function dropRejected() {
    const c = readCred(path.join(cacheDir, REJECTED));
    if (!c) return "";
    return drop(c.user) ? c.user : "";
  }

  return { owner, has, list, archive, use, drop, dropRejected };
}

module.exports = { createCredVault, validId };

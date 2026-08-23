// When the box clears its own saved Spotify login, and - mostly - when it must
// not. Every line fed in here is a real line from the tvbox-livingroom incident
// of 2026-08-23, verbatim, so a change in librespot's log format fails this test
// rather than quietly switching the recovery off.
//
// The whole point is asymmetry: not clearing a dead login costs a box that is
// invisible to every phone until a human notices (six hours and a reboot, that
// time), while clearing a live one costs the account features until someone casts
// to the box again. So the guard has to be sure, and most of these assertions are
// about the second kind of mistake.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const { createCredGuard, isCredentialRejection, isUp } = require("./credguard");

// The measured lines. The denial is the one that killed the box; the AP line
// above it is what makes the failure so misleading (the login DID work, one step
// earlier), and is here to prove it is not itself taken for a failure.
const DENIED =
  "[2026-08-23T09:22:59Z ERROR librespot] could not initialize spirc: Invalid state { Login request was denied: INVALID_CREDENTIALS }";
const AUTHED = "[2026-08-23T09:22:59Z INFO  librespot_core::session] Authenticated as '11124899563' !";
const PUBLISHED = "[2026-08-23T09:27:09Z INFO  librespot_discovery] Published zeroconf service";
const TRANSIENT =
  "[2026-08-02T15:38:54Z ERROR librespot] could not initialize spirc: Service unavailable { client error (Connect) }";
const SPAWN = "spawn: librespot --name tvbox-livingroom --device-type tv --backend pulseaudio";
const EXITED = "exited code 1 sig null";

function box(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-credguard-"));
  const logs = [];
  const guard = createCredGuard({
    fs,
    path,
    cacheDir: dir,
    log: (m) => logs.push(m),
    ...(opts || {}),
  });
  const cred = path.join(dir, "credentials.json");
  const kept = path.join(dir, "credentials.json.rejected");
  fs.writeFileSync(cred, '{"username":"11124899563","auth_type":1,"auth_data":"saved-blob"}');
  return { dir, guard, logs, cred, kept };
}

test("two denials clear the saved login, and keep it as evidence", () => {
  const b = box();
  assert.equal(b.guard.note(DENIED, {}), false, "one denial is not enough");
  assert.equal(fs.existsSync(b.cred), true);
  assert.equal(b.guard.note(DENIED, {}), true, "the second one acts");
  assert.equal(fs.existsSync(b.cred), false, "librespot must start with no cached login");
  assert.match(fs.readFileSync(b.kept, "utf8"), /saved-blob/, "the refused blob is kept, not deleted");
  assert.match(b.logs.join("\n"), /cast to the box once/, "the log says what the user has to do");
});

test("the lines around the denial are not denials", () => {
  const b = box();
  for (const line of [AUTHED, SPAWN, EXITED, TRANSIENT, PUBLISHED]) {
    assert.equal(b.guard.note(line, {}), false, line);
  }
  // Not one of them may even count towards the threshold: a single real denial
  // after all of that must still leave the file alone.
  assert.equal(b.guard.note(DENIED, {}), false);
  assert.equal(fs.existsSync(b.cred), true);
});

test("a transient denial never clears anything, however often it repeats", () => {
  const b = box();
  for (let i = 0; i < 10; i++) assert.equal(b.guard.note(TRANSIENT, {}), false);
  assert.equal(fs.existsSync(b.cred), true);
});

test("an access-token start is ignored - the token was refused, not the file", () => {
  const b = box();
  // The adopt path: three token starts refused in a row, which is exactly what
  // the live box did. The saved login must survive all of them.
  for (let i = 0; i < 3; i++) {
    assert.equal(b.guard.note(DENIED, { withToken: true }), false);
  }
  assert.equal(fs.existsSync(b.cred), true, "a failed adoption must not cost the box its login");
  // And it does not count towards the threshold either, so one ordinary denial
  // afterwards is still only the first.
  assert.equal(b.guard.note(DENIED, {}), false);
  assert.equal(fs.existsSync(b.cred), true);
  assert.equal(b.guard.note(DENIED, {}), true, "two ordinary denials still act");
});

test("a daemon that comes up clears the strikes", () => {
  const b = box();
  assert.equal(b.guard.note(DENIED, {}), false);
  assert.equal(b.guard.note(PUBLISHED, {}), false, "up again: the count is about ONE bad file");
  assert.equal(b.guard.note(DENIED, {}), false, "so this is the first strike, not the second");
  assert.equal(fs.existsSync(b.cred), true);
});

test("nothing cached: says so once, and does not throw", () => {
  const b = box();
  fs.unlinkSync(b.cred);
  for (let i = 0; i < 6; i++) b.guard.note(DENIED, {});
  const missing = b.logs.filter((m) => /no saved credentials/.test(m));
  assert.equal(missing.length, 1, "one line, not one per start");
});

test("the number of resets is bounded, and the last word is a reason", () => {
  const b = box({ maxHeals: 1 });
  assert.equal(b.guard.note(DENIED, {}), false);
  assert.equal(b.guard.note(DENIED, {}), true);
  // A fresh login arrives (a cast) and is refused too: the guard is out of resets.
  fs.writeFileSync(b.cred, '{"auth_data":"second-blob"}');
  assert.equal(b.guard.note(DENIED, {}), false);
  assert.equal(b.guard.note(DENIED, {}), false, "no second reset");
  assert.equal(fs.existsSync(b.cred), true);
  assert.equal(b.logs.filter((m) => /leaving it alone/.test(m)).length, 1);
});

test("a rename that fails is reported, not thrown", () => {
  const b = box();
  const broken = {
    existsSync: () => true,
    renameSync: () => {
      throw new Error("EROFS: read-only file system");
    },
  };
  const guard = createCredGuard({ fs: broken, path, cacheDir: b.dir, log: (m) => b.logs.push(m) });
  assert.equal(guard.note(DENIED, {}), false);
  assert.equal(guard.note(DENIED, {}), false);
  assert.match(b.logs.join("\n"), /could not clear the refused login: EROFS/);
});

test("the two classifiers are what the plugin's routing keys off", () => {
  assert.equal(isCredentialRejection(DENIED), true);
  assert.equal(isCredentialRejection(TRANSIENT), false);
  assert.equal(isCredentialRejection(""), false);
  assert.equal(isCredentialRejection(undefined), false);
  assert.equal(isUp(PUBLISHED), true);
  assert.equal(isUp(AUTHED), false, "authenticated is not the same as discoverable");
  // A discovery-only start never authenticates at all, so "up" has to be the
  // zeroconf line rather than a login: that is the state the recovery aims for.
  assert.equal(isUp("[2026-08-23T09:27:09Z INFO  librespot_discovery] Published zeroconf service"), true);
});

test("the daemon's own lines are told apart from the supervisor's", () => {
  // The plugin routes on this: "[" means librespot, anything else is the
  // supervisor. Both go to librespot.log; only ERRORs and supervisor lines go to
  // shell.log, which is what keeps per-track INFO out of it.
  assert.equal(DENIED.startsWith("["), true);
  assert.equal(DENIED.includes(" ERROR "), true);
  assert.equal(AUTHED.startsWith("["), true);
  assert.equal(AUTHED.includes(" ERROR "), false, "INFO must not reach shell.log");
  assert.equal(SPAWN.startsWith("["), false);
  assert.equal(EXITED.startsWith("["), false);
});

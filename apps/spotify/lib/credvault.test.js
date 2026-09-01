// One saved librespot login per account: what may be filed, what may be put in
// place, and what must never be either.
//
// The real fs against a temp directory rather than a fake: the whole point of
// this module is what is on disk afterwards - the mode bits, the temp file that
// must not survive, the file that must still be there after a failed write - and
// a stub would be asserting itself.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const { createCredVault, validId } = require("./credvault");

const cred = (user, extra) =>
  JSON.stringify({ username: user, auth_type: 1, auth_data: "blob-" + user + (extra || "") });

function vault() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-credvault-"));
  const logged = [];
  const v = createCredVault({ fs, path, cacheDir, log: (m) => logged.push(m) });
  return {
    v,
    cacheDir,
    logged,
    live: path.join(cacheDir, "credentials.json"),
    slot: (id) => path.join(cacheDir, "logins", id + ".json"),
    setLive: (raw) => fs.writeFileSync(path.join(cacheDir, "credentials.json"), raw),
    read: (f) => fs.readFileSync(f, "utf8"),
  };
}

test("a login is filed under the account named inside it", () => {
  const t = vault();
  t.setLive(cred("acct-one"));

  assert.equal(t.v.archive(), "acct-one");
  assert.equal(t.read(t.slot("acct-one")), cred("acct-one"));
  assert.deepEqual(t.v.list(), ["acct-one"]);
  assert.equal(t.v.has("acct-one"), true);
  assert.equal(t.v.owner(), "acct-one", "and the live file still says whose the box is");
});

test("nothing to file is not an error, and says nothing", () => {
  const t = vault();
  assert.equal(t.v.archive(), "");
  assert.equal(t.v.owner(), "");
  assert.deepEqual(t.v.list(), []);
  assert.deepEqual(t.logged, [], "a box that has never been signed in is an ordinary state");
});

test("a second archive of the same login writes nothing and says nothing twice", () => {
  const t = vault();
  t.setLive(cred("u1"));
  assert.equal(t.v.archive(), "u1");
  const at = fs.statSync(t.slot("u1")).mtimeMs;

  assert.equal(t.v.archive(), "u1");

  assert.equal(fs.statSync(t.slot("u1")).mtimeMs, at, "the same bytes are not rewritten");
  assert.equal(t.logged.length, 1, "and a login is announced once, not on every start");
});

test("a changed login for the same account replaces the copy", () => {
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();
  t.setLive(cred("u1", "-rotated"));

  assert.equal(t.v.archive(), "u1");

  assert.equal(t.read(t.slot("u1")), cred("u1", "-rotated"));
});

// The username comes out of a JSON file this module did not write, and it becomes
// a file name. Every one of these would otherwise resolve somewhere it must not.
test("a username that cannot be a file name is refused, not repaired", () => {
  for (const bad of ["../../evil", "a/b", ".", "..", "", "u 1", "ú1", "x".repeat(65), "a\u0000b"]) {
    assert.equal(validId(bad), false, JSON.stringify(bad) + " must not be an id");
  }
  for (const good of ["acct-one", "some.user_name-1", "x".repeat(64)]) {
    assert.equal(validId(good), true, JSON.stringify(good) + " is a Spotify id");
  }

  const t = vault();
  t.setLive(cred("../../evil"));
  assert.equal(t.v.archive(), "", "nothing is filed");
  assert.equal(t.v.owner(), "", "and the box is not reported as signed in as it");
  assert.equal(fs.existsSync(path.join(t.cacheDir, "logins")), false, "no directory was even made");
});

test("a live file that is not a credentials file leaves the vault alone", () => {
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();

  t.setLive("{ truncated");
  assert.equal(t.v.archive(), "");
  assert.equal(t.v.owner(), "");
  assert.equal(t.read(t.slot("u1")), cred("u1"), "the copy of a login that worked is not lost to a bad file");
});

test("putting a login in place archives the one it displaces", () => {
  const t = vault();
  t.setLive(cred("u2"));
  t.v.archive();
  t.setLive(cred("u1")); // u1 is signed in now; u2 is only in the vault

  const r = t.v.use("u2");

  assert.deepEqual(r, { ok: true, displaced: "u1" });
  assert.equal(t.read(t.live), cred("u2"), "the box will start as u2");
  assert.equal(t.read(t.slot("u1")), cred("u1"), "and u1 can be put back");
  assert.equal(t.v.owner(), "u2");
});

test("a login already in place is left where it is", () => {
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();
  const at = fs.statSync(t.live).mtimeMs;

  assert.deepEqual(t.v.use("u1"), { ok: true, displaced: "u1" });

  assert.equal(fs.statSync(t.live).mtimeMs, at, "the live file is not rewritten for no reason");
});

test("an account with no saved login is refused, and nothing is touched", () => {
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();

  assert.deepEqual(t.v.use("u2"), { ok: false, displaced: "" });
  assert.deepEqual(t.v.use("../../evil"), { ok: false, displaced: "" });

  assert.equal(t.read(t.live), cred("u1"), "the working login stayed in place");
});

test("a slot whose contents name somebody else is refused", () => {
  // Only an edited or half-written vault produces this, and using it would sign
  // the box in as an account nobody asked for - the one thing this must not do.
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();
  fs.writeFileSync(t.slot("u2"), cred("someone-else"));

  assert.deepEqual(t.v.use("u2"), { ok: false, displaced: "" });

  assert.equal(t.read(t.live), cred("u1"));
  assert.ok(
    t.logged.some((m) => m.includes("belongs to someone-else")),
    "and it says which account the file really holds",
  );
});

test("a credential is not readable by anyone else", () => {
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();

  assert.equal(fs.statSync(t.slot("u1")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(t.cacheDir, "logins")).mode & 0o777, 0o700);
});

test("a write leaves no temp file behind", () => {
  const t = vault();
  t.setLive(cred("u2"));
  t.v.archive();
  t.setLive(cred("u1"));
  t.v.use("u2");

  assert.deepEqual(
    fs.readdirSync(path.join(t.cacheDir, "logins")).filter((n) => n.endsWith(".tmp")),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(t.cacheDir).filter((n) => n.endsWith(".tmp")),
    [],
  );
});

test("a write that cannot happen is reported, and the file it would have replaced survives", () => {
  const t = vault();
  t.setLive(cred("u2"));
  t.v.archive();
  t.setLive(cred("u1"));
  fs.chmodSync(t.cacheDir, 0o500); // no writing in the cache directory
  try {
    const r = t.v.use("u2");
    assert.equal(r.ok, false);
    assert.equal(t.read(t.live), cred("u1"), "the box is still signed in as somebody");
    assert.ok(t.logged.some((m) => m.includes("could not write credentials.json")));
  } finally {
    fs.chmodSync(t.cacheDir, 0o700);
  }
});

test("a login that could not be copied first is not replaced at all", () => {
  // The one unrecoverable thing this module could do: overwrite the only copy of a
  // household member's login while failing to keep one. A full or read-only card
  // is enough to get here.
  const t = vault();
  t.setLive(cred("u2"));
  t.v.archive();
  t.setLive(cred("u1")); // u1 is signed in and has never been vaulted
  fs.mkdirSync(t.slot("u1")); // something is in the way of u1's copy

  assert.deepEqual(t.v.use("u2"), { ok: false, displaced: "" });

  assert.equal(t.read(t.live), cred("u1"), "the box is still signed in as u1");
  assert.ok(t.logged.some((m) => m.includes("could not be saved first")));
});

test("a login in place that cannot be read is not replaced either", () => {
  // `readCred` answers null both for "there is nothing" and for "this cannot be
  // attributed" - a file librespot would accept but whose username field this does
  // not recognise. Taken as nothing, it was overwritten: somebody's only login,
  // gone, and the caller told there was nothing to put back.
  const t = vault();
  t.setLive(cred("u2"));
  t.v.archive();
  t.setLive('{"user":"acct-one","auth_type":1}'); // a field name this does not know

  assert.deepEqual(t.v.use("u2"), { ok: false, displaced: "" });

  assert.equal(t.read(t.live), '{"user":"acct-one","auth_type":1}', "left exactly as it was");
  assert.ok(t.logged.some((m) => m.includes("cannot read")));
});

test("a symlink left at the temp path is not followed", () => {
  const t = vault();
  const target = path.join(t.cacheDir, "elsewhere.json");
  fs.mkdirSync(path.join(t.cacheDir, "logins"), { recursive: true });
  fs.symlinkSync(target, t.slot("u1") + ".tmp");
  t.setLive(cred("u1"));

  assert.equal(t.v.archive(), "u1");

  assert.equal(fs.existsSync(target), false, "the credential did not go where the link pointed");
  assert.equal(t.read(t.slot("u1")), cred("u1"));
  assert.equal(fs.lstatSync(t.slot("u1")).isSymbolicLink(), false);
});

test("the login the credential guard rejected is dropped, by name from the file", () => {
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();
  t.setLive(cred("u2"));
  t.v.archive();
  // What credguard does: the refused blob is moved aside, so the live file is gone.
  fs.renameSync(t.live, path.join(t.cacheDir, "credentials.json.rejected"));

  assert.equal(t.v.dropRejected(), "u2");

  assert.equal(t.v.has("u2"), false, "a blob Spotify refuses must not be swapped back in");
  assert.equal(t.v.has("u1"), true, "and the other account's login is untouched");
});

test("no rejected file, nothing dropped", () => {
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();

  assert.equal(t.v.dropRejected(), "");
  assert.equal(t.v.has("u1"), true);
});

test("dropping an account's login is what unlinking it costs", () => {
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();

  assert.equal(t.v.drop("u1"), true);
  assert.equal(t.v.drop("u1"), false, "gone is not an error");
  assert.equal(t.v.drop("../../evil"), false);
  assert.deepEqual(t.v.list(), []);
});

test("only credentials files are listed", () => {
  const t = vault();
  t.setLive(cred("u1"));
  t.v.archive();
  fs.writeFileSync(path.join(t.cacheDir, "logins", "notes.txt"), "x");
  fs.writeFileSync(path.join(t.cacheDir, "logins", "u2.json.tmp"), "x");

  assert.deepEqual(t.v.list(), ["u1"]);
});

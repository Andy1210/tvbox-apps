// What the box remembers about the Microsoft account, and what it deliberately
// does not. Every assertion here is a failure that is invisible at runtime: a
// relative `expires_in` stored as-is looks valid forever, a token file written
// world-readable works exactly as well as a private one, and a half-stored
// account (access token, no refresh token) works until the first reboot.
//
// TVBOX_XCLOUD_TOKENS is set before the module loads, because it resolves the
// file path at require time.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-xcloud-tokens-"));
const FILE = path.join(DIR, ".tvbox", "xcloud-tokens.json");
process.env.TVBOX_XCLOUD_TOKENS = FILE;

const store = require("./tokenstore");

const reset = () => {
  store.clear();
  store._reload();
};

test("a fresh box has no account", () => {
  reset();
  assert.equal(store.hasAccount(), false);
  assert.equal(store.getUserToken(), null);
  assert.equal(store.accessTokenIsFresh(), false);
});

test("expires_in is stamped to an absolute time at receipt", () => {
  reset();
  const before = Date.now();
  store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 3600 });
  const u = store.getUserToken();
  // Not the relative number: a stored 3600 would read as valid for ever.
  assert.ok(u.expires_at >= before + 3600e3 && u.expires_at <= Date.now() + 3600e3);
  assert.equal(store.accessTokenIsFresh(), true);
});

test("a token inside the skew window is already treated as stale", () => {
  reset();
  // 30 s left, against a 60 s skew: it must be refused, or it can expire between
  // the freshness check and the request that check was for.
  store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 30 });
  assert.equal(store.accessTokenIsFresh(), false);
  assert.ok(store.SKEW_SECONDS >= 30);
});

test("an expired access token still leaves a usable account", () => {
  reset();
  store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 0 });
  assert.equal(store.accessTokenIsFresh(), false);
  // The refresh token is what makes an account, and it outlives the access token.
  assert.equal(store.hasAccount(), true);
});

test("only the account side is persisted, at mode 600, and the shared dir is left alone", () => {
  reset();
  // The directory is `~/.tvbox` on a real box - the shell's whole data directory.
  // This used to chmod it 0700 on every token refresh, which is an undeclared
  // change to state this plugin does not own; 0600 on the file is the protection.
  const dir = path.dirname(FILE);
  fs.chmodSync(dir, 0o755);
  store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "xboxlive.signin" });
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755);

  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.deepEqual(Object.keys(raw), ["user"]);
  // No gsToken, no XSTS token: those are re-derived in three requests and expire
  // within hours, so writing them down is a live streaming credential on disk for
  // no benefit. The access token IS here, beside the refresh token that can mint
  // another one - the file's comment used to claim otherwise.
  assert.equal(JSON.stringify(raw).includes("gsToken"), false);
  assert.equal(JSON.stringify(raw).includes("XSTS"), false);
});

test("no temp file is left behind", () => {
  reset();
  store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 3600 });
  assert.equal(fs.existsSync(FILE + ".tmp"), false);
});

test("a response with no refresh_token is refused rather than half-stored", () => {
  reset();
  assert.throws(() => store.setUserToken({ access_token: "a", expires_in: 3600 }), /refresh_token/);
  assert.equal(store.hasAccount(), false);
});

test("the account survives a reload, and clear removes the file", () => {
  reset();
  store.setUserToken({ access_token: "a", refresh_token: "r-persisted", expires_in: 3600 });
  store._reload();
  assert.equal(store.getUserToken().refresh_token, "r-persisted");
  // The access token is persisted too (it is valid for an hour and re-deriving it
  // costs a round trip), but it is the refresh token that has to survive.
  store.clear();
  assert.equal(fs.existsSync(FILE), false);
  assert.equal(store.hasAccount(), false);
});

test("an unreadable token file reads as no account, not as a crash", () => {
  reset();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, "{ this is not json");
  store._reload();
  assert.equal(store.hasAccount(), false);
});

test("a token file that is valid JSON but not our shape reads as no account", () => {
  reset();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ user: null, junk: 1 }));
  store._reload();
  assert.equal(store.hasAccount(), false);
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// Where the Microsoft account lives on the box: the Microsoft refresh token and
// the short-lived access token that came with it. What is deliberately NOT here is
// everything downstream - the XSTS tokens, the streaming token and its gsToken -
// which is re-derived in three requests and expires within hours, so writing it to
// disk would put a live streaming credential in a file for no gain.
const fs = require("fs");
const os = require("os");
const path = require("path");

const FILE = process.env.TVBOX_XCLOUD_TOKENS || path.join(os.homedir(), ".tvbox", "xcloud-tokens.json");
// Treated as expired this many seconds early, so a token cannot go stale between
// the check and the request it was checked for.
const SKEW_SECONDS = 60;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && typeof raw === "object") return { user: raw.user || null };
  } catch {
    /* no account yet, or a file we cannot read - either way there is no account */
  }
  return { user: null };
}

let state = load();

function save() {
  const tmp = FILE + ".tmp";
  try {
    const dir = path.dirname(FILE);
    // 0700 if WE are the one creating it - the mode a directory holding a refresh
    // token should have. Not a chmod: an existing `~/.tvbox` belongs to the shell
    // and its permissions are not this plugin's to change.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // fsync before the rename: the rename can otherwise reach the disk before the
    // bytes it points at, and the file that survives a power cut is then empty -
    // which here means the box has no Xbox account at all.
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600); // enforce regardless of umask - this is a refresh token
    fs.renameSync(tmp, FILE);
    // The FILE, and not its directory. `dir` is `~/.tvbox` - the shell's whole
    // data directory, every app package and config.json inside it - so chmodding
    // it 0700 from here was an undeclared change to shared state on every token
    // refresh. 0600 on the file is what actually protects the token.
    return true;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing left to clean up */
    }
    console.warn("[xcloud] token persist failed:", e.message);
    return false;
  }
}

// `expires_in` is seconds from NOW, so it is only meaningful at the moment the
// response arrived - stamp it here rather than storing the relative number.
function setUserToken(body) {
  if (!body || !body.refresh_token) throw new Error("token response carries no refresh_token");
  // Number(x) || 0 would be the same value here, but a missing expires_in and an
  // expires_in of 0 mean the same thing - already expired - so this is explicit.
  const ttl = Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : 0;
  state.user = {
    access_token: body.access_token || "",
    refresh_token: body.refresh_token,
    scope: body.scope || "",
    expires_at: Date.now() + ttl * 1000,
  };
  save();
  return state.user;
}

const getUserToken = () => state.user;
const hasAccount = () => !!(state.user && state.user.refresh_token);

function accessTokenIsFresh() {
  const u = state.user;
  return !!(u && u.access_token && u.expires_at - SKEW_SECONDS * 1000 > Date.now());
}

function clear() {
  state = { user: null };
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* already gone */
  }
}

// Test seam: the plugin never calls this, the offline check does.
function _reload() {
  state = load();
}

module.exports = { FILE, SKEW_SECONDS, setUserToken, getUserToken, hasAccount, accessTokenIsFresh, clear, _reload };

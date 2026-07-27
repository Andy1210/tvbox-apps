// A network share as the game library, so several boxes in one house read the
// same games from one place.
//
// SMB, not NFS: mounting NFS needs the mount syscall and therefore root, which
// nothing in tvbox is allowed to use at runtime. rclone mounts SMB over FUSE as
// the ordinary user, and ships as a single static binary the app installs itself.
//
// The remote is configured through rclone's ENVIRONMENT variables rather than an
// rclone.conf, so the credentials live in exactly one file (this module's own
// config, 0600) instead of being copied into a second one next to the mount.
// rclone still wants its password "obscured", which is a reversible encoding and
// not encryption, so the file permissions are what actually protect it.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execFileSync } = require("child_process");

const CONFIG_FILE = path.join(os.homedir(), ".tvbox", "retroarch-share.json");
const ROMS_DIR = path.join(os.homedir(), ".tvbox", "roms");
const REMOTE = "tvboxsmb"; // rclone remote name; only ever used internally
const DEFAULT_MOUNT_NAME = "network";
// The mount is read through by an emulator loading a disc image, so cache what
// has been read to local disk: without it every seek inside a 700MB image goes
// back over the network. Bounded so a big library cannot fill the box.
const VFS_ARGS = [
  "--read-only",
  "--vfs-cache-mode",
  "full",
  "--vfs-cache-max-size",
  "8G",
  "--vfs-cache-max-age",
  "168h",
  "--vfs-read-ahead",
  "128M",
  "--dir-cache-time",
  "30s",
  "--no-modtime",
];

// A host name or IP. No scheme, no path, no credentials.
function hostOk(h) {
  return typeof h === "string" && h.length <= 253 && /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(h);
}
// An SMB share name. Windows share names are permissive; this stays with what a
// NAS actually produces, and rules out separators and control characters.
function shareOk(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 80 && !/[/\\:*?"<>|\x00-\x1f]/.test(s);
}
// The folder the share appears as inside the library. A path segment, so a slug.
function mountNameOk(n) {
  return typeof n === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(n);
}
// A sub-folder inside the share, so only the games are mounted and not the whole
// disk. Slash-separated, and empty means the share's own root. Real folder names
// carry spaces and accents, so this rejects what breaks a path rather than
// restricting it to a slug.
function pathOk(p) {
  if (typeof p !== "string") return false;
  if (p === "") return true;
  if (p.length > 400 || p.startsWith("/") || p.endsWith("/") || p.includes("//")) return false;
  if (/[\\\x00-\x1f]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// What rclone is pointed at: the share, plus the sub-folder when there is one.
function remotePath(cfg) {
  const sub = (cfg && cfg.path) || "";
  return REMOTE + ":" + cfg.share + (sub ? "/" + sub : "");
}

function mountPoint(cfg) {
  return path.join(ROMS_DIR, (cfg && cfg.mountName) || DEFAULT_MOUNT_NAME);
}

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return cfg && typeof cfg === "object" ? cfg : null;
  } catch (e) {
    return null;
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600); // an existing file keeps its old mode otherwise
}

function clearConfig() {
  try {
    fs.unlinkSync(CONFIG_FILE);
    return true;
  } catch (e) {
    return false;
  }
}

// rclone's own reversible encoding for stored passwords. Fed over stdin so the
// plain password never appears in the process list.
function obscure(pass) {
  return execFileSync("rclone", ["obscure", "-"], { input: String(pass), encoding: "utf8" }).trim();
}

// The password the caller means, from what the form sent. Omitting `pass` keeps the
// stored one; sending it empty clears it. An empty password is legitimate (a guest
// share), so "unchanged" and "cleared" cannot both be "falsy" - every caller has to
// read it the same way, which is why this lives in one place.
function passFrom(input) {
  if (!input || input.pass === undefined) return (readConfig() || {}).pass || "";
  return input.pass ? obscure(String(input.pass)) : "";
}

// Validate + normalise what the phone form sent into a stored config. Throws with
// a short reason the form can show.
function configFrom(input) {
  const host = String((input && input.host) || "").trim();
  const share = String((input && input.share) || "").trim();
  const user = String((input && input.user) || "").trim();
  const domain = String((input && input.domain) || "").trim();
  const mountName = String((input && input.mountName) || DEFAULT_MOUNT_NAME)
    .trim()
    .toLowerCase();
  // A path pasted from a file manager may well arrive with stray slashes.
  const sub = String((input && input.path) || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!hostOk(host)) throw new Error("bad_host");
  if (!shareOk(share)) throw new Error("bad_share");
  if (user.length > 128 || domain.length > 128) throw new Error("bad_user");
  if (!mountNameOk(mountName)) throw new Error("bad_mount_name");
  if (!pathOk(sub)) throw new Error("bad_path");
  const cfg = { host, share, path: sub, user, domain, mountName };
  cfg.pass = passFrom(input);
  return cfg;
}

// rclone reads a remote's settings from RCLONE_CONFIG_<REMOTE>_<KEY>.
function envFor(cfg, baseEnv) {
  const env = { ...baseEnv };
  const p = "RCLONE_CONFIG_" + REMOTE.toUpperCase() + "_";
  env[p + "TYPE"] = "smb";
  env[p + "HOST"] = cfg.host;
  env[p + "USER"] = cfg.user || "guest";
  env[p + "PASS"] = cfg.pass || "";
  if (cfg.domain) env[p + "DOMAIN"] = cfg.domain;
  return env;
}

function mountArgs(cfg) {
  return ["mount", remotePath(cfg), mountPoint(cfg), ...VFS_ARGS];
}

// A stale FUSE mount (rclone killed hard, or the box lost power mid-mount) leaves
// a directory that reports EIO forever. Clearing it is cheap and makes a remount
// reliable, so it runs before every mount attempt.
function unmount(cfg) {
  const point = mountPoint(cfg);
  try {
    execFileSync("fusermount", ["-u", "-z", point], { stdio: "ignore" });
  } catch (e) {
    /* not mounted, which is the normal case */
  }
}

function ensureMountPoint(cfg) {
  fs.mkdirSync(mountPoint(cfg), { recursive: true });
}

// Is the mount live? A FUSE mount shows up in /proc/self/mountinfo; readdir is
// not a usable test because an unmounted point is simply an empty directory.
function isMounted(cfg) {
  const point = mountPoint(cfg);
  try {
    return fs
      .readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .some((line) => line.split(" ").includes(point));
  } catch (e) {
    return false;
  }
}

// rclone's `lsd` prints fixed columns and then the name, which may itself contain
// spaces, so the name is everything from the fifth field on.
function dirNames(stdout) {
  return String(stdout)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.trim().split(/\s+/).slice(4).join(" "))
    .filter(Boolean)
    .slice(0, 60);
}

// Try the credentials without mounting, and list the folders at the configured
// path so the form can be used to walk down to where the games actually are.
// A failure carries rclone's own last line, which says things like
// NT_STATUS_LOGON_FAILURE that are worth showing on the phone as they are.
function test(cfg, baseEnv, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      "rclone",
      ["lsd", remotePath(cfg), "--low-level-retries", "1", "--retries", "1"],
      { env: envFor(cfg, baseEnv), timeout: timeoutMs || 20000 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, dirs: dirNames(stdout), path: cfg.path || "" });
        const lines = String(stderr || err.message)
          .trim()
          .split("\n")
          .filter(Boolean);
        resolve({ ok: false, error: (lines[lines.length - 1] || "failed").slice(0, 200) });
      },
    );
  });
}

// List the shares the server offers, so the form does not have to guess a name.
// rclone lists shares when the path after the remote is empty, which is why this
// validates only the connection fields and not the share.
function listShares(input, baseEnv, timeoutMs) {
  const host = String((input && input.host) || "").trim();
  if (!hostOk(host)) return Promise.resolve({ ok: false, error: "bad_host" });
  const cfg = {
    host,
    user: String((input && input.user) || "").trim(),
    domain: String((input && input.domain) || "").trim(),
    // Same omit-versus-empty contract as configFrom(): an absent `pass` keeps what
    // is stored, an empty one means no password. Reading it as truthy would fall
    // back to the stored password and make it impossible to browse as a guest.
    pass: passFrom(input),
  };
  return new Promise((resolve) => {
    execFile(
      "rclone",
      ["lsd", REMOTE + ":", "--low-level-retries", "1", "--retries", "1"],
      { env: envFor(cfg, baseEnv), timeout: timeoutMs || 20000 },
      (err, stdout, stderr) => {
        if (err) {
          const lines = String(stderr || err.message)
            .trim()
            .split("\n")
            .filter(Boolean);
          return resolve({ ok: false, error: (lines[lines.length - 1] || "failed").slice(0, 200) });
        }
        resolve({ ok: true, shares: dirNames(stdout) });
      },
    );
  });
}

// What the phone form and the box need to know. The password is never returned,
// only whether one is stored.
function status(cfg) {
  if (!cfg) return { configured: false };
  return {
    configured: true,
    host: cfg.host,
    share: cfg.share,
    path: cfg.path || "",
    user: cfg.user || "",
    domain: cfg.domain || "",
    mountName: cfg.mountName || DEFAULT_MOUNT_NAME,
    hasPass: !!cfg.pass,
    mountPoint: mountPoint(cfg),
    mounted: isMounted(cfg),
  };
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_MOUNT_NAME,
  readConfig,
  writeConfig,
  clearConfig,
  configFrom,
  envFor,
  mountArgs,
  mountPoint,
  ensureMountPoint,
  unmount,
  isMounted,
  test,
  listShares,
  status,
  hostOk,
  shareOk,
  mountNameOk,
  pathOk,
  remotePath,
};

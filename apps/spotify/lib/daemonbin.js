// Keeps the box's librespot at the build this version of the app ships.
//
// The shell downloads a requires.download binary only when it is missing, so a box
// that already has one would stay on the old build for good. A failure here only
// means the old build keeps running, and the next start tries again.
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");

async function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(await fs.promises.readFile(file))
    .digest("hex");
}

function curl(url, dest) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-fsSL", "--proto-redir", "=https", "--connect-timeout", "20", "--max-time", "600", url, "-o", dest],
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

// Resolves to true when `file` was replaced. Only a file that exists is replaced: with
// none there, the daemon comes from elsewhere on PATH and is not this app's to change.
async function refreshBinary({ file, spec, tmp = file + ".new", download = curl, log = () => {} }) {
  const wanted = String((spec && spec.sha256) || "").toLowerCase();
  if (!/^https:\/\//.test((spec && spec.url) || "") || !/^[0-9a-f]{64}$/.test(wanted)) return false;
  let current;
  try {
    current = await sha256(file);
  } catch (e) {
    return false;
  }
  if (current === wanted) return false;
  try {
    await download(spec.url, tmp);
    const got = await sha256(tmp);
    if (got !== wanted) throw new Error("sha256 mismatch (got " + got + ")");
    await fs.promises.chmod(tmp, 0o755);
    await fs.promises.rename(tmp, file);
    return true;
  } catch (e) {
    log("could not update " + file + ": " + (e.message || e));
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}

module.exports = { refreshBinary };

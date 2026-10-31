// Moves a box from an earlier build of librespot this app shipped to the one in the
// manifest. The shell downloads a requires.download binary only when it is missing, so
// such a box would stay on the old build for good. A failed download leaves the old build
// in place and the next start tries again.
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
      [
        "-fsSL",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "20",
        "--max-time",
        "600",
        "--retry",
        "5",
        "--retry-delay",
        "10",
        "--retry-all-errors",
        url,
        "-o",
        dest,
      ],
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

// Resolves to true when `file` was replaced. Only a build listed in `replaces` is: any
// other file there is somebody's own build, and with none there the daemon comes from
// elsewhere on PATH. The name is unique because a hot-load can start a second update
// while the first one is still downloading.
async function refreshBinary({ file, spec, replaces = [], download = curl, log = () => {} }) {
  const wanted = String((spec && spec.sha256) || "").toLowerCase();
  if (!/^https:\/\//.test((spec && spec.url) || "") || !/^[0-9a-f]{64}$/.test(wanted)) return false;
  let current;
  try {
    current = await sha256(file);
  } catch (e) {
    return false;
  }
  if (!replaces.includes(current)) return false;
  const tmp = file + ".new-" + crypto.randomBytes(4).toString("hex");
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

// Tests for the network-share config contract. The subtle part is the password:
// the form omits it when the user did not touch the field and sends "" when they
// deliberately emptied it, so "keep what is stored" and "clear it" must not collapse
// into the same thing. HOME is redirected before the module loads, because it
// resolves its config path at require time.
//
// Cases that hand over a NEW password are deliberately absent: storing one shells
// out to `rclone obscure`, which is the app's own downloaded binary and not
// something a unit test should require.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-share-test-"));
process.env.HOME = HOME;
const share = require("./share");

const BASE = { host: "192.168.1.10", share: "Games", user: "andy", mountName: "network" };
const reset = () => share.clearConfig();

test("the config file is under the redirected HOME, not a real one", () => {
  assert.ok(share.CONFIG_FILE.startsWith(HOME), share.CONFIG_FILE);
});

test("a stored config is written 0600, since it holds a password", () => {
  reset();
  share.writeConfig({ ...BASE, path: "", domain: "", pass: "obscured" });
  assert.strictEqual(fs.statSync(share.CONFIG_FILE).mode & 0o777, 0o600);
});

test("an omitted password keeps the stored one", () => {
  reset();
  share.writeConfig({ ...BASE, path: "", domain: "", pass: "kept-value" });
  const cfg = share.configFrom({ ...BASE }); // no `pass` key at all
  assert.strictEqual(cfg.pass, "kept-value");
});

test("an empty password clears the stored one, which a guest share needs", () => {
  reset();
  share.writeConfig({ ...BASE, path: "", domain: "", pass: "kept-value" });
  const cfg = share.configFrom({ ...BASE, pass: "" });
  assert.strictEqual(cfg.pass, "", "an explicitly emptied field must not resurrect the old password");
});

test("the domain survives the round trip (it reaches rclone's environment)", () => {
  reset();
  const cfg = share.configFrom({ ...BASE, domain: "WORKGROUP" });
  assert.strictEqual(cfg.domain, "WORKGROUP");
  const env = share.envFor(cfg, {});
  assert.strictEqual(env.RCLONE_CONFIG_TVBOXSMB_DOMAIN, "WORKGROUP");
  // and no domain means the variable is simply absent, not empty
  assert.strictEqual(share.envFor(share.configFrom(BASE), {}).RCLONE_CONFIG_TVBOXSMB_DOMAIN, undefined);
});

test("status never returns the password, only whether there is one", () => {
  reset();
  share.writeConfig({ ...BASE, path: "Emulators", domain: "", pass: "secret" });
  const st = share.status(share.readConfig());
  assert.strictEqual(st.hasPass, true);
  assert.strictEqual(st.pass, undefined);
  assert.ok(!JSON.stringify(st).includes("secret"), "the password leaked into status()");
  assert.strictEqual(st.path, "Emulators");
});

test("a sub-path is optional, normalised, and cannot climb out of the share", () => {
  assert.strictEqual(share.configFrom({ ...BASE, path: "/Emulators/roms/" }).path, "Emulators/roms");
  assert.strictEqual(share.configFrom({ ...BASE }).path, "");
  for (const bad of ["../etc", "a/../../b", "a//b", "back\\slash", "."]) {
    assert.throws(() => share.configFrom({ ...BASE, path: bad }), /bad_path/, JSON.stringify(bad) + " must be refused");
  }
  // a folder name with spaces or an ampersand is perfectly normal on a NAS
  assert.strictEqual(share.configFrom({ ...BASE, path: "Rock & Roll/Disc 1" }).path, "Rock & Roll/Disc 1");
});

test("the remote path is the share plus the sub-folder, and just the share without one", () => {
  assert.strictEqual(share.remotePath({ share: "Games", path: "Emulators" }), "tvboxsmb:Games/Emulators");
  assert.strictEqual(share.remotePath({ share: "Games", path: "" }), "tvboxsmb:Games");
  assert.strictEqual(share.remotePath({ share: "Games" }), "tvboxsmb:Games");
});

test("the host, share and mount folder are validated", () => {
  for (const host of ["", "http://x", "1.2.3.4/share", "a b", "-x"]) {
    assert.throws(() => share.configFrom({ ...BASE, host }), /bad_host/, JSON.stringify(host));
  }
  for (const sh of ["", "a/b", "a\\b", 'a"b', "a*b"]) {
    assert.throws(() => share.configFrom({ ...BASE, share: sh }), /bad_share/, JSON.stringify(sh));
  }
  for (const mountName of ["../net", "Net Work", "-net"]) {
    assert.throws(() => share.configFrom({ ...BASE, mountName }), /bad_mount_name/, JSON.stringify(mountName));
  }
  // the mount folder is lower-cased for the caller, since it becomes a path segment
  assert.strictEqual(share.configFrom({ ...BASE, mountName: "NETWORK" }).mountName, "network");
});

test("the mount point sits inside the library, under the chosen folder name", () => {
  const point = share.mountPoint({ mountName: "nas" });
  assert.ok(point.startsWith(path.join(HOME, ".tvbox", "roms")), point);
  assert.strictEqual(path.basename(point), "nas");
  assert.strictEqual(path.basename(share.mountPoint({})), share.DEFAULT_MOUNT_NAME);
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

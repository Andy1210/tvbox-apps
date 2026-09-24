const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// A home with no iptv.conf, so only the config below decides the source.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "livetv-home-"));
const provider = require("./provider");

test("a read that fails after the source changed answers for the new source", async () => {
  // The old source fails (loopback is refused), the new one is "nothing configured".
  let iptv = { mode: "m3u", m3u: { url: "http://127.0.0.1:9/list.m3u" } };
  provider.setConfig({ rawIptv: () => iptv });
  provider.clearCache();
  const asked = provider.getChannels();
  iptv = null;
  provider.clearCache();
  await assert.rejects(asked, (e) => e.message === "not_configured");
});

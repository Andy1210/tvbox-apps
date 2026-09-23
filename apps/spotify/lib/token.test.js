// Token handling, driven through the real module with a stubbed https layer:
// which refusals unlink an account, and that a refused access token is replaced
// rather than retried as it was.
//
// HOME is redirected before the module loads, because it resolves the accounts
// file at require time.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const https = require("https");
const { EventEmitter } = require("events");

const REAL_HOME = process.env.HOME;
const REAL_REQUEST = https.request;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-spotify-token-"));
process.env.HOME = HOME;
fs.mkdirSync(path.join(HOME, ".tvbox"), { recursive: true });
fs.writeFileSync(
  path.join(HOME, ".tvbox", "spotify-accounts.json"),
  JSON.stringify({ active: "u1", list: [{ id: "u1", name: "U", token: "refresh-token" }] }),
);

// The stub stands in for https.request itself, so the module's own request()
// wrapper (timeouts, the keep-alive agent, header handling) is the code under
// test rather than something the test replaces.
let handler = () => ({ status: 500, body: "" });
const seen = [];
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.write = () => {};
  req.destroy = () => {};
  req.end = () => {
    const url = opts.path;
    seen.push(url);
    let out;
    try {
      out = handler(url, opts) || { status: 500, body: "" };
    } catch (e) {
      setImmediate(() => req.emit("error", e));
      return;
    }
    const res = new EventEmitter();
    res.statusCode = out.status;
    res.headers = out.headers || {};
    setImmediate(() => {
      if (out.body) res.emit("data", out.body);
      res.emit("end");
    });
    cb(res);
  };
  return req;
};

const api = require("./spotify_api");
api.setConfig({ rawSpotify: () => ({ clientId: "id", clientSecret: "secret" }) });

// Put back what this file took over. Node runs each test file in its own
// process, so nothing else would notice today, but a stubbed core module and a
// redirected HOME left behind are the kind of thing that only bites once
// somebody adds a second file here.
test.after(() => {
  https.request = REAL_REQUEST;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

const accounts = () => api.listAccounts().map((a) => a.id);

test("a refused access token is dropped and the request asked again with a new one", async () => {
  let refreshes = 0;
  let calls = 0;
  handler = (url, opts) => {
    if (url.includes("/api/token")) {
      refreshes++;
      return { status: 200, body: JSON.stringify({ access_token: "at" + refreshes, expires_in: 3600 }) };
    }
    calls++;
    return String(opts.headers.Authorization) === "Bearer at1"
      ? { status: 401, body: '{"error":{"status":401}}' }
      : { status: 200, body: JSON.stringify({ items: [], total: 0 }) };
  };
  const r = await api.getPlaylists();
  assert.deepStrictEqual(r, []);
  assert.strictEqual(refreshes, 2, "the refused token was not reused");
  assert.strictEqual(calls, 2);
});

test("a wrong client secret does not unlink the account", async () => {
  handler = (url) => {
    if (url.includes("/api/token")) return { status: 401, body: '{"error":"invalid_client"}' };
    return { status: 401, body: "" };
  };
  await assert.rejects(api._test.refreshFor("u1"));
  assert.deepStrictEqual(accounts(), ["u1"]);
});

test("a dead refresh token does unlink it", async () => {
  handler = (url) => {
    if (url.includes("/api/token")) return { status: 400, body: '{"error":"invalid_grant"}' };
    return { status: 500, body: "" };
  };
  await assert.rejects(api._test.refreshFor("u1"));
  assert.deepStrictEqual(accounts(), []);
});

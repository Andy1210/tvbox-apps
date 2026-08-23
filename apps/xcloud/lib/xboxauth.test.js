// The token chain, driven through the real module with https.request stubbed, so
// the module's own request wrapper (the deadline, the keep-alive agent, header
// handling) is under test rather than replaced.
//
// The device-code half is where the assertions earn their keep. Microsoft answers
// the poll with a 400 and a BODY, and the body is the state: `authorization_pending`
// means keep waiting, `slow_down` means back off, `expired_token` means stop. A
// client that treats every 400 as a failure - or as a reason to retry blindly -
// either gives up on a sign-in that was working or hammers a dead code for its
// full fifteen minutes. Both were the reference implementation's behaviour.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const https = require("https");
const { EventEmitter } = require("events");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-xcloud-auth-"));
process.env.TVBOX_XCLOUD_TOKENS = path.join(DIR, "tokens.json");

const REAL_REQUEST = https.request;
let handler = () => ({ status: 500, body: "" });
const seen = [];

https.request = (opts, cb) => {
  const req = new EventEmitter();
  let body = "";
  req.write = (c) => { body += c; };
  req.destroy = (e) => setImmediate(() => req.emit("error", e || new Error("destroyed")));
  req.setTimeout = () => {};
  req.end = () => {
    const call = { host: opts.hostname, path: opts.path, method: opts.method, headers: opts.headers, body };
    seen.push(call);
    let out;
    try {
      out = handler(call) || { status: 500, body: "" };
    } catch (e) {
      setImmediate(() => req.emit("error", e));
      return;
    }
    const res = new EventEmitter();
    res.statusCode = out.status;
    res.headers = out.headers || {};
    setImmediate(() => {
      cb(res);
      const text = typeof out.body === "string" ? out.body : JSON.stringify(out.body || {});
      if (text) res.emit("data", Buffer.from(text));
      res.emit("end");
    });
  };
  return req;
};

const auth = require("./xboxauth");
const store = require("./tokenstore");

const reset = () => {
  seen.length = 0;
  auth.signOut();
  store._reload();
  handler = () => ({ status: 500, body: "" });
};

const at = (frag) => seen.filter((c) => c.path.includes(frag) || c.host.includes(frag));

// ------------------------------------------------------------- device code

test("a device code carries Microsoft's own expiry and interval, not ours", async () => {
  reset();
  handler = () => ({ status: 200, body: { user_code: "ABCD1234", device_code: "dc", verification_uri: "https://ms/link", expires_in: 600, interval: 7 } });
  const dc = await auth.startDeviceCodeAuth();
  assert.equal(dc.userCode, "ABCD1234");
  assert.equal(dc.interval, 7);
  assert.equal(dc.expiresIn, 600);
  assert.match(seen[0].body, /client_id=/);
  assert.match(seen[0].body, /xboxlive\.signin/);
});

test("authorization_pending keeps polling and does not surface as a failure", async () => {
  reset();
  let n = 0;
  handler = () => {
    n++;
    if (n < 3) return { status: 400, body: { error: "authorization_pending" } };
    return { status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600 } };
  };
  const user = await auth.pollForDeviceCode("dc", { interval: 1, expiresIn: 60 });
  assert.equal(user.refresh_token, "r");
  assert.equal(n, 3);
  assert.equal(store.hasAccount(), true);
});

test("slow_down widens the interval instead of failing or hammering", async () => {
  reset();
  const gaps = [];
  let last = Date.now();
  let n = 0;
  handler = () => {
    gaps.push(Date.now() - last);
    last = Date.now();
    n++;
    if (n === 1) return { status: 400, body: { error: "slow_down" } };
    return { status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600 } };
  };
  // slow_down adds 5 s to the interval, so the run must take at least that long.
  // The interval floor is 1 s (Microsoft's own minimum), so a poll test pays a
  // second per attempt - passing 0 here would not make it faster.
  const t = Date.now();
  await auth.pollForDeviceCode("dc", { interval: 1, expiresIn: 60 });
  assert.ok(Date.now() - t >= 4000, "slow_down must actually slow the next poll down");
});

test("each terminal state has its own code, because the advice differs", async () => {
  for (const [error, code] of [
    ["authorization_declined", "declined"],
    ["expired_token", "code_expired"],
    ["bad_verification_code", "bad_code"],
    ["invalid_client", "devicecode_failed"],
  ]) {
    reset();
    handler = () => ({ status: 400, body: { error, error_description: "x" } });
    await assert.rejects(
      () => auth.pollForDeviceCode("dc", { interval: 1, expiresIn: 60 }),
      (e) => e.code === code,
      "expected " + error + " -> " + code,
    );
    // A terminal state must stop, not retry: exactly one poll went out.
    assert.equal(at("/token").length, 1, error + " must not be retried");
  }
});

test("the poll stops on its deadline rather than running for ever", async () => {
  reset();
  handler = () => ({ status: 400, body: { error: "authorization_pending" } });
  await assert.rejects(
    () => auth.pollForDeviceCode("dc", { interval: 1, expiresIn: 0 }),
    (e) => e.code === "code_expired",
  );
});

test("aborting the sign-in screen stops the poll", async () => {
  reset();
  handler = () => ({ status: 400, body: { error: "authorization_pending" } });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(
    () => auth.pollForDeviceCode("dc", { interval: 1, expiresIn: 60, signal: ac.signal }),
    (e) => e.code === "cancelled",
  );
});

// ------------------------------------------------------------- refresh

test("a 400 on refresh clears the account and asks for a new sign-in", async () => {
  reset();
  store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 0 });
  handler = () => ({ status: 400, body: { error: "invalid_grant" } });
  await assert.rejects(() => auth.getAccessToken(), (e) => e.code === "reauth_required");
  // A dead refresh token must not be kept: every later call would repeat a request
  // that can never succeed.
  assert.equal(store.hasAccount(), false);
});

test("a 500 on refresh keeps the account - that one is worth retrying later", async () => {
  reset();
  store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 0 });
  handler = () => ({ status: 503, body: "upstream down" });
  await assert.rejects(() => auth.getAccessToken(), (e) => e.code === "refresh_failed");
  assert.equal(store.hasAccount(), true);
});

test("a fresh access token is reused instead of refreshed", async () => {
  reset();
  store.setUserToken({ access_token: "still-good", refresh_token: "r", expires_in: 3600 });
  assert.equal(await auth.getAccessToken(), "still-good");
  assert.equal(seen.length, 0);
});

// ------------------------------------------------------------- XSTS

const signedIn = () => store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 3600 });
const xstsOk = { Token: "xsts-user", NotAfter: new Date(Date.now() + 3600e3).toISOString(), DisplayClaims: { xui: [{ uhs: "uhs", gtg: "Gamer", xid: "123" }] } };

test("an XErr is translated, because the actions differ completely", async () => {
  for (const [xerr, code] of [
    [2148916233, "no_xbox_account"],
    [2148916238, "child_account"],
    [2148916235, "region_unsupported"],
    [2148916227, "account_banned"],
  ]) {
    reset();
    signedIn();
    handler = () => ({ status: 401, body: { XErr: xerr, Redirect: "https://start.ui.xboxlive.com/..." } });
    await assert.rejects(() => auth.getXstsUserToken(), (e) => e.code === code, "XErr " + xerr);
  }
});

test("an unknown XErr keeps its number so a log is still actionable", async () => {
  reset();
  signedIn();
  handler = () => ({ status: 401, body: { XErr: 999999 } });
  await assert.rejects(
    () => auth.getXstsUserToken(),
    (e) => e.code === "xsts_denied" && e.detail.xerr === 999999 && /999999/.test(e.message),
  );
});

test("the user token is cached while valid", async () => {
  reset();
  signedIn();
  handler = () => ({ status: 200, body: xstsOk });
  await auth.getXstsUserToken();
  await auth.getXstsUserToken();
  assert.equal(at("/user/authenticate").length, 1);
});

test("an XSTS token already inside the skew window is not reused", async () => {
  reset();
  signedIn();
  handler = () => ({ status: 200, body: { ...xstsOk, NotAfter: new Date(Date.now() + 30e3).toISOString() } });
  await auth.getXstsUserToken();
  await auth.getXstsUserToken();
  assert.equal(at("/user/authenticate").length, 2, "30 s left is inside the 60 s skew");
});

// ------------------------------------------------------------- streaming token

const streamBody = (host) => ({
  gsToken: "gs",
  market: "DE",
  durationInSeconds: 14400,
  offeringSettings: {
    regions: [
      { name: "EASTUS", baseUri: "https://eus.core.gssv-play-prod.xboxlive.com", isDefault: false },
      { name: "WESTEUROPE", baseUri: "https://" + host + "/", isDefault: true },
    ],
  },
});

test("the streaming host is the default region's HOSTNAME, not its URL", async () => {
  reset();
  signedIn();
  handler = (c) => {
    if (c.path.includes("/user/authenticate") || c.path.includes("/xsts/authorize")) return { status: 200, body: xstsOk };
    return { status: 200, body: streamBody("weu.core.gssv-play-prod.xboxlive.com") };
  };
  const tok = await auth.getStreamingToken("xgpuweb");
  // A path is appended to this, so a full URL here builds "https://host/https://host/v2/titles".
  assert.equal(tok.host, "weu.core.gssv-play-prod.xboxlive.com");
  assert.equal(tok.market, "DE");
  assert.equal(tok.regions.length, 2);
});

test("a token offering no region to connect to is a failure, not an empty host", async () => {
  reset();
  signedIn();
  handler = (c) => {
    if (c.path.includes("authenticate") || c.path.includes("authorize")) return { status: 200, body: xstsOk };
    return { status: 200, body: { gsToken: "gs", offeringSettings: { regions: [] } } };
  };
  await assert.rejects(() => auth.getStreamingToken("xgpuweb"), (e) => e.code === "streaming_token_failed");
});

test("a 401 on the Ultimate offering falls back to free-to-play", async () => {
  reset();
  signedIn();
  const offerings = [];
  handler = (c) => {
    if (c.path.includes("authenticate") || c.path.includes("authorize")) return { status: 200, body: xstsOk };
    offerings.push(c.host.split(".")[0]);
    if (c.host.startsWith("xgpuweb.")) return { status: 401, body: "not sold here" };
    return { status: 200, body: streamBody("weu.core.gssv-play-prod.xboxlive.com") };
  };
  const tok = await auth.getCloudStreamingToken();
  assert.deepEqual(offerings, ["xgpuweb", "xgpuwebf2p"]);
  assert.equal(tok.offering, "xgpuwebf2p");
});

test("a 500 on the Ultimate offering does NOT fall back", async () => {
  reset();
  signedIn();
  handler = (c) => {
    if (c.path.includes("authenticate") || c.path.includes("authorize")) return { status: 200, body: xstsOk };
    return { status: 503, body: "down" };
  };
  // Falling back here would report a temporary outage as "Ultimate is not sold in
  // your country", which is a different thing to tell someone.
  await assert.rejects(() => auth.getCloudStreamingToken(), (e) => e.code === "streaming_token_failed");
  assert.equal(at("xgpuwebf2p").length, 0);
});

// ------------------------------------------------------------- transfer token

test("the transfer token comes from login.live.com, not the MSAL endpoint", async () => {
  reset();
  signedIn();
  handler = () => ({ status: 200, body: { access_token: "lpt-value", user_id: "u" } });
  const t = await auth.getTransferToken();
  assert.equal(t.lpt, "lpt-value");
  assert.equal(seen[0].host, "login.live.com");
  // A session in state ReadyToConnect wants this specific purpose scope; anything
  // else leaves it sitting there until it times out.
  assert.match(decodeURIComponent(seen[0].body), /PURPOSE_XBOX_CLOUD_CONSOLE_TRANSFER_TOKEN/);
});

test("nothing is attempted without an account", async () => {
  reset();
  for (const fn of [auth.getAccessToken, auth.getTransferToken]) {
    await assert.rejects(() => fn(), (e) => e.code === "not_signed_in");
  }
  assert.equal(seen.length, 0);
});

test.after(() => {
  https.request = REAL_REQUEST;
  fs.rmSync(DIR, { recursive: true, force: true });
});

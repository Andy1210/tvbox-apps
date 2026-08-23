// The session ladder. Everything asserted here about the order and the states was
// measured against the live server, because the ladder as documented is wrong in
// two places that both look like a slow server rather than a bug.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const https = require("https");
const { EventEmitter } = require("events");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-xcloud-session-"));
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
    res.headers = {};
    setImmediate(() => {
      cb(res);
      const text = out.body == null ? "" : typeof out.body === "string" ? out.body : JSON.stringify(out.body);
      if (text) res.emit("data", Buffer.from(text));
      res.emit("end");
    });
  };
  return req;
};

const auth = require("./xboxauth");
const store = require("./tokenstore");
const session = require("./session");

const xstsOk = { Token: "t", NotAfter: new Date(Date.now() + 3600e3).toISOString(), DisplayClaims: { xui: [{ uhs: "u" }] } };
const streamOk = {
  gsToken: "gs-token",
  market: "DE",
  durationInSeconds: 14400,
  offeringSettings: { regions: [{ name: "WESTEUROPE", baseUri: "https://weu.core.gssv-play-prod.xboxlive.com/", isDefault: true }] },
};

function reset() {
  seen.length = 0;
  auth.signOut();
  store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 3600 });
}

// Answers the token chain and delegates the gssv paths to `rest`.
const withAuth = (rest) => (c) => {
  if (c.path.includes("/user/authenticate") || c.path.includes("/xsts/authorize")) return { status: 200, body: xstsOk };
  if (c.path === "/v2/login/user") return { status: 200, body: streamOk };
  if (c.host === "login.live.com") return { status: 200, body: { access_token: "lpt-value", user_id: "u" } };
  return rest(c);
};

const gssvCalls = () => seen.filter((c) => c.host.startsWith("weu.core."));
const SID = "SESSION-ID";
const live = { id: SID, type: "cloud", target: "GAME" };

// ------------------------------------------------------------------- start

test("a cloud session names the title, a console session names the server", async () => {
  reset();
  handler = withAuth(() => ({ status: 200, body: { sessionPath: "/v5/sessions/cloud/" + SID } }));
  await session.start("GAME", { locale: "hu-HU" });
  let sent = JSON.parse(gssvCalls().find((c) => c.path.endsWith("/play")).body);
  assert.equal(sent.titleId, "GAME");
  assert.equal(sent.serverId, "");
  assert.equal(sent.settings.locale, "hu-HU");

  reset();
  handler = withAuth(() => ({ status: 200, body: { sessionPath: "/v5/sessions/home/" + SID } }));
  await session.start("CONSOLE", { type: "home" });
  sent = JSON.parse(gssvCalls().find((c) => c.path.endsWith("/play")).body);
  assert.equal(sent.titleId, "");
  assert.equal(sent.serverId, "CONSOLE");
});

test("the session id comes from the path, not from a sibling field", async () => {
  reset();
  handler = withAuth(() => ({ status: 200, body: { sessionPath: "/v5/sessions/cloud/FROM-PATH", sessionId: "FROM-FIELD" } }));
  assert.equal((await session.start("GAME")).id, "FROM-PATH");
  assert.equal(session.idFromPath("/v5/sessions/cloud/ABC"), "ABC");
  assert.equal(session.idFromPath("v5/sessions/cloud/ABC"), "ABC");
  assert.equal(session.idFromPath(""), "");
  assert.equal(session.idFromPath("/nope"), "");
});

test("a play that starts no session is an error, not an empty id", async () => {
  reset();
  handler = withAuth(() => ({ status: 200, body: { message: "no capacity" } }));
  await assert.rejects(() => session.start("GAME"), (e) => e.code === "no_session");
});

test("the display size travels in the device-info header", async () => {
  reset();
  handler = withAuth(() => ({ status: 200, body: { sessionPath: "/v5/sessions/cloud/" + SID } }));
  await session.start("GAME", { width: 1280, height: 720 });
  const info = JSON.parse(gssvCalls().find((c) => c.path.endsWith("/play")).headers["X-MS-Device-Info"]);
  assert.deepEqual(info.dev.displayInfo.dimensions, { widthInPixels: 1280, heightInPixels: 720 });
});

// ------------------------------------------------------------------- states

test("ReadyToConnect is handed the TRANSFER token, exactly once", async () => {
  reset();
  const states = ["ReadyToConnect", "ReadyToConnect", "Provisioning", "Provisioned"];
  let i = 0;
  handler = withAuth((c) => {
    if (c.path.endsWith("/state")) return { status: 200, body: { state: states[Math.min(i++, states.length - 1)] } };
    if (c.path.endsWith("/connect")) return { status: 200, body: {} };
    return { status: 404, body: "" };
  });
  await session.waitReady(live, { intervalMs: 1, timeoutMs: 5000 });

  const connects = gssvCalls().filter((c) => c.path.endsWith("/connect"));
  // Once: a second /connect on an already-connected session is not idempotent.
  assert.equal(connects.length, 1);
  // The transfer token, not the streaming token - handing over the wrong one
  // leaves the session in this state until it times out.
  assert.equal(JSON.parse(connects[0].body).userToken, "lpt-value");
  assert.equal(seen.some((c) => c.host === "login.live.com"), true);
});

test("a Failed session reports the server's own reason", async () => {
  reset();
  handler = withAuth((c) => ({ status: 200, body: { state: "Failed", errorDetails: { code: "WhatEver", message: "Your region is full" } } }));
  await assert.rejects(
    () => session.waitReady(live, { intervalMs: 1, timeoutMs: 5000 }),
    (e) => e.code === "session_failed" && /region is full/.test(e.message),
  );
});

test("a queue asks for an estimate at most every 30 s and reports how long it has been", async () => {
  reset();
  let polls = 0;
  handler = withAuth((c) => {
    if (c.path.endsWith("/state")) {
      polls++;
      return { status: 200, body: { state: polls < 12 ? "WaitingForResources" : "Provisioned" } };
    }
    if (c.path.includes("/v1/waittime/")) return { status: 200, body: { estimatedTotalWaitTimeInSeconds: 90 } };
    return { status: 404, body: "" };
  });
  const queue = [];
  await session.waitReady(live, { intervalMs: 1, timeoutMs: 5000, onQueue: (secs, elapsed) => queue.push([secs, elapsed]) });
  // Eleven state polls in a few milliseconds must not become eleven wait-time
  // requests: the estimate does not move that fast.
  assert.equal(gssvCalls().filter((c) => c.path.includes("/v1/waittime/")).length, 1);
  assert.equal(queue[0][0], 90);
  assert.equal(typeof queue[0][1], "number");
});

test("onState fires on a change, not on every poll", async () => {
  reset();
  let polls = 0;
  handler = withAuth((c) => {
    if (c.path.endsWith("/state")) {
      polls++;
      return { status: 200, body: { state: polls < 8 ? "Provisioning" : "Provisioned" } };
    }
    return { status: 404, body: "" };
  });
  const states = [];
  await session.waitReady(live, { intervalMs: 1, timeoutMs: 5000, onState: (s) => states.push(s) });
  // A caller that redraws per poll flickers.
  assert.deepEqual(states, ["Provisioning", "Provisioned"]);
});

test("waiting gives up on its own deadline and says what it last saw", async () => {
  reset();
  handler = withAuth((c) => ({ status: 200, body: { state: "Provisioning" } }));
  await assert.rejects(
    () => session.waitReady(live, { intervalMs: 1, timeoutMs: 40 }),
    (e) => e.code === "provision_timeout" && e.detail.last === "Provisioning",
  );
});

test("an unknown state keeps the session alive rather than failing it", async () => {
  reset();
  let polls = 0;
  handler = withAuth((c) => {
    if (c.path.endsWith("/state")) {
      polls++;
      return { status: 200, body: { state: polls < 4 ? "SomethingNew" : "Provisioned" } };
    }
    return { status: 404, body: "" };
  });
  const r = await session.waitReady(live, { intervalMs: 1, timeoutMs: 5000 });
  assert.equal(r.state, "Provisioned");
});

// ------------------------------------------------------------- configuration

test("configuration derives the keepalive interval instead of guessing it", async () => {
  reset();
  handler = withAuth(() => ({
    status: 200,
    body: {
      keepAlivePulseInSeconds: 60,
      timeoutForNoConnectionSeconds: 300,
      serverDetails: { ipV4Address: "13.0.0.1" },
      // It really does arrive as a string, and it carries the H.264 profile
      // preference the renderer has to honour.
      clientStreamingConfigOverrides: JSON.stringify({ videoConfiguration: { preferMainH264Profile: true } }),
    },
  }));
  const cfg = await session.configuration(live);
  assert.equal(cfg.keepAliveMs, 60000);
  assert.equal(cfg.noConnectionTimeoutMs, 300000);
  assert.equal(cfg.overrides.videoConfiguration.preferMainH264Profile, true);
});

test("a missing or absurd keepalive falls back rather than hammering", async () => {
  reset();
  handler = withAuth(() => ({ status: 200, body: { keepAlivePulseInSeconds: 0 } }));
  assert.equal((await session.configuration(live)).keepAliveMs, 60000);
  reset();
  handler = withAuth(() => ({ status: 200, body: { keepAlivePulseInSeconds: 1 } }));
  // A one-second pulse would be 3600 requests an hour; the floor holds.
  assert.equal((await session.configuration(live)).keepAliveMs, 15000);
});

test("an unreadable overrides blob does not fail the session", async () => {
  reset();
  handler = withAuth(() => ({ status: 200, body: { clientStreamingConfigOverrides: "{not json" } }));
  assert.deepEqual((await session.configuration(live)).overrides, {});
});

// ------------------------------------------------------------- exchanges

test("a 204 on an exchange is a wait, not an empty answer", async () => {
  reset();
  let gets = 0;
  handler = withAuth((c) => {
    if (c.method === "POST" && c.path.endsWith("/sdp")) return { status: 200, body: {} };
    gets++;
    if (gets < 3) return { status: 204, body: "" };
    return { status: 200, body: { exchangeResponse: JSON.stringify({ sdp: "answer", messageType: "answer" }) } };
  });
  const answer = await session.sendSdp(live, "v=0...", { timeoutMs: 5000 });
  // Reading the 204 as an answer is how an offer ends up never answered.
  assert.equal(answer.sdp, "answer");
  assert.equal(gets, 3);
});

test("the offer carries the channel versions, and a chat renegotiation does not", async () => {
  reset();
  handler = withAuth((c) => {
    if (c.method === "POST") return { status: 200, body: {} };
    return { status: 200, body: { exchangeResponse: "{}" } };
  });
  await session.sendSdp(live, "OFFER", { timeoutMs: 2000 });
  let sent = JSON.parse(gssvCalls().find((c) => c.method === "POST").body);
  assert.equal(sent.messageType, "offer");
  assert.equal(sent.sdp, "OFFER");
  // The input channel's protocol depends on the version agreed here.
  assert.equal(sent.configuration.input.maxVersion, 8);

  reset();
  handler = withAuth((c) => (c.method === "POST" ? { status: 200, body: {} } : { status: 200, body: { exchangeResponse: "{}" } }));
  await session.sendChatSdp(live, "MIC", { timeoutMs: 2000 });
  sent = JSON.parse(gssvCalls().find((c) => c.method === "POST").body);
  assert.equal(sent.configuration.isMediaStreamsChatRenegotiation, true);
  assert.equal(sent.configuration.input, undefined, "a renegotiation must not reset the agreed versions");
});

test("an exchange that never replies gives up", async () => {
  reset();
  handler = withAuth((c) => (c.method === "POST" ? { status: 200, body: {} } : { status: 204, body: "" }));
  await assert.rejects(() => session.sendSdp(live, "OFFER", { timeoutMs: 60 }), (e) => e.code === "exchange_timeout");
});

test("an exchange response that is not JSON is reported, not swallowed", async () => {
  reset();
  handler = withAuth((c) => (c.method === "POST" ? { status: 200, body: {} } : { status: 200, body: { exchangeResponse: "<html>" } }));
  await assert.rejects(() => session.sendSdp(live, "OFFER", { timeoutMs: 2000 }), (e) => e.code === "bad_exchange");
});

// ------------------------------------------------------------- ICE / Teredo

test("a Teredo candidate is unpacked into its IPv4 host and port", () => {
  // RFC 4380's own example: the port and the client address are stored
  // one's-complemented, which is the part that is easy to get wrong.
  assert.deepEqual(session.parseTeredo("2001:0:4136:e378:8000:63bf:3fff:fdd2"), { client4: "192.0.2.45", port: 40000 });
  // Written with a trailing dotted quad, as these addresses often are.
  assert.deepEqual(session.parseTeredo("2001:0:4136:e378:8000:63bf:63.255.253.210"), { client4: "192.0.2.45", port: 40000 });
});

test("an ordinary address is not read as Teredo", () => {
  for (const a of [
    "2a00:1450:4001:81b::200e",
    "2603:1020:204:FE::C0A8:3A", // Microsoft's own server address shape
    "2002:c000:22d::",
    "192.0.2.45",
    "",
    "not an address",
    "2001:0:4136:e378:8000:63bf:3fff", // seven groups
    "2001::0::1",
  ]) {
    assert.equal(session.parseTeredo(a), null, a);
  }
});

test("ICE candidates gain the unpacked pair and keep the original", async () => {
  reset();
  handler = withAuth((c) => {
    if (c.method === "POST") return { status: 200, body: {} };
    return {
      status: 200,
      body: {
        exchangeResponse: JSON.stringify([
          { candidate: "candidate:1 1 UDP 1 2001:0:4136:e378:8000:63bf:3fff:fdd2 9002 typ host", messageType: "iceCandidate" },
          { candidate: "candidate:2 1 UDP 1 13.104.115.6 1111 typ host", messageType: "iceCandidate" },
        ]),
      },
    };
  });
  const out = await session.sendIce(live, { candidate: "mine" }, { timeoutMs: 2000 });
  const lines = out.map((c) => c.candidate);
  // Two derived plus the original for the Teredo one, and the plain one untouched.
  assert.equal(out.length, 4);
  assert.ok(lines.some((l) => l.includes("192.0.2.45 9002")));
  assert.ok(lines.some((l) => l.includes("192.0.2.45 40000")));
  assert.ok(lines.some((l) => l.includes("2001:0:4136")), "the original candidate must survive");
  assert.ok(lines.some((l) => l.includes("13.104.115.6")));
});

test("a candidate line too short to hold an address yields nothing extra", () => {
  assert.deepEqual(session.teredoCandidates({ candidate: "candidate:1 1 UDP" }), []);
  assert.deepEqual(session.teredoCandidates({}), []);
  assert.deepEqual(session.teredoCandidates(null), []);
});

// ------------------------------------------------------------- keepalive/stop

test("stopping is a DELETE on the session itself", async () => {
  reset();
  handler = withAuth(() => ({ status: 200, body: {} }));
  await session.stop(live);
  const call = gssvCalls()[gssvCalls().length - 1];
  assert.equal(call.method, "DELETE");
  assert.equal(call.path, "/v5/sessions/cloud/" + SID);
});

test("keepalive posts to the session and returns what the server said", async () => {
  reset();
  handler = withAuth(() => ({ status: 200, body: { aliveSeconds: null, reason: "None" } }));
  const r = await session.keepalive(live);
  assert.equal(r.reason, "None");
  assert.equal(gssvCalls()[gssvCalls().length - 1].path, "/v5/sessions/cloud/" + SID + "/keepalive");
});

test.after(() => {
  https.request = REAL_REQUEST;
  fs.rmSync(DIR, { recursive: true, force: true });
});

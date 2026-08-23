// Starting, negotiating and stopping a stream session.
//
// The plugin does the SIGNALLING only. The WebRTC itself belongs to the renderer -
// Node has no RTCPeerConnection without a native module, and the page is where the
// video and the input channel have to live anyway. So this file is the state
// machine plus the SDP/ICE exchange, and the offer/answer strings pass through it.
//
// The ladder, confirmed against a live server rather than read off a diagram:
//
//   POST   /v5/sessions/cloud/play            -> sessionPath
//   GET    /v5/sessions/cloud/<id>/state      -> Provisioning | ReadyToConnect |
//                                                WaitingForResources | Provisioned | Failed
//   POST   /v5/sessions/cloud/<id>/connect    -> only for ReadyToConnect, and it
//                                                wants the Passport transfer token,
//                                                NOT the streaming token
//   GET    /v5/sessions/cloud/<id>/configuration
//   POST   /v5/sessions/cloud/<id>/sdp   then GET the same path -> the answer
//   POST   /v5/sessions/cloud/<id>/ice   then GET the same path -> the candidates
//   POST   /v5/sessions/cloud/<id>/keepalive
//   DELETE /v5/sessions/cloud/<id>
//
// Two things measured against the live server that the ladder does not show:
//
// `ReadyToConnect` is the step that is easy to miss, and it arrives BEFORE
// `Provisioning` rather than after it. A session that reaches it and is never
// handed the transfer token sits there until it times out, which looks exactly
// like a slow server.
//
// And a second /play for the same title returns the SAME session id - the server
// reattaches rather than starting a second one. So a session stranded by a shell
// restart costs nothing: the next launch picks it up. That is also why nothing here
// lists an account's running sessions; /v5/sessions/cloud/active from the reference
// client answers 404, as does every other version tried.
const api = require("./xcloudapi");
const auth = require("./xboxauth");

const TYPE_CLOUD = "cloud";
const TYPE_HOME = "home"; // streaming from one's own console - the ladder is identical

// Microsoft's own client identifies itself with this, and the response depends on
// it: the display dimensions decide the stream's resolution.
function deviceInfo(width, height) {
  return JSON.stringify({
    appInfo: {
      env: {
        clientAppId: "Microsoft.GamingApp",
        clientAppType: "native",
        clientAppVersion: "2203.1001.4.0",
        clientSdkVersion: "8.5.2",
        httpEnvironment: "prod",
        sdkInstallId: "",
      },
    },
    dev: {
      hw: { make: "Microsoft", model: "Surface Pro", sdktype: "native" },
      os: { name: "Windows 11", ver: "22631.2715", platform: "desktop" },
      displayInfo: {
        dimensions: { widthInPixels: width, heightInPixels: height },
        pixelDensity: { dpiX: 1, dpiY: 1 },
      },
    },
  });
}

// The channel versions the client speaks. These are a negotiation, not decoration:
// the server picks the highest it also supports, and the input channel's protocol
// depends on the number agreed here.
const CHANNEL_CONFIG = {
  chatConfiguration: {
    bytesPerSample: 2,
    expectedClipDurationMs: 20,
    format: { codec: "opus", container: "webm" },
    numChannels: 1,
    sampleFrequencyHz: 24000,
  },
  chat: { minVersion: 1, maxVersion: 1 },
  control: { minVersion: 1, maxVersion: 3 },
  input: { minVersion: 1, maxVersion: 8 },
  message: { minVersion: 1, maxVersion: 1 },
};

class SessionError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.detail = detail;
  }
}

const path = (type, id, tail) => "/v5/sessions/" + type + (id ? "/" + id : "") + (tail ? "/" + tail : "");

// The play response gives a sessionPath like /v5/sessions/cloud/<id>; the id is
// what every later call is addressed by, so take it from the path rather than
// trusting a sibling field that is not always there.
function idFromPath(sessionPath) {
  const parts = String(sessionPath || "").split("/").filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 1] : "";
}

async function start(target, opts) {
  const o = opts || {};
  const type = o.type === TYPE_HOME ? TYPE_HOME : TYPE_CLOUD;
  const res = await api.gssv("POST", path(type, "", "play"), {
    titleId: type === TYPE_CLOUD ? target : "",
    systemUpdateGroup: "",
    clientSessionId: "",
    settings: {
      nanoVersion: "V3;WebrtcTransport.dll",
      enableTextToSpeech: false,
      highContrast: 0,
      locale: o.locale || "en-US",
      useIceConnection: false,
      timezoneOffsetMinutes: o.timezoneOffsetMinutes != null ? o.timezoneOffsetMinutes : 0,
      sdkType: "web",
      osName: "windows",
    },
    serverId: type === TYPE_HOME ? target : "",
    fallbackRegionNames: [],
  }, { headers: { "X-MS-Device-Info": deviceInfo(o.width || 1920, o.height || 1080) }, timeout: 30000 });

  const body = res.json() || {};
  const id = idFromPath(body.sessionPath) || body.sessionId || "";
  if (!id) throw new SessionError("no_session", "The server started no session: " + (res.text || "").slice(0, 200));
  return { id, type, target, sessionPath: body.sessionPath || path(type, id) };
}

// Polls until the session is ready to negotiate, doing the one thing the state
// machine demands of us along the way.
//
// `onState` is called on every change rather than every poll, because the useful
// ones are a queue position and a failure - and a caller that redraws on each poll
// flickers.
async function waitReady(session, opts) {
  const o = opts || {};
  const deadlineAt = Date.now() + (o.timeoutMs || 300000);
  const intervalMs = o.intervalMs || 1000;
  let connectSent = false;
  let last = "";
  let waitSeconds = null;
  let waitAskedAt = 0;
  const startedAt = Date.now();

  for (;;) {
    cancelled(o.signal);
    if (Date.now() > deadlineAt) throw new SessionError("provision_timeout", "The session never became ready.", { last });

    const res = await api.gssv("GET", path(session.type, session.id, "state"), null, { timeout: 20000 });
    const body = res.json() || {};
    const state = String(body.state || "");
    if (state !== last) {
      last = state;
      if (o.onState) o.onState(state, body);
    }

    switch (state) {
      case "Provisioned":
        return { state, body };

      case "ReadyToConnect": {
        // The one action this loop owns. Sent once: a second /connect on an
        // already-connected session is not idempotent on this API.
        if (!connectSent) {
          connectSent = true;
          const { lpt } = await auth.getTransferToken();
          await api.gssv("POST", path(session.type, session.id, "connect"), { userToken: lpt }, { timeout: 20000 });
        }
        break;
      }

      case "WaitingForResources": {
        // A queue, and it can be long: measured at 224 s on this account while the
        // server's own estimate said 10. So the estimate is re-asked as the wait
        // goes on, but it must NOT be shown as a countdown - it is an order of
        // magnitude, and a timer that expires while you are still waiting is worse
        // than no timer. Asked at most every 30 s; it does not move faster.
        if (session.target && Date.now() - waitAskedAt > 30000) {
          waitAskedAt = Date.now();
          waitSeconds = await api.fetchWaitTime(session.target).catch(() => waitSeconds || 0);
          if (o.onQueue) o.onQueue(waitSeconds, Math.round((Date.now() - startedAt) / 1000));
        }
        break;
      }

      case "Failed":
        throw new SessionError("session_failed", failureMessage(body), { errorDetails: body.errorDetails });

      case "Provisioning":
      case "":
        break;

      default:
        // An unknown state is not a reason to give up - the ladder has gained
        // states before - but it is worth surfacing.
        if (o.onState) o.onState(state, body);
        break;
    }
    await sleep(intervalMs, o.signal);
  }
}

function failureMessage(body) {
  const d = (body && body.errorDetails) || {};
  if (d.message) return String(d.message);
  if (d.code) return "The session failed (" + d.code + ").";
  return "The session failed.";
}

// The server tells us how often to send a keepalive and how long it will wait
// without a connection, so neither is guessed. `clientStreamingConfigOverrides`
// arrives as a JSON STRING rather than an object - it carries the H.264 profile
// preference and the input reliability flag, which the renderer has to honour.
async function configuration(session) {
  const res = await api.gssv("GET", path(session.type, session.id, "configuration"), null, { timeout: 20000 });
  const cfg = res.json() || {};
  let overrides = {};
  if (typeof cfg.clientStreamingConfigOverrides === "string") {
    try {
      overrides = JSON.parse(cfg.clientStreamingConfigOverrides) || {};
    } catch {
      /* a blob we cannot read is not a reason to fail the session */
    }
  }
  return {
    ...cfg,
    overrides,
    keepAliveMs: Math.max(15000, positive(cfg.keepAlivePulseInSeconds, 60) * 1000),
    noConnectionTimeoutMs: positive(cfg.timeoutForNoConnectionSeconds, 300) * 1000,
  };
}

function cancelled(signal) {
  if (signal && signal.aborted) throw new SessionError("cancelled", "Cancelled.");
}

function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The exchange endpoints answer the POST with nothing useful and hand the result
// to a following GET, and that GET answers 204 while the other side has not
// replied yet. So an exchange is post-then-poll, and the 204 is a wait, not an
// empty answer - reading it as one is how an offer ends up with no answer.
async function exchange(session, kind, payload, opts) {
  const o = opts || {};
  cancelled(o.signal);
  await api.gssv("POST", path(session.type, session.id, kind), payload, { timeout: 20000 });

  const deadlineAt = Date.now() + (o.timeoutMs || 30000);
  for (;;) {
    // An aborted sleep RESOLVES rather than throwing, so without this the loop
    // simply polled on with no delay until its own deadline - a stopped session
    // still exchanging SDP against a session id it is about to delete.
    cancelled(o.signal);
    const res = await api.gssv("GET", path(session.type, session.id, kind), null, { timeout: 20000 });
    if (res.status !== 204) {
      const body = res.json() || {};
      if (body.exchangeResponse) {
        try {
          return JSON.parse(body.exchangeResponse);
        } catch {
          throw new SessionError("bad_exchange", "The " + kind + " exchange was not JSON.", { raw: String(body.exchangeResponse).slice(0, 200) });
        }
      }
      if (body.errorDetails) throw new SessionError("exchange_failed", failureMessage(body), { errorDetails: body.errorDetails });
    }
    if (Date.now() > deadlineAt) throw new SessionError("exchange_timeout", "The " + kind + " exchange got no reply.");
    await sleep(750, o.signal);
    cancelled(o.signal);
  }
}

const sendSdp = (session, sdp, opts) =>
  exchange(session, "sdp", { messageType: "offer", sdp, configuration: CHANNEL_CONFIG }, opts);

// A renegotiation for the microphone, which carries a different configuration and
// must not reset the channel versions already agreed.
const sendChatSdp = (session, sdp, opts) =>
  exchange(session, "sdp", { messageType: "offer", sdp, configuration: { isMediaStreamsChatRenegotiation: true } }, opts);

async function sendIce(session, candidate, opts) {
  const candidates = await exchange(session, "ice", { messageType: "iceCandidate", candidate }, opts);
  const list = Array.isArray(candidates) ? candidates : Object.values(candidates || {});
  return list.flatMap((c) => [...teredoCandidates(c), c]);
}

// A server candidate can be a Teredo address, which is an IPv6 wrapper around an
// IPv4 endpoint. On a network with no IPv6 route that candidate is unreachable as
// written, while the IPv4 host and port inside it are - so the pair is unpacked
// and offered alongside. Implemented here rather than taken from a library because
// a plugin has no node_modules on the box, and it is a fixed bit layout:
//
//   2001:0000:<server v4>:<flags><obscured port>:<obscured client v4>
//
// The port and the client address are stored one's-complemented (RFC 4380 s.4).
function teredoCandidates(entry) {
  const parts = String((entry && entry.candidate) || "").split(" ");
  if (parts.length <= 4) return [];
  const t = parseTeredo(parts[4]);
  if (!t) return [];
  const base = { messageType: "iceCandidate", sdpMLineIndex: "0", sdpMid: "0" };
  return [
    { ...base, candidate: "a=candidate:10 1 UDP 1 " + t.client4 + " 9002 typ host " },
    { ...base, candidate: "a=candidate:11 1 UDP 1 " + t.client4 + " " + t.port + " typ host " },
  ];
}

function parseTeredo(address) {
  const groups = expandIpv6(address);
  // The prefix is 2001:0000::/32; anything else is an ordinary address.
  if (!groups || groups.length !== 8 || groups[0] !== 0x2001 || groups[1] !== 0x0000) return null;
  const port = (~groups[5] & 0xffff) >>> 0;
  const client = (~((groups[6] << 16) | groups[7]) & 0xffffffff) >>> 0;
  return {
    client4: [(client >>> 24) & 0xff, (client >>> 16) & 0xff, (client >>> 8) & 0xff, client & 0xff].join("."),
    port,
  };
}

// Enough IPv6 parsing for the above: groups as numbers, "::" expanded, and a
// trailing dotted-quad (which a Teredo address is usually written with) folded
// into its two groups.
function expandIpv6(text) {
  let s = String(text || "").trim().toLowerCase();
  if (!s || s.includes(":::")) return null;
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);

  let tail = [];
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted) {
    const o = dotted[1].split(".").map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, dotted.index).replace(/:$/, "") + ":";
  }

  const dbl = s.indexOf("::");
  const parse = (part) => {
    if (part === "") return [];
    const out = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let groups;
  if (dbl >= 0) {
    const head = parse(s.slice(0, dbl).replace(/:$/, ""));
    const rest = parse(s.slice(dbl + 2).replace(/^:|:$/g, ""));
    if (!head || !rest) return null;
    const fill = 8 - (head.length + rest.length + tail.length);
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...rest, ...tail];
  } else {
    const head = parse(s.replace(/:$/, ""));
    if (!head) return null;
    groups = [...head, ...tail];
  }
  return groups.length === 8 ? groups : null;
}

const keepalive = (session) =>
  api.gssv("POST", path(session.type, session.id, "keepalive"), {}, { timeout: 15000 }).then((r) => r.json() || {});

/**
 * Is the session still there?
 *
 * Nothing tells us when the person quits from the Xbox guide - the server simply
 * ends the session, and the only thing that eventually notices is WebRTC's own
 * ICE timeout, about thirty seconds later. So the state is asked for.
 *
 * A 404 is the answer, not an error: the session is gone, which is exactly what
 * the question was.
 */
async function alive(session) {
  try {
    const res = await api.gssv("GET", path(session.type, session.id, "state"), null, { timeout: 15000 });
    const state = String((res.json() || {}).state || "");
    return { alive: state !== "Failed", state };
  } catch (e) {
    const status = e && e.detail && e.detail.status;
    if (status === 404) return { alive: false, state: "Gone" };
    // Anything else is a question we could not ask - a blip on the way to
    // Microsoft is not a reason to take a running game off the screen.
    return { alive: true, state: "", error: String(e.message || e) };
  }
}

// Stopping matters more than it looks: an abandoned session holds the account's
// slot, so the next launch is refused for a stream nobody is watching.
async function stop(session) {
  await api.gssv("DELETE", path(session.type, session.id), null, { timeout: 20000 });
}

// The listener is REMOVED on the ordinary path too. `{ once: true }` only covers
// the abort that fires; a signal that lives as long as the session (it does - one
// controller per session) collects one listener per poll otherwise, and these
// loops poll every 750 ms for as long as the exchange takes.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    let onAbort = null;
    const done = () => {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const t = setTimeout(done, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(t);
        done();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

module.exports = {
  SessionError,
  TYPE_CLOUD,
  TYPE_HOME,
  CHANNEL_CONFIG,
  start,
  waitReady,
  configuration,
  sendSdp,
  sendChatSdp,
  sendIce,
  keepalive,
  alive,
  stop,
  // Test seams for the pieces that are pure logic.
  idFromPath,
  parseTeredo,
  expandIpv6,
  teredoCandidates,
};

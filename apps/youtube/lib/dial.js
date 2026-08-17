// A DIAL receiver for ONE app: what puts the box in a phone's cast list, and the
// small REST service the phone then talks to.
//
// DIAL is what a phone's YouTube app uses to find a television that is not a
// Chromecast: it searches the LAN over SSDP, reads a device description, and POSTs
// a launch request carrying a pairing code. The receiver's job ends there - the code
// goes into the url of the TV page, and YouTube's own app is what joins the phone's
// session. So this module carries no YouTube knowledge beyond the app NAME.
//
// Two shapes worth knowing:
//   • the REST base is a HEADER on the device description (`Application-URL`), not
//     an element - a receiver that only serves the XML is invisible;
//   • the address advertised has to be one the PHONE can reach, and a box can have
//     both wifi and ethernet up, so it is chosen per request from the asker's own
//     subnet rather than fixed at start.
const dgram = require("dgram");
const http = require("http");
const os = require("os");

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const DIAL_ST = "urn:dial-multiscreen-org:service:dial:1";
// Any sender that reaches us is one of the household's phones, but the pairing code
// arrives unauthenticated, so both directions are bounded: a body this small holds
// every launch payload a sender sends, and the reply budget keeps an M-SEARCH flood
// from turning the box into an amplifier.
const MAX_BODY = 2048;
// Per SOURCE, not per box: one counter shared by everyone means a single chatty
// device (or a deliberate flood) makes the box disappear from every phone's cast
// list - measured, a legitimate searcher got none of its answers back.
//
// The global ceiling is generous on purpose: it exists to bound what the box can be
// made to EMIT (a reply is ~300 bytes, so 60/s is ~18 KB/s), and a tight one turned
// into a denial of discovery instead - five spoofed source addresses, or an ordinary
// household UPnP sweep, spent it and the phone got nothing. SSDP is UDP, so a
// determined attacker on the LAN can deny discovery whatever we do here; what this
// keeps is the box behaving under ordinary noise.
const MAX_REPLIES_PER_SEC = 4;
const MAX_REPLIES_PER_SEC_TOTAL = 60;
// A launch opens an app on the television. A person pressing cast produces one or
// two; anything beyond this from one source is not a person, and the box-wide ceiling
// is what a hundred addresses run into.
const MAX_LAUNCHES_PER_MIN = 12;
const MAX_LAUNCHES_PER_MIN_TOTAL = 30;
// How often a refusal is summarised into the log, rather than written per request.
const REFUSAL_LOG_EVERY_MS = 60000;
// A browser sender is allowed, but only YouTube's own pages: everything else that
// speaks CORS here is a page that has no business launching anything.
const ALLOWED_ORIGINS = new Set([
  "https://www.youtube.com",
  "https://youtube.com",
  "https://m.youtube.com",
  "https://music.youtube.com",
  "https://tv.youtube.com",
]);
// Sockets a sender may hold at once. The fds belong to the shell's own process,
// which also serves the launcher's API and the phone remote.
const MAX_CONNECTIONS = 64;
// How often to re-try the multicast join while it is failing. Long enough to be
// free, short enough that a box which came up before its network is findable by the
// time somebody reaches for a phone.
const JOIN_RETRY_MS = 15000;

// Is `ip` inside the network of this interface address? Both v4, both from
// os.networkInterfaces() / a socket, so a prefix compare on the masked words is
// enough - no dependency, and nothing here has to handle v6 (SSDP for DIAL is v4).
function sameSubnet(addr, mask, ip) {
  const words = (s) =>
    String(s)
      .split(".")
      .map((n) => Number(n));
  const [a, m, i] = [words(addr), words(mask), words(ip)];
  if (a.length !== 4 || m.length !== 4 || i.length !== 4) return false;
  if ([...a, ...m, ...i].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return a.every((byte, k) => (byte & m[k]) === (i[k] & m[k]));
}

// The address to advertise to `remoteIp`: the interface it can actually reach us on.
// A box with wifi and ethernet both up would otherwise hand out whichever one came
// first, and half the household's phones would find a device they cannot open.
function localAddressFor(remoteIp, ifaces = os.networkInterfaces()) {
  const v4 = [];
  for (const list of Object.values(ifaces || {})) {
    for (const n of list || []) {
      const four = n.family === "IPv4" || n.family === 4;
      if (four && !n.internal) v4.push(n);
    }
  }
  const hit = remoteIp && v4.find((n) => sameSubnet(n.address, n.netmask, remoteIp));
  return (hit || v4[0] || {}).address || "127.0.0.1";
}

// "::ffff:192.168.1.5" -> "192.168.1.5". Node reports a v4 peer this way on a
// dual-stack socket, and the subnet match above needs the plain form.
function plainIp(ip) {
  const s = String(ip || "");
  return s.startsWith("::ffff:") ? s.slice(7) : s;
}

// Is this datagram a search WE answer? Both targets get an answer, as a television
// does: a sender that asks for the DIAL service by name is the common case, but one
// that sweeps with `ssdp:all` and filters afterwards would never see a receiver that
// answers only the former - and being absent from the phone's list is the whole
// failure this feature exists to avoid. Anything else on the group (a NOTIFY, another
// device's search for a MediaRenderer) is not ours to answer.
function matchesSearch(buf) {
  const text = String(buf).slice(0, 1024);
  if (!/^M-SEARCH\b/i.test(text)) return false;
  const st = (/^ST:[ \t]*(.+?)[ \t]*$/im.exec(text) || [])[1];
  return st === DIAL_ST || st === "ssdp:all";
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * @param {object} o
 * @param {string} o.app          DIAL app name, e.g. "YouTube" (case matters to senders)
 * @param {() => string} o.friendlyName  what the phone lists, read per request
 * @param {string} o.uuid         stable device id (a reboot must not change it)
 * @param {number} [o.port]       preferred TCP port; taken port or 0 -> ephemeral
 * @param {() => boolean} o.isRunning  is the app on screen right now
 * @param {(launchData: string) => void} o.onLaunch  a phone cast: the POST body
 * @param {(msg: string) => void} [o.log]
 */
function createDialReceiver(o) {
  const app = String(o.app);
  const appPath = "/apps/" + app;
  let server = null;
  let ssdp = null;
  let repliesTotal = 0; // SSDP answers sent this second, all sources
  const repliesBy = new Map(); // source -> answers sent this second
  const launchesBy = new Map(); // source -> timestamps of its launches in the last minute
  let refusedCount = 0; // refusals since the last summary line
  let refusedLoggedAt = 0;
  let budgetTimer = null;
  let joinTimer = null; // retrying the multicast join (a box that booted before its wifi)
  let joined = false;
  const log = (m) => o.log && o.log(m);
  // How many distinct sources the SSDP budget tracks. Full, an unknown source is
  // refused: a reply is cheap, spoofing the source of a UDP search is free, and the
  // global ceiling is what such a flood runs into anyway. The launch budget needs no
  // equivalent - see launchAllowed.
  const MAX_SOURCES = 64;

  // May this source launch something right now? Three properties, each one a measured
  // failure of the simpler version:
  //
  //   • a SLIDING minute, not a fixed one - a fixed window let 24 launches land in a
  //     fifth of a second by straddling its boundary;
  //   • a ceiling for the BOX as well as per source - 64 addresses times a per-source
  //     limit was 768 page loads and 768 CEC power-ons a minute, and an attacker on
  //     the LAN can hold that many addresses;
  //   • no cap on the number of sources tracked, because the box-wide ceiling already
  //     is one: an entry is only recorded for a launch that was ALLOWED, so the table
  //     cannot hold more sources than that ceiling, and entries older than the window
  //     are dropped on the next call. A source cap here would only have given a flood a
  //     way to evict the household's own phone.
  function launchAllowed(from) {
    const now = Date.now();
    const cutoff = now - 60000;
    let total = 0;
    for (const [src, stamps] of launchesBy) {
      const live = stamps.filter((t) => t > cutoff);
      if (live.length) {
        launchesBy.set(src, live);
        total += live.length;
      } else launchesBy.delete(src);
    }
    if (total >= MAX_LAUNCHES_PER_MIN_TOTAL) return false;
    const mine = launchesBy.get(from) || [];
    if (mine.length >= MAX_LAUNCHES_PER_MIN) return false;
    mine.push(now);
    launchesBy.set(from, mine);
    return true;
  }

  const appUrlFor = (host) => "http://" + host + ":" + boundPort() + "/apps/";
  function boundPort() {
    const a = server && server.address();
    return (a && a.port) || 0;
  }

  // The description carries identity only. The REST base is NOT in here - it is the
  // `Application-URL` header on this response, which is the part a sender reads.
  function deviceXml() {
    return (
      '<?xml version="1.0"?>' +
      '<root xmlns="urn:schemas-upnp-org:device-1-0">' +
      "<specVersion><major>1</major><minor>0</minor></specVersion>" +
      "<device>" +
      "<deviceType>urn:schemas-upnp-org:device:tvdevice:1</deviceType>" +
      "<friendlyName>" +
      xmlEscape(o.friendlyName()) +
      "</friendlyName>" +
      "<manufacturer>tvbox</manufacturer><modelName>tvbox</modelName>" +
      "<UDN>uuid:" +
      xmlEscape(o.uuid) +
      "</UDN>" +
      "</device></root>"
    );
  }

  // The app's state, as DIAL asks it. "running" is reported only while the app is
  // ON SCREEN, and a backgrounded window counts as stopped: a page kept alive out
  // of sight is not a screen a phone is looking at, and a sender that believes the
  // app is up expects to drive it through a session this receiver cannot publish -
  // the leanback page holds its own screen id, so `additionalData` is empty and a
  // launch (with a fresh pairing code) is the only way in.
  function serviceXml() {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.2.1">' +
      "<name>" +
      xmlEscape(app) +
      "</name>" +
      '<options allowStop="false"/>' +
      "<state>" +
      (o.isRunning() ? "running" : "stopped") +
      "</state>" +
      "<additionalData></additionalData>" +
      "</service>"
    );
  }

  // CORS, and it is a gate rather than a courtesy. A launch is a CORS-SIMPLE
  // request, so no preflight stands between a page and this endpoint: without a
  // check, any page on the LAN - a guest phone's browser, an IoT device's web UI,
  // an ad frame inside an app running on the box - can take the television and
  // pair it to a stranger's session. The reference device in this house (a Fire
  // TV) answers 403 to a request whose Origin is not YouTube's, so this is the
  // protocol's own posture, not ours.
  //
  // A native sender (the phone's YouTube app) sends NO Origin at all and is
  // unaffected. A browser sender gets its own origin echoed - never `*`, because
  // the wildcard also lets any page READ the box's name, its stable id and
  // whether somebody is watching right now.
  function originOk(req) {
    const h = req.headers || {};
    // PRESENCE, not truthiness: `Origin:` with an empty value is a browser too, and
    // an empty string is not one of the origins we allow.
    if (!("origin" in h)) return true; // not a browser - nothing to gate
    return ALLOWED_ORIGINS.has(String(h.origin).toLowerCase());
  }

  // A refusal is the one log line an attacker controls the rate of - it happens
  // BEFORE any budget is charged, and both the path and the origin come off the
  // wire. Written out per request it is a storage-fill: measured at 3 GiB in six
  // seconds from one host, into a file with no rotation, which also destroys every
  // other line in it. So refusals are counted and summarised, and what is quoted is
  // cut to a length that cannot be used as a payload.
  function noteRefusal(method, path, origin) {
    refusedCount++;
    const now = Date.now();
    if (now - refusedLoggedAt < REFUSAL_LOG_EVERY_MS) return;
    refusedLoggedAt = now;
    const cut = (s) => String(s || "").slice(0, 60);
    log(
      "refused " +
        refusedCount +
        " request(s) from a browser origin we do not allow; last: " +
        cut(method) +
        " " +
        cut(path) +
        " origin " +
        cut(origin),
    );
    refusedCount = 0;
  }
  function corsFor(req) {
    const o2 = req.headers && req.headers.origin;
    if (!o2 || !ALLOWED_ORIGINS.has(String(o2).toLowerCase())) return {};
    return {
      "Access-Control-Allow-Origin": String(o2),
      // On the ACTUAL response, not only on the preflight: CORS hides a
      // non-safelisted response header from script otherwise, and these two are
      // where the protocol travels - the REST base and the launched instance.
      "Access-Control-Expose-Headers": "Location, Application-URL",
      Vary: "Origin",
    };
  }

  function send(res, code, body, type, extra) {
    const buf = Buffer.from(body || "");
    res.writeHead(code, { "Content-Type": type || "text/plain", "Content-Length": buf.length, ...(extra || {}) });
    res.end(buf);
  }

  function handle(req, res) {
    const path = String(req.url || "/").split("?")[0];
    const host = plainIp(req.socket && req.socket.localAddress) || localAddressFor(null);
    const cors = corsFor(req);
    if (!originOk(req)) {
      noteRefusal(req.method, path, req.headers.origin);
      return send(res, 403, "not allowed");
    }
    if (req.method === "OPTIONS") {
      return send(res, 204, "", "text/plain", {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Origin",
      });
    }
    // HEAD is how some senders probe before they read; answering 404 to it reads as
    // "no such device". Node suppresses the body itself, so the headers are enough.
    const reading = req.method === "GET" || req.method === "HEAD";
    if (reading && path === "/dd.xml") {
      return send(res, 200, deviceXml(), "text/xml; charset=utf-8", { ...cors, "Application-URL": appUrlFor(host) });
    }
    if (path === appPath && reading) {
      return send(res, 200, serviceXml(), "text/xml; charset=utf-8", cors);
    }
    if (path === appPath && req.method === "POST") {
      const from = plainIp(req.socket && req.socket.remoteAddress);
      // A launch opens an app and reloads a page, so it is the expensive route on
      // the box. One sender pressing cast is a couple of these; hundreds a second
      // is somebody holding the television in a reload loop.
      if (!launchAllowed(from)) {
        log("launch from " + from + " refused: too many");
        return send(res, 429, "too many", "text/plain", cors);
      }
      let body = "";
      let over = false;
      // BYTES, counted off the chunks, not the length of the string they decode to: a
      // JS string measures UTF-16 code units, so a multi-byte body passes a cap it has
      // already exceeded on the wire - and the cap is the bound on an unauthenticated
      // input.
      let bytes = 0;
      req.on("data", (c) => {
        if (over) return;
        bytes += c.length;
        body += c;
        if (bytes > MAX_BODY) {
          over = true;
          body = "";
          // Bounding memory is not enough: a sender that keeps writing holds a
          // socket and a request slot of the shell's own process.
          send(res, 413, "too large", "text/plain", cors);
          req.destroy();
        }
      });
      req.on("end", () => {
        if (over) return undefined;
        log("launch from " + from + " (" + bytes + " bytes)");
        let opened = false;
        try {
          opened = o.onLaunch(body) !== false;
        } catch (e) {
          log("launch handler: " + e.message);
        }
        // 201 + the instance's own url is what a sender waits for; without it the
        // cast is reported as failed even though the app came up. The opposite
        // matters too: if nothing opened - the app is not installed, or not ready -
        // saying 201 leaves the phone connected to a television that is doing
        // nothing, with no way to tell.
        if (!opened) return send(res, 503, "the app did not open", "text/plain", cors);
        return send(res, 201, "", "text/plain", { ...cors, LOCATION: appUrlFor(host) + app + "/run" });
      });
      return undefined;
    }
    // Stopping is advertised as unavailable (`allowStop="false"`), and the spec's
    // answer for that is 501 rather than a silent 404 - a sender that tried can
    // tell the difference between "no" and "no such app".
    if (path === appPath + "/run" && req.method === "DELETE")
      return send(res, 501, "stop is not offered", "text/plain", cors);
    return send(res, 404, "not found", "text/plain", cors);
  }

  // May we answer THIS asker right now? Charged per source first, so a flood costs
  // the flooder its own budget and nobody else's, and only then against the global
  // ceiling that bounds what the box can be made to emit.
  function replyAllowed(address) {
    // Per source FIRST: a flooder should spend its own budget before it can spend the
    // box's, so an honest asker is still inside the ceiling when it arrives.
    const mine = repliesBy.get(address) || 0;
    if (mine >= MAX_REPLIES_PER_SEC) return false;
    if (repliesTotal >= MAX_REPLIES_PER_SEC_TOTAL) return false;
    if (!repliesBy.has(address) && repliesBy.size >= MAX_SOURCES) return false;
    repliesBy.set(address, mine + 1);
    repliesTotal++;
    return true;
  }

  function ssdpReply(remote) {
    if (!replyAllowed(remote.address)) return;
    const host = localAddressFor(remote.address);
    const msg = Buffer.from(
      "HTTP/1.1 200 OK\r\n" +
        "LOCATION: http://" +
        host +
        ":" +
        boundPort() +
        "/dd.xml\r\n" +
        "CACHE-CONTROL: max-age=1800\r\n" +
        "EXT:\r\n" +
        "BOOTID.UPNP.ORG: 1\r\n" +
        "SERVER: Linux/6 UPnP/1.1 tvbox/1\r\n" +
        "ST: " +
        DIAL_ST +
        "\r\n" +
        "USN: uuid:" +
        o.uuid +
        "::" +
        DIAL_ST +
        "\r\n\r\n",
    );
    ssdp.send(msg, remote.port, remote.address, (e) => e && log("ssdp reply: " + e.message));
  }

  function onSsdp(buf, remote) {
    if (matchesSearch(buf)) ssdpReply(remote);
  }

  function startHttp(preferred, cb) {
    server = http.createServer(handle);
    // Idle sockets and half-sent requests are the cheap half of a denial attempt,
    // and the file descriptors come out of the shell's own process - the one that
    // also serves the launcher's API and the phone remote. Node refuses a
    // connection beyond the cap rather than queueing it.
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 5000;
    // Without this Node only CHECKS those timeouts every 30 s, so a socket held with
    // one byte a minute lived 21-30 s each time - long enough for a handful of them
    // to keep the connection table full and the receiver unreachable indefinitely.
    server.connectionsCheckingInterval = 2000;
    server.on("error", (e) => {
      if (e.code === "EADDRINUSE" && preferred !== 0) {
        // Somebody else holds the preferred port. The port only has to be reachable,
        // never guessable: it travels in the LOCATION a sender reads.
        log("port " + preferred + " is taken, taking any free one");
        server.removeAllListeners("error");
        server = null;
        return startHttp(0, cb);
      }
      log("http: " + e.message);
      server = null;
      if (cb) {
        const done = cb;
        cb = null;
        done(e);
      }
    });
    server.listen(preferred, "0.0.0.0", () => {
      log("dial rest on :" + boundPort());
      if (cb) {
        const done = cb;
        cb = null;
        done(null);
      }
    });
  }

  function startSsdp(cb) {
    ssdp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    ssdp.on("error", (e) => {
      log("ssdp: " + e.message);
      try {
        ssdp.close();
      } catch (x) {}
      ssdp = null;
      if (cb) {
        const done = cb;
        cb = null;
        done(e);
      }
    });
    ssdp.on("message", onSsdp);
    ssdp.bind(SSDP_PORT, () => {
      // Joining the group is what makes the box FINDABLE - the REST half being up
      // means nothing to a phone that never learns the address. A box that boots
      // before its wifi associates fails this join, so it is retried rather than
      // logged and forgotten: without the retry the receiver reports success and
      // stays invisible until somebody toggles the switch, which is the least
      // diagnosable failure this feature can have.
      joinGroup();
      log("ssdp listening on :" + SSDP_PORT);
      if (cb) {
        const done = cb;
        cb = null;
        done(null);
      }
    });
  }

  function joinGroup() {
    if (!ssdp) return;
    try {
      ssdp.addMembership(SSDP_ADDR);
      joined = true;
      if (joinTimer) clearInterval(joinTimer);
      joinTimer = null;
      return;
    } catch (e) {
      log("ssdp membership: " + e.message + (joinTimer ? "" : "; retrying every " + JOIN_RETRY_MS / 1000 + "s"));
    }
    if (joinTimer) return;
    joinTimer = setInterval(joinGroup, JOIN_RETRY_MS);
    if (joinTimer.unref) joinTimer.unref();
  }

  return {
    // (cb) -> cb(err|null). Starts the REST service first: the SSDP answer carries
    // its port, so advertising before it is bound would send phones to nothing.
    start(cb) {
      if (server) return void (cb && cb(null));
      budgetTimer = setInterval(() => {
        repliesTotal = 0;
        repliesBy.clear();
      }, 1000);
      if (budgetTimer.unref) budgetTimer.unref();
      startHttp(Number(o.port) || 0, (e) => {
        if (e) return cb && cb(e);
        startSsdp((e2) => cb && cb(e2 || null));
      });
    },
    stop(cb) {
      if (budgetTimer) clearInterval(budgetTimer);
      budgetTimer = null;
      if (joinTimer) clearInterval(joinTimer);
      joinTimer = null;
      joined = false;
      const s = server;
      const u = ssdp;
      server = null;
      ssdp = null;
      try {
        if (u) u.close();
      } catch (e) {}
      if (!s) return void (cb && cb());
      // A sender keeps its connection open between requests, and `close` alone waits
      // for it - turning the switch off has to mean off.
      try {
        s.closeAllConnections();
      } catch (e) {}
      s.close(() => cb && cb());
    },
    running: () => !!server,
    // Findable, not merely running: the REST half being up means nothing to a phone
    // that never learns the address. A caller can tell the two apart.
    findable: () => !!server && joined,
    port: boundPort,
    // for tests: the decisions, without sockets
    _handle: handle,
    _onSsdp: onSsdp,
    _replyAllowed: replyAllowed,
    _launchAllowed: launchAllowed,
  };
}

module.exports = {
  ALLOWED_ORIGINS,
  MAX_LAUNCHES_PER_MIN,
  MAX_LAUNCHES_PER_MIN_TOTAL,
  MAX_REPLIES_PER_SEC,
  MAX_REPLIES_PER_SEC_TOTAL,
  createDialReceiver,
  localAddressFor,
  sameSubnet,
  matchesSearch,
  DIAL_ST,
  MAX_BODY,
  MAX_REPLIES_PER_SEC,
};

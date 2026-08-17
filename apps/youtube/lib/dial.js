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
// list - measured, a legitimate searcher got none of its answers back. The global
// ceiling stays as the amplification bound.
const MAX_REPLIES_PER_SEC = 4;
const MAX_REPLIES_PER_SEC_TOTAL = 20;
// A launch opens an app on the television. A person pressing cast produces one or
// two; anything beyond this from one source is not a person.
const MAX_LAUNCHES_PER_MIN = 12;
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
const MAX_CONNECTIONS = 32;

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
  const launchesBy = new Map(); // source -> launches this minute
  let launchWindowAt = 0;
  let budgetTimer = null;
  const log = (m) => o.log && o.log(m);
  // How many distinct sources a budget map will track. Full and asked about an
  // unknown one, both budgets refuse: under a flood the honest answer is "no",
  // and clearing the map instead would hand the flooder a way to reset it.
  const MAX_SOURCES = 64;

  function launchAllowed(from) {
    const now = Date.now();
    if (now - launchWindowAt >= 60000) {
      launchesBy.clear();
      launchWindowAt = now;
    }
    const seen = launchesBy.has(from);
    if (!seen && launchesBy.size >= MAX_SOURCES) return false;
    const n = (launchesBy.get(from) || 0) + 1;
    launchesBy.set(from, n);
    return n <= MAX_LAUNCHES_PER_MIN;
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
    const o2 = req.headers && req.headers.origin;
    if (!o2) return true; // not a browser - nothing to gate
    return ALLOWED_ORIGINS.has(String(o2).toLowerCase());
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
      log("refused " + req.method + " " + path + " from origin " + req.headers.origin);
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
      req.on("data", (c) => {
        if (over) return;
        body += c;
        if (body.length > MAX_BODY) {
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
        log("launch from " + from + " (" + body.length + " bytes)");
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
    if (repliesTotal >= MAX_REPLIES_PER_SEC_TOTAL) return false;
    const mine = repliesBy.get(address) || 0;
    if (mine >= MAX_REPLIES_PER_SEC) return false;
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
      try {
        ssdp.addMembership(SSDP_ADDR);
      } catch (e) {
        // A box with no route to the multicast group yet (booting, wifi still
        // associating) must not lose the receiver for good - the REST half is up,
        // and a restart of the switch re-tries the join.
        log("ssdp membership: " + e.message);
      }
      log("ssdp listening on :" + SSDP_PORT);
      if (cb) {
        const done = cb;
        cb = null;
        done(null);
      }
    });
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

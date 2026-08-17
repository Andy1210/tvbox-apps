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
const MAX_REPLIES_PER_SEC = 10;

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
  let replies = 0; // budget for this second
  let budgetTimer = null;
  const log = (m) => o.log && o.log(m);

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

  function send(res, code, body, type, extra) {
    const buf = Buffer.from(body || "");
    res.writeHead(code, {
      "Content-Type": type || "text/plain",
      "Content-Length": buf.length,
      // A sender may be a web page (a browser's cast button), and every route here
      // is either a read or "open YouTube" - the same thing any remote in the room
      // can do - so the reads stay open rather than guessing an Origin allowlist.
      "Access-Control-Allow-Origin": "*",
      ...(extra || {}),
    });
    res.end(buf);
  }

  function handle(req, res) {
    const path = String(req.url || "/").split("?")[0];
    const host = plainIp(req.socket && req.socket.localAddress) || localAddressFor(null);
    if (req.method === "OPTIONS") {
      return send(res, 204, "", "text/plain", {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Origin",
        "Access-Control-Expose-Headers": "Location",
      });
    }
    if (req.method === "GET" && path === "/dd.xml") {
      return send(res, 200, deviceXml(), "text/xml; charset=utf-8", { "Application-URL": appUrlFor(host) });
    }
    if (path === appPath && req.method === "GET") {
      return send(res, 200, serviceXml(), "text/xml; charset=utf-8");
    }
    if (path === appPath && req.method === "POST") {
      let body = "";
      let over = false;
      req.on("data", (c) => {
        if (over) return;
        body += c;
        if (body.length > MAX_BODY) {
          over = true;
          body = "";
        }
      });
      req.on("end", () => {
        if (over) return send(res, 413, "too large");
        log("launch from " + plainIp(req.socket && req.socket.remoteAddress) + " (" + body.length + " bytes)");
        try {
          o.onLaunch(body);
        } catch (e) {
          log("launch handler: " + e.message);
        }
        // 201 + the instance's own url is what a sender waits for; without it the
        // cast is reported as failed even though the app came up.
        return send(res, 201, "", "text/plain", { LOCATION: appUrlFor(host) + app + "/run" });
      });
      return undefined;
    }
    // Stopping is advertised as unavailable (`allowStop="false"`), and the spec's
    // answer for that is 501 rather than a silent 404 - a sender that tried can
    // tell the difference between "no" and "no such app".
    if (path === appPath + "/run" && req.method === "DELETE") return send(res, 501, "stop is not offered");
    return send(res, 404, "not found");
  }

  function ssdpReply(remote) {
    if (replies >= MAX_REPLIES_PER_SEC) return;
    replies++;
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
      budgetTimer = setInterval(() => (replies = 0), 1000);
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
    // for tests: the request handler and the SSDP decision, without sockets
    _handle: handle,
    _onSsdp: onSsdp,
  };
}

module.exports = {
  createDialReceiver,
  localAddressFor,
  sameSubnet,
  matchesSearch,
  DIAL_ST,
  MAX_BODY,
  MAX_REPLIES_PER_SEC,
};

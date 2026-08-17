// The receiver a phone finds, and what it may do once it has.
//
// Every case here is a decision a SENDER makes on our answer: the REST base travels
// as a header (a receiver that only serves the XML is invisible), a launch has to be
// 201 with a LOCATION or the cast reads as failed on the phone, and the app state is
// what decides whether a launch is sent at all. The advertised address is its own
// subject, because a box can have wifi and ethernet up at once and only one of them
// is the one the phone came in on.
// Run: node --test apps/youtube/lib/dial.test.js
const test = require("node:test");
const assert = require("node:assert");
const { createDialReceiver, localAddressFor, sameSubnet, matchesSearch, MAX_BODY } = require("./dial");

function receiver(over = {}) {
  const launches = [];
  const r = createDialReceiver({
    app: "YouTube",
    friendlyName: () => "tvbox-livingroom",
    uuid: "11111111-2222-5333-8444-555555555555",
    isRunning: () => false,
    onLaunch: (d) => launches.push(d),
    log: () => {},
    ...over,
  });
  return { r, launches };
}

// A request/response pair as far as the handler can tell.
function fakeReq(method, url, { body = null, localAddress = "192.168.1.219", remoteAddress = "192.168.1.50" } = {}) {
  const on = {};
  return {
    method,
    url,
    socket: { localAddress, remoteAddress },
    on(ev, fn) {
      on[ev] = fn;
      // The body arrives AFTER the handler subscribed, which is the order a real
      // request has: pushing it first would let a handler with no reader pass.
      if (ev === "end" && body !== null) {
        if (on.data) on.data(Buffer.from(body));
        fn();
      }
      return this;
    },
  };
}

function fakeRes() {
  const out = { code: 0, headers: {}, body: "" };
  return {
    out,
    writeHead(code, headers) {
      out.code = code;
      out.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    },
    end(b) {
      out.body = String(b || "");
    },
  };
}

function call(r, method, url, opts) {
  const res = fakeRes();
  r._handle(fakeReq(method, url, opts), res);
  return res.out;
}

test("the description carries the REST base as a HEADER, on the address the phone reached", () => {
  const { r } = receiver();
  const out = call(r, "GET", "/dd.xml", { localAddress: "192.168.1.219" });
  assert.equal(out.code, 200);
  assert.match(out.headers["application-url"], /^http:\/\/192\.168\.1\.219:\d+\/apps\/$/);
  assert.match(out.body, /<friendlyName>tvbox-livingroom<\/friendlyName>/);
  assert.match(out.body, /uuid:11111111-2222-5333-8444-555555555555/);
});

test("a box name that would break the XML is escaped", () => {
  const { r } = receiver({ friendlyName: () => 'tv & "box" <lounge>' });
  const body = call(r, "GET", "/dd.xml").body;
  assert.match(body, /tv &amp; &quot;box&quot; &lt;lounge&gt;/);
  assert.ok(!body.includes("<lounge>"));
});

test("an IPv4-mapped peer address is advertised as plain IPv4", () => {
  const { r } = receiver();
  const out = call(r, "GET", "/dd.xml", { localAddress: "::ffff:192.168.1.219" });
  assert.match(out.headers["application-url"], /^http:\/\/192\.168\.1\.219:/);
});

test("the app reads as stopped while it is not on screen, which is what makes a phone launch it", () => {
  const { r } = receiver({ isRunning: () => false });
  const body = call(r, "GET", "/apps/YouTube").body;
  assert.match(body, /<state>stopped<\/state>/);
  assert.match(body, /<options allowStop="false"\/>/);
  assert.match(body, /dialVer="/);
  // No screen id: the leanback page holds its own, so a launch (with a fresh pairing
  // code) is the only way in - an empty additionalData is what says that.
  assert.match(body, /<additionalData><\/additionalData>/);
});

test("and as running while it is", () => {
  const { r } = receiver({ isRunning: () => true });
  assert.match(call(r, "GET", "/apps/YouTube").body, /<state>running<\/state>/);
});

test("only the app this receiver was built for exists, by exact name", () => {
  const { r } = receiver();
  assert.equal(call(r, "GET", "/apps/Netflix").code, 404);
  assert.equal(call(r, "GET", "/apps/youtube").code, 404); // senders address it as "YouTube"
});

test("a launch hands the body over and answers 201 with the instance url", () => {
  const { r, launches } = receiver();
  const out = call(r, "POST", "/apps/YouTube", { body: "pairingCode=abc-123&theme=cl" });
  assert.deepEqual(launches, ["pairingCode=abc-123&theme=cl"]);
  assert.equal(out.code, 201);
  assert.match(out.headers.location, /\/apps\/YouTube\/run$/);
});

test("a launch is answered even when opening the app throws", () => {
  // A sender with no reply retries, and a cast has to fail on the TV rather than
  // silently on the phone.
  const { r } = receiver({
    onLaunch: () => {
      throw new Error("no window");
    },
  });
  assert.equal(call(r, "POST", "/apps/YouTube", { body: "pairingCode=x" }).code, 201);
});

test("a body too big to be a launch is refused, and nothing is opened", () => {
  const { r, launches } = receiver();
  const out = call(r, "POST", "/apps/YouTube", { body: "x".repeat(MAX_BODY + 1) });
  assert.equal(out.code, 413);
  assert.deepEqual(launches, []);
});

test("an empty body is a launch too - a sender may carry no pairing code", () => {
  const { r, launches } = receiver();
  assert.equal(call(r, "POST", "/apps/YouTube", { body: "" }).code, 201);
  assert.deepEqual(launches, [""]);
});

test("stop says it is not offered rather than that the app is gone", () => {
  const { r } = receiver();
  assert.equal(call(r, "DELETE", "/apps/YouTube/run").code, 501);
});

test("a browser's preflight is answered, since a cast button can be a web page", () => {
  const { r } = receiver();
  const out = call(r, "OPTIONS", "/apps/YouTube");
  assert.equal(out.code, 204);
  assert.match(out.headers["access-control-allow-methods"], /POST/);
});

test("nothing else is served", () => {
  const { r } = receiver();
  for (const [m, u] of [
    ["GET", "/"],
    ["GET", "/apps/"],
    ["GET", "/../etc/passwd"],
    ["GET", "/dd.xml/../apps/YouTube"],
    ["POST", "/dd.xml"],
    ["PUT", "/apps/YouTube"],
    ["POST", "/apps/YouTube/run"],
  ]) {
    assert.equal(call(r, m, u).code, 404, m + " " + u);
  }
});

test("a query string does not change which route was asked for", () => {
  const { r } = receiver();
  assert.equal(call(r, "GET", "/apps/YouTube?v=2").code, 200);
  assert.equal(call(r, "GET", "/dd.xml?x=1").code, 200);
});

const search = (st) =>
  Buffer.from(
    'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ' + st + "\r\n\r\n",
  );

test("the DIAL search and a broad sweep are answered; other traffic on the group is not", () => {
  assert.equal(matchesSearch(search("urn:dial-multiscreen-org:service:dial:1")), true);
  assert.equal(matchesSearch(search("ssdp:all")), true);
  assert.equal(matchesSearch(search("upnp:rootdevice")), false);
  assert.equal(matchesSearch(search("urn:schemas-upnp-org:device:MediaRenderer:1")), false);
  assert.equal(matchesSearch(search("")), false);
  // A NOTIFY carries an ST too, and every device on the LAN multicasts them.
  assert.equal(
    matchesSearch(Buffer.from("NOTIFY * HTTP/1.1\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n")),
    false,
  );
  assert.equal(matchesSearch(Buffer.from("")), false);
});

test("a search header is read with the spacing senders really write", () => {
  assert.equal(matchesSearch(Buffer.from("M-SEARCH * HTTP/1.1\r\nst:   ssdp:all   \r\n\r\n")), true);
  // ...but a target that merely CONTAINS ours is a different target.
  assert.equal(matchesSearch(search("urn:dial-multiscreen-org:service:dial:1x")), false);
});

test("the address advertised is the interface the asker can reach, not whichever came first", () => {
  const ifaces = {
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
    eth0: [{ address: "10.0.0.7", netmask: "255.255.255.0", family: "IPv4", internal: false }],
    wlan0: [{ address: "192.168.1.219", netmask: "255.255.255.0", family: "IPv4", internal: false }],
  };
  assert.equal(localAddressFor("192.168.1.50", ifaces), "192.168.1.219");
  assert.equal(localAddressFor("10.0.0.99", ifaces), "10.0.0.7");
  // An asker on neither still gets a real interface, and never loopback - a phone
  // cannot reach that, and it is the address a naive pick lands on.
  assert.equal(localAddressFor("172.16.0.5", ifaces), "10.0.0.7");
  assert.equal(localAddressFor(null, ifaces), "10.0.0.7");
  assert.equal(localAddressFor("192.168.1.50", { lo: ifaces.lo }), "127.0.0.1", "with no interface, there is none");
});

test("subnets are compared by mask, not by leading digits", () => {
  assert.equal(sameSubnet("192.168.1.219", "255.255.255.0", "192.168.1.50"), true);
  assert.equal(sameSubnet("192.168.1.219", "255.255.255.0", "192.168.2.50"), false);
  assert.equal(sameSubnet("10.0.0.7", "255.255.0.0", "10.0.9.9"), true);
  assert.equal(sameSubnet("bogus", "255.255.255.0", "192.168.1.5"), false);
  assert.equal(sameSubnet("192.168.1.1", "255.255.255.0", "999.1.1.1"), false);
});

// The sockets themselves: bound on an ephemeral port so the test needs no fixed one,
// and a stop that really lets go - the switch in Settings has to mean off.
test("it starts, answers on the port it advertises, and stops", async () => {
  const http = require("node:http");
  const { r } = receiver({ port: 0 });
  await new Promise((res, rej) => r.start((e) => (e ? rej(e) : res())));
  try {
    assert.ok(r.port() > 0, "no port");
    assert.equal(r.running(), true);
    const body = await new Promise((res, rej) => {
      http
        .get({ host: "127.0.0.1", port: r.port(), path: "/apps/YouTube" }, (m) => {
          let s = "";
          m.on("data", (c) => (s += c));
          m.on("end", () => res(s));
        })
        .on("error", rej);
    });
    assert.match(body, /<name>YouTube<\/name>/);
  } finally {
    await new Promise((res) => r.stop(res));
  }
  assert.equal(r.running(), false);
});

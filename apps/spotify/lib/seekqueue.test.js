// Moving inside a song, and reading what is queued behind it.
//
// Both are writes/reads against the account HOLDING THE BOX rather than the
// active one, which is the same gap boxcontrol.test.js exists for: an account
// can be playing in another room, and a seek that lands there moves somebody
// else's song. The stub records the bearer token every request carried, so each
// assertion can say which account it went out as.
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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-spotify-seekqueue-"));
process.env.HOME = HOME;
fs.mkdirSync(path.join(HOME, ".tvbox"), { recursive: true });
fs.writeFileSync(
  path.join(HOME, ".tvbox", "spotify-accounts.json"),
  JSON.stringify({
    active: "u1",
    list: [
      { id: "u1", name: "One", token: "r1" },
      { id: "u2", name: "Two", token: "r2" },
    ],
  }),
);

let handler = () => ({ status: 500, body: "" });
let seen = [];
https.request = (opts, cb) => {
  const req = new EventEmitter();
  let body = "";
  req.setTimeout = () => {};
  req.write = (c) => {
    body += c;
  };
  req.destroy = () => {};
  req.end = () => {
    const auth = String((opts.headers || {}).Authorization || "");
    seen.push({ method: opts.method, path: opts.path, bearer: auth.startsWith("Bearer ") ? auth.slice(7) : "", body });
    const out = handler(opts.path, opts, body) || { status: 500, body: "" };
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

const bridge = require("./spotify");
const api = require("./spotify_api");
const CONFIG = { rawSpotify: () => ({ clientId: "id", clientSecret: "secret", deviceName: "tvbox-test" }) };
api.setConfig(CONFIG);
bridge.setConfig(CONFIG);

test.after(() => {
  https.request = REAL_REQUEST;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

const BOX = { id: "dev-box", name: "tvbox-test", type: "TV" };
const PHONE = { id: "dev-phone", name: "A phone", type: "Smartphone" };

const QUEUE_BODY = JSON.stringify({
  currently_playing: { uri: "spotify:track:now", name: "Now" },
  queue: [
    {
      uri: "spotify:track:a",
      name: "A",
      duration_ms: 180000,
      artists: [{ name: "One" }, { name: "Two" }],
      album: { images: [{ url: "big.jpg" }, { url: "small.jpg" }] },
    },
    { uri: "spotify:track:b", name: "B", duration_ms: 90000, artists: [], album: {} },
    "not an object",
  ],
});

function serve({ boxOn, queueBody, queueStatus }) {
  handler = (url, opts, body) => {
    if (url === "/api/token") {
      const refresh = new URLSearchParams(body).get("refresh_token");
      return { status: 200, body: JSON.stringify({ access_token: "at-" + refresh, expires_in: 3600 }) };
    }
    const who = String((opts.headers || {}).Authorization || "").replace("Bearer at-r", "u");
    if (url === "/v1/me/player/devices")
      return { status: 200, body: JSON.stringify({ devices: who === boxOn ? [PHONE, BOX] : [PHONE] }) };
    if (url === "/v1/me/player/queue")
      return { status: queueStatus || 200, body: queueStatus ? "" : queueBody || QUEUE_BODY };
    if (url === "/v1/me/player") return { status: 200, body: JSON.stringify({}) };
    if (url.startsWith("/v1/me/player/")) return { status: 204, body: "" };
    return { status: 404, body: "" };
  };
}
function castFrom(user) {
  bridge.handleEvent({ player_event: "session_connected", user_name: user }, true);
}
function reset(activeId) {
  seen = [];
  api.forgetBoxDevice();
  bridge.clear();
  api.switchAccount(activeId || "u1");
}
const writes = () => seen.filter((r) => r.method !== "GET" && r.path !== "/api/token");

test("a seek goes to the box's own device, as the account holding it", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");

  const r = await api.control("seek", "65000");

  assert.deepEqual(r, { ok: true, error: "" });
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].method, "PUT");
  assert.equal(w[0].bearer, "at-r2", "sent as the account holding the box");
  assert.match(w[0].path, /^\/v1\/me\/player\/seek\?position_ms=65000&device_id=dev-box$/);
});

test("a position that is not a number never reaches Spotify", async () => {
  reset("u1");
  serve({ boxOn: "u1" });
  castFrom("u1");

  // Number("") is 0 and Number(null) is 0, so a coercion here would seek to the
  // start of the song rather than refuse; NaN would reach the URL as "NaN".
  for (const bad of ["", "abc", null, undefined, -5, NaN]) {
    const r = await api.control("seek", bad);
    assert.equal(r.ok, false, `refused ${String(bad)}`);
    assert.equal(r.error, "bad position");
  }
  assert.deepEqual(writes(), [], "nothing went out");
});

test("a fractional position is floored rather than sent as a decimal", async () => {
  reset("u1");
  serve({ boxOn: "u1" });
  castFrom("u1");
  await api.control("seek", 1234.9);
  assert.match(writes()[0].path, /position_ms=1234&/);
});

test("the queue is read as the account holding the box", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");

  const q = await api.queue();

  assert.equal(q.ok, true);
  const read = seen.find((r) => r.path === "/v1/me/player/queue");
  assert.equal(read.bearer, "at-r2");
  assert.deepEqual(
    q.items.map((x) => x.name),
    ["A", "B"],
    "a row that is not an object is dropped rather than drawn as an empty line",
  );
  assert.equal(q.items[0].artists, "One, Two");
  assert.equal(q.items[0].image_url, "small.jpg", "the smallest image, for a 5vh row");
  assert.equal(q.items[1].image_url, "", "a track with no album art is not a broken picture");
});

test("the number of rows is bounded, whatever is asked for", async () => {
  reset("u1");
  serve({ boxOn: "u1" });
  castFrom("u1");
  const one = await api.queue(1);
  assert.equal(one.items.length, 1);
  const all = await api.queue(999);
  assert.equal(all.items.length, 2, "capped at what Spotify returned");
});

test("a box somebody else is driving answers with a reason, not an empty queue", async () => {
  reset("u1");
  // The box is signed into an account this box has not linked: no device of ours
  // to ask about, and the ACTIVE account's queue belongs to another room.
  serve({ boxOn: "nobody" });
  castFrom("u9");

  const q = await api.queue();

  assert.equal(q.ok, false);
  assert.equal(q.error, "box_other_account");
  assert.deepEqual(q.items, []);
  assert.ok(
    !seen.some((r) => r.path === "/v1/me/player/queue"),
    "nothing was asked of an account that does not hold the box",
  );
});

test("a queue Spotify refuses is a failure, not an empty list", async () => {
  reset("u1");
  serve({ boxOn: "u1", queueStatus: 403 });
  castFrom("u1");
  const q = await api.queue();
  assert.equal(q.ok, false);
  assert.deepEqual(q.items, []);
  assert.ok(q.error, "the reason travels, so the screen can say something true");
});

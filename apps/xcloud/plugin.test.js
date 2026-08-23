// The plugin's route contract with the shell.
//
// This file exists because of one bug that every other kind of test missed: the
// shell reads a POST body ITSELF and hands the parsed object over as the third
// argument (`route(req, res, { body })` in shell/main.js), leaving the request
// stream already ended. A route that read the stream instead waited for events
// that would never fire, never answered, and left the television on "starting"
// for ever - while the local harness, which passed the raw stream, was happy.
//
// So what is asserted here is the SHAPE of the contract, not the behaviour behind
// it: every route answers, and no POST route depends on the request stream.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("stream");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-xcloud-plugin-"));
process.env.TVBOX_XCLOUD_TOKENS = path.join(DIR, "tokens.json");
process.env.TVBOX_XCLOUD_CACHE = path.join(DIR, "library.json");

const sessions = require("./lib/session");
const plugin = require("./plugin");

function mount() {
  let table = null;
  const host = {
    base: "http://127.0.0.1:8097",
    log: () => {},
    json: (res, body) => res._resolve(body),
    registerRoutes: (prefix, t, opts) => (table = { prefix, t, guard: (opts && opts.guard) || [] }),
    // `uiLocale`, and a SHORT id, because that is what the shell's config really
    // exposes and really returns. The stub used to offer a `get(...)` returning a
    // full tag - an API the shell has never had - so the plugin's own call threw on
    // the box and fell back to en-US for every catalogue read, with this suite
    // green throughout.
    config: { uiLocale: () => "hu" },
    idle: () => false,
  };
  const instance = plugin(host);
  instance.start();
  return { table, instance };
}

// A request the way the shell leaves it: the body already read off the stream.
function callRoute(t, key, opts) {
  const o = opts || {};
  const handler = t[key];
  assert.ok(handler, "no route " + key);
  const req = Readable.from([]);
  req.url = o.url || "/";
  // A real request always carries headers, and a route that reads one must be
  // exercised against something shaped like the shell's. The last time this
  // harness differed from the shell - it passed the raw stream where the shell
  // passes a parsed body - the bug it hid could not reproduce locally at all.
  req.headers = o.headers || {};
  // Ended before the handler ever sees it, exactly as in the shell.
  req.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(key + " never answered")), 4000);
    const res = {
      _resolve: (body) => {
        clearTimeout(timer);
        resolve(body);
      },
    };
    handler(req, res, key.startsWith("POST") ? { body: o.body || {} } : {});
  });
}

test("every route is registered under the app's own prefix", () => {
  const { table, instance } = mount();
  assert.equal(table.prefix, "/tvbox/api/xcloud");
  for (const key of Object.keys(table.t)) assert.match(key, /^(GET|POST) \//, key);
  instance.stop();
});

test("state-changing routes are POST, because the shell only gates non-GET", async () => {
  const { table, instance } = mount();
  // A GET is not checked for a foreign origin, and this API listens
  // unauthenticated on loopback - so a signout reachable by GET would be a page
  // on the internet signing the television out.
  for (const changing of ["signin/start", "signin/cancel", "signout", "session/start", "session/sdp", "session/ice", "session/stop"]) {
    assert.ok(table.t["POST /" + changing], changing + " must be POST");
    assert.equal(table.t["GET /" + changing], undefined, changing + " must not also be a GET");
  }
  instance.stop();
});

test("a POST route answers from the ctx body and never waits on the stream", async () => {
  const { table, instance } = mount();
  try {
    // Signed out, so each of these answers a refusal rather than doing anything -
    // which is all this needs: the point is that it ANSWERS.
    const started = await callRoute(table.t, "POST /session/start", { body: { titleId: "SOMEGAME" } });
    assert.equal(started.ok, false, "no account, so it refuses - but it replies");

    const bad = await callRoute(table.t, "POST /session/start", { body: { titleId: "../../etc/passwd" } });
    assert.equal(bad.code, "bad_request");

    const missing = await callRoute(table.t, "POST /session/start", { body: {} });
    assert.equal(missing.code, "bad_request");

    assert.equal((await callRoute(table.t, "POST /session/sdp", { body: { sdp: "v=0" } })).code, "no_session");
    assert.equal((await callRoute(table.t, "POST /session/ice", { body: { candidate: [] } })).code, "no_session");
    assert.equal((await callRoute(table.t, "POST /session/stop")).ok, true);
    assert.equal((await callRoute(table.t, "POST /signin/cancel")).ok, true);
  } finally {
    instance.stop();
  }
});

test("the read routes answer with no account rather than throwing", async () => {
  const { table, instance } = mount();
  try {
    const status = await callRoute(table.t, "GET /status");
    assert.equal(status.signedIn, false);
    assert.equal((await callRoute(table.t, "GET /signin/state")).state, "idle");
    assert.equal((await callRoute(table.t, "GET /session/state")).active, false);
    assert.deepEqual((await callRoute(table.t, "GET /search", { url: "/search?q=x" })).results, []);
    assert.equal((await callRoute(table.t, "GET /title", { url: "/title?id=nope" })).code, "not_found");
  } finally {
    instance.stop();
  }
});

test("no route hands out a credential", async () => {
  const { table, instance } = mount();
  try {
    for (const key of ["GET /status", "GET /signin/state", "GET /session/state"]) {
      const body = JSON.stringify(await callRoute(table.t, key));
      for (const secret of ["refresh_token", "access_token", "gsToken", "Bearer", "lpt"]) {
        assert.equal(body.includes(secret), false, key + " leaked " + secret);
      }
    }
  } finally {
    instance.stop();
  }
});

test("the keepalive and alive timers run without throwing", async (t) => {
  // These live at module scope and were calling a `log` defined inside the
  // factory - a ReferenceError, on a path with no catch, about five seconds into
  // every stream. Nothing exercised them, so nothing said so, and the "the server
  // ended the session" detection they exist for never once ran.
  const real = { start: sessions.start, waitReady: sessions.waitReady, configuration: sessions.configuration, keepalive: sessions.keepalive, alive: sessions.alive, stop: sessions.stop };
  const calls = { keepalive: 0, alive: 0 };
  sessions.start = async () => ({ id: "S1", type: "cloud", target: "GAME" });
  sessions.waitReady = async () => ({ state: "Provisioned" });
  sessions.configuration = async () => ({ keepAliveMs: 60000, noConnectionTimeoutMs: 300000, serverDetails: {}, overrides: {} });
  sessions.keepalive = async () => {
    calls.keepalive++;
    return { reason: "SessionEnding" };
  };
  sessions.alive = async () => {
    calls.alive++;
    return { alive: false, state: "Gone" };
  };
  sessions.stop = async () => {};

  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { table, instance } = mount();
  try {
    await callRoute(table.t, "POST /session/start", { body: { titleId: "GAME" } });
    // The ladder resolves on its own microtasks; let them run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    t.mock.timers.tick(6000); // past one alive poll
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(calls.alive > 0, "the alive poll has to actually run");

    t.mock.timers.tick(61000); // past one keepalive
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(calls.keepalive > 0, "the keepalive has to actually run");

    const state = await callRoute(table.t, "GET /session/state");
    assert.ok(state.ended, "and what they learn has to reach the screen: " + JSON.stringify(state));
  } finally {
    t.mock.timers.reset();
    instance.stop();
    Object.assign(sessions, real);
  }
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("the catalogue is read in the box's own language, from the API the shell really has", async () => {
  // Two bugs in one line, and each hid the other: the plugin asked
  // `host.config.get("locale")`, which does not exist (so the branch threw), and
  // `settings.language()` took full tags only while the shell answers with "hu".
  // Every read on a Hungarian box therefore asked Microsoft for en-US, and the
  // background refresh then cached that over the Hungarian catalogue every
  // fifteen minutes.
  const settings = require("./lib/settings");
  assert.equal(settings.language("hu"), "hu-HU");
  assert.equal(settings.language("hu-HU"), "hu-HU");
  assert.equal(settings.language("en"), "en-US");
  assert.equal(settings.language("HU"), "hu-HU");
  // Nothing we ship a catalogue for still falls back rather than guessing.
  assert.equal(settings.language("sv"), "en-US");
  assert.equal(settings.language(""), "en-US");
  assert.equal(settings.language(undefined), "en-US");

  const { table, instance } = mount();
  try {
    const seen = [];
    const library = require("./lib/library");
    const realGet = library.get;
    library.get = async (o) => {
      seen.push(o && o.language);
      return { titles: [], partial: false, filling: false, stale: false };
    };
    try {
      await callRoute(table.t, "GET /library", { url: "/library" });
    } finally {
      library.get = realGet;
    }
    assert.deepEqual(seen, ["hu-HU"]);
  } finally {
    instance.stop();
  }
});

test("the reads that spend something upstream ask for the same-origin gate", () => {
  // An open GET is the policy for a side-effect-free read. `/library` is ~101
  // authenticated requests to Microsoft on a cold cache and rewrites the cached
  // language; `/waittime` is one authenticated request per DISTINCT id, so its
  // 30 s cache de-duplicates repeats and bounds nothing else. Both are reachable
  // from an <img src> on any page the box loads.
  const { table, instance } = mount();
  try {
    assert.deepEqual([...table.guard].sort(), ["GET /library", "GET /waittime"]);
    // Everything named has to BE a route, or the declaration silently covers
    // nothing at all.
    for (const key of table.guard) assert.ok(table.t[key], "guarded a route that does not exist: " + key);
  } finally {
    instance.stop();
  }
});

test("only a page of OURS keeps the session alive", async (t) => {
  // The reaper ends a session nobody has asked about for a minute, because a page
  // signals its departure best-effort and the account is charged a slot for the
  // machine. `GET /session/state` is what says "somebody is watching" - and it is
  // an open read that needs no credential and carries no Origin, so an <img src>
  // on any page the box loads could hold a session open indefinitely.
  //
  // `Sec-Fetch-Dest` is what tells them apart: a fetch from our page sends
  // `empty`, an image sends `image`. An absent header is a non-browser (curl, a
  // test) and counts, like everywhere else in this stack.
  const real = { start: sessions.start, waitReady: sessions.waitReady, configuration: sessions.configuration, keepalive: sessions.keepalive, alive: sessions.alive, stop: sessions.stop };
  let stopped = 0;
  sessions.start = async () => ({ id: "S9", type: "cloud", target: "GAME" });
  sessions.waitReady = async () => ({ state: "Provisioned" });
  sessions.configuration = async () => ({ keepAliveMs: 60000, noConnectionTimeoutMs: 300000, overrides: {} });
  sessions.keepalive = async () => ({ reason: "None" });
  sessions.alive = async () => ({ alive: true, state: "Provisioned" });
  sessions.stop = async () => {
    stopped++;
  };

  // `Date` as well as the timers: the reaper compares wall clock against
  // `lastAsked`, so ticking the intervals alone leaves it measuring zero elapsed
  // and it never fires.
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { table, instance } = mount();
  try {
    await callRoute(table.t, "POST /session/start", { body: { titleId: "GAME" } });
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // An IMAGE asking, every 20 s, for a minute and a half. It must not count.
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(20000);
      for (let j = 0; j < 3; j++) await Promise.resolve();
      await callRoute(table.t, "GET /session/state", { headers: { "sec-fetch-dest": "image" } });
    }
    assert.equal(stopped, 1, "an unwatched session has to be ended");

    // …and our own page's fetch does keep one.
    stopped = 0;
    await callRoute(table.t, "POST /session/start", { body: { titleId: "GAME" } });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(20000);
      for (let j = 0; j < 3; j++) await Promise.resolve();
      await callRoute(table.t, "GET /session/state", { headers: { "sec-fetch-dest": "empty" } });
    }
    assert.equal(stopped, 0, "a watched session must not be reaped");
  } finally {
    t.mock.timers.reset();
    Object.assign(sessions, real);
    instance.stop();
  }
});

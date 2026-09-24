// The plugin's own loop: one timer chain at most, and none after stop().
// It lives under lib/ because that is where CI runs package tests
// (`apps/*/lib/*.test.js`); the file it tests is one directory up.
// Run: node --test apps/mediaclient/lib/plugin.test.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const PLUGIN = path.join(__dirname, "..", "plugin.js");

// Timers are counted rather than run: what matters is how many chains are alive.
function fakeTimers() {
  const live = new Map();
  let next = 1;
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  global.setTimeout = (fn, ms) => {
    const id = next++;
    live.set(id, { fn, ms });
    return id;
  };
  global.clearTimeout = (id) => live.delete(id);
  return {
    live,
    fire() {
      const due = [...live.entries()];
      for (const [id, t] of due) {
        live.delete(id);
        t.fn();
      }
    },
    restore() {
      global.setTimeout = real.setTimeout;
      global.clearTimeout = real.clearTimeout;
    },
  };
}

function load() {
  // An empty home: no stored session, so a tick never starts a real receiver.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mc-plugin-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  delete require.cache[require.resolve(PLUGIN)];
  const routes = {};
  const host = {
    log: () => {},
    json: (res, body) => {
      res.body = body;
    },
    navTo: () => true,
    registerRoutes: (prefix, table) => Object.assign(routes, table),
    config: { uiLocale: () => "en" },
  };
  const plugin = require(PLUGIN)(host);
  process.env.HOME = prev;
  const call = (route) => {
    const res = {};
    routes[route]({}, res);
    return res.body;
  };
  return { plugin, call };
}

test("releases never add a second timer chain, and stop() ends the one there is", () => {
  const t = fakeTimers();
  try {
    const { plugin, call } = load();
    plugin.start();
    assert.strictEqual(t.live.size, 1);
    t.fire();
    assert.strictEqual(t.live.size, 1);
    for (let i = 0; i < 5; i++) {
      call("POST /poll-taken");
      call("POST /poll-released");
    }
    assert.strictEqual(t.live.size, 1, "one chain after five handovers");
    plugin.stop();
    assert.strictEqual(t.live.size, 0, "nothing left after stop");
    t.fire();
    assert.strictEqual(t.live.size, 0);
  } finally {
    t.restore();
  }
});

test("a release with nothing taken, or after stop(), runs no tick", () => {
  const t = fakeTimers();
  try {
    const { plugin, call } = load();
    plugin.start();
    for (let i = 0; i < 5; i++) assert.deepStrictEqual(call("POST /poll-released"), { ok: true });
    assert.strictEqual(t.live.size, 1);
    const [only] = [...t.live.values()];
    assert.strictEqual(only.ms, 10_000, "still the start delay: no tick ran early");
    call("POST /poll-taken");
    plugin.stop();
    call("POST /poll-released");
    assert.strictEqual(t.live.size, 0, "a release after stop does not restart the loop");
  } finally {
    t.restore();
  }
});

test("quitting the app hands the poll back even though the page never said so", () => {
  const t = fakeTimers();
  try {
    const { plugin, call } = load();
    plugin.start();
    call("POST /poll-taken");
    const before = [...t.live.values()].map((x) => x.ms);
    assert.deepStrictEqual(before, [10_000], "only the start delay is pending");
    // The window was destroyed: no poll-released arrives, only the shell's hook.
    plugin.appClosed();
    const after = [...t.live.values()].map((x) => x.ms);
    assert.deepStrictEqual(after, [15_000], "the receiver ran at once and keeps watching");
    // Nothing was taken any more, so a late release or a second quit is a no-op.
    const [id] = [...t.live.keys()];
    call("POST /poll-released");
    plugin.appClosed();
    assert.deepStrictEqual([...t.live.keys()], [id]);
  } finally {
    t.restore();
  }
});

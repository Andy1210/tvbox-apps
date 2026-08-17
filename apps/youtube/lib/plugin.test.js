// The plugin: everything between the shell and the receiver.
//
// It lives under lib/ because that is the only place CI runs package tests
// (`apps/*/lib/*.test.js`), and the file it tests is one directory up. What matters
// here is what the plugin does with a shell that is OLDER or unhappier than the one it
// was written against - a plugin factory that throws is a plugin the shell drops
// entirely, leaving the app's tile on HOME with a switch that does nothing.
// Run: node --test apps/youtube/lib/plugin.test.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const PLUGIN = path.join(__dirname, "..", "plugin.js");
function load(host) {
  delete require.cache[require.resolve(PLUGIN)];
  return require(PLUGIN)(host);
}

// A shell, as far as the plugin can tell. `over` removes or breaks parts of it.
function fakeHost(over = {}) {
  const calls = { log: [], navTo: [], notify: [], listeners: [] };
  const host = {
    calls,
    log: (m) => calls.log.push(String(m)),
    switchOn: () => false, // off by default, like the manifest
    appState: () => ({ running: false, foreground: false }),
    idle: () => true, // nothing on screen
    navTo: (id, opts) => {
      calls.navTo.push({ id, opts });
      return true;
    },
    notify: (n) => calls.notify.push(n),
    onConfigChange: (cb) => calls.listeners.push(cb),
    config: { uiLocale: () => "hu" },
    ...over,
  };
  return host;
}

test("a shell that cannot report config changes does not take the plugin down with it", () => {
  // The two other host calls are guarded for the same reason; this one was not, and an
  // older shell would have lost the whole plugin - tile on HOME, switch inert.
  const host = fakeHost({
    onConfigChange: () => {
      throw new TypeError("host.onConfigChange is not a function");
    },
  });
  const plugin = load(host);
  assert.equal(typeof plugin.start, "function");
  assert.match(host.calls.log.join(" "), /cannot report config changes/);
});

test("nothing is advertised while the switch is off, and no shell call is needed to know it", () => {
  const host = fakeHost({ switchOn: () => false });
  const plugin = load(host);
  plugin.start();
  assert.deepEqual(host.calls.navTo, []);
  plugin.stop(); // must not throw with no receiver
});

test("a shell with no switches at all keeps the receiver down", () => {
  // Advertising on a shell that cannot show the switch would be a feature nobody
  // could turn off.
  const host = fakeHost({ switchOn: undefined });
  const plugin = load(host);
  plugin.start();
  assert.deepEqual(host.calls.navTo, []);
});

test("a cast hands the launch body to the shell as the app's query", () => {
  const host = fakeHost();
  load(host);
  // The receiver is not started (the switch is off); the launch path is what is under
  // test, so it is driven through the callback the receiver would call.
  // (start() with the switch on binds sockets - covered by dial.test.js instead.)
  const opened = openThrough(host, "pairingCode=abc-123&theme=cl");
  assert.equal(opened, true);
  assert.deepEqual(host.calls.navTo, [{ id: "youtube", opts: { query: "pairingCode=abc-123&theme=cl" } }]);
});

test("what the shell says about opening the app is what the sender is told", () => {
  const refused = fakeHost({ navTo: () => false });
  load(refused);
  assert.equal(openThrough(refused, "pairingCode=x"), false, "nothing opened -> the cast failed");
  const older = fakeHost({ navTo: () => undefined });
  load(older);
  assert.equal(openThrough(older, "pairingCode=x"), true, "an older shell cannot tell, which is not a failure");
});

test("the note is for the person whose viewing was interrupted, so an idle box shows none", () => {
  const idle = fakeHost({ idle: () => true });
  load(idle);
  openThrough(idle, "pairingCode=x");
  assert.deepEqual(idle.calls.notify, []);

  const watching = fakeHost({ idle: () => false });
  load(watching);
  openThrough(watching, "pairingCode=x");
  assert.equal(watching.calls.notify.length, 1);
  assert.match(watching.calls.notify[0].message, /telefonjáról/, "the box is set to Hungarian");
});

test("the note is in the language the box is set to, and English when it cannot tell", () => {
  const en = fakeHost({ idle: () => false, config: { uiLocale: () => "en-GB" } });
  load(en);
  openThrough(en, "pairingCode=x");
  assert.match(en.calls.notify[0].message, /from their phone/);

  const noLocale = fakeHost({ idle: () => false, config: {} });
  load(noLocale);
  openThrough(noLocale, "pairingCode=x");
  assert.match(noLocale.calls.notify[0].message, /from their phone/, "no uiLocale -> English, not a crash");
});

test("a cast that opened nothing says nothing on the television", () => {
  const host = fakeHost({ idle: () => false, navTo: () => false });
  load(host);
  openThrough(host, "pairingCode=x");
  assert.deepEqual(host.calls.notify, [], "'YouTube is starting' would be a lie");
});

// Drive one cast through the plugin, the way the receiver does. The launch handler is
// private, so it is taken from the options the plugin hands the receiver factory - with
// the factory stubbed, because the real one binds udp/1900 and would make a unit test
// a network test.
function openThrough(host, body) {
  const dial = require("./dial");
  const orig = dial.createDialReceiver;
  let captured = null;
  dial.createDialReceiver = (o) => {
    captured = o;
    return { start: (cb) => cb && cb(null), stop: () => {}, running: () => true, port: () => 0 };
  };
  let plugin = null;
  try {
    // The cache has to go FIRST: plugin.js destructures createDialReceiver at load
    // time, so a module loaded before the stub keeps the real one - and starting the
    // real receiver in a unit test binds sockets and hangs the runner.
    delete require.cache[require.resolve(PLUGIN)];
    plugin = require(PLUGIN)({ ...host, switchOn: () => true });
    plugin.start();
    assert.ok(captured, "the plugin never built a receiver");
    return captured.onLaunch(body);
  } finally {
    if (plugin) plugin.stop();
    dial.createDialReceiver = orig;
    delete require.cache[require.resolve(PLUGIN)];
  }
}

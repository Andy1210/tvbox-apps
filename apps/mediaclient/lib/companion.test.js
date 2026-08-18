// The shell-side Plex receiver: the parts that decide whether a box is a player
// at all. Everything here failed at least once against a real server or a real
// box, which is why each case names what it is about rather than the function.
//
// Run by CI's "package library tests" step: node --test apps/*/lib/*.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { parseCommands, readSession, leaveCast, startCompanion } = require("./companion");

// ---- what the server sends, and what it is allowed to look like -----------

test("a raw > inside an attribute does not truncate the command", () => {
  // `>` is legal unescaped in an XML attribute value. Stopping at the first one
  // lost both the key and the commandID, so the box acted on a paramless
  // command and, having no id, answered nobody - the controller hung.
  const [cmd] = parseCommands(
    '<MediaContainer><Command path="/player/playback/playMedia" key="/a?x>y" commandID="7" /></MediaContainer>',
  );
  assert.equal(cmd.path, "/player/playback/playMedia");
  assert.equal(cmd.params.key, "/a?x>y");
  assert.equal(cmd.params.commandID, "7");
});

test("a command inside a comment is not a command", () => {
  assert.deepEqual(parseCommands('<!-- <Command path="/player/playback/stop" /> -->'), []);
  assert.deepEqual(parseCommands('<![CDATA[<Command path="/player/playback/stop" />]]>'), []);
});

test("single quotes and numeric references are read, not dropped", () => {
  const [cmd] = parseCommands("<Command path='/player/playback/playMedia' key='/library&#47;metadata&#x2f;9' />");
  assert.equal(cmd.params.key, "/library/metadata/9");
});

test("an answer full of commands is bounded", () => {
  // This app signs into servers the household does not necessarily own, and
  // every command past the first costs a sequential POST to answer it.
  const many = '<Command path="/player/playback/stop" commandID="1" />'.repeat(5000);
  assert.equal(parseCommands(many).length, 16);
});

test("entities decode in the right order", () => {
  const [cmd] = parseCommands('<Command path="/x" key="a&amp;lt;b" />');
  assert.equal(cmd.params.key, "a&lt;b", "a doubly-escaped value must not decode twice");
});

// ---- the request, which is where a poll goes to die -----------------------

test("a truncated answer settles instead of parking the loop for ever", async () => {
  // Measured: with a handler only on the REQUEST, a body cut off mid-flight
  // (a wifi blip, a NAT timeout, a server restart) emits `aborted`/`close` on
  // the response and nothing on the request - the promise never settled, the
  // loop parked, and the box silently stopped being a player until a restart.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/xml", "Content-Length": "1000" });
    res.write("<MediaContainer>");
    res.socket.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const store = tempStore({
    session: { kind: "plex", token: "t", baseUrl: `http://127.0.0.1:${port}`, serverId: "S", profileId: "owner" },
    identity: { clientId: "cid", host: "tvbox-test" },
  });
  let ended = false;
  const stop = startCompanion({
    ...readSession(store),
    onCommand: () => false,
    log: () => {},
    onEnded: () => {
      ended = true;
    },
  });
  // It retries rather than ending, so the proof is that it got PAST the first
  // request at all: an unsettled promise never reaches the backoff.
  await new Promise((r) => setTimeout(r, 300));
  await stop(false);
  server.close();
  assert.equal(ended, false, "a retryable failure is not the end of the receiver");
});

test("stopping destroys the poll in flight", async () => {
  // Without it the socket stayed registered with the server for up to ten
  // minutes after standing down, and a command delivered into it was swallowed
  // - taken from the server, never answered.
  let closed = false;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.on("close", () => {
      closed = true;
    });
    // Never answers: this is what a long poll looks like.
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const store = tempStore({
    session: { kind: "plex", token: "t", baseUrl: `http://127.0.0.1:${port}`, serverId: "S", profileId: "owner" },
    identity: { clientId: "cid", host: "tvbox-test" },
  });
  const stop = startCompanion({ ...readSession(store), onCommand: () => false, log: () => {} });
  await new Promise((r) => setTimeout(r, 200));
  await stop(false);
  await new Promise((r) => setTimeout(r, 100));
  server.close();
  assert.equal(closed, true);
});

// ---- who the box is, and whether it may be one ---------------------------

test("no session, a Jellyfin session, or casting turned off means no receiver", () => {
  assert.equal(readSession(tempStore({})), null, "nobody signed in");
  assert.equal(
    readSession(
      tempStore({
        session: { kind: "jellyfin", token: "t", baseUrl: "http://s", serverId: "S" },
        identity: { clientId: "c" },
      }),
    ),
    null,
    "a Jellyfin session has no business on a Plex route",
  );
  assert.equal(
    readSession(
      tempStore({
        session: { kind: "plex", token: "t", baseUrl: "http://s", serverId: "S" },
        identity: { clientId: "c" },
        prefs: { cast: false },
      }),
    ),
    null,
    "the household said no",
  );
  const ok = readSession(
    tempStore({
      session: { kind: "plex", token: "t", baseUrl: "http://s", serverId: "S", profileId: "kid" },
      identity: { clientId: "c" },
      prefs: {},
    }),
  );
  assert.equal(ok.profileId, "kid", "an absent setting is a box nobody has asked, which is on");
});

// ---- the handover, which writes the file the app's credential lives in ----

test("a stashed cast never leaves the store worse than it found it", () => {
  const store = tempStore({
    session: { kind: "plex", token: "t", baseUrl: "http://s", serverId: "S" },
    identity: { clientId: "c" },
  });
  assert.equal(leaveCast(store, { path: "/player/playback/playMedia", params: { key: "/k" } }, "owner"), true);
  const after = JSON.parse(fs.readFileSync(store, "utf8"));
  assert.ok(after.session, "the session survives");
  assert.equal(JSON.parse(after["pending-cast"]).profileId, "owner");

  // Over the cap: refused rather than written, because the store has a quota the
  // shell enforces on the APP's writes and cannot enforce on this one - and a
  // store over quota is one the app can no longer write a token to, or shrink.
  const huge = { path: "/player/playback/playMedia", params: { key: "x".repeat(20000) } };
  assert.equal(leaveCast(store, huge, "owner"), false);
  assert.equal(JSON.parse(fs.readFileSync(store, "utf8")).session, after.session, "and nothing changed");

  // A store that is not an object is not a store to write into.
  const broken = tempStore(null, "[1,2,3]");
  assert.equal(leaveCast(broken, { path: "/p", params: {} }, "owner"), false);
  assert.equal(leaveCast(path.join(os.tmpdir(), "tvbox-no-such-store.json"), { path: "/p", params: {} }, ""), false);
});

let n = 0;
function tempStore(obj, raw) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-cast-")), `store-${n++}.json`);
  const flat = {};
  for (const [k, v] of Object.entries(obj || {})) flat[k] = JSON.stringify(v);
  fs.writeFileSync(p, raw === undefined ? JSON.stringify(flat) : raw);
  return p;
}

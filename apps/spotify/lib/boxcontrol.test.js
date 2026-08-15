// Which player a press on the TV reaches, driven through the real module with a
// stubbed https layer.
//
// The box is signed into ONE Spotify account - whoever last cast to it - and that
// is not necessarily the account the launcher is browsing. Every assertion here
// is about that gap: a command has to go out as the account holding the box and
// be addressed to the box's device id, or it lands on whatever else that account
// is playing on, in whatever room that is.
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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-spotify-boxcontrol-"));
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

// The stub stands in for https.request itself, so the module's own request()
// wrapper is the code under test rather than something the test replaces. Each
// call is recorded with the bearer token it carried, which is how a request is
// attributed to an account: the token endpoint hands back "at-<refresh token>".
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
    let out;
    try {
      out = handler(opts.path, opts, body) || { status: 500, body: "" };
    } catch (e) {
      setImmediate(() => req.emit("error", e));
      return;
    }
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
bridge.setConfig(CONFIG); // the device name the box advertises, and matches against

test.after(() => {
  https.request = REAL_REQUEST;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

const BOX = { id: "dev-box", name: "tvbox-test", type: "TV" };
const PHONE = { id: "dev-phone", name: "A phone", type: "Smartphone" };

// Who can see the box, by account. Everyone else gets a device list without it -
// which is what Spotify answers for an account the box is not signed into.
function serve({ boxOn, player, boxId }) {
  handler = (url, opts, body) => {
    if (url === "/api/token") {
      const refresh = new URLSearchParams(body).get("refresh_token");
      return { status: 200, body: JSON.stringify({ access_token: "at-" + refresh, expires_in: 3600 }) };
    }
    const who = String((opts.headers || {}).Authorization || "").replace("Bearer at-r", "u");
    if (url === "/v1/me/player/devices") {
      const box = boxId ? { ...BOX, id: boxId } : BOX; // a respawned librespot is a new device id
      return { status: 200, body: JSON.stringify({ devices: who === boxOn ? [PHONE, box] : [PHONE] }) };
    }
    if (url === "/v1/me/player") return { status: 200, body: JSON.stringify(player || {}) };
    if (url.startsWith("/v1/me/player/")) return { status: 204, body: "" }; // any transport write
    return { status: 404, body: "" };
  };
}

// A cast is librespot telling us it changed hands; the id is the same string the
// Web API calls that user's id. `true` is the trust flag plugin.js passes for an
// event carrying the daemon's key.
function castFrom(user) {
  bridge.handleEvent({ player_event: "session_connected", user_name: user }, true);
}
function disconnected(trusted) {
  bridge.handleEvent({ player_event: "session_disconnected" }, trusted !== false);
}
// Back to a box nobody has cast to. `clear()` rather than a disconnect event,
// because a disconnect does NOT unown the box (see spotify.js) — the daemon
// going away is what does.
function reset(activeId) {
  seen = [];
  api.forgetBoxDevice();
  bridge.clear();
  api.switchAccount(activeId || "u1");
}
const writes = () => seen.filter((r) => r.method !== "GET" && r.path !== "/api/token");
const lists = () => seen.filter((r) => r.path === "/v1/me/player/devices").length;

test("a pause goes out as the account the box is signed into, not the active one", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");

  const r = await api.control("pause");

  assert.deepEqual(r, { ok: true, error: "" });
  const w = writes();
  assert.equal(w.length, 1, "exactly one command");
  assert.equal(w[0].bearer, "at-r2", "sent as the account holding the box");
  assert.match(w[0].path, /^\/v1\/me\/player\/pause\?device_id=dev-box$/);
  assert.ok(
    !seen.some((s) => s.bearer === "at-r1" && s.path.startsWith("/v1/me/player/") && s.method !== "GET"),
    "the active account's player is not touched",
  );
});

test("the launcher follows the box, so the library and the buttons agree", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");
  assert.equal(api.listAccounts().find((a) => a.active).id, "u1");

  await api.control("pause");

  assert.equal(api.listAccounts().find((a) => a.active).id, "u2", "the account playing here became the active one");
});

test("an account this box has not linked is refused, and no command goes out", async () => {
  reset("u1");
  serve({ boxOn: "" });
  castFrom("someone-elses-account");

  const r = await api.control("pause");

  assert.equal(r.ok, false);
  assert.equal(r.error, "box_other_account", "a distinct answer: this is not an idle box");
  assert.equal(writes().length, 0, "any command would have reached another player");
  assert.equal(api.listAccounts().find((a) => a.active).id, "u1", "and the active account is left alone");
});

test("a stranger is only named after the device lists agree", async () => {
  // The session user matching no linked account is a state this code produces
  // itself - a "legacy" or synthetic id, or an account dropped by a failed
  // refresh - so the sweep decides before anybody is called a stranger.
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("not-an-account-we-know");

  const r = await api.control("pause");

  assert.equal(r.ok, true, "the box is u2's, whatever librespot called the user");
  assert.equal(writes()[0].bearer, "at-r2");
});

test("a listing that fails is not a box to take off somebody", async () => {
  reset("u1");
  castFrom("u2");
  handler = (url, opts, body) => {
    if (url === "/api/token") {
      const refresh = new URLSearchParams(body).get("refresh_token");
      return { status: 200, body: JSON.stringify({ access_token: "at-" + refresh, expires_in: 3600 }) };
    }
    // 500 rather than the 429 this really is in the field: a rate-limited read
    // ends up here too, but only after apiGet has slept through its retries, and
    // that is six seconds this suite does not need to spend.
    if (url === "/v1/me/player/devices") return { status: 500, body: "" };
    return { status: 404, body: "" };
  };

  assert.deepEqual(await api.control("pause"), { ok: false, error: "box_unreachable" });
  // play() answers the same way, because `box_not_found` is what lets the caller
  // restart librespot into another account - over the top of a live session.
  assert.deepEqual(await api.play({ uris: ["spotify:track:x"] }), { ok: false, error: "box_unreachable" });
  assert.equal(writes().length, 0);
});

test("a free box is the only one play() may report as free", async () => {
  reset("u1");
  serve({ boxOn: "" }); // nobody holds it: adoption is allowed to follow

  assert.deepEqual(await api.play({ uris: ["spotify:track:x"] }), { ok: false, error: "box_not_found" });

  castFrom("someone-elses-account"); // ...but a stranger's box is not free
  assert.deepEqual(await api.play({ uris: ["spotify:track:x"] }), { ok: false, error: "box_other_account" });
});

test("with no session event, the device lists still find the box", async () => {
  reset("u1");
  serve({ boxOn: "u2" }); // no castFrom(): an older app package reports no user

  const r = await api.control("next");

  assert.equal(r.ok, true);
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].bearer, "at-r2");
  assert.match(w[0].path, /^\/v1\/me\/player\/next\?device_id=dev-box$/);
});

test("no linked account can see the box: that is its own answer, and not the same one", async () => {
  reset("u1");
  serve({ boxOn: "" }); // librespot signed into nobody / not running

  const r = await api.control("pause");

  assert.equal(r.ok, false);
  assert.equal(r.error, "box_not_found");
  assert.equal(writes().length, 0);
});

test("play/pause follows what the box is doing, not what the account is doing elsewhere", async () => {
  reset("u1");
  // The owner is playing on a phone; the box holds the session but is paused.
  serve({ boxOn: "u2", player: { is_playing: true, device: { name: "A phone" } } });
  castFrom("u2");
  bridge.handleEvent({ player_event: "paused", position_ms: 1000 });

  const r = await api.control("playpause");

  assert.equal(r.ok, true);
  const w = writes();
  assert.equal(w.length, 1);
  assert.match(w[0].path, /^\/v1\/me\/player\/play\?device_id=dev-box$/, "resumes the box rather than pausing a phone");

  // ...and with the box itself playing, the same button stops it.
  seen = [];
  serve({ boxOn: "u2", player: { is_playing: true, device: { name: "tvbox-test" } } });
  await api.control("playpause");
  assert.match(writes()[0].path, /^\/v1\/me\/player\/pause\?device_id=dev-box$/);
});

test("if the player cannot be read, the box's own state answers the button", async () => {
  reset("u1");
  castFrom("u2");
  handler = (url, opts, body) => {
    if (url === "/api/token") {
      const refresh = new URLSearchParams(body).get("refresh_token");
      return { status: 200, body: JSON.stringify({ access_token: "at-" + refresh, expires_in: 3600 }) };
    }
    if (url === "/v1/me/player/devices") return { status: 200, body: JSON.stringify({ devices: [BOX] }) };
    if (url === "/v1/me/player") return { status: 500, body: "" }; // Spotify is having a moment
    return { status: 204, body: "" };
  };
  bridge.handleEvent({ player_event: "playing", track_id: "t1", position_ms: 0, duration_ms: 1000 });

  await api.control("playpause");

  assert.match(writes()[0].path, /^\/v1\/me\/player\/pause\?device_id=dev-box$/);
});

test("a setting carries its value AND the device, in one query string", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");

  await api.control("shuffle", true);
  await api.control("repeat", "context");

  assert.match(writes()[0].path, /^\/v1\/me\/player\/shuffle\?state=true&device_id=dev-box$/);
  assert.match(writes()[1].path, /^\/v1\/me\/player\/repeat\?state=context&device_id=dev-box$/);
});

test("the device listing is paid for once, and again after the box changes hands", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");

  await api.control("pause");
  await api.control("next");
  const lists = () => seen.filter((s) => s.path === "/v1/me/player/devices").length;
  assert.equal(lists(), 1, "the second press reuses the id");

  seen = [];
  castFrom("u1"); // a different phone takes the box over
  serve({ boxOn: "u1" });
  await api.control("pause");
  assert.equal(lists(), 1, "a box that changed hands is looked up again");
  assert.equal(writes()[0].bearer, "at-r1");
});

test("autoplay names the account itself, and that does not move the active one", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");

  const r = await api.control("pause", undefined, "u2");

  assert.equal(r.ok, true);
  const w = writes();
  assert.equal(w[0].bearer, "at-r2");
  assert.match(w[0].path, /device_id=dev-box$/, "still addressed to the box");
  assert.equal(api.listAccounts().find((a) => a.active).id, "u1", "a play nobody asked for does not switch accounts");
});

test("the player behind the toggles is the box's, and says so only while the box is playing", async () => {
  reset("u1");
  serve({
    boxOn: "u2",
    player: {
      is_playing: true,
      item: { id: "t" },
      shuffle_state: true,
      repeat_state: "track",
      device: { name: "tvbox-test" },
    },
  });
  castFrom("u2");

  const s = await api.playerState();

  assert.equal(s.ok, true);
  assert.equal(s.device, "tvbox-test");
  assert.equal(s.shuffle, true);
  assert.equal(s.repeat, "track");
  assert.ok(
    seen.some((r) => r.path === "/v1/me/player" && r.bearer === "at-r2"),
    "asked the account holding the box",
  );
  assert.ok(!seen.some((r) => r.path === "/v1/me/player" && r.bearer === "at-r1"));
  assert.equal(
    seen.filter((r) => r.path === "/v1/me/player/devices").length,
    0,
    "a read needs the account, not the device id",
  );
});

test("a phone's settings are never shown as the box's", async () => {
  reset("u1");
  serve({
    boxOn: "u2",
    player: {
      is_playing: true,
      item: { id: "t" },
      shuffle_state: true,
      repeat_state: "track",
      device: { name: "A phone" },
    },
  });
  castFrom("u2");

  const s = await api.playerState();

  assert.equal(s.ok, true);
  assert.equal(s.shuffle, false);
  assert.equal(s.repeat, "off");
  assert.equal(s.active, false);
  assert.ok(!s.device);
});

test("a box in somebody else's hands reads as that, for the screen and for autoplay", async () => {
  reset("u1");
  serve({ boxOn: "" });
  castFrom("someone-elses-account");

  const s = await api.playerState();
  assert.equal(s.ok, true);
  assert.equal(s.other_account, true);
  assert.equal(s.active, false);
  assert.equal(seen.filter((r) => r.path === "/v1/me/player").length, 0, "there is no player of ours to read");

  const b = await api.boxPlayerState();
  assert.deepEqual(
    { ok: b.ok, box: b.box, is_playing: b.is_playing },
    { ok: true, box: false, is_playing: false },
    "autoplay must stay quiet rather than play over somebody",
  );
});

test("music starting is enough to follow the box, with no session event at all", async () => {
  reset("u1");
  serve({ boxOn: "u2" }); // no castFrom(): librespot named nobody

  assert.equal(await api.followBox(), true);
  assert.equal(api.listAccounts().find((a) => a.active).id, "u2");

  // ...and a box nobody linked can be seen on leaves the launcher where it was.
  reset("u1");
  serve({ boxOn: "" });
  assert.equal(await api.followBox(), false);
  assert.equal(api.listAccounts().find((a) => a.active).id, "u1");
});

test("a respawned daemon is a new device id, and the old one is not reused", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");
  await api.control("pause");
  assert.match(writes()[0].path, /device_id=dev-box$/);

  // The shell restarts librespot (a rename, a give-up): same name, new device.
  seen = [];
  serve({ boxOn: "u2", boxId: "dev-box-2" });
  bridge.clear(); // what stopLibrespot/restartLibrespot do
  api.forgetBoxDevice();
  castFrom("u2");
  await api.control("pause");

  assert.match(writes()[0].path, /device_id=dev-box-2$/, "Spotify accepts a dead id and does nothing with it");
});

test("a box that is not in the list yet is asked about again, not remembered as missing", async () => {
  reset("u1");
  serve({ boxOn: "" }); // mid-respawn: nobody can see it
  assert.equal((await api.control("pause")).error, "box_not_found");
  const before = lists();

  serve({ boxOn: "u2" }); // ...and a second later it is back
  assert.equal((await api.control("pause")).ok, true);
  assert.ok(lists() > before, "the miss was not cached");
});

test("the account the box moved to is on disk, not just in this process", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");

  await api.control("pause");

  const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, ".tvbox", "spotify-accounts.json"), "utf8"));
  assert.equal(onDisk.active, "u2", "a shell restart must not undo the handover");
  assert.equal(onDisk.list.length, 2);
});

test("a continuation nobody asked for does not repoint the library, but the next press does", async () => {
  reset("u1");
  serve({ boxOn: "u2" });

  // autoplay: plays as the box's account, deliberately without making it active
  assert.equal((await api.play({ uris: ["spotify:track:x"], keepActive: true })).ok, true);
  assert.equal(api.listAccounts().find((a) => a.active).id, "u1");

  // Starting music ACTIVATES the box, and the activation event arrives here.
  castFrom("u2");
  assert.equal(api.boxSignedInAs("u2"), false, "an activation we caused is not somebody choosing this room");
  assert.equal(api.listAccounts().find((a) => a.active).id, "u1");

  // A person pressing something is, and it outranks the window.
  assert.equal((await api.control("pause")).ok, true);
  assert.equal(api.listAccounts().find((a) => a.active).id, "u2");
});

test("a guest who cast once and went home does not lock the TV out of its own box", async () => {
  reset("u1");
  serve({ boxOn: "" });
  castFrom("someone-elses-account");
  assert.equal((await api.control("pause")).error, "box_other_account", "while their session is up, it is theirs");

  disconnected(); // they stopped and left

  // The name is still the last thing librespot said, and it must not go on
  // refusing every press - nor block the adoption that gets the box back.
  assert.deepEqual(await api.play({ uris: ["spotify:track:x"] }), { ok: false, error: "box_not_found" });
  assert.equal((await api.control("pause")).error, "box_not_found");
});

test("a forged event cannot un-name the box's owner either", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");

  // plugin.js strips `user_name` from an event that does not carry the daemon's
  // key, so what arrives here is a session_connected naming nobody.
  bridge.handleEvent({ player_event: "session_connected" }, false);

  assert.equal(bridge.sessionUser(), "u2", "the owner is what the daemon last said, not what a forger left out");
});

test("a forged disconnect cannot hand a stranger's live cast to the TV", async () => {
  reset("u1");
  serve({ boxOn: "" });
  castFrom("someone-elses-account"); // a guest is casting right now
  assert.equal((await api.play({ uris: ["spotify:track:x"] })).error, "box_other_account");

  // Anything on this box's origin can post an event. Said without the daemon's
  // key, "the session ended" would make the box read as free - and a free box is
  // the one the play path may ADOPT, which restarts librespot into the
  // household's account and ends the guest's cast.
  bridge.handleEvent({ player_event: "session_disconnected" }, false);

  assert.equal(
    (await api.play({ uris: ["spotify:track:x"] })).error,
    "box_other_account",
    "still theirs, and still not adoptable",
  );

  disconnected(); // ...and when the daemon says it, the box is free again
  assert.equal((await api.play({ uris: ["spotify:track:x"] })).error, "box_not_found");
});

test("an activation is a new device id, even when the same account activates again", async () => {
  reset("u1");
  bridge.onSessionUser((u) => api.boxSignedInAs(u)); // what plugin.js wires up
  serve({ boxOn: "u2" });
  castFrom("u2");
  await api.control("pause");
  assert.match(writes()[0].path, /device_id=dev-box$/);

  // The supervisor respawned librespot after a crash: it never went through
  // stopLibrespot, so nothing but this event says the device changed.
  seen = [];
  serve({ boxOn: "u2", boxId: "dev-box-2" });
  castFrom("u2");
  await api.control("pause");

  assert.match(writes()[0].path, /device_id=dev-box-2$/);
  bridge.onSessionUser(null);
});

test("a continuation that activates the box does not repoint the library, whatever the order", async () => {
  reset("u1");
  bridge.onSessionUser((u) => api.boxSignedInAs(u));
  // An idle box answers the first play with 404, and the transfer that follows is
  // what ACTIVATES it - so the activation event arrives in the middle of play(),
  // before it returns.
  let plays = 0;
  handler = (url, opts, body) => {
    if (url === "/api/token") {
      const refresh = new URLSearchParams(body).get("refresh_token");
      return { status: 200, body: JSON.stringify({ access_token: "at-" + refresh, expires_in: 3600 }) };
    }
    if (url === "/v1/me/player/devices") return { status: 200, body: JSON.stringify({ devices: [BOX] }) };
    if (url.indexOf("/v1/me/player/play") === 0) {
      plays++;
      if (plays === 1) return { status: 404, body: "" };
      return { status: 204, body: "" };
    }
    if (url.indexOf("/v1/me/player?") === 0 || url === "/v1/me/player") {
      castFrom("u2"); // the transfer activates the box
      return { status: 204, body: "" };
    }
    return { status: 204, body: "" };
  };

  assert.equal((await api.play({ uris: ["spotify:track:x"], keepActive: true })).ok, true);

  assert.equal(api.listAccounts().find((a) => a.active).id, "u1", "nobody in the room asked for this");
  bridge.onSessionUser(null);
});

test("an account that autoplay names but the box does not have is refused, not swapped", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");

  // accountById used to fall back to the ACTIVE account here, so a pause meant
  // for a removed account went to whoever was active - and without a device id.
  assert.deepEqual(await api.control("pause", undefined, "gone"), { ok: false, error: "no_such_account" });
  assert.equal(writes().length, 0);
});

test("a press Spotify refuses does not move the launcher", async () => {
  reset("u1");
  handler = (url, opts, body) => {
    if (url === "/api/token") {
      const refresh = new URLSearchParams(body).get("refresh_token");
      return { status: 200, body: JSON.stringify({ access_token: "at-" + refresh, expires_in: 3600 }) };
    }
    if (url === "/v1/me/player/devices") {
      const who = String((opts.headers || {}).Authorization || "").replace("Bearer at-r", "u");
      return { status: 200, body: JSON.stringify({ devices: who === "u2" ? [BOX] : [] }) };
    }
    if (url === "/v1/me/player") return { status: 200, body: "{}" };
    return { status: 403, body: "Player command failed" }; // e.g. a Development Mode app
  };
  castFrom("u2");

  assert.equal((await api.control("pause")).ok, false);

  assert.equal(api.listAccounts().find((a) => a.active).id, "u1", "a refused command did not make u2 the one playing");
});

test("a disconnect gives the box back to the device lists rather than to the last owner", async () => {
  reset("u1");
  serve({ boxOn: "u1" });
  castFrom("u2"); // u2 held it...
  disconnected(); // ...and dropped it
  seen = [];

  const r = await api.control("pause");

  assert.equal(r.ok, true);
  assert.equal(writes()[0].bearer, "at-r1", "resolved again from who can see the box");
});

// LAST: it removes an account, and the module's list is process-wide.
test("removing the account holding the box is not a dead end either", async () => {
  reset("u1");
  serve({ boxOn: "u2" });
  castFrom("u2");
  await api.control("pause");

  api.removeAccount("u2"); // Settings -> Accounts -> remove, or a refresh that 401s
  disconnected();
  serve({ boxOn: "" }); // and with it gone, nothing of ours can see the box

  assert.deepEqual(
    await api.play({ uris: ["spotify:track:x"] }),
    { ok: false, error: "box_not_found" },
    "the box is free again, so the TV may take it back",
  );
});

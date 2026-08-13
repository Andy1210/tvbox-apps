// Autoplay tests. Two things here decide whether the room stays quiet when it
// should and gets music when it should, and neither is visible from the outside:
// WHICH endpoint the continuation came from (the one this app may not be allowed
// to call at all), and WHETHER the silence after a track really was the end of the
// playlist.
const test = require("node:test");
const assert = require("node:assert");
const { createAutoplay, continuation, unavailable, interleave } = require("./autoplay");

const track = (id) => ({ uri: "spotify:track:" + id, name: id });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// A Web API stand-in. Each method records its calls so a test can assert that a
// probe was NOT repeated, which is the whole point of remembering the verdict.
function fakeApi(over) {
  const calls = { recommendations: 0, artistTopTracks: 0, primaryArtistId: 0, playerState: 0 };
  return {
    calls,
    // Every argument is forwarded, including the account the read is for. A fake
    // that quietly drops one cannot tell whether the code passes it.
    async recommendations(seeds, limit, accId) {
      calls.recommendations++;
      if (over.recommendations) return over.recommendations(seeds, limit, accId);
      return [track("r1"), track("r2")];
    },
    async primaryArtistId(id, accId) {
      calls.primaryArtistId++;
      return over.primaryArtistId ? over.primaryArtistId(id, accId) : "art-" + id;
    },
    async artistTopTracks(a, accId) {
      calls.artistTopTracks++;
      return over.artistTopTracks
        ? over.artistTopTracks(a, accId)
        : [track(a + "-1"), track(a + "-2"), track(a + "-3")];
    },
    // The REAL boxPlayerState never throws: it catches its own errors and answers
    // with `ok: false`. A fake that throws instead would let a fail-open guard
    // pass its test, which is exactly what happened here once. It answers about
    // THE BOX, not about the active account's player.
    async boxPlayerState() {
      calls.playerState++;
      return over.playerState ? over.playerState() : { ok: true, box: true, is_playing: false };
    },
    ...over.extra,
  };
}

test("recommendations are used when the endpoint answers", async () => {
  const api = fakeApi({});
  const state = { recommendations: "unknown" };
  const r = await continuation(["a"], api, state);
  assert.equal(r.source, "recommendations");
  assert.deepEqual(r.uris, ["spotify:track:r1", "spotify:track:r2"]);
  assert.equal(state.recommendations, "yes");
  assert.equal(api.calls.artistTopTracks, 0, "the ladder below must not run when the top rung answered");
});

test("a 403 is a permanent verdict: the ladder takes over and the probe is not repeated", async () => {
  const api = fakeApi({
    recommendations: () => {
      throw new Error("HTTP 403 Forbidden");
    },
  });
  const state = { recommendations: "unknown" };
  const first = await continuation(["a"], api, state);
  assert.equal(first.source, "artists");
  assert.equal(state.recommendations, "no");
  assert.ok(first.uris.length > 0);

  const second = await continuation(["b"], api, state);
  assert.equal(second.source, "artists");
  assert.equal(api.calls.recommendations, 1, "a deprecated endpoint must be probed once, not once per playlist");
});

test("a passing failure is NOT remembered as a verdict", async () => {
  let n = 0;
  const api = fakeApi({
    recommendations: () => {
      n++;
      if (n === 1) throw new Error("HTTP 429 Too Many Requests");
      return [track("later")];
    },
  });
  const state = { recommendations: "unknown" };
  const first = await continuation(["a"], api, state);
  assert.equal(first.source, "artists", "this time it falls through");
  assert.equal(state.recommendations, "unknown", "but the endpoint is not written off");
  const second = await continuation(["a"], api, state);
  assert.equal(second.source, "recommendations");
});

test("unavailable() tells a permanent refusal from a passing one", () => {
  assert.ok(unavailable(new Error("HTTP 403 x")));
  assert.ok(unavailable(new Error("HTTP 404 x")));
  assert.ok(!unavailable(new Error("HTTP 429 x")));
  assert.ok(!unavailable(new Error("socket hang up")));
  assert.ok(!unavailable(null));
});

test("the artist ladder interleaves and never replays its own seeds", async () => {
  const api = fakeApi({
    recommendations: () => {
      throw new Error("HTTP 404 gone");
    },
    primaryArtistId: (id) => (id === "s1" ? "A" : "B"),
    artistTopTracks: (a) => (a === "A" ? [track("s1"), track("A2")] : [track("B1"), track("B2")]),
  });
  const r = await continuation(["s1", "s2"], api, { recommendations: "no" });
  assert.equal(r.source, "artists");
  // s1 is a seed, so A's own top track drops out; what is left alternates artists.
  assert.deepEqual(r.uris, ["spotify:track:A2", "spotify:track:B1", "spotify:track:B2"]);
});

test("one artist failing does not lose the others", async () => {
  const api = fakeApi({
    recommendations: () => {
      throw new Error("HTTP 403 x");
    },
    primaryArtistId: (id) => id,
    artistTopTracks: (a) => {
      if (a === "bad") throw new Error("HTTP 500");
      return [track(a + "-1")];
    },
  });
  const r = await continuation(["bad", "good"], api, { recommendations: "no" });
  assert.deepEqual(r.uris, ["spotify:track:good-1"]);
});

test("no seeds means no continuation", async () => {
  const api = fakeApi({});
  const r = await continuation([], api, { recommendations: "unknown" });
  assert.equal(r.source, "none");
  assert.deepEqual(r.uris, []);
  assert.equal(api.calls.recommendations, 0);
});

test("interleave round-robins and tolerates ragged lists", () => {
  assert.deepEqual(interleave([[1, 2, 3], [4], [5, 6]]), [1, 4, 5, 2, 6, 3]);
  assert.deepEqual(interleave([]), []);
  assert.deepEqual(interleave([[], []]), []);
});

// ---- the watcher ----
// `graceMs` is injected so these run in milliseconds instead of the four seconds
// the box waits.
function watcher(over = {}) {
  const played = [];
  const api = fakeApi(over.api || {});
  const a = createAutoplay({
    api,
    play: async (body) => {
      played.push(body);
      return over.playFails ? { ok: false, error: "box_not_found" } : { ok: true };
    },
    isEnabled: () => over.enabled !== false,
    log: () => {},
    graceMs: 5,
  });
  return { a, played, api };
}

test("a track that ends with nothing after it continues the music", async () => {
  const { a, played } = watcher();
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(30);
  assert.equal(played.length, 1);
  assert.ok(played[0].uris.length > 0);
});

test("a next track cancels it", async () => {
  const { a, played } = watcher();
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  a.onEvent("track_changed", "t2");
  await tick(30);
  assert.equal(played.length, 0);
});

test("a stop after the last track is the ending, not a cancellation", async () => {
  const { a, played } = watcher();
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  a.onEvent("stopped", "");
  await tick(30);
  assert.equal(played.length, 1, "librespot reports a finished context as end_of_track then stopped");
});

test("a stop the user asked for arms nothing", async () => {
  const { a, played } = watcher();
  a.onEvent("playing", "t1");
  a.onEvent("stopped", "");
  await tick(30);
  assert.equal(played.length, 0);
});

test("switched off, it stays silent", async () => {
  const { a, played } = watcher({ enabled: false });
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(30);
  assert.equal(played.length, 0);
});

test("something already playing means the silence was not an ending", async () => {
  const { a, played } = watcher({ api: { playerState: () => ({ ok: true, box: true, is_playing: true }) } });
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(30);
  assert.equal(played.length, 0);
});

test("a player state we could not read is not permission to start music", async () => {
  // This is the shape the real API returns when /me/player fails: an object with
  // ok:false and NO is_playing. Read as "nothing is playing", it would push
  // autoplay's tracks over a session that never actually stopped.
  const { a, played } = watcher({
    api: { playerState: () => ({ ok: false, box: false, is_playing: false, error: "HTTP 429" }) },
  });
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(30);
  assert.equal(played.length, 0);
});

test("a box no linked account is driving is not continued either", async () => {
  // The guard reads the player of whichever account drives the box. When none
  // does, a continuation could not be played there anyway, and the old shape
  // (asking the ACTIVE account) would have answered "nothing is playing" about a
  // completely different device.
  const { a, played } = watcher({ api: { playerState: () => ({ ok: true, box: false, is_playing: false }) } });
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(30);
  assert.equal(played.length, 0);
});

test("a player read that throws does not start music either", async () => {
  const { a, played } = watcher({
    api: {
      playerState: () => {
        throw new Error("network");
      },
    },
  });
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(30);
  assert.equal(played.length, 0);
});

test("switching autoplay off mid-build calls off the continuation", async () => {
  // Building one is several round trips and can sit out a rate limit, so it is
  // seconds long. Checking the conditions only before those awaits would let
  // music start after the listener had already switched the feature off.
  let on = true;
  const played = [];
  const api = fakeApi({
    recommendations: async () => {
      on = false; // the settings toggle, while the continuation is being built
      return [track("x")];
    },
  });
  const a = createAutoplay({
    api,
    play: async (b) => {
      played.push(b);
      return { ok: true };
    },
    isEnabled: () => on,
    log: () => {},
    graceMs: 5,
  });
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(40);
  assert.equal(played.length, 0);
});

test("a pause during the build calls it off too", async () => {
  const played = [];
  let a;
  const api = fakeApi({
    recommendations: async () => {
      a.onEvent("paused", "t1"); // the listener presses pause mid-build
      return [track("x")];
    },
  });
  a = createAutoplay({
    api,
    play: async (b) => {
      played.push(b);
      return { ok: true };
    },
    isEnabled: () => true,
    log: () => {},
    graceMs: 5,
  });
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(40);
  assert.equal(played.length, 0);
});

test("a pause that lands while the play request is out stops the music again", async () => {
  // The request cannot be recalled once it is in flight, so the only honest
  // answer is to stop what it started.
  const played = [];
  const controls = [];
  let a;
  const api = fakeApi({
    playerState: () => ({ ok: true, box: true, is_playing: false, accountId: "bob" }),
    extra: {
      async control(action, state, accId) {
        controls.push([action, accId]);
        return { ok: true };
      },
    },
  });
  a = createAutoplay({
    api,
    play: async (b) => {
      played.push(b);
      a.onEvent("paused", "t1"); // the listener presses pause while this is out
      return { ok: true };
    },
    isEnabled: () => true,
    log: () => {},
    graceMs: 5,
  });
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(40);
  assert.equal(played.length, 1, "the request had already gone");
  // The account matters as much as the action: the play went out under the box's
  // account without making it active, so a pause as the active one would reach a
  // different player and leave this music running.
  assert.deepEqual(controls, [["pause", "bob"]]);
});

test("the continuation is chosen for the account that will play it", async () => {
  // autoplay plays with keepActive, so the account driving the box is
  // deliberately not made the active one. A catalog read for the wrong account is
  // answered for the wrong COUNTRY, which on a box with two accounts in two
  // countries returns tracks the one actually playing cannot play.
  const asked = [];
  const { a } = watcher({
    api: {
      playerState: () => ({ ok: true, box: true, is_playing: false, accountId: "bob" }),
      recommendations: (seeds, limit, accId) => {
        asked.push(accId);
        return [track("x")];
      },
    },
  });
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(30);
  assert.deepEqual(asked, ["bob"], "the box's account, not whichever one is active");
});

test("a continuation never changes which account the box's screens show", async () => {
  const { a, played } = watcher();
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(30);
  assert.equal(played.length, 1);
  assert.equal(played[0].keepActive, true, "an unattended play must not switch the active account");
});

test("the unattended bound holds even when a continuation is not recognised as its own", async () => {
  // Track ids can be relinked on playback, so `queued` can miss - and then every
  // continuation looks like somebody else starting music and resets the chain.
  // The second bound is the one that cannot be fooled that way.
  const { a, played } = watcher();
  for (let i = 0; i < 12; i++) {
    a.onEvent("playing", "relinked-" + i); // never one of the ids we queued
    a.onEvent("end_of_track", "relinked-" + i);
    await tick(30);
  }
  assert.equal(played.length, 6, "MAX_UNATTENDED is the ceiling regardless of id matching");

  a.userPlayed(); // somebody pressed something
  a.onEvent("playing", "fresh");
  a.onEvent("end_of_track", "fresh");
  await tick(30);
  assert.equal(played.length, 7);
});

test("the chain is bounded, and a play the user starts resets it", async () => {
  const { a, played } = watcher();
  // Each round: the continuation's own first track plays, then that ends too. The
  // continuation's tracks must NOT read as a fresh start, or the chain never ends.
  for (let i = 0; i < 5; i++) {
    a.onEvent("playing", "r1");
    a.onEvent("end_of_track", "r1");
    await tick(30);
  }
  assert.equal(played.length, 3, "one finished playlist must not play until someone stops it");

  a.userPlayed();
  a.onEvent("playing", "fresh");
  a.onEvent("end_of_track", "fresh");
  await tick(30);
  assert.equal(played.length, 4);
});

test("a cast started elsewhere resets the chain, so autoplay does not die on a cast-only box", async () => {
  // The TV UI's play button is the only thing that calls userPlayed(); a household
  // that always casts from a phone would otherwise get three continuations ever.
  const { a, played } = watcher();
  for (let i = 0; i < 4; i++) {
    a.onEvent("playing", "r1");
    a.onEvent("end_of_track", "r1");
    await tick(30);
  }
  assert.equal(played.length, 3);
  a.onEvent("playing", "somebody-elses-track"); // a cast, not one of ours
  a.onEvent("end_of_track", "somebody-elses-track");
  await tick(30);
  assert.equal(played.length, 4);
});

test("two ends inside the grace window continue once, not twice", async () => {
  const { a, played } = watcher();
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  a.onEvent("end_of_track", "t1");
  await tick(40);
  assert.equal(played.length, 1, "an overwritten timer would be uncancellable and would fire again");
});

test("a next track still cancels when two ends were seen", async () => {
  const { a, played } = watcher();
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  a.onEvent("end_of_track", "t1");
  a.onEvent("playing", "t2");
  await tick(40);
  assert.equal(played.length, 0);
});

test("pause inside the grace window stops the continuation", async () => {
  const { a, played } = watcher();
  a.onEvent("playing", "t1");
  a.onEvent("end_of_track", "t1");
  a.onEvent("paused", "t1");
  await tick(30);
  assert.equal(played.length, 0, "music the listener just stopped must not be replaced by more music");
});

test("the seeds are the session that ended, not whatever plays next", async () => {
  const seen = [];
  const { a } = watcher({
    api: {
      recommendations: (seeds) => {
        seen.push([...seeds]);
        return [track("x")];
      },
    },
  });
  a.onEvent("track_changed", "t1");
  a.onEvent("end_of_track", "t1");
  // librespot reports the session ending after the last track, which clears the
  // history - the seeds must already have been taken.
  a.onEvent("stopped", "");
  await tick(30);
  assert.deepEqual(seen[0], ["t1"]);
});

test("a new session does not seed from the previous one", async () => {
  const seen = [];
  const { a } = watcher({
    api: {
      recommendations: (seeds) => {
        seen.push([...seeds]);
        return [track("x")];
      },
    },
  });
  a.onEvent("track_changed", "guest-track");
  a.onEvent("stopped", "");
  a.onEvent("track_changed", "mine");
  a.onEvent("end_of_track", "mine");
  await tick(30);
  assert.deepEqual(seen[0], ["mine"], "a guest's listening must not seed the owner's continuation");
});

test("seeds come from what actually played, newest last", async () => {
  const seen = [];
  const { a } = watcher({
    api: {
      recommendations: (seeds) => {
        seen.push([...seeds]);
        return [track("x")];
      },
    },
  });
  for (const id of ["t1", "t2", "t3", "t4", "t5", "t6"]) a.onEvent("track_changed", id);
  a.onEvent("end_of_track", "t6");
  await tick(30);
  assert.deepEqual(seen[0], ["t2", "t3", "t4", "t5", "t6"], "at most five, and the most recent ones");
});

test("a repeated event does not fill the history with one track", async () => {
  const seen = [];
  const { a } = watcher({
    api: {
      recommendations: (seeds) => {
        seen.push([...seeds]);
        return [track("x")];
      },
    },
  });
  a.onEvent("track_changed", "t1");
  a.onEvent("playing", "t1");
  a.onEvent("loading", "t1");
  a.onEvent("track_changed", "t2");
  a.onEvent("end_of_track", "t2");
  await tick(30);
  assert.deepEqual(seen[0], ["t1", "t2"]);
});

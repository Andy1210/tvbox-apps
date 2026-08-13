// What plays when a playlist runs out.
//
// Spotify's own Autoplay - the similar tracks an official client queues when a
// context ends - is not exposed on the Web API, and neither is Smart Shuffle. So
// the box builds its own continuation, and the endpoint that would do it directly
// cannot simply be called: /recommendations was deprecated for apps registered
// after 2024-11-27, which makes availability a property of the OWNER's Spotify app
// registration rather than something this code can know. It is therefore PROBED at
// runtime and the verdict remembered, with a ladder underneath that every app
// still has.
//
// The signal that a context ended is silence, not an event. librespot emits
// `end_of_track` after every track and then simply says nothing more when there is
// no next one, so end-of-track ARMS a timer and anything that starts playing
// cancels it. The timer also re-checks the player before acting: several librespot
// events can follow a track's end, in an order that is not guaranteed, so the
// player's own state is the only reliable answer to "did anything start".

const SEEDS_MAX = 5; // the Recommendations endpoint's own seed limit
const WANT = 30; // how many tracks one continuation queues
const ARTISTS_MAX = 4; // artists to draw on when recommendations are unavailable
const PER_ARTIST = 5; // ... and how many of each artist's top tracks to take
const RECENT_MAX = 10; // how much history is kept to seed from
const END_GRACE_MS = 4000; // how long after end_of_track a next track may still start
// A continuation ends in a track that ends, which would arm the next one: without
// a bound, one finished playlist plays until someone stops it.
//
// Two bounds, because they fail differently. MAX_CHAIN counts continuations since
// anything else was heard playing, and "anything else" is recognised by track id -
// good, but an id can be relinked on playback and then a continuation looks like
// somebody else's music. MAX_UNATTENDED counts them since a person demonstrably
// did something (pressed play, or any transport button) and cannot be fooled that
// way. Three continuations is roughly ninety tracks; six is the ceiling.
const MAX_CHAIN = 3;
const MAX_UNATTENDED = 6;

// 403 means the app was registered after the deprecation, 404 that the endpoint is
// gone for it entirely. Both are permanent for this client id, so the probe is
// answered once and for all. A 429 or a network error is neither, and must not be
// remembered as a verdict.
function unavailable(err) {
  return /HTTP (403|404)/.test(String((err && err.message) || err || ""));
}

function uniq(list) {
  return [...new Set((list || []).filter(Boolean))];
}

// Round-robin rather than artist after artist: five tracks of one artist and then
// five of the next is a different thing from a mix.
function interleave(lists) {
  const out = [];
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

// Build the uris to play next from what was just played. `deps` is the Web API
// surface (injected so this is testable without one), `state` carries the probe
// verdict across calls.
async function continuation(seedTrackIds, deps, state) {
  const seeds = uniq(seedTrackIds).slice(-SEEDS_MAX);
  if (!seeds.length) return { uris: [], source: "none" };

  if (state.recommendations !== "no") {
    try {
      const tracks = await deps.recommendations(seeds, WANT);
      state.recommendations = "yes";
      const uris = uniq((tracks || []).map((t) => t && t.uri));
      if (uris.length) return { uris, source: "recommendations" };
    } catch (e) {
      if (unavailable(e)) state.recommendations = "no";
      // Anything else is a passing failure: fall through to the ladder this time,
      // but leave the verdict alone so it is tried again next time.
    }
  }

  // Artist top tracks: still available to every app, and unlike a walk of the
  // user's own library it brings music the library does not already have, which is
  // the point of an autoplay.
  const artistIds = [];
  for (const id of seeds) {
    let a = "";
    try {
      a = await deps.primaryArtistId(id);
    } catch (e) {
      a = "";
    }
    if (a && !artistIds.includes(a)) artistIds.push(a);
    if (artistIds.length >= ARTISTS_MAX) break;
  }
  const seen = new Set(seeds.map((id) => "spotify:track:" + id));
  const perArtist = [];
  for (const a of artistIds) {
    let tracks = [];
    try {
      tracks = await deps.artistTopTracks(a);
    } catch (e) {
      continue; // one artist failing must not lose the others
    }
    const take = [];
    for (const t of tracks || []) {
      if (!t || !t.uri || seen.has(t.uri)) continue;
      seen.add(t.uri);
      take.push(t.uri);
      if (take.length >= PER_ARTIST) break;
    }
    if (take.length) perArtist.push(take);
  }
  const uris = interleave(perArtist).slice(0, WANT);
  return uris.length ? { uris, source: "artists" } : { uris: [], source: "none" };
}

// The event glue: watches librespot's player events, and when a context runs out
// asks continuation() what to play and starts it on the box.
//
// `isEnabled` is read at the moment it matters rather than captured, so turning
// autoplay off in Settings takes effect on the playlist that is already running.
function createAutoplay({ api, play, isEnabled, log, graceMs }) {
  const grace = Number(graceMs) > 0 ? Number(graceMs) : END_GRACE_MS;
  const state = { recommendations: "unknown" };
  let recent = [];
  let armed = null;
  let armedSeeds = []; // the history AS IT WAS when the timer was set (see below)
  let queued = new Set(); // track ids of the continuation we started, if any
  let chain = 0;
  let unattended = 0;
  let busy = false;
  let generation = 0; // bumped by anything that should call off a continuation already being built
  const say = (m) => {
    try {
      if (log) log("spotify autoplay: " + m);
    } catch (e) {}
  };

  // Calls off both a pending timer and a continuation already being built.
  // Building one is several round trips and can sit out a rate limit, so it is
  // seconds long: checking the conditions only before those awaits would let
  // music start after the listener had already pressed pause, or after autoplay
  // had been switched off in Settings.
  function disarm() {
    if (armed) clearTimeout(armed);
    armed = null;
    generation++;
  }
  function noteTrack(trackId) {
    const id = String(trackId || "");
    if (!id) return;
    // A track the LAST continuation queued is not somebody starting something, so
    // it does not end the chain. Anything else is a fresh start: without this the
    // chain could only ever be reset from this box's own UI, and a household that
    // starts its music by casting would find autoplay silently dead after three.
    if (!queued.has(id)) {
      chain = 0;
      queued.clear();
    }
    if (recent[recent.length - 1] === id) return;
    recent.push(id);
    while (recent.length > RECENT_MAX) recent.shift();
  }

  async function fire() {
    armed = null;
    if (busy) return;
    busy = true; // claimed BEFORE the first await: two timers must not both continue
    const mine = generation; // anything that calls off a continuation bumps this
    const cancelled = () => generation !== mine || !isEnabled();
    try {
      if (!isEnabled()) return;
      if (chain >= MAX_CHAIN) return say("chain limit reached; stopping here");
      if (unattended >= MAX_UNATTENDED) return say("nothing has been asked for in a while; stopping here");
      // The events alone cannot say whether the silence is an ending, so ask the
      // player - and require an ANSWER. `ok` false means we could not find out,
      // which is not the same as "nothing is playing": treating it as such is how
      // autoplay would push its own tracks over a session that never stopped.
      const st = await api.playerState();
      if (!st || !st.ok) return say("player state unknown; not continuing");
      if (st.is_playing) return;
      if (cancelled()) return say("called off before it started");
      const { uris, source } = await continuation(armedSeeds, api, state);
      if (!uris.length) return say("nothing to continue with");
      if (cancelled()) return say("called off before it started");
      // Claimed BEFORE the request: librespot can report the first track playing
      // before play() has even returned, and a `playing` for a track we do not yet
      // recognise as ours would reset the chain and make autoplay endless.
      queued = new Set(uris.map((u) => String(u).split(":").pop()));
      let r;
      try {
        // keepActive: this play was nobody's decision, so it must not change which
        // linked account the box's screens are showing.
        r = await play({ uris, keepActive: true });
      } catch (e) {
        queued.clear();
        throw e;
      }
      if (r && r.ok) {
        chain++;
        unattended++;
        say(`continued from ${source} with ${uris.length} tracks`);
      } else {
        queued.clear();
        say("play refused: " + ((r && r.error) || "?"));
      }
    } catch (e) {
      say("failed: " + (e.message || e));
    } finally {
      busy = false;
    }
  }

  return {
    // Called for every librespot player event the bridge handles.
    onEvent(name, trackId) {
      switch (name) {
        case "end_of_track":
          disarm(); // an overwritten timer would be uncancellable, and would fire twice
          if (!isEnabled()) return;
          // The seeds are taken NOW, because the session that just ended is what
          // they should describe - and the `stopped` that follows clears the
          // history so the next session does not inherit it.
          armedSeeds = [...recent];
          armed = setTimeout(fire, grace);
          return;
        case "playing":
        case "loading":
        case "track_changed":
          disarm();
          noteTrack(trackId);
          return;
        case "paused":
          // Music the listener just stopped must not be replaced by more music.
          disarm();
          return;
        case "stopped":
        case "session_disconnected":
          // These do NOT disarm: a context running out is followed by exactly
          // them, so treating them as a cancellation would switch the feature off
          // entirely. A stop the listener asked for arms nothing, because it is
          // not preceded by end_of_track. The history is dropped, though - the
          // next session is somebody else's and must not seed from this one.
          recent = [];
          return;
        default:
          return;
      }
    },
    // Somebody in the room did something: started a track, or pressed a transport
    // button. Either way this is a fresh start, not a link in a chain, and it is
    // the one signal that cannot be confused with autoplay's own music.
    userPlayed() {
      chain = 0;
      unattended = 0;
      queued.clear();
      disarm();
    },
    stop: disarm,
  };
}

module.exports = { createAutoplay, continuation, unavailable, interleave, END_GRACE_MS, MAX_CHAIN };

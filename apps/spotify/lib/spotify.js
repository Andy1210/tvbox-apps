// tvbox Spotify bridge — cast-only.
//
// The box is a Spotify Connect endpoint via librespot/raspotify. librespot's
// --onevent hook (spotify_event_hook.sh) POSTs each player event WITH full track
// metadata (librespot 0.8 exports NAME/ARTISTS/ALBUM/COVERS/DURATION_MS/...), so
// we just hold playback state and push it to the launcher over SSE — with NO
// Spotify Web API and NO credentials. Control happens from the casting phone; the
// box only displays now-playing and auto-opens the Spotify app when a cast starts.
//
// Packaged Spotify cast bridge (Kodi-model app code — ships in the app package,
// not the core shell). `config` is the shell's config store, injected once by
// plugin.js via setConfig(host.config); we read rawSpotify() for the Connect
// device name. There is no core `./config` module in the package.
let config = { rawSpotify: () => null };
function setConfig(cfg) {
  if (cfg) config = cfg;
}

// The Spotify Connect device name. The shell passes this same value to librespot
// as --name (main.js), so the idle screen and the phone's Connect list agree.
function deviceName() {
  return (config.rawSpotify() || {}).deviceName || "tvbox";
}

// ---- playback state (entirely event-fed) ----
const EMPTY = {
  track_id: "",
  uri: "",
  title: "",
  artist: "",
  album: "",
  cover_url: "",
  artist_image_url: "",
  duration_ms: 0,
  position_ms: 0,
  is_playing: false,
  item_type: "",
};
const state = { ...EMPTY, pos_ts: 0 };
function reset() {
  Object.assign(state, EMPTY, { pos_ts: 0 });
}

function estimatedPosition() {
  if (!state.is_playing || !state.pos_ts) return state.position_ms;
  const elapsed = Date.now() - state.pos_ts;
  return Math.min(state.position_ms + elapsed, Math.max(state.duration_ms, 0));
}
function getState() {
  return {
    track_id: state.track_id,
    uri: state.uri,
    title: state.title,
    artist: state.artist,
    album: state.album,
    cover_url: state.cover_url,
    artist_image_url: state.artist_image_url,
    duration_ms: state.duration_ms,
    position_ms: estimatedPosition(),
    is_playing: state.is_playing,
    item_type: state.item_type,
    device_name: deviceName(),
  };
}

// The optional Web-API enrichment (the plugin sets the current artist's photo for
// the now-playing background). Cleared automatically when the track changes.
function setArtistImage(url) {
  state.artist_image_url = String(url || "");
  notify();
}

// ---- SSE listeners ----
const listeners = new Set();
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  const s = getState();
  for (const fn of listeners) {
    try {
      fn(s);
    } catch (e) {
      /* drop */
    }
  }
}

// ---- cast lifecycle ----
// Rising edge: when a cast session starts (idle -> playing) fire a callback so
// the shell can auto-open the Spotify app and stop any other playback. It fires
// once per session; pausing keeps the session, stop/disconnect ends it (so the
// next cast re-fires). Resuming after a pause does NOT re-grab focus.
let casting = false;
let castStartCb = null;
function onCastStart(cb) {
  castStartCb = cb;
}
function markCastActive() {
  if (casting) return;
  casting = true;
  try {
    if (castStartCb) castStartCb();
  } catch (e) {
    console.warn("[spotify] castStart cb:", e.message);
  }
}

// ---- whose account the box is signed into ----
// librespot holds exactly ONE account's session at a time — whoever last picked
// the box in their Spotify app — and names it on session_connected as USER_NAME,
// which is the same string the Web API calls that user's id. That account is the
// only one any command about the box may be sent as: the account the launcher
// happens to be browsing is a different question, and a command sent as that one
// reaches whatever device IT is playing on, which can be a phone in another room.
//
// Empty means we have not been told. That is not "nobody": the device lists
// answer the same question through Spotify, and spotify_api falls back to them
// whenever this is empty or turns out not to hold.
//
// librespot 0.8 emits session_connected from handle_activate() ONLY - when the
// box becomes the active Connect device, i.e. when somebody casts to it. It says
// nothing at startup, so a box sitting on its cached credentials never reports an
// owner here, and session_disconnected means "the box went idle", not "the box
// lost its account" - the daemon stays signed in as the same user. So this is
// cleared when the DAEMON goes (see clear()), not when playback moves away.
//
// `casting` is the second half of it, and the two are not the same question. A
// name here outlives the session it came from, on purpose; whether that session
// is still up is what says how much the name is worth. Only a LIVE session by an
// account we have not linked may refuse the TV its buttons - a name left over
// from a guest who cast once and went home must not, or the box refuses
// everything until its daemon is restarted.
let sessionUser = "";
let sessionLive = false;
let sessionUserCb = null;
function onSessionUser(cb) {
  sessionUserCb = cb;
}
function getSessionUser() {
  return sessionUser;
}
// Is somebody using the box right now? Either signal is enough: the activation
// event says so directly, and a cast that is playing says so even if that event
// was lost (the hook swallows a failed post).
function sessionActive() {
  return sessionLive || casting;
}
function fireSessionUser() {
  try {
    if (sessionUserCb) sessionUserCb(sessionUser);
  } catch (e) {
    console.warn("[spotify] sessionUser cb:", e.message);
  }
}
function setSessionUser(u) {
  const v = String(u || "");
  if (v === sessionUser) return;
  sessionUser = v;
  fireSessionUser();
}

// ---- librespot events (rich payload from spotify_event_hook.sh) ----
function applyMeta(ev) {
  if (ev.track_id) {
    const tid = String(ev.track_id);
    if (tid !== state.track_id) state.artist_image_url = ""; // new track -> drop the stale artist bg
    state.track_id = tid;
  }
  if (ev.uri) state.uri = String(ev.uri);
  if (ev.name) state.title = String(ev.name);
  if (ev.artists) state.artist = String(ev.artists);
  if (ev.album) state.album = String(ev.album);
  if (ev.cover_url) state.cover_url = String(ev.cover_url);
  if (ev.item_type) state.item_type = String(ev.item_type);
  const dur = Number(ev.duration_ms);
  if (Number.isFinite(dur) && dur > 0) state.duration_ms = dur;
}
function applyPos(ev) {
  const p = Number(ev.position_ms);
  if (Number.isFinite(p)) state.position_ms = p;
}
function handleEvent(ev) {
  const e = String(ev.player_event || "").toLowerCase();
  const now = Date.now();
  switch (e) {
    // Not a playback event, so there is nothing to render — but it is the moment
    // the box changed hands, and everything the TV can do to it depends on that.
    //
    // An event with no name at all leaves the owner alone rather than clearing it:
    // the name is the one field held to the daemon's key (plugin.js), so a forged
    // event arrives here stripped of it, and taking that as "nobody owns the box"
    // would hand the forger the same denial by the other door.
    //
    // Fired even when the name has not changed, because the DEVICE has: an
    // activation follows a respawn, and the respawned daemon is a new device id
    // under the same name — one Spotify accepts and quietly does nothing with.
    case "session_connected":
      if (!ev.user_name) return;
      sessionLive = true; // somebody's session is up, whoever they are
      sessionUser = String(ev.user_name);
      fireSessionUser();
      return;
    case "stopped":
    case "session_disconnected":
      // Neither of these ends the daemon's login (see sessionUser above), so the
      // owner's NAME is left alone: forgetting it here would drop the fast path
      // every time the music paused its way out of the room. What does end is the
      // session, and that is what decides whether a name we cannot use may hold
      // the TV's buttons.
      if (e === "session_disconnected") sessionLive = false;
      reset();
      casting = false;
      notify();
      return;
    case "loading":
    case "track_changed":
      applyMeta(ev);
      applyPos(ev);
      state.pos_ts = state.is_playing ? now : 0;
      markCastActive();
      break;
    case "playing":
      applyMeta(ev);
      applyPos(ev);
      state.is_playing = true;
      state.pos_ts = now;
      markCastActive();
      break;
    case "paused":
      applyPos(ev);
      state.is_playing = false;
      state.pos_ts = 0;
      break;
    case "seeked":
    case "seek":
      applyPos(ev);
      state.pos_ts = state.is_playing ? now : 0;
      break;
    case "end_of_track":
      state.is_playing = false;
      state.pos_ts = 0;
      break;
    default:
      return; // volume_changed / shuffle_changed / session_client_changed / ... — nothing to render
  }
  notify();
}

// Push the current state to SSE clients (e.g. after a device-name change, so the
// UI reflects the new name immediately rather than on next cast/reconnect).
function pushState() {
  notify();
}

// Reset to idle and push. The shell calls this when it deliberately tears down
// librespot (e.g. a rename respawn): a killed process emits no disconnect event,
// so without this the UI would keep showing the last track until a reconnect.
//
// The owner goes with it, and only here: the daemon that was signed in is the one
// being killed, and the next one comes up naming nobody until somebody casts to
// it. Kept, it would address commands to a device id that no longer exists -
// which Spotify accepts and silently does nothing with.
function clear() {
  reset();
  casting = false;
  sessionLive = false;
  setSessionUser("");
  notify();
}

module.exports = {
  setConfig,
  getState,
  subscribe,
  handleEvent,
  deviceName,
  onCastStart,
  onSessionUser,
  sessionUser: getSessionUser,
  sessionActive,
  pushState,
  clear,
  setArtistImage,
};

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
    case "stopped":
    case "session_disconnected":
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
      return; // volume_changed / shuffle_changed / session_connected / ... — nothing to render
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
function clear() {
  reset();
  casting = false;
  notify();
}

module.exports = { setConfig, getState, subscribe, handleEvent, deviceName, onCastStart, pushState, clear, setArtistImage };

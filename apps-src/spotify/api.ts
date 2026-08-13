// Live Spotify playback state, pushed by the shell over SSE (shell/spotify.js).
// Cast is always available; the Web API types/calls below are OPTIONAL account
// features (shell/spotify_api.js) that only work once an account is connected.
export interface SpState {
  track_id: string;
  uri: string;
  title: string;
  artist: string;
  album: string;
  cover_url: string;
  artist_image_url: string; // primary artist photo (Web API enrichment); "" if none/not connected
  duration_ms: number;
  position_ms: number;
  is_playing: boolean;
  item_type: string;
  device_name: string;
}

export interface LyricLine {
  ms: number;
  text: string;
}
export interface Lyrics {
  synced: LyricLine[];
  plain: string;
  instrumental: boolean;
}

export interface Track {
  uri: string;
  name: string;
  artists: string;
  album: string;
  duration_ms: number;
  image_url: string;
  // Position in the collection this track came from, which is NOT its index in
  // this array: an entry Spotify cannot resolve to a track (removed, or blocked
  // in this market) is dropped from the list but still occupies a position in the
  // playlist. `offset.position` is told the playlist's number, so playback from a
  // row has to carry this rather than the row's own index.
  pos?: number;
}

export interface Playlist {
  id: string;
  uri: string;
  name: string;
  owner: string;
  is_own: boolean;
  tracks_total: number | null;
  image_url: string;
}

export interface Account {
  id: string;
  name: string;
  active: boolean;
}

export interface AuthStatus {
  configured: boolean; // client_id/secret present
  connected: boolean; // at least one account is linked
  user: string; // active account's display name
  accounts: Account[];
  connectSeq: number; // increments on each successful OAuth link (for the connect UI)
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function authStatus(): Promise<AuthStatus> {
  try {
    const r = await fetch("/tvbox/api/spotify/auth/status", { cache: "no-store" });
    const s = (await r.json()) as AuthStatus;
    return { ...s, accounts: s.accounts || [], connectSeq: s.connectSeq || 0 };
  } catch {
    return { configured: false, connected: false, user: "", accounts: [], connectSeq: 0 };
  }
}

export async function switchAccount(id: string): Promise<void> {
  await fetch("/tvbox/api/spotify/account/switch", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ id }),
  }).catch(() => {});
}

export async function removeAccount(id: string): Promise<void> {
  await fetch("/tvbox/api/spotify/account/remove", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ id }),
  }).catch(() => {});
}

export async function startConnect(): Promise<void> {
  await fetch("/tvbox/api/spotify/auth/start").catch(() => {});
}

// Turn Spotify Connect on/off for this box (librespot daemon). No account
// needed — this is the built-in app's on/off switch.
export async function setSpotifyEnabled(enabled: boolean): Promise<boolean> {
  try {
    const r = await fetch("/tvbox/api/spotify/enable", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled }),
    });
    return (await r.json()).ok === true;
  } catch {
    return false;
  }
}

export async function disconnectAccount(): Promise<void> {
  await fetch("/tvbox/api/spotify/disconnect", { method: "POST" }).catch(() => {});
}

export async function fetchLiked(): Promise<ListResult<Track>> {
  try {
    const j = await (await fetch("/tvbox/api/spotify/liked", { cache: "no-store" })).json();
    return { items: j.tracks || [], error: String(j.error || ""), truncated: !!j.truncated };
  } catch {
    return { items: [], error: "network" };
  }
}

// Lists carry the API error out to the UI: a 403 from a Development-Mode
// Spotify app whose User Management list is missing this account must read as
// an instruction, not as an empty library.
//
// `truncated` is the other half of the same rule: a library longer than the
// server's paging bound must say so rather than just ending.
export interface ListResult<T> {
  items: T[];
  error: string;
  truncated?: boolean;
}

export async function fetchPlaylists(): Promise<ListResult<Playlist>> {
  try {
    const j = await (await fetch("/tvbox/api/spotify/playlists", { cache: "no-store" })).json();
    return { items: j.playlists || [], error: String(j.error || "") };
  } catch {
    return { items: [], error: "network" };
  }
}

export async function fetchPlaylistItems(id: string): Promise<ListResult<Track>> {
  try {
    const j = await (
      await fetch("/tvbox/api/spotify/playlist?id=" + encodeURIComponent(id), { cache: "no-store" })
    ).json();
    return { items: j.tracks || [], error: String(j.error || ""), truncated: !!j.truncated };
  } catch {
    return { items: [], error: "network" };
  }
}

export async function search(q: string): Promise<{ tracks: Track[]; playlists: Playlist[] }> {
  try {
    const r = await (await fetch("/tvbox/api/spotify/search?q=" + encodeURIComponent(q), { cache: "no-store" })).json();
    return { tracks: r.tracks || [], playlists: r.playlists || [] };
  } catch {
    return { tracks: [], playlists: [] };
  }
}

export async function control(action: string, state?: boolean | string): Promise<string> {
  // returns "" on success, else the API error - a 403 from a Development Mode
  // app must surface as an instruction, not as dead buttons
  try {
    const r = await fetch("/tvbox/api/spotify/control", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(state === undefined ? { action } : { action, state }),
    });
    const j = await r.json();
    return j.ok === true ? "" : String(j.error || "control failed");
  } catch {
    return "network";
  }
}

export type Repeat = "off" | "context" | "track";
export interface PlayerState {
  ok: boolean; // false = we could not find out, which is not the same as "nothing is playing"
  connected: boolean;
  active: boolean;
  is_playing?: boolean;
  shuffle: boolean;
  repeat: Repeat;
  device?: string; // the Spotify Connect device the ACTIVE account is playing on
}

// Shuffle and repeat are player-wide settings that the cast metadata (the SSE
// state) does not carry, so the toggles read them from here rather than
// remembering what they last sent - the phone can change either of them too.
export async function playerState(): Promise<PlayerState> {
  const unknown: PlayerState = { ok: false, connected: false, active: false, shuffle: false, repeat: "off" };
  try {
    const j = await (await fetch("/tvbox/api/spotify/player", { cache: "no-store" })).json();
    return {
      ok: !!j.ok,
      connected: !!j.connected,
      active: !!j.active,
      is_playing: !!j.is_playing,
      shuffle: !!j.shuffle,
      repeat: (["off", "context", "track"].includes(j.repeat) ? j.repeat : "off") as Repeat,
      device: String(j.device || ""),
    };
  } catch {
    return unknown;
  }
}

export async function getAutoplay(): Promise<boolean> {
  try {
    return !!(await (await fetch("/tvbox/api/spotify/autoplay", { cache: "no-store" })).json()).enabled;
  } catch {
    return false;
  }
}

export async function setAutoplay(enabled: boolean): Promise<boolean> {
  try {
    const r = await fetch("/tvbox/api/spotify/autoplay", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled }),
    });
    return !!(await r.json()).enabled;
  } catch {
    return !enabled;
  }
}

// How many track uris the fallback is worth sending. The box caps what it
// forwards to Spotify at the same number, so anything beyond this is a larger
// request between two processes on the same machine for nothing: a thousand-track
// playlist would serialise its whole tail on every press.
export const URIS_MAX = 100;

// `offset` is the position WITHIN the context, and `collection` asks the box to
// play Liked Songs as a context of its own. Both exist so a track picked from a
// long list starts the real playlist at that track, instead of a flat copy of it:
// a copy runs out where it was cut, and shuffle and repeat only ever see what was
// copied. `uris` stays as the fallback for a selection with no context.
export async function play(body: {
  contextUri?: string;
  uris?: string[];
  offset?: number;
  collection?: boolean;
}): Promise<{ ok: boolean; error: string }> {
  try {
    const r = await fetch("/tvbox/api/spotify/play", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    const j = await r.json();
    return { ok: j.ok === true, error: String(j.error || "") };
  } catch {
    return { ok: false, error: "network" };
  }
}

// Lyrics from the shell's LRCLIB proxy — matched by the track metadata, so it
// works cast-only (no Spotify account). `synced` is time-tagged for a karaoke view.
export async function fetchLyrics(s: SpState): Promise<Lyrics> {
  const q = new URLSearchParams({
    title: s.title,
    artist: s.artist,
    album: s.album || "",
    duration: String(Math.round((s.duration_ms || 0) / 1000)),
  });
  try {
    const r = await fetch("/tvbox/api/spotify/lyrics?" + q.toString(), { cache: "no-store" });
    const d = await r.json();
    return { synced: d.synced || [], plain: d.plain || "", instrumental: !!d.instrumental };
  } catch {
    return { synced: [], plain: "", instrumental: false };
  }
}

// "m:ss" from milliseconds.
export function mmss(ms: number): string {
  if (!ms || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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

export async function fetchLiked(): Promise<Track[]> {
  try {
    return (await (await fetch("/tvbox/api/spotify/liked", { cache: "no-store" })).json()).tracks || [];
  } catch {
    return [];
  }
}

export async function fetchPlaylists(): Promise<Playlist[]> {
  try {
    return (await (await fetch("/tvbox/api/spotify/playlists", { cache: "no-store" })).json()).playlists || [];
  } catch {
    return [];
  }
}

export async function fetchPlaylistItems(id: string): Promise<Track[]> {
  try {
    return (
      (await (await fetch("/tvbox/api/spotify/playlist?id=" + encodeURIComponent(id), { cache: "no-store" })).json())
        .tracks || []
    );
  } catch {
    return [];
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

export async function control(action: string): Promise<void> {
  await fetch("/tvbox/api/spotify/control", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ action }),
  }).catch(() => {});
}

export async function play(body: { contextUri?: string; uris?: string[] }): Promise<{ ok: boolean; error: string }> {
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

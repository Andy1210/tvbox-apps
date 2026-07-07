// tvbox Spotify Web API — OPTIONAL. Adds account features (Liked Songs, search,
// playlist browsing, play-to-box) on top of the always-on cast-only bridge
// (spotify.js). If no client_id/secret/token is configured, every method here is
// a no-op and the UI hides the features — the box still works as a cast target.
//
// Auth: OAuth Authorization Code flow, done ON the box (Spotify only allows a
// loopback http redirect, so it can't come back to a phone). The refresh token
// is persisted (chmod 600) and rotated tokens are re-persisted — Spotify rotates
// refresh tokens, and dropping a rotation would silently log the box out.
//
// 2026 API notes: playlist contents are GET /playlists/{id}/items (the old
// /tracks path is gone), and only for playlists the user owns/collaborates on.
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// Packaged Spotify Web API (Kodi-model app code — ships in the app package, not
// the core shell). `config` is the shell's config store, injected once by
// plugin.js via setConfig(host.config); we read rawSpotify() for the client
// id/secret. There is no core `./config` module in the package.
let config = { rawSpotify: () => null };
function setConfig(cfg) {
  if (cfg) config = cfg;
}

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTH_URL = "https://accounts.spotify.com/authorize";
const API = "https://api.spotify.com/v1";
const TOKEN_FILE = path.join(os.homedir(), ".tvbox", "spotify-token"); // legacy single refresh token (migrated)
const ACCOUNTS_FILE = path.join(os.homedir(), ".tvbox", "spotify-accounts.json"); // { active, list:[{id,name,token}] }, chmod 600
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "streaming", // lets librespot sign the box into this account with our access token (the "adopt" step)
].join(" ");

// Loopback redirect (the only http redirect Spotify allows). Must be registered
// verbatim in the app's dashboard. Port is the shell's single source of truth.
const REDIRECT_URI = "http://127.0.0.1:" + require("./constants").PORT + "/tvbox/api/spotify/auth/callback";

function creds() {
  const s = config.rawSpotify() || {};
  return { id: (s.clientId || "").trim(), secret: (s.clientSecret || "").trim() };
}
function configured() {
  const c = creds();
  return !!(c.id && c.secret);
}

// ---- accounts (multi-account) ----
// Several Spotify accounts can be linked (family boxes); each keeps its own
// refresh token and you switch between them without re-login. Shape on disk:
// { active: "<id>", list: [{ id, name, token }] }.
function loadAccounts() {
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    if (j && Array.isArray(j.list)) return { active: j.active || "", list: j.list };
  } catch (e) {
    /* none */
  }
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return { active: "legacy", list: [{ id: "legacy", name: "", token: t }] };
  } catch (e) {
    /* none */
  }
  return { active: "", list: [] };
}
function saveAccounts() {
  try {
    const dir = path.dirname(ACCOUNTS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(ACCOUNTS_FILE, 0o600); // enforce on every write (refresh tokens)
  } catch (e) {
    console.warn("[spotify-api] accounts persist failed:", e.message);
  }
}
let accounts = loadAccounts();
function activeAccount() {
  return accounts.list.find((x) => x.id === accounts.active) || accounts.list[0] || null;
}
function activeName() {
  const a = activeAccount();
  return (a && a.name) || "";
}
function connected() {
  return !!(configured() && activeAccount());
}
function listAccounts() {
  return accounts.list.map((x) => ({ id: x.id, name: x.name || "Spotify", active: x.id === accounts.active }));
}
function switchAccount(id) {
  if (!accounts.list.find((x) => x.id === id)) return false;
  accounts.active = id;
  saveAccounts();
  return true;
}
function removeAccount(id) {
  accounts.list = accounts.list.filter((x) => x.id !== id);
  if (accounts.active === id) accounts.active = (accounts.list[0] && accounts.list[0].id) || "";
  tokCache.delete(id);
  saveAccounts();
  if (!accounts.list.length) {
    try {
      fs.unlinkSync(TOKEN_FILE);
    } catch (e) {}
  }
}

// ---- http ----
function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers: headers || {} },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(12000, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}
function basicAuth() {
  const c = creds();
  return "Basic " + Buffer.from(`${c.id}:${c.secret}`).toString("base64");
}

// ---- OAuth ----
function authUrl(state) {
  const c = creds();
  const q = new URLSearchParams({
    client_id: c.id,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: state || "",
    show_dialog: "false",
  });
  return `${AUTH_URL}?${q}`;
}
async function exchangeCode(code) {
  if (!configured()) return { ok: false, error: "not configured" };
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString();
  const { status, body: resp } = await request(
    "POST",
    TOKEN_URL,
    { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  );
  if (status !== 200) return { ok: false, error: "HTTP " + status + " " + resp.slice(0, 120) };
  const j = JSON.parse(resp);
  const token = j.refresh_token || "";
  if (!token) return { ok: false, error: "no refresh token" };
  // Identify the account (so re-linking the same account updates, not duplicates).
  let id = "",
    name = "";
  try {
    const { status: ms, body: mb } = await request("GET", API + "/me", { Authorization: "Bearer " + j.access_token });
    if (ms === 200) {
      const me = JSON.parse(mb);
      id = me.id || "";
      name = me.display_name || me.id || "";
    }
  } catch (e) {
    /* fall back to a synthetic id */
  }
  if (!id) id = "acc-" + (accounts.list.length + 1);
  accounts.list = accounts.list.filter((x) => x.id !== id); // re-linking the same account updates it
  accounts.list.push({ id, name, token });
  accounts.active = id;
  saveAccounts();
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch (e) {} // legacy single-token migrated
  tokCache.set(id, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 });
  connectSeq++; // signals the connect UI that a new link succeeded (even if already connected)
  return { ok: true };
}
let connectSeq = 0;
function disconnect() {
  const a = activeAccount();
  if (a) removeAccount(a.id);
}

// ---- token ----
// Per-account access-token cache (keyed by account id) so we can call the API as
// ANY linked account, not just the active one — the play path picks whichever
// account currently owns the box device. One cache per id also means concurrent
// refreshes of the same account share a rotation instead of racing it.
const tokCache = new Map(); // accId -> { token, exp }
const tokInflight = new Map(); // accId -> Promise — SERIALIZES refreshes per account.
// Spotify ROTATES refresh tokens on every refresh: two concurrent refreshes with
// the same (old) token make the second one 400 -> the account got dropped as
// "revoked". Cold start fires several API calls at once (status + playlists +
// play), so this race was real — all callers must share one in-flight refresh.
function tokenFor(acc) {
  if (!configured() || !acc) return Promise.reject(new Error("not connected"));
  const c = tokCache.get(acc.id);
  if (c && Date.now() < c.exp) return Promise.resolve(c.token);
  let p = tokInflight.get(acc.id);
  if (!p) {
    p = refreshToken(acc).finally(() => tokInflight.delete(acc.id));
    tokInflight.set(acc.id, p);
  }
  return p;
}
async function refreshToken(acc) {
  const cr = creds();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: acc.token,
    client_id: cr.id,
  }).toString();
  const { status, body: resp } = await request(
    "POST",
    TOKEN_URL,
    { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  );
  if (status !== 200) {
    if (status === 400 || status === 401) {
      removeAccount(acc.id);
    } // revoked -> drop this account
    throw new Error("refresh HTTP " + status);
  }
  const j = JSON.parse(resp);
  if (j.refresh_token && j.refresh_token !== acc.token) {
    acc.token = j.refresh_token;
    saveAccounts();
  } // rotation
  tokCache.set(acc.id, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 });
  return j.access_token;
}
async function apiGet(acc, p) {
  const token = await tokenFor(acc);
  const { status, body } = await request("GET", API + p, { Authorization: "Bearer " + token });
  if (status === 204 || !body) return {};
  if (status >= 400) throw new Error("HTTP " + status + " " + body.slice(0, 120));
  return JSON.parse(body);
}
async function apiWrite(acc, method, p, payload) {
  const token = await tokenFor(acc);
  const headers = { Authorization: "Bearer " + token };
  let body = null;
  if (payload !== undefined) {
    body = JSON.stringify(payload);
    headers["Content-Type"] = "application/json";
  } else headers["Content-Length"] = "0";
  const { status, body: resp } = await request(method, API + p, headers, body);
  return { ok: status >= 200 && status < 300, status, body: resp };
}
// Active-account convenience wrappers (browse/search/status stay on the active one).
function userGet(p) {
  return apiGet(activeAccount(), p);
}
function userWrite(method, p, payload) {
  return apiWrite(activeAccount(), method, p, payload);
}

// ---- status ----
async function status() {
  const out = {
    configured: configured(),
    connected: connected(),
    user: activeName(),
    accounts: listAccounts(),
    connectSeq,
  };
  if (out.connected) {
    const acc = activeAccount();
    const placeholder = !!acc && (acc.id === "legacy" || acc.id.indexOf("acc-") === 0); // synthetic id -> resolve real id
    if (acc && (!acc.name || placeholder)) {
      try {
        const me = await userGet("/me");
        const realId = me.id || acc.id;
        if (placeholder && realId !== acc.id) {
          accounts.list = accounts.list.filter((x) => x === acc || x.id !== realId); // drop any duplicate of the real id
          if (accounts.active === acc.id) accounts.active = realId;
          acc.id = realId;
        }
        if (me.display_name || me.id) acc.name = me.display_name || me.id;
        saveAccounts();
      } catch (e) {
        out.connected = connected();
      } // a failed refresh may have dropped the account
      out.user = activeName();
      out.accounts = listAccounts();
    }
  }
  return out;
}

// ---- library ----
function trackOf(t) {
  if (!t) return null;
  return {
    uri: t.uri || "",
    name: t.name || "",
    artists: (t.artists || [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(", "),
    album: (t.album || {}).name || "",
    duration_ms: t.duration_ms || 0,
    image_url: ((t.album || {}).images || []).slice(-2)[0]?.url || ((t.album || {}).images || [])[0]?.url || "",
  };
}
async function getLiked(limit) {
  const out = [];
  let offset = 0;
  const cap = limit || 200;
  while (out.length < cap) {
    const d = await userGet(`/me/tracks?limit=50&offset=${offset}`);
    const items = d.items || [];
    if (!items.length) break;
    for (const it of items) {
      const t = trackOf(it.track);
      if (t && t.uri) out.push(t);
    }
    offset += items.length;
    if (offset >= (d.total || offset)) break;
  }
  return out;
}
async function getPlaylists() {
  const out = [];
  let offset = 0;
  const meId = (activeAccount() || {}).id || "";
  for (;;) {
    const d = await userGet(`/me/playlists?limit=50&offset=${offset}`);
    const items = d.items || [];
    if (!items.length) break;
    for (const p of items) {
      if (!p || !p.id) continue;
      const owner = p.owner || {};
      out.push({
        id: p.id,
        uri: p.uri || "",
        name: p.name || "",
        owner: owner.display_name || "",
        // own = we can browse its items (2026: owner or collaborator only). Match by
        // owner id (stable) with a display-name fallback; collaborative counts too.
        is_own: !!(
          (meId && owner.id === meId) ||
          (activeName() && owner.display_name === activeName()) ||
          p.collaborative
        ),
        // 2026: the per-playlist count moved from `tracks` to `items`.
        tracks_total: (p.items || p.tracks || {}).total ?? null,
        image_url: (p.images || [])[0]?.url || "",
      });
    }
    offset += items.length;
    if (offset >= (d.total || offset)) break;
  }
  return out;
}
// 2026: GET /playlists/{id}/items (was /tracks). Owned/collaborated only; others
// come back empty. The track is under items[].item (was items[].track).
async function getPlaylistItems(id) {
  const out = [];
  let offset = 0;
  const fields = "total,items(item(uri,name,duration_ms,artists(name),album(name,images)))";
  for (;;) {
    const d = await userGet(`/playlists/${id}/items?limit=50&offset=${offset}&fields=${encodeURIComponent(fields)}`);
    const items = d.items || [];
    if (!items.length) break;
    for (const it of items) {
      const t = trackOf(it.item);
      if (t && t.uri) out.push(t);
    }
    offset += items.length;
    if (offset >= (d.total || offset)) break;
  }
  return out;
}
async function search(q) {
  if (!q) return { tracks: [], playlists: [] };
  const d = await userGet(`/search?q=${encodeURIComponent(q)}&type=track,playlist&limit=10`);
  const tracks = ((d.tracks || {}).items || []).map(trackOf).filter((t) => t && t.uri);
  const playlists = ((d.playlists || {}).items || []).filter(Boolean).map((p) => ({
    id: p.id,
    uri: p.uri || "",
    name: p.name || "",
    owner: (p.owner || {}).display_name || "",
    is_own: false,
    tracks_total: (p.tracks || {}).total ?? null,
    image_url: (p.images || [])[0]?.url || "",
  }));
  return { tracks, playlists };
}

// ---- playback (start on THIS box) ----
const spotifyBridge = require("./spotify");
// The box's Connect device id within a SPECIFIC account's device list (matched by
// the librespot --name), or "" if that account can't see the box. Case/space
// tolerant so a stray rename doesn't silently break targeting.
async function boxDeviceOn(acc) {
  const d = await apiGet(acc, "/me/player/devices");
  const want = spotifyBridge.deviceName().trim().toLowerCase();
  const dev = (d.devices || []).find(
    (x) =>
      x &&
      String(x.name || "")
        .trim()
        .toLowerCase() === want,
  );
  return dev ? dev.id : "";
}
// Which linked account currently sees the box in its device list (preferring the
// active one), or null. The box (librespot) follows whoever last held its session.
async function findBoxAccount() {
  const ordered = [activeAccount(), ...accounts.list.filter((a) => a && a.id !== accounts.active)].filter(Boolean);
  for (const a of ordered) {
    try {
      const id = await boxDeviceOn(a);
      if (id) return { account: a, devId: id };
    } catch (e) {
      /* try next account */
    }
  }
  return null;
}
// A fresh access token for the ACTIVE account (for handing the box's librespot
// this account's session — the play path's "adopt" step in the Spotify plugin).
function activeAccessToken() {
  return tokenFor(activeAccount());
}
// Play a playlist (context_uri) or track uris ON THE BOX. Find whichever
// connected account currently owns the box device and play there; then switch
// active to it so the transport controls target the same session. If no linked
// account can see the box, report it — the caller (plugin) may then adopt the
// box into the active account and retry.
async function play({ contextUri, uris }) {
  if (!connected()) return { ok: false, error: "not connected" };
  const payload = contextUri ? { context_uri: contextUri } : { uris: uris || [] };
  const found = await findBoxAccount();
  if (!found) return { ok: false, error: "box_not_found" };
  const { account: target, devId } = found;
  const q = `?device_id=${devId}`;
  let r = await apiWrite(target, "PUT", "/me/player/play" + q, payload);
  if (!r.ok && r.status === 404) {
    // device idle — wake it by transferring playback there, then retry once
    try {
      await apiWrite(target, "PUT", "/me/player", { device_ids: [devId], play: false });
    } catch (e) {}
    r = await apiWrite(target, "PUT", "/me/player/play" + q, payload);
  }
  if (r.ok && target.id !== accounts.active) {
    accounts.active = target.id;
    saveAccounts();
  } // controls follow the playing account
  return { ok: r.ok, error: r.ok ? "" : "HTTP " + r.status + " " + (r.body || "").slice(0, 80) };
}

// Transport controls for the box (the connected account controls /me/player; the
// box became the active device when we started playback there). playpause checks
// the live player so one button works for both states.
async function control(action) {
  if (!connected()) return { ok: false, error: "not connected" };
  if (action === "playpause") {
    let playing = false;
    try {
      const p = await userGet("/me/player");
      playing = !!(p && p.is_playing);
    } catch (e) {}
    action = playing ? "pause" : "play";
  }
  const routes = {
    play: ["PUT", "/me/player/play"],
    pause: ["PUT", "/me/player/pause"],
    next: ["POST", "/me/player/next"],
    prev: ["POST", "/me/player/previous"],
  };
  const r = routes[action];
  if (!r) return { ok: false, error: "bad action" };
  const res = await userWrite(r[0], r[1]);
  return { ok: res.ok, error: res.ok ? "" : "HTTP " + res.status };
}

// ---- artist image (now-playing background) ----
// librespot's cast metadata only gives the ALBUM cover; the launcher background
// prefers the primary artist's photo (like the old rpi-client). Resolve
// track -> primary artist -> image, cached per artist id. Public catalog data,
// so any connected account works; empty when not connected or not found.
const artistImgCache = new Map(); // artistId -> url ("" = looked up, none)
async function artistImageForTrack(trackId) {
  if (!connected() || !trackId) return "";
  let track;
  try {
    track = await userGet("/tracks/" + encodeURIComponent(trackId));
  } catch (e) {
    return "";
  }
  const artistId = ((track.artists || [])[0] || {}).id || "";
  if (!artistId) return "";
  if (artistImgCache.has(artistId)) return artistImgCache.get(artistId);
  let url = "";
  try {
    const a = await userGet("/artists/" + encodeURIComponent(artistId));
    url = ((a.images || [])[0] || {}).url || "";
  } catch (e) {
    url = "";
  }
  artistImgCache.set(artistId, url);
  return url;
}

module.exports = {
  setConfig,
  REDIRECT_URI,
  configured,
  connected,
  authUrl,
  exchangeCode,
  disconnect,
  status,
  getLiked,
  getPlaylists,
  getPlaylistItems,
  search,
  play,
  control,
  artistImageForTrack,
  listAccounts,
  switchAccount,
  removeAccount,
  findBoxAccount,
  activeAccessToken,
};

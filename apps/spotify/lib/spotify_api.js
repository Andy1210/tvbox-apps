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
  // Asked for because a Spotify app that controls playback is expected to hold
  // it. It does NOT let librespot sign the box in with our token: login5 refuses
  // a third-party client at Connect registration with this scope present, and
  // with `app-remote-control` too - measured. The box signs itself in from its
  // own saved login instead.
  "streaming",
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
// Written whole, then renamed over the old one: this file is the only copy of
// every linked account's refresh token, and it is now written on a handover as
// well as on a link. A power cut during a plain overwrite leaves a truncated file
// and the box has no accounts at all; a rename either happened or did not.
function saveAccounts() {
  const tmp = ACCOUNTS_FILE + ".tmp";
  try {
    const dir = path.dirname(ACCOUNTS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    // fsync before the rename, the same shape the box uses for the boot partition:
    // the rename can otherwise reach the disk before the bytes it points at, and
    // the file that survives a power cut is then empty - which here means the box
    // has no linked accounts at all.
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(accounts));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600); // enforce regardless of umask (refresh tokens)
    fs.renameSync(tmp, ACCOUNTS_FILE);
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (e2) {
      /* nothing left to clean up */
    }
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
  dropCaches(id); // its library must not outlive the account it belongs to
  saveAccounts();
  if (!accounts.list.length) {
    try {
      fs.unlinkSync(TOKEN_FILE);
    } catch (e) {}
  }
}

// ---- http ----
// One pool of kept-alive connections for every call in this file. A library is
// read a page at a time, so without this each page paid its own TLS handshake to
// api.spotify.com, and on a large playlist those handshakes were most of the wait
// before anything could be drawn. maxSockets bounds it to the paging concurrency.
// `timeout` retires an idle pooled socket rather than handing out one the far end
// has already closed: reusing that fails the request with ECONNRESET, and a page
// that fails fails the whole read (see pagedAll).
const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8, timeout: 20000 });

function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers: headers || {}, agent },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers || {} }));
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
// Pages now go out several at a time (pagedAll below), which meets Spotify's rate
// limit more readily than one at a time did - and 429 is the one status where the
// server says exactly how long to wait. A long Retry-After is NOT slept through:
// the caller is a screen waiting to draw, so a wait that long is reported as the
// error it is instead of looking like a hang.
const RETRY_MAX = 2;
const RETRY_MAX_WAIT_S = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(acc, p) {
  for (let attempt = 0; ; attempt++) {
    const token = await tokenFor(acc);
    let status, body, headers;
    try {
      ({ status, body, headers } = await request("GET", API + p, { Authorization: "Bearer " + token }));
    } catch (e) {
      // A pooled connection the far end has already closed fails here rather than
      // answering, and a page that fails fails the whole read (see pagedAll). One
      // retry costs a request and turns that into nothing at all.
      if (attempt < RETRY_MAX && /ECONNRESET|socket hang up|EPIPE/i.test(String(e.message || e))) continue;
      throw e;
    }
    if (status === 429 && attempt < RETRY_MAX) {
      const after = Number((headers || {})["retry-after"]) || 1;
      if (after <= RETRY_MAX_WAIT_S) {
        await sleep(after * 1000);
        continue;
      }
    }
    // The error check comes FIRST. An error response is not required to carry a
    // body, and reading "no body" as "no content" turns a refused request into an
    // empty answer: a rate-limited page would read as a page with nothing on it,
    // and a paged read would come back short while reporting success.
    if (status >= 400) throw new Error("HTTP " + status + (body ? " " + body.slice(0, 120) : ""));
    if (status === 204 || !body) return {};
    return JSON.parse(body);
  }
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
// Browsing, searching and the account's own identity are questions ABOUT the
// active account, so they read as it. Anything that acts on the box says which
// account to act as instead, because the box is not always the active one's.
function userGet(p) {
  return apiGet(activeAccount(), p);
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
// ---- paging ----
// Read every page of a paged collection. The first page carries `total`, so the
// rest go out CONCURRENTLY: sequential paging costs one round trip to
// api.spotify.com per 50 items, so a thousand-track playlist cannot be drawn
// until twenty of them have completed one after another.
//
// A page that fails fails the whole read, deliberately. The alternative is a list
// that is silently short - and a list the user cannot tell is short is worse than
// an error they can retry.
//
// Each page is returned WITH the offset it was asked for, because a row's index in
// the assembled list is not its position in the playlist: an entry Spotify cannot
// resolve to a track (a removed or region-blocked one) is dropped here but still
// occupies a position there, and `offset.position` is what playback is told.
const PAGE = 50;
const PAGE_CONCURRENCY = 6;
// A bound rather than a limit anyone should hit: it exists so a pathological
// account cannot page forever. When it bites, `truncated` says so, because a list
// that just ends cannot be told from a shorter library.
const MAX_ITEMS = 10000;

async function pagedAll(acc, pathFor, itemsOf) {
  const first = await apiGet(acc, pathFor(0, PAGE));
  const firstItems = itemsOf(first) || [];
  const reported = Number(first.total);
  const known = Number.isFinite(reported) && reported >= 0;

  // Without a `total` there is nothing to fan out over, and assuming the first
  // page is the whole collection would truncate it silently. A full page means
  // there is more, so read on one at a time until a short one ends it.
  //
  // `truncated` is reported rather than worked out from the total afterwards.
  // Here the two are not the same thing: the loop stops AT the bound, so the
  // total it returns is exactly MAX_ITEMS, and a caller comparing the two would
  // conclude nothing was cut - which is the silent short list this whole function
  // is written to avoid.
  if (!known) {
    const pages = [{ offset: 0, items: firstItems }];
    let offset = firstItems.length;
    let full = firstItems.length === PAGE; // a full page means there is more after it
    while (full && offset < MAX_ITEMS) {
      const items = itemsOf(await apiGet(acc, pathFor(offset, PAGE))) || [];
      pages.push({ offset, items });
      offset += items.length;
      full = items.length === PAGE;
    }
    return { pages, total: offset, truncated: full };
  }

  const total = Math.min(reported, MAX_ITEMS);
  const offsets = [];
  for (let o = firstItems.length; o < total; o += PAGE) offsets.push(o);
  // Each worker writes its own slot, so the pages end up in list order however
  // the requests interleave. `failed` stops the others as soon as one page is
  // lost: the read is finished either way, and the usual reason a page fails is
  // a rate limit that the remaining requests would only feed.
  const slots = new Array(offsets.length).fill(null);
  let next = 0;
  let failed = false;
  const worker = async () => {
    for (;;) {
      const k = next++;
      if (k >= offsets.length || failed) return;
      try {
        slots[k] = { offset: offsets[k], items: itemsOf(await apiGet(acc, pathFor(offsets[k], PAGE))) || [] };
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, offsets.length) }, worker));
  const pages = [{ offset: 0, items: firstItems }, ...slots.map((s) => s || { offset: 0, items: [] })];
  // Every window is worked out before the first one is asked for, so a page that
  // comes back shorter than it was asked for leaves entries that nobody requests.
  // Positions survive that (each row's comes from the offset it was read at), but
  // the list does not, and a list that cannot be told is short is the thing this
  // whole function is written to avoid. So compare what arrived against what was
  // promised, and say when they differ.
  const collected = pages.reduce((n, p) => n + p.items.length, 0);
  return { pages, total: reported, truncated: reported > MAX_ITEMS || collected < total };
}

// Flatten paged results into tracks, each carrying `pos`, its true position in the
// collection. `pick` pulls the track object out of one entry (the key differs per
// endpoint: `track` for Liked Songs, `item` for a playlist).
function tracksWithPositions(pages, pick) {
  const tracks = [];
  for (const page of pages) {
    page.items.forEach((entry, k) => {
      const t = trackOf(pick(entry));
      if (t && t.uri) tracks.push({ ...t, pos: page.offset + k });
    });
  }
  return tracks;
}

// ---- caches ----
// Keyed by ACCOUNT as well as by id: playlist ids are global but access is not,
// and Liked Songs is per-account outright, so a cache shared across a family
// box's linked accounts would answer with the wrong person's library.
const listCache = new Map(); // "<accId>|<kind>|<id>" -> { at, snapshot, value }
const LIST_TTL_MS = 300000; // how long a list is served without asking Spotify at all
const PLAYLIST_FRESH_MS = 60000; // ... and how long before even the snapshot check is skipped
// The ceiling on serving a playlist whose snapshot check keeps failing. Without
// it, a check that never succeeds means an entry that is never re-read: the
// playlist can be edited, or deleted, and the box would go on showing what it
// last saw for as long as it is up.
const PLAYLIST_MAX_AGE_MS = 1800000;
// A cap, because these entries are whole track arrays (up to MAX_ITEMS each) held
// in the shell's main process for as long as the box is up, and a snapshot match
// refreshes an entry's age rather than expiring it. Map iterates in insertion
// order, so the oldest key is the first one.
const LIST_CACHE_MAX = 24;

function cacheKey(acc, kind, id) {
  return ((acc && acc.id) || "") + "|" + kind + "|" + (id || "");
}
function cacheStore(key, entry) {
  // A read that was already running when its account was removed would otherwise
  // put that account's library back after dropCaches had cleared it, and it would
  // sit there until eviction. The key carries the account, so the check is here
  // rather than at every call site.
  const accId = key.split("|")[0];
  if (accId && !accounts.list.some((x) => x.id === accId)) return;
  listCache.delete(key); // re-insert, so a refreshed entry counts as the newest
  listCache.set(key, entry);
  while (listCache.size > LIST_CACHE_MAX) listCache.delete(listCache.keys().next().value);
}
function dropCaches(accId) {
  if (!accId) {
    marketCache.clear();
    return listCache.clear();
  }
  marketCache.delete(accId);
  for (const k of [...listCache.keys()]) if (k.startsWith(accId + "|")) listCache.delete(k);
}

// One paging run per collection, however many screens ask at once. Without this,
// N concurrent requests for the same playlist each start their own run - and each
// run is up to 200 requests against the same rate limit.
const inflight = new Map(); // cache key -> Promise
function once(key, run) {
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// The whole library, not a first slice of it: the length is no longer what costs,
// because the UI mounts a window of rows rather than all of them.
async function getLiked() {
  const acc = activeAccount();
  const key = cacheKey(acc, "liked", "");
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
  return once(key, async () => {
    const { pages, total, truncated } = await pagedAll(
      acc,
      (o, l) => `/me/tracks?limit=${l}&offset=${o}`,
      (d) => d.items,
    );
    const value = { tracks: tracksWithPositions(pages, (e) => e && e.track), total, truncated };
    cacheStore(key, { at: Date.now(), value });
    return value;
  });
}
async function getPlaylists() {
  const acc = activeAccount();
  const key = cacheKey(acc, "playlists", "");
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
  return once(key, () => readPlaylists(acc, key));
}
async function readPlaylists(acc, key) {
  const out = [];
  const meId = (acc || {}).id || "";
  const { pages } = await pagedAll(
    acc,
    (o, l) => `/me/playlists?limit=${l}&offset=${o}`,
    (d) => d.items,
  );
  for (const page of pages) {
    for (const p of page.items) {
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
  }
  cacheStore(key, { at: Date.now(), value: out });
  return out;
}
// 2026: GET /playlists/{id}/items (was /tracks). Owned/collaborated only; others
// come back empty. The track is under items[].item (was items[].track).
//
// `snapshot_id` is what makes re-entering a playlist free: it changes whenever the
// playlist is edited, so one small request decides whether the pages we already
// have are still the playlist - instead of paging the whole thing again to find
// out that nothing changed.
const PL_FIELDS = "total,items(item(uri,name,duration_ms,artists(name),album(name,images)))";
async function getPlaylistItems(id) {
  const acc = activeAccount();
  const pid = encodeURIComponent(String(id || ""));
  const key = cacheKey(acc, "playlist", pid);
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < PLAYLIST_FRESH_MS) return hit.value;
  return once(key, async () => {
    let snapshot = "";
    let snapshotFailed = false;
    try {
      snapshot = String((await apiGet(acc, `/playlists/${pid}?fields=snapshot_id`)).snapshot_id || "");
    } catch (e) {
      snapshotFailed = true;
    }
    // A cheap check that failed must not escalate into the expensive read. That
    // is a feedback loop: the check fails when the account is being rate-limited,
    // and re-paging the whole playlist is what produces more of it. What we have
    // is served instead, up to PLAYLIST_MAX_AGE_MS, and its age is NOT reset -
    // otherwise a check that always fails would keep the entry young forever and
    // it could never be re-read or evicted.
    //
    // An empty snapshot is not a match either: two reads that both failed to
    // learn one would agree with each other and pin the entry the same way.
    if (hit) {
      if (snapshot && snapshot === hit.snapshot) {
        cacheStore(key, { ...hit, at: Date.now() }); // confirmed current, so it is the newest
        return hit.value;
      }
      if (snapshotFailed && Date.now() - hit.at < PLAYLIST_MAX_AGE_MS) return hit.value;
    }
    const { pages, total, truncated } = await pagedAll(
      acc,
      (o, l) => `/playlists/${pid}/items?limit=${l}&offset=${o}&fields=${encodeURIComponent(PL_FIELDS)}`,
      (d) => d.items,
    );
    const value = { tracks: tracksWithPositions(pages, (e) => e && e.item), total, truncated };
    cacheStore(key, { at: Date.now(), snapshot, value });
    return value;
  });
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
// active one). The box (librespot) follows whoever last held its session.
//
// `complete` is the second answer and it is not cosmetic: "every account said no"
// and "we could not ask" look identical from an empty result, and they call for
// opposite things. The first is a box with no Connect registration, which the
// plugin fixes by restarting the daemon; the second is a listing that failed (an
// outage, a 429, a refresh that did not come back) behind which the box may be
// perfectly fine and playing, and restarting there takes the music off somebody
// for a reason that was never established. Carried in the result rather than kept
// as module state because a sweep is a chain of awaits and the /player poll runs
// one of its own every twenty seconds.
async function findBoxAccount() {
  const ordered = [activeAccount(), ...accounts.list.filter((a) => a && a.id !== accounts.active)].filter(Boolean);
  let complete = ordered.length > 0; // no linked account at all is not a completed sweep
  let answered = false; // …and `answered` is the weaker question: did ANY of them reply?
  for (const a of ordered) {
    try {
      const id = await boxDeviceOn(a);
      answered = true;
      if (id) return { account: a, devId: id, complete: true, answered: true };
    } catch (e) {
      complete = false; // this account never answered, so its silence means nothing
    }
  }
  return { account: null, devId: "", complete, answered };
}

// The box's device id within one account's list, cached: a transport press must
// not cost a device listing of its own, and the answer only changes when the box
// changes hands, is renamed, or its daemon is restarted — all of which call
// forgetBoxDevice. The TTL is the bound on anything that does neither, a crash
// respawn included (that one goes through the supervisor, not through us).
//
// A MISS is never cached. It means the box is not in that account's list right
// now, which is exactly what a respawning librespot looks like for a second or
// two — and caching it would answer the press somebody makes immediately
// afterwards out of memory, for half a minute.
const BOX_DEV_TTL_MS = 30000;
let boxDev = { key: "", id: "", at: 0 };
function boxDevKey(acc) {
  return acc.id + "\n" + spotifyBridge.deviceName();
}
function rememberBoxDevice(acc, id) {
  if (acc && id) boxDev = { key: boxDevKey(acc), id, at: Date.now() };
}
async function boxDeviceIdFor(acc) {
  if (!acc) return "";
  const key = boxDevKey(acc);
  if (boxDev.key === key && boxDev.id && Date.now() - boxDev.at < BOX_DEV_TTL_MS) return boxDev.id;
  const id = await boxDeviceOn(acc);
  rememberBoxDevice(acc, id);
  return id;
}
// Drop the cached id. librespot derives it from the device NAME (verified: it is
// sha1 of that name, so it survives a restart, a reboot and a credential change
// and moves only on a rename, which boxDevKey already keys on) - so this is not
// about the id going out of date. It is about the DEVICE: a daemon that has gone
// leaves an id Spotify still accepts and silently does nothing with.
function forgetBoxDevice() {
  boxDev = { key: "", id: "", at: 0 };
}
// Who the launcher is browsing, for a caller outside this module. Id and name
// only: the account row also carries the refresh token, which is the one thing in
// this file that must not travel.
function activeAccountInfo() {
  const a = activeAccount();
  return a ? { id: a.id, name: a.name || "" } : null;
}
// Can THIS account see the box right now? The question a sign-in has to poll,
// and it must be asked of one named account rather than of the fleet: coming back
// under a different account is precisely the failure being waited out. Never
// throws - a listing that did not answer is not a box that is absent, but for a
// poll they are the same "not yet".
async function boxSeenBy(accId) {
  const acc = accounts.list.find((x) => x.id === accId);
  if (!acc) return false;
  try {
    return !!(await boxDeviceIdFor(acc));
  } catch (e) {
    return false;
  }
}

// Who the box is playing as. Every command about the box is sent as this account
// and addressed to this device id; nothing else may stand in for either.
//
// Two sources, and the second is not a legacy path — it is what answers most of
// the time:
//   1. librespot's session user. Exact and free, but librespot 0.8 names it only
//      when the box is ACTIVATED (see spotify.js), so an idle box has no owner
//      here even though it is signed into one.
//   2. the device lists — whoever can see the box is signed into it.
//
// The named owner is CHECKED rather than trusted: if that account cannot address
// the box, the sweep decides. Three states this code produces itself would
// otherwise report a stranger holding the box — a synthetic or "legacy" account
// id that matches no session user, an account dropped mid-flight by a failed
// refresh, and a name left over from a daemon that has since restarted.
//
// `state` is the whole answer, because the four cases need four different things
// done about them:
//   ours         a linked account holds the box; account + devId are set
//   unreachable  a linked account holds it, but we could not address the device.
//                Transient, and NOT permission to take the box off them
//   other        an account this box has not linked holds it: nothing we send
//                can reach that playback
//   none         nobody we know holds it; the box is free
// `needDevice` is what a READ can do without: a question about the box needs only
// the account to ask as, and with the session user known that costs no request.
async function boxOwner(needDevice) {
  const user = spotifyBridge.sessionUser();
  const named = user ? accounts.list.find((x) => x.id === user) : null;
  // Whether the NAMED owner's own listing answered, as opposed to throwing. It is
  // the strongest evidence there is about the box: that account is the one
  // librespot says holds it, so an empty answer from it means the registration is
  // gone whatever another linked account's listing did. Without this, a 429 on an
  // unrelated family account made the whole recovery unreachable - and /player
  // sweeps every account every twenty seconds, so meeting one is routine.
  let namedAnswered = false;
  if (named) {
    if (!needDevice) return { state: "ours", account: named, devId: "", swept: false };
    let devId = "";
    try {
      devId = await boxDeviceIdFor(named);
      namedAnswered = true;
    } catch (e) {
      devId = "";
    }
    if (devId) return { state: "ours", account: named, devId, swept: true };
  }
  // Nobody named, but a recent read already paid for a listing. Without this the
  // sweep below runs on every /player poll — one listing per linked account,
  // every twenty seconds, on the path the comment above calls the common one.
  //
  // Reads only. A handover whose event was lost (the hook swallows a failed post)
  // leaves this pointing at the previous account for up to the TTL, and a
  // COMMAND sent there goes out as an account that no longer holds the box —
  // which Spotify accepts and quietly does nothing with, i.e. a button that
  // reports success.
  // A press is a human-paced event and can afford to ask.
  const cached = !named && !needDevice && cachedBoxOwner();
  if (cached) return { ...cached, swept: true };
  let found = { account: null, devId: "", complete: false };
  try {
    found = await findBoxAccount();
  } catch (e) {
    found = { account: null, devId: "", complete: false };
  }
  if (found.account) {
    rememberBoxDevice(found.account, found.devId); // paid for once, not again next press
    return { state: "ours", account: found.account, devId: found.devId, swept: true };
  }
  // `swept` says the empty answer was actually established, and EVERY shape below
  // carries it: a caller that acts on "the box is not addressable" needs it,
  // because the alternative - nobody answered - is not a fact about the box at
  // all. Set on all of them rather than only where it is read, so that which
  // refusal wins never depends on the order the states are checked in.
  const swept = !!found.complete;
  if (named) return { state: "unreachable", account: named, devId: "", swept: swept || namedAnswered };
  // A name we cannot use only means "somebody else is on the box" while their
  // session is UP. A guest who cast once and went home leaves their name behind,
  // and reading that as an owner refused every press and every play from the TV
  // until the daemon was restarted — the recovery included, since that is gated
  // on the box being free.
  if (user && spotifyBridge.sessionActive()) return { state: "other", account: null, devId: "", swept };
  return { state: "none", account: null, devId: "", swept };
}
// The device cache read back as an owner: same TTL, same key, and the account has
// to still be linked - removing an account must not leave the box addressed as it.
function cachedBoxOwner() {
  if (!boxDev.id || Date.now() - boxDev.at >= BOX_DEV_TTL_MS) return null;
  const [accId, name] = boxDev.key.split("\n");
  if (name !== spotifyBridge.deviceName()) return null;
  const acc = accounts.list.find((x) => x.id === accId);
  return acc ? { state: "ours", account: acc, devId: boxDev.id } : null;
}

// Follow the box: the account holding its session is the one whose library the
// TV should be showing, and whose player its buttons reach. This is what a cast
// from a phone changes, and until it did, a second linked account could take the
// box over and leave the screen browsing — and commanding — the first one.
//
// The window covers the activation a play of OURS causes: both autoplay's
// continuations and a row somebody pressed on this screen activate the box, and
// neither is a phone claiming it. An activation outside the window reads as
// somebody having chosen this room, which is the case this exists to follow.
//
// In two phases, because the window has to be armed before it can be aimed. A play
// arms it with no account named, which suppresses ANY activation - the target is
// not known until the device lookup comes back, and the activation can arrive
// before that: it is one local POST against the play's two round trips. Once the
// target IS known the window narrows to that one account, so a real cast by
// another account inside it is still followed. Swallowing those left the library,
// the name beside the gear and the transport buttons pointing at the wrong
// account, and the next press then took the box off the person who had just cast.
const FOLLOW_SUPPRESS_MS = 30000;
let suppressFollowUntil = 0;
let suppressFollowFor = "";
function armFollowSuppression(accId) {
  suppressFollowUntil = Date.now() + FOLLOW_SUPPRESS_MS;
  suppressFollowFor = accId || "";
}
function disarmFollowSuppression() {
  suppressFollowUntil = 0;
  suppressFollowFor = "";
}
function switchActiveTo(id) {
  if (Date.now() < suppressFollowUntil && (!suppressFollowFor || id === suppressFollowFor)) return false;
  if (!id || id === accounts.active) return false;
  if (!accounts.list.find((x) => x.id === id)) return false;
  accounts.active = id;
  saveAccounts();
  return true;
}
// The box changed hands (librespot signed into a different account, or out of
// one): where it was is no longer where it is.
function boxSignedInAs(userId) {
  forgetBoxDevice();
  return switchActiveTo(userId);
}
// The same thing without being told who. librespot does not always name the
// account: measured on a box logging in from its cached credentials, no
// session_connected arrived at all, and the launcher stayed on the other account
// with a box that was not its. Music starting is the other moment worth asking
// at, and the device lists answer it.
async function followBox() {
  // The CHECKED path, unlike the reads: this runs when music started, which is
  // exactly the moment the owner may have changed, and the whole reason it exists
  // is that the event announcing that can go missing. Believing a session user
  // here without asking the device lists would keep the launcher on the account
  // that held the box before the cast this is reacting to.
  const owner = await boxOwner(true);
  return !!(owner.account && switchActiveTo(owner.account.id));
}
// What THE BOX is doing, which is a different question from what the active
// account's player is doing, and the only one autoplay may act on.
//
// librespot is signed into one account at a time, so the box appears in exactly
// that account's device list - which is what findBoxAccount resolves. Asking the
// ACTIVE account instead reads a different player: on a box with two accounts
// linked, a cast running under one of them is invisible to the other, and
// "nothing is playing" would then be permission to start music over it.
//
// `ok` false means we could not find out. `box` false means no linked account is
// driving this box, in which case a continuation could not be played there
// either, so the two answers stay consistent.
async function boxPlayerState() {
  const unknown = { ok: false, box: false, is_playing: false };
  if (!connected()) return { ...unknown, ok: true };
  let found;
  try {
    found = await boxOwner(false); // a read: the account is enough
  } catch (e) {
    return { ...unknown, error: String(e.message || e) };
  }
  // "Somebody we have not linked is driving it" and "nobody we know holds it"
  // mean the same thing here: nothing we could start would reach this box, so
  // there is nothing to continue.
  if (!found.account) return { ok: true, box: false, is_playing: false };
  try {
    const p = await apiGet(found.account, "/me/player");
    const device = ((p && p.device) || {}).name || "";
    const want = spotifyBridge.deviceName().trim().toLowerCase();
    return {
      ok: true,
      box: device.trim().toLowerCase() === want,
      is_playing: !!(p && p.is_playing),
      device,
      // Whose box this is, so a continuation is chosen for the country that will
      // actually play it rather than for whoever happens to be the active account.
      accountId: found.account.id,
    };
  } catch (e) {
    return { ...unknown, error: String(e.message || e) };
  }
}

// Play a playlist (context_uri) or track uris ON THE BOX. Find whichever
// connected account currently owns the box device and play there. If no linked
// account can see the box, report which of the two it is — the caller (plugin)
// signs the daemon back in from its saved login and retries.
//
// What this does NOT do is move the launcher onto the account it played as. The
// active account is whose library the TV is showing, and it is a choice somebody
// made on this screen; a play they started from it must not take it off them. It
// follows a CAST instead (boxSignedInAs / followBox), which is somebody claiming
// the box from a phone - and a play arms the same suppression autoplay uses, so
// the activation this play itself causes does not read as one.
// Spotify refuses a very large `uris` array, and a flat copy of a playlist is not
// the playlist anyway: `next` runs off the end of the copy, and shuffle and repeat
// only ever see the tracks that were copied. So anything with a context of its own
// plays as `context_uri` + `offset`, and `uris` is what is left for a selection
// that has no context.
const URIS_MAX = 100;

// Liked Songs does have a context, but an undocumented one, so the caller sends
// the track uris as well and we fall back to them if it is refused.
function collectionUri(acc) {
  const id = (acc && acc.id) || "";
  return id && id !== "legacy" && id.indexOf("acc-") !== 0 ? `spotify:user:${id}:collection` : "";
}

async function play({ contextUri, uris, offset, collection }) {
  if (!connected()) return { ok: false, error: "not connected" };
  // Armed BEFORE the request, not after it. Starting playback activates the box,
  // and the activation event is what the launcher follows; on an idle box the
  // play takes two round trips (the 404 transfer and the retry below) while the
  // event needs one local POST, so arming afterwards armed it too late and a
  // continuation nobody asked for still repointed the household's library.
  armFollowSuppression("");
  const found = await boxOwner(true);
  // `box_not_found` and `box_unreachable` both say the device cannot be
  // addressed, and both let the caller restart the daemon to sign it back in;
  // they differ only in whether librespot has named an owner since this shell
  // started. `box_other_account` must NOT be one of them: an account we have not
  // linked is holding the box, so a restart would take it off a person, and
  // nothing we send could reach that playback anyway.
  // A refusal is not a play, so it must not go on suppressing the follow: a
  // continuation that never started would otherwise keep the launcher off a real
  // cast for the rest of the window.
  const refuse = (error) => {
    disarmFollowSuppression();
    return { ok: false, error };
  };
  // An account this box has not linked is holding it: nothing we send could reach
  // that playback, and it is never a reason to restart the daemon. Judged on the
  // state and not on `swept`, because it is a fact about a LIVE session rather
  // than about a listing.
  if (found.state === "other") return refuse("box_other_account");
  if (found.state === "unreachable" || found.state === "none") {
    // Nothing about the box was established, so it must not reach the caller as
    // either answer below - both of those are read as "the box has no Connect
    // registration" and answered by restarting the daemon, which would be taking
    // it off somebody on the strength of a listing that never came back.
    if (!found.swept) return refuse("box_lookup_failed");
    return refuse(found.state === "unreachable" ? "box_unreachable" : "box_not_found");
  }
  if (!found.account || !found.devId) return refuse("box_unreachable");
  const { account: target, devId } = found;
  // Now that the target is known, the window is about THAT account's activation
  // and nobody else's - a cast by another account inside it is a real handover.
  armFollowSuppression(target.id);
  const q = `?device_id=${encodeURIComponent(devId)}`;
  const pos = Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
  // "Liked Songs" means the liked songs of the account whose library is on
  // screen, and a collection context can only name the account the play goes out
  // as. When the box is signed into somebody else that context is a different
  // person's collection, which Spotify accepts - so it plays their songs and
  // reports success. The caller sends the track uris as well for exactly this
  // case; falling through to them keeps the songs the ones that were asked for.
  const asked = activeAccount();
  const ctx = contextUri || (collection && asked && target.id === asked.id ? collectionUri(target) : "");

  const attempt = async (payload) => {
    let r = await apiWrite(target, "PUT", "/me/player/play" + q, payload);
    if (!r.ok && r.status === 404) {
      // device idle - wake it by transferring playback there, then retry once
      try {
        await apiWrite(target, "PUT", "/me/player", { device_ids: [devId], play: false });
      } catch (e) {}
      r = await apiWrite(target, "PUT", "/me/player/play" + q, payload);
    }
    return r;
  };

  // The window is armed above, and a THROW leaves this function without touching it
  // again: a timeout or a socket error would keep the launcher off a real cast for
  // the next thirty seconds, for a play that never happened.
  let r;
  try {
    r = ctx ? await attempt({ context_uri: ctx, ...(pos > 0 ? { offset: { position: pos } } : {}) }) : null;
    if ((!r || !r.ok) && (uris || []).length) {
      if (r) console.warn("[spotify-api] context play refused (" + r.status + "); falling back to track uris");
      r = await attempt({ uris: (uris || []).slice(0, URIS_MAX) });
    }
  } catch (e) {
    disarmFollowSuppression();
    throw e;
  }
  if (!r) return refuse("nothing to play");
  // A refusal is not a play, so it must not go on suppressing the follow.
  if (!r.ok) disarmFollowSuppression();
  // WHICH account this went out as. Autoplay has to be able to stop the music it
  // just started, and the account it guessed from boxPlayerState is not
  // necessarily the one resolved here - a pause sent as the wrong one is
  // refused, and the music it was cancelling keeps playing. The NAME is for the
  // screen: when this is not the account being browsed, the music is somebody
  // else's session and the person who pressed a row is owed that sentence.
  return {
    ok: r.ok,
    error: r.ok ? "" : "HTTP " + r.status + " " + (r.body || "").slice(0, 80),
    account: target.id,
    accountName: target.name || "",
  };
}

// Transport controls for the box. Two things decide where a press lands, and
// both used to be assumed rather than resolved:
//
//   • WHICH ACCOUNT. The box is signed into one, and it is not necessarily the
//     one the launcher is browsing — a phone casting to the box takes it over
//     without asking the TV. Sent as the active account instead, a pause reached
//     a player that account happened to have somewhere else: nothing on the box
//     stopped, and if that account was listening on a phone, the TV paused the
//     phone. Both were reported from one living room.
//   • WHICH DEVICE. /me/player/* with no device_id means "whatever this account
//     is playing on", which is the box only while the box is the thing playing.
//     Addressing the box by id is what keeps a press in this room.
const REPEAT_STATES = ["off", "context", "track"];

// `accId` names the account to act on: autoplay knows which account its own play
// went out as, and has to be able to stop that music without resolving the owner
// again. Without it the box's owner is resolved here.
async function control(action, state, accId) {
  if (!connected()) return { ok: false, error: "not connected" };
  let acc = null;
  let devId = "";
  if (accId) {
    // A named account is not a licence to skip the device: accountById falls back
    // to the ACTIVE account for an id it does not know (an account removed while
    // autoplay was armed), and a write with no device_id is "whatever this account
    // is playing on" — which is how autoplay's own cancel-pause would have paused
    // a family member's phone.
    acc = accounts.list.find((x) => x.id === accId);
    if (!acc) return { ok: false, error: "no_such_account" };
    try {
      devId = await boxDeviceIdFor(acc);
    } catch (e) {
      devId = "";
    }
    if (!devId) return { ok: false, error: "box_unreachable" };
  } else {
    const owner = await boxOwner(true);
    // Four states, four answers. Only "none" says the box is idle; the others say
    // somebody else is driving it, or that we could not address it — and a
    // command sent anyway would land in another room.
    if (owner.state === "other") return { ok: false, error: "box_other_account" };
    if (owner.state === "unreachable" || (owner.account && !owner.devId))
      return { ok: false, error: "box_unreachable" };
    if (!owner.account) return { ok: false, error: "box_not_found" };
    acc = owner.account;
    devId = owner.devId;
    // Somebody is in the room, which ends the window autoplay armed - here rather
    // than after the write, because a press Spotify refuses is still a person.
    disarmFollowSuppression();
  }
  const at = (p) => p + (p.indexOf("?") >= 0 ? "&" : "?") + "device_id=" + encodeURIComponent(devId);
  const write = (m, p, payload) => apiWrite(acc, m, at(p), payload);
  if (action === "playpause") {
    action = (await boxIsPlaying(acc)) ? "pause" : "play";
  }
  // Shuffle and repeat carry a value, so they are not in the table below. Both are
  // player-wide settings rather than one-shot commands: they persist until changed,
  // which is why the UI reads them back from playerState() instead of assuming.
  let res;
  if (action === "shuffle") {
    const on = state === true || state === "true";
    res = await write("PUT", "/me/player/shuffle?state=" + (on ? "true" : "false"));
  } else if (action === "repeat") {
    const s = REPEAT_STATES.includes(state) ? state : "off";
    res = await write("PUT", "/me/player/repeat?state=" + s);
  } else if (action === "seek") {
    // A place in the song rather than a command about the queue, so it carries a
    // value like the two above. Held to a whole number of milliseconds inside the
    // track: Spotify answers 400 for a negative or non-numeric position, and a
    // NaN would reach the URL as the string "NaN".
    // A number, or a string that is one. Not a coercion: Number("") and
    // Number(null) are both 0, so a caller that sent nothing would seek to the
    // start of the song instead of being refused - and 0 is a real position, so
    // the two cannot be told apart afterwards.
    const raw = typeof state === "number" ? state : typeof state === "string" && state.trim() ? Number(state) : NaN;
    const ms = Math.floor(raw);
    if (!Number.isFinite(ms) || ms < 0) return { ok: false, error: "bad position" };
    res = await write("PUT", "/me/player/seek?position_ms=" + ms);
  } else {
    const routes = {
      play: ["PUT", "/me/player/play"],
      pause: ["PUT", "/me/player/pause"],
      next: ["POST", "/me/player/next"],
      prev: ["POST", "/me/player/previous"],
    };
    const r = routes[action];
    if (!r) return { ok: false, error: "bad action" };
    res = await write(r[0], r[1]);
  }
  // A press does not move the launcher either (see play): it is aimed at the box,
  // it already resolved the account holding it, and the library on screen is
  // somebody's choice rather than a consequence of the pause button.
  return { ok: res.ok, error: res.ok ? "" : "HTTP " + res.status };
}

// Is the BOX playing — the question the one play/pause button asks, and not the
// same as "is this account playing", which is true of a phone in another room.
// Asked of the owner's player and pinned to the device name; the librespot state
// is the fallback, because the events that feed it come over a hook whose curl
// failures are swallowed, and a lost `paused` would make the button send the
// opposite of what its icon shows.
async function boxIsPlaying(acc) {
  try {
    const p = await apiGet(acc, "/me/player");
    const device = ((p && p.device) || {}).name || "";
    if (device.trim().toLowerCase() === spotifyBridge.deviceName().trim().toLowerCase()) return !!(p && p.is_playing);
    return false; // the account is playing somewhere else, so the box is not
  } catch (e) {
    return !!spotifyBridge.getState().is_playing;
  }
}

// What the shuffle and repeat toggles must reflect. librespot's cast metadata (the
// SSE state that drives now-playing) carries neither, so they come from the Web
// API - and only from there, which is also why a toggle press re-reads rather than
// trusting what it just sent. `/me/player` answers 204 with nothing active, and
// apiGet turns that into {}: no player is not an error, it is "off".
// `ok` says whether the answer is one: this never throws, so without it a caller
// cannot tell "nothing is playing" from "we could not find out". That difference
// decides whether autoplay may start music, and defaulting it to "nothing is
// playing" would have it push its own tracks over somebody's live session.
//
// The question is about THE BOX, so it is asked of the account holding the box —
// the same resolution the buttons use, or the toggles would show one player's
// settings and change another's. `other_account` is the case no read can cover:
// the box is being driven by an account this box has not linked, so there is
// nothing of ours to ask, and the screen has to say so rather than show a
// player's worth of blanks.
async function playerState() {
  const unknown = {
    ok: false,
    connected: connected(),
    active: false,
    is_playing: false,
    shuffle: false,
    repeat: "off",
  };
  if (!connected()) return { ...unknown, ok: true };
  let owner;
  try {
    owner = await boxOwner(false); // a read: the account is enough
  } catch (e) {
    return { ...unknown, error: String(e.message || e) };
  }
  const idle = { ok: true, connected: true, active: false, is_playing: false, shuffle: false, repeat: "off" };
  if (owner.state === "other") return { ...idle, other_account: true };
  if (!owner.account) return idle;
  try {
    const p = await apiGet(owner.account, "/me/player");
    const device = ((p && p.device) || {}).name || "";
    // Shuffle and repeat belong to the player that is running, so they are only
    // this box's settings while the box is the device. Reported otherwise, the
    // TV would show a phone's shuffle as its own.
    const isBox = device.trim().toLowerCase() === spotifyBridge.deviceName().trim().toLowerCase();
    if (!isBox) return idle;
    return {
      ok: true,
      connected: true,
      active: !!(p && p.item),
      is_playing: !!(p && p.is_playing),
      shuffle: !!(p && p.shuffle_state),
      repeat: REPEAT_STATES.includes(p && p.repeat_state) ? p.repeat_state : "off",
      device,
    };
  } catch (e) {
    return { ...unknown, error: String(e.message || e) };
  }
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

// ---- catalog reads, for the autoplay continuation ----
// Every one of these takes the account to read AS, defaulting to the active one.
// That parameter is not decoration: a play never makes the box's account the
// active one, so the account driving the box is not the one a read defaults to,
// and a catalog read for the wrong account is answered for the wrong COUNTRY. On a
// box with two accounts in two countries that produces recommendations the account
// actually playing cannot play.
function accountById(id) {
  return (id && accounts.list.find((x) => x.id === id)) || activeAccount();
}

// The market a catalog request is answered for. Top tracks REQUIRE one, and the
// account's own country is the honest answer; `from_token` is the fallback for an
// account that does not expose it.
// Per account, for the same reason the library caches are: a family box can have
// two accounts in two countries, and the wrong market answers with a catalog the
// listener cannot play.
let marketCache = new Map(); // accId -> market
async function market(accId) {
  const acc = accountById(accId);
  const id = (acc || {}).id || "";
  const hit = marketCache.get(id);
  if (hit) return hit;
  let m = "from_token";
  try {
    m = String((await apiGet(acc, "/me")).country || "") || "from_token";
  } catch (e) {
    m = "from_token";
  }
  marketCache.set(id, m);
  return m;
}

// Spotify deprecated /recommendations for apps registered after 2024-11-27, so
// whether this one may call it is a property of the app's registration rather than
// of the request. The caller probes once and remembers - see lib/autoplay.js.
// `market` matters beyond playability: without it Spotify may hand back a track
// id that gets relinked to a different one on playback, and autoplay recognises
// its own tracks by id to know it is still the thing playing.
async function recommendations(seedTrackIds, limit, accId) {
  const seeds = (seedTrackIds || []).filter(Boolean).slice(0, 5);
  if (!seeds.length) return [];
  const n = Math.max(1, Math.min(100, limit || 30));
  const d = await apiGet(
    accountById(accId),
    `/recommendations?limit=${n}&market=${encodeURIComponent(await market(accId))}&seed_tracks=${encodeURIComponent(seeds.join(","))}`,
  );
  return (d.tracks || []).map(trackOf).filter((t) => t && t.uri);
}

async function artistTopTracks(artistId, accId) {
  if (!artistId) return [];
  const d = await apiGet(
    accountById(accId),
    `/artists/${encodeURIComponent(artistId)}/top-tracks?market=${encodeURIComponent(await market(accId))}`,
  );
  return (d.tracks || []).map(trackOf).filter((t) => t && t.uri);
}

// The primary artist of a track, which is what an artist-based continuation is
// seeded from. Shares artistImageForTrack's shape but not its cache: that one
// stores an image url, this one an artist id.
// Keyed by track alone, because which artist a track is by does not depend on who
// is asking - unlike the market-sensitive reads above.
const trackArtistCache = new Map(); // trackId -> artistId ("" = looked up, none)
async function primaryArtistId(trackId, accId) {
  if (!connected() || !trackId) return "";
  if (trackArtistCache.has(trackId)) return trackArtistCache.get(trackId);
  let id = "";
  try {
    id =
      (((await apiGet(accountById(accId), "/tracks/" + encodeURIComponent(trackId))).artists || [])[0] || {}).id || "";
  } catch (e) {
    id = "";
  }
  trackArtistCache.set(trackId, id);
  return id;
}

/**
 * What is queued behind the current track, as the account that holds the box.
 *
 * `/me/player/queue` answers for the ACCOUNT, and an account can be playing in
 * another room - so the same resolution the buttons use decides whose queue this
 * is, and a box somebody else is driving answers with nothing rather than with a
 * list belonging to another player. The rows are trimmed to what a panel on a
 * television can show: Spotify returns up to twenty, and the reply carries a full
 * track object each.
 */
async function queue(limit) {
  if (!connected()) return { ok: false, connected: false, items: [] };
  let owner;
  try {
    owner = await boxOwner(true);
  } catch (e) {
    return { ok: false, connected: true, items: [], error: "box_unreachable" };
  }
  if (owner.state === "other") return { ok: false, connected: true, items: [], error: "box_other_account" };
  if (!owner.account) return { ok: false, connected: true, items: [], error: "box_not_found" };
  let j;
  try {
    j = await apiGet(owner.account, "/me/player/queue");
  } catch (e) {
    return { ok: false, connected: true, items: [], error: String((e && e.message) || e) };
  }
  const n = Math.max(1, Math.min(Number(limit) || 12, 20));
  const rows = Array.isArray(j && j.queue) ? j.queue.slice(0, n) : [];
  return { ok: true, connected: true, items: rows.map(queueRow).filter(Boolean) };
}

/** One queued item, reduced to what the panel draws. */
function queueRow(t) {
  if (!t || typeof t !== "object") return null;
  const artists = Array.isArray(t.artists)
    ? t.artists
        .map((a) => (a && a.name) || "")
        .filter(Boolean)
        .join(", ")
    : "";
  const images = (t.album && Array.isArray(t.album.images) && t.album.images) || [];
  return {
    uri: String(t.uri || ""),
    name: String(t.name || ""),
    artists,
    duration_ms: Number(t.duration_ms) || 0,
    // The smallest image Spotify offers: these are 5vh rows, and the largest is
    // 640px each on a panel that draws a dozen of them.
    image_url: images.length ? String(images[images.length - 1].url || "") : "",
  };
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
  playerState,
  queue,
  boxPlayerState,
  recommendations,
  artistTopTracks,
  primaryArtistId,
  artistImageForTrack,
  listAccounts,
  activeAccountInfo,
  switchAccount,
  removeAccount,
  findBoxAccount,
  boxSeenBy,
  boxOwner,
  boxSignedInAs,
  followBox,
  forgetBoxDevice,
};

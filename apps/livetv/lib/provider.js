// tvbox Live TV provider. Reads ~/.tvbox/iptv.conf (Pi-local IPTV credentials,
// never committed). Prefers the Xtream Codes API (player_api.php — structured
// categories/streams/EPG); falls back to parsing the M3U playlist if the Xtream
// API isn't available. The launcher fetches channels via
// GET /tvbox/api/livetv/channels and plays a stream URL through the shell's mpv
// service; per-channel now/next EPG via GET /tvbox/api/livetv/epg?id=<stream>.
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");

// Packaged Live TV provider (Kodi-model app code — ships in the app package, not
// the core shell). `config` is the shell's config store, injected once by
// plugin.js via setConfig(host.config); we read rawIptv() for the active IPTV
// source. Playback is the shell's shared mpv (the UI drives it via window.tvbox);
// this is purely the IPTV data surface behind /tvbox/api/livetv/*.
let config = { rawIptv: () => null };
function setConfig(cfg) {
  if (cfg) config = cfg;
}

const CONF = path.join(os.homedir(), ".tvbox", "iptv.conf");
const TTL_MS = 10 * 60 * 1000;
// Xtream live container extension. Per-source: set iptv.container in config
// (default "ts"); some providers serve only "m3u8".
function streamExt() {
  const c = config.rawIptv();
  return (c && c.container) || "ts";
}

function readConf() {
  const out = {};
  try {
    for (const line of fs.readFileSync(CONF, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (e) {
    /* not configured */
  }
  return out;
}

// Xtream {base,user,pass} from an M3U URL: standard query style
// (?username=&password=) or HunTV path style (/playlist/<user>/<pass>/m3u_plus).
function xtreamFromUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const url = new URL(urlStr);
    const qu = url.searchParams.get("username");
    const qp = url.searchParams.get("password");
    if (qu && qp) return { base: url.origin, user: qu, pass: qp };
    const parts = url.pathname.split("/").filter(Boolean); // playlist/<user>/<pass>/m3u_plus
    if (parts.length >= 3) return { base: url.origin, user: parts[1], pass: parts[2] };
  } catch (e) {
    /* ignore */
  }
  return null;
}
function deriveXtream(conf) {
  if (conf.XTREAM_URL && conf.XTREAM_USER && conf.XTREAM_PASS) {
    return { base: conf.XTREAM_URL.replace(/\/+$/, ""), user: conf.XTREAM_USER, pass: conf.XTREAM_PASS };
  }
  return xtreamFromUrl(conf.M3U_URL);
}
function xmltvUrl(x) {
  return `${x.base}/xmltv.php?username=${encodeURIComponent(x.user)}&password=${encodeURIComponent(x.pass)}`;
}

// The active source, resolved from the config store first (Xtream or M3U mode),
// then the legacy ~/.tvbox/iptv.conf. Returns { x?, m3uUrl?, epgUrl? }.
function resolveSource() {
  const c = config.rawIptv();
  if (c) {
    if (c.mode === "xtream" && c.xtream && c.xtream.base) {
      const x = { base: String(c.xtream.base).replace(/\/+$/, ""), user: c.xtream.user, pass: c.xtream.pass };
      return { origin: "config", x, m3uUrl: null, epgUrl: xmltvUrl(x) };
    }
    if (c.mode === "m3u" && c.m3u && c.m3u.url) {
      const x = xtreamFromUrl(c.m3u.url);
      return { origin: "config", x, m3uUrl: c.m3u.url, epgUrl: c.m3u.epgUrl || (x ? xmltvUrl(x) : null) };
    }
  }
  const conf = readConf();
  const x = deriveXtream(conf);
  return { origin: "iptv.conf", x, m3uUrl: conf.M3U_URL || null, epgUrl: conf.EPG_URL || (x ? xmltvUrl(x) : null) };
}

// Block loopback/private/link-local targets so a malicious IPTV provider can't
// 302 our fetch at the box's own services or the LAN (SSRF). Checked on the
// initial URL and every redirect (fetchText recurses).
function isBlockedHost(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m) {
    const a = Number(m[1]),
      b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
  }
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true; // IPv6 loopback/ULA/link-local
  return false;
}

function fetchText(url, timeoutMs, redirects) {
  return new Promise((resolve, reject) => {
    let host;
    try {
      host = new URL(url).hostname;
    } catch (e) {
      return reject(new Error("bad url"));
    }
    if (isBlockedHost(host)) return reject(new Error("blocked host: " + host));
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 4) {
        res.resume();
        return resolve(fetchText(res.headers.location, timeoutMs, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

function api(x, action, extra) {
  const u =
    `${x.base}/player_api.php?username=${encodeURIComponent(x.user)}&password=${encodeURIComponent(x.pass)}` +
    (action ? `&action=${action}` : "") +
    (extra || "");
  return fetchText(u, 25000, 0).then((t) => JSON.parse(t));
}

function b64(s) {
  if (!s) return "";
  try {
    return Buffer.from(String(s), "base64").toString("utf8");
  } catch (e) {
    return String(s);
  }
}

async function channelsFromXtream(x) {
  const [cats, streams] = await Promise.all([api(x, "get_live_categories"), api(x, "get_live_streams")]);
  const catName = {};
  for (const c of cats || []) catName[String(c.category_id)] = c.category_name;
  return (streams || []).map((s) => ({
    id: String(s.stream_id),
    name: s.name,
    logo: s.stream_icon || "",
    group: catName[String(s.category_id)] || "Other",
    url: `${x.base}/live/${x.user}/${x.pass}/${s.stream_id}.${streamExt()}`,
    epgId: s.epg_channel_id || "",
    order: typeof s.num === "number" ? s.num : 0,
  }));
}

// M3U fallback ---------------------------------------------------------------
function attr(line, key) {
  const m = new RegExp(key + '="([^"]*)"').exec(line);
  return m ? m[1] : "";
}
function channelsFromM3U(text) {
  const channels = [];
  let cur = null;
  let order = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF")) {
      const after = line.indexOf(",") >= 0 ? line.slice(line.lastIndexOf(",") + 1).trim() : "";
      cur = {
        id: attr(line, "tvg-id") || attr(line, "xui-id") || after,
        name: attr(line, "tvg-name") || after || "—",
        logo: attr(line, "tvg-logo"),
        group: attr(line, "group-title") || "Other",
        epgId: attr(line, "tvg-id") || "",
      };
    } else if (line && !line.startsWith("#") && cur) {
      cur.url = line;
      cur.order = order++;
      channels.push(cur);
      cur = null;
    }
  }
  return channels;
}

// ----------------------------------------------------------------------------
let cache = { at: 0, channels: null, xtream: null };

async function getChannels() {
  const now = Date.now();
  if (cache.channels && now - cache.at < TTL_MS) return cache.channels;
  const src = resolveSource();
  if (!src.x && !src.m3uUrl) throw new Error("not_configured"); // truly no source
  let channels = null;
  let failed = false; // a source IS configured but the fetch/auth failed
  if (src.x) {
    try {
      const info = await api(src.x, "");
      if (info && info.user_info && Number(info.user_info.auth) === 1) {
        channels = await channelsFromXtream(src.x);
        cache.xtream = src.x;
        console.log("[livetv] xtream (" + src.origin + "):", channels.length, "channels");
      } else {
        failed = true;
        console.warn("[livetv] xtream auth failed");
      }
    } catch (e) {
      failed = true;
      console.warn("[livetv] xtream unavailable:", e.message);
    }
  }
  if (!channels && src.m3uUrl) {
    try {
      channels = channelsFromM3U(await fetchText(src.m3uUrl, 30000, 0));
      cache.xtream = null;
      console.log("[livetv] m3u (" + src.origin + "):", channels.length, "channels");
    } catch (e) {
      failed = true;
      console.warn("[livetv] m3u fetch failed:", e.message);
    }
  }
  if (!channels) throw new Error(failed ? "unreachable" : "not_configured");
  if (!channels.length) throw new Error("empty_playlist");
  cache = { ...cache, at: now, channels };
  return channels;
}

function clearCache() {
  cache = { at: 0, channels: null, xtream: null };
  epgCache = { at: 0, progs: null };
}

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// Full EPG, parsed once from the XMLTV guide (EPG_URL, or xmltv.php for an
// Xtream login) into { channelId: [{title,start,stop}, ...] } sorted by start,
// for a now-2h..now+24h window. ~12 MB fetch + single-pass parse, cached. Keyed
// by the channel's epg id (tvg-id / epg_channel_id). now/next and the guide grid
// both derive from this.
let epgCache = { at: 0, progs: null };
const EPG_TTL_MS = 15 * 60 * 1000;

async function getEpg() {
  const now = Date.now();
  if (epgCache.progs && now - epgCache.at < EPG_TTL_MS) return epgCache.progs;
  const { epgUrl } = resolveSource();
  if (!epgUrl) return {};
  const xml = await fetchText(epgUrl, 45000, 0);
  const nowSec = Math.floor(now / 1000);
  const lo = nowSec - 2 * 3600;
  const hi = nowSec + 24 * 3600;
  const progs = {};
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const chm = /channel="([^"]*)"/.exec(attrs);
    if (!chm || !chm[1]) continue;
    const start = Number((/start_timestamp="(\d+)"/.exec(attrs) || [])[1] || 0);
    const stop = Number((/stop_timestamp="(\d+)"/.exec(attrs) || [])[1] || 0);
    if (!start || !stop || stop < lo || start > hi) continue;
    const tm = /<title[^>]*>([\s\S]*?)<\/title>/.exec(m[2]);
    const title = tm ? decodeEntities(tm[1]).trim() : "";
    (progs[chm[1]] || (progs[chm[1]] = [])).push({ title, start, stop });
  }
  for (const ch in progs) progs[ch].sort((a, b) => a.start - b.start);
  epgCache = { at: now, progs };
  console.log("[livetv] epg parsed for", Object.keys(progs).length, "channels");
  return progs;
}

// now/next per channel (Live TV list view).
async function getNowNext() {
  const progs = await getEpg();
  const nowSec = Math.floor(Date.now() / 1000);
  const map = {};
  for (const ch in progs) {
    let nowP = null;
    let nextP = null;
    for (const p of progs[ch]) {
      if (p.start <= nowSec && nowSec < p.stop) nowP = p;
      else if (p.start >= nowSec) {
        nextP = p;
        break;
      } // sorted -> first future
    }
    map[ch] = { now: nowP, next: nextP };
  }
  return map;
}

// programmes overlapping [fromSec, toSec) per channel (EPG guide grid).
async function getGuide(fromSec, toSec) {
  const progs = await getEpg();
  const out = {};
  for (const ch in progs) {
    const list = progs[ch].filter((p) => p.stop > fromSec && p.start < toSec);
    if (list.length) out[ch] = list;
  }
  return out;
}

// Now/next for one stream (Xtream get_short_epg; base64 title/description).
async function getShortEpg(streamId, limit) {
  const x = cache.xtream;
  if (!x) return [];
  const data = await api(x, "get_short_epg", `&stream_id=${encodeURIComponent(streamId)}&limit=${limit || 2}`);
  return (data && data.epg_listings ? data.epg_listings : []).map((p) => ({
    title: b64(p.title),
    description: b64(p.description),
    start: p.start,
    end: p.end,
  }));
}

module.exports = { setConfig, getChannels, getShortEpg, getNowNext, getGuide, clearCache, readConf };

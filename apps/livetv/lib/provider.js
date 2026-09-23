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
const dns = require("dns");
const net = require("net");
const epg = require("./epg");

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

// SSRF guard. A malicious IPTV provider controls the M3U / Xtream / EPG URLs
// AND any redirect Location they return, and we fetch them with raw
// http/https.get — NOT the shell's guarded appfetch broker — so this is the ONLY
// defense. A name-only string check is bypassable: a DNS name that resolves to a
// private/loopback IP, or an IPv4-mapped IPv6 literal like [::ffff:127.0.0.1],
// slips straight through. So (mirroring shell/appfetch.js) we classify literals
// rigorously AND resolve every host, refusing if ANY resolved address is
// loopback / private / link-local / metadata / unspecified, and we re-guard on
// each redirect hop. Dependency-free — Node built-ins only.

// Normalize a hostname: lowercase, strip a trailing FQDN dot, strip IPv6
// brackets and any zone id (%eth0).
function normHost(h) {
  let s = String(h || "").toLowerCase();
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  return s;
}

// Pull the embedded IPv4 out of an IPv4-mapped/-compatible/NAT64 IPv6 address
// ("::ffff:x", "::x", "64:ff9b::x") in dotted OR hex-group form; else null.
// These ranges aren't publicly routable as-is, so classifying the embedded v4
// fails closed (e.g. ::ffff:127.0.0.1 -> loopback).
function embeddedV4(s) {
  const m = /^(?:::(?:ffff:)?|64:ff9b::)([0-9a-f.:]+)$/i.exec(s);
  if (!m) return null;
  const tail = m[1];
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(tail)) return tail; // ::ffff:127.0.0.1
  const g = tail.split(":");
  if (g.length === 2 && g.every((x) => /^[0-9a-f]{1,4}$/i.test(x))) {
    const hi = parseInt(g[0], 16);
    const lo = parseInt(g[1], 16);
    return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join("."); // ::ffff:7f00:1
  }
  return null;
}

// Classify a literal IP into a trust category: loopback | linklocal | metadata |
// unspecified | private | public. Non-IP input returns "" (it's a name).
function classifyIp(ip) {
  const s = normHost(ip);
  if (net.isIPv4(s)) {
    const o = s.split(".").map(Number);
    if (o[0] === 0) return "unspecified"; // 0.0.0.0/8
    if (o[0] === 127) return "loopback"; // 127.0.0.0/8
    if (o[0] === 169 && o[1] === 254) return o[2] === 169 && o[3] === 254 ? "metadata" : "linklocal"; // 169.254/16
    if (o[0] === 10) return "private";
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "private"; // 172.16/12
    if (o[0] === 192 && o[1] === 168) return "private"; // 192.168/16
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return "private"; // 100.64/10 CGNAT
    return "public";
  }
  if (net.isIPv6(s)) {
    if (s === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(s)) return "loopback"; // incl. fully-expanded
    if (s === "::" || /^(0{1,4}:){7}0{1,4}$/.test(s)) return "unspecified";
    const v4 = embeddedV4(s); // ::ffff:… / ::… / 64:ff9b::… -> classify the embedded v4
    if (v4) return classifyIp(v4);
    if (/^fe[89ab]/.test(s)) return "linklocal"; // fe80::/10
    if (/^f[cd]/.test(s)) return "private"; // fc00::/7 unique-local
    if (/^fec/.test(s)) return "private"; // deprecated site-local
    return "public";
  }
  return "";
}

// Categories a box must never fetch from. This provider only ever pulls PUBLIC
// IPTV endpoints, so private (LAN) is refused too — same as the old literal
// check, but now also for names that RESOLVE into these ranges.
function isForbiddenCat(cat) {
  return cat === "loopback" || cat === "linklocal" || cat === "metadata" || cat === "unspecified" || cat === "private";
}

// Promisified dns.lookup(all): a name -> every A/AAAA address ([] on failure).
function lookupAll(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addrs) => resolve(err ? [] : addrs));
  });
}

// A net/tls `lookup` that returns ONLY the vetted addresses, so the socket
// connects exactly where we classified — no re-resolution / rebinding TOCTOU.
function pinnedLookup(addresses) {
  const list = addresses.map((a) => ({ address: a.address, family: a.family || (net.isIPv6(a.address) ? 6 : 4) }));
  return function (hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  };
}

// Resolve + vet a target host; returns the vetted addresses (to pin the socket
// to) or throws. localhost aliases and forbidden literal IPs (incl. IPv4-mapped
// IPv6) are rejected up front; a name is resolved and rejected if ANY address is
// forbidden — the DNS-rebinding / name-to-private bypass the old check missed.
async function vetHost(host) {
  const h = normHost(host);
  if (!h || h === "localhost" || h.endsWith(".localhost")) throw new Error("blocked host: " + host);
  const literal = classifyIp(h);
  if (literal) {
    if (isForbiddenCat(literal)) throw new Error("blocked host: " + host);
    return [{ address: h, family: net.isIPv6(h) ? 6 : 4 }]; // an IP literal: no DNS needed
  }
  const addrs = await lookupAll(h);
  if (!addrs.length) throw new Error("dns lookup failed: " + host);
  for (const a of addrs) {
    const cat = classifyIp(a.address);
    if (isForbiddenCat(cat)) throw new Error("blocked host " + host + " -> " + a.address + " (" + cat + ")");
  }
  return addrs;
}

// A provider's answer is held in memory whole, in the shell's own process, so it
// is bounded twice: in size, and in total time. The socket timeout alone is an
// idle timeout, and a server that trickles a byte at a time never trips it.
const FETCH_MAX_CHARS = 64 * 1024 * 1024;

function fetchText(url, timeoutMs, redirects, maxChars) {
  const cap = maxChars || FETCH_MAX_CHARS;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return Promise.reject(new Error("bad url"));
  }
  // Only http(s) is ever fetched (M3U/Xtream/EPG); refuse file:, data:, etc.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return Promise.reject(new Error("blocked scheme: " + parsed.protocol));
  return vetHost(parsed.hostname).then(
    (addresses) =>
      new Promise((resolve, reject) => {
        const mod = parsed.protocol === "https:" ? https : http;
        const req = mod.get(url, { lookup: pinnedLookup(addresses) }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 4) {
            res.resume();
            // Resolve Location against the current URL so RELATIVE redirects work,
            // then recurse — vetHost re-guards the new host on every hop.
            let next;
            try {
              next = new URL(res.headers.location, parsed).href;
            } catch (e) {
              return reject(new Error("bad redirect location"));
            }
            clearTimeout(deadline);
            return resolve(fetchText(next, timeoutMs, (redirects || 0) + 1, cap));
          }
          if (res.statusCode !== 200) {
            res.resume();
            clearTimeout(deadline);
            return reject(new Error("HTTP " + res.statusCode));
          }
          const parts = [];
          let size = 0;
          res.setEncoding("utf8");
          res.on("data", (c) => {
            size += c.length;
            if (size > cap) return req.destroy(new Error("response too large"));
            parts.push(c);
          });
          res.on("end", () => {
            clearTimeout(deadline);
            resolve(parts.join(""));
          });
          res.on("error", reject);
        });
        const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs * 2);
        req.on("error", (e) => {
          clearTimeout(deadline);
          reject(e);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
      }),
  );
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
// Streaming schemes mpv can actually play. A hostile playlist could set a
// channel URL to file:// (or another local scheme) that window.tvbox.play would
// hand straight to mpv, so channels with any other scheme are dropped at parse.
const STREAM_SCHEMES = new Set(["http", "https", "rtsp", "rtsps", "rtmp", "rtmps", "udp", "rtp"]);
function allowedStreamUrl(u) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(u || "").trim());
  return !!m && STREAM_SCHEMES.has(m[1].toLowerCase()); // must be an absolute URL with an allowed scheme
}
function attr(line, key) {
  const m = new RegExp(key + '="([^"]*)"').exec(line);
  return m ? m[1] : "";
}
function channelsFromM3U(text) {
  const channels = [];
  // A channel's id is its focus key and its identity on screen, and playlists
  // repeat a tvg-id (one channel in two qualities, or two channels sharing a guide
  // entry). A repeat gets a suffix; its guide id is left as it was.
  const seen = new Map();
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
      if (allowedStreamUrl(cur.url)) {
        cur.order = order++;
        const n = seen.get(cur.id) || 0;
        seen.set(cur.id, n + 1);
        if (n) cur.id = cur.id + "~" + (n + 1);
        channels.push(cur);
      } else {
        console.warn("[livetv] dropped channel with disallowed URL scheme:", line.slice(0, 40));
      }
      cur = null;
    }
  }
  return channels;
}

// ----------------------------------------------------------------------------
let cache = { at: 0, channels: null, xtream: null };
// Bumped by clearCache. A read that started before a source change answers for
// the OLD source, so its result is only kept if the generation is still the one
// it started under. `inflight` makes the two screens that ask together (now/next
// and the guide) share one download instead of each making their own.
let generation = 0;
const inflight = { channels: null, epg: null };
function shared(key, run) {
  const gen = generation;
  if (inflight[key] && inflight[key].gen === gen) return inflight[key].p;
  const p = run(gen).finally(() => {
    if (inflight[key] && inflight[key].p === p) inflight[key] = null;
  });
  inflight[key] = { gen, p };
  return p;
}

function getChannels() {
  if (cache.channels && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.channels);
  // A read that outlived a source change answers for the new source instead.
  return shared("channels", readChannels).catch((e) =>
    e && e.message === "source_changed" ? getChannels() : Promise.reject(e),
  );
}

async function readChannels(gen) {
  const now = Date.now();
  const src = resolveSource();
  if (!src.x && !src.m3uUrl) throw new Error("not_configured"); // truly no source
  let channels = null;
  let xtream = null;
  let failed = false; // a source IS configured but the fetch/auth failed
  if (src.x) {
    try {
      const info = await api(src.x, "");
      if (info && info.user_info && Number(info.user_info.auth) === 1) {
        channels = await channelsFromXtream(src.x);
        xtream = src.x;
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
      console.log("[livetv] m3u (" + src.origin + "):", channels.length, "channels");
    } catch (e) {
      failed = true;
      console.warn("[livetv] m3u fetch failed:", e.message);
    }
  }
  if (!channels) throw new Error(failed ? "unreachable" : "not_configured");
  if (!channels.length) throw new Error("empty_playlist");
  if (gen !== generation) throw new Error("source_changed");
  cache = { ...cache, at: now, channels, xtream };
  return channels;
}

function clearCache() {
  generation++;
  cache = { at: 0, channels: null, xtream: null };
  epgCache = { at: 0, progs: null };
}

// Full EPG, parsed once from the XMLTV guide (EPG_URL, or xmltv.php for an
// Xtream login) into { channelId: [{title,start,stop}, ...] } sorted by start,
// for a now-2h..now+24h window. ~12 MB fetch + single-pass parse, cached. Keyed
// by the channel's epg id (tvg-id / epg_channel_id). now/next and the guide grid
// both derive from this.
let epgCache = { at: 0, progs: null };
const EPG_TTL_MS = 15 * 60 * 1000;

function getEpg() {
  if (epgCache.progs && Date.now() - epgCache.at < EPG_TTL_MS) return Promise.resolve(epgCache.progs);
  return shared("epg", readEpg).catch((e) => (e && e.message === "source_changed" ? getEpg() : Promise.reject(e)));
}

async function readEpg(gen) {
  const now = Date.now();
  const { epgUrl } = resolveSource();
  if (!epgUrl) return {};
  const xml = await fetchText(epgUrl, 45000, 0);
  const nowSec = Math.floor(now / 1000);
  const progs = await parseEpgOffThread(xml, nowSec - 2 * 3600, nowSec + 24 * 3600);
  if (gen !== generation) throw new Error("source_changed");
  epgCache = { at: now, progs };
  console.log("[livetv] epg parsed for", Object.keys(progs).length, "channels");
  return progs;
}

// The guide is megabytes of XML and the parse is one long synchronous pass, so it
// runs on a worker thread: in the shell's main process it would stall the UI and
// every other route while it runs. Inline only if a worker cannot be started.
function parseEpgOffThread(xml, lo, hi) {
  let Worker;
  try {
    ({ Worker } = require("worker_threads"));
  } catch (e) {
    return Promise.resolve(epg.parse(xml, lo, hi));
  }
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(path.join(__dirname, "epg-worker.js"), { workerData: { xml, lo, hi } });
    } catch (e) {
      return resolve(epg.parse(xml, lo, hi));
    }
    w.once("message", resolve);
    w.once("error", reject);
    w.once("exit", (code) => {
      if (code !== 0) reject(new Error("epg worker exited with " + code));
    });
  });
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

module.exports = {
  setConfig,
  getChannels,
  getShortEpg,
  getNowNext,
  getGuide,
  clearCache,
  readConf,
  _test: { parseEpgOffThread, channelsFromM3U },
};

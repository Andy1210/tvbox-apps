// The playable library, assembled and cached.
//
// Two facts about the catalogue decide the whole shape of this file. A product row
// from catalog.gamepass.com is 14.7 KB and 39 fields - trailers, screenshots,
// language support, descriptions - and the whole library of them is 23.5 MB, while
// the six fields a ten-foot grid needs come to 581 bytes a row, or 1.45 MB for
// 2531 titles. And hydrating all of it takes ~17 s against ~0.9 s for the first
// fifty.
//
// So: reduce first (6% of what arrived is kept), cache the reduced form, and
// hydrate the first screen before the rest. Not lazily per scroll - a name search
// over 2531 titles is what makes a library this size usable at all, and it cannot
// search rows that were never fetched. The images stay lazy by themselves: only
// their URLs are here, and the page loads what is on screen.
const fs = require("fs");
const os = require("os");
const path = require("path");
const api = require("./xcloudapi");

const CACHE_FILE = process.env.TVBOX_XCLOUD_CACHE || path.join(os.homedir(), ".tvbox", "xcloud-library.json");
// Game Pass adds and removes titles monthly, and a stale name is a cosmetic
// error while a re-hydration is 17 s of requests - so a day is the right order.
const TTL_MS = 24 * 3600 * 1000;
// What the first paint needs: the recent row plus the first grid rows.
const FIRST_SCREEN = 50;
const CACHE_VERSION = 1;

let state = { titles: [], fetchedAt: 0, market: "", language: "", partial: false, version: CACHE_VERSION };
let loaded = false;
let inFlight = null;

function loadCache() {
  if (loaded) return state;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    // A version bump means the reduced shape changed, so the cached rows are
    // missing fields the UI now reads - refetching is cheaper than guessing.
    if (raw && raw.version === CACHE_VERSION && Array.isArray(raw.titles)) state = raw;
  } catch {
    /* no cache yet, or one we cannot read - either way there is nothing to reuse */
  }
  return state;
}

function saveCache() {
  const tmp = CACHE_FILE + ".tmp";
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    // A cache that cannot be written costs 17 s on the next launch and nothing
    // else, so it is never worth failing a request over.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    console.warn("[xcloud] library cache write failed:", e.message);
  }
}

const isFresh = () => state.titles.length > 0 && Date.now() - state.fetchedAt < TTL_MS && !state.partial;

// The reduced row. Everything the grid, the detail panel and the search read, and
// nothing else - this is the 6% the size measurement above is about.
function reduce(joined) {
  return joined.map((t) => ({
    titleId: t.titleId,
    productId: t.productId,
    name: t.name,
    publisher: t.publisher,
    tile: t.tile,
    poster: t.poster,
    owned: t.hasEntitlement,
    inputs: t.supportedInputTypes,
    maxPlaySeconds: t.maxPlaySeconds,
    // Kept so a title with no catalogue row can be hidden rather than drawn as a
    // blank card, and so a later pass knows what is still worth asking about.
    hydrated: t.hydrated,
  }));
}

// One shared refresh: two screens opening at once must not start two 17 s passes.
function refresh(opts) {
  if (inFlight) return inFlight;
  inFlight = doRefresh(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRefresh(opts) {
  const o = opts || {};
  const language = o.language || "en-US";
  const titles = await api.fetchTitles();
  const ids = titles.map((t) => t.productId);

  // First screen first, so the grid can draw while the rest is still arriving.
  const head = await api.hydrate(ids.slice(0, FIRST_SCREEN), { language, market: o.market });
  let products = head.products;
  let partial = head.partial;

  publish(titles, products, partial, o, language);
  if (o.onFirstScreen) o.onFirstScreen(state);

  if (ids.length > FIRST_SCREEN) {
    const tail = await api.hydrate(ids.slice(FIRST_SCREEN), { language, market: o.market, signal: o.signal });
    products = { ...products, ...tail.products };
    partial = partial || tail.partial;
    publish(titles, products, partial, o, language);
  }

  saveCache();
  return state;
}

function publish(titles, products, partial, o, language) {
  state = {
    version: CACHE_VERSION,
    titles: reduce(api.joinCatalogue(titles, products)),
    fetchedAt: Date.now(),
    market: o.market || "",
    language,
    // A partial hydration is NOT cached as complete: it would keep the missing
    // names missing for the whole TTL.
    partial,
  };
}

// What a UI request gets. Cached rows are served immediately and a stale cache is
// refreshed BEHIND the answer, so the grid is never blank because of a slow
// catalogue - only an empty cache waits.
async function get(opts) {
  loadCache();
  if (isFresh()) return { titles: state.titles, fetchedAt: state.fetchedAt, cached: true, partial: false };

  if (state.titles.length > 0) {
    refresh(opts).catch((e) => console.warn("[xcloud] background library refresh failed:", e.message));
    return { titles: state.titles, fetchedAt: state.fetchedAt, cached: true, stale: true, partial: state.partial };
  }

  await refresh(opts);
  return { titles: state.titles, fetchedAt: state.fetchedAt, cached: false, partial: state.partial };
}

const find = (titleId) => loadCache().titles.find((t) => t.titleId === titleId) || null;

// Substring, accent-insensitive, over names the cache already holds - which is the
// reason the whole library is fetched rather than paged in as the grid scrolls.
function search(query, limit = 60) {
  const q = normalize(query);
  if (!q) return [];
  const out = [];
  for (const t of loadCache().titles) {
    if (t.name && normalize(t.name).includes(q)) {
      out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out;
}

const normalize = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks so "pokemon" finds "Pokémon"
    .toLowerCase()
    .trim();

function invalidate() {
  state = { titles: [], fetchedAt: 0, market: "", language: "", partial: false, version: CACHE_VERSION };
  loaded = true;
  try {
    fs.unlinkSync(CACHE_FILE);
  } catch {
    /* already gone */
  }
}

module.exports = { CACHE_FILE, TTL_MS, FIRST_SCREEN, CACHE_VERSION, get, find, search, refresh, invalidate, reduce, normalize, _state: () => state };

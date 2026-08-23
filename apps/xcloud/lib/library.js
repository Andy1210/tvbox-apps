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
const CACHE_VERSION = 2; // bumped when `reduce` gained `categories`

let state = { titles: [], fetchedAt: 0, market: "", language: "", partial: false, filling: false, version: CACHE_VERSION };
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
    // 0600 regardless of umask, like the settings and the tokens beside it. Not a
    // credential, but it is the whole Game Pass catalogue WITH this account's
    // entitlement flag per title - what this household subscribes to - and it was
    // the one of the three written at the umask (664 as measured on the box).
    fs.chmodSync(tmp, 0o600);
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

// Language matters, not only age: the categories come back localised, so a cache
// fetched in Hungarian is the wrong answer for an English UI - and a stale-by-age
// check would serve it for the rest of the TTL.
const isFresh = (language) =>
  state.titles.length > 0 &&
  Date.now() - state.fetchedAt < TTL_MS &&
  !state.partial &&
  (!language || !state.language || state.language === language);

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
    // The genres, for filtering. Localised by the catalogue, which is why the
    // cache is keyed on language below - 68 bytes a title against the 581
    // already kept.
    categories: (t.categories || []).map(String),
    // Kept so a title with no catalogue row can be hidden rather than drawn as a
    // blank card, and so a later pass knows what is still worth asking about.
    hydrated: t.hydrated,
  }));
}

// One shared refresh: two screens opening at once must not start two 17 s passes.
// `firstScreen` resolves as soon as there is something to draw, which is what a
// cold `get()` waits for - the whole pass took 40 s on the box, and waiting for it
// spent the head-first hydration on nobody.
//
// The language is part of what is in flight, not just the fact of it. Sharing a
// pass with a caller that asked for a DIFFERENT language hands back a catalogue
// whose categories are in the wrong one, and looks exactly like a cache that
// refused to refetch.
let firstScreen = null;
let inFlightLanguage = null;
// The identity of the pass that owns `inFlight`. Comparing the LANGUAGE instead
// meant a pass disowned by `invalidate()` matched the replacement that had taken
// the same key, and cleared ITS slot - so the dedupe stopped working and three
// full catalogue passes ran at once against an endpoint that 504s under load.
let inFlightToken = null;
// Bumped by `invalidate`. A pass started before it belongs to a library that no
// longer exists: without this, forgetting the catalogue while one was running
// handed the next reader that stale promise, which was already past its publish
// and only had its `saveCache()` left to run - so it wrote the EMPTY state to
// disk and answered with nothing. Measured on the box: "no games available", and
// an app restart did not clear it because the plugin keeps running.
let generation = 0;

function refresh(opts) {
  const language = (opts && opts.language) || "en-US";
  if (inFlight && inFlightLanguage === language) return inFlight;

  // A pass for another language is waited out rather than cancelled: it is about
  // to publish, and two passes writing the same state interleave.
  const after = inFlight ? inFlight.catch(() => {}) : Promise.resolve();
  let ready;
  firstScreen = new Promise((r) => {
    ready = r;
  });
  inFlightLanguage = language;
  const era = generation;
  const token = {};
  inFlightToken = token;
  inFlight = after
    .then(() => doRefresh({ ...opts, _ready: ready, _era: era }))
    .finally(() => {
      // Only clear what is still ours: a later pass may already have replaced it.
      if (inFlightToken === token) {
        inFlight = null;
        inFlightLanguage = null;
        inFlightToken = null;
        firstScreen = null;
      }
      // A pass that failed before the first screen must not leave a promise
      // nothing will ever resolve.
      if (ready) ready();
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
  if (o._ready) o._ready();

  if (ids.length <= FIRST_SCREEN) state.filling = false;

  let aborted = false;
  if (ids.length > FIRST_SCREEN) {
    const tail = await api.hydrate(ids.slice(FIRST_SCREEN), { language, market: o.market, signal: o.signal });
    products = { ...products, ...tail.products };
    partial = partial || tail.partial;
    aborted = !!tail.aborted;
    publish(titles, products, partial, o, language);
  }

  // A pass whose library was forgotten while it ran must not write anything: its
  // state object is gone and saving would put an empty one on disk.
  if (o._era !== generation) return state;
  state.filling = false;
  // A pass that STOPPED is not this language's answer. Caching it would serve a
  // catalogue of fifty titles from disk for the whole TTL, and `isFresh` would
  // see nothing wrong with it - the next launch would not even try to refill.
  if (!aborted) saveCache();
  return state;
}

function publish(titles, products, partial, o, language) {
  if (o._era !== undefined && o._era !== generation) return;
  const next = reduce(api.joinCatalogue(titles, products));
  // A refresh must never make what is on screen WORSE. The head-only publish is
  // for a cold start; over a library that already has its names it would replace
  // 2530 named rows with 50 - measured on the box, where a background pass turned
  // the grid into a screen of blanks until its tail landed.
  //
  // Only within the same LANGUAGE, though: a different one is a different list
  // rather than a worse version of this one, and comparing them by count leaves
  // the categories in the language nobody asked for.
  if (state.language === language && named(next) < named(state.titles)) return;
  state = {
    version: CACHE_VERSION,
    titles: next,
    fetchedAt: Date.now(),
    market: o.market || "",
    language,
    // A partial hydration is NOT cached as complete: it would keep the missing
    // names missing for the whole TTL.
    partial,
    // Says the tail is still coming, so a caller can draw now and re-read rather
    // than deciding this is all there is.
    filling: true,
  };
}

const named = (rows) => (rows || []).reduce((n, t) => n + (t.name ? 1 : 0), 0);

// What a UI request gets. Cached rows are served immediately and a stale cache is
// refreshed BEHIND the answer, so the grid is never blank because of a slow
// catalogue - only an empty cache waits.
// One state holds one language, so every switch is a full pass over the whole
// catalogue - ~101 requests to Microsoft and ~17 s. A person changes the language
// at most once in a sitting; a caller that alternates does it every time.
//
// This route is a GET, and the shell gates only non-GET, so an `<img src>` on any
// page the box loads can ask - measured. The switch is therefore rate limited
// rather than the request: what is served in the meantime is the language already
// held, which is wrong only for whoever asked for the other one.
const LANGUAGE_SWITCH_MS = 60000;
let lastSwitch = 0;

// What the screen last asked for. The idle refresh has no request to read a
// language from, so it fell back to the box's own `config.locale` - unset here -
// and asked for en-US every fifteen minutes. One state holds one language, so
// that threw away the Hungarian catalogue, wrote an English one to disk, and made
// the next app open pay the full cold pass. Measured on the box.
let lastAsked = "";
const askedLanguage = () => lastAsked;

async function get(opts) {
  loadCache();
  let language = (opts && opts.language) || "en-US";
  if (opts && opts.remember !== false) lastAsked = language;
  if (state.titles.length && state.language && state.language !== language) {
    if (Date.now() - lastSwitch < LANGUAGE_SWITCH_MS) language = state.language;
    else lastSwitch = Date.now();
  }
  if (isFresh(language)) return answer({ cached: true });

  if (state.titles.length > 0 && state.language === language) {
    refresh(opts).catch((e) => console.warn("[xcloud] background library refresh failed:", e.message));
    return answer({ cached: true, stale: true });
  }

  // Cold: wait only for the first screen. The whole pass is ~20 s here and was
  // measured at 40 s on the box, and a grid that draws in a second and fills in
  // behind is the point of hydrating the head first at all.
  const pass = refresh(opts);
  pass.catch(() => {}); // the failure is surfaced below, not as an unhandled one
  if (firstScreen) await firstScreen;

  // Nothing published means the pass either died or is still going, and the two
  // have to be told apart - awaiting it does that and throws if it failed. Not
  // decided by which promise settles first: an earlier cut read a flag set by a
  // `catch` whose ordering against the first-screen resolution is not defined,
  // and it reported a failure only some of the time.
  //
  // A pass that DID publish is not waited for: answering after the first screen
  // is the whole point.
  if (!state.titles.length) await pass;
  return answer({ cached: false });
}

function answer(extra) {
  return {
    titles: state.titles,
    fetchedAt: state.fetchedAt,
    partial: state.partial,
    // The caller re-reads while this is true rather than treating a first screen
    // as the whole library.
    filling: !!state.filling,
    ...extra,
  };
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

// Game Pass's own curated lists. Cached for an hour: "recently added" changes on
// Microsoft's schedule, not ours, and the answer is one small request.
//
// What is cached is the PRODUCT IDS, and the resolution against the library
// happens on every read. Caching resolved rows looked equivalent and was not: the
// first screen asks for these while the catalogue is still filling in, so the rows
// captured were the ones with no name and no art yet - and then those sat in the
// cache for an hour, drawing a row of title ids on the television.
const COLLECTION_TTL_MS = 3600 * 1000;
const collections = new Map();

async function collection(name, opts) {
  const id = api.SIGL[name];
  if (!id) throw new Error("no such collection: " + name);
  const o = opts || {};
  const language = o.language || "en-US";
  const key = name + "|" + language;

  const hit = collections.get(key);
  let ids;
  if (hit && Date.now() - hit.at < COLLECTION_TTL_MS) {
    ids = hit.ids;
  } else {
    ids = await api.fetchSigl(id, { language, market: o.market });
    collections.set(key, { at: Date.now(), ids });
  }

  // Resolved against the library, so a list entry that is not streamable on this
  // account simply does not appear - the sigls cover console and PC too. A title
  // the catalogue has not named yet is left out rather than drawn as its id.
  const byProduct = new Map(loadCache().titles.map((t) => [t.productId, t]));
  return ids.map((p) => byProduct.get(p)).filter((t) => t && t.name);
}

function invalidate() {
  collections.clear();
  // Anything running now belongs to the library being forgotten.
  generation++;
  // There is no language left to protect, so the next reader may pick one freely.
  lastSwitch = 0;
  inFlight = null;
  inFlightLanguage = null;
  inFlightToken = null;
  firstScreen = null;
  state = { titles: [], fetchedAt: 0, market: "", language: "", partial: false, filling: false, version: CACHE_VERSION };
  loaded = true;
  try {
    fs.unlinkSync(CACHE_FILE);
  } catch {
    /* already gone */
  }
}

module.exports = {
  CACHE_FILE,
  TTL_MS,
  FIRST_SCREEN,
  CACHE_VERSION,
  COLLECTION_TTL_MS,
  askedLanguage,
  get,
  find,
  search,
  collection,
  refresh,
  invalidate,
  reduce,
  normalize,
  _state: () => state,
};

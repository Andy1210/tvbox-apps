// The gssv streaming API and the Game Pass catalogue - the two halves of "what can
// I play", which live on different hosts and answer with different halves of a
// title.
//
//   <region>.gssv-play-prod.xboxlive.com  GET /v2/titles   ->  titleId + productId,
//       entitlement, supported input types. Bearer: the gsToken. No names, no art.
//   catalog.gamepass.com                  POST /v3/products -> ProductTitle,
//       Image_Tile / Image_Poster, publisher, categories. No auth at all.
//
// So a usable list is one request to the first and one per 100 products to the
// second, joined on the product id.
const http = require("./http");
const auth = require("./xboxauth");

const CATALOG_HOST = "catalog.gamepass.com";
// Measured against this account's 2531 titles, and none of these numbers is the
// endpoint's documented limit - it has none. What it has is an origin that times
// out under load: batches of 100 fired all at once answered 504 ten times out of
// twenty-six, with a median latency of 10.3 s, while batches of 25 answered in
// 172 ms each. Bounded fan-out plus one retry took every configuration to zero
// failed batches; 25/8 does the whole library in ~17 s and 8 sockets is kinder to
// a Pi than the 12 that saves three of them. greenlight's own hardcoded 100 is
// what leaves a big library rendering as spinning placeholders.
const CATALOG_BATCH = 25;
const CATALOG_CONCURRENCY = 8;
const CATALOG_RETRIES = 2;
// Hydration level: this is the one that carries the tile and poster art. The
// lighter levels answer faster and return no images, which is the whole point here.
const HYDRATION = "RemoteHighSapphire0";

const catalogHeaders = {
  "ms-cv": "0",
  "calling-app-name": "Xbox Cloud Gaming Web",
  "calling-app-version": "21.0.0",
  Accept: "application/json",
};

class ApiError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
  }
}

// Every gssv call is the same shape: the streaming token decides both the host and
// the bearer, so they are never allowed to drift apart.
async function gssv(method, path, body, opts) {
  const token = (opts && opts.token) || (await auth.getCloudStreamingToken());
  const res = await http.request(method, token.host, path, {
    Authorization: "Bearer " + token.gsToken,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...((opts && opts.headers) || {}),
  }, body == null ? null : JSON.stringify(body), opts);

  if (res.status === 401 || res.status === 403) {
    throw new ApiError("token_rejected", "The streaming token was refused: " + http.describe(res), { status: res.status });
  }
  if (!res.ok) throw new ApiError("gssv_failed", method + " " + path + " failed: " + http.describe(res), { status: res.status });
  return res;
}

// What this account may stream. `results` carries no name and no art - that is the
// catalogue's job below.
async function fetchTitles(opts) {
  const res = await gssv("GET", "/v2/titles", null, opts);
  const body = res.json() || {};
  const results = Array.isArray(body.results) ? body.results : [];
  return results.map(shapeTitle).filter((t) => t.titleId && t.productId);
}

// What was played last changes between two launches, not between two screens, so
// a short cache is enough to stop an ungated GET turning into one authenticated
// request to Microsoft per HTTP request.
const RECENT_TTL_MS = 30000;
const WAIT_TTL_MS = 30000;
// Keyed by the count asked for: a cached 5-row answer served a later request for
// 25 and the Continue row silently lost twenty games for the next 30 seconds.
const recentCache = { at: 0, n: 0, rows: null };
const waitCache = new Map();

// Most-recently-used, i.e. the "continue playing" row. `mr` is a count.
async function fetchRecentTitles(limit, opts) {
  const n = Math.min(50, Math.max(1, Number(limit) || 25));
  if (recentCache.rows && recentCache.n >= n && Date.now() - recentCache.at < RECENT_TTL_MS) {
    return recentCache.rows.slice(0, n);
  }
  const res = await gssv("GET", "/v2/titles/mru?mr=" + n, null, opts);
  const body = res.json() || {};
  const results = Array.isArray(body.results) ? body.results : [];
  recentCache.rows = results.map(shapeTitle).filter((t) => t.titleId && t.productId);
  recentCache.n = n;
  recentCache.at = Date.now();
  return recentCache.rows.slice(0, n);
}

function shapeTitle(row) {
  const d = (row && row.details) || {};
  return {
    titleId: row && row.titleId ? String(row.titleId) : "",
    productId: d.productId ? String(d.productId) : "",
    xboxTitleId: d.xboxTitleId != null ? String(d.xboxTitleId) : "",
    hasEntitlement: !!d.hasEntitlement,
    supportedInputTypes: Array.isArray(d.supportedInputTypes) ? d.supportedInputTypes : [],
    // Non-null only for a trial or a time-limited free run; the UI has to say so
    // before someone starts a 30-minute demo thinking it is the game.
    maxPlaySeconds: Number(d.maxGameplayTimeInSeconds) || 0,
  };
}

// How long the queue is for a title, in seconds. Ultimate accounts are usually
// zero, so this is only worth showing when it is not.
async function fetchWaitTime(titleId, opts) {
  // Held to the same shape as a title id everywhere else. `encodeURIComponent`
  // already stops path injection, but an unbounded string is still an
  // authenticated request to Microsoft with someone else's text in it.
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(titleId || ""))) {
    throw new ApiError("bad_request", "waitTime needs a titleId");
  }
  const hit = waitCache.get(titleId);
  if (hit && Date.now() - hit.at < WAIT_TTL_MS) return hit.seconds;
  const res = await gssv("GET", "/v1/waittime/" + encodeURIComponent(titleId), null, opts);
  const body = res.json() || {};
  const seconds = Number(body.estimatedTotalWaitTimeInSeconds) || 0;
  // Bounded, because the key is a caller's string: the queue is asked about one
  // title at a time and a handful is all a screen ever needs.
  if (waitCache.size > 32) waitCache.clear();
  waitCache.set(titleId, { at: Date.now(), seconds });
  return seconds;
}

// The names and the art. Unauthenticated, and `market` is NOT hardcoded: it comes
// from the streaming token, because a catalogue read for the wrong market answers
// with prices, availability and sometimes titles that are not this account's.
async function hydrate(productIds, opts) {
  const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { products: {}, partial: false, batches: 0, failedBatches: 0 };

  const o = opts || {};
  const market = o.market || (await auth.getCloudStreamingToken()).market || "US";
  const language = o.language || "en-US";
  const path =
    "/v3/products?market=" + encodeURIComponent(market) +
    "&language=" + encodeURIComponent(language) +
    "&hydration=" + HYDRATION;

  const batches = [];
  for (let i = 0; i < ids.length; i += CATALOG_BATCH) batches.push(ids.slice(i, i + CATALOG_BATCH));

  const products = {};
  let failed = 0;
  let cursor = 0;

  // A worker pool rather than Promise.all over every batch: the fan-out is what
  // pushes this endpoint into 504s, so it has to be bounded HERE. Bounding it in
  // the socket pool instead would cap every other caller invisibly.
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= batches.length) return;
      if (o.signal && o.signal.aborted) return;

      for (let attempt = 0; ; attempt++) {
        let res = null;
        try {
          res = await http.postJson(CATALOG_HOST, path, catalogHeaders, { Products: batches[i] }, { timeout: 25000 });
        } catch {
          /* transport failure - same handling as a 5xx below */
        }
        if (res && res.ok) {
          const body = res.json() || {};
          Object.assign(products, body.Products || {});
          break;
        }
        // A 4xx is our own request being wrong and will be wrong again; only a
        // 5xx or a transport failure is worth repeating.
        const worthRetrying = !res || res.status >= 500 || res.status === 429;
        if (!worthRetrying || attempt >= CATALOG_RETRIES) {
          failed++;
          break;
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CATALOG_CONCURRENCY, batches.length) }, worker));

  // A batch that failed loses ITS titles, not the whole grid - a partial catalogue
  // beats an empty screen, and the caller is told so it can say "some titles have
  // no name yet" rather than pretending the library is that size.
  if (failed && failed === batches.length) {
    throw new ApiError("catalog_unavailable", "The Game Pass catalogue could not be read (all " + batches.length + " batches failed).");
  }
  return { products, partial: failed > 0, batches: batches.length, failedBatches: failed };
}

// Join the two halves. The catalogue is keyed by its OWN product id and carries
// `XCloudTitleId`, but the two do not always agree - so match on the xCloud title
// id first and fall back to the product id, which is how a title whose catalogue
// row predates its cloud entry still gets a name.
function joinCatalogue(titles, products) {
  const byXCloudId = new Map();
  const byStoreId = new Map();
  for (const key of Object.keys(products || {})) {
    const p = products[key];
    if (!p) continue;
    if (p.XCloudTitleId) byXCloudId.set(String(p.XCloudTitleId), p);
    if (p.StoreId) byStoreId.set(String(p.StoreId), p);
    byStoreId.set(String(key), p);
  }

  return titles.map((t) => {
    const p = byXCloudId.get(t.titleId) || byStoreId.get(t.productId) || null;
    return {
      ...t,
      name: (p && p.ProductTitle) || "",
      publisher: (p && p.PublisherName) || "",
      tile: imageUrl(p && p.Image_Tile),
      poster: imageUrl(p && p.Image_Poster),
      categories: (p && (p.LocalizedCategories || p.Categories)) || [],
      // A title with no catalogue row is still playable - it just has no name to
      // show, so the UI can decide to hide it rather than drawing a blank card.
      hydrated: !!p,
    };
  });
}

// The catalogue nests art as { URL } or { Uri }, sometimes under `Image_Tile.URL`,
// and returns protocol-relative URLs ("//store-images...") which a page loaded
// from our own origin cannot fetch as-is.
function imageUrl(img) {
  if (!img) return "";
  const raw = String(typeof img === "string" ? img : img.URL || img.Uri || img.url || "");
  if (!raw) return "";
  const url = raw.startsWith("//") ? "https:" + raw : raw;
  // Only http(s). Nothing else is a picture: the catalogue is Microsoft's, but it
  // is remote data reaching an `src`, and the shell ships no CSP to catch a
  // `javascript:`/`data:`/`file:` one behind us. A plain `http:` is allowed
  // because the catalogue does serve some, and refusing it would blank real art.
  return /^https?:\/\//i.test(url) ? url : "";
}

// A "sigl" is one of Game Pass's own curated lists, addressed by a fixed id, and
// it answers with product ids only - the names and art come from the catalogue
// like everything else. Unauthenticated, same host.
//
// The ids are Microsoft's and are not discoverable: these are the ones that
// answered on this market, verified rather than copied. "Coming soon" 404s, so it
// is not in the list.
const SIGL = {
  recentlyAdded: "f13cf6b4-57e6-4459-89df-6aec18cf0538",
  leavingSoon: "393f05bf-e596-4ef6-9487-6d4fa0eab987",
  mostPopular: "a884932a-f02b-40c8-a903-a008c23b1df1",
};

async function fetchSigl(id, opts) {
  const o = opts || {};
  const market = o.market || (await auth.getCloudStreamingToken()).market || "US";
  const path =
    "/sigls/v2?id=" + encodeURIComponent(id) +
    "&market=" + encodeURIComponent(market) +
    "&language=" + encodeURIComponent(o.language || "en-US");
  const res = await http.get(CATALOG_HOST, path, catalogHeaders, { timeout: 20000 });
  if (!res.ok) throw new ApiError("sigl_unavailable", "Could not read the list " + id + ": " + http.describe(res), { status: res.status });
  const body = res.json();
  // The array carries a metadata entry with no id alongside the products.
  return (Array.isArray(body) ? body : []).map((r) => r && r.id).filter(Boolean).map(String);
}

module.exports = {
  ApiError,
  SIGL,
  fetchSigl,
  gssv,
  fetchTitles,
  fetchRecentTitles,
  fetchWaitTime,
  hydrate,
  joinCatalogue,
  imageUrl,
  CATALOG_BATCH,
};

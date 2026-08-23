// The two halves of "what can I play", and the joining of them.
//
// The hydration assertions are the ones measured rather than reasoned: batches of
// 100 fired all at once made catalog.gamepass.com answer 504 ten times out of
// twenty-six with a 10.3 s median, while batches of 25 answered in 172 ms. So the
// fan-out has to be bounded HERE and a 5xx has to be retried - and a 4xx must NOT
// be, because our own malformed request will be malformed again.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const https = require("https");
const { EventEmitter } = require("events");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-xcloud-api-"));
process.env.TVBOX_XCLOUD_TOKENS = path.join(DIR, "tokens.json");

const REAL_REQUEST = https.request;
let handler = () => ({ status: 500, body: "" });
let live = 0;
let peakLive = 0;
const seen = [];

https.request = (opts, cb) => {
  const req = new EventEmitter();
  let body = "";
  req.write = (c) => { body += c; };
  req.destroy = (e) => setImmediate(() => req.emit("error", e || new Error("destroyed")));
  req.setTimeout = () => {};
  req.end = () => {
    const call = { host: opts.hostname, path: opts.path, method: opts.method, headers: opts.headers, body };
    seen.push(call);
    live++;
    peakLive = Math.max(peakLive, live);
    let out;
    try {
      out = handler(call) || { status: 500, body: "" };
    } catch (e) {
      live--;
      setImmediate(() => req.emit("error", e));
      return;
    }
    const res = new EventEmitter();
    res.statusCode = out.status;
    res.headers = {};
    // A tick of delay, so overlapping requests really do overlap and peakLive
    // measures something.
    setTimeout(() => {
      live--;
      cb(res);
      const text = typeof out.body === "string" ? out.body : JSON.stringify(out.body || {});
      if (text) res.emit("data", Buffer.from(text));
      res.emit("end");
    }, out.delay || 5);
  };
  return req;
};

const auth = require("./xboxauth");
const store = require("./tokenstore");
const api = require("./xcloudapi");

const xstsOk = { Token: "t", NotAfter: new Date(Date.now() + 3600e3).toISOString(), DisplayClaims: { xui: [{ uhs: "u" }] } };
const streamOk = {
  gsToken: "gs-token",
  market: "DE",
  durationInSeconds: 14400,
  offeringSettings: { regions: [{ name: "WESTEUROPE", baseUri: "https://weu.core.gssv-play-prod.xboxlive.com/", isDefault: true }] },
};

function reset() {
  seen.length = 0;
  live = 0;
  peakLive = 0;
  auth.signOut();
  store.setUserToken({ access_token: "a", refresh_token: "r", expires_in: 3600 });
}

// Answers the token chain and delegates anything else to `rest`.
const withAuth = (rest) => (c) => {
  if (c.host.includes("xboxlive.com") && (c.path.includes("/user/authenticate") || c.path.includes("/xsts/authorize"))) {
    return { status: 200, body: xstsOk };
  }
  if (c.path === "/v2/login/user") return { status: 200, body: streamOk };
  return rest(c);
};

const ids = (n) => Array.from({ length: n }, (_, i) => "P" + i);

// ------------------------------------------------------------------ gssv

test("a gssv call goes to the token's own host with the token as bearer", async () => {
  reset();
  handler = withAuth((c) => ({ status: 200, body: { results: [] } }));
  await api.fetchTitles();
  const call = seen.find((c) => c.path === "/v2/titles");
  assert.equal(call.host, "weu.core.gssv-play-prod.xboxlive.com");
  assert.equal(call.headers.Authorization, "Bearer gs-token");
});

test("a rejected token is its own failure, distinct from any other", async () => {
  reset();
  handler = withAuth(() => ({ status: 401, body: "expired" }));
  await assert.rejects(() => api.fetchTitles(), (e) => e.code === "token_rejected");
  reset();
  handler = withAuth(() => ({ status: 500, body: "boom" }));
  await assert.rejects(() => api.fetchTitles(), (e) => e.code === "gssv_failed");
});

test("a title with no product id is dropped rather than sent to the catalogue", async () => {
  reset();
  handler = withAuth(() => ({
    status: 200,
    body: { results: [
      { titleId: "A", details: { productId: "P1", xboxTitleId: 1, hasEntitlement: true, supportedInputTypes: ["Controller"] } },
      { titleId: "B", details: {} },
      { details: { productId: "P3" } },
    ] },
  }));
  const titles = await api.fetchTitles();
  assert.deepEqual(titles.map((t) => t.titleId), ["A"]);
  assert.equal(titles[0].hasEntitlement, true);
});

test("a time-limited title says so, so nobody starts a demo thinking it is the game", async () => {
  reset();
  handler = withAuth(() => ({
    status: 200,
    body: { results: [{ titleId: "A", details: { productId: "P1", maxGameplayTimeInSeconds: 1800 } }] },
  }));
  assert.equal((await api.fetchTitles())[0].maxPlaySeconds, 1800);
});

// ------------------------------------------------------------------ hydration

test("hydration batches at 25 and never exceeds its concurrency", async () => {
  reset();
  handler = withAuth((c) => {
    if (!c.path.startsWith("/v3/products")) return { status: 404, body: "" };
    const sent = JSON.parse(c.body).Products;
    assert.ok(sent.length <= api.CATALOG_BATCH, "batch of " + sent.length);
    return { status: 200, body: { Products: Object.fromEntries(sent.map((p) => [p, { ProductTitle: p }])) }, delay: 20 };
  });
  const r = await api.hydrate(ids(200), { market: "DE" });
  assert.equal(Object.keys(r.products).length, 200);
  assert.equal(r.batches, 8);
  assert.ok(peakLive <= 8, "peak concurrency was " + peakLive);
  assert.ok(peakLive > 1, "the pool has to actually run batches in parallel");
});

test("a 504 batch is retried and its titles survive", async () => {
  reset();
  const failedOnce = new Set();
  handler = withAuth((c) => {
    const sent = JSON.parse(c.body).Products;
    const key = sent[0];
    if (!failedOnce.has(key)) {
      failedOnce.add(key);
      return { status: 504, body: "<HTML>gateway timeout</HTML>" };
    }
    return { status: 200, body: { Products: Object.fromEntries(sent.map((p) => [p, { ProductTitle: p }])) } };
  });
  const r = await api.hydrate(ids(75), { market: "DE" });
  assert.equal(r.failedBatches, 0);
  assert.equal(r.partial, false);
  assert.equal(Object.keys(r.products).length, 75);
});

test("a 4xx is not retried - our request will be wrong again", async () => {
  reset();
  let calls = 0;
  handler = withAuth(() => {
    calls++;
    return { status: 400, body: "bad request" };
  });
  const r = await api.hydrate(ids(25), { market: "DE" }).catch((e) => e);
  assert.equal(calls, 1, "a 400 was retried " + calls + " times");
  assert.equal(r.code, "catalog_unavailable");
});

test("some batches failing leaves a partial catalogue, not an empty one", async () => {
  reset();
  handler = withAuth((c) => {
    const sent = JSON.parse(c.body).Products;
    if (sent[0] === "P25") return { status: 503, body: "" };
    return { status: 200, body: { Products: Object.fromEntries(sent.map((p) => [p, { ProductTitle: p }])) } };
  });
  const r = await api.hydrate(ids(75), { market: "DE" });
  assert.equal(r.failedBatches, 1);
  assert.equal(r.partial, true);
  assert.equal(Object.keys(r.products).length, 50);
});

test("only every batch failing is an error", async () => {
  reset();
  handler = withAuth(() => ({ status: 503, body: "" }));
  await assert.rejects(() => api.hydrate(ids(50), { market: "DE" }), (e) => e.code === "catalog_unavailable");
});

test("the market comes from the streaming token, not a hardcoded US", async () => {
  reset();
  handler = withAuth((c) => ({ status: 200, body: { Products: {} } }));
  await api.hydrate(ids(1));
  const call = seen.find((c) => c.path.startsWith("/v3/products"));
  // A catalogue read for the wrong market answers with another country's
  // availability, and this account's market is DE.
  assert.match(call.path, /market=DE/);
  assert.equal(call.host, "catalog.gamepass.com");
});

test("duplicate product ids cost one slot, not two", async () => {
  reset();
  handler = withAuth((c) => {
    assert.equal(JSON.parse(c.body).Products.length, 2);
    return { status: 200, body: { Products: {} } };
  });
  const r = await api.hydrate(["P1", "P1", "P2"], { market: "DE" });
  assert.equal(r.batches, 1);
});

test("hydrating nothing makes no request", async () => {
  reset();
  handler = withAuth(() => { throw new Error("should not be called"); });
  const r = await api.hydrate([], { market: "DE" });
  assert.deepEqual(r, { products: {}, partial: false, batches: 0, failedBatches: 0, aborted: false });
});

// ------------------------------------------------------------------ joining

test("a title is matched by its xCloud id first, then by product id", () => {
  const titles = [
    { titleId: "T1", productId: "P1" },
    { titleId: "T2", productId: "P2" },
  ];
  const products = {
    // Keyed by the store id, carrying the xCloud id - the normal case.
    P1: { XCloudTitleId: "T1", StoreId: "P1", ProductTitle: "By xCloud id" },
    // No XCloudTitleId: a catalogue row that predates the cloud entry.
    P2: { StoreId: "P2", ProductTitle: "By store id" },
  };
  const joined = api.joinCatalogue(titles, products);
  assert.equal(joined[0].name, "By xCloud id");
  assert.equal(joined[1].name, "By store id");
});

test("a title with no catalogue row is kept and flagged, not dropped", () => {
  const joined = api.joinCatalogue([{ titleId: "T9", productId: "P9" }], {});
  assert.equal(joined.length, 1);
  assert.equal(joined[0].hydrated, false);
  assert.equal(joined[0].name, "");
});

test("a protocol-relative image URL is made absolute", () => {
  // The catalogue returns "//store-images.s-microsoft.com/...", which a page
  // served from our own origin cannot load as-is.
  assert.equal(api.imageUrl({ URL: "//store-images.s-microsoft.com/x.png" }), "https://store-images.s-microsoft.com/x.png");
  assert.equal(api.imageUrl({ Uri: "https://a/b.png" }), "https://a/b.png");
  assert.equal(api.imageUrl("//a/b.png"), "https://a/b.png");
  assert.equal(api.imageUrl(null), "");
  assert.equal(api.imageUrl({}), "");
});

test.after(() => {
  https.request = REAL_REQUEST;
  fs.rmSync(DIR, { recursive: true, force: true });
});

test("a hydration the caller abandoned reports itself as incomplete", async () => {
  // Skipped batches used to leave `failed` at zero, so the result came back
  // `partial: false` - and the library then cached a head-only catalogue as this
  // language's finished answer, which `isFresh` served for the whole TTL. The
  // next launch would not even try to refill it.
  reset();
  const controller = new AbortController();
  let served = 0;
  handler = withAuth((c) => {
    served++;
    // Give up part way through, the way a page leaving does.
    if (served === 1) controller.abort();
    const sent = JSON.parse(c.body).Products;
    return { status: 200, body: { Products: Object.fromEntries(sent.map((p) => [p, { ProductTitle: p }])) } };
  });
  const all = ids(300);
  const r = await api.hydrate(all, { market: "DE", signal: controller.signal });
  assert.equal(r.aborted, true);
  assert.equal(r.partial, true, "an incomplete answer must say so");
  assert.ok(served < Math.ceil(all.length / api.CATALOG_BATCH), "it has to actually stop: " + served);
  // What it DID fetch is still returned - the caller may show it, it just may not
  // remember it as the whole catalogue.
  assert.ok(Object.keys(r.products).length > 0);
});

test("the recent row belongs to an account, and is forgotten with it", async () => {
  // `recentCache` holds one account's Continue row and nothing in it says whose,
  // so signing out and in as somebody else inside its 30 s TTL served the previous
  // person's games. The library is invalidated on sign-out; this was not.
  reset();
  handler = withAuth((c) => {
    if (!c.path.startsWith("/v2/titles/mru")) return { status: 404, body: "" };
    return { status: 200, body: { results: [{ titleId: "A", details: { productId: "P-A" } }] } };
  });
  const first = await api.fetchRecentTitles(5);
  assert.deepEqual(first.map((t) => t.titleId), ["A"]);

  // Somebody else signs in, and the endpoint answers with THEIR row.
  api.forgetAccount();
  reset();
  handler = withAuth((c) => {
    if (!c.path.startsWith("/v2/titles/mru")) return { status: 404, body: "" };
    return { status: 200, body: { results: [{ titleId: "B", details: { productId: "P-B" } }] } };
  });
  const second = await api.fetchRecentTitles(5);
  assert.deepEqual(second.map((t) => t.titleId), ["B"], "the previous account's row was served");
});

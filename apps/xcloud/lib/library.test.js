// The cache and the ordering, which is where this app's "is it fast" lives.
//
// The numbers behind the design, measured against this account's 2531 titles: a
// raw catalogue row is 14.7 KB and the whole library of them 23.5 MB, while the
// fields a ten-foot grid reads come to 581 bytes a row - 1.45 MB for everything.
// Hydrating all of it costs ~17 s against ~0.9 s for the first fifty. So the
// library is reduced, cached, and fetched first-screen-first; it is deliberately
// NOT paged in as the grid scrolls, because a name search over 2531 titles is what
// makes a library this size usable and it cannot search rows never fetched.
//
// api.* is stubbed rather than https, because what is under test here is the
// ordering and the cache, not the requests.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-xcloud-lib-"));
const CACHE = path.join(DIR, "xcloud-library.json");
process.env.TVBOX_XCLOUD_CACHE = CACHE;

const api = require("./xcloudapi");
const library = require("./library");

const REAL = { fetchTitles: api.fetchTitles, hydrate: api.hydrate };

// A catalogue row with the weight the real one has, so the reduction assertion
// measures something.
const fatProduct = (id, name) => ({
  StoreId: id,
  ProductTitle: name,
  PublisherName: "Pub",
  Image_Tile: { URL: "//img/" + id + "-tile.png" },
  Image_Poster: { URL: "//img/" + id + "-poster.png" },
  Trailers: Array.from({ length: 6 }, (_, i) => ({ Uri: "https://video/" + id + "/" + i, Caption: "x".repeat(120) })),
  Screenshots: Array.from({ length: 8 }, (_, i) => ({ Uri: "https://shot/" + id + "/" + i })),
  ProductDescription: "d".repeat(1100),
  LanguageSupport: { en: ["audio", "text"], de: ["text"], hu: ["text"] },
  LocalizedCategories: ["Akció és kaland", "Szerepjáték"],
  Categories: ["Action & adventure", "Role playing"],
});

let calls = { titles: 0, hydrate: [] };

function stub(n, opts) {
  const o = opts || {};
  calls = { titles: 0, hydrate: [] };
  const titles = Array.from({ length: n }, (_, i) => ({
    titleId: "T" + i,
    productId: "P" + i,
    xboxTitleId: String(i),
    hasEntitlement: i % 4 === 0,
    supportedInputTypes: ["Controller"],
    maxPlaySeconds: 0,
  }));
  api.fetchTitles = async () => {
    calls.titles++;
    if (o.titlesFail) throw new Error("titles down");
    return titles;
  };
  api.hydrate = async (ids) => {
    calls.hydrate.push(ids.length);
    if (o.tailPartial && ids.length > library.FIRST_SCREEN) {
      return { products: {}, partial: true, batches: 1, failedBatches: 1 };
    }
    const products = {};
    for (const id of ids) {
      const i = Number(id.slice(1));
      products[id] = { ...fatProduct(id, o.name ? o.name(i) : "Game " + i), XCloudTitleId: "T" + i };
    }
    return { products, partial: false, batches: Math.ceil(ids.length / 25), failedBatches: 0 };
  };
  return titles;
}

const fresh = () => {
  library.invalidate();
  try {
    fs.unlinkSync(CACHE);
  } catch {
    /* already gone */
  }
};

test("the first screen is published before the rest is fetched", async () => {
  fresh();
  stub(200);
  let atFirstPaint = null;
  await library.refresh({ onFirstScreen: (s) => { atFirstPaint = s.titles.filter((t) => t.name).length; } });
  assert.equal(atFirstPaint, library.FIRST_SCREEN, "the grid must be able to draw before the tail arrives");
  // Two hydrations: the head, then the tail. Not one big one.
  assert.deepEqual(calls.hydrate, [library.FIRST_SCREEN, 200 - library.FIRST_SCREEN]);
});

test("a library that fits in one screen makes one hydration", async () => {
  fresh();
  stub(30);
  await library.refresh({});
  assert.deepEqual(calls.hydrate, [30]);
});

test("the cached row is the reduced one - the heavy catalogue fields are gone", async () => {
  fresh();
  stub(60);
  await library.refresh({});
  const raw = fs.readFileSync(CACHE, "utf8");
  for (const heavy of ["Trailers", "Screenshots", "ProductDescription", "LanguageSupport"]) {
    assert.equal(raw.includes(heavy), false, heavy + " must not reach the cache");
  }
  const row = library._state().titles[0];
  assert.deepEqual(Object.keys(row).sort(), [
    // `categories` is what a genre filter is made of - 68 bytes a title against
    // the 581 already kept.
    "categories", "hydrated", "inputs", "maxPlaySeconds", "name", "owned", "poster", "productId", "publisher", "tile", "titleId",
  ]);
  assert.equal(row.tile, "https://img/P0-tile.png");
});

test("a warm start serves the cache and asks for nothing", async () => {
  fresh();
  stub(60);
  await library.refresh({});

  // A second process: the module reloads and reads the file.
  delete require.cache[require.resolve("./library")];
  const lib2 = require("./library");
  stub(60);
  const got = await lib2.get({});
  assert.equal(got.titles.length, 60);
  assert.equal(got.cached, true);
  assert.equal(calls.titles, 0, "a fresh cache must not trigger a fetch");
  assert.deepEqual(calls.hydrate, []);
});

test("a partial hydration is not cached as complete", async () => {
  fresh();
  stub(200, { tailPartial: true });
  await library.refresh({});
  assert.equal(library._state().partial, true);

  // The next get() must refresh rather than serve incomplete names for the whole
  // 24-hour TTL.
  stub(200);
  const got = await library.get({});
  assert.equal(got.cached, true);
  assert.equal(got.stale, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.titles, 1, "a partial cache has to be refetched behind the answer");
});

test("a stale cache answers immediately and refreshes behind the answer", async () => {
  fresh();
  stub(60);
  await library.refresh({});
  // Age the cache past its TTL.
  library._state().fetchedAt = Date.now() - library.TTL_MS - 1000;

  stub(60, { name: (i) => "Renamed " + i });
  const t = Date.now();
  const got = await library.get({});
  assert.ok(Date.now() - t < 50, "a stale answer must not wait for the refresh");
  assert.equal(got.stale, true);
  assert.equal(got.titles[0].name, "Game 0", "the old rows are what is served now");

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(library._state().titles[0].name, "Renamed 0", "and the refresh lands behind it");
});

test("an empty cache waits, because there is nothing to show", async () => {
  fresh();
  stub(60);
  const got = await library.get({});
  assert.equal(got.cached, false);
  assert.equal(got.titles.length, 60);
});

test("two screens opening at once share one refresh", async () => {
  fresh();
  stub(200);
  const [a, b] = await Promise.all([library.refresh({}), library.refresh({})]);
  assert.equal(calls.titles, 1, "a second caller must not start a second 17 s pass");
  assert.equal(a, b);
});

test("a failed refresh leaves a usable cache in place", async () => {
  fresh();
  stub(60);
  await library.refresh({});
  stub(60, { titlesFail: true });
  await assert.rejects(() => library.refresh({}));
  assert.equal(library._state().titles.length, 60);
});

test("a cache written by an older shape is discarded, not read", async () => {
  fresh();
  stub(60);
  await library.refresh({});
  const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  // A version bump means the reduced row gained a field the UI now reads; reusing
  // the old rows would render blanks.
  fs.writeFileSync(CACHE, JSON.stringify({ ...raw, version: raw.version - 1 }));
  delete require.cache[require.resolve("./library")];
  const lib2 = require("./library");
  stub(60);
  await lib2.get({});
  assert.equal(calls.titles, 1);
});

test("a corrupt cache is ignored rather than crashing the app", async () => {
  fresh();
  fs.writeFileSync(CACHE, "{not json");
  delete require.cache[require.resolve("./library")];
  const lib2 = require("./library");
  stub(10);
  const got = await lib2.get({});
  assert.equal(got.titles.length, 10);
});

test("search is accent-insensitive, substring, and capped", async () => {
  fresh();
  stub(120, { name: (i) => (i === 3 ? "Pokémon Legends" : i === 7 ? "ORI and the Blind Forest" : "Game " + i) });
  await library.refresh({});
  assert.equal(library.search("pokemon")[0].name, "Pokémon Legends");
  assert.equal(library.search("POKEMON")[0].name, "Pokémon Legends");
  assert.equal(library.search("blind forest")[0].name, "ORI and the Blind Forest");
  assert.equal(library.search("game", 5).length, 5, "the cap has to hold");
  assert.deepEqual(library.search(""), []);
  assert.deepEqual(library.search("   "), []);
  assert.deepEqual(library.search("nothing here at all"), []);
});

test("find() answers by title id", async () => {
  fresh();
  stub(20);
  await library.refresh({});
  assert.equal(library.find("T5").name, "Game 5");
  assert.equal(library.find("nope"), null);
});

test("a cache that cannot be written does not fail the request", async () => {
  fresh();
  stub(20);
  const real = fs.renameSync;
  fs.renameSync = () => { throw new Error("read-only filesystem"); };
  try {
    const s = await library.refresh({});
    assert.equal(s.titles.length, 20, "the answer is the point; the cache is an optimisation");
  } finally {
    fs.renameSync = real;
  }
});


test("a cold get answers after the FIRST screen, not the whole pass", async () => {
  fresh();
  stub(400);
  // The tail is held open, so a get() that waits for the whole pass never
  // returns here. The whole pass measured 40 s on the box, which is what the
  // person was looking at while the grid said "loading".
  let releaseTail;
  const realHydrate = api.hydrate;
  api.hydrate = async (ids) => {
    calls.hydrate.push(ids.length);
    if (ids.length > library.FIRST_SCREEN) {
      await new Promise((r) => (releaseTail = r));
    }
    return realHydrate(ids);
  };

  const got = await library.get({});
  assert.equal(got.titles.length, 400);
  assert.equal(got.filling, true, "the caller has to know the tail is still coming");
  assert.equal(got.titles.filter((t) => t.name).length, library.FIRST_SCREEN);

  releaseTail();
  await new Promise((r) => setTimeout(r, 30));
  const after = await library.get({});
  assert.equal(after.titles.filter((t) => t.name).length, 400);
  assert.equal(after.filling, false, "and when it lands, that it is done");
});

test("a small library is never reported as still filling", async () => {
  fresh();
  stub(20);
  const got = await library.get({});
  assert.equal(got.filling, false);
});

test("a background refresh never makes what is served WORSE", async () => {
  fresh();
  stub(400);
  await library.refresh({});
  assert.equal(library._state().titles.filter((t) => t.name).length, 400);

  // Now a second pass, with its tail held: its head-only publish must not replace
  // 400 named rows with 50. Measured on the box, that turned a full grid into a
  // screen of blanks until the tail landed.
  let releaseTail;
  const realHydrate = api.hydrate;
  stub(400);
  api.hydrate = async (ids) => {
    calls.hydrate.push(ids.length);
    if (ids.length > library.FIRST_SCREEN) await new Promise((r) => (releaseTail = r));
    return realHydrate(ids);
  };
  const pass = library.refresh({});
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(
    library._state().titles.filter((t) => t.name).length,
    400,
    "the head-only publish has to be ignored while a complete library is being served",
  );
  releaseTail();
  await pass;
  assert.equal(library._state().titles.filter((t) => t.name).length, 400);
});

test("a refresh that fails before its first screen releases the cold get instead of hanging", async () => {
  fresh();
  stub(60, { titlesFail: true });
  // The cold path waits on the first-screen promise. A pass that dies before
  // publishing anything must still resolve it, or the screen says "loading" for
  // ever with nothing left to wait for.
  const settled = await Promise.race([
    library.get({}).then(
      (r) => ({ kind: "resolved", titles: r.titles.length }),
      (e) => ({ kind: "rejected", code: e.message }),
    ),
    new Promise((r) => setTimeout(() => r({ kind: "hung" }), 2000)),
  ]);
  assert.notEqual(settled.kind, "hung", "get must not wait on a promise nothing will resolve");
});


test("the cache is keyed on LANGUAGE, not only on age", async () => {
  fresh();
  stub(60);
  await library.get({ language: "hu-HU" });
  assert.equal(calls.titles, 1);

  // The catalogue returns its categories localised, so a Hungarian cache is the
  // WRONG answer for an English UI - and an age-only freshness check would serve
  // it for the rest of the day.
  stub(60, { name: (i) => "English " + i });
  const en = await library.get({ language: "en-US" });
  assert.equal(calls.titles, 1, "a different language has to refetch");
  // Refetching is not enough: the rows have to actually BE the new language. The
  // no-downgrade guard compares named counts, and a head-only publish of 50 over
  // 60 named rows would be skipped - leaving the categories in the language
  // nobody asked for.
  assert.equal(library._state().language, "en-US");
  assert.match(en.titles[0].name, /^English /);

  stub(60);
  await library.get({ language: "en-US" });
  assert.equal(calls.titles, 0, "and the same one must not");
});

test("switching language repeatedly does not refetch the catalogue each time", async () => {
  fresh();
  stub(60);
  await library.get({ language: "hu-HU" });
  assert.equal(calls.titles, 1);

  // One state holds one language, so a switch is a full pass - ~101 requests and
  // ~17 s. This route is an ungated GET, so a page on the box can ask for the
  // other language over and over; the SWITCH is limited, not the request.
  stub(60);
  await library.get({ language: "en-US" });
  assert.equal(calls.titles, 1, "the first switch is honoured");

  stub(60);
  const back = await library.get({ language: "hu-HU" });
  assert.equal(calls.titles, 0, "an immediate switch back is served from what is held");
  assert.equal(library._state().language, "en-US");
  assert.equal(back.titles.length, 60, "and it is still a usable answer, just not that language");
});

test("the localised categories reach the reduced row", async () => {
  fresh();
  stub(20);
  await library.refresh({ language: "hu-HU" });
  assert.deepEqual(library._state().titles[0].categories, ["Akció és kaland", "Szerepjáték"]);
});

test("a collection resolves against the library on every read, not at fetch time", async () => {
  fresh();
  stub(400);
  // The first screen asks for a collection while the catalogue is still filling.
  // A collection that captured rows THEN would hold the unnamed ones for an hour
  // - measured on the television as a row of title ids.
  let releaseTail;
  const realHydrate = api.hydrate;
  api.hydrate = async (ids) => {
    calls.hydrate.push(ids.length);
    if (ids.length > library.FIRST_SCREEN) await new Promise((r) => (releaseTail = r));
    return realHydrate(ids);
  };
  const pass = library.refresh({});
  await new Promise((r) => setTimeout(r, 30));

  const realSigl = api.fetchSigl;
  // A product from the TAIL, which has no name yet.
  api.fetchSigl = async () => ["P300"];
  try {
    assert.deepEqual(await library.collection("recentlyAdded", {}), [], "an unnamed title is left out, not drawn as its id");
    releaseTail();
    await pass;
    const after = await library.collection("recentlyAdded", {});
    assert.equal(after.length, 1);
    assert.ok(after[0].name, "and it appears with its name once the catalogue has it");
  } finally {
    api.fetchSigl = realSigl;
  }
});

test("a collection is fetched once an hour and resolved against the library", async () => {
  fresh();
  stub(60);
  await library.refresh({});
  const rows = library._state().titles;

  const realSigl = api.fetchSigl;
  let siglCalls = 0;
  // Two ids the library has and one it does not: a sigl covers console and PC
  // titles too, and one that is not streamable here must simply not appear rather
  // than becoming a tile that cannot be played.
  api.fetchSigl = async () => {
    siglCalls++;
    return [rows[3].productId, "NOT-STREAMABLE-HERE", rows[7].productId];
  };
  try {
    const got = await library.collection("recentlyAdded", { language: "en-US" });
    assert.deepEqual(got.map((x) => x.titleId), [rows[3].titleId, rows[7].titleId]);
    await library.collection("recentlyAdded", { language: "en-US" });
    assert.equal(siglCalls, 1, "an hour's cache, not a request per screen");
    // A different language is a different list, because the names are localised.
    await library.collection("recentlyAdded", { language: "hu-HU" });
    assert.equal(siglCalls, 2);
  } finally {
    api.fetchSigl = realSigl;
  }
});

test("an unknown collection is refused rather than silently empty", async () => {
  await assert.rejects(() => library.collection("nope", {}), /no such collection/);
});


test("forgetting the catalogue while a pass runs does not hand the next reader that pass", async () => {
  fresh();
  stub(400);
  let releaseTail;
  const realHydrate = api.hydrate;
  api.hydrate = async (ids) => {
    calls.hydrate.push(ids.length);
    if (ids.length > library.FIRST_SCREEN) await new Promise((r) => (releaseTail = r));
    return realHydrate(ids);
  };

  const first = library.refresh({});
  await new Promise((r) => setTimeout(r, 30));
  // Measured on the box: the running pass was already past its publish, so all it
  // had left was saveCache() - which wrote the EMPTY state to disk and answered
  // with nothing. "No games available", and an app restart did not clear it
  // because the plugin keeps running.
  library.invalidate();
  api.hydrate = realHydrate;

  const got = await library.get({});
  assert.equal(got.titles.length, 400, "the reader gets a NEW pass, not the disowned one");
  releaseTail?.();
  await first.catch(() => {});
  assert.equal(library._state().titles.length, 400, "and the disowned pass writes nothing over it");
});

test("a cold read whose fetch fails is an error, not an empty catalogue", async () => {
  fresh();
  stub(60, { titlesFail: true });
  // Answering with an empty list said "no games available" on a screen that then
  // had no way back to anything - the two states are not the same and must not
  // look the same.
  await assert.rejects(() => library.get({}), /titles down/);
});

test("a cold read that fails does not poison the next one", async () => {
  fresh();
  stub(60, { titlesFail: true });
  await assert.rejects(() => library.get({}));
  stub(60);
  const got = await library.get({});
  assert.equal(got.titles.length, 60);
});

test.after(() => {
  api.fetchTitles = REAL.fetchTitles;
  api.hydrate = REAL.hydrate;
  fs.rmSync(DIR, { recursive: true, force: true });
});

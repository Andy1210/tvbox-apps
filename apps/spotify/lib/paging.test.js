// Paging tests, driven through the real module with a stubbed https layer.
//
// This is the seam every bug in this area has lived in, and none of them were
// visible from the function alone: a row's number has to be its position in the
// PLAYLIST (an entry Spotify cannot resolve is dropped from the list but keeps
// its place there), a page that fails has to fail the read rather than come back
// as an empty page, and a collection cut at the paging bound has to say so.
//
// HOME is redirected before the module loads, because it resolves the accounts
// file at require time.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const https = require("https");
const { EventEmitter } = require("events");

const REAL_HOME = process.env.HOME;
const REAL_REQUEST = https.request;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-spotify-paging-"));
process.env.HOME = HOME;
fs.mkdirSync(path.join(HOME, ".tvbox"), { recursive: true });
fs.writeFileSync(
  path.join(HOME, ".tvbox", "spotify-accounts.json"),
  JSON.stringify({ active: "u1", list: [{ id: "u1", name: "U", token: "refresh-token" }] }),
);

// The stub stands in for https.request itself, so the module's own request()
// wrapper (timeouts, the keep-alive agent, header handling) is the code under
// test rather than something the test replaces.
let handler = () => ({ status: 500, body: "" });
const seen = [];
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.write = () => {};
  req.destroy = () => {};
  req.end = () => {
    const url = opts.path;
    seen.push(url);
    let out;
    try {
      out = handler(url, opts) || { status: 500, body: "" };
    } catch (e) {
      setImmediate(() => req.emit("error", e));
      return;
    }
    const res = new EventEmitter();
    res.statusCode = out.status;
    res.headers = out.headers || {};
    setImmediate(() => {
      if (out.body) res.emit("data", out.body);
      res.emit("end");
    });
    cb(res);
  };
  return req;
};

const api = require("./spotify_api");
api.setConfig({ rawSpotify: () => ({ clientId: "id", clientSecret: "secret" }) });

// Put back what this file took over. Node runs each test file in its own
// process, so nothing else would notice today, but a stubbed core module and a
// redirected HOME left behind are the kind of thing that only bites once
// somebody adds a second file here.
test.after(() => {
  https.request = REAL_REQUEST;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

const TOKEN = { status: 200, body: JSON.stringify({ access_token: "at", expires_in: 3600 }) };

// One playlist entry. `null` stands for what Spotify cannot resolve to a track:
// removed, or blocked in this market. It occupies a position but yields no row.
function entry(i, resolvable) {
  return { item: resolvable ? { uri: "spotify:track:t" + i, name: "T" + i, artists: [], album: {} } : null };
}
// Serve a playlist of `total` entries, `limit` at a time, dropping the entries
// whose index is in `holes`.
function playlist({ id, total, holes = [], reportTotal = true, short }) {
  return (url) => {
    if (url.indexOf("/api/token") >= 0) return TOKEN;
    if (url.indexOf("fields=snapshot_id") >= 0)
      return { status: 200, body: JSON.stringify({ snapshot_id: "s-" + id }) };
    const m = /offset=(\d+)/.exec(url);
    const offset = m ? Number(m[1]) : 0;
    const limit = Number((/limit=(\d+)/.exec(url) || [])[1] || 50);
    // `short` lets a page come back with fewer entries than asked for, which is
    // what the offsets have to survive.
    const take = short && short.at === offset ? short.n : limit;
    const items = [];
    for (let k = offset; k < Math.min(offset + take, total); k++) items.push(entry(k, holes.indexOf(k) < 0));
    const body = { items };
    if (reportTotal) body.total = total;
    return { status: 200, body: JSON.stringify(body) };
  };
}

test("a row's position is the playlist's, not the row's own index", async () => {
  handler = playlist({ id: "p1", total: 130, holes: [2, 51, 129] });
  const r = await api.getPlaylistItems("p1");
  assert.equal(r.total, 130);
  assert.equal(r.tracks.length, 127, "three entries resolve to nothing");
  assert.equal(r.truncated, false);
  // The dropped entries are gone from the rows but their places survive.
  assert.deepEqual(
    r.tracks.slice(0, 4).map((t) => t.pos),
    [0, 1, 3, 4],
  );
  assert.equal(r.tracks[r.tracks.length - 1].pos, 128);
  // Every row's pos must match the track it actually carries.
  for (const t of r.tracks) assert.equal(t.uri, "spotify:track:t" + t.pos);
});

test("positions stay right when a page comes back short", async () => {
  // The first page returning fewer entries than asked for is what makes the
  // window arithmetic interesting: everything after it is offset by the
  // difference, and a row that lies about its position starts the wrong track.
  handler = playlist({ id: "p2", total: 200, short: { at: 0, n: 48 } });
  const r = await api.getPlaylistItems("p2");
  const positions = r.tracks.map((t) => t.pos);
  assert.deepEqual(positions, [...new Set(positions)], "no position may be read twice");
  for (const t of r.tracks)
    assert.equal(t.uri, "spotify:track:t" + t.pos, "a row must carry the track at its position");
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "positions arrive in order",
  );
  assert.equal(positions[0], 0);
  assert.equal(positions[positions.length - 1], 199, "the tail is not lost");
  assert.equal(positions.length, 200, "and nothing in the middle is skipped");
});

test("a short page in the MIDDLE cannot pass as a complete read", async () => {
  // The concurrent path works out every offset before it starts, so a page that
  // comes back short mid-collection leaves entries nobody asked for. Positions
  // stay honest (each one comes from the offset that was requested), but the list
  // is missing tracks - and a list that cannot be told is short is the thing this
  // module exists to avoid.
  handler = playlist({ id: "p8", total: 300, short: { at: 100, n: 40 } });
  const r = await api.getPlaylistItems("p8");
  for (const t of r.tracks) assert.equal(t.uri, "spotify:track:t" + t.pos, "positions stay right regardless");
  if (r.tracks.length < 300) assert.equal(r.truncated, true, "an incomplete read must say it is incomplete");
});

test("a page that fails fails the whole read, even with an empty body", async () => {
  // A 429 with no body used to read as a page with nothing on it, so the list
  // came back short and called itself complete.
  let n = 0;
  const ok = playlist({ id: "p3", total: 300 });
  handler = (url, opts) => {
    if (url.indexOf("/api/token") >= 0) return TOKEN;
    if (url.indexOf("fields=snapshot_id") >= 0) return ok(url, opts);
    if (++n === 3) return { status: 429, body: "", headers: { "retry-after": "120" } };
    return ok(url, opts);
  };
  await assert.rejects(() => api.getPlaylistItems("p3"), /HTTP 429/);
});

test("a collection cut at the paging bound says so", async () => {
  handler = playlist({ id: "p4", total: 12000 });
  const r = await api.getPlaylistItems("p4");
  assert.equal(r.truncated, true, "10000 of 12000 is not a complete playlist");
  assert.equal(r.tracks.length, 10000);
});

test("... and says so even when Spotify reports no total", async () => {
  // The sequential fallback stops AT the bound, so the count it collected equals
  // the bound exactly. Comparing the two would conclude nothing was cut.
  handler = playlist({ id: "p5", total: 12000, reportTotal: false });
  const r = await api.getPlaylistItems("p5");
  assert.equal(r.tracks.length, 10000);
  assert.equal(r.truncated, true);
});

test("a collection that ends exactly on a page boundary is not called truncated", async () => {
  handler = playlist({ id: "p6", total: 100, reportTotal: false });
  const r = await api.getPlaylistItems("p6");
  assert.equal(r.tracks.length, 100);
  assert.equal(r.truncated, false, "a short page after a full one is the end, not a bound");
});

test("concurrent readers share one paging run, and a repeat read costs nothing", async () => {
  handler = playlist({ id: "p7", total: 500 });
  seen.length = 0;
  const [a, b, c] = await Promise.all([
    api.getPlaylistItems("p7"),
    api.getPlaylistItems("p7"),
    api.getPlaylistItems("p7"),
  ]);
  const itemReads = seen.filter((u) => u.indexOf("/items?") >= 0).length;
  assert.equal(itemReads, 10, "500 entries is ten pages, once, not three times over");
  assert.equal(a.tracks.length, 500);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);

  seen.length = 0;
  const again = await api.getPlaylistItems("p7");
  assert.equal(seen.length, 0, "inside the fresh window it does not even ask");
  assert.equal(again.tracks.length, 500);
});

test("Liked Songs is read whole, not to a fixed cap", async () => {
  handler = (url) => {
    if (url.indexOf("/api/token") >= 0) return TOKEN;
    const offset = Number((/offset=(\d+)/.exec(url) || [])[1] || 0);
    const items = [];
    for (let k = offset; k < Math.min(offset + 50, 640); k++) {
      items.push({ track: { uri: "spotify:track:l" + k, name: "L" + k, artists: [], album: {} } });
    }
    return { status: 200, body: JSON.stringify({ total: 640, items }) };
  };
  const r = await api.getLiked();
  assert.equal(r.tracks.length, 640, "the old build stopped at 200 with nothing to say so");
  assert.equal(r.truncated, false);
  assert.equal(r.tracks[639].pos, 639);
});

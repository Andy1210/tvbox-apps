import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlexBackend } from "../backends/plex/backend";
import type { Session } from "../backends/types";

// Every endpoint this app calls, against a real server.
//
// Skipped unless PLEX_URL and PLEX_TOKEN are in the environment, so CI - which
// has no server - runs the rest of the suite untouched. Run it against the
// household's own server with:
//
//   PLEX_URL=http://127.0.0.1:32400 PLEX_TOKEN=… npm test
//
// It exists because the fixtures pin the SHAPE of a response and this pins that
// the request was accepted at all. A parameter name that a server quietly
// ignores looks identical to one it honours until someone watches something.

const BASE = process.env.PLEX_URL;
const TOKEN = process.env.PLEX_TOKEN;

const session: Session = {
  profileId: "test",
  profileName: "test",
  token: TOKEN ?? "",
  serverId: "test",
  serverName: "test",
  baseUrl: BASE ?? "",
  location: "lan",
};

const id = { clientId: "mediaclient-live-test", deviceName: "test" };

describe.skipIf(!BASE || !TOKEN)("plex backend against a live server", () => {
  // The global stub in setup.ts exists so no ordinary test reaches the network;
  // this suite is the exception it was written for.
  beforeEach(() => vi.unstubAllGlobals());

  const backend = (): PlexBackend => new PlexBackend(session, id);

  it("lists libraries", async () => {
    const libs = await backend().libraries();
    expect(libs.length).toBeGreaterThan(0);
    expect(libs.every((l) => l.id && l.title)).toBe(true);
    expect(libs.every((l) => l.kind === "movie" || l.kind === "show")).toBe(true);
  });

  it("reads on deck", async () => {
    const deck = await backend().onDeck();
    expect(Array.isArray(deck)).toBe(true);
    // Order is the whole point of the row; assert it rather than the contents.
    const stamps = deck.map((i) => i.lastViewedAt ?? i.addedAt ?? 0);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });

  it("pages a library and reports a total", async () => {
    const b = backend();
    const [lib] = await b.libraries();
    const page = await b.libraryPage(lib.id, { offset: 0, limit: 5, sort: "titleSort" });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThanOrEqual(5);
    // Without a total the grid cannot size its scrollbar or know when to stop.
    expect(typeof page.total).toBe("number");
  });

  it("lists letter buckets and fetches one, including the non-alphabetic bucket", async () => {
    const b = backend();
    const [lib] = await b.libraries();
    const letters = await b.letters(lib.id);
    expect(letters.length).toBeGreaterThan(1);

    for (const bucket of [letters[0], letters[1]]) {
      const page = await b.letterPage(lib.id, bucket.key, { offset: 0, limit: 3 });
      // The first bucket is "#", whose key arrives percent-encoded. If it is
      // encoded a second time on the way out, this 404s or comes back empty.
      expect(page.items.length, `bucket ${bucket.title} (key ${bucket.key})`).toBeGreaterThan(0);
    }
  });

  it("reads an item with its cast", async () => {
    const b = backend();
    const [lib] = await b.libraries();
    const page = await b.libraryPage(lib.id, { offset: 0, limit: 1, sort: "titleSort" });
    const detail = await b.item(page.items[0].id);

    expect(detail.title).not.toBe("");
    expect(detail.roles.length).toBeGreaterThan(0);
    expect(detail.roles[0].id).toMatch(/^\d+$/);
  });

  it("finds an actor's work across every library", async () => {
    const b = backend();
    const libs = await b.libraries();
    const movies = libs.find((l) => l.kind === "movie");
    if (!movies) return;

    // Walk a few films until one has a cast member who also appears elsewhere -
    // the cross-library case is the whole feature, and a one-film actor proves
    // nothing about it.
    const page = await b.libraryPage(movies.id, { offset: 0, limit: 12, sort: "titleSort" });
    for (const item of page.items) {
      const detail = await b.item(item.id);
      for (const role of detail.roles.slice(0, 4)) {
        const credits = await b.personCredits(role);
        const kinds = new Set(credits.items.map((c) => c.kind));
        if (credits.items.length > 1 && kinds.has("show")) {
          // Rolled up: an actor's episodes must arrive as their series.
          expect(credits.items.every((c) => c.kind !== "episode")).toBe(true);
          return;
        }
      }
    }
  }, 120_000);

  it("builds a poster URL the server actually serves", async () => {
    const b = backend();
    const deck = await b.onDeck();
    const withArt = deck.find((i) => i.thumb);
    if (!withArt) return;

    const url = b.posterUrl(withArt, 300, 450);
    expect(url).toBeDefined();
    // The URL carries no credential - that is the point of it - so the server
    // must accept the token in a header instead. If it ever stopped doing so,
    // artwork would have to go back into the DOM with the token in it.
    expect(url).not.toContain(TOKEN!);

    const res = await fetch(url!, { headers: b.imageHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\//);
  });

  it("reads markers for an episode that has them", async () => {
    const b = backend();
    const libs = await b.libraries();
    const shows = libs.find((l) => l.kind === "show");
    if (!shows) return;

    const page = await b.libraryPage(shows.id, { offset: 0, limit: 3, sort: "titleSort" });
    for (const show of page.items) {
      const seasons = await b.children(show.id);
      if (!seasons.length) continue;
      const episodes = await b.children(seasons[0].id);
      for (const ep of episodes.slice(0, 4)) {
        const markers = await b.markers(ep.id);
        if (markers.length) {
          expect(markers.every((m) => m.endMs > m.startMs)).toBe(true);
          expect(markers.every((m) => typeof m.final === "boolean")).toBe(true);
          return;
        }
      }
    }
  }, 120_000);

  it("searches", async () => {
    const results = await backend().search("a");
    expect(Array.isArray(results)).toBe(true);
  });

  it("reads history rows, and only as many as asked for", async () => {
    const rows = await backend().history(5);

    // The bound is the assertion that matters. A container size on its own is
    // ignored by this server, and the whole history arrives instead - eighteen
    // thousand rows and nine megabytes on this one, with no error to notice.
    expect(rows.length).toBeLessThanOrEqual(5);
    if (rows.length) {
      expect(rows[0].itemId).not.toBe("");
      expect(typeof rows[0].viewedAt).toBe("number");
    }
  });

  it("caps recently-added rather than fetching the whole library", async () => {
    const items = await backend().recentlyAdded();
    expect(items.length).toBeLessThanOrEqual(24);
  });

  it("returns nothing for an empty search instead of failing", async () => {
    // An empty search box is an ordinary state; this endpoint answers a blank
    // query with a refusal rather than an empty list.
    await expect(backend().search("   ")).resolves.toEqual([]);
  });

  it("reads the scores, reviews, trailers and chapters a detail screen shows", async () => {
    const b = backend();
    const libs = await b.libraries();
    const movies = libs.find((l) => l.kind === "movie")!;
    const page = await b.libraryPage(movies.id, { offset: 0, limit: 8, sort: "titleSort" });

    let sawScore = false;
    let sawReview = false;
    let sawExtra = false;
    let sawChapter = false;
    for (const item of page.items) {
      const d = await b.item(item.id);
      sawScore ||= d.scores.length > 0;
      sawReview ||= d.reviews.length > 0;
      sawExtra ||= d.extras.length > 0;
      sawChapter ||= d.chapters.length > 0;
      for (const s of d.scores) {
        expect(s.value).toBeGreaterThan(0);
        expect(["critic", "audience"]).toContain(s.kind);
        // The source is only knowable from the icon reference, so a blank one
        // means the mapping stopped working.
        expect(s.source).not.toBe("unknown");
      }
    }
    expect(sawScore, "no scores across eight films").toBe(true);
    expect(sawReview, "no reviews across eight films").toBe(true);
    expect(sawExtra, "no trailers across eight films").toBe(true);
    expect(sawChapter, "no chapters across eight films").toBe(true);
  }, 120_000);

  it("resolves a stream the player can actually take", async () => {
    const b = backend();
    const libs = await b.libraries();
    const movies = libs.find((l) => l.kind === "movie")!;
    const page = await b.libraryPage(movies.id, { offset: 0, limit: 1, sort: "titleSort" });
    const session = `test-${Date.now()}`;

    const decision = await b.resolveStream(page.items[0].id, { session, panel: { width: 3840, height: 2160 } });
    try {
      expect(decision.url).toMatch(/^https?:\/\//);
      // The URL has to be fetchable: a direct-play part answers 401 without the
      // token, and the transcoder answers 400 when it cannot find a profile for
      // this client - both of which look like a working URL until it is used.
      const res = await fetch(decision.url, { headers: { Range: "bytes=0-1023" } });
      expect([200, 206]).toContain(res.status);
    } finally {
      await b.endSession(session);
    }
  }, 60_000);

  it("reports progress without disturbing what is stored", async () => {
    const b = backend();
    const deck = await b.onDeck();
    const item = deck.find((i) => i.viewOffsetMs && i.durationMs);
    if (!item) return;

    // Re-report exactly where the server already thinks playback is. The call
    // has to be accepted; writing a different position would move a household
    // member's resume point for a test.
    await expect(b.reportProgress(item.id, item.viewOffsetMs!, item.durationMs!, "paused")).resolves.toBeUndefined();
  });

  it("lists transcode sessions so orphans can be reaped", async () => {
    // Nothing of ours is running, so the answer is zero - what is being checked
    // is that the endpoint exists and the shape parses, since this is the only
    // backstop for a window that was killed while hidden.
    await expect(backend().reapOwnSessions()).resolves.toBe(0);
  });
});

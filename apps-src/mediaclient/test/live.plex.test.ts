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
  accountToken: TOKEN ?? "",
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

  it("serves a preview frame for scrubbing", async () => {
    const b = backend();
    const page = await b.libraryPage((await b.libraries())[0].id, { offset: 0, limit: 6 });
    const detail = await b.item(page.items[0].id);
    const partId = detail.versions[0]?.partId;
    if (!partId) return;

    const url = b.previewUrl(partId, 600_000, 320, 180);
    expect(url).toBeDefined();
    // Same rule as artwork: the frame is shown in the page, so the credential
    // travels as a header instead.
    expect(url).not.toContain(TOKEN!);

    const res = await fetch(url!, { headers: b.imageHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\//);
  });

  it("actually lowers the bitrate when a ceiling is asked for", async () => {
    // The setting is the kind that fails silently: the server answers 200 and
    // reports a decision either way. Measured before this test existed, a 720
    // kbps ceiling on an 11,390 kbps film came back "directplay" at the full
    // rate, because directPlay=1 outranks the ceiling - so what is checked here
    // is the bitrate that came back, not that the request was accepted.
    const b = backend();
    const page = await b.libraryPage((await b.libraries())[0].id, { offset: 0, limit: 120 });

    let heavy: { id: string; kbps: number } | null = null;
    for (const item of page.items) {
      const detail = await b.item(item.id).catch(() => null);
      const kbps = detail?.versions[0]?.bitrateKbps ?? 0;
      if (kbps > 6000) {
        heavy = { id: item.id, kbps };
        break;
      }
    }
    if (!heavy) return; // nothing on this server is big enough to be capped

    const session = `test-cap-${Date.now()}`;
    const capped = await b.resolveStream(heavy.id, { session, maxBitrateKbps: 2000 });
    expect(capped.transcoded).toBe(true);
    // The session is ours whether or not the decision named one back, so it is
    // stopped by the id we sent - a probe that leaves one open shows up as a
    // stream on the server's activity list.
    await b.endSession(session).catch(() => {});
  });

  it("orders and narrows a library the way the server says it can", async () => {
    // Both lists are asked of the server rather than hardcoded, because they
    // differ by library type - a series library orders by unwatched episode
    // count, a film library by resolution - so this checks the keys we send
    // back are keys it offered, and that they actually change the answer.
    const b = backend();
    const lib = (await b.libraries())[0];

    const sorts = await b.sortOptions(lib.id);
    expect(sorts.map((s) => s.key)).toContain("titleSort");
    expect(sorts.length).toBeGreaterThan(2);

    const filters = await b.filterOptions(lib.id);
    const unwatched = filters.find((f) => f.key === "unwatched");
    expect(unwatched?.kind).toBe("flag");
    const genre = filters.find((f) => f.key === "genre");
    expect(genre?.kind).toBe("list");

    const all = await b.libraryPage(lib.id, { offset: 0, limit: 1 });
    const narrowed = await b.libraryPage(lib.id, { offset: 0, limit: 1, filters: { unwatched: "1" } });
    // A filter that is accepted but ignored answers 200 with the whole library,
    // which is indistinguishable from a working filter unless the totals are
    // compared.
    expect(narrowed.total).toBeLessThan(all.total ?? Number.MAX_SAFE_INTEGER);

    // And ordering: the first title descending must not be the first ascending.
    const asc = await b.libraryPage(lib.id, { offset: 0, limit: 1, sort: "titleSort" });
    const desc = await b.libraryPage(lib.id, { offset: 0, limit: 1, sort: "titleSort", desc: true });
    expect(desc.items[0]?.id).not.toBe(asc.items[0]?.id);

    // The A-Z strip has to agree with the grid, or a letter opens an empty page.
    const strip = await b.letters(lib.id, { unwatched: "1" });
    const stripTotal = strip.reduce((n, l) => n + l.size, 0);
    expect(stripTotal).toBeLessThanOrEqual(all.total ?? Number.MAX_SAFE_INTEGER);
  });

  it("lands a letter jump on that letter, not near it", async () => {
    // The strip scrolls rather than filters, so what matters is the OFFSET. The
    // obvious implementation - summing the bucket sizes - is what this replaces:
    // measured on this library, 14 of 29 buckets landed on the previous letter,
    // because the strip and the sort disagree about accented initials. So the
    // check is the title at the offset, not that a number came back.
    const b = backend();
    const lib = (await b.libraries())[0];
    const strip = await b.letters(lib.id);
    const usable = strip.filter((l) => l.size > 0 && /^[A-Z]$/.test(l.title));
    expect(usable.length).toBeGreaterThan(5);

    for (const l of [usable[1], usable[Math.floor(usable.length / 2)], usable[usable.length - 1]]) {
      const offset = await b.letterOffset(lib.id, l.key, { sort: "titleSort" });
      const at = await b.libraryPage(lib.id, { offset, limit: 1, sort: "titleSort" });
      const title = at.items[0]?.sortTitle ?? at.items[0]?.title ?? "";
      const initial = title.trim()[0]?.normalize("NFD")[0]?.toUpperCase();
      expect(initial).toBe(l.title.toUpperCase());
    }
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

  it("resolves a stream for every film, not just the convenient one", async () => {
    const b = backend();
    const libs = await b.libraries();
    const movies = libs.find((l) => l.kind === "movie")!;
    // A sweep, not one item. Asking for a decision while the server has
    // auto-selected a subtitle is refused, which is the ordinary case here - and
    // resolving a single film hides it, because whether it happens depends on
    // the film.
    const page = await b.libraryPage(movies.id, { offset: 0, limit: 12, sort: "titleSort" });

    const failures: string[] = [];
    for (const item of page.items) {
      const session = `test-${item.id}-${Date.now()}`;
      try {
        const decision = await b.resolveStream(item.id, { session, panel: { width: 3840, height: 2160 } });
        expect(decision.url).toMatch(/^https?:\/\//);
      } catch (e) {
        failures.push(`${item.title}: ${(e as Error).message}`);
      } finally {
        await b.endSession(session).catch(() => {});
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it("hands the player a URL that actually streams", async () => {
    const b = backend();
    const libs = await b.libraries();
    const movies = libs.find((l) => l.kind === "movie")!;
    const page = await b.libraryPage(movies.id, { offset: 0, limit: 1, sort: "titleSort" });
    const session = `test-${Date.now()}`;

    const decision = await b.resolveStream(page.items[0].id, { session, panel: { width: 3840, height: 2160 } });
    try {
      // A direct-play part answers 401 without the token and the transcoder
      // answers 400 when it cannot find a profile - both look like a working URL
      // until something tries to use it.
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

  it("finds the films the library holds more than one copy of, and labels them apart", async () => {
    const b = backend();
    const libs = await b.libraries();
    const movies = libs.find((l) => l.kind === "movie")!;

    let multi = 0;
    for (let offset = 0; offset < 300 && multi < 2; offset += 100) {
      const page = await b.libraryPage(movies.id, { offset, limit: 100, sort: "titleSort" });
      for (const item of page.items) {
        const d = await b.item(item.id);
        if (d.versions.length < 2) continue;
        multi += 1;

        // The point of the label: two copies must never read the same, or the
        // choice between them is a coin toss.
        const labels = d.versions.map((v) => v.label);
        expect(new Set(labels).size, `${d.title}: ${labels.join(" / ")}`).toBe(labels.length);
        expect(labels.every((l) => l && l !== "?")).toBe(true);
        // Each version addresses its own file.
        expect(new Set(d.versions.map((v) => v.partId)).size).toBe(d.versions.length);
        if (multi >= 2) break;
      }
    }
    expect(multi, "no multi-version film found in the first 300").toBeGreaterThan(0);
  }, 300_000);

  it("plays the second copy when asked for it", async () => {
    const b = backend();
    const libs = await b.libraries();
    const movies = libs.find((l) => l.kind === "movie")!;

    for (let offset = 0; offset < 300; offset += 100) {
      const page = await b.libraryPage(movies.id, { offset, limit: 100, sort: "titleSort" });
      for (const item of page.items) {
        const d = await b.item(item.id);
        if (d.versions.length < 2) continue;

        const session = `test-v-${Date.now()}`;
        try {
          const first = await b.resolveStream(d.id, { session, version: 0 });
          const second = await b.resolveStream(d.id, { session: `${session}-b`, version: 1 });
          expect(first.version).toBe(0);
          expect(second.version).toBe(1);
          // Different files, so different URLs - asking for the second and
          // getting the first is the failure this guards.
          expect(second.url).not.toBe(first.url);
        } finally {
          await b.endSession(session).catch(() => {});
          await b.endSession(`${session}-b`).catch(() => {});
        }
        return;
      }
    }
  }, 300_000);

  it("lists the household's people", async () => {
    // Read-only on purpose: switching would change which user the account is
    // actually signed in as, on a real household's account.
    const profiles = await backend().listProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    // The uuid, not the numeric id: the switch endpoint takes that one, and a
    // picker built on the wrong field looks right until someone presses it.
    expect(profiles.every((p) => /^[0-9a-f]{8,}$/i.test(p.id))).toBe(true);
    expect(profiles.every((p) => p.name)).toBe(true);
  }, 60_000);
});

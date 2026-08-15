import { describe, it, expect, beforeEach, vi } from "vitest";
import { JellyfinBackend } from "../backends/jellyfin/backend";
import type { Session } from "../backends/types";

// Every endpoint this app calls, against a real Jellyfin server.
//
// Skipped unless the environment names one, so CI - which has no server - runs
// the rest of the suite untouched:
//
//   JELLYFIN_URL=http://127.0.0.1:8096 JELLYFIN_TOKEN=… JELLYFIN_USER=… npm test
//
// It exists for the reason the Plex one does: a fixture pins the SHAPE of an
// answer, and this pins that the request was accepted at all. Jellyfin ignores
// a parameter it does not know rather than refusing it, so a misspelled sort
// key looks exactly like a working one until somebody looks at the order.
//
// It only READS. Nothing here reports progress, marks anything watched or
// starts a session, because the server it is aimed at holds the household's
// real library.

const BASE = process.env.JELLYFIN_URL;
const TOKEN = process.env.JELLYFIN_TOKEN;
const USER = process.env.JELLYFIN_USER;

const session: Session = {
  profileId: USER ?? "",
  profileName: "test",
  token: TOKEN ?? "",
  accountToken: TOKEN ?? "",
  serverId: "test",
  serverName: "test",
  baseUrl: BASE ?? "",
  location: "lan",
};

const backend = new JellyfinBackend(session, { deviceId: "live-test", deviceName: "live-test" });
const live = BASE && TOKEN && USER ? describe : describe.skip;

live("a real Jellyfin server", () => {
  // The suite's setup stubs fetch away so no test reaches the network by
  // accident. This one is the exception, and says so.
  beforeEach(() => vi.unstubAllGlobals());

  it("lists the libraries, and each one has a kind we model", async () => {
    const libs = await backend.libraries();
    expect(libs.length).toBeGreaterThan(0);
    for (const l of libs) {
      expect(l.id).toBeTruthy();
      expect(l.title).toBeTruthy();
      expect(["movie", "show", "other"]).toContain(l.kind);
    }
  });

  it("pages a library, and the page is the size that was asked for", async () => {
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const page = await backend.libraryPage(movies.id, { offset: 0, limit: 5 });

    expect(page.items.length).toBe(5);
    expect(page.total).toBeGreaterThan(5);
    // The whole point of asking for a page: the offset has to move it.
    const second = await backend.libraryPage(movies.id, { offset: 5, limit: 5 });
    expect(second.items[0].id).not.toBe(page.items[0].id);
    for (const it of page.items) {
      expect(it.title, "a title on every tile").toBeTruthy();
      expect(it.kind).toBeTruthy();
    }
  });

  it("sorts in the order it was told to", async () => {
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const asc = await backend.libraryPage(movies.id, { offset: 0, limit: 3, sort: "SortName" });
    const desc = await backend.libraryPage(movies.id, { offset: 0, limit: 3, sort: "SortName", desc: true });
    // A parameter the server ignored would give the same three titles twice.
    expect(desc.items[0].id).not.toBe(asc.items[0].id);
  });

  it("answers a detail with the parts a detail screen draws", async () => {
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const page = await backend.libraryPage(movies.id, { offset: 0, limit: 1 });
    const detail = await backend.item(page.items[0].id);

    expect(detail.id).toBe(page.items[0].id);
    expect(detail.versions.length, "at least one file to play").toBeGreaterThan(0);
    const v = detail.versions[0];
    expect(v.partId, "the file the server addresses by").toBeTruthy();
    expect(v.audio.length, "a film has at least one audio track").toBeGreaterThan(0);
    // Ordinals are what the box's player counts, so they have to start at 0 and
    // run without a gap for everything inside the file.
    const inside = v.audio.filter((t) => !t.external).map((t) => t.ordinal);
    expect(inside).toEqual(inside.map((_, i) => i));
    expect(Array.isArray(detail.roles)).toBe(true);
    expect(Array.isArray(detail.chapters)).toBe(true);
  });

  it("finds something by name", async () => {
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const page = await backend.libraryPage(movies.id, { offset: 0, limit: 1 });
    const word = (page.items[0].title.split(/\s+/)[0] || "").slice(0, 6);

    const hits = await backend.search(word);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("names the genres this library actually has", async () => {
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const genres = await backend.filterValues(movies.id, "genre");
    expect(genres.length).toBeGreaterThan(0);
    expect(genres[0].key).toBeTruthy();

    // And filtering by one has to narrow the library rather than be ignored -
    // which is the failure this server makes silent.
    const all = await backend.libraryPage(movies.id, { offset: 0, limit: 1 });
    const filtered = await backend.libraryPage(movies.id, {
      offset: 0,
      limit: 1,
      filters: { genre: genres[0].key },
    });
    expect(filtered.total).toBeGreaterThan(0);
    expect(filtered.total!).toBeLessThan(all.total!);
  });

  it("builds an artwork URL that answers without a credential", async () => {
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const page = await backend.libraryPage(movies.id, { offset: 0, limit: 1 });
    const url = backend.posterUrl(page.items[0], 300, 450);
    expect(url).toBeTruthy();
    expect(url, "no credential belongs in an artwork URL").not.toContain("api_key");

    const res = await fetch(url!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("image");
  });

  it("decides a stream and hands back a URL the player can open", async () => {
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const page = await backend.libraryPage(movies.id, { offset: 0, limit: 1 });
    const decision = await backend.resolveStream(page.items[0].id, { session: "live-test" });

    expect(decision.url).toMatch(/^https?:\/\//);
    expect(decision.version).toBe(0);
    expect(typeof decision.transcoded).toBe("boolean");
    // A HEAD rather than a GET: this is a film, and the point is only that the
    // server accepts the URL.
    const res = await fetch(decision.url, { method: "HEAD" });
    expect([200, 206]).toContain(res.status);
  });

  it("asks for markers without failing on a film that has none", async () => {
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const page = await backend.libraryPage(movies.id, { offset: 0, limit: 1 });
    const markers = await backend.markers(page.items[0].id);
    expect(Array.isArray(markers)).toBe(true);
  });


  it("builds an A-Z strip whose letters land where they say", async () => {
    // The strip is an accelerator, and an accelerator that arrives at the wrong
    // letter is worse than none - the sibling backend records 14 of 29 buckets
    // landing on the PREVIOUS letter when the offset was summed from the bucket
    // sizes instead of asked for. So this checks the landing, not the arithmetic.
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const letters = await backend.letters(movies.id);
    expect(letters.length).toBeGreaterThan(5);
    expect(letters.every((l) => l.size > 0), "a letter nobody can press must not be shown").toBe(true);

    const target = letters.find((l) => l.key === "S") ?? letters[letters.length - 1];
    const offset = await backend.letterOffset(movies.id, target.key, {});
    const page = await backend.libraryPage(movies.id, { offset, limit: 3, sort: "SortName" });

    const first = (page.items[0]?.sortTitle || page.items[0]?.title || "").trim();
    expect(first.slice(0, 1).toUpperCase(), `landing on ${target.key}`).toBe(target.key);
  });

  it("takes the screens' own default sort without the server refusing it", async () => {
    // The screens seed the OTHER backend's key, `titleSort`, and pass it on
    // every page. It is not a member of this server's sort enum, so it is
    // either ignored or refused - and refused means every library tile opens
    // onto "Try again".
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie") ?? libs[0];
    const seeded = await backend.libraryPage(movies.id, { offset: 0, limit: 3, sort: "titleSort" });
    const named = await backend.libraryPage(movies.id, { offset: 0, limit: 3, sort: "SortName" });
    expect(seeded.items.map((i) => i.id)).toEqual(named.items.map((i) => i.id));
  });
});

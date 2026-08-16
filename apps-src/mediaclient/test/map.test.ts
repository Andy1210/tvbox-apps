import { describe, it, expect } from "vitest";
import { onDeckOrder, rollUpEpisodes, toDetail, toItem, toLibrary, toMarkers } from "../backends/plex/map";
import type { MediaItem } from "../backends/types";
import sections from "./fixtures/sections.json";
import ondeck from "./fixtures/ondeck.json";
import movieDetail from "./fixtures/movie_detail.json";
import episodeMarkers from "./fixtures/episode_markers.json";
import firstCharacter from "./fixtures/firstcharacter.json";

// The fixtures carry the SHAPE of a real server's answers with invented
// contents. Invented deliberately: a real dump of this data is a household's
// viewing record - what they watch, when the television was on, which titles a
// child started - and this registry is public. Every assertion below is about
// shape and ordering, so nothing is lost by making the data up.
//
// Watch state feeds the continue-watching row and the house assistant's
// recommendations, so a mistake in this mapper is a data bug that surfaces
// somewhere else entirely.

const md = (f: { MediaContainer: { Metadata?: unknown[] } }) => (f.MediaContainer.Metadata ?? []) as never[];

describe("library mapping", () => {
  it("keeps only the libraries this app can show", () => {
    const libs = (sections.MediaContainer.Directory ?? []).map(toLibrary);
    const kinds = libs.map((l) => l.kind);

    // The server also serves music and photos; those are not v1 surfaces, but
    // they must map to something rather than crash the list.
    expect(kinds).toContain("movie");
    expect(kinds).toContain("show");
    expect(libs.every((l) => l.id !== "")).toBe(true);
  });
});

describe("item mapping", () => {
  it("carries the watch-state fields the rest of the app reads", () => {
    const item = toItem(md(ondeck)[0]);

    expect(item.id).not.toBe("");
    expect(item.kind).toBe("episode");
    expect(typeof item.viewOffsetMs).toBe("number");
    expect(typeof item.lastViewedAt).toBe("number");
  });

  it("falls back up the art chain so a poster grid has no holes", () => {
    // An episode's own thumb is a still from that episode; a season carries the
    // show's. Whichever exists, something must come out.
    const episodes = md(ondeck)
      .map(toItem)
      .filter((i: MediaItem) => i.kind === "episode");
    expect(episodes.length).toBeGreaterThan(0);
    expect(episodes.every((e: MediaItem) => typeof e.thumb === "string" && e.thumb.length > 0)).toBe(true);
  });
});

describe("on-deck order", () => {
  it("puts the most recently touched item first", () => {
    const ordered = onDeckOrder(md(ondeck).map(toItem));
    const stamps = ordered.map((i) => i.lastViewedAt ?? i.addedAt ?? 0);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });

  it("does not sink an item that has never been viewed", () => {
    // The next unwatched episode of a series carries no last-viewed stamp at
    // all. Sorting on that field alone would bury it under films abandoned years
    // ago, which is the opposite of what a continue-watching row is for.
    const never: MediaItem = { id: "n", kind: "episode", title: "Never watched", addedAt: 9_999_999_999 };
    const old: MediaItem = { id: "o", kind: "movie", title: "Watched long ago", lastViewedAt: 1_000_000 };

    expect(onDeckOrder([old, never])[0].id).toBe("n");
  });
});

describe("cast mapping", () => {
  it("keeps the id the server uses for this person in every library", () => {
    const detail = toDetail(md(movieDetail)[0]);

    expect(detail.roles.length).toBeGreaterThan(0);
    const role = detail.roles[0];
    expect(role.id).toMatch(/^\d+$/);
    expect(role.name).not.toBe("");
    // The per-item filter spells the same query ("actor=<id>"), so the two must
    // agree - if they ever drift, the person page silently returns nothing.
    const raw = (md(movieDetail)[0] as unknown as { Role: { filter: string }[] }).Role[0];
    expect(raw.filter).toBe(`actor=${role.id}`);
  });

  it("drops a role with no usable id rather than offering a dead link", () => {
    const detail = toDetail({ Role: [{ tag: "Nameless" }, { id: 1, tag: "Real" }] });
    expect(detail.roles.map((r) => r.name)).toEqual(["Real"]);
  });
});

describe("markers", () => {
  it("reads a credits marker off a real episode", () => {
    const markers = toMarkers(md(episodeMarkers)[0]);
    const credits = markers.find((m) => m.type === "credits");

    expect(credits).toBeDefined();
    expect(credits!.startMs).toBeGreaterThan(0);
    expect(credits!.endMs).toBeGreaterThan(credits!.startMs);
  });

  it("treats an absent `final` as non-final", () => {
    // The attribute is only ever present-and-true: a credits run that does not
    // reach the end of the file simply omits it. Comparing against `false` would
    // match nothing, and auto-advance would fire on a mid-credits scene.
    const [midCredits, realEnd] = toMarkers({
      Marker: [
        { type: "credits", startTimeOffset: 100, endTimeOffset: 200 },
        { type: "credits", startTimeOffset: 300, endTimeOffset: 400, final: true },
      ],
    });

    expect(midCredits.final).toBe(false);
    expect(realEnd.final).toBe(true);
  });

  it("sorts markers by position so the first one encountered is first", () => {
    const markers = toMarkers({
      Marker: [
        { type: "credits", startTimeOffset: 900, endTimeOffset: 1000, final: true },
        { type: "intro", startTimeOffset: 10, endTimeOffset: 90 },
      ],
    });
    expect(markers.map((m) => m.type)).toEqual(["intro", "credits"]);
  });
});

describe("episode roll-up", () => {
  it("collapses many episodes of one series into that series", () => {
    // A guest star is tagged on the episode, not the series, so their credits
    // come back as a pile of episodes. Nine rows of one show is not an answer to
    // "what else were they in".
    const credits: MediaItem[] = [
      { id: "1", kind: "movie", title: "A film" },
      { id: "2", kind: "episode", title: "Ep 1", grandparentTitle: "A series", grandparentId: "100" },
      { id: "3", kind: "episode", title: "Ep 2", grandparentTitle: "A series", grandparentId: "100" },
      { id: "4", kind: "episode", title: "Ep 1", grandparentTitle: "Another series", grandparentId: "200" },
    ];

    const rolled = rollUpEpisodes(credits);

    expect(rolled.map((r) => r.title).sort()).toEqual(["A film", "A series", "Another series"]);
    expect(rolled.every((r) => r.kind !== "episode")).toBe(true);
  });

  it("carries the series id, not the episode's", () => {
    // The tile opens whatever id it holds. An episode id opens an episode page
    // under a series title, and asking a server for an episode's children is an
    // error rather than an empty list - so the season list dies with it.
    const [series] = rollUpEpisodes([
      {
        id: "39451",
        kind: "episode",
        title: "Chapter 8",
        grandparentTitle: "A series",
        grandparentId: "39432",
        thumb: "/still",
        grandparentThumb: "/poster",
      },
    ]);

    expect(series.id).toBe("39432");
    // The series' own poster too: an episode's thumb is a still from it.
    expect(series.thumb).toBe("/poster");
  });

  it("does not duplicate a series that is already listed in its own right", () => {
    const rolled = rollUpEpisodes([
      { id: "100", kind: "show", title: "A series" },
      { id: "e", kind: "episode", title: "Ep 1", grandparentTitle: "A series", grandparentId: "100" },
    ]);

    expect(rolled).toHaveLength(1);
    expect(rolled[0].kind).toBe("show");
  });

  it("keeps two series apart when they share a name", () => {
    // Deduping on the title would collapse a remake into its original.
    const rolled = rollUpEpisodes([
      { id: "e1", kind: "episode", title: "Ep", grandparentTitle: "Same Name", grandparentId: "1" },
      { id: "e2", kind: "episode", title: "Ep", grandparentTitle: "Same Name", grandparentId: "2" },
    ]);

    expect(rolled.map((r) => r.id).sort()).toEqual(["1", "2"]);
  });

  it("drops an episode with no series id rather than linking somewhere wrong", () => {
    expect(rollUpEpisodes([{ id: "e", kind: "episode", title: "Ep", grandparentTitle: "A series" }])).toEqual([]);
  });
});

describe("letter buckets", () => {
  it("reads the server's own bucket list", () => {
    const buckets = firstCharacter.MediaContainer.Directory ?? [];
    expect(buckets.length).toBeGreaterThan(10);
    expect(buckets.every((b) => typeof b.size === "number" && b.size > 0)).toBe(true);
  });

  it("cannot be turned into offsets, which is why the app does not try", () => {
    // The bucket list orders accented initials after Z, while the sorted grid
    // interleaves them where the language puts them. A running sum of the sizes
    // therefore drifts partway through the alphabet - measured on this server,
    // 13 of 29 buckets land on the wrong title. The app asks the server for a
    // letter's items instead; this test pins the reason so nobody optimises it
    // back into arithmetic.
    const titles = (firstCharacter.MediaContainer.Directory ?? []).map((b) => b.title);
    const zIndex = titles.indexOf("Z");
    const accented = titles.findIndex((t) => /[^\x00-\x7F]/.test(t));

    expect(zIndex).toBeGreaterThanOrEqual(0);
    expect(accented).toBeGreaterThan(zIndex);
  });
});

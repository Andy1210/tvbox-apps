import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The action row on a detail screen, and the room it leaves the synopsis.
 *
 * The buttons were three lines - play and marking, then audio and subtitles,
 * then the versions - and on a season screen the synopsis describes the
 * HIGHLIGHTED episode, so it is what somebody moving along the row is reading.
 * Bringing the row to the top of the view took it off the screen, and the three
 * lines were what made the distance.
 */

import type { ItemDetail, MediaItem, MediaVersion } from "../backends/types";

const { setupRemote, flushFocus, setFocus, getCurrentFocusKey, remote, place } = await import("./remote");
setupRemote();

let n = 0;

function version(): MediaVersion {
  return {
    mediaIndex: 0,
    partIndex: 0,
    parts: 1,
    label: "1080p",
    audio: [
      { ordinal: 0, id: "a0", kind: "audio", label: "Magyar", language: "Hungarian" },
      { ordinal: 1, id: "a1", kind: "audio", label: "English", language: "English" },
    ],
    subtitles: [{ ordinal: 0, id: "s0", kind: "subtitle", label: "Magyar", language: "Hungarian" }],
  };
}

function detailOf(item: MediaItem): ItemDetail {
  return {
    ...item,
    roles: [],
    extras: [],
    reviews: [],
    scores: [],
    chapters: [],
    versions: item.kind === "episode" ? [version()] : [],
  } as ItemDetail;
}

interface Harness {
  season: MediaItem;
  episodes: MediaItem[];
}

/**
 * A season of two episodes.
 *
 * `inProgress` is the point of half of these: a season carries no resume point
 * of its own, so what Play would carry on with is only knowable from the
 * episodes under it.
 */
async function open(opts?: { inProgress?: boolean; watched?: boolean }): Promise<Harness> {
  const { render, act } = await import("@testing-library/react");
  const { configureI18n } = await import("@sdk");
  const { Detail } = await import("../Detail");
  const { useApp } = await import("../state");
  const en = (await import("../locales/en.json")).default;
  const hu = (await import("../locales/hu.json")).default;
  configureI18n({ hu, en }, { fallback: "en" });

  n += 1;
  const season: MediaItem = { id: `season${n}`, kind: "season", title: "1. évad", index: 1, parentId: `show${n}` };
  const episodes: MediaItem[] = [
    {
      id: `ep1-${n}`,
      kind: "episode",
      title: "Első rész",
      index: 1,
      parentIndex: 1,
      parentId: season.id,
      durationMs: 1_800_000,
      viewOffsetMs: opts?.inProgress ? 600_000 : undefined,
      viewCount: opts?.watched ? 1 : 0,
    },
    { id: `ep2-${n}`, kind: "episode", title: "Második rész", index: 2, parentIndex: 1, parentId: season.id },
  ];
  const byId = new Map<string, MediaItem>([[season.id, season], ...episodes.map((e) => [e.id, e] as const)]);

  useApp.setState({
    backend: {
      kind: "plex",
      item: async (id: string) => detailOf(byId.get(id) ?? season),
      children: async (id: string) => (id === season.id ? episodes : []),
      setWatched: async () => {},
      posterUrl: () => undefined,
      artUrl: () => undefined,
      backdropUrl: () => undefined,
      themeUrl: () => undefined,
      imageHeaders: () => ({}),
      markers: async () => [],
    } as never,
    screen: { name: "item", itemId: season.id },
    history: [],
    failure: null,
  });

  render(<Detail itemId={season.id} />);
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
  return { season, episodes };
}

const el = (key: string): HTMLElement | null => document.querySelector(`[data-sfocus="${key}"]`);
const text = (key: string): string => el(key)?.textContent ?? "";
const name = (key: string): string => el(key)?.getAttribute("aria-label") ?? "";

/** Let time pass the press-bounce guard, which is real-clock. */
async function settleClock(): Promise<void> {
  await new Promise((r) => setTimeout(r, 450));
}

async function press(key: string): Promise<void> {
  const { act } = await import("@testing-library/react");
  const btn = el(key);
  expect(btn, `the ${key} button`).toBeTruthy();
  await act(async () => {
    btn!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  // Twice: a press that opens a panel mounts new focusables, and the one-shot
  // initial focus inside it lands a tick after the mount.
  await flushFocus();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushFocus();
}

async function focusOn(key: string): Promise<void> {
  const { act } = await import("@testing-library/react");
  await setFocus(key);
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("what Play says on a season", () => {
  it("carries on, and offers the start, when an episode is half watched", async () => {
    // A season has no resume point of its own, so asking `detail` for one was
    // always false here: the button said "Play" over a half-watched episode and
    // the restart button - which only exists beside a resume - was never
    // rendered at all, on any season screen there has ever been.
    await open({ inProgress: true });
    expect(name("detail-play")).toContain("Carry on");
    expect(el("detail-restart"), "and the way back to the beginning comes with it").toBeTruthy();
  });

  it("starts, with no way back to a beginning nobody left", async () => {
    await open();
    expect(name("detail-play")).toContain("Play");
    expect(name("detail-play")).not.toContain("Carry on");
    expect(el("detail-restart")).toBeNull();
  });

  it("names the episode it would start, which is not the one under the cursor", async () => {
    // Play takes the episode in progress, or else the first unwatched, and the
    // cursor is somewhere else entirely - so without the designation this is
    // the one control on the screen whose target nothing names.
    const h = await open({ inProgress: true });
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    expect(name("detail-play"), "the half-watched one, not the highlighted one").toContain("S1E1");
  });
});

describe("the marking button", () => {
  it("draws the tick this app already uses, rather than spelling itself out", async () => {
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    // A glyph, so the row fits on one line - but never a nameless one.
    expect(text("detail-watched"), "no words while the cursor is elsewhere").toBe("");
    expect(name("detail-watched")).toContain("Mark as watched");
    expect(el("detail-watched")?.querySelector("svg"), "the tile's own tick").toBeTruthy();
  });

  it("spells itself out while it is focused, designation and all", async () => {
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    await focusOn("detail-watched");
    expect(text("detail-watched")).toContain("S1E2");
    expect(text("detail-watched")).toContain("Mark as watched");
  });

  it("takes its words back when the cursor leaves the row", async () => {
    // The SDK's button reports focus and has no blur, so a label opened by one
    // and never closed stays open behind whatever the cursor moved on to.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await focusOn("detail-watched");
    expect(text("detail-watched")).not.toBe("");
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    expect(text("detail-watched"), "back to a glyph").toBe("");
  });
});

describe("the overflow button", () => {
  it("holds what a screen does not need every time", async () => {
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await press("detail-more");
    expect(text("more-lang")).toContain("Audio and subtitles");
    expect(text("more-watched-season")).toContain("Mark season as watched");
  });

  it("refuses the press that opened it, arriving again by itself", async () => {
    // The remote repeats and it bounces - measured on the box, twice within
    // 180 ms - and by then the cursor is on the first item of the menu. Without
    // the shared guard, opening the menu opened the language panel behind it.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await press("detail-more");
    await press("more-lang");
    expect(text("more-lang"), "the menu is still what is up").toContain("Audio and subtitles");
  });

  it("gives the cursor back to itself when the menu is closed", async () => {
    // The button that opened the chain is the only one of the three still on
    // screen; without this the panel closes onto a cursor that is nowhere, and
    // whatever puts one back lands on Play.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await press("detail-more");
    await settleClock();
    await press("more-close");
    expect(el("more-close"), "the menu is gone").toBeNull();
    expect(getCurrentFocusKey()).toBe("detail-more");
  });

  it("is not offered when there is nothing behind it", async () => {
    // A film with one audio track and no subtitles has neither a season to mark
    // nor a language to choose, and a menu holding nothing is a press that
    // answers with an empty box.
    const { render, act } = await import("@testing-library/react");
    const { configureI18n } = await import("@sdk");
    const { Detail } = await import("../Detail");
    const { useApp } = await import("../state");
    const en = (await import("../locales/en.json")).default;
    const hu = (await import("../locales/hu.json")).default;
    configureI18n({ hu, en }, { fallback: "en" });

    n += 1;
    const film: MediaItem = { id: `film${n}`, kind: "movie", title: "A film" };
    useApp.setState({
      backend: {
        kind: "plex",
        item: async () => ({ ...detailOf(film), versions: [{ ...version(), audio: [], subtitles: [] }] }),
        children: async () => [],
        setWatched: async () => {},
        posterUrl: () => undefined,
        artUrl: () => undefined,
        backdropUrl: () => undefined,
        themeUrl: () => undefined,
        imageHeaders: () => ({}),
        markers: async () => [],
      } as never,
      screen: { name: "item", itemId: film.id },
      history: [],
      failure: null,
    });
    render(<Detail itemId={film.id} />);
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      await flushFocus();
    }
    expect(el("detail-play"), "the film itself still plays").toBeTruthy();
    expect(el("detail-more")).toBeNull();
  });
});

describe("the action row as a place to navigate", () => {
  it("hands Right along its own buttons", async () => {
    // The row is a focus container of its own now - it has to be, to know that
    // the cursor has left it - and a container that swallowed a sideways press
    // would take the marking button off the remote entirely.
    const h = await open({ inProgress: true });
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await focusOn("detail-play");
    const keys = ["detail-play", "detail-restart", "detail-watched", "detail-more"];
    keys.forEach((k, i) => place(el(k)!, 100 + i * 260, 400, 240, 70));
    await remote.right();
    expect(getCurrentFocusKey()).toBe("detail-restart");
    await remote.right();
    expect(getCurrentFocusKey()).toBe("detail-watched");
    await remote.right();
    expect(getCurrentFocusKey()).toBe("detail-more");
  });

  it("is what Up out of the episode row still reaches", async () => {
    // Decided by the screen rather than by geometry, and the key it aims at
    // moved with the buttons: an Up aimed at a control that is no longer
    // rendered leaves the app with no origin and swallows the press.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await remote.up();
    expect(getCurrentFocusKey()).toBe("detail-play");
  });
});

describe("where a row parks", () => {
  it("goes to the top of the view when it has nothing to keep above it", async () => {
    const { revealTop } = await import("../Row");
    expect(revealTop({ top: 160, bottom: 880, rowTop: 600, rowHeight: 220 })).toBe(160);
  });

  it("leaves the kept element exactly the room it had", async () => {
    // The gap between the two is the layout's, so the row lands as far below the
    // top of the view as the synopsis sits above it.
    const { revealTop } = await import("../Row");
    expect(revealTop({ top: 160, bottom: 880, rowTop: 600, rowHeight: 220, keepTop: 380 })).toBe(160 + 220);
  });

  it("never pushes the row off the bottom to do it", async () => {
    // A page taller than the screen has to lose something, and it is the top of
    // what is being kept - not the row the cursor is actually on.
    const { revealTop } = await import("../Row");
    expect(revealTop({ top: 160, bottom: 880, rowTop: 900, rowHeight: 300, keepTop: 100 })).toBe(880 - 300);
  });

  it("keeps the plain placement for a row too tall to fit at all", async () => {
    const { revealTop } = await import("../Row");
    expect(revealTop({ top: 160, bottom: 880, rowTop: 600, rowHeight: 900, keepTop: 100 })).toBe(160);
  });

  it("ignores an element that is not above the row", async () => {
    const { revealTop } = await import("../Row");
    expect(revealTop({ top: 160, bottom: 880, rowTop: 600, rowHeight: 220, keepTop: 700 })).toBe(160);
  });
});

describe("which episode the page is about", () => {
  /** The cursor's own ring, and the fainter one that is not the cursor. */
  const cursorRings = (): number => document.querySelectorAll('div[class*="ring-[0.35vh]"]').length;
  const subjectRings = (): number => document.querySelectorAll('div[class*="ring-white/40"]').length;

  it("marks nothing before an episode is highlighted", async () => {
    await open();
    expect(subjectRings()).toBe(0);
  });

  it("keeps the highlighted episode marked once the cursor moves to the buttons", async () => {
    // The synopsis, the cast and the marking button are all about ONE episode,
    // and no tile was highlighted while the cursor was up on the buttons - so
    // the only thing naming it was a designation written into a label.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    expect(cursorRings(), "the cursor is on the tile").toBe(1);
    expect(subjectRings(), "and it needs no second ring while it is").toBe(0);

    await focusOn("detail-play");
    expect(cursorRings(), "the cursor has gone").toBe(0);
    expect(subjectRings(), "the page still says which episode it is about").toBe(1);
  });

  it("moves the mark with the highlight", async () => {
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await focusOn("detail-watched");
    expect(subjectRings()).toBe(1);
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    await focusOn("detail-watched");
    // Still exactly one: a mark left behind on the previous episode would make
    // the page look as though it were about two of them.
    expect(subjectRings()).toBe(1);
  });
});

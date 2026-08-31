import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Switching seasons from the episode list.
 *
 * An episode has no screen of its own - it is shown on its season - so the
 * episode list is where somebody is when they want another season, and the only
 * way there was Back to the series and in again. The strip puts the seasons one
 * press above the episodes, and switching keeps the cursor on it, so looking
 * through four of them is four presses rather than twelve.
 */

import type { ItemDetail, MediaItem } from "../backends/types";

const { setupRemote, flushFocus, setFocus, getCurrentFocusKey, remote, place } = await import("./remote");
setupRemote();

function detailOf(item: MediaItem): ItemDetail {
  return { ...item, roles: [], extras: [], reviews: [], scores: [], chapters: [], versions: [] } as ItemDetail;
}

/**
 * Fresh ids per test: norigin's current focus key is module state and outlives
 * Testing Library's cleanup, so a second screen built with the same keys has
 * focus restored onto a control the test never pressed.
 */
let n = 0;

interface Fixture {
  showId: string;
  seasons: MediaItem[];
  episodes: MediaItem[];
}

function fixture(count = 3): Fixture {
  n += 1;
  const showId = `show${n}`;
  const seasons = Array.from({ length: count }, (_, i) => ({
    id: `season${n}-${i + 1}`,
    kind: "season" as const,
    title: `${i + 1}. évad`,
    index: i + 1,
    parentId: showId,
  }));
  // The middle season where there is one, so both ends of the strip are a
  // press away; the only one otherwise.
  const on = seasons[1] ?? seasons[0]!;
  return {
    showId,
    seasons,
    episodes: [
      { id: `ep1-${n}`, kind: "episode", title: "Első rész", index: 1, parentIndex: on.index, parentId: on.id },
      { id: `ep2-${n}`, kind: "episode", title: "Második rész", index: 2, parentIndex: on.index, parentId: on.id },
    ],
  };
}

interface Harness extends Fixture {
  /** The season the screen is on: the middle one, so both ends are reachable. */
  current: MediaItem;
  childrenFor: string[];
}

async function open(opts?: {
  seasonCount?: number;
  /** The show's children fail, which must cost the strip and nothing else. */
  failSeasons?: boolean;
  /** What the show answers with, for the "only seasons" case. */
  showChildren?: MediaItem[];
  focusSeasons?: boolean;
}): Promise<Harness> {
  const { render, act } = await import("@testing-library/react");
  const { configureI18n } = await import("@sdk");
  const { Detail } = await import("../Detail");
  const { useApp } = await import("../state");
  const en = (await import("../locales/en.json")).default;
  const hu = (await import("../locales/hu.json")).default;
  configureI18n({ hu, en }, { fallback: "en" });

  const f = fixture(opts?.seasonCount ?? 3);
  const current = f.seasons[1] ?? f.seasons[0]!;
  const h: Harness = { ...f, current, childrenFor: [] };
  const byId = new Map<string, MediaItem>([
    ...f.seasons.map((s) => [s.id, s] as const),
    ...f.episodes.map((e) => [e.id, e] as const),
  ]);
  useApp.setState({
    backend: {
      kind: "plex",
      item: async (id: string) => detailOf(byId.get(id) ?? current),
      children: async (id: string) => {
        h.childrenFor.push(id);
        if (id === f.showId) {
          if (opts?.failSeasons) throw new Error("no");
          return opts?.showChildren ?? f.seasons;
        }
        return f.episodes;
      },
      setWatched: async () => {},
      posterUrl: () => undefined,
      artUrl: () => undefined,
      backdropUrl: () => undefined,
      themeUrl: () => undefined,
      imageHeaders: () => ({}),
      markers: async () => [],
    } as never,
    screen: { name: "item", itemId: current.id, focusSeasons: opts?.focusSeasons },
    history: [],
    failure: null,
  });

  render(<Detail itemId={current.id} focusSeasons={opts?.focusSeasons} />);
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
  return h;
}

const chip = (id: string): HTMLElement | null => document.querySelector(`[data-sfocus="detail-season-${id}"]`);
const chips = (): string[] =>
  [...document.querySelectorAll('[data-sfocus^="detail-season-"]')].map((e) => e.textContent ?? "");

/** Lay the screen out the way it is drawn: buttons, strip, episodes. */
function layout(h: Harness): void {
  const at = (sel: string, x: number, y: number, w = 200, h_ = 60) => {
    const el = document.querySelector(sel);
    if (el) place(el, x, y, w, h_);
  };
  at('[data-sfocus="detail-play"]', 100, 100, 300, 70);
  h.seasons.forEach((s, i) => at(`[data-sfocus="detail-season-${s.id}"]`, 100 + i * 220, 300, 200, 60));
  h.episodes.forEach((e, i) => at(`[data-sfocus="children-${h.current.id}-${e.id}"]`, 100 + i * 340, 500, 320, 200));
}

async function settle(): Promise<void> {
  const { act } = await import("@testing-library/react");
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

describe("the season strip on an episode list", () => {
  it("offers every season by its number, with the one being shown named", async () => {
    const h = await open();
    // The number, not the name the server carries: this library names a third
    // of its seasons, and "Secrets Revealed" does not say which one it is.
    expect(chips()).toEqual(["Season 1", "Season 2", "Season 3"]);
    // The current one is told apart by weight and fill, not by a glyph: a tick
    // means watched everywhere else in this app.
    expect(chip(h.current.id)?.className).toContain("font-semibold");
    expect(chip(h.seasons[0]!.id)?.className).toContain("text-fg-dim");
  });

  it("offers nothing when there is nothing to switch to", async () => {
    await open({ seasonCount: 1 });
    expect(chips()).toEqual([]);
  });

  it("offers only seasons, whatever else the series answers with", async () => {
    await open({
      showChildren: [
        { id: "not-a-season", kind: "movie", title: "A film" },
        // No number to show, so the server's own name stands: Plex's season 0
        // is the specials, and a numberless season is not "Season 0".
        { id: "s-0", kind: "season", title: "Kiegészítők", index: 0 },
        { id: "s-a", kind: "season", title: "Első", index: 1 },
        { id: "s-b", kind: "season", title: "Második" },
      ],
    });
    expect(chips()).toEqual(["Kiegészítők", "Season 1", "Második"]);
  });

  it("costs the strip and nothing else when the series cannot be listed", async () => {
    const { doesFocusableExist } = await import("@noriginmedia/norigin-spatial-navigation");
    const h = await open({ failSeasons: true });
    expect(chips()).toEqual([]);
    // The episodes are still there, and the cursor is on one of them.
    expect(doesFocusableExist(`children-${h.current.id}-${h.episodes[0]!.id}`)).toBe(true);
    expect(document.body.textContent).toContain("Első rész");
  });

  it("is what Up from the episodes reaches, and Down comes back", async () => {
    const h = await open();
    layout(h);
    await setFocus(`children-${h.current.id}-${h.episodes[0]!.id}`);
    await settle();
    await remote.up();
    await settle();
    // Entered at the season being shown, not at the first one.
    expect(getCurrentFocusKey()).toBe(`detail-season-${h.current.id}`);
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe(`children-${h.current.id}-${h.episodes[0]!.id}`);
  });

  it("reaches the play button above it", async () => {
    const h = await open();
    layout(h);
    await setFocus(`detail-season-${h.current.id}`);
    await settle();
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe("detail-play");
  });

  it("goes round at the ends rather than off the strip", async () => {
    const h = await open();
    layout(h);
    await setFocus(`detail-season-${h.seasons[0]!.id}`);
    await settle();
    await remote.left();
    await settle();
    expect(getCurrentFocusKey()).toBe(`detail-season-${h.seasons[2]!.id}`);
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe(`detail-season-${h.seasons[0]!.id}`);
  });

  it("switches the screen to the season pressed, without a step to go back through", async () => {
    const { useApp } = await import("../state");
    const { act } = await import("@testing-library/react");
    const h = await open();
    await act(async () => {
      chip(h.seasons[2]!.id)!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const screen = useApp.getState().screen;
    expect(screen).toMatchObject({ name: "item", itemId: h.seasons[2]!.id, focusSeasons: true });
    // Back belongs to whatever opened the series, not to a trail of seasons.
    expect(useApp.getState().history).toEqual([]);
  });

  it("does nothing when the season already on screen is pressed", async () => {
    const { useApp } = await import("../state");
    const { act } = await import("@testing-library/react");
    const h = await open();
    const before = useApp.getState().screen;
    await act(async () => {
      chip(h.current.id)!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useApp.getState().screen).toBe(before);
  });

  it("opens on the strip when that is where it was opened from", async () => {
    const h = await open({ focusSeasons: true });
    expect(getCurrentFocusKey()).toBe(`detail-season-${h.current.id}`);
  });

  it("opens where it always did when there is no strip to open on", async () => {
    // A series with one season, arrived at with the flag set: the flag must not
    // park the cursor on a key that never mounts, which is a dead remote.
    await open({ seasonCount: 1, focusSeasons: true });
    expect(getCurrentFocusKey()).toBe("detail-play");
  });
});

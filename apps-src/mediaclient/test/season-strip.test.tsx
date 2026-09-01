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
  /** Lets a held season list answer, for the tests about a slow one. */
  releaseSeasons?: () => void;
}

async function open(opts?: {
  seasonCount?: number;
  /** The show's children fail, which must cost the strip and nothing else. */
  failSeasons?: boolean;
  /** What the show answers with, for the "only seasons" case. */
  showChildren?: MediaItem[];
  /** The season list never answers, the way a stalled connection does not. */
  holdSeasons?: boolean;
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
          if (opts?.holdSeasons) await new Promise<void>((r) => (h.releaseSeasons = r));
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
    await act(tick);
    await flushFocus();
  }
  return h;
}

/**
 * One turn of the event loop, under whichever clock the test is running.
 *
 * The screen places its cursor from a timer, so a test that fakes the clock -
 * the one measuring how long the strip is waited for - has to advance it rather
 * than wait on it, or the page never finishes arriving.
 */
async function tick(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
  else await new Promise((r) => setTimeout(r, 0));
}

/** A chip by its POSITION in the strip, which is how it is keyed. */
const chipKey = (i: number): string => `detail-seasons-at-${i}`;
const chip = (i: number): HTMLElement | null => document.querySelector(`[data-sfocus="${chipKey(i)}"]`);
const chips = (): string[] =>
  [...document.querySelectorAll('[data-sfocus^="detail-seasons-at-"]')].map((e) => e.textContent ?? "");

/** Lay the screen out the way it is drawn: buttons, strip, episodes. */
function layout(h: Harness): void {
  const at = (sel: string, x: number, y: number, w = 200, h_ = 60) => {
    const el = document.querySelector(sel);
    if (el) place(el, x, y, w, h_);
  };
  at('[data-sfocus="detail-play"]', 100, 100, 300, 70);
  h.seasons.forEach((_s, i) => at(`[data-sfocus="${chipKey(i)}"]`, 100 + i * 220, 300, 200, 60));
  // The episode tiles carry no `data-sfocus` - only FocusButton does - so there
  // is nothing to lay out for them here. Both transitions across that boundary
  // go through this screen's own onArrowPress handlers rather than through
  // geometry, which is what these tests measure; the geometry half was measured
  // on a box.
}

async function settle(): Promise<void> {
  const { act } = await import("@testing-library/react");
  for (let i = 0; i < 3; i++) {
    await act(tick);
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
    expect(chip(h.seasons.indexOf(h.current))?.className).toContain("font-semibold");
    expect(chip(0)?.className).toContain("text-fg-dim");
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
    expect(getCurrentFocusKey()).toBe(chipKey(h.seasons.indexOf(h.current)));
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe(`children-${h.current.id}-${h.episodes[0]!.id}`);
  });

  it("reaches the play button above it", async () => {
    const h = await open();
    layout(h);
    await setFocus(chipKey(h.seasons.indexOf(h.current)));
    await settle();
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe("detail-play");
  });

  it("goes round at the ends rather than off the strip", async () => {
    const h = await open();
    layout(h);
    await setFocus(chipKey(0));
    await settle();
    await remote.left();
    await settle();
    expect(getCurrentFocusKey()).toBe(chipKey(2));
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe(chipKey(0));
  });

  it("switches the screen to the season pressed, without a step to go back through", async () => {
    const { useApp } = await import("../state");
    const { act } = await import("@testing-library/react");
    const h = await open();
    await act(async () => {
      chip(2)!.click();
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
      chip(h.seasons.indexOf(h.current))!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useApp.getState().screen).toBe(before);
  });

  it("opens on the strip when that is where it was opened from", async () => {
    const h = await open({ focusSeasons: true });
    expect(getCurrentFocusKey()).toBe(chipKey(h.seasons.indexOf(h.current)));
  });

  it("opens where it always did when there is no strip to open on", async () => {
    // A series with one season, arrived at with the flag set: the flag must not
    // park the cursor on a key that never mounts, which is a dead remote.
    await open({ seasonCount: 1, focusSeasons: true });
    expect(getCurrentFocusKey()).toBe("detail-play");
  });

  it("opens on the strip even when the series does not list this season", async () => {
    // The cursor names the STRIP, not a chip: a series whose children come back
    // without the season being shown would otherwise park it on a key nothing
    // mounted, which is one swallowed press and a screen with nothing lit.
    await open({
      focusSeasons: true,
      showChildren: [
        { id: "other-a", kind: "season", title: "Első", index: 1 },
        { id: "other-b", kind: "season", title: "Második", index: 2 },
      ],
    });
    expect(getCurrentFocusKey()).toBe(chipKey(0));
  });

  it("tells the season being shown apart by weight, which focus does not take", async () => {
    // Every way into the strip lands on this chip, and focus fills a chip white
    // - taking the fill with it, but not the weight, which is what still says
    // which season the screen is on.
    const h = await open();
    expect(chip(h.seasons.indexOf(h.current))?.className).toContain("font-semibold");
    expect(chip(0)?.className).not.toContain("font-semibold");
  });

  it("places its cursor without waiting for the season list", async () => {
    // The list is a second request. Waiting for it left the screen with nothing
    // highlighted, which on a television is a remote that does nothing.
    const h = await open({ focusSeasons: true, holdSeasons: true });
    expect(getCurrentFocusKey()).toBe("detail-play");
    expect(chips()).toEqual([]);
    h.releaseSeasons?.();
    await settle();
    // ...and once it answers, the strip takes the cursor, since nobody moved it.
    expect(getCurrentFocusKey()).toBe(chipKey(h.seasons.indexOf(h.current)));
  });

  it("leaves a late season list where the cursor was put by a press", async () => {
    const h = await open({ focusSeasons: true, holdSeasons: true });
    layout(h);
    // Somebody is already reading the episodes when the list answers.
    await setFocus(`children-${h.current.id}-${h.episodes[1]!.id}`);
    await settle();
    h.releaseSeasons?.();
    await settle();
    expect(getCurrentFocusKey()).toBe(`children-${h.current.id}-${h.episodes[1]!.id}`);
  });
});

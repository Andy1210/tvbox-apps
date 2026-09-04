import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Marking an episode watched, from the season screen it is listed on.
 *
 * Two things were wrong at once and only one of them was visible. The button
 * acted on the SEASON - one press moved all sixteen episodes of one, measured
 * against the real server - and whatever it moved, the tick appeared nowhere
 * until the screen was left and opened again, because this screen keeps the
 * children it was built with for as long as it is up.
 */

import type { ItemDetail, MediaItem } from "../backends/types";

const { setupRemote, flushFocus, setFocus, focusBecomes } = await import("./remote");
setupRemote();

const TICK = 'path[d="M4 12.5l5.5 5.5L20 7"]';
const ticks = (): number => document.querySelectorAll(TICK).length;
/**
 * The tile's progress bar, which is drawn instead of a tick and not beside it.
 *
 * `bg-black/60` is in the selector because the chapter strip draws a bar at the
 * same edge; it is not on this screen today, and this keeps the count honest if
 * a fixture ever grows chapters.
 */
const bars = (): number =>
  document.querySelectorAll('div[class*="inset-x-0"][class*="bottom-0"][class*="bg-black/60"]').length;

function detailOf(item: MediaItem): ItemDetail {
  return { ...item, roles: [], extras: [], reviews: [], scores: [], chapters: [], versions: [] } as ItemDetail;
}

/**
 * Each test gets its own ids, and that is not cosmetic.
 *
 * norigin's current focus key is module state and outlives Testing Library's
 * cleanup, so a second screen built with the SAME child keys has focus restored
 * onto a tile the moment its row mounts - which set the highlight this file is
 * measuring. Fresh ids leave nothing to restore.
 */
let n = 0;
interface Fixture {
  season: MediaItem;
  episodes: MediaItem[];
}
function fixture(): Fixture {
  n += 1;
  const season: MediaItem = {
    id: `season${n}`,
    kind: "season",
    title: "1. évad",
    // A season's own view count is its number of WATCHED EPISODES, so this is
    // what made the button read "mark as unwatched" with fifteen still to go.
    viewCount: 1,
  };
  return {
    season,
    episodes: [
      {
        id: `ep1-${n}`,
        kind: "episode",
        title: "Első rész",
        index: 1,
        parentIndex: 1,
        grandparentTitle: "Sorozat",
        parentId: season.id,
      },
      {
        id: `ep2-${n}`,
        kind: "episode",
        title: "Második rész",
        index: 2,
        parentIndex: 1,
        grandparentTitle: "Sorozat",
        parentId: season.id,
        // Half watched: the tile draws a bar OR a tick, never both.
        viewOffsetMs: 600_000,
        durationMs: 1_800_000,
      },
    ],
  };
}

interface Harness extends Fixture {
  marks: { id: string; watched: boolean }[];
  childrenCalls: number;
  releaseWrite?: () => void;
  releaseChildren?: () => void;
  /** What the NEXT children() call answers, when a test needs newer truth. */
  answer?: MediaItem[];
}

async function open(opts?: {
  failWrite?: boolean;
  holdWrite?: boolean;
  holdChildren?: boolean;
  slowWriteMs?: number;
}): Promise<Harness> {
  const { render, act } = await import("@testing-library/react");
  const { configureI18n } = await import("@sdk");
  const { Detail } = await import("../Detail");
  const { useApp } = await import("../state");
  const en = (await import("../locales/en.json")).default;
  const hu = (await import("../locales/hu.json")).default;
  configureI18n({ hu, en }, { fallback: "en" });

  const f = fixture();
  const h: Harness = { ...f, marks: [], childrenCalls: 0 };
  const byId = new Map<string, MediaItem>([[f.season.id, f.season], ...f.episodes.map((e) => [e.id, e] as const)]);
  useApp.setState({
    backend: {
      kind: "plex",
      item: async (id: string) => detailOf(byId.get(id) ?? f.season),
      children: async () => {
        h.childrenCalls += 1;
        if (opts?.holdChildren && h.childrenCalls > 1) await new Promise<void>((r) => (h.releaseChildren = r));
        return h.answer ?? f.episodes;
      },
      setWatched: async (id: string, watched: boolean) => {
        h.marks.push({ id, watched });
        if (opts?.slowWriteMs) await new Promise((r) => setTimeout(r, opts.slowWriteMs));
        if (opts?.holdWrite) await new Promise<void>((r) => (h.releaseWrite = r));
        if (opts?.failWrite) throw new Error("nope");
      },
      posterUrl: () => undefined,
      artUrl: () => undefined,
      backdropUrl: () => undefined,
      themeUrl: () => undefined,
      imageHeaders: () => ({}),
      markers: async () => [],
    } as never,
    screen: { name: "item", itemId: f.season.id },
    history: [],
    failure: null,
  });

  render(<Detail itemId={f.season.id} />);
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
  return h;
}

/** Put the cursor on an episode, the way arriving in the list does. */
async function highlight(h: Harness, which: 0 | 1): Promise<void> {
  const { act } = await import("@testing-library/react");
  await setFocus(`children-${h.season.id}-${h.episodes[which]!.id}`);
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

async function press(key = "detail-watched"): Promise<void> {
  const { act } = await import("@testing-library/react");
  const btn = document.querySelector(`[data-sfocus="${key}"]`) as HTMLElement | null;
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

const label = (key = "detail-watched"): string => document.querySelector(`[data-sfocus="${key}"]`)?.textContent ?? "";
/**
 * What the button is called, whether or not it is spelling itself out.
 *
 * The marking button draws a tick and shows its words only while it is focused,
 * so its text content is empty for most of a session - but its NAME is what
 * these tests are about, and that is on the element either way.
 */
const name = (key = "detail-watched"): string =>
  document.querySelector(`[data-sfocus="${key}"]`)?.getAttribute("aria-label") ?? "";
/** Open the overflow menu, which is where the season-wide mark now lives. */
async function openMore(): Promise<void> {
  await press("detail-more");
}
/** Let time pass the press-bounce guard, which is real-clock. */
const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 450));
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("marking an episode watched from its season screen", () => {
  it("marks the episode the page is describing, not the season", async () => {
    const h = await open();
    await highlight(h, 0);
    expect(name(), "nothing about this episode is watched yet").toContain("Mark as watched");

    await press();
    expect(h.marks, "the highlighted episode, and only it").toEqual([{ id: h.episodes[0]!.id, watched: true }]);
  });

  it("puts the tick on the episode straight away, with no second request", async () => {
    const h = await open();
    const calls = h.childrenCalls;
    await highlight(h, 0);
    expect(ticks(), "no episode is finished at the start").toBe(0);

    await press();
    expect(ticks(), "the tile somebody is looking at").toBe(1);
    expect(h.childrenCalls, "and the row was not refetched to get it").toBe(calls);
    expect(name(), "the button says what it would do next").toContain("Mark as unwatched");
  });

  it("replaces a half-watched episode's progress bar with the tick", async () => {
    // The tile draws one or the other, and a patch that set only the view count
    // left the bar in place - so the press appeared to do nothing at all on
    // exactly the episodes somebody is most likely to press it on.
    const h = await open();
    await highlight(h, 1);
    expect(bars(), "ep2 is 10 of 30 minutes in").toBeGreaterThan(0);

    await press();
    expect(ticks()).toBe(1);
    expect(bars(), "and the bar is gone").toBe(0);
  });

  it("takes the tick back off when the server refuses", async () => {
    const h = await open({ failWrite: true });
    await highlight(h, 0);
    await press();
    expect(h.marks).toEqual([{ id: h.episodes[0]!.id, watched: true }]);
    expect(ticks(), "an optimistic tick that never landed must not stay").toBe(0);
    expect(name()).toContain("Mark as watched");
  });

  it("offers nothing to mark before an episode is highlighted", async () => {
    // The season is what the page is describing then, and a season is not what
    // this button means: pressing it moved every episode at once.
    await open();
    expect(document.querySelector('[data-sfocus="detail-watched"]')).toBeNull();
  });
});

describe("the button says which episode it is about", () => {
  it("carries the episode's designation", async () => {
    // On a season the largest text on the screen is the SERIES, the episode's
    // own name is one dim line, and no tile is highlighted while the cursor is
    // up on the buttons - so without this the button reads as being about the
    // series.
    const h = await open();
    await highlight(h, 1);
    expect(name()).toContain("S1E2");
    expect(name()).toContain("Mark as watched");
  });
});

describe("marking the whole season", () => {
  it("is offered on arrival, before anything is highlighted", async () => {
    // Behind the overflow button now, but still reachable on the screen that
    // has no episode highlighted yet - which is where a season watched on
    // somebody else's television is put right.
    await open();
    expect(document.querySelector('[data-sfocus="detail-watched"]'), "no episode is highlighted yet").toBeNull();
    await openMore();
    expect(label("more-watched-season")).toContain("Mark season as watched");
  });

  it("asks first, and the safe answer is the one holding the focus", async () => {
    // The only confirmation in this app, and the focus placement is the point:
    // a remote repeats and it bounces, so the press that opens the panel can
    // arrive again by itself - landing on "no" makes a doubled press a cancel.
    const h = await open();
    await openMore();
    await press("more-watched-season");
    expect(h.marks, "nothing has been asked of the server yet").toEqual([]);
    expect(document.body.textContent).toContain("Mark the whole season as watched?");
    expect(document.body.textContent, "and it says how much it moves").toContain("Episodes affected: 2");
    // Waited for: the panel's own cursor lands on a timer, so a counted settle
    // reads whatever was focused behind it.
    await focusBecomes("confirm-no");
  });

  it("does nothing when the answer is no", async () => {
    const h = await open();
    await openMore();
    await press("more-watched-season");
    await press("confirm-no");
    expect(h.marks).toEqual([]);
    expect(ticks()).toBe(0);
    expect(document.querySelector('[data-sfocus="confirm-no"]'), "and the panel is gone").toBeNull();
  });

  it("moves every episode, and every tile with it", async () => {
    // One call on the season key is what the server does to all of them, so the
    // row has to move as one - a patch of the pressed item alone would tick
    // nothing at all here.
    const h = await open();
    expect(ticks()).toBe(0);
    await openMore();
    await press("more-watched-season");
    await press("confirm-yes");
    expect(h.marks, "the season, not an episode").toEqual([{ id: h.season.id, watched: true }]);
    expect(ticks(), "both episodes").toBe(2);
    expect(bars(), "and the half-watched one is finished now").toBe(0);
    await settle();
    await openMore();
    expect(label("more-watched-season")).toContain("Mark season as unwatched");
  });

  it("reads as watched only when nothing is left", async () => {
    const h = await open();
    await highlight(h, 0);
    await press();
    await settle();
    await openMore();
    expect(label("more-watched-season"), "one of two is not the season").toContain("Mark season as watched");
  });

  it("cannot be confirmed by the press that opened it", async () => {
    // The bounce case end to end: the second press lands on whatever has the
    // focus, and that is "no".
    const h = await open();
    await openMore();
    await press("more-watched-season");
    await press("confirm-no");
    expect(h.marks).toEqual([]);
    expect(ticks()).toBe(0);
  });
});

describe("a press that bounces", () => {
  it("counts once", async () => {
    // Measured on the box: two presses 150 ms apart marked and then unmarked,
    // and the only evidence was a 180 ms flash of the tick. `busy` cannot cover
    // it - the write answers in well under that on a LAN.
    const h = await open();
    await highlight(h, 0);
    await press();
    await press();
    expect(h.marks, "the repeat is not a second command").toEqual([{ id: h.episodes[0]!.id, watched: true }]);
    expect(ticks()).toBe(1);
  });

  it("still lets a deliberate second press through", async () => {
    const h = await open();
    await highlight(h, 0);
    await press();
    await settle();
    await press();
    expect(h.marks.map((m) => m.watched)).toEqual([true, false]);
    expect(ticks()).toBe(0);
  });
});

describe("a refetch that lands after the press", () => {
  it("does not take the tick back off", async () => {
    // Coming back from playback refetches the item AND the row, and its answer
    // is a round trip old: without the pending patch being re-applied the tick
    // appeared and then vanished, with the press already on the server. The
    // refetch is held open here so the press lands inside its window, which is
    // exactly where the cursor sits when somebody comes back from an episode.
    const { act } = await import("@testing-library/react");
    const { usePlayer } = await import("../playback/player");
    const h = await open({ holdChildren: true });
    await highlight(h, 0);

    // Playback, and back - which is what arms the refetch.
    await act(async () => {
      usePlayer.setState({ current: { item: h.episodes[0]! } as never });
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      usePlayer.setState({ current: null });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.childrenCalls, "the refetch went out and is being held").toBe(2);

    await press();
    expect(ticks()).toBe(1);

    await act(async () => {
      h.releaseChildren?.();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(ticks(), "the stale answer must not undo the press").toBe(1);
    expect(name(), "and the button agrees with the tile").toContain("Mark as unwatched");
  });
});

describe("a season tile", () => {
  it("shows no tick while episodes are left, whatever its own view count says", async () => {
    // Plex rolls a child's scrobble up into the parent, so a season's own
    // viewCount climbs as episodes are marked while viewedLeafCount stays put -
    // measured, 2 to 7 on a season with nothing watched. The tile drew a
    // finished tick beside its own "16 unwatched" badge.
    const { render, act } = await import("@testing-library/react");
    const { configureI18n } = await import("@sdk");
    const { Detail } = await import("../Detail");
    const { useApp } = await import("../state");
    const en = (await import("../locales/en.json")).default;
    const hu = (await import("../locales/hu.json")).default;
    configureI18n({ hu, en }, { fallback: "en" });

    const show: MediaItem = { id: "show9", kind: "show", title: "Sorozat" };
    const seasons: MediaItem[] = [
      { id: "s9a", kind: "season", title: "1. évad", viewCount: 7, unwatchedCount: 16 },
      { id: "s9b", kind: "season", title: "2. évad", viewCount: 1, unwatchedCount: 0 },
    ];
    const byId = new Map<string, MediaItem>([[show.id, show], ...seasons.map((x) => [x.id, x] as const)]);
    useApp.setState({
      backend: {
        kind: "plex",
        item: async (id: string) => detailOf(byId.get(id) ?? show),
        children: async () => seasons,
        setWatched: async () => {},
        posterUrl: () => undefined,
        artUrl: () => undefined,
        backdropUrl: () => undefined,
        themeUrl: () => undefined,
        imageHeaders: () => ({}),
        markers: async () => [],
      } as never,
      screen: { name: "item", itemId: show.id },
      history: [],
      failure: null,
    });
    render(<Detail itemId={show.id} />);
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      await flushFocus();
    }
    expect(ticks(), "only the season with nothing left").toBe(1);
  });
});

describe("a mark the server has already answered", () => {
  it("does not outlive the playback that made newer truth", async () => {
    // The mark exists to beat a refetch that was already in flight, not to pin
    // the item for the life of the screen: an episode marked watched and then
    // stopped ten minutes in came back with a real resume point, and the mark
    // put it back to nothing - the tile lost its bar and Play stopped resuming.
    const { act } = await import("@testing-library/react");
    const { usePlayer } = await import("../playback/player");
    const h = await open();
    await highlight(h, 0);
    await press();
    expect(ticks()).toBe(1);
    expect(bars(), "ep2 is the only one part-way through").toBe(1);

    // Watched ten minutes of it and stopped, which is what the server now says.
    h.answer = h.episodes.map((e) =>
      e.id === h.episodes[0]!.id ? { ...e, viewCount: 1, viewOffsetMs: 600_000, durationMs: 1_800_000 } : e,
    );
    await act(async () => {
      usePlayer.setState({ current: { item: h.episodes[0]! } as never });
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      usePlayer.setState({ current: null });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(bars(), "its resume point is back").toBe(2);
    expect(ticks(), "and it is not claiming to be finished").toBe(0);
  });
});

describe("a held OK button", () => {
  it("is one command, not one every 400 ms", async () => {
    // Spatial navigation fires on every keydown and does not look at `repeat`,
    // so a held button arrives as a stream of presses. Each refused one pushes
    // the window forward, which is what makes the whole hold a single command.
    const h = await open();
    await highlight(h, 0);
    for (let i = 0; i < 6; i++) {
      await press();
      await new Promise((r) => setTimeout(r, 120));
    }
    expect(h.marks.length, "one command for the whole hold").toBe(1);
    expect(ticks()).toBe(1);
  });
});

describe("a held OK button against a slow server", () => {
  it("is still one command", async () => {
    // The window has to be pushed by a press `busy` refuses as well: without
    // that, a write slower than the window let a repeat through and the hold
    // undid itself - measured at a 600 ms write, [watched, unwatched].
    const h = await open({ slowWriteMs: 600 });
    await highlight(h, 0);
    for (let i = 0; i < 8; i++) {
      await press();
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 800));
    expect(
      h.marks.map((m) => m.watched),
      "one command for the whole hold",
    ).toEqual([true]);
  });
});

describe("an answer given quickly", () => {
  it("is not swallowed by the guard that protects the button behind it", async () => {
    // The panel is the protection for the press that opened it - it opens on
    // "Cancel" - so the answer itself is not guarded. With the guard on the
    // write instead of on the press, answering inside the window dropped the
    // command silently, with the panel already closed.
    const h = await open();
    await openMore();
    await press("more-watched-season");
    await press("confirm-yes");
    expect(h.marks, "answered at once, and it still counted").toEqual([{ id: h.season.id, watched: true }]);
    expect(ticks()).toBe(2);
  });
});

describe("a season of one episode", () => {
  it('does not say "1 episodes"', async () => {
    // The count is interpolated into one sentence, and English disagrees with
    // itself at one. The wording carries no number agreement at all now.
    const { render, act } = await import("@testing-library/react");
    const { configureI18n } = await import("@sdk");
    const { Detail } = await import("../Detail");
    const { useApp } = await import("../state");
    const en = (await import("../locales/en.json")).default;
    const hu = (await import("../locales/hu.json")).default;
    configureI18n({ hu, en }, { fallback: "en" });
    const season: MediaItem = { id: "one-season", kind: "season", title: "1. évad" };
    const only: MediaItem[] = [{ id: "only-ep", kind: "episode", title: "Egyetlen", index: 1, parentIndex: 1 }];
    useApp.setState({
      backend: {
        kind: "plex",
        item: async () => detailOf(season),
        children: async () => only,
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
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      await flushFocus();
    }
    await openMore();
    await press("more-watched-season");
    expect(document.body.textContent).not.toContain("1 episodes");
    expect(document.body.textContent).toContain("Episodes affected: 1");
  });
});

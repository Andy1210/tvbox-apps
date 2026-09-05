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

const { setupRemote, flushFocus, setFocus, getCurrentFocusKey, remote, place, focusLands, focusBecomes } =
  await import("./remote");
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
  const { render } = await import("@testing-library/react");
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
  await settleFocus();
  // The screen's own cursor, waited for rather than counted. It lands on a
  // timer, and one that arrives after a test has put the cursor somewhere takes
  // it straight back - which makes what the test measures a question about how
  // busy the machine is.
  await focusLands();
  return { season, episodes };
}

const el = (key: string): HTMLElement | null => document.querySelector(`[data-sfocus="${key}"]`);
const text = (key: string): string => el(key)?.textContent ?? "";
const name = (key: string): string => el(key)?.getAttribute("aria-label") ?? "";
/** The line under the row, which is what names a button drawn as a glyph. */
const hint = (): string => document.querySelector("[data-actions-hint]")?.textContent ?? "";

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

/**
 * Let a panel finish going away.
 *
 * Closing one unmounts its focusables and puts the cursor back on a timeout, so
 * a single flush reads the cursor mid-teardown.
 */
async function settleFocus(): Promise<void> {
  const { act } = await import("@testing-library/react");
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
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

  it("is named under the row while it is focused, designation and all", async () => {
    // Under the row rather than inside the button: a label that opens inside it
    // moves every button to its right at the moment the cursor arrives.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    await focusOn("detail-watched");
    expect(text("detail-watched"), "the button itself stays a glyph").toBe("");
    expect(hint()).toContain("S1E2");
    expect(hint()).toContain("Mark as watched");
  });

  it("takes that name back when the cursor leaves the row", async () => {
    // The SDK's button reports focus and has no blur, so a name put up by one
    // and never taken down stays up behind whatever the cursor moved on to.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await focusOn("detail-watched");
    expect(hint()).not.toBe("");
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    expect(hint(), "nothing in the row is focused now").toBe("");
  });

  it("leaves the line empty for a button that already carries its words", async () => {
    await open();
    await focusOn("detail-play");
    expect(hint(), "Play says what it is; repeating it under the row says nothing").toBe("");
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

  it("takes a press on an item at once, with no window that answers nothing", async () => {
    // The bounce guard was on these items and it is deliberately not any more:
    // it also refuses a REAL press for 400 ms, silently, which on a television
    // reads as a remote that has stopped working. What a repeat can reach here
    // is a panel that Back closes - nothing that has to be undone.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await press("detail-more");
    await press("more-lang");
    expect(el("more-lang"), "the menu has gone").toBeNull();
    expect(el("lp-close"), "and the audio panel is up").toBeTruthy();
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
    // Arrive, then let the turns pass, then read - all three of these need the
    // three lines, and each one earns its place.
    //
    // Closing the menu lands the cursor TWICE on a healthy build:
    // `useFocusOnReveal` catches it as the menu goes, and the restore then
    // moves it to the button. Both land in the same timer turn, so nothing can
    // observe the one in between - so the group-then-read pairing the rule
    // elsewhere asks for buys nothing here, and the wait names the key. What
    // the pairing exists to catch is caught by the settle and the read below
    // instead.
    //
    // But a wait returns on first ARRIVAL and never sees the cursor leave
    // again, and where it ends is the whole subject: the press that would start
    // a film comes after. Measured - a restore that hands the cursor back and
    // then drops it on Play passes a bare wait on two of these three and fails
    // all three here. The settle is what gives the read its reach, and the
    // reach is that helper's turn count: three turns sees a drop up to about
    // 5 ms out, and past that nothing here would.
    await focusBecomes("detail-more");
    await settleFocus();
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
  const subjectRings = (): number => document.querySelectorAll('div[class*="ring-white/55"]').length;

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

describe("closing the overflow menu", () => {
  it("gives the cursor back to the button, not to the episode row, on Back", async () => {
    // The menu sits directly above a row where OK means PLAY, so a cursor that
    // lands there instead of on the button turns the next press into a film.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await press("detail-more");
    await remote.back();
    // Arrive, settle, read - see the first of these three, above.
    await focusBecomes("detail-more");
    await settleFocus();
    expect(getCurrentFocusKey()).toBe("detail-more");
  });

  it("does the same after an episode has been played", async () => {
    // `first` follows the last episode played, so the screen's own idea of
    // where a cursor belongs is an episode tile by then - which is exactly the
    // state the menu must not fall back into.
    const { act } = await import("@testing-library/react");
    const { usePlayer } = await import("../playback/player");
    const h = await open();
    await act(async () => {
      usePlayer.setState({ current: { item: h.episodes[1]! } as never });
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      usePlayer.setState({ current: null });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
    await focusOn("detail-more");
    await press("detail-more");
    await remote.back();
    // Arrive, settle, read, as above - and here the cursor's first landing is
    // the episode row rather than Play, because `first` follows the episode
    // that was played. That is the row these tests exist to keep it off, which
    // is exactly why the read after the settle is the assertion.
    await focusBecomes("detail-more");
    await settleFocus();
    expect(getCurrentFocusKey()).toBe("detail-more");
  });
});

describe("a film screen, where geometry is the only way back up", () => {
  /**
   * A film with two versions, so there is a focusable BELOW the action row that
   * carries a focus key a test can name.
   *
   * A season screen hides this class of bug: `Row.onArrowFromFirst` and the
   * season strip both call `focusFirstOf(ABOVE_ROWS)` by name, so they reach
   * the buttons whatever spatial navigation thinks. A film has no such route -
   * every press in or out of its action row is decided by geometry.
   */
  async function openFilm(): Promise<void> {
    const { render } = await import("@testing-library/react");
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
        item: async () => ({
          ...detailOf(film),
          versions: [
            { ...version(), label: "1080p" },
            { ...version(), mediaIndex: 1, label: "2160p" },
          ],
        }),
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
    await settleFocus();
    // Waited for, like `open()`: a landing that arrives after a test has moved
    // the cursor takes it back.
    await focusLands();
    // The action row above, the version chips below it.
    place(el("detail-play")!, 100, 400, 300, 70);
    place(el("detail-watched")!, 440, 400, 120, 70);
    place(el("detail-more")!, 600, 400, 120, 70);
    place(el("detail-version-0")!, 100, 560, 200, 60);
    place(el("detail-version-1")!, 320, 560, 200, 60);
  }

  it("lets Up out of the version chips reach the buttons again", async () => {
    // A container that is not itself focusable is never in norigin's candidate
    // list, and its children are siblings of nothing outside it - so with that
    // off, one press of Down put every button on this screen out of reach in
    // both directions, with only Back to escape.
    await openFilm();
    await setFocus("detail-version-0");
    await flushFocus();
    await remote.up();
    expect(getCurrentFocusKey()).toBe("detail-play");
  });

  it("comes back to the buttons after going down and up again", async () => {
    await openFilm();
    await focusOn("detail-play");
    await remote.down();
    expect(getCurrentFocusKey(), "down leaves the row").toBe("detail-version-0");
    await remote.up();
    expect(getCurrentFocusKey(), "and up returns to it").toBe("detail-play");
  });
});

describe("a panel closing while something else owns the screen", () => {
  it("does not park the cursor on a button behind a film", async () => {
    // This page does not unmount during playback, it sits behind the player -
    // and the two focus hooks beside this one carry the same guard for a
    // measured reason: one OK press then both paused the film and pressed the
    // page's Play button behind it. Playback does not only start from a key
    // press either; a spoken "next episode" reaches the app the same way.
    const { act } = await import("@testing-library/react");
    const { usePlayer } = await import("../playback/player");
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[0]!.id}`);
    await press("detail-more");
    await act(async () => {
      usePlayer.setState({ current: { item: h.episodes[0]! } as never });
      await new Promise((r) => setTimeout(r, 0));
    });
    await remote.back();
    // A non-event, and the only shape that fits one: nothing can be waited for
    // here, because the thing being forbidden IS the wait's own signal - the
    // restore's timer must not fire. So the window is observed instead. A
    // counted settle is not a window: it spends a fixed number of turns, and a
    // restore that fires one turn later than the machine happened to allow went
    // unseen - measured, dropping the `playing` guard was caught with the
    // landing delayed 5 ms and missed at 8. The window IS the reach, and it is
    // the number below: the same mutation is caught out to 240 ms and missed at
    // 300.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    // And what must not happen is any button on THIS page taking the cursor,
    // not one named button: the page's own keys are the ones a press would act
    // on while the film is up, and the row is as wrong as the button. On a
    // healthy build the cursor is still on the menu's own key, which is no
    // longer mounted - the page deliberately does nothing at all.
    const at = String(getCurrentFocusKey());
    expect(at.startsWith("detail-") || at.startsWith("children-"), `the page took the cursor to ${at}`).toBe(false);
    await act(async () => {
      usePlayer.setState({ current: null });
      await new Promise((r) => setTimeout(r, 0));
    });
  });
});

describe("an overflow menu that loses its contents", () => {
  it("closes itself rather than leaving a flag nothing can clear", async () => {
    // What goes in the menu is computed from the screen, so a list that empties
    // under an open one would leave it up with nothing drawn - which switches
    // off every focus hook on the page behind it, and takes its own Back
    // handler down with it, so nothing is left that could close it.
    const { render, act } = await import("@testing-library/react");
    const { MoreMenu } = await import("../MoreMenu");
    const { configureI18n } = await import("@sdk");
    const en = (await import("../locales/en.json")).default;
    const hu = (await import("../locales/hu.json")).default;
    configureI18n({ hu, en }, { fallback: "en" });

    let closed = 0;
    const onClose = (): void => {
      closed += 1;
    };
    const { rerender } = render(
      <MoreMenu items={[{ key: "lang", label: "Audio and subtitles", onEnter: () => {} }]} onClose={onClose} />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(closed, "a menu with something in it stays up").toBe(0);

    rerender(<MoreMenu items={[]} onClose={onClose} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(closed, "and one with nothing in it asks to be closed").toBe(1);
    expect(document.querySelector('[data-sfocus="more-close"]'), "nothing of it is drawn").toBeNull();
  });
});

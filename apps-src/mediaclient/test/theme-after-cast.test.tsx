import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { themeItem, useTheme } from "../theme";
import { usePlayer, resetPlayer } from "../playback/player";
import { useApp } from "../state";
import { usePrefs } from "../prefs";
import type { MediaItem } from "../backends/types";

// A series' theme must not start over the countdown at the end of an episode.
//
// That is the loudest thing this app does and it lands in a room whose volume is
// set for a film's dialogue, so `useTheme` remembers what playback silenced and
// refuses to bring it back. A film started BY VOICE broke the assumption behind
// that: it puts the season screen up UNDERNEATH itself, so there was nothing
// sounding to remember - and the theme started as soon as the episode ended.
//
// The hard case is the one this pins: browsing series A while an episode of
// series B is cast. B's screen replaces A's in the same commit as the film
// starting, so which url gets recorded depends on React running the departing
// cleanup before the arriving effect. It does - and this is here so that stays
// true.

const season = (id: string): MediaItem => ({ id, kind: "season", title: `Season ${id}`, theme: `t/${id}` });

let plays: string[] = [];
/** The elements the module made, so a test can read what really happened to one. */
interface Sounding {
  volume: number;
  paused: boolean;
}
let made: Sounding[] = [];

function Season({ item }: { item: MediaItem | null | undefined }): null {
  useTheme(item);
  return null;
}

beforeEach(async () => {
  // The stop a screen arms on its way out waits a tick, so it can be cancelled
  // by another season of the same series arriving. That tick outlives the test
  // that armed it: let it land before this one renders, or the module still
  // believes the previous test's theme is playing.
  await new Promise((r) => setTimeout(r, 0));
  plays = [];
  usePrefs.setState({ themeMusic: true });
  useApp.setState({
    backend: {
      themeUrl: (i: MediaItem) => (i.theme ? `http://server/${i.theme}` : undefined),
      imageHeaders: () => ({}),
    } as never,
  });
  vi.stubGlobal("fetch", async (url: string) => ({ ok: true, blob: async () => ({ url }) }));
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (b: { url: string }) => b.url,
    revokeObjectURL: () => {},
  });
  made = [];
  class FakeAudio {
    volume = 1;
    paused = false;
    onended: (() => void) | null = null;
    constructor(readonly src: string) {
      made.push(this as unknown as Sounding);
    }
    play(): Promise<void> {
      plays.push(this.src);
      this.paused = false;
      return Promise.resolve();
    }
    pause(): void {
      this.paused = true;
    }
  }
  vi.stubGlobal("Audio", FakeAudio);
});

afterEach(() => {
  resetPlayer();
  vi.unstubAllGlobals();
});

/** Let the fetch chain inside the effect run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const playing = { item: { id: "ep" }, decision: {}, markers: [], choice: { version: 0 } } as never;

describe("what a detail screen tells the theme player", () => {
  const oneSeason = { id: "s", kind: "season", title: "1" } as MediaItem;
  const film = { id: "f", kind: "movie", title: "F" } as MediaItem;

  it("answers with the item, with nothing, or with not-known-yet", () => {
    expect(themeItem(oneSeason, false)).toBe(oneSeason);
    expect(themeItem(film, false)).toBeNull();
    // Loading: the theme carries across a season switch rather than restarting.
    expect(themeItem(null, false)).toBeUndefined();
    // Failed: the same empty item, and the opposite answer - a theme playing
    // under "something went wrong" would play for as long as it is up.
    expect(themeItem(null, true)).toBeNull();
    // A screen can fail with its item already in hand: the episode list is
    // fetched after the item and under the same catch.
    expect(themeItem(oneSeason, true)).toBeNull();
  });
});

describe("a series' theme and a film started by voice", () => {
  it("does not silence the series for good when the fetch is still in flight", async () => {
    // Nothing has started yet, so there is nothing to keep alive: leaving the
    // url marked as playing told the next screen a theme was on its way that
    // nobody would ever start, and the series stayed silent for the visit.
    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", async (url: string) => {
      await new Promise<void>((r) => (release = r));
      return { ok: true, blob: async () => ({ url }) };
    });
    const { rerender } = render(<Season key="h1" item={season("A")} />);
    await settle();
    expect(plays).toEqual([]);
    await act(async () => {
      rerender(<Season key="h2" item={undefined} />);
    });
    await settle();
    // The screen that started it is gone, so its own answer is discarded.
    release?.();
    await settle();
    expect(plays, "the departing screen's fetch is dead").toEqual([]);

    await act(async () => {
      rerender(<Season key="h2" item={season("A")} />);
    });
    await settle();
    release?.();
    await settle();
    expect(plays, "the arriving screen fetches it for itself").toEqual(["http://server/t/A"]);
  });

  it("stays silent when the episode ends, having never sounded", async () => {
    // The plain voice case: the app was on its home page, so no theme was
    // playing when the season screen arrived under the film.
    const { rerender } = render(<Season item={null} />);
    await act(async () => {
      usePlayer.setState({ current: playing });
      rerender(<Season key="b" item={season("B")} />);
    });
    await settle();
    expect(plays, "nothing while the film is on").toEqual([]);

    await act(async () => usePlayer.setState({ current: null }));
    await settle();
    expect(plays, "and nothing over the countdown").toEqual([]);
  });

  it("keeps playing across a season switch of the same series", async () => {
    // The season strip replaces this screen with another season's, which is a
    // remount: the theme is the series', so it must carry on rather than start
    // again from its first bar. The arriving screen does not know its item for
    // a round trip, which is why "not known yet" is a different answer from
    // "nothing to play".
    const { rerender } = render(<Season key="s1" item={season("A")} />);
    await settle();
    expect(plays).toEqual(["http://server/t/A"]);

    // Season two of the same series: a new screen, the item still on its way.
    await act(async () => {
      rerender(<Season key="s2" item={undefined} />);
    });
    await settle();
    await act(async () => {
      rerender(<Season key="s2" item={season("A")} />);
    });
    await settle();
    expect(plays, "the same theme is not started twice").toEqual(["http://server/t/A"]);
  });

  it("really stops one that is still fading in", async () => {
    // Two ramps on one element do not average, they fight: a fade-out that
    // starts while the volume is still at zero computes a step of zero and can
    // never lower what the fade-in keeps raising. Measured before the fix: the
    // theme sat at full level over a film with `pause()` never called.
    const { rerender } = render(<Season key="f1" item={season("A")} />);
    await settle();
    const a = made[0]!;
    // Exact, and it has to be: the bug is that a fade-out scaling by the
    // current volume computes a step of ZERO from silence, so a test that
    // started the film a little way up the ramp would be measuring a fade that
    // can move. Which is why the suite's timer-scaling probe fails this one and
    // must not be "fixed" here - it stretches the settle above past the window,
    // the ramp climbs, and the premise is gone. Nothing about the app changed.
    expect(a.volume, "the fade starts from silence").toBe(0);

    // A film starts before the ramp has moved at all, which is the window.
    await act(async () => {
      usePlayer.setState({ current: playing });
      rerender(<Season key="f1" item={season("A")} />);
    });
    // The pause is waited for; the level is read AFTER a window, and the two
    // cannot be swapped. A pause is an event, so waiting for it removes a guess
    // about the machine and costs nothing. The level is the absence of one -
    // that the fade-in's own interval was cancelled and is not still raising
    // this element - and the fade-out reaches zero on its first tick, so a wait
    // for a low level returns at the instant it is low and never sees a ramp
    // carrying on after it. Measured: a build whose fade-out completes while
    // the fade-in leaks passes the wait and fails this.
    await waitFor(() => expect(a.paused, "it was really paused").toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(a.volume, "and it did not get louder on the way out").toBeLessThanOrEqual(0.01);
  });

  it("stops when the screen is really left", async () => {
    const { unmount } = render(<Season key="s1" item={season("A")} />);
    await settle();
    expect(plays).toEqual(["http://server/t/A"]);
    await act(async () => unmount());
    await settle();
    // Nothing to assert about sound in a stub, so this asserts the state the
    // guard reads: the same series played again means the stop really happened.
    render(<Season key="s3" item={season("A")} />);
    await settle();
    expect(plays).toEqual(["http://server/t/A", "http://server/t/A"]);
  });

  it("stays silent when another series' theme was sounding as the cast arrived", async () => {
    const { rerender } = render(<Season key="a" item={season("A")} />);
    await settle();
    expect(plays, "A's theme is what somebody was listening to").toEqual(["http://server/t/A"]);

    // The film starts and the screen swaps to B in one commit, which is what the
    // cast path really does.
    await act(async () => {
      usePlayer.setState({ current: playing });
      rerender(<Season key="b" item={season("B")} />);
    });
    await settle();

    await act(async () => usePlayer.setState({ current: null }));
    await settle();
    expect(plays, "B's theme must not arrive over the countdown").toEqual(["http://server/t/A"]);
  });

  it("still plays the theme of a series somebody simply walks into", async () => {
    // The other direction, so the suppression cannot quietly become "never".
    render(<Season key="c" item={season("C")} />);
    await settle();
    expect(plays).toEqual(["http://server/t/C"]);
  });
});

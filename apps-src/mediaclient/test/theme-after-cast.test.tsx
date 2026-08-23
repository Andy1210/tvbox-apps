import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useTheme } from "../theme";
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

function Season({ item }: { item: MediaItem | null }): null {
  useTheme(item);
  return null;
}

beforeEach(() => {
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
  class FakeAudio {
    volume = 1;
    onended: (() => void) | null = null;
    constructor(readonly src: string) {}
    play(): Promise<void> {
      plays.push(this.src);
      return Promise.resolve();
    }
    pause(): void {}
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

describe("a series' theme and a film started by voice", () => {
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

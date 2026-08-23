import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { NowPlaying } from "../music/NowPlaying";
import { useMusic } from "../playback/music";
import { useApp } from "../state";
import { setupRemote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaItem } from "../backends/types";

// The queue panel going away and coming back.
//
// Both directions are one motion - the song column gives up the width or takes
// it - and the column can only ANIMATE that if its width is a length in both
// states. It was `flex-1` on one side and `w-[64vw]` on the other, and
// `width: auto` cannot be interpolated: measured in Chrome, coming back out of
// the settled state the column started 26 px wide with the panel already at
// full width beside it, so the whole row appeared at the left edge of the screen
// and slid across. An auto margin made it worse - it re-centres the column the
// instant the panel mounts, a 340 px jump sideways at 1080p.
//
// So the widths are lengths here, and the panel waits for the column to have
// moved before it mounts. This holds both, because neither is visible from the
// code: the classes look symmetrical.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const track: MediaItem = { id: "t1", kind: "track", title: "A Song", grandparentTitle: "An Artist" };

/** The column the song sits in - the only element carrying an inline width. */
function songColumnWidth(root: HTMLElement): string {
  const el = root.querySelector<HTMLElement>("div[style*='width']");
  return el?.style.width ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ backend: null });
  useMusic.setState({ queue: [track], index: 0, state: "playing", positionMs: 0, durationMs: 200_000 });
});

afterEach(() => {
  vi.useRealTimers();
  useMusic.setState({ queue: [], index: 0, state: "stopped" });
});

describe("the screen settling and waking", () => {
  it("animates the song column between two lengths, never from auto", async () => {
    const { container } = render(<NowPlaying />);
    // 90vw of row, less the 3vw gap and the 34vw panel.
    expect(songColumnWidth(container)).toBe("53vw");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    expect(songColumnWidth(container), "settled: the song alone, centred").toBe("64vw");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(songColumnWidth(container), "and straight back to a length").toBe("53vw");
  });

  it("waits for the column to move before the panel comes back", async () => {
    const { container, queryByText } = render(<NowPlaying />);
    const queueHeader = (): HTMLElement | null => queryByText(new RegExp(en.music.queue));
    expect(queueHeader()).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    expect(queueHeader(), "gone with the settle, at once as before").toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    // The press has already given the column its width back, and the panel is
    // still not there: mounting it in the same frame is what put it beside a
    // column that had not moved.
    expect(songColumnWidth(container)).toBe("53vw");
    expect(queueHeader(), "not in the frame the column starts moving in").toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(queueHeader(), "and there once the space is").not.toBeNull();
  });
});

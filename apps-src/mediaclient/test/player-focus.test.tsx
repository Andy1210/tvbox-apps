import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Player } from "../Player";
import { usePlayer } from "../playback/player";
import { useApp } from "../state";
import { setupRemote, remote, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaItem } from "../backends/types";

// The overlay has to own focus, and this is not cosmetic.
//
// Playback starts from a screen behind this one, so focus arrives sitting on
// that screen's play button. The overlay routes the arrows by what has focus -
// the bar scrubs, the button row navigates - so a foreign key silently disabled
// the whole thing: nothing scrubbed, the buttons could not be reached, and OK
// re-fired the play button that still had focus and restarted the film from the
// beginning. Closing the audio menu left focus on a track row and did the same.
//
// Nothing errors in that state and the overlay draws correctly, which is why it
// survived a careful read and had to be found on a sofa.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const item: MediaItem = { id: "m1", kind: "movie", title: "Film", durationMs: 3_600_000 };

beforeEach(async () => {
  useApp.setState({ backend: null });
  usePlayer.setState({
    current: {
      item,
      decision: { url: "http://x/s.m3u8", session: "s", transcoded: false },
      markers: [],
      detail: undefined,
      choice: { version: 0 },
    } as never,
    state: "playing",
    positionMs: 600_000,
    durationMs: 3_600_000,
    seekTargetMs: null,
    scrubMs: null,
    overlay: true,
    buffering: false,
  });
  await act(async () => setFocus(""));
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushFocus();
}

describe("the playback overlay", () => {
  it("takes focus off the screen that started the film", async () => {
    // What arriving from the detail page looks like: its play button still has
    // focus when the overlay mounts.
    render(<Player />);
    await act(async () => setFocus("detail-play"));
    await settle();

    expect(getCurrentFocusKey()).toBe("scrub");
  });

  it("scrubs on Left and Right rather than seeking", async () => {
    render(<Player />);
    await settle();
    expect(getCurrentFocusKey()).toBe("scrub");

    await remote.right();

    // The cursor moved; the film did not. That distinction is the whole point:
    // a seek costs a transcode segment and a rebuffer, so hunting for a scene
    // used to mean paying for one per press.
    expect(usePlayer.getState().scrubMs).toBeGreaterThan(600_000);
    expect(usePlayer.getState().seekTargetMs).toBeNull();
  });

  it("commits on OK and cancels on Back", async () => {
    render(<Player />);
    await settle();

    await remote.right();
    const aimedAt = usePlayer.getState().scrubMs!;
    await remote.ok();

    expect(usePlayer.getState().seekTargetMs).toBe(aimedAt);
    expect(usePlayer.getState().scrubMs).toBeNull();

    await remote.right();
    expect(usePlayer.getState().scrubMs).not.toBeNull();
    await remote.back();
    // Back withdraws the question rather than pausing: the cursor is a question
    // that has not been answered, and leaving it drawn over a paused film points
    // at a place the film never went.
    expect(usePlayer.getState().scrubMs).toBeNull();
    expect(usePlayer.getState().state).toBe("playing");
  });

  it("does not hide the overlay while a cursor is armed", async () => {
    render(<Player />);
    await settle();

    await remote.right();
    expect(usePlayer.getState().scrubMs).not.toBeNull();

    // Well past the idle timeout. Hiding here left the film looking untouched
    // while OK still meant "jump to a place you can no longer see".
    await act(async () => {
      await new Promise((r) => setTimeout(r, 4_500));
    });

    expect(usePlayer.getState().overlay).toBe(true);
  });
});

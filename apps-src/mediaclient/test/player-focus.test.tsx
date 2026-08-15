import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Player } from "../Player";
import { usePlayer, __wirePlayerEventsForTest } from "../playback/player";
import { useApp } from "../state";
import { doesFocusableExist } from "@noriginmedia/norigin-spatial-navigation";
import { setupRemote, remote, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaItem } from "../backends/types";

// The overlay has three states, and which one it is in decides what every key
// means: nothing focused (arrows jump ten seconds, OK pauses), the bar (arrows
// move a cursor, OK goes there), the button row (spatial navigation).
//
// Nothing focused is the resting state, and getting there is not automatic.
// Playback starts from the screen behind this one, so focus arrives sitting on
// THAT screen's play button - which silently disabled the whole overlay:
// nothing scrubbed, the buttons could not be reached, and OK re-fired the play
// button and restarted the film. Closing the audio menu left focus on a track
// row and did the same.
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
    // The real sequence: the detail page's play button has focus, OK starts the
    // film, and the overlay mounts underneath that focus.
    await act(async () => setFocus("detail-play"));
    render(<Player />);
    await settle();

    // Resting, not on the bar: the arrows must jump rather than scrub, and OK
    // must not reach the play button that started the film.
    expect(getCurrentFocusKey()).toBe("player-idle");
  });

  it("jumps rather than scrubs while nothing is focused", async () => {
    render(<Player />);
    await settle();

    await remote.right();

    // A real seek, and no cursor: this is what a reflexive press should do.
    expect(usePlayer.getState().scrubMs).toBeNull();
    expect(usePlayer.getState().seekTargetMs).toBe(610_000);
  });

  it("moves between resting, the bar and the buttons in one press each", async () => {
    // Every vertical move is decided by the handler rather than by geometry.
    // Spatial navigation cannot make the first step at all - resting means
    // nothing is focused, so it has no origin - and once the resting anchor is
    // a focusable it is also a candidate, so leaving the rest to geometry let
    // Up from a button land back on it instead of the bar.
    render(<Player />);
    await settle();
    expect(getCurrentFocusKey()).toBe("player-idle");

    await remote.up();
    expect(getCurrentFocusKey()).toBe("scrub");

    await remote.down();
    expect(getCurrentFocusKey()).toBe("pb-playpause");

    await remote.up();
    expect(getCurrentFocusKey()).toBe("scrub");
  });

  it("scrubs on Left and Right once the bar has focus", async () => {
    render(<Player />);
    await settle();
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe("scrub");

    await remote.right();

    // The cursor moved; the film did not. That distinction is the whole point:
    // a seek costs a transcode segment and a rebuffer, so hunting for a scene
    // would otherwise mean paying for one per press.
    expect(usePlayer.getState().scrubMs).toBeGreaterThan(600_000);
    expect(usePlayer.getState().seekTargetMs).toBeNull();
  });

  it("commits on OK and cancels on Back", async () => {
    render(<Player />);
    await settle();
    await remote.up();

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
    await remote.up();
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

describe("a seek that has been committed", () => {
  it("settles when the player lands past it, in either direction", async () => {
    // Driven through the REAL bridge event path, because the failure is in how
    // the reducer treats a report, and a copy of the rule in a test would agree
    // with itself no matter what the player does.
    //
    // The player reports its OLD position until a seek lands, so the target is
    // held to stop the bar jumping backwards. Releasing it on a window alone was
    // wrong both ways: a forward seek that lands on the next keyframe a few
    // seconds beyond the target never reports inside the window again, so the
    // bar froze at the target while the film played on; and testing "past the
    // target" without the direction clears it on the first stale report of a
    // BACKWARD seek, which snaps it back.
    let emit: ((ev: { type: string; ms?: number }) => void) | undefined;
    (window as unknown as { tvbox: unknown }).tvbox = {
      player: { play: () => {}, seek: () => {}, stop: () => {} },
      onPlayer: (cb: (ev: { type: string; ms?: number }) => void) => {
        emit = cb;
        return () => {};
      },
    };
    __wirePlayerEventsForTest();
    expect(emit).toBeDefined();

    const report = (ms: number): void => emit!({ type: "position", ms });

    // Forward from 100s to 600s.
    usePlayer.setState({ positionMs: 100_000 });
    usePlayer.getState().seekTo(600_000);
    report(100_500); // still where it was
    expect(usePlayer.getState().seekTargetMs).toBe(600_000);
    report(603_000); // landed on the next keyframe, past the target
    expect(usePlayer.getState().seekTargetMs).toBeNull();

    // Backward from 600s to 100s. Every stale report is already past it.
    usePlayer.setState({ positionMs: 600_000 });
    usePlayer.getState().seekTo(100_000);
    report(600_500);
    expect(usePlayer.getState().seekTargetMs).toBe(100_000);
    report(97_000);
    expect(usePlayer.getState().seekTargetMs).toBeNull();

    // A seek to where the film already is: rewinding at the start clamps the
    // target onto the origin, and the distance rule degenerates there. Held on
    // it alone, only a landing within two seconds could ever release it.
    usePlayer.setState({ positionMs: 0 });
    usePlayer.getState().seekTo(0);
    report(5_000);
    expect(usePlayer.getState().seekTargetMs).toBeNull();

    // A backward seek that lands PAST its target, on the first keyframe after
    // it, and then plays away from it. Held on direction alone this never
    // settled: the bar and clock froze at the target for the rest of the film,
    // and every later jump and scrub took that stale number as its origin.
    usePlayer.setState({ positionMs: 1_200_000 });
    usePlayer.getState().seekTo(600_000);
    report(1_199_000); // still where it was
    expect(usePlayer.getState().seekTargetMs).toBe(600_000);
    report(604_000); // landed, 4s past the target
    expect(usePlayer.getState().seekTargetMs).toBeNull();
  });
});

describe("the skip button", () => {
  it("hands the cursor back when it goes away", async () => {
    // It disappears by design - three seconds after a marker starts, when the
    // marker passes, or when the overlay hides - and focus stays on a key that
    // no longer exists, so every press after that is discarded. This is the
    // same failure as every other vanishing focusable here, on the one that is
    // MEANT to vanish.
    render(<Player />);
    await settle();

    await act(async () => setFocus("skip"));
    expect(getCurrentFocusKey()).toBe("skip");

    // A real transition: the overlay hiding is one of the three ways the button
    // goes away, and it is the one a test can drive.
    await act(async () => {
      usePlayer.setState({ overlay: false });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();

    expect(getCurrentFocusKey()).not.toBe("skip");
    expect(getCurrentFocusKey()).toBeTruthy();
  });

  it("does not take the cursor back every time the overlay reappears", async () => {
    // It announces itself for three seconds when a marker starts, and taking the
    // cursor is the point of that. But it is ALSO on screen whenever the overlay
    // is up, and the overlay comes up on every keypress - so keying the grab on
    // visibility re-took the cursor on every press for the whole two minutes of
    // an intro. What that felt like: Right seeked once and then stopped moving
    // the film at all, and OK-OK skipped the intro instead of pausing.
    usePlayer.setState({
      current: {
        item,
        decision: { url: "http://x/s.m3u8", session: "s", transcoded: false },
        markers: [{ type: "intro", startMs: 595_000, endMs: 700_000 }],
        detail: undefined,
        choice: { version: 0 },
      } as never,
      overlay: false,
    });
    render(<Player />);
    await settle();

    // Past the three seconds the button announces itself for, and then with the
    // overlay hidden - which is what the idle timer does a second later. Both
    // halves matter: with the overlay still up the button is on screen the whole
    // time and nothing toggles, so a press proves nothing.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3_100));
    });
    await act(async () => {
      usePlayer.setState({ overlay: false });
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => setFocus("player-idle"));
    await flushFocus();
    expect(getCurrentFocusKey()).toBe("player-idle");

    // A press with the marker still running. The overlay comes back up, so the
    // button is on screen again - and it must stay where it is.
    await remote.right();
    await settle();
    expect(getCurrentFocusKey(), "the skip button took the cursor off a resting press").toBe("player-idle");

    // Which means the arrow did what resting arrows do.
    expect(usePlayer.getState().seekTargetMs).toBe(610_000);
  });

  it("keeps the highlight when Left runs off the end of the button row", async () => {
    // The row hands Left and Right to spatial navigation so the transport
    // buttons can be walked, and the resting anchor is a zero-sized element at
    // the page origin - a perfectly good LEFT candidate from the leftmost
    // button. Nothing was then highlighted, and the arrows silently went back to
    // meaning a ten-second seek.
    render(<Player />);
    await settle();
    await act(async () => setFocus("pb-playpause"));
    await flushFocus();

    for (let i = 0; i < 4; i++) {
      await remote.left();
      await settle();
      expect(getCurrentFocusKey(), `after ${i + 1} Left press(es)`).not.toBe("player-idle");
    }
  });
});

describe("the overlay's own controls", () => {
  it("comes up on OK rather than pausing, and Back closes it", async () => {
    // A stray OK used to pause the film. What someone reaching for the remote
    // wants is the controls - and the pause button is the one already focused
    // when they arrive, so pausing is still one press away.
    render(<Player />);
    await settle();
    usePlayer.setState({ overlay: false });

    await remote.ok();
    await settle();
    expect(usePlayer.getState().state).toBe("playing");
    expect(usePlayer.getState().overlay).toBe(true);
    expect(getCurrentFocusKey()).toBe("pb-playpause");

    // Back undoes the last thing opened - the controls - rather than pausing.
    await remote.back();
    await settle();
    expect(usePlayer.getState().overlay).toBe(false);
    expect(usePlayer.getState().state).toBe("playing");

    // With them closed, Back is what it always was.
    await remote.back();
    expect(usePlayer.getState().state).toBe("paused");
  });
});

describe("the chapter strip", () => {
  const withChapters = (): void => {
    usePlayer.setState({
      current: {
        item,
        decision: { url: "http://x/s.m3u8", session: "s", transcoded: false },
        markers: [],
        detail: {
          id: "m1",
          kind: "movie",
          title: "Film",
          roles: [],
          extras: [],
          reviews: [],
          scores: [],
          versions: [{ index: 0, label: "1080p", partId: "1", audio: [], subtitles: [] }],
          chapters: [
            { index: 1, startMs: 0, endMs: 600_000 },
            { index: 2, startMs: 600_000, endMs: 1_200_000 },
            { index: 3, startMs: 1_200_000, endMs: 1_800_000 },
          ],
        },
        choice: { version: 0 },
      } as never,
      positionMs: 700_000,
      overlay: true,
    });
  };

  /** Down from the transport buttons, which is the request for the strip. */
  const openStrip = async (): Promise<void> => {
    await act(async () => setFocus("pb-playpause"));
    await flushFocus();
    await remote.down();
    await settle();
  };

  it("is not there until Down from the buttons asks for it", async () => {
    // Tall enough to matter over a running film, so it is asked for rather than
    // dismissed - and it opens pointing at the chapter being played, not at the
    // start of the film, which is never where anyone is.
    withChapters();
    render(<Player />);
    await settle();

    expect(doesFocusableExist("chapters"), "closed until it is asked for").toBe(false);

    // The bar still goes to the buttons, and only the buttons open the strip.
    await act(async () => setFocus("scrub"));
    await flushFocus();
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe("pb-playpause");

    await remote.down();
    await settle();
    // 700_000 is inside the second chapter.
    expect(getCurrentFocusKey()).toBe("ch-2-600000");
  });

  it("closes on the way back up to the buttons", async () => {
    withChapters();
    render(<Player />);
    await settle();
    await openStrip();

    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe("pb-playpause");
    expect(doesFocusableExist("chapters"), "out only while the cursor is in it").toBe(false);
  });

  it("does not seek when the arrows are choosing a chapter", async () => {
    // Left and Right belong to the strip here, exactly as they do on the button
    // row. Treated as resting they would have jumped the film ten seconds per
    // press while the cursor appeared to move between thumbnails.
    withChapters();
    render(<Player />);
    await settle();
    await openStrip();

    usePlayer.setState({ seekTargetMs: null });
    await remote.right();
    await settle();
    expect(usePlayer.getState().seekTargetMs, "an arrow on the strip is not a seek").toBeNull();
  });

  it("goes where the chapter starts, and puts the strip away", async () => {
    withChapters();
    render(<Player />);
    await settle();
    await openStrip();

    // Read off the focused tile rather than assumed: which one Right lands on
    // is geometry, and this harness places no rectangles. What is being tested
    // is that OK goes to the chapter under the cursor, whichever that is.
    await remote.right();
    await settle();
    const startMs = Number(String(getCurrentFocusKey()).split("-").at(-1));
    expect(Number.isFinite(startMs)).toBe(true);

    await remote.ok();
    await settle();
    expect(usePlayer.getState().seekTargetMs).toBe(startMs);
    expect(doesFocusableExist("chapters"), "the press was a destination, not a browse").toBe(false);
  });

  it("does nothing on a film with no chapters", async () => {
    render(<Player />);
    await settle();
    await act(async () => setFocus("pb-playpause"));
    await flushFocus();
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe("pb-playpause");
  });
});

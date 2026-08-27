import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Player } from "../Player";
import { usePlayer } from "../playback/player";
import { useApp } from "../state";
import { setupRemote, remote, setFocus, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaItem } from "../backends/types";

/**
 * Back must leave the film whichever window listener sees the key first.
 *
 * Two capture-phase keydown listeners on `window` are in play, and the order
 * between them is decided by which registered first: the SDK's single
 * `useBackspace` stack (installed once, by the first enabled handler in the app)
 * and the player's own `onKey`, which raises the overlay for anything it is
 * handed. In the real app MediaClient mounts first, so the stack wins and the
 * player's listener never sees a Back key at all.
 *
 * This file is a SEPARATE FILE on purpose: vitest gives it its own module
 * registry, so the SDK's module-global "am I listening" flag starts false and
 * the first thing to mount is the player - whose `onKey` effect is declared
 * above its `useBackspace`, and therefore registers first. That is the reversed
 * order, and without the `isBackKey` guard in `onKey` the press raises the
 * overlay before the stack reads it, the stack then reads that as "close the
 * controls", and Back can never leave the film. Measured: this test passes in
 * `player-focus.test.tsx`'s file order either way, and fails here without the
 * guard.
 */

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
    overlay: false,
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

describe("Back with the player's own key listener registered first", () => {
  it("still leaves the film on one press", async () => {
    // The premise, asserted rather than assumed: NOTHING has taken a Back key
    // before this render. The SDK's stack installs its window listener on the
    // first enabled handler and calls `preventDefault` whenever it has one, so
    // an unprevented Back key means the stack is still empty and the player's
    // own listener is about to register first. Without this, a wrapper added to
    // this file - or moving `useBackspace` above the key effect in Player.tsx -
    // would leave the test passing with the guard deleted, covering nothing.
    const probe = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    window.dispatchEvent(probe);
    expect(probe.defaultPrevented).toBe(false);

    render(<Player />);
    await settle();
    // The controls come up on mount and hide themselves four seconds later; the
    // press this is about is the one that arrives with nothing over the picture.
    await act(async () => {
      usePlayer.setState({ overlay: false });
    });
    await settle();
    expect(usePlayer.getState().overlay).toBe(false);

    await remote.back();
    await settle();

    expect(usePlayer.getState().state).toBe("stopped");
    expect(usePlayer.getState().current).toBe(null);
  });
});

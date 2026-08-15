import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePlayer, resetPlayer } from "../playback/player";
import type { MediaBackend, MediaItem, StreamDecision } from "../backends/types";

/**
 * The running order, driven through the real `play()`.
 *
 * The first version of this test only did `usePlayer.setState({ queue, siblings })`
 * and then asserted what it had just set, so it could not fail: gutting the whole
 * queue block in `play()` left it green, and three separate ways of losing the
 * order shipped underneath it. Everything here goes through the store's own code.
 */

const film = (id: string): MediaItem => ({ id, kind: "movie", title: id.toUpperCase() });
const episode = (id: string, parentId: string): MediaItem => ({ id, kind: "episode", title: id, parentId });

function fakeBackend(over: Partial<MediaBackend> = {}): MediaBackend {
  return {
    kind: "plex",
    resolveStream: async (): Promise<StreamDecision> =>
      ({
        url: "http://server/file.mkv",
        audio: "auto",
        sub: "no",
        session: "s",
        transcoded: false,
        version: 0,
      }) as StreamDecision,
    markers: async () => [],
    item: async (id: string) => ({ id, kind: "movie", title: id, versions: [], roles: [], extras: [] }),
    // The parentage fallback, which the queue is supposed to outrank.
    children: async () => [episode("e1", "s1"), episode("e2", "s1"), episode("e3", "s1")],
    reportProgress: async () => {},
    keepAlive: async () => {},
    endSession: async () => {},
    ...over,
  } as unknown as MediaBackend;
}

let played: string[] = [];
/** The shell's own player events, as the store subscribes to them. */
let listeners: ((ev: { type: string; reason?: string }) => void)[] = [];
const emit = (ev: { type: string; reason?: string }): void => listeners.forEach((l) => l(ev));

/** Let queued promises run while the clock is fake. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  played = [];
  listeners = [];
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: (url: string) => played.push(url),
    stop: () => {},
    pause: () => {},
    resume: () => {},
    onPlayer: (fn: (ev: { type: string; reason?: string }) => void) => {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },
    panel: { width: 1920, height: 1080 },
  };
});

afterEach(() => {
  resetPlayer();
  vi.useRealTimers();
});

describe("the list something was started from", () => {
  it("wins over what the item belongs to", async () => {
    // A playlist is a running order and it outranks parentage. Without it an
    // episode played from a playlist was followed by the next episode of its
    // SERIES - the fallback below returns e1/e2/e3 and would win.
    const queue = [film("f1"), episode("e2", "s1"), film("f3")];
    await usePlayer.getState().play(fakeBackend(), queue[1], { queue });

    expect(usePlayer.getState().siblings.prev?.id).toBe("f1");
    expect(usePlayer.getState().siblings.next?.id).toBe("f3");
    expect(usePlayer.getState().queue?.length).toBe(3);
  });

  it("gives a film a next, which parentage never could", async () => {
    const queue = [film("f1"), film("f2")];
    await usePlayer.getState().play(fakeBackend(), queue[0], { queue });
    expect(usePlayer.getState().siblings.next?.id).toBe("f2");
  });

  it("survives a change of quality or audio", async () => {
    // changeTracks restarts the stream by calling play() again, and play() sets
    // the order from what it is handed - so a restart that did not carry it
    // cleared it. Measured: the prev/next buttons vanished part-way through a
    // playlist, and on an episode the series' order silently replaced it.
    const queue = [film("f1"), film("f2"), film("f3")];
    await usePlayer.getState().play(fakeBackend(), queue[1], { queue });
    await usePlayer.getState().changeTracks({ version: 0, maxBitrateKbps: 2000 });

    expect(usePlayer.getState().queue?.map((q) => q.id)).toEqual(["f1", "f2", "f3"]);
    expect(usePlayer.getState().siblings.next?.id).toBe("f3");
  });

  it("survives the countdown to the next one", async () => {
    // The auto-advance was the one route the order did not travel, so a playlist
    // advanced exactly once and then stopped - the item it landed on had no
    // queue to find a next in. Driven through the real path: the shell's own
    // "finished" event, then the countdown's timer.
    const queue = [film("f1"), film("f2"), film("f3")];
    await usePlayer.getState().play(fakeBackend(), queue[0], { queue });
    expect(usePlayer.getState().siblings.next?.id).toBe("f2");

    // Played to the end: a finish with no reason, at the duration.
    usePlayer.setState({ durationMs: 1_000_000, positionMs: 1_000_000 });
    emit({ type: "finished" });
    await settle();
    expect(usePlayer.getState().upNext?.item.id, "the countdown should be armed").toBe("f2");

    // Let the countdown run out.
    await vi.advanceTimersByTimeAsync(6_000);
    await settle();

    expect(usePlayer.getState().current?.item.id).toBe("f2");
    expect(usePlayer.getState().queue?.map((q) => q.id)).toEqual(["f1", "f2", "f3"]);
    expect(usePlayer.getState().siblings.next?.id, "the step after the auto-advance is where it used to stop").toBe(
      "f3",
    );
  });
});

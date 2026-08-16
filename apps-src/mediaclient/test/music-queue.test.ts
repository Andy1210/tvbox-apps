import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useMusic, resetMusic } from "../playback/music";
import { usePlayer, resetPlayer, __wirePlayerEventsForTest } from "../playback/player";
import { claimPlayer, resetPlayerOwner } from "../playback/owner";
import type { MediaBackend, MediaItem } from "../backends/types";

/**
 * The queue, driven through the store's own `playQueue` rather than by setting
 * state and asserting it back. Everything here is a behaviour somebody can see:
 * which file the box was handed, what happened when it ended, and where the
 * cursor was left.
 */

const track = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id,
  kind: "track",
  title: id.toUpperCase(),
  mediaKey: `/library/parts/${id}/file.mp3`,
  durationMs: 200_000,
  ...over,
});

function fakeBackend(over: Partial<MediaBackend> = {}): MediaBackend {
  return {
    kind: "plex",
    trackUrl: (item: MediaItem) => (item.mediaKey ? `http://server${item.mediaKey}` : undefined),
    posterUrl: () => undefined,
    reportProgress: async () => {},
    keepAlive: async () => {},
    endSession: async () => {},
    ...over,
  } as unknown as MediaBackend;
}

let played: string[] = [];
let stops = 0;
let listeners: ((ev: { type: string; reason?: string; ms?: number }) => void)[] = [];
const emit = (ev: { type: string; reason?: string; ms?: number }): void => listeners.forEach((l) => l(ev));

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  played = [];
  stops = 0;
  listeners = [];
  resetPlayerOwner();
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: (url: string) => played.push(url),
    stop: () => {
      stops += 1;
    },
    pause: () => {},
    resume: () => {},
    seek: () => {},
    onPlayer: (fn: (ev: { type: string; reason?: string; ms?: number }) => void) => {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },
  };
});

afterEach(() => {
  resetMusic();
  resetPlayer();
  resetPlayerOwner();
  vi.useRealTimers();
});

/** Puts the store in the state a song is playing from, without asserting it. */
async function start(items: MediaItem[], opts?: { startIndex?: number; shuffle?: boolean }): Promise<void> {
  await useMusic.getState().playQueue(fakeBackend(), items, opts);
  await settle();
}

describe("starting a queue", () => {
  it("plays the song that was pressed, not the first one", async () => {
    await start([track("a"), track("b"), track("c")], { startIndex: 1 });
    expect(played).toEqual(["http://server/library/parts/b/file.mp3"]);
    expect(useMusic.getState().index).toBe(1);
  });

  it("shuffling still starts on the song that was pressed", async () => {
    // The press said "play this one". A shuffle that starts somewhere else reads
    // as the press having missed, which is the one thing shuffle must not do.
    await start([track("a"), track("b"), track("c"), track("d")], { startIndex: 2, shuffle: true });
    expect(useMusic.getState().queue[0].id).toBe("c");
    expect(useMusic.getState().index).toBe(0);
    expect(useMusic.getState().queue).toHaveLength(4);
  });

  it("skips a song with no file rather than stalling on it", async () => {
    // One unplayable file in a queue of hundreds must not end the evening.
    await start([track("a", { mediaKey: undefined }), track("b")]);
    expect(played).toEqual(["http://server/library/parts/b/file.mp3"]);
    expect(useMusic.getState().index).toBe(1);
  });
});

describe("when a song ends", () => {
  it("starts the next one", async () => {
    await start([track("a"), track("b")]);
    emit({ type: "position", ms: 199_000 });
    emit({ type: "finished" });
    await settle();
    expect(played).toEqual(["http://server/library/parts/a/file.mp3", "http://server/library/parts/b/file.mp3"]);
  });

  it("does not walk the queue when the stream dropped instead", async () => {
    // A dropped connection and a file running out both arrive as `finished` with
    // no reason. Advancing on the first would play the whole library in seconds,
    // reporting each song as listened to.
    await start([track("a"), track("b")]);
    emit({ type: "position", ms: 4_000 });
    emit({ type: "finished" });
    await settle();
    expect(played).toEqual(["http://server/library/parts/a/file.mp3"]);
    expect(useMusic.getState().state).toBe("stopped");
  });

  it("stops when the box says why it ended", async () => {
    await start([track("a"), track("b")]);
    emit({ type: "position", ms: 199_000 });
    emit({ type: "finished", reason: "tv-standby" });
    await settle();
    expect(played).toHaveLength(1);
  });

  it("repeats one only when the box asked, not when Next was pressed", async () => {
    await start([track("a"), track("b")]);
    useMusic.getState().setRepeat("one");

    emit({ type: "position", ms: 199_000 });
    emit({ type: "finished" });
    await settle();
    expect(played[1]).toBe("http://server/library/parts/a/file.mp3");

    await useMusic.getState().next();
    await settle();
    expect(played[2]).toBe("http://server/library/parts/b/file.mp3");
  });

  it("wraps to the top on repeat all, and stops without it", async () => {
    await start([track("a"), track("b")]);
    await useMusic.getState().next();
    await settle();
    await useMusic.getState().next();
    await settle();
    expect(useMusic.getState().state).toBe("stopped");

    await start([track("a"), track("b")]);
    useMusic.getState().setRepeat("all");
    await useMusic.getState().next();
    await settle();
    await useMusic.getState().next();
    await settle();
    expect(useMusic.getState().index).toBe(0);
  });
});

describe("the transport", () => {
  it("restarts the song when Previous comes late, and steps back when it is early", async () => {
    await start([track("a"), track("b")]);
    await useMusic.getState().next();
    await settle();

    emit({ type: "position", ms: 9_000 });
    await useMusic.getState().previous();
    await settle();
    expect(useMusic.getState().index).toBe(1);

    emit({ type: "position", ms: 1_000 });
    await useMusic.getState().previous();
    await settle();
    expect(useMusic.getState().index).toBe(0);
  });
});

describe("editing the queue", () => {
  it("adds after the playing song, or at the end", async () => {
    await start([track("a"), track("b")]);
    useMusic.getState().enqueue([track("x")], "next");
    expect(useMusic.getState().queue.map((t) => t.id)).toEqual(["a", "x", "b"]);
    useMusic.getState().enqueue([track("z")], "end");
    expect(useMusic.getState().queue.map((t) => t.id)).toEqual(["a", "x", "b", "z"]);
  });

  it("keeps the playing song under the cursor when something above it goes", async () => {
    await start([track("a"), track("b"), track("c")], { startIndex: 2 });
    useMusic.getState().removeAt(0);
    expect(useMusic.getState().index).toBe(1);
    expect(useMusic.getState().queue[useMusic.getState().index].id).toBe("c");
  });

  it("refuses to remove the song that is playing", async () => {
    await start([track("a"), track("b")]);
    useMusic.getState().removeAt(0);
    expect(useMusic.getState().queue).toHaveLength(2);
  });

  it("puts the original order back when shuffle goes off", async () => {
    const items = [track("a"), track("b"), track("c"), track("d")];
    await start(items, { startIndex: 0, shuffle: true });
    const playing = useMusic.getState().queue[useMusic.getState().index].id;

    useMusic.getState().setShuffle(false);
    expect(useMusic.getState().queue.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    // Found rather than assumed to be 0: the song keeps playing, and its place
    // in the unshuffled order is wherever it happens to sit.
    expect(useMusic.getState().queue[useMusic.getState().index].id).toBe(playing);
  });
});

describe("sharing the box's one player", () => {
  it("keeps a film's handler out of a song's ending", async () => {
    // Both stores hear every event. Without the ownership guard a song ending
    // reaches the film store as "finished nowhere near the end", which is the
    // one case that calls stop() - and that stop reaches the BOX, silencing the
    // track that had just started. Counting the bridge's stop is what
    // distinguishes the two: the film store's own state is "stopped" either way,
    // so asserting on it would pass with the guard removed.
    __wirePlayerEventsForTest();
    usePlayer.setState({
      current: { item: track("f"), decision: {}, markers: [], choice: { version: 0 } } as never,
      state: "playing",
      durationMs: 7_200_000,
      positionMs: 60_000,
    });
    claimPlayer("music");

    emit({ type: "finished" });
    await settle();

    expect(stops).toBe(0);
    expect(usePlayer.getState().current).not.toBeNull();
  });

  it("and lets them through when no queue is holding it", async () => {
    // The other half: with nobody holding the player the film store still hears
    // everything. A claim that failed to happen must not leave the remote dead.
    __wirePlayerEventsForTest();
    usePlayer.setState({
      current: { item: track("f"), decision: {}, markers: [], choice: { version: 0 } } as never,
      state: "playing",
      durationMs: 7_200_000,
      positionMs: 60_000,
    });

    emit({ type: "finished" });
    await settle();

    expect(stops).toBe(1);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useMusic, resetMusic } from "../playback/music";
import { resetPlayer } from "../playback/player";
import { releasePlayer } from "../playback/owner";
import type { MediaBackend, MediaItem } from "../backends/types";

/**
 * Carrying on where a song was left, and building a queue without starting one.
 *
 * Both are decisions the STORE makes and the screen only reflects, and both have
 * a direction that costs something: a resume that fires on the wrong press drops
 * somebody into the middle of a song they asked for from the top, and an "add"
 * that starts playing is the opposite of what the word means. The start position
 * is what these assert on, because it is the one thing the screen cannot show.
 */

const track = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id,
  kind: "track",
  title: id.toUpperCase(),
  mediaKey: `/library/parts/${id}/file.mp3`,
  durationMs: 200_000,
  ...over,
});

function fakeBackend(): MediaBackend {
  return {
    kind: "plex",
    trackUrl: (item: MediaItem) => (item.mediaKey ? `http://server${item.mediaKey}` : undefined),
    posterUrl: () => undefined,
    reportProgress: async () => {},
    keepAlive: async () => {},
    endSession: async () => {},
  } as unknown as MediaBackend;
}

/** Every start, with the second it was asked to begin at. */
let starts: { url: string; at: number }[] = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  starts = [];
  // `releasePlayer` rather than a full reset: resetting the owner module also
  // drops the callbacks the two stores registered at import, and one of the
  // cases below is exactly what a film taking the player does to the queue.
  releasePlayer("video");
  releasePlayer("music");
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: (url: string, _streams: unknown, startPos: number) => starts.push({ url, at: startPos ?? 0 }),
    stop: () => {},
    pause: () => {},
    resume: () => {},
    seek: () => {},
    onPlayer: () => () => {},
  };
});

afterEach(() => {
  resetMusic();
  resetPlayer();
  releasePlayer("video");
  releasePlayer("music");
  vi.useRealTimers();
});

async function start(items: MediaItem[], opts?: { startIndex?: number }): Promise<void> {
  await useMusic.getState().playQueue(fakeBackend(), items, opts);
  await settle();
}

describe("carrying on where a song was left", () => {
  it("starts a track at the offset the server holds for it", async () => {
    await start([track("a", { viewOffsetMs: 90_000 })]);
    expect(starts).toEqual([{ url: "http://server/library/parts/a/file.mp3", at: 90 }]);
    // And the screen agrees, rather than counting up from zero to meet it.
    expect(useMusic.getState().positionMs).toBe(90_000);
  });

  it("ignores an offset a few seconds in", async () => {
    // Resuming a song ten seconds in is more surprising than starting it.
    await start([track("a", { viewOffsetMs: 9_000 })]);
    expect(starts[0].at).toBe(0);
  });

  it("ignores an offset at the very end", async () => {
    // A track left there is one that finished; starting it at its own end plays
    // nothing and walks the queue on.
    await start([track("a", { viewOffsetMs: 199_000 })]);
    expect(starts[0].at).toBe(0);
  });

  it("carries on from where a stop left it, not from the server's older answer", async () => {
    await start([track("a", { viewOffsetMs: 30_000 }), track("b")]);
    useMusic.setState({ positionMs: 120_000 });
    await useMusic.getState().stop();
    await settle();
    starts = [];
    useMusic.getState().toggle(); // Play, on a queue that is still in hand
    await settle();
    expect(starts[0].at).toBe(120);
  });

  it("forgets the resume point once it has been used", async () => {
    await start([track("a")]);
    useMusic.setState({ positionMs: 120_000 });
    await useMusic.getState().stop();
    await settle();
    expect(useMusic.getState().resume).not.toBeNull();
    useMusic.getState().toggle();
    await settle();
    expect(useMusic.getState().resume).toBeNull();
  });

  it("remembers nothing when the queue simply ran out", async () => {
    // The last track ends at its own end, and that is not a place to come back
    // to - the whole queue would restart at its final second.
    await start([track("a")]);
    useMusic.setState({ positionMs: 199_500 });
    await useMusic.getState().stop();
    await settle();
    expect(useMusic.getState().resume).toBeNull();
  });

  it("starts the NEXT track from the beginning, whatever the server holds", async () => {
    await start([track("a"), track("b", { viewOffsetMs: 90_000 })]);
    starts = [];
    await useMusic.getState().next(true);
    await settle();
    expect(starts[0]).toEqual({ url: "http://server/library/parts/b/file.mp3", at: 0 });
  });

  it("restarts the current song from the beginning when Previous means restart", async () => {
    await start([track("a", { viewOffsetMs: 90_000 })]);
    useMusic.setState({ positionMs: 95_000 });
    starts = [];
    await useMusic.getState().previous();
    await settle();
    expect(starts[0].at).toBe(0);
  });

  it("keeps a place when a film takes the player away", async () => {
    await start([track("a")]);
    useMusic.setState({ positionMs: 60_000 });
    // What the film's own claim does to the music store.
    const { claimPlayer } = await import("../playback/owner");
    claimPlayer("video");
    await settle();
    expect(useMusic.getState().resume).toEqual({ index: 0, ms: 60_000 });
  });
});

describe("adding to the queue rather than playing", () => {
  it("builds a queue out of nothing and starts nothing", async () => {
    useMusic.getState().enqueue([track("a"), track("b")], "end");
    await settle();
    expect(starts).toEqual([]);
    expect(useMusic.getState().state).toBe("stopped");
    // Pointing at its first track, or no screen could show it and Play would
    // have no index to start.
    expect(useMusic.getState().index).toBe(0);
    expect(useMusic.getState().queue.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("leaves the playing track where it is when songs are added to the end", async () => {
    await start([track("a"), track("b")], { startIndex: 1 });
    useMusic.getState().enqueue([track("c")], "end");
    expect(useMusic.getState().index).toBe(1);
    expect(useMusic.getState().queue.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("counts what one run of the mode added, and starts again at the next", () => {
    useMusic.getState().setAdding(true);
    useMusic.getState().enqueue([track("a"), track("b")], "end");
    expect(useMusic.getState().added).toBe(2);
    useMusic.getState().setAdding(false);
    useMusic.getState().setAdding(true);
    expect(useMusic.getState().added).toBe(0);
  });

  it("keeps the songs when shuffle is switched off afterwards", async () => {
    await start([track("a"), track("b")]);
    useMusic.getState().setShuffle(true);
    useMusic.getState().enqueue([track("c")], "end");
    useMusic.getState().setShuffle(false);
    // The unshuffled order gained them too, or turning shuffle off would drop
    // everything added while it was on.
    expect(useMusic.getState().queue.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
  });
});

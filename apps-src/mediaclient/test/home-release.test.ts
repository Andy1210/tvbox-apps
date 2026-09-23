import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { usePlayer, resetPlayer } from "../playback/player";
import { __lifecycle } from "../lifecycle";
import type { MediaItem, StreamDecision } from "../backends/types";

/**
 * Home during a film.
 *
 * The shell hides this window and stops the film, so the store has to stop
 * saying one is playing: coming back to "playing" was a frozen overlay over
 * nothing, with the browsing screens hidden and the screensaver held off.
 */

let ended: string[] = [];

const backend = {
  kind: "plex",
  resolveStream: async (): Promise<StreamDecision> =>
    ({ url: "http://x/f.mkv", audio: "auto", sub: "no", session: "s1", transcoded: false, version: 0 }) as never,
  markers: async () => [],
  item: async () => ({ id: "m1", kind: "movie", title: "A film", versions: [], roles: [], extras: [] }),
  children: async () => [],
  reportProgress: async () => {},
  keepAlive: async () => {},
  endSession: async (s: string) => {
    ended.push(s);
  },
} as never;

beforeEach(() => {
  ended = [];
  __lifecycle.reset();
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: () => {},
    stop: () => {},
    onPlayer: () => () => {},
    setPlayerProp: () => Promise.resolve({ ok: true }),
    panel: { width: 1920, height: 1080 },
  };
});

afterEach(() => resetPlayer());

describe("pressing Home during a film", () => {
  it("leaves the store saying nothing is playing", async () => {
    const item: MediaItem = { id: "m1", kind: "movie", title: "A film" };
    await usePlayer.getState().play(backend, item, {});
    expect(usePlayer.getState().current).toBeTruthy();

    __lifecycle.release("hidden");

    expect(usePlayer.getState().current).toBeNull();
    expect(usePlayer.getState().state).toBe("stopped");
    expect(ended).toEqual(["s1"]);
  });
});

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

describe("pressing Home while a film is being fetched", () => {
  it("gives up a play still resolving when nothing was on screen", async () => {
    let plays = 0;
    (globalThis as unknown as { tvbox: { play: () => void } }).tvbox.play = () => {
      plays += 1;
    };
    const item: MediaItem = { id: "m1", kind: "movie", title: "A film" };
    await usePlayer.getState().play(backend, item, {});
    await usePlayer.getState().stop();
    expect(usePlayer.getState().current).toBeNull();
    const before = plays;

    let resolve = (_d: StreamDecision): void => {};
    const slow = {
      ...(backend as object),
      resolveStream: () => new Promise<StreamDecision>((r) => (resolve = r)),
    } as never;
    const pending = usePlayer.getState().play(slow, item, {});
    __lifecycle.release("hidden");
    resolve({ url: "http://x/f.mkv", audio: "auto", sub: "no", session: "s2", transcoded: false, version: 0 } as never);
    await pending;

    expect(plays, "nothing started behind the launcher").toBe(before);
    expect(usePlayer.getState().current).toBeNull();
  });
});

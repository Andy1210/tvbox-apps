import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { usePlayer, resetPlayer } from "../playback/player";
import type { MediaItem, StreamDecision } from "../backends/types";

/**
 * Shifting the subtitles in time.
 *
 * Deliberately NOT a saved preference, unlike their size and colour: an offset
 * corrects one badly timed file, so carrying it forward would break subtitles
 * that were already right.
 */

let props: [string, unknown][] = [];
let accept = true;

beforeEach(() => {
  props = [];
  accept = true;
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: () => {},
    stop: () => {},
    onPlayer: () => () => {},
    setPlayerProp: (name: string, value: unknown) => {
      props.push([name, value]);
      return Promise.resolve({ ok: accept });
    },
    panel: { width: 1920, height: 1080 },
  };
});

afterEach(() => resetPlayer());

describe("the subtitle offset", () => {
  it("reaches the player as seconds", () => {
    usePlayer.getState().nudgeSubDelay(0.25);
    usePlayer.getState().nudgeSubDelay(0.25);
    expect(usePlayer.getState().subDelaySec).toBe(0.5);
    expect(props.at(-1)).toEqual(["sub-delay", 0.5]);

    usePlayer.getState().nudgeSubDelay(-1);
    expect(usePlayer.getState().subDelaySec).toBe(-0.5);
  });

  it("stays inside what the shell will accept", () => {
    // The shell's allowlist bounds sub-delay at 120 seconds and REFUSES anything
    // outside it. A refused value never reaches mpv, so an unclamped number on
    // screen would disagree with the subtitles, silently.
    usePlayer.getState().nudgeSubDelay(500);
    expect(usePlayer.getState().subDelaySec).toBe(120);
    usePlayer.getState().nudgeSubDelay(-500);
    expect(usePlayer.getState().subDelaySec).toBe(-120);
    for (const [, v] of props) expect(Math.abs(v as number)).toBeLessThanOrEqual(120);
  });

  it("does not accumulate floating-point dust", () => {
    // The row steps by a quarter second, which is a power of two and therefore
    // exact - so this drives a tenth instead, which is not: three of them come
    // to 0.30000000000000004 unrounded. The guard is on the store rather than
    // on today's step size, because the number is shown to two places right
    // next to subtitles somebody is lining up by eye.
    for (let i = 0; i < 3; i++) usePlayer.getState().nudgeSubDelay(0.1);
    expect(usePlayer.getState().subDelaySec).toBe(0.3);
    expect(props.at(-1)).toEqual(["sub-delay", 0.3]);
  });

  it("starts over with the next film", async () => {
    usePlayer.getState().nudgeSubDelay(2);
    expect(usePlayer.getState().subDelaySec).toBe(2);

    const item: MediaItem = { id: "m2", kind: "movie", title: "Another" };
    await usePlayer.getState().play(
      {
        kind: "plex",
        resolveStream: async (): Promise<StreamDecision> =>
          ({ url: "http://x/f.mkv", audio: "auto", sub: "no", session: "s", transcoded: false, version: 0 }) as never,
        markers: async () => [],
        item: async () => ({ id: "m2", kind: "movie", title: "Another", versions: [], roles: [], extras: [] }),
        children: async () => [],
        reportProgress: async () => {},
        keepAlive: async () => {},
        endSession: async () => {},
      } as never,
      item,
      {},
    );

    expect(usePlayer.getState().subDelaySec, "an offset belongs to the file it was found on").toBe(0);
  });
});

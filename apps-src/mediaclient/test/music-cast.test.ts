import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCompanionCommand } from "../playback/remoteControl";
import { usePlayer, resetPlayer } from "../playback/player";
import { useMusic, resetMusic } from "../playback/music";
import { useApp } from "../state";
import { __lifecycle } from "../lifecycle";

/**
 * A cast from Plexamp or the phone app, which is MUSIC.
 *
 * It arrives down the same wire as a film and looked identical to the handler,
 * so every cast was handed to the film player: it took the screen, stopped
 * whatever was on, and played one track of an album as if it were a movie.
 *
 * The running order is the other half. A controller that casts does not send a
 * list - it builds a play queue on the server and sends its key - so without
 * reading the queue back, a cast album is one track and then silence.
 */

const started: string[] = [];

const TRACKS = [
  { id: "9001", kind: "track", title: "Első" },
  { id: "9002", kind: "track", title: "Második" },
  { id: "9003", kind: "track", title: "Harmadik" },
];

function backend(over: Record<string, unknown> = {}): unknown {
  return {
    kind: "plex",
    item: async (id: string) => ({ id, kind: "track", title: `Track ${id}`, versions: [], roles: [], extras: [] }),
    queueItems: async () => ({ items: TRACKS, startIndex: 1 }),
    trackUrl: (item: { id: string }) => {
      started.push(item.id);
      return `http://s/${item.id}.flac`;
    },
    reportProgress: async () => {},
    keepAlive: async () => {},
    endSession: async () => {},
    ...over,
  };
}

beforeEach(() => {
  started.length = 0;
  __lifecycle.reset();
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: () => {},
    stop: () => {},
    pause: () => {},
    resume: () => {},
    seek: () => {},
    onPlayer: () => () => {},
    panel: { width: 1920, height: 1080 },
  };
  useApp.setState({ backend: backend() as never, screen: { name: "home" }, history: [] });
});

afterEach(() => {
  resetPlayer();
  resetMusic();
});

const cast = (params: Record<string, string>) =>
  runCompanionCommand({
    path: "/player/playback/playMedia",
    params: {
      queryKey: "/library/metadata/9002",
      queryContainerKey: "/playQueues/20406",
      queryType: "music",
      commandID: "1",
      ...params,
    },
  });

describe("a cast of music", () => {
  it("goes to the music player, not the film player", async () => {
    const res = await cast({});

    expect(res).toEqual({ ok: true });
    expect(useMusic.getState().queue.length, "the whole queue, not one track").toBe(3);
    // The film player must not have been touched: it owns the screen, and
    // taking it for a song is what made a cast interrupt what was on.
    expect(usePlayer.getState().current).toBeNull();
  });

  it("starts on the track that was pressed, not at the top of the album", async () => {
    await cast({});

    // The queue carries an offset because a controller builds the whole album
    // and says where to begin; ignoring it plays the album from the start
    // whatever was tapped.
    expect(useMusic.getState().index).toBe(1);
    expect(started[0]).toBe("9002");
  });

  it("is music because the ITEM is a track, whatever the controller called it", async () => {
    // `type` is the controller's word. A cast that omits it - or sends the
    // wrong one - would otherwise be played as a film.
    const res = await cast({ queryType: "video" });

    expect(res).toEqual({ ok: true });
    expect(useMusic.getState().queue.length).toBe(3);
    expect(usePlayer.getState().current).toBeNull();
  });

  it("falls back to the one track when the queue cannot be read", async () => {
    useApp.setState({
      backend: backend({
        queueItems: async () => {
          throw new Error("500");
        },
      }) as never,
    });

    const res = await cast({});

    // A worse answer than the album, but an honest one, and it is what was
    // asked for.
    expect(res).toEqual({ ok: true });
    expect(useMusic.getState().queue.length).toBe(1);
    expect(started).toEqual(["9002"]);
  });

  it("refuses while the app is not on screen", async () => {
    // The box has ONE shared player and the shell will not hand it to a window
    // nobody is looking at - so a cast that reported success here would be the
    // house saying music is playing over a launcher.
    __lifecycle.release("hidden");

    const res = await cast({});

    expect(res).toEqual({ ok: false, reason: "the media app is not on screen" });
    expect(started).toEqual([]);
  });
});

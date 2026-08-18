import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCompanionCommand } from "../playback/remoteControl";
import { usePlayer, resetPlayer } from "../playback/player";
import { useMusic, resetMusic } from "../playback/music";
import { useApp } from "../state";
import { __lifecycle } from "../lifecycle";
import { forgetCastQueue, timelineFor } from "../playback/timeline";
import type { MediaItem } from "../backends/types";

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
    queueItems: async () => ({
      items: TRACKS,
      startIndex: 1,
      // The queue's own ids, which is what a controller matches against.
      // In the SERVER's order; the report keys them by item, because the store's
      // index walks the shuffled one.
      entryIds: ["q1", "q2", "q3"],
      version: "3",
    }),
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

const launched: string[] = [];
let launchRefused = false;

beforeEach(() => {
  started.length = 0;
  launchRefused = false;
  __lifecycle.reset();
  (globalThis as { window?: unknown }).window = globalThis;
  launched.length = 0;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    // What the box does when an app asks to be brought forward: the window is
    // shown, so the page is visible again. `launchRefused` is how a test says
    // the box did not manage it.
    launch: (id: string) => {
      launched.push(id);
      if (!launchRefused) __lifecycle.resume();
    },
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

describe("the transport, once a cast is playing", () => {
  const transport = (path: string) => runCompanionCommand({ path, params: { commandID: "2" } });

  beforeEach(async () => {
    await cast({});
  });

  it("pauses and resumes the MUSIC, not the film player", async () => {
    // Every transport case used to test the film player's `current`, which a
    // cast never sets: the phone said "nothing is playing" while it played on.
    expect(await transport("/player/playback/pause")).toEqual({ ok: true });
    expect(useMusic.getState().state).toBe("paused");
    expect(await transport("/player/playback/play")).toEqual({ ok: true });
    expect(useMusic.getState().state).toBe("playing");
  });

  it("stops it, rather than answering ok and stopping nothing", async () => {
    // The worst of the six: `stop` returned ok as "already what was asked for"
    // - true for a film that is not playing, a lie here. The assistant drives
    // the same path, so "állítsd meg a zenét" was answered yes.
    expect(await transport("/player/playback/stop")).toEqual({ ok: true });
    expect(useMusic.getState().state).toBe("stopped");
  });

  it("skips to the next track and back", async () => {
    expect(await transport("/player/playback/skipNext")).toEqual({ ok: true });
    expect(useMusic.getState().index).toBe(2);
    expect(await transport("/player/playback/skipPrevious")).toEqual({ ok: true });
    expect(useMusic.getState().index).toBe(1);
  });
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

  it("does not inherit a shuffle somebody left on", async () => {
    // A controller sends a running order it has already decided - Plexamp
    // shuffles at its end - so a switch left on here plays a different album
    // than the one on the phone. Measured before the fix: 9002, 9003, 9001.
    useMusic.setState({ shuffle: true });

    await cast({});

    expect(useMusic.getState().queue.map((t) => t.id)).toEqual(["9001", "9002", "9003"]);
    expect(useMusic.getState().index).toBe(1);
  });

  it("does not hand a FILM to the music player because a controller said music", async () => {
    // `type` is the controller's word. Taking it for a film gives mpv the film's
    // own file with no display-mode claim, no transcode and no subtitles, and
    // the page never goes transparent - it keys off the film player.
    useApp.setState({
      backend: backend({
        item: async (id: string) => ({ id, kind: "movie", title: "Film", versions: [], roles: [], extras: [] }),
      }) as never,
    });

    const res = await cast({ queryType: "music" });

    expect(useMusic.getState().queue.length, "the music player must not have it").toBe(0);
    expect(res.ok, "it is handled as a film, not refused").toBe(false);
  });

  it("takes an album, an artist and a playlist as music too", async () => {
    // Only a TRACK carries a file, so keying on that alone sent a cast album to
    // the film player.
    for (const kind of ["album", "artist", "playlist"]) {
      resetMusic();
      useApp.setState({
        backend: backend({
          item: async (id: string) => ({ id, kind, title: kind, versions: [], roles: [], extras: [] }),
        }) as never,
      });

      const res = await cast({});

      expect(res, `a cast ${kind} is music`).toEqual({ ok: true });
      expect(useMusic.getState().queue.length).toBe(3);
    }
  });

  it("accepts the /playlists/ key form a controller sends", async () => {
    const res = await cast({ queryKey: "/playlists/9002" });

    expect(res).toEqual({ ok: true });
  });

  it("refuses a cast that lands after the person changed", async () => {
    // The queue read is a round trip, and `chooseProfile` mutates the backend in
    // place - so the object still held here carries the NEW person's token by
    // the time the music would start, past the PIN that boundary exists for.
    useApp.setState({
      backend: backend({
        queueItems: async () => {
          useApp.setState({ screen: { name: "profiles" }, history: [] });
          return { items: TRACKS, startIndex: 1 };
        },
      }) as never,
    });

    const res = await cast({});

    // The picker being UP is its own sentence: nobody has changed, the box is
    // asking. Either way nothing plays.
    expect(res).toEqual({
      ok: false,
      reason: "this box is asking who is watching; choose a profile on it first",
    });
    expect(started, "nothing may play as the person who just left").toEqual([]);
  });

  it("comes forward when the app went off screen mid-cast, and still plays", async () => {
    // Being hidden used to end this: the shell refused the player to a window
    // nobody was looking at, so the cast was refused here rather than reported
    // as playing over a launcher. The box lets sound outlive the screen now, so
    // the answer is to ask for the screen instead of giving up.
    useApp.setState({
      backend: backend({
        queueItems: async () => {
          __lifecycle.release("hidden");
          return { items: TRACKS, startIndex: 1 };
        },
      }) as never,
    });

    const res = await cast({});

    expect(res).toEqual({ ok: true });
    expect(launched, "it asked the box for the screen").toEqual(["mediaclient"]);
    expect(started.length).toBeGreaterThan(0);
  });

  it("plays the cast even when the box will not bring it forward", async () => {
    // Music is sound, not the screen. A box that cannot show the app - a native
    // game holding the output, say - is no reason to refuse a phone's album:
    // the whole point of the shell change behind this is that music does not
    // need to be looked at.
    launchRefused = true;
    __lifecycle.release("hidden");

    const res = await cast({});

    expect(res).toEqual({ ok: true });
    expect(launched).toEqual(["mediaclient"]);
    expect(started.length).toBeGreaterThan(0);
  });

  it("does not hand a song title to the controller as a reason", async () => {
    // The music store uses `error` as a LABEL - the title that could not be
    // played - and it is proxied to the phone byte for byte.
    useApp.setState({
      backend: backend({ trackUrl: () => undefined }) as never,
    });

    const res = await cast({});

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).not.toContain("Első");
    expect(res.ok === false && res.reason).not.toContain("Második");
  });

  it("shows Now Playing for a cast that arrives while the app is hidden", async () => {
    // The screen is the whole of what the room sees when a cast arrives: nobody
    // is holding a remote. So the app comes forward and lands on the track,
    // rather than leaving an album playing behind whatever was there.
    __lifecycle.release("hidden");

    const res = await cast({});

    expect(res).toEqual({ ok: true });
    expect(launched).toEqual(["mediaclient"]);
    expect(useApp.getState().screen.name).toBe("nowPlaying");
  });

  it("does not take the screen for a cast it is going to refuse", async () => {
    // Coming forward is DESTRUCTIVE on this box: it ends a native app - a game,
    // with whatever was unsaved in it - and stops another app's film. So a
    // command that will be refused must not have taken the screen on its way to
    // the refusal. The person check therefore runs BEFORE the request as well as
    // after it.
    __lifecycle.release("hidden");
    useApp.setState({ screen: { name: "profiles" } });

    const res = await cast({});

    expect(res).toEqual({
      ok: false,
      reason: "this box is asking who is watching; choose a profile on it first",
    });
    expect(launched, "nothing was asked to come forward").toEqual([]);
    expect(started).toEqual([]);
  });

  it("names the playing row from the QUEUE, not from the command", async () => {
    // A controller matches the report against the queue it built, and the
    // command names one entry while the album moves through many - so the id
    // comes from the queue read. It also means nothing a controller wrote ever
    // reaches the XML this box publishes.
    forgetCastQueue("music");
    await cast({ queryPlayQueueItemID: "12\u0007<x" });

    const line = timelineFor(
      "music",
      { item: TRACKS[1] as unknown as MediaItem, state: "playing", positionMs: 0, durationMs: 1 },
      { machineIdentifier: "M", baseUrl: "http://s:32400" },
    );
    expect(line.playQueueItemID, "the queue's own id for that row").toBe("q2");
    expect(line.playQueueVersion).toBe("3");
    expect(line.containerKey).toBe("/playQueues/20406");
  });

  it("plays again after a phone stopped it, because the queue is still there", async () => {
    // `stop()` keeps the queue and sets the state to stopped, so the box still
    // holds the album with a cursor in it - and the phone showing that album was
    // answered "nothing is playing" when it pressed play.
    await cast({});
    expect(started.length).toBeGreaterThan(0);
    await runCompanionCommand({ path: "/player/playback/stop", params: {} });
    expect(useMusic.getState().state).toBe("stopped");
    expect(useMusic.getState().queue.length, "the album is still held").toBeGreaterThan(0);

    const before = started.length;
    const res = await runCompanionCommand({ path: "/player/playback/play", params: {} });

    expect(res).toEqual({ ok: true });
    expect(started.length, "it starts again where the cursor is").toBeGreaterThan(before);
  });
});

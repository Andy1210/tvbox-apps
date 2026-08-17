import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runCompanionCommand } from "../playback/remoteControl";
import { usePlayer, resetPlayer } from "../playback/player";
import { useApp } from "../state";
import { __lifecycle } from "../lifecycle";
import type { StreamDecision } from "../backends/types";

/**
 * What a command from a phone or from the assistant actually does.
 *
 * The shape of the arguments is the whole of the first test, and it is not a
 * detail: the server does NOT forward a controller's query arguments under
 * their own names. It prefixes each with `query` and capitalises, so `key`
 * arrives as `queryKey`. Reading the plain name got undefined for every
 * argument that mattered - playMedia did nothing at all - and the loop answered
 * 200 regardless, so the assistant said the film was playing. 144 tests passed
 * over that, because none of them was this one.
 */

const played: { url: string; startSec?: number }[] = [];

function backend(over: Record<string, unknown> = {}): unknown {
  return {
    kind: "plex",
    item: async (id: string) => ({
      id,
      kind: "movie",
      title: `Item ${id}`,
      versions: [{ mediaIndex: 0, label: "1080p", partId: "1", audio: [], subtitles: [] }],
      roles: [],
      extras: [],
    }),
    resolveStream: async (): Promise<StreamDecision> =>
      ({ url: "http://s/f.mkv", audio: "auto", sub: "no", session: "s", transcoded: false, version: 0 }) as never,
    markers: async () => [],
    children: async () => [],
    reportProgress: async () => {},
    keepAlive: async () => {},
    endSession: async () => {},
    ...over,
  };
}

const launched: string[] = [];
let launchRefused = false;

beforeEach(() => {
  launchRefused = false;
  played.length = 0;
  __lifecycle.reset();
  (globalThis as { window?: unknown }).window = globalThis;
  launched.length = 0;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    // What the box does when an app asks to be brought forward: the window is
    // shown, so the page is visible again. `launchRefused` is a box that cannot
    // - a native game holding the screen, say.
    launch: (id: string) => {
      launched.push(id);
      if (!launchRefused) __lifecycle.resume();
    },
    play: (url: string, _s: unknown, startSec?: number) => played.push({ url, startSec }),
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
  vi.useRealTimers();
});

describe("a command from a controller", () => {
  it("reads the argument names the server really sends", async () => {
    // Captured verbatim from the live server after the assistant sent its own
    // playMedia: every argument is `query`-prefixed and CamelCased.
    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: {
        queryKey: "/library/metadata/27467",
        queryOffset: "754000",
        queryContainerKey: "/playQueues/20396",
        queryType: "video",
        commandID: "1",
      },
    });

    expect(res, "the command must be honoured, not refused").toEqual({ ok: true });
    expect(usePlayer.getState().current?.item.id).toBe("27467");
    expect(played.length, "something actually started").toBe(1);
  });

  it("starts where the controller said, not where the server left off", async () => {
    // `resume` used the item's own view offset and only then seeked, which
    // begins a transcode in the wrong place and leaves the bar pointing
    // somewhere the film never went.
    useApp.setState({
      backend: backend({
        item: async (id: string) => ({
          id,
          kind: "movie",
          title: "Film",
          viewOffsetMs: 3_600_000,
          versions: [{ mediaIndex: 0, label: "1080p", partId: "1", audio: [], subtitles: [] }],
          roles: [],
          extras: [],
        }),
      }) as never,
    });

    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/1", queryOffset: "754000", commandID: "1" },
    });

    expect(played[0]?.startSec, "the controller's offset wins over the resume point").toBe(754);
  });

  it("refuses what it cannot do, rather than answering OK", async () => {
    // The server proxies this answer to the controller verbatim and the
    // assistant reads the code. Answering OK for something that did not happen
    // is how a house says a film is playing over a launcher.
    expect(await runCompanionCommand({ path: "/player/playback/pause", params: {} })).toEqual({
      ok: false,
      reason: expect.stringContaining("nothing is playing"),
    });
    expect(await runCompanionCommand({ path: "/player/playback/skipNext", params: {} })).toMatchObject({ ok: false });
    expect(await runCompanionCommand({ path: "/player/mirror/details", params: {} })).toMatchObject({ ok: false });
    expect(
      await runCompanionCommand({ path: "/player/playback/playMedia", params: { queryKey: "/nope" } }),
    ).toMatchObject({ ok: false });
  });

  it("asks the box for the screen before starting a film, and then starts it", async () => {
    // The box HIDES an app rather than closing it, so a cast to a television
    // somebody pressed Home on arrives at a page that is alive and polling but
    // not on screen. That used to be a refusal; it is a request now.
    __lifecycle.release("hidden");
    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });

    expect(res).toMatchObject({ ok: true });
    expect(launched, "it asked for the screen by app id").toEqual(["mediaclient"]);
    expect(played.length, "and only then handed the film to the player").toBe(1);
  });

  it("will not start a film the box cannot bring to the screen", async () => {
    // The other half, and the reason the request is awaited rather than fired
    // and forgotten. The shell refuses the player to a window that is not in
    // front, and it refuses SILENTLY - the bridge discards the result. So a
    // film started anyway plays nothing, reports success, and leaves the box
    // publishing "playing" over whatever is actually on screen.
    launchRefused = true;
    __lifecycle.release("hidden");
    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });

    expect(res).toMatchObject({ ok: false });
    expect(played.length, "nothing may be sent to the shared player").toBe(0);
  });
  it("says so when the film did not start", async () => {
    // The player reports both of its failures by putting them in state and
    // returning normally, so awaiting the call proves nothing. An unconditional
    // OK here is the same lie the visibility check above exists to prevent,
    // reached down a different path: the assistant tells the house a film is
    // playing while the television shows the launcher.
    useApp.setState({
      backend: backend({
        resolveStream: async () => {
          throw new Error("no stream for this");
        },
      }) as never,
    });

    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });

    expect(res).toMatchObject({ ok: false });
    expect(played.length, "nothing reached the shared player").toBe(0);
    expect(usePlayer.getState().current, "and nothing is claimed to be playing").toBeNull();
  });

  it("says so when this box has no player at all", async () => {
    (globalThis as unknown as { tvbox: unknown }).tvbox = { panel: { width: 1920, height: 1080 } };

    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });

    expect(res).toMatchObject({ ok: false });
  });

  it("does not answer for the next episode before it has been tried", async () => {
    // skipNext went through the same call that swallows its failures, and did
    // not even await it - so the answer was written before anything had been
    // attempted at all.
    // The second stream is the one that fails: the sibling is played through
    // the backend the FIRST film was started with, held inside the player, so
    // swapping the app's backend would not reach it.
    let streams = 0;
    useApp.setState({
      backend: backend({
        resolveStream: async (): Promise<StreamDecision> => {
          streams += 1;
          if (streams > 1) throw new Error("no stream for this");
          return {
            url: "http://s/f.mkv",
            audio: "auto",
            sub: "no",
            session: "s",
            transcoded: false,
            version: 0,
          } as never;
        },
      }) as never,
    });
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    usePlayer.setState({
      siblings: { next: { id: "9", kind: "episode", title: "Next" } },
    });

    const res = await runCompanionCommand({ path: "/player/playback/skipNext", params: { commandID: "2" } });
    expect(res).toMatchObject({ ok: false });
  });

  it("will not start a film for the person who just left", async () => {
    // Sign-out and the profile picker replace the backend, and a command whose
    // item fetch is still in flight would otherwise play as whoever was signed
    // in when it arrived - their history, their continue-watching - with the
    // picker on screen.
    const slow = backend({
      item: async (id: string) => {
        useApp.setState({ backend: backend() as never, screen: { name: "home" }, history: [] });
        return {
          id,
          kind: "movie",
          title: "Film",
          versions: [{ mediaIndex: 0, label: "1080p", partId: "1", audio: [], subtitles: [] }],
          roles: [],
          extras: [],
        };
      },
    });
    useApp.setState({ backend: slow as never });

    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });

    expect(res).toMatchObject({ ok: false });
    expect(played.length, "nothing may play as the previous profile").toBe(0);
  });

  it("honours a small offset the controller named", async () => {
    // The ten-second floor belongs to a RESUME point - resuming a film four
    // seconds in is more surprising than starting it - and it was applied to an
    // offset somebody asked for as well, so the film began at zero while the
    // bar showed the offset.
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/1", queryOffset: "5000", commandID: "1" },
    });

    expect(played[0]?.startSec).toBe(5);
    expect(usePlayer.getState().positionMs).toBe(5000);
  });

  it("does not answer OK for a repeat command that started nothing", async () => {
    // A play that fails before it tears the previous film down leaves `current`
    // holding the OLD one - so a command naming the film already on screen
    // matched it and was answered OK while nothing had happened.
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    expect(usePlayer.getState().current?.item.id).toBe("27467");
    (globalThis as unknown as { tvbox: { play?: unknown } }).tvbox.play = undefined;

    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "2" },
    });

    expect(res).toMatchObject({ ok: false });
  });
  it("will not start a film while the profile picker is up", async () => {
    // Opening the picker changes the SCREEN; the backend is replaced only when
    // somebody is chosen, which is after the film would have started. So a
    // command already in flight played as the previous person, reported their
    // progress, and said nothing to anyone - the loop's teardown had already
    // made the answer silent.
    useApp.setState({
      backend: backend({
        item: async (id: string) => {
          useApp.setState({ screen: { name: "profiles" } });
          return {
            id,
            kind: "movie",
            title: "Film",
            versions: [{ mediaIndex: 0, label: "1080p", partId: "1", audio: [], subtitles: [] }],
            roles: [],
            extras: [],
          };
        },
      }) as never,
    });

    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });

    expect(res).toMatchObject({ ok: false });
    expect(played.length, "nothing may play as the person who is being replaced").toBe(0);
  });
});

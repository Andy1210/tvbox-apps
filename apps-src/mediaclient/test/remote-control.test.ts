import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runCompanionCommand } from "../playback/remoteControl";
import { usePlayer, resetPlayer } from "../playback/player";
import { useApp } from "../state";
import { __lifecycle } from "../lifecycle";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Message, type MessageProps } from "../Message";
import { setupRemote, setFocus, getCurrentFocusKey } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
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

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

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
const notified: unknown[] = [];
let launchRefused = false;

beforeEach(() => {
  launchRefused = false;
  notified.length = 0;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/tvbox/api/notify")) {
      notified.push(init?.body);
      return new Response("{}", { status: 200 });
    }
    return realFetch(input as RequestInfo, init);
  });
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

  it("does not take the screen for a film it is going to refuse", async () => {
    // The check that makes this pass runs BEFORE the request to come forward.
    // Asserting only "refused, nothing played" would pass with that check
    // removed, because the one after the request still refuses - by which time a
    // native app has been killed and another app's film stopped.
    __lifecycle.release("hidden");
    useApp.setState({ screen: { name: "profiles" } });

    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });

    expect(res).toMatchObject({ ok: false });
    expect(launched, "nothing was asked to come forward").toEqual([]);
    expect(played.length).toBe(0);
  });

  it("says a phone took the screen only once it really has", async () => {
    // The note names a takeover. Announcing it before the request could succeed
    // meant telling the room the app had the screen and then refusing.
    launchRefused = true;
    __lifecycle.release("hidden");
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    expect(notified, "no note for a takeover that did not happen").toEqual([]);

    launchRefused = false;
    __lifecycle.release("hidden");
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    expect(notified.length, "and one when it did").toBe(1);
  });

  it("turns a phone's D-pad into the keys every screen already listens to", async () => {
    // The player claims `navigation` now, so a phone draws a D-pad - and a claim
    // that answers with a refusal is worse than no claim. Keys rather than calls
    // into each screen, so a phone and the remote in the room do the same thing.
    const keys: string[] = [];
    const onKey = (e: KeyboardEvent) => keys.push(e.key);
    window.addEventListener("keydown", onKey);

    for (const [path, key] of [
      ["moveUp", "ArrowUp"],
      ["moveDown", "ArrowDown"],
      ["moveLeft", "ArrowLeft"],
      ["moveRight", "ArrowRight"],
      ["select", "Enter"],
    ] as const) {
      const res = await runCompanionCommand({ path: `/player/navigation/${path}`, params: {} });
      expect(res, path).toEqual({ ok: true });
      expect(keys.at(-1), path).toBe(key);
    }
    window.removeEventListener("keydown", onKey);
  });

  it("sends Back and Home through the app rather than as keys", async () => {
    // The box's Back never reaches a page (the compositor takes it), and Home
    // here means this app's home screen - not the launcher, which is not a
    // phone controlling the media app's business.
    useApp.setState({ screen: { name: "search" }, history: [{ name: "home" }] });
    expect(await runCompanionCommand({ path: "/player/navigation/back", params: {} })).toEqual({ ok: true });
    expect(useApp.getState().screen.name).toBe("home");

    useApp.setState({ screen: { name: "search" }, history: [] });
    expect(await runCompanionCommand({ path: "/player/navigation/home", params: {} })).toEqual({ ok: true });
    expect(useApp.getState().screen.name).toBe("home");
  });

  it("refuses the music screen when there is no music", async () => {
    useApp.setState({ screen: { name: "home" }, history: [] });
    const res = await runCompanionCommand({ path: "/player/navigation/music", params: {} });
    expect(res).toMatchObject({ ok: false });
    expect(useApp.getState().screen.name).toBe("home");
  });

  it("will not drive a phone's D-pad into the profile picker", async () => {
    // `select` on that screen chooses a person, and a PIN pad is a screen you
    // can send digits at - so a controller with a D-pad could otherwise cross
    // the boundary the playback paths refuse at.
    const keys: string[] = [];
    const onKey = (e: KeyboardEvent) => keys.push(e.key);
    window.addEventListener("keydown", onKey);
    useApp.setState({ screen: { name: "profiles" }, history: [] });

    for (const what of ["moveDown", "select", "back", "home", "music"]) {
      const res = await runCompanionCommand({ path: `/player/navigation/${what}`, params: {} });
      expect(res, what).toMatchObject({ ok: false });
    }
    expect(keys, "no press may reach the picker").toEqual([]);
    expect(launched, "and it must not take the screen on the way to refusing").toEqual([]);
    expect(useApp.getState().screen.name, "nor navigate away from it").toBe("profiles");
    window.removeEventListener("keydown", onKey);
  });

  it("refuses the music screen before taking the screen, not after", async () => {
    __lifecycle.release("hidden");
    useApp.setState({ screen: { name: "home" }, history: [] });
    const res = await runCompanionCommand({ path: "/player/navigation/music", params: {} });
    expect(res).toMatchObject({ ok: false });
    expect(launched, "nothing was asked to come forward").toEqual([]);
  });

  /**
   * What is UNDER the film a controller started.
   *
   * A cast leaves whatever screen was up, and the usual case is the home page:
   * the box answers Plex with the app closed, so most casts open it. That screen
   * is not decoration - the countdown to the next episode is drawn on the season
   * page, on the episode it is about to play - so a voice-started episode ran out
   * over the home page and stepped to the next one with nothing to show for it,
   * and Back at the end of a film went to the home page rather than to the film.
   */
  const episodeBackend = (over: Record<string, unknown> = {}): unknown =>
    backend({
      item: async (id: string) => ({
        id,
        kind: "episode",
        title: `Episode ${id}`,
        grandparentTitle: "A Series",
        parentId: "season-9",
        versions: [{ mediaIndex: 0, label: "1080p", partId: "1", audio: [], subtitles: [] }],
        roles: [],
        extras: [],
        ...over,
      }),
    });

  it("puts the film's own page behind it", async () => {
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    expect(useApp.getState().screen).toEqual({ name: "item", itemId: "27467" });
    // And Back still reaches where the household was, so the cast did not erase
    // it.
    expect(useApp.getState().history.at(-1)).toEqual({ name: "home" });
  });

  it("puts an episode's SEASON behind it, pointing at the episode", async () => {
    useApp.setState({ backend: episodeBackend() as never });
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/555", commandID: "1" },
    });
    // The season, because an episode has no page of its own - that is the screen
    // the countdown is drawn on.
    expect(useApp.getState().screen).toEqual({ name: "item", itemId: "season-9", focusChildId: "555" });
  });

  it("does not stack a second cast from the same season onto the history", async () => {
    useApp.setState({ backend: episodeBackend() as never });
    for (const id of ["555", "556"]) {
      await runCompanionCommand({
        path: "/player/playback/playMedia",
        params: { queryKey: `/library/metadata/${id}`, commandID: "1" },
      });
    }
    expect(useApp.getState().screen).toEqual({ name: "item", itemId: "season-9", focusChildId: "556" });
    expect(useApp.getState().history, "one step back, not one per episode").toEqual([{ name: "home" }]);
  });

  it("falls back to the series when the server named no season", async () => {
    // 508 of this library's 8234 episodes carry no `parentRatingKey`, and the
    // prev/next lookup reads the same field - so those have no next episode and
    // no countdown either way. The series is then the most the screen can
    // honestly be, and it points at nothing: an episode is not a child of a
    // series, and naming a key that never mounts is how a page gets a dead
    // remote.
    useApp.setState({ backend: episodeBackend({ parentId: undefined, grandparentId: "show-3" }) as never });
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/555", commandID: "1" },
    });
    expect(useApp.getState().screen).toEqual({ name: "item", itemId: "show-3" });
  });

  it("leaves the screen alone when there is no page to open at all", async () => {
    useApp.setState({
      backend: episodeBackend({ parentId: undefined, grandparentId: undefined }) as never,
    });
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/555", commandID: "1" },
    });
    expect(useApp.getState().screen).toEqual({ name: "home" });
  });

  it("never stacks more than one step onto the history, whatever is cast", async () => {
    // An evening of spoken requests used to have to be pressed back through one
    // film at a time.
    useApp.setState({ screen: { name: "library", libraryId: "2", title: "Series" }, history: [] });
    for (const id of ["1001", "1002", "1003"]) {
      await runCompanionCommand({
        path: "/player/playback/playMedia",
        params: { queryKey: `/library/metadata/${id}`, commandID: "1" },
      });
    }
    expect(useApp.getState().screen).toEqual({ name: "item", itemId: "1003" });
    expect(useApp.getState().history).toEqual([{ name: "library", libraryId: "2", title: "Series" }]);
  });

  it("gives the box back if somebody else is at it by the time the film resolved", async () => {
    // The step after the longest await in the function, and taking the screen is
    // what a cast does to somebody standing at the box: measured, a cast whose
    // stream resolved while the household was choosing a profile walked the box
    // off its own PIN pad. Leaving the film running instead only hides the pad
    // behind it, which is the same screen taken by another means - so this is a
    // refusal, and the film is stopped.
    useApp.setState({
      backend: backend({
        resolveStream: async () => {
          useApp.setState({ screen: { name: "profiles" }, history: [] });
          return { url: "http://s/f.mkv", audio: "auto", sub: "no", session: "s", transcoded: false, version: 0 };
        },
      }) as never,
    });
    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    expect(res).toMatchObject({ ok: false });
    expect(usePlayer.getState().current, "nothing is left playing").toBeNull();
    expect(useApp.getState().screen, "and the picker still has the screen").toEqual({ name: "profiles" });
  });

  it("still steps during the countdown at the end of an episode", async () => {
    // The guard for a given-up step must not catch the moment somebody actually
    // says "következő rész": the episode has just ended, the countdown is on
    // screen, nothing is `current` - and the neighbours are real. Giving a step
    // up cancels the countdown with it, which is what tells the two apart.
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    // The way it really happens: the file ran out, so `stop()` has been through
    // and the countdown was armed after it.
    await usePlayer.getState().stop();
    usePlayer.setState({
      upNext: { item: { id: "556", kind: "episode", title: "Next" }, at: Date.now() + 5_000 } as never,
      siblings: { next: { id: "556", kind: "episode", title: "Next" } } as never,
    });
    expect(await runCompanionCommand({ path: "/player/playback/skipNext", params: {} })).toEqual({ ok: true });
    expect(usePlayer.getState().current?.item.id, "and it really started it").toBe("556");
  });

  it("says nothing is playing after a step was given up, not that the series ended", async () => {
    // A cancelled step leaves no neighbours behind, and the guard for them would
    // answer with a claim about the LIBRARY - the sentence this file forbids four
    // lines above it - about a series that has more.
    usePlayer.setState({ current: null, moving: null, buffering: false, siblings: {}, upNext: null });
    expect(await runCompanionCommand({ path: "/player/playback/skipNext", params: {} })).toEqual({
      ok: false,
      reason: "nothing is playing",
    });
    expect(await runCompanionCommand({ path: "/player/playback/skipPrevious", params: {} })).toEqual({
      ok: false,
      reason: "nothing is playing",
    });
  });

  it("really stops, when a cast landed while a step was still in flight", async () => {
    // Both can be true at once: a cast sets `current` while the step's own claim
    // is still held. Measured before this, `stop` took the claim to mean nothing
    // was playing, answered ok, and never called stop at all - the film played on
    // and the assistant told the room it had stopped.
    usePlayer.setState({ current: { item: { id: "900" } } as never, moving: { id: "e3" } as never });
    const res = await runCompanionCommand({ path: "/player/playback/stop", params: {} });
    expect(res).toEqual({ ok: true });
    expect(usePlayer.getState().current, "and it really is stopped").toBeNull();
    expect(usePlayer.getState().moving, "the step is given up too").toBeNull();
  });

  it("refuses to pause a film that is about to be replaced", async () => {
    // `current` is the OUTGOING film for the whole of a step now, so a pause
    // reaches a film that is a second from being swapped: measured, the assistant
    // was told it had paused and the television was playing again straight after.
    // The remote's own keys are swallowed for the same reason.
    usePlayer.setState({
      current: { item: { id: "900" }, decision: {}, markers: [], choice: { version: 0 } } as never,
      state: "playing",
      moving: { id: "e3" } as never,
    });
    for (const path of ["pause", "play", "playPause", "seekTo", "stepForward", "stepBack"]) {
      expect(await runCompanionCommand({ path: `/player/playback/${path}`, params: { queryOffset: "1000" } }), path).toEqual({
        ok: false,
        reason: "the box is already changing episode",
      });
    }
    expect(usePlayer.getState().state, "and the film is untouched").toBe("playing");
  });

  it("says which of the two it is when a step is refused", async () => {
    // Two states, two sentences: the assistant reads these out. Saying "already
    // changing episode" about a box that is merely opening the film somebody
    // asked for is a claim about something that is not happening.
    usePlayer.setState({ current: null, moving: { id: "e3" } as never, buffering: false });
    expect(await runCompanionCommand({ path: "/player/playback/skipNext", params: {} })).toEqual({
      ok: false,
      reason: "the box is already changing episode",
    });

    // Nothing stepping, but the box has not put the last one on screen yet. The
    // siblings are deliberately empty, which is what a step leaves behind - and
    // what used to make this answer "nothing follows this", i.e. "that was the
    // last episode", about a series that has more.
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    usePlayer.setState({ moving: null, siblings: {}, buffering: true });
    expect(await runCompanionCommand({ path: "/player/playback/skipNext", params: {} })).toEqual({
      ok: false,
      reason: "the box has not shown this one yet",
    });
  });

  it("keeps the page the household was reading when a cast arrives", async () => {
    // The one history step is for consecutive CASTS. Keyed on "the screen is an
    // item page" it also erased a page somebody in the room had opened: they were
    // on a season, another room asked for a film, and it was dropped out of the
    // history instead of left behind the film.
    useApp.setState({ screen: { name: "item", itemId: "their-season" }, history: [{ name: "home" }] });
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/1001", commandID: "1" },
    });
    expect(useApp.getState().history.at(-1), "their page is still behind it").toEqual({
      name: "item",
      itemId: "their-season",
    });

    // And the cast's OWN page is still replaced by the next cast.
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/1002", commandID: "1" },
    });
    expect(useApp.getState().screen).toEqual({ name: "item", itemId: "1002" });
    expect(useApp.getState().history.at(-1)).toEqual({ name: "item", itemId: "their-season" });
  });

  it("does not let a phone navigate out from under an arriving episode", async () => {
    // The D-pad paths are dispatched at window, where spatial navigation's own
    // listener runs first whatever the capture flag says - so the overlay's
    // swallow cannot reach them. Measured: a phone's `back` during a step
    // navigated away and left the episode to land on the screen it had chosen.
    useApp.setState({ screen: { name: "item", itemId: "s1" }, history: [{ name: "home" }] });
    usePlayer.setState({ current: null, moving: { id: "e3" } as never });

    expect(await runCompanionCommand({ path: "/player/navigation/select", params: {} })).toEqual({
      ok: false,
      reason: "the box is already changing episode",
    });
    expect(usePlayer.getState().moving, "a D-pad press is refused, not acted on").not.toBeNull();

    expect(await runCompanionCommand({ path: "/player/navigation/back", params: {} })).toEqual({ ok: true });
    expect(usePlayer.getState().moving, "and Back gives the step up").toBeNull();
    // And nothing else: the remote's Back during a step stays put, and one press
    // must not cost the page the person was on as well as the episode.
    expect(useApp.getState().screen).toEqual({ name: "item", itemId: "s1" });
  });

  it("refuses a transport command while the box is asking who is watching", async () => {
    // The playback and navigation paths each refused this for themselves; the
    // transport ones had no check at all, and a skip accepted there takes a claim
    // on the screen - which hides the PIN pad the digits are being typed into.
    useApp.setState({ screen: { name: "profiles" }, history: [] });
    for (const path of [
      "/player/playback/skipNext",
      "/player/playback/skipPrevious",
      "/player/playback/pause",
      "/player/playback/play",
      "/player/playback/playPause",
      "/player/playback/stop",
      "/player/playback/seekTo",
      "/player/playback/stepForward",
      "/player/playback/stepBack",
    ]) {
      // The REASON, not merely a refusal: eight of these nine paths already answer
      // ok:false on an idle box ("nothing is playing"), so without the sentence
      // this test would pass with the guard deleted.
      expect(await runCompanionCommand({ path, params: {} }), path).toEqual({
        ok: false,
        reason: "this box is asking who is watching; choose a profile on it first",
      });
    }
    expect(usePlayer.getState().moving, "and nothing took the screen").toBeNull();
  });

  it("will not press either button that signs the household out", async () => {
    // The guard is on what the press would HIT, not on any state near it.
    // `Message` takes the cursor as it mounts, and behind a film `hidden` hides
    // the pixels and not the focus tree - so the cursor sits on that button for
    // the rest of the film, and the overlay's own swallow cannot stop the press:
    // in a real browser a key dispatched at window runs its listeners in
    // registration order, and spatial navigation gets there first.
    // Real buttons, mounted one at a time: the guard asks the library whether the
    // key it is looking at still exists, and `Message` takes the cursor for its
    // own first button - so two of them in one render measures the same one twice.
    const mounts: [string, MessageProps][] = [
      ["msg-signin", { failure: { kind: "signed-out" } }],
      ["settings-signout", { text: "x", actions: [{ key: "settings-signout", label: "out", onEnter: () => {} }] }],
    ];
    for (const [key, props] of mounts) {
      const { unmount } = render(createElement(Message, props));
      await setFocus(key);
      expect(getCurrentFocusKey(), `${key} must be what a press would reach`).toBe(key);
      expect(await runCompanionCommand({ path: "/player/navigation/select", params: {} }), key).toEqual({
        ok: false,
        reason: "there is a message on this box waiting to be read",
      });
      unmount();
    }
    render(createElement(Message, mounts[0][1]));
    await setFocus("msg-signin");
    // The arrows are not the danger, and they are all a phone has to get off it.
    expect(await runCompanionCommand({ path: "/player/navigation/moveRight", params: {} })).toEqual({ ok: true });
  });

  it("does not refuse OK on a key the button has left behind", async () => {
    // The library keeps its focus key when the focused component unmounts, and
    // nothing re-parks a `Message` returned outside a focus context - so the name
    // outlived the button and every OK was refused with a message on screen that
    // said a spinner.
    const { unmount } = render(createElement(Message, { failure: { kind: "signed-out" } }));
    await setFocus("msg-signin");
    unmount();
    expect(await runCompanionCommand({ path: "/player/navigation/select", params: {} })).toEqual({ ok: true });
  });

  it("still lets a phone press Retry, and OK on an ordinary screen", async () => {
    render(createElement(Message, { failure: { kind: "unreachable" }, onRetry: () => {} }));
    // Every other message's one button is Retry, which the household may well
    // want to press from a phone - and refusing on the app-wide failure flag took
    // the whole D-pad away for the length of any film with a 403 behind it.
    await setFocus("msg-retry");
    expect(await runCompanionCommand({ path: "/player/navigation/select", params: {} })).toEqual({ ok: true });

    await setFocus("detail-play");
    useApp.setState({ screen: { name: "home" }, failure: { kind: "signed-out" }, history: [] });
    expect(await runCompanionCommand({ path: "/player/navigation/select", params: {} })).toEqual({ ok: true });
    useApp.setState({ failure: null });
  });

  it("still stops a film when a screen behind it has failed", async () => {
    // `failure` is written by any 401 OR 403 from any screen's fetch - including
    // the detail page a cast mounts behind the film it just started - and nothing
    // clears it while a film plays. Refusing every command on it meant one 403
    // left "stop" answering a refusal with the film still going.
    await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    useApp.setState({ failure: { kind: "signed-out" } });
    expect(await runCompanionCommand({ path: "/player/playback/stop", params: {} })).toEqual({ ok: true });
    expect(usePlayer.getState().current).toBeNull();
    useApp.setState({ failure: null });
  });

  it("says nobody is signed in where there is no profile to choose", async () => {
    // Two states, two sentences: only the picker offers a choice. The assistant
    // reads these out, and "choose a profile on it" is not something a person
    // standing at a sign-in screen can do.
    useApp.setState({ screen: { name: "login" }, history: [] });
    expect(await runCompanionCommand({ path: "/player/playback/pause", params: {} })).toEqual({
      ok: false,
      reason: "nobody is signed in on this box",
    });
    useApp.setState({ screen: { name: "home" }, backend: null, history: [] });
    expect(await runCompanionCommand({ path: "/player/playback/pause", params: {} })).toEqual({
      ok: false,
      reason: "nobody is signed in on this box",
    });
  });

  it("does not give a step up on the way to refusing a command", async () => {
    // `bringToFront` can still turn a navigation down, and abandoning the step
    // first meant a command reported as failed had already thrown the episode
    // away. This file says so twice about its other paths.
    launchRefused = true;
    __lifecycle.release("hidden");
    usePlayer.setState({ current: null, moving: { id: "e3" } as never });
    const res = await runCompanionCommand({ path: "/player/navigation/home", params: {} });
    expect(res).toMatchObject({ ok: false });
    expect(usePlayer.getState().moving, "the step is still going").not.toBeNull();
  });

  it("answers the transport paths that were left out with the same two sentences", async () => {
    usePlayer.setState({ current: null, moving: { id: "e3" } as never });
    for (const path of ["/player/playback/pause", "/player/playback/seekTo", "/player/playback/stepForward"]) {
      expect(await runCompanionCommand({ path, params: { queryOffset: "1000" } }), path).toEqual({
        ok: false,
        reason: "the box is already changing episode",
      });
    }
  });

  it("still lets a phone subscribe while the picker is up", async () => {
    // A refused subscribe is answered 400 by the server and the phone gives up
    // rather than trying again once somebody has picked - and these two paths
    // change nothing on the box.
    useApp.setState({ screen: { name: "profiles" }, history: [] });
    expect(await runCompanionCommand({ path: "/player/timeline/subscribe", params: {} })).toEqual({ ok: true });
    expect(await runCompanionCommand({ path: "/player/timeline/unsubscribe", params: {} })).toEqual({ ok: true });
  });

  it("leaves the screen alone when the film could not start", async () => {
    // Refused on its way in: a cast that never played must not walk the person to
    // a page they did not ask for.
    launchRefused = true;
    __lifecycle.release("hidden");
    const res = await runCompanionCommand({
      path: "/player/playback/playMedia",
      params: { queryKey: "/library/metadata/27467", commandID: "1" },
    });
    expect(res).toMatchObject({ ok: false });
    expect(useApp.getState().screen).toEqual({ name: "home" });
  });
});

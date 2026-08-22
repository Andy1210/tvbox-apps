import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useMusic, resetMusic } from "../playback/music";
import { usePlayer, resetPlayer } from "../playback/player";
import { resetPlayerOwner } from "../playback/owner";
import { renderHook } from "@testing-library/react";
import { handleMusicCommand, handleMusicKey, useMusicMediaKeys } from "../playback/mediakeys";
import type { MediaBackend, MediaItem } from "../backends/types";

/**
 * The two ways to drive a song that are not a list row: the cursor on the bar,
 * and the transport buttons on the remote.
 *
 * Both are asserted through the store, because both have a state the screen only
 * reflects - where the cursor points, and whether a press reached the queue at
 * all. The keys in particular shipped unhandled, which no rendering test would
 * have caught: the screen was right, nothing listened.
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

let played: string[] = [];
let seeks: number[] = [];
let pauses = 0;
let resumes = 0;
let stops = 0;

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  played = [];
  seeks = [];
  pauses = 0;
  resumes = 0;
  stops = 0;
  resetPlayerOwner();
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: (url: string) => played.push(url),
    stop: () => {
      stops += 1;
    },
    pause: () => {
      pauses += 1;
    },
    resume: () => {
      resumes += 1;
    },
    // Seconds on the wire, which is what the bar has to be held to: a cursor in
    // milliseconds that seeks in milliseconds lands 1000x into the song.
    seek: (s: number) => seeks.push(s),
    onPlayer: () => () => {},
  };
});

afterEach(() => {
  resetMusic();
  resetPlayer();
  resetPlayerOwner();
  vi.useRealTimers();
});

async function start(items: MediaItem[], opts?: { startIndex?: number }): Promise<void> {
  await useMusic.getState().playQueue(fakeBackend(), items, opts);
  await settle();
}

describe("the cursor on the bar", () => {
  it("moves without moving the music", async () => {
    await start([track("a")]);
    useMusic.getState().scrubBy(5_000);
    expect(useMusic.getState().scrubMs).toBe(5_000);
    // The whole point of a cursor: nothing was asked of the box yet.
    expect(seeks).toEqual([]);
    expect(useMusic.getState().positionMs).toBe(0);
  });

  it("carries on from where the cursor is, not from where the song is", async () => {
    await start([track("a")]);
    useMusic.getState().scrubBy(5_000);
    useMusic.getState().scrubBy(5_000);
    // Reading the position each time would leave a held arrow fighting whatever
    // the box last reported, and the cursor would crawl.
    expect(useMusic.getState().scrubMs).toBe(10_000);
  });

  it("stops at both ends of the song", async () => {
    await start([track("a")]);
    useMusic.getState().scrubBy(-30_000);
    expect(useMusic.getState().scrubMs).toBe(0);
    useMusic.getState().scrubBy(10_000_000);
    expect(useMusic.getState().scrubMs).toBe(200_000);
  });

  it("refuses to move at all when the song has no known length", async () => {
    // The bar has no scale yet, so the mark would sit at 0% while the clock
    // beside it ran away - and committing would seek to a time the song does not
    // have. A track can arrive with no duration: the library carries none and
    // the box has not read the header.
    await start([track("a", { durationMs: undefined })]);
    expect(useMusic.getState().durationMs).toBe(0);
    useMusic.getState().scrubBy(5_000);
    expect(useMusic.getState().scrubMs).toBeNull();
    useMusic.getState().commitScrub();
    expect(seeks).toEqual([]);
  });

  it("goes where it points when it is committed, and puts itself away", async () => {
    await start([track("a")]);
    useMusic.getState().scrubBy(40_000);
    useMusic.getState().commitScrub();
    expect(seeks).toEqual([40]);
    expect(useMusic.getState().positionMs).toBe(40_000);
    expect(useMusic.getState().scrubMs).toBeNull();
  });

  it("leaves the song alone when it is cancelled", async () => {
    await start([track("a")]);
    useMusic.setState({ positionMs: 12_000 });
    useMusic.getState().scrubBy(40_000);
    useMusic.getState().cancelScrub();
    expect(seeks).toEqual([]);
    expect(useMusic.getState().positionMs).toBe(12_000);
    expect(useMusic.getState().scrubMs).toBeNull();
  });

  it("does nothing when committed with no cursor out", async () => {
    await start([track("a")]);
    useMusic.getState().commitScrub();
    expect(seeks).toEqual([]);
  });

  it("is dropped when the song changes under it", async () => {
    await start([track("a"), track("b")]);
    useMusic.getState().scrubBy(40_000);
    await useMusic.getState().next();
    await settle();
    // Carried over, it would point at a second of the PREVIOUS song's length.
    expect(useMusic.getState().scrubMs).toBeNull();
  });
});

describe("the transport buttons on the remote", () => {
  it("pauses and resumes on play/pause", async () => {
    await start([track("a")]);
    expect(handleMusicKey("MediaPlayPause")).toBe(true);
    expect(pauses).toBe(1);
    expect(useMusic.getState().state).toBe("paused");
    handleMusicKey("MediaPlayPause");
    expect(resumes).toBe(1);
    expect(useMusic.getState().state).toBe("playing");
  });

  it("takes the dedicated Play and Pause at their word", async () => {
    await start([track("a")]);
    // Already playing. A toggle here would stop the music the button asked for.
    expect(handleMusicKey("MediaPlay")).toBe(true);
    expect(pauses).toBe(0);
    expect(useMusic.getState().state).toBe("playing");

    handleMusicKey("MediaPause");
    expect(useMusic.getState().state).toBe("paused");
    // And again: still paused, not resumed.
    handleMusicKey("MediaPause");
    expect(resumes).toBe(0);
    expect(useMusic.getState().state).toBe("paused");
  });

  it("steps between songs", async () => {
    await start([track("a"), track("b"), track("c")]);
    handleMusicKey("MediaTrackNext");
    await settle();
    expect(useMusic.getState().index).toBe(1);
    handleMusicKey("MediaTrackPrevious");
    await settle();
    expect(useMusic.getState().index).toBe(0);
  });

  it("answers to the names the box's browser really sends", async () => {
    // Measured by injecting the remote's own key codes through uinput and asking
    // the page what arrived - see the table in mediakeys.ts. A test over made-up
    // names would pass while every button on the remote stayed dead.
    await start([track("a"), track("b")]);
    for (const key of ["MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "MediaFastForward", "MediaRewind"]) {
      expect([key, handleMusicKey(key)]).toEqual([key, true]);
      await settle();
    }
  });

  it("winds inside the song rather than between songs", async () => {
    await start([track("a"), track("b")]);
    useMusic.setState({ positionMs: 30_000 });
    handleMusicKey("MediaFastForward");
    expect(seeks).toEqual([40]);
    expect(useMusic.getState().index).toBe(0);
    handleMusicKey("MediaRewind");
    expect(seeks).toEqual([40, 30]);
    expect(useMusic.getState().index).toBe(0);
  });

  it("stops", async () => {
    await start([track("a")]);
    expect(handleMusicKey("MediaStop")).toBe(true);
    await settle();
    expect(stops).toBe(1);
    expect(useMusic.getState().state).toBe("stopped");
  });

  it("leaves a film's keys to the film", async () => {
    await start([track("a")]);
    usePlayer.setState({ current: {} as never });
    // The film player runs its own handler for exactly these keys. Acting here
    // too would pause the film AND step the queue underneath it.
    expect(handleMusicKey("MediaPlayPause")).toBe(false);
    expect(handleMusicKey("MediaTrackNext")).toBe(false);
    expect(pauses).toBe(0);
    expect(useMusic.getState().index).toBe(0);
  });

  it("leaves the press alone when there is no queue", () => {
    expect(handleMusicKey("MediaPlayPause")).toBe(false);
    expect(pauses).toBe(0);
  });

  it("is not interested in any other key", async () => {
    await start([track("a")]);
    expect(handleMusicKey("ArrowDown")).toBe(false);
    expect(handleMusicKey("Enter")).toBe(false);
    expect(handleMusicKey("AudioVolumeUp")).toBe(false);
  });

  it("is not fooled by a key named after something every object has", async () => {
    // The table is a plain object, so `"toString" in ACTIONS` is TRUE and hands
    // back a function - which is truthy, matches no case, and reached a branch
    // that threw. Inside a window listener that is an uncaught error on a press.
    await start([track("a")]);
    for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect([key, handleMusicKey(key)]).toEqual([key, false]);
    }
    expect(pauses).toBe(0);
    expect(useMusic.getState().state).toBe("playing");
  });
});

describe("the listener that carries those presses", () => {
  // The decision above can be perfect while the remote stays dead, because
  // nothing in it attaches a listener. These press a real event at the window
  // instead, which is the path the box actually uses.
  const dispatch = (key: string): KeyboardEvent => {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return ev;
  };

  it("acts on a press and marks it handled", async () => {
    await start([track("a")]);
    const { unmount } = renderHook(() => useMusicMediaKeys());
    const ev = dispatch("MediaPlayPause");
    expect(pauses).toBe(1);
    expect(useMusic.getState().state).toBe("paused");
    // Handled means handled: whatever else listens must not act on it too.
    expect(ev.defaultPrevented).toBe(true);
    unmount();
  });

  it("leaves a key it does not own alone", async () => {
    await start([track("a")]);
    const { unmount } = renderHook(() => useMusicMediaKeys());
    const ev = dispatch("ArrowDown");
    // Not swallowed - spatial navigation is downstream of this listener.
    expect(ev.defaultPrevented).toBe(false);
    unmount();
  });

  it("stops listening when it goes away", async () => {
    await start([track("a")]);
    const { unmount } = renderHook(() => useMusicMediaKeys());
    unmount();
    dispatch("MediaPlayPause");
    expect(pauses).toBe(0);
    expect(useMusic.getState().state).toBe("playing");
  });
});

/**
 * A command forwarded by the shell (MQTT: a spoken request, Home Assistant, a
 * phone), which is NOT the same decision as a key press.
 *
 * The shell owns the player this queue plays through and acts on a transport
 * command itself before forwarding it, so the half of these assertions that
 * matters most is what the app must NOT do: pausing here as well toggles the
 * pause straight back off, and the music comes back on while the room was told
 * it stopped.
 */
describe("a command forwarded from the shell", () => {
  it("does not pause the box a second time, but stops the screen claiming it plays", async () => {
    await start([track("a")]);
    expect(handleMusicCommand({ action: "pause" })).toBe(true);
    // The shell already did this to mpv. Doing it again un-pauses.
    expect(pauses).toBe(0);
    expect(useMusic.getState().state).toBe("paused");
    expect(handleMusicCommand({ action: "resume" })).toBe(true);
    expect(resumes).toBe(0);
    expect(useMusic.getState().state).toBe("playing");
  });

  it("leaves a stop to the shell, whose own stop reaches the queue as `finished`", async () => {
    await start([track("a"), track("b")]);
    expect(handleMusicCommand({ action: "stop" })).toBe(true);
    expect(stops).toBe(0);
    expect(useMusic.getState().index).toBe(0);
  });

  it("steps the queue, which the shell has no way of doing", async () => {
    await start([track("a"), track("b")]);
    expect(handleMusicCommand({ action: "next" })).toBe(true);
    await settle();
    expect(useMusic.getState().index).toBe(1);
    expect(handleMusicCommand({ action: "previous" })).toBe(true);
    await settle();
    expect(useMusic.getState().index).toBe(0);
  });

  it("sets shuffle from the word it was given, and toggles from what is on", async () => {
    await start([track("a"), track("b")]);
    expect(handleMusicCommand({ action: "shuffle", state: "on" })).toBe(true);
    expect(useMusic.getState().shuffle).toBe(true);
    expect(handleMusicCommand({ action: "shuffle", state: "off" })).toBe(true);
    expect(useMusic.getState().shuffle).toBe(false);
    expect(handleMusicCommand({ action: "shuffle", state: "toggle" })).toBe(true);
    expect(useMusic.getState().shuffle).toBe(true);
  });

  it("refuses a state it cannot read rather than falling back to a default", async () => {
    await start([track("a")]);
    // "true" and "random" are not this vocabulary. Taking either as "on" is how
    // a request to STOP shuffling would switch it on.
    expect(handleMusicCommand({ action: "shuffle", state: "true" })).toBe(false);
    expect(handleMusicCommand({ action: "shuffle", state: "random" })).toBe(false);
    expect(handleMusicCommand({ action: "shuffle" })).toBe(false);
    expect(useMusic.getState().shuffle).toBe(false);
    // Spotify's own words for repeat, which the box must not accept as ours.
    expect(handleMusicCommand({ action: "repeat", state: "context" })).toBe(false);
    expect(handleMusicCommand({ action: "repeat", state: "track" })).toBe(false);
    expect(useMusic.getState().repeat).toBe("off");
  });

  it("sets repeat in the queue's own vocabulary", async () => {
    await start([track("a")]);
    expect(handleMusicCommand({ action: "repeat", state: "one" })).toBe(true);
    expect(useMusic.getState().repeat).toBe("one");
    expect(handleMusicCommand({ action: "repeat", state: "all" })).toBe(true);
    expect(useMusic.getState().repeat).toBe("all");
    expect(handleMusicCommand({ action: "repeat", state: "off" })).toBe(true);
    expect(useMusic.getState().repeat).toBe("off");
  });

  it("records a lyrics request for the screen that draws them", async () => {
    await start([track("a")]);
    expect(useMusic.getState().lyricsAsk).toBeNull();
    expect(handleMusicCommand({ action: "lyrics" })).toBe(true);
    expect(useMusic.getState().lyricsAsk?.state).toBe("on");
    expect(handleMusicCommand({ action: "lyrics", state: "off" })).toBe(true);
    expect(useMusic.getState().lyricsAsk?.state).toBe("off");
  });

  it("stands down on a queue that was STOPPED, so nothing starts unasked", async () => {
    await start([track("a"), track("b")]);
    await useMusic.getState().stop();
    await settle();
    // The queue deliberately survives a stop (so Play can carry on), which is
    // exactly why the command has to be refused: without the ownership test a
    // spoken "next song" hours later started track b out of nowhere.
    const before = played.length;
    expect(handleMusicCommand({ action: "next" })).toBe(false);
    await settle();
    expect(played.length).toBe(before);
    expect(useMusic.getState().index).toBe(0);
    expect(useMusic.getState().state).toBe("stopped");
  });

  it("stands down when the SHELL says somebody else is making the sound", async () => {
    await start([track("a"), track("b")]);
    // The shell forwards to the foreground app as well as to the sounding one, and
    // only it can tell them apart: a queue paused here with Spotify playing used
    // to take a spoken "next song" and start house music over it. Note the queue
    // here is PLAYING and this app owns the player - ownership cannot answer this
    // question, which is why the shell has to say.
    expect(handleMusicCommand({ action: "next", sounding: "spotify" })).toBe(false);
    expect(handleMusicCommand({ action: "lyrics", sounding: "spotify" })).toBe(false);
    expect(handleMusicCommand({ action: "shuffle", state: "on", sounding: "spotify" })).toBe(false);
    expect(useMusic.getState().index).toBe(0);
    expect(useMusic.getState().lyricsAsk).toBeNull();
    expect(useMusic.getState().shuffle).toBe(false);
    // ...and it acts when the sound is its own, or when the shell does not say.
    expect(handleMusicCommand({ action: "shuffle", state: "on", sounding: "mediaclient" })).toBe(true);
    expect(useMusic.getState().shuffle).toBe(true);
  });

  it("still sets shuffle and repeat on a queue that is not playing", async () => {
    await start([track("a"), track("b")]);
    await useMusic.getState().stop();
    await settle();
    // These two are store writes and touch no player, so requiring ownership for
    // them dropped a spoken "kapcsold ki a keverést" on a stopped queue - and
    // they are outside the silence policy, so the room heard it had been done.
    expect(handleMusicCommand({ action: "shuffle", state: "on" })).toBe(true);
    expect(useMusic.getState().shuffle).toBe(true);
    expect(handleMusicCommand({ action: "repeat", state: "all" })).toBe(true);
    expect(useMusic.getState().repeat).toBe("all");
    // ...while the ones that touch it still stand down.
    expect(handleMusicCommand({ action: "next" })).toBe(false);
    expect(handleMusicCommand({ action: "lyrics" })).toBe(false);
  });

  it("stands down while a film owns the player", async () => {
    await start([track("a"), track("b")]);
    usePlayer.setState({ current: { id: "film" } as never });
    expect(handleMusicCommand({ action: "next" })).toBe(false);
    await settle();
    expect(useMusic.getState().index).toBe(0);
  });

  it("stands down with nothing queued", () => {
    expect(handleMusicCommand({ action: "next" })).toBe(false);
    expect(handleMusicCommand({ action: "shuffle", state: "on" })).toBe(false);
    expect(useMusic.getState().shuffle).toBe(false);
  });

  it("answers an action it does not know, and a payload that is not one", async () => {
    await start([track("a")]);
    expect(handleMusicCommand({ action: "tv_off" })).toBe(false);
    expect(handleMusicCommand({ action: "" })).toBe(false);
    expect(handleMusicCommand(null)).toBe(false);
  });
});

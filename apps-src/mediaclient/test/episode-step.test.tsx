import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Player } from "../Player";
import { usePlayer, resetPlayer, useShowingPlayer } from "../playback/player";
import { claimPlayer, ownsPlayer, resetPlayerOwner } from "../playback/owner";
import { useApp } from "../state";
import { setupRemote, remote, setFocus, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem, StreamDecision } from "../backends/types";

// Stepping to the next episode, as the button on the overlay does it.
//
// The move is a stop and a start - five round trips - and for all of them the
// player holds nothing: the overlay comes down and there is no film on screen.
// Measured on the box: pressing the button again in that window started another
// episode, so a person pressing blindly at a screen that had gone dark stepped
// three or four episodes at once and landed somewhere nobody had asked for.
//
// Both halves are here, because either one alone leaves the same complaint. The
// press has to be refused while a move is in flight, and something has to be on
// screen saying the first press was taken.
//
// The third part of the fix - the overlay's key handler swallowing the D-pad so
// a press cannot reach the browsing screen hidden behind - is deliberately not
// asserted here: norigin calls preventDefault on the navigation keys itself, and
// its own handler is on `window` like ours, so in happy-dom a claimed press and
// an unclaimed one look the same. It is visible on the box, not from here.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const ep = (id: string): MediaItem => ({
  id,
  kind: "episode",
  title: `Episode ${id}`,
  grandparentTitle: "A Series",
  parentId: "s1",
  parentIndex: 1,
  index: Number(id.slice(1)),
  durationMs: 1_000_000,
});
const KIDS = [ep("e1"), ep("e2"), ep("e3"), ep("e4"), ep("e5")];

/** How long the server takes to answer for the episode being moved to. */
let resolveMs = 0;
let started: string[] = [];
/** Every time the box was told to stop, which is what releases the display mode. */
let boxStops = 0;
let listeners: ((ev: { type: string; reason?: string }) => void)[] = [];

/**
 * The shell reporting that the box has the picture up.
 *
 * `play()` sets `current` before the box is told anything, so until this arrives
 * the store is still buffering - and a step is refused for that whole window,
 * which is the point. Every test that wants a settled film has to say so.
 */
function onScreen(): void {
  listeners.forEach((l) => l({ type: "playing" }));
}

function fakeBackend(): MediaBackend {
  return {
    kind: "plex",
    resolveStream: async (id: string): Promise<StreamDecision> => {
      if (resolveMs) await new Promise((r) => setTimeout(r, resolveMs));
      return {
        url: `http://server/${id}.mkv`,
        audio: "auto",
        sub: "no",
        session: "s",
        transcoded: false,
        version: 0,
      } as StreamDecision;
    },
    markers: async () => [],
    item: async (id: string) => ({ id, kind: "episode", title: id, versions: [], roles: [], extras: [] }),
    children: async () => KIDS,
    reportProgress: async () => {},
    keepAlive: async () => {},
    endSession: async () => {},
  } as unknown as MediaBackend;
}

beforeEach(() => {
  started = [];
  boxStops = 0;
  listeners = [];
  resolveMs = 0;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: (url: string) => started.push(url),
    stop: () => {
      boxStops += 1;
    },
    pause: () => {},
    resume: () => {},
    onPlayer: (fn: (ev: { type: string; reason?: string }) => void) => {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },
    panel: { width: 1920, height: 1080 },
  };
  useApp.setState({ backend: fakeBackend() });
});

afterEach(() => resetPlayer());

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
  await flushFocus();
}

/** What every screen behind the player reads. */
function Showing(): React.JSX.Element {
  return <span>{useShowingPlayer() ? "showing" : "idle"}</span>;
}

describe("stepping to the next episode", () => {
  it("takes one press, whatever arrives while it is moving", async () => {
    render(<Player />);
    await act(async () => {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      onScreen();
    });
    await settle();
    expect(usePlayer.getState().siblings.next?.id).toBe("e3");
    await setFocus("pb-next");

    // A server that takes its time, which is the only condition under which the
    // window exists at all.
    resolveMs = 40;
    await remote.ok();
    // Mid-step the OUTGOING film is still what the box is showing.
    expect(usePlayer.getState().current?.item.id).toBe("e2");
    expect(usePlayer.getState().moving?.id).toBe("e3");

    // Two more asks inside the window. The button itself is drawn for the film
    // that is still on, so this is the shape they arrive in: a press on it, and a
    // phone's or a spoken skipNext, which go straight here.
    const second = await usePlayer.getState().playSibling("next");
    const third = await usePlayer.getState().playSibling("next");
    expect([second, third], "a step in flight refuses another").toEqual([undefined, undefined]);

    await settle(200);
    expect(usePlayer.getState().current?.item.id, "one press, one episode").toBe("e3");
    expect(usePlayer.getState().moving).toBeNull();
    // The first episode plus the one step. The two asks in between bought
    // nothing - unguarded they started e4 and then e5, which is the complaint:
    // pressing at a dark screen walked several episodes on.
    expect(started).toEqual(["http://server/e2.mkv", "http://server/e3.mkv"]);
  });

  it("never tells the box to stop, so the television changes mode once", async () => {
    // The box keeps its display mode while something claims it, and the shell's
    // own relaunch stops the running mpv with `keepMode` set for exactly that
    // reason. Telling the box to stop first threw it away: the mode went back to
    // the UI's and the new file claimed it again, and a mode switch blanks HDMI
    // for one to three seconds. Two blanks per episode change, and the second one
    // is where the new episode's first seconds went.
    const { container } = render(<Showing />);
    await act(async () => {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      onScreen();
    });
    expect(boxStops, "nothing has been stopped yet").toBe(0);

    resolveMs = 40;
    const step = usePlayer.getState().playSibling("next");
    await settle(10);
    // The outgoing film is still on screen and still playing, which is what
    // leaves the mode claimed - and what the browsing screens key on.
    expect(usePlayer.getState().current?.item.id).toBe("e2");
    expect(container.textContent).toBe("showing");

    await act(async () => {
      await step;
    });
    expect(usePlayer.getState().current?.item.id).toBe("e3");
    expect(started).toEqual(["http://server/e2.mkv", "http://server/e3.mkv"]);
    expect(boxStops, "the box was handed the new file, never told to stop").toBe(0);
    expect(container.textContent).toBe("showing");
  });

  it("does not stop a film that started while it was handing over", async () => {
    // The release and the box's stop used to run at the top of `stop`, before any
    // await, where nothing could overtake them. On the abandon path they now land
    // two server round trips later - so without the check they tore a film that
    // had really started off the screen.
    const gates: (() => void)[] = [];
    const slowStop = {
      ...fakeBackend(),
      endSession: () => new Promise<void>((r) => gates.push(() => r())),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(slowStop, KIDS[1]);
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();

    // A second, legitimate start lands while the first is still saying goodbye.
    usePlayer.getState().cancelMove();
    await usePlayer.getState().play(fakeBackend(), KIDS[4]);
    onScreen();
    const stops = boxStops;

    gates[0]?.();
    await step;
    await settle();
    expect(usePlayer.getState().current?.item.id, "the newer film is still on").toBe("e5");
    expect(boxStops, "and the box was not told to stop it").toBe(stops);
  });

  it("does not silence music that took the player while it was handing over", async () => {
    // Same window, the other owner. `stop` is protected by `whenPlayerLost`
    // clearing `current`; the abandon path runs past that, so without the check
    // it stopped the song while the music store went on saying it was playing.
    const gates: (() => void)[] = [];
    const slowStop = {
      ...fakeBackend(),
      endSession: () => new Promise<void>((r) => gates.push(() => r())),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(slowStop, KIDS[1]);
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();

    claimPlayer("music"); // the film's own teardown runs through whenPlayerLost
    resetPlayer(); // a sign-out: the token moves, and the step is abandoned
    const stops = boxStops;

    gates[0]?.();
    await step;
    await settle();
    expect(boxStops, "the song plays on").toBe(stops);
    expect(ownsPlayer("music")).toBe(true);
    resetPlayerOwner();
  });

  it("leaves the screen up when a step runs with nothing playing", async () => {
    // The one case a step really does run with no picture: an episode has ended,
    // the countdown is on screen, and a spoken "next episode" arrives. Hiding the
    // browsing screens there left the television black with the countdown behind
    // it - the opposite of what the hiding is for.
    const { container } = render(<Showing />);
    await act(async () => {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      onScreen();
    });
    expect(container.textContent).toBe("showing");

    await act(async () => usePlayer.getState().stop());
    resolveMs = 40;
    const step = usePlayer.getState().playSibling("next");
    await settle(10);
    expect(usePlayer.getState().moving?.id, "a step really is in flight").toBe("e3");
    expect(container.textContent, "and the season list stays up").toBe("idle");
    await act(async () => {
      await step;
    });
  });

  it("does not let the countdown beat a film asked for while it was resolving", async () => {
    // The auto-advance timer is five seconds and a resolve is three round trips,
    // so left armed it fired first, bumped the token and abandoned the call it
    // raced: measured, a film asked for by voice during the countdown was
    // replaced by the next episode.
    vi.useFakeTimers();
    try {
      await usePlayer.getState().play(fakeBackend(), KIDS[1], { queue: KIDS });
      onScreen();
      usePlayer.setState({ durationMs: 1_000_000, positionMs: 1_000_000 });
      listeners.forEach((l) => l({ type: "finished" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(usePlayer.getState().upNext?.item.id, "the countdown is armed").toBe("e3");

      resolveMs = 6_000; // longer than the countdown
      const asked = usePlayer.getState().play(fakeBackend(), KIDS[4]);
      await vi.advanceTimersByTimeAsync(7_000);
      await asked;
      expect(usePlayer.getState().current?.item.id, "what was asked for, not what was next").toBe("e5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says on the overlay that the press was taken, and keeps saying it", async () => {
    // The picture does not go away during a step any more, so the overlay is the
    // only place a press can be acknowledged. Measured before this: the rendered
    // page was byte-identical before the press and a second into the step, and
    // then the overlay faded out at four seconds with the old episode still on.
    vi.useFakeTimers();
    try {
      const { container } = render(<Player />);
      await act(async () => {
        await usePlayer.getState().play(fakeBackend(), KIDS[1]);
        onScreen();
      });
      await act(async () => await vi.advanceTimersByTimeAsync(0));
      const before = container.textContent;

      resolveMs = 20_000;
      void usePlayer.getState().playSibling("next");
      await act(async () => await vi.advanceTimersByTimeAsync(50));
      expect(container.textContent, "the press changed something").not.toBe(before);
      expect(container.textContent).toContain("S1E3");

      // Past the idle hide, which is when the wait is longest.
      await act(async () => await vi.advanceTimersByTimeAsync(6_000));
      expect(usePlayer.getState().overlay, "and it is still on screen").toBe(true);
      expect(container.textContent).toContain("S1E3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws away a pause aimed at the film that is being replaced", async () => {
    // The press reaches an overlay that looks entirely ordinary, so it is easy to
    // make: measured, OK paused the outgoing episode and the new one started
    // playing a second later - somebody pressed pause and got a playing
    // television. The press still brings the overlay up, where the line above
    // says what is happening.
    render(<Player />);
    await act(async () => {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      onScreen();
    });
    await settle();
    resolveMs = 60;
    const step = usePlayer.getState().playSibling("next");
    await settle(10);
    // The remote's own play/pause key, which acts whatever has focus.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "MediaPlayPause", bubbles: true, cancelable: true }));
    });
    expect(usePlayer.getState().state, "the outgoing film is not paused").toBe("playing");
    expect(usePlayer.getState().overlay, "but the press is acknowledged").toBe(true);

    await act(async () => {
      await step;
    });
    expect(usePlayer.getState().current?.item.id).toBe("e3");
    expect(usePlayer.getState().state).toBe("playing");
  });

  it("says so when a step could not be started", async () => {
    // The film carries on, which is right - but the press then produced nothing
    // visible at all, which is indistinguishable from a dead remote. `error` was
    // read by no component in the app.
    const broken = { ...fakeBackend(), resolveStream: () => Promise.reject(new Error("no")) } as unknown as MediaBackend;
    const { container } = render(<Player />);
    await act(async () => {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      onScreen();
    });
    await settle();
    usePlayer.setState({ siblings: { next: KIDS[2] } });
    // The sibling step goes through the broken backend.
    await act(async () => {
      await usePlayer.getState().play(broken, KIDS[2]);
    });
    await settle();
    expect(usePlayer.getState().current?.item.id, "the film carries on").toBe("e2");
    expect(container.textContent).toContain(en.player.failed);
  });

  it("really stops when an explicit stop lands inside the hand-over", async () => {
    // A plain cancel stands down there, so that one Back press has one outcome -
    // but an instruction to stop cannot: measured, the box was told to stop, the
    // house was told it had stopped, and the step went on to start the next
    // episode a second later.
    const gates: (() => void)[] = [];
    const slowStop = {
      ...fakeBackend(),
      endSession: () => new Promise<void>((r) => gates.push(() => r())),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(slowStop, KIDS[1]);
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();
    expect(usePlayer.getState().moving?.id).toBe("e3");

    usePlayer.getState().cancelMove(true);
    await usePlayer.getState().stop();
    gates[0]?.();
    await step;
    await settle();
    expect(usePlayer.getState().current, "nothing is playing").toBeNull();
    expect(started, "and no episode arrived after it").toEqual(["http://server/e2.mkv"]);
  });

  it("does not tear off a restart of the same film", async () => {
    // Two plays of one episode are the same id, so the abandon guard cannot use
    // it: a subtitle change during a step restarts the same film, and comparing
    // ids blanked the television and brought the browsing screens back.
    const gates: (() => void)[] = [];
    const slowStop = {
      ...fakeBackend(),
      endSession: () => new Promise<void>((r) => gates.push(() => r())),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(slowStop, KIDS[1]);
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();
    usePlayer.getState().cancelMove(true);
    await usePlayer.getState().play(fakeBackend(), KIDS[1]); // the same episode again
    onScreen();
    const stops = boxStops;

    gates[0]?.();
    await step;
    await settle();
    expect(usePlayer.getState().current?.item.id, "the restart is still on").toBe("e2");
    expect(boxStops, "and the box was not told to stop it").toBe(stops);
  });

  it("keeps the acknowledgement up when other keys are pressed", async () => {
    // `rearmHide` runs at the end of every key the handler does not swallow, and
    // none of them changes what the pin keys on - so one arrow press took the
    // acknowledgement away four seconds later with the old episode still on.
    vi.useFakeTimers();
    try {
      render(<Player />);
      await act(async () => {
        await usePlayer.getState().play(fakeBackend(), KIDS[1]);
        onScreen();
      });
      await act(async () => await vi.advanceTimersByTimeAsync(0));

      resolveMs = 20_000;
      void usePlayer.getState().playSibling("next");
      await act(async () => await vi.advanceTimersByTimeAsync(50));
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      });
      await act(async () => await vi.advanceTimersByTimeAsync(6_000));
      expect(usePlayer.getState().overlay, "still on screen after an arrow").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not seek a film that is about to be replaced", async () => {
    // From rest an arrow is a ten-second jump, not a cursor: it costs a transcode
    // segment on a stream discarded a second later and writes a resume point
    // nobody watched.
    render(<Player />);
    await act(async () => {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      onScreen();
    });
    await settle();
    await setFocus("player-idle");

    resolveMs = 60;
    const step = usePlayer.getState().playSibling("next");
    await settle(10);
    await remote.right();
    expect(usePlayer.getState().seekTargetMs, "no jump into the outgoing film").toBeNull();
    await act(async () => {
      await step;
    });
  });

  it("does not carry one attempt's failure onto the next film", async () => {
    // `error` had no owner and no clear except a successful start, so the line it
    // draws came back beside the title of a film that was playing perfectly well.
    const broken = { ...fakeBackend(), resolveStream: () => Promise.reject(new Error("no")) } as unknown as MediaBackend;
    await usePlayer.getState().play(fakeBackend(), KIDS[1]);
    onScreen();
    usePlayer.setState({ siblings: { next: KIDS[2] } });
    await usePlayer.getState().play(broken, KIDS[2]);
    expect(usePlayer.getState().error).toBe("unplayable");

    // A fresh attempt clears it as it STARTS, not when it succeeds - otherwise the
    // line stayed beside the title of a film that was playing perfectly well, for
    // the length of the next attempt and beyond.
    const gates: (() => void)[] = [];
    const slow = {
      ...fakeBackend(),
      resolveStream: () => new Promise<void>((r) => gates.push(() => r())).then(() => ({
        url: "http://server/e4.mkv",
        audio: "auto",
        sub: "no",
        session: "s",
        transcoded: false,
        version: 0,
      })),
    } as unknown as MediaBackend;
    const attempt = usePlayer.getState().play(slow, KIDS[3]);
    await settle();
    expect(usePlayer.getState().error, "gone the moment another attempt starts").toBeNull();
    gates[0]?.();
    await attempt;
  });

  it("does not write an abandoned attempt's failure onto the film that replaced it", async () => {
    const gates: (() => void)[] = [];
    let asked = 0;
    const one = fakeBackend() as unknown as { resolveStream(i: string): Promise<unknown> };
    const gated = {
      ...fakeBackend(),
      resolveStream: (id: string) =>
        (asked += 1) === 2
          ? new Promise<void>((r) => gates.push(() => r())).then(() => Promise.reject(new Error("no")))
          : one.resolveStream(id),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(gated, KIDS[1]);
    onScreen();
    const abandonedStep = usePlayer.getState().play(gated, KIDS[2]); // stalls, then fails
    await settle();
    await usePlayer.getState().play(fakeBackend(), KIDS[3]); // and is superseded
    onScreen();

    gates[0]?.();
    await abandonedStep;
    await settle();
    expect(usePlayer.getState().current?.item.id).toBe("e4");
    expect(usePlayer.getState().error, "the film that is playing did not fail").toBeNull();
  });

  it("gives the screen back if the move never lands", async () => {
    // Nothing here can cancel a request already in flight, so the only thing
    // bounded is the CLAIM. The Plex request layer has no timeout of its own, so
    // without this a server that accepts the connection and never answers left
    // the box on one line with the browsing screen hidden and Back swallowed.
    vi.useFakeTimers();
    try {
      // The first episode starts; the step after it asks a server that never
      // answers, which is the shape this guards against.
      let asked = 0;
      const stalls = {
        ...fakeBackend(),
        resolveStream: (id: string) =>
          (asked += 1) > 1
            ? new Promise<never>(() => {})
            : (fakeBackend() as unknown as { resolveStream(i: string): Promise<unknown> }).resolveStream(id),
      } as unknown as MediaBackend;
      await usePlayer.getState().play(stalls, KIDS[1]);
      onScreen();
      expect(usePlayer.getState().current?.item.id, "the first one has to start").toBe("e2");

      void usePlayer.getState().playSibling("next");
      await vi.advanceTimersByTimeAsync(0);
      expect(usePlayer.getState().moving?.id).toBe("e3");

      await vi.advanceTimersByTimeAsync(12_000);
      expect(usePlayer.getState().moving, "the claim is given up, not held for ever").toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses another step until the box has shown the last one", async () => {
    // `play()` sets `current` before the box is told anything, so the overlay
    // comes back with the buttons focusable while the screen is still black -
    // and a press there stepped another episode. Measured on this hardware a film
    // can take well over five seconds to appear, so this is most of the window
    // the guard exists for.
    await usePlayer.getState().play(fakeBackend(), KIDS[1]);
    onScreen();
    expect(await usePlayer.getState().playSibling("next")).toBeTruthy();
    expect(usePlayer.getState().current?.item.id).toBe("e3");
    expect(usePlayer.getState().buffering, "the box has not shown it yet").toBe(true);

    expect(await usePlayer.getState().playSibling("next"), "not until it has").toBeUndefined();
    expect(started).toEqual(["http://server/e2.mkv", "http://server/e3.mkv"]);

    onScreen();
    expect(await usePlayer.getState().playSibling("next"), "and then it may").toBeTruthy();
    expect(usePlayer.getState().current?.item.id).toBe("e4");
  });

  it("does not let a step it gave up on cancel the next one", async () => {
    // The give-up hands the screen back with the request still in flight, and
    // that request comes back eventually. Measured: its own cleanup cleared the
    // claim of the step somebody had started in the meantime, so the browsing
    // screens un-hid over a stopped player and that episode arrived underneath
    // them.
    vi.useFakeTimers();
    try {
      // The first film starts; both steps after it are held open, so two are in
      // flight at once - which is the only state this can be seen in.
      const gates: (() => void)[] = [];
      let asked = 0;
      const one = fakeBackend() as unknown as { resolveStream(i: string): Promise<unknown> };
      const gated = {
        ...fakeBackend(),
        resolveStream: (id: string) =>
          (asked += 1) === 1
            ? one.resolveStream(id)
            : new Promise<void>((r) => gates.push(() => r())).then(() => one.resolveStream(id)),
      } as unknown as MediaBackend;

      await usePlayer.getState().play(gated, KIDS[1]);
      onScreen();
      void usePlayer.getState().playSibling("next"); // held open
      await vi.advanceTimersByTimeAsync(0);
      expect(usePlayer.getState().moving?.id).toBe("e3");

      await vi.advanceTimersByTimeAsync(12_000); // given up on
      expect(usePlayer.getState().moving).toBeNull();

      void usePlayer.getState().playSibling("next"); // a second step, also held
      await vi.advanceTimersByTimeAsync(0);
      expect(usePlayer.getState().moving?.id, "the second step holds the claim").toBe("e3");

      gates[0]?.(); // the abandoned request lands at last
      await vi.advanceTimersByTimeAsync(50);
      // Identity cannot tell the two apart - the film never changed, so both
      // steps are aimed at the same episode - so the claim is held by sequence.
      expect(usePlayer.getState().moving, "and the claim is still the second step's").not.toBeNull();
      expect(started, "nor does the abandoned episode reach the box").toEqual(["http://server/e2.mkv"]);
      gates[1]?.();
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the film that is playing alone when Back gives a step up", async () => {
    // Back is the only key left during a step, and it cannot unsend the request -
    // so what it cancels is the claim. Nothing has been torn down at that point
    // any more, which is the whole shape of the fix: the episode somebody changed
    // their mind about never arrives, and the one they were watching carries on.
    const gates: (() => void)[] = [];
    let asked = 0;
    const one = fakeBackend() as unknown as { resolveStream(i: string): Promise<unknown> };
    const gated = {
      ...fakeBackend(),
      resolveStream: (id: string) =>
        (asked += 1) === 2
          ? new Promise<void>((r) => gates.push(() => r())).then(() => one.resolveStream(id))
          : one.resolveStream(id),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(gated, KIDS[1], { queue: KIDS });
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();
    expect(usePlayer.getState().moving?.id).toBe("e3");

    usePlayer.getState().cancelMove();
    expect(usePlayer.getState().moving, "the claim goes at once").toBeNull();

    gates[0]?.();
    await step;
    await settle();
    expect(usePlayer.getState().current?.item.id, "and the film carries on").toBe("e2");
    expect(usePlayer.getState().siblings.next?.id, "with its neighbours").toBe("e3");
    expect(started, "the box was never told to play the other one").toEqual(["http://server/e2.mkv"]);
    expect(boxStops, "nor to stop this one").toBe(0);
  });

  it("gives the buttons back if the box never says it started", async () => {
    // `buffering` is cleared by an event from the box, and a refused play sends
    // none - measured 2 attempts in 5 when the app is not the foreground one. So
    // a guard on the flag alone was permanent: the prev/next buttons died on a
    // box showing nothing, and the assistant answered "the box is already
    // changing episode" about it.
    vi.useFakeTimers();
    try {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      // No `onScreen()`: this is the box saying nothing at all.
      expect(await usePlayer.getState().playSibling("next"), "not while it may still be coming").toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(usePlayer.getState().buffering, "the flag is still stuck on").toBe(true);
      expect(await usePlayer.getState().playSibling("next"), "and the button works again").toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not refuse a step because the film stalled after it started", async () => {
    // The shell reports a stall on a transcoded stream as an ordinary event, so
    // the flag alone would refuse a legitimate step - silently, and with the
    // assistant claiming the box was changing episode when nothing was. The test
    // is the box's own first-frame event, not the clock: a stall EIGHT seconds in
    // is still after the start, and reading it as one is the case every caller
    // says it excludes.
    vi.useFakeTimers();
    try {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      onScreen();
      await vi.advanceTimersByTimeAsync(8_000);
      usePlayer.setState({ buffering: true }); // a stall, inside the old bound
      expect(await usePlayer.getState().playSibling("next")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the swap finish when Back lands inside the hand-over", async () => {
    // Past the hand-over the outgoing film's progress has been reported and its
    // session ended, so there is nothing to go back TO - honouring the cancel
    // there stopped the box and left the person on a season list, while the same
    // press a moment earlier let the film carry on. One press, two outcomes,
    // split by a window nobody can see. The window is two server round trips.
    const gates: (() => void)[] = [];
    const slowStop = {
      ...fakeBackend(),
      endSession: () => new Promise<void>((r) => gates.push(() => r())),
    } as unknown as MediaBackend;

    render(<Player />);
    await act(async () => {
      await usePlayer.getState().play(slowStop, KIDS[1]);
      onScreen();
    });
    await settle();
    const step = usePlayer.getState().playSibling("next");
    await settle();
    expect(usePlayer.getState().current?.item.id, "still saying the last one's last word").toBe("e2");

    await remote.back();
    expect(usePlayer.getState().moving?.id, "the press is not honoured here").toBe("e3");

    gates[0]?.();
    await step;
    await settle();
    expect(usePlayer.getState().current?.item.id, "and the episode that was asked for arrives").toBe("e3");
    expect(boxStops, "without the box ever being told to stop").toBe(0);
  });

  it("keeps the outgoing film's running order when a step is given up mid-resolve", async () => {
    // The resolve is the longer of the two windows, and nothing has been torn
    // down inside it - so a cancel there must leave the film that is playing
    // exactly as it was, order and all. Before the reorder this was the window in
    // which the queue and the neighbours had already been replaced for an item
    // that never played, and "next episode" then started the one after it.
    const gates: (() => void)[] = [];
    let asked = 0;
    const one = fakeBackend() as unknown as { resolveStream(i: string): Promise<unknown> };
    const gated = {
      ...fakeBackend(),
      resolveStream: (id: string) =>
        (asked += 1) === 1
          ? one.resolveStream(id)
          : new Promise<void>((r) => gates.push(() => r())).then(() => one.resolveStream(id)),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(gated, KIDS[1], { queue: KIDS });
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();
    usePlayer.getState().cancelMove();
    gates[0]?.();
    await step;
    await settle();

    expect(usePlayer.getState().current?.item.id).toBe("e2");
    expect(usePlayer.getState().siblings).toEqual({ prev: KIDS[0], next: KIDS[2] });
    expect(usePlayer.getState().queue?.length).toBe(5);
    expect(started).toEqual(["http://server/e2.mkv"]);
  });

  it("does not let a sign-out leave an episode arriving behind it", async () => {
    // `resetPlayer` is what a sign-out and a profile switch call, and `play` holds
    // its backend as an argument - so clearing the module's own reference does not
    // reach it. Measured: the film started anyway, and its first progress report
    // went out with the NEW profile's token.
    const gates: (() => void)[] = [];
    let asked = 0;
    const one = fakeBackend() as unknown as { resolveStream(i: string): Promise<unknown> };
    const gated = {
      ...fakeBackend(),
      resolveStream: (id: string) =>
        (asked += 1) === 1
          ? one.resolveStream(id)
          : new Promise<void>((r) => gates.push(() => r())).then(() => one.resolveStream(id)),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(gated, KIDS[1]);
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();

    resetPlayer();
    gates[0]?.();
    await step;
    await settle();
    expect(usePlayer.getState().current).toBeNull();
    expect(started).toEqual(["http://server/e2.mkv"]);
  });

  it("does not leave the overlay up for ever when the box never reports", async () => {
    // The pin was a branch that armed no timer, and nothing else re-runs on the
    // bound running out - so on a box that reports no first frame the overlay
    // never hid again. Most reachable on a RESUME, where the position report that
    // accidentally rescued a fresh start never arrives at zero.
    vi.useFakeTimers();
    try {
      render(<Player />);
      await act(async () => {
        await usePlayer.getState().play(fakeBackend(), { ...KIDS[1], viewOffsetMs: 600_000 });
      });
      await act(async () => await vi.advanceTimersByTimeAsync(0));
      expect(usePlayer.getState().overlay, "held up while it may still be coming").toBe(true);

      await act(async () => await vi.advanceTimersByTimeAsync(30_000));
      expect(usePlayer.getState().overlay, "and gone once it plainly is not").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear the running order of the film that superseded it", async () => {
    // `forThis !== playToken` cannot tell a cancel from a LATER play, and a later
    // play has already written its queue and its neighbours by then. Measured: the
    // abandoned call's cleanup took them off the film that really was playing -
    // no prev/next buttons, no auto-advance, and "next episode" answered "nothing
    // follows this".
    const gates: (() => void)[] = [];
    let asked = 0;
    const one = fakeBackend() as unknown as { resolveStream(i: string): Promise<unknown> };
    const gated = {
      ...fakeBackend(),
      resolveStream: (id: string) =>
        (asked += 1) === 1
          ? new Promise<void>((r) => gates.push(() => r())).then(() => one.resolveStream(id))
          : one.resolveStream(id),
    } as unknown as MediaBackend;

    const stalled = usePlayer.getState().play(gated, KIDS[0], { queue: KIDS });
    await settle();
    // A second, legitimate start lands first and puts its own order in the store.
    await usePlayer.getState().play(gated, KIDS[1], { queue: KIDS });
    onScreen();
    expect(usePlayer.getState().siblings.next?.id).toBe("e3");

    gates[0]?.(); // the superseded call resolves at last
    await stalled;
    await settle();

    expect(usePlayer.getState().current?.item.id, "the later film is still on").toBe("e2");
    expect(usePlayer.getState().siblings.next?.id, "with its neighbours intact").toBe("e3");
    expect(usePlayer.getState().queue?.length, "and its running order").toBe(5);
  });
});

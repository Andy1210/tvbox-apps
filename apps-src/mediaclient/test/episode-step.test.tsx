import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Player } from "../Player";
import { usePlayer, resetPlayer, useShowingPlayer } from "../playback/player";
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
  listeners = [];
  resolveMs = 0;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: (url: string) => started.push(url),
    stop: () => {},
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
    // Mid-move: nothing is playing and the next one has not arrived.
    expect(usePlayer.getState().current).toBeNull();

    // Two more asks inside the window. The button itself is unmounted with the
    // overlay, so this is the shape they arrive in: the button once it has come
    // back, and a phone's or a spoken skipNext, which go straight here.
    const second = await usePlayer.getState().playSibling("next");
    const third = await usePlayer.getState().playSibling("next");
    expect([second, third], "a move in flight refuses another").toEqual([undefined, undefined]);

    await settle(200);
    expect(usePlayer.getState().current?.item.id, "one press, one episode").toBe("e3");
    expect(usePlayer.getState().moving).toBeNull();
    // The first episode plus the one step. The two asks in between bought
    // nothing - unguarded they started e4 and then e5, which is the complaint:
    // pressing at a dark screen walked several episodes on.
    expect(started).toEqual(["http://server/e2.mkv", "http://server/e3.mkv"]);
  });

  it("still counts as showing a film while it moves", async () => {
    // The screens behind key on this, and for the length of the move the player
    // holds nothing: read as "playback is over" they wake up behind the
    // transition. The home screen's backdrop is the sharp one - it is portalled
    // out of the hidden page, so nothing the page does to itself reaches it, and
    // four full-screen layers land over the picture.
    const { container } = render(<Showing />);
    await act(async () => {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      onScreen();
    });
    expect(container.textContent).toBe("showing");

    resolveMs = 40;
    const move = usePlayer.getState().playSibling("next");
    await settle(10);
    expect(usePlayer.getState().current, "nothing is playing at this instant").toBeNull();
    expect(container.textContent, "and the screens must stay out of the way").toBe("showing");

    await act(async () => {
      await move;
    });
    expect(container.textContent).toBe("showing");
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
      const abandoned = usePlayer.getState().moving;
      expect(abandoned?.id).toBe("e3");

      await vi.advanceTimersByTimeAsync(12_000); // given up on
      expect(usePlayer.getState().moving).toBeNull();

      void usePlayer.getState().playSibling("next"); // a second step, also held
      await vi.advanceTimersByTimeAsync(0);
      const live = usePlayer.getState().moving;
      expect(live, "the second step holds the claim").toBeTruthy();
      expect(live).not.toBe(abandoned);

      gates[0]?.(); // the abandoned request lands at last
      await vi.advanceTimersByTimeAsync(50);
      expect(usePlayer.getState().moving, "and the claim is still the second step's").toBe(live);
      expect(started, "nor does the abandoned episode reach the box").toEqual(["http://server/e2.mkv"]);
      gates[1]?.();
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the screen back when Back gives up a step, and drops what lands later", async () => {
    // Back is the only key left during a step, and eating it for as long as the
    // server takes is a dead remote. It cannot unsend the request, so what it
    // cancels is the claim - and the film that was on its way must not appear
    // over whatever the person went to instead.
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

    await usePlayer.getState().play(gated, KIDS[1]);
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();
    expect(usePlayer.getState().moving?.id).toBe("e3");

    usePlayer.getState().cancelMove();
    expect(usePlayer.getState().moving, "the screens come back at once").toBeNull();

    gates[0]?.();
    await step;
    await settle();
    expect(usePlayer.getState().current, "and nothing arrives after it").toBeNull();
    expect(started, "the box was never told to play it").toEqual(["http://server/e2.mkv"]);
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

  it("leaves nothing to step through after a step is given up", async () => {
    // The teardown has already run by then, and `stop` does not clear the
    // neighbours - so they survived a cancelled step and the next `skipNext`
    // answered ok and started an episode on a box that was showing nothing.
    const gates: (() => void)[] = [];
    const slowStop = {
      ...fakeBackend(),
      endSession: () => new Promise<void>((r) => gates.push(() => r())),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(slowStop, KIDS[1]);
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();
    usePlayer.getState().cancelMove();
    gates[0]?.();
    await step;
    await settle();

    expect(usePlayer.getState().current).toBeNull();
    expect(usePlayer.getState().siblings, "nothing to step to").toEqual({});
    expect(await usePlayer.getState().playSibling("next"), "and nothing steps").toBeUndefined();
    expect(started).toEqual(["http://server/e2.mkv"]);
  });

  it("drops a step that was given up while the last episode was being closed off", async () => {
    // The last word for the previous episode is two server round trips, which on
    // a slow server is most of the step - and the token used to be taken AFTER
    // them, so a Back arriving in that window was eaten and the episode landed
    // anyway. Back looked like it had worked and then the film started on top of
    // the screen it had returned to.
    // `end()` awaits the final progress report and then the session; holding the
    // session is holding the teardown.
    const gates: (() => void)[] = [];
    const slowStop = {
      ...fakeBackend(),
      endSession: () => new Promise<void>((r) => gates.push(() => r())),
    } as unknown as MediaBackend;

    await usePlayer.getState().play(slowStop, KIDS[1]);
    onScreen();
    const step = usePlayer.getState().playSibling("next");
    await settle();
    expect(usePlayer.getState().moving?.id, "the step is inside the teardown").toBe("e3");

    usePlayer.getState().cancelMove();
    gates[0]?.();
    await step;
    await settle();
    expect(usePlayer.getState().current, "nothing arrives after it").toBeNull();
    expect(started, "and the box was never told to play it").toEqual(["http://server/e2.mkv"]);
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

  it("says on screen which episode is starting", async () => {
    const { container } = render(<Player />);
    await act(async () => {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
      onScreen();
    });
    await settle();
    await setFocus("pb-next");

    resolveMs = 40;
    await remote.ok();
    // The screen behind must not come back either, which is what the browsing
    // screens key on: a film that is on its way counts as playing.
    expect(usePlayer.getState().current === null && usePlayer.getState().moving !== null).toBe(true);
    expect(container.textContent).toContain("A Series");
    expect(container.textContent).toContain(en.player.starting);
    await settle(200);
  });
});

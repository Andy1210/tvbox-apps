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

  it("says on screen which episode is starting", async () => {
    const { container } = render(<Player />);
    await act(async () => {
      await usePlayer.getState().play(fakeBackend(), KIDS[1]);
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

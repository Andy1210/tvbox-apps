import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { updateAllLayouts } from "@noriginmedia/norigin-spatial-navigation";
import { configureI18n } from "@sdk";
import { Player } from "../Player";
import { usePlayer } from "../playback/player";
import { useApp } from "../state";
import { setupRemote, place, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { ItemDetail, Marker, MediaItem, StreamDecision } from "../backends/types";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

// The harness dispatches ON WINDOW, which makes window the event TARGET - and at
// AT_TARGET both capture and bubble listeners on the same node run in
// registration order, so Player's stopPropagation() cannot stop norigin. On the
// box the event starts at a DOM node, so Player's window-capture listener runs
// strictly before norigin's window-bubble one and stopPropagation DOES stop it.
// These presses therefore start at document.body.
async function drain(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}
async function press(key: string): Promise<void> {
  await act(async () => {
    updateAllLayouts();
    await drain();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    await drain();
  });
}
const key = {
  up: () => press("ArrowUp"),
  down: () => press("ArrowDown"),
  left: () => press("ArrowLeft"),
  right: () => press("ArrowRight"),
  ok: () => press("Enter"),
  back: () => press("Backspace"),
};

const item: MediaItem = { id: "m1", kind: "movie", title: "Film", durationMs: 7_200_000 };
const detail: ItemDetail = {
  ...item,
  roles: [],
  scores: [],
  reviews: [],
  extras: [],
  chapters: [],
  versions: [
    {
      index: 0,
      partIndex: 0,
      parts: 1,
      partId: "55784",
      label: "1080p",
      audio: [
        { ordinal: 0, id: "a1", kind: "audio", label: "Magyar" },
        { ordinal: 1, id: "a2", kind: "audio", label: "English" },
      ],
      subtitles: [{ ordinal: 0, id: "s1", kind: "subtitle", label: "Magyar" }],
    },
  ],
};
const decision: StreamDecision = {
  url: "http://s/stream.m3u8",
  audio: "auto",
  sub: "auto",
  subtitlesBurnedIn: false,
  version: 0,
  session: "sess-1",
  location: "lan",
  transcoded: true,
};

const bridge = {
  seek: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  play: vi.fn(),
  selectStreams: vi.fn(),
  onPlayer: vi.fn(() => () => {}),
  panel: null,
};

function setPlaying(over: Partial<Parameters<typeof usePlayer.setState>[0]> = {}, markers: Marker[] = []): void {
  usePlayer.setState({
    current: { item, decision, markers, detail, choice: { version: 0 } },
    state: "playing",
    positionMs: 600_000,
    durationMs: 7_200_000,
    buffering: false,
    seekTargetMs: null,
    scrubMs: null,
    overlay: true,
    error: null,
    ...(over as object),
  });
}

/** Real geometry of the overlay at a 1080-tall viewport (see the report). */
const VH = 1080 / 100;
function layOut(container: HTMLElement): void {
  const byKey = (k: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-k="${k}"]`);
  // ScrubBar root: 65.8vh .. 89.2vh; the button row: 90.6vh .. 96vh.
  const scrub = container.querySelector<HTMLElement>("[data-scrub]");
  if (scrub) place(scrub, 4 * 19.2, 65.8 * VH, 92 * 19.2, 23.4 * VH);
  const row = ["pb-playpause", "pb-tracks", "pb-quality"];
  row.forEach((k, i) => {
    const el = byKey(k);
    if (el) place(el, 4 * 19.2 + i * 200, 90.6 * VH, 180, 5.4 * VH);
  });
  const skip = byKey("skip");
  // right-[4vw], bottom-[34vh] -> 60.6vh .. 66vh
  if (skip) place(skip, 80 * 19.2, 60.6 * VH, 200, 5.4 * VH);
}

/** Tag the focusable DOM nodes so the geometry can find them. */
function tag(container: HTMLElement): void {
  const texts: Record<string, string> = {
    "pb-playpause": en.player.pause,
    "pb-tracks": en.player.tracks,
    "pb-quality": en.player.quality,
    skip: en.player.skipIntro,
  };
  for (const [k, text] of Object.entries(texts)) {
    const el = [...container.querySelectorAll("div")].find((d) => d.textContent === text && d.children.length === 0);
    if (el) el.setAttribute("data-k", k);
  }
  // The scrub focusable is the div holding the preview area, the bar and the hint.
  const hint = [...container.querySelectorAll("p")].find(
    (p) => p.textContent === en.player.hint || p.textContent === en.player.hintScrub,
  );
  hint?.parentElement?.setAttribute("data-scrub", "1");
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  await flushFocus();
}

beforeEach(async () => {
  vi.stubGlobal("crypto", { randomUUID: () => "uuid" });
  (window as unknown as { tvbox: unknown }).tvbox = bridge;
  Object.values(bridge).forEach((v) => typeof v === "function" && (v as ReturnType<typeof vi.fn>).mockClear?.());
  useApp.setState({ backend: null, screen: { name: "home" }, history: [], failure: null } as never);
  usePlayer.setState({ current: null, scrubMs: null, seekTargetMs: null, overlay: false });
  await act(async () => setFocus(""));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 2. Focus routing between the bar and the button row
// ---------------------------------------------------------------------------

describe("PROBE focus routing", () => {
  it("A: the bar has focus at start, Down reaches the buttons, Up comes back", async () => {
    setPlaying();
    const { container } = render(<Player />);
    await settle();
    tag(container);
    layOut(container);

    expect(getCurrentFocusKey()).toBe("scrub");
    await key.down();
    console.log("after Down:", getCurrentFocusKey());
    await key.up();
    console.log("after Up:", getCurrentFocusKey());
  });

  it("B: Left/Right on a button move between buttons and do NOT scrub", async () => {
    setPlaying();
    const { container } = render(<Player />);
    await settle();
    tag(container);
    layOut(container);

    await setFocus("pb-playpause");
    await key.right();
    console.log("button row, after Right:", getCurrentFocusKey(), "scrubMs:", usePlayer.getState().scrubMs);
    expect(usePlayer.getState().scrubMs).toBeNull();
    await key.right();
    console.log("button row, after Right x2:", getCurrentFocusKey());
    await key.left();
    console.log("button row, after Left:", getCurrentFocusKey());
  });

  it("C: Left/Right on the bar scrub and do NOT move focus", async () => {
    setPlaying();
    const { container } = render(<Player />);
    await settle();
    tag(container);
    layOut(container);

    expect(getCurrentFocusKey()).toBe("scrub");
    await key.right();
    console.log("bar, after Right: focus", getCurrentFocusKey(), "scrubMs", usePlayer.getState().scrubMs);
    expect(getCurrentFocusKey()).toBe("scrub");
    expect(usePlayer.getState().scrubMs).toBe(610_000);
  });

  it("D: the skip button steals focus, and then the bar is dead", async () => {
    setPlaying({ positionMs: 30_000 }, [{ type: "intro", startMs: 0, endMs: 90_000, final: false }]);
    const { container } = render(<Player />);
    await settle();
    tag(container);
    layOut(container);

    console.log("with an intro marker up, focus is:", getCurrentFocusKey());
    await key.right();
    console.log("  after Right: focus", getCurrentFocusKey(), "scrubMs", usePlayer.getState().scrubMs);
    await key.down();
    console.log("  Down from skip lands on:", getCurrentFocusKey());
    await key.up();
    console.log("  then Up lands on:", getCurrentFocusKey());
  });

  it("E: geometry - does Down from skip reach the bar at all?", async () => {
    setPlaying({ positionMs: 30_000 }, [{ type: "intro", startMs: 0, endMs: 90_000, final: false }]);
    const { container } = render(<Player />);
    await settle();
    tag(container);
    layOut(container);
    await setFocus("skip");
    await key.down();
    console.log("skip -> Down ->", getCurrentFocusKey());
    // The numbers themselves, for the report.
    console.log(
      "skip.bottom =",
      (60.6 + 5.4) * VH,
      " scrub.top =",
      65.8 * VH,
      " overlap =",
      (60.6 + 5.4) * VH - 65.8 * VH,
    );
  });

  it("F: when the marker ends while skip has focus, is anything focused?", async () => {
    setPlaying({ positionMs: 30_000 }, [{ type: "intro", startMs: 0, endMs: 90_000, final: false }]);
    const { container } = render(<Player />);
    await settle();
    tag(container);
    layOut(container);
    expect(getCurrentFocusKey()).toBe("skip");

    // The marker runs out. Overlay stays up because the user is pressing keys.
    await act(async () => {
      usePlayer.setState({ positionMs: 120_000 });
      await drain();
    });
    await flushFocus();
    console.log("marker over, focus is:", JSON.stringify(getCurrentFocusKey()));
    await key.down();
    console.log("  Down now lands on:", JSON.stringify(getCurrentFocusKey()));
    await key.right();
    console.log("  Right: focus", JSON.stringify(getCurrentFocusKey()), "scrubMs", usePlayer.getState().scrubMs);
  });
});

// ---------------------------------------------------------------------------
// 1. The two-stage scrub
// ---------------------------------------------------------------------------

describe("PROBE scrub lifecycle", () => {
  it("G: the overlay hides after 4s with the cursor still out, and OK commits it unseen", async () => {
    vi.useFakeTimers();
    setPlaying();
    const { container } = render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await drain();
    });
    tag(container);
    layOut(container);
    expect(getCurrentFocusKey()).toBe("scrub");

    await key.right();
    expect(usePlayer.getState().scrubMs).toBe(610_000);
    expect(usePlayer.getState().overlay).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
      await drain();
    });
    console.log("after 4.1s idle: overlay =", usePlayer.getState().overlay, " scrubMs =", usePlayer.getState().scrubMs);
    const el = container.querySelector<HTMLElement>(".absolute.inset-0");
    console.log("  overlay element classes:", el?.className);

    bridge.seek.mockClear();
    await key.ok();
    console.log("  OK while hidden -> seek called with:", bridge.seek.mock.calls, " pause:", bridge.pause.mock.calls.length);
    vi.useRealTimers();
  });

  it("H: Back while the cursor is out (and hidden) does not pause", async () => {
    vi.useFakeTimers();
    setPlaying();
    const { container } = render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await drain();
    });
    tag(container);
    layOut(container);
    await key.right();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
      await drain();
    });
    expect(usePlayer.getState().overlay).toBe(false);

    bridge.pause.mockClear();
    await key.back();
    console.log("Back #1: pause calls =", bridge.pause.mock.calls.length, " state =", usePlayer.getState().state, " scrubMs =", usePlayer.getState().scrubMs);
    await key.back();
    console.log("Back #2: pause calls =", bridge.pause.mock.calls.length, " state =", usePlayer.getState().state);
    vi.useRealTimers();
  });

  it("I: a cursor survives the track menu being opened and closed", async () => {
    setPlaying();
    const { container } = render(<Player />);
    await settle();
    tag(container);
    layOut(container);

    await key.right();
    expect(usePlayer.getState().scrubMs).toBe(610_000);
    // Down to the buttons, right to Tracks, OK opens the menu.
    await setFocus("pb-tracks");
    await key.ok();
    await settle();
    console.log("menu open? scrubMs =", usePlayer.getState().scrubMs);
    // The film plays on while the menu is up.
    await act(async () => {
      usePlayer.setState({ positionMs: 1_800_000 });
      await drain();
    });
    await key.back(); // closes the menu
    await settle();
    console.log("menu closed: scrubMs =", usePlayer.getState().scrubMs, " positionMs =", usePlayer.getState().positionMs);
    bridge.seek.mockClear();
    await setFocus("scrub");
    await key.ok();
    console.log("  OK now seeks to:", bridge.seek.mock.calls);
  });

  it("J: MediaTrackNext/Previous move the cursor with no way to commit it", async () => {
    setPlaying();
    const { container } = render(<Player />);
    await settle();
    tag(container);
    layOut(container);
    await setFocus("pb-playpause");
    await press("MediaTrackNext");
    console.log("with focus on a button, MediaTrackNext -> scrubMs =", usePlayer.getState().scrubMs);
    bridge.seek.mockClear();
    bridge.pause.mockClear();
    await key.ok();
    console.log("  then OK -> seek:", bridge.seek.mock.calls.length, " pause:", bridge.pause.mock.calls.length);
  });

  it("K: the film stops while a cursor is out", async () => {
    setPlaying();
    render(<Player />);
    await settle();
    await key.right();
    expect(usePlayer.getState().scrubMs).toBe(610_000);
    await act(async () => {
      await usePlayer.getState().stop();
      await drain();
    });
    console.log("after stop(): scrubMs =", usePlayer.getState().scrubMs, " current =", usePlayer.getState().current);
  });
});

// ---------------------------------------------------------------------------
// 4b. changeTracks and the resume position
// ---------------------------------------------------------------------------

describe("PROBE changeTracks", () => {
  it("L: a committed-but-unsettled seek is lost when quality changes", async () => {
    const resolveStream = vi.fn(async () => ({ ...decision, session: "sess-2" }));
    const backend = {
      resolveStream,
      markers: async () => [],
      item: async () => detail,
      setTracks: async () => {},
      reportProgress: async () => {},
      keepAlive: async () => {},
      endSession: async () => {},
    };
    setPlaying();
    // Play through the store so currentBackend is wired.
    await act(async () => {
      await usePlayer.getState().play(backend as never, item, {});
      await drain();
    });
    await act(async () => {
      usePlayer.setState({ positionMs: 600_000, durationMs: 7_200_000 });
      usePlayer.getState().seekTo(5_400_000); // the user just committed a scrub to 1:30:00
      await drain();
    });
    expect(usePlayer.getState().seekTargetMs).toBe(5_400_000);
    expect(usePlayer.getState().positionMs).toBe(600_000);

    bridge.play.mockClear();
    await act(async () => {
      await usePlayer.getState().changeTracks({ version: 0, maxBitrateKbps: 2000 });
      await drain();
    });
    console.log("restart start position (sec):", bridge.play.mock.calls.at(-1)?.[2]);
    console.log("  the seek target was 5400 s; positionMs was", 600_000 / 1000, "s");
  });

  it("M: two quality presses in flight leak a transcode session", async () => {
    const sessions: string[] = [];
    const ended: string[] = [];
    let n = 0;
    const backend = {
      resolveStream: async (_id: string, o: { session: string }) => {
        sessions.push(o.session);
        await new Promise((r) => setTimeout(r, 10));
        return { ...decision, session: o.session };
      },
      markers: async () => [],
      item: async () => detail,
      setTracks: async () => {},
      reportProgress: async () => {},
      keepAlive: async () => {},
      endSession: async (s: string) => {
        ended.push(s);
      },
    };
    vi.stubGlobal("crypto", { randomUUID: () => `sess-${++n}` });
    await act(async () => {
      await usePlayer.getState().play(backend as never, item, {});
      await drain();
    });
    // Two presses on the quality column, the second before the first settles.
    await act(async () => {
      const a = usePlayer.getState().changeTracks({ version: 0, maxBitrateKbps: 4000 });
      const b = usePlayer.getState().changeTracks({ version: 0, maxBitrateKbps: 2000 });
      await Promise.all([a, b]);
      await drain();
    });
    console.log("sessions started:", sessions);
    console.log("sessions ended  :", ended);
    console.log("leaked          :", sessions.filter((s) => !ended.includes(s) && s !== usePlayer.getState().current?.decision.session));
  });

  it("N: changing version silently drops the quality ceiling", async () => {
    setPlaying({ current: { item, decision, markers: [], detail, choice: { version: 0, maxBitrateKbps: 2000 } } });
    console.log("choice before:", usePlayer.getState().current?.choice);
    // TrackMenu's version Option calls apply({ version: v.index }) - nothing else.
    console.log("what a version press sends:", { version: 0 });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { updateAllLayouts } from "@noriginmedia/norigin-spatial-navigation";
import { configureI18n } from "@sdk";
import { Player } from "../Player";
import { usePlayer } from "../playback/player";
import { useApp } from "../state";
import { setupRemote, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { ItemDetail, MediaItem, StreamDecision } from "../backends/types";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

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
      audio: [{ ordinal: 0, id: "a1", kind: "audio", label: "Magyar" }],
      subtitles: [],
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

beforeEach(async () => {
  (window as unknown as { tvbox: unknown }).tvbox = bridge;
  Object.values(bridge).forEach((v) => typeof v === "function" && (v as ReturnType<typeof vi.fn>).mockClear?.());
  usePlayer.setState({ current: null, scrubMs: null, seekTargetMs: null, overlay: false, positionMs: 0, state: "stopped" });
  await act(async () => setFocus(""));
});
afterEach(() => vi.useRealTimers());

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  await flushFocus();
}

describe("PROBE after the menu", () => {
  it("AF: focus and overlay after Back closes the track menu", async () => {
    vi.useFakeTimers();
    usePlayer.setState({
      current: { item, decision, markers: [], detail, choice: { version: 0 } },
      state: "playing",
      positionMs: 600_000,
      durationMs: 7_200_000,
      overlay: true,
    });
    const { container } = render(<Player />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await drain();
    });
    expect(getCurrentFocusKey()).toBe("scrub");
    await act(async () => {
      setFocus("pb-tracks");
      await drain();
    });
    await press("Enter");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await drain();
    });
    console.log("AF menu open, focus:", getCurrentFocusKey());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await drain();
    });
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      await vi.advanceTimersByTimeAsync(20);
      await drain();
    });
    console.log("AF menu closed. focus:", JSON.stringify(getCurrentFocusKey()), " overlay:", usePlayer.getState().overlay);
    const el = container.querySelector<HTMLElement>(".absolute.inset-0");
    console.log("AF overlay classes:", el?.className.includes("opacity-0") ? "opacity-0 (invisible)" : "opacity-100");
    // Can the user still pause?
    bridge.pause.mockClear();
    await press("Enter");
    console.log("AF Enter after closing the menu -> pause():", bridge.pause.mock.calls.length, " overlay:", usePlayer.getState().overlay);
    const { doesFocusableExist } = await import("@noriginmedia/norigin-spatial-navigation");
    console.log("AF the focused key still exists?", doesFocusableExist(getCurrentFocusKey() ?? ""));
    await press("ArrowRight");
    console.log("AF Right -> focus", JSON.stringify(getCurrentFocusKey()), " scrubMs", usePlayer.getState().scrubMs);
    await press("ArrowDown");
    console.log("AF Down -> focus", JSON.stringify(getCurrentFocusKey()));
    await press("ArrowUp");
    console.log("AF Up   -> focus", JSON.stringify(getCurrentFocusKey()));
    bridge.pause.mockClear();
    await press("Enter");
    console.log("AF Enter again -> pause():", bridge.pause.mock.calls.length);
    vi.useRealTimers();
  });

  it("AG: focus after a quality restart tears the overlay down and back up", async () => {
    const backend = {
      resolveStream: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { ...decision, session: "sess-2" };
      },
      markers: async () => [],
      item: async () => detail,
      setTracks: async () => {},
      reportProgress: async () => {},
      keepAlive: async () => {},
      endSession: async () => {},
    };
    useApp.setState({ backend } as never);
    render(<Player />);
    await act(async () => {
      await usePlayer.getState().play(backend as never, item, {});
      await drain();
    });
    await settle();
    console.log("AG playing, focus:", getCurrentFocusKey());
    await act(async () => {
      setFocus("pb-quality");
      await drain();
    });
    await press("Enter");
    await settle();
    console.log("AG quality menu open, focus:", getCurrentFocusKey());
    // Choose 2 Mbps: q-5
    await act(async () => {
      setFocus("q-5");
      await drain();
    });
    await press("Enter");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
      await drain();
    });
    await settle();
    console.log(
      "AG after the restart: focus",
      JSON.stringify(getCurrentFocusKey()),
      " choice",
      JSON.stringify(usePlayer.getState().current?.choice),
      " overlay",
      usePlayer.getState().overlay,
    );
  }, 15_000);
});

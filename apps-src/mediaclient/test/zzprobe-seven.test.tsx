import { describe, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { updateAllLayouts, doesFocusableExist } from "@noriginmedia/norigin-spatial-navigation";
import { configureI18n } from "@sdk";
import { Player } from "../Player";
import { usePlayer } from "../playback/player";
import { setupRemote, setFocus, getCurrentFocusKey } from "./remote";
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
    await new Promise((r) => setTimeout(r, 2));
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
  url: "http://s/x.m3u8",
  audio: "auto",
  sub: "auto",
  subtitlesBurnedIn: false,
  version: 0,
  session: "s",
  location: "lan",
  transcoded: true,
};
const bridge = { seek: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), onPlayer: vi.fn(() => () => {}) };

beforeEach(() => {
  (window as unknown as { tvbox: unknown }).tvbox = bridge;
  Object.values(bridge).forEach((v) => (v as ReturnType<typeof vi.fn>).mockClear?.());
});
afterEach(() => vi.useRealTimers());

async function settle(ms = 6): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
    await drain();
  });
}

describe("PROBE closing the track menu, real timers, repeated", () => {
  it("AJ: 8 identical runs of open-menu / Back / try to pause", async () => {
    const tally: Record<string, number> = {};
    for (let i = 0; i < 8; i += 1) {
      usePlayer.setState({
        current: { item, decision, markers: [], detail, choice: { version: 0 } },
        state: "playing",
        positionMs: 600_000,
        durationMs: 7_200_000,
        overlay: true,
        scrubMs: null,
        seekTargetMs: null,
      });
      render(<Player />);
      await settle();
      await act(async () => {
        setFocus("pb-tracks");
        await drain();
      });
      await press("Enter"); // opens the menu
      await settle();
      const inMenu = getCurrentFocusKey();
      await press("Backspace"); // closes it
      await settle();
      const afterClose = getCurrentFocusKey();
      const exists = doesFocusableExist(afterClose ?? "");
      bridge.pause.mockClear();
      await press("Enter");
      const paused = bridge.pause.mock.calls.length;
      await press("ArrowRight");
      const scrubbed = usePlayer.getState().scrubMs !== null;
      const outcome = `menu=${inMenu} afterClose=${afterClose} exists=${exists} pause=${paused} scrub=${scrubbed}`;
      tally[outcome] = (tally[outcome] ?? 0) + 1;
      cleanup();
      await act(async () => drain());
    }
    console.log("AJ outcomes:", JSON.stringify(tally, null, 1));
  }, 60_000);

  it("AK: the overlay's visibility after the menu closes (real 4s idle)", async () => {
    usePlayer.setState({
      current: { item, decision, markers: [], detail, choice: { version: 0 } },
      state: "playing",
      positionMs: 600_000,
      durationMs: 7_200_000,
      overlay: true,
    });
    const { container } = render(<Player />);
    await settle();
    await act(async () => {
      setFocus("pb-tracks");
      await drain();
    });
    await press("Enter");
    await settle();
    console.log("AK menu open, overlay =", usePlayer.getState().overlay, " focus =", getCurrentFocusKey());
    for (let s = 1; s <= 5; s += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 1_000));
        await drain();
      });
      console.log(`AK   t+${s}s inside the menu: overlay =`, usePlayer.getState().overlay);
    }
    await press("Backspace");
    await settle();
    const el = container.querySelector<HTMLElement>(".absolute.inset-0");
    console.log(
      "AK menu closed: overlay =",
      usePlayer.getState().overlay,
      " visible:",
      el?.className.includes("opacity-0") ? "NO (opacity-0)" : "yes",
    );
  }, 30_000);
});

describe("PROBE overlay auto-hide with a cursor out, real timers", () => {
  it("AL: OK after the overlay hid commits the unseen cursor", async () => {
    usePlayer.setState({
      current: { item, decision, markers: [], detail, choice: { version: 0 } },
      state: "playing",
      positionMs: 600_000,
      durationMs: 7_200_000,
      overlay: true,
      scrubMs: null,
      seekTargetMs: null,
    });
    render(<Player />);
    await settle();
    await act(async () => {
      setFocus("scrub");
      await drain();
    });
    await press("ArrowRight");
    console.log("AL cursor at", usePlayer.getState().scrubMs, " overlay", usePlayer.getState().overlay);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 4_300));
      await drain();
    });
    console.log("AL after 4.3s: overlay =", usePlayer.getState().overlay, " cursor still =", usePlayer.getState().scrubMs);
    bridge.seek.mockClear();
    bridge.pause.mockClear();
    await press("Enter");
    console.log("AL OK -> seek:", bridge.seek.mock.calls, " pause:", bridge.pause.mock.calls.length);

    // and Back, from a fresh cursor
    usePlayer.getState().showOverlay(true);
    await press("ArrowRight");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 4_300));
      await drain();
    });
    bridge.pause.mockClear();
    await press("Backspace");
    console.log("AL Back #1 -> pause:", bridge.pause.mock.calls.length, " state:", usePlayer.getState().state, " cursor:", usePlayer.getState().scrubMs);
    await press("Backspace");
    console.log("AL Back #2 -> pause:", bridge.pause.mock.calls.length, " state:", usePlayer.getState().state);
  }, 30_000);
});

import { describe, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { configureI18n, FocusButton } from "@sdk";
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

const item: MediaItem = { id: "m1", kind: "movie", title: "Film", durationMs: 7_200_000 };
const detail: ItemDetail = {
  ...item,
  roles: [],
  scores: [],
  reviews: [],
  extras: [],
  chapters: [],
  versions: [{ index: 0, partIndex: 0, parts: 1, partId: "55784", label: "1080p", audio: [], subtitles: [] }],
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

function Stage(): React.JSX.Element {
  const playing = usePlayer((s) => s.current !== null);
  return (
    <div>
      <div id="player-stage">
        <Player />
      </div>
      <main hidden={playing}>
        <FocusButton focusKey="detail-play" onEnter={() => {}}>
          Play
        </FocusButton>
        <FocusButton focusKey="detail-restart" onEnter={() => {}}>
          Restart
        </FocusButton>
      </main>
    </div>
  );
}

beforeEach(() => {
  (window as unknown as { tvbox: unknown }).tvbox = { seek: vi.fn(), pause: vi.fn(), onPlayer: vi.fn(() => () => {}) };
});
afterEach(() => vi.useRealTimers());

describe("PROBE the hand-off, repeated", () => {
  it("AH: 12 identical runs of `film starts while the detail page holds focus`", async () => {
    const tally: Record<string, number> = {};
    for (let i = 0; i < 12; i += 1) {
      usePlayer.setState({ current: null, overlay: false, state: "stopped", positionMs: 0, scrubMs: null, seekTargetMs: null });
      render(<Stage />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
        await drain();
      });
      await act(async () => {
        setFocus("detail-play");
        await drain();
      });
      const before = getCurrentFocusKey();
      await act(async () => {
        usePlayer.setState({
          current: { item, decision, markers: [], detail, choice: { version: 0 } },
          state: "playing",
          positionMs: 600_000,
          durationMs: 7_200_000,
          overlay: true,
        });
        await new Promise((r) => setTimeout(r, 5));
        await drain();
      });
      const after = getCurrentFocusKey();
      const outcome = `${before} -> ${after}`;
      tally[outcome] = (tally[outcome] ?? 0) + 1;
      cleanup();
      await act(async () => drain());
    }
    console.log("AH outcomes:", JSON.stringify(tally));
  }, 30_000);

  it("AI: same, but the film starts while focus sits on a key that no longer exists", async () => {
    // Exactly the state Back-out-of-the-track-menu leaves behind: getCurrentFocusKey()
    // still names a focusable that was unmounted.
    usePlayer.setState({ current: null, overlay: false, state: "stopped", positionMs: 0 });
    const { unmount } = render(
      <FocusButton focusKey="ghost" onEnter={() => {}}>
        Ghost
      </FocusButton>,
    );
    await act(async () => {
      setFocus("ghost");
      await drain();
    });
    console.log("AI focus before:", getCurrentFocusKey());
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
      await drain();
    });
    console.log("AI after unmount, focus key is still:", JSON.stringify(getCurrentFocusKey()));
    render(<Stage />);
    await act(async () => {
      usePlayer.setState({
        current: { item, decision, markers: [], detail, choice: { version: 0 } },
        state: "playing",
        positionMs: 600_000,
        durationMs: 7_200_000,
        overlay: true,
      });
      await new Promise((r) => setTimeout(r, 5));
      await drain();
    });
    console.log("AI film started, focus:", JSON.stringify(getCurrentFocusKey()));
  }, 15_000);
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { updateAllLayouts } from "@noriginmedia/norigin-spatial-navigation";
import { configureI18n, FocusButton } from "@sdk";
import { Player } from "../Player";
import { usePlayer } from "../playback/player";
import { setupRemote, place, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
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

const playSpy = vi.fn();

/** MediaClient's real shape: the browse screen stays MOUNTED behind the film,
 *  only `hidden`. So its focusables stay registered and the focus key survives. */
function Stage(): React.JSX.Element {
  const playing = usePlayer((s) => s.current !== null);
  return (
    <div>
      <div id="player-stage">
        <Player />
      </div>
      <main hidden={playing}>
        <FocusButton focusKey="detail-play" onEnter={() => playSpy()}>
          Play
        </FocusButton>
        <FocusButton focusKey="detail-restart" onEnter={() => {}}>
          Restart
        </FocusButton>
      </main>
    </div>
  );
}

beforeEach(async () => {
  (window as unknown as { tvbox: unknown }).tvbox = bridge;
  Object.values(bridge).forEach((v) => typeof v === "function" && (v as ReturnType<typeof vi.fn>).mockClear?.());
  playSpy.mockClear();
  usePlayer.setState({ current: null, scrubMs: null, seekTargetMs: null, overlay: false, positionMs: 0, state: "stopped" });
  await act(async () => setFocus(""));
});
afterEach(() => vi.useRealTimers());

describe("PROBE the overlay when the browse screen is still behind it", () => {
  it("AD: focus never reaches the bar, and every key belongs to the hidden screen", async () => {
    vi.useFakeTimers();
    const { container } = render(<Stage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await drain();
    });
    // The user is on the detail page and presses Play.
    await act(async () => {
      setFocus("detail-play");
      await drain();
    });
    expect(getCurrentFocusKey()).toBe("detail-play");
    console.log("AD t0 (before play):", JSON.stringify(getCurrentFocusKey()));

    await act(async () => {
      usePlayer.setState({
        current: { item, decision, markers: [], detail, choice: { version: 0 } },
        state: "playing",
        positionMs: 600_000,
        durationMs: 7_200_000,
        overlay: true,
      });
      await drain();
      console.log("AD t1 (rendered, before the 0ms timer):", JSON.stringify(getCurrentFocusKey()));
      await vi.advanceTimersByTimeAsync(1);
      await drain();
      console.log("AD t2 (after the 0ms timer):", JSON.stringify(getCurrentFocusKey()));
      await vi.advanceTimersByTimeAsync(10);
      await drain();
    });
    console.log("AD film started. focus =", JSON.stringify(getCurrentFocusKey()), "(the bar wanted 'scrub')");

    // `hidden` is display:none, and getBoundingClientRect on a display:none node
    // is all zeros - so the browse screen's focusables really measure 0x0 at the
    // origin while the film plays. That is the faithful model.
    const btns = [...container.querySelectorAll("div")].filter((d) => ["Play", "Restart"].includes(d.textContent ?? ""));
    btns.forEach((el, i) => place(el, 100 + i * 200, 200, 180, 60));
    const hint = [...container.querySelectorAll("p")].find(
      (p) => p.textContent === en.player.hint || p.textContent === en.player.hintScrub,
    );
    if (hint?.parentElement) place(hint.parentElement, 76, 710, 1766, 252);
    const row = [...container.querySelectorAll("div")].filter((d) =>
      [en.player.pause, en.player.tracks, en.player.quality].includes(d.textContent ?? ""),
    );
    row.forEach((el, i) => place(el, 76 + i * 200, 978, 180, 58));

    await press("ArrowRight");
    console.log("AD  Right -> focus", JSON.stringify(getCurrentFocusKey()), " scrubMs", usePlayer.getState().scrubMs);
    await press("Enter");
    console.log("AD  Enter -> detail Play pressed:", playSpy.mock.calls.length, " pause():", bridge.pause.mock.calls.length);

    // Four seconds of nothing: the overlay hides, the effect re-runs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_500);
      await drain();
    });
    console.log("AD  after the overlay auto-hid, focus =", JSON.stringify(getCurrentFocusKey()), " overlay =", usePlayer.getState().overlay);
    await press("ArrowLeft");
    console.log("AD  Left -> focus", JSON.stringify(getCurrentFocusKey()), " scrubMs", usePlayer.getState().scrubMs);
    await press("Enter");
    console.log(
      "AD  Enter on the hidden Play button -> play() fired:",
      playSpy.mock.calls.length,
      " pause():",
      bridge.pause.mock.calls.length,
    );
    await press("ArrowDown");
    await press("ArrowUp");
    console.log("AD  Down then Up -> focus", JSON.stringify(getCurrentFocusKey()), " (the bar is at y=710, the buttons at y=978)");
    vi.useRealTimers();
  });

  it("AE: same, but focus was cleared first (the case the tests cover)", async () => {
    vi.useFakeTimers();
    render(<Stage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await drain();
    });
    await act(async () => {
      setFocus("");
      await drain();
    });
    await act(async () => {
      usePlayer.setState({
        current: { item, decision, markers: [], detail, choice: { version: 0 } },
        state: "playing",
        positionMs: 600_000,
        durationMs: 7_200_000,
        overlay: true,
      });
      await vi.advanceTimersByTimeAsync(10);
      await drain();
    });
    console.log("AE with no prior focus, the bar takes it:", JSON.stringify(getCurrentFocusKey()));
    vi.useRealTimers();
  });
});

describe("PROBE quality restart window", () => {
  it("AB2: `current` is null while the new decision is in flight", async () => {
    const backend = {
      resolveStream: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { ...decision, session: "sess-2" };
      },
      markers: async () => [],
      item: async () => detail,
      setTracks: async () => {},
      reportProgress: async () => {},
      keepAlive: async () => {},
      endSession: async () => {},
    };
    await act(async () => {
      await usePlayer.getState().play(backend as never, item, {});
      await drain();
    });
    expect(usePlayer.getState().current).not.toBeNull();

    const samples: (boolean | null)[] = [];
    await act(async () => {
      const done = usePlayer.getState().changeTracks({ version: 0, maxBitrateKbps: 2000 });
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 15));
        samples.push(usePlayer.getState().current === null);
      }
      await done;
    });
    console.log("AB2 `current === null` samples across the restart:", samples);
    console.log("AB2 -> while any of these is true, <main hidden> is false: the browse screen is drawn over the film.");
  }, 15_000);
});

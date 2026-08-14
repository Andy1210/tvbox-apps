import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { updateAllLayouts } from "@noriginmedia/norigin-spatial-navigation";
import { configureI18n } from "@sdk";
import { Player } from "../Player";
import { ScrubPreview } from "../ScrubPreview";
import { TrackMenu, QUALITIES } from "../TrackMenu";
import { usePlayer } from "../playback/player";
import { useApp } from "../state";
import { __imageCacheSize, clearImages } from "../posters";
import { PlexBackend } from "../backends/plex/backend";
import { setupRemote, place, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { ItemDetail, MediaItem, MediaVersion, Session, StreamDecision } from "../backends/types";

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
const key = {
  up: () => press("ArrowUp"),
  down: () => press("ArrowDown"),
  left: () => press("ArrowLeft"),
  right: () => press("ArrowRight"),
  ok: () => press("Enter"),
  back: () => press("Backspace"),
};

const item: MediaItem = { id: "m1", kind: "movie", title: "Film", durationMs: 7_200_000 };
function version(over: Partial<MediaVersion> = {}): MediaVersion {
  return {
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
    ...over,
  };
}
const detail: ItemDetail = {
  ...item,
  roles: [],
  scores: [],
  reviews: [],
  extras: [],
  chapters: [],
  versions: [version()],
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
  usePlayer.setState({ current: null, scrubMs: null, seekTargetMs: null, overlay: false, positionMs: 0 });
  if (!globalThis.URL.createObjectURL) {
    let n = 0;
    globalThis.URL.createObjectURL = () => `blob:stub-${++n}`;
    globalThis.URL.revokeObjectURL = () => {};
  }
  clearImages();
  await act(async () => setFocus(""));
});
afterEach(() => vi.useRealTimers());

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  await flushFocus();
}

// ---------------------------------------------------------------------------
// Re-runs of the two probes that were poisoned by leaked focus
// ---------------------------------------------------------------------------

describe("PROBE focus, isolated", () => {
  it("C2: Left/Right on the bar scrub and leave focus on the bar", async () => {
    usePlayer.setState({
      current: { item, decision, markers: [], detail, choice: { version: 0 } },
      state: "playing",
      positionMs: 600_000,
      durationMs: 7_200_000,
      overlay: true,
    });
    render(<Player />);
    await settle();
    await setFocus("scrub");
    await key.right();
    console.log("C2 bar Right -> focus", getCurrentFocusKey(), "scrubMs", usePlayer.getState().scrubMs);
    await key.left();
    await key.left();
    console.log("C2 bar Left x2 -> focus", getCurrentFocusKey(), "scrubMs", usePlayer.getState().scrubMs);
  });

  it("K2: stop() and finished clear the cursor", async () => {
    usePlayer.setState({
      current: { item, decision, markers: [], detail, choice: { version: 0 } },
      state: "playing",
      positionMs: 600_000,
      durationMs: 7_200_000,
      overlay: true,
    });
    render(<Player />);
    await settle();
    await setFocus("scrub");
    await key.right();
    expect(usePlayer.getState().scrubMs).toBe(610_000);
    await act(async () => {
      await usePlayer.getState().stop();
      await drain();
    });
    console.log("K2 after stop(): scrubMs =", usePlayer.getState().scrubMs, "current =", usePlayer.getState().current);
  });

  it("O: can the skip button be reached from the bar at all?", async () => {
    usePlayer.setState({
      current: {
        item,
        decision,
        markers: [{ type: "intro" as const, startMs: 0, endMs: 90_000, final: false }],
        detail,
        choice: { version: 0 },
      },
      state: "playing",
      positionMs: 30_000,
      durationMs: 7_200_000,
      overlay: true,
    });
    const { container } = render(<Player />);
    await settle();
    const skipEl = [...container.querySelectorAll("div")].find(
      (d) => d.textContent === en.player.skipIntro && d.children.length === 0,
    );
    const hint = [...container.querySelectorAll("p")].find(
      (p) => p.textContent === en.player.hint || p.textContent === en.player.hintScrub,
    );
    const scrubEl = hint?.parentElement;
    const VH = 10.8;
    if (scrubEl) place(scrubEl, 76.8, 65.8 * VH, 1766, 23.4 * VH);
    if (skipEl) place(skipEl, 1536, 60.6 * VH, 200, 5.4 * VH);
    const buttons = [...container.querySelectorAll("div")].filter((d) =>
      [en.player.pause, en.player.tracks, en.player.quality].includes(d.textContent ?? ""),
    );
    buttons.forEach((el, i) => place(el, 76.8 + i * 200, 90.6 * VH, 180, 5.4 * VH));

    console.log("O default focus:", getCurrentFocusKey(), "(skip is on screen)");
    await setFocus("scrub");
    await key.up();
    console.log("O scrub -> Up ->", getCurrentFocusKey());
    await setFocus("pb-playpause");
    await key.up();
    console.log("O pb-playpause -> Up ->", getCurrentFocusKey());
    await key.up();
    console.log("O   -> Up again ->", getCurrentFocusKey());
  });

  it("P: closing the track menu can leave the overlay hidden", async () => {
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
    await act(async () => {
      // Any press arms the hide timer; this one opens the menu.
      updateAllLayouts();
      await drain();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await drain();
    });
    await act(async () => {
      usePlayer.getState().cancelScrub();
      await drain();
    });
    // open the menu the way the button does
    await act(async () => {
      await setFocus("pb-tracks");
      await drain();
    });
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await drain();
    });
    const menuUp = container.textContent?.includes(en.tracks.audio);
    console.log("P menu open?", menuUp, " overlay:", usePlayer.getState().overlay);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_500);
      await drain();
    });
    console.log("P after 4.5s inside the menu, overlay =", usePlayer.getState().overlay);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      await vi.advanceTimersByTimeAsync(20);
      await drain();
    });
    const el = container.querySelector<HTMLElement>(".absolute.inset-0");
    console.log("P menu closed. overlay =", usePlayer.getState().overlay, " classes:", el?.className);
    vi.useRealTimers();
  });

  it("Q: a forward keyframe snap larger than 2s freezes the bar", async () => {
    usePlayer.setState({
      current: { item, decision, markers: [], detail, choice: { version: 0 } },
      state: "playing",
      positionMs: 600_000,
      durationMs: 7_200_000,
      overlay: true,
      seekTargetMs: null,
    });
    act(() => usePlayer.getState().seekTo(610_000));
    expect(usePlayer.getState().seekTargetMs).toBe(610_000);
    // The reconciliation the bridge does, replayed by hand.
    const feed = (ms: number): void => {
      const target = usePlayer.getState().seekTargetMs;
      const settled = target === null || Math.abs(ms - target) < 2_000;
      usePlayer.setState({ positionMs: ms, seekTargetMs: settled ? null : target });
    };
    // fastSeek=1 on an HLS transcode lands on the next segment boundary.
    for (const ms of [613_000, 613_500, 614_000, 620_000, 700_000, 1_200_000]) feed(ms);
    console.log(
      "Q after a +3s forward snap and 10 min of playback: seekTargetMs =",
      usePlayer.getState().seekTargetMs,
      " positionMs =",
      usePlayer.getState().positionMs,
      " bar shows =",
      usePlayer.getState().scrubMs ?? usePlayer.getState().seekTargetMs ?? usePlayer.getState().positionMs,
    );
    // And a backward snap, for contrast.
    usePlayer.setState({ seekTargetMs: null, positionMs: 600_000 });
    act(() => usePlayer.getState().seekTo(610_000));
    for (const ms of [605_000, 606_000, 608_500, 609_500]) feed(ms);
    console.log("Q backward snap: seekTargetMs =", usePlayer.getState().seekTargetMs);
  });
});

// ---------------------------------------------------------------------------
// 3. ScrubPreview
// ---------------------------------------------------------------------------

describe("PROBE ScrubPreview", () => {
  const session: Session = {
    profileId: "p",
    profileName: "p",
    token: "s3cr3t-token",
    accountToken: "s3cr3t-token",
    serverId: "s",
    serverName: "s",
    baseUrl: "http://192.168.1.10:32400",
    location: "lan",
  };

  it("R: the URL and the DOM carry no token", async () => {
    const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });
    useApp.setState({ backend } as never);
    const url = backend.previewUrl("55784", 600_000, 416, 234);
    console.log("R previewUrl:", url);
    expect(url).not.toContain("s3cr3t-token");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["x"]), { status: 200 })),
    );
    const { container } = render(<ScrubPreview partId="55784" timeMs={600_000} widthVh={26} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      await drain();
    });
    const img = container.querySelector("img");
    console.log("R img src:", img?.getAttribute("src"), " full html:", container.innerHTML.slice(0, 200));
    expect(container.innerHTML).not.toContain("s3cr3t-token");
  });

  it("S: one failed frame blanks the preview for the rest of the gesture", async () => {
    const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });
    useApp.setState({ backend } as never);
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        // The second request fails (a blip, a 404 at one offset, a busy server).
        if (n === 2) return new Response("", { status: 500 });
        return new Response(new Blob(["x"]), { status: 200 });
      }),
    );
    const { container, rerender } = render(<ScrubPreview partId="55784" timeMs={600_000} widthVh={26} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      await drain();
    });
    console.log("S frame 1 rendered:", Boolean(container.querySelector("img")));
    rerender(<ScrubPreview partId="55784" timeMs={620_000} widthVh={26} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      await drain();
    });
    console.log("S frame 2 (failed) rendered:", Boolean(container.querySelector("img")));
    rerender(<ScrubPreview partId="55784" timeMs={640_000} widthVh={26} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      await drain();
    });
    console.log("S frame 3 (server fine again) rendered:", Boolean(container.querySelector("img")), "<- should be true");
    console.log("S fetches issued:", n);
  });

  it("T: preview frames evict the poster cache", async () => {
    const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });
    useApp.setState({ backend } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["x"]), { status: 200 })),
    );
    const { rerender } = render(<ScrubPreview partId="55784" timeMs={0} widthVh={26} />);
    // A held Right across a two-hour film: 60 s per press once the ramp is up.
    for (let i = 1; i <= 130; i += 1) {
      rerender(<ScrubPreview partId="55784" timeMs={i * 60_000} widthVh={26} />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 130));
        await drain();
      });
    }
    console.log("T shared image-cache entries after one full-length scrub:", __imageCacheSize(), "(MAX_ENTRIES = 240)");
  });

  it("U: partId undefined leaves the last frame up and issues nothing", async () => {
    const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });
    useApp.setState({ backend } as never);
    const f = vi.fn(async () => new Response(new Blob(["x"]), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const { container, rerender } = render(<ScrubPreview partId="55784" timeMs={600_000} widthVh={26} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      await drain();
    });
    const before = container.querySelector("img")?.getAttribute("src");
    rerender(<ScrubPreview partId={undefined} timeMs={1_800_000} widthVh={26} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      await drain();
    });
    console.log("U with no partId: img =", container.querySelector("img")?.getAttribute("src"), " (was", before, ")");
    console.log("U fetches:", f.mock.calls.length);
  });

  it("V: the bucket can round past the end of the film", () => {
    const durationMs = 7_200_000;
    const at = durationMs - 1_000;
    console.log("V timeMs", at, "-> bucket", Math.round(at / 5000) * 5000, " duration", durationMs);
  });
});

// ---------------------------------------------------------------------------
// 5. TrackMenu
// ---------------------------------------------------------------------------

describe("PROBE TrackMenu", () => {
  const base = {
    onChoose: () => {},
    onClose: () => {},
  };

  async function mount(props: Partial<Parameters<typeof TrackMenu>[0]>): Promise<void> {
    render(<TrackMenu versions={[version()]} current={{ version: 0 }} {...base} {...(props as object)} />);
    await settle();
  }

  it("W: focus lands somewhere real for every `initial`", async () => {
    for (const initial of ["version", "audio", "subtitles", "quality"] as const) {
      await act(async () => setFocus(""));
      const { unmount } = render(
        <TrackMenu versions={[version()]} current={{ version: 0 }} initial={initial} {...base} />,
      );
      await settle();
      console.log(`W initial=${initial} -> focus`, getCurrentFocusKey());
      unmount();
    }
  });

  it("X: quality column with an already-chosen ceiling, and with an unknown one", async () => {
    for (const kbps of [undefined, 4000, 999] as (number | undefined)[]) {
      await act(async () => setFocus(""));
      const { unmount, container } = render(
        <TrackMenu versions={[version()]} current={{ version: 0, maxBitrateKbps: kbps }} initial="quality" {...base} />,
      );
      await settle();
      const idx = QUALITIES.findIndex((q) => q.kbps === kbps);
      console.log(`X maxBitrateKbps=${kbps} findIndex=${idx} -> focus`, getCurrentFocusKey());
      console.log("   q- keys present:", QUALITIES.map((_, i) => `q-${i}`).join(","), " marked active:", [...container.querySelectorAll("span")].filter((s) => s.textContent === "•").length);
      unmount();
    }
  });

  it("Y: no audio tracks and a single version", async () => {
    await act(async () => setFocus(""));
    await mount({
      versions: [version({ audio: [], subtitles: [] })],
      initial: "audio",
    });
    console.log("Y initial=audio, no audio tracks -> focus", getCurrentFocusKey());
  });

  it("Z: the language buttons and the quality column are reachable from each other", async () => {
    await act(async () => setFocus(""));
    const { container } = render(
      <TrackMenu
        versions={[version()]}
        current={{ version: 0 }}
        initial="quality"
        onSearchSubtitles={() => {}}
        onSearchLanguage={() => {}}
        searchLanguage="hu"
        {...base}
      />,
    );
    await settle();
    // Model the four columns as four x-bands.
    const cols = [...container.querySelectorAll("section")];
    console.log("Z columns rendered:", cols.length, cols.map((c) => c.querySelector("h3")?.textContent));
    cols.forEach((sec, ci) => {
      const opts = [...sec.querySelectorAll<HTMLElement>("div")].filter((d) => d.parentElement?.parentElement === sec || d.parentElement === sec.children[1]);
      opts.forEach((el, ri) => place(el, ci * 400, 100 + ri * 60, 360, 50));
    });
    console.log("Z focus at open:", getCurrentFocusKey());
    await key.left();
    console.log("Z quality -> Left ->", getCurrentFocusKey());
  });
});

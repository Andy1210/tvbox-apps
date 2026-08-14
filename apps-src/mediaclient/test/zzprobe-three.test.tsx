import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { updateAllLayouts, doesFocusableExist } from "@noriginmedia/norigin-spatial-navigation";
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

describe("PROBE TrackMenu, isolated per test", () => {
  it("W1 initial=version", async () => {
    const { container } = render(
      <TrackMenu versions={[version()]} current={{ version: 0 }} initial="version" onChoose={() => {}} onClose={() => {}} />,
    );
    await settle();
    console.log("W1 focus:", getCurrentFocusKey(), " sections:", container.querySelectorAll("section").length);
    console.log("W1 headings:", [...container.querySelectorAll("h3")].map((h) => h.textContent));
    console.log("W1 q-0 exists?", doesFocusableExist("q-0"), " aud-0 exists?", doesFocusableExist("aud-0"));
  });

  it("W2 initial=quality, no ceiling yet", async () => {
    render(
      <TrackMenu versions={[version()]} current={{ version: 0 }} initial="quality" onChoose={() => {}} onClose={() => {}} />,
    );
    await settle();
    console.log("W2 focus:", getCurrentFocusKey(), " expected q-0");
  });

  it("W3 initial=quality, ceiling already 4 Mbps", async () => {
    render(
      <TrackMenu
        versions={[version()]}
        current={{ version: 0, maxBitrateKbps: 4000 }}
        initial="quality"
        onChoose={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    console.log("W3 focus:", getCurrentFocusKey(), " expected q-4 (QUALITIES[4] =", QUALITIES[4], ")");
  });

  it("W4 initial=quality, ceiling not in the list", async () => {
    render(
      <TrackMenu
        versions={[version()]}
        current={{ version: 0, maxBitrateKbps: 999 }}
        initial="quality"
        onChoose={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    console.log("W4 focus:", getCurrentFocusKey(), " findIndex =", QUALITIES.findIndex((q) => q.kbps === 999));
  });

  it("W5 initial=subtitles", async () => {
    render(
      <TrackMenu versions={[version()]} current={{ version: 0 }} initial="subtitles" onChoose={() => {}} onClose={() => {}} />,
    );
    await settle();
    console.log("W5 focus:", getCurrentFocusKey(), " expected sub-off");
  });

  it("W6 initial=audio with no audio tracks and a single version", async () => {
    render(
      <TrackMenu
        versions={[version({ audio: [], subtitles: [] })]}
        current={{ version: 0 }}
        initial="audio"
        onChoose={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    console.log("W6 focus:", getCurrentFocusKey(), " expected sub-off");
  });

  it("W7 the quality mark tracks the choice", async () => {
    const { container } = render(
      <TrackMenu
        versions={[version()]}
        current={{ version: 0, maxBitrateKbps: 4000 }}
        initial="quality"
        onChoose={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    const marked = [...container.querySelectorAll("span")]
      .filter((s) => s.textContent === "•")
      .map((s) => s.parentElement?.textContent);
    console.log("W7 rows marked active:", marked);
  });
});

describe("PROBE skip button mid-film", () => {
  it("AA: a marker that arrives while the overlay is already up", async () => {
    usePlayer.setState({
      current: { item, decision, markers: [{ type: "intro", startMs: 60_000, endMs: 150_000, final: false }], detail, choice: { version: 0 } },
      state: "playing",
      positionMs: 10_000,
      durationMs: 7_200_000,
      overlay: true,
    });
    const { container } = render(<Player />);
    await settle();
    console.log("AA before the marker: focus", getCurrentFocusKey(), " skip rendered?", container.textContent?.includes(en.player.skipIntro));

    await act(async () => {
      usePlayer.setState({ positionMs: 70_000 }); // inside the intro now
      await drain();
    });
    await flushFocus();
    console.log("AA marker active: focus", getCurrentFocusKey(), " skip rendered?", container.textContent?.includes(en.player.skipIntro));

    // Now the arrows: with focus on skip, does the bar still scrub?
    await press("ArrowRight");
    console.log("AA  Right -> focus", getCurrentFocusKey(), " scrubMs", usePlayer.getState().scrubMs);
    await press("Enter");
    console.log("AA  Enter -> seek calls", bridge.seek.mock.calls, " pause calls", bridge.pause.mock.calls.length);

    // And when the marker ends with focus still on skip.
    await act(async () => {
      usePlayer.setState({ positionMs: 200_000 });
      await drain();
    });
    await flushFocus();
    console.log("AA marker over: focus", JSON.stringify(getCurrentFocusKey()), " skip exists?", doesFocusableExist("skip"));
    await press("ArrowDown");
    console.log("AA  Down ->", JSON.stringify(getCurrentFocusKey()));
    await press("ArrowRight");
    console.log("AA  Right -> focus", JSON.stringify(getCurrentFocusKey()), " scrubMs", usePlayer.getState().scrubMs);
  });
});

describe("PROBE image cache", () => {
  const session: Session = {
    profileId: "p",
    profileName: "p",
    token: "tok",
    accountToken: "tok",
    serverId: "s",
    serverName: "s",
    baseUrl: "http://192.168.1.10:32400",
    location: "lan",
  };

  it("T2: how many cache entries one long scrub adds", async () => {
    const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });
    useApp.setState({ backend } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["x"]), { status: 200 })),
    );
    const { rerender } = render(<ScrubPreview partId="55784" timeMs={0} widthVh={26} />);
    for (let i = 1; i <= 60; i += 1) {
      rerender(<ScrubPreview partId="55784" timeMs={i * 60_000} widthVh={26} />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 130));
        await drain();
      });
    }
    console.log("T2 shared image-cache entries after 60 preview frames:", __imageCacheSize(), "(MAX_ENTRIES 240, shared with posters)");
  }, 30_000);

  it("U2: partId goes away mid-gesture", async () => {
    const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });
    useApp.setState({ backend } as never);
    const f = vi.fn(async () => new Response(new Blob(["x"]), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const { container, rerender } = render(<ScrubPreview partId="55784" timeMs={600_000} widthVh={26} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
      await drain();
    });
    const before = container.querySelector("img")?.getAttribute("src") ?? null;
    console.log("U2 frame 1 src:", before, " fetches:", f.mock.calls.length);
    rerender(<ScrubPreview partId={undefined} timeMs={1_800_000} widthVh={26} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
      await drain();
    });
    console.log("U2 after partId=undefined: src:", container.querySelector("img")?.getAttribute("src") ?? null, " fetches:", f.mock.calls.length);
  }, 15_000);
});

describe("PROBE quality restart visibility", () => {
  it("AB: `current` is null while the new decision is in flight", async () => {
    let resolveDecision: (() => void) | null = null;
    const backend = {
      resolveStream: async () => {
        await new Promise<void>((r) => {
          resolveDecision = r;
        });
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
      resolveDecision?.();
      await drain();
    });
    expect(usePlayer.getState().current).not.toBeNull();

    let seenNull = false;
    const p = act(async () => {
      const done = usePlayer.getState().changeTracks({ version: 0, maxBitrateKbps: 2000 });
      await drain();
      seenNull = usePlayer.getState().current === null;
      resolveDecision?.();
      await done;
      await drain();
    });
    await p;
    console.log("AB during the restart, current === null (so <main hidden> reopens and the browse screen shows over the film):", seenNull);
  });

  it("AC: a failed decision on a quality change loses the film entirely", async () => {
    let fail = false;
    const backend = {
      resolveStream: async () => {
        if (fail) throw new Error("network");
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
    fail = true;
    await act(async () => {
      await usePlayer.getState().changeTracks({ version: 0, maxBitrateKbps: 2000 });
      await drain();
    });
    console.log("AC after a failed quality change: current =", usePlayer.getState().current, " error =", usePlayer.getState().error);
  });
});

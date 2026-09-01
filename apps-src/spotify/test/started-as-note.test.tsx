// Whose Spotify session the music started in, said on the screen the press lands
// on.
//
// The box holds ONE session and the launcher may be browsing another account. When
// this box has no saved login for the account being browsed, the songs are the
// ones that were pressed but the session is somebody else's - and nothing on the
// player screen could show that by itself.
//
// The bug these tests exist for is the second press: a note is one press's answer,
// and left standing it re-appears over the NEXT song, claiming the wrong account
// about music that played in the right one.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";
import { configureI18n, useConfigStore } from "@sdk";
import { Spotify } from "../Spotify";
import { useSpotifyStore } from "../stores/spotify";
import { useBrowse } from "../stores/browse";
import { setupRemote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const play = vi.fn(async (_body: unknown) => ({ ok: true, error: "", startedAs: "" }) as PlayResult);
// Its own mock rather than an inline one, so a test can change what the box says
// about its accounts (an account whose display name never resolved).
const authStatus = vi.fn(async (..._a: unknown[]) => ({
  configured: true,
  connected: true,
  user: "Kata",
  accounts: [
    { id: "u1", name: "Kata", active: true },
    { id: "u2", name: "Bence", active: false },
  ],
  connectSeq: 0,
}));
type PlayResult = { ok: boolean; error: string; startedAs?: string };

vi.mock("../api", async () => {
  const real = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...real,
    authStatus: (...a: unknown[]) => authStatus(...a),
    fetchLiked: vi.fn(async () => ({
      items: [{ uri: "spotify:track:t1", name: "A Song", artists: "An Artist", album: "", duration_ms: 200000 }],
      error: "",
      truncated: false,
    })),
    fetchPlaylists: vi.fn(async () => ({ items: [], error: "" })),
    fetchPlaylistItems: vi.fn(async () => ({ items: [], error: "" })),
    playerState: vi.fn(async () => ({
      ok: true,
      connected: true,
      active: false,
      is_playing: false,
      shuffle: false,
      repeat: "off" as const,
    })),
    fetchQueue: vi.fn(async () => []),
    control: vi.fn(async () => ""),
    play: (body: unknown) => play(body),
  };
});

/** Enough config for the app to show the player screen rather than its enable screen. */
function enable(): void {
  useConfigStore.setState({
    config: { spotify: { enabled: true }, ambient: { enabled: false, idleMinutes: 0 } },
  } as never);
}

const click = (key: string): void => {
  const el = document.querySelector<HTMLElement>(`[data-sfocus="${key}"]`);
  if (!el) throw new Error("no focusable " + key);
  fireEvent.click(el);
};
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

// From the player screen into the library, and press the one liked song there.
async function pressASong(): Promise<void> {
  click("sp-browse");
  await settle();
  await settle();
  fireEvent.click(screen.getByText("A Song"));
  await settle();
  await settle();
}

beforeEach(() => {
  enable();
  useSpotifyStore.setState({ state: null, at: 0 });
  useBrowse.setState({ tab: "liked", openPl: null, query: "", shownFor: "Kata" } as never);
  play.mockReset();
  authStatus.mockReset();
  authStatus.mockResolvedValue({
    configured: true,
    connected: true,
    user: "Kata",
    accounts: [
      { id: "u1", name: "Kata", active: true },
      { id: "u2", name: "Bence", active: false },
    ],
    connectSeq: 0,
  });
  vi.useRealTimers();
});

describe("the sentence about whose session started", () => {
  it("names the account the music actually went out as", async () => {
    play.mockResolvedValue({ ok: true, error: "", startedAs: "Bence" });
    render(<Spotify onExit={vi.fn()} />);
    await settle();

    await pressASong();

    // The other account is named, and so is the one being browsed - the sentence
    // has no "this one"/"that one" for somebody to resolve at ten feet.
    const expected = en.spotify.startedAsOther.replace(/\{name\}/g, "Bence").replace(/\{mine\}/g, "Kata");
    expect(document.body.textContent).toContain(expected);
  });

  it("does not survive into the next press", async () => {
    // The bug: `onPlayed("")` left the previous note standing, and the player
    // screen showed it again over a song that had played in the right account.
    play.mockResolvedValue({ ok: true, error: "", startedAs: "Bence" });
    render(<Spotify onExit={vi.fn()} />);
    await settle();
    await pressASong();
    expect(document.body.textContent).toContain("Bence");

    play.mockResolvedValue({ ok: true, error: "", startedAs: "" }); // this one played as us
    await pressASong();

    expect(document.body.textContent).not.toContain("Bence");
  });

  it("says nothing when the music started in the account being browsed", async () => {
    play.mockResolvedValue({ ok: true, error: "", startedAs: "" });
    render(<Spotify onExit={vi.fn()} />);
    await settle();

    await pressASong();

    // The suite runs in English (configureI18n fallback), so this is the sentence
    // that would be there.
    expect(document.body.textContent).not.toContain("Spotify account, because");
  });

  it("names no second account when this one has no name of its own", async () => {
    // A linked account whose display name Spotify never resolved: the sentence
    // cannot say "cast from X's phone" because there is no X, so it says which
    // account is open here instead of leaving a hole in the middle.
    authStatus.mockResolvedValue({
      configured: true,
      connected: true,
      user: "",
      accounts: [{ id: "u1", name: "", active: true }],
      connectSeq: 0,
    });
    play.mockResolvedValue({ ok: true, error: "", startedAs: "Bence" });
    render(<Spotify onExit={vi.fn()} />);
    await settle();

    await pressASong();

    const expected = en.spotify.startedAsOtherPlain.replace(/\{name\}/g, "Bence");
    expect(document.body.textContent).toContain(expected);
  });

  it("goes away on its own, and a status poll cannot hold it there", async () => {
    // The regression this test exists for: the timer lived on the player screen and
    // was re-armed by every unrelated re-render. The account status is polled every
    // 10 s, shorter than the note's 12, so the note never expired at all - measured
    // still on screen after a minute.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      play.mockResolvedValue({ ok: true, error: "", startedAs: "Bence" });
      render(<Spotify onExit={vi.fn()} />);
      await settle();
      await pressASong();
      expect(document.body.textContent).toContain("Bence");

      // Two poll periods, one second at a time, with the promises allowed to land -
      // which is what re-rendered the screen and re-armed the old timer.
      for (let i = 0; i < 25; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      expect(document.body.textContent).not.toContain("Bence");
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { configureI18n, useConfigStore } from "@sdk";
import { MediaClient } from "../MediaClient";
import { useApp } from "../state";
import { usePlayer, resetPlayer } from "../playback/player";
import { __resetIdentity } from "../identity";
import { setupRemote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

/**
 * Asking the box for its screensaver.
 *
 * The launcher owns the ambient screen and its window is hidden while an app is
 * in front, so its idle timer cannot arm behind this one: a media client left on
 * a poster grid is a still picture the box would otherwise hold all night. The
 * keys land in this window, so the counting has to be here.
 *
 * What the tests are really about is where it must NOT ask. The shell would
 * bring the launcher forward, and reaching the launcher ENDS a native program
 * rather than hiding it - so asking while a film is loaded would stop the film.
 * And the sign-in screen is a code being read off the television while somebody
 * types it into a phone: the one screen where minutes without a press mean
 * attention rather than absence.
 */

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const requests: number[] = [];
/** Two minutes idle, as the launcher's own default has it. */
const IDLE_MINUTES = 2;

function setConfig(over: Record<string, unknown> = {}): void {
  useConfigStore.setState({
    config: { ambient: { enabled: true, idleMinutes: IDLE_MINUTES, city: "", sleepMinutes: 0, bing: false }, ...over },
  } as never);
}

/**
 * On a browsing screen, with the sign-in flow settled.
 *
 * `boot()` finds no saved session in a test environment and lands on sign-in,
 * which is the one screen this feature is switched off on - so a test that did
 * not do this would be measuring the off switch.
 */
async function renderOnHome(): Promise<void> {
  render(<MediaClient onExit={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    useApp.setState({ screen: { name: "home" } });
  });
}

/** Let the clock pass without letting real time pass. */
async function idle(minutes: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(minutes * 60_000);
  });
}

beforeEach(() => {
  requests.length = 0;
  vi.useFakeTimers();
  __resetIdentity();
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    ambient: { request: () => requests.push(Date.now()) },
    onPlayer: () => () => {},
    panel: { width: 1920, height: 1080 },
  };
  useApp.setState({ screen: { name: "home" }, history: [], session: null, backend: null, failure: null });
  setConfig();
});

afterEach(() => {
  resetPlayer();
  vi.useRealTimers();
  useConfigStore.setState({ config: undefined } as never);
});

describe("the screensaver over the media client", () => {
  it("asks for it once the box has been left alone", async () => {
    await renderOnHome();
    await idle(IDLE_MINUTES + 1);

    expect(requests.length).toBe(1);
  });

  it("does not ask while a press keeps arriving", async () => {
    await renderOnHome();
    for (let i = 0; i < 4; i++) {
      await idle(1);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      });
    }

    expect(requests.length).toBe(0);
  });

  it("does not ask while a film is loaded, paused included", async () => {
    await renderOnHome();
    act(() => {
      usePlayer.setState({
        current: {
          item: { id: "1", kind: "movie", title: "Film", versions: [], roles: [], extras: [] },
          decision: { url: "http://s/f.mkv", audio: "auto", sub: "no", session: "s", transcoded: false, version: 0 },
          markers: [],
          detail: undefined,
          choice: { mediaIndex: 0, label: "1080p", partId: "1", audio: [], subtitles: [] },
        } as never,
        state: "paused",
      });
    });
    await idle(IDLE_MINUTES + 1);

    // The shell refuses this too, because reaching the launcher would end mpv
    // rather than hide it - but a paused film is exactly when an idle timer
    // looks right, so the reason is worth holding here as well.
    expect(requests.length).toBe(0);
  });

  it("does not ask while the sign-in code is on screen", async () => {
    await renderOnHome();
    act(() => {
      useApp.setState({ screen: { name: "login" } });
    });
    await idle(IDLE_MINUTES + 1);

    expect(requests.length).toBe(0);
  });

  it("does not count time while this window is hidden", async () => {
    // A hidden window is not what anybody is looking at, and it receives none of
    // the keys that would reset the count - so its time is not idleness.
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await renderOnHome();
    await idle(IDLE_MINUTES + 1);
    expect(requests.length).toBe(0);

    visibility.mockReturnValue("visible");
    await idle(IDLE_MINUTES + 1);
    expect(requests.length).toBe(1);
    visibility.mockRestore();
  });

  it("does nothing at all when the box has its screensaver off", async () => {
    setConfig({ ambient: { enabled: false, idleMinutes: IDLE_MINUTES, city: "", sleepMinutes: 0, bing: false } });
    await renderOnHome();
    await idle(IDLE_MINUTES + 1);

    expect(requests.length).toBe(0);
  });

  it("survives a shell that has never heard of it", async () => {
    // An app installed over the air outlives the shell it was built against.
    (globalThis as unknown as { tvbox: { ambient?: unknown } }).tvbox.ambient = undefined;
    await renderOnHome();
    await idle(IDLE_MINUTES + 1);

    expect(requests.length).toBe(0);
  });
  it("does not fire straight away when the window comes back after a long hide", async () => {
    // The interval cannot keep the stamp fresh while hidden: Chromium throttles
    // a hidden renderer to about one wake a minute and freezes it after a
    // while. Measured on the box before the fix - a minute configured, twenty
    // seconds delivered, because the first tick after coming back compared
    // against a stamp from before the screensaver.
    //
    // Fake timers tick a hidden window exactly on schedule, which is why the
    // test above passes either way: the throttling is modelled here by moving
    // the clock WITHOUT running the timers.
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await renderOnHome();

    visibility.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Seven minutes pass with no tick at all - the frozen renderer.
    vi.setSystemTime(Date.now() + 7 * 60_000);

    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await idle(1);
    expect(requests.length, "the count starts again when the window returns").toBe(0);

    // And it still fires once the person really has left it alone - just past
    // the threshold from the RETURN, not from before the screensaver.
    await idle(IDLE_MINUTES - 0.5);
    expect(requests.length).toBe(1);
    visibility.mockRestore();
  });
});

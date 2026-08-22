import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import {
  init as initNav,
  destroy as destroyNav,
  type FocusableComponent,
  type FocusableComponentLayout,
} from "@noriginmedia/norigin-spatial-navigation";
import { configureI18n, useConfigStore } from "@sdk";
import { RetroArchApp } from "../RetroArch";
import { __resetLibrary } from "../library";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

/**
 * Asking the box for its screensaver over the games grid.
 *
 * The delay is the one the person set for the launcher, and the launcher's own
 * window is hidden while this app is in front - so its timer cannot arm behind
 * this one and a wall of covers is a still picture the box would hold all night.
 *
 * The config store is deliberately left EMPTY here rather than filled by hand.
 * That is the whole test: nothing else in this app reads the box's config, so
 * the app has to fetch it itself, and a version that only subscribed to the
 * store read a delay of zero and never asked. Measured on a box - the grid sat
 * there past the minute it was set to.
 */

configureI18n({ hu, en }, { fallback: "en" });

// happy-dom has no layout engine, so norigin's default measurement returns
// nothing and its scheduler rejects on every mount. This test does not walk the
// grid with the arrows - it only needs the focusables to register - so a flat
// adapter is enough; the D-pad harness that lays elements out on a synthetic
// plane lives in the media client's tests.
beforeAll(() => {
  initNav({
    layoutAdapter: {
      measureLayout: async (component: FocusableComponent): Promise<FocusableComponentLayout> => ({
        node: component.node,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
      }),
    },
  });
});
afterAll(() => destroyNav());

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchSystems: vi.fn(async () => ({ systems: [], playing: false })),
    fetchGames: vi.fn(async () => ({ games: [], core: null, cores: [] })),
  };
});

const requests: number[] = [];
/** One minute, as this house has it set. */
const IDLE_MINUTES = 1;

async function renderGrid(): Promise<void> {
  render(<RetroArchApp onExit={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
}

async function idle(minutes: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(minutes * 60_000);
  });
}

beforeEach(() => {
  requests.length = 0;
  localStorage.clear();
  __resetLibrary();
  vi.useFakeTimers();
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    ambient: { request: () => requests.push(Date.now()) },
  };
  // What the box answers, rather than what a test wrote into the store.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ambient: { enabled: true, idleMinutes: IDLE_MINUTES, city: "", sleepMinutes: 0, bing: false },
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useConfigStore.setState({ config: null } as never);
});

describe("the screensaver over the games grid", () => {
  it("asks for it once the box has been left alone", async () => {
    await renderGrid();
    await idle(IDLE_MINUTES * 1.5);

    expect(requests.length).toBe(1);
  });

  it("does not ask while a press keeps arriving", async () => {
    await renderGrid();
    for (let i = 0; i < 4; i++) {
      await idle(IDLE_MINUTES * 0.5);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      });
    }

    expect(requests).toEqual([]);
  });

  it("stays off when the box has its screensaver off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ambient: { enabled: false, idleMinutes: IDLE_MINUTES, city: "", sleepMinutes: 0, bing: false },
        }),
      })),
    );
    await renderGrid();
    await idle(IDLE_MINUTES + 1);

    expect(requests).toEqual([]);
  });
});

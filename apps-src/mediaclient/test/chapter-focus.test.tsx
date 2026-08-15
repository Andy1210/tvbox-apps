import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaItem } from "../backends/types";

/**
 * Focus may only ever be sent to a key that exists.
 *
 * This is the rule the chapter strip broke, and it is worth pinning as a rule
 * rather than as one screen's behaviour, because it is the same failure this
 * app has hit repeatedly: norigin leaves a focus key it does not know exactly
 * where it is, so a `setFocus` that names something not yet mounted parks the
 * cursor on a component that will never answer a press. Nothing errors.
 *
 * Here it happened because the key handler asked for the strip in the same
 * press that created it - React had not rendered, and `useFocusable` registers
 * in its own effect after that. The strip appeared, the cursor stayed on
 * "chapters", and since that key starts with neither "ch-" nor "pb-" the
 * overlay read it as RESTING: the next arrow seeked the film instead of moving
 * between thumbnails.
 *
 * The race itself does not reproduce under happy-dom - React and norigin both
 * settle in microtasks here, so the strip is always mounted in time. The rule
 * is what is tested, and the rule fails on the old code whatever the timing.
 */
const spy = vi.hoisted(() => ({ calls: [] as { key: string; existed: boolean }[] }));

vi.mock("@noriginmedia/norigin-spatial-navigation", async () => {
  const actual = await vi.importActual<typeof import("@noriginmedia/norigin-spatial-navigation")>(
    "@noriginmedia/norigin-spatial-navigation",
  );
  return {
    ...actual,
    setFocus: (key: string, ...rest: unknown[]) => {
      spy.calls.push({ key, existed: actual.doesFocusableExist(key) });
      return (actual.setFocus as (k: string, ...r: unknown[]) => unknown)(key, ...rest);
    },
  };
});

const { Player } = await import("../Player");
const { usePlayer } = await import("../playback/player");
const { useApp } = await import("../state");
const { setupRemote, remote, setFocus, flushFocus } = await import("./remote");

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const item: MediaItem = { id: "m1", kind: "movie", title: "Film", durationMs: 3_600_000 };

beforeEach(async () => {
  spy.calls.length = 0;
  useApp.setState({ backend: null });
  usePlayer.setState({
    current: {
      item,
      decision: { url: "http://x/s.m3u8", session: "s", transcoded: false },
      markers: [],
      detail: {
        id: "m1",
        kind: "movie",
        title: "Film",
        roles: [],
        extras: [],
        reviews: [],
        scores: [],
        versions: [{ index: 0, label: "1080p", partId: "1", audio: [], subtitles: [] }],
        chapters: [
          { index: 1, startMs: 0, endMs: 600_000 },
          { index: 2, startMs: 600_000, endMs: 1_200_000 },
        ],
      },
      choice: { version: 0 },
    } as never,
    state: "playing",
    positionMs: 700_000,
    durationMs: 3_600_000,
    seekTargetMs: null,
    scrubMs: null,
    overlay: true,
    buffering: false,
  });
  await act(async () => setFocus(""));
});

describe("opening the chapter strip", () => {
  it("never asks for a focus key that does not exist yet", async () => {
    render(<Player />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();

    await act(async () => setFocus("pb-playpause"));
    await flushFocus();
    spy.calls.length = 0;

    await remote.down();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();

    const missing = spy.calls.filter((c) => !c.existed && c.key !== "");
    expect(
      missing,
      `focus was requested for ${missing.map((m) => m.key).join(", ")}, which did not exist at the time`,
    ).toEqual([]);
    // And it did reach the strip, so the rule is not satisfied by never asking.
    expect(spy.calls.some((c) => c.key === "chapters")).toBe(true);
  });
});

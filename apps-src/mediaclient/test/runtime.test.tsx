import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Detail } from "../Detail";
import { Hero } from "../Hero";
import { Tile } from "../Tile";
import { useApp } from "../state";
import { usePlayer } from "../playback/player";
import { runtime } from "../time";
import type { ItemDetail, MediaItem } from "../backends/types";
import { flushFocus, setFocus, setupRemote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

// How long a film or an episode runs, wherever one is listed.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const t = (key: string, vars?: Record<string, string>): string =>
  key === "detail.runtimeHm" ? `${vars?.h}h ${vars?.m}m` : `${vars?.m}m`;

function tileText(item: MediaItem): string {
  const { container, unmount } = render(<Tile item={item} focusKey={`tile-${item.id}`} onEnter={() => {}} />);
  const text = container.textContent ?? "";
  unmount();
  return text;
}

beforeEach(() => {
  useApp.setState({ backend: null });
  usePlayer.setState({ current: null, upNext: null, moving: null });
});

describe("runtime", () => {
  it("reads in minutes, then in hours and minutes", () => {
    expect(runtime(42 * 60_000, t)).toBe("42m");
    expect(runtime(134 * 60_000, t)).toBe("2h 14m");
  });

  it("rounds a short clip up to a minute rather than saying zero", () => {
    expect(runtime(20_000, t)).toBe("1m");
  });

  it("says nothing when the length is not known", () => {
    expect(runtime(undefined, t)).toBe("");
    expect(runtime(0, t)).toBe("");
  });
});

describe("a tile", () => {
  it("carries the length of a film and of an episode", () => {
    expect(tileText({ id: "m", kind: "movie", title: "F", durationMs: 134 * 60_000 })).toMatch(/2\D+14/);
    expect(tileText({ id: "m", kind: "movie", title: "F", durationMs: 42 * 60_000 })).toMatch(/42/);
    expect(tileText({ id: "e", kind: "episode", title: "E", durationMs: 23 * 60_000 })).toMatch(/23/);
  });

  it("does not read a series' typical episode as the length of the series", () => {
    expect(tileText({ id: "s", kind: "show", title: "S", durationMs: 22 * 60_000 })).not.toMatch(/22/);
  });

  it("draws nothing for a film whose length is not known", () => {
    const { container } = render(
      <Tile item={{ id: "n", kind: "movie", title: "" }} focusKey="tile-n" onEnter={() => {}} />,
    );
    expect(container.querySelector(".tabular-nums")).toBeNull();
  });
});

describe("the home screen's description", () => {
  it("keeps the separator with the title and the length in one piece", () => {
    const { container } = render(
      <Hero item={{ id: "e", kind: "episode", title: "Pilot", grandparentTitle: "Series", durationMs: 23 * 60_000 }} />,
    );
    const line = [...container.querySelectorAll("p")].find((p) => p.textContent?.includes("Pilot"));
    expect(line?.textContent).toMatch(/^Pilot · .*23/);
    const length = line?.querySelector(".whitespace-nowrap")?.textContent;
    expect(length).toMatch(/23/);
    // Only the length: a title inside this span could no longer wrap.
    expect(length).not.toMatch(/Pilot/);
  });

  it("names a film's length, and no line at all for a series", () => {
    const film = render(<Hero item={{ id: "m", kind: "movie", title: "F", durationMs: 42 * 60_000 }} />);
    expect(film.container.textContent).toMatch(/42/);
    film.unmount();

    const show = render(<Hero item={{ id: "s", kind: "show", title: "S", durationMs: 22 * 60_000 }} />);
    expect(show.container.textContent).not.toMatch(/22/);
  });
});

describe("the episode list's header", () => {
  const season: MediaItem = { id: "rt-season", kind: "season", title: "1" };
  const episode: MediaItem = {
    id: "rt-ep",
    kind: "episode",
    title: "Pilot",
    index: 1,
    parentIndex: 1,
    grandparentTitle: "Series",
    parentId: season.id,
    durationMs: 23 * 60_000,
  };
  const detailOf = (item: MediaItem): ItemDetail =>
    ({ ...item, roles: [], extras: [], reviews: [], scores: [], chapters: [], versions: [] }) as ItemDetail;

  const tick = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      await flushFocus();
    }
  };

  it("gives the highlighted episode's length, in a line whose height was already there", async () => {
    useApp.setState({
      backend: {
        kind: "plex",
        item: async (id: string) => detailOf(id === episode.id ? episode : season),
        children: async () => [episode],
        posterUrl: () => undefined,
        artUrl: () => undefined,
        backdropUrl: () => undefined,
        themeUrl: () => undefined,
        imageHeaders: () => ({}),
        markers: async () => [],
      } as never,
      screen: { name: "item", itemId: season.id },
      history: [],
      failure: null,
    });

    const { container } = render(<Detail itemId={season.id} />);
    await tick();
    const header = (): HTMLElement => container.querySelector("header") as HTMLElement;
    const line = (): Element | null => header().querySelector('[class*="min-h-"]');

    expect(line()).toBeTruthy();
    expect(line()?.textContent).toBe("");

    await setFocus(`children-${season.id}-${episode.id}`);
    await tick();

    expect(line()?.textContent).toMatch(/23/);
  });
});

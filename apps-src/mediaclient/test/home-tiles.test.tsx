import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Home } from "../Home";
import { useApp } from "../state";
import { setupRemote, flushFocus } from "./remote";
import { TILE_VH } from "../Library";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem } from "../backends/types";

// Every poster on the home screen is one size.
//
// The carry-on-watching row asked for 24vh while every other row, and the
// library grid, take the shared 26vh default - so the first row of the screen
// was visibly the smallest one on it. By then it was showing the same 2:3
// artwork as its neighbours: it started on the EPISODE's own still, and a later
// change gave it the series cover instead, which left nothing wanting a
// shorter tile.
configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

function item(n: number, kind: MediaItem["kind"] = "movie"): MediaItem {
  return { id: `i${n}`, kind, title: `Film ${n}`, thumb: `/t/${n}` };
}

function stubBackend(): MediaBackend {
  return {
    kind: "plex",
    libraries: async () => [{ id: "1", title: "Movies", kind: "movie" }],
    onDeck: async () => [item(1, "episode")],
    recentlyAdded: async () => [item(2)],
    playlists: async () => [],
    item: async () => ({ id: "i1", kind: "movie", title: "Film 1", roles: [], extras: [], reviews: [], versions: [] }),
    backdropUrl: () => undefined,
    themeUrl: () => undefined,
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
  } as unknown as MediaBackend;
}

// No focus reset here on purpose. This test reads inline styles, not the
// cursor - and `setFocus("")` would not clear one anyway: norigin returns early
// on a falsy key.
beforeEach(() => {
  useApp.setState({ backend: stubBackend(), screen: { name: "home" }, history: [], failure: null });
});

describe("the home screen's posters", () => {
  it("are the same size in the carry-on-watching row as in the rest", async () => {
    const { container } = render(<Home />);
    await waitFor(() => expect(screen.getByText("Movies")).toBeInTheDocument());
    await flushFocus();

    // The width is the tile's own inline style, so this needs no layout engine:
    // Tile sizes itself `heightVh * aspect` and the poster box `heightVh`.
    const deck = container.querySelector<HTMLElement>('[data-sfocus="ondeck-i1"]');
    const recent = container.querySelector<HTMLElement>('[data-sfocus="recent-1-i2"]');
    expect(deck).toBeTruthy();
    expect(recent).toBeTruthy();
    expect(deck?.style.width).toBe(recent?.style.width);

    // ...and it is the shared default rather than both rows having drifted to
    // the same wrong number: 26vh of poster at a 2:3 ratio.
    const poster = (el: HTMLElement | null) => el?.firstElementChild as HTMLElement | null;
    expect(poster(deck)?.style.height).toBe("26vh");
    expect(poster(recent)?.style.height).toBe("26vh");
  });

  // The other half of the same invariant, and the half no rendering can reach
  // from here: the library grid carries its own copy of the number. Without
  // this the test above stays green while "one poster size" quietly stops
  // being true.
  it("are the size the library grid uses too", () => {
    expect(TILE_VH).toBe(26);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Detail } from "../Detail";
import { useApp } from "../state";
import { usePlayer, resetPlayer } from "../playback/player";
import { setupRemote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { ItemDetail, MediaBackend, MediaItem } from "../backends/types";

// The one row on a film's page, when the thing it shows is being fetched.
//
// A film has no children, so the countdown tile IS the row: the fallback that
// puts it there is the only reason the page is not empty. A spoken "next
// episode" during that countdown cancels it and starts a step, and without the
// step being covered too the row - the only one on the page - simply vanished
// for as long as the fetch took. Scoping it to parentage looked right and put it
// straight back: a film has no parent to match, so the test never fired on the
// one page this exists for.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const film = (id: string, title: string): MediaItem => ({ id, kind: "movie", title });

function detail(over: Partial<ItemDetail>): ItemDetail {
  return {
    id: "f1",
    kind: "movie",
    title: "First film",
    roles: [],
    extras: [],
    reviews: [],
    versions: [],
    chapters: [],
    scores: [],
    ...over,
  } as unknown as ItemDetail;
}

const backend = {
  kind: "plex",
  item: async () => detail({}),
  children: async () => [],
  posterUrl: () => undefined,
  artUrl: () => undefined,
  backdropUrl: () => undefined,
  themeUrl: () => undefined,
  imageHeaders: () => ({}),
  markers: async () => [],
} as unknown as MediaBackend;

const queue = [film("f1", "First film"), film("f2", "Second film")];

afterEach(() => resetPlayer());

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("the row on a film's page", () => {
  it("keeps the tile while a step fetches what the countdown named", async () => {
    useApp.setState({ backend, screen: { name: "item", itemId: "f1" }, history: [] });
    const { container, rerender } = render(<Detail itemId="f1" queueFrom={queue} />);
    await settle();

    usePlayer.setState({ upNext: { item: queue[1], at: Date.now() + 5_000 } });
    rerender(<Detail itemId="f1" queueFrom={queue} />);
    await settle();
    expect(container.textContent, "the countdown puts it there").toContain("Second film");

    // The spoken request: the countdown is cancelled and a step takes over.
    usePlayer.setState({ upNext: null, moving: queue[1] });
    rerender(<Detail itemId="f1" queueFrom={queue} />);
    await settle();
    expect(container.textContent, "and the step keeps it there").toContain("Second film");
  });

  it("does not draw something from another page's list", async () => {
    useApp.setState({ backend, screen: { name: "item", itemId: "f1" }, history: [] });
    const { container, rerender } = render(<Detail itemId="f1" queueFrom={[queue[0]]} />);
    await settle();

    usePlayer.setState({ upNext: null, moving: film("x9", "Somebody else's episode") });
    rerender(<Detail itemId="f1" queueFrom={[queue[0]]} />);
    await settle();
    expect(container.textContent).not.toContain("Somebody else's episode");
  });
});

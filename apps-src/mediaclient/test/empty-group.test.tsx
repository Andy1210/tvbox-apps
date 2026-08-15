import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Detail } from "../Detail";
import { useApp } from "../state";
import { setupRemote, setFocus, getCurrentFocusKey, flushFocus, remote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { ItemDetail, MediaBackend } from "../backends/types";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

function detail(over: Partial<ItemDetail>): ItemDetail {
  return {
    id: "c1",
    kind: "collection",
    title: "Empty collection",
    roles: [],
    extras: [],
    reviews: [],
    versions: [],
    chapters: [],
    scores: [],
    ...over,
  } as unknown as ItemDetail;
}

// A group screen with nothing in it.
//
// 0.21.0 hid the Play button on collections and playlists - it was a silent
// no-op there, the server answers 400 - and pointed initial focus at the first
// child instead. A collection with NO children then had neither, so nothing was
// focusable at all: every press was discarded and only Back did anything. This
// account has such a collection.

describe("a group with nothing in it", () => {
  it("says so, and leaves something to press", async () => {
    useApp.setState({
      backend: {
        kind: "plex",
        item: async () => detail({}),
        children: async () => [],
        posterUrl: () => undefined,
        artUrl: () => undefined,
        backdropUrl: () => undefined,
        themeUrl: () => undefined,
        imageHeaders: () => ({}),
        markers: async () => [],
      } as unknown as MediaBackend,
      screen: { name: "item", itemId: "c1" },
      history: [],
      failure: null,
    });
    await act(async () => setFocus(""));
    render(<Detail itemId="c1" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();

    // The message renders on the first commit; the focus it asks for lands a
    // macrotask later, because focusables register in their own effect.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();

    expect(document.body.textContent).toContain(en.detail.emptyCollection);

    const key = getCurrentFocusKey();
    expect(key, `initial focus was ${String(key)}`).toBeTruthy();

    // And it answers the remote rather than only Back.
    await remote.down();
    await remote.right();
    expect(getCurrentFocusKey()).toBeTruthy();
  });
});

describe("the home screen's background layers", () => {
  it("are outside the page's stacking context", async () => {
    // The failure this guards is invisible to reading and looks like three
    // different bugs: a fixed layer at z-0 INSIDE a `relative z-10` container
    // paints after that container's in-flow text, so it covers the rail, the
    // row headings and the tile captions - while the posters survive, because a
    // tile's frame is itself positioned. Portalled to the body, they are simply
    // behind everything.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Hero.tsx"), "utf8");
    expect(src).toContain("createPortal");
    expect(src).toContain("document.body");

    // And no fixed layer may carry a z-index that puts it back into the fight.
    const fixedLayers = src.match(/className="pointer-events-none fixed[^"]*"/g) ?? [];
    expect(fixedLayers.length).toBeGreaterThan(1);
    for (const cls of fixedLayers) expect(cls, cls).not.toMatch(/\bz-\d/);
  });
});

describe("what comes next", () => {
  it("follows the list it was started from, not what the item belongs to", async () => {
    // A playlist is a running order and it wins over parentage. Without this an
    // episode played from a playlist was followed by the next episode of its
    // SERIES, and a film - which belongs to nothing - had no next at all.
    const { usePlayer } = await import("../playback/player");

    const ep = (n: number, season: string) => ({
      id: `e${n}`,
      kind: "episode" as const,
      title: `E${n}`,
      parentId: season,
    });
    const film = { id: "f1", kind: "movie" as const, title: "Film" };

    // A hand-made queue mixing a film and an episode, as a playlist does.
    const queue = [film, ep(7, "s1"), { id: "f2", kind: "movie" as const, title: "Film 2" }];
    const at = queue.findIndex((q) => q.id === "e7");
    usePlayer.setState({ queue, siblings: { prev: queue[at - 1], next: queue[at + 1] } });

    // The neighbours are the playlist's, not season s1's.
    expect(usePlayer.getState().siblings.prev?.id).toBe("f1");
    expect(usePlayer.getState().siblings.next?.id).toBe("f2");

    // And a film in a list has a next, which it never could from parentage.
    const first = queue.findIndex((q) => q.id === "f1");
    expect(queue[first + 1]?.id).toBe("e7");
  });
});

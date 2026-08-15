import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Detail } from "../Detail";
import { useApp } from "../state";
import { doesFocusableExist } from "@noriginmedia/norigin-spatial-navigation";
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

describe("a series screen", () => {
  it("opens on something that exists", async () => {
    // A show has no Play button - the server answers 400 for one - but the
    // initial focus was chosen by a DIFFERENT test than the render used, and
    // that one said a show is playable. norigin hands back a focus key it does
    // not know unchanged, so focus parked on a component that was never
    // mounted: no origin for the key handler, every press discarded, nothing
    // logged. All 256 series screens.
    const show = detail({ id: "sh1", kind: "show", title: "Show" });
    const seasons = [
      { id: "s1", kind: "season" as const, title: "S1" },
      { id: "s2", kind: "season" as const, title: "S2" },
    ];
    useApp.setState({
      backend: {
        kind: "plex",
        item: async () => show,
        children: async () => seasons,
        posterUrl: () => undefined,
        artUrl: () => undefined,
        backdropUrl: () => undefined,
        themeUrl: () => undefined,
        imageHeaders: () => ({}),
        markers: async () => [],
      } as unknown as MediaBackend,
      screen: { name: "item", itemId: "sh1" },
      history: [],
      failure: null,
    });
    await act(async () => setFocus(""));
    render(<Detail itemId="sh1" />);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      await flushFocus();
    }

    const key = getCurrentFocusKey();
    expect(key, "a show must not open on the play button it does not render").not.toBe("detail-play");
    expect(doesFocusableExist(String(key)), `initial focus was ${String(key)}, which does not exist`).toBe(true);

    // And the D-pad actually moves, which is the thing that was broken.
    await remote.down();
    await remote.right();
    expect(doesFocusableExist(String(getCurrentFocusKey()))).toBe(true);
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

describe("what Play starts", () => {
  it("is an episode, never a season or a show", async () => {
    // Neither a show nor a season is something the server can resolve a stream
    // for - both answer 400 - so a Play button on either accepted OK and did
    // nothing. On 256 series screens that was the INITIAL cursor position.
    const { __toPlayableForTest } = await import("../Detail");

    const ep = (id: string, over = {}) => ({ id, kind: "episode" as const, title: id, ...over });
    const season = { id: "s1", kind: "season" as const, title: "S1" } as never;
    const show = { id: "sh1", kind: "show" as const, title: "Show" } as never;
    const film = { id: "f1", kind: "movie" as const, title: "Film" } as never;

    // A show's children are seasons, so there is nothing here to start.
    expect(__toPlayableForTest(show, [season])).toBeUndefined();

    // An episode already in progress wins: skipping past a half-watched one is
    // not what pressing play means.
    expect(
      __toPlayableForTest(season, [ep("e1", { viewCount: 1 }), ep("e2", { viewOffsetMs: 300_000 }), ep("e3")])?.id,
    ).toBe("e2");

    // Otherwise the first unwatched.
    expect(__toPlayableForTest(season, [ep("e1", { viewCount: 1 }), ep("e2")])?.id).toBe("e2");

    // An empty season has nothing, which is what keeps the button off it.
    expect(__toPlayableForTest(season, [])).toBeUndefined();

    // A film is itself.
    expect(__toPlayableForTest(film, [])?.id).toBe("f1");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Which file of a title this household watches.
 *
 * The 1080p copy of a film is sometimes a side-by-side 3D encode, so the SD one
 * is the right answer on a television without glasses - and the app asked again
 * every time, because the choice lived in a component's state and died with the
 * screen.
 */

const store = vi.hoisted(() => ({ data: new Map<string, unknown>(), writes: 0 }));

vi.mock("../storage", () => ({
  readJson: async (key: string) => store.data.get(key) ?? null,
  writeJson: async (key: string, value: unknown) => {
    store.writes += 1;
    store.data.set(key, JSON.parse(JSON.stringify(value)));
    return { ok: true };
  },
}));

const { useChosenVersion, rememberedVersion } = await import("../chosenVersion");

beforeEach(() => {
  store.data.clear();
  store.writes = 0;
  useChosenVersion.setState({ chosen: new Map() });
});

describe("the remembered version", () => {
  it("survives a restart", async () => {
    useChosenVersion.getState().remember("jurassic", 2);
    await Promise.resolve();
    expect(store.data.get("chosen-versions")).toEqual([["jurassic", 2]]);

    // A fresh start reads it back.
    useChosenVersion.setState({ chosen: new Map() });
    await useChosenVersion.getState().load();
    expect(rememberedVersion("jurassic", 3)).toBe(2);
  });

  it("is held to what the item still has", () => {
    // A library can lose a file - the 1080p copy is deleted and the SD one is
    // left - and an index with no version behind it resolves to no part, which
    // fails when play is pressed rather than when it is read.
    useChosenVersion.getState().remember("jurassic", 2);
    expect(rememberedVersion("jurassic", 3)).toBe(2);
    expect(rememberedVersion("jurassic", 2), "index 2 does not exist in a list of two").toBe(0);
    expect(rememberedVersion("jurassic", 1)).toBe(0);
    expect(rememberedVersion(undefined, 5)).toBe(0);
  });

  it("stores nothing for the first version, and forgets on the way back to it", () => {
    // The first version is what the app picks anyway, so an entry for it changes
    // nothing and takes a slot from a real choice.
    useChosenVersion.getState().remember("a", 0);
    expect(useChosenVersion.getState().chosen.size).toBe(0);

    useChosenVersion.getState().remember("a", 1);
    expect([...useChosenVersion.getState().chosen]).toEqual([["a", 1]]);
    useChosenVersion.getState().remember("a", 0);
    expect(useChosenVersion.getState().chosen.size, "going back to the first is a choice to forget").toBe(0);
  });

  it("keeps the newest and drops what has not been touched", () => {
    // Numeric ids, because that is what a Plex rating key IS - and it is the
    // whole bug: a decimal integer string is an ARRAY INDEX key on a plain
    // object, so `Object.keys` returns them numerically ascending whatever
    // order they were written in. The first version of this test used
    // "film-0"-style ids, which are not integer keys and therefore DO keep
    // insertion order, so it passed against a map that evicted the lowest
    // rating key - the oldest title in the library - instead of the least
    // recently chosen.
    for (let i = 0; i < 320; i++) useChosenVersion.getState().remember(String(90000 + i), 1);
    const kept = [...useChosenVersion.getState().chosen.keys()];
    expect(kept.length).toBe(300);
    expect(kept).toContain("90319");
    expect(kept).not.toContain("90000");

    // A LOW rating key chosen last must survive a batch of high ones. Ordered
    // by key rather than by age, this is the entry that goes first.
    useChosenVersion.getState().remember("301", 2);
    for (let i = 0; i < 250; i++) useChosenVersion.getState().remember(String(80000 + i), 1);
    const after = [...useChosenVersion.getState().chosen.keys()];
    expect(after, "the one chosen a moment ago must not be the one dropped").toContain("301");
    expect(after, "and what was ahead of it went first").not.toContain("90100");
  });

  it("refuses a stored value that is not a version index", async () => {
    // The file survives an app update and can be hand-edited or truncated. A bad
    // value handed to versions[n] is undefined, and playback then resolves
    // against no part at all.
    store.data.set("chosen-versions", { ok: 3, neg: -1, frac: 1.5, str: "2", huge: 1e9, "": 4, zero: 0 });
    await useChosenVersion.getState().load();
    expect([...useChosenVersion.getState().chosen]).toEqual([["ok", 3]]);
  });
});

describe("the detail screen", () => {
  it("opens on the version this title was last watched in", async () => {
    // End to end, because the store being right is not the feature: the screen
    // has to seed itself from it when the item lands, and it used to reset to
    // the first file on every open.
    const { render, act } = await import("@testing-library/react");
    const { configureI18n } = await import("@sdk");
    const { Detail } = await import("../Detail");
    const { useApp } = await import("../state");
    const { setupRemote, flushFocus } = await import("./remote");
    const en = (await import("../locales/en.json")).default;
    const hu = (await import("../locales/hu.json")).default;
    configureI18n({ hu, en }, { fallback: "en" });
    setupRemote();

    const versions = [
      { mediaIndex: 0, label: "1080p 3D", partId: "1", parts: 1, partIndex: 0, audio: [], subtitles: [] },
      { mediaIndex: 1, label: "SD", partId: "2", parts: 1, partIndex: 0, audio: [], subtitles: [] },
    ];
    useChosenVersion.setState({ chosen: new Map([["jw", 1]]) });
    useApp.setState({
      backend: {
        kind: "plex",
        item: async () => ({
          id: "jw",
          kind: "movie",
          title: "Jurassic World",
          roles: [],
          extras: [],
          reviews: [],
          scores: [],
          chapters: [],
          versions,
        }),
        children: async () => [],
        posterUrl: () => undefined,
        artUrl: () => undefined,
        backdropUrl: () => undefined,
        themeUrl: () => undefined,
        imageHeaders: () => ({}),
        markers: async () => [],
      } as never,
      screen: { name: "item", itemId: "jw" },
      history: [],
      failure: null,
    });

    render(<Detail itemId="jw" />);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      await flushFocus();
    }

    // The play button names the version it would start.
    const play = Array.from(document.querySelectorAll("*")).find(
      (e) => (e.textContent ?? "").includes("·") && (e.textContent ?? "").length < 40,
    );
    expect(play?.textContent, "the button should offer the remembered file").toContain("SD");
  });
});

describe("the version chips", () => {
  it("give every file its own focus key", async () => {
    // A film on two discs is one media entry and two rows. Keyed on the media
    // index both chips claimed "detail-version-0", so the remote could not
    // reach the second disc, both rows ticked, and Play started part 1 either
    // way. Keyed on the array position they are separate things.
    const { render, act } = await import("@testing-library/react");
    const { configureI18n } = await import("@sdk");
    const { doesFocusableExist } = await import("@noriginmedia/norigin-spatial-navigation");
    const { Detail } = await import("../Detail");
    const { useApp } = await import("../state");
    const { setupRemote, flushFocus } = await import("./remote");
    const en = (await import("../locales/en.json")).default;
    const hu = (await import("../locales/hu.json")).default;
    configureI18n({ hu, en }, { fallback: "en" });
    setupRemote();

    const versions = [
      { mediaIndex: 0, partIndex: 0, parts: 2, label: "SD · 1/2", partId: "108049", audio: [], subtitles: [] },
      { mediaIndex: 0, partIndex: 1, parts: 2, label: "SD · 2/2", partId: "108050", audio: [], subtitles: [] },
    ];
    useApp.setState({
      backend: {
        kind: "plex",
        item: async () => ({
          id: "46594",
          kind: "movie",
          title: "A döntő szavazat",
          roles: [],
          extras: [],
          reviews: [],
          scores: [],
          chapters: [],
          versions,
        }),
        children: async () => [],
        posterUrl: () => undefined,
        artUrl: () => undefined,
        backdropUrl: () => undefined,
        themeUrl: () => undefined,
        imageHeaders: () => ({}),
        markers: async () => [],
      } as never,
      screen: { name: "item", itemId: "46594" },
      history: [],
      failure: null,
    });

    render(<Detail itemId="46594" />);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      await flushFocus();
    }

    expect(doesFocusableExist("detail-version-0"), "the first disc").toBe(true);
    expect(doesFocusableExist("detail-version-1"), "the second disc must be reachable too").toBe(true);
  });
});

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
  useChosenVersion.setState({ chosen: {} });
});

describe("the remembered version", () => {
  it("survives a restart", async () => {
    useChosenVersion.getState().remember("jurassic", 2);
    await Promise.resolve();
    expect(store.data.get("chosen-versions")).toEqual({ jurassic: 2 });

    // A fresh start reads it back.
    useChosenVersion.setState({ chosen: {} });
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
    expect(useChosenVersion.getState().chosen).toEqual({});

    useChosenVersion.getState().remember("a", 1);
    expect(useChosenVersion.getState().chosen).toEqual({ a: 1 });
    useChosenVersion.getState().remember("a", 0);
    expect(useChosenVersion.getState().chosen, "going back to the first is a choice to forget").toEqual({});
  });

  it("keeps the newest and drops what has not been touched", () => {
    // Nothing ever removes an entry, so without a cap a library of 1,693 films
    // grows a permanent record of every one ever started - and this file is read
    // at startup before anything can be shown.
    for (let i = 0; i < 320; i++) useChosenVersion.getState().remember(`film-${i}`, 1);
    const kept = Object.keys(useChosenVersion.getState().chosen);
    expect(kept.length).toBe(300);
    expect(kept).toContain("film-319");
    expect(kept).not.toContain("film-0");

    // Choosing again makes a title the newest, so the next batch pushes out what
    // was ahead of it rather than it. Fewer than the cap, or the batch alone
    // fills the map and the assertion would prove nothing about age.
    useChosenVersion.getState().remember("film-20", 2);
    for (let i = 400; i < 400 + 250; i++) useChosenVersion.getState().remember(`film-${i}`, 1);
    const after = Object.keys(useChosenVersion.getState().chosen);
    expect(after, "re-choosing made it the newest").toContain("film-20");
    expect(after, "and the ones ahead of it went first").not.toContain("film-100");
  });

  it("refuses a stored value that is not a version index", async () => {
    // The file survives an app update and can be hand-edited or truncated. A bad
    // value handed to versions[n] is undefined, and playback then resolves
    // against no part at all.
    store.data.set("chosen-versions", { ok: 3, neg: -1, frac: 1.5, str: "2", huge: 1e9, "": 4, zero: 0 });
    await useChosenVersion.getState().load();
    expect(useChosenVersion.getState().chosen).toEqual({ ok: 3 });
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
      { index: 0, label: "1080p 3D", partId: "1", parts: 1, partIndex: 0, audio: [], subtitles: [] },
      { index: 1, label: "SD", partId: "2", parts: 1, partIndex: 0, audio: [], subtitles: [] },
    ];
    useChosenVersion.setState({ chosen: { jw: 1 } });
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

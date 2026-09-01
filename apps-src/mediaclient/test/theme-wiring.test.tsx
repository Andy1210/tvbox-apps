import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ItemDetail, MediaItem } from "../backends/types";

/**
 * What the detail screen TELLS the theme player, as opposed to what the player
 * does with it.
 *
 * The rule has three answers and the middle one is easy to lose: a screen that
 * is still loading must not stop the theme (a season switch is a remount, and
 * the arriving screen does not know its item for a round trip), while a screen
 * that FAILED must, or the sting plays on under "something went wrong" for as
 * long as it is up. Both states have the same empty item, so only the screen
 * can tell them apart - which makes this a wiring test, not a unit one.
 */

const told: (MediaItem | null | undefined)[] = [];
vi.mock("../theme", async (importOriginal) => {
  const real = await importOriginal<typeof import("../theme")>();
  return {
    ...real,
    useTheme: (item: MediaItem | null | undefined) => {
      told.push(item);
    },
  };
});

const { setupRemote, flushFocus } = await import("./remote");
setupRemote();

function detailOf(item: MediaItem): ItemDetail {
  return { ...item, roles: [], extras: [], reviews: [], scores: [], chapters: [], versions: [] } as ItemDetail;
}

let n = 0;

async function open(opts: { childrenFail?: boolean } = {}): Promise<void> {
  const { render: draw, act: run } = await import("@testing-library/react");
  const { configureI18n } = await import("@sdk");
  const { Detail } = await import("../Detail");
  const { useApp } = await import("../state");
  const en = (await import("../locales/en.json")).default;
  const hu = (await import("../locales/hu.json")).default;
  configureI18n({ hu, en }, { fallback: "en" });

  n += 1;
  const season: MediaItem = { id: `w-season${n}`, kind: "season", title: "2. évad", index: 2, parentId: `w-show${n}` };
  useApp.setState({
    backend: {
      kind: "plex",
      item: async () => detailOf(season),
      children: async (id: string) => {
        if (id === season.id && opts.childrenFail) throw new Error("no episodes");
        return [];
      },
      setWatched: async () => {},
      posterUrl: () => undefined,
      artUrl: () => undefined,
      backdropUrl: () => undefined,
      themeUrl: () => "http://server/theme",
      imageHeaders: () => ({}),
      markers: async () => [],
    } as never,
    screen: { name: "item", itemId: season.id },
    history: [],
    failure: null,
  });
  draw(<Detail itemId={season.id} />);
  for (let i = 0; i < 5; i += 1) {
    await run(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

beforeEach(() => {
  told.length = 0;
  vi.restoreAllMocks();
});

describe("the theme a detail screen asks for", () => {
  it("says nothing at all while the item is on its way, then names it", async () => {
    await open();
    expect(told[0], "not known yet, so the theme carries over from the last screen").toBeUndefined();
    expect(told[told.length - 1], "the season, once it is known").toMatchObject({ kind: "season" });
  });

  it("says nothing to play when the screen has failed, item or no item", async () => {
    const { useApp } = await import("../state");
    // The episodes are fetched under the same catch as the item, so this screen
    // fails with its season already in hand - the case a check on the item
    // alone gets wrong.
    await open({ childrenFail: true });
    expect(useApp.getState().failure, "the failure screen is up").toBeTruthy();
    expect(told[told.length - 1]).toBeNull();
  });
});

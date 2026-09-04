import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

/**
 * Which episode's track list a chosen language is resolved against.
 *
 * The choice is remembered as a LANGUAGE, deliberately, so that it carries from
 * one episode to the next - but it has to become an ordinal before playback,
 * and an ordinal only means anything inside one item's own list. The screen
 * resolved it against the episode it was DESCRIBING, which on a season is
 * wherever the cursor is, while Play starts the episode in progress.
 *
 * Measured over this library's 566 seasons by the rule the code actually
 * applies - `pick` takes the FIRST track of the language - 67 of them resolve
 * some language to a different ordinal between two episodes. So choosing the
 * Hungarian subtitle and pressing Play started the English one, silently.
 *
 * The fixture is shaped so that only a true read of the STARTED episode gives
 * the right answer: the first child and the highlighted episode list their
 * languages in the same order as each other, and the started episode lists them
 * the other way round. Reading from either of the two wrong sources yields 0
 * where 1 is right.
 */

import type { ItemDetail, MediaItem, MediaVersion, Track } from "../backends/types";

const { setupRemote, flushFocus, setFocus } = await import("./remote");
setupRemote();

let n = 0;

const sub = (ordinal: number, language: string, forced = false): Track => ({
  ordinal,
  id: `s${ordinal}-${language}`,
  kind: "subtitle",
  language,
  label: forced ? `${language} forced` : language,
  forced,
});
const aud = (ordinal: number, language: string): Track => ({
  ordinal,
  id: `a${ordinal}-${language}`,
  kind: "audio",
  language,
  label: language,
});

function version(audio: Track[], subtitles: Track[]): MediaVersion {
  return { mediaIndex: 0, partIndex: 0, parts: 1, label: "1080p", audio, subtitles };
}

/** magyar first, then English - what the first child and the cursor's episode carry. */
const MAGYAR_FIRST = (): MediaVersion =>
  version([aud(0, "magyar"), aud(1, "English")], [sub(0, "magyar"), sub(1, "English")]);
/** The other way round - what the STARTED episode carries. */
const ENGLISH_FIRST = (): MediaVersion =>
  version([aud(0, "English"), aud(1, "magyar")], [sub(0, "English"), sub(1, "magyar")]);

interface Harness {
  season: MediaItem;
  /** ep1 is `children[0]`, ep2 is the one in progress, ep3 is where the cursor goes. */
  episodes: MediaItem[];
  /** Every `play` this screen asked for, in order. */
  played: { id: string; audio?: number; subtitle?: number | "none" }[];
  /** Every item id this screen fetched, in order. */
  asked: string[];
}

interface Options {
  /** Nothing in progress, so Play starts `children[0]` - the shape the prefetch stands down on. */
  noProgress?: boolean;
  /** The started episode's own read never answers. */
  holdTarget?: boolean;
  /** The FIRST read of `children[0]` rejects; a second one succeeds. */
  failFirstChild?: boolean;
  /** The started episode carries its magyar subtitle as a sidecar, numbered -1. */
  external?: boolean;
  /**
   * Every episode carries TWO magyar subtitles - signs-only first, then the
   * whole thing - which is the shape 56 of this library's episodes have and the
   * one a bare language cannot tell apart.
   */
  forcedPair?: boolean;
}

async function open(opts?: Options): Promise<Harness> {
  const { render, act } = await import("@testing-library/react");
  const { configureI18n } = await import("@sdk");
  const { Detail } = await import("../Detail");
  const { useApp } = await import("../state");
  const { usePlayer } = await import("../playback/player");
  const en = (await import("../locales/en.json")).default;
  const hu = (await import("../locales/hu.json")).default;
  configureI18n({ hu, en }, { fallback: "en" });

  n += 1;
  const season: MediaItem = { id: `season${n}`, kind: "season", title: "1. évad", index: 1, parentId: `show${n}` };
  const ep = (i: number, extra: Partial<MediaItem> = {}): MediaItem => ({
    id: `ep${i}-${n}`,
    kind: "episode",
    title: `${i}. rész`,
    index: i,
    parentIndex: 1,
    parentId: season.id,
    durationMs: 1_800_000,
    ...extra,
  });
  const episodes: MediaItem[] = [
    ep(1),
    // In progress, so Play starts THIS one - and it is not `children[0]`, so
    // the prefetch really runs. `noProgress` takes that away, which is the
    // other shape: then Play starts the first child and the prefetch stands
    // down in favour of the read already going out for it.
    ep(2, opts?.noProgress ? {} : { viewOffsetMs: 600_000 }),
    ep(3),
  ];

  const target = episodes[opts?.noProgress ? 0 : 1]!;
  const versions: Record<string, MediaVersion> = {
    [episodes[0]!.id]: MAGYAR_FIRST(),
    [episodes[1]!.id]: ENGLISH_FIRST(),
    [episodes[2]!.id]: MAGYAR_FIRST(),
  };
  // Whichever episode starts is the one that disagrees with the other two.
  if (opts?.noProgress) versions[episodes[0]!.id] = ENGLISH_FIRST();
  if (opts?.forcedPair)
    for (const e of episodes)
      versions[e.id] = version(versions[e.id]!.audio, [
        sub(0, "magyar", true),
        sub(1, "magyar"),
        sub(2, "English"),
      ]);
  if (opts?.external) {
    const v = versions[target.id]!;
    versions[target.id] = version(v.audio, [sub(0, "English"), sub(-1, "magyar")]);
  }

  const detailOf = (item: MediaItem): ItemDetail =>
    ({
      ...item,
      roles: [],
      extras: [],
      reviews: [],
      scores: [],
      chapters: [],
      versions: versions[item.id] ? [versions[item.id]!] : [],
    }) as ItemDetail;

  const byId = new Map<string, MediaItem>([[season.id, season], ...episodes.map((e) => [e.id, e] as const)]);
  const h: Harness = { season, episodes, played: [], asked: [] };
  let firstChildReads = 0;

  useApp.setState({
    backend: {
      kind: "plex",
      item: async (id: string) => {
        h.asked.push(id);
        if (opts?.holdTarget && id === target.id) await new Promise(() => {});
        if (opts?.failFirstChild && id === episodes[0]!.id) {
          firstChildReads += 1;
          if (firstChildReads === 1) throw new Error("no");
        }
        return detailOf(byId.get(id) ?? season);
      },
      children: async (id: string) => (id === season.id ? episodes : []),
      setWatched: async () => {},
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

  // The store's own action, replaced: what this screen HANDS to playback is the
  // whole question, and resolving a real stream would answer a different one.
  usePlayer.setState({
    play: async (_backend: unknown, item: MediaItem, o?: { audio?: number; subtitle?: number | "none" }) => {
      h.played.push({ id: item.id, audio: o?.audio, subtitle: o?.subtitle });
    },
  } as never);

  render(<Detail itemId={season.id} />);
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
  return h;
}

const el = (key: string): HTMLElement | null => document.querySelector(`[data-sfocus="${key}"]`);
/** The language panel's own heading, which is the only truncating h2 on screen. */
const heading = (): string => document.querySelector("h2.truncate")?.textContent ?? "";

async function press(key: string): Promise<void> {
  const { act } = await import("@testing-library/react");
  const btn = el(key);
  expect(btn, `the ${key} button`).toBeTruthy();
  await act(async () => {
    btn!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushFocus();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushFocus();
}

async function focusOn(key: string): Promise<void> {
  const { act } = await import("@testing-library/react");
  await setFocus(key);
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

/** Put the cursor on an episode that is NOT the one Play starts. */
async function cursorOnOther(h: Harness): Promise<void> {
  await focusOn(`children-${h.season.id}-${h.episodes[2]!.id}`);
}

/** Choose a subtitle through the panel, the way somebody would. */
async function chooseSubtitle(id: string): Promise<void> {
  await press("detail-more");
  await press("more-lang");
  await press(`lp-sub-${id}`);
  await press("lp-close");
}

/**
 * The store's `play` is module state and outlives this file.
 *
 * Vitest isolates by file today, so replacing it is contained - but with
 * isolation off it reaches other files: measured, `queue.test.ts` calls the real
 * `play` and gets the stub. Restoring costs nothing and removes the dependency
 * on a config setting.
 */
let realPlay: unknown;
beforeEach(async () => {
  vi.restoreAllMocks();
  const { usePlayer } = await import("../playback/player");
  realPlay ??= usePlayer.getState().play;
});
afterEach(async () => {
  const { usePlayer } = await import("../playback/player");
  usePlayer.setState({ play: realPlay } as never);
});

describe("a language chosen on a season screen", () => {
  it("is resolved against the episode Play starts, not the one under the cursor", async () => {
    const h = await open();
    await cursorOnOther(h);
    // The cursor's episode lists magyar at 0; the started one lists it at 1.
    await chooseSubtitle("s0-magyar");

    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[1]!.id, audio: undefined, subtitle: 1 }]);
  });

  it("does the same for the button that starts from the beginning", async () => {
    const h = await open();
    await cursorOnOther(h);
    await chooseSubtitle("s0-magyar");

    await focusOn("detail-restart");
    await press("detail-restart");
    expect(h.played).toEqual([{ id: h.episodes[1]!.id, audio: undefined, subtitle: 1 }]);
  });

  it("resolves an audio language the same way", async () => {
    // `pick` resolves the two independently; only one of them used to be tested.
    const h = await open();
    await cursorOnOther(h);
    await press("detail-more");
    await press("more-lang");
    await press("lp-aud-0");
    await press("lp-close");

    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[1]!.id, audio: 1, subtitle: undefined }]);
  });

  it("passes nothing when no language has been chosen", async () => {
    // The common case, and it must stay untouched: with no choice the file's
    // own default is what plays, not an ordinal this screen invented.
    const h = await open();
    await cursorOnOther(h);
    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[1]!.id, audio: undefined, subtitle: undefined }]);
  });

  it("carries an external subtitle by the started episode's own numbering", async () => {
    // A sidecar's ordinal is negative and per item, so -1 on one episode is a
    // different file from -1 on another. Resolving the LANGUAGE against the
    // started episode is what gets its own file rather than a borrowed number.
    const h = await open({ external: true });
    await cursorOnOther(h);
    await chooseSubtitle("s0-magyar");
    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[1]!.id, audio: undefined, subtitle: -1 }]);
  });
});

describe("when the started episode's tracks are not known", () => {
  it("passes no ordinal rather than one read off another episode", async () => {
    // The read is one round trip wide, and the row can move under it - a mark,
    // or a resume point landing, changes which episode Play starts. Handing
    // over the highlighted episode's ordinal is the whole bug; losing the
    // choice is the harmless direction.
    const h = await open({ holdTarget: true });
    await cursorOnOther(h);
    await chooseSubtitle("s0-magyar");
    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[1]!.id, audio: undefined, subtitle: undefined }]);
  });
});

describe("a season nobody has started, where Play begins at the first episode", () => {
  it("reads that episode once rather than twice", async () => {
    // It is already being fetched for the panel, and the cache has no in-flight
    // deduplication - so asking again is a second request for the same document
    // rather than a cache hit.
    const h = await open({ noProgress: true });
    expect(h.asked.filter((id) => id === h.episodes[0]!.id)).toHaveLength(1);
  });

  it("still resolves the choice against it", async () => {
    const h = await open({ noProgress: true });
    await cursorOnOther(h);
    await chooseSubtitle("s0-magyar");
    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[0]!.id, audio: undefined, subtitle: 1 }]);
  });

  it("asks again when that one read fails, instead of dropping the choice", async () => {
    // Standing down in favour of another request makes that request the only
    // source; if it fails there is nothing else coming, and the choice would be
    // lost for as long as the screen is up.
    const h = await open({ noProgress: true, failFirstChild: true });
    await cursorOnOther(h);
    await chooseSubtitle("s0-magyar");
    await focusOn("detail-play");
    await press("detail-play");
    expect(h.asked.filter((id) => id === h.episodes[0]!.id).length).toBeGreaterThan(1);
    expect(h.played).toEqual([{ id: h.episodes[0]!.id, audio: undefined, subtitle: 1 }]);
  });
});

describe("the panel says which episode it is listing", () => {
  it("names the highlighted episode when there is one", async () => {
    const h = await open();
    await cursorOnOther(h);
    await press("detail-more");
    await press("more-lang");
    expect(heading()).toContain("S1E3");
    expect(el("lp-sub-s0-magyar"), "and lists that episode's own tracks").toBeTruthy();
  });

  it("names the FIRST episode when nothing is highlighted, which is whose list it shows", async () => {
    // The commonest way in - arrive, overflow, languages, never entering the
    // row. The label used to ask the season, which has no designation, while
    // the list had already fallen back to the first episode: on a real season
    // that offered seven languages against the two the started episode had,
    // with nothing to say whose they were.
    await open();
    await press("detail-more");
    await press("more-lang");
    expect(heading()).toContain("S1E1");
  });
});

describe("two subtitles in one language", () => {
  /** Which row the panel has ticked, by its focus key. */
  const ticked = (): string | undefined =>
    [...document.querySelectorAll('[data-sfocus^="lp-sub-"]')].find((e) => (e.textContent ?? "").includes("✓"))
      ?.getAttribute("data-sfocus") ?? undefined;

  it("takes the one that was pressed, and shows it as taken", async () => {
    // Reported from the sofa: the tick refused to move and signs-only played.
    // The choice was kept as a bare LANGUAGE, and matching a language returns
    // the FIRST track carrying it - which here is the signs-only one.
    const h = await open({ forcedPair: true });
    await cursorOnOther(h);
    await press("detail-more");
    await press("more-lang");
    await press("lp-sub-s1-magyar");
    expect(ticked(), "the panel says which one is on").toBe("lp-sub-s1-magyar");
    await press("lp-close");

    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played, "and the whole subtitle plays, not the signs-only one").toEqual([
      { id: h.episodes[1]!.id, audio: undefined, subtitle: 1 },
    ]);
  });

  it("still takes signs-only when signs-only is what was pressed", async () => {
    const h = await open({ forcedPair: true });
    await cursorOnOther(h);
    await press("detail-more");
    await press("more-lang");
    await press("lp-sub-s0-magyar");
    expect(ticked()).toBe("lp-sub-s0-magyar");
    await press("lp-close");

    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[1]!.id, audio: undefined, subtitle: 0 }]);
  });
});

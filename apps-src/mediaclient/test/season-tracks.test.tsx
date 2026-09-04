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
 * Measured on this library: one language sits at different ordinals across the
 * episodes of 210 of 566 seasons, subtitles mostly. So choosing the Hungarian
 * subtitle and pressing Play started the English one, silently.
 */

import type { ItemDetail, MediaItem, MediaVersion, Track } from "../backends/types";

const { setupRemote, flushFocus, setFocus } = await import("./remote");
setupRemote();

let n = 0;

const sub = (ordinal: number, language: string): Track => ({
  ordinal,
  id: `s${ordinal}-${language}`,
  kind: "subtitle",
  language,
  label: language,
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

interface Harness {
  season: MediaItem;
  episodes: MediaItem[];
  /** Every `play` this screen asked for, in order. */
  played: { id: string; audio?: number; subtitle?: number | "none" }[];
}

/**
 * A season whose two episodes carry the same two subtitle languages in the
 * OPPOSITE order, which is the shape the server really produces.
 *
 * Episode 1 is half watched, so it is what Play starts; episode 2 is the one
 * the cursor will be on. Their orders disagree, so an ordinal read off one and
 * handed to the other names the other language.
 */
async function open(opts?: { holdTarget?: boolean; external?: boolean }): Promise<Harness> {
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
  const episodes: MediaItem[] = [
    {
      id: `ep1-${n}`,
      kind: "episode",
      title: "Első rész",
      index: 1,
      parentIndex: 1,
      parentId: season.id,
      durationMs: 1_800_000,
      // In progress, so this is what Play starts.
      viewOffsetMs: 600_000,
    },
    { id: `ep2-${n}`, kind: "episode", title: "Második rész", index: 2, parentIndex: 1, parentId: season.id },
  ];

  const versions: Record<string, MediaVersion> = {
    // English first here...
    [episodes[0]!.id]: version(
      [aud(0, "English"), aud(1, "magyar")],
      // An external subtitle is numbered NEGATIVELY and per item, so an id or
      // an ordinal from another episode means something else here.
      opts?.external ? [sub(0, "English"), sub(-1, "magyar")] : [sub(0, "English"), sub(1, "magyar")],
    ),
    // ...and Hungarian first here.
    [episodes[1]!.id]: version(
      [aud(0, "magyar"), aud(1, "English")],
      [sub(0, "magyar"), sub(1, "English")],
    ),
  };

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
  const h: Harness = { season, episodes, played: [] };

  useApp.setState({
    backend: {
      kind: "plex",
      item: async (id: string) => {
        // A prefetch that never answers, for the window before it lands.
        if (opts?.holdTarget && id === episodes[0]!.id) await new Promise(() => {});
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
    play: async (_backend: unknown, item: MediaItem, opts?: { audio?: number; subtitle?: number | "none" }) => {
      h.played.push({ id: item.id, audio: opts?.audio, subtitle: opts?.subtitle });
    },
  } as never);

  render(<Detail itemId={season.id} />);
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
  return h;
}

const el = (key: string): HTMLElement | null => document.querySelector(`[data-sfocus="${key}"]`);

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

/** Choose a subtitle language through the panel, the way somebody would. */
async function chooseSubtitle(language: string): Promise<void> {
  await press("detail-more");
  await press("more-lang");
  // The panel lists the tracks of the episode the screen is DESCRIBING, which
  // is the point: the language is picked off the highlighted episode.
  await press(`lp-sub-s${language === "magyar" ? 0 : 1}-${language}`);
  await press("lp-close");
}

/**
 * The store's `play` is module state and outlives this file.
 *
 * Vitest isolates by file today, so replacing it is contained - but measured,
 * with isolation off this was the one file in the suite that broke others
 * (`queue.test.ts` calls the real `play` and got the stub). Restoring it costs
 * nothing and removes the dependency on a config setting.
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
    // The cursor on episode 2, whose subtitles read Hungarian, English.
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    await chooseSubtitle("magyar");

    await focusOn("detail-play");
    await press("detail-play");

    expect(h.played, "Play starts the half-watched episode").toEqual([
      // Hungarian is ordinal 1 on episode 1. Reading it off episode 2 - where
      // Hungarian is 0 - would have started English.
      { id: h.episodes[0]!.id, audio: undefined, subtitle: 1 },
    ]);
  });

  it("does the same for the button that starts from the beginning", async () => {
    // It only exists beside a resume, so it is exactly the button that starts
    // an episode other than the highlighted one.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    await chooseSubtitle("magyar");

    await focusOn("detail-restart");
    await press("detail-restart");
    expect(h.played).toEqual([{ id: h.episodes[0]!.id, audio: undefined, subtitle: 1 }]);
  });

  it("passes nothing when no language has been chosen", async () => {
    // The common case, and it must stay untouched: with no choice the file's
    // own default is what should play, not an ordinal this screen invented.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[0]!.id, audio: undefined, subtitle: undefined }]);
  });

  it("still lists the highlighted episode's own tracks in the panel", async () => {
    // The panel describes the episode the page is about. Listing the tracks of
    // a different one would offer languages for something nobody is looking at.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    await press("detail-more");
    await press("more-lang");
    expect(el("lp-sub-s0-magyar"), "episode 2 has magyar first").toBeTruthy();
    expect(el("lp-sub-s1-English"), "and English second").toBeTruthy();
  });
});

describe("what happens when the started episode's tracks are not known", () => {
  it("passes no ordinal rather than one read off the wrong episode", async () => {
    // The prefetch is one round trip wide, and the row can move under it - a
    // mark, or a resume point landing, changes which episode Play starts. The
    // old fallback handed over the HIGHLIGHTED episode's ordinal, which is the
    // whole bug; losing the choice for a moment is the harmless direction.
    const h = await open({ holdTarget: true });
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    await chooseSubtitle("magyar");

    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[0]!.id, audio: undefined, subtitle: undefined }]);
  });
});

describe("an audio language chosen on a season screen", () => {
  it("is resolved against the episode Play starts", async () => {
    // The same rule as the subtitles, and worth its own case: `pick` resolves
    // the two independently and only one of them was covered.
    const h = await open();
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    await press("detail-more");
    await press("more-lang");
    // Episode 2 lists magyar first; episode 1 lists it second.
    await press("lp-aud-0");
    await press("lp-close");

    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[0]!.id, audio: 1, subtitle: undefined }]);
  });
});

describe("an external subtitle", () => {
  it("is not carried to another episode by its id", async () => {
    // A sidecar is numbered negatively and per item, so `-1` on one episode and
    // `-1` on another are different FILES. The choice is kept by id when the
    // track has no language to key on, and an id only means anything inside the
    // item it came from - so the honest answer on a different episode is none.
    const h = await open({ external: true });
    await focusOn(`children-${h.season.id}-${h.episodes[1]!.id}`);
    // Episode 2's magyar subtitle is an ordinary internal one at ordinal 0;
    // episode 1's is external, at -1. Choosing by LANGUAGE still resolves,
    // because the language is what carries - and it resolves to -1, which is
    // episode 1's own file rather than a number borrowed from episode 2.
    await chooseSubtitle("magyar");
    await focusOn("detail-play");
    await press("detail-play");
    expect(h.played).toEqual([{ id: h.episodes[0]!.id, audio: undefined, subtitle: -1 }]);
  });
});

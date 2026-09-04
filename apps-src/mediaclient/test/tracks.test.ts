import { describe, it, expect } from "vitest";
import { rememberTrack, resolveTrack } from "../tracks";
import type { Track } from "../backends/types";

/**
 * What a track choice has to survive.
 *
 * Two things at once, pulling in opposite directions: it must carry to the NEXT
 * episode, where an ordinal means nothing, and it must be exact within the
 * episode it was made on, where a language means nothing - measured over 1,395
 * episodes of this library, 519 carry two or more subtitles in one language.
 */

const A = "episode-a";
const B = "episode-b";

interface Opts {
  forced?: boolean;
  sdh?: boolean;
  id?: string;
}

const sub = (ordinal: number, language: string | undefined, o: Opts = {}): Track => ({
  ordinal,
  id: o.id ?? `s${ordinal}`,
  kind: "subtitle",
  language,
  label: `${language ?? "?"}${o.forced ? " forced" : ""}${o.sdh ? " SDH" : ""}`,
  forced: o.forced,
  hearingImpaired: o.sdh,
});

/** The shape the report was made on: signs-only first, then the whole thing. */
const FORCED_FIRST = [sub(0, "magyar", { forced: true }), sub(1, "magyar"), sub(2, "English")];
/** The same two, the other way round - what another episode of the season has. */
const FULL_FIRST = [sub(0, "magyar"), sub(1, "magyar", { forced: true }), sub(2, "English")];
/** Two of one language that nothing tells apart, which is the commonest shape. */
const TWO_ALIKE = [sub(0, "magyar"), sub(1, "magyar"), sub(2, "English")];

describe("choosing between two tracks of one language", () => {
  it("keeps the one that was chosen, not the first of its language", () => {
    // The reported bug: the tick refused to move and signs-only played. Matching
    // by language alone always returned ordinal 0.
    expect(resolveTrack(FORCED_FIRST, rememberTrack(FORCED_FIRST, 1, A), A)).toBe(1);
  });

  it("does the same where nothing but position tells them apart", () => {
    // The commonest shape. No flag differs, so position is the only thing the
    // choice can hold on to - and within one item it is exact.
    expect(resolveTrack(TWO_ALIKE, rememberTrack(TWO_ALIKE, 1, A), A)).toBe(1);
  });

  it("still picks signs-only when signs-only is what was asked for", () => {
    expect(resolveTrack(FORCED_FIRST, rememberTrack(FORCED_FIRST, 0, A), A)).toBe(0);
  });
});

describe("subtitles written for a viewer who cannot hear", () => {
  // A third kind, not a variant of forced: a file routinely holds the full
  // track and the SDH one in the same language with the same forced flag.
  const WITH_SDH = [sub(0, "English"), sub(1, "English", { sdh: true })];

  it("is not handed over in place of the full track", () => {
    expect(resolveTrack(WITH_SDH, rememberTrack(WITH_SDH, 0, A), A)).toBe(0);
  });

  it("survives a change of position on the next episode", () => {
    // Measured on this library: the full English track sat at 3 on one episode
    // and SDH sat at 3 on the next. Position alone took the SDH one.
    const choice = rememberTrack([sub(2, "English", { sdh: true }), sub(3, "English")], 3, A);
    const next = [sub(2, "English"), sub(3, "English", { sdh: true })];
    expect(resolveTrack(next, choice, B)).toBe(2);
  });

  it("is kept when it is what was asked for", () => {
    const choice = rememberTrack(WITH_SDH, 1, A);
    expect(resolveTrack([sub(0, "English", { sdh: true }), sub(1, "English")], choice, B)).toBe(0);
  });
});

describe("carrying that choice to another episode", () => {
  it("follows the kind rather than the position when the order differs", () => {
    // The whole subtitle was at 1 and is now at 0; the signs-only one has taken
    // its place. Position alone would hand over signs-only.
    expect(resolveTrack(FULL_FIRST, rememberTrack(FORCED_FIRST, 1, A), B)).toBe(0);
  });

  it("keeps signs-only as signs-only", () => {
    expect(resolveTrack(FULL_FIRST, rememberTrack(FORCED_FIRST, 0, A), B)).toBe(1);
  });

  it("takes the position when the track there is still the same kind", () => {
    // A different episode that happens to list them the same way round.
    const next = [sub(0, "magyar"), sub(1, "magyar"), sub(2, "English")];
    expect(resolveTrack(next, rememberTrack(TWO_ALIKE, 1, A), B)).toBe(1);
  });

  it("gives the signs-only track when it is the only one in that language", () => {
    // Deliberate, and the owner's call: a player would have shown it anyway, and
    // it is nearer to what was asked for than nothing at all.
    const choice = rememberTrack(FORCED_FIRST, 1, A);
    expect(resolveTrack([sub(0, "magyar", { forced: true }), sub(1, "English")], choice, B)).toBe(0);
  });

  it("gives nothing when the language is not there at all", () => {
    // A choice that cannot be honoured is dropped rather than answered with a
    // different language.
    const choice = rememberTrack(FORCED_FIRST, 1, A);
    expect(resolveTrack([sub(0, "English"), sub(1, "Polish")], choice, B)).toBeUndefined();
  });
});

describe("a track with no language", () => {
  const SIDECAR = [sub(-1, undefined, { id: "sidecar-7" }), sub(0, "English")];

  it("is matched by its own id inside the item it came from", () => {
    // Measured on this server, 179 of 207 sidecar subtitles on films carry no
    // language, so without this the choice was dropped on the floor.
    expect(resolveTrack(SIDECAR, rememberTrack(SIDECAR, -1, A), A)).toBe(-1);
  });

  it("does not travel to another item, even when an id there matches", () => {
    // On Jellyfin the id IS the stream's index, so the same string on the next
    // episode is a different track. Nothing else about a track with no language
    // can be carried, so the honest answer there is none.
    const choice = rememberTrack(SIDECAR, -1, A);
    expect(resolveTrack(SIDECAR, choice, B)).toBeUndefined();
  });
});

describe("what cannot be remembered", () => {
  it("is nothing at all, rather than a choice that names no track", () => {
    expect(rememberTrack(FORCED_FIRST, 99, A)).toBeUndefined();
    expect(rememberTrack(undefined, 0, A)).toBeUndefined();
  });

  it("resolves to nothing against a list that is not there", () => {
    expect(resolveTrack(undefined, rememberTrack(FORCED_FIRST, 1, A), A)).toBeUndefined();
    expect(resolveTrack(FORCED_FIRST, undefined, A)).toBeUndefined();
  });
});

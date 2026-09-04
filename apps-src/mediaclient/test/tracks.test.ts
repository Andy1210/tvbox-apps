import { describe, it, expect } from "vitest";
import { rememberTrack, resolveTrack } from "../tracks";
import type { Track } from "../backends/types";

/**
 * What a track choice has to survive.
 *
 * Two things at once, and they pull in opposite directions: the choice must
 * carry to the NEXT episode, where an ordinal means nothing, and it must be
 * exact within the episode it was made on, where a language means nothing -
 * measured over 400 episodes of this library, 367 carry two or more subtitles
 * in one language and only 56 of those are told apart by the forced flag.
 */

const sub = (ordinal: number, language: string | undefined, forced = false, id = ""): Track => ({
  ordinal,
  id: id || `s${ordinal}`,
  kind: "subtitle",
  language,
  label: `${language ?? "?"}${forced ? " forced" : ""}`,
  forced,
});

/** The shape the report was made on: signs-only first, then the whole thing. */
const FORCED_FIRST = [sub(0, "magyar", true), sub(1, "magyar"), sub(2, "English")];
/** The same two, the other way round - what another episode of the season has. */
const FULL_FIRST = [sub(0, "magyar"), sub(1, "magyar", true), sub(2, "English")];
/** Two of one language that nothing tells apart, which is the commonest shape. */
const TWO_ALIKE = [sub(0, "magyar"), sub(1, "magyar"), sub(2, "English")];

describe("choosing between two tracks of one language", () => {
  it("keeps the one that was chosen, not the first of its language", () => {
    // The reported bug: the tick refused to move and signs-only played. Matching
    // by language alone always returned ordinal 0.
    const choice = rememberTrack(FORCED_FIRST, 1);
    expect(resolveTrack(FORCED_FIRST, choice)).toBe(1);
  });

  it("does the same where nothing but position tells them apart", () => {
    // 311 of those 367. No flag differs, so the position is the only thing the
    // choice can hold on to - and within one item it is exact.
    const choice = rememberTrack(TWO_ALIKE, 1);
    expect(resolveTrack(TWO_ALIKE, choice)).toBe(1);
  });

  it("still picks signs-only when signs-only is what was asked for", () => {
    const choice = rememberTrack(FORCED_FIRST, 0);
    expect(resolveTrack(FORCED_FIRST, choice)).toBe(0);
  });
});

describe("carrying that choice to another episode", () => {
  it("follows the kind rather than the position when the order differs", () => {
    // The whole subtitle was at 1 and is now at 0; the signs-only one has taken
    // its place. Position alone would hand over signs-only.
    const choice = rememberTrack(FORCED_FIRST, 1);
    expect(resolveTrack(FULL_FIRST, choice)).toBe(0);
  });

  it("keeps signs-only as signs-only", () => {
    const choice = rememberTrack(FORCED_FIRST, 0);
    expect(resolveTrack(FULL_FIRST, choice)).toBe(1);
  });

  it("takes the position when the track there is still the same kind", () => {
    const choice = rememberTrack(TWO_ALIKE, 1);
    expect(resolveTrack(TWO_ALIKE.map((t) => ({ ...t })), choice)).toBe(1);
  });

  it("gives the signs-only track when it is the only one in that language", () => {
    // Deliberate, and the owner's call: a player would have shown it anyway, and
    // it is nearer to what was asked for than nothing at all.
    const choice = rememberTrack(FORCED_FIRST, 1);
    expect(resolveTrack([sub(0, "magyar", true), sub(1, "English")], choice)).toBe(0);
  });

  it("gives nothing when the language is not there at all", () => {
    // A choice that cannot be honoured is dropped rather than answered with a
    // different language.
    const choice = rememberTrack(FORCED_FIRST, 1);
    expect(resolveTrack([sub(0, "English"), sub(1, "Polish")], choice)).toBeUndefined();
  });
});

describe("a track with no language", () => {
  it("is matched by its own id inside the item it came from", () => {
    // Measured on this server, 426 of 493 sidecar subtitles carry no language,
    // so without this the choice was dropped on the floor.
    const list = [sub(-1, undefined, false, "sidecar-7"), sub(0, "English")];
    const choice = rememberTrack(list, -1);
    expect(resolveTrack(list, choice)).toBe(-1);
  });

  it("does not travel to another item, because an id does not", () => {
    const choice = rememberTrack([sub(-1, undefined, false, "sidecar-7")], -1);
    expect(resolveTrack([sub(-1, undefined, false, "sidecar-9")], choice)).toBeUndefined();
  });
});

describe("what cannot be remembered", () => {
  it("is nothing at all, rather than a choice that names no track", () => {
    expect(rememberTrack(FORCED_FIRST, 99)).toBeUndefined();
    expect(rememberTrack(undefined, 0)).toBeUndefined();
  });

  it("resolves to nothing against a list that is not there", () => {
    expect(resolveTrack(undefined, rememberTrack(FORCED_FIRST, 1))).toBeUndefined();
    expect(resolveTrack(FORCED_FIRST, undefined)).toBeUndefined();
  });
});

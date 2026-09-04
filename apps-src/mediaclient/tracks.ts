import type { Track } from "./backends/types";

/**
 * A track choice, in terms that survive a change of episode.
 *
 * The language is the part that carries: an ordinal is a position in one item's
 * own list and episodes of a season do not agree on it. But a language on its
 * own is not enough to name a TRACK - measured over 400 episodes of this
 * library, 367 carry two or more subtitles in one language, and matching by
 * language alone always returns the first of them. So the choice keeps what it
 * can about which of them was picked, and each field is used only where it
 * still means something.
 */
export interface TrackChoice {
  /** What carries between episodes, where the server gives one. */
  language?: string;
  /**
   * Signs-only, as opposed to the whole dialogue.
   *
   * The one flag that tells two same-language subtitles apart, and it tells
   * apart 56 of those 367. It is worth keeping on its own because getting it
   * wrong is the loudest failure of the three: a viewer who asked for subtitles
   * gets almost none.
   */
  forced: boolean;
  /**
   * Where it sat in the item it was chosen on. A hint, never an identity.
   *
   * It is what makes the choice exact within one item - which is where the
   * panel's own tick lives, and where the remaining 311 of those 367 can only
   * be told apart by position, because nothing else about them differs.
   */
  ordinal: number;
  /**
   * The only thing left when a track carries no language at all.
   *
   * Measured on this server, 426 of 493 sidecar subtitles carry none, so
   * without this the choice was dropped on the floor: the panel closed, the
   * tick never moved and playback started with no subtitle. An id only matches
   * inside the item it came from, which is the honest limit.
   */
  id?: string;
}

/** What was chosen, read off the list it was chosen from. */
export function rememberTrack(tracks: Track[] | undefined, ordinal: number): TrackChoice | undefined {
  const track = tracks?.find((t) => t.ordinal === ordinal);
  if (!track) return undefined;
  return { language: track.language, forced: track.forced === true, ordinal: track.ordinal, id: track.id };
}

/**
 * The ordinal that choice means in THIS list, or nothing.
 *
 * A ladder rather than one test, because the three things a choice knows stop
 * being true at different distances:
 *
 * 1. The same position, when the track there is still the same language and the
 *    same kind. Exact within the item it was chosen on, and right across
 *    episodes whenever the order is stable - which is most of them.
 * 2. The same language and the same kind, which is what carries when the order
 *    is not stable.
 * 3. The same language, whatever kind. This is deliberate rather than a
 *    fallthrough: where the next episode has only a signs-only track in that
 *    language, signs-only is what a player would have shown anyway, and it is
 *    nearer to what was asked for than nothing.
 *
 * Nothing at all when the language is absent from this list - a choice that
 * cannot be honoured is dropped rather than answered with another language.
 */
export function resolveTrack(tracks: Track[] | undefined, choice: TrackChoice | undefined): number | undefined {
  if (!tracks || !choice) return undefined;
  // No language to carry, so the id is all there is - and it only means
  // anything inside the item it came from.
  if (!choice.language) return tracks.find((t) => t.id === choice.id)?.ordinal;

  const sameLanguage = tracks.filter((t) => t.language === choice.language);
  const sameKind = (t: Track): boolean => (t.forced === true) === choice.forced;

  const atOrdinal = sameLanguage.find((t) => t.ordinal === choice.ordinal && sameKind(t));
  if (atOrdinal) return atOrdinal.ordinal;

  return (sameLanguage.find(sameKind) ?? sameLanguage[0])?.ordinal;
}

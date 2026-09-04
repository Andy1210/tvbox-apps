import type { Track } from "./backends/types";

/**
 * A track choice, in terms that survive a change of episode.
 *
 * Named `ChosenTrack` rather than `TrackChoice` because `backends/types.ts`
 * already exports that name for something else entirely - the number, "no" or
 * "auto" the player is handed.
 *
 * The language is the part that carries: an ordinal is a position in one item's
 * own list and episodes of a season do not agree on it. But a language on its
 * own does not name a TRACK - across this library's 8,234 episodes, 1,841 carry
 * two or more subtitles in one language - so the choice keeps what it can about
 * which of them was picked, and each field is used only as far as it still
 * means something.
 */
export interface ChosenTrack {
  /** What carries between episodes, where the server gives one. */
  language?: string;
  /** Signs and foreign dialogue only, rather than the whole of it. */
  forced: boolean;
  /**
   * Written for a viewer who cannot hear it.
   *
   * A third kind rather than a variant of `forced`, and it earns its place: a
   * file routinely holds the full track and the SDH one in the same language
   * with the same forced flag, and without this a choice cannot tell them
   * apart. Measured across the whole library against the muxer's own stream
   * labels, which this code does not read: leaving it out is 52 regressions
   * against 0.64.1 where including it is 27.
   *
   * Its reach is smaller than its population: 577 of the 1,749 episode subtitle
   * tracks whose LABEL says SDH carry the flag. It is never wrong when present,
   * and the label is the obvious next signal.
   */
  hearingImpaired: boolean;
  /**
   * Where it sat in the item it was chosen on. A hint, never an identity.
   *
   * It is what makes the choice exact within one item - which is where the
   * panel's own tick lives, and where two tracks that differ in nothing else
   * can only be told apart by position.
   */
  ordinal: number;
  /**
   * The item AND version it was chosen on, which is the only thing that makes
   * `id` usable.
   *
   * An id is per-item on Jellyfin - literally the stream's index - so without
   * this the id below would silently name a different stream on the next
   * episode. The version belongs in the key for the same reason and one step
   * finer: on Jellyfin the index is per MEDIA SOURCE, so two versions of one
   * item repeat it, and the version chips change the version without changing
   * the item.
   */
  itemId: string;
  /**
   * The only thing left when a track carries no language at all.
   *
   * Measured on this server, 422 of 482 sidecar subtitles on films carry none,
   * so without this the choice was dropped on the floor: the panel closed, the
   * tick never moved and playback started with no subtitle.
   */
  id?: string;
}

/** What was chosen, read off the list it was chosen from. */
export function rememberTrack(tracks: Track[] | undefined, ordinal: number, itemId: string): ChosenTrack | undefined {
  const track = tracks?.find((t) => t.ordinal === ordinal);
  if (!track) return undefined;
  return {
    language: track.language,
    forced: track.forced === true,
    hearingImpaired: track.hearingImpaired === true,
    ordinal: track.ordinal,
    itemId,
    id: track.id,
  };
}

/**
 * The ordinal that choice means in THIS list, or nothing.
 *
 * A ladder rather than one test, because the things a choice knows stop being
 * true at different distances:
 *
 * 1. The same position, when the track there is still the same language and the
 *    same kind. Exact within the item it was chosen on, and right across
 *    episodes whenever the order is stable - which is most of them. Measured
 *    over this library, putting this rung second instead costs ten times the
 *    errors.
 * 2. The same language and the same kind, which is what carries when the order
 *    is not stable.
 * 3. The same language, whatever kind. Deliberate rather than a fallthrough:
 *    where the next episode has only a signs-only track in that language,
 *    signs-only is what a player would have shown anyway, and it is nearer to
 *    what was asked for than nothing.
 *
 * Nothing at all when the language is absent from this list - a choice that
 * cannot be honoured is dropped rather than answered with another language.
 * That is structural rather than measured: every rung reads from `sameLanguage`.
 *
 * Measured over the whole library against the muxer's own stream labels, which
 * this code does not read: 2,367 resolutions fixed against 0.64.1 and 27
 * regressed.
 *
 * `itemId` says which item and version this list belongs to, and only the id
 * branch reads it.
 */
export function resolveTrack(
  tracks: Track[] | undefined,
  choice: ChosenTrack | undefined,
  itemId: string,
): number | undefined {
  if (!tracks || !choice) return undefined;
  // No language to carry, so the id is all there is - and an id only means
  // anything inside the item it came from, which on Jellyfin is literal: the id
  // IS the stream's index, so the same string on the next episode is a
  // different track.
  if (!choice.language) {
    return choice.itemId === itemId ? tracks.find((t) => t.id === choice.id)?.ordinal : undefined;
  }

  const sameLanguage = tracks.filter((t) => t.language === choice.language);
  const sameKind = (t: Track): boolean =>
    (t.forced === true) === choice.forced && (t.hearingImpaired === true) === choice.hearingImpaired;

  const atOrdinal = sameLanguage.find((t) => t.ordinal === choice.ordinal && sameKind(t));
  if (atOrdinal) return atOrdinal.ordinal;

  return (sameLanguage.find(sameKind) ?? sameLanguage[0])?.ordinal;
}

// One song in a list.
//
// A row rather than a tile, because that is what a song is: the artwork is the
// album's and is shared by everything around it, while the title and the artist
// are the two things that tell one row from the next. A grid of near-identical
// covers is exactly what this library would look like as tiles - most of its
// albums are two-to-four track singles.

import { FocusButton } from "@sdk";
import type { MediaItem } from "../backends/types";
import { clock } from "../time";
import { useArtwork } from "./useArtwork";

/**
 * The pitch a list of these must reserve per row, in vh.
 *
 * Not decoration: spatial navigation resolves by geometry and drops a candidate
 * whose box overlaps the focused one, so a row that measures taller than the
 * space it is given makes its NEIGHBOUR unreachable. Measured on the box - a
 * queue whose rows had no fixed height moved the cursor 6 -> 8 -> 10 going down
 * and 7 -> 5 -> 3 coming up, in every run: half of a 572-track queue could never
 * be selected. The songs list, which did reserve this, moved one row per press.
 *
 * 9vh against a row of 6vh artwork plus 1.1vh padding either side leaves room
 * for the focus ring's 4% scale without the boxes touching.
 */
export const TRACK_ROW_VH = 9;

export function TrackRow({
  item,
  focusKey,
  onEnter,
  artUrl,
  playing,
  /** Position in the list, drawn where there is no artwork to draw. */
  ordinal,
  onArrowPress,
  onFocused,
}: {
  item: MediaItem;
  focusKey: string;
  onEnter: () => void;
  artUrl?: string;
  playing?: boolean;
  ordinal?: number;
  onArrowPress?: (direction: string) => boolean;
  /** Called when this row takes focus. A windowed list learns where it is from
   *  this rather than by counting presses - see MusicList. */
  onFocused?: () => void;
}): React.JSX.Element {
  const artist = item.grandparentTitle ?? item.parentTitle;
  const art = useArtwork(artUrl);
  return (
    <FocusButton
      focusKey={focusKey}
      onEnter={onEnter}
      onArrowPress={onArrowPress}
      onFocused={onFocused}
      // Full width and left-aligned: a row of text centred on a television reads
      // as a heading, and the eye then has to find where each line starts.
      className={`flex w-full items-center gap-[1.2vw] rounded-[1vh] px-[1.5vw] py-[1.1vh] text-left ${
        playing ? "bg-white/10" : ""
      }`}
    >
      {/* The ordinal stands in until the cover arrives, and stays if it never
          does - a torn-image icon says nothing, and a blank column of the same
          width would make the titles jump sideways when art lands. */}
      {art ? (
        <img
          src={art}
          alt=""
          // Decorative: the title beside it says what this is, and a screen
          // reader announcing the cover twice is noise.
          className="h-[6vh] w-[6vh] shrink-0 rounded-[0.6vh] object-cover"
        />
      ) : (
        <span className="w-[6vh] shrink-0 text-center text-[2.2vh] text-fg-dim tabular-nums">{ordinal ?? ""}</span>
      )}

      <span className="min-w-0 flex-1">
        {/* Two lines, both truncated. A song title and an artist are each one
            line on a television; wrapping them makes rows of different heights,
            and a list whose rows jump is a list you cannot aim at. */}
        <span className={`block truncate text-[2.4vh] ${playing ? "font-bold" : ""}`}>{item.title}</span>
        {artist && <span className="block truncate text-[2vh] text-fg-dim">{artist}</span>}
      </span>

      {item.durationMs ? (
        <span className="shrink-0 text-[2vh] text-fg-dim tabular-nums">{clock(item.durationMs)}</span>
      ) : null}
    </FocusButton>
  );
}

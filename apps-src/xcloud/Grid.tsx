import { useMemo } from "react";
import type { Title } from "./api";
import { Tile } from "./Tile";

// The library as a grid rather than a row.
//
// A row was wrong twice over: a few hundred titles cannot be reached by holding
// right, and an "owned" row and an "everything" row both sorted alphabetically
// show the same first screen - two rows, one content. So the grid is the list and
// the rows above it are the short, curated things a row is actually good for.
//
// It does not move itself: the page owns the vertical movement, because a press
// can leave this grid for a row above it and one transform has to cover both.
export function Grid({
  titles,
  idPrefix,
  onPlay,
  onFocused,
}: {
  titles: Title[];
  idPrefix: string;
  onPlay: (t: Title) => void;
  onFocused?: (el: HTMLElement) => void;
}) {
  // Owned first, then the rest, each alphabetically - so the games that can be
  // played right now are not scattered among the ones that would have to be
  // bought. `localeCompare` because the names are not ASCII.
  const ordered = useMemo(() => {
    const by = (a: Title, b: Title) => a.name.localeCompare(b.name);
    return [...titles.filter((t) => t.owned).sort(by), ...titles.filter((t) => !t.owned).sort(by)];
  }, [titles]);

  return (
    // The gaps have to clear the focus reach on both sides of a tile, or a
    // focused one is drawn over its neighbour rather than beside it. Nothing here
    // clips, so this is about overlap rather than cropping.
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(13vw,1fr))] gap-x-[1.5vw]"
      style={{ rowGap: "calc(2 * var(--focus-reach) + 0.6vh)", padding: "0 var(--focus-reach)" }}
    >
      {ordered.map((title) => (
        <Tile
          key={title.titleId}
          // Keyed on the TITLE, not its position: the catalogue keeps arriving for
          // half a minute and the sort moves a game's index as it grows, so an
          // index-keyed focus follows the SLOT and lands on a different game.
          focusKey={`${idPrefix}-${title.titleId}`}
          title={title}
          onEnter={() => onPlay(title)}
          onFocused={onFocused}
        />
      ))}
    </div>
  );
}

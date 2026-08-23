import { useMemo } from "react";
import type { Title } from "./api";
import { Tile } from "./Tile";

// The whole library as a grid rather than a row.
//
// A row was wrong twice over: 2531 titles cannot be reached by holding right, and
// an "owned" row and an "everything" row both sorted alphabetically show the same
// first screen - two rows, one content. The grid is everything, with what the
// subscription covers first, so the row above it can be the one thing a row is
// good for: what you were in the middle of.
//
// Every tile is mounted and the art is `loading="lazy"`, so the browser fetches
// the pictures for the rows on screen and the 1.45 MB of metadata is all that is
// really held.
export function Grid({
  titles,
  idPrefix,
  onPlay,
}: {
  titles: Title[];
  idPrefix: string;
  onPlay: (t: Title) => void;
}) {
  // Owned first, then the rest, each alphabetically - so the games that can be
  // played right now are not scattered among the ones that would have to be
  // bought.
  const ordered = useMemo(() => {
    const by = (a: Title, b: Title) => a.name.localeCompare(b.name);
    return [...titles.filter((t) => t.owned).sort(by), ...titles.filter((t) => !t.owned).sort(by)];
  }, [titles]);

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(13vw,1fr))] gap-[1.5vw]">
      {ordered.map((title, i) => (
        <Tile key={title.titleId} title={title} focusKey={`${idPrefix}-${i}`} onEnter={() => onPlay(title)} />
      ))}
    </div>
  );
}

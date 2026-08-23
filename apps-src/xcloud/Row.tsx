import { useCallback, useMemo, useRef } from "react";
import type { Title } from "./api";
import { Tile } from "./Tile";
import { createMover, nearest, pinScroll } from "./moveTo";

// A horizontal row, moved by a transform rather than scrolled.
//
// Its own mover, so a sideways press animates this row and touches nothing else -
// and so a press that stays inside the visible part does not move it at all, which
// is what `nearest` means.
//
// The padding is not decoration: the focus outline sits outside the tile, and this
// container clips (it has to, or the tiles past the edge would draw across the
// page). Without room reserved the highlight is cut off - and it is cut off on all
// FOUR sides, not just the ends, because the clip box is only as tall as the row.
// `--focus-reach` is how far a focused tile is drawn outside its own box; see
// index.css.
const PAD = "var(--focus-reach)";

export function Row({
  id,
  label,
  titles,
  onPlay,
  onFocused,
}: {
  id: string;
  label: string;
  titles: Title[];
  onPlay: (t: Title) => void;
  /** The page moves vertically; a row reports the focused tile up for that. */
  onFocused?: (el: HTMLElement) => void;
}) {
  const mover = useMemo(() => createMover("x"), []);
  const track = useRef<HTMLDivElement | null>(null);
  const clip = useRef<HTMLDivElement | null>(null);
  const pin = useMemo(() => pinScroll(), []);

  // Memoised: React re-attaches an INLINE ref on every render, and a ref callback
  // that returns a value is read as a cleanup function in React 19.
  const attachTrack = useCallback(
    (el: HTMLDivElement | null) => {
      track.current = el;
      mover.attach(el);
    },
    [mover],
  );

  const focusTile = useCallback(
    (el: HTMLElement) => {
      const box = clip.current;
      const strip = track.current;
      if (box && strip) {
        const tile = el.getBoundingClientRect();
        const view = box.getBoundingClientRect();
        // The track is translated by -at, so its rect already carries the shift;
        // adding `at` back gives the position in the un-moved strip.
        const start = tile.left - view.left + mover.at;
        mover.to(
          nearest({
            at: mover.at,
            viewport: view.width,
            start,
            size: tile.width,
            padStart: tile.width * 0.25,
            padEnd: tile.width * 0.25,
            max: strip.scrollWidth,
          }),
          true,
        );
      }
      onFocused?.(el);
    },
    [mover, onFocused],
  );

  return (
    <section className="mb-[3vh]">
      <h2 className="mb-[1vh] px-[0.5vw] text-[2.2vh] text-fg-dim">{label}</h2>
      <div
        ref={(el) => {
          clip.current = el;
          pin(el);
        }}
        className="overflow-hidden"
        style={{ padding: PAD }}
      >
        <div ref={attachTrack} className="flex w-max gap-[1.5vw]">
          {titles.map((title) => (
            <Tile
              key={title.titleId}
              title={title}
              focusKey={`${id}-${title.titleId}`}
              onEnter={() => onPlay(title)}
              onFocused={focusTile}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

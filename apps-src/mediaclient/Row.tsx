import { useFocusable, FocusContext, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useCallback, useMemo, useRef } from "react";
import { Tile } from "./Tile";
import { createMover, nearest } from "./moveTo";
import type { MediaItem } from "./backends/types";

export interface RowProps {
  id: string;
  title: string;
  items: MediaItem[];
  posterUrl: (item: MediaItem) => string | undefined;
  onSelect: (item: MediaItem) => void;
  heightVh?: number;
  /** Tile shape and caption depth. See Tile. */
  aspect?: number;
  captionLines?: 2 | 3;
  /**
   * Called when any tile in this row takes focus.
   *
   * The page above the first row is not focusable - a title, a photo, a
   * synopsis - so there is nothing to navigate UP to once someone has scrolled
   * past it. The first row uses this to take the page back to its top.
   */
  onReached?: () => void;
  /**
   * Which item the cursor is on.
   *
   * A season's audio and subtitle choice belongs to the episode about to play,
   * and the tracks differ per episode - so the screen has to know which one is
   * highlighted, not merely which one was pressed.
   */
  onFocusItem?: (item: MediaItem) => void;
  /**
   * Intercept an arrow leaving this row.
   *
   * A row's vertical padding pulls its box over whatever sits above it, and
   * spatial navigation drops a candidate whose bottom is inside the focused
   * element - so Up out of a row can find nothing at all. Where that matters,
   * the screen says where Up goes instead of letting geometry decide.
   */
  onArrowFromFirst?: (direction: string) => boolean;
  /** Item id to a countdown, for the one about to start by itself. */
  countdownFor?: { id: string; seconds: number } | null;
}

/**
 * A horizontal rail of posters.
 *
 * The scroll follows focus rather than the pointer: on a D-pad the focused tile
 * has to be the one on screen, and letting the browser's own scrollIntoView do
 * it puts the tile at the edge, where the next press appears to do nothing.
 */
export function Row({
  id,
  title,
  items,
  posterUrl,
  onSelect,
  heightVh,
  aspect,
  captionLines,
  onReached,
  onFocusItem,
  onArrowFromFirst,
  countdownFor,
}: RowProps): React.JSX.Element | null {
  const window_ = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  // The rail moves itself with a composited transform rather than being
  // scrolled - the same reason the library grid does, measured there: a native
  // scroll of this content re-rasters per frame what a transform simply moves.
  const mover = useMemo(() => createMover("x"), []);

  const onFocusChild = useCallback(
    (el: HTMLElement) => {
      onReached?.();
      const box = window_.current;
      if (!box) return;
      // A tile's worth of run-up on the leading side, so the rail looks like it
      // continues rather than ending at the focus ring.
      const pad = el.offsetWidth * 0.6;
      const to = nearest({
        at: mover.at,
        viewport: box.clientWidth,
        start: el.offsetLeft,
        size: el.offsetWidth,
        padStart: pad,
        padEnd: pad,
        // The moved layer's own width, not the window's scroll width: the
        // window no longer scrolls, so what bounds the travel is how wide the
        // thing being moved is.
        max: layer.current?.scrollWidth ?? box.clientWidth,
      });
      // Instant when the jump is more than a screen: arriving on episode 40
      // otherwise animates the whole way there, which reads as the app hanging
      // rather than as a transition.
      mover.to(to, Math.abs(to - mover.at) <= box.clientWidth);
    },
    [onReached, mover],
  );

  /**
   * Sideways off the end of the rail goes round; anything else is the caller's.
   *
   * Without this the ends were not a boundary, they were an accident: with no
   * candidate in that direction, spatial navigation goes up to the container
   * and the container restores its LAST FOCUSED child. From the first tile that
   * looks like a jump to the end of the row, and from the last tile it looks
   * like nothing happening at all - the same behaviour twice, visible once.
   *
   * A row on a television is a ring: forty episodes and the fortieth is one
   * press from the first. The move is a jump rather than a slide, which the
   * mover already decides for anything more than a screen away.
   */
  const wrapOrDelegate = useCallback(
    (dir: string, index: number): boolean => {
      const last = items.length - 1;
      if (last > 0 && ((dir === "left" && index === 0) || (dir === "right" && index === last))) {
        const to = dir === "left" ? last : 0;
        const item = items[to];
        setFocus(`${id}-${item.id || to}`);
        return false;
      }
      return onArrowFromFirst ? onArrowFromFirst(dir) : true;
    },
    [items, id, onArrowFromFirst],
  );

  const { ref, focusKey } = useFocusable({ focusKey: `row-${id}`, trackChildren: true, saveLastFocusedChild: true });

  if (items.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <section
        ref={ref}
        // shrink-0, because a row is a flex item in a column that scrolls: with
        // several of them taller than the box, flexbox squashes each one rather
        // than letting the box scroll - and what survives is the middle, so the
        // heading above the tiles and the captions below them both vanish.
        className="flex shrink-0 flex-col gap-[1vh]"
      >
        <h2 className="shrink-0 px-[4vw] text-[2vh] font-semibold tracking-tight">{title}</h2>
        {/* The inset is OUTSIDE the clip, and that is the whole point of the
            extra element. `overflow` clips at the PADDING box, so a rail padded
            by 4vw stays visible inside those 4vw - a tile sliding out of the
            row ran all the way to the screen edge instead of disappearing at
            the margin. Padding here, clipping below, and the two stop
            disagreeing. */}
        <div className="px-[4vw]">
          <div
            ref={window_}
            // Clips; it does not scroll. Everything in it is carried by the
            // layer below, which the compositor moves.
            //
            // Padding on BOTH axes with matching negative margins, so the box
            // does not move: a focus ring is drawn OUTSIDE a tile's box, and
            // this element clips. Without the vertical half the top and bottom
            // of the ring go; without the horizontal half the first and last
            // tile lose their left and right edges - which is what happened
            // when the 4vw inset moved out to the wrapper and took the only
            // horizontal room with it.
            //
            // Small on purpose. It is the ring's allowance, not the inset: a
            // tile sliding out of the row disappears 0.8vw past the margin
            // rather than running to the screen edge.
            className="no-scrollbar -mx-[0.8vw] -my-[4vh] overflow-hidden px-[0.8vw] py-[6vh]"
          >
            {/* `relative` is load-bearing, not spacing. A tile's offsetLeft is
              measured against the nearest POSITIONED ancestor, and the maths
              above moves THIS layer - so without it the two are in different
              coordinate spaces, and the rail lurched back and forth with the
              cursor landing off screen. */}
            <div
              ref={(node) => {
                layer.current = node;
                mover.attach(node);
              }}
              style={{ willChange: "transform" }}
              className="relative flex gap-[1.2vw]"
            >
              {items.map((item, i) => (
                <Tile
                  key={item.id || `${id}-${i}`}
                  item={item}
                  posterUrl={posterUrl(item)}
                  focusKey={`${id}-${item.id || i}`}
                  heightVh={heightVh}
                  aspect={aspect}
                  captionLines={captionLines}
                  onEnter={() => onSelect(item)}
                  onArrowPress={(dir) => wrapOrDelegate(dir, i)}
                  countdown={countdownFor?.id === item.id ? countdownFor.seconds : undefined}
                  // The rail moves itself; the browser must not also scroll it.
                  selfScroll={false}
                  onFocusedEl={(el) => {
                    onFocusChild(el);
                    onFocusItem?.(item);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </section>
    </FocusContext.Provider>
  );
}

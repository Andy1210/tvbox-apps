import { useFocusable, FocusContext, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { Tile } from "./Tile";
import { createMover, nearest } from "@sdk/moveTo";
import type { MediaItem } from "./backends/types";

/**
 * Where the top of a row should land inside the view.
 *
 * Pure, and separate from the DOM half deliberately: the scroll padding, the
 * rectangles and the scroller itself need a browser that compiles CSS, while
 * the placement is the part with a wrong answer. Coordinates are the viewport's,
 * so `top` and `bottom` are the view's edges with its scroll padding already
 * taken off.
 */
export function revealTop(a: {
  top: number;
  bottom: number;
  rowTop: number;
  rowHeight: number;
  /** The element that must stay on screen, where it sits now. */
  keepTop?: number;
}): number {
  const { top, bottom, rowTop, rowHeight, keepTop } = a;
  if (keepTop === undefined) return top;
  // The gap between the two is fixed by the layout, so putting the kept element
  // where the row would otherwise go only ever moves the row DOWN - and never
  // past the point where the row itself stops fitting, which is what decides
  // who loses room on a page taller than the screen. A row too tall to fit at
  // all keeps the plain placement.
  return Math.max(top, Math.min(top + (rowTop - keepTop), bottom - rowHeight));
}

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
   * An element above this row that must stay on screen while it is focused.
   *
   * A row is otherwise brought to the top of the view, and on a season screen
   * that takes the synopsis with it - the synopsis there describes the
   * HIGHLIGHTED episode, so it is exactly what someone moving along the row is
   * reading. Given this, the row parks low enough to leave it showing, and no
   * lower than still fits the row itself.
   */
  keepAbove?: RefObject<HTMLElement | null>;
  /**
   * The id of the item the screen around this row is describing.
   *
   * Marked on its tile, faintly, so that a page whose synopsis and buttons
   * follow the highlight still says which item they are about once the cursor
   * has moved up to those buttons.
   */
  describing?: string;
  /**
   * Intercept an arrow leaving this row.
   *
   * A row's vertical padding pulls its box over whatever sits above it, and
   * spatial navigation drops a candidate whose bottom is inside the focused
   * element - so Up out of a row can find nothing at all. Where that matters,
   * the screen says where Up goes instead of letting geometry decide.
   */
  onArrowFromFirst?: (direction: string) => boolean;
  /**
   * Item id to what is drawn over its poster: a countdown's number for the one
   * about to start by itself, or a mark for the one that is being fetched. A
   * string, because a step has no number to show and the alternative was the
   * badge simply disappearing - measured, the countdown's "4" vanished the moment
   * a spoken "next episode" arrived and nothing took its place for up to twelve
   * seconds.
   */
  countdownFor?: { id: string; seconds: number | string } | null;
}

/**
 * A horizontal rail of posters.
 *
 * The scroll follows focus rather than the pointer: on a D-pad the focused tile
 * has to be the one on screen, and letting the browser's own scrollIntoView do
 * it puts the tile at the edge, where the next press appears to do nothing.
 */
/**
 * An empty row draws nothing, and it registers nothing either: a focusable
 * registered before its node exists has no coordinates, and spatial navigation
 * can then offer it as a target that highlights nothing.
 */
export function Row(props: RowProps): React.JSX.Element | null {
  return props.items.length === 0 ? null : <RowBody {...props} />;
}

function RowBody({
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
  keepAbove,
  describing,
}: RowProps): React.JSX.Element {
  const section = useRef<HTMLElement | null>(null);
  const window_ = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  // The rail moves itself with a composited transform rather than being
  // scrolled - the same reason the library grid does, measured there: a native
  // scroll of this content re-rasters per frame what a transform simply moves.
  const mover = useMemo(() => createMover("x"), []);

  /**
   * Put this row at the top of the page's view, unless it is already in it.
   *
   * The scroll padding is read from the scroller rather than assumed: it is
   * what keeps the first row clear of the rail above it, and duplicating the
   * number here is how the two drift.
   */
  const revealRow = useCallback(() => {
    const sec = section.current;
    if (!sec) return;
    let sc: HTMLElement | null = sec.parentElement;
    while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
    if (!sc) return;

    const style = getComputedStyle(sc);
    const padTop = parseFloat(style.scrollPaddingTop) || 0;
    const padBottom = parseFloat(style.scrollPaddingBottom) || 0;
    const row = sec.getBoundingClientRect();
    const view = sc.getBoundingClientRect();
    const bottom = view.bottom - padBottom;
    const keep = keepAbove?.current;
    const top = revealTop({
      top: view.top + padTop,
      bottom,
      rowTop: row.top,
      rowHeight: row.height,
      keepTop: keep?.getBoundingClientRect().top,
    });
    // Already in view, so nothing moves - which is what stops a sideways press
    // from nudging the page.
    if (row.top >= top && row.bottom <= bottom) return;
    sc.scrollTop += row.top - top;
  }, [keepAbove]);

  /**
   * Put the rail back where a new list can be seen.
   *
   * The offset is only ever recomputed when a tile takes focus, and nothing
   * re-clamps it when the list underneath changes - a native scroller got that
   * from the browser, this is not one. Searching again while the first rail was
   * scrolled therefore opened it on empty space: a heading with nothing under
   * it, correcting itself only once something in it was focused.
   *
   * A different list starts at the beginning; the same list that grew or lost
   * its tail keeps its place, clamped to what is left of it. The test for "the
   * same list" is whether one is a PREFIX of the other, because the two cases
   * are told apart by nothing weaker: a page of episodes arriving keeps every
   * id it had, while refining a search ("star" to "star wars") routinely keeps
   * the top hit and replaces everything behind it - which the first id alone
   * read as the same list, and the rail then opened on results nobody had
   * looked at.
   */
  const ids = items.map((i) => i.id);
  const signature = ids.join("\u0000");
  const shown = useRef<string[]>(ids);
  useEffect(() => {
    const prev = shown.current;
    shown.current = ids;
    const box = window_.current;
    if (!box) return;
    const shared = Math.min(prev.length, ids.length);
    let continues = prev.length > 0 && ids.length > 0;
    for (let i = 0; i < shared && continues; i += 1) if (prev[i] !== ids[i]) continues = false;
    if (!continues) {
      mover.to(0, false);
      return;
    }
    // The same list, longer or shorter: keep the place, but not past the end -
    // nothing else re-clamps a rail that moves itself.
    const style = getComputedStyle(box);
    const viewport = box.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const max = layer.current?.scrollWidth ?? box.clientWidth;
    mover.to(Math.max(0, Math.min(mover.at, max - viewport)), false);
    // `signature` rather than `ids`, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, mover]);

  const onFocusChild = useCallback(
    (el: HTMLElement) => {
      onReached?.();
      // The PAGE still scrolls vertically, and it used to get that for free:
      // a tile's own scrollIntoView moved the rail sideways and the page
      // downwards in one call. Turning the tile's scrolling off to stop it
      // fighting the transform took the vertical half with it, and the home
      // screen stopped following the cursor past the first row.
      //
      // The section rather than the tile, because the tile lives inside a clip
      // that is not a scroller: asking the browser to reveal it can only be
      // answered by moving something we are moving ourselves.
      //
      // And computed rather than handed to `scrollIntoView`, because "nearest"
      // aligns whichever edge is closer - going down that parks the row at the
      // BOTTOM of the view, with the row above still showing a row and a half
      // of itself. A row is brought to the top of the view or not moved at all,
      // which is the only placement that reads the same in both directions.
      revealRow();

      const box = window_.current;
      if (!box) return;
      // A tile's worth of run-up on the leading side, so the rail looks like it
      // continues rather than ending at the focus ring.
      const pad = el.offsetWidth * 0.6;
      // The CONTENT width, not clientWidth - which includes padding. The clip
      // carries a small horizontal padding as room for the focus ring, and
      // counting it as usable width made the rail believe it could see 1.6vw
      // more than it can: it under-scrolled by exactly that, and the last tile
      // came up cropped by about two ring widths on the right.
      const style = getComputedStyle(box);
      const viewport = box.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const to = nearest({
        at: mover.at,
        viewport,
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
    [onReached, mover, revealRow],
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

  return (
    <FocusContext.Provider value={focusKey}>
      <section
        ref={(node) => {
          section.current = node;
          (ref as React.MutableRefObject<HTMLElement | null>).current = node;
        }}
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
                  // Only where the caller named one, and never a match on an
                  // empty id: an item with none would otherwise mark every
                  // tile that also has none.
                  describing={Boolean(describing) && item.id === describing}
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

import { useFocusable, FocusContext } from "@noriginmedia/norigin-spatial-navigation";
import { useCallback, useRef } from "react";
import { Tile } from "./Tile";
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
}: RowProps): React.JSX.Element | null {
  const scroller = useRef<HTMLDivElement>(null);

  const onFocusChild = useCallback(
    (el: HTMLElement) => {
      onReached?.();
      const box = scroller.current;
      if (!box) return;
      // Keep a tile's worth of run-up visible on the leading side so the rail
      // looks like it continues rather than ending at the focus ring.
      const pad = el.offsetWidth * 0.6;
      const left = el.offsetLeft - pad;
      const right = el.offsetLeft + el.offsetWidth + pad;
      // Instant when the jump is more than a screen: arriving on episode 40
      // otherwise animates the whole way there, which reads as the app hanging
      // rather than as a transition.
      const far = Math.abs(left - box.scrollLeft) > box.clientWidth;
      const behavior = far ? "auto" : "smooth";
      if (left < box.scrollLeft) box.scrollTo({ left, behavior });
      else if (right > box.scrollLeft + box.clientWidth) box.scrollTo({ left: right - box.clientWidth, behavior });
    },
    [onReached],
  );

  const { ref, focusKey } = useFocusable({ focusKey: `row-${id}`, trackChildren: true, saveLastFocusedChild: true });

  if (items.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} className="flex flex-col gap-[1vh]">
        <h2 className="px-[4vw] text-[2vh] font-semibold tracking-tight">{title}</h2>
        <div
          ref={scroller}
          // No scroll-smooth. This row does its own scrolling and says how, but the
          // browser also brings a focused tile into view - and that call names no
          // behaviour, so the CSS decided for it and animated a jump of forty
          // episodes end to end.
          className="no-scrollbar flex gap-[1.2vw] overflow-x-auto px-[4vw] py-[9vh] -my-[5vh]"
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
              onFocusedEl={(el) => {
                onFocusChild(el);
                onFocusItem?.(item);
              }}
            />
          ))}
        </div>
      </section>
    </FocusContext.Provider>
  );
}

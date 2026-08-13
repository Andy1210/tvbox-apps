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
}

/**
 * A horizontal rail of posters.
 *
 * The scroll follows focus rather than the pointer: on a D-pad the focused tile
 * has to be the one on screen, and letting the browser's own scrollIntoView do
 * it puts the tile at the edge, where the next press appears to do nothing.
 */
export function Row({ id, title, items, posterUrl, onSelect, heightVh }: RowProps): React.JSX.Element | null {
  const scroller = useRef<HTMLDivElement>(null);

  const onFocusChild = useCallback((el: HTMLElement) => {
    const box = scroller.current;
    if (!box) return;
    // Keep a tile's worth of run-up visible on the leading side so the rail
    // looks like it continues rather than ending at the focus ring.
    const pad = el.offsetWidth * 0.6;
    const left = el.offsetLeft - pad;
    const right = el.offsetLeft + el.offsetWidth + pad;
    if (left < box.scrollLeft) box.scrollTo({ left, behavior: "smooth" });
    else if (right > box.scrollLeft + box.clientWidth)
      box.scrollTo({ left: right - box.clientWidth, behavior: "smooth" });
  }, []);

  const { ref, focusKey } = useFocusable({ focusKey: `row-${id}`, trackChildren: true, saveLastFocusedChild: true });

  if (items.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} className="flex flex-col gap-[1vh]">
        <h2 className="px-[4vw] text-[2vh] font-semibold tracking-tight">{title}</h2>
        <div ref={scroller} className="no-scrollbar flex gap-[1.2vw] overflow-x-auto scroll-smooth px-[4vw] py-[9vh] -my-[5vh]">
          {items.map((item, i) => (
            <Tile
              key={item.id || `${id}-${i}`}
              item={item}
              posterUrl={posterUrl(item)}
              focusKey={`${id}-${item.id || i}`}
              heightVh={heightVh}
              onEnter={() => onSelect(item)}
              onFocusedEl={onFocusChild}
            />
          ))}
        </div>
      </section>
    </FocusContext.Provider>
  );
}

import { useEffect, useRef, useState } from "react";
import { useFocusableItem } from "@sdk";
import type { MediaItem } from "./backends/types";
import { loadImage } from "./posters";
import { useApp } from "./state";

export interface TileProps {
  item: MediaItem;
  /** Server-scaled poster; absent when the item has no art. */
  posterUrl?: string;
  focusKey: string;
  onEnter: () => void;
  /** Poster height in vh; width follows the 2:3 poster ratio. */
  heightVh?: number;
  /** Called with this tile's element when it takes focus, so the container can
   *  scroll it into view on its own terms rather than the browser's. */
  onFocusedEl?: (el: HTMLElement) => void;
}

/** How far through the item, 0-1, or null when it was never started. */
function progress(item: MediaItem): number | null {
  if (!item.viewOffsetMs || !item.durationMs) return null;
  return Math.min(1, item.viewOffsetMs / item.durationMs);
}

function label(item: MediaItem): string {
  if (item.kind === "episode" && item.seriesTitle) {
    const s = item.parentIndex !== undefined ? `S${item.parentIndex}` : "";
    const e = item.index !== undefined ? `E${item.index}` : "";
    return [item.seriesTitle, [s, e].filter(Boolean).join("")].filter(Boolean).join(" · ");
  }
  return item.title;
}

/**
 * One poster in a row or grid.
 *
 * The watched state is on the tile rather than only on the detail page because
 * that is the question being asked while scrolling: what have I not seen. A
 * partly-watched item shows how far in, a finished one a plain mark; an
 * unwatched one shows nothing, so the marks mean something.
 */
export function Tile({
  item,
  posterUrl,
  focusKey,
  onEnter,
  heightVh = 26,
  onFocusedEl,
}: TileProps): React.JSX.Element {
  // scrollIntoView scrolls BOTH axes - `inline` defaults to "nearest" - so a
  // row gets its vertical scrolling from here and then supersedes the horizontal
  // half with its own scrollTo, which gives the focused tile some run-up. That
  // ordering holds only because this hook runs before the effect below.
  const { ref, focused } = useFocusableItem({ focusKey, onEnterPress: onEnter }, { block: "nearest" });
  const el = useRef<HTMLDivElement | null>(null);
  const backend = useApp((s) => s.backend);
  const [src, setSrc] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const pct = progress(item);
  const watched = !pct && (item.viewCount ?? 0) > 0;
  const showsTitleInPlace = (!src || broken) && item.title !== "";

  useEffect(() => {
    if (focused && el.current) onFocusedEl?.(el.current);
  }, [focused, onFocusedEl]);

  // Artwork is fetched with the credential in a header and shown as a blob, so
  // the token never appears in markup. A failure is not an error: the tile has a
  // title to fall back to.
  useEffect(() => {
    if (!posterUrl || !backend) return;
    let live = true;
    void loadImage(posterUrl, backend.imageHeaders()).then((url) => {
      if (!live) return;
      if (url) setSrc(url);
      else setBroken(true);
    });
    return () => {
      live = false;
    };
  }, [posterUrl, backend]);

  return (
    <div
      ref={(node) => {
        el.current = node;
        ref(node);
      }}
      onClick={onEnter}
      // No scale on focus, and this is load-bearing rather than taste. Spatial
      // navigation filters "below me" candidates with `sibling.top >=
      // current.bottom`, measured with getBoundingClientRect - which reports the
      // TRANSFORMED box. A tile is 29.5vh in a 30vh row, so growing it 6% put
      // its bottom 4px past the next row's top and removed that row from the
      // candidate set: Down skipped to the row after it, and the last row of a
      // library could not be reached at all.
      className="flex shrink-0 flex-col gap-[0.8vh]"
      style={{ width: `${heightVh * (2 / 3)}vh` }}
    >
      <div
        className={[
          "relative overflow-hidden rounded-[0.8vh] bg-white/5",
          focused ? "ring-[0.35vh] ring-white shadow-[0_0.6vh_2vh_rgba(0,0,0,0.55)]" : "",
        ].join(" ")}
        style={{ height: `${heightVh}vh` }}
      >
        {src && !broken ? (
          <img
            src={src}
            alt=""
            decoding="async"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          // A missing poster must not collapse the tile: the row's geometry is
          // what the D-pad navigates against.
          <div className="flex h-full w-full items-center justify-center px-[0.6vh] text-center text-[1.7vh] text-fg-dim">
            {item.title}
          </div>
        )}

        {watched && (
          <div className="absolute top-[0.6vh] right-[0.6vh] rounded-full bg-black/70 p-[0.4vh]">
            <svg viewBox="0 0 24 24" className="h-[1.8vh] w-[1.8vh]" fill="none" stroke="#fff" strokeWidth="3">
              <path d="M4 12.5l5.5 5.5L20 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}

        {pct !== null && (
          <div className="absolute inset-x-0 bottom-0 h-[0.5vh] bg-black/60">
            <div className="h-full bg-white" style={{ width: `${pct * 100}%` }} />
          </div>
        )}

        {item.unwatchedCount ? (
          <div className="absolute top-[0.6vh] left-[0.6vh] rounded-full bg-black/70 px-[0.8vh] py-[0.2vh] text-[1.7vh] tabular-nums">
            {item.unwatchedCount}
          </div>
        ) : null}
      </div>

      {/* Skipped when the poster placeholder is already showing this title:
          otherwise an art-less item prints its name twice, once inside the grey
          box and once beneath it. */}
      {!showsTitleInPlace && (
        <div className="truncate text-[1.8vh]" title={label(item)}>
          {label(item)}
        </div>
      )}
    </div>
  );
}

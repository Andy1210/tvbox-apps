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
  /** Whether the browser scrolls this into view. False when the container moves
   *  itself - see the note at the hook below. */
  selfScroll?: boolean;
  /**
   * Width as a multiple of the height. Default is a 2:3 poster.
   *
   * Extras and trailers are clips, not films: their artwork is 16:9 and their
   * names are sentences ("Behind the Scenes: Building the Ship"), neither of
   * which fits a poster-shaped tile.
   */
  aspect?: number;
  /** Caption lines before it truncates. */
  captionLines?: 2 | 3;
  /** Intercept an arrow before spatial navigation resolves it. */
  onArrowPress?: (direction: string) => boolean;
  /** Seconds until this one starts by itself. Drawn over the poster. */
  /** Over the poster: a countdown's number, or a mark that this one is starting. */
  countdown?: number | string;
}

/** How far through the item, 0-1, or null when it was never started. */
function progress(item: MediaItem): number | null {
  if (!item.viewOffsetMs || !item.durationMs) return null;
  return Math.min(1, item.viewOffsetMs / item.durationMs);
}

function label(item: MediaItem): string {
  if (item.kind !== "episode") return item.title;

  // The episode's own NAME, with its number in front of it. The number alone -
  // which is what a row of episodes used to show - tells you where you are in a
  // series you already know and nothing at all about the one you are choosing
  // from. The series title is dropped here: inside a season it is on the screen
  // already, and outside one the row's own heading carries it.
  return [episodeNumber(item), item.title].filter(Boolean).join(" · ");
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
  selfScroll = true,
  aspect = 2 / 3,
  captionLines = 2,
  onArrowPress,
  countdown,
}: TileProps): React.JSX.Element {
  // scrollIntoView scrolls BOTH axes - `inline` defaults to "nearest" - so a
  // row gets its vertical scrolling from here and then supersedes the horizontal
  // half with its own scrollTo, which gives the focused tile some run-up. That
  // ordering holds only because this hook runs before the effect below.
  // `selfScroll: false` hands the movement to the container, and that is not a
  // tidiness preference: a container that moves itself with a composited
  // transform must not ALSO be scrolled by the browser underneath it, or the
  // two fight and the transform animates against a moving origin.
  const { ref, focused } = useFocusableItem(
    { focusKey, onEnterPress: onEnter, onArrowPress },
    selfScroll ? { block: "nearest" } : undefined,
  );
  const el = useRef<HTMLDivElement | null>(null);
  const backend = useApp((s) => s.backend);
  // The poster is held WITH the url it belongs to. A grid recycles a tile as it
  // scrolls, and holding the blob alone meant the previous film's poster stayed
  // on screen under the new film's title until the next one arrived - and stayed
  // for good on an item that has no artwork at all.
  const [art, setArt] = useState<{ url: string; src: string } | null>(null);
  const src = art && art.url === posterUrl ? art.src : null;
  const [broken, setBroken] = useState(false);
  const pct = progress(item);
  // What "watched" means for a LIST of things is that none of them is left, and
  // its own `viewCount` does not say that: Plex rolls a child's scrobble up into
  // the parent, so marking episodes by hand took one season's count from 2 to 7
  // while its `viewedLeafCount` stayed 0 - a finished tick beside the tile's own
  // "16 unwatched" badge, which unscrobbling the episodes never took back off.
  // `unwatchedCount` is set for a series and a season and for nothing else, so
  // it is also the test for which kind of item this is.
  const watched =
    !pct && (item.unwatchedCount !== undefined ? item.unwatchedCount === 0 : (item.viewCount ?? 0) > 0);
  const showsTitleInPlace = (!src || broken) && item.title !== "";

  // The callback is held in a ref and the effect depends on `focused` alone.
  // Depending on the callback re-ran this on EVERY render - and a caller that
  // sets state from it (a season loading the highlighted episode's details)
  // then rendered again, called again, and the app locked up.
  const notify = useRef(onFocusedEl);
  notify.current = onFocusedEl;
  useEffect(() => {
    if (focused && el.current) notify.current?.(el.current);
  }, [focused]);

  // Artwork is fetched with the credential in a header and shown as a blob, so
  // the token never appears in markup. A failure is not an error: the tile has a
  // title to fall back to.
  useEffect(() => {
    if (!posterUrl || !backend) return;
    let live = true;
    // Reset first: without this a tile that failed once keeps showing its title
    // even after the URL changes under it, and the only cure is an unmount -
    // which is why scrolling away and back appeared to fix it.
    setBroken(false);
    void loadImage(posterUrl, backend.imageHeaders()).then((url) => {
      if (!live) return;
      if (url) setArt({ url: posterUrl, src: url });
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
      style={{ width: `${heightVh * aspect}vh` }}
    >
      <div
        className={[
          "relative overflow-hidden rounded-[0.8vh] bg-white/5",
          focused ? "ring-[0.35vh] ring-white shadow-[0_0.6vh_2vh_rgba(0,0,0,0.55)]" : "",
        ].join(" ")}
        style={{ height: `${heightVh}vh` }}
      >
        {/* Over the poster, not beside it: the countdown is about THIS episode,
            and a number anywhere else is a number about the screen. */}
        {countdown !== undefined && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/55">
            <span className="text-[6vh] font-semibold tabular-nums [text-shadow:0_0.2vh_0.8vh_rgba(0,0,0,0.9)]">
              {countdown}
            </span>
          </div>
        )}
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
      {/* Two lines, at a FIXED height. A trailer rail is what made one line
          useless - "Official Trailer 2" and "Behind the Scenes" cut to the same
          first two words - and letting the caption grow instead would move every
          row below it, which is also what spatial navigation measures against. */}
      {!showsTitleInPlace && (
        <div
          className={`shrink-0 ${captionLines === 3 ? "line-clamp-3" : "line-clamp-2"} text-[1.8vh] leading-[1.5]`}
          style={{ height: `${captionLines * 2.7}vh` }}
          title={label(item)}
        >
          {label(item)}
        </div>
      )}
    </div>
  );
}

/**
 * "S2E34", or nothing when the server did not number it.
 *
 * Shared with the playback overlay rather than written twice: the two would
 * drift, and a number that disagrees with itself between the list and the film
 * is worse than no number.
 */
export function episodeNumber(item: MediaItem): string {
  if (item.kind !== "episode") return "";
  const s = item.parentIndex !== undefined ? `S${item.parentIndex}` : "";
  const e = item.index !== undefined ? `E${item.index}` : "";
  return `${s}${e}`;
}

import { useEffect, useState } from "react";
import { loadImage } from "./posters";
import { useApp } from "./state";
import { log } from "./redact";
import type { MediaItem } from "./backends/types";

/**
 * The artwork behind everything.
 *
 * A black screen behind a row of posters is a lot of nothing on a television,
 * and the server holds a wide backdrop for most titles - 243 of 256 series
 * here. It sits behind the page and follows whatever the cursor is on.
 *
 * Two things it must not do. It must not cover the video: it is skipped while
 * something plays, because this page is transparent then and anything drawn
 * here would sit over the film. And it must not make the text unreadable, which
 * is what the scrim above it is for - the art is a background, not a picture on
 * display, so it is dimmed hard rather than shown at its best.
 */
export function Backdrop({ item }: { item?: MediaItem | null }): React.JSX.Element | null {
  const backend = useApp((s) => s.backend);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!backend || !item?.art) {
      // Keep the last one rather than blanking: moving onto a title that has no
      // backdrop should not flash the screen to black and back.
      return;
    }
    const url = backend.backdropUrl(item, 1280, 720);
    if (!url) return;
    let live = true;
    void loadImage(url, backend.imageHeaders()).then((objectUrl) => {
      if (!live) return;
      // A null answer here used to be silent, which made a backdrop that never
      // appeared indistinguishable from one the item does not have.
      if (objectUrl) setSrc(objectUrl);
      else log.warn("backdrop did not load");
    });
    return () => {
      live = false;
    };
  }, [backend, item?.id, item?.art]);

  if (!src) return null;

  return (
    // z-0 with the page content explicitly above it, rather than a negative
    // index. A fixed element paints above ordinary in-flow content, so it needs
    // a layer of its own and the content needs one too - a negative index left
    // the outcome to whichever ancestor happened to form a stacking context.
    <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
      <img src={src} alt="" className="h-full w-full object-cover" />
      {/* Dark enough that body text keeps its contrast wherever the art is
          light. The horizontal pass keeps the left column - where every screen
          puts its title and synopsis - darker still. */}
      <div className="absolute inset-0 bg-gradient-to-t from-bg-0 via-bg-0/85 to-bg-0/60" />
      <div className="absolute inset-0 bg-gradient-to-r from-bg-0 via-bg-0/70 to-transparent" />
    </div>
  );
}

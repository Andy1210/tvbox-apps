import { useEffect, useRef, useState } from "react";
import { loadImage } from "./posters";
import { useApp } from "./state";

/**
 * The frame the scrub cursor is sitting on.
 *
 * Finding a place in a two-hour film by time alone means guessing. The server
 * already holds a preview index for each file, so the cursor can show what is
 * actually there - which is the whole reason the cursor does not seek until it
 * is committed.
 *
 * Two things shape this:
 *
 * - Requests are debounced and only the LAST one may paint. Holding Right walks
 *   the cursor in large steps, and each step is a separate request; without
 *   this, the frames arrive out of order and the picture flickers backwards
 *   through the film. The in-flight generation is checked on arrival rather than
 *   cancelled, because the image cache means a repeat of the same offset is free
 *   and aborting would throw that away.
 * - The previous frame stays up while the next one loads. Blanking between
 *   frames makes a held press look like the preview is broken; a slightly stale
 *   frame reads as the picture catching up, which is what it is.
 */
export function ScrubPreview({
  partId,
  timeMs,
  widthVh,
}: {
  partId?: string;
  timeMs: number;
  widthVh: number;
}): React.JSX.Element | null {
  const backend = useApp((s) => s.backend);
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const generation = useRef(0);

  // Rounded, so the small adjustments at the end of a held press do not each
  // ask for their own frame: the index has one every few seconds anyway.
  const bucket = Math.round(timeMs / 5000) * 5000;

  useEffect(() => {
    if (!backend || !partId) return;
    // vh is a fraction of the viewport, and the server wants pixels - asking
    // for `16 * widthVh` happened to be right at 1080p and wrong on any other
    // panel height.
    const px = Math.round((widthVh / 100) * window.innerHeight);
    const url = backend.previewUrl(partId, bucket, px, Math.round((px * 9) / 16));
    if (!url) return; // no part id was already handled above

    const mine = ++generation.current;
    const id = setTimeout(() => {
      void loadImage(url, backend.imageHeaders()).then((objectUrl) => {
        if (mine !== generation.current) return;
        // Per frame, not for good. A single failed fetch used to blank the
        // preview for the rest of the gesture even though the next frame would
        // have loaded fine.
        setMissing(!objectUrl);
        if (objectUrl) setSrc(objectUrl);
      });
    }, 120);

    return () => clearTimeout(id);
  }, [backend, partId, bucket, widthVh]);

  // No index for this file, or the server would not render one. The bar and the
  // clock still work, so this is left out rather than replaced with an apology.
  if (missing || !src) return null;

  return (
    <img
      src={src}
      alt=""
      className="rounded-[0.8vh] border-[0.25vh] border-white/80 bg-black object-cover shadow-[0_0_2vh_rgba(0,0,0,0.7)]"
      style={{ width: `${widthVh}vh`, height: `${(widthVh * 9) / 16}vh` }}
    />
  );
}

// Album art, fetched the way the rest of this app fetches artwork.
//
// A poster URL from the backend deliberately carries NO credential - it is paired
// with `imageHeaders()`, so the token never lands in markup, a log or a
// now-playing report. A plain `<img src={posterUrl}>` therefore renders a broken
// image, which is exactly what the first version of these screens did: every
// cover on the box was an empty box with a torn-page icon, and neither the tests
// nor reading the code showed it.
//
// The film side solves this inside Tile; the music screens draw art in four
// places that are not tiles, so the effect lives here once instead of four times.

import { useEffect, useState } from "react";
import { loadImage } from "../posters";
import { useApp } from "../state";

export function useArtwork(url: string | undefined): string | undefined {
  const backend = useApp((s) => s.backend);
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!url || !backend) {
      setSrc(undefined);
      return;
    }
    let live = true;
    // Cleared first, so a row recycled onto another song does not keep showing
    // the previous one's cover while the new one loads.
    setSrc(undefined);
    void loadImage(url, backend.imageHeaders()).then((blobUrl) => {
      if (live) setSrc(blobUrl ?? undefined);
    });
    return () => {
      live = false;
    };
  }, [url, backend]);

  return src;
}

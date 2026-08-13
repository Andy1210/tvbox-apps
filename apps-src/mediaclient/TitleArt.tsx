import { useEffect, useState } from "react";
import { loadImage } from "./posters";
import { useApp } from "./state";

/**
 * A film's own title artwork, in place of its name set in the app's typeface.
 *
 * Servers hold this alongside the poster for some titles and not others, so it
 * is a replacement when present and nothing at all when absent - which means the
 * text has to be the fallback rather than something drawn underneath and
 * covered up.
 *
 * The name stays in the accessibility tree either way: the artwork is a picture
 * of a word, and a screen reader cannot read a picture.
 */
export function TitleArt({ title, logo }: { title: string; logo?: string }): React.JSX.Element {
  const backend = useApp((s) => s.backend);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(null);
    setFailed(false);
    if (!logo || !backend) return;
    let live = true;
    void loadImage(logo, backend.imageHeaders()).then((url) => {
      if (!live) return;
      if (url) setSrc(url);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [logo, backend]);

  if (logo && src && !failed) {
    return (
      <img
        src={src}
        alt={title}
        decoding="async"
        // Bounded by height rather than width: these vary from a compact
        // monogram to a long wordmark, and constraining the width squashes the
        // short ones into a stamp.
        className="max-h-[12vh] max-w-[52vw] self-start object-contain"
      />
    );
  }

  return <h1 className="text-[3.4vh] leading-tight font-semibold tracking-tight">{title}</h1>;
}

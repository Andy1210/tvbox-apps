import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useFocusableItem } from "@sdk";
import { loadImage } from "./posters";
import { useApp } from "./state";
import type { Chapter } from "./backends/types";

/**
 * The film's chapters, as pictures.
 *
 * A chapter list of names is nearly useless on most films, because the server
 * gets the names from the file and most files call them "Chapter 8" - so the
 * frame is the thing that identifies one. The same preview index the scrub
 * cursor uses answers for that, which is why this costs no new server support.
 *
 * It is not on screen by default. It is tall, and the overlay's job while a
 * film is playing is to get out of the way; going DOWN from the transport
 * buttons is the request for it. It opens UNDER them, so the whole overlay
 * lifts and the buttons stay in the order they were reached in.
 */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** 16:9, sized so about five fit across without the row needing to scroll. */
const TILE_VH = 9.5;

/** Both parts, because a file can repeat a chapter index. */
function tileKey(c: Chapter): string {
  return `ch-${c.index}-${c.startMs}`;
}

export function ChapterStrip({
  chapters,
  partId,
  positionMs,
  onPick,
}: {
  chapters: Chapter[];
  partId?: string;
  positionMs: number;
  onPick: (ms: number) => void;
}): React.JSX.Element {
  // Which one is playing, so the strip opens pointing at where you are rather
  // than at the beginning of the film.
  const at = chapters.findIndex((c) => positionMs >= c.startMs && positionMs < c.endMs);
  const here = chapters[at >= 0 ? at : 0];

  // A container with a KEY, so the overlay can send focus here without knowing
  // which chapter that is. `preferredChildFocusKey` decides the first landing
  // and `saveLastFocusedChild` the later ones - opening points at where the
  // film is, and coming back up from the buttons returns to where you left.
  const { ref, focusKey } = useFocusable({
    focusKey: "chapters",
    saveLastFocusedChild: true,
    preferredChildFocusKey: here ? tileKey(here) : undefined,
  });

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="no-scrollbar flex gap-[1vw] overflow-x-auto py-[0.4vh]">
        {chapters.map((c, i) => (
          <ChapterTile
            key={tileKey(c)}
            chapter={c}
            partId={partId}
            playing={i === at}
            onEnter={() => onPick(c.startMs)}
          />
        ))}
      </div>
    </FocusContext.Provider>
  );
}

function ChapterTile({
  chapter,
  partId,
  playing,
  onEnter,
}: {
  chapter: Chapter;
  partId?: string;
  playing: boolean;
  onEnter: () => void;
}): React.JSX.Element {
  const backend = useApp((s) => s.backend);
  const [src, setSrc] = useState<string | null>(null);
  const live = useRef(true);

  const { ref, focused } = useFocusableItem<HTMLButtonElement>(
    { focusKey: tileKey(chapter), onEnterPress: onEnter },
    // Horizontal only, and instant. `scrollIntoView` moves BOTH axes by
    // default, and this strip sits inside the overlay's own column - a
    // vertical nudge here drags the whole control block.
    { block: "nearest", inline: "center" },
  );

  useEffect(() => {
    live.current = true;
    if (!backend) return;
    // The chapter's own thumbnail where the file carries one; the preview index
    // otherwise. Most files here carry neither a useful name nor a thumb, so
    // the index is the common path rather than the fallback.
    const px = Math.round((TILE_VH / 100) * window.innerHeight * (16 / 9));
    const url = chapter.thumb
      ? backend.artUrl(chapter.thumb)
      : partId
        ? backend.previewUrl(partId, chapter.startMs, px, Math.round((px * 9) / 16))
        : undefined;
    if (!url) return;
    void loadImage(url, backend.imageHeaders()).then((objectUrl) => {
      if (live.current && objectUrl) setSrc(objectUrl);
    });
    return () => {
      live.current = false;
    };
  }, [backend, partId, chapter.thumb, chapter.startMs]);

  return (
    <button
      ref={ref}
      type="button"
      className={`shrink-0 overflow-hidden rounded-[0.8vh] text-left transition-[outline] ${
        focused ? "outline outline-[0.3vh] outline-white" : "outline-0"
      }`}
      style={{ width: `${(TILE_VH * 16) / 9}vh` }}
    >
      <div className="relative bg-white/10" style={{ height: `${TILE_VH}vh` }}>
        {src && <img src={src} alt="" className="h-full w-full object-cover" />}
        {/* Where the film is now. The strip is a list of places, and without
            this the only thing saying which one you are in is the bar above. */}
        {playing && <div className="absolute inset-0 ring-[0.3vh] ring-inset ring-white/90" />}
      </div>
      <div className="bg-black/70 px-[0.5vw] py-[0.3vh]">
        <div className="truncate text-[1.5vh]">{chapter.title || clock(chapter.startMs)}</div>
        {chapter.title ? <div className="text-[1.3vh] text-white/70 tabular-nums">{clock(chapter.startMs)}</div> : null}
      </div>
    </button>
  );
}

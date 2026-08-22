// The words, in the panel the queue usually has.
//
// Where the database has timings this is a karaoke view: the line for the
// current second is bright and centred, and the panel follows the song. Where it
// has only text, the D-pad scrolls it - and that is a key listener rather than a
// focusable, because a scrolling box of forty unfocusable lines beside a list of
// songs would otherwise be somewhere the cursor can enter and not leave.

import { useEffect, useRef, useState } from "react";
import { getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "@sdk";
import { fetchLyrics, type Lyrics as LyricsData } from "./lyrics";
import { usePrefs } from "../prefs";
import type { MediaItem } from "../backends/types";

/** How far one press moves the plain view - about two thirds of the panel. */
const SCROLL_STEP = 0.66;

export function Lyrics({
  item,
  positionMs,
  scrollKey,
}: {
  item: MediaItem | undefined;
  positionMs: number;
  /**
   * The one focus key whose arrows scroll this panel.
   *
   * Checked at press time rather than passed as a flag: everything on this
   * screen is a focusable, and a listener that took Up and Down whenever the
   * lyrics were on display would be a screen where the cursor cannot move.
   */
  scrollKey: string;
}): React.JSX.Element {
  const { t } = useI18n();
  // The one thing this app sends outside the house, so it is asked for rather
  // than assumed - and the panel says so instead of showing nothing.
  const enabled = usePrefs((s) => s.lyrics);
  const [data, setData] = useState<LyricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const activeRef = useRef<HTMLParagraphElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const title = item?.title;
  const artist = item?.grandparentTitle ?? item?.parentTitle;
  const album = item?.parentTitle;
  const durationMs = item?.durationMs;

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setData(null);
    void fetchLyrics({ title, artist, album, durationMs }).then((d) => {
      if (!live) return;
      setData(d);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [enabled, title, artist, album, durationMs]);

  const synced = data?.synced ?? [];
  let active = -1;
  for (let i = 0; i < synced.length; i++) {
    if (synced[i].ms <= positionMs) active = i;
    else break;
  }

  useEffect(() => {
    if (active >= 0) activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);

  const plainOnly = !loading && !!data && !data.instrumental && !synced.length && !!data.plain;
  useEffect(() => {
    if (!plainOnly) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (getCurrentFocusKey() !== scrollKey) return;
      const el = boxRef.current;
      if (!el) return;
      const room = el.scrollHeight - el.clientHeight;
      const at = el.scrollTop;
      // At the edge the press falls through, so Up out of the top of the lyrics
      // still reaches the buttons above rather than being swallowed here.
      if ((e.key === "ArrowUp" && at <= 1) || (e.key === "ArrowDown" && at >= room - 1)) return;
      e.preventDefault();
      e.stopPropagation();
      // A held key repeats; an animation restarting on every repeat is slower
      // than no animation at all.
      el.scrollBy({ top: (e.key === "ArrowDown" ? 1 : -1) * el.clientHeight * SCROLL_STEP, behavior: "auto" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [plainOnly, scrollKey]);

  const message = !enabled
    ? t("music.lyricsOff")
    : loading
      ? t("common.loading")
      : !data || (!synced.length && !data.plain && !data.instrumental)
        ? t("music.noLyrics")
        : data.instrumental
          ? t("music.instrumental")
          : null;

  if (message) return <p className="px-[1.5vw] py-[2vh] text-[2.1vh] text-fg-dim">{message}</p>;

  if (synced.length) {
    return (
      <div ref={boxRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[1.5vw]">
        {/* Half a panel of padding at each end, so the first and last lines can
            still reach the middle - a line highlighted at the very bottom of the
            box is one nobody reads in time. */}
        <div className="h-[22vh]" aria-hidden="true" />
        {synced.map((line, i) => (
          <p
            key={`${line.ms}-${i}`}
            ref={i === active ? activeRef : undefined}
            className={[
              "py-[0.5vh] text-[2.4vh] transition-colors",
              i === active ? "font-semibold text-fg" : "text-fg-dim/60",
            ].join(" ")}
          >
            {line.text || " "}
          </p>
        ))}
        <div className="h-[22vh]" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div ref={boxRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[1.5vw]">
      <p className="whitespace-pre-wrap text-[2.2vh] text-fg-dim">{data?.plain}</p>
    </div>
  );
}

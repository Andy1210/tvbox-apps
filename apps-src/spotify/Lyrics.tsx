import { useEffect, useRef, useState } from "react";
import { useI18n } from "@sdk";
import { fetchLyrics, type SpState, type Lyrics as LyricsData } from "./api";

// Lyrics view for the now-playing screen. Fetches from the shell's LRCLIB proxy
// (works cast-only). When time-synced lyrics exist it's a karaoke view: the line
// for the current position is highlighted and auto-scrolled to centre (the big
// vertical padding lets the first/last line reach centre). Falls back to plain
// text, or a "no lyrics" note. Not focusable — it just tracks playback.
export function Lyrics({ state, pos }: { state: SpState; pos: number }) {
  const { t } = useI18n();
  const [data, setData] = useState<LyricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    fetchLyrics(state).then((d) => {
      if (alive) {
        setData(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
    // Key on the QUERY metadata, not just track_id: librespot delivers the new
    // id first (a "loading" event) and the name/artist a beat later, so keying on
    // track_id alone would fetch with the previous song's title and never correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.title, state.artist, state.album, state.duration_ms]);

  const synced = data?.synced || [];
  let active = -1;
  for (let i = 0; i < synced.length; i++) {
    if (synced[i].ms <= pos) active = i;
    else break;
  }

  useEffect(() => {
    if (active >= 0) activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);

  if (loading) return <div className="text-[2.2vh] text-fg-dim">{t("spotify.lyricsLoading")}</div>;
  if (data?.instrumental) return <div className="text-[2.8vh] text-fg-dim">{t("spotify.lyricsInstrumental")}</div>;

  if (synced.length) {
    return (
      <div className="h-full w-full overflow-y-auto no-scrollbar flex flex-col items-center gap-[1.6vh] px-[6vw] py-[40vh]">
        {synced.map((l, i) => (
          <div
            key={i}
            ref={i === active ? activeRef : undefined}
            className={[
              "text-center leading-tight transition-all duration-300 max-w-[80vw]",
              i === active ? "text-[3.6vh] font-bold text-white" : "text-[2.6vh] text-white/40",
            ].join(" ")}
          >
            {l.text || "♪"}
          </div>
        ))}
      </div>
    );
  }

  if (data?.plain) {
    return (
      <div className="h-full overflow-y-auto no-scrollbar max-w-[74vw] whitespace-pre-wrap text-center text-[2.4vh] leading-relaxed text-white/85 py-[10vh]">
        {data.plain}
      </div>
    );
  }

  return <div className="text-[2.6vh] text-fg-dim">{t("spotify.lyricsNone")}</div>;
}

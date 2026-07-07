import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useFocusableItem } from "@sdk";
import { fetchGuide, hhmmEpoch, type Channel, type Guide } from "./api";

// Timeline scale. Horizontal = time (vw), vertical = channels (vh).
const HOUR_VW = 26;
const VW_PER_MIN = HOUR_VW / 60;
const COL_VW = 15; // channel label column width
const ROW_VH = 11;

function ProgBlock({
  fk,
  title,
  timeStr,
  leftVw,
  widthVw,
  isNow,
  onPlay,
}: {
  fk: string;
  title: string;
  timeStr: string;
  leftVw: number;
  widthVw: number;
  isNow: boolean;
  onPlay: () => void;
}) {
  const { ref, focused } = useFocusableItem(
    { focusKey: fk, onEnterPress: onPlay },
    { inline: "center", block: "center", behavior: "smooth" },
  );
  return (
    <div
      ref={ref}
      onClick={onPlay}
      className={[
        "absolute top-[0.5vh] bottom-[0.5vh] rounded-[0.8vh] px-[0.8vw] flex flex-col justify-center overflow-hidden",
        "transition-[transform,background-color,color] duration-150",
        focused ? "!bg-white !text-[#06090d] z-10 scale-[1.02]" : isNow ? "bg-white/[0.16]" : "bg-white/[0.06]",
      ].join(" ")}
      style={{ left: leftVw + "vw", width: widthVw + "vw" }}
    >
      <div className="text-[1.4vh] opacity-70 tabular-nums leading-tight">{timeStr}</div>
      <div className="text-[1.8vh] font-medium truncate leading-tight">{title}</div>
    </div>
  );
}

export function EpgGuide({
  channels,
  onPlay,
  onExit,
}: {
  channels: Channel[];
  onPlay: (c: Channel) => void;
  onExit: () => void;
}) {
  const { t, tag } = useI18n();
  const [data, setData] = useState<Guide | null>(null);
  const { ref, focusKey } = useFocusable({ focusKey: "epg-guide" });

  useEffect(() => {
    fetchGuide().then(setData);
  }, []);
  useBackspace(onExit);

  // initial focus: the live programme of the first channel that has EPG
  useEffect(() => {
    if (!data) return;
    for (let ci = 0; ci < channels.length; ci++) {
      const ps = data.guide[channels[ci].epgId || ""] || [];
      if (!ps.length) continue;
      let pi = ps.findIndex((p) => p.start <= data.now && data.now < p.stop);
      if (pi < 0) pi = 0;
      const id = setTimeout(() => setFocus(`epg-${ci}-${pi}`), 0);
      return () => clearTimeout(id);
    }
  }, [data, channels]);

  if (!data) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
      </div>
    );
  }

  const { from, to, now } = data;
  const timelineVw = ((to - from) / 60) * VW_PER_MIN;
  const nowVw = ((now - from) / 60) * VW_PER_MIN;
  const ticks: number[] = [];
  for (let h = Math.ceil(from / 3600) * 3600; h <= to; h += 3600) ticks.push(h);

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="h-full flex flex-col">
        <div className="px-[4vw] pt-[2.5vh] pb-[1.2vh] text-[2.4vh] font-bold shrink-0">
          {t("livetv.guideTitle")} <span className="text-fg-dim">· {channels[0]?.group}</span>
        </div>
        <div ref={ref} className="flex-1 overflow-auto no-scrollbar relative">
          <div className="relative" style={{ width: `calc(${COL_VW}vw + ${timelineVw}vw)` }}>
            {/* time header */}
            <div className="sticky top-0 z-30 flex h-[5vh] bg-bg-0">
              <div className="sticky left-0 z-40 bg-bg-0" style={{ width: COL_VW + "vw" }} />
              <div className="relative" style={{ width: timelineVw + "vw" }}>
                {ticks.map((h) => (
                  <div
                    key={h}
                    className="absolute top-0 h-[5vh] border-l border-white/10 pl-[0.5vw] text-[1.6vh] text-fg-dim tabular-nums"
                    style={{ left: ((h - from) / 60) * VW_PER_MIN + "vw" }}
                  >
                    {hhmmEpoch(h, tag)}
                  </div>
                ))}
              </div>
            </div>
            {/* now line */}
            <div
              className="absolute top-0 bottom-0 w-[0.15vw] bg-red-500 z-20"
              style={{ left: `calc(${COL_VW}vw + ${nowVw}vw)` }}
            />
            {/* channel rows */}
            {channels.map((ch, ci) => {
              const ps = data.guide[ch.epgId || ""] || [];
              return (
                <div key={ch.id} className="flex border-b border-white/5" style={{ height: ROW_VH + "vh" }}>
                  <div
                    className="sticky left-0 z-30 bg-bg-0 flex items-center gap-[0.6vw] px-[0.8vw]"
                    style={{ width: COL_VW + "vw" }}
                  >
                    {ch.logo ? (
                      <img src={ch.logo} alt="" className="h-[5vh] w-[3.5vw] object-contain shrink-0" />
                    ) : null}
                    <span className="text-[1.7vh] font-medium truncate">{ch.name}</span>
                  </div>
                  <div className="relative" style={{ width: timelineVw + "vw" }}>
                    {ps.length === 0 ? (
                      <div className="absolute left-[1vw] top-1/2 -translate-y-1/2 text-[1.5vh] text-fg-dim/60">
                        {t("livetv.noProgramme")}
                      </div>
                    ) : (
                      ps.map((p, pi) => {
                        const leftVw = Math.max(0, ((p.start - from) / 60) * VW_PER_MIN);
                        const endVw = Math.min(timelineVw, ((p.stop - from) / 60) * VW_PER_MIN);
                        const widthVw = Math.max(3, endVw - leftVw);
                        return (
                          <ProgBlock
                            key={pi}
                            fk={`epg-${ci}-${pi}`}
                            title={p.title}
                            timeStr={hhmmEpoch(p.start, tag)}
                            leftVw={leftVw}
                            widthVw={widthVw}
                            isNow={p.start <= now && now < p.stop}
                            onPlay={() => onPlay(ch)}
                          />
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

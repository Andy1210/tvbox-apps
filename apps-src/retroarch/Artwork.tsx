import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, FocusButton } from "@sdk";
import { fetchArt, startArt, stopArt, shortSystem, type ArtProgress, type ArtSystem } from "./api";

// Covers, from the TV. The box fetches them on its own whenever it is idle
// (lib/art.js), so this screen is for watching that and for asking for it NOW -
// which is what a freshly scanned console needs. Same routes as the phone's Artwork
// page.
const POLL_MS = 1500;

export function Artwork() {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "art-page" });
  const [systems, setSystems] = useState<ArtSystem[]>([]);
  const [progress, setProgress] = useState<ArtProgress | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const load = () =>
      fetchArt()
        .then((d) => {
          setSystems(d.systems);
          setProgress(d.progress);
          setError("");
        })
        .catch(() => setError(t("retroarch.artError")));
    load();
    // Polled rather than pushed: a pass is minutes long and the plugin keeps its
    // progress in memory, so there is nothing to subscribe to.
    timer.current = setInterval(load, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const running = !!progress && progress.running;
  const total = systems.reduce((n, s) => n + s.total, 0);
  const have = systems.reduce((n, s) => n + s.have, 0);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full overflow-y-auto no-scrollbar px-[3vw] pb-[3vh]">
        <div className="flex items-center justify-between gap-[1.5vw] pb-[2vh]">
          <div>
            <div className="text-[2.4vh] font-semibold tabular-nums">
              {have} / {total}
            </div>
            <div className="text-[1.6vh] text-fg-dim">
              {running
                ? progress && progress.listing
                  ? t("retroarch.artListing", { system: progress.system || "" })
                  : t("retroarch.artWorking", {
                      system: progress && progress.system ? shortSystem(progress.system) : "",
                      done: String((progress && progress.done) || 0),
                      todo: String((progress && progress.todo) || 0),
                    })
                : error || t("retroarch.artIdle")}
            </div>
          </div>
          <FocusButton
            focusKey="art-toggle"
            onEnter={() => {
              (running ? stopArt() : startArt()).catch(() => setError(t("retroarch.artError")));
            }}
            className="px-[2vw] py-[1.2vh] rounded-[1.2vh] bg-white/10 text-[1.9vh] font-semibold"
          >
            {running ? t("retroarch.artStop") : t("retroarch.artStart")}
          </FocusButton>
        </div>
        {progress && progress.offline && (
          <div className="text-[1.7vh] text-fg-dim pb-[1vh]">{t("retroarch.artOffline")}</div>
        )}
        <div className="flex flex-col gap-[0.8vh]">
          {systems.map((s) => {
            const pct = s.total ? Math.round((s.have / s.total) * 100) : 0;
            return (
              <div key={s.system} className="px-[1.4vw] py-[1.1vh] rounded-[1vh] bg-white/5">
                <div className="flex items-baseline justify-between gap-[1vw]">
                  <span className="text-[1.8vh] font-semibold truncate">{shortSystem(s.system)}</span>
                  <span className="text-[1.5vh] text-fg-dim tabular-nums shrink-0">
                    {s.have} / {s.total}
                    {s.unavailable ? " · " + t("retroarch.artNoCover", { n: s.unavailable }) : ""}
                  </span>
                </div>
                <div className="mt-[0.7vh] h-[0.6vh] rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full bg-white/70" style={{ width: pct + "%" }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

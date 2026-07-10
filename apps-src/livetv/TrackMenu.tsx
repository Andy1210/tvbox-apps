import { useCallback, useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, FocusButton } from "@sdk";

// In-playback track picker: a full-screen dim over the running video (the page
// is transparent, mpv shows through) listing the stream's audio tracks and
// subtitles + an Off entry. Own focus boundary like the PIN gate: while open,
// LiveTV's raw playback key handler is gated off, so the D-pad moves the focus
// here, Enter applies via window.tvbox.setTrack and Back (useBackspace) closes
// back to playback. Selection is applied optimistically, then confirmed by
// re-querying mpv shortly after (some streams renumber or drop tracks).

// Prefer the track's own title; else the language name for the viewer's locale
// (mpv reports ISO 639 codes like "hun"/"eng"); else the raw code; else Track N.
function trackLabel(track: TvboxTrack, tag: string, fallback: string): string {
  if (track.title) return track.title;
  if (track.lang) {
    try {
      const name = new Intl.DisplayNames([tag], { type: "language" }).of(track.lang);
      if (name) return name;
    } catch {
      /* unknown/invalid code -> raw code */
    }
    return track.lang;
  }
  return fallback;
}

function CheckMark({ visible }: { visible: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={["w-[2.4vh] h-[2.4vh] shrink-0", visible ? "" : "opacity-0"].join(" ")}
    >
      <path d="M4.5 12.5l5 5 10-11" />
    </svg>
  );
}

function TrackRow({
  fk,
  label,
  selected,
  onEnter,
}: {
  fk: string;
  label: string;
  selected: boolean;
  onEnter: () => void;
}) {
  return (
    <FocusButton
      focusKey={fk}
      onEnter={onEnter}
      className="flex items-center justify-between gap-[1vw] px-[1.4vw] py-[1.3vh] rounded-[1vh] bg-white/5 text-[2.1vh] font-medium"
    >
      <span className="truncate">{label}</span>
      <CheckMark visible={selected} />
    </FocusButton>
  );
}

export function TrackMenu({ tracks, onClose }: { tracks: TvboxTrack[]; onClose: () => void }) {
  const { t, tag } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "track-menu", isFocusBoundary: true });
  const [list, setList] = useState<TvboxTrack[]>(tracks);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useBackspace(onClose);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  // initial focus: the selected audio track, else the selected/Off subtitle row
  useEffect(() => {
    const audio = tracks.filter((x) => x.type === "audio");
    const subs = tracks.filter((x) => x.type === "sub");
    const a = audio.find((x) => x.selected) || audio[0];
    const s = subs.find((x) => x.selected);
    const key = a ? `track-audio-${a.id}` : s ? `track-sub-${s.id}` : "track-sub-off";
    const id = setTimeout(() => setFocus(key), 0);
    return () => clearTimeout(id);
    // mount-only on purpose: the opening snapshot decides where focus lands
  }, []);

  const apply = useCallback((type: "audio" | "sub", id: number | "no") => {
    window.tvbox?.setTrack?.(type, id);
    // optimistic checkmark; mpv re-query after ~500ms confirms (or corrects) it
    setList((l) => l.map((x) => (x.type === type ? { ...x, selected: typeof id === "number" && x.id === id } : x)));
    clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => {
      window.tvbox
        ?.tracks?.()
        ?.then((ts) => {
          if (ts.length) setList(ts);
        })
        .catch(() => {});
    }, 500);
  }, []);

  const audio = list.filter((x) => x.type === "audio");
  const subs = list.filter((x) => x.type === "sub");
  const subsOff = !subs.some((x) => x.selected);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center">
        <div className="w-[38vw] min-w-[420px] max-h-[82vh] overflow-y-auto no-scrollbar flex flex-col gap-[1vh] p-[1vh]">
          <div className="text-[2.8vh] font-bold mb-[0.5vh]">{t("livetv.tracksTitle")}</div>
          {audio.length > 0 && (
            <>
              <div className="text-[1.7vh] text-fg-dim font-semibold mt-[1vh]">{t("livetv.tracksAudio")}</div>
              {audio.map((x) => (
                <TrackRow
                  key={x.id}
                  fk={`track-audio-${x.id}`}
                  label={trackLabel(x, tag, t("livetv.trackN", { n: x.id }))}
                  selected={x.selected}
                  onEnter={() => apply("audio", x.id)}
                />
              ))}
            </>
          )}
          {subs.length > 0 && (
            <>
              <div className="text-[1.7vh] text-fg-dim font-semibold mt-[1vh]">{t("livetv.tracksSubtitles")}</div>
              <TrackRow fk="track-sub-off" label={t("livetv.tracksOff")} selected={subsOff} onEnter={() => apply("sub", "no")} />
              {subs.map((x) => (
                <TrackRow
                  key={x.id}
                  fk={`track-sub-${x.id}`}
                  label={trackLabel(x, tag, t("livetv.trackN", { n: x.id }))}
                  selected={x.selected}
                  onEnter={() => apply("sub", x.id)}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

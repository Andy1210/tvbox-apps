import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, FocusButton } from "@sdk";
import { useSpotifyStore } from "./stores/spotify";
import { Lyrics } from "./Lyrics";
import { mmss, control } from "./api";

// transport icons (inline SVG so they render regardless of font)
const ICONS: Record<string, string> = {
  prev: "M7 6v12h2V6H7zm3 6l9 6V6l-9 6z",
  next: "M15 6v12h2V6h-2zM5 6v12l9-6-9-6z",
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zm8 0h4v14h-4z",
};
function TIcon({ name, big }: { name: string; big?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={big ? "w-[4.6vh] h-[4.6vh]" : "w-[3.4vh] h-[3.4vh]"}>
      <path d={ICONS[name]} />
    </svg>
  );
}
function Ctrl({
  fk,
  onEnter,
  big,
  sm,
  children,
}: {
  fk: string;
  onEnter: () => void;
  big?: boolean;
  sm?: boolean;
  children: React.ReactNode;
}) {
  return (
    <FocusButton
      focusKey={fk}
      onEnter={onEnter}
      className={[
        "rounded-full flex items-center justify-center bg-white/10 text-white",
        big ? "w-[9vh] h-[9vh]" : sm ? "w-[5.5vh] h-[5.5vh]" : "w-[7vh] h-[7vh]",
      ].join(" ")}
    >
      {children}
    </FocusButton>
  );
}

// The Spotify "wordmark" circle, for the idle (nothing-casting) screen.
function SpotifyMark() {
  return (
    <svg viewBox="0 0 24 24" className="w-[11vh] h-[11vh] mx-auto" fill="#1DB954">
      <circle cx="12" cy="12" r="11" />
      <path
        d="M6.4 9.7c3.7-1.1 8.2-0.7 11.4 1.2M7 13c3-0.85 6.6-0.5 9 1.1M7.5 16c2.3-0.65 4.9-0.4 6.7 0.8"
        stroke="#0a160f"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-[3vh] h-[3vh]">
      <path d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.68 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.21.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
    </svg>
  );
}

// Cast-only now-playing: a passive, full-screen display of whatever is casting to
// the box. No playback controls (the phone drives playback) — just cover, title,
// artist, album and a locally-ticked progress bar, a gear to device settings, and
// (when an account is connected) a Browse entry. Back exits home; playback keeps
// going on the box.
export function NowPlaying({
  connected,
  onSettings,
  onBrowse,
  onExit,
}: {
  connected: boolean;
  onSettings: () => void;
  onBrowse: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const state = useSpotifyStore((s) => s.state);
  const at = useSpotifyStore((s) => s.at);
  const [, setTick] = useState(0);
  const [showLyrics, setShowLyrics] = useState(false);
  const { ref, focusKey } = useFocusable({ focusKey: "sp-now" });

  // Back closes the lyrics overlay first, then exits to HOME.
  useBackspace(() => {
    if (showLyrics) {
      setShowLyrics(false);
      return;
    }
    onExit();
  });
  const hasTrackNow = !!state?.track_id;
  useEffect(() => {
    const id = setTimeout(() => setFocus(connected ? (hasTrackNow ? "sp-playpause" : "sp-browse") : "sp-gear"), 0);
    return () => clearTimeout(id);
  }, [connected, hasTrackNow]);
  // tick the progress bar / lyrics position locally between SSE pushes (faster
  // while lyrics are shown so the karaoke highlight stays close to the audio)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), showLyrics ? 250 : 1000);
    return () => clearInterval(id);
  }, [showLyrics]);
  // close lyrics when playback stops; focus the toggle when opening them
  useEffect(() => {
    if (!hasTrackNow) setShowLyrics(false);
  }, [hasTrackNow]);
  useEffect(() => {
    if (showLyrics) setFocus("sp-lyrics");
  }, [showLyrics]);
  // remote media keys -> Web API control (only meaningful when connected)
  useEffect(() => {
    if (!connected) return;
    const MEDIA: Record<string, string> = {
      MediaPlayPause: "playpause",
      MediaPlay: "play",
      MediaPause: "pause",
      MediaTrackNext: "next",
      MediaTrackPrevious: "prev",
      MediaFastForward: "next",
      MediaRewind: "prev",
    };
    const onKey = (e: KeyboardEvent) => {
      const a = MEDIA[e.key];
      if (a) {
        e.preventDefault();
        doControl(a);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [connected]);

  const playing = !!state?.is_playing;
  // transport errors (Development Mode 403 etc.) show as a transient hint
  // instead of silently dead buttons
  const [ctrlErr, setCtrlErr] = useState("");
  useEffect(() => {
    if (!ctrlErr) return;
    const id = setTimeout(() => setCtrlErr(""), 8000);
    return () => clearTimeout(id);
  }, [ctrlErr]);
  const doControl = (a: string) =>
    void control(a).then((err) => {
      if (err) setCtrlErr(/not registered|HTTP 403/i.test(err) ? t("spotify.notRegistered") : t("spotify.apiError", { error: err }));
    });
  const pos = state ? Math.min(state.position_ms + (playing ? Date.now() - at : 0), state.duration_ms || Infinity) : 0;
  const pct = state && state.duration_ms ? Math.min(100, (pos / state.duration_ms) * 100) : 0;
  const hasTrack = !!state?.track_id;
  const device = state?.device_name || "tvbox";

  return (
    <FocusContext.Provider value={focusKey}>
      {/* overflow-CLIP, not hidden: a hidden box is still programmatically
          scrollable, and the lyrics scrollIntoView scrolls every scrollable
          ancestor - the scale-105 backdrop overflows this box at the bottom, so
          the view used to get nudged up, dragging the inset-0 dim layers along
          and letting the backdrop peek out undimmed. clip forbids scrolling. */}
      <div ref={ref} className="relative h-full overflow-clip">
        {(state?.artist_image_url || state?.cover_url) && (
          <div
            className="absolute inset-0 bg-cover bg-center scale-105 blur-[0.6vh] opacity-85"
            style={{ backgroundImage: `url(${state.artist_image_url || state.cover_url})` }}
          />
        )}
        {/* lighter than before so the artist photo stays visible; darker toward the
            bottom where title/controls sit, for legibility */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/30 to-black/80" />
        {/* lyrics need a readable backdrop — darken the artist photo well below the
            now-playing treatment while the (full-screen) lyrics are shown */}
        {showLyrics && <div className="absolute inset-0 bg-black/60" />}

        {connected && (
          <FocusButton
            focusKey="sp-browse"
            onEnter={onBrowse}
            className="absolute top-[3vh] left-[3vw] z-20 px-[2vw] py-[1.2vh] rounded-full bg-white/10 flex items-center gap-[0.6vw] text-white text-[1.9vh] font-semibold"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-[2.4vh] h-[2.4vh]">
              <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" />
            </svg>
            {t("spotify.browse")}
          </FocusButton>
        )}

        <FocusButton
          focusKey="sp-gear"
          onEnter={onSettings}
          className="absolute top-[3vh] right-[3vw] z-20 w-[6vh] h-[6vh] rounded-full bg-white/10 flex items-center justify-center text-white"
        >
          <GearIcon />
        </FocusButton>

        {hasTrack && (
          <FocusButton
            focusKey="sp-lyrics"
            onEnter={() => setShowLyrics((v) => !v)}
            className={[
              "absolute top-[3vh] left-1/2 -translate-x-1/2 z-20 px-[2vw] py-[1.2vh] rounded-full flex items-center gap-[0.6vw] text-[1.9vh] font-semibold",
              showLyrics ? "bg-[#1DB954] text-[#06120b]" : "bg-white/10 text-white",
            ].join(" ")}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-[2.4vh] h-[2.4vh]">
              <path d="M4 5h16v2H4zm0 4h10v2H4zm0 4h16v2H4zm0 4h10v2H4z" />
            </svg>
            {t("spotify.lyrics")}
          </FocusButton>
        )}

        {/* while reading lyrics, keep a compact playback strip (state + small
            transport controls) under the Lyrics button */}
        {showLyrics && hasTrack && (
          <div className="absolute top-[11vh] left-1/2 -translate-x-1/2 z-20 w-[56vw] max-w-[720px] flex flex-col items-center gap-[1vh] rounded-[1.6vh] bg-black/35 px-[2.5vw] py-[1.4vh]">
            <div className="text-[1.8vh] text-white/85 truncate max-w-full text-center">
              {state!.title}
              <span className="text-white/45"> · {state!.artist}</span>
            </div>
            <div className="w-full">
              <div className="h-[0.5vh] rounded-full bg-white/15 overflow-hidden">
                <div className="h-full bg-[#1DB954]" style={{ width: pct + "%" }} />
              </div>
              <div className="flex justify-between text-[1.3vh] text-fg-dim mt-[0.4vh] tabular-nums">
                <span>{mmss(pos)}</span>
                <span>{mmss(state!.duration_ms)}</span>
              </div>
            </div>
            {connected && (
              <div className="flex items-center gap-[1.2vw] mt-[0.2vh]">
                <Ctrl fk="sp-prev" sm onEnter={() => doControl("prev")}>
                  <TIcon name="prev" />
                </Ctrl>
                <Ctrl fk="sp-playpause" sm onEnter={() => doControl("playpause")}>
                  <TIcon name={playing ? "pause" : "play"} />
                </Ctrl>
                <Ctrl fk="sp-next" sm onEnter={() => doControl("next")}>
                  <TIcon name="next" />
                </Ctrl>
              </div>
            )}
            {ctrlErr && <div className="text-[1.5vh] text-warn mt-[0.4vh] max-w-[40vw]">{ctrlErr}</div>}
          </div>
        )}

        <div
          className={[
            "relative z-10 h-full flex flex-col items-center justify-center gap-[2.4vh] px-[6vw]",
            // while lyrics are open, start the content below the absolute playback
            // strip (top-[11vh] + its height, taller when transport controls show)
            // so the lyrics scroll area never underlaps it
            hasTrack && showLyrics ? (connected ? "pt-[29vh]" : "pt-[22vh]") : "",
          ].join(" ")}
        >
          {hasTrack && showLyrics ? (
            <Lyrics state={state!} pos={pos} />
          ) : hasTrack ? (
            <>
              {state!.cover_url ? (
                <img
                  src={state!.cover_url}
                  alt=""
                  className="w-[40vh] h-[40vh] rounded-[1.6vh] shadow-[0_2vh_6vh_rgba(0,0,0,0.6)] object-cover"
                />
              ) : (
                <div className="w-[40vh] h-[40vh] rounded-[1.6vh] bg-white/10 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-[16vh] h-[16vh] text-white/30">
                    <path d="M9 17.5a2.5 2.5 0 1 1-2.5-2.5c.36 0 .7.08 1 .21V6l9-2v8.5a2.5 2.5 0 1 1-2.5-2.5c.36 0 .7.08 1 .21V6.24L9 7.6v9.9z" />
                  </svg>
                </div>
              )}
              <div className="text-center max-w-[74vw]">
                <div className="text-[3.6vh] font-bold truncate">{state!.title}</div>
                <div className="text-[2.3vh] text-fg-dim truncate mt-[0.4vh]">{state!.artist}</div>
                {state!.album && <div className="text-[1.8vh] text-fg-dim/70 truncate mt-[0.3vh]">{state!.album}</div>}
              </div>
              <div className="w-[60vw] max-w-[820px]">
                <div className="h-[0.6vh] rounded-full bg-white/15 overflow-hidden">
                  <div className="h-full bg-[#1DB954]" style={{ width: pct + "%" }} />
                </div>
                <div className="flex justify-between text-[1.5vh] text-fg-dim mt-[0.6vh] tabular-nums">
                  <span>{mmss(pos)}</span>
                  <span>{mmss(state!.duration_ms)}</span>
                </div>
              </div>
              {connected ? (
                <div className="flex items-center gap-[1.5vw] mt-[0.8vh]">
                  <Ctrl fk="sp-prev" onEnter={() => control("prev")}>
                    <TIcon name="prev" />
                  </Ctrl>
                  <Ctrl fk="sp-playpause" big onEnter={() => control("playpause")}>
                    <TIcon name={playing ? "pause" : "play"} big />
                  </Ctrl>
                  <Ctrl fk="sp-next" onEnter={() => control("next")}>
                    <TIcon name="next" />
                  </Ctrl>
                </div>
              ) : (
                <div className="flex items-center gap-[0.8vw] text-[1.8vh] text-fg-dim mt-[0.5vh]">
                  <span className={"w-[1.2vh] h-[1.2vh] rounded-full " + (playing ? "bg-[#1DB954]" : "bg-white/40")} />
                  {t("spotify.controlHint", { device })}
                </div>
              )}
            </>
          ) : (
            <div className="text-center">
              <SpotifyMark />
              <div className="text-[3vh] font-semibold mt-[2vh]">{t("spotify.notPlaying")}</div>
              <div className="text-[2.1vh] text-fg-dim mt-[1.2vh] max-w-[62vw] mx-auto">
                {t("spotify.castHint", { device })}
              </div>
            </div>
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

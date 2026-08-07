import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, isBackKey, postNowPlaying } from "@sdk";
import { baseName, formatTime, type Entry } from "./api";
import { remember } from "./resume";
import { TrackMenu } from "./TrackMenu";

// Playing a file, which on this box means the shell's mpv behind a transparent
// page: everything here is an overlay drawn over the film.
//
// A recording is not a live channel, so this screen owns the three things Live TV
// never needed - hold it, jump around in it, and remember where it got to. The
// position comes from the player's own events rather than a timer of ours: mpv is
// the clock, and after a seek only it knows where playback actually landed.
//
// There is no focusable control on this screen on purpose. A film fills the
// picture and a remote has arrows: focus rings over a film would be the one thing
// on screen, and every one of them would need a second press to reach.

const SEEK_ARROW = 10; // seconds - the arrows, for finding the line you missed
const SEEK_MEDIA = 60; // seconds - the dedicated rewind/forward keys
const BANNER_MS = 5000;

export function Player({
  file,
  startPos,
  onStop,
  onEnded,
}: {
  file: Entry;
  startPos: number;
  onStop: () => void;
  onEnded: () => void;
}) {
  const { t } = useI18n();
  const [pos, setPos] = useState(startPos);
  const [dur, setDur] = useState(0);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [started, setStarted] = useState(false); // the first frame has been seen
  const [banner, setBanner] = useState(true);
  // Bumped by anything that should restart the banner's countdown. The countdown
  // cannot depend on the position: mpv reports one per frame, so the timeout would
  // be re-armed twenty times a second and the banner would never leave the screen.
  const [bannerSeq, setBannerSeq] = useState(0);
  const [tracks, setTracks] = useState<TvboxTrack[]>([]);
  const [trackMenu, setTrackMenu] = useState(false);
  const tracksLoaded = useRef(false);
  // The last position/duration seen, for the seek arithmetic and for the resume
  // point written on the way out - both run outside React's render cycle.
  const live = useRef({ pos: startPos, dur: 0 });

  const title = baseName(file.name);
  // An older shell exposes no player at all. Without this the screen is a spinner
  // that never resolves and only Back leaves - the app has to say what happened.
  const canPlay = !!window.tvbox?.play;

  // Start it. `startPos` reaches mpv as its own --start, so a resumed film opens
  // at the right frame instead of jumping there once playback is under way.
  useEffect(() => {
    if (!canPlay) return;
    window.tvbox?.play?.(file.path, undefined, startPos);
    postNowPlaying({ app: "files", state: "playing", title });
    // file.path identifies the film; startPos/title are decided with it
  }, [file.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember where this got to. On the way out, whatever the reason - the film
  // ran out (the store drops it), the user left, or the next one is starting.
  useEffect(() => {
    const path = file.path;
    return () => {
      void remember(path, live.current.pos, live.current.dur);
    };
  }, [file.path]);

  // Home is the ordinary way to abandon a film, and it does NOT unmount this
  // screen: the shell stops mpv and HIDES the window, so without this the position
  // would never be written, the box would report a film playing for the rest of its
  // uptime (which is also what stops it from applying updates while it is idle),
  // and coming back would show a live-looking overlay over a dead player.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) onStop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [onStop]);

  const refreshTracks = useCallback(() => {
    window.tvbox
      ?.tracks?.()
      ?.then(setTracks)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!window.tvbox?.onPlayer) return;
    return window.tvbox.onPlayer((ev) => {
      if (ev.type === "buffering") setBuffering(!!ev.on);
      else if (ev.type === "position") {
        const s = (ev.ms || 0) / 1000;
        live.current.pos = s;
        setPos(s);
      } else if (ev.type === "duration") {
        const s = (ev.ms || 0) / 1000;
        live.current.dur = s;
        setDur(s);
      } else if (ev.type === "playing") {
        setBuffering(false);
        setStarted(true);
        // "playing" arrives with every position update, not once - so the track
        // list is read for this file the first time and not twenty times a second.
        if (!tracksLoaded.current) {
          tracksLoaded.current = true;
          refreshTracks();
        }
      } else if (ev.type === "error") onStop();
      else if (ev.type === "finished") {
        // A stop of our own, or the TV going to standby, is not the end of a
        // film: only a film that ran out earns the next one.
        if (ev.reason) onStop();
        else onEnded();
      }
    });
  }, [refreshTracks, onStop, onEnded]);

  const showBanner = useCallback(() => {
    setBanner(true);
    setBannerSeq((s) => s + 1);
  }, []);
  useEffect(() => {
    if (!banner || paused) return; // a held film keeps its banner: that IS the state
    const id = setTimeout(() => setBanner(false), BANNER_MS);
    return () => clearTimeout(id);
  }, [banner, paused, bannerSeq]);

  const togglePause = useCallback(() => {
    // Only claim the state the shell can actually be in: an older bridge has no
    // pause, and a screen that says "Paused" over a film that is still running is
    // worse than a button that does nothing.
    if (!window.tvbox?.pause || !window.tvbox?.resume) return;
    const nowPaused = !paused;
    setPaused(nowPaused);
    if (nowPaused) {
      window.tvbox?.pause?.();
      // A pause is the one moment mid-film when the position is worth writing
      // down: a box that loses power between here and the end keeps it.
      void remember(file.path, live.current.pos, live.current.dur);
    } else {
      window.tvbox?.resume?.();
    }
    postNowPlaying({ app: "files", state: nowPaused ? "paused" : "playing", title });
    showBanner();
  }, [paused, title, file.path, showBanner]);

  const seekBy = useCallback(
    (delta: number) => {
      if (!window.tvbox?.seek) return; // same as pause: do not move a position we cannot move
      const d = live.current.dur;
      const to = Math.max(0, d ? Math.min(d - 1, live.current.pos + delta) : live.current.pos + delta);
      live.current.pos = to;
      setPos(to);
      showBanner();
      window.tvbox?.seek?.(to);
    },
    [showBanner],
  );

  const audioCount = tracks.filter((x) => x.type === "audio").length;
  const subCount = tracks.filter((x) => x.type === "sub").length;
  const tracksAvailable = audioCount >= 2 || subCount >= 1;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (trackMenu) return; // the picker owns the keys while it is open
      // Back arrives as Backspace, Escape, BrowserBack or GoBack depending on how
      // the box is being driven; never check one key.
      if (isBackKey(ev) || ev.key === "MediaStop") {
        ev.preventDefault();
        onStop();
        return;
      }
      switch (ev.key) {
        case "Enter":
        case "MediaPlayPause":
        case "MediaPlay":
        case "MediaPause":
          togglePause();
          break;
        case "ArrowLeft":
          seekBy(-SEEK_ARROW);
          break;
        case "ArrowRight":
          seekBy(SEEK_ARROW);
          break;
        case "MediaRewind":
          seekBy(-SEEK_MEDIA);
          break;
        case "MediaFastForward":
          seekBy(SEEK_MEDIA);
          break;
        case "ArrowUp":
          if (tracksAvailable) {
            refreshTracks(); // in case mpv renumbered them since the file loaded
            setTrackMenu(true);
          } else showBanner();
          break;
        case "ArrowDown":
          showBanner();
          break;
        default:
          return;
      }
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [trackMenu, togglePause, seekBy, showBanner, onStop, tracksAvailable, refreshTracks]);

  const progress = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;

  return (
    <div className="fixed inset-0 pointer-events-none">
      {!canPlay && (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-[2vh] px-[10vw] text-center">
          <div className="text-[2.4vh] font-semibold">{title}</div>
          <div className="text-[2vh] text-fg-dim">{t("files.errUnsupported")}</div>
        </div>
      )}
      {/* Before the first frame the page is still opaque, so this IS the screen.
          Mid-film it must not be: a stick that stalls for a second would black out
          a picture that is about to carry on. */}
      {canPlay && buffering && !started && (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-[2vh]">
          <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
          <div className="text-[2.4vh] font-semibold px-[10vw] text-center truncate">{title}</div>
        </div>
      )}
      {buffering && started && (
        <div className="absolute top-[4vh] right-[4vw] w-[4vh] h-[4vh] rounded-full border-[0.4vh] border-white/20 border-t-white animate-spin" />
      )}

      <div
        className={[
          "absolute left-0 right-0 bottom-0 p-[4vh_4vw] transition-[opacity,transform] duration-300",
          "bg-gradient-to-t from-black/90 via-black/60 to-transparent",
          banner && !buffering ? "opacity-100 translate-y-0" : "opacity-0 translate-y-[3vh]",
        ].join(" ")}
      >
        <div className="text-[3vh] font-bold leading-tight truncate">{title}</div>
        <div className="flex items-center gap-[1.2vw] mt-[1.5vh]">
          <div className="text-[1.9vh] tabular-nums">{formatTime(pos)}</div>
          <div className="flex-1 h-[0.6vh] rounded-full bg-white/20 overflow-hidden">
            <div className="h-full bg-white" style={{ width: progress + "%" }} />
          </div>
          <div className="text-[1.9vh] tabular-nums text-fg-dim">{dur > 0 ? formatTime(dur) : "--:--"}</div>
        </div>
        <div className="text-[1.6vh] text-fg-dim mt-[1.2vh]">
          {paused ? t("files.paused") + " · " : ""}
          {t("files.playerHint")}
          {tracksAvailable ? " · " + t("files.playerTracksHint") : ""}
        </div>
      </div>

      {trackMenu && (
        <div className="pointer-events-auto">
          <TrackMenu tracks={tracks} onClose={() => setTrackMenu(false)} />
        </div>
      )}
    </div>
  );
}

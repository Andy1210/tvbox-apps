import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useFocusableItem, FocusButton } from "@sdk";
import { useSpotifyStore } from "./stores/spotify";
import { Lyrics } from "./Lyrics";
import { focusLost, jump } from "./focus";
import { mmss, control, fetchQueue, playerState, type PlayerState, type QueueItem, type Repeat } from "./api";

/**
 * How long the screen goes untouched before the queue panel steps back.
 *
 * The panel answers "what is next", which is a question asked once and then
 * finished with - after that it is a list of text over somebody's album art. Any
 * press brings it back, and so does the next song, which is the other moment the
 * question comes up.
 */
const PANEL_IDLE_MS = 10_000;

/** How far one press carries the seek cursor. */
const SEEK_STEP_MS = 10_000;
/**
 * How long a committed seek's position is shown before the box's clock wins.
 *
 * Long enough to cover the write and the SSE push after it, short enough that a
 * seek the account refused corrects itself while somebody is still looking.
 */
const SEEK_SETTLE_MS = 5_000;

// transport icons (inline SVG so they render regardless of font)
const ICONS: Record<string, string> = {
  prev: "M7 6v12h2V6H7zm3 6l9 6V6l-9 6z",
  next: "M15 6v12h2V6h-2zM5 6v12l9-6-9-6z",
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zm8 0h4v14h-4z",
  shuffle:
    "M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z",
  repeat: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z",
  repeat_one: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z",
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
  on,
  label,
  children,
}: {
  fk: string;
  onEnter: () => void;
  big?: boolean;
  sm?: boolean;
  on?: boolean; // a setting that is currently active (shuffle, repeat)
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <FocusButton
      focusKey={fk}
      onEnter={onEnter}
      label={label}
      className={[
        "rounded-full flex items-center justify-center",
        // Shuffle and repeat are settings rather than commands, so they have a
        // state to show. Green fill is the same "on" the app uses everywhere; the
        // focus ring still overrides it, so the two never read as one thing.
        on ? "bg-[#1DB954] text-[#06120b]" : "bg-white/10 text-white",
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
  note,
  lyrics,
  onNoteDone,
  onSettings,
  onBrowse,
  onExit,
}: {
  connected: boolean;
  /** What a spoken request is doing, or why it did nothing. Empty means none. */
  note?: string;
  /**
   * A spoken lyrics request. `at` is what distinguishes the same one asked twice.
   */
  lyrics?: { state: string; at: number } | null;
  onNoteDone?: () => void;
  onSettings: () => void;
  onBrowse: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const state = useSpotifyStore((s) => s.state);
  const at = useSpotifyStore((s) => s.at);
  const [, setTick] = useState(0);
  const [showLyrics, setShowLyrics] = useState(false);
  /** Where the seek cursor points while it is out; null means there is none. */
  const [seekMs, setSeekMs] = useState<number | null>(null);
  /**
   * Where a committed seek asked to go, until the box says it got there.
   *
   * Playback position arrives over SSE from librespot, a beat after the write -
   * so without this the bar snaps back to where the song WAS the moment OK is
   * pressed, and jumps forward again a second later.
   *
   * The timestamp is the important half. The first cut kept the target while the
   * report was more than three seconds away from it - which is true again as soon
   * as playback moves PAST it, so once the song had run three seconds beyond the
   * seek the bar reverted to the target and froze there for the rest of the
   * track. Measured on the box: 0:44 for twenty-four seconds while the music
   * played. It is a short window after a press, not a rule about distance, and it
   * closes on its own - which is also what lets a REFUSED seek recover, since
   * nothing would ever supersede one that went backwards.
   */
  const [seekedTo, setSeekedTo] = useState<{ at: number; ms: number } | null>(null);
  /** What is coming next, and whether the panel is on display. */
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [panel, setPanel] = useState(true);
  // Where focus goes when it has to come back to this screen without being told
  // where. That happens on its own: shuffle and repeat mount and unmount with
  // what the box is doing, and when the one holding focus goes, the library
  // clears the parent's last-focused child and falls back to the element nearest
  // the top-left — the Browse pill, in the opposite corner from the row the
  // person was on. The play button is the neighbour, and it is always there.
  const { ref, focusKey } = useFocusable({ focusKey: "sp-now", preferredChildFocusKey: "sp-playpause" });

  // Back puts the seek cursor away first - while it is out, it is the only thing
  // on screen that a press could be about - then closes the lyrics, then leaves.
  useBackspace(() => {
    if (seekMs !== null) {
      setSeekMs(null);
      return;
    }
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
  // A spoken request. The functional setter is what makes "toggle" mean the value
  // on screen rather than the one this effect closed over, and the dependency is
  // the request alone: re-running it whenever the track ticks would put the
  // lyrics back up after somebody pressed them away.
  useEffect(() => {
    if (!lyrics) return;
    const want = String(lyrics.state || "on");
    setShowLyrics((shown) => (want === "toggle" ? !shown : want !== "off"));
  }, [lyrics]);

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
  // A spoken request's answer goes away by itself too: it is a line about a press
  // nobody in the room made, so nothing here can be waiting to dismiss it.
  useEffect(() => {
    if (!note || !onNoteDone) return;
    const id = setTimeout(onNoteDone, 8000);
    return () => clearTimeout(id);
  }, [note, onNoteDone]);
  // Shuffle and repeat are player-wide SETTINGS, and the cast metadata does not
  // carry them - so they are read back from the Web API rather than assumed from
  // what was last pressed. The phone can change either of them too, which is why
  // this also re-reads when the track changes.
  const [player, setPlayer] = useState<PlayerState | null>(null);
  // Reads can overtake each other (a track change and a toggle fire one each), and
  // the loser would put the older answer on screen. Only the newest is allowed to
  // land.
  const readSeq = useRef(0);
  const refreshPlayer = () => {
    if (!connected) return;
    const seq = ++readSeq.current;
    void playerState().then((p) => {
      if (seq === readSeq.current) setPlayer(p);
    });
  };
  useEffect(refreshPlayer, [connected, state?.track_id]);
  // A phone can change shuffle or repeat without the track changing, and then the
  // buttons show the wrong thing and the next repeat press picks the wrong mode
  // from it. There is no event for that, so this screen re-reads while it is the
  // one on display. It only exists while it is, so the poll stops with it.
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(refreshPlayer, 20000);
    return () => clearInterval(id);
  }, [connected]);
  const repeatNext: Record<Repeat, Repeat> = { off: "context", context: "track", track: "off" };
  const repeat: Repeat = player?.repeat || "off";
  // The read is about the box (the server asks the account holding it), so this
  // is the second half of the same rule rather than a workaround for the first:
  // shuffle and repeat are settings of a player that is RUNNING, and shown for
  // one that is not they are a claim about nothing. `active` as well as the name,
  // because a player that stopped still carries the device it last played on.
  // The two names come from different places: the Web API's device list, and what
  // librespot was told to call itself. Fold them the same way the box does server
  // side, or a difference in case or a stray space hides the settings on the very
  // box they belong to.
  const sameDevice = (a: string, b: string) => !!a.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();
  const onThisBox = !!player?.ok && !!player.active && sameDevice(player.device || "", state?.device_name || "");

  // The net under that: a focus key can outlive the element it named, and then no
  // arrow goes anywhere - a remote that has stopped working, with no way back.
  useEffect(() => {
    const id = setTimeout(() => {
      if (focusLost()) jump("sp-playpause", "sp-browse", "sp-gear");
    }, 60);
    return () => clearTimeout(id);
  }, [onThisBox, connected, hasTrackNow]);

  // Why a press did nothing. The box_* answers are the ones that are not Spotify
  // refusing us: the box is held by an account this box has not linked, or it is
  // not addressable as a device at all. Each needs a different thing done about
  // it, and none of them is "Spotify error" - which is what they all used to read
  // as, on a screen whose buttons had just silently reached another room.
  const ctrlMessage = (err: string) => {
    if (err === "box_other_account") return t("spotify.otherAccount");
    if (err === "box_not_found") return t("spotify.boxNotFound");
    if (err === "box_unreachable") return t("spotify.boxUnreachable");
    return /not registered|HTTP 403/i.test(err) ? t("spotify.notRegistered") : t("spotify.apiError", { error: err });
  };

  const doControl = (a: string, v?: boolean | string) =>
    void control(a, v).then((err) => {
      if (err) setCtrlErr(ctrlMessage(err));
      else refreshPlayer();
    });

  // A setting is shown as pressed straight away and confirmed a moment later:
  // Spotify can still answer /me/player with the pre-toggle value right after
  // accepting the write, and a button that flicks back looks broken. The delayed
  // re-read is what corrects it if the write did not take after all.
  const setSetting = (a: "shuffle" | "repeat", v: boolean | Repeat) => {
    // Bumping the sequence is what makes the optimistic value stick: a read that
    // was already in flight when the button was pressed carries the pre-toggle
    // value, and without this it would land afterwards and turn the button back.
    readSeq.current++;
    setPlayer((p) => ({
      ok: true,
      connected: true,
      device: p?.device,
      active: p?.active ?? true,
      is_playing: p?.is_playing,
      shuffle: a === "shuffle" ? (v as boolean) : (p?.shuffle ?? false),
      repeat: a === "repeat" ? (v as Repeat) : (p?.repeat ?? "off"),
    }));
    void control(a, v).then((err) => {
      if (err) setCtrlErr(ctrlMessage(err));
      setTimeout(refreshPlayer, 700);
    });
  };
  /**
   * The panel steps back on its own, and every press brings it forward.
   *
   * Only while a song is PLAYING: paused or idle, this screen already asks the
   * box for its screensaver (see Spotify.tsx), and a panel fading out on its own
   * clock underneath that is two things dimming the same screen.
   */
  const trackId = state?.track_id;
  // A new song is a new clock: an optimistic position from the last one would
  // otherwise hold the bar somewhere in the middle of it.
  useEffect(() => setSeekedTo(null), [trackId]);
  useEffect(() => {
    setPanel(true);
    if (!playing) return;
    let timer = 0;
    const arm = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPanel(false), PANEL_IDLE_MS);
    };
    const wake = (): void => {
      setPanel(true);
      arm();
    };
    arm();
    window.addEventListener("keydown", wake, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", wake, true);
    };
    // The track is a dependency on purpose: the next song is the other moment
    // "what is next" is worth answering.
  }, [playing, trackId]);

  /**
   * What is queued, read when the track changes and only while it can be shown.
   *
   * The rows are not focusable: Spotify has no way to jump to an arbitrary
   * position in a queue, so a row that took the cursor would be a press that
   * cannot do anything - and it would also be a focusable this panel takes away
   * when it steps back.
   */
  useEffect(() => {
    if (!connected || !panel || !hasTrackNow) return;
    let live = true;
    // Cleared first: the rows belong to the song that was playing, and a read
    // takes a moment - so without this the panel says "up next" over the
    // previous track's queue for as long as the request is in the air.
    setQueue([]);
    void fetchQueue().then((q) => {
      if (live) setQueue(q.ok ? q.items : []);
    });
    return () => {
      live = false;
    };
  }, [connected, panel, hasTrackNow, trackId]);

  const reported = state
    ? Math.min(state.position_ms + (playing ? Date.now() - at : 0), state.duration_ms || Infinity)
    : 0;
  // The asked-for place until the box reports somewhere near it, then the box's
  // own clock again.
  // The asked-for place for a few seconds after the press, and only while the box
  // still disagrees with it. Both halves matter: the box's clock takes over the
  // moment it agrees, and the window ends whatever happens.
  const optimistic =
    seekedTo !== null && Date.now() - seekedTo.at < SEEK_SETTLE_MS && Math.abs(reported - seekedTo.ms) > 3000;
  const pos = optimistic ? seekedTo.ms : reported;
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
          </div>
        )}

        {/* Why a press did nothing, and the standing case of it: an account this
            box has not linked is driving the music, so none of these buttons can
            reach it. Anchored to the bottom of the screen rather than placed in
            the column, for two reasons - it does not shove the cover and the
            controls upwards as it appears, and it is in the same place whether
            the lyrics are open or not. On its own backdrop, because the layer
            underneath is somebody's album art and amber prose on a bright photo
            is not readable from a sofa. */}
        {(note || (connected && (ctrlErr || player?.otherAccount))) && (
          // left+right rather than a centred max-width: a shrink-to-fit box that
          // starts at the middle of the screen has 50vw to work with, so the long
          // messages (the Development Mode one is 190 characters) wrapped to four
          // lines and grew up into the controls.
          <div className="absolute bottom-[3vh] left-[15vw] right-[15vw] z-30 rounded-[1.4vh] bg-black/70 px-[2.4vw] py-[1.2vh] text-center text-[2.1vh] text-warn">
            {note || ctrlErr || t("spotify.otherAccount")}
          </div>
        )}

        <div className="relative z-10 h-full">
          <div
            className={[
              "h-full flex flex-col items-center justify-center gap-[2.4vh] px-[6vw]",
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
                  {state!.album && (
                    <div className="text-[1.8vh] text-fg-dim/70 truncate mt-[0.3vh]">{state!.album}</div>
                  )}
                </div>
                <SeekBar
                  pos={pos}
                  duration={state!.duration_ms}
                  cursor={seekMs}
                  // The panel is drawn OVER the right of the screen rather than
                  // beside the song, which is what keeps the cover and the
                  // buttons from sliding - but at this box's 1360px the
                  // full-width bar ran 136px underneath it, with the duration
                  // wedged between two song titles. The bar is the only thing
                  // that reaches that far, so the bar is what gives way.
                  narrow={panel && queue.length > 0}
                  // Seeking is a write to the account's player, so it needs the
                  // Web API and it needs the box to BE the player: the same pair
                  // the shuffle and repeat buttons are gated on. Without both, the
                  // bar stays what it was - something to read.
                  seekable={connected && onThisBox}
                  onMove={(delta) =>
                    setSeekMs((cur) => Math.max(0, Math.min(state!.duration_ms || 0, (cur ?? pos) + delta)))
                  }
                  onCommit={() => {
                    if (seekMs === null) return;
                    doControl("seek", String(Math.floor(seekMs)));
                    setSeekedTo({ at: Date.now(), ms: seekMs });
                    setSeekMs(null);
                  }}
                  onToggle={() => doControl("playpause")}
                />
                {connected ? (
                  <div className="flex items-center gap-[1.5vw] mt-[0.8vh]">
                    {onThisBox && (
                      <Ctrl
                        fk="sp-shuffle"
                        sm
                        on={!!player?.shuffle}
                        label={t("spotify.shuffle")}
                        onEnter={() => setSetting("shuffle", !player?.shuffle)}
                      >
                        <TIcon name="shuffle" />
                      </Ctrl>
                    )}
                    <Ctrl fk="sp-prev" onEnter={() => doControl("prev")}>
                      <TIcon name="prev" />
                    </Ctrl>
                    <Ctrl fk="sp-playpause" big onEnter={() => doControl("playpause")}>
                      <TIcon name={playing ? "pause" : "play"} big />
                    </Ctrl>
                    <Ctrl fk="sp-next" onEnter={() => doControl("next")}>
                      <TIcon name="next" />
                    </Ctrl>
                    {/* One button, three states. The icon alone cannot carry them
                      from across a room, so the state is written next to it:
                      the icon says repeat, the word says what it repeats. */}
                    {onThisBox && (
                      <Ctrl
                        fk="sp-repeat"
                        sm
                        on={repeat !== "off"}
                        label={t("spotify.repeat")}
                        onEnter={() => setSetting("repeat", repeatNext[repeat])}
                      >
                        <TIcon name={repeat === "track" ? "repeat_one" : "repeat"} />
                      </Ctrl>
                    )}
                  </div>
                ) : null}
                {/* Hidden while a message is up: the strip is anchored to the
                  bottom of the screen and this is the last thing above it, so the
                  two share the same few vh and the backdrop would cover it. */}
                {connected &&
                  onThisBox &&
                  !ctrlErr &&
                  !player?.otherAccount &&
                  (repeat !== "off" || player?.shuffle) && (
                    <div className="flex items-center gap-[1.2vw] text-[1.6vh] text-[#1DB954] mt-[0.2vh]">
                      {player?.shuffle && <span>{t("spotify.shuffle")}</span>}
                      {repeat !== "off" && <span>{t("spotify.repeat_" + repeat)}</span>}
                    </div>
                  )}
                {!connected && (
                  <div className="flex items-center gap-[0.8vw] text-[1.8vh] text-fg-dim mt-[0.5vh]">
                    <span
                      className={"w-[1.2vh] h-[1.2vh] rounded-full " + (playing ? "bg-[#1DB954]" : "bg-white/40")}
                    />
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
          {/* What is next, OVER the right of the screen rather than beside the
            song in the layout. As a flex sibling it moved the cover, the bar and
            the transport row sideways by half its width every time it came and
            went - on a ten-second timer, and back on the next press, so the
            button being aimed at moved as it was pressed. Absolute, it changes
            nothing underneath: the cover is 40vh wide and centred, so it ends
            well before this panel starts. Unmounted rather than hidden, since a
            hidden box still takes layout. Never over the lyrics, which are full
            screen. */}
          {panel && !showLyrics && hasTrack && queue.length > 0 && (
            <div
              className="absolute top-0 right-0 bottom-0 z-20 flex w-[30vw] min-w-0 flex-col pt-[11vh] pb-[4vh] pr-[3vw]"
              aria-hidden="true"
            >
              <div className="shrink-0 pb-[1vh] text-[2.1vh] text-fg-dim">{t("spotify.upNext")}</div>
              <div className="min-h-0 flex-1 overflow-hidden flex flex-col gap-[0.8vh]">
                {queue.map((x, i) => (
                  <div
                    key={x.uri + i}
                    className="flex items-center gap-[1vw] rounded-[1vh] bg-black/30 px-[1vw] py-[0.7vh]"
                  >
                    {x.image_url ? (
                      <img
                        src={x.image_url}
                        alt=""
                        className="w-[4.4vh] h-[4.4vh] rounded-[0.5vh] object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-[4.4vh] h-[4.4vh] rounded-[0.5vh] bg-white/10 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[1.9vh]">{x.name}</div>
                      <div className="truncate text-[1.5vh] text-fg-dim">{x.artists}</div>
                    </div>
                    <div className="shrink-0 text-[1.5vh] text-fg-dim tabular-nums">{mmss(x.duration_ms)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

/**
 * The bar, and the cursor on it.
 *
 * Focusable in its own right, which is what lets Left and Right mean a place in
 * the song here and a move between buttons one row down, with no mode nobody can
 * see: what has focus says which. The same shape the media client's player uses.
 */
function SeekBar({
  pos,
  duration,
  cursor,
  seekable,
  narrow,
  onMove,
  onCommit,
  onToggle,
}: {
  pos: number;
  duration: number;
  /** Where the cursor points, or null when it is not out. */
  cursor: number | null;
  seekable: boolean;
  /** The queue panel is up, so the bar must stop before it. */
  narrow: boolean;
  onMove: (deltaMs: number) => void;
  onCommit: () => void;
  onToggle: () => void;
}) {
  const shown = cursor ?? pos;
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const playedPct = duration > 0 ? Math.min(100, (pos / duration) * 100) : 0;
  const { ref, focused } = useFocusableItem({
    focusKey: "sp-seek",
    focusable: seekable,
    onEnterPress: () => {
      // While the cursor is out, OK is the only way to go where it points -
      // pausing there would be an odd answer to a press aimed at a place in the
      // song.
      if (cursor !== null) onCommit();
      else onToggle();
    },
    onArrowPress: (dir: string) => {
      if (dir === "left" || dir === "right") {
        // Consumed even with no length yet: otherwise the one press that behaves
        // differently is the one nobody could predict.
        if (duration > 0) onMove(dir === "left" ? -SEEK_STEP_MS : SEEK_STEP_MS);
        return false;
      }
      return true;
    },
  });

  return (
    <div
      ref={ref}
      data-sfocus="sp-seek"
      className={["transition-all duration-300", narrow ? "w-[36vw] max-w-[520px]" : "w-[60vw] max-w-[820px]"].join(
        " ",
      )}
    >
      <div
        className={[
          "relative rounded-full bg-white/15 transition-all",
          focused ? "h-[1.1vh] ring-[0.3vh] ring-white/70" : "h-[0.6vh]",
        ].join(" ")}
      >
        <div className="absolute top-0 left-0 h-full rounded-full bg-[#1DB954]" style={{ width: pct + "%" }} />
        {/* Where the song IS, while the cursor is somewhere else - without it
            there is no way back to it. It differs from the cursor in SHAPE rather
            than in size: at three metres a size difference alone is a few
            arc-minutes and reads as one mark that moved. */}
        {cursor !== null && (
          <div
            className="absolute top-1/2 h-[2.2vh] w-[0.35vh] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
            style={{ left: playedPct + "%" }}
          />
        )}
        {/* The cursor, and the only thing on this bar that says it has focus:
            every other control on this screen turns solid white, and a half-vh
            height change does not read across a room. */}
        <div
          className={[
            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_1.5vh_rgba(0,0,0,0.7)]",
            cursor !== null
              ? "h-[2.6vh] w-[2.6vh] border-[0.3vh] border-white bg-[#1DB954]"
              : focused
                ? "h-[1.8vh] w-[1.8vh] bg-white"
                : "h-[1.2vh] w-[1.2vh] bg-white/80",
          ].join(" ")}
          style={{ left: pct + "%" }}
        />
      </div>
      <div className="flex justify-between text-[1.5vh] text-fg-dim mt-[0.6vh] tabular-nums">
        <span className={cursor !== null ? "text-white" : ""}>{mmss(shown)}</span>
        <span>{mmss(duration)}</span>
      </div>
    </div>
  );
}

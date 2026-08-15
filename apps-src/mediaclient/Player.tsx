import { useEffect, useRef, useState } from "react";
import {
  FocusContext,
  doesFocusableExist,
  getCurrentFocusKey,
  setFocus,
  useFocusable,
} from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useFocusableItem, useI18n } from "@sdk";
import { useApp } from "./state";
import { TrackMenu, type Choice } from "./TrackMenu";
import type { Track } from "./backends/types";
import { usePlayer } from "./playback/player";
import { ScrubPreview } from "./ScrubPreview";
import { NextIcon, PauseIcon, PlayIcon, PreviousIcon } from "./icons";
import { episodeNumber } from "./Tile";
import { applySubtitleStyle, usePrefs } from "./prefs";

/**
 * Where focus rests while the overlay is just showing.
 *
 * A real focusable rather than "nothing focused", because spatial navigation
 * offers no way to clear focus - setFocus with an unknown key leaves the last
 * one in place - and "nothing" then means "whatever the previous screen left
 * behind", which is how the overlay ended up routing its arrows to a play
 * button on a hidden page.
 */
const IDLE_KEY = "player-idle";

/** Nudge sizes as a press is held. Held longer means further per press. */
const STEPS_MS = [10_000, 30_000, 60_000];
/** The overlay hides itself this long after the last press. */
const IDLE_HIDE_MS = 4_000;

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * What is on screen while something plays.
 *
 * The video is behind this page, so everything here is drawn over it and the
 * page itself is transparent. Which means the overlay has to get out of the way:
 * it hides after a few seconds of no input, and any press brings it back.
 *
 * Two rows, and which one has focus decides what the arrows do. On the bar,
 * Left and Right move a cursor and OK goes where it points - the film keeps
 * playing meanwhile, because each seek costs a transcode segment and a rebuffer,
 * so hunting for a scene used to mean paying for a dozen to arrive at one. On
 * the row of buttons under it, the arrows belong to spatial navigation.
 *
 * The bar has focus by default, so the common case - find a place, press OK -
 * costs nothing extra, and the buttons are one press down.
 */
export function Player(): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const backend = useApp((s) => s.backend);
  const current = usePlayer((s) => s.current);
  const state = usePlayer((s) => s.state);
  const positionMs = usePlayer((s) => s.positionMs);
  const seekTargetMs = usePlayer((s) => s.seekTargetMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const buffering = usePlayer((s) => s.buffering);
  const overlay = usePlayer((s) => s.overlay);
  const scrubMs = usePlayer((s) => s.scrubMs);
  const siblings = usePlayer((s) => s.siblings);

  const [menu, setMenu] = useState<null | "version" | "audio" | "subtitles" | "quality">(null);
  // Which language the subtitle search asks for. Seeded from the interface, but
  // changeable: a film often has only an English subtitle, and someone may want
  // that one on purpose.
  const [searchLang, setSearchLang] = useState((locale ?? "en").slice(0, 2));
  const [searchState, setSearchState] = useState<"idle" | "searching" | "unavailable" | "none">("idle");
  const [foundSubs, setFoundSubs] = useState<Track[]>([]);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef({ dir: 0, count: 0 });
  // Read inside the key handler, which is registered once per film rather than
  // per render, so it cannot close over the current value.
  const skippableRef = useRef(false);

  const { ref, focusKey } = useFocusable({ focusKey: "player", saveLastFocusedChild: true, isFocusBoundary: true });

  // Any input shows the overlay and restarts the countdown. Pausing keeps it up:
  // a paused film with nothing on screen looks like a frozen box.
  useEffect(() => {
    if (!current) return;
    const bump = (): void => {
      usePlayer.getState().showOverlay(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      // Not while a cursor is out: hiding it leaves the film looking untouched
      // while OK still means "jump to a place you can no longer see".
      if (usePlayer.getState().state === "playing" && usePlayer.getState().scrubMs === null) {
        hideTimer.current = setTimeout(() => usePlayer.getState().showOverlay(false), IDLE_HIDE_MS);
      }
    };
    bump();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [current, state, positionMs === 0]);

  useEffect(() => {
    // The menu owns the D-pad while it is open. This handler is capture-phase on
    // window, ahead of spatial navigation's own - so leaving it running would
    // scrub the film on Left/Right instead of moving between the menu's columns,
    // and OK would both press the focused button and toggle pause.
    if (!current || menu) return;

    // Re-armed from FRESH state, and after the key has been acted on. Reading
    // the snapshot taken at the top of the handler meant the first arrow press
    // armed the hide while scrubMs was still null - so the overlay vanished
    // four seconds later with the cursor out, and the next OK jumped the film
    // to a place nobody could see.
    const rearmHide = (): void => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      const p = usePlayer.getState();
      if (p.state === "playing" && p.scrubMs === null) {
        hideTimer.current = setTimeout(() => usePlayer.getState().showOverlay(false), IDLE_HIDE_MS);
      }
    };

    const onKey = (e: KeyboardEvent): void => {
      const p = usePlayer.getState();
      // Three states, and which one it is decides what every key means.
      //
      // Nothing focused is the DEFAULT and the common case: the arrows jump ten
      // seconds, the way a transport control does, and OK pauses. Reaching for
      // the scene picker is a deliberate step up onto the bar, because scrubbing
      // by eye is the slower, more careful thing and should not be what a
      // reflexive press does.
      const fk = getCurrentFocusKey();
      const onBar = fk === "scrub";
      // Anything that is not ours counts as resting too: a key left behind by
      // the screen that started the film must not be able to act on a press.
      const idle = !fk || fk === IDLE_KEY || !(onBar || fk.startsWith("pb-") || fk === "skip");
      p.showOverlay(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          // Off the skip button rather than into whatever geometry finds: it is
          // absolutely positioned away from both rows, so sideways from it
          // landed on the resting anchor.
          if (fk === "skip") {
            e.preventDefault();
            e.stopPropagation();
            setFocus("scrub");
            break;
          }
          if (!idle && !onBar) break; // the button row: spatial navigation's
          e.preventDefault();
          e.stopPropagation();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          if (held.current.dir === dir) held.current.count += 1;
          else held.current = { dir, count: 0 };
          const step = STEPS_MS[Math.min(held.current.count >> 2, STEPS_MS.length - 1)];
          // On the bar the cursor moves and the film does not: a seek costs a
          // fresh transcode segment and a rebuffer, so finding a scene by eye
          // would otherwise mean paying for a dozen to arrive at one. Off the
          // bar it is an ordinary jump, which is what a press expects when
          // nothing has been chosen.
          if (onBar) p.scrubBy(dir * step);
          else p.seekBy(dir * step);
          break;
        }
        case "Enter":
          // With a button focused, OK belongs to it - otherwise one press would
          // both fire the button and toggle pause.
          if (!idle && !onBar) break;
          e.preventDefault();
          // Committing comes first: while the cursor is out, OK is the only way
          // to go where it is pointing, and pausing there would be an odd
          // answer to a press that was aiming at a scene.
          if (p.scrubMs !== null) p.commitScrub();
          else p.togglePause();
          break;
        case "MediaPlayPause":
          e.preventDefault();
          p.togglePause();
          break;
        case "MediaStop":
          e.preventDefault();
          void p.stop();
          break;
        // A dedicated skip key is unambiguous, so it jumps rather than arming a
        // cursor - and arming one from the button row stranded it: the arrows
        // could not move it and OK belonged to whatever button had focus.
        case "MediaTrackNext":
          p.seekBy(60_000);
          break;
        case "MediaTrackPrevious":
          p.seekBy(-60_000);
          break;
        // Vertical movement is decided here rather than by geometry, for all
        // three states. Spatial navigation cannot make the first step at all -
        // resting means nothing is focused, so it has no origin and discards
        // the press - and once the resting anchor exists as a focusable, it is
        // also a CANDIDATE, so leaving the rest to geometry meant Up from a
        // button could land back on it instead of the bar. Three states and two
        // keys is small enough to state outright.
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          if (idle) setFocus("scrub");
          else if (fk?.startsWith("pb-")) setFocus("scrub");
          else if (onBar && skippableRef.current) setFocus("skip");
          // From the skip button itself Up has nowhere to go, and the press is
          // already consumed - so it goes back to the bar rather than sitting
          // there looking broken.
          else if (fk === "skip") setFocus("scrub");
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          if (idle || fk === "skip") setFocus("scrub");
          else if (onBar) {
            // Leaving the bar withdraws the cursor. Left armed, it stayed drawn
            // where nothing could move it, and the next OK - on a button, or on
            // the resting anchor - jumped the film instead of doing what the
            // button said.
            p.cancelScrub();
            setFocus("pb-playpause");
          }
          break;
      }

      rearmHide();
    };

    const onKeyUp = (): void => {
      held.current = { dir: 0, count: 0 };
    };

    // Capture phase: these keys must not reach spatial navigation, or Left and
    // Right would move focus instead of scrubbing.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [current, menu]);

  const marker = current ? usePlayer.getState().activeMarker() : null;
  const skippable = Boolean(marker && (marker.type === "intro" || (marker.type === "credits" && !marker.final)));
  skippableRef.current = skippable;

  /**
   * The skip button announces itself, then gets out of the way.
   *
   * It has to be visible without the overlay - that was the bug it was moved
   * out for - but an intro can run two minutes, and a button parked over the
   * picture for all of it is the opposite complaint. Three seconds is long
   * enough to see and press; after that it comes back with the overlay, which
   * is one press away.
   */
  const [announcing, setAnnouncing] = useState(false);
  /**
   * The skip button leaving takes the cursor with it.
   *
   * It unmounts when the marker passes, when three seconds are up, or when the
   * overlay hides - and focus stays on a key that no longer exists, so every
   * press after that is discarded. Sending the cursor back to rest is the whole
   * fix; it is the same failure as every other disappearing focusable in this
   * app, on the one that disappears BY DESIGN.
   */
  const showSkip = skippable && (announcing || overlay);
  useEffect(() => {
    if (!skippable) {
      setAnnouncing(false);
      return;
    }
    setAnnouncing(true);
    const id = setTimeout(() => setAnnouncing(false), 3_000);
    return () => clearTimeout(id);
  }, [skippable, marker?.startMs]);

  // Skip without asking, when that is switched on. Off by default: a marker is
  // the server's guess, and one that is a minute out jumps past the opening of
  // an episode with nothing to say what happened.
  const autoSkip = usePrefs((s) => s.autoSkip);
  useEffect(() => {
    if (autoSkip && skippable && !menu) usePlayer.getState().skipMarker();
  }, [autoSkip, skippable, menu]);

  // The style is per file in mpv, so it is pushed again whenever a stream
  // starts rather than only when it is changed in Settings.
  useEffect(() => {
    if (current) applySubtitleStyle();
  }, [current]);

  // Back pauses and keeps the frame; stopping loses where you were, which
  // matters more on a television than on a phone. Only a paused film stops.
  //
  // Through the SDK's stack rather than a listener of our own: it installs a
  // single capture-phase handler at app start and stops propagation, so a raw
  // listener registered later never sees the key at all - the film would keep
  // playing while the overlay claimed Back would pause it.
  useBackspace(() => {
    // Back closes the menu first: it is a layer over the film, and leaving it
    // open while the film pauses underneath would be two things at once.
    if (menu) {
      setMenu(null);
      return;
    }
    const p = usePlayer.getState();
    // Then the scrub cursor: it is a question that has not been answered yet,
    // and Back is how a question is withdrawn. Pausing here instead would leave
    // the cursor on screen pointing at a place the film never went.
    if (p.scrubMs !== null) {
      p.cancelScrub();
      return;
    }
    if (p.state === "playing") p.togglePause();
    else void p.stop();
  }, Boolean(current));

  // Focus is taken off anything the overlay does not own, and handed to
  // NOBODY: nothing focused is the overlay's resting state, where the arrows
  // jump ten seconds and OK pauses.
  //
  // Both halves matter. Playback starts from the screen behind this one, so
  // focus arrives on that screen's play button - and since the arrows are
  // routed by what has focus, that silently disabled the whole overlay: nothing
  // scrubbed, the buttons could not be reached, and OK re-fired the play button
  // and restarted the film. A key that no longer exists behaves the same way,
  // because spatial navigation walks up to the root and gives up there, which
  // is what closing the track menu used to leave behind.
  useEffect(() => {
    if (!current || menu) return;
    const id = setTimeout(() => {
      const key = getCurrentFocusKey();
      const ours = key === IDLE_KEY || key === "scrub" || key?.startsWith("pb-") || key === "skip";
      if (!key || !ours || !doesFocusableExist(key)) setFocus(IDLE_KEY);
    }, 0);
    return () => clearTimeout(id);
    // showSkip is in here because the skip button disappears BY DESIGN - three
    // seconds after a marker starts, when the marker passes, when the overlay
    // hides - and without it the cursor stayed on a key that no longer existed
    // and every press after that was discarded.
  }, [current, menu, overlay, showSkip]);

  // Back to resting when the overlay goes away, so the next press starts from
  // the same place every time rather than wherever it was left.
  useEffect(() => {
    if (!overlay && current) setFocus(IDLE_KEY);
  }, [overlay, current]);

  // The skip button is only reachable if something puts focus on it: Left and
  // Right are taken by scrubbing and nothing else moves focus here.
  useEffect(() => {
    // Not while the menu is open: the skip button is not rendered then, and
    // focusing a key with no element behind it leaves the library with no origin
    // to navigate from - every later press is discarded. The window is wide,
    // because the first minute of an episode is exactly when someone opens this
    // menu to fix the audio language.
    // Not while a cursor is out: the mark would stay drawn on the bar while the
    // arrows stopped moving it and OK skipped the marker instead of committing
    // - the bar would be showing a place OK was never going to go.
    // From the resting state as well as from the bar. Resting is where the
    // overlay sits by default, so requiring the bar meant the button appeared
    // with the cursor nowhere near it and OK did something else.
    const at = getCurrentFocusKey();
    // Only while it is on screen. Focusing a button nobody can see means the
    // next OK does something invisible.
    if (showSkip && !menu && usePlayer.getState().scrubMs === null && (!at || at === IDLE_KEY || at === "scrub"))
      setFocus("skip");
  }, [showSkip, menu]);

  if (!current) return null;

  if (menu && current.detail) {
    const searchSubtitles = async (): Promise<void> => {
      if (searchState === "searching") return; // one at a time
      setSearchState("searching");
      try {
        // Whatever the language buttons say. Seeded from the interface language,
        // because that is the right guess, but never more than a guess: a title
        // may only have a subtitle in one language, and that one is worth
        // finding.
        const found = await backend!.searchSubtitles(current.item.id, searchLang);
        setFoundSubs(found);
        setSearchState(found.length ? "idle" : "none");
      } catch {
        // The server answers with an error rather than an empty list when it has
        // no subtitle provider configured, so "none found" and "cannot look" are
        // different sentences.
        setSearchState("unavailable");
      }
    };

    const downloadSubtitle = async (track: Track): Promise<void> => {
      try {
        await backend!.addSubtitle(current.item.id, track.id);
        setFoundSubs([]);
        // The item now has a track it did not have; without refetching, the
        // column would keep showing the old list and the download would look
        // like it did nothing.
        const fresh = await backend!.item(current.item.id);
        usePlayer.setState({ current: { ...current, detail: fresh } });
      } catch {
        setSearchState("unavailable");
      }
    };

    return (
      <TrackMenu
        versions={current.detail.versions}
        current={current.choice as Choice}
        onChoose={(next) => void usePlayer.getState().changeTracks(next)}
        initial={menu}
        onClose={() => setMenu(null)}
        searchLanguage={searchLang}
        onSearchLanguage={(code) => {
          setSearchLang(code);
          // The results on screen were for the old language; leaving them under
          // a new label would offer a Hungarian file as an English one.
          setFoundSubs([]);
          setSearchState("idle");
        }}
        onSearchSubtitles={backend ? () => void searchSubtitles() : undefined}
        found={foundSubs}
        onDownloadSubtitle={(track) => void downloadSubtitle(track)}
        searchState={searchState}
      />
    );
  }

  const shown = scrubMs ?? seekTargetMs ?? positionMs;
  const pct = durationMs > 0 ? Math.min(100, (shown / durationMs) * 100) : 0;
  // Where the film actually is, kept visible while the cursor is away from it -
  // otherwise there is no way to tell how far you have wandered, or to get back.
  const playedPct = durationMs > 0 ? Math.min(100, ((seekTargetMs ?? positionMs) / durationMs) * 100) : 0;
  const partId = current.detail?.versions[current.choice.version]?.partId;
  const onButtons = Boolean(getCurrentFocusKey()?.startsWith("pb-"));
  const hintKey =
    scrubMs !== null
      ? "player.hintScrub"
      : onButtons
        ? "player.hintButtons"
        : state === "paused"
          ? "player.hintPaused"
          : "player.hint";

  return (
    <FocusContext.Provider value={focusKey}>
      {/* OUTSIDE the fading wrapper, and that is the point: the overlay hides
          itself after four seconds of no input, and the skip button lived
          inside it - so during an intro, which is exactly when it is wanted, it
          was gone before anyone looked up. Bottom right, where a television
          puts this. */}
      {showSkip && (
        <div className="absolute right-[4vw] bottom-[6vh] z-20 transition-opacity duration-200">
          <FocusButton
            focusKey="skip"
            onEnter={() => usePlayer.getState().skipMarker()}
            // No text shadow: this one has its own opaque ground, unlike the
            // title and the clock, which are written straight over the film.
            className="rounded-[1vh] bg-black/70 px-[2.4vw] py-[1.4vh] text-[2.2vh] font-semibold"
          >
            {t(marker!.type === "intro" ? "player.skipIntro" : "player.skipCredits")}
          </FocusButton>
        </div>
      )}
      <div
        ref={ref}
        className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-200 ${
          overlay ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <IdleAnchor />

        {/* A gradient rather than a panel: the film keeps showing through, which
            is what makes the overlay feel like it belongs to the picture. */}
        {/* The stop in the middle matters: with a single stop to transparent,
            the title sat in the top third at alpha 0.18 and was the least
            readable thing on the overlay over a bright scene. */}
        <div className="bg-gradient-to-t from-black/90 via-black/65 to-transparent px-[4vw] pt-[10vh] pb-[4vh]">
          <div className="flex flex-col gap-[1.4vh]">
            <div className="flex items-baseline gap-[1.2vw]">
              <h2 className="text-[2.8vh] font-semibold tracking-tight [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.9)]">
                {current.item.seriesTitle ?? current.item.title}
              </h2>
              {current.item.seriesTitle && (
                <span className="text-[2.1vh] text-white/80 [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.9)]">
                  {/* The number before the name. Halfway through a series it is
                      the thing being checked - "which one is this" - and the
                      name on its own does not answer it. */}
                  {[episodeNumber(current.item), current.item.title].filter(Boolean).join(" · ")}
                </span>
              )}
              {buffering && (
                <span className="text-[2.1vh] text-white/85 [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.9)]">
                  {t("player.buffering")}
                </span>
              )}
              {current.decision.transcoded && (
                <span className="text-[1.7vh] text-fg-dim">{t("player.converting")}</span>
              )}
            </div>

            <ScrubBar
              shown={shown}
              pct={pct}
              playedPct={playedPct}
              durationMs={durationMs}
              markers={current.markers}
              scrubbing={scrubMs !== null}
              partId={partId}
              hintKey={hintKey}
            />

            <ButtonRow
              paused={state === "paused"}
              canChooseTracks={Boolean(current.detail)}
              hasPrev={Boolean(siblings.prev)}
              hasNext={Boolean(siblings.next)}
              onPrev={() => usePlayer.getState().playSibling("prev")}
              onNext={() => usePlayer.getState().playSibling("next")}
              onPlayPause={() => usePlayer.getState().togglePause()}
              onTracks={() => setMenu("audio")}
              onQuality={() => setMenu("quality")}
            />
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

/**
 * Somewhere for focus to sit while nothing is chosen.
 *
 * Invisible and unreachable by the arrows - the handler moves focus on and off
 * it deliberately - so it never appears in the D-pad's geometry.
 */
function IdleAnchor(): React.JSX.Element {
  const { ref } = useFocusableItem({ focusKey: IDLE_KEY });
  return <div ref={ref} className="pointer-events-none absolute h-0 w-0" aria-hidden="true" />;
}

/**
 * The bar, the cursor, and the frame the cursor is on.
 *
 * Focusable in its own right so that arrows can mean two different things on
 * two rows without a mode nobody can see: what has focus says which.
 */
function ScrubBar({
  shown,
  pct,
  playedPct,
  durationMs,
  markers,
  scrubbing,
  partId,
  hintKey,
}: {
  shown: number;
  pct: number;
  playedPct: number;
  durationMs: number;
  markers: { type: string; startMs: number; endMs: number }[];
  scrubbing: boolean;
  partId?: string;
  hintKey: string;
}): React.JSX.Element {
  const { t } = useI18n();
  // No scroll options: the overlay does not scroll, and asking the browser to
  // bring this into view drags the transparent page under the video.
  const { ref, focused } = useFocusableItem({ focusKey: "scrub" });

  return (
    <div ref={ref} className="flex flex-col gap-[1vh]">
      {/* The frame rides above the cursor and only exists while scrubbing: a
          preview pinned over a film nobody is scrubbing is just a smaller
          picture in front of a bigger one. */}
      {/* Vertical room only. The frame itself is positioned inside the bar
          below, because a percentage here would resolve against this full-width
          box while the cursor's resolves against the bar - two coordinate
          systems that agree only at the exact midpoint, and are 162px apart a
          tenth of the way into a film. Reserved only while scrubbing: kept
          always, it pushed the title and the bar up the screen for a preview
          that was not there. */}
      <div className={scrubbing ? "h-[16vh]" : "hidden"} />

      <div className="flex items-center gap-[1.2vw]">
        <span className="w-[9vw] text-[2.2vh] tabular-nums [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.9)]">
          {clock(shown)}
        </span>

        <div
          className={`relative h-[0.7vh] flex-1 rounded-full bg-white/25 transition-all ${
            focused ? "h-[1.1vh] ring-[0.3vh] ring-white/70" : ""
          }`}
        >
          {/* Markers sit on the bar so the shape of the episode is visible
              before you get there. */}
          {markers.map((m) => (
            <div
              key={`${m.type}-${m.startMs}`}
              className="absolute top-0 h-full bg-white/35"
              style={{
                left: `${durationMs ? (m.startMs / durationMs) * 100 : 0}%`,
                width: `${durationMs ? ((m.endMs - m.startMs) / durationMs) * 100 : 0}%`,
              }}
            />
          ))}
          <div className="absolute top-0 left-0 h-full rounded-full bg-white" style={{ width: `${playedPct}%` }} />
          {/* While scrubbing there are two marks: where the film is, and where
              the cursor points. Without the first one there is no way back. */}
          {/* Where the film IS, while the cursor is away from it. A thin upright
              tick rather than a smaller disc: the two marks have to differ in
              shape, because at three metres a size difference alone is a few
              arc-minutes and reads as one mark that moved. */}
          {scrubbing && (
            <div
              className="absolute top-1/2 h-[2.4vh] w-[0.35vh] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
              style={{ left: `${playedPct}%` }}
            />
          )}
          {/* Above the cursor, in the cursor's own coordinate system. */}
          {scrubbing && (
            <div
              className="absolute bottom-[2.4vh] -translate-x-1/2"
              // Clamped by half its own width, or the frame hangs off the screen
              // at either end - and the last minutes are exactly where someone
              // is looking for the point they fell asleep.
              style={{ left: `clamp(13vh, ${pct}%, calc(100% - 13vh))` }}
            >
              <ScrubPreview partId={partId} timeMs={shown} widthVh={26} />
            </div>
          )}
          <div
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_1.5vh_rgba(0,0,0,0.7)] ${
              scrubbing
                ? "h-[2.8vh] w-[2.8vh] border-[0.3vh] border-white bg-[var(--color-accent)]"
                : "h-[2vh] w-[2vh] bg-white"
            }`}
            style={{ left: `${pct}%` }}
          />
        </div>

        <span className="w-[9vw] text-right text-[2.2vh] text-white/80 tabular-nums [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.9)]">
          -{clock(Math.max(0, durationMs - shown))}
        </span>
      </div>

      {/* One line, and it has to say what the arrows do RIGHT NOW: which row has
          focus decides that, so a single fixed sentence was wrong in three of
          the four states - it still described jumping on Left and Right, which
          is the behaviour this screen no longer has. */}
      <p className="text-[2vh] text-white/85 [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.9)]">{t(hintKey)}</p>
    </div>
  );
}

/** What the Plex client puts under the bar: the things that are not the bar. */
function ButtonRow({
  paused,
  canChooseTracks,
  hasPrev,
  hasNext,
  onPlayPause,
  onTracks,
  onQuality,
  onPrev,
  onNext,
}: {
  paused: boolean;
  canChooseTracks: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onPlayPause: () => void;
  onTracks: () => void;
  onQuality: () => void;
  onPrev: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  // Opaque enough to read against any frame, and above the 10-foot floor of
  // 2.22vh at 1080p.
  const cls = "rounded-[1vh] bg-black/55 px-[2vw] py-[1.3vh] text-[2.4vh]";

  return (
    <div className="flex items-center gap-[1vw]">
      {/* Episode stepping first, so the three transport controls sit together
          in the order a remote's own keys do. Only when there is one: a button
          that highlights and does nothing is worse than no button. */}
      {hasPrev && (
        <FocusButton focusKey="pb-prev" label={t("player.previousEpisode")} onEnter={onPrev} className={cls}>
          <PreviousIcon />
        </FocusButton>
      )}
      <FocusButton
        focusKey="pb-playpause"
        label={t(paused ? "player.play" : "player.pause")}
        onEnter={onPlayPause}
        className={cls}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </FocusButton>
      {hasNext && (
        <FocusButton focusKey="pb-next" label={t("player.nextEpisode")} onEnter={onNext} className={cls}>
          <NextIcon />
        </FocusButton>
      )}
      {/* Only when there is something to choose between. A button that opens a
          panel with nothing in it is worse than no button - and the panel is
          what Back would then close instead of pausing. */}
      {canChooseTracks && (
        <>
          <FocusButton focusKey="pb-tracks" onEnter={onTracks} className={cls}>
            {t("player.tracks")}
          </FocusButton>
          <FocusButton focusKey="pb-quality" onEnter={onQuality} className={cls}>
            {t("player.quality")}
          </FocusButton>
        </>
      )}
    </div>
  );
}

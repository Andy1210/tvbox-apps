import { useEffect, useRef, useState } from "react";
import { FocusContext, getCurrentFocusKey, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useFocusableItem, useI18n } from "@sdk";
import { useApp } from "./state";
import { TrackMenu, type Choice } from "./TrackMenu";
import type { Track } from "./backends/types";
import { usePlayer } from "./playback/player";
import { ScrubPreview } from "./ScrubPreview";

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

  const [menu, setMenu] = useState<null | "version" | "audio" | "subtitles" | "quality">(null);
  // Which language the subtitle search asks for. Seeded from the interface, but
  // changeable: a film often has only an English subtitle, and someone may want
  // that one on purpose.
  const [searchLang, setSearchLang] = useState((locale ?? "en").slice(0, 2));
  const [searchState, setSearchState] = useState<"idle" | "searching" | "unavailable" | "none">("idle");
  const [foundSubs, setFoundSubs] = useState<Track[]>([]);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef({ dir: 0, count: 0 });

  const { ref, focusKey } = useFocusable({ focusKey: "player", saveLastFocusedChild: true, isFocusBoundary: true });

  // Any input shows the overlay and restarts the countdown. Pausing keeps it up:
  // a paused film with nothing on screen looks like a frozen box.
  useEffect(() => {
    if (!current) return;
    const bump = (): void => {
      usePlayer.getState().showOverlay(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (usePlayer.getState().state === "playing") {
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

    const onKey = (e: KeyboardEvent): void => {
      const p = usePlayer.getState();
      // Which row owns the arrows. On the bar they move the cursor; on the
      // button row they have to reach the next button, so this handler - which
      // runs ahead of spatial navigation and stops propagation - must keep its
      // hands off them there.
      const onBar = getCurrentFocusKey() === "scrub" || !getCurrentFocusKey();
      p.showOverlay(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (p.state === "playing") hideTimer.current = setTimeout(() => usePlayer.getState().showOverlay(false), IDLE_HIDE_MS);

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          if (!onBar) break;
          e.preventDefault();
          e.stopPropagation();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          if (held.current.dir === dir) held.current.count += 1;
          else held.current = { dir, count: 0 };
          const step = STEPS_MS[Math.min(held.current.count >> 2, STEPS_MS.length - 1)];
          // The cursor moves; the film does not. Each seek costs a fresh
          // transcode segment and a rebuffer, so finding a scene by eye used to
          // mean paying for a dozen of them to arrive at one.
          p.scrubBy(dir * step);
          break;
        }
        case "Enter":
          // With a button up and focused, OK belongs to it - otherwise one press
          // would both fire the button and toggle pause.
          if (!onBar) break;
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
        case "MediaTrackNext":
          p.scrubBy(60_000);
          break;
        case "MediaTrackPrevious":
          p.scrubBy(-60_000);
          break;
        // Up and Down are left alone: they are what moves between the bar and
        // the row of buttons under it, and that is spatial navigation's job.
      }
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

  // The bar takes focus as the film starts, and takes it back whenever the
  // overlay returns. Without an origin, spatial navigation discards every press
  // - and the arrows would then not even reach the buttons under it.
  useEffect(() => {
    if (!current || menu) return;
    const id = setTimeout(() => {
      const key = getCurrentFocusKey();
      if (!key || key === "skip") setFocus("scrub");
    }, 0);
    return () => clearTimeout(id);
  }, [current, menu, overlay]);

  // The skip button is only reachable if something puts focus on it: Left and
  // Right are taken by scrubbing and nothing else moves focus here.
  useEffect(() => {
    // Not while the menu is open: the skip button is not rendered then, and
    // focusing a key with no element behind it leaves the library with no origin
    // to navigate from - every later press is discarded. The window is wide,
    // because the first minute of an episode is exactly when someone opens this
    // menu to fix the audio language.
    if (skippable && !menu) setFocus("skip");
  }, [skippable, menu]);

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

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-200 ${
          overlay ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {skippable && (
          <div className="absolute right-[4vw] bottom-[34vh]">
            <FocusButton
              focusKey="skip"
              onEnter={() => usePlayer.getState().skipMarker()}
              className="rounded-[1vh] bg-white/90 px-[2vw] py-[1.2vh] text-[2vh] font-semibold text-black"
            >
              {t(marker!.type === "intro" ? "player.skipIntro" : "player.skipCredits")}
            </FocusButton>
          </div>
        )}

        {/* A gradient rather than a panel: the film keeps showing through, which
            is what makes the overlay feel like it belongs to the picture. */}
        <div className="bg-gradient-to-t from-black/85 to-transparent px-[4vw] pt-[8vh] pb-[4vh]">
          <div className="flex flex-col gap-[1.4vh]">
            <div className="flex items-baseline gap-[1.2vw]">
              <h2 className="text-[2.6vh] font-semibold tracking-tight">
                {current.item.seriesTitle ?? current.item.title}
              </h2>
              {current.item.seriesTitle && <span className="text-[1.9vh] text-fg-dim">{current.item.title}</span>}
              {buffering && <span className="text-[1.7vh] text-fg-dim">{t("player.buffering")}</span>}
              {current.decision.transcoded && <span className="text-[1.7vh] text-fg-dim">{t("player.converting")}</span>}
            </div>

            <ScrubBar
              shown={shown}
              pct={pct}
              playedPct={playedPct}
              durationMs={durationMs}
              markers={current.markers}
              scrubbing={scrubMs !== null}
              partId={partId}
            />

            <ButtonRow
              paused={state === "paused"}
              canChooseTracks={Boolean(current.detail)}
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
}: {
  shown: number;
  pct: number;
  playedPct: number;
  durationMs: number;
  markers: { type: string; startMs: number; endMs: number }[];
  scrubbing: boolean;
  partId?: string;
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
      <div className="relative h-[16vh]">
        {scrubbing && (
          <div
            className="absolute bottom-0 -translate-x-1/2"
            // Clamped, or the frame hangs off the screen at either end and the
            // one place it matters most - the last minutes - is unreadable.
            style={{ left: `clamp(14vh, ${pct}%, calc(100% - 14vh))` }}
          >
            <ScrubPreview partId={partId} timeMs={shown} widthVh={26} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-[1.2vw]">
        <span className="w-[9vw] text-[1.9vh] tabular-nums">{clock(shown)}</span>

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
          {scrubbing && (
            <div
              className="absolute top-1/2 h-[1.2vh] w-[1.2vh] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/50"
              style={{ left: `${playedPct}%` }}
            />
          )}
          <div
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_1.5vh_rgba(0,0,0,0.6)] ${
              scrubbing ? "h-[2.6vh] w-[2.6vh] bg-accent" : "h-[2vh] w-[2vh] bg-white"
            }`}
            style={{ left: `${pct}%` }}
          />
        </div>

        <span className="w-[9vw] text-right text-[1.9vh] text-fg-dim tabular-nums">
          -{clock(Math.max(0, durationMs - shown))}
        </span>
      </div>

      <p className="text-[1.7vh] text-fg-dim">{t(scrubbing ? "player.hintScrub" : "player.hint")}</p>
    </div>
  );
}

/** What the Plex client puts under the bar: the things that are not the bar. */
function ButtonRow({
  paused,
  canChooseTracks,
  onPlayPause,
  onTracks,
  onQuality,
}: {
  paused: boolean;
  canChooseTracks: boolean;
  onPlayPause: () => void;
  onTracks: () => void;
  onQuality: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const cls = "rounded-[1vh] bg-white/12 px-[2vw] py-[1.2vh] text-[2vh]";

  return (
    <div className="flex items-center gap-[1vw]">
      <FocusButton focusKey="pb-playpause" onEnter={onPlayPause} className={cls}>
        {t(paused ? "player.play" : "player.pause")}
      </FocusButton>
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

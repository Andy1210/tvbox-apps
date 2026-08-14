import { useEffect, useRef, useState } from "react";
import { FocusContext, getCurrentFocusKey, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { useApp } from "./state";
import { TrackMenu, type Choice } from "./TrackMenu";
import type { Track } from "./backends/types";
import { usePlayer } from "./playback/player";

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
 * Left and Right scrub rather than move focus. On a remote there is no other
 * gesture for it, and a scrub bar you have to focus first is a scrub bar nobody
 * uses.
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

  const [menu, setMenu] = useState(false);
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
      p.showOverlay(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (p.state === "playing") hideTimer.current = setTimeout(() => usePlayer.getState().showOverlay(false), IDLE_HIDE_MS);

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          e.stopPropagation();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          if (held.current.dir === dir) held.current.count += 1;
          else held.current = { dir, count: 0 };
          const step = STEPS_MS[Math.min(held.current.count >> 2, STEPS_MS.length - 1)];
          p.seekBy(dir * step);
          break;
        }
        case "Enter":
          // With the skip button up and focused, OK belongs to it - otherwise
          // one press would both fire the button and toggle pause.
          if (getCurrentFocusKey() === "skip") break;
          e.preventDefault();
          p.togglePause();
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
          p.seekBy(60_000);
          break;
        case "MediaTrackPrevious":
          p.seekBy(-60_000);
          break;
        case "ArrowDown":
          // Down is free here: nothing else on the overlay moves focus
          // vertically, and a track menu behind a long press or a coloured
          // button is a track menu nobody finds. Only when there is something to
          // show - otherwise the press opens a state that renders nothing, and
          // the next Back closes it instead of pausing.
          if (!p.current?.detail) break;
          e.preventDefault();
          e.stopPropagation();
          setMenu(true);
          break;
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
      setMenu(false);
      return;
    }
    const p = usePlayer.getState();
    if (p.state === "playing") p.togglePause();
    else void p.stop();
  }, Boolean(current));

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
        // The interface language, not a fixed one: someone watching in English
        // is not helped by Hungarian subtitles, and the button never said which
        // language it would look for.
        const found = await backend!.searchSubtitles(current.item.id, (locale ?? "en").slice(0, 2));
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
        onClose={() => setMenu(false)}
        onSearchSubtitles={backend ? () => void searchSubtitles() : undefined}
        found={foundSubs}
        onDownloadSubtitle={(track) => void downloadSubtitle(track)}
        searchState={searchState}
      />
    );
  }

  const shown = seekTargetMs ?? positionMs;
  const pct = durationMs > 0 ? Math.min(100, (shown / durationMs) * 100) : 0;

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-200 ${
          overlay ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {skippable && (
          <div className="absolute right-[4vw] bottom-[26vh]">
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

            <div className="flex items-center gap-[1.2vw]">
              <span className="w-[9vw] text-[1.9vh] tabular-nums">{clock(shown)}</span>

              <div className="relative h-[0.7vh] flex-1 rounded-full bg-white/25">
                {/* Markers sit on the bar so the shape of the episode is visible
                    before you get there. */}
                {current.markers.map((m) => (
                  <div
                    key={`${m.type}-${m.startMs}`}
                    className="absolute top-0 h-full bg-white/35"
                    style={{
                      left: `${durationMs ? (m.startMs / durationMs) * 100 : 0}%`,
                      width: `${durationMs ? ((m.endMs - m.startMs) / durationMs) * 100 : 0}%`,
                    }}
                  />
                ))}
                <div className="absolute top-0 left-0 h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
                <div
                  className="absolute top-1/2 h-[2vh] w-[2vh] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_1.5vh_rgba(0,0,0,0.6)]"
                  style={{ left: `${pct}%` }}
                />
              </div>

              <span className="w-[9vw] text-right text-[1.9vh] text-fg-dim tabular-nums">
                −{clock(Math.max(0, durationMs - shown))}
              </span>
            </div>

            <p className="text-[1.7vh] text-fg-dim">
              {t(state === "paused" ? "player.hintPaused" : "player.hint")}
            </p>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

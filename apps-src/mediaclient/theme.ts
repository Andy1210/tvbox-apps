// A series' theme music, while you are looking at it.
//
// The server holds one for about six series in ten here. It is what the Plex
// client does on a season screen, and it is the difference between browsing a
// database and being somewhere.

import { useEffect } from "react";
import { useApp } from "./state";
import { useShowingPlayer } from "./playback/player";
import { usePrefs } from "./prefs";
import { onRelease } from "./lifecycle";
import type { MediaItem } from "./backends/types";
import { log } from "./redact";

let audio: HTMLAudioElement | null = null;
let playingUrl: string | null = null;
/**
 * The theme a film silenced, which must not come back when the film does.
 *
 * Leaving an episode returns to the season screen, and the screen was never
 * unmounted - so without this the sting starts again from its first bar, at full
 * level, into a room whose volume is set for a film's dialogue. That is the
 * loudest thing this app does and it happens after every episode. Cleared by
 * moving to another series, and by leaving the screen, so arriving at a series
 * still plays its theme - which is the whole point of having one.
 */
let silencedByPlayback: string | null = null;

/** Fade over this long rather than cutting, which is startling on a TV. */
const FADE_MS = 600;
/**
 * Under the room's conversation, not over it.
 *
 * A level is a judgement about one room and one television, so it is a constant
 * rather than anything derived: 0.35 was almost nothing on a TV and 0.7 was too
 * loud, and this sits at 60% of the 0.7. It is amplitude, not loudness - the
 * step from 0.7 is about 4.4 dB, so a change here reads smaller than the
 * numbers suggest.
 */
const LEVEL = 0.42;

/** Walk an element's volume to `to`, and run `done` when it arrives. */
function fade(a: HTMLAudioElement, to: number, done?: () => void): () => void {
  const step = Math.abs(to - a.volume) / (FADE_MS / 50);
  const timer = setInterval(() => {
    const at = a.volume;
    const next = at < to ? Math.min(to, at + step) : Math.max(to, at - step);
    a.volume = next;
    if (Math.abs(next - to) <= 0.01) {
      a.volume = to;
      clearInterval(timer);
      done?.();
    }
  }, 50);
  return () => clearInterval(timer);
}

/**
 * A stop that a screen of the same series may still cancel.
 *
 * Leaving the detail screen stops the theme, and switching seasons IS leaving
 * it: the screen is keyed on the item, so the strip unmounts one season's page
 * and mounts the next one's in the same commit. Stopping there restarted the
 * sting from its first bar on every switch, which is the movement the strip
 * exists to make cheap. So the stop waits a tick, and a screen that wants the
 * same theme cancels it - the same rule the guard below states for moving
 * between episodes, one level up.
 */
let leaving: ReturnType<typeof setTimeout> | null = null;

function keepPlaying(): void {
  if (leaving === null) return;
  clearTimeout(leaving);
  leaving = null;
}

function stop(): void {
  keepPlaying();
  const a = audio;
  // Cleared BEFORE the early return: leaving it set meant a theme whose fetch
  // was interrupted - by walking away and back quickly, which is ordinary -
  // was never retried for the life of the app, because the guard below saw its
  // own stale value.
  playingUrl = null;
  if (!a) return;
  audio = null;
  fade(a, 0, () => {
    a.pause();
    URL.revokeObjectURL(a.src);
  });
}

/**
 * Play the theme of whatever is on screen.
 *
 * Deliberately quiet and deliberately conditional:
 *
 * - Silent while anything is playing. The page is transparent then and the film
 *   has the room's attention; a theme over it would be two soundtracks.
 * - And silent on the way BACK from one, for the series that was being watched.
 * - The same theme is not restarted when the cursor moves between episodes of
 *   the series it belongs to, because that is most of what someone does on a
 *   season screen and restarting it every time is worse than not having it.
 * - Faded in, never punched in. It starts at a level chosen against a quiet
 *   room, and the moment it most often starts in is the one straight after a
 *   film, when the television's volume is set for dialogue.
 * - Fetched with the credential as a header, like artwork, so the URL never
 *   carries it - which is why it becomes a blob rather than an <audio src>.
 */
export function useTheme(item: MediaItem | null | undefined): void {
  const backend = useApp((s) => s.backend);
  const playing = useShowingPlayer();
  const on = usePrefs((s) => s.themeMusic);
  const url = item && backend && on ? backend.themeUrl(item) : undefined;
  /**
   * `undefined` means the screen does not know yet, which is not the same
   * answer as `null`.
   *
   * A screen replaced by another of the same series arrives with its item still
   * on its way - a round trip, far longer than the tick the stop below waits -
   * and treating that as "nothing to play" restarts the sting from its first
   * bar every time somebody switches season.
   */
  const unknown = item === undefined;

  // The shell HIDES an app window rather than destroying it, and audio in a
  // hidden page is not throttled - so without this, pressing Home from a season
  // screen left the theme looping over the launcher and over whatever app came
  // next.
  useEffect(() => onRelease(() => stop()), []);

  useEffect(() => {
    // Whatever this screen decides, it decides it now: a stop left over from
    // the screen this one replaced must not fire into it and silence a theme
    // that has just been started.
    keepPlaying();
    if (unknown) return;
    if (!backend || !url) {
      stop();
      return;
    }
    if (playing) {
      // THIS screen's theme, which is the only one the question is ever asked
      // about again: what comes back after a film is whatever the screen under
      // it wants, so that is what has to be remembered as silenced. A film
      // started by voice puts a screen up underneath itself, and its theme
      // would otherwise start over the countdown at the end of the episode -
      // the one moment this exists to keep quiet, in a room whose volume is set
      // for a film's dialogue. (It used to read `playingUrl ?? url`, which came
      // to the same answer only because leaving a screen cleared `playingUrl`
      // before the next one asked; that stop is deferred now, so the screen
      // says what it means instead.)
      silencedByPlayback = url;
      stop();
      return;
    }
    // A different series is a different theme, and nothing about it was silenced.
    if (silencedByPlayback && silencedByPlayback !== url) silencedByPlayback = null;
    if (silencedByPlayback === url) return;
    if (playingUrl === url) return;

    let live = true;
    stop();
    playingUrl = url;
    void fetch(url, { headers: backend.imageHeaders() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!live || !blob || playingUrl !== url) return;
        const a = new Audio(URL.createObjectURL(blob));
        // Twice, then silence. Reading a list of twenty-four episodes to the
        // same sting on endless repeat is the version nobody wants.
        let plays = 0;
        a.loop = false;
        a.onended = () => {
          plays += 1;
          if (plays >= 2 || audio !== a) return;
          a.volume = LEVEL;
          void a.play().catch(() => {});
        };
        // From silence. The ramp is what stops the first bar being the loudest
        // thing in the room; `onended` replays at LEVEL, which is right - by
        // then the sting has already been heard once.
        a.volume = 0;
        audio = a;
        void a
          .play()
          .then(() => {
            if (audio === a) fade(a, LEVEL);
          })
          .catch(() => {
            /* autoplay refused, or the box has no audio out here */
          });
      })
      .catch((e) => log.warn("theme music failed", e));

    return () => {
      live = false;
    };
  }, [backend, url, playing, unknown]);

  // Leaving the screen stops it. Without this the theme follows you into the
  // library and plays under a grid of posters - and it is also where the
  // silence a film left behind ends, so coming back to the series later still
  // plays its theme.
  useEffect(
    () => () => {
      silencedByPlayback = null;
      // A tick, not now: the next screen gets to say whether it wants the same
      // theme. Nothing else is deferred, so a screen that is really being left
      // falls silent in the same frame a person would notice.
      keepPlaying();
      leaving = setTimeout(() => {
        leaving = null;
        stop();
      }, 0);
    },
    [],
  );
}

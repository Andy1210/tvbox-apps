// A series' theme music, while you are looking at it.
//
// The server holds one for about six series in ten here. It is what the Plex
// client does on a season screen, and it is the difference between browsing a
// database and being somewhere.

import { useEffect } from "react";
import { useApp } from "./state";
import { usePlayer } from "./playback/player";
import { usePrefs } from "./prefs";
import { onRelease } from "./lifecycle";
import type { MediaItem } from "./backends/types";
import { log } from "./redact";

let audio: HTMLAudioElement | null = null;
let playingUrl: string | null = null;

/** Fade out over this long rather than cutting, which is startling on a TV. */
const FADE_MS = 600;

function stop(): void {
  const a = audio;
  // Cleared BEFORE the early return: leaving it set meant a theme whose fetch
  // was interrupted - by walking away and back quickly, which is ordinary -
  // was never retried for the life of the app, because the guard below saw its
  // own stale value.
  playingUrl = null;
  if (!a) return;
  audio = null;
  const step = a.volume / (FADE_MS / 50);
  const timer = setInterval(() => {
    a.volume = Math.max(0, a.volume - step);
    if (a.volume <= 0.01) {
      clearInterval(timer);
      a.pause();
      URL.revokeObjectURL(a.src);
    }
  }, 50);
}

/**
 * Play the theme of whatever is on screen.
 *
 * Deliberately quiet and deliberately conditional:
 *
 * - Silent while anything is playing. The page is transparent then and the film
 *   has the room's attention; a theme over it would be two soundtracks.
 * - The same theme is not restarted when the cursor moves between episodes of
 *   the series it belongs to, because that is most of what someone does on a
 *   season screen and restarting it every time is worse than not having it.
 * - Fetched with the credential as a header, like artwork, so the URL never
 *   carries it - which is why it becomes a blob rather than an <audio src>.
 */
export function useTheme(item: MediaItem | null | undefined): void {
  const backend = useApp((s) => s.backend);
  const playing = usePlayer((s) => s.current !== null);
  const on = usePrefs((s) => s.themeMusic);
  const url = item && backend && on ? backend.themeUrl(item) : undefined;

  // The shell HIDES an app window rather than destroying it, and audio in a
  // hidden page is not throttled - so without this, pressing Home from a season
  // screen left the theme looping over the launcher and over whatever app came
  // next.
  useEffect(() => onRelease(() => stop()), []);

  useEffect(() => {
    if (!backend || !url || playing) {
      stop();
      return;
    }
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
          if (plays < 2 && audio === a) void a.play().catch(() => {});
        };
        // Under the room's conversation, not over it - but audible: 0.35 was
        // measured on a television as almost nothing.
        a.volume = 0.7;
        audio = a;
        void a.play().catch(() => {
          /* autoplay refused, or the box has no audio out here */
        });
      })
      .catch((e) => log.warn("theme music failed", e));

    return () => {
      live = false;
    };
  }, [backend, url, playing]);

  // Leaving the screen stops it. Without this the theme follows you into the
  // library and plays under a grid of posters.
  useEffect(() => stop, []);
}

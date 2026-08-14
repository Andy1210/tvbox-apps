// A series' theme music, while you are looking at it.
//
// The server holds one for about six series in ten here. It is what the Plex
// client does on a season screen, and it is the difference between browsing a
// database and being somewhere.

import { useEffect } from "react";
import { useApp } from "./state";
import { usePlayer } from "./playback/player";
import type { MediaItem } from "./backends/types";
import { log } from "./redact";

let audio: HTMLAudioElement | null = null;
let playingUrl: string | null = null;

/** Fade out over this long rather than cutting, which is startling on a TV. */
const FADE_MS = 600;

function stop(): void {
  const a = audio;
  if (!a) return;
  audio = null;
  playingUrl = null;
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
  const url = item && backend ? backend.themeUrl(item) : undefined;

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
        a.loop = true;
        // Under the room's conversation, not over it.
        a.volume = 0.35;
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

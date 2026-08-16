// The transport buttons on the remote, for music.
//
// Mounted at the ROOT rather than on the player screen, and that is the whole
// point of the module: music keeps playing while you browse, so the moment those
// buttons are the only control on screen is exactly the moment the player screen
// is not mounted. Handled there, they worked nowhere - which is how they shipped.
//
// A film is left alone. `Player.tsx` runs its own capture-phase handler for the
// same keys whenever a film is loaded, so without the guard below one press
// would pause the film AND step the music queue underneath it. The film's
// handler is the one that yields nothing: it is gated on a film being loaded,
// which is the narrower condition, so this one asks the same question and stands
// down. Ownership is deliberately NOT what is asked - a queue that was stopped
// has released the player but is still on screen, and Play has to be able to
// start it again.
//
// Bubble phase, unlike the film's: the on-screen keyboard and the Back stack
// both listen in capture, so anything that has taken the keyboard for itself
// gets the press first and can stop it reaching here.

import { useEffect } from "react";
import { useMusic } from "./music";
import { usePlayer } from "./player";

/** Inside a song. The queue steppers move between them - see the note below. */
const STEP_MS = 10_000;

/**
 * What one press is asking for, by the name the browser gives the key.
 *
 * Two spellings per stepper on purpose. The remote's own capabilities were read
 * off the box - it really does send KEY_PLAYPAUSE, KEY_NEXTSONG,
 * KEY_PREVIOUSSONG, KEY_REWIND and KEY_FASTFORWARD - but what the browser then
 * calls them is its business, and `MediaNextTrack`/`MediaPreviousTrack` were the
 * names before the current spec settled on `MediaTrackNext`/`MediaTrackPrevious`.
 * Accepting both costs nothing and is the difference between a working button
 * and a dead one; the film player and the Spotify app each accept one set only,
 * which is a thing to fix there rather than to copy.
 */
const ACTIONS = {
  MediaPlayPause: "toggle",
  MediaPlay: "play",
  MediaPause: "pause",
  MediaTrackNext: "next",
  MediaNextTrack: "next",
  MediaTrackPrevious: "previous",
  MediaPreviousTrack: "previous",
  MediaFastForward: "forward",
  MediaRewind: "rewind",
  MediaStop: "stop",
} as const;

/**
 * Act on one key, and say whether it was ours.
 *
 * Separate from the hook so it can be tested against the real stores: what
 * matters here is which press reaches the queue and which is left alone, and
 * that is a decision, not a listener.
 */
export function handleMusicKey(key: string): boolean {
  if (usePlayer.getState().current) return false;
  const m = useMusic.getState();
  // Nothing queued: the press is left alone rather than swallowed, so a remote
  // whose play button doubles as something else still does that.
  if (!m.queue.length) return false;

  const action = (ACTIONS as Record<string, string | undefined>)[key];
  if (!action) return false;

  switch (action) {
    case "toggle":
      m.toggle();
      break;
    // The dedicated pair is not a toggle. A remote that sends them sends the one
    // it means, and answering Play with a pause is worse than doing nothing - it
    // is the opposite of what the button says.
    case "play":
      if (m.state !== "playing") m.toggle();
      break;
    case "pause":
      if (m.state === "playing") m.toggle();
      break;
    case "next":
      void m.next();
      break;
    case "previous":
      void m.previous();
      break;
    // Wind, not skip. On a film the same two keys jump a minute because the item
    // is two hours long; here the item is three minutes and the thing next to it
    // is another song, which the pair above already reaches.
    case "forward":
      m.seek(m.positionMs + STEP_MS);
      break;
    case "rewind":
      m.seek(m.positionMs - STEP_MS);
      break;
    case "stop":
      void m.stop();
      break;
  }
  return true;
}

export function useMusicMediaKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (handleMusicKey(e.key)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

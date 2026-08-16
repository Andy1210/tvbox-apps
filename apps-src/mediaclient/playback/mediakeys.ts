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
 * These names are measured rather than assumed, because no amount of reading
 * says what Chromium calls a key. A uinput device declaring the same codes the
 * box's own remote bridge declares was used to send each button, and the page
 * was asked what arrived:
 *
 *   KEY_PLAYPAUSE 164 -> MediaPlayPause      KEY_NEXTSONG 163 -> MediaTrackNext
 *   KEY_REWIND    168 -> MediaRewind         KEY_PREVIOUSSONG 165 -> MediaTrackPrevious
 *   KEY_FASTFORWARD 208 -> MediaFastForward
 *
 * `code` came back identical to `key` for all five. The older spellings
 * (MediaNextTrack/MediaPreviousTrack) are therefore NOT listed: they are
 * alternative names for keys whose real name is now known, so they can never
 * arrive, and a branch that cannot run is worse than no branch.
 *
 * MediaPlay, MediaPause and MediaStop are a different case and stay although
 * they were not injected: they are separate BUTTONS rather than other spellings
 * of a measured one, and this remote declares the codes behind two of them
 * (KEY_PLAY 207, KEY_STOPCD 166) alongside the five above. Dropping them would
 * lose coverage; dropping a synonym loses nothing.
 */
const ACTIONS = {
  MediaPlayPause: "toggle",
  MediaPlay: "play",
  MediaPause: "pause",
  MediaTrackNext: "next",
  MediaTrackPrevious: "previous",
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

  // Looked up without widening to `string`, so the switch below still has to
  // handle every action the table can produce.
  //
  // `hasOwn` rather than `in`: the table is a plain object, so `"toString" in
  // ACTIONS` is TRUE and hands back a function - truthy, matching no case, and
  // straight into the branch below. A key named after anything on
  // Object.prototype would have thrown inside a window listener.
  const action: (typeof ACTIONS)[keyof typeof ACTIONS] | undefined = Object.hasOwn(ACTIONS, key)
    ? ACTIONS[key as keyof typeof ACTIONS]
    : undefined;
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
    default: {
      // Adding a row to the table without a case here stops COMPILING rather
      // than silently reporting the press handled while nothing happened, which
      // is the failure this whole module exists to undo.
      //
      // At runtime it answers "not ours" instead of throwing. This runs inside a
      // window keydown listener, where an exception is an uncaught error on an
      // ordinary press - a far worse outcome than a key that does nothing, and
      // the exact damage the prototype hole above would have done.
      const unreachable: never = action;
      void unreachable;
      return false;
    }
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

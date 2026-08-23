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
import { ownsPlayer } from "./owner";
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
  // A step between two episodes counts as the film holding the player. `current`
  // is null for the whole of it, so a single press of the play button during one
  // started house music over the episode that was arriving - and the film took
  // the player straight back, leaving the queue claiming to play a song nobody
  // could hear, in the mini-player, on the now-playing screen and in the report
  // the shell publishes.
  if (usePlayer.getState().current || usePlayer.getState().moving) return false;
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

/**
 * One command forwarded from the shell (MQTT: voice, Home Assistant, a phone),
 * and whether it was ours.
 *
 * A sibling of `handleMusicKey` rather than part of it, because the two are NOT
 * the same set of decisions. The shell owns the player this queue plays through,
 * and for a transport command it acts on it ITSELF before forwarding - so
 * pausing here as well would toggle the pause straight back off. What the app
 * still has to do for those is stop lying about them on screen; the ones the
 * shell has no analogue of are the ones it actually performs.
 *
 * `state` arrives in the house's vocabulary (on/off/toggle, and off/one/all for
 * repeat), which is the queue's own vocabulary too - no translation, unlike the
 * Spotify app, whose API has its own words for repeat.
 */
export function handleMusicCommand(cmd: { action?: string; state?: string; sounding?: string } | null): boolean {
  // A film owns the player: its own pause is the shell's business and the queue
  // underneath must not step. Same question the key handler asks, for the same
  // reason - a step between two episodes included, see the note there.
  if (usePlayer.getState().current || usePlayer.getState().moving) return false;
  const m = useMusic.getState();
  if (!m.queue.length) return false;
  // Who the SHELL believes is making the sound. A forwarded command goes to the
  // foreground app as well as to the sounding one, and only the shell can tell
  // them apart: with a queue paused here and Spotify playing, a spoken "next
  // song" skipped Spotify and started house music over it. Empty means the shell
  // does not know (or predates the field), and then the ownership test below is
  // all there is.
  const sounding = String(cmd?.sounding || "");
  if (sounding && sounding !== "mediaclient") return false;
  const action = String(cmd?.action || "").toLowerCase();
  const state = String(cmd?.state || "").toLowerCase();
  // Ownership is asked for the actions that TOUCH the player, not for the two
  // that are a store write. Asking it for all of them dropped a spoken "kapcsold
  // ki a keverést" on a queue that was merely stopped - and shuffle and repeat
  // are outside the silence policy, so the room heard that it had been done.
  const needsPlayer = action === "next" || action === "previous" || action === "lyrics";
  if (needsPlayer && !ownsPlayer("music")) return false;
  switch (action) {
    // Already done to mpv by the shell. Only the label is ours - `state` drives
    // what the player screen and the mini player show, and leaving it on
    // "playing" through a spoken pause is a screen that contradicts the room.
    case "pause":
      if (m.state === "playing") useMusic.setState({ state: "paused" });
      return true;
    case "play":
    case "resume":
      if (m.state === "paused") useMusic.setState({ state: "playing" });
      return true;
    // Also the shell's: its stop reaches the queue as a `finished` carrying a
    // reason, which is what keeps it from advancing to the next song.
    case "stop":
      return true;
    case "next":
      void m.next();
      return true;
    case "previous":
      void m.previous();
      return true;
    case "shuffle":
      if (state === "toggle") m.setShuffle(!m.shuffle);
      else if (state === "on" || state === "off") m.setShuffle(state === "on");
      else return false;
      return true;
    case "repeat":
      if (state === "off" || state === "one" || state === "all") m.setRepeat(state);
      // Through the three in the order the on-screen button cycles them, so a
      // spoken toggle and a pressed one mean the same thing.
      else if (state === "toggle") m.setRepeat(m.repeat === "off" ? "all" : m.repeat === "all" ? "one" : "off");
      else return false;
      return true;
    // Only recorded here: it needs a screen, and which screen is up is not this
    // module's to decide (MediaClient.tsx navigates, then the panel reads this).
    case "lyrics":
      m.askLyrics(state || "on");
      return true;
    default:
      return false;
  }
}

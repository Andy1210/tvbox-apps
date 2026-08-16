// Who is driving the box's single player.
//
// The shell has one mpv, and this app now has two things that want it: a film
// and a queue of songs. They cannot both hold it, and the half that bites is
// not the audio - it is the EVENTS. The bridge reports `finished` to every
// listener, and the video store's handler acts on its own state unconditionally:
// a song ending would reach it, find no film near its end, and call stop() -
// which stops the music that had just started the next track.
//
// So ownership is explicit and cheap: a store claims the player before it hands
// the shell a URL, ignores events while it does not hold it, and is told when it
// loses it so it can drop the state it was keeping.
//
// This module holds no React state on purpose. It is consulted inside an event
// callback that may fire after the component reading it has gone.

export type PlayerOwner = "video" | "music";

let current: PlayerOwner | null = null;
const lost = new Map<PlayerOwner, () => void>();

/**
 * Take the player.
 *
 * The previous owner is told, but the shell is NOT stopped here: the caller is
 * about to hand it another URL, which replaces what is playing anyway, and a
 * stop in between is a round trip that only widens the silence.
 */
export function claimPlayer(who: PlayerOwner): void {
  if (current === who) return;
  const previous = current;
  current = who;
  if (previous) lost.get(previous)?.();
}

/** Give it up, if it is still ours. The guard matters: a stop that arrives after
 *  someone else has claimed it must not clear their ownership. */
export function releasePlayer(who: PlayerOwner): void {
  if (current === who) current = null;
}

export function ownsPlayer(who: PlayerOwner): boolean {
  return current === who;
}

/**
 * Somebody ELSE is holding it.
 *
 * The two stores ask different questions on purpose. Music asks `ownsPlayer`,
 * because a queue only ever runs after an explicit claim. Film asks this one,
 * so that with nobody holding the player its events still arrive: it is the
 * app's original and default player, and a claim that failed to happen must
 * leave it working rather than leave the remote dead.
 */
export function heldByAnother(who: PlayerOwner): boolean {
  return current !== null && current !== who;
}

/** What to forget when the player is taken away. Registered once per store. */
export function whenPlayerLost(who: PlayerOwner, fn: () => void): void {
  lost.set(who, fn);
}

/** Tests, and a sign-out: nobody holds it and nobody is owed a callback. */
export function resetPlayerOwner(): void {
  current = null;
  lost.clear();
}

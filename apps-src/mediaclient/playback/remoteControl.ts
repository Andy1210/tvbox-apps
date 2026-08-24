// What a Companion command actually does here.
//
// Kept apart from the transport that delivers it: the poll loop is about a wire
// and this is about the player, and the two fail for entirely different reasons.
//
// Every path returns whether it WORKED, and that answer reaches the controller
// unchanged - the server proxies it verbatim and the assistant reads the code.
// Answering OK for something that did not happen is how a house ends up saying
// a film is playing while the television shows the launcher.

import { stillSettling, usePlayer } from "./player";
import { useMusic } from "./music";
import { useApp, type Screen } from "../state";
import { doesFocusableExist, getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";
import { isVisible } from "../lifecycle";
import { rememberedVersion } from "../chosenVersion";
import type { CommandResult, CompanionCommand } from "../backends/plex/companion";
import type { MediaBackend, MediaItem } from "../backends/types";
import { log } from "../redact";
import { readRaw, removeRaw } from "../storage";
import { translate, useLocaleStore } from "@sdk";
import { rememberCastQueue, stopped, timelineFor, type ServerAddress, type Timeline } from "./timeline";

/**
 * One of a command's arguments, under either name the server may use.
 *
 * It does NOT forward a controller's query arguments as they were sent: it
 * prefixes each with `query` and capitalises, so `key` arrives as `queryKey`
 * and `offset` as `queryOffset`. Measured against the live server with the
 * assistant's own playMedia. Reading only the plain name got `undefined` for
 * every argument that mattered, which made playMedia a no-op - and because the
 * loop answered 200 anyway, the house said the film was playing.
 *
 * Both are read, in the order the server actually sends them: the documented
 * plain name is what every other implementation of this protocol writes down.
 */
function arg(cmd: CompanionCommand, name: string): string | undefined {
  const prefixed = `query${name[0].toUpperCase()}${name.slice(1)}`;
  return cmd.params[prefixed] ?? cmd.params[name];
}

/** `/playQueues/20406` -> `20406`. The `?own=1&window=200` form is stripped. */
function queueId(containerKey: string | undefined): string | undefined {
  const m = /^\/playQueues\/(\d+)\b/.exec(containerKey ?? "");
  return m ? m[1] : undefined;
}

/**
 * Whether the person this command was meant for is still the person here.
 *
 * Two separate things say no, because only one of them is the backend: signing
 * out replaces it with null, but OPENING the picker changes the screen alone -
 * the backend is replaced when somebody is CHOSEN, which is after a film would
 * have started. Measured before this existed: a film played and reported
 * progress under the previous profile's token with the picker on screen.
 */
function personChanged(who: { backend: unknown }): CommandResult | null {
  const now = useApp.getState();
  if (now.backend !== who.backend) return no("the person on this box changed");
  // A different sentence, because it is a different thing and the assistant
  // reads it out: with nobody chosen yet the backend has not CHANGED - the box
  // is sitting on its own picker, which is what somebody in the room has to
  // answer before anything can be sent here. And only the PICKER offers a
  // profile: telling somebody at a sign-in screen to choose one is an
  // instruction they cannot follow.
  if (now.screen.name === "profiles")
    return no("this box is asking who is watching; choose a profile on it first");
  if (now.screen.name === "login" || now.screen.name === "boot") return no("nobody is signed in on this box");
  return null;
}

/**
 * Nobody has said who is watching yet, so nothing may act on this box.
 *
 * `playMedia` and the navigation paths each refuse this for themselves; the
 * TRANSPORT paths had no check at all, and a skip accepted there takes a claim on
 * the screen - which HIDES the PIN pad the digits are being typed into, for as
 * long as the step lasts. The poll loop is already stopped while the picker is
 * up, so nothing legitimate is turned away: this closes the window a command
 * already in flight arrives through.
 *
 * The screen name is not the whole test: a sign-out is a network round trip
 * before the screen moves, so `backend` is what says nobody is signed in during
 * it. It is deliberately NOT keyed on the app-wide `failure` - that is written by
 * `classify` on any 401 OR 403 from any screen's fetch, including the detail page
 * a cast mounts behind the film it just started, and nothing clears it while a
 * film plays. Measured: one 403 there and every command was refused, "stop"
 * included, with the film still playing. The narrower thing that needed guarding
 * - a controller pressing the "sign in again" button on a failure screen - is
 * guarded in `navigate`, where the press happens.
 *
 * Two sentences, because they are two states and the assistant reads them out:
 * only the picker offers a profile to choose.
 *
 * The two timeline paths are exempt: they change nothing, and this file's own
 * note records that a refused `subscribe` is answered 400 by the server and the
 * phone gives up rather than trying again once somebody has picked.
 */
function nobodyChosen(path: string): CommandResult | null {
  if (path.startsWith("/player/timeline/")) return null;
  const now = useApp.getState();
  const at = now.screen.name;
  if (at === "profiles") return no("this box is asking who is watching; choose a profile on it first");
  if (at === "login" || at === "boot" || !now.backend) return no("nobody is signed in on this box");
  return null;
}

/**
 * A note on the television saying a phone took the screen.
 *
 * The person holding the remote did not press anything, and what they were
 * doing has just ended. `apps/youtube` shows the same note for the same reason;
 * this is the box's own toast, posted through the local door every app on this
 * origin has.
 */
function say(key: string): string {
  // The store rather than the hook: this is not a component, and the note has to
  // be in the language the box is set to at the moment the phone sends it.
  // `locale` is null until the store has resolved one, which is the state a
  // cast can easily arrive in - the app may have started hidden seconds ago.
  return translate(useLocaleStore.getState().locale || "en", key);
}

function castNote(): void {
  try {
    void fetch("/tvbox/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: say("cast.title"),
        message: say("cast.took"),
        duration: 5000,
      }),
    }).catch(() => {});
  } catch (e) {
    /* no shell (dev, tests) */
  }
}

/** The manifest id, which is how this app asks the box to bring it forward. */
const APP_ID = "mediaclient";
/** How long to wait for the box to put this window on screen. */
const FRONT_TIMEOUT_MS = 3_000;

/**
 * Bring this app to the front, and wait until it is actually there.
 *
 * A cast arrives with nobody at the television holding a remote, so whatever it
 * starts has to be reachable: the app may be behind the launcher, behind another
 * app, or hidden since somebody pressed Home an hour ago. The box hides an app
 * rather than closing it, so this page is alive and polling in all three cases -
 * it just is not on screen, and before this the cast was REFUSED for that.
 *
 * The wait is not politeness. A film may only be started by the app the box has
 * in front, so a play sent in the same tick as the request to come forward races
 * the box and is rejected about as often as not. Music has no such rule any more
 * (sound outlives the screen), but it still waits, because the point of showing
 * Now Playing is that the room can see what arrived.
 *
 * Returns whether the window is on screen. A false is not fatal for music and is
 * for a film; each caller decides.
 */
async function bringToFront(): Promise<boolean> {
  if (isVisible()) return true;
  try {
    (typeof window === "undefined" ? undefined : window.tvbox)?.launch?.(APP_ID);
  } catch (e) {
    log.warn("could not ask the box to come forward", e);
  }
  const until = Date.now() + FRONT_TIMEOUT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    if (isVisible()) {
      // Only once it really happened. Somebody in the room did not ask for this
      // and what they were doing has just ended, so they are told who did - the
      // way the box's other cast receiver does it. Saying so BEFORE the request
      // meant announcing a takeover that could still be refused a moment later.
      // Best effort and never awaited: a cast must not fail on a toast.
      castNote();
      return true;
    }
  }
  return false;
}

/**
 * Start a cast of MUSIC, which is a different player with a different queue.
 *
 * Plexamp and the phone app do not send a list: they build a play queue on the
 * server and send its key, so the running order exists only there. Reading it
 * back is what makes a cast album an album - without it the first track plays
 * and the box falls silent.
 *
 * The whole video path is wrong for this, and not only cosmetically: it would
 * hand the track to the film player, take the screen for it and stop whatever
 * the person was listening to.
 */
async function startMusic(
  cmd: CompanionCommand,
  backend: MediaBackend,
  item: MediaItem,
  who: ReturnType<typeof useApp.getState>,
): Promise<CommandResult> {
  let tracks: MediaItem[] = [item];
  let startIndex = 0;
  let entryIds: string[] | undefined;
  let version: string | undefined;
  const qid = queueId(arg(cmd, "containerKey"));
  if (qid) {
    try {
      const queue = await backend.queueItems(qid);
      if (queue.items.length) {
        tracks = queue.items;
        startIndex = Math.min(queue.startIndex, queue.items.length - 1);
        entryIds = queue.entryIds;
        version = queue.version;
      }
    } catch (e) {
      // One track is a worse answer than the album, but it is an honest one and
      // it is what was asked for; the queue is the running order after it.
      log.warn("could not read the cast play queue", e);
    }
  }

  // On screen before the music starts, not as a condition of it: the box lets
  // sound outlive the screen now, so being hidden is no longer a reason to
  // refuse - but a cast nobody can see is a cast nobody can stop from the sofa,
  // and Now Playing is what this turns into.
  // BEFORE coming forward, not only after. Bringing this app to the front is
  // destructive - it ends a native app (a game, with its unsaved state) and
  // stops another app's film - so a command that is going to be refused must
  // never have taken the screen on its way to the refusal.
  const before = personChanged(who);
  if (before) return before;
  await bringToFront();
  // And again, because reading the queue and coming forward both take time and
  // the person can change inside it.
  const changed = personChanged(who);
  if (changed) return changed;

  // `shuffle: false` explicitly, not the box's leftover flag. A controller sends
  // a running order it has already decided - Plexamp shuffles at its end - so
  // inheriting a switch somebody left on plays a different album than the one on
  // the phone: measured, a three-track cast came back 2, 3, 1.
  await useMusic.getState().playQueue(backend, tracks, { startIndex, shuffle: false });
  const after = useMusic.getState();
  // `error` in the music store is a LABEL - the title of the track that could
  // not be played - so it is not sent on as a reason. A song title is not an
  // answer to a phone, and the assistant would read it out as one.
  if (after.error) return no("that music could not be played");
  if (!after.queue.length) return no("the music did not start");
  // Show what is playing. A cast arrives with nobody at the television holding a
  // remote, so the screen it lands on is the whole of what the room sees - and
  // it was the home page, with a song coming out of it and no way to tell which
  // one. Every in-app route to a track does this (MusicItem, MusicList,
  // MusicHome); the cast path was the one that did not.
  //
  // Unless somebody else is at the box by now: `playQueue` is several round trips
  // and this is the step after them, so the same check the film path makes here
  // applies - navigating is what takes the screen away from a profile picker or a
  // sign-in that has come up in the meantime.
  if (!personChanged(who)) useApp.getState().go({ name: "nowPlaying" });
  // Remembered for the report that follows: a phone matches what the box says
  // it is playing against the queue IT built, and a report with no queue on it
  // reads as the box playing one loose track.
  // The queue's own ids, from the queue itself rather than from the controller's
  // command: the command names ONE entry, and the report has to name whichever
  // one is playing as the album moves on. (Where the read failed there is
  // nothing to name, and the report leaves the field out.)
  if (qid) {
    // Keyed by the item, not by position: the store's index walks the shuffled
    // order and these came back in the server's.
    const byItem: Record<string, string> = {};
    tracks.forEach((t, i) => {
      const id = entryIds?.[i];
      if (id && byItem[t.id] === undefined) byItem[t.id] = id;
    });
    rememberCastQueue("music", `/playQueues/${qid}`, { entryIds: byItem, version });
  }
  // No "went off screen" check after the start, unlike the film path, and the
  // difference is real rather than an oversight: a film owns the SCREEN, so one
  // playing behind the launcher is a box lying about what it is showing, while
  // music is sound - it goes on playing while somebody browses, which is what it
  // does when it is started from inside the app.
  //
  // Measured, when this check was here: the shell revealed video for the song
  // (it had not been told the track is audio), mpv's window occluded this one,
  // the page reported itself hidden, and the cast stopped itself two seconds
  // after starting. The cause is fixed at the source - music now starts with
  // `kind: "audio"` - and this check is gone because it was wrong for music
  // either way.
  return ok;
}

/**
 * `/library/metadata/12345` -> `12345`. Anything else is not an item.
 *
 * `/playlists/<id>` is accepted too: a controller casting a playlist addresses
 * it that way, and this server answers `/library/metadata/<id>` for the same
 * number - so refusing the form was refusing the cast.
 */
function ratingKey(key: string | undefined): string | undefined {
  const m = /^\/(?:library\/metadata|playlists)\/(\d+)\b/.exec(key ?? "");
  return m ? m[1] : undefined;
}

/** Which item kinds belong to the music player rather than the film player. */
const MUSIC_KINDS = new Set<string>(["track", "album", "artist", "playlist"]);
/** And which are films, whatever a controller calls them. */
const VIDEO_KINDS = new Set<string>(["movie", "episode", "season", "show"]);

const ok: CommandResult = { ok: true };
const no = (reason: string): CommandResult => ({ ok: false, reason });

/**
 * Whether the item asked for is the one now playing.
 *
 * The player reports both of its failures by putting them in state and
 * returning normally - no player on this box, and a stream it could not resolve
 * - so "the call came back" says nothing about whether a film started. This is
 * the only honest test, and it is why every path that starts something waits
 * for it before answering.
 */
function started(id: string | undefined): CommandResult {
  const after = usePlayer.getState();
  // The error first, and not only as a fallback message: a play that fails
  // before it tears the previous film down leaves `current` holding the OLD
  // one, so a command naming the item already on screen would match it and be
  // answered OK for doing nothing. A successful play clears this.
  if (after.error) return no(after.error);
  if (!id || !after.current || after.current.item.id !== id) return no("the film did not start");
  return ok;
}

/**
 * Run one command.
 *
 * Only the paths this box can honestly answer. An unknown one is refused rather
 * than ignored: the controller gets an answer either way, and a refusal is the
 * true one.
 */
/**
 * Whether the MUSIC player is the one holding playback.
 *
 * Every transport case used to test the film player's `current`, which a cast
 * never sets - so once music was casting, pause, play, next, previous and seek
 * all answered "nothing is playing" while it played on, and STOP answered ok
 * (its "already what was asked for" branch) and stopped nothing. That reaches a
 * phone AND the house assistant, which drives the same six paths.
 */
function music(): boolean {
  const m = useMusic.getState();
  // A step between two episodes is the film holding the player too: `current` is
  // null for the whole of it, so a spoken "pause" during one reached the music
  // queue instead - and a "stop" was answered ok while the next episode started
  // a second later.
  return !filmHasPlayer() && m.queue.length > 0 && m.state !== "stopped";
}

/**
 * The buttons a controller may not press for the household.
 *
 * Both sign the box out, and the second is reachable from a phone by arrows -
 * home, Settings, and two presses. Keyed on the CURSOR rather than on any state
 * near it, because that is what a press reaches, and checked against the live
 * focusables as well: the library does not clear its focus key when the focused
 * component unmounts, so the name alone outlives the button and refused an
 * ordinary OK on a screen with nothing on it but a spinner.
 */
const SIGNS_OUT = new Set(["msg-signin", "settings-signout"]);

/** Said out loud, so the two reasons a step is refused are two sentences. */
const STEPPING = "the box is already changing episode";
const STARTING = "the box has not shown this one yet";

/**
 * Why a step was refused, in the words for it - never "it did not start".
 *
 * Two states and they are not the same claim: one says another step is running,
 * the other says the box has not put the LAST one on screen. Answering the first
 * about the second was measured to tell the room the box was changing episode
 * three seconds after a film had been asked for by voice, when nothing was
 * changing at all.
 */
function stepRefusal(): string | null {
  if (usePlayer.getState().moving) return STEPPING;
  return stillSettling() ? STARTING : null;
}


/** The film player holds the box, a step between two episodes included. */
function filmHasPlayer(): boolean {
  const p = usePlayer.getState();
  return p.current !== null || p.moving !== null;
}

/**
 * Whether PLAY belongs to the music player, which is a wider question.
 *
 * `stop()` keeps the queue and sets the state to "stopped", so after a phone
 * presses Stop the box still holds an album with a cursor in it - and the same
 * phone's Play was answered "nothing is playing" while its own screen showed the
 * album. Pressing play on a stopped queue means start it again from where the
 * cursor is, which is what pressing play on the television does.
 */
function musicToResume(): boolean {
  return !filmHasPlayer() && useMusic.getState().queue.length > 0;
}

/**
 * The D-pad a phone draws once this player claims `navigation`.
 *
 * The presses arrive as commands and leave as key events on this window, which
 * is what every screen here already listens to - the spatial navigation, the
 * player's own overlay, the on-screen keyboard. Sending keys rather than calling
 * into each screen is what keeps a phone and the remote in the room doing
 * exactly the same thing, including on a screen written after this.
 *
 * `back` and `home` are the two that are not keys: Back is the app's own history
 * (the box's Back key is caught by the compositor before a page sees it), and
 * Home means this app's home screen - not the box's launcher, which is a place a
 * phone controlling the media app has no business sending it.
 */
const NAV_KEYS: Record<string, string> = {
  moveUp: "ArrowUp",
  moveDown: "ArrowDown",
  moveLeft: "ArrowLeft",
  moveRight: "ArrowRight",
  select: "Enter",
};

function pressKey(key: string): void {
  if (typeof window === "undefined") return;
  for (const type of ["keydown", "keyup"] as const) {
    window.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
  }
}

async function navigate(what: string): Promise<CommandResult> {
  // Not into the profile picker. A D-pad from a phone is presses, and `select`
  // on that screen chooses a person - so without this a controller could pick a
  // profile, and a PIN pad is a screen you can send digits at. The playback
  // paths refuse for the same reason; this is the same boundary reached by a
  // different door.
  const who = useApp.getState();
  const picking = who.screen.name === "profiles" || who.screen.name === "login" || who.screen.name === "boot";
  if (picking) return no("this box is asking who is watching; choose a profile on it first");
  // Refused BEFORE the screen, like every other refusal here: coming forward
  // ends a native app and stops another app's film, and a command that is going
  // to be refused must not do that on its way to the refusal.
  if (what === "music" && useMusic.getState().queue.length === 0) {
    // Said as what it is. "Nothing is playing" is false while a film is on
    // screen, and the assistant reads these out.
    return no("there is no music on this box to show");
  }
  if (!NAV_KEYS[what] && what !== "back" && what !== "home" && what !== "music") {
    return no("this player does not support that command");
  }
  // A step between two episodes has nothing on screen to navigate, and these keys
  // are DISPATCHED AT WINDOW - where spatial navigation's own listener sits on
  // the same node and, measured in Chromium, runs first whatever the capture flag
  // says. So the overlay's swallow cannot stop them and this is the guard that
  // has to: a phone's `select` would otherwise press whatever is focused on the
  // hidden browsing screen. Refused here, before the screen, like every other
  // refusal in this function.
  if (usePlayer.getState().moving && NAV_KEYS[what]) return no(STEPPING);
  // Nor may a controller press the one button that signs the household out.
  //
  // Guarded on what the press would actually HIT rather than on any state near
  // it, which is what two earlier attempts got wrong. `Message` takes the cursor
  // as it mounts, and behind a film `hidden` hides the pixels and not the focus
  // tree - so the cursor sits on that button for the rest of the film, and the
  // overlay's own swallow cannot stop the press: measured in a real browser, a
  // key dispatched at window runs its listeners in registration order and
  // spatial navigation reaches `onEnterPress` synchronously, before this app's
  // handler exists. Refusing on the app-wide failure flag instead took the whole
  // D-pad away from a phone for the length of any film with a 403 behind it, and
  // refusing every failure KIND took Retry away too.
  const at = getCurrentFocusKey();
  if (what === "select" && at && SIGNS_OUT.has(at) && doesFocusableExist(at))
    return no("there is a message on this box waiting to be read");

  // On screen: a D-pad press means "move what I am looking at", and a hidden
  // window would answer ok while nothing moved.
  if (!(await bringToFront())) return no("the media app could not come to the screen");
  // And still not the picker - coming forward is a round trip, and boot can put
  // it up inside one.
  if (personChanged(who)) return no("this box is asking who is watching; choose a profile on it first");
  const key = NAV_KEYS[what];
  if (key) {
    pressKey(key);
    return ok;
  }
  const app = useApp.getState();
  // Past every refusal, so nothing is given up on the way to one: `bringToFront`
  // and the check above can both still turn this down, and abandoning the step
  // first meant a command reported as failed had already thrown the episode away.
  const step = usePlayer.getState().moving;
  if (step) usePlayer.getState().cancelMove();
  if (what === "back") {
    // The same as the remote's Back during a step: give the step up and stay put.
    // Navigating as well would take the page the person was on as well as the
    // episode, off one press.
    if (step) return ok;
    app.back();
    return ok;
  }
  if (what === "home") {
    app.go({ name: "home" });
    return ok;
  }
  // Where the music IS, which is what this command means on a player: the
  // track, not the library.
  app.go({ name: "nowPlaying" });
  return ok;
}

/**
 * The screen a cast last put up, by identity.
 *
 * What tells "the page this feature opened" from "the page the household opened",
 * which the screen's own shape cannot: both are item pages. A person who
 * navigates away and back gets a different object, so their page is theirs again.
 */
let castScreen: Screen | null = null;

/**
 * Put the film's own browse screen behind the player.
 *
 * A cast leaves whatever screen was up, which is usually the home page - the
 * box answers Plex with the app closed, so most casts open it. That screen is
 * not decoration: the countdown to the next episode is drawn on the SEASON page
 * (see `Detail`), on the episode it is about to play, so a voice-started episode
 * ran out over the home page and stepped to the next one with nothing to show
 * for it. It is also what Back reaches, and what is on screen when the film ends.
 *
 * An episode has no page of its own - its season is the list it belongs to - so
 * that is what opens, pointing at the episode. Anything else opens on itself.
 *
 * A season the server did not name falls back to the SERIES, without pointing at
 * anything: 508 of this library's 8234 episodes carry no `parentRatingKey`, and
 * the same field is what the prev/next lookup uses - so those have no next
 * episode and no countdown either way, and all the screen can honestly be is the
 * thing they belong to. No `focusChildId` there, because an episode is not a
 * child of a series, and naming a key that will never mount is how a page ends
 * up with a dead remote.
 *
 * One step in the history at most: the first cast pushes, so Back returns
 * wherever the household was browsing, and every cast after it replaces. Pushing
 * each time meant an evening of spoken requests had to be pressed back through
 * one film at a time.
 */
function showBrowseScreenFor(item: MediaItem): void {
  const app = useApp.getState();
  const episode = item.kind === "episode";
  const itemId = episode ? (item.parentId ?? item.grandparentId) : item.id;
  if (!itemId) return;
  const screen: Screen =
    episode && item.parentId ? { name: "item", itemId, focusChildId: item.id } : { name: "item", itemId };
  // Only the page a cast put there is replaced, and it is recognised by identity
  // rather than by being an item page at all. Keyed on the KIND, one cast erased
  // the page somebody in the room was reading: they were on a season, another
  // room asked for a film, and `replace` dropped their page out of the history
  // instead of leaving it behind the film.
  if (app.screen === castScreen) app.replace(screen);
  else app.go(screen);
  castScreen = screen;
}

export async function runCompanionCommand(cmd: CompanionCommand): Promise<CommandResult> {
  const waiting = nobodyChosen(cmd.path);
  if (waiting) return waiting;
  const p = usePlayer.getState();
  switch (cmd.path) {
    case "/player/playback/playMedia": {
      const id = ratingKey(arg(cmd, "key"));
      const backend = useApp.getState().backend;
      if (!id) return no("no item in the command");
      if (!backend) return no("nobody is signed in on this box");
      // Nothing about the screen here any more, and that is the change: this
      // refusal fired before either path could ask for the screen itself, so a
      // cast to a box somebody had pressed Home on was answered "not on screen"
      // while this very page was alive and polling behind the launcher. Each
      // path asks in its own way below - a film needs the screen and refuses if
      // it cannot have it, music only wants to be seen.
      //
      // Who this command belongs to, taken BEFORE any round trip: both paths
      // compare against it afterwards, and a snapshot taken later is a snapshot
      // of the change rather than of the person who was there.
      const asked = useApp.getState();

      const item = await backend.item(id);
      // What the thing IS, not what the controller called it: `type` is the
      // controller's word and a cast that omits it would be played as a film.
      // An album, an artist and a playlist are music too - only a TRACK carries
      // a file, so keying on that alone sent a cast album to the film player.
      // The controller's word is a fallback, and only for something that is not
      // itself a film: `type=music` with a film's key handed the film's own file
      // to the music player, with no display mode, no transcode and no subtitle.
      const musical = MUSIC_KINDS.has(item.kind) || (arg(cmd, "type") === "music" && !VIDEO_KINDS.has(item.kind));
      if (musical) return await startMusic(cmd, backend, item, asked);
      const offset = Number(arg(cmd, "offset") ?? "0");
      const at = Number.isFinite(offset) && offset > 0 ? offset : 0;
      // A film needs the screen, so it is asked for rather than required: the
      // box hides an app instead of closing it, and refusing here is what made
      // a cast to a box somebody had pressed Home on answer "not on screen"
      // with the app alive and polling behind the launcher.
      //
      // Still a refusal when it does not work, and the message is the honest
      // one: starting a film into a window nobody is looking at hands the box's
      // one player to a hidden page, and the shell's own refusal is invisible
      // from here - the bridge throws its result away.
      // Asked BEFORE coming forward as well: taking the screen ends a native app
      // and stops another app's film, and a command that is going to be refused
      // must not do that on its way to the refusal.
      const beforeFront = personChanged(asked);
      if (beforeFront) return beforeFront;
      if (!(await bringToFront())) return no("the media app could not come to the screen");
      const afterFront = personChanged(asked);
      if (afterFront) return afterFront;
      await p.play(backend, item, {
        version: rememberedVersion(item.id, item.versions.length),
        // The controller's offset is the whole instruction, so the server's own
        // resume point must not be used as well: with `resume` the film started
        // at `viewOffsetMs` and only then seeked, which begins a transcode in
        // the wrong place and leaves the bar pointing where it never went.
        resume: false,
        startMs: at,
      });
      // What the player DID, not what it was asked to do: an unconditional OK
      // told the house a film was playing while the television showed the
      // launcher.
      const playing = started(item.id);
      if (!playing.ok) return playing;
      // And it must still be the screen in front, or what just started is
      // playing behind the launcher. Stopped rather than left running: the
      // controller is being told this failed, and a box that keeps playing
      // after that is the same lie in the other direction.
      if (!isVisible()) {
        await p.stop();
        return no("the media app went off screen");
      }
      // Last, because it is about the screen UNDER the film and nothing above
      // depends on it - and only once the film really started, so a refused cast
      // does not walk the person to a page they never asked for.
      //
      // Asked one more time who is here, and this one is a REFUSAL: the same shape
      // as the visibility check above, because the same thing is wrong. Measured,
      // a cast whose stream resolved while the household was choosing a profile
      // walked the box off its own PIN pad; leaving the film running instead would
      // hide the pad behind it, which is the same screen taken by a different
      // means. Stopped rather than left playing, for the reason the line above
      // gives: the controller is being told this failed.
      const later = personChanged(asked);
      if (later) {
        await p.stop();
        return later;
      }
      showBrowseScreenFor(item);
      return ok;
    }
    case "/player/playback/play":
      if (musicToResume()) {
        const m = useMusic.getState();
        if (m.state === "paused") m.toggle();
        // Stopped, with the queue still there: start it again where the cursor
        // is. `playAt` is what the television's own play does from this state.
        else if (m.state === "stopped") await m.playAt(m.index);
        return ok;
      }
      if (!p.current) return no(stepRefusal() ?? "nothing is playing");
      if (p.state === "paused") p.togglePause();
      return ok;
    case "/player/playback/pause":
      if (music()) {
        if (useMusic.getState().state === "playing") useMusic.getState().toggle();
        return ok;
      }
      if (!p.current) return no(stepRefusal() ?? "nothing is playing");
      if (p.state === "playing") p.togglePause();
      return ok;
    case "/player/playback/playPause":
      // Guarded on `current`, not on state: the bridge is the box's SHARED mpv,
      // so an unguarded toggle reached it with this app holding nothing.
      if (music()) {
        useMusic.getState().toggle();
        return ok;
      }
      if (!p.current) return no(stepRefusal() ?? "nothing is playing");
      p.togglePause();
      return ok;
    case "/player/playback/stop":
      if (music()) {
        await useMusic.getState().stop();
        return ok;
      }
      // A step in flight is given up as well as stopped, and BOTH can be true at
      // once: a cast landing during a step sets `current` while the step's own
      // claim is still held. Treating the claim as "nothing is playing" answered
      // ok without calling stop at all - the film played on and the house was
      // told it had stopped, which is the one thing this file's header forbids.
      // Forced, because this is an instruction to stop: a plain cancel stands
      // down once the hand-over has begun, and the box was then told to stop,
      // answered ok, and started the next episode a second later anyway.
      if (usePlayer.getState().moving) usePlayer.getState().cancelMove(true);
      if (!usePlayer.getState().current) return ok; // already what was asked for
      await usePlayer.getState().stop();
      return ok;
    // Awaited and then checked, for the same reason playMedia is: `playSibling`
    // starts the next episode through the same call that swallows its failures,
    // so answering before it returned was answering before anything had been
    // tried.
    //
    // The cost is that the poll loop does not poll while this runs, and the move
    // is four or five round trips - the old film's progress and session end,
    // then the new one's stream, markers and detail. On a slow server that can
    // pass the loop's 12 s bound, and the controller is told the command timed
    // out while the episode does start. That is the acceptable direction of the
    // two: a false failure leaves the person looking at what they asked for, a
    // false success leaves the house saying a film is playing over a launcher.
    case "/player/playback/skipNext": {
      if (music()) {
        await useMusic.getState().next();
        return ok;
      }
      // BEFORE the siblings guard, because a step clears `siblings` and re-fetches
      // the neighbours: measured mid-step, "next episode" was answered "nothing
      // follows this" - a claim about the LIBRARY, read out in the room as "that
      // was the last one", about a series that has more.
      const busyNext = stepRefusal();
      if (busyNext) return no(busyNext);
      // Nothing is playing at all - a step that was given up leaves no neighbours
      // behind - and the guard below would answer with a claim about the LIBRARY,
      // which is the sentence this file forbids four lines above it. `upNext` is
      // the difference: an episode has just ended with the countdown on screen,
      // which is exactly when somebody says "next episode", and the neighbours
      // are real. An abandoned step has none, because giving one up cancels the
      // countdown with it.
      if (!p.current && !p.upNext) return no("nothing is playing");
      if (!p.siblings.next) return no("nothing follows this");
      // The item the player says it started, not the one this snapshot held:
      // `siblings` is replaced as the previous film is torn down, so the two
      // can be different episodes by the time the answer is written.
      return started((await p.playSibling("next"))?.id);
    }
    case "/player/playback/skipPrevious": {
      if (music()) {
        await useMusic.getState().previous();
        return ok;
      }
      const busyPrev = stepRefusal();
      if (busyPrev) return no(busyPrev);
      // Nothing is playing at all - a step that was given up leaves no neighbours
      // behind - and the guard below would answer with a claim about the LIBRARY,
      // which is the sentence this file forbids four lines above it. `upNext` is
      // the difference: an episode has just ended with the countdown on screen,
      // which is exactly when somebody says "next episode", and the neighbours
      // are real. An abandoned step has none, because giving one up cancels the
      // countdown with it.
      if (!p.current && !p.upNext) return no("nothing is playing");
      if (!p.siblings.prev) return no("nothing comes before this");
      return started((await p.playSibling("prev"))?.id);
    }
    case "/player/playback/seekTo": {
      if (music()) {
        const to = Number(arg(cmd, "offset"));
        if (!Number.isFinite(to)) return no("no offset in the command");
        useMusic.getState().seek(Math.max(0, to));
        return ok;
      }
      if (!p.current) return no(stepRefusal() ?? "nothing is playing");
      const to = Number(arg(cmd, "offset"));
      if (!Number.isFinite(to)) return no("no offset in the command");
      p.seekTo(Math.max(0, to));
      return ok;
    }
    case "/player/playback/stepForward":
      if (music()) {
        useMusic.getState().seek(useMusic.getState().positionMs + 30_000);
        return ok;
      }
      if (!p.current) return no(stepRefusal() ?? "nothing is playing");
      p.seekBy(30_000);
      return ok;
    case "/player/playback/stepBack":
      if (music()) {
        useMusic.getState().seek(Math.max(0, useMusic.getState().positionMs - 30_000));
        return ok;
      }
      if (!p.current) return no(stepRefusal() ?? "nothing is playing");
      p.seekBy(-30_000);
      return ok;
    // The controller asking to be kept informed about this player. Measured on
    // the box: a phone that has just found the box sends `subscribe` first, and
    // refusing it is where "it appears in the list but will not connect" comes
    // from - the refusal is answered 400 by the server and the phone gives up.
    //
    // Answering ok is enough because the player already tells the SERVER what it
    // is doing (`:/timeline` on every progress report), and the server is what
    // relays to a subscriber. Nothing has to be pushed from here.
    case "/player/timeline/subscribe":
    case "/player/timeline/unsubscribe":
      return ok;
    case "/player/navigation/moveUp":
    case "/player/navigation/moveDown":
    case "/player/navigation/moveLeft":
    case "/player/navigation/moveRight":
    case "/player/navigation/select":
    case "/player/navigation/back":
    case "/player/navigation/home":
    case "/player/navigation/music":
      return await navigate(cmd.path.slice("/player/navigation/".length));
    default:
      log.info(`companion command not supported: ${cmd.path}`);
      return no("this player does not support that command");
  }
}

/**
 * What this box is doing, in the three lines a controller expects.
 *
 * Read at call time from the two stores rather than pushed at them: the report
 * goes out on a one-second tick and on every command, and a snapshot kept
 * anywhere else would be the state as of the last thing that thought to update
 * it. Photos are a kind this app has no player for, so that line is always
 * stopped - and it is still sent, because a controller decides which player it
 * holds from the line that is NOT stopped.
 */
export function companionTimelines(server: ServerAddress): Timeline[] {
  const film = usePlayer.getState();
  const music = useMusic.getState();
  const track = music.queue[music.index];
  return [
    timelineFor(
      "video",
      {
        item: film.current?.item ?? null,
        // Buffering is its own state on the wire: a phone draws a spinner for it
        // and a scrubber for "playing", and a rebuffer reported as playing makes
        // the position bar sit still while the phone insists it is moving.
        state: film.buffering && film.state === "playing" ? "buffering" : film.state,
        positionMs: film.positionMs,
        durationMs: film.durationMs,
      },
      server,
    ),
    timelineFor(
      "music",
      {
        item: track ?? null,
        state: music.buffering && music.state === "playing" ? "buffering" : music.state,
        positionMs: music.positionMs,
        durationMs: music.durationMs,
        shuffle: music.shuffle,
        repeat: music.repeat === "one" ? 1 : music.repeat === "all" ? 2 : 0,
      },
      server,
    ),
    stopped("photo"),
  ];
}

/**
 * The cast that arrived while this app was closed.
 *
 * The box answers Plex while the app is not running (`apps/mediaclient/plugin.js`
 * - a player has to be findable before somebody walks to the television), and a
 * command it cannot execute itself is left here and the app is opened. This is
 * the app picking it up.
 *
 * Left in the app's own store rather than on the url: a playMedia carries the
 * key, the queue, the server and its address, which is well past what the
 * shell's launch-query allows a sender to put on a page - and rightly, since
 * that path exists for untrusted senders.
 *
 * Taken exactly once, and only if it is fresh: a command left by a cast an hour
 * ago is not something to start playing at the person who has just opened the
 * app for their own reasons.
 */
const PENDING_CAST_KEY = "pending-cast";
/**
 * How old a waiting cast may be.
 *
 * Ten minutes rather than one, because of the case that takes the longest and
 * is the reason this exists: with autologin off, a cast opens the app onto the
 * profile picker and nothing can run until somebody walks over and answers it.
 * A minute is not enough to cross a room and type a PIN, and dropping the cast
 * there means the phone said it was playing and nothing ever did. Long enough
 * to survive that, short enough that a cast from this morning does not start
 * playing at whoever opens the app tonight.
 */
const PENDING_CAST_MAX_AGE_MS = 10 * 60_000;

let pendingCastRun: Promise<void> | null = null;

export async function runPendingCast(): Promise<void> {
  // One at a time. The key is removed only after the read returns, so two
  // overlapping calls both see the same command and both play it - and the
  // effect that calls this can run twice (a remount in development, `picking`
  // flipping back inside the read).
  if (pendingCastRun) return pendingCastRun;
  pendingCastRun = takePendingCast().finally(() => {
    pendingCastRun = null;
  });
  return pendingCastRun;
}

async function takePendingCast(): Promise<void> {
  const raw = await readRaw(PENDING_CAST_KEY);
  if (raw === null) return;
  await removeRaw(PENDING_CAST_KEY);
  let pending: { at?: number; profileId?: string; path?: string; params?: Record<string, string> };
  try {
    pending = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!pending.path || !pending.params) return;
  // Whose it was. The box answered Plex as the last person signed in, and this
  // runs when somebody has been chosen - which need not be the same person. A
  // cast addressed to one profile must not play under another's token, history
  // and all, past a picker it never saw. An older stash has no profile on it
  // and is refused rather than guessed at.
  const who = useApp.getState().session?.profileId ?? "";
  if ((pending.profileId ?? "") !== who) {
    log.info("a cast was waiting here for somebody else; ignored");
    return;
  }
  const age = Date.now() - Number(pending.at || 0);
  if (!Number.isFinite(age) || age < 0 || age > PENDING_CAST_MAX_AGE_MS) {
    log.info("a cast was waiting here but it is stale; ignored");
    return;
  }
  log.info("running the cast that opened this app");
  const res = await runCompanionCommand({ path: pending.path, params: pending.params });
  if (!res.ok) log.warn(`the cast that opened this app did not run: ${res.reason}`);
}

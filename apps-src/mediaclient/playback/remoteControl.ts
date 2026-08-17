// What a Companion command actually does here.
//
// Kept apart from the transport that delivers it: the poll loop is about a wire
// and this is about the player, and the two fail for entirely different reasons.
//
// Every path returns whether it WORKED, and that answer reaches the controller
// unchanged - the server proxies it verbatim and the assistant reads the code.
// Answering OK for something that did not happen is how a house ends up saying
// a film is playing while the television shows the launcher.

import { usePlayer } from "./player";
import { useMusic } from "./music";
import { useApp } from "../state";
import { isVisible } from "../lifecycle";
import { rememberedVersion } from "../chosenVersion";
import type { CommandResult, CompanionCommand } from "../backends/plex/companion";
import type { MediaBackend, MediaItem } from "../backends/types";
import { log } from "../redact";

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
  const qid = queueId(arg(cmd, "containerKey"));
  if (qid) {
    try {
      const queue = await backend.queueItems(qid);
      if (queue.items.length) {
        tracks = queue.items;
        startIndex = Math.min(queue.startIndex, queue.items.length - 1);
      }
    } catch (e) {
      // One track is a worse answer than the album, but it is an honest one and
      // it is what was asked for; the queue is the running order after it.
      log.warn("could not read the cast play queue", e);
    }
  }

  // Everything here is checked AGAIN, because reading the queue is a round trip
  // and all three can change inside it. The film path learned each of these the
  // hard way and this one had none of them: measured, a cast answered ok while
  // the app was hidden (so the shell silently refused and nothing played), and
  // while the profile picker was open (so it played as the person who had just
  // left, past the PIN that boundary exists for).
  if (!isVisible()) return no("the media app is not on screen");
  const now = useApp.getState();
  const choosing = now.screen.name === "profiles" || now.screen.name === "login" || now.screen.name === "boot";
  if (now.backend !== who.backend || choosing) return no("the person on this box changed");

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
  // And still on screen after the start, or what is playing belongs to a window
  // nobody is looking at.
  if (!isVisible()) {
    await useMusic.getState().stop();
    return no("the media app went off screen");
  }
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
  return usePlayer.getState().current === null && m.queue.length > 0 && m.state !== "stopped";
}

export async function runCompanionCommand(cmd: CompanionCommand): Promise<CommandResult> {
  const p = usePlayer.getState();
  switch (cmd.path) {
    case "/player/playback/playMedia": {
      const id = ratingKey(arg(cmd, "key"));
      const backend = useApp.getState().backend;
      if (!id) return no("no item in the command");
      if (!backend) return no("nobody is signed in on this box");
      // The shell REFUSES to start the player for an app that is not in front -
      // and it refuses silently, because the bridge discards the result. So the
      // old code played nothing, reported success, and left the box publishing
      // "playing" over a launcher. Said out loud instead: the assistant can put
      // the app in front and ask again.
      if (!isVisible()) return no("the media app is not on screen");
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
      if (musical) {
        if (!isVisible()) return no("the media app is not on screen");
        return await startMusic(cmd, backend, item, asked);
      }
      const offset = Number(arg(cmd, "offset") ?? "0");
      const at = Number.isFinite(offset) && offset > 0 ? offset : 0;
      // Asked again, because the answer above is minutes old by the standards
      // of this function: fetching the item is a round trip to the server, and
      // the app can be sent behind the launcher while it is in flight. Starting
      // a film then hands the box's one player to a window nobody is looking
      // at, and the shell's refusal is invisible from here - the bridge throws
      // its result away.
      if (!isVisible()) return no("the media app is not on screen");
      // And still the same person. Two separate things say it is not, because
      // only one of them is the backend: signing out replaces it with null, but
      // OPENING the picker changes the screen alone - the backend is replaced
      // when somebody is chosen, which is after the film would have started.
      // Measured before this: the film played and reported progress under the
      // previous profile's token with the picker on screen, and the loop's own
      // teardown made it silent rather than visible.
      const app = useApp.getState();
      const choosing = app.screen.name === "profiles" || app.screen.name === "login" || app.screen.name === "boot";
      if (app.backend !== backend || choosing) return no("the person on this box changed");
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
      return ok;
    }
    case "/player/playback/play":
      if (music()) {
        if (useMusic.getState().state === "paused") useMusic.getState().toggle();
        return ok;
      }
      if (!p.current) return no("nothing is playing");
      if (p.state === "paused") p.togglePause();
      return ok;
    case "/player/playback/pause":
      if (music()) {
        if (useMusic.getState().state === "playing") useMusic.getState().toggle();
        return ok;
      }
      if (!p.current) return no("nothing is playing");
      if (p.state === "playing") p.togglePause();
      return ok;
    case "/player/playback/playPause":
      // Guarded on `current`, not on state: the bridge is the box's SHARED mpv,
      // so an unguarded toggle reached it with this app holding nothing.
      if (music()) {
        useMusic.getState().toggle();
        return ok;
      }
      if (!p.current) return no("nothing is playing");
      p.togglePause();
      return ok;
    case "/player/playback/stop":
      if (music()) {
        await useMusic.getState().stop();
        return ok;
      }
      if (!p.current) return ok; // already what was asked for
      await p.stop();
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
      if (!p.current) return no("nothing is playing");
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
      if (!p.current) return no("nothing is playing");
      p.seekBy(30_000);
      return ok;
    case "/player/playback/stepBack":
      if (music()) {
        useMusic.getState().seek(Math.max(0, useMusic.getState().positionMs - 30_000));
        return ok;
      }
      if (!p.current) return no("nothing is playing");
      p.seekBy(-30_000);
      return ok;
    default:
      log.info(`companion command not supported: ${cmd.path}`);
      return no("this player does not support that command");
  }
}

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
import { useApp } from "../state";
import { isVisible } from "../lifecycle";
import { rememberedVersion } from "../chosenVersion";
import type { CommandResult, CompanionCommand } from "../backends/plex/companion";
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

/** `/library/metadata/12345` -> `12345`. Anything else is not an item. */
function ratingKey(key: string | undefined): string | undefined {
  const m = /^\/library\/metadata\/(\d+)\b/.exec(key ?? "");
  return m ? m[1] : undefined;
}

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
function started(id: string): CommandResult {
  const after = usePlayer.getState();
  if (!after.current || after.current.item.id !== id) return no(after.error ?? "the film did not start");
  return ok;
}

/**
 * Run one command.
 *
 * Only the paths this box can honestly answer. An unknown one is refused rather
 * than ignored: the controller gets an answer either way, and a refusal is the
 * true one.
 */
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

      const item = await backend.item(id);
      const offset = Number(arg(cmd, "offset") ?? "0");
      const at = Number.isFinite(offset) && offset > 0 ? offset : 0;
      // Asked again, because the answer above is minutes old by the standards
      // of this function: fetching the item is a round trip to the server, and
      // the app can be sent behind the launcher while it is in flight. Starting
      // a film then hands the box's one player to a window nobody is looking
      // at, and the shell's refusal is invisible from here - the bridge throws
      // its result away.
      if (!isVisible()) return no("the media app is not on screen");
      // And still the same person. Signing out or picking another profile
      // replaces the backend, and a command already in flight would otherwise
      // play as whoever was signed in when it arrived - history and all - with
      // the profile picker on screen.
      if (useApp.getState().backend !== backend) return no("the person on this box changed");
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
      if (!p.current) return no("nothing is playing");
      if (p.state === "paused") p.togglePause();
      return ok;
    case "/player/playback/pause":
      if (!p.current) return no("nothing is playing");
      if (p.state === "playing") p.togglePause();
      return ok;
    case "/player/playback/playPause":
      // Guarded on `current`, not on state: the bridge is the box's SHARED mpv,
      // so an unguarded toggle reached it with this app holding nothing.
      if (!p.current) return no("nothing is playing");
      p.togglePause();
      return ok;
    case "/player/playback/stop":
      if (!p.current) return ok; // already what was asked for
      await p.stop();
      return ok;
    // Awaited and then checked, for the same reason playMedia is: `playSibling`
    // starts the next episode through the same call that swallows its failures,
    // so answering before it returned was answering before anything had been
    // tried.
    case "/player/playback/skipNext": {
      const next = p.siblings.next;
      if (!next) return no("nothing follows this");
      await p.playSibling("next");
      return started(next.id);
    }
    case "/player/playback/skipPrevious": {
      const prev = p.siblings.prev;
      if (!prev) return no("nothing comes before this");
      await p.playSibling("prev");
      return started(prev.id);
    }
    case "/player/playback/seekTo": {
      if (!p.current) return no("nothing is playing");
      const to = Number(arg(cmd, "offset"));
      if (!Number.isFinite(to)) return no("no offset in the command");
      p.seekTo(Math.max(0, to));
      return ok;
    }
    case "/player/playback/stepForward":
      if (!p.current) return no("nothing is playing");
      p.seekBy(30_000);
      return ok;
    case "/player/playback/stepBack":
      if (!p.current) return no("nothing is playing");
      p.seekBy(-30_000);
      return ok;
    default:
      log.info(`companion command not supported: ${cmd.path}`);
      return no("this player does not support that command");
  }
}

// What a Companion command actually does here.
//
// Kept apart from the transport that delivers it: the poll loop is about a wire
// and this is about the player, and the two fail for entirely different reasons.

import { usePlayer } from "./player";
import { useApp } from "../state";
import { rememberedVersion } from "../chosenVersion";
import type { CompanionCommand } from "../backends/plex/companion";
import { log } from "../redact";

/** `/library/metadata/12345` -> `12345`. Anything else is not an item. */
function ratingKey(key: string | undefined): string | undefined {
  const m = /^\/library\/metadata\/(\d+)\b/.exec(key ?? "");
  return m ? m[1] : undefined;
}

/**
 * Run one command.
 *
 * Only the paths this box can honestly answer. An unknown one is logged and
 * ignored rather than guessed at - the controller is told the command was
 * received either way, because the alternative is a phone that hangs, and
 * "nothing happened" is easier to understand than a frozen remote.
 */
export async function runCompanionCommand(cmd: CompanionCommand): Promise<void> {
  const p = usePlayer.getState();
  switch (cmd.path) {
    case "/player/playback/playMedia": {
      const id = ratingKey(cmd.params.key);
      const backend = useApp.getState().backend;
      if (!id || !backend) {
        log.warn("playMedia without an item, or with nobody signed in");
        return;
      }
      // The controller decides WHAT; this box decides HOW. The version, the
      // audio and the subtitle are the household's own choices for this title -
      // a phone asking for a film has no idea that the 1080p copy of it is a 3D
      // encode - so playMedia carries the item and nothing else is taken from
      // it but the offset.
      const item = await backend.item(id);
      const offset = Number(cmd.params.offset ?? "0");
      await p.play(backend, item, {
        version: rememberedVersion(item.id, item.versions.length),
        resume: Number.isFinite(offset) && offset > 0,
      });
      if (Number.isFinite(offset) && offset > 0) usePlayer.getState().seekTo(offset);
      return;
    }
    case "/player/playback/play":
      if (p.state === "paused") p.togglePause();
      return;
    case "/player/playback/pause":
      if (p.state === "playing") p.togglePause();
      return;
    case "/player/playback/playPause":
      p.togglePause();
      return;
    case "/player/playback/stop":
      await p.stop();
      return;
    case "/player/playback/skipNext":
      p.playSibling("next");
      return;
    case "/player/playback/skipPrevious":
      p.playSibling("prev");
      return;
    case "/player/playback/seekTo": {
      const to = Number(cmd.params.offset);
      if (Number.isFinite(to)) p.seekTo(Math.max(0, to));
      return;
    }
    case "/player/playback/stepForward":
      p.seekBy(30_000);
      return;
    case "/player/playback/stepBack":
      p.seekBy(-30_000);
      return;
    default:
      log.info(`companion command ignored: ${cmd.path}`);
  }
}

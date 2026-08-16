// A line along the bottom saying what is playing, while you browse for the next
// thing.
//
// Deliberately NOT focusable. A floating element that takes focus is a trap on a
// D-pad: it sits over a list, spatial navigation resolves by geometry, and Down
// from the last row lands on it instead of doing nothing - so the way back into
// the list is a guess. The way to the player is a named chip in each music
// screen's header, which is somewhere the cursor already goes.

import { useMusic } from "../playback/music";
import { artworkScale } from "../posters";
import { useApp } from "../state";
import { useArtwork } from "./useArtwork";
import { clock } from "../time";
import { PauseIcon } from "../icons";

export function MiniPlayer(): React.JSX.Element | null {
  const backend = useApp((s) => s.backend);
  const screen = useApp((s) => s.screen);
  const queue = useMusic((s) => s.queue);
  const index = useMusic((s) => s.index);
  const state = useMusic((s) => s.state);
  const positionMs = useMusic((s) => s.positionMs);
  const durationMs = useMusic((s) => s.durationMs);

  const item = queue[index];
  // Above the early return: a hook cannot be called conditionally, and this
  // component returns null on most screens.
  // Scaled like every other art request: a fixed pixel size is the right picture
  // on one panel and a blurred or oversized one on the next.
  const cover = useArtwork(
    item && backend ? backend.posterUrl(item, 120 * artworkScale(), 120 * artworkScale()) : undefined,
  );

  // Not over the player itself, which says all of this larger; and not over a
  // film, which owns the screen and the audio both.
  if (!item || state === "stopped" || screen.name === "nowPlaying") return null;

  const artist = item.grandparentTitle ?? item.parentTitle;
  const pct = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

  return (
    <div
      // aria-hidden: everything here is repeated, larger and reachable, on the
      // player screen. Announcing a bar nobody can focus only lengthens the way
      // to what can be.
      aria-hidden="true"
      // A row in the layout, not a bar floating over it. Overlaid, it hid the
      // bottom of every list underneath it - seen on the box: with music playing,
      // the row the cursor was on could be behind the bar, so the D-pad worked
      // and nothing visible moved. As a flex child the screen above simply gets
      // less height and scrolls to its own real end.
      className="pointer-events-none z-20 flex shrink-0 items-center gap-[1vw] bg-black/70 px-[4vw] py-[1vh] backdrop-blur"
    >
      {cover && <img src={cover} alt="" className="h-[5vh] w-[5vh] shrink-0 rounded-[0.5vh] object-cover" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[2.1vh]">{item.title}</span>
        {artist && <span className="block truncate text-[1.8vh] text-fg-dim">{artist}</span>}
      </span>
      <span className="shrink-0 text-[1.9vh] text-fg-dim tabular-nums">
        {clock(positionMs)} / {clock(durationMs)}
      </span>
      <span className="h-[0.5vh] w-[12vw] shrink-0 overflow-hidden rounded-full bg-white/15">
        <span className="block h-full rounded-full bg-white/70" style={{ width: `${pct}%` }} />
      </span>
      {/* Drawn, not typed. A symbol CODEPOINT is what this Chromium has no
          guaranteed font coverage for - the same reason the launcher bans emoji,
          and a missing one draws a tofu box where the state should be - but an
          inline SVG carries its own shape and cannot be missing. Nothing is lost
          by not naming it: this whole bar is aria-hidden, because every word in
          it is repeated - larger and reachable - on the player screen. */}
      {state === "paused" && <PauseIcon className="h-[2.2vh] w-[2.2vh] shrink-0 text-fg-dim" />}
    </div>
  );
}

// The strip that says OK is adding, not playing.
//
// A mode where the one button everybody uses does something else is the classic
// remote trap: there is no pointer, no hover and no menu bar, so the only thing
// that can say what OK means now is a line on the screen. It is drawn for as
// long as the mode is on, on every music screen, and it names the way out.
//
// Deliberately NOT focusable, for the same reason the bar along the bottom is
// not: a strip that takes focus sits between the header and the list, and Up
// from the first row would land on it instead of on the buttons.

import { useI18n } from "@sdk";
import { useMusic } from "../playback/music";

export function AddBanner(): React.JSX.Element | null {
  const { t } = useI18n();
  const adding = useMusic((s) => s.adding);
  const added = useMusic((s) => s.added);
  if (!adding) return null;

  return (
    <div
      aria-hidden="true"
      // A row in the layout rather than something floating over one: overlaid it
      // would cover the top of whatever list is under it, and on a television a
      // row that is behind something still takes the cursor.
      className="pointer-events-none z-20 flex shrink-0 items-baseline gap-[1.2vw] bg-[var(--color-accent)]/25 px-[4vw] py-[0.8vh]"
    >
      <span className="shrink-0 text-[2.1vh] font-semibold">{t("music.addingTitle")}</span>
      <span className="min-w-0 flex-1 truncate text-[1.8vh] text-fg-dim">{t("music.addingHint")}</span>
      {added > 0 && (
        <span className="shrink-0 text-[1.9vh] tabular-nums">{t("music.addedCount", { n: String(added) })}</span>
      )}
    </div>
  );
}

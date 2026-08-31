import { FocusContext, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import type { MediaItem } from "./backends/types";

/** The strip itself, as a focus target. */
export const SEASONS_KEY = "detail-seasons";
/** One season's chip. `detail-` prefixed so `ownsDetailKey` recognises it. */
export const seasonKey = (id: string): string => `detail-season-${id}`;

/**
 * The other seasons of the series, on the season's own screen.
 *
 * An episode has no screen of its own - it is shown on its season - so the
 * episode list IS where somebody is when they want the next season, and getting
 * there meant Back to the series and in again. With twenty-seven of them (South
 * Park, on this library) that is the difference between browsing and giving up.
 *
 * A strip rather than a menu: the count is information. How many seasons there
 * are, and which one this is, are both answered without pressing anything.
 */
export function SeasonStrip({
  seasons,
  currentId,
  title,
  onPick,
  onLeave,
}: {
  seasons: MediaItem[];
  /** The season being shown, which is the one the strip is entered at. */
  currentId: string;
  title: string;
  onPick: (season: MediaItem) => void;
  /**
   * Up and Down out of the strip.
   *
   * Decided by the screen, not by geometry: the row below carries vertical
   * padding that pulls its box over this one, and spatial navigation drops a
   * candidate whose bottom is inside the focused element - the same reason the
   * episode row hands its own Up back to the page. Returns whether it moved, so
   * a press with nothing to reach is left to geometry rather than eaten.
   */
  onLeave: (direction: "up" | "down") => boolean;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({
    focusKey: SEASONS_KEY,
    // Entered at the season being shown, never at the one last pressed: this is
    // where you ARE, and it is what makes the next season one press away. Same
    // decision, for the same reason, as the A-Z strip's.
    saveLastFocusedChild: false,
    preferredChildFocusKey: seasonKey(currentId),
  });

  if (seasons.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <section ref={ref} className="flex shrink-0 flex-col gap-[1vh]">
        <h2 className="shrink-0 px-[4vw] text-[2vh] font-semibold tracking-tight">{title}</h2>
        {/* The page's inset is OUTSIDE the scroller, the way the poster rows do
            it: a scroller carrying the inset as padding clips at its padding
            box, so a chip sliding out of view ran to the screen edge - which on
            a television is under the overscan. */}
        <div className="px-[4vw]">
          {/* Scrolls sideways because a series can have twenty-seven seasons.
              The padding/margin pairs are the focus ring's room, on both axes:
              `overflow-x` clips the other one too. `scroll-px` is the run-up -
              scrollIntoView otherwise parks the chip flush against the edge,
              where the strip looks like it has ended. */}
          <div className="no-scrollbar -mx-[0.8vw] -my-[1vh] flex gap-[0.8vw] overflow-x-auto scroll-px-[6vw] px-[0.8vw] py-[1vh]">
            {seasons.map((season, i) => (
              <FocusButton
                key={season.id}
                focusKey={seasonKey(season.id)}
                onEnter={() => onPick(season)}
                onArrowPress={(dir) => {
                  if (dir === "up" || dir === "down") return !onLeave(dir);
                  // A rail on a television is a ring, the way the poster rows are:
                  // with no candidate past the end, spatial navigation asks the
                  // container instead, and what it does there is not a boundary,
                  // it is whatever was focused last somewhere else on the page.
                  const last = seasons.length - 1;
                  if (last > 0 && ((dir === "left" && i === 0) || (dir === "right" && i === last))) {
                    setFocus(seasonKey(seasons[dir === "left" ? last : 0].id));
                    return false;
                  }
                  return true;
                }}
                // The season being shown is named by weight and fill, not by a
                // glyph: a tick means "watched" everywhere else in this app, and a
                // ring means "focused". Focus still turns the chip white, which
                // overrides both.
                className={`shrink-0 rounded-[0.9vh] px-[1.6vw] py-[0.9vh] text-[1.9vh] whitespace-nowrap ${
                  season.id === currentId ? "bg-white/15 font-semibold" : "bg-white/5 text-fg-dim"
                }`}
              >
                {/* The NUMBER, where the season has one, rather than the name the
                  server carries: a third of this library's series name their
                  seasons ("Secrets Revealed", "The Final Season"), and a strip
                  of names says nothing about which one is the third - while
                  every episode caption beside it reads S3E1. Plex's season 0 is
                  the specials, which have no number and keep their name. */}
                {season.index && season.index > 0 ? t("detail.seasonN", { n: String(season.index) }) : season.title}
              </FocusButton>
            ))}
          </div>
        </div>
      </section>
    </FocusContext.Provider>
  );
}

import { useI18n } from "@sdk";
import type { Score } from "./backends/types";

/**
 * The scores a server holds for an item.
 *
 * All of them, not just the one it puts on a tile: a film with a warm audience
 * and a cold press is a different proposition from one where they agree, and
 * that is exactly the thing someone is deciding on while standing in front of
 * the television.
 *
 * The marks are inline SVG. The box's browser has no colour-emoji font and
 * renders one as a hollow box, which is the sort of detail that only shows up on
 * the actual screen.
 */
export function Scores({ scores }: { scores: Score[] }): React.JSX.Element | null {
  const { t } = useI18n();
  if (scores.length === 0) return null;

  // Critics before audience within a source, sources in a stable order, so the
  // row does not reshuffle between two films.
  const order = ["rottentomatoes", "imdb", "themoviedb"];
  const sorted = [...scores].sort((a, b) => {
    const s = order.indexOf(a.source) - order.indexOf(b.source);
    if (s !== 0) return s;
    return a.kind === "critic" ? -1 : 1;
  });

  return (
    <div className="flex flex-wrap items-center gap-[1.4vw]">
      {sorted.map((s) => (
        <div key={`${s.source}-${s.kind}`} className="flex items-center gap-[0.5vw]">
          <Mark score={s} />
          <span className="text-[1.9vh] font-semibold tabular-nums">{s.value.toFixed(1)}</span>
          <span className="text-[1.7vh] text-fg-dim">{label(s, t)}</span>
        </div>
      ))}
    </div>
  );
}

const NAMES: Record<string, string> = { rottentomatoes: "RT", themoviedb: "TMDB", imdb: "IMDb" };

function label(s: Score, t: (key: string, vars?: Record<string, string>) => string): string {
  // An unknown source is printed as itself. Falling through to "IMDb" would put
  // one service's name on another's number, which is worse than showing nothing
  // - the whole reason this component reads the icon rather than guessing.
  const source = NAMES[s.source] ?? s.source;
  // "viewers" is a word on screen, so it belongs in the locale files rather than
  // in a template here - a Hungarian television would otherwise read "IMDb ·
  // viewers".
  return s.kind === "critic" ? source : t("detail.audienceScore", { source });
}

function Mark({ score }: { score: Score }): React.JSX.Element {
  const size = "h-[2.2vh] w-[2.2vh]";

  if (score.source === "rottentomatoes") {
    // Fresh and rotten are not decoration - a 6.0 that is "rotten" and a 6.0
    // that is "fresh" mean different things on that scale. The audience scale
    // has its own pair of marks, so a critic score and an audience score do not
    // draw the same glyph.
    const audience = score.kind === "audience";
    const rotten = score.sentiment === "rotten" || score.sentiment === "spilled";
    if (audience) {
      return (
        <svg viewBox="0 0 24 24" className={size} aria-hidden="true">
          {rotten ? (
            <path d="M4 14h16l-2 6H6z M6 14l2-6h8l2 6" fill="#4a9b3f" opacity="0.9" />
          ) : (
            <path d="M4 13h16l-2 7H6z M7 13c0-4 2-7 5-7s5 3 5 7" fill="#f5c518" />
          )}
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 24 24" className={size} aria-hidden="true">
        {rotten ? (
          <path d="M12 3l2 4 4-2-1 4 4 1-3 3 3 3-4 1 1 4-4-2-2 4-2-4-4 2 1-4-4-1 3-3-3-3 4-1-1-4 4 2z" fill="#4a9b3f" />
        ) : (
          <circle cx="12" cy="13" r="8" fill="#e2372a" />
        )}
        {!rotten && <path d="M12 5c1-2 3-2 4-1-1 1-2 2-4 1z" fill="#3f8f34" />}
      </svg>
    );
  }

  if (score.source === "imdb") {
    return (
      <span className="rounded-[0.3vh] bg-[#f5c518] px-[0.5vw] py-[0.1vh] text-[1.7vh] font-bold text-black">IMDb</span>
    );
  }

  return (
    <svg viewBox="0 0 24 24" className={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6.1L12 16.8 6.7 19.7l1.1-6.1L3.4 9.4l6-.8z" strokeLinejoin="round" />
    </svg>
  );
}

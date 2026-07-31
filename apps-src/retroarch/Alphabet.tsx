import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useFocusableItem } from "@sdk";
import { ALPHA, SEARCH, TILES, jump } from "./focus";
import type { GameRow } from "./api";

// The A-Z rail: 1044 games are 174 rows of covers, and a D-pad cannot walk that. A
// letter jumps the grid to where that letter starts, the way Plex's index does.
//
// Letters with no games are rendered dimmed and NOT registered as focusable, so the
// D-pad skips them instead of stopping on a dead entry. "#" collects everything that
// does not start with a letter - digits and punctuation, which is most of an arcade or
// homebrew list.
export const OTHER = "#";
const LETTERS = [OTHER, ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];

// Which bucket a label belongs to. Accents are folded first, so "Álom" files under A
// rather than under "#" - a Hungarian library would otherwise pile up in one bucket.
export function bucketOf(label: string): string {
  const first = String(label || "")
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .charAt(0);
  return first >= "A" && first <= "Z" ? first : OTHER;
}

// bucket -> the position in the list where it starts. Built from the list the grid is
// showing, so it follows a search too.
export function bucketStarts(games: GameRow[]): Map<string, number> {
  const at = new Map<string, number>();
  games.forEach((g, i) => {
    const b = bucketOf(g.label);
    if (!at.has(b)) at.set(b, i);
  });
  return at;
}

function Letter({
  letter,
  at,
  current,
  onPreview,
  onCommit,
}: {
  letter: string;
  at: number | undefined;
  current: boolean;
  onPreview: (pos: number) => void;
  onCommit: (pos: number) => void;
}) {
  const has = at !== undefined;
  // An empty letter is not focusable at all - that is what makes the D-pad skip it.
  const { ref, focused } = useFocusableItem(
    {
      focusKey: "alpha-" + letter,
      focusable: has,
      // Moving over a letter scrolls the grid to it and leaves focus here, so the rail
      // can be walked; OK (or left) is what puts focus on the covers.
      onFocus: () => has && onPreview(at as number),
      onEnterPress: () => has && onCommit(at as number),
      onArrowPress: (dir) => {
        if (dir === "left") {
          onCommit(has ? (at as number) : -1);
          return false;
        }
        if (dir === "right") return false; // nothing further right
        return true;
      },
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      className={[
        "h-[2.5vh] leading-[2.5vh] text-center rounded-[0.5vh] text-[1.5vh] font-semibold tabular-nums",
        !has ? "text-white/15" : focused ? "bg-white text-[#06090d]" : current ? "bg-white/15 text-fg" : "text-fg-dim",
      ].join(" ")}
    >
      {letter}
    </div>
  );
}

export function Alphabet({
  games,
  currentBucket,
  onPreview,
  onCommit,
}: {
  games: GameRow[];
  currentBucket: string;
  onPreview: (pos: number) => void;
  onCommit: (pos: number) => void;
}) {
  const { ref, focusKey } = useFocusable({
    focusKey: ALPHA,
    // Up from the top letter belongs to the header, like everywhere else in this view.
    onArrowPress: (dir) => (dir === "up" ? !jump(SEARCH) : true),
  });
  const starts = bucketStarts(games);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="w-[2.2vw] shrink-0 flex flex-col justify-center gap-[0.15vh]">
        {LETTERS.map((l) => (
          <Letter
            key={l}
            letter={l}
            at={starts.get(l)}
            current={l === currentBucket}
            onPreview={onPreview}
            onCommit={(pos) => (pos < 0 ? jump(TILES) : onCommit(pos))}
          />
        ))}
      </div>
    </FocusContext.Provider>
  );
}

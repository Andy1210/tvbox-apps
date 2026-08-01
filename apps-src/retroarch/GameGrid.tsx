import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem, Osk } from "@sdk";
import { coverUrl, shortSystem, type GameRow, type SystemRow } from "./api";
import { Alphabet, bucketOf } from "./Alphabet";
import { ALPHA, EMPTY_ACTION, RAIL, SEARCH, TABS, TILES, jump } from "./focus";

// How many covers a row holds, and how much of the list is MOUNTED around the
// focused row. A library here is 1044 GBA plus 787 NES games; putting three
// thousand <img> tiles in the DOM is what makes a Pi swap instead of scroll, so the
// grid renders a window and moves it as focus travels. The window is deliberately
// much larger than the shift: the focused tile has to survive the move (its focus
// key must still be mounted afterwards) or focus would fall back to nothing.
const COLS = 6;
const WINDOW_ROWS = 12;
const SHIFT_ROWS = 3;
const EDGE_ROWS = 2; // shift once focus comes this close to the mounted edge
// A row is EXACTLY this tall: 24vh of cover, a 3vh label, and a 1vh gap. The number is
// load-bearing rather than cosmetic - the spacers that stand in for unmounted rows and
// the scroll offset a letter jump computes both derive from it, so the tile heights
// below must stay fixed and add up to it.
const ROW_VH = 28;

// The chain the D-pad walks, since geometry cannot find these edges on its own:
// consoles <-> covers <-> letters, and up from any of them to the search button and
// then the tabs. Keys and the safe hop live in focus.ts.

function Console({
  row,
  first,
  active,
  onPick,
  onEnter,
}: {
  row: SystemRow;
  first: boolean;
  active: boolean;
  onPick: (system: string) => void;
  onEnter: () => void;
}) {
  const { ref, focused } = useFocusableItem(
    {
      focusKey: "sys-" + row.system,
      // Moving through the rail changes which console the grid shows, the way a
      // category rail normally previews - but it must NOT pull focus out of the rail,
      // or every press down would land somewhere else and the rail would be
      // impossible to walk. OK (or right) is what commits and moves to the covers.
      onFocus: () => onPick(row.system),
      onEnterPress: onEnter,
      onArrowPress: (dir) => {
        if (dir === "up" && first) {
          jump(TABS);
          return false;
        }
        if (dir === "right") {
          onEnter();
          return false;
        }
        return true;
      },
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      className={[
        "px-[1.2vw] py-[1.2vh] rounded-[1vh] flex items-baseline justify-between gap-[0.8vw] transition-colors",
        focused ? "!bg-white !text-[#06090d]" : active ? "bg-white/10 text-fg" : "text-fg-dim",
      ].join(" ")}
    >
      <span className="text-[1.8vh] font-semibold truncate">{shortSystem(row.system)}</span>
      <span className="text-[1.3vh] opacity-70 tabular-nums">{row.games}</span>
    </div>
  );
}

function Tile({
  system,
  game,
  pos,
  onPlay,
  onFocusPos,
}: {
  system: string;
  game: GameRow;
  pos: number;
  onPlay: (game: GameRow) => void;
  onFocusPos: (pos: number) => void;
}) {
  // onFocus is norigin's callback, not the DOM event: nothing here ever takes real
  // DOM focus, so a focusin listener would never fire.
  const { ref, focused } = useFocusableItem(
    {
      focusKey: "g-" + game.i,
      onEnterPress: () => onPlay(game),
      onFocus: () => onFocusPos(pos),
      onArrowPress: (dir) => {
        if (dir === "up" && pos < COLS) {
          jump(SEARCH, TABS);
          return false;
        }
        // Left out of the first column goes to the console rail, at the console it
        // was left on - geometry would pick whichever row happens to sit next to this
        // tile, which is how "left" used to land on the top console.
        if (dir === "left" && pos % COLS === 0) {
          jump(RAIL);
          return false;
        }
        // ... and right out of the last column goes to the letter rail.
        if (dir === "right" && pos % COLS === COLS - 1) {
          jump(ALPHA);
          return false;
        }
        return true;
      },
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      onClick={() => onPlay(game)}
      className={[
        "rounded-[1vh] overflow-hidden bg-white/5 flex flex-col",
        "transition-[transform,outline-color] duration-150 outline outline-[3px] outline-transparent outline-offset-2",
        focused ? "scale-[1.06] outline-[var(--color-focus)] z-10" : "",
      ].join(" ")}
    >
      <div className="h-[24vh] flex items-center justify-center p-[0.4vh] shrink-0">
        {game.cover ? (
          // Lazy + async decode: a row of six 200 kB PNGs would otherwise block the
          // very focus move that scrolled them into view.
          <img
            src={coverUrl(system, game.i)}
            alt=""
            loading="lazy"
            decoding="async"
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="px-[0.6vw] text-[1.5vh] text-fg-dim text-center">{game.label}</span>
        )}
      </div>
      <div
        className={[
          "px-[0.6vw] h-[3vh] leading-[3vh] text-[1.4vh] truncate shrink-0",
          focused ? "bg-white text-[#06090d] font-semibold" : "text-fg-dim",
        ].join(" ")}
      >
        {game.label}
      </div>
    </div>
  );
}

function SearchButton({ onPress, onClear }: { onPress: () => void; onClear?: () => void }) {
  const { t } = useI18n();
  // Up from here is the tab row; down goes back to whatever tile was last focused
  // (setFocus on a container restores its own last child).
  const upDown = (dir: string) => {
    if (dir === "up") {
      jump(TABS);
      return false;
    }
    if (dir === "down") {
      // The covers if there are any, else the empty-library button, else the
      // console list - never "grid-page", whose children are containers
      // themselves and which resolves to nothing useful. EMPTY_ACTION is in the
      // list because with no games that button is the only thing below here, and
      // it sets no arrow handling of its own: skipping it sent the cursor past
      // the one control the screen was offering.
      jump(TILES, EMPTY_ACTION, RAIL);
      return false;
    }
    return true;
  };
  const { ref, focused } = useFocusableItem({ focusKey: "search", onEnterPress: onPress, onArrowPress: upDown });
  const { ref: cref, focused: cfocused } = useFocusableItem({
    focusKey: "search-clear",
    onEnterPress: () => onClear && onClear(),
    onArrowPress: upDown,
  });
  return (
    <div className="flex items-center gap-[0.6vw]">
      {onClear && (
        <div
          ref={cref}
          onClick={onClear}
          className={[
            "px-[1vw] py-[0.8vh] rounded-[1vh] text-[1.6vh] font-semibold",
            cfocused ? "bg-white text-[#06090d]" : "bg-white/5",
          ].join(" ")}
        >
          {t("retroarch.clear")}
        </div>
      )}
      <div
        ref={ref}
        onClick={onPress}
        className={[
          "px-[1.2vw] py-[0.8vh] rounded-[1vh] text-[1.6vh] font-semibold flex items-center gap-[0.5vw]",
          focused ? "bg-white text-[#06090d]" : "bg-white/5",
        ].join(" ")}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[1.8vh] h-[1.8vh]">
          <circle cx="11" cy="11" r="6" />
          <path d="M15.5 15.5L20 20" strokeLinecap="round" />
        </svg>
        {t("retroarch.search")}
      </div>
    </div>
  );
}

function EmptyAction({ onPress }: { onPress: () => void }) {
  const { t } = useI18n();
  const { ref, focused } = useFocusableItem({ focusKey: EMPTY_ACTION, onEnterPress: onPress });
  return (
    <div
      ref={ref}
      onClick={onPress}
      className={[
        "px-[2vw] py-[1.2vh] rounded-[1.2vh] text-[1.9vh] font-semibold",
        focused ? "bg-white text-[#06090d]" : "bg-white/10 text-fg",
      ].join(" ")}
    >
      {t("retroarch.noLibraryAction")}
    </div>
  );
}

// The console list. A component, not a branch inside GameGrid, so that when there are
// no consoles its focus key does not exist either.
function ConsoleRail({
  systems,
  active,
  onPick,
  onEnter,
}: {
  systems: SystemRow[];
  active: string;
  onPick: (system: string) => void;
  onEnter: () => void;
}) {
  const { ref, focusKey } = useFocusable({ focusKey: RAIL });
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="w-[16vw] shrink-0 overflow-y-auto no-scrollbar flex flex-col gap-[0.4vh]">
        {systems.map((s, k) => (
          <Console
            key={s.system}
            row={s}
            first={k === 0}
            active={s.system === active}
            onPick={onPick}
            onEnter={onEnter}
          />
        ))}
      </div>
    </FocusContext.Provider>
  );
}

// The covers, for the same reason: an empty grid must not leave a focus key behind.
function Tiles({
  system,
  mounted,
  start,
  rows,
  end,
  scroller,
  onPlay,
  onFocusPos,
}: {
  system: string;
  mounted: GameRow[];
  start: number;
  rows: number;
  end: number;
  scroller: MutableRefObject<HTMLDivElement | null>;
  onPlay: (game: GameRow) => void;
  onFocusPos: (pos: number) => void;
}) {
  const { ref, focusKey } = useFocusable({ focusKey: TILES });
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={(el) => {
          // Two owners for one node: our scroller, and spatial navigation's container
          // ref (an object ref, like useFocusableItem merges).
          scroller.current = el;
          (ref as MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        className="flex-1 overflow-y-auto no-scrollbar"
      >
        {/* Spacers stand in for the rows that are not mounted, so the scroll position
            does not jump when the window shifts. */}
        <div style={{ height: start * ROW_VH + "vh" }} />
        <div className="grid grid-cols-6 gap-x-[1vw] gap-y-[1vh]">
          {mounted.map((g, k) => (
            <Tile key={g.i} system={system} game={g} pos={start * COLS + k} onPlay={onPlay} onFocusPos={onFocusPos} />
          ))}
        </div>
        <div style={{ height: Math.max(0, rows - end) * ROW_VH + "vh" }} />
      </div>
    </FocusContext.Provider>
  );
}

export function GameGrid({
  systems,
  system,
  games,
  loading,
  error,
  onSystem,
  onPlay,
  onEmptyAction,
}: {
  systems: SystemRow[];
  system: string;
  games: GameRow[];
  loading: boolean;
  error: string;
  onSystem: (system: string) => void;
  onPlay: (game: GameRow) => void;
  onEmptyAction: () => void;
}) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "grid-page" });
  const [query, setQuery] = useState("");
  const [osk, setOsk] = useState(false);
  const [start, setStart] = useState(0); // first MOUNTED row
  // A letter jump has to wait for the window: the tile it wants to focus is not
  // mounted until `start` has moved, so the position is remembered and the effect
  // below focuses it on the render where it exists.
  const [pendingPos, setPendingPos] = useState<number | null>(null);
  const [bucket, setBucket] = useState(""); // which letter the grid is sitting on
  const scroller = useRef<HTMLDivElement | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? games.filter((g) => g.label.toLowerCase().includes(q)) : games;
  }, [games, query]);

  // A new list starts at the top.
  useEffect(() => {
    setStart(0);
  }, [system, query]);

  // Focus moves to the covers only when the user ASKED for them: the first list of the
  // session, a finished search, or a console committed with OK or right. Walking the
  // console rail changes the list too, and doing it there is what made the rail
  // unusable - each step down previewed a console, its list arrived a fetch later, and
  // focus was yanked out of the rail mid-walk.
  const [toTiles, setToTiles] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (!shown.length) return;
    if (!toTiles && !first.current) return;
    first.current = false;
    setToTiles(false);
    setFocus("g-" + shown[0].i);
  }, [toTiles, shown]);

  const rows = Math.ceil(shown.length / COLS);
  const end = Math.min(rows, start + WINDOW_ROWS);
  const mounted = shown.slice(start * COLS, end * COLS);
  const clampRow = (row: number) => Math.max(0, Math.min(Math.max(0, rows - WINDOW_ROWS), row));

  // Scroll the grid to a position without taking focus (walking the letter rail), and
  // the same plus focus (committing a letter with OK or left).
  const showPos = (pos: number) => {
    const g = shown[pos];
    if (!g) return;
    const row = Math.floor(pos / COLS);
    setBucket(bucketOf(g.label));
    setStart(clampRow(row - 1));
    // Focus stays on the letter, so nothing scrolls the list into view for us - and a
    // moved window with an unmoved scroll offset shows the spacer, i.e. a blank grid.
    if (scroller.current) scroller.current.scrollTop = (Math.max(0, row - 1) * ROW_VH * window.innerHeight) / 100;
  };
  const goPos = (pos: number) => {
    showPos(pos);
    setPendingPos(pos);
  };
  useEffect(() => {
    if (pendingPos === null) return;
    const g = shown[pendingPos];
    if (!g) return setPendingPos(null);
    const row = Math.floor(pendingPos / COLS);
    if (row < start || row >= end) return; // the window is still moving; re-runs on it
    setPendingPos(null);
    setFocus("g-" + g.i);
  }, [pendingPos, start, end, shown]);

  // Move the mounted window when focus approaches either edge of it. The position
  // is the one in the FILTERED list, not the playlist index the focus key carries.
  const onFocusPos = (pos: number) => {
    const b = bucketOf((shown[pos] || { label: "" }).label);
    if (b !== bucket) setBucket(b);
    const row = Math.floor(pos / COLS);
    if (row - start < EDGE_ROWS && start > 0) setStart(Math.max(0, start - SHIFT_ROWS));
    else if (end - row <= EDGE_ROWS && end < rows)
      setStart(Math.min(Math.max(0, rows - WINDOW_ROWS), start + SHIFT_ROWS));
  };

  if (osk)
    return (
      <Osk
        title={t("retroarch.searchTitle")}
        initial={query}
        onDone={(v) => {
          setQuery(v);
          setToTiles(true);
          setOsk(false);
        }}
        onCancel={() => setOsk(false)}
      />
    );

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex gap-[1.5vw] px-[3vw] pb-[2vh]">
        {systems.length > 0 && (
          <ConsoleRail systems={systems} active={system} onPick={onSystem} onEnter={() => setToTiles(true)} />
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-baseline justify-between gap-[1vw] pb-[1vh]">
            <div className="text-[2.2vh] font-semibold truncate">{system || t("retroarch.noConsoles")}</div>
            <div className="flex items-center gap-[1vw] text-[1.6vh] text-fg-dim">
              {query && <span className="truncate max-w-[14vw]">{"“" + query + "”"}</span>}
              <SearchButton onPress={() => setOsk(true)} onClear={query ? () => setQuery("") : undefined} />
            </div>
          </div>
          {error ? (
            <div className="flex-1 flex items-center justify-center text-[2vh] text-fg-dim">{error}</div>
          ) : loading ? (
            <div className="flex-1 flex items-center justify-center text-[2vh] text-fg-dim">
              {t("retroarch.loading")}
            </div>
          ) : !shown.length ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-[2vh] text-[2vh] text-fg-dim">
              <div>
                {query ? t("retroarch.noMatch") : systems.length ? t("retroarch.noGames") : t("retroarch.noLibrary")}
              </div>
              {/* A library with nothing in it has no tile and no console to focus, so
                  this button is the only thing in the view - and the way to the screen
                  that fixes it. */}
              {!query && <EmptyAction onPress={onEmptyAction} />}
            </div>
          ) : (
            <Tiles
              system={system}
              mounted={mounted}
              start={start}
              rows={rows}
              end={end}
              scroller={scroller}
              onPlay={onPlay}
              onFocusPos={onFocusPos}
            />
          )}
        </div>
        {!error && !loading && shown.length > 0 && (
          <Alphabet games={shown} currentBucket={bucket} onPreview={showPos} onCommit={goPos} />
        )}
      </div>
    </FocusContext.Provider>
  );
}

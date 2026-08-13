import { useEffect, useMemo, useRef, useState, type ReactNode, type MutableRefObject } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem, Osk } from "@sdk";
import { mmss, type Track } from "./api";
import { IndexRail, alphaBuckets, positionBuckets, bucketOf, type Bucket } from "./IndexRail";
import { RAIL, ROWS, TABS, TOOLS, jump } from "./focus";

// A track list that stays usable at a thousand rows.
//
// The list is WINDOWED: only the rows around the focused one are in the DOM, with
// spacers standing in for the rest so the scroll position stays honest. Mounting a
// thousand rows costs a thousand spatial-navigation registrations and a thousand
// cover fetches from Spotify's CDN before the first row can be drawn, and it costs
// that whether or not anyone scrolls past row twenty.
//
// A row is EXACTLY this tall: a 5vh cover, 1.1vh of padding above and below, and
// 0.8vh to the next row. The number is load-bearing rather than cosmetic - the
// spacers and the scroll offset a rail jump computes both derive from it, so the
// heights below must keep adding up to it.
const ROW_VH = 8;
const WINDOW_ROWS = 24;
const SHIFT_ROWS = 6;
const EDGE_ROWS = 4; // shift once focus comes this close to the mounted edge
const RAIL_MIN_ROWS = 25; // below this the rail is noise: the list is a few presses long

export type Sort = "order" | "title" | "artist";
const SORTS: Sort[] = ["order", "title", "artist"];

interface Entry {
  t: Track;
  i: number; // position in the ORIGINAL list, which is what playback is told
}

// Accent- and case-insensitive, so "arvizturo" finds "Árvíztűrő" - the box's
// on-screen keyboard makes typing the accents a chore, and nobody should have to.
function fold(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
// sensitivity "base" folds accents the same way `fold` and `bucketOf` do, so the
// sorted order and the A-Z rail agree about where a name belongs.
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function Row({
  entry,
  pos,
  number,
  railLabel,
  onPlay,
  onFocusPos,
  onUp,
}: {
  entry: Entry;
  pos: number;
  number: string; // the track's place in the list, or "" when a sort has reordered it
  railLabel: string; // the rail entry this row sits under, so right enters there
  onPlay: (i: number) => void;
  onFocusPos: (pos: number) => void;
  onUp: () => void;
}) {
  // onFocus is norigin's callback, not the DOM event: nothing here ever takes
  // real DOM focus, so a focusin listener would never fire.
  const { ref, focused } = useFocusableItem(
    {
      focusKey: "tr-" + entry.i,
      onEnterPress: () => onPlay(entry.i),
      onFocus: () => onFocusPos(pos),
      onArrowPress: (dir) => {
        if (dir === "up" && pos === 0) {
          onUp();
          return false;
        }
        // The rows are one column, so geometry finds nothing to the right. The
        // rail is what is there - when it is there at all: a short list does not
        // get one, and swallowing the press then would just make the key dead.
        // Entering it AT the current position matters: focusing the container
        // lands on whichever entry norigin picks, whose preview then scrolls the
        // list somewhere else, so from row 700 the list would jump to the top.
        if (dir === "right") return !jump("rail-" + railLabel, RAIL);
        return true;
      },
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      onClick={() => onPlay(entry.i)}
      className={[
        "h-[7.2vh] mb-[0.8vh] px-[1.5vw] rounded-[1vh] flex items-center gap-[1.2vw] shrink-0",
        focused ? "bg-white text-[#06090d]" : "bg-white/5",
      ].join(" ")}
    >
      {/* The number is what confirms a jump landed where the rail said. Without
          it, "go to 500" and "go to 400" look identical from the sofa. */}
      {number && (
        <div
          className={[
            "w-[4.5vh] shrink-0 text-right text-[1.5vh] tabular-nums",
            focused ? "opacity-60" : "opacity-40",
          ].join(" ")}
        >
          {number}
        </div>
      )}
      {entry.t.image_url ? (
        // Async decode, but NOT loading="lazy". The window above IS the
        // virtualization, so deferring the fetch on top of it saves nothing and
        // costs the one thing that shows: lazy waits for Chromium's intersection
        // check, which lands a frame behind the scroll a keypress just caused, so
        // rows that came into view painted empty until the next press.
        <img
          src={entry.t.image_url}
          alt=""
          decoding="async"
          className="w-[5vh] h-[5vh] rounded-[0.6vh] object-cover shrink-0"
        />
      ) : (
        <div className="w-[5vh] h-[5vh] rounded-[0.6vh] bg-white/10 shrink-0" />
      )}
      <div className="min-w-0 flex-1 text-left">
        <div className="text-[2.1vh] truncate">{entry.t.name}</div>
        <div className={["text-[1.6vh] truncate", focused ? "opacity-70" : "opacity-60"].join(" ")}>
          {entry.t.artists}
        </div>
      </div>
      <div className={["text-[1.6vh] tabular-nums shrink-0", focused ? "opacity-70" : "opacity-60"].join(" ")}>
        {mmss(entry.t.duration_ms)}
      </div>
    </div>
  );
}

function ToolButton({ fk, onEnter, children }: { fk: string; onEnter: () => void; children: ReactNode }) {
  const { ref, focused } = useFocusableItem(
    {
      focusKey: fk,
      onEnterPress: onEnter,
      onArrowPress: (dir) => {
        if (dir === "up") return !jump(TABS);
        if (dir === "down") return !jump(ROWS, RAIL);
        return true;
      },
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      onClick={onEnter}
      className={[
        "px-[1.4vw] py-[0.8vh] rounded-[1vh] text-[1.7vh] font-semibold flex items-center gap-[0.5vw] shrink-0",
        focused ? "bg-white text-[#06090d]" : "bg-white/10",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

// The rows, as a component of their own: an empty list must not leave a focus key
// behind for `jump` to land on.
function Rows({
  mounted,
  start,
  total,
  end,
  numbered,
  railLabelAt,
  scroller,
  onPlay,
  onFocusPos,
  onUp,
}: {
  mounted: Entry[];
  start: number;
  total: number;
  end: number;
  numbered: boolean;
  railLabelAt: (pos: number) => string;
  scroller: MutableRefObject<HTMLDivElement | null>;
  onPlay: (i: number) => void;
  onFocusPos: (pos: number) => void;
  onUp: () => void;
}) {
  const { ref, focusKey } = useFocusable({ focusKey: ROWS });
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={(el) => {
          // Two owners for one node: our scroller, and spatial navigation's
          // container ref (an object ref, like useFocusableItem merges).
          scroller.current = el;
          (ref as MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar flex flex-col"
      >
        <div style={{ height: start * ROW_VH + "vh" }} className="shrink-0" />
        {mounted.map((e, k) => (
          <Row
            key={e.i}
            entry={e}
            pos={start + k}
            number={numbered ? String(start + k + 1) : ""}
            railLabel={railLabelAt(start + k)}
            onPlay={onPlay}
            onFocusPos={onFocusPos}
            onUp={onUp}
          />
        ))}
        <div style={{ height: Math.max(0, total - end) * ROW_VH + "vh" }} className="shrink-0" />
      </div>
    </FocusContext.Provider>
  );
}

export function TrackList({
  tracks,
  actions,
  emptyText,
  onPlay,
}: {
  tracks: Track[];
  actions?: ReactNode; // play-all / shuffle-all, sharing the tools row
  emptyText: string;
  onPlay: (index: number) => void; // index in the ORIGINAL list
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [osk, setOsk] = useState(false);
  const [sort, setSort] = useState<Sort>("order");
  const [start, setStart] = useState(0); // first MOUNTED row
  // A rail jump has to wait for the window: the row it wants to focus is not
  // mounted until `start` has moved, so the position is remembered and the effect
  // below focuses it on the render where it exists.
  const [pendingPos, setPendingPos] = useState<number | null>(null);
  const [bucket, setBucket] = useState("");
  const scroller = useRef<HTMLDivElement | null>(null);

  const shown: Entry[] = useMemo(() => {
    const q = fold(query.trim());
    let list = tracks.map((tr, i) => ({ t: tr, i }));
    if (q) list = list.filter((e) => fold(e.t.name + " " + e.t.artists + " " + e.t.album).includes(q));
    // Sorting is a way to FIND a track, not to reorder playback: what plays is
    // still the playlist from that track on, in the playlist's own order (the
    // entry carries its original position for exactly that).
    if (sort === "title") list = [...list].sort((a, b) => collator.compare(a.t.name, b.t.name));
    else if (sort === "artist")
      list = [...list].sort(
        (a, b) => collator.compare(a.t.artists, b.t.artists) || collator.compare(a.t.name, b.t.name),
      );
    return list;
  }, [tracks, query, sort]);

  const total = shown.length;
  const end = Math.min(total, start + WINDOW_ROWS);
  const mounted = shown.slice(start, end);
  const clampRow = (row: number) => Math.max(0, Math.min(Math.max(0, total - WINDOW_ROWS), row));

  const buckets: Bucket[] = useMemo(
    () => (sort === "order" ? positionBuckets(total) : alphaBuckets(shown.map((e) => sortKey(e, sort)))),
    [shown, sort, total],
  );

  // A new list, a new search or a new order all start at the top.
  useEffect(() => {
    setStart(0);
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [tracks, query, sort]);

  // Coming back from the on-screen keyboard, something has to be focused again:
  // the OSK replaced this whole view, so every key it held is gone. The rows are
  // where the user wants to be, but a search that matched nothing does not render
  // them at all - hence the fallback to the control they would press next. Set on
  // the way out of the OSK and consumed on the render that has the new list, so it
  // cannot land on a row that is about to be filtered away.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    // Wait for the window: `setStart(0)` is a state update, so on the render right
    // after the keyboard closes the list is still scrolled where it was and row 0
    // is not mounted. Jumping now would always miss it and fall through to the
    // search button instead of landing on the first result.
    if (shown.length && start !== 0) return;
    refocus.current = false;
    jump(shown.length ? "tr-" + shown[0].i : "", "br-search-in", TOOLS);
    // `osk` as well as `shown`: cancelling changes no list, so the list identity
    // alone would never signal that the keyboard closed.
  }, [osk, shown, start]);

  const labelAt = (pos: number): string => {
    const e = shown[pos];
    if (!e) return "";
    if (sort !== "order") return bucketOf(sortKey(e, sort));
    let label = "";
    for (const b of buckets) if (b.at !== undefined && b.at <= pos) label = b.label;
    return label;
  };

  // Scroll the list to a position without taking focus (walking the rail), and the
  // same plus focus (committing with OK or left).
  const showPos = (pos: number) => {
    if (!shown[pos]) return;
    setBucket(labelAt(pos));
    setStart(clampRow(pos - 1));
    // Focus stays on the rail, so nothing scrolls the list into view for us - and
    // a moved window with an unmoved scroll offset shows the spacer, i.e. nothing.
    if (scroller.current) scroller.current.scrollTop = (Math.max(0, pos - 1) * ROW_VH * window.innerHeight) / 100;
  };
  const goPos = (pos: number) => {
    showPos(pos);
    setPendingPos(pos);
  };
  useEffect(() => {
    if (pendingPos === null) return;
    const e = shown[pendingPos];
    if (!e) return setPendingPos(null);
    if (pendingPos < start || pendingPos >= end) return; // the window is still moving; re-runs on it
    setPendingPos(null);
    setFocus("tr-" + e.i);
  }, [pendingPos, start, end, shown]);

  // Move the mounted window when focus approaches either edge of it.
  const onFocusPos = (pos: number) => {
    const b = labelAt(pos);
    if (b !== bucket) setBucket(b);
    if (pos - start < EDGE_ROWS && start > 0) setStart(Math.max(0, start - SHIFT_ROWS));
    else if (end - pos <= EDGE_ROWS && end < total) setStart(clampRow(start + SHIFT_ROWS));
  };

  if (osk)
    return (
      <Osk
        title={t("spotify.searchInList")}
        initial={query}
        onDone={(v) => {
          refocus.current = true;
          setQuery(v);
          setOsk(false);
        }}
        onCancel={() => {
          refocus.current = true;
          setOsk(false);
        }}
      />
    );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ToolsRow>
        {actions}
        <ToolButton fk="br-search-in" onEnter={() => setOsk(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[1.8vh] h-[1.8vh]">
            <circle cx="11" cy="11" r="6" />
            <path d="M15.5 15.5L20 20" strokeLinecap="round" />
          </svg>
          {/* Quotes come from the locale, not from the code: Hungarian opens a
              quotation low („) and the rest of this app's strings already do. */}
          {query ? t("spotify.quoted", { text: query }) : t("spotify.searchInList")}
        </ToolButton>
        {query && (
          <ToolButton fk="br-search-clear" onEnter={() => setQuery("")}>
            {t("spotify.clear")}
          </ToolButton>
        )}
        <ToolButton fk="br-sort" onEnter={() => setSort(SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length])}>
          {t("spotify.sort")}: {t("spotify.sort_" + sort)}
        </ToolButton>
        <div className="ml-auto text-[1.6vh] text-fg-dim tabular-nums shrink-0">{total}</div>
      </ToolsRow>

      {!total ? (
        <div className="flex-1 flex items-center justify-center text-[2vh] text-fg-dim px-[8vw] text-center">
          {query ? t("spotify.noMatch") : emptyText}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-[1vw]">
          <Rows
            mounted={mounted}
            start={start}
            total={total}
            end={end}
            // Only in the list's own order, and only unfiltered: under a sort or a
            // filter the row's place in what is shown is not its place in the
            // list, and a number that means neither is worse than none.
            numbered={sort === "order" && !query.trim()}
            railLabelAt={labelAt}
            scroller={scroller}
            onPlay={onPlay}
            onFocusPos={onFocusPos}
            onUp={() => jump(TOOLS, TABS)}
          />
          {total >= RAIL_MIN_ROWS && (
            <IndexRail buckets={buckets} current={bucket} onPreview={showPos} onCommit={goPos} />
          )}
        </div>
      )}
    </div>
  );
}

function sortKey(e: Entry, sort: Sort): string {
  return sort === "artist" ? e.t.artists : e.t.name;
}

// The tools row is a focus container so `jump(TOOLS)` lands on whichever control
// was last used there, rather than always on the first one.
function ToolsRow({ children }: { children: ReactNode }) {
  const { ref, focusKey } = useFocusable({ focusKey: TOOLS });
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="flex items-center gap-[0.8vw] mb-[1.2vh] shrink-0">
        {children}
      </div>
    </FocusContext.Provider>
  );
}

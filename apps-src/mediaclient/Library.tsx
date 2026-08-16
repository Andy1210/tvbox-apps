import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FocusContext, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { Tile } from "./Tile";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { useFocusFallback, useInitialFocus } from "./focus";
import { usePlayer } from "./playback/player";
import { classify, useApp } from "./state";
import { createMover, nearest } from "./moveTo";
import { LibraryFilters, type LibraryView } from "./LibraryFilters";
import type { MediaItem } from "./backends/types";
import { log } from "./redact";

const PAGE = 100;
// Chosen so a tile fills its column: at 26vh tall a 2:3 poster is 17.3vw-ish of
// height, and six of them left a third of each cell empty, which reads as a
// mistake rather than as spacing.
/** Poster height. The tile's own width follows from it at 2:3. */
const TILE_VH = 26;
/**
 * Clearance between one row's tile and the next row's top.
 *
 * Sized against what a tile really occupies: 26vh of poster, a 0.8vh gap and a
 * caption of TWO lines at 1.8vh and line-height 1.5, i.e. 32.2vh. Spatial
 * navigation drops a row from the candidate set the moment the one above it
 * measures taller than the pitch, so this margin is the whole reason Down moves
 * one row rather than two. grid-nav.test.tsx holds it to the same arithmetic.
 */
const ROW_GAP_VH = 8;
/**
 * Seven. Six was tried as a way to make the scroll animation affordable, and it
 * did not - so the density is a look decision again, and this is the look it
 * had.
 */
const COLUMNS = 7;
/** Rows kept mounted above and below the viewport. */
/**
 * Rows kept in the DOM beyond the visible ones, each side.
 *
 * Three rows fit on screen, so 2 meant 7-8 rows and up to 56 tiles for a
 * three-row window - and every one of them is reconciled whenever the window
 * moves, which is once per row of travel and lands in the middle of a scroll.
 * At 1 it is 5-6 rows.
 *
 * It does NOT change when images are decoded: a tile fetches on mount, and
 * mount happens when the window shifts, whatever the margin. What it costs is
 * network lead - one row of it at a fast hold - so this is the floor rather
 * than a number to keep lowering.
 */
const OVERSCAN = 1;

interface Letter {
  key: string;
  title: string;
  size: number;
}

/**
 * A whole library, as a grid.
 *
 * Two things make this different from a row: there can be thousands of items, so
 * only what is near the viewport is mounted and pages are fetched as
 * placeholders come into range; and there is an A-Z strip, because scrolling to
 * S with a D-pad is not a thing anyone will do twice.
 */
/**
 * Whether two scroll positions produce the same set of rendered rows.
 *
 * Both edges, not just the top: the bottom edge crosses a row boundary at a
 * different offset whenever the viewport is not a whole number of rows, so
 * quantising on the top alone would hold the last row back by up to one row.
 */
function sameWindow(a: number, b: number, rowHeight: number, viewport: number): boolean {
  if (rowHeight <= 0) return a === b;
  return (
    Math.floor(a / rowHeight) === Math.floor(b / rowHeight) &&
    Math.ceil((a + viewport) / rowHeight) === Math.ceil((b + viewport) / rowHeight)
  );
}

export function Library({ libraryId, title }: { libraryId: string; title: string }): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const playing = usePlayer((s) => s.current !== null);

  const [letters, setLetters] = useState<Letter[]>([]);
  const [view, setView] = useState<LibraryView>({ sort: "titleSort", desc: false, filters: {}, labels: {} });
  const [arranging, setArranging] = useState(false);
  /**
   * Browsing the library's collections instead of its films.
   *
   * A mode on the same grid rather than a screen of its own: it pages the same
   * way, it is the same shape, and this server holds 461 of them - which is a
   * grid, not a row on the home screen.
   */
  const [mode, setMode] = useState<"items" | "collections">("items");
  /** Sort key to its translated name, for the button. Empty until asked for. */
  const [sortNames, setSortNames] = useState<Record<string, string>>({});
  /** Which (library, mode, sort) the names have been asked for. See below. */
  const asked = useRef(new Set<string>());
  /** How the films were arranged, kept for the way back out of the collections. */
  const saved = useRef<LibraryView | null>(null);
  /** Which letter search may still act. See jumpToLetter. */
  const jump = useRef(0);
  /** The letter last pressed, until the cursor moves off it. See activeLetter. */
  const [pressedLetter, setPressedLetter] = useState<string | null>(null);
  const [items, setItems] = useState<(MediaItem | null)[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  /**
   * Where the grid sits, and what moves it.
   *
   * `scrollTop` is still React state because the virtualiser is computed from
   * it - but it is set from the mover rather than from a scroll event, and only
   * when the WINDOW changes, so moving a row does not re-render the grid.
   */
  const [scrollTop, setScrollTop] = useState(0);
  const mover = useMemo(() => createMover("y"), []);
  /**
   * Two heights, because they answer two different questions.
   *
   * `windowH` is what a vh is worth: the tiles and the padding are sized in vh,
   * so their pixel height follows the window whatever else is on the page.
   *
   * `viewport` is how much of the grid can be seen, and the grid is the flex
   * child BELOW the header - about 92 px shorter than the window here. Using
   * the window for it moved every row that far too little, so the row under the
   * cursor sat with its caption cut off by the screen edge, and the end clamp
   * left the last row permanently unreachable.
   */
  const [windowH, setWindowH] = useState(1080);
  const [viewport, setViewport] = useState(1080);

  const scroller = useRef<HTMLDivElement>(null);
  const pending = useRef(new Set<number>());
  // Pages the server has answered, short or not. Relying on the cells staying
  // null instead means a page that comes back with fewer items than it claims -
  // items removed mid-browse, a section refreshing - is requested again on every
  // render, forever.
  const answered = useRef(new Set<number>());
  const generation = useRef(0);

  // Row height in pixels: tiles are sized in vh, so this has to follow the
  // window rather than be a constant.
  const rowHeight = useMemo(() => Math.round(windowH * ((TILE_VH + ROW_GAP_VH) / 100)), [windowH]);

  /**
   * The visible height of the grid, measured rather than assumed.
   *
   * Its own vertical padding is subtracted for the same reason the rails
   * subtract theirs: `overflow` clips at the PADDING box, so `clientHeight`
   * includes room that exists for the focus ring to be drawn outside a tile,
   * and counting it as usable would move a row that far too little at the end.
   */
  const measure = useCallback((): void => {
    setWindowH(window.innerHeight);
    const box = scroller.current;
    if (!box) return;
    const style = getComputedStyle(box);
    const inner = box.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
    if (inner > 0) setViewport(inner);
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  useEffect(() => {
    if (!backend) return;
    let live = true;
    backend
      .letters(libraryId, view.filters, mode === "collections" ? "collections" : undefined)
      .then((l) => live && setLetters(l))
      .catch(() => {
        /* the strip is an accelerator; the grid works without it */
      });
    return () => {
      live = false;
    };
  }, [backend, libraryId, view.filters, mode]);

  // Only once the order is not the default: naming it on the button needs the
  // server's own word for it, and asking for that on every library open would
  // be a request nobody reads.
  useEffect(() => {
    // Keyed on what has been ASKED, not on what came back. The guard used to be
    // "do I have a name for this sort", with `sortNames` in the dependency list
    // - so a key the server does not name never satisfied it: the answer set a
    // fresh object, the effect ran again, and the library asked forever.
    //
    // What makes such a key reachable is the `of` argument below, added in the
    // same change: an order chosen for the films - release date, critic rating,
    // audience rating, last viewed - is not in the shorter list the server
    // names for collections. Before that argument existed both call sites asked
    // for the same full list and the loop could not be reached, which is why
    // the two halves belong in one commit.
    const want = `${libraryId}:${mode}:${view.sort}`;
    if (!backend || (view.sort === "titleSort" && !view.desc) || asked.current.has(want)) return;
    asked.current.add(want);
    void backend
      .sortOptions(libraryId, mode === "collections" ? "collections" : undefined)
      // The answer is kept even when this effect has been cleaned up. It is
      // merged rather than assigned, so a late one cannot undo a newer answer -
      // and dropping it left the KEY in `asked` with no name behind it, so the
      // button showed the server's raw key for the life of the screen. Reversing
      // an order is two presses on one chip, which is exactly how a request gets
      // cancelled mid-flight.
      .then((o) => setSortNames((prev) => ({ ...prev, ...Object.fromEntries(o.map((x) => [x.key, x.title])) })))
      .catch(() => {
        // The button falls back to the raw key, and the ask is forgotten so a
        // later open can try again - a server that was down once is not a
        // server without names.
        asked.current.delete(want);
      });
  }, [backend, libraryId, mode, view.sort, view.desc]);

  // Loading a page. `letter` selects between the whole library and one bucket;
  // both are asked of the server rather than derived from the other, because the
  // bucket list and the sorted grid do not agree on where accented initials go.
  const loadPage = useCallback(
    async (page: number) => {
      if (!backend || pending.current.has(page) || answered.current.has(page)) return;
      pending.current.add(page);
      const mine = generation.current;
      try {
        const q = { offset: page * PAGE, limit: PAGE, sort: view.sort, desc: view.desc, filters: view.filters };
        const res =
          mode === "collections" ? await backend.collections(libraryId, q) : await backend.libraryPage(libraryId, q);
        if (mine !== generation.current) return;
        answered.current.add(page);

        setTotal((prev) => res.total ?? prev ?? res.items.length);
        setItems((prev) => {
          const size = res.total ?? Math.max(prev.length, page * PAGE + res.items.length);
          const next =
            prev.length === size ? [...prev] : [...prev, ...Array<null>(Math.max(0, size - prev.length)).fill(null)];
          next.length = size;
          res.items.forEach((it, i) => (next[page * PAGE + i] = it));
          return next;
        });
      } catch (e) {
        if (mine !== generation.current) return;
        log.warn("library page failed", e);
        fail(classify(e));
      } finally {
        pending.current.delete(page);
      }
    },
    [backend, fail, libraryId, view, mode],
  );

  // Changing letter, order or filter is a new list: drop what was there rather
  // than let old items show through while the first page arrives.
  useEffect(() => {
    generation.current += 1;
    pending.current.clear();
    answered.current.clear();
    setItems([]);
    setTotal(null);
    setScrollTop(0);
    setPressedLetter(null);
    // A different list, not a move within one: there is nothing to follow from
    // the old position to the new one.
    mover.to(0, false);
    void loadPage(0);
  }, [loadPage]);

  const rows = Math.ceil((total ?? items.length) / COLUMNS) || 0;
  /**
   * Bring a row into the window, animating unless it is a jump.
   *
   * `nearest` in the sense scrollIntoView means it: a row already on screen
   * does not move the grid at all, which is what keeps a sideways press from
   * nudging it. The padding is the scroll-padding the container used to carry -
   * a row flush against the edge is inside the overscan of some televisions.
   *
   * The window is updated from here rather than from a scroll event, and only
   * when it actually changes: moving one row would otherwise re-render every
   * tile in it, in the middle of the animation that is trying to be smooth.
   */
  const showRow = useCallback(
    (row: number) => {
      const padVh = (v: number): number => Math.round((v / 100) * windowH);
      const to = nearest({
        at: mover.at,
        viewport,
        start: row * rowHeight,
        size: rowHeight,
        padStart: padVh(4),
        padEnd: padVh(6),
        max: rows * rowHeight,
      });
      mover.to(to, true);
      setScrollTop((prev) => (sameWindow(prev, to, rowHeight, viewport) ? prev : to));
      // Moving by hand hands the mark back to whatever is on screen.
      setPressedLetter(null);
    },
    [mover, viewport, windowH, rowHeight, rows],
  );

  /** Where the grid may sit at the very end: past this the rows run out. */
  const maxOffset = useCallback(
    (row: number) => Math.max(0, Math.min(row * rowHeight, rows * rowHeight - viewport)),
    [rowHeight, rows, viewport],
  );

  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);

  // Fetch whatever the visible window needs. Pages already in flight are skipped,
  // so a fast scroll does not queue the same request repeatedly.
  useEffect(() => {
    for (let r = firstRow; r < lastRow; r += 1) {
      // Both ends of the row: a row that straddles a page boundary would
      // otherwise only ever ask for the first of the two, and on the last row
      // there is no following row to ask for the second.
      const first = Math.floor((r * COLUMNS) / PAGE);
      const last = Math.floor(((r + 1) * COLUMNS - 1) / PAGE);
      for (let p = first; p <= last; p += 1) void loadPage(p);
    }
  }, [firstRow, lastRow, items, loadPage]);

  // Not a place the arrows may land while the failure screen is up.
  // `useFocusable` registers on the hook call, which is above the early return
  // that swaps this screen for the error - so the container stayed registered
  // with no node and a zero-sized box at the page origin, and one arrow press
  // from "Try again" landed on it. It answers no OK, so the remote was dead
  // with the button still highlighted.
  const { ref: gridRef, focusKey } = useFocusable({
    focusKey: `grid-${libraryId}`,
    saveLastFocusedChild: true,
    focusable: !failure,
  });

  /**
   * Hold the grid, and measure it as it arrives.
   *
   * Measured from the ref rather than only in an effect because the screen
   * returns its loading state first: on mount there is no grid to measure, and
   * nothing would run again once there is one.
   *
   * The callback is memoised because React re-attaches an INLINE ref on every
   * render, which would force a layout per render for a number that changes
   * about never.
   */
  const attachGrid = useCallback(
    (node: HTMLDivElement | null) => {
      scroller.current = node;
      (gridRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      if (node) measure();
    },
    [measure, gridRef],
  );

  const poster = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());

  // Nothing focuses itself, so the first tile has to be told to take it - and a
  // press arriving after the grid was cleared for a letter change has to land
  // somewhere rather than be discarded.
  // The button, when the grid is empty. A filter that matches nothing left the
  // screen with its own "no results" text and the button that could undo it
  // visible but unreachable - every press re-aimed at a cell that was not there.
  useInitialFocus(total === 0 ? "lib-arrange" : "cell-0", total !== null);
  // Every key this screen owns has to be listed. A focusable the guard does not
  // recognise is treated as gone and focus is yanked back to the grid - so the
  // sort-and-filter button could be reached and then lost between the press
  // landing on it and OK arriving, which opened the first film instead.
  useFocusFallback(
    // Always mounted, unlike cell-0: that is only near the top of the grid, so
    // recovering focus while scrolled down aimed at nothing and the remote went
    // dead. The button is on screen in every state this screen has.
    "lib-arrange",
    (key) =>
      key.startsWith("cell-") ||
      key.startsWith("letter-") ||
      key.startsWith("lib-") ||
      // The failure screen replaces this one entirely, so its button is the
      // only key on it.
      key.startsWith("msg-"),
    // Not while the panel is open: this is a window listener, and it stays armed
    // behind the panel. Its predicate rejects every panel key, so any press the
    // panel could not resolve - a row edge, and it wraps twenty-seven chips -
    // threw focus out onto an unmounted grid cell and cost the next press.
    !playing && !arranging,
  );

  // Built before every early return, and rendered in each of them. Applying a
  // sort empties the list, which puts the screen back on "Loading" - and that
  // unmounted the panel mid-press: which filter was open was lost, both option
  // lists were refetched, and focus landed on a grid cell that was not mounted.
  const panel = arranging ? (
    <LibraryFilters
      libraryId={libraryId}
      view={view}
      of={mode === "collections" ? "collections" : undefined}
      // A new order or filter is a new list, so the grid resets to the top on
      // its own; the strip needs nothing, because it holds no state now.
      onApply={setView}
      onClose={() => setArranging(false)}
    />
  ) : null;

  // Every early return keeps the same root element type and renders the panel.
  // React unmounts a subtree when the type at a position changes, so returning
  // a fragment from one branch and a provider from another remounted the panel
  // mid-press: which filter was open was lost and both option lists refetched.
  if (failure)
    return (
      <FocusContext.Provider value={focusKey}>
        {panel}
        <Message failure={failure} onRetry={() => void loadPage(0)} />
      </FocusContext.Provider>
    );
  // `total === null` is "not asked yet"; a total of zero is an answer, and an
  // empty library must say so rather than spin forever.
  if (total === null && items.length === 0)
    return (
      <FocusContext.Provider value={focusKey}>
        {panel}
        <Message loading />
      </FocusContext.Provider>
    );

  const visible: React.JSX.Element[] = [];
  for (let r = firstRow; r < lastRow; r += 1) {
    for (let c = 0; c < COLUMNS; c += 1) {
      const i = r * COLUMNS + c;
      if (total !== null && i >= total) continue;
      const item = items[i];
      visible.push(
        <div
          key={item?.id ?? `cell-${i}`}
          className="absolute"
          style={{ top: r * rowHeight, left: `${(c * 100) / COLUMNS}%`, width: `${100 / COLUMNS}%` }}
        >
          {item ? (
            <Tile
              item={item}
              posterUrl={poster(item)}
              focusKey={`cell-${i}`}
              heightVh={TILE_VH}
              // The grid moves itself; the browser must not also scroll it.
              selfScroll={false}
              onFocusedEl={() => showRow(r)}
              onEnter={() => go({ name: "item", itemId: item.id })}
            />
          ) : (
            // A cell whose page has not arrived still renders, and still takes
            // focus. Without it the rows below the loaded window hold nothing
            // focusable, and pressing Down does nothing at all until the fetch
            // lands - a silent stall that looks like a dead remote.
            <Tile
              item={{ id: `pending-${i}`, kind: "movie", title: "" }}
              focusKey={`cell-${i}`}
              heightVh={TILE_VH}
              selfScroll={false}
              onFocusedEl={() => showRow(r)}
              onEnter={() => {}}
            />
          )}
        </div>,
      );
    }
  }

  const narrowed = Object.keys(view.filters).length;

  /**
   * What the button says.
   *
   * The first chosen filter by name, plus a count of the rest, and the order
   * whenever it is not the default - so the state of the library can be read
   * without opening the panel that set it.
   */
  const summary = ((): string => {
    const parts: string[] = [];
    const first = Object.keys(view.filters)[0];
    if (first) {
      parts.push(view.labels[first] ?? view.filters[first]);
      if (narrowed > 1) parts.push(`+${narrowed - 1}`);
    }
    if (view.sort !== "titleSort" || view.desc) {
      parts.push((sortNames[view.sort] ?? view.sort) + (view.desc ? " \u2193" : ""));
    }
    return parts.length ? `${t("library.arrange")} · ${parts.join(" · ")}` : t("library.arrange");
  })();

  /**
   * Which letter the grid is currently showing.
   *
   * Read off the first item of the top visible row, so the strip confirms a
   * jump and keeps confirming while someone scrolls by hand - without it the
   * letter pressed looks exactly like the other twenty-eight and nothing on
   * screen says the press did anything.
   *
   * The letter pressed wins until the cursor moves, for two reasons. The row
   * this reads is the first MOUNTED one, which is a row of overscan above the
   * first visible one, so every item before the letter's own belongs to the
   * letter before it - the mark was always one early. And in a library that
   * fits on screen the grid cannot move at all, so the mark is the whole of the
   * feedback: without this, pressing Z there changed nothing anywhere.
   */
  const activeLetter = ((): string | null => {
    if (pressedLetter) return pressedLetter;
    const first = items[firstRow * COLUMNS];
    const t = (first?.sortTitle ?? first?.title ?? "").trim();
    if (!t) return null;
    const ch = t[0].toUpperCase();
    const keys = letters.map((l) => l.key);
    if (keys.includes(ch)) return ch;
    const folded = ch.normalize("NFD")[0].toUpperCase();
    return keys.includes(folded) ? folded : "#";
  })();

  /**
   * Take the grid to a letter.
   *
   * The strip is an index into the list, not a filter: it moves the view and
   * leaves the library whole, so what is above and below a letter stays
   * reachable by scrolling - which is what someone expects from an alphabet
   * down the side of a grid.
   */
  const jumpToLetter = (key: string): void => {
    if (!backend) return;
    // Each press starts a search of about eleven requests, and pressing another
    // letter meanwhile must not let the first one land: a late answer scrolls
    // away from the letter last chosen.
    const mine = ++jump.current;
    void backend
      .letterOffset(libraryId, key, {
        sort: view.sort,
        desc: view.desc,
        filters: view.filters,
        of: mode === "collections" ? "collections" : undefined,
      })
      .then((offset) => {
        if (mine !== jump.current) return;
        const row = Math.floor(offset / COLUMNS);
        // Fetch before scrolling: the window is computed from scrollTop, so the
        // rows land already requested rather than as a screen of placeholders.
        void loadPage(Math.floor(offset / PAGE));
        // Not animated. A jump to "S" in a library of 1,700 crosses most of
        // the list, and animating that distance is a second of scenery on the
        // way to somewhere the person already chose - through a window that is
        // rebuilt as it passes, because the grid is virtualised.
        // Clamped, because this is the one move that does not go through
        // `nearest`. A letter whose first row falls inside the last screenful
        // would otherwise put the grid past its end: pressing Z in a library of
        // 256 left one row of posters at the top and the rest of the screen
        // black, until some other press happened to correct it.
        const to = maxOffset(row);
        mover.to(to, false);
        setScrollTop(to);
        setPressedLetter(key);
      })
      .catch((e) => log.warn("letter jump failed", e));
  };

  return (
    <FocusContext.Provider value={focusKey}>
      {/* Over the grid, never instead of it. Replacing it unmounted the moved
          layer while `scrollTop` lived on in React state, so on close a fresh
          one mounted at 0 while the virtualised window was still computed from
          the old position - the only mounted rows were far below the viewport,
          the screen was blank, and the focus guard then set focus to a cell
          that was not mounted, over and over. Every press discarded.

          The mover keeps its own offset across that, and re-applies it when the
          element attaches, so the two cannot disagree the way they did. */}
      {panel}
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-[1.4vw] px-[4vw] py-[2vh]">
          <h1 className="text-[2.6vh] font-semibold tracking-tight">
            {title}
            {total !== null && <span className="ml-[1vw] text-[1.8vh] text-fg-dim tabular-nums">{total}</span>}
          </h1>
          {/* The count beside it, because a filtered library looks like a small
              library otherwise - and someone who left a filter on last week has
              no other way to tell. */}
          {/* Collections are the library's own groupings, so they belong beside
              it rather than on the home screen. */}
          <FocusButton
            focusKey="lib-mode"
            onEnter={() => {
              // Nothing carries INTO a collection list: measured, every list
              // filter returns nothing against collections, and half the orders
              // a film can be put in do not exist for one either - the server
              // answers those with an empty list, which this screen reports as
              // "this library has no collections".
              //
              // Coming back is not the same act, though. Clearing there threw
              // away an order somebody had chosen for the films, with nothing on
              // screen to say so, so it is put back instead.
              if (mode === "items") {
                saved.current = view;
                setView({ sort: "titleSort", desc: false, filters: {}, labels: {} });
                setMode("collections");
              } else {
                setView(saved.current ?? { sort: "titleSort", desc: false, filters: {}, labels: {} });
                setMode("items");
              }
            }}
            className="rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
          >
            {t(mode === "items" ? "library.collections" : "library.allItems")}
          </FocusButton>
          <FocusButton
            focusKey="lib-arrange"
            onEnter={() => setArranging(true)}
            className="rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
          >
            {/* What is on, not how much. A count says a filter exists without
                saying which, and a non-default ORDER left no trace at all -
                which is the same failure, on the half nobody had noticed. */}
            {summary}
          </FocusButton>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div
            ref={attachGrid}
            // Only when the WINDOW changes, not on every scroll event. The two
            // rows below are the whole use of `scrollTop`, and they move a row
            // at a time - but a scroll event fires per frame, so an animated
            // scroll re-rendered the entire grid about thirty times per press
            // instead of once. That is what made a smooth scroll feel worse
            // than an instant one on a Pi: the animation was fine, the work
            // underneath it was not. Returning the previous value tells React
            // there is nothing to do.
            // scroll-padding for the same reason the other screens have it: the
            // bottom row would otherwise land flush against the edge, which is
            // inside TV overscan on some sets.
            // Vertical padding, because the focus ring is drawn OUTSIDE the
            // tile's box and this element clips: without it the top row's ring
            // loses its upper edge against the scroller's own boundary.
            // NOT a scroller. The grid moves itself with a composited
            // transform, the way Plex's own client does - there is no
            // `scrollIntoView` and no `scroll-behavior` anywhere in that
            // bundle; positions are translations and movement is a Web
            // Animations keyframe pair on `transform`.
            //
            // Measured here before that change, per row moved: animating a
            // native scroll cost the GPU process 111-118 ms against 18-23 ms
            // for the same distance jumped, because a scrolling container whose
            // contents are rebuilt underneath it re-rasters what a transform
            // simply moves.
            //
            className="no-scrollbar relative flex-1 overflow-hidden px-[3vw] pt-[1.2vh] pb-[2vh]"
          >
            {total === 0 && (
              <div className="flex h-full items-center justify-center text-[2.2vh] text-fg-dim">
                {/* A filter is the likelier reason for an empty grid, and it is
                    the one somebody can undo - so it is named first. Saying "this
                    library has no collections" while a filter is on is a claim
                    about the library, and 8 of the content ratings a collection
                    list offers do return nothing. */}
                {Object.keys(view.filters).length
                  ? t("library.emptyFiltered")
                  : mode === "collections"
                    ? t("library.noCollections")
                    : t("library.empty")}
              </div>
            )}
            {/* One tall spacer carries the scrollbar; only the visible rows are
                mounted, because a library of several thousand posters is exactly
                the kind of DOM this hardware cannot afford. */}
            <div
              ref={(node) => mover.attach(node)}
              style={{ height: rows * rowHeight, willChange: "transform" }}
              className="relative"
            >
              {visible}
            </div>
          </div>

          {/* Only under an ascending title sort. The jump binary-searches on a
              title's initial, which is monotonic in that order and in no other -
              under "date added" the search returns a meaningless offset and the
              grid lands somewhere arbitrary, with nothing to say why. */}
          {/* Collections bucket by letter exactly as the items do - the server
              answers firstCharacter for them too - so the strip works in both
              modes without a second implementation. */}
          {letters.length > 1 && view.sort === "titleSort" && !view.desc && (
            <LetterStrip letters={letters} onPick={jumpToLetter} active={activeLetter} />
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function LetterStrip({
  letters,
  onPick,
  active,
}: {
  letters: Letter[];
  onPick: (key: string) => void;
  active: string | null;
}): React.JSX.Element {
  const { ref, focusKey } = useFocusable({
    focusKey: "letters",
    saveLastFocusedChild: true,
    // Enter where the grid already is, not at "#". From the M's, reaching M
    // otherwise cost up to twenty-six presses down a strip whose whole purpose
    // is to be faster than scrolling.
    preferredChildFocusKey: active ? `letter-${active}` : undefined,
  });
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        // Every letter at once, and no scrolling. A strip you have to scroll
        // through is slower than scrolling the grid it is meant to shortcut -
        // so the letters shrink to fit the height instead, which they can
        // because each is one character.
        // overflow-y-auto is a backstop, not the plan: 29 letters fit, but a
        // library with every Hungarian accented bucket would exceed the column
        // and the ends would otherwise be clipped while still focusable - which
        // is a dead remote rather than a cosmetic problem.
        className="no-scrollbar flex h-full flex-col items-stretch justify-center gap-[0.1vh] overflow-y-auto py-[1vh] pr-[1vw] pl-[0.4vw]"
        ref={ref}
      >
        {letters.map((l, i) => (
          <FocusButton
            key={l.key}
            focusKey={`letter-${l.key}`}
            onEnter={() => onPick(l.key)}
            onArrowPress={(dir) => {
              // Up from the first letter goes to the header rather than into
              // the grid. Geometry says the grid - it is what lies up and to
              // the left - but the strip is a column of its own, and its top is
              // where someone reaches for the controls above it.
              if (dir === "up" && i === 0) {
                setFocus("lib-arrange");
                return false;
              }
              return true;
            }}
            // A bare character, not a button-shaped box: thirty of those made a
            // second column down the side of the screen. Focus still fills, as
            // it does everywhere else.
            // Bigger than it was, and tighter, because those trade against each
            // other: 29 letters have to fit the column height without scrolling,
            // and at leading 1.35 that capped the size below the 24px floor a
            // television wants for body text. Tighter leading buys the size.
            className={`rounded-[0.5vh] px-[0.6vw] text-center text-[2.4vh] leading-[1.15] ${
              l.key === active ? "font-bold" : "text-fg-dim"
            }`}
          >
            {l.title}
          </FocusButton>
        ))}
      </div>
    </FocusContext.Provider>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  forgetLibraryCursor,
  recallLibraryCursor,
  recallLibraryView,
  rememberLibraryCursor,
  rememberLibraryView,
  type LibraryState,
} from "./libraryView";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { Tile } from "./Tile";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { useFocusFallback, useInitialFocus } from "./focus";
import { useShowingPlayer } from "./playback/player";
import { classify, useApp } from "./state";
import { createMover, nearest, pinScroll } from "@sdk/moveTo";
import { LibraryFilters, type LibraryView } from "./LibraryFilters";
import { LetterStrip, type Letter } from "./LetterStrip";
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

/**
 * A whole library, as a grid.
 *
 * Two things make this different from a row: there can be thousands of items, so
 * only what is near the viewport is mounted and pages are fetched as
 * placeholders come into range; and there is an A-Z strip, because scrolling to
 * S with a D-pad is not a thing anyone will do twice.
 */
/**
 * The grid's visible height, read off the element.
 *
 * Its own vertical padding is subtracted because `overflow` clips at the
 * PADDING box: `clientHeight` includes the room that exists for a focus ring to
 * be drawn outside a tile, and counting it as usable moves a row that far too
 * little at the end of the list.
 *
 * A function rather than only the state that holds it, because there is one
 * moment that needs the answer before the state can carry it: the commit that
 * first renders the grid measures it from a ref callback, so its own layout
 * effects still see the height from before there was a grid.
 */
function gridViewport(box: HTMLElement): number {
  const style = getComputedStyle(box);
  return box.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
}

/**
 * A vh, in pixels.
 *
 * The clearance a row keeps from the edges of the screen is sized in vh like
 * everything else here, and two places move the grid: the ordinary step, and the
 * resume that has to land on the SAME offset the step would have chosen.
 */
function padPx(vh: number, windowH: number): number {
  return Math.round((vh / 100) * windowH);
}

/**
 * How far a row is kept from the top and the bottom of the screen.
 *
 * One pair of numbers rather than three copies, because the A-Z strip's mark is
 * only right while it reads the SAME top pad that `nearest` parks with: with two
 * literals, changing one has the strip silently naming the row above the screen
 * again. No test can see that - at every rest position the grid can reach, any
 * pad from 43 px up to a row's height marks the same letter - so a shared
 * constant is the whole of the guarantee.
 */
const PAD_TOP_VH = 4;
const PAD_BOTTOM_VH = 6;

/**
 * The cells the grid will have mounted when it opens on `index`.
 *
 * The cursor's row is NOT the top of that window: `nearest` only promises the
 * row sits between the two pads, so depending on which side it was brought in
 * from it can be as high as the third row on screen or as low as the third from
 * the bottom. The union of the two is three rows either side, which is seven
 * rows and 49 cells - fewer than a page, so it can straddle at most one
 * boundary and cost at most two requests.
 *
 * A function rather than four lines inside the effect because the band is the
 * whole of the fix: anchored at the cursor's row instead, the top of the screen
 * arrived blank.
 */
export function arrivalCells(index: number): [first: number, last: number] {
  const row = Math.floor(index / COLUMNS);
  return [Math.max(0, (row - 2 - OVERSCAN) * COLUMNS), (row + 4) * COLUMNS - 1];
}

/**
 * Every focus key this screen can own, in any of its states.
 *
 * A predicate over names rather than over anything live, so a check about
 * whether the cursor is still somewhere this screen owns cannot drift from the
 * list of keys it hands out. A key it misses is treated as gone, and focus is
 * yanked off it.
 */
function ownsKey(key: string): boolean {
  return (
    key.startsWith("cell-") ||
    key.startsWith("letter-") ||
    key.startsWith("lib-") ||
    // The failure screen replaces this one entirely, so its button is the only
    // key on it.
    key.startsWith("msg-")
  );
}

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
  const playing = useShowingPlayer();

  const [letters, setLetters] = useState<Letter[]>([]);
  const kept = useRef(recallLibraryView(libraryId));
  const [view, setView] = useState<LibraryView>(
    kept.current?.view ?? { sort: "titleSort", desc: false, filters: {}, labels: {} },
  );
  const [arranging, setArranging] = useState(false);
  /**
   * Browsing the library's collections instead of its films.
   *
   * A mode on the same grid rather than a screen of its own: it pages the same
   * way, it is the same shape, and this server holds 461 of them - which is a
   * grid, not a row on the home screen.
   */
  const [mode, setMode] = useState<"items" | "collections">(kept.current?.mode ?? "items");
  /** Sort key to its translated name, for the button. Empty until asked for. */
  const [sortNames, setSortNames] = useState<Record<string, string>>({});
  /** Which (library, mode, sort) the names have been asked for. See below. */
  const asked = useRef(new Set<string>());
  /**
   * Whether an error has been on this screen at all.
   *
   * The deferred initial focus is held back while the failure screen is up, so
   * on a failure during the resume it has never fired - and it would then fire
   * the moment Try again clears the error, putting the cursor on the resumed
   * poster about a millisecond after the OK that dismissed the screen. The same
   * press, repeated by a held button or by anyone who taps twice at an error,
   * then lands there: measured on a box, it started a film nobody chose, which
   * here means the shared mpv, a display-mode switch and a second of wind-down
   * to get out of. An entry failure is exactly what the arrival requests made
   * ordinary, so this closes it by leaving the cursor where the failure screen
   * left it, the way the screen behaved before any of this.
   *
   * What that costs is one press: the recovery guard below puts the cursor back
   * on the next arrow or OK. Three attempts at spending that press instead each
   * ended somewhere worse - a film, a cursor behind an open panel, and an error
   * screen whose own button could not be reached after a retry that failed
   * again - so the press stays spent.
   */
  const sawFailure = useRef(false);
  useEffect(() => {
    if (failure) sawFailure.current = true;
  }, [failure]);
  /** How the films were arranged, kept for the way back out of the collections. */
  const saved = useRef<LibraryView | null>(kept.current?.saved ?? null);
  // Opening anything from here unmounts this screen, so what was chosen is
  // written out as it changes rather than on the way out - there is no way out
  // to hook.
  useEffect(() => {
    const state: LibraryState = { view, mode, saved: saved.current };
    rememberLibraryView(libraryId, state);
  }, [libraryId, view, mode]);

  /**
   * Where the cursor was when this library was last left, read once on mount.
   *
   * Opening anything from the grid unmounts this screen, so a film opened from
   * the middle of a library came back to an alphabetical list at the top, with
   * the title just watched somewhere off the bottom of the screen. The cursor
   * is what is remembered rather than the film that was opened, so moving off
   * it with the arrows and leaving by some other route is remembered too - the
   * screen returns to where the person left it, not to what they last played.
   *
   * Spent by the effect below, and read during render for the cell to open on.
   */
  const resume = useRef(recallLibraryCursor(libraryId));
  /**
   * The cell to open the grid on, or null while the resume is still pending.
   *
   * Null is what holds `useInitialFocus` back: the first cell would otherwise
   * take the cursor before the grid has moved, which drags the grid back to the
   * top and undoes the resume. With nothing to resume it starts at 0 and the
   * screen behaves exactly as it did.
   */
  const [startCell, setStartCell] = useState<number | null>(resume.current ? null : 0);
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
  const pin = useMemo(() => pinScroll(), []);
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

  /** The visible height of the grid, measured rather than assumed. */
  const measure = useCallback((): void => {
    setWindowH(window.innerHeight);
    const box = scroller.current;
    if (!box) return;
    const inner = gridViewport(box);
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
  /**
   * Which list this last ran for, as the three things that define one.
   *
   * Not a "has this run before" flag. The effect is keyed on `loadPage`, whose
   * identity also moves for reasons that are not a new list, and a run counter
   * reads any of those as one: React's Strict Mode sets an effect up twice on
   * mount, which would drop the resume AND delete the stored cursor with it.
   * `view` is compared by reference on purpose - `setView` is the only thing
   * that replaces it, so identity is exactly "a different list".
   */
  const list = useRef<{ id: string; view: LibraryView; mode: string } | null>(null);
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
    // A new order, filter or mode renumbers the whole grid, so the cell an index
    // names is a different title. Dropped here rather than left for the next
    // focus event to overwrite: pressing Back before the cursor lands anywhere
    // would otherwise file a position from the old list under the new one's
    // view. `libraryId` is safe to name here only because `MediaClient` mounts
    // this screen with `key={screen.libraryId}` - without that remount, opening
    // another library would delete the cursor of the one just arrived at.
    const before = list.current;
    list.current = { id: libraryId, view, mode };
    if (before && (before.id !== libraryId || before.view !== view || before.mode !== mode)) {
      resume.current = undefined;
      setStartCell(0);
      forgetLibraryCursor(libraryId);
    }
    void loadPage(0);
    // Page 0 is what answers with the total, but the resumed cell is usually on
    // another page - and asking for that one only once the grid has moved costs
    // a whole extra round trip. For that round trip the screen is a grid of
    // blank placeholders whose `onEnter` does nothing, so the Back-then-OK that
    // people actually do after leaving a film lands on the right tile and is
    // swallowed. Both in flight together instead.
    //
    // The WINDOW rather than the cursor's own cell: the grid arrives with four
    // to six rows mounted, and a page boundary falls inside that band for about
    // two cursor positions in five - worst case 27 of the 42 tiles on screen,
    // and one press of Down lands on one of them. `arrivalCells` says which
    // band; a narrower one left a whole row of posters blank at the TOP of the
    // screen with the A-Z strip marking nothing, for 47 ms, and then fetched it
    // 99 ms late.
    //
    // A page past the end costs one request and answers with no items, which is
    // cheaper than carrying a total nobody knows yet in order to avoid it.
    const back = resume.current;
    if (back && back.index >= 0) {
      const [first, last] = arrivalCells(back.index);
      for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p += 1) void loadPage(p);
    }
  }, [loadPage, libraryId, view, mode, mover]);

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
      const to = nearest({
        at: mover.at,
        viewport,
        start: row * rowHeight,
        size: rowHeight,
        padStart: padPx(PAD_TOP_VH, windowH),
        padEnd: padPx(PAD_BOTTOM_VH, windowH),
        max: rows * rowHeight,
      });
      mover.to(to, true);
      setScrollTop((prev) => (sameWindow(prev, to, rowHeight, viewport) ? prev : to));
      // Moving by hand hands the mark back to whatever is on screen.
      setPressedLetter(null);
    },
    [mover, viewport, windowH, rowHeight, rows],
  );

  /**
   * Put the grid back where this library was left.
   *
   * A layout effect, so it lands before the frame is drawn: as a passive one
   * the top of the library is painted first and the grid then jumps, which on a
   * television reads as the screen having opened in the wrong place.
   *
   * Not before `total` arrives: the screen is showing "Loading" until then and
   * there is no grid to move.
   *
   * The viewport is read off the element rather than taken from the state
   * beside it, because the commit that first renders the grid measures it in a
   * ref callback and this effect runs in that same commit, where the state
   * still holds the height from before there was a grid - measured on the
   * gaming box, whose window is 768 px tall, that is 406 px out.
   *
   * It buys the FIRST FRAME, not the resting place: once the cell takes the
   * cursor, `holdCursor` runs `showRow` with the height by then in the state
   * and corrects any clamp. So the cost of dropping this read is a visible
   * settle on entry, which is the thing a layout effect is here to avoid,
   * rather than a grid left in the wrong place.
   *
   * `nearest` rather than the offset verbatim so a window that changed size in
   * between - a display-mode switch, which this box does per film - still puts
   * the row on screen instead of somewhere past the end of a shorter grid.
   */
  useLayoutEffect(() => {
    const at = resume.current;
    if (!at || total === null) return;
    // Spent here, and the failure screen does not hold it back - `total` is set
    // the moment page 0 answers, whether or not there is a grid on screen. So by
    // the time Try again is pressed there is no cursor left to re-derive a
    // window from, which is why `retry` works off the rows instead.
    const box = scroller.current;
    const seen = box ? gridViewport(box) : 0;
    // The state is the fallback rather than the source: a grid that measures as
    // nothing is a grid that is not laid out, and any answer at all beats
    // leaving `startCell` null, which is a screen with no cursor on it.
    const vp = seen > 0 ? seen : viewport;
    resume.current = undefined;
    // The library can be shorter than it was - something removed, a section
    // refreshed - and a cell past its end never mounts, which is the dead
    // remote `useFocusFallback` exists for. The top is the honest answer.
    const index = at.index >= 0 && at.index < total ? at.index : 0;
    const row = Math.floor(index / COLUMNS);
    const to = nearest({
      at: at.offset,
      viewport: vp,
      start: row * rowHeight,
      size: rowHeight,
      padStart: padPx(PAD_TOP_VH, windowH),
      padEnd: padPx(PAD_BOTTOM_VH, windowH),
      max: rows * rowHeight,
    });
    mover.to(to, false);
    setScrollTop(to);
    setStartCell(index);
  }, [total, rows, rowHeight, windowH, viewport, mover]);

  /** Where the grid may sit at the very end: past this the rows run out. */
  const maxOffset = useCallback(
    (row: number) => Math.max(0, Math.min(row * rowHeight, rows * rowHeight - viewport)),
    [rowHeight, rows, viewport],
  );

  /**
   * A cell has the cursor: bring its row into view, and file where that leaves
   * the screen so it can be returned to.
   *
   * Written on every move rather than when something is opened, because the two
   * differ and the move is the one that is true: someone who steps off a film
   * with the arrows and leaves from there has not asked to come back to the
   * film they played. The offset is read after the move, since `mover.at` is
   * the destination from the moment it is asked for.
   */
  const holdCursor = useCallback(
    (index: number, row: number) => {
      showRow(row);
      rememberLibraryCursor(libraryId, { index, offset: mover.at });
    },
    [showRow, libraryId, mover],
  );

  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);

  /**
   * Ask for the pages a band of rows needs.
   *
   * Both ends of every row: a row that straddles a page boundary would
   * otherwise only ever ask for the first of the two, and on the last row there
   * is no following row to ask for the second.
   */
  const loadRows = useCallback(
    (from: number, to: number) => {
      for (let r = from; r < to; r += 1) {
        const first = Math.floor((r * COLUMNS) / PAGE);
        const last = Math.floor(((r + 1) * COLUMNS - 1) / PAGE);
        for (let p = first; p <= last; p += 1) void loadPage(p);
      }
    },
    [loadPage],
  );

  // Fetch whatever the visible window needs. Pages already in flight are skipped,
  // so a fast scroll does not queue the same request repeatedly.
  useEffect(() => {
    loadRows(firstRow, lastRow);
  }, [firstRow, lastRow, items, loadRows]);

  /**
   * What Try again does: both halves, because each one alone is a dead screen.
   *
   * **Page 0**, because it is the page that carries the total - and with no
   * total there are no rows, so the window below is empty and the button asks
   * for nothing at all. That is the ordinary way a whole library fails (the
   * server is down, the box has just woken), and measured on a box it left the
   * screen on a spinner that never resolves, with nothing focusable on it.
   *
   * **The window**, because the page that failed is not necessarily the first
   * one: once page 0 has answered it sits in `answered` and asking for it
   * returns at its own first line, so the button cleared the failure and
   * requested nothing - 42 blank tiles, recovering only on the second press,
   * the one that happened to move the grid. Only the resume asks for a second
   * page on the way in, which is what makes that the ordinary case now.
   *
   * Neither set is cleared. A page that FAILED is in neither of them already -
   * `pending` deletes in its `finally` and `answered` is only written on
   * success - so this asks for exactly the failed ones and skips the rest.
   * Clearing `answered` would re-request pages whose posters are on screen, and
   * a second refusal there replaces a good screen with the error again.
   */
  const retry = useCallback(() => {
    void loadPage(0);
    loadRows(firstRow, lastRow);
  }, [loadPage, loadRows, firstRow, lastRow]);

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
      // `overflow-hidden` clips but stays scrollable programmatically, and the
      // browser scrolls the nearest such ancestor whenever focus lands outside it
      // - as does `scrollIntoView`, which FocusButton calls. The grid then carries
      // a second offset that nothing here can see, on top of the transform, and a
      // row looks cropped for a reason the transform cannot explain.
      pin(node);
      if (node) measure();
    },
    [measure, gridRef, pin],
  );

  const poster = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());

  // Nothing focuses itself, so the first tile has to be told to take it - and a
  // press arriving after the grid was cleared for a letter change has to land
  // somewhere rather than be discarded.
  // The button, when the grid is empty. A filter that matches nothing left the
  // screen with its own "no results" text and the button that could undo it
  // visible but unreachable - every press re-aimed at a cell that was not there.
  // `startCell` is the first cell, except on a library being returned to, where
  // it is the one the cursor was left on - and null until that is settled, so
  // the cursor cannot land on the first tile and pull the grid back to the top.
  //
  // Never while the failure screen is up. It replaces this whole screen, and it
  // focuses its own button - but `startCell` goes null to a value LATER, on the
  // resume, so this would fire afterwards and aim the cursor at a grid cell that
  // is not mounted. Measured: the error text on screen, its Try again button
  // unhighlighted, and neither OK nor an arrow doing anything, because the
  // fallback's own target is not mounted there either. Only a page other than
  // the first can fail this way, which is what the resumed page made ordinary.
  const startKey = total === 0 ? "lib-arrange" : `cell-${startCell ?? 0}`;
  useInitialFocus(startKey, total !== null && startCell !== null && !failure && !sawFailure.current);
  // Every key this screen owns has to be listed. A focusable the guard does not
  // recognise is treated as gone and focus is yanked back to the grid - so the
  // sort-and-filter button could be reached and then lost between the press
  // landing on it and OK arriving, which opened the first film instead.
  useFocusFallback(
    // Always in the same place, unlike cell-0: that is only near the top of the
    // grid, so recovering focus while scrolled down aimed at nothing and the
    // remote went dead. It is not mounted on the failure or loading screens,
    // which render only the panel and the message - but those focus their own
    // button, and a key parked while it is away lights when it comes back.
    "lib-arrange",
    ownsKey,
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
        <Message failure={failure} onRetry={retry} />
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
              onFocusedEl={() => holdCursor(i, r)}
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
              onFocusedEl={() => holdCursor(i, r)}
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
   * The row read is the first one a person can READ, and getting there is two
   * corrections rather than one. It used to read the first MOUNTED row, which
   * is a row of overscan above the screen; and the row the top edge merely
   * falls INSIDE is not on screen either, because `nearest` parks the grid a
   * pad above the row it is bringing in - so after every upward move, and after
   * the resume, which lands through that same branch, the row above shows 43 px
   * of a caption and nothing else. Measured on a box: the strip marking R with
   * 17 px of an R row visible and every readable row an S. Adding the pad back
   * before the divide names the row whose posters are there, at the top, at a
   * letter jump, at the pad rest and at the end clamp alike.
   *
   * That only ever showed while somebody scrolled by hand, where the letter
   * they pressed masks it; a library now opens where it was left, so the mark
   * is on screen from the first frame with nothing to mask it.
   *
   * The letter pressed still wins until the cursor moves, because in a library
   * that fits on screen the grid cannot move at all - there the mark is the
   * whole of the feedback, and without this pressing Z changed nothing
   * anywhere.
   */
  const activeLetter = ((): string | null => {
    if (pressedLetter) return pressedLetter;
    const first = items[Math.floor((scrollTop + padPx(PAD_TOP_VH, windowH)) / rowHeight) * COLUMNS];
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
            // Pinned: `overflow-hidden` clips but stays scrollable
            // programmatically, and the browser scrolls the nearest such ancestor
            // whenever focus lands outside it - as does `scrollIntoView`, which
            // FocusButton calls. The page then carries a second offset nothing
            // here can see, and the row looks cropped for no reason the transform
            // explains.
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
            <LetterStrip letters={letters} onPick={jumpToLetter} active={activeLetter} upTargetKey="lib-arrange" />
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

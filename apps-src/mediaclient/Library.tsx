import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { Tile } from "./Tile";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { useFocusFallback, useInitialFocus } from "./focus";
import { usePlayer } from "./playback/player";
import { classify, useApp } from "./state";
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
const COLUMNS = 7;
/** Rows kept mounted above and below the viewport. */
const OVERSCAN = 2;

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
  const [items, setItems] = useState<(MediaItem | null)[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
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
  const rowHeight = useMemo(() => Math.round(viewport * ((TILE_VH + ROW_GAP_VH) / 100)), [viewport]);

  useEffect(() => {
    const measure = (): void => setViewport(window.innerHeight);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    backend
      .letters(libraryId, view.filters)
      .then((l) => live && setLetters(l))
      .catch(() => {
        /* the strip is an accelerator; the grid works without it */
      });
    return () => {
      live = false;
    };
  }, [backend, libraryId, view.filters]);

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
        const res = await backend.libraryPage(libraryId, q);
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
    [backend, fail, libraryId, view],
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
    scroller.current?.scrollTo({ top: 0 });
    void loadPage(0);
  }, [loadPage]);

  const rows = Math.ceil((total ?? items.length) / COLUMNS) || 0;
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

  const { ref: gridRef, focusKey } = useFocusable({ focusKey: `grid-${libraryId}`, saveLastFocusedChild: true });

  const poster = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());

  // Nothing focuses itself, so the first tile has to be told to take it - and a
  // press arriving after the grid was cleared for a letter change has to land
  // somewhere rather than be discarded.
  useInitialFocus("cell-0", total !== null && total > 0);
  // Every key this screen owns has to be listed. A focusable the guard does not
  // recognise is treated as gone and focus is yanked back to the grid - so the
  // sort-and-filter button could be reached and then lost between the press
  // landing on it and OK arriving, which opened the first film instead.
  useFocusFallback(
    "cell-0",
    (key) => key.startsWith("cell-") || key.startsWith("letter-") || key.startsWith("lib-"),
    !playing,
  );

  if (failure) return <Message failure={failure} onRetry={() => void loadPage(0)} />;
  // `total === null` is "not asked yet"; a total of zero is an answer, and an
  // empty library must say so rather than spin forever.
  if (total === null && items.length === 0) return <Message loading />;

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
              onEnter={() => {}}
            />
          )}
        </div>,
      );
    }
  }

  if (arranging)
    return (
      <LibraryFilters
        libraryId={libraryId}
        view={view}
        // A new order or filter is a new list, so the grid resets to the top on
        // its own; the strip needs nothing, because it holds no state now.
        onApply={setView}
        onClose={() => setArranging(false)}
      />
    );

  const narrowed = Object.keys(view.filters).length;

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
    void backend
      .letterOffset(libraryId, key, { sort: view.sort, desc: view.desc, filters: view.filters })
      .then((offset) => {
        const row = Math.floor(offset / COLUMNS);
        // Fetch before scrolling: the window is computed from scrollTop, so the
        // rows land already requested rather than as a screen of placeholders.
        void loadPage(Math.floor(offset / PAGE));
        // Instant, not smooth. A jump to "S" in a library of 1,700 crosses most
        // of the list, and animating that distance is a second of scenery on the
        // way to somewhere the person already chose.
        scroller.current?.scrollTo({ top: row * rowHeight });
      })
      .catch((e) => log.warn("letter jump failed", e));
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-[1.4vw] px-[4vw] py-[2vh]">
          <h1 className="text-[2.6vh] font-semibold tracking-tight">
            {title}
            {total !== null && <span className="ml-[1vw] text-[1.8vh] text-fg-dim tabular-nums">{total}</span>}
          </h1>
          {/* The count beside it, because a filtered library looks like a small
              library otherwise - and someone who left a filter on last week has
              no other way to tell. */}
          <FocusButton
            focusKey="lib-arrange"
            onEnter={() => setArranging(true)}
            className="rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
          >
            {narrowed ? `${t("library.arrange")} · ${narrowed}` : t("library.arrange")}
          </FocusButton>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div
            ref={(node) => {
              scroller.current = node;
              (gridRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            // scroll-padding for the same reason the other screens have it: the
            // bottom row would otherwise land flush against the edge, which is
            // inside TV overscan on some sets.
            // Vertical padding, because the focus ring is drawn OUTSIDE the
            // tile's box and this element clips: without it the top row's ring
            // loses its upper edge against the scroller's own boundary.
            className="no-scrollbar relative flex-1 overflow-y-auto px-[3vw] pt-[1.2vh] pb-[2vh] scroll-pt-[4vh] scroll-pb-[6vh]"
          >
            {total === 0 && (
              <div className="flex h-full items-center justify-center text-[2.2vh] text-fg-dim">
                {Object.keys(view.filters).length ? t("library.emptyFiltered") : t("library.empty")}
              </div>
            )}
            {/* One tall spacer carries the scrollbar; only the visible rows are
                mounted, because a library of several thousand posters is exactly
                the kind of DOM this hardware cannot afford. */}
            <div style={{ height: rows * rowHeight }} className="relative">
              {visible}
            </div>
          </div>

          {letters.length > 1 && <LetterStrip letters={letters} onPick={jumpToLetter} />}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function LetterStrip({ letters, onPick }: { letters: Letter[]; onPick: (key: string) => void }): React.JSX.Element {
  const { ref, focusKey } = useFocusable({ focusKey: "letters", saveLastFocusedChild: true });
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        // Every letter at once, and no scrolling. A strip you have to scroll
        // through is slower than scrolling the grid it is meant to shortcut -
        // so the letters shrink to fit the height instead, which they can
        // because each is one character.
        className="flex h-full flex-col items-stretch justify-center gap-[0.2vh] py-[1vh] pr-[1vw] pl-[0.4vw]"
        ref={ref}
      >
        {letters.map((l) => (
          <FocusButton
            key={l.key}
            focusKey={`letter-${l.key}`}
            onEnter={() => onPick(l.key)}
            // A bare character, not a button-shaped box: thirty of those made a
            // second column down the side of the screen. Focus still fills, as
            // it does everywhere else.
            className="rounded-[0.5vh] px-[0.6vw] text-center text-[1.9vh] leading-[1.35]"
          >
            {l.title}
          </FocusButton>
        ))}
      </div>
    </FocusContext.Provider>
  );
}

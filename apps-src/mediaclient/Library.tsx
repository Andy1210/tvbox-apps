import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { Tile } from "./Tile";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { useFocusFallback, useInitialFocus } from "./focus";
import { classify, useApp } from "./state";
import type { MediaItem } from "./backends/types";
import { log } from "./redact";

const PAGE = 100;
// Chosen so a tile fills its column: at 26vh tall a 2:3 poster is 17.3vw-ish of
// height, and six of them left a third of each cell empty, which reads as a
// mistake rather than as spacing.
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

  const [letters, setLetters] = useState<Letter[]>([]);
  const [letter, setLetter] = useState<string | null>(null);
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
  const rowHeight = useMemo(() => Math.round(viewport * 0.3), [viewport]);

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
      .letters(libraryId)
      .then((l) => live && setLetters(l))
      .catch(() => {
        /* the strip is an accelerator; the grid works without it */
      });
    return () => {
      live = false;
    };
  }, [backend, libraryId]);

  // Loading a page. `letter` selects between the whole library and one bucket;
  // both are asked of the server rather than derived from the other, because the
  // bucket list and the sorted grid do not agree on where accented initials go.
  const loadPage = useCallback(
    async (page: number) => {
      if (!backend || pending.current.has(page) || answered.current.has(page)) return;
      pending.current.add(page);
      const mine = generation.current;
      try {
        const q = { offset: page * PAGE, limit: PAGE, sort: "titleSort" as const };
        const res = letter ? await backend.letterPage(libraryId, letter, q) : await backend.libraryPage(libraryId, q);
        if (mine !== generation.current) return;
        answered.current.add(page);

        setTotal((prev) => res.total ?? prev ?? res.items.length);
        setItems((prev) => {
          const size = res.total ?? Math.max(prev.length, page * PAGE + res.items.length);
          const next = prev.length === size ? [...prev] : [...prev, ...Array<null>(Math.max(0, size - prev.length)).fill(null)];
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
    [backend, fail, letter, libraryId],
  );

  // Changing letter is a new list: drop what was there rather than let old items
  // show through while the first page arrives.
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
  const poster = (item: MediaItem): string | undefined => backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());

  // Nothing focuses itself, so the first tile has to be told to take it - and a
  // press arriving after the grid was cleared for a letter change has to land
  // somewhere rather than be discarded.
  useInitialFocus("cell-0", total !== null && total > 0);
  useFocusFallback("cell-0", (key) => key.startsWith("cell-") || key.startsWith("letter-"));

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
              heightVh={26}
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
              heightVh={26}
              onEnter={() => {}}
            />
          )}
        </div>,
      );
    }
  }

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="flex h-full flex-col">
        <h1 className="px-[4vw] py-[2vh] text-[2.6vh] font-semibold tracking-tight">
          {title}
          {total !== null && <span className="ml-[1vw] text-[1.8vh] text-fg-dim tabular-nums">{total}</span>}
        </h1>

        <div className="flex flex-1 overflow-hidden">
          <div
            ref={(node) => {
              scroller.current = node;
              (gridRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            className="no-scrollbar relative flex-1 overflow-y-auto px-[3vw]"
          >
            {total === 0 && (
              <div className="flex h-full items-center justify-center text-[2.2vh] text-fg-dim">
                {letter ? t("library.emptyLetter") : t("library.empty")}
              </div>
            )}
            {/* One tall spacer carries the scrollbar; only the visible rows are
                mounted, because a library of several thousand posters is exactly
                the kind of DOM this hardware cannot afford. */}
            <div style={{ height: rows * rowHeight }} className="relative">
              {visible}
            </div>
          </div>

          {letters.length > 1 && (
            <LetterStrip letters={letters} active={letter} onPick={setLetter} allLabel={t("library.all")} />
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function LetterStrip({
  letters,
  active,
  onPick,
  allLabel,
}: {
  letters: Letter[];
  active: string | null;
  onPick: (key: string | null) => void;
  allLabel: string;
}): React.JSX.Element {
  const { ref, focusKey } = useFocusable({ focusKey: "letters", saveLastFocusedChild: true });
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="no-scrollbar flex w-[5vw] flex-col items-center gap-[0.4vh] overflow-y-auto py-[1vh]">
        <FocusButton
          focusKey="letter-all"
          onEnter={() => onPick(null)}
          className={`w-[3.4vw] rounded-[0.6vh] py-[0.4vh] text-center text-[1.7vh] ${active === null ? "bg-white/20" : ""}`}
        >
          {allLabel}
        </FocusButton>
        {letters.map((l) => (
          <FocusButton
            key={l.key}
            focusKey={`letter-${l.key}`}
            onEnter={() => onPick(l.key)}
            className={`w-[3.4vw] rounded-[0.6vh] py-[0.4vh] text-center text-[1.7vh] tabular-nums ${
              active === l.key ? "bg-white/20" : ""
            }`}
          >
            {l.title}
          </FocusButton>
        ))}
      </div>
    </FocusContext.Provider>
  );
}

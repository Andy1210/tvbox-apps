// Every song, album or artist in a library, as one list.
//
// A list rather than the grid the films use, for all three lenses. Album art in
// this collection repeats - remix EPs of the same single share a cover - so a
// wall of thumbnails is a wall of the same picture, while a row gives each item
// a line of text that actually distinguishes it.
//
// Sized for a library that is meant to reach several thousand tracks, which
// decides two things. Pages are asked for as the cursor approaches them rather
// than up front, and only a window of rows is mounted - the rest is a spacer, so
// the scrollbar and the letter strip still describe the whole list.
//
// The window follows the CURSOR, not the scroll position. On a television there
// is no free scrolling: the only way to move is the D-pad, so the focused row is
// always known and is a better anchor than a scroll offset that has to be
// measured.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FocusContext, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { LetterStrip, type Letter } from "../LetterStrip";
import { Message } from "../Message";
import { TrackRow, TRACK_ROW_VH } from "./TrackRow";
import { artworkScale } from "../posters";
import { useFocusFallback, useInitialFocus } from "../focus";
import { classify, useApp, type MusicLens } from "../state";
import { useMusic } from "../playback/music";
import type { MediaItem, PageQuery } from "../backends/types";
import { log } from "../redact";

/** One request's worth. Big enough that a letter jump lands inside one. */
const PAGE = 100;
/** Rows mounted at once. Three screens' worth, so a fast hold has run-up. */
const WINDOW = 36;
/** Rows kept above the cursor inside that window. */
const LEAD = 12;
/**
 * How many rows a single Play-all queue may hold.
 *
 * A queue lives in memory and is handed to the box one file at a time, so this
 * is a bound on what "play everything" means rather than on the library.
 */
const QUEUE_CAP = 2000;

export function MusicList({
  libraryId,
  lens,
  title,
}: {
  libraryId: string;
  lens: MusicLens;
  title: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const playQueue = useMusic((s) => s.playQueue);
  const playingId = useMusic((s) => s.queue[s.index]?.id);

  const [total, setTotal] = useState<number | null>(null);
  const [pages, setPages] = useState<Map<number, MediaItem[]>>(new Map());
  const [letters, setLetters] = useState<Letter[]>([]);
  const [cursor, setCursor] = useState(0);
  const [reload, setReload] = useState(0);
  const inflight = useRef<Set<number>>(new Set());
  const rowEls = useRef(new Map<number, HTMLElement>());
  /**
   * Where Up from the top of the list goes.
   *
   * Only the songs list has header buttons. Pointing at one that never mounts is
   * not a missed jump - spatial navigation waits for the key, so the press does
   * nothing at all and the remote reads as dead.
   */
  const topKey = lens === "tracks" ? "ml-playall" : null;

  /** The backend's own name for this depth. Artists are the library's items. */
  const of: PageQuery["of"] = lens === "artists" ? undefined : lens;

  // A new lens is a different list: everything measured about the old one -
  // its length, its letters, where the cursor was - describes something else.
  useEffect(() => {
    setTotal(null);
    setPages(new Map());
    setLetters([]);
    setCursor(0);
    inflight.current = new Set();
  }, [lens, libraryId]);

  const loadPage = useCallback(
    async (index: number) => {
      if (!backend || inflight.current.has(index)) return;
      inflight.current.add(index);
      try {
        const p = await backend.libraryPage(libraryId, { offset: index * PAGE, limit: PAGE, of });
        setPages((m) => new Map(m).set(index, p.items));
        if (p.total !== undefined) setTotal(p.total);
        else if (p.items.length < PAGE) setTotal(index * PAGE + p.items.length);
      } catch (e) {
        // Dropped from the in-flight set so approaching it again retries. A page
        // that failed once on a flaky network must not become a permanent hole.
        inflight.current.delete(index);
        log.warn("music page failed", e);
        if (index === 0) fail(classify(e));
        return;
      }
    },
    [backend, libraryId, of, fail],
  );

  useEffect(() => {
    void loadPage(0);
  }, [loadPage, reload]);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    backend
      .letters(libraryId, undefined, of)
      .then((l) => live && setLetters(l))
      .catch(() => {
        /* a strip that does not appear is the right failure: the list still works */
      });
    return () => {
      live = false;
    };
  }, [backend, libraryId, of, reload]);

  // The window, and the pages under it. Both derived from the cursor so there is
  // one source of truth for where the list is.
  const start = total === null ? 0 : Math.max(0, Math.min(cursor - LEAD, Math.max(0, total - WINDOW)));
  const end = total === null ? WINDOW : Math.min(total, start + WINDOW);

  useEffect(() => {
    const first = Math.floor(start / PAGE);
    const last = Math.floor(Math.max(start, end - 1) / PAGE);
    for (let p = first; p <= last; p++) if (!pages.has(p)) void loadPage(p);
  }, [start, end, pages, loadPage]);

  const at = (index: number): MediaItem | undefined => pages.get(Math.floor(index / PAGE))?.[index % PAGE];

  // The cursor row is brought into view here rather than by the browser: these
  // rows are plain buttons, and the window they sit in is a slice of a much
  // taller list, so the element only exists once the window has moved to it.
  // "nearest" is what keeps a step down from moving the list by a whole screen.
  useEffect(() => {
    rowEls.current.get(cursor)?.scrollIntoView({ block: "nearest" });
  }, [cursor, start]);

  const rows = useMemo(() => {
    const out: number[] = [];
    for (let i = start; i < end; i++) out.push(i);
    return out;
  }, [start, end]);

  useInitialFocus("mrow-0", total !== null);
  useFocusFallback(
    `mrow-${cursor}`,
    (key) => key.startsWith("mrow-") || key.startsWith("letter-") || key.startsWith("ml-") || key.startsWith("msg-"),
    true,
  );

  /** Where the strip should light up: the letter the cursor's row starts with. */
  const activeLetter = useMemo(() => {
    const item = at(cursor);
    // Folded the way the server buckets, not merely upper-cased. Two things the
    // naive version got wrong, both seen on the box: a title starting with a
    // digit belongs to "#", so a list that opens on "01" lit no letter at all;
    // and an accented initial is folded into its plain letter, so "Ő" has to
    // find "O" rather than a key nothing offers.
    const raw = (item?.sortTitle ?? item?.title ?? "").trim().charAt(0);
    const plain = raw.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
    const key = /^[A-Z]$/.test(plain) ? plain : "#";
    return letters.find((l) => l.key === key)?.key ?? null;
    // `pages` is what makes the row available; without it the strip stays on the
    // letter the list opened at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, letters, pages]);

  const jumpToLetter = useCallback(
    async (key: string) => {
      if (!backend) return;
      try {
        const offset = await backend.letterOffset(libraryId, key, { of });
        setCursor(offset);
        // The page under the landing point first, so the row exists to focus.
        await loadPage(Math.floor(offset / PAGE));
        setFocus(`mrow-${offset}`);
      } catch (e) {
        log.warn("letter jump failed", e);
      }
    },
    [backend, libraryId, of, loadPage],
  );

  const openOrPlay = async (index: number): Promise<void> => {
    const item = at(index);
    if (!item || !backend) return;
    if (lens !== "tracks") {
      go({ name: "musicItem", itemId: item.id, kind: item.kind, title: item.title, libraryId });
      return;
    }
    // A song pressed in the full list plays the list from there. Bounded: the
    // queue is held in memory, and "everything after this" in a library of
    // thousands is not what the press meant anyway.
    const from = Math.floor(index / PAGE) * PAGE;
    const page = await backend
      .libraryPage(libraryId, { offset: from, limit: Math.min(QUEUE_CAP, PAGE * 4), of })
      .catch(() => null);
    const items = page?.items.length ? page.items : [item];
    await playQueue(backend, items, {
      startIndex: Math.max(
        0,
        items.findIndex((i) => i.id === item.id),
      ),
    });
    go({ name: "nowPlaying" });
  };

  const square = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 160 * artworkScale(), 160 * artworkScale());

  if (failure) return <Message failure={failure} onRetry={() => setReload((n) => n + 1)} />;
  if (total === null) return <Message loading />;
  if (total === 0) return <Message text={t("music.empty")} />;

  return (
    <div className="relative z-10 flex h-full flex-col">
      <div className="h-[3.3vh] shrink-0" aria-hidden="true" />
      <Header
        title={title}
        lens={lens}
        total={total}
        onNowPlaying={playingId ? () => go({ name: "nowPlaying" }) : undefined}
        onPlayAll={async (shuffle) => {
          if (!backend || lens !== "tracks") return;
          const p = await backend.libraryPage(libraryId, { offset: 0, limit: QUEUE_CAP, of }).catch(() => null);
          if (!p?.items.length) return;
          await playQueue(backend, p.items, { shuffle });
          go({ name: "nowPlaying" });
        }}
      />

      <div className="flex min-h-0 flex-1">
        <div className="no-scrollbar min-w-0 flex-1 overflow-y-auto px-[3vw]">
          {/* The spacer above and below is what makes a window of 36 rows behave
              like a list of thousands: the scroll height, and therefore the
              position within the library, stays honest. */}
          <div style={{ height: `${start * TRACK_ROW_VH}vh` }} aria-hidden="true" />
          <ul className="flex flex-col">
            {rows.map((i) => {
              const item = at(i);
              return (
                <li
                  key={i}
                  ref={(el) => {
                    if (el) rowEls.current.set(i, el);
                    else rowEls.current.delete(i);
                  }}
                  style={{ height: `${TRACK_ROW_VH}vh` }}
                >
                  {item ? (
                    <TrackRow
                      item={item}
                      focusKey={`mrow-${i}`}
                      ordinal={i + 1}
                      artUrl={square(item)}
                      playing={lens === "tracks" && item.id === playingId}
                      onEnter={() => void openOrPlay(i)}
                      onArrowPress={(dir) => {
                        if (dir === "up" && i === 0 && topKey) {
                          setFocus(topKey);
                          return false;
                        }
                        // Clamped to rows that exist. The cursor drives the
                        // mounted window, the scroll, the strip's highlight AND
                        // the focus fallback, so letting it run past either end -
                        // which it did on the last row, and on the first row of
                        // the album and artist lenses where there is no header to
                        // catch Up - pointed the fallback at `mrow-<out of range>`,
                        // a key that can never mount. That is the dead remote.
                        if (dir === "down" || dir === "up") {
                          const to = dir === "down" ? i + 1 : i - 1;
                          setCursor(Math.max(0, Math.min(to, total - 1)));
                        }
                        return true;
                      }}
                    />
                  ) : (
                    // A row that has not arrived is still a row: without a box of
                    // the same height the ones below it move as pages land, and a
                    // list that shifts under the cursor is a list you cannot aim
                    // at.
                    <div className="h-full animate-pulse rounded-[1vh] bg-white/5" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ul>
          <div style={{ height: `${Math.max(0, total - end) * TRACK_ROW_VH}vh` }} aria-hidden="true" />
        </div>

        {letters.length > 1 && (
          <LetterStrip
            letters={letters}
            onPick={(k) => void jumpToLetter(k)}
            active={activeLetter}
            // The first row when there is no header to reach: a key that never
            // mounts would swallow the press entirely.
            upTargetKey={topKey ?? "mrow-0"}
          />
        )}
      </div>
    </div>
  );
}

function Header({
  title,
  lens,
  total,
  onPlayAll,
  onNowPlaying,
}: {
  title: string;
  lens: MusicLens;
  total: number;
  onPlayAll: (shuffle: boolean) => Promise<void>;
  /** Absent when nothing is playing, and then no chip is drawn. */
  onNowPlaying?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "ml-header", saveLastFocusedChild: true });
  const chip = "shrink-0 rounded-[1vh] bg-white/10 px-[2vw] py-[1.1vh] text-[2.2vh]";
  const heading = lens === "tracks" ? t("music.songs") : lens === "albums" ? t("music.albums") : t("music.artists");

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="flex shrink-0 items-center gap-[1vw] px-[4vw] py-[1vh]">
        <span className="mr-[1vw] shrink-0 text-[2.6vh] font-bold">
          {title} · {heading}
        </span>
        <span className="mr-auto shrink-0 text-[2vh] text-fg-dim tabular-nums">{total}</span>
        {lens === "tracks" && (
          <>
            <FocusButton focusKey="ml-playall" onEnter={() => void onPlayAll(false)} className={chip}>
              {t("music.playAll")}
            </FocusButton>
            <FocusButton focusKey="ml-shuffle" onEnter={() => void onPlayAll(true)} className={chip}>
              {t("music.shuffle")}
            </FocusButton>
          </>
        )}
        {onNowPlaying && (
          <FocusButton focusKey="ml-nowplaying" onEnter={onNowPlaying} className={chip}>
            {t("music.nowPlaying")}
          </FocusButton>
        )}
      </div>
    </FocusContext.Provider>
  );
}

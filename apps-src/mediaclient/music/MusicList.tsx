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
  // Only while it is actually playing. The queue survives a stop now, so reading
  // it alone left the header offering "Most szól" and a row still drawn bold
  // after Stop - three surfaces telling two stories, with the mini bar correctly
  // gone.
  const playingId = useMusic((s) => (s.state === "stopped" ? undefined : s.queue[s.index]?.id));
  // A queue that exists, playing or not. Adding songs to a stopped queue is what
  // the add mode does, and the only way to that queue is the player screen - so
  // the chip has to appear for it, which the marker above must not.
  const hasQueue = useMusic((s) => s.queue[s.index] !== undefined);
  const adding = useMusic((s) => s.adding);
  const setAdding = useMusic((s) => s.setAdding);
  const enqueue = useMusic((s) => s.enqueue);
  const [note, setNote] = useState<string | null>(null);

  const [total, setTotal] = useState<number | null>(null);
  const [pages, setPages] = useState<Map<number, MediaItem[]>>(new Map());
  const [letters, setLetters] = useState<Letter[]>([]);
  const [cursor, setCursor] = useState(0);
  const [reload, setReload] = useState(0);
  const inflight = useRef<Set<number>>(new Set());
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

  // No scrolling from here. Every row is a FocusButton, and the SDK already
  // brings the focused one into view with `block: "nearest"` - scrolling it a
  // second time from a cursor effect is what let spatial navigation resolve
  // against a layout that had just moved.
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
    // Adding a SONG is what the mode changes. An album or an artist still opens,
    // so the way to add three tracks off one album is to walk into it - and each
    // of those screens carries a chip that adds the whole thing.
    if (adding && lens === "tracks") {
      enqueue([item], "end");
      setNote(t("music.addedOne", { title: item.title }));
      return;
    }
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
        note={note}
        adding={adding}
        onAdding={() => {
          setNote(null);
          setAdding(!adding);
        }}
        onNowPlaying={hasQueue ? () => go({ name: "nowPlaying" }) : undefined}
        onPlayAll={async (shuffle) => {
          if (!backend || lens !== "tracks") return;
          const p = await backend.libraryPage(libraryId, { offset: 0, limit: QUEUE_CAP, of }).catch(() => null);
          if (!p?.items.length) return;
          await playQueue(backend, p.items, { shuffle });
          go({ name: "nowPlaying" });
        }}
      />

      <div className="flex min-h-0 flex-1">
        {/* scroll-padding, so the row the cursor is on is never flush against an
            edge. `block: "nearest"` stops as soon as a row is technically
            visible, which on a television leaves it touching the bottom with
            nothing after it to say the list continues. */}
        <div className="no-scrollbar min-w-0 flex-1 scroll-py-[10vh] overflow-y-auto px-[3vw]">
          {/* The spacer above and below is what makes a window of 36 rows behave
              like a list of thousands: the scroll height, and therefore the
              position within the library, stays honest. */}
          <div style={{ height: `${start * TRACK_ROW_VH}vh` }} aria-hidden="true" />
          <ul className="flex flex-col">
            {rows.map((i) => {
              const item = at(i);
              return (
                <li key={i} style={{ height: `${TRACK_ROW_VH}vh` }}>
                  {item ? (
                    <TrackRow
                      item={item}
                      focusKey={`mrow-${i}`}
                      ordinal={i + 1}
                      artUrl={square(item)}
                      playing={lens === "tracks" && item.id === playingId}
                      onEnter={() => void openOrPlay(i)}
                      // The cursor FOLLOWS focus; it does not lead it.
                      //
                      // Leading it was measured on the box and was worse than the
                      // bug it replaced: the handler moved the cursor, the cursor
                      // scrolled the list, and then `return true` let spatial
                      // navigation resolve as well - on the layout that had just
                      // moved under it. One Down press advanced three rows and one
                      // Up two, so about two songs in three could not be reached
                      // at all. It looked correct before the list had to scroll,
                      // because `scrollIntoView` is a no-op there.
                      //
                      // Now the only mover is spatial navigation, and this reports
                      // where it landed. The window, the strip's highlight and the
                      // focus fallback all read the cursor, so they follow too.
                      onFocused={() => setCursor(i)}
                      onArrowPress={(dir) => {
                        if (dir === "up" && i === 0 && topKey) {
                          setFocus(topKey);
                          return false;
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
  note,
  adding,
  onAdding,
  onPlayAll,
  onNowPlaying,
}: {
  title: string;
  lens: MusicLens;
  total: number;
  /** What the last press did, when it added something. */
  note: string | null;
  adding: boolean;
  onAdding: () => void;
  onPlayAll: (shuffle: boolean) => Promise<void>;
  /** Absent when there is no queue at all, and then no chip is drawn. */
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
        <span className="shrink-0 text-[2vh] text-fg-dim tabular-nums">{total}</span>
        {/* The last thing added, next to the button that added it. It replaces
            nothing and pushes nothing: the row is one line tall either way. */}
        <span className="mr-auto min-w-0 flex-1 truncate px-[1vw] text-[1.9vh] text-fg-dim">{note}</span>
        {lens === "tracks" && (
          <>
            <FocusButton focusKey="ml-playall" onEnter={() => void onPlayAll(false)} className={chip}>
              {t("music.playAll")}
            </FocusButton>
            <FocusButton focusKey="ml-shuffle" onEnter={() => void onPlayAll(true)} className={chip}>
              {t("music.shuffle")}
            </FocusButton>
            <FocusButton
              focusKey="ml-add"
              onEnter={onAdding}
              className={adding ? chip + " !bg-[var(--color-accent)]" : chip}
            >
              {t("music.addMode")}
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

// What a music library opens on.
//
// Songs first, not albums. That is a decision about THIS collection rather than
// a general preference: most of its albums are two-to-four track singles and
// remix EPs, and a large share of them sit under "Various Artists" - so a wall
// of covers is a wall of near-identical thumbnails with the middle of the
// library hidden inside one folder. What people actually do here is "put
// something on", so that is one press, and everything else is a row.
//
// Every row is capped and asked for by page. The library is a few hundred songs
// today and is meant to reach several thousand, and a screen that loads a whole
// music library to draw six covers stops working long before that.

import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { Row } from "../Row";
import { Message } from "../Message";
import { artworkScale } from "../posters";
import { useFocusFallback, useInitialFocus, useScrollToTopOnFirst } from "../focus";
import { classify, useApp } from "../state";
import { useMusic } from "../playback/music";
import type { MediaItem } from "../backends/types";
import { log } from "../redact";

/** Enough to fill a rail twice over, and small enough to be one request. */
const ROW = 24;

interface Loaded {
  recent: MediaItem[];
  played: MediaItem[];
  artists: MediaItem[];
  albums: MediaItem[];
  playlists: MediaItem[];
  totalTracks?: number;
}

export function MusicHome({ libraryId, title }: { libraryId: string; title: string }): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const playQueue = useMusic((s) => s.playQueue);
  const nowPlaying = useMusic((s) => s.queue[s.index] !== undefined);
  const adding = useMusic((s) => s.adding);
  const setAdding = useMusic((s) => s.setAdding);
  const enqueue = useMusic((s) => s.enqueue);
  const [note, setNote] = useState<string | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [reload, setReload] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const toTop = useScrollToTopOnFirst(scroller);

  useEffect(() => {
    if (!backend) return;
    let live = true;

    (async () => {
      try {
        // In parallel: they are independent, and a music home that fills in one
        // row per round trip is a screen that visibly assembles itself.
        const settled = await Promise.allSettled([
          backend.recentlyAdded(libraryId, "music"),
          backend.libraryPage(libraryId, { offset: 0, limit: ROW, of: "tracks", sort: "lastViewedAt", desc: true }),
          backend.libraryPage(libraryId, { offset: 0, limit: ROW }),
          backend.libraryPage(libraryId, { offset: 0, limit: ROW, of: "albums", sort: "addedAt", desc: true }),
          backend.playlists("audio"),
        ]);
        if (!live) return;

        // A row that failed contributes nothing, which is right - one slow or
        // missing hub should not hold up the screen. But if they ALL failed the
        // server is down, and drawing "this library is empty" then tells the
        // household something about their library that is not true. Every call
        // used to swallow its own failure, which made the catch below dead code.
        const failure = settled.find((r) => r.status === "rejected");
        if (failure && settled.every((r) => r.status === "rejected")) {
          throw (failure as PromiseRejectedResult).reason;
        }
        const value = <T,>(i: number, fallback: T): T =>
          settled[i].status === "fulfilled" ? ((settled[i] as PromiseFulfilledResult<T>).value ?? fallback) : fallback;

        const recent = value<MediaItem[]>(0, []);
        const played = value<{ items: MediaItem[] }>(1, { items: [] });
        const artists = value<{ items: MediaItem[] }>(2, { items: [] });
        const albums = value<{ items: MediaItem[] }>(3, { items: [] });
        const playlists = value<MediaItem[]>(4, []);
        // Asked for one item purely for the count the container carries, which is
        // what the "all songs" button says. A page of one is the cheapest way to
        // ask a question the list endpoint answers in its envelope.
        const count = await backend
          .libraryPage(libraryId, { offset: 0, limit: 1, of: "tracks" })
          .then((p) => p.total)
          .catch(() => undefined);
        if (!live) return;
        setData({
          recent,
          // Only songs actually played. Everything here is unplayed on a fresh
          // library, and a row that is empty on most boxes teaches people to
          // scroll past that part of the screen.
          played: played.items.filter((i) => i.lastViewedAt),
          artists: artists.items,
          albums: albums.items,
          playlists,
          totalTracks: count,
        });
      } catch (e) {
        if (!live) return;
        log.warn("music home failed to load", e);
        fail(classify(e));
      }
    })();

    return () => {
      live = false;
    };
  }, [backend, libraryId, fail, reload]);

  useInitialFocus("mh-shuffle", Boolean(data));
  useFocusFallback("mh-shuffle", (key) => key.startsWith("mh-") || key.startsWith("msg-"), true);

  const square = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 300 * artworkScale(), 300 * artworkScale());

  /** Play a rail's worth of songs, starting where the cursor is. */
  const playFrom = (items: MediaItem[], item: MediaItem): void => {
    if (!backend) return;
    // This screen has one rail of songs, and while the add mode is on it obeys
    // the same rule as every other song: OK adds it.
    if (adding) {
      enqueue(backend, [item], "end");
      setNote(t("music.addedOne", { title: item.title }));
      return;
    }
    void playQueue(backend, items, { startIndex: Math.max(0, items.indexOf(item)), shuffle: false });
    go({ name: "nowPlaying" });
  };

  const open = (item: MediaItem): void =>
    go({ name: "musicItem", itemId: item.id, kind: item.kind, title: item.title, libraryId });

  const shuffleAll = async (): Promise<void> => {
    if (!backend) return;
    // The whole library, not the rail: "shuffle everything" that shuffles the
    // twenty-four newest songs is the wrong answer to the one press this screen
    // exists for. Capped because a queue is held in memory and this library is
    // meant to grow - past this many, a shuffle is indistinguishable from a
    // shuffle of a slice anyway.
    const page = await backend.libraryPage(libraryId, { offset: 0, limit: 2000, of: "tracks" }).catch(() => null);
    if (!page?.items.length) return;
    await playQueue(backend, page.items, { shuffle: true });
    go({ name: "nowPlaying" });
  };

  if (failure) return <Message failure={failure} onRetry={() => setReload((n) => n + 1)} />;
  if (!data) return <Message loading />;

  const empty =
    !data.recent.length && !data.albums.length && !data.artists.length && !data.played.length && !data.playlists.length;

  return (
    <div className="relative z-10 flex h-full flex-col">
      <div className="h-[3.3vh] shrink-0" aria-hidden="true" />
      <Actions
        title={title}
        totalTracks={data.totalTracks}
        onReachTop={toTop}
        note={note}
        // Only while the mode is on. Off, this screen's row is already five
        // chips wide, and the way IN to the mode is the songs list and the album
        // screens where it is used - what it needs here is a way OUT, because
        // walking back up to the library is how somebody arrives here with it on.
        onStopAdding={adding ? () => setAdding(false) : undefined}
        // Only when there is something to go back to. A chip that opens an empty
        // player is a press that teaches people the button does nothing.
        onNowPlaying={nowPlaying ? () => go({ name: "nowPlaying" }) : undefined}
        onShuffle={() => void shuffleAll()}
        onSongs={() => go({ name: "musicList", libraryId, lens: "tracks", title })}
        onAlbums={() => go({ name: "musicList", libraryId, lens: "albums", title })}
        onArtists={() => go({ name: "musicList", libraryId, lens: "artists", title })}
      />

      {empty && <Message text={t("music.empty")} />}

      <div className="no-scrollbar flex flex-1 flex-col gap-[2vh] overflow-y-auto pt-[2.5vh] pb-[2vh] scroll-pt-[2.5vh] scroll-pb-[6vh] [mask-image:linear-gradient(to_bottom,transparent_0,#000_2.5vh)]">
        {data.played.length > 0 && (
          <Row
            id="mh-played"
            title={t("music.recentlyPlayed")}
            items={data.played}
            posterUrl={square}
            onSelect={(i) => playFrom(data.played, i)}
            aspect={1}
          />
        )}
        {data.recent.length > 0 && (
          <Row
            id="mh-recent"
            title={t("music.recentlyAdded")}
            items={data.recent}
            posterUrl={square}
            onSelect={open}
            aspect={1}
          />
        )}
        {data.playlists.length > 0 && (
          <Row
            id="mh-playlists"
            title={t("music.playlists")}
            items={data.playlists}
            posterUrl={square}
            onSelect={open}
            aspect={1}
          />
        )}
        {data.artists.length > 0 && (
          <Row
            id="mh-artists"
            title={t("music.artists")}
            items={data.artists}
            posterUrl={square}
            onSelect={open}
            aspect={1}
          />
        )}
        {data.albums.length > 0 && (
          <Row
            id="mh-albums"
            title={t("music.albums")}
            items={data.albums}
            posterUrl={square}
            onSelect={open}
            aspect={1}
          />
        )}
      </div>
    </div>
  );
}

function Actions({
  title,
  totalTracks,
  onReachTop,
  note,
  onStopAdding,
  onShuffle,
  onSongs,
  onAlbums,
  onArtists,
  onNowPlaying,
}: {
  title: string;
  totalTracks?: number;
  onReachTop: () => void;
  /** What the last press added, when it added something. */
  note: string | null;
  /** Absent unless the add mode is on, and then no chip is drawn. */
  onStopAdding?: () => void;
  onShuffle: () => void;
  onSongs: () => void;
  onAlbums: () => void;
  onArtists: () => void;
  /** Absent when nothing is playing, and then no chip is drawn. */
  onNowPlaying?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "mh-actions", saveLastFocusedChild: true });
  const chip = "shrink-0 rounded-[1vh] bg-white/10 px-[2vw] py-[1.1vh] text-[2.2vh]";

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="flex shrink-0 items-center gap-[1vw] px-[4vw] py-[1vh]">
        <span className="mr-[1vw] shrink-0 text-[2.6vh] font-bold">{title}</span>
        {/* Shuffle first and leftmost, because it is the press this screen is
            for. The remote lands here on arrival. */}
        <FocusButton focusKey="mh-shuffle" onFocused={onReachTop} onEnter={onShuffle} className={chip}>
          {t("music.shuffleAll")}
        </FocusButton>
        <FocusButton focusKey="mh-songs" onFocused={onReachTop} onEnter={onSongs} className={chip}>
          {totalTracks ? t("music.songsN", { n: String(totalTracks) }) : t("music.songs")}
        </FocusButton>
        <FocusButton focusKey="mh-albums-all" onFocused={onReachTop} onEnter={onAlbums} className={chip}>
          {t("music.albums")}
        </FocusButton>
        <FocusButton focusKey="mh-artists-all" onFocused={onReachTop} onEnter={onArtists} className={chip}>
          {t("music.artists")}
        </FocusButton>
        {onNowPlaying && (
          <FocusButton focusKey="mh-nowplaying" onFocused={onReachTop} onEnter={onNowPlaying} className={chip}>
            {t("music.nowPlaying")}
          </FocusButton>
        )}
        {onStopAdding && (
          <FocusButton
            focusKey="mh-stopadding"
            onFocused={onReachTop}
            onEnter={onStopAdding}
            className={chip + " !bg-[var(--color-accent)] !text-[#0d1014]"}
          >
            {t("music.addModeOff")}
          </FocusButton>
        )}
        {/* Truncating rather than wrapping: the row is one line tall, and a
            second line here pushes every rail down by its height. */}
        <span className="min-w-0 flex-1 truncate text-[1.9vh] text-fg-dim">{note}</span>
      </div>
    </FocusContext.Provider>
  );
}

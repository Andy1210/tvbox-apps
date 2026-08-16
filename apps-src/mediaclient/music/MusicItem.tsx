// An artist, an album or a playlist: a header and the songs under it.
//
// One screen for three things because the shape is the same - artwork, a name, a
// few actions and a list - and the differences are which call fills the list and
// what the second line says. Three screens would be three copies of the focus
// handling.
//
// The artist case carries a measured trap. `/children` on an artist UNDER-REPORTS
// on this server: one artist with a single album answered zero, and another with
// seventeen answered three. Asking the section for albums filtered by artist
// answers correctly and agrees with each album's own parent, so that is what this
// uses - and it is also what lets "play everything by them" be one request.

import { useEffect, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { Message } from "../Message";
import { TrackRow } from "./TrackRow";
import { artworkScale } from "../posters";
import { useFocusFallback, useInitialFocus } from "../focus";
import { classify, useApp } from "../state";
import { useMusic } from "../playback/music";
import { useArtwork } from "./useArtwork";
import type { ItemKind, MediaItem } from "../backends/types";
import { clock } from "../time";
import { log } from "../redact";

/** A bound on one queue, matching the list screen's. */
const QUEUE_CAP = 2000;

export function MusicItem({
  itemId,
  kind,
  title,
  libraryId,
}: {
  itemId: string;
  kind: ItemKind;
  title: string;
  libraryId: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const playQueue = useMusic((s) => s.playQueue);
  const enqueue = useMusic((s) => s.enqueue);
  const playingId = useMusic((s) => s.queue[s.index]?.id);

  const [header, setHeader] = useState<MediaItem | null>(null);
  const [tracks, setTracks] = useState<MediaItem[] | null>(null);
  const [albums, setAlbums] = useState<MediaItem[]>([]);
  const [reload, setReload] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!backend) return;
    let live = true;

    (async () => {
      try {
        const detail = await backend.item(itemId).catch(() => null);
        if (!live) return;
        setHeader(detail);

        if (kind === "artist") {
          const [al, tr] = await Promise.all([
            backend.libraryPage(libraryId, { offset: 0, limit: 200, of: "albums", filters: { "artist.id": itemId } }),
            backend.libraryPage(libraryId, {
              offset: 0,
              limit: QUEUE_CAP,
              of: "tracks",
              filters: { "artist.id": itemId },
            }),
          ]);
          if (!live) return;
          setAlbums(al.items);
          setTracks(tr.items);
          return;
        }

        const items = kind === "playlist" ? await backend.playlistItems(itemId) : await backend.children(itemId);
        if (!live) return;
        setTracks(items);
      } catch (e) {
        if (!live) return;
        log.warn("music item failed to load", e);
        fail(classify(e));
      }
    })();

    return () => {
      live = false;
    };
  }, [backend, itemId, kind, libraryId, fail, reload]);

  useInitialFocus("mi-play", tracks !== null);
  useFocusFallback(
    "mi-play",
    (key) => key.startsWith("mi-") || key.startsWith("mt-") || key.startsWith("ma-") || key.startsWith("msg-"),
    true,
  );

  const art = (item: MediaItem, px: number): string | undefined =>
    backend?.posterUrl(item, px * artworkScale(), px * artworkScale());
  // The header's own cover, loaded with the credential in a header. Above the
  // early returns below, because a hook cannot be called conditionally.
  const headerArt = useArtwork(header && backend ? art(header, 300) : undefined);

  const play = async (shuffle: boolean, startIndex = 0): Promise<void> => {
    if (!backend || !tracks?.length) return;
    await playQueue(backend, tracks, { startIndex, shuffle });
    go({ name: "nowPlaying" });
  };

  if (failure) return <Message failure={failure} onRetry={() => setReload((n) => n + 1)} />;
  if (tracks === null) return <Message loading />;

  const shown = header ?? ({ id: itemId, kind, title } as MediaItem);
  const subtitle =
    kind === "album"
      ? [shown.parentTitle, shown.year].filter(Boolean).join(" · ")
      : kind === "artist"
        ? t("music.albumsN", { n: String(albums.length) })
        : undefined;
  const totalMs = tracks.reduce((sum, x) => sum + (x.durationMs ?? 0), 0);

  return (
    <div className="relative z-10 flex h-full flex-col px-[4vw]">
      <div className="h-[3.3vh] shrink-0" aria-hidden="true" />

      <div className="flex shrink-0 items-end gap-[2vw] pb-[2vh]">
        {headerArt && (
          <img src={headerArt} alt="" className="h-[22vh] w-[22vh] shrink-0 rounded-[1vh] object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[4vh] font-bold">{shown.title || title}</h1>
          {subtitle && <p className="truncate text-[2.2vh] text-fg-dim">{subtitle}</p>}
          <p className="text-[2vh] text-fg-dim">
            {t("music.tracksN", { n: String(tracks.length) })}
            {totalMs > 0 && ` · ${clock(totalMs)}`}
          </p>
          {note && <p className="mt-[0.6vh] text-[2vh] text-fg-dim">{note}</p>}

          <Actions
            onPlay={() => void play(false)}
            onShuffle={() => void play(true)}
            onQueue={() => {
              enqueue(tracks, "end");
              setNote(t("music.queued", { n: String(tracks.length) }));
            }}
          />
        </div>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-[4vh]">
        {kind === "artist" && albums.length > 0 && (
          <AlbumList
            albums={albums}
            art={(a) => art(a, 160)}
            onOpen={(a) => go({ name: "musicItem", itemId: a.id, kind: "album", title: a.title, libraryId })}
          />
        )}

        <ul className="flex flex-col">
          {tracks.map((item, i) => (
            <li key={item.id}>
              <TrackRow
                item={item}
                focusKey={`mt-${item.id}`}
                ordinal={item.index ?? i + 1}
                // No cover per row on an album: every one of them is the album's
                // own, already shown at the top, so the column would be the same
                // picture repeated down the screen. An artist's list spans
                // albums, so there it earns its place.
                artUrl={kind === "album" ? undefined : art(item, 160)}
                playing={item.id === playingId}
                onEnter={() => void play(false, i)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Actions({
  onPlay,
  onShuffle,
  onQueue,
}: {
  onPlay: () => void;
  onShuffle: () => void;
  onQueue: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "mi-actions", saveLastFocusedChild: true });
  const chip = "shrink-0 rounded-[1vh] bg-white/10 px-[2vw] py-[1.1vh] text-[2.2vh]";
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="mt-[1.2vh] flex items-center gap-[1vw]">
        <FocusButton focusKey="mi-play" onEnter={onPlay} className={chip}>
          {t("music.play")}
        </FocusButton>
        <FocusButton focusKey="mi-shuffle" onEnter={onShuffle} className={chip}>
          {t("music.shuffle")}
        </FocusButton>
        <FocusButton focusKey="mi-queue" onEnter={onQueue} className={chip}>
          {t("music.addToQueue")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}

function AlbumList({
  albums,
  art,
  onOpen,
}: {
  albums: MediaItem[];
  art: (a: MediaItem) => string | undefined;
  onOpen: (a: MediaItem) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <h2 className="px-[1.5vw] pt-[1vh] pb-[0.6vh] text-[2.2vh] text-fg-dim">{t("music.albums")}</h2>
      <ul className="flex flex-col pb-[1.5vh]">
        {albums.map((a) => (
          <li key={a.id}>
            <TrackRow item={a} focusKey={`ma-${a.id}`} artUrl={art(a)} onEnter={() => onOpen(a)} />
          </li>
        ))}
      </ul>
    </>
  );
}

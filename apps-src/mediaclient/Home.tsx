import { useEffect, useState, useRef } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { Row } from "./Row";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { useFocusFallback, useInitialFocus, useScrollToTopOnFirst } from "./focus";
import { usePlayer } from "./playback/player";
import { usePrefs } from "./prefs";
import { Hero } from "./Hero";
import { classify, useApp } from "./state";
import type { Library, MediaItem } from "./backends/types";
import { log } from "./redact";

interface Loaded {
  libraries: Library[];
  onDeck: MediaItem[];
  recent: { library: Library; items: MediaItem[] }[];
  playlists: MediaItem[];
}

/**
 * What the TV opens on.
 *
 * Continue-watching first, because that is what the box is used for most
 * evenings; then what each library gained recently. A library with nothing new
 * contributes no row rather than an empty one - a row that is always there and
 * always empty teaches people to skip past that part of the screen.
 */
export function Home(): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const homeRows = usePrefs((s) => s.homeRows);
  const hiddenRows = usePrefs((s) => s.hiddenRows);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const playing = usePlayer((s) => s.current !== null);
  const [reload, setReload] = useState(0);
  const [under, setUnder] = useState<MediaItem | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  // The rail is the top of the page, so reaching it takes the page there. The
  // hero and the rail are both above the rows, and nothing else up there is
  // focusable - without this, scrolling back was one-way.
  const toTop = useScrollToTopOnFirst(scroller);
  const [data, setData] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!backend) return;
    let live = true;

    (async () => {
      try {
        const libraries = await backend.libraries();
        if (!live) return;

        // On-deck first and on its own: it is the row people came for, and
        // waiting for every library's recents before showing anything makes the
        // TV look broken on a slow server.
        const onDeck = await backend.onDeck();
        if (!live) return;
        setData({ libraries, onDeck, recent: [], playlists: [] });

        // After the first paint, not before it: the account may have none, and
        // nobody should wait on that answer to see what they were watching.
        void backend
          .playlists()
          .then((p) => live && setData((d) => (d ? { ...d, playlists: p } : d)))
          .catch(() => {
            /* a row that does not appear is the right failure here */
          });

        const recent: Loaded["recent"] = [];
        for (const library of libraries) {
          const items = await backend.recentlyAdded(library.id, library.kind);
          if (!live) return;
          if (items.length) recent.push({ library, items });
          setData((d) => ({ libraries, onDeck, recent: [...recent], playlists: d?.playlists ?? [] }));
        }
      } catch (e) {
        if (!live) return;
        log.warn("home failed to load", e);
        fail(classify(e));
      }
    })();

    return () => {
      live = false;
    };
  }, [backend, fail, reload]);

  // The first thing worth pressing: what you were watching, or a library when
  // there is nothing to carry on with. Up from there reaches the top rail.
  const firstKey = data?.onDeck.length
    ? `ondeck-${data.onDeck[0].id}`
    : data?.libraries.length
      ? `lib-${data.libraries[0].id}`
      : "nav-search";
  useInitialFocus(firstKey, Boolean(data));
  // Focus is set once; without a fallback anything that unmounts the focused
  // tile afterwards leaves the D-pad dead with only Back working.
  useFocusFallback(
    firstKey,
    (key) =>
      key.startsWith("ondeck-") ||
      key.startsWith("lib-") ||
      key.startsWith("recent-") ||
      key.startsWith("playlists-") ||
      key.startsWith("nav-"),
    !playing,
  );

  const poster = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());

  /**
   * Carry-on-watching rows show the SERIES cover, not the episode's own still.
   *
   * An episode's thumb is a frame from the episode, which is 16:9 and arrives
   * letterboxed into a 2:3 tile - so a row of them reads as a row of blurry
   * screenshots next to the posters beside it, and none of them says which show
   * it is. Films are unaffected: they carry no series.
   */
  const deckPoster = (item: MediaItem): string | undefined =>
    backend?.posterUrl(
      item.seriesThumb ? { ...item, thumb: item.seriesThumb } : item,
      300 * artworkScale(),
      450 * artworkScale(),
    );
  const open = (item: MediaItem): void => go({ name: "item", itemId: item.id });

  if (failure) return <Message failure={failure} onRetry={() => setReload((n) => n + 1)} />;
  if (!data) return <Message loading />;

  const nothing = data.onDeck.length === 0 && data.recent.length === 0;

  return (
    <>
      {/* The rail and the hero do not scroll. The hero is what the screen is
          FOR - it is the only thing that says what a poster actually is - so it
          stays put and the rows move under it. That also decides how many rows
          are on screen at once: one, which is what someone is choosing from. */}
      <div className="relative z-10 flex h-full flex-col">
        {/* One rail at the top holding the libraries AND the two actions.
          Separately, the actions sat far right in a header while the first tile
          sat far left, and spatial navigation resolves Up by geometry - so
          reaching them meant finding the one column of the grid that happened to
          line up. In one row they are always one Left press away, and the
          libraries are where someone looks for them. */}
        {/* Not focusable, so it cannot get in the way of the rail below it - but
          something has to say which app this is. */}
        <h1 className="shrink-0 px-[4vw] text-[2.2vh] font-semibold tracking-tight opacity-70">{t("app.name")}</h1>

        <TopRow
          onReachTop={toTop}
          libraries={data.libraries}
          onLibrary={(l) => go({ name: "library", libraryId: l.id, title: l.title })}
          onSearch={() => go({ name: "search" })}
          onSettings={() => go({ name: "settings" })}
        />

        <Hero item={under} />

        {nothing && <Message text={t("home.empty")} />}

        <div
          ref={scroller}
          // scroll-pt has to clear the row's HEADING, not just the tile. The
          // browser brings the focused tile into view and knows nothing about
          // the title above it, so a small padding parked the tile at the top
          // and pushed "Carry on watching" off the screen - and with it the
          // captions at the bottom of the same row.
          className="no-scrollbar flex flex-1 flex-col gap-[2vh] overflow-y-auto pb-[2vh] scroll-pt-[11vh] scroll-pb-[6vh]"
        >
          {/* Ordered by the household, not by us. A row switched off is not
          rendered at all rather than rendered empty, and one with nothing in it
          is skipped for the same reason: a row that is blank on most boxes
          teaches people to scroll past that part of the screen. */}
          {homeRows
            .filter((id) => !hiddenRows.includes(id))
            .map((id) => {
              if (id === "ondeck")
                return data.onDeck.length ? (
                  <Row
                    key="ondeck"
                    id="ondeck"
                    title={t("home.continue")}
                    items={data.onDeck}
                    posterUrl={deckPoster}
                    onSelect={open}
                    onFocusItem={setUnder}
                    heightVh={24}
                  />
                ) : null;

              if (id === "playlists")
                return data.playlists.length ? (
                  <Row
                    key="playlists"
                    id="playlists"
                    title={t("home.playlists")}
                    items={data.playlists}
                    posterUrl={poster}
                    onSelect={open}
                    onFocusItem={setUnder}
                  />
                ) : null;

              return data.recent.map(({ library, items }) => (
                <Row
                  key={library.id}
                  id={`recent-${library.id}`}
                  title={t("home.recentIn", { library: library.title })}
                  items={items}
                  posterUrl={poster}
                  onSelect={open}
                  onFocusItem={setUnder}
                />
              ));
            })}
        </div>
      </div>
    </>
  );
}

function TopRow({
  onReachTop,
  libraries,
  onLibrary,
  onSearch,
  onSettings,
}: {
  onReachTop: () => void;
  libraries: Library[];
  onLibrary: (l: Library) => void;
  onSearch: () => void;
  onSettings: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "top", saveLastFocusedChild: true });

  return (
    <FocusContext.Provider value={focusKey}>
      {/* The libraries scroll; search and settings do not. A server with five
          libraries would otherwise push the only route to sign-out off the far
          end of a rail whose scrollbar is hidden. */}
      <div ref={ref} className="flex shrink-0 items-center gap-[1vw] px-[4vw] py-[1vh]">
        {/* Padding on BOTH axes, with matching negative margins so the row does
            not move. The focus state scales a chip by 4% and this element
            scrolls, so it clips its own children - vertically at the top and
            bottom, and horizontally at scroll position zero, which is where the
            first chip sits and therefore the one most often focused. */}
        <div className="no-scrollbar -mx-[0.8vw] -my-[1.4vh] flex min-w-0 flex-1 items-center gap-[1vw] overflow-x-auto px-[0.8vw] py-[1.4vh]">
          {libraries.map((l) => (
            <FocusButton
              key={l.id}
              focusKey={`lib-${l.id}`}
              onEnter={() => onLibrary(l)}
              className="shrink-0 rounded-[1vh] bg-white/10 px-[2vw] py-[1.1vh] text-[2.2vh]"
            >
              {l.title}
            </FocusButton>
          ))}
        </div>

        <FocusButton
          focusKey="nav-search"
          onFocused={onReachTop}
          onEnter={onSearch}
          className="shrink-0 rounded-[1vh] bg-white/10 px-[2vw] py-[1.1vh] text-[2.2vh]"
        >
          {t("home.search")}
        </FocusButton>
        <FocusButton
          focusKey="nav-settings"
          onFocused={onReachTop}
          onEnter={onSettings}
          className="shrink-0 rounded-[1vh] bg-white/10 px-[2vw] py-[1.1vh] text-[2.2vh]"
        >
          {t("home.settings")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}

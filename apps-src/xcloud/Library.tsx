import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FocusButton, Osk, useI18n } from "@sdk";
import { getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";
import { Grid } from "./Grid";
import { Row } from "./Row";
import { Splash } from "./XCloud";
import { SearchIcon, CloseIcon, ExitIcon } from "./icons";
import { createMover, nearest } from "./moveTo";

// The library. Short curated rows, then everything the subscription covers, with a
// search over the whole catalogue and a genre filter over what is shown.
//
// The page moves itself with a transform and never scrolls - see moveTo.ts for the
// measurement behind that. Two consequences shape this file: the header sits
// OUTSIDE the moving container so it stays put, and the moving container carries
// padding because a tile's focus outline is drawn outside the tile and the
// viewport clips.
const RECENT_LIMIT = 12;
// While the catalogue is still filling in behind the first screen. Frequent enough
// that the grid grows visibly, rare enough that re-reading a 1.25 MB answer is not
// what makes it slow.
const FILLING_POLL_MS = 3000;
// A stale cache is being refreshed behind the answer; one re-read is enough.
const STALE_REREAD_MS = 20000;
const ALL_GENRES = "*";

export function Library({
  status,
  onPlay,
  onSignedOut,
  onExit,
}: {
  status: api.Status | null;
  onPlay: (title: api.Title) => void;
  onSignedOut: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const [all, setAll] = useState<api.Title[] | null>(null);
  const [recent, setRecent] = useState<api.Title[]>([]);
  const [collections, setCollections] = useState<Record<string, api.Title[]>>({});
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [genre, setGenre] = useState(ALL_GENRES);

  const mover = useMemo(() => createMover("y"), []);
  const viewport = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);

  const attachContent = useCallback(
    (el: HTMLDivElement | null) => {
      content.current = el;
      mover.attach(el);
    },
    [mover],
  );

  // Bring whatever just took focus into the window. `nearest` in the sense
  // scrollIntoView means it: something already visible does not move the page,
  // which is what keeps a sideways press from nudging it vertically.
  const show = useCallback(
    (el: HTMLElement) => {
      const box = viewport.current;
      const col = content.current;
      if (!box || !col) return;
      const item = el.getBoundingClientRect();
      const view = box.getBoundingClientRect();
      // The column is translated by -at, so its rect already carries the shift;
      // adding `at` back gives the position in the un-moved column.
      const start = item.top - view.top + mover.at;
      mover.to(
        nearest({
          at: mover.at,
          viewport: view.height,
          start,
          size: item.height,
          // A row flush against the edge is inside the overscan of some sets, and
          // the focus outline needs room beyond that.
          padStart: Math.round(view.height * 0.06),
          padEnd: Math.round(view.height * 0.06),
          max: col.scrollHeight,
        }),
        true,
      );
    },
    [mover],
  );

  useEffect(() => {
    let alive = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      // The plugin answers a cold library as soon as the first screen is
      // hydrated, so this re-reads until the rest lands rather than either
      // waiting for it or treating fifty titles as the whole catalogue.
      const read = async (): Promise<void> => {
        const lib = await api.getLibrary();
        if (!alive) return;
        setAll(lib.titles);
        setPartial(lib.partial);
        // The curated rows are resolved against the catalogue, so while it is
        // still filling they come back short - re-read them with it rather than
        // leaving the first, emptiest answer on screen.
        const c = await api.getCollections().catch(() => null);
        if (alive && c) setCollections(c.collections);
        if (lib.filling || lib.stale) {
          again = setTimeout(() => void read().catch(() => {}), lib.filling ? FILLING_POLL_MS : STALE_REREAD_MS);
        }
      };
      try {
        await read();
      } catch (e) {
        if (alive) setError(t("errors." + ((e as api.ApiError).code || "generic")) || t("errors.generic"));
      }
      // Asked separately because it is the one thing that changes between two
      // launches, so it is never served from the cache.
      const r = await api.getRecent().catch(() => null);
      if (alive && r) setRecent(r.titles.filter((x) => x.name).slice(0, RECENT_LIMIT));
    })();
    return () => {
      alive = false;
      if (again) clearTimeout(again);
    };
  }, [t]);

  const playable = useMemo(() => (all || []).filter((x) => x.name), [all]);
  // The grid shows what the subscription covers, and search reaches the rest. Not
  // a tidying-up: every tile is a DOM node and an <img>, and the full catalogue is
  // 2530 of them - measured at 7650 nodes against 1874 for this.
  const owned = useMemo(() => playable.filter((x) => x.owned), [playable]);

  // Genres, from the categories the catalogue already gave us. Only those with
  // enough titles to be worth a chip: a filter that leads to two games is a dead
  // end you have to press Back out of.
  const genres = useMemo(() => {
    const count = new Map<string, number>();
    for (const tt of owned) for (const c of tt.categories || []) count.set(c, (count.get(c) || 0) + 1);
    return [...count.entries()]
      .filter(([, n]) => n >= 5)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n]) => ({ name, n }));
  }, [owned]);

  const results = useMemo(() => {
    const q = normalize(query);
    if (!q) return null;
    return playable.filter((x) => normalize(x.name).includes(q));
  }, [playable, query]);

  const gridTitles = useMemo(() => {
    const base = results ?? owned;
    return genre === ALL_GENRES ? base : base.filter((x) => (x.categories || []).includes(genre));
  }, [results, owned, genre]);

  const rows = useMemo(
    () =>
      [
        { id: "r-continue", label: t("library.recent"), titles: recent },
        { id: "r-new", label: t("library.recentlyAdded"), titles: collections.recentlyAdded || [] },
        { id: "r-leaving", label: t("library.leavingSoon"), titles: collections.leavingSoon || [] },
      ].filter((r) => r.titles.length > 0),
    [t, recent, collections],
  );

  // The first thing to focus, named rather than assumed: a tile's key is its
  // title id, so there is no "-0".
  const firstOfGrid = gridTitles.length
    ? [...gridTitles].sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name))[0]
    : null;
  const firstKey = results
    ? firstOfGrid && `g-search-${firstOfGrid.titleId}`
    : rows.length
      ? `${rows[0].id}-${rows[0].titles[0].titleId}`
      : firstOfGrid && `g-all-${firstOfGrid.titleId}`;
  // Which LIST is on screen. The initial focus is placed once per list, not once
  // per data change: the catalogue keeps arriving for half a minute, and
  // re-focusing on every re-read walked the cursor back to the first tile
  // whenever the grid grew - measured, sixteen presses down ended up back at the
  // top.
  const listId = results ? "search:" + query : "library:" + genre;
  const placed = useRef({ list: "", key: "" });
  useEffect(() => {
    if (!all || typing || !firstKey) return;
    const p = placed.current;
    if (p.list === listId) {
      // The screen assembles in pieces: the grid is here before the rows are, so
      // the first key changes once the continue row arrives. Re-place only while
      // nobody has moved - measured, without this the cursor opened on the grid,
      // which sits below the rows and off the bottom of the screen.
      if (p.key === firstKey) return;
      if (getCurrentFocusKey() !== p.key) return;
    }
    placed.current = { list: listId, key: firstKey };
    // useFocusable registers during its own effect, so a setFocus in a sibling
    // effect of the same commit can run first and find nothing there.
    const id = setTimeout(() => setFocus(firstKey), 0);
    return () => clearTimeout(id);
  }, [all, firstKey, typing, listId]);

  // A different list is not a move within one: there is nothing to follow from the
  // old position to the new.
  useEffect(() => {
    mover.to(0, false);
  }, [mover, query, genre]);

  const onSearchDone = useCallback((value: string) => {
    setQuery(value.trim());
    setGenre(ALL_GENRES);
    setTyping(false);
  }, []);

  if (error) return <Splash>{error}</Splash>;
  if (!all) return <Splash>{t("library.loading")}</Splash>;
  if (!playable.length) return <Splash>{t("library.empty")}</Splash>;

  if (typing) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-0 p-[4vw]">
        <Osk title={t("library.search")} initial={query} onDone={onSearchDone} onCancel={() => setTyping(false)} />
      </div>
    );
  }

  const hidden = playable.length - owned.length;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg-0 text-fg">
      {/* Outside the moving column, so it stays put. */}
      <header className="flex shrink-0 items-center justify-between gap-6 px-[4vw] pb-[2vh] pt-[3vh]">
        <h1 className="text-4xl font-semibold">{t("title")}</h1>
        <div className="flex items-center gap-4">
          {partial && <span className="text-lg text-warn">{t("library.partial")}</span>}
          {status?.gamertag && (
            <span className="text-lg text-fg-dim">{t("library.signedInAs", { gamertag: status.gamertag })}</span>
          )}
          <FocusButton
            focusKey="lib-search"
            className="flex items-center gap-3 rounded-lg bg-bg-1 px-6 py-3 text-xl"
            onEnter={() => setTyping(true)}
            label={t("library.search")}
          >
            <SearchIcon className="h-[1.1em] w-[1.1em]" />
            <span>{query || t("library.search")}</span>
          </FocusButton>
          {query && (
            <FocusButton
              focusKey="lib-clear"
              className="flex items-center rounded-lg bg-bg-1 px-5 py-3 text-xl"
              onEnter={() => setQuery("")}
              label={t("library.clear")}
            >
              <CloseIcon className="h-[1.1em] w-[1.1em]" />
            </FocusButton>
          )}
          <FocusButton
            focusKey="lib-signout"
            className="rounded-lg bg-bg-1 px-5 py-3 text-xl"
            onEnter={() => void api.signOut().then(onSignedOut)}
          >
            {t("library.signOut")}
          </FocusButton>
          <FocusButton
            focusKey="lib-exit"
            className="flex items-center rounded-lg bg-bg-1 px-5 py-3 text-xl"
            onEnter={onExit}
            label={t("stream.stop")}
          >
            <ExitIcon className="h-[1.1em] w-[1.1em]" />
          </FocusButton>
        </div>
      </header>

      {/* The window. It clips, which is why the column below pads. */}
      <div ref={viewport} className="min-h-0 flex-1 overflow-hidden px-[4vw]">
        <div ref={attachContent} className="pb-[8vh] pt-[1vh] will-change-transform">
          {!results &&
            rows.map((r) => (
              <Row key={r.id} id={r.id} label={r.label} titles={r.titles} onPlay={onPlay} onFocused={show} />
            ))}

          {genres.length > 1 && (
            <section className="mb-[2vh]">
              <div className="flex flex-wrap gap-3 px-[0.5vw]">
                <Chip
                  focusKey="genre-all"
                  active={genre === ALL_GENRES}
                  label={t("library.allGenres")}
                  onEnter={() => setGenre(ALL_GENRES)}
                  onFocused={show}
                />
                {genres.map((g, i) => (
                  <Chip
                    key={g.name}
                    focusKey={`genre-${i}`}
                    active={genre === g.name}
                    label={g.name}
                    onEnter={() => setGenre(g.name)}
                    onFocused={show}
                  />
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-[1vh] flex items-baseline gap-4 px-[0.5vw] text-2xl text-fg-dim">
              <span>
                {results ? t("library.search") : t("library.owned")} — {gridTitles.length}
              </span>
              {/* Say what is NOT on screen, rather than letting the grid look like
                  the whole catalogue. */}
              {!results && genre === ALL_GENRES && hidden > 0 && (
                <span className="text-lg">{t("library.searchRest", { count: hidden })}</span>
              )}
            </h2>
            {gridTitles.length ? (
              <Grid
                titles={gridTitles}
                idPrefix={results ? "g-search" : "g-all"}
                onPlay={onPlay}
                onFocused={show}
              />
            ) : (
              <p className="px-[0.5vw] py-[6vh] text-3xl text-fg-dim">
                {results ? t("library.noResults", { query }) : t("library.empty")}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Chip({
  focusKey,
  active,
  label,
  onEnter,
  onFocused,
}: {
  focusKey: string;
  active: boolean;
  label: string;
  onEnter: () => void;
  onFocused: (el: HTMLElement) => void;
}) {
  return (
    <FocusButton
      focusKey={focusKey}
      // The chosen filter has to stay legible when it is NOT the focused thing,
      // so it is marked by its fill rather than by the focus ring.
      className={
        "rounded-full px-5 py-2 text-lg " + (active ? "bg-accent text-fg" : "bg-bg-1 text-fg-dim")
      }
      onEnter={onEnter}
      onFocused={() => {
        const el = document.querySelector<HTMLElement>(`[data-sfocus="${focusKey}"]`);
        if (el) onFocused(el);
      }}
    >
      {label}
    </FocusButton>
  );
}

// Accent-insensitive, so "pokemon" finds "Pokémon" - the same normalisation the
// plugin's own search route uses.
const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks so "pokemon" finds "Pokémon"
    .toLowerCase()
    .trim();

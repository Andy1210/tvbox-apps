import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FocusButton, Osk, useBackspace, useI18n } from "@sdk";
import { doesFocusableExist, getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";
import { Grid } from "./Grid";
import { Row } from "./Row";
import { SearchIcon, CloseIcon, SettingsIcon } from "./icons";
import { errorText } from "./errors";
import { Settings } from "./Settings";
import { createMover, nearest, pinScroll } from "@sdk/moveTo";

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

// No "leave the app" BUTTON: the remote's Home already does that, and a second
// way to do it took a slot in a header where every button costs a press to get
// past. Back still leaves, which is the convention every other app on this box
// follows - walk the screens first, and only leave from the top.
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
  const { t, tag } = useI18n();
  const [all, setAll] = useState<api.Title[] | null>(null);
  const [recent, setRecent] = useState<api.Title[]>([]);
  const [collections, setCollections] = useState<Record<string, api.Title[]>>({});
  const [partial, setPartial] = useState(false);
  // The catalogue arrives over about half a minute, and a count printed off the
  // first screen of it read "42" for a library of 2530 - a number wrong by sixty
  // times, stated with no hedge, next to a row that was one tile wide.
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [genre, setGenre] = useState(ALL_GENRES);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const mover = useMemo(() => createMover("y"), []);
  const viewport = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const pin = useMemo(() => pinScroll(), []);
  const attachViewport = useCallback(
    (el: HTMLDivElement | null) => {
      viewport.current = el;
      pin(el);
    },
    [pin],
  );

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
      // Measured against the COLUMN, not against the window. Both rects carry the
      // same transform, so their difference is where the element sits in the
      // un-moved column - which is what `mover.to` wants.
      //
      // The old form added `mover.at` to a window-relative top, mixing the
      // transform's CURRENT position (the rect, mid-animation) with its
      // DESTINATION (`at`, set synchronously). The library assembles in three
      // commits - catalogue, collections, recent - so three `setFocus` calls land
      // inside the 180 ms move, and 7 cold launches in 8 came to rest 191 px down:
      // the first row clipped, and the header above it unreachable, because
      // norigin only looks up at what is fully above the focused rect.
      const colBox = col.getBoundingClientRect();
      // A row's heading belongs to the tile under it. Bringing the TILE into view
      // left "Continue" cut off at the top, because the label was not part of what
      // was being shown - so for a tile in the first line of its section, the band
      // starts at the section instead. Only the first line: measuring from the
      // section top while deep in the grid would jump back to its beginning.
      let top = item.top;
      const section = el.closest("section");
      if (section) {
        const sec = section.getBoundingClientRect();
        if (item.top - sec.top < item.height) top = sec.top;
      }
      const start = top - colBox.top;
      mover.to(
        nearest({
          at: mover.at,
          viewport: view.height,
          start,
          size: item.bottom - top,
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

  // Bumped by the settings panel's refresh, which is what makes the grid behind it
  // re-read - it said "refreshed" over the catalogue it had just replaced.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      // The plugin answers a cold library as soon as the first screen is
      // hydrated, so this re-reads until the rest lands rather than either
      // waiting for it or treating fifty titles as the whole catalogue.
      const read = async (): Promise<void> => {
        const lib = await api.getLibrary(tag);
        if (!alive) return;
        // A read that WORKED clears the last one's message. Without this the
        // refresh wired up in Settings changed nothing on screen: the catalogue
        // loaded behind an error sentence that nothing could ever remove, and
        // leaving the app was the only way past it.
        setError(null);
        setAll(lib.titles);
        setPartial(lib.partial);
        setFilling(!!lib.filling);
        // The curated rows are resolved against the catalogue, so while it is
        // still filling they come back short - re-read them with it rather than
        // leaving the first, emptiest answer on screen.
        const c = await api.getCollections(tag).catch(() => null);
        if (alive && c) setCollections(c.collections);
        if (lib.filling || lib.stale) {
          again = setTimeout(() => void read().catch(() => {}), lib.filling ? FILLING_POLL_MS : STALE_REREAD_MS);
        }
      };
      try {
        await read();
      } catch (e) {
        if (alive) setError(errorText(t, (e as api.ApiError).code));
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
  }, [t, tag, reload]);

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
    // Nothing in the body to focus: the header is what the remote gets, or the
    // screen is one nobody can leave.
    // Not while another screen owns the focus. The settings panel replaces the
    // whole library body, so placing a grid tile from here targets something that
    // is not mounted: measured, pressing "Refresh the catalogue" left the panel
    // with nothing focused and only Back to get out.
    if (typing || settingsOpen) return;
    if (!firstKey || !all || !playable.length) {
      const id = setTimeout(() => setFocus("lib-settings"), 0);
      return () => clearTimeout(id);
    }
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
  }, [all, firstKey, typing, settingsOpen, listId]);

  // And a safety net under all of it: whenever a press arrives with nothing
  // focused, put the cursor back.
  //
  // The placement above only fires when the LIST changes, and the ways to end up
  // with nothing focused do not change it - closing the on-screen keyboard,
  // confirming it empty, clearing the query with the X. Each unmounts the element
  // that held focus and leaves the screen inert: measured, six presses in every
  // direction recovered nothing and only Home escaped.
  useEffect(() => {
    const onKey = () => {
      // `doesFocusableExist`, not just "is a key set": norigin's own
      // `removeFocusable` deletes the component and leaves `focusKey` pointing at
      // it, so after the element unmounts the getter still answers with the dead
      // key - and this guard returned early every single time. Measured: closing
      // the on-screen keyboard, confirming it empty, or clearing the query with
      // the X each left the screen inert, and ten presses in every direction
      // recovered nothing.
      const at = getCurrentFocusKey();
      if (at && doesFocusableExist(at)) return;
      setFocus(firstKey && doesFocusableExist(firstKey) ? firstKey : "lib-settings");
    };
    // Capture, ahead of the library's own handler, which would otherwise act on
    // the dead focus first.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [firstKey]);

  // A different list is not a move within one: there is nothing to follow from the
  // old position to the new.
  useEffect(() => {
    mover.to(0, false);
  }, [mover, query, genre]);

  // Back walks the screens: the keyboard, then a search, then the app. It did
  // nothing at all before - every other app on the box registers one, and a
  // remote's Back key reaching a page that ignores it is a dead key.
  useBackspace(() => {
    if (typing) setTyping(false);
    else if (query) setQuery("");
    else onExit();
  });

  const onSearchDone = useCallback((value: string) => {
    setQuery(value.trim());
    setGenre(ALL_GENRES);
    setTyping(false);
  }, []);

  if (typing) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-0 p-[4vw]">
        <Osk title={t("library.search")} initial={query} onDone={onSearchDone} onCancel={() => setTyping(false)} />
      </div>
    );
  }

  const hidden = playable.length - owned.length;
  // Loading, empty and failed all keep the header. An early return took it with
  // them, and the "no games available" screen then had no way to reach the
  // settings that could refresh the catalogue or sign out - measured after a
  // refresh went wrong, and an app restart did not help because the screen itself
  // was the dead end.
  const message = error || (!all ? t("library.loading") : !playable.length ? t("library.empty") : null);

  if (settingsOpen) {
    return (
      <Settings
        status={status}
        onSignedOut={onSignedOut}
        onRefreshed={() => setReload((n) => n + 1)}
        onClose={() => {
          setSettingsOpen(false);
          // Back to the button it was opened from, or the remote is left with
          // nothing focused on a screen full of tiles.
          setTimeout(() => setFocus("lib-settings"), 0);
        }}
      />
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg-0 text-fg">
      {/* Outside the moving column, so it stays put. */}
      <header className="flex shrink-0 items-center justify-between gap-6 px-[4vw] pb-[2vh] pt-[3vh]">
        <h1 className="text-[3.3vh] font-semibold">{t("title")}</h1>
        <div className="flex items-center gap-4">
          {partial && <span className="text-[1.7vh] text-warn">{t("library.partial")}</span>}
          {status?.gamertag && (
            <span className="text-[1.7vh] text-fg-dim">{t("library.signedInAs", { gamertag: status.gamertag })}</span>
          )}
          <FocusButton
            focusKey="lib-search"
            className="flex items-center gap-3 rounded-lg bg-bg-1 px-6 py-3 text-[1.9vh]"
            onEnter={() => setTyping(true)}
            label={t("library.search")}
          >
            <SearchIcon className="h-[1.1em] w-[1.1em]" />
            <span>{query || t("library.search")}</span>
          </FocusButton>
          {query && (
            <FocusButton
              focusKey="lib-clear"
              className="flex items-center rounded-lg bg-bg-1 px-5 py-3 text-[1.9vh]"
              onEnter={() => setQuery("")}
              label={t("library.clear")}
            >
              <CloseIcon className="h-[1.1em] w-[1.1em]" />
            </FocusButton>
          )}
          <FocusButton
            focusKey="lib-settings"
            className="flex items-center gap-3 rounded-lg bg-bg-1 px-6 py-3 text-[1.9vh]"
            onEnter={() => setSettingsOpen(true)}
            label={t("settings.title")}
          >
            <SettingsIcon className="h-[1.1em] w-[1.1em]" />
            <span>{t("settings.title")}</span>
          </FocusButton>
        </div>
      </header>

      {/* Loading, empty and failed all keep the header above. Returning a bare
          message instead took it with them, and the "no games available" screen
          then had no way to reach the settings that could refresh the catalogue or
          sign out - measured after a refresh went wrong, with an app restart no
          help because the screen itself was the dead end. */}
      {message && (
        <div className="flex flex-1 items-center justify-center px-[4vw]">
          <p className={"text-center text-[2.8vh] " + (error ? "text-warn" : "text-fg-dim")}>{message}</p>
        </div>
      )}

      {/* The window. It clips, which is why the column below pads. Horizontal room
          for the focus reach too: a row's first tile sits at this edge.
          UNMOUNTED rather than hidden when there is a message: `display: none`
          leaves every tile registered with spatial navigation at a 0x0 rect on the
          origin, which reads as "far left" - measured, two Lefts from the settings
          button landed on an undrawn tile and Enter there STARTED A GAME nobody
          could see. */}
      {!message && (
      <div
        ref={attachViewport}
        className="min-h-0 flex-1 overflow-hidden"
        style={{ paddingLeft: "calc(4vw - var(--focus-reach))", paddingRight: "calc(4vw - var(--focus-reach))" }}
      >
        {/* The reach again: this column is inside the window, which clips, so the
            first row's highlight needs room above it. */}
        <div
          ref={attachContent}
          className="pb-[8vh] will-change-transform"
          style={{ paddingTop: "var(--focus-reach)" }}
        >
          {!results &&
            rows.map((r) => (
              <Row key={r.id} id={r.id} label={r.label} titles={r.titles} onPlay={onPlay} onFocused={show} />
            ))}

          {genres.length > 1 && !(results && !gridTitles.length) && (
            <section className="mb-[2vh]">
              <div className="flex flex-wrap gap-3 px-[0.5vw]">
                <Chip
                  focusKey="genre-all"
                  active={genre === ALL_GENRES}
                  label={t("library.allGenres")}
                  onEnter={() => setGenre(ALL_GENRES)}
                  onFocused={show}
                />
                {genres.map((g) => (
                  <Chip
                    key={g.name}
                    // Keyed on the NAME, not the position - the same rule the grid
                    // states for its tiles. The list is sorted by count and the
                    // catalogue keeps arriving for half a minute, so a positional
                    // key put a different genre under the cursor between reads, and
                    // re-registered the focused element under a new key so the next
                    // press found nothing where it was standing.
                    focusKey={`genre-${slug(g.name)}`}
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
            <h2 className="mb-[1vh] flex items-baseline gap-4 px-[0.5vw] text-[2.2vh] text-fg-dim">
              <span>
                {results ? t("library.search") : t("library.owned")}
                {filling && !results ? "" : " — " + gridTitles.length}
              </span>
              {filling && !results && <span className="text-[1.7vh] text-warn">{t("library.filling")}</span>}
              {/* Say what is NOT on screen, rather than letting the grid look like
                  the whole catalogue. */}
              {!results && !filling && genre === ALL_GENRES && hidden > 0 && (
                <span className="text-[1.7vh]">{t("library.searchRest", { count: hidden })}</span>
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
              <p className="px-[0.5vw] py-[6vh] text-[2.8vh] text-fg-dim">
                {results ? t("library.noResults", { query }) : t("library.empty")}
              </p>
            )}
          </section>
        </div>
      </div>
      )}
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
        "rounded-full px-5 py-2 text-[1.7vh] " + (active ? "bg-accent text-fg" : "bg-bg-1 text-fg-dim")
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

// A focus key has to be a stable, safe identifier, and a category name is neither
// (they carry spaces, ampersands and accents). Collisions cannot matter here: two
// genres that slug the same would already be one chip to a reader.
const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Accent-insensitive, so "pokemon" finds "Pokémon" - the same normalisation the
// plugin's own search route uses.
const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks so "pokemon" finds "Pokémon"
    .toLowerCase()
    .trim();

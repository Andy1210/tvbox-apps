import { useCallback, useEffect, useMemo, useState } from "react";
import { FocusButton, Osk, useI18n } from "@sdk";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";
import { Grid } from "./Grid";
import { Tile } from "./Tile";
import { Splash } from "./XCloud";

// The library: what you were in the middle of, then everything, then a search over
// the lot.
//
// The whole catalogue is held rather than paged in as the grid scrolls, and the
// search is the reason: 2531 titles is unusable without one, and a search cannot
// look at rows that were never fetched. The metadata for all of them is 1.45 MB.
// The art stays lazy, which the browser does for us.
//
// One row and one grid rather than three rows: two rows both sorted
// alphabetically - "in your subscription" and "everything" - showed the same first
// screen, which is two rows for one content.
const RECENT_LIMIT = 12;

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
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    let alive = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      try {
        const lib = await api.getLibrary();
        if (!alive) return;
        setAll(lib.titles);
        setPartial(lib.partial);
        // A stale answer means the plugin is refreshing behind it: the rows are
        // usable now and better in a moment, so re-read once rather than making
        // anyone wait for a catalogue they can already see.
        if (lib.stale) {
          again = setTimeout(async () => {
            const next = await api.getLibrary().catch(() => null);
            if (alive && next) {
              setAll(next.titles);
              setPartial(next.partial);
            }
          }, 20000);
        }
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
  // The grid shows what the subscription covers, and the search reaches the rest.
  // Not a tidying-up: every tile is a DOM node and an <img>, and the full
  // catalogue is 2530 of them - measured at 7650 nodes and 3.2 s to first paint on
  // a desktop, which a Pi 5 has no headroom for. It is also the honest cut, since
  // these are the games that can be started right now; the other 1900-odd would
  // have to be bought, and nobody finds one of those by holding Down.
  const owned = useMemo(() => playable.filter((x) => x.owned), [playable]);

  // Searched locally over the cache the plugin already handed us - the route
  // exists too, but a round trip per keystroke on a D-pad keyboard is a lot of
  // requests for an answer we are holding.
  const results = useMemo(() => {
    const q = normalize(query);
    if (!q) return null;
    return playable.filter((x) => normalize(x.name).includes(q));
  }, [playable, query]);

  const firstGridKey = results ? "g-search-0" : "g-all-0";
  const firstKey = recent.length && !results ? "t-recent-0" : firstGridKey;
  const hidden = playable.length - owned.length;

  useEffect(() => {
    if (!all || typing) return;
    // useFocusable registers during its own effect, so a setFocus in a sibling
    // effect of the same commit can run first and find nothing there.
    const id = setTimeout(() => setFocus(firstKey), 0);
    return () => clearTimeout(id);
  }, [all, firstKey, typing]);

  const onSearchDone = useCallback((value: string) => {
    setQuery(value.trim());
    setTyping(false);
  }, []);

  if (error) return <Splash>{error}</Splash>;
  if (!all) return <Splash>{t("library.loading")}</Splash>;
  if (!playable.length) return <Splash>{t("library.empty")}</Splash>;

  if (typing) {
    return (
      <div className="flex min-h-screen w-screen items-center justify-center bg-bg-0 p-[4vw]">
        <Osk title={t("library.search")} initial={query} onDone={onSearchDone} onCancel={() => setTyping(false)} />
      </div>
    );
  }

  return (
    <div className="min-h-screen w-screen bg-bg-0 px-[4vw] py-[3vh] text-fg">
      <header className="mb-[3vh] flex items-center justify-between gap-6">
        <h1 className="text-4xl font-semibold">{t("title")}</h1>
        <div className="flex items-center gap-4">
          {partial && <span className="text-lg text-warn">{t("library.partial")}</span>}
          {status?.gamertag && (
            <span className="text-lg text-fg-dim">{t("library.signedInAs", { gamertag: status.gamertag })}</span>
          )}
          <FocusButton
            focusKey="lib-search"
            className="rounded-lg bg-bg-1 px-6 py-3 text-xl"
            onEnter={() => setTyping(true)}
          >
            {query ? "🔍 " + query : "🔍 " + t("library.search")}
          </FocusButton>
          {query && (
            <FocusButton
              focusKey="lib-clear"
              className="rounded-lg bg-bg-1 px-5 py-3 text-xl"
              onEnter={() => setQuery("")}
            >
              ✕
            </FocusButton>
          )}
          <FocusButton
            focusKey="lib-signout"
            className="rounded-lg bg-bg-1 px-5 py-3 text-xl"
            onEnter={() => void api.signOut().then(onSignedOut)}
          >
            {t("library.signOut")}
          </FocusButton>
          <FocusButton focusKey="lib-exit" className="rounded-lg bg-bg-1 px-5 py-3 text-xl" onEnter={onExit}>
            {t("stream.stop")}
          </FocusButton>
        </div>
      </header>

      {results ? (
        results.length ? (
          <section>
            <h2 className="mb-[1.5vh] text-2xl text-fg-dim">
              {t("library.search")} — {results.length}
            </h2>
            <Grid titles={results} idPrefix="g-search" onPlay={onPlay} />
          </section>
        ) : (
          <p className="mt-[10vh] text-center text-3xl text-fg-dim">{t("library.noResults", { query })}</p>
        )
      ) : (
        <>
          {recent.length > 0 && (
            <section className="mb-[4vh]">
              <h2 className="mb-[1.5vh] text-2xl text-fg-dim">{t("library.recent")}</h2>
              {/* The one thing a row is good for: a short list you were in the
                  middle of. It scrolls inside itself; the page never scrolls
                  sideways. */}
              <div className="flex gap-[1.5vw] overflow-x-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {recent.map((title, i) => (
                  <Tile key={title.titleId} title={title} focusKey={`t-recent-${i}`} onEnter={() => onPlay(title)} />
                ))}
              </div>
            </section>
          )}
          <section>
            <h2 className="mb-[1.5vh] flex items-baseline gap-4 text-2xl text-fg-dim">
              <span>
                {t("library.owned")} — {owned.length}
              </span>
              {/* Say what is NOT on screen, rather than letting the grid look like
                  the whole catalogue. */}
              {hidden > 0 && <span className="text-lg">{t("library.searchRest", { count: hidden })}</span>}
            </h2>
            <Grid titles={owned} idPrefix="g-all" onPlay={onPlay} />
          </section>
        </>
      )}
    </div>
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

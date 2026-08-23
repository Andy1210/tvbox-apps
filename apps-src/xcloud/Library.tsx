import { useEffect, useMemo, useState } from "react";
import { FocusButton, useI18n } from "@sdk";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";
import { Tile } from "./Tile";
import { Splash } from "./XCloud";

// The library. Two rows for now - what is in progress, and everything playable -
// which is the shape the ten-foot pass will build on rather than replace.
//
// The whole catalogue is held rather than paged in as the grid scrolls, and the
// reason is the search: 2531 titles is unusable without one, and a search cannot
// look at rows that were never fetched. The metadata for all of them is 1.45 MB;
// the art is what stays lazy, and the browser does that for us.
const ROW_LIMIT = 40;

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

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const lib = await api.getLibrary();
        if (!alive) return;
        setAll(lib.titles);
        setPartial(lib.partial);
        // A stale answer means the plugin is refreshing behind it, so the rows on
        // screen are usable now and better in a moment - re-read once rather than
        // making the person wait for a catalogue they can already see.
        if (lib.stale) {
          setTimeout(async () => {
            const again = await api.getLibrary().catch(() => null);
            if (alive && again) {
              setAll(again.titles);
              setPartial(again.partial);
            }
          }, 20000);
        }
      } catch (e) {
        if (alive) setError(t("errors." + ((e as api.ApiError).code || "generic")) || t("errors.generic"));
      }
      // The continue row is asked for separately because it is the one thing that
      // changes between two launches, so it is never served from the cache.
      const r = await api.getRecent().catch(() => null);
      if (alive && r) setRecent(r.titles.filter((x) => x.name));
    })();
    return () => {
      alive = false;
    };
  }, [t]);

  const playable = useMemo(() => (all || []).filter((x) => x.name), [all]);
  const owned = useMemo(() => playable.filter((x) => x.owned).slice(0, ROW_LIMIT), [playable]);
  const rest = useMemo(() => playable.slice(0, ROW_LIMIT), [playable]);

  const firstKey = recent.length ? "t-recent-0" : owned.length ? "t-owned-0" : "t-all-0";
  useEffect(() => {
    if (!all) return;
    // useFocusable registers during its own effect, so a setFocus in a sibling
    // effect of the same commit can run first and find nothing there.
    const id = setTimeout(() => setFocus(firstKey), 0);
    return () => clearTimeout(id);
  }, [all, firstKey]);

  if (error) return <Splash>{error}</Splash>;
  if (!all) return <Splash>{t("library.loading")}</Splash>;
  if (!playable.length) return <Splash>{t("library.empty")}</Splash>;

  return (
    <div className="min-h-screen w-screen bg-bg-0 px-[4vw] py-[3vh] text-fg">
      <header className="mb-[3vh] flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold">{t("title")}</h1>
        <div className="flex items-center gap-6">
          {partial && <span className="text-lg text-warn">{t("library.partial")}</span>}
          <span className="text-lg text-fg-dim">
            {status?.gamertag ? t("library.signedInAs", { gamertag: status.gamertag }) : ""}
          </span>
          <FocusButton
            focusKey="lib-signout"
            className="rounded-lg bg-bg-1 px-5 py-2 text-lg"
            onEnter={() => void api.signOut().then(onSignedOut)}
          >
            {t("library.signOut")}
          </FocusButton>
          <FocusButton focusKey="lib-exit" className="rounded-lg bg-bg-1 px-5 py-2 text-lg" onEnter={onExit}>
            {t("stream.stop")}
          </FocusButton>
        </div>
      </header>

      {recent.length > 0 && <Row id="recent" label={t("library.recent")} titles={recent} onPlay={onPlay} />}
      {owned.length > 0 && <Row id="owned" label={t("library.owned")} titles={owned} onPlay={onPlay} />}
      <Row id="all" label={t("library.all")} titles={rest} onPlay={onPlay} />
    </div>
  );
}

function Row({
  id,
  label,
  titles,
  onPlay,
}: {
  id: string;
  label: string;
  titles: api.Title[];
  onPlay: (t: api.Title) => void;
}) {
  return (
    <section className="mb-[4vh]">
      <h2 className="mb-[1.5vh] text-2xl text-fg-dim">{label}</h2>
      {/* The row scrolls inside itself; the page never scrolls sideways. */}
      <div className="flex gap-[1.5vw] overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {titles.map((title, i) => (
          <Tile key={title.titleId} title={title} focusKey={`t-${id}-${i}`} onEnter={() => onPlay(title)} />
        ))}
      </div>
    </section>
  );
}

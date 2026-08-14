import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, Osk, useI18n } from "@sdk";
import { Row } from "./Row";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { useInitialFocus } from "./focus";
import { classify, useApp } from "./state";
import type { MediaItem } from "./backends/types";
import { log } from "./redact";

/**
 * Finding something by name.
 *
 * The A-Z strip is fine for browsing and useless for "the one with the boat in
 * it", so a library of thousands needs this. Typing goes through the box's own
 * keyboard, which the shell also lets a phone drive - nobody should have to
 * spell a title with a D-pad while holding a phone.
 *
 * The keyboard is a separate step rather than a field on the page, because it is
 * a focus boundary: with it open nothing else on the screen can be reached, and
 * that is the right behaviour while someone is typing.
 *
 * Results are grouped by kind. A search for a name usually means one or the
 * other, and a single mixed rail makes you read all of it.
 */
export function Search(): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);

  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(true);
  const [results, setResults] = useState<MediaItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!backend) return;
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }

    const mine = ++generation.current;
    setSearching(true);
    backend
      .search(q)
      .then((r) => {
        if (mine !== generation.current) return;
        setResults(r);
        setSearching(false);
      })
      .catch((e) => {
        if (mine !== generation.current) return;
        log.warn("search failed", e);
        setSearching(false);
        fail(classify(e));
      });
  }, [backend, query, fail]);

  const { ref, focusKey } = useFocusable({ focusKey: "search", saveLastFocusedChild: true });
  // Only when the keyboard is closed: it owns focus while it is open.
  useInitialFocus("search-edit", !typing);

  if (typing) {
    return (
      <Osk
        title={t("search.title")}
        initial={query}
        onDone={(value) => {
          setQuery(value);
          setTyping(false);
        }}
        onCancel={() => setTyping(false)}
      />
    );
  }

  if (failure) return <Message failure={failure} onRetry={() => setQuery((q) => `${q}`)} />;

  const poster = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());
  const open = (item: MediaItem): void => go({ name: "item", itemId: item.id });

  const films = (results ?? []).filter((r) => r.kind === "movie");
  const series = (results ?? []).filter((r) => r.kind === "show");
  const episodes = (results ?? []).filter((r) => r.kind === "episode");
  const nothing = results !== null && results.length === 0 && !searching;

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="flex h-full flex-col gap-[2vh] overflow-y-auto py-[3vh] scroll-pt-[16vh] scroll-pb-[12vh]"
      >
        <div className="flex items-center gap-[1.4vw] px-[4vw]">
          <FocusButton
            focusKey="search-edit"
            onEnter={() => setTyping(true)}
            className="min-w-[36vw] rounded-[1vh] bg-white/10 px-[2vw] py-[1.4vh] text-left text-[2.2vh]"
          >
            {query || t("search.placeholder")}
          </FocusButton>
          {searching && <span className="text-[1.9vh] text-fg-dim">{t("common.loading")}</span>}
        </div>

        {nothing && <p className="px-[4vw] text-[2.1vh] text-fg-dim">{t("search.nothing", { query })}</p>}

        <Row id="s-films" title={t("person.films")} items={films} posterUrl={poster} onSelect={open} />
        <Row id="s-series" title={t("person.series")} items={series} posterUrl={poster} onSelect={open} />
        <Row id="s-episodes" title={t("search.episodes")} items={episodes} posterUrl={poster} onSelect={open} />
      </div>
    </FocusContext.Provider>
  );
}

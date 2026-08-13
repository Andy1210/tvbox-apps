import { useEffect, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "@sdk";
import { Row } from "./Row";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { useFocusFallback, useInitialFocus } from "./focus";
import { classify, useApp } from "./state";
import type { CreditSet, MediaItem } from "./backends/types";
import { log } from "./redact";

/**
 * Everything one person appears in, across every library.
 *
 * This is the screen a media server's own client cannot show. Its actor filter
 * runs inside a single library, so opening a name from a film lists their other
 * films and stops - the series they are in are one library over and never
 * appear. The same filter applied server-wide answers the question people
 * actually ask, because the person's id is the same number in every library.
 *
 * Films and series are separated rather than mixed. "What else is this person
 * in" usually has one of those two in mind, and a single rail sorted by nothing
 * in particular makes you read all of it to find out.
 */
export function Person({ personId, personName }: { personId: string; personName: string }): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const [reload, setReload] = useState(0);
  const [credits, setCredits] = useState<CreditSet | null>(null);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    setCredits(null);

    backend
      .personCredits({ id: personId, name: personName })
      .then((c) => live && setCredits(c))
      .catch((e) => {
        if (!live) return;
        log.warn("person credits failed", e);
        fail(classify(e));
      });

    return () => {
      live = false;
    };
  }, [backend, personId, personName, fail, reload]);

  const { ref, focusKey } = useFocusable({ focusKey: `person-${personId}`, saveLastFocusedChild: true });
  const firstCredit = credits?.items.find((c) => c.kind === "movie") ?? credits?.items[0];
  const firstCreditKey = firstCredit ? `${firstCredit.kind === "movie" ? "films" : "series"}-${firstCredit.id}` : undefined;
  useInitialFocus(firstCreditKey, Boolean(credits));
  // Focus is set once; without a fallback anything that unmounts the focused
  // tile afterwards leaves the D-pad dead with only Back working.
  useFocusFallback(firstCreditKey, (key) => key.startsWith("films-") || key.startsWith("series-"));

  if (failure) return <Message failure={failure} onRetry={() => setReload((n) => n + 1)} />;
  if (!credits) return <Message loading />;

  const poster = (item: MediaItem): string | undefined => backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());
  const open = (item: MediaItem): void => go({ name: "item", itemId: item.id });

  const films = credits.items.filter((c) => c.kind === "movie");
  const series = credits.items.filter((c) => c.kind === "show");

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="flex h-full flex-col gap-[2.4vh] overflow-y-auto py-[3vh]">
        <header className="flex flex-col gap-[0.6vh] px-[4vw]">
          <h1 className="text-[3.4vh] font-semibold tracking-tight">{personName}</h1>
          <p className="text-[1.8vh] text-fg-dim">
            {t("person.count", { films: String(films.length), series: String(series.length) })}
          </p>
        </header>

        {credits.items.length === 0 && <Message text={t("person.empty", { name: personName })} />}

        <Row id="films" title={t("person.films")} items={films} posterUrl={poster} onSelect={open} />
        <Row id="series" title={t("person.series")} items={series} posterUrl={poster} onSelect={open} />

        {credits.truncated && <p className="px-[4vw] text-[1.7vh] text-fg-dim">{t("person.partial")}</p>}
      </div>
    </FocusContext.Provider>
  );
}

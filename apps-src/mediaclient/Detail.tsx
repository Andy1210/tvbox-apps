import { useEffect, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { Row } from "./Row";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { CastRow } from "./CastRow";
import { Scores } from "./Scores";
import { Reviews } from "./Reviews";
import { TitleArt } from "./TitleArt";
import { useFocusFallback, useInitialFocus } from "./focus";
import { usePlayer } from "./playback/player";
import { classify, useApp } from "./state";
import type { ItemDetail, MediaItem } from "./backends/types";
import { log } from "./redact";

/** Hours and minutes, with the unit letters coming from the locale - "2h 14m"
 *  is not how a Hungarian television says it. */
function runtime(ms: number | undefined, t: (key: string, vars?: Record<string, string>) => string): string {
  if (!ms) return "";
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? t("detail.runtimeHm", { h: String(h), m: String(m) }) : t("detail.runtimeM", { m: String(m) });
}

/**
 * One film or series.
 *
 * The cast is the point of this screen as much as the synopsis is: it is the
 * only way into the person pages, and those are the thing a media server's own
 * client cannot do.
 */
export function Detail({ itemId }: { itemId: string }): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const playing = usePlayer((s) => s.current !== null);
  const [reload, setReload] = useState(0);
  const [version, setVersion] = useState(0);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [children, setChildren] = useState<MediaItem[]>([]);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    setDetail(null);
    setChildren([]);
    // A different item has different versions; carrying an index across would
    // play the wrong file, or none.
    setVersion(0);

    (async () => {
      try {
        const d = await backend.item(itemId);
        if (!live) return;
        setDetail(d);

        // A series or season has something under it; a film does not, and asking
        // costs a round trip that shows as a pause before the screen settles.
        if (d.kind === "show" || d.kind === "season") {
          const kids = await backend.children(itemId);
          if (live) setChildren(kids);
        }
      } catch (e) {
        if (!live) return;
        log.warn("detail failed", e);
        fail(classify(e));
      }
    })();

    return () => {
      live = false;
    };
  }, [backend, itemId, fail, reload]);

  const { ref, focusKey } = useFocusable({ focusKey: `detail-${itemId}`, saveLastFocusedChild: true });
  useInitialFocus("detail-play", Boolean(detail));
  // Returning from playback unmounts the player, which held focus - without a
  // fallback the detail page comes back with the D-pad dead.
  useFocusFallback("detail-play", (key) => key.startsWith("detail-") || key.startsWith("cast-") || key.startsWith("children-") || key.startsWith("extras-") || key.startsWith("review-"), !playing);

  if (failure) return <Message failure={failure} onRetry={() => setReload((n) => n + 1)} />;
  if (!detail) return <Message loading />;

  const poster = (item: MediaItem): string | undefined => backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());
  const resumable = (detail.viewOffsetMs ?? 0) > 0;

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="flex h-full flex-col gap-[2.4vh] overflow-y-auto py-[3vh] scroll-pt-[16vh] scroll-pb-[12vh]">
        <header className="flex flex-col gap-[1.2vh] px-[4vw]">
          <TitleArt title={detail.seriesTitle ?? detail.title} logo={detail.logo} />
          {detail.seriesTitle && <p className="text-[2vh] text-fg-dim">{detail.title}</p>}
          {detail.tagline && <p className="text-[1.9vh] text-fg-dim italic">{detail.tagline}</p>}

          <div className="flex flex-wrap items-center gap-[1.4vw] text-[1.7vh] text-fg-dim">
            {detail.year ? <span className="tabular-nums">{detail.year}</span> : null}
            {detail.durationMs ? <span className="tabular-nums">{runtime(detail.durationMs, t)}</span> : null}
            {detail.contentRating ? (
              <span className="rounded-[0.4vh] border border-white/40 px-[0.6vw] py-[0.1vh]">
                {detail.contentRating}
              </span>
            ) : null}
            {detail.studio ? <span>{detail.studio}</span> : null}
            {detail.genres?.slice(0, 3).map((g) => <span key={g}>{g}</span>)}
          </div>

          <Scores scores={detail.scores} />

          {detail.summary && <p className="max-w-[62vw] text-[2vh] leading-relaxed">{detail.summary}</p>}

          <div className="mt-[1vh] flex gap-[1.2vw]">
            <FocusButton
              focusKey="detail-play"
              onEnter={() => backend && void usePlayer.getState().play(backend, detail, { version })}
              className="rounded-[1vh] bg-white/15 px-[2.4vw] py-[1.4vh] text-[2.1vh]"
            >
              {/* Naming the version on the button answers "does this chip start
                  playback or configure it?" without anyone having to try. */}
              {`${resumable ? t("detail.resume") : t("detail.play")}${
                detail.versions.length > 1 ? ` · ${detail.versions[version]?.label ?? ""}` : ""
              }`}
            </FocusButton>
            {resumable && (
              <FocusButton
                focusKey="detail-restart"
                onEnter={() => backend && void usePlayer.getState().play(backend, detail, { resume: false, version })}
                className="rounded-[1vh] bg-white/10 px-[2vw] py-[1.4vh] text-[2.1vh]"
              >
                {t("detail.fromStart")}
              </FocusButton>
            )}
          </div>

          {/* Only when there is a choice to make. A library keeps the same film
              in two languages as often as in two resolutions, so this is picked
              before pressing play rather than found afterwards in a menu. */}
          {detail.versions.length > 1 && (
            <div className="mt-[0.6vh] flex flex-wrap items-center gap-[0.8vw]">
              <span className="text-[1.7vh] text-fg-dim">{t("tracks.version")}</span>
              {detail.versions.map((v) => (
                <FocusButton
                  key={v.index}
                  focusKey={`detail-version-${v.index}`}
                  onEnter={() => setVersion(v.index)}
                  // A ring, not a fill: a focused button turns white, so a white
                  // "selected" background is invisible on the very chip someone
                  // is standing on - the state would only be visible from a
                  // distance, which is the opposite of useful.
                  className={`rounded-[0.8vh] px-[1.4vw] py-[0.8vh] text-[1.8vh] ${
                    v.index === version ? "bg-white/15 ring-[0.3vh] ring-white" : "bg-white/8"
                  }`}
                >
                  {v.parts > 1 ? `${v.label} · ${t("tracks.part", { n: String(v.partIndex + 1), of: String(v.parts) })}` : v.label}
                </FocusButton>
              ))}
            </div>
          )}
        </header>

        {children.length > 0 && (
          <Row
            id={`children-${itemId}`}
            title={detail.kind === "show" ? t("detail.seasons") : t("detail.episodes")}
            items={children}
            posterUrl={poster}
            onSelect={(item) => go({ name: "item", itemId: item.id })}
            heightVh={22}
          />
        )}

        {detail.roles.length > 0 && (
          <CastRow
            roles={detail.roles}
            title={t("detail.cast")}
            onSelect={(role) => go({ name: "person", personId: role.id, personName: role.name })}
          />
        )}

        {detail.extras.length > 0 && (
          <Row
            id={`extras-${itemId}`}
            title={t("detail.extras")}
            items={detail.extras.map((e) => ({
              id: e.id,
              kind: "movie" as const,
              title: e.title,
              thumb: e.thumb,
              durationMs: e.durationMs,
            }))}
            posterUrl={poster}
            onSelect={(extra) =>
              // Trailers are ordinary items on the server, so they go through
              // the same player. A tile that highlights, accepts OK and does
              // nothing is worse than no tile.
              backend && void usePlayer.getState().play(backend, extra, { resume: false })
            }
            heightVh={16}
          />
        )}

        <Reviews reviews={detail.reviews} title={t("detail.reviews")} />
      </div>
    </FocusContext.Provider>
  );
}

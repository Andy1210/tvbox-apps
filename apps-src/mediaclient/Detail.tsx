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
import { useFocusFallback, useInitialFocus, useScrollToTopOnFirst } from "./focus";
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
  const [audio, setAudio] = useState<number | undefined>();
  const [subtitle, setSubtitle] = useState<number | "none" | undefined>();
  /**
   * The episode the cursor is on, with its own tracks.
   *
   * A season carries no tracks of its own and its episodes do not share them,
   * so the language choice has to follow the highlight rather than the screen.
   */
  const [focused, setFocused] = useState<ItemDetail | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [busy, setBusy] = useState(false);
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
        // A collection and a playlist are lists of films, and the metadata path
        // answers for a collection the same way it does for a series - a
        // playlist is the one that needs its own call.
        if (d.kind === "playlist") {
          const kids = await backend.playlistItems(itemId);
          if (live) setChildren(kids);
        } else if (d.kind === "show" || d.kind === "season" || d.kind === "collection") {
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
  // The focus container IS the scroller here, so one ref serves both.
  const toTop = useScrollToTopOnFirst(ref);

  const watched = (detail?.viewCount ?? 0) > 0;

  /**
   * Flip watched state, and show it straight away.
   *
   * The item is patched locally rather than refetched: the server answers the
   * scrobble before its own view state has settled, so reading it back returns
   * the OLD value often enough that the button appeared not to work. A refetch
   * on failure would be worse - it would replace a correct optimistic state
   * with a stale one.
   */
  const toggleWatched = async (): Promise<void> => {
    if (!backend || !detail || busy) return;
    setBusy(true);
    const next = !watched;
    setDetail({ ...detail, viewCount: next ? Math.max(1, detail.viewCount ?? 0) : 0 });
    try {
      await backend.setWatched(detail.id, next);
    } catch (e) {
      log.warn("could not change watched state", e);
      setDetail(detail); // put the button back where it was
    } finally {
      setBusy(false);
    }
  };
  useInitialFocus("detail-play", Boolean(detail));
  // Returning from playback unmounts the player, which held focus - without a
  // fallback the detail page comes back with the D-pad dead.
  useFocusFallback(
    "detail-play",
    (key) =>
      key.startsWith("detail-") ||
      key.startsWith("cast-") ||
      key.startsWith("children-") ||
      key.startsWith("extras-") ||
      key.startsWith("review-") ||
      key.startsWith("detail-aud-") ||
      key.startsWith("detail-sub-"),
    !playing,
  );

  if (failure) return <Message failure={failure} onRetry={() => setReload((n) => n + 1)} />;
  if (!detail) return <Message loading />;

  const poster = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());
  /** 16:9, to match the tile an extra is drawn in. */
  const wide = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 400 * artworkScale(), 225 * artworkScale());
  const resumable = (detail.viewOffsetMs ?? 0) > 0;
  /** A film's own tracks, or the highlighted episode's on a season. */
  const tracksFrom = (detail.kind === "season" ? focused : detail)?.versions[version];

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="flex h-full flex-col gap-[2.4vh] overflow-y-auto py-[3vh] scroll-pt-[16vh] scroll-pb-[12vh]"
      >
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
            {detail.genres?.slice(0, 3).map((g) => (
              <span key={g}>{g}</span>
            ))}
          </div>

          <Scores scores={detail.scores} />

          {detail.summary && <p className="max-w-[62vw] text-[2vh] leading-relaxed">{detail.summary}</p>}

          <div className="mt-[1vh] flex gap-[1.2vw]">
            <FocusButton
              focusKey="detail-play"
              // The first focusable on the page, so reaching it means going back
              // to the top - the title art and synopsis above it can be reached
              // no other way.
              onFocused={toTop}
              onEnter={() => backend && void usePlayer.getState().play(backend, detail, { version, audio, subtitle })}
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
                onEnter={() =>
                  backend &&
                  void usePlayer.getState().play(backend, detail, { resume: false, version, audio, subtitle })
                }
                className="rounded-[1vh] bg-white/10 px-[2vw] py-[1.4vh] text-[2.1vh]"
              >
                {t("detail.fromStart")}
              </FocusButton>
            )}
            {/* Marking by hand is what a shared server needs: a film watched
                somewhere else, or abandoned twenty minutes in and not worth
                resuming, has no other way to be put right - and the carry-on
                row is built from exactly this state. */}
            <FocusButton
              focusKey="detail-watched"
              onEnter={() => void toggleWatched()}
              className="rounded-[1vh] bg-white/10 px-[2vw] py-[1.4vh] text-[2.1vh]"
            >
              {t(watched ? "detail.markUnwatched" : "detail.markWatched")}
            </FocusButton>
          </div>

          {/* Language before playing, not after. A converted stream bakes its
              tracks in when it starts, so changing them mid-film costs a
              restart - and the version chips were already asking the same
              question one axis over. On a season these follow the highlighted
              episode, because a season has no tracks of its own and its
              episodes do not share them. */}
          {tracksFrom && (tracksFrom.audio.length > 1 || tracksFrom.subtitles.length > 0) && (
            <div className="mt-[0.6vh] flex flex-col gap-[0.8vh]">
              {tracksFrom.audio.length > 1 && (
                <div className="flex flex-wrap items-center gap-[0.8vw]">
                  <span className="w-[8vw] text-[1.7vh] text-fg-dim">{t("tracks.audio")}</span>
                  {tracksFrom.audio.map((a) => (
                    <Pick
                      key={a.id}
                      focusKey={`detail-aud-${a.ordinal}`}
                      active={audio === undefined ? Boolean(a.selected) : audio === a.ordinal}
                      label={a.label}
                      onEnter={() => setAudio(a.ordinal)}
                    />
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-[0.8vw]">
                <span className="w-[8vw] text-[1.7vh] text-fg-dim">{t("tracks.subtitles")}</span>
                <Pick
                  focusKey="detail-sub-off"
                  active={subtitle === "none"}
                  label={t("tracks.subtitlesOff")}
                  onEnter={() => setSubtitle("none")}
                />
                {tracksFrom.subtitles.map((sub) => (
                  <Pick
                    key={sub.id}
                    focusKey={`detail-sub-${sub.ordinal}`}
                    active={subtitle === undefined ? Boolean(sub.selected) : subtitle === sub.ordinal}
                    label={sub.label}
                    onEnter={() => setSubtitle(sub.ordinal)}
                  />
                ))}
              </div>
            </div>
          )}

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
                  // A check, not a ring and not a fill. A white ring is what
                  // focus looks like on every poster in this app, so a ringed
                  // chip reads as the focused one from across a room; and the
                  // fill is what focus looks like on every button, so it cannot
                  // mean "chosen" either. A mark inside the chip is the only
                  // thing left that survives the chip turning solid white.
                  className="rounded-[0.8vh] bg-white/8 px-[1.4vw] py-[0.8vh] text-[1.8vh]"
                >
                  <span className="inline-block w-[1.4vw] shrink-0 text-center">{v.index === version ? "✓" : ""}</span>
                  {v.parts > 1
                    ? `${v.label} · ${t("tracks.part", { n: String(v.partIndex + 1), of: String(v.parts) })}`
                    : v.label}
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
            // An episode's artwork is a frame from it, which is 16:9 - shown in
            // a poster-shaped tile it was letterboxed into a strip. A season's
            // artwork IS a poster, so only the episodes change shape.
            posterUrl={detail.kind === "season" ? wide : poster}
            aspect={detail.kind === "season" ? 16 / 9 : undefined}
            heightVh={detail.kind === "season" ? 15 : 22}
            onFocusItem={(item) => {
              if (item.kind !== "episode" || !backend) return;
              // Cached by the backend, so moving along a row of episodes is not
              // a request each.
              void backend
                .item(item.id)
                .then((d) => setFocused(d))
                .catch(() => setFocused(null));
            }}
            onSelect={(item) => {
              // An episode plays. There is nothing on a screen of its own worth
              // the press: what someone wants from a list of episodes is to
              // watch one, and everything else about it - cast, extras, the
              // audio and subtitle choice - is on this screen already.
              if (item.kind === "episode" && backend) {
                void usePlayer.getState().play(backend, item, { version, audio, subtitle });
                return;
              }
              go({ name: "item", itemId: item.id });
            }}
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
            // 16:9 and three caption lines: these are clips whose artwork is a
            // frame and whose names are sentences, so a poster-shaped tile cut
            // "Official Trailer 2" and "Behind the Scenes" to the same words.
            heightVh={16}
            aspect={16 / 9}
            captionLines={2}
            items={detail.extras.map((e) => ({
              id: e.id,
              kind: "movie" as const,
              title: e.title,
              thumb: e.thumb,
              durationMs: e.durationMs,
            }))}
            posterUrl={wide}
            onSelect={(extra) =>
              // Trailers are ordinary items on the server, so they go through
              // the same player. A tile that highlights, accepts OK and does
              // nothing is worse than no tile.
              backend && void usePlayer.getState().play(backend, extra, { resume: false })
            }
          />
        )}

        <Reviews reviews={detail.reviews} title={t("detail.reviews")} />
      </div>
    </FocusContext.Provider>
  );
}

/** A chip whose check says chosen and whose fill says focused. */
function Pick({
  focusKey,
  active,
  label,
  onEnter,
}: {
  focusKey: string;
  active: boolean;
  label: string;
  onEnter: () => void;
}): React.JSX.Element {
  return (
    <FocusButton
      focusKey={focusKey}
      onEnter={onEnter}
      className="rounded-[0.8vh] bg-white/8 px-[1.2vw] py-[0.8vh] text-[1.8vh]"
    >
      <span className="inline-block w-[1.2vw] shrink-0 text-center">{active ? "\u2713" : ""}</span>
      {label}
    </FocusButton>
  );
}

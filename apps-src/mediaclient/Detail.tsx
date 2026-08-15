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
import { LanguagePicker } from "./LanguagePicker";
import { Backdrop } from "./Backdrop";
import { useTheme } from "./theme";
import { useFocusFallback, useInitialFocus, useScrollToTopOnFirst } from "./focus";
import { usePlayer } from "./playback/player";
import { classify, useApp } from "./state";
import type { ItemDetail, MediaItem, MediaVersion } from "./backends/types";
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
export function Detail({ itemId, focusChildId }: { itemId: string; focusChildId?: string }): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const replace = useApp((s) => s.replace);
  const back = useApp((s) => s.back);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const playing = usePlayer((s) => s.current !== null);
  const [reload, setReload] = useState(0);
  const [version, setVersion] = useState(0);
  /**
   * The chosen tracks, kept as a LANGUAGE rather than an ordinal.
   *
   * An ordinal is a position in one item's own track list, and episodes of a
   * season do not agree on it: measured, choosing Hungarian on an episode whose
   * tracks read English, Magyar and then pressing the next one - whose read
   * Magyar, English - played English. And a converted stream bakes its tracks
   * in at start, so that costs a restart to undo.
   */
  const [audioLang, setAudioLang] = useState<string | undefined>();
  const [subLang, setSubLang] = useState<string | "none" | undefined>();
  /**
   * The episode the cursor is on, with its own tracks.
   *
   * A season carries no tracks of its own and its episodes do not share them,
   * so the language choice has to follow the highlight rather than the screen.
   */
  const [focused, setFocused] = useState<ItemDetail | null>(null);
  const [firstChild, setFirstChild] = useState<ItemDetail | null>(null);
  const [picking, setPicking] = useState(false);
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
        // An episode is shown on its season, with itself highlighted - the
        // description, the cast and the extras all belong to whichever episode
        // the cursor is on, so a screen per episode would be the same screen
        // with one row missing.
        if (d.kind === "episode" && d.parentId) {
          replace({ name: "item", itemId: d.parentId, focusChildId: d.id });
          return;
        }

        if (d.kind === "playlist") {
          const kids = await backend.playlistItems(itemId);
          if (live) setChildren(kids);
        } else if (d.kind === "show" || d.kind === "season" || d.kind === "collection") {
          const kids = await backend.children(itemId);
          // Its tracks stand in until something is highlighted.
          if (kids[0] && d.kind === "season") void backend.item(kids[0].id).then((k) => live && setFirstChild(k));
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
  // Arriving from a carry-on-watching tile opens on THAT episode rather than on
  // the play button, so the page is already describing what was pressed.
  // Whatever this screen actually has: the episode someone arrived pointing at,
  // the first child on a group, the play button on a film - and on a group with
  // nothing in it, the message's own way out, because none of the others exist.
  const first = focusChildId
    ? `children-${itemId}-${focusChildId}`
    : detail && !playableKind(detail)
      ? children[0]
        ? `children-${itemId}-${children[0].id}`
        : "detail-back"
      : "detail-play";
  useInitialFocus(first, Boolean(detail));
  // Returning from playback unmounts the player, which held focus - without a
  // fallback the detail page comes back with the D-pad dead.
  useFocusFallback(
    // The play button when there is one; otherwise the first child, which is
    // what a group screen has instead. A group with NEITHER - an empty
    // collection, and this server has one - left nothing focusable at all, so
    // every press was discarded and only Back worked.
    first,
    (key) =>
      key.startsWith("detail-") ||
      key.startsWith("cast-") ||
      key.startsWith("children-") ||
      key.startsWith("extras-") ||
      key.startsWith("review-"),
    // Not while the language panel is up. This is a window listener and stays
    // armed behind it; the panel's keys are none of the above, so every press
    // it could not resolve threw focus back onto the play button - which is
    // exactly "I cannot navigate in the subtitle list".
    !playing && !picking,
  );

  // Before the early returns, as hooks must be. `detail` is null while loading,
  // which is simply no theme yet.
  useTheme(detail?.kind === "season" || detail?.kind === "show" ? detail : null);

  if (failure) return <Message failure={failure} onRetry={() => setReload((n) => n + 1)} />;
  if (!detail) return <Message loading />;

  // A group with nothing in it. Without this the screen had no focusable at all
  // - Play is hidden on a group and there is no first child to fall back to -
  // so every press was discarded and only Back did anything.
  if (!playableKind(detail) && children.length === 0)
    return (
      <Message
        text={t(detail.kind === "playlist" ? "detail.emptyPlaylist" : "detail.emptyCollection")}
        actions={[{ key: "detail-back", label: t("common.back"), onEnter: () => back() }]}
      />
    );

  const poster = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 300 * artworkScale(), 450 * artworkScale());
  /** 16:9, to match the tile an extra is drawn in. */
  const wide = (item: MediaItem): string | undefined =>
    backend?.posterUrl(item, 400 * artworkScale(), 225 * artworkScale());
  const resumable = (detail.viewOffsetMs ?? 0) > 0;
  /** A group is a list of things to play, not a thing to play. */
  const playable = detail.kind !== "collection" && detail.kind !== "playlist";
  /**
   * What the page is describing.
   *
   * On a season that is the episode the cursor is on, not the season: its
   * synopsis, its cast, its extras, its scores. A season's own metadata is a
   * repeat of the series, and a screen per episode would be this screen with
   * one row missing - so the rows reload as the highlight moves, which is what
   * makes the episode list a place you can read from rather than a menu.
   */
  const shown = (detail.kind === "season" && focused) || detail;
  // On a season, the highlighted episode's tracks - or the FIRST episode's
  // before anything is highlighted, so the button exists on arrival rather than
  // materialising only after someone has been down into the list and back.
  const tracksFrom = shown.versions[version] ?? firstChild?.versions[version];

  /** The chosen language, resolved against whatever is about to play. */
  const pick = (v: MediaVersion | undefined): { audio?: number; subtitle?: number | "none" } => ({
    audio: audioLang ? v?.audio.find((a) => a.language === audioLang)?.ordinal : undefined,
    subtitle:
      subLang === "none" ? "none" : subLang ? v?.subtitles.find((x) => x.language === subLang)?.ordinal : undefined,
  });

  return (
    <FocusContext.Provider value={focusKey}>
      <Backdrop item={shown} />
      {picking && (
        <LanguagePicker
          version={tracksFrom}
          audio={pick(tracksFrom).audio}
          subtitle={pick(tracksFrom).subtitle}
          onAudio={(ordinal) => setAudioLang(tracksFrom?.audio.find((a) => a.ordinal === ordinal)?.language)}
          onSubtitle={(ordinal) =>
            setSubLang(ordinal === "none" ? "none" : tracksFrom?.subtitles.find((x) => x.ordinal === ordinal)?.language)
          }
          onClose={() => setPicking(false)}
        />
      )}
      <div
        ref={ref}
        className="relative z-10 flex h-full flex-col gap-[2.4vh] overflow-y-auto py-[3vh] scroll-pt-[16vh] scroll-pb-[12vh]"
      >
        <header className="flex flex-col gap-[1.2vh] px-[4vw]">
          <TitleArt title={shown.seriesTitle ?? shown.title} logo={shown.logo} />
          {/* The episode's own name under the series art, so the page names what
              it is describing rather than only what it belongs to. */}
          {shown !== detail || shown.seriesTitle ? <p className="text-[2vh] text-fg-dim">{shown.title}</p> : null}
          {shown.tagline && <p className="text-[1.9vh] text-fg-dim italic">{shown.tagline}</p>}

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

          <Scores scores={shown.scores} />

          {shown.summary && <p className="max-w-[62vw] text-[2vh] leading-relaxed">{shown.summary}</p>}

          {/* Not on a collection or a playlist: measured, resolveStream answers
              400 for both, so the button accepted OK and did nothing - and it
              was the initial focus on 461 collection screens. Their first
              child is what plays, and it is one row down. */}
          <div className="mt-[1vh] flex gap-[1.2vw]">
            {playable && (
              <FocusButton
                focusKey="detail-play"
                // The first focusable on the page, so reaching it means going back
                // to the top - the title art and synopsis above it can be reached
                // no other way.
                onFocused={toTop}
                onEnter={() =>
                  backend && void usePlayer.getState().play(backend, detail, { version, ...pick(tracksFrom) })
                }
                className="rounded-[1vh] bg-white/15 px-[2.4vw] py-[1.4vh] text-[2.1vh]"
              >
                {/* Naming the version on the button answers "does this chip start
                  playback or configure it?" without anyone having to try. */}
                {`${resumable ? t("detail.resume") : t("detail.play")}${
                  detail.versions.length > 1 ? ` · ${detail.versions[version]?.label ?? ""}` : ""
                }`}
              </FocusButton>
            )}
            {playable && resumable && (
              <FocusButton
                focusKey="detail-restart"
                onEnter={() =>
                  backend &&
                  void usePlayer.getState().play(backend, detail, { resume: false, version, ...pick(tracksFrom) })
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
            {playable && (
              <FocusButton
                focusKey="detail-watched"
                onEnter={() => void toggleWatched()}
                className="rounded-[1vh] bg-white/10 px-[2vw] py-[1.4vh] text-[2.1vh]"
              >
                {t(watched ? "detail.markUnwatched" : "detail.markWatched")}
              </FocusButton>
            )}
          </div>

          {/* One button, not a wall. A film with fifteen embedded subtitles
              filled the screen with them above the synopsis and the cast, for a
              choice most people make once, if at all. */}
          {tracksFrom && (tracksFrom.audio.length > 1 || tracksFrom.subtitles.length > 0) && (
            <FocusButton
              focusKey="detail-lang"
              onEnter={() => setPicking(true)}
              className="mt-[0.6vh] self-start rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
            >
              {`${t("tracks.title")} \u203a`}
            </FocusButton>
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
            title={
              detail.kind === "show"
                ? t("detail.seasons")
                : detail.kind === "season"
                  ? t("detail.episodes")
                  : t("detail.inThis")
            }
            items={children}
            // An episode's artwork is a frame from it, which is 16:9 - shown in
            // a poster-shaped tile it was letterboxed into a strip. A season's
            // artwork IS a poster, so only the episodes change shape.
            posterUrl={detail.kind === "season" ? wide : poster}
            aspect={detail.kind === "season" ? 16 / 9 : undefined}
            heightVh={detail.kind === "season" ? 15 : 22}
            onFocusItem={(item) => {
              if (item.kind !== "episode" || !backend) return;
              // Already showing it: moving back onto the same tile must not
              // start another request or another render.
              if (focused?.id === item.id) return;
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
                // Resolved against the episode being started, not the one the
                // cursor was on when the language was chosen.
                void backend
                  .item(item.id)
                  .then((d) => usePlayer.getState().play(backend, item, { version, ...pick(d.versions[version]) }));
                return;
              }
              go({ name: "item", itemId: item.id });
            }}
          />
        )}

        {shown.roles.length > 0 && (
          <CastRow
            roles={shown.roles}
            title={t("detail.cast")}
            onSelect={(role) => go({ name: "person", personId: role.id, personName: role.name })}
          />
        )}

        {shown.extras.length > 0 && (
          <Row
            id={`extras-${itemId}`}
            title={t("detail.extras")}
            // 16:9 and three caption lines: these are clips whose artwork is a
            // frame and whose names are sentences, so a poster-shaped tile cut
            // "Official Trailer 2" and "Behind the Scenes" to the same words.
            heightVh={16}
            aspect={16 / 9}
            captionLines={2}
            items={shown.extras.map((e) => ({
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

        <Reviews reviews={shown.reviews} title={t("detail.reviews")} />
      </div>
    </FocusContext.Provider>
  );
}

/** Whether an item is a thing to play rather than a list of them. */
function playableKind(d: ItemDetail): boolean {
  return d.kind !== "collection" && d.kind !== "playlist";
}

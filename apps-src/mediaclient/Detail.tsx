import { useEffect, useRef, useState } from "react";
import { FocusContext, doesFocusableExist, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { Row } from "./Row";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { CastRow } from "./CastRow";
import { Scores } from "./Scores";
import { Reviews } from "./Reviews";
import { TitleArt } from "./TitleArt";
import { Summary } from "./Summary";
import { LanguagePicker } from "./LanguagePicker";
import { Backdrop } from "./Backdrop";
import { useTheme } from "./theme";
import { useFocusFallback, useInitialFocus, useScrollToTopOnFirst } from "./focus";
import { usePlayer, useShowingPlayer } from "./playback/player";
import { rememberedVersion, useChosenVersion } from "./chosenVersion";
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
export function Detail({
  itemId,
  focusChildId,
  queueFrom,
}: {
  itemId: string;
  focusChildId?: string;
  queueFrom?: MediaItem[];
}): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const replace = useApp((s) => s.replace);
  const back = useApp((s) => s.back);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const playing = useShowingPlayer();
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
  /** The chosen subtitle when it has no language to be remembered by. */
  const [subId, setSubId] = useState<string | undefined>();
  /**
   * The episode the cursor is on, with its own tracks.
   *
   * A season carries no tracks of its own and its episodes do not share them,
   * so the language choice has to follow the highlight rather than the screen.
   */
  const [focused, setFocused] = useState<ItemDetail | null>(null);
  const [firstChild, setFirstChild] = useState<ItemDetail | null>(null);
  const upNext = usePlayer((s) => s.upNext);
  const moving = usePlayer((s) => s.moving);
  // Only to re-render while a countdown is running; the value is the clock.
  const [, setTick] = useState(0);
  const [picking, setPicking] = useState(false);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [children, setChildren] = useState<MediaItem[]>([]);
  /**
   * Whether the screen knows what it holds.
   *
   * Which key the one-shot initial focus aims at depends on the children - a
   * show has no Play button and must open on a season - and they arrive a round
   * trip after the item does. Firing on `detail` alone aimed at a button that
   * did not exist yet.
   */
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    setDetail(null);
    setChildren([]);
    setSettled(false);
    // A different item has different versions; carrying an index across would
    // play the wrong file, or none. Seeded from what was chosen for the NEW
    // item a moment later, once its version list is known.
    setVersion(0);
    // Everything else this screen holds for ONE item, cleared with the rest.
    //
    // Defensive rather than a fix for something reachable today: `MediaClient`
    // renders this with `key={screen.itemId}`, so opening another item remounts
    // it and nothing can carry over. What this effect really serves is the paths
    // that re-run it on a LIVE mount - "try again" after a failure, and a
    // backend replaced under it - plus the day somebody drops that key.
    //
    // `subId` is the one with teeth if that day comes: a track id is only
    // meaningful within its own item, and on Jellyfin it is the stream's index -
    // so "2" on the next film is a different subtitle, baked into a converted
    // stream at start.
    setFocused(null);
    setFirstChild(null);
    setAudioLang(undefined);
    setSubLang(undefined);
    setSubId(undefined);
    setPicking(false);

    (async () => {
      try {
        const d = await backend.item(itemId);
        if (!live) return;
        setDetail(d);
        // Held to what this item actually has: a library can lose the file the
        // choice pointed at, and an index with no version behind it resolves to
        // no part - which fails when play is pressed rather than here.
        setVersion(rememberedVersion(d.id, d.versions.length));

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
        if (live) setSettled(true);
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

  /**
   * What this screen last started, so coming back from playback lands on it.
   *
   * The browse tree is HIDDEN while a film plays rather than unmounted, so the
   * focus fallback below still aims at the key this screen was built with - the
   * episode somebody arrived pointing at. Three episodes later that is not where
   * the cursor belongs, and it is where it went.
   *
   * Held against the children rather than trusted: the player also carries a
   * film's own id, and a fallback aimed at a key nothing mounted leaves the
   * remote dead.
   */
  const playingId = usePlayer((s) => s.current?.item.id);
  const [lastPlayedId, setLastPlayedId] = useState<string | undefined>();
  useEffect(() => {
    if (playingId) setLastPlayedId(playingId);
  }, [playingId]);
  const lastPlayedChild = lastPlayedId && children.some((c) => c.id === lastPlayedId) ? lastPlayedId : undefined;

  /**
   * What the server knows AFTER playback, rather than what it knew before it.
   *
   * Same cause as the focus above: this screen keeps the children it was built
   * with for as long as it is up, so an episode that has just been watched still
   * carries the view count it had - no tick, on any of them, until the screen is
   * left and opened again. Refetched in place rather than through `reload`,
   * which clears the screen to a spinner and takes the focus fallback with it.
   *
   * `children` is not cached by either backend, so this really does ask the
   * server; the item itself is, briefly, which is the same answer re-entering
   * the screen would get.
   */
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (playing) {
      wasPlaying.current = true;
      return;
    }
    if (!wasPlaying.current) return;
    wasPlaying.current = false;
    if (!backend || !detail) return;
    const kind = detail.kind;
    let live = true;
    void (async () => {
      try {
        const [d, kids] = await Promise.all([
          backend.item(itemId),
          kind === "playlist"
            ? backend.playlistItems(itemId)
            : kind === "show" || kind === "season" || kind === "collection"
              ? backend.children(itemId)
              : Promise.resolve(null),
        ]);
        if (!live) return;
        setDetail(d);
        if (kids) setChildren(kids);
      } catch (e) {
        // Nothing is said about it: the screen it would replace is a correct one
        // that is merely a few minutes old, and a failure screen over it would be
        // worse than a missing tick.
        log.warn("could not refresh after playback", e);
      }
    })();
    return () => {
      live = false;
    };
    // `detail` is read for its kind only, and re-running this when it changes
    // would refetch on the answer it just set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, backend, itemId]);

  // Not a place the arrows may land while the failure screen is up.
  // `useFocusable` registers on the hook call, which is above the early return
  // that swaps this screen for the error - so the container stayed registered
  // with no node and a zero-sized box at the page origin, and one arrow press
  // from "Try again" landed on it. It answers no OK, so the remote was dead
  // with the button still highlighted.
  const { ref, focusKey } = useFocusable({
    focusKey: `detail-${itemId}`,
    saveLastFocusedChild: true,
    focusable: !failure,
  });
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
  // Aimed at the Play button only where one is RENDERED, and by the same test
  // the render uses. They were two different tests, and a show passed one and
  // failed the other: `playableKind` says a show is a thing to play, the button
  // asks `toPlayable` as well and gets nothing. norigin returns a key it does
  // not know unchanged, so focus parked on a component that did not exist and
  // every press was discarded with nothing to report it - on all 256 series.
  const first = upNext
    ? `children-${itemId}-${upNext.item.id}`
    : lastPlayedChild
      ? `children-${itemId}-${lastPlayedChild}`
      : focusChildId
        ? `children-${itemId}-${focusChildId}`
        : detail && hasPlayButton(detail, children)
          ? "detail-play"
          : children[0]
            ? `children-${itemId}-${children[0].id}`
            : "detail-back";
  useInitialFocus(first, settled);

  // A countdown arrives on a screen that never unmounted - the browse tree is
  // hidden during playback, not thrown away - so the one-shot initial focus has
  // long since fired. The episode about to start is pointed at explicitly.
  useEffect(() => {
    if (!upNext) return;
    const key = `children-${itemId}-${upNext.item.id}`;
    if (!doesFocusableExist(key)) return;
    const id = setTimeout(() => setFocus(key), 0);
    return () => clearTimeout(id);
  }, [upNext, itemId]);
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
      key.startsWith("review-") ||
      // The failure screen's own button. It replaces this whole screen, so its
      // key is the only one on it - and a predicate that did not recognise it
      // pulled focus onto a key the failure screen never renders, on the FIRST
      // arrow press. "Something went wrong / Try again", highlighted, and the
      // remote does nothing but Back.
      key.startsWith("msg-"),
    // Not while the language panel is up. This is a window listener and stays
    // armed behind it; the panel's keys are none of the above, so every press
    // it could not resolve threw focus back onto the play button - which is
    // exactly "I cannot navigate in the subtitle list".
    !playing && !picking,
  );

  /**
   * The countdown on the next episode, and the press that stops it.
   *
   * Any key cancels - not only the one that starts it - because a countdown
   * somebody cannot stop is a countdown they fight. The listener is capture
   * phase so it sees the press before anything else acts on it, and the
   * re-render each second is what draws the number down.
   */
  // Back is the key someone reaches for to escape a countdown, and it was the
  // one key that did not cancel it: the SDK installs a single capture-phase
  // listener at app start and calls stopImmediatePropagation, so a listener
  // added later on the same target never runs. Registered through the SDK's own
  // stack instead, which is the only thing that sees Back.
  useBackspace(() => usePlayer.getState().cancelUpNext(), Boolean(upNext));

  useEffect(() => {
    if (!upNext) return;
    const cancel = (): void => usePlayer.getState().cancelUpNext();
    window.addEventListener("keydown", cancel, true);
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => {
      window.removeEventListener("keydown", cancel, true);
      clearInterval(id);
    };
  }, [upNext]);

  // Leaving this screen takes the countdown with it. The timer is module state
  // in the player, so navigating away - or the screen being replaced - left it
  // armed with nothing on screen to say so and nothing able to cancel it.
  useEffect(() => () => usePlayer.getState().cancelUpNext(), []);

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
  // A group is a list of things to play, not a thing to play - and a show is a
  // list of seasons, which are lists too. An empty season has nothing to start
  // either, and a button that accepts OK and does nothing is worse than none.
  const playable = hasPlayButton(detail, children);
  /**
   * The running order Play hands over.
   *
   * A list screen's own children ARE the order; a film has none, so it uses the
   * list it was opened from. `children` first, because a season opened from a
   * collection is a list in its own right and its episodes are the order there.
   */
  const order = children.length ? children : (queueFrom ?? []);
  /**
   * What the one row on this screen holds.
   *
   * Usually the children. On a FILM there are none - and a film opened from a
   * playlist now has a next, so the countdown to it had nowhere to be drawn:
   * the film ended, five seconds passed with nothing on screen, and the next
   * one started unannounced. It also left the fallback focus key pointing at a
   * tile that was never mounted, so the first press during that window was
   * swallowed. The row is what gives the countdown both a place and a key.
   *
   * `moving` for the same reason one step further on: a spoken "next episode"
   * during the countdown cancels it and starts a step, and on a film opened from
   * a playlist that emptied the only row on the page - the person watched it
   * vanish while nothing started. Scoped to THIS page, because the store is
   * global and any childless detail page would otherwise draw a row holding an
   * episode of another series.
   */
  const rowItems = children.length
    ? children
    : upNext
      ? [upNext.item]
      : moving && moving.parentId === itemId
        ? [moving]
        : [];
  /**
   * What Play starts.
   *
   * A season is not a thing the server can resolve a stream for either - it
   * answers the same 400 a collection does - so Play there means the first
   * episode nobody has finished, which is what someone pressing it wants. On a
   * film it is the film.
   */
  /**
   * What Play starts.
   *
   * Neither a show nor a season is something the server can resolve a stream
   * for - both answer 400 - so Play means an EPISODE. On a season that is the
   * one in progress if there is one, because skipping past a half-watched
   * episode is not what pressing play means; otherwise the first unwatched. On
   * a show the children are seasons, so there is nothing here to start: the
   * button is left off, as it is on a collection.
   */
  const toPlay =
    detail.kind === "season"
      ? (children.find((c) => (c.viewOffsetMs ?? 0) > 0) ?? children.find((c) => !(c.viewCount ?? 0)) ?? children[0])
      : detail.kind === "show"
        ? undefined
        : detail;
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

  /**
   * The chosen tracks, resolved against whatever is about to play.
   *
   * By language where there is one, because that is what carries across
   * episodes - and by the track's own id where there is not. Measured on this
   * server, 426 of 493 sidecar subtitles carry no language at all, so keying
   * only on language dropped the choice on the floor: the picker closed, the
   * tick never moved, and Play started with no subtitle. An id only matches
   * within the same item, which is the film case and is the honest limit -
   * a track with no language has nothing to match on in the next episode.
   */
  const pick = (v: MediaVersion | undefined): { audio?: number; subtitle?: number | "none" } => ({
    audio: audioLang ? v?.audio.find((a) => a.language === audioLang)?.ordinal : undefined,
    subtitle:
      subLang === "none"
        ? "none"
        : subLang
          ? v?.subtitles.find((x) => x.language === subLang)?.ordinal
          : subId
            ? v?.subtitles.find((x) => x.id === subId)?.ordinal
            : undefined,
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
          onSubtitle={(ordinal) => {
            const track = ordinal === "none" ? undefined : tracksFrom?.subtitles.find((x) => x.ordinal === ordinal);
            setSubLang(ordinal === "none" ? "none" : track?.language);
            setSubId(track?.language ? undefined : track?.id);
          }}
          onClose={() => setPicking(false)}
        />
      )}
      <div
        ref={ref}
        className="relative z-10 flex h-full flex-col gap-[2.4vh] overflow-y-auto py-[3vh] scroll-pt-[16vh] scroll-pb-[12vh]"
      >
        <header className="flex flex-col gap-[1.2vh] px-[4vw]">
          <TitleArt title={shown.grandparentTitle ?? shown.title} logo={shown.logo} />
          {/* The episode's own name under the series art, so the page names what
              it is describing rather than only what it belongs to. */}
          {shown !== detail || shown.grandparentTitle ? <p className="text-[2vh] text-fg-dim">{shown.title}</p> : null}
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

          {/* Rendered even with no text, and that is the point rather than an
              oversight: a fixed height stops "two lines then six", but an
              episode with NO synopsis removed the box entirely and moved
              everything under it by ~11vh - which is the jump this was added to
              stop. Whole seasons here are like that: 14 of Nodame Cantabile's
              23 episodes carry no summary.

              Keyed on the item, so switching episodes builds a fresh one rather
              than carrying the previous synopsis's opened state onto it. */}
          <Summary key={shown.id} text={shown.summary ?? ""} />

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
                  backend &&
                  toPlay &&
                  void usePlayer.getState().play(backend, toPlay, { version, ...pick(tracksFrom), queue: order })
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
                  toPlay &&
                  void usePlayer
                    .getState()
                    .play(backend, toPlay, { resume: false, version, ...pick(tracksFrom), queue: order })
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
              {/* Keyed on the ARRAY POSITION, not on the version's own index -
                  they are different numbers whenever one media entry holds two
                  parts, and a film on two discs gave both chips the same focus
                  key, so the second could not be reached with a remote. */}
              {detail.versions.map((v, i) => (
                <FocusButton
                  key={i}
                  focusKey={`detail-version-${i}`}
                  onEnter={() => {
                    setVersion(i);
                    // Remembered against the item, so the next time this title
                    // is opened it is already on the file this household
                    // actually watches - the 1080p copy of a film is sometimes
                    // a 3D encode, and picking round it every time is the app
                    // asking a question it has already been answered.
                    useChosenVersion.getState().remember(detail.id, i);
                  }}
                  // A check, not a ring and not a fill. A white ring is what
                  // focus looks like on every poster in this app, so a ringed
                  // chip reads as the focused one from across a room; and the
                  // fill is what focus looks like on every button, so it cannot
                  // mean "chosen" either. A mark inside the chip is the only
                  // thing left that survives the chip turning solid white.
                  className="rounded-[0.8vh] bg-white/8 px-[1.4vw] py-[0.8vh] text-[1.8vh]"
                >
                  <span className="inline-block w-[1.4vw] shrink-0 text-center">{i === version ? "✓" : ""}</span>
                  {v.parts > 1
                    ? `${v.label} · ${t("tracks.part", { n: String(v.partIndex + 1), of: String(v.parts) })}`
                    : v.label}
                </FocusButton>
              ))}
            </div>
          )}
        </header>

        {rowItems.length > 0 && (
          <Row
            id={`children-${itemId}`}
            title={
              children.length === 0
                ? t("detail.upNext")
                : detail.kind === "show"
                  ? t("detail.seasons")
                  : detail.kind === "season"
                    ? t("detail.episodes")
                    : t("detail.inThis")
            }
            items={rowItems}
            // An episode's artwork is a frame from it, which is 16:9 - shown in
            // a poster-shaped tile it was letterboxed into a strip. A season's
            // artwork IS a poster, so only the episodes change shape.
            posterUrl={detail.kind === "season" ? wide : poster}
            aspect={detail.kind === "season" ? 16 / 9 : undefined}
            heightVh={detail.kind === "season" ? 15 : 22}
            // Up from the first row of a detail screen goes to the buttons,
            // decided here rather than by geometry: the row's own padding pulls
            // its box up over them, and spatial navigation drops a candidate
            // whose bottom is inside the focused element - so Up found nothing
            // and the cursor left the screen.
            onArrowFromFirst={(dir) => {
              if (dir !== "up") return true;
              // Whatever this screen actually has above the row. Aiming at a
              // button that is not rendered leaves the app with no origin and
              // swallows the press.
              for (const key of ["detail-play", "detail-lang", "detail-watched", "lib-arrange"]) {
                if (doesFocusableExist(key)) {
                  setFocus(key);
                  return false;
                }
              }
              return true;
            }}
            countdownFor={
              upNext
                ? { id: upNext.item.id, seconds: Math.max(0, Math.ceil((upNext.at - Date.now()) / 1000)) }
                : moving
                  ? { id: moving.id, seconds: "…" }
                  : null
            }
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
                void backend.item(item.id).then((d) =>
                  // The screen's own list is the running order: a playlist and
                  // a collection are one, and a season is one too. Without it
                  // an episode played from a playlist would be followed by the
                  // next episode of its SERIES, and a film by nothing at all.
                  usePlayer.getState().play(backend, item, { version, ...pick(d.versions[version]), queue: children }),
                );
                return;
              }
              // A film opens its own screen, and that screen has no children to
              // make a running order from - so the list it was opened from is
              // carried over. Only from a list of things to play: a season's
              // episodes never take this route, and a show is not an order.
              go({
                name: "item",
                itemId: item.id,
                queueFrom: detail.kind === "playlist" || detail.kind === "collection" ? children : undefined,
              });
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

/**
 * Whether this screen renders a Play button.
 *
 * One test, used by both the render and the focus target. Kept as a function
 * rather than a local so the two can never drift apart again - they did, and
 * the D-pad went dead on every show.
 */
function hasPlayButton(d: ItemDetail, kids: MediaItem[]): boolean {
  return playableKind(d) && Boolean(toPlayable(d, kids));
}

/** What Play would start on this screen, or nothing. Mirrors `toPlay`. */
export function __toPlayableForTest(d: ItemDetail, kids: MediaItem[]): MediaItem | undefined {
  return toPlayable(d, kids);
}

function toPlayable(d: ItemDetail, kids: MediaItem[]): MediaItem | undefined {
  if (d.kind === "show") return undefined;
  if (d.kind !== "season") return d;
  return kids.find((c) => (c.viewOffsetMs ?? 0) > 0) ?? kids.find((c) => !(c.viewCount ?? 0)) ?? kids[0];
}

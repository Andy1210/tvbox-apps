import { useEffect, useRef, useState } from "react";
import {
  FocusContext,
  doesFocusableExist,
  getCurrentFocusKey,
  setFocus,
  useFocusable,
} from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { Row } from "./Row";
import { episodeNumber } from "./Tile";
import { Message } from "./Message";
import { artworkScale } from "./posters";
import { CastRow } from "./CastRow";
import { Scores } from "./Scores";
import { Reviews } from "./Reviews";
import { TitleArt } from "./TitleArt";
import { Summary } from "./Summary";
import { LanguagePicker } from "./LanguagePicker";
import { Confirm } from "./Confirm";
import { SeasonStrip, SEASONS_KEY } from "./SeasonStrip";
import { Actions, type Action } from "./Actions";
import { MoreMenu, type MoreItem } from "./MoreMenu";
import { MoreIcon, PlayIcon, WatchedIcon } from "./icons";
import { Backdrop } from "./Backdrop";
import { themeItem, useTheme } from "./theme";
import { useFocusFallback, useFocusOnReveal, useInitialFocus, useScrollToTopOnFirst } from "./focus";
import { usePlayer, useShowingPlayer } from "./playback/player";
import { rememberedVersion, useChosenVersion } from "./chosenVersion";
import { classify, useApp } from "./state";
import { rememberTrack, resolveTrack, type ChosenTrack } from "./tracks";
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

/** The part of an item this screen ever patches by hand. */
type ViewState = Pick<MediaItem, "viewCount" | "viewOffsetMs">;

/** Two presses closer together than this are one press that bounced. */
const PRESS_GAP_MS = 400;

/**
 * Which focus keys belong to this screen.
 *
 * Shared by the two hooks that put the cursor back, so they cannot disagree
 * about whose cursor it is. The failure screen's own button is in here for a
 * reason: it replaces this whole screen, so its key is the only one on it - and
 * a predicate that did not recognise it pulled focus onto a key the failure
 * screen never renders, on the FIRST arrow press. "Something went wrong / Try
 * again", highlighted, and the remote does nothing but Back.
 */
export function ownsDetailKey(key: string): boolean {
  return (
    key.startsWith("detail-") ||
    key.startsWith("cast-") ||
    key.startsWith("children-") ||
    key.startsWith("extras-") ||
    key.startsWith("review-") ||
    key.startsWith("msg-")
  );
}

/**
 * The buttons above the rows, in the order Up should try them.
 *
 * Whatever this screen actually has: aiming at a button that is not rendered
 * leaves the app with no origin and swallows the press. A show has no Play
 * button, a film no season button, and the arrival screen has neither.
 */
const ABOVE_ROWS = ["detail-play", "detail-watched", "detail-more", "lib-arrange"];

/** Focus the first of these that exists. False when none of them does, which is
 *  the caller's cue to leave the press to geometry rather than eat it. */
function focusFirstOf(keys: readonly string[]): boolean {
  for (const key of keys) {
    if (doesFocusableExist(key)) {
      setFocus(key);
      return true;
    }
  }
  return false;
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
  focusSeasons,
}: {
  itemId: string;
  focusChildId?: string;
  queueFrom?: MediaItem[];
  focusSeasons?: boolean;
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
   * The chosen tracks, kept as a description rather than as an ordinal.
   *
   * An ordinal is a position in one item's own track list, and episodes of a
   * season do not agree on it: measured, choosing Hungarian on an episode whose
   * tracks read English, Magyar and then pressing the next one - whose read
   * Magyar, English - played English. And a converted stream bakes its tracks
   * in at start, so that costs a restart to undo.
   *
   * Not a bare language either, which is what it used to be: 1,841 of this
   * library's 8,234 episodes carry two subtitles in one language, and a language
   * matched the FIRST of them - so choosing the full Hungarian subtitle on a
   * file that also has a signs-only one left the tick where it was and played
   * signs only. See `tracks.ts` for what is kept and how far each part travels.
   */
  const [audioChoice, setAudioChoice] = useState<ChosenTrack | undefined>();
  const [subChoice, setSubChoice] = useState<ChosenTrack | "none" | undefined>();
  /**
   * The episode the cursor is on, with its own tracks.
   *
   * A season carries no tracks of its own and its episodes do not share them,
   * so the language choice has to follow the highlight rather than the screen.
   */
  const [focused, setFocused] = useState<ItemDetail | null>(null);
  const [firstChild, setFirstChild] = useState<ItemDetail | null>(null);
  /**
   * The episode Play would start, with its own track list.
   *
   * A season's episodes do not agree on track ORDER - measured over this
   * library's 566 seasons by the rule this code actually applies, 67 of them
   * resolve a language to a different ordinal somewhere (60 subtitles, 11
   * audio) - and the chosen language is turned into an ordinal against whatever
   * this screen is describing, which is the HIGHLIGHTED episode. Play starts the
   * one in progress instead, so the ordinal was read off one episode and handed
   * to another: choosing the Hungarian subtitle and pressing Play started the
   * English one.
   *
   * Fetched ahead of the press rather than during it. Resolving on the press
   * would put a round trip in front of playback, and Play on a television has
   * to be immediate.
   */
  const [playTarget, setPlayTarget] = useState<ItemDetail | null>(null);
  /**
   * Whether the first episode could not be read.
   *
   * It is the only source of the played episode's tracks on the commonest
   * season - the one nobody has started, where Play begins at the first child -
   * because the prefetch below stands down there rather than asking for a
   * document that is already on its way. If that request fails there is nothing
   * else coming, and the choice is dropped for as long as the screen is up. So
   * a failure hands the job back to the prefetch, which has a catch of its own.
   */
  const [firstChildFailed, setFirstChildFailed] = useState(false);
  const upNext = usePlayer((s) => s.upNext);
  const moving = usePlayer((s) => s.moving);
  // Only to re-render while a countdown is running; the value is the clock.
  const [, setTick] = useState(0);
  const [picking, setPicking] = useState(false);
  /** The rarely-used actions, behind the overflow button. */
  const [more, setMore] = useState(false);
  /** The season-wide mark, waiting to be answered. */
  const [confirming, setConfirming] = useState(false);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [children, setChildren] = useState<MediaItem[]>([]);
  /** The other seasons of this series, on a season screen. Empty everywhere else. */
  const [seasons, setSeasons] = useState<MediaItem[]>([]);
  /**
   * Whether the screen knows what it holds.
   *
   * Which key the one-shot initial focus aims at depends on the children - a
   * show has no Play button and must open on a season - and they arrive a round
   * trip after the item does. Firing on `detail` alone aimed at a button that
   * did not exist yet.
   */
  const [settled, setSettled] = useState(false);

  /**
   * View-state changes this screen has made that the server has not answered yet.
   *
   * The post-playback refetch above writes `detail` and `children` too, and its
   * answer is a round trip old: pressing the button while one was in flight had
   * the tick appear and then vanish as the refetch landed, with the press
   * already on the server. Kept by id and applied on top of whatever arrives, so
   * the press wins until it is confirmed or reverted.
   */
  const marks = useRef(new Map<string, ViewState>());
  /** Ids whose write has not answered yet, which are the only marks worth keeping. */
  const settling = useRef(new Set<string>());
  const withMarks = <T extends MediaItem>(item: T): T => {
    const m = marks.current.get(item.id);
    return m ? { ...item, ...m } : item;
  };

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
    // The track choice is the one with teeth if that day comes: it holds an
    // ordinal and an id, and both are meaningful only within their own item -
    // on Jellyfin the id IS the stream's index, so "2" on the next film is a
    // different subtitle, baked into a converted stream at start.
    setFocused(null);
    setFirstChild(null);
    setPlayTarget(null);
    setFirstChildFailed(false);
    // The third panel, cleared with the other two: a menu left standing across
    // an item change belongs to an overflow list that has been rebuilt under
    // it, and an empty one has nothing for the cursor to land on.
    setMore(false);
    setAudioChoice(undefined);
    setSubChoice(undefined);
    setPicking(false);
    setConfirming(false);
    // Held by id, and an id is only meaningful within one library - but this is
    // really about the screen having been rebuilt from the server, which is what
    // a pending patch exists to survive.
    marks.current.clear();
    settling.current.clear();

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
          if (kids[0] && d.kind === "season")
            void backend.item(kids[0].id).then(
              (k) => live && setFirstChild(k),
              (e) => {
                // Answered rather than dropped: this is the only read of the
                // played episode's tracks on a season nobody has started, and
                // an unhandled rejection said nothing at all.
                if (!live) return;
                setFirstChildFailed(true);
                log.warn("could not read the first episode's tracks", e);
              },
            );
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
   * The series' other seasons, for the strip above the episode list.
   *
   * Its own request, after the screen: it is a shortcut, not part of what the
   * page says, so nothing here may hold the episodes up or fail the screen. A
   * series that cannot be listed simply has no strip, and Back to the series
   * still works.
   *
   * Keyed on the kind and the parent rather than on `detail`, which is replaced
   * whole by the refetch after playback - that would ask again for a list that
   * cannot have changed.
   */
  const showId = detail?.kind === "season" ? detail.parentId : undefined;
  const known = detail !== null;
  useEffect(() => {
    // Nothing is known yet, so nothing is settled: a screen opened from the
    // strip waits on this flag, and answering "settled, no seasons" before the
    // item has even arrived would put its cursor back on the play button.
    if (!known) return;
    setSeasons([]);
    if (!backend || !showId) return;
    let live = true;
    void (async () => {
      try {
        const kids = await backend.children(showId);
        // A series' children are its seasons, but the strip says so itself
        // rather than trusting it: a chip that opens something which is not a
        // season would put an unrelated screen one press from the episodes.
        if (live) setSeasons(kids.filter((k) => k.kind === "season" && k.id));
      } catch (e) {
        log.warn("could not list the seasons", e);
      }
    })();
    return () => {
      live = false;
    };
    // `known` rather than `detail`, which is replaced whole by the refetch after
    // playback: keying on the object would clear the strip and ask again every
    // time a film ends.
  }, [backend, showId, known]);

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
    // A settled mark is not truth any more, and playback is what makes newer
    // truth: an episode marked watched and then stopped ten minutes in came
    // back with its real resume point, and a mark left applied on top put it
    // back to nothing - so the tile lost its bar and Play stopped resuming it.
    // A write still in the air is different and is kept.
    for (const id of [...marks.current.keys()]) if (!settling.current.has(id)) marks.current.delete(id);
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
        // Under whatever this screen has changed by hand since the request went
        // out - the answer is a round trip old and would otherwise take a tick
        // back off that is already on the server.
        setDetail(withMarks(d));
        if (kids) setChildren(kids.map(withMarks));
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
  /**
   * The synopsis, so the episode row can keep it on screen.
   *
   * On a season it describes the HIGHLIGHTED episode rather than the season, so
   * it is what somebody moving along the row is reading - and a row brought to
   * the top of the view took it with it.
   */
  const summary = useRef<HTMLDivElement | null>(null);

  /**
   * The item the watched button acts on, and where its state is read from.
   *
   * On a season that is the EPISODE the page is describing, not the season. A
   * season carries a `viewCount` of its own that says nothing about "the season
   * is watched" - Plex rolls a child's scrobble up into it, so it is above zero
   * after one episode and disagrees with `viewedLeafCount` on 225 of this
   * library's 400 seasons. The button therefore read "mark as unwatched" with
   * fifteen episodes to go, and pressing it scrobbled or unscrobbled all of them
   * at once. Everything else on this screen - the title under the art, the
   * synopsis, the cast, the scores, the language button - already describes the
   * highlighted episode.
   *
   * Its view state comes from the ROW rather than from `focused`, because only
   * the row is kept current: the post-playback refetch above replaces `children`
   * and never `focused`, and `backend.item` answers from a 30 s cache - so after
   * watching an episode its tile carried a tick while the button was still
   * offering to mark it watched, two claims about one episode on one screen.
   *
   * Null until the highlight has loaded, which is what keeps the button off
   * rather than pointed at the season: a control that acts on the wrong item is
   * worse than one that appears a round trip late.
   */
  const watchTarget: ItemDetail | MediaItem | null =
    detail?.kind === "season"
      ? ((focused && children.find((c) => c.id === focused.id)) ?? focused ?? null)
      : (detail ?? null);
  const watched = (watchTarget?.viewCount ?? 0) > 0;
  /** A season is watched when nothing in it is left, which is what its row says. */
  const seasonWatched = children.length > 0 && children.every((c) => (c.viewCount ?? 0) > 0);

  /** Overwrite the view state of the listed ids wherever this screen holds it. */
  const repaint = (state: Map<string, ViewState>): void => {
    const put = <T extends MediaItem>(item: T): T => {
      const v = state.get(item.id);
      return v ? { ...item, ...v } : item;
    };
    setDetail((d) => (d && state.has(d.id) ? put(d) : d));
    setFocused((f) => (f && state.has(f.id) ? put(f) : f));
    setChildren((kids) => (kids.some((c) => state.has(c.id)) ? kids.map(put) : kids));
  };

  /**
   * The button a panel must hand the cursor back to.
   *
   * Set by the panel as it closes rather than acted on there: `setFocus` inside
   * the close handler runs while the panel is still mounted and races its
   * unmount, and what norigin does with a focused component that goes away is
   * to walk UP - which reaches this page's own container and restores whatever
   * child it remembers. Observed on a box: Back out of the overflow menu left
   * the cursor on an episode tile, one press from starting it, on a menu that
   * sits directly above that row.
   *
   * Unconditional about WHERE, unlike `useFocusOnReveal`'s: the tile the cursor
   * lands on is a key this screen owns, so a guard that keeps an owned cursor
   * keeps exactly the wrong one.
   */
  const [restore, setRestore] = useState<string | null>(null);

  /**
   * A remote repeats, so a press that lands twice must not undo itself.
   *
   * Measured on the box: two presses 150 ms apart marked and then unmarked, and
   * the only evidence was a 180 ms flash of the tick - from the sofa, a button
   * that does nothing. `busy` cannot cover it; the write answers in well under
   * that against a server on the LAN.
   *
   * The window is pushed forward by a REFUSED press as well as an accepted one,
   * which is what makes a held OK button one command rather than one every
   * 400 ms: spatial navigation fires on every keydown and does not look at
   * `repeat`. Suppressing a press is the safe direction for a toggle - it
   * withholds a write, it can never cause one.
   *
   * It guards the PRESS, not the write, and that distinction is a bug fixed:
   * with it inside `setWatchedOn` an answer given to a panel within the window
   * of the press that OPENED it was dropped silently, with the panel already
   * closed.
   *
   * One control has it: the button that marks a single episode, which is the
   * only one here that writes on the press itself. Everything else this guarded
   * ends at a panel - one that Back closes, or a confirmation that opens on
   * "Cancel" - and there the guard cost more than it bought, because it also
   * refuses a REAL press for 400 ms, silently, which from a sofa is a remote
   * that has stopped working.
   *
   * `performance.now()` rather than the wall clock: these boxes have no
   * battery-backed clock, so the first NTP correction after a cold boot steps
   * time backwards - and a negative elapsed reads as "too soon" for as long as
   * the step lasted, which is the button dead with nothing to say why.
   */
  const lastPress = useRef(0);
  /** True when this press is the tail of the last one rather than a new one. */
  const bounced = (): boolean => {
    const now = performance.now();
    const soon = now - lastPress.current < PRESS_GAP_MS;
    lastPress.current = now;
    return soon;
  };

  /**
   * Flip watched state, and show it straight away.
   *
   * The items are patched locally rather than refetched: the server answers the
   * scrobble before its own view state has settled, so reading it back returns
   * the OLD value often enough that the button appeared not to work. A refetch
   * on failure would be worse - it would replace a correct optimistic state
   * with a stale one.
   *
   * The patch reaches the ROW as well as the button, because the tick somebody
   * is looking for is on the tile: this screen keeps the children it was built
   * with for as long as it is up, so marking an episode watched changed the
   * button's label and nothing else until the screen was left and opened again.
   * `sweep` is what a season's own button carries - one call moves every episode
   * on the server, so every tile has to move with it.
   *
   * `viewOffsetMs` is cleared in both directions, and that is not tidiness - the
   * tile draws a progress bar OR a tick, never both, so a half-watched episode
   * patched with a view count alone still showed the bar and no tick. It matches
   * the server: measured, a Plex scrobble clears the offset and an unscrobble
   * clears both.
   *
   * The revert is per id and functional rather than a snapshot of the screen:
   * the cursor moves while the write is in flight, and putting `focused` back as
   * it was pulled the synopsis, cast and backdrop onto an episode that was no
   * longer the highlighted one.
   */
  const setWatchedOn = async (target: MediaItem, next: boolean, sweep: MediaItem[] = []): Promise<void> => {
    if (!backend || busy || !target.id) return;
    const items = [target, ...sweep.filter((i) => i.id && i.id !== target.id)];
    const before = new Map<string, ViewState>(
      items.map((i) => [i.id, { viewCount: i.viewCount, viewOffsetMs: i.viewOffsetMs }]),
    );
    const after = new Map<string, ViewState>(
      items.map((i) => [i.id, { viewCount: next ? Math.max(1, i.viewCount ?? 0) : 0, viewOffsetMs: undefined }]),
    );
    setBusy(true);
    for (const [id, v] of after) {
      marks.current.set(id, v);
      settling.current.add(id);
    }
    repaint(after);
    try {
      await backend.setWatched(target.id, next);
    } catch (e) {
      log.warn("could not change watched state", e);
      for (const id of after.keys()) marks.current.delete(id);
      repaint(before);
    } finally {
      for (const id of after.keys()) settling.current.delete(id);
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
  /**
   * Where the cursor STARTS, which is not always where it is put back.
   *
   * A screen opened from another season's strip opens on the strip, so looking
   * through the seasons is one press each. Everything else about this page -
   * coming back out of a film, a press arriving with the cursor nowhere - still
   * aims at `first`, which knows about the episode that was playing.
   *
   * Only when the strip is really there: a series with one season has none, and
   * a key that never mounts is a remote that does nothing. The STRIP is named,
   * not a chip - the container always exists while the strip is drawn, and it
   * is the one thing that knows which chip the season being shown is.
   */
  useInitialFocus(first, settled);

  /**
   * The strip, for a screen opened from another season's.
   *
   * Separate from the cursor above, and always later than it, because the
   * season list is a second request that may answer either side of the
   * episodes. Making the cursor WAIT for it was the first attempt and it was
   * worse in both directions: the screen had nothing highlighted until the list
   * answered, and a slow one then moved the cursor out from under a press. So
   * the cursor goes where it always goes, and this lifts it onto the strip only
   * while it is still standing where this screen put it - anyone who has
   * pressed anything keeps what they pressed.
   */
  const lifted = useRef(false);
  useEffect(() => {
    // Not while a film is up, the way the other two focus hooks on this screen
    // are gated: the player owns the cursor then, and this page is only hidden
    // behind it. Safe without the guard today - starting a film changes `first`,
    // so the test below already fails - but that is another component's doing.
    if (!focusSeasons || lifted.current || !settled || playing || seasons.length <= 1) return;
    if (!doesFocusableExist(SEASONS_KEY)) return;
    lifted.current = true;
    // A timer, like the one-shot above and after it: both are armed in source
    // order, so this reads a cursor that has already been placed.
    const id = setTimeout(() => {
      if (getCurrentFocusKey() === first) setFocus(SEASONS_KEY);
    }, 0);
    return () => clearTimeout(id);
  }, [focusSeasons, seasons, first, settled, playing]);

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
  // The film has gone and this page is back: the cursor comes with it, rather
  // than waiting for a press. `first` is the play button, so the gesture that
  // measured worst - Back to leave, OK to carry on watching - works.
  //
  // `!moving` is not decoration: `current` is null for the whole of an episode
  // step, five round trips of it, so without it a step counts as this page being
  // revealed and parks the cursor on the OUTGOING episode's tile, behind a player
  // that is still up. The same guard, for the same reason, as the fallback's.
  useFocusOnReveal(first, ownsDetailKey, !playing && !moving && !picking && !confirming && !more);

  useFocusFallback(
    // The play button when there is one; otherwise the first child, which is
    // what a group screen has instead. A group with NEITHER - an empty
    // collection, and this server has one - left nothing focusable at all, so
    // every press was discarded and only Back worked.
    first,
    ownsDetailKey,
    // Not while the language panel is up. This is a window listener and stays
    // armed behind it; the panel's keys are none of the above, so every press
    // it could not resolve threw focus back onto the play button - which is
    // exactly "I cannot navigate in the subtitle list".
    !playing && !picking && !confirming && !more,
  );

  /**
   * Hand the cursor back to the button a panel was opened from.
   *
   * After the two hooks above, and on a timeout for the same reason theirs
   * have one: the panel's own focusables are torn down in this commit and
   * norigin's cleanup for them runs first. `focusFirstOf` rather than a bare
   * `setFocus`, because the overflow button is only rendered while it has
   * something behind it - a screen that lost its last overflow item while the
   * panel was up would otherwise be handed a key that never mounts.
   */
  //
  // `!playing && !moving` for the reason the two hooks above carry it: this
  // page sits BEHIND the player rather than unmounting, and a cursor parked on
  // a button there is a press away from acting on the film that is running.
  const panelUp = picking || confirming || more;
  useEffect(() => {
    if (!restore || panelUp || playing || moving) return;
    const id = setTimeout(() => {
      focusFirstOf([restore, ...ABOVE_ROWS]);
      setRestore(null);
    }, 0);
    return () => clearTimeout(id);
  }, [restore, panelUp, playing, moving]);

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

  /**
   * Read the tracks of the episode Play would start.
   *
   * Only on a season: everywhere else Play starts the item this screen is
   * already describing, so its tracks are on `detail` and there is nothing to
   * fetch. `toPlayable` rather than a second copy of the rule - the two drifted
   * apart once and took the D-pad with them.
   *
   * The id, not the item, as the dependency: `children` is rebuilt whenever a
   * view state is patched, and the object identity changes with it while the
   * episode Play would start usually does not.
   */
  const playTargetId = detail?.kind === "season" ? toPlayable(detail, children)?.id : undefined;
  /**
   * The first episode is already being fetched, for the tracks the buttons show
   * before anything is highlighted - and the metadata cache has no in-flight
   * deduplication, so asking for the same document again is a second request
   * rather than a cache hit. On a season nobody has started, which is the
   * commonest one there is, that is exactly the same episode.
   */
  const alreadyAsked = playTargetId !== undefined && playTargetId === children[0]?.id && !firstChildFailed;
  useEffect(() => {
    if (!backend || !playTargetId || alreadyAsked) return;
    let live = true;
    void backend
      .item(playTargetId)
      .then((item) => {
        if (live) setPlayTarget(item);
      })
      .catch((e) => {
        // Not surfaced, and the degradation is deliberate: with no answer the
        // choice is passed on as nothing rather than as an ordinal from another
        // episode's list, so playback falls back to the file's own default.
        // There is no retry - leaving the screen is what asks again.
        log.warn("could not read the tracks of the episode Play would start", e);
      });
    return () => {
      live = false;
    };
  }, [backend, playTargetId, alreadyAsked]);

  // Before the early returns, as hooks must be. `detail` is null while loading,
  // which is simply no theme yet.
  // Three answers rather than two - the item, nothing, or not known yet. See
  // themeItem: switching seasons replaces this screen with another of the same
  // series, and the theme must survive the gap rather than start again.
  useTheme(themeItem(detail, Boolean(failure)));

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
   * episode of another series - but scoped to the page's own LIST as well as to
   * parentage, or the scoping undoes the fix: a film has no parent to match (Plex
   * gives a movie no `parentRatingKey`), so parentage alone never fires on the
   * one page this exists for, and where it does fire `children` is non-empty and
   * the fallback is unreachable.
   */
  const rowItems = children.length
    ? children
    : upNext
      ? [upNext.item]
      : moving && (moving.parentId === itemId || order.some((q) => q.id === moving.id))
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
  const toPlay = toPlayable(detail, children);
  /**
   * What the page is describing.
   *
   * On a season that is the episode the cursor is on, not the season: its
   * synopsis, its cast, its extras, its scores. A season's own metadata is a
   * repeat of the series, and a screen per episode would be this screen with
   * one row missing - so the rows reload as the highlight moves, which is what
   * makes the episode list a place you can read from rather than a menu.
   */
  /**
   * Whether Play carries on rather than starts.
   *
   * Asked of the episode Play would START, not of the screen: a season carries
   * no resume point of its own, so reading `detail` here was always false on
   * one - the button said "Play" over a half-watched episode and the restart
   * button, which only exists beside a resume, was never rendered at all.
   */
  const resumable = (toPlay?.viewOffsetMs ?? 0) > 0;
  const shown = (detail.kind === "season" && focused) || detail;
  /**
   * Whose tracks the panel lists, as an ITEM rather than a version.
   *
   * On a season that is the highlighted episode - or the FIRST one before
   * anything is highlighted, so the button exists on arrival rather than
   * materialising only after somebody has been down into the list and back.
   *
   * Named, because the panel has to say which episode it is offering and the
   * two used to fall back to different things: with nothing highlighted the
   * label asked `shown`, which is the SEASON and has no designation, while the
   * list had already fallen back to the first episode. Measured on a box, that
   * is the commonest way into the panel - arrive, overflow, languages, never
   * entering the row - and on Bluey's second season it offered seven languages
   * against the two the episode Play starts actually has, unlabelled.
   */
  const tracksOwner = shown.versions[version] ? shown : firstChild;
  const tracksFrom = tracksOwner?.versions[version];
  /**
   * The tracks Play resolves its choice against, which are the STARTED
   * episode's - not the highlighted one's.
   *
   * `tracksFrom` describes what the screen is SHOWING, and on a season that is
   * wherever the cursor is; Play starts the episode in progress instead. An
   * ordinal read off one and handed to the other names a different track: 67 of
   * this library's 566 seasons resolve some language differently between two of
   * their episodes. Counting where a language merely APPEARS at more than one
   * ordinal is the wrong test and gives three times the number - `pick` takes
   * the FIRST match, so a language whose first occurrence never moves is safe.
   *
   * Whichever copy of that episode is already in hand - the one fetched for
   * this, the highlighted one when the cursor is on it, the first child, or the
   * item itself on a film - and NOTHING when none of them is it. Falling back
   * to the highlighted episode's list is what the screen used to do, and it is
   * the bug: a stale answer is one round trip wide, but a choice resolved
   * against the wrong list names a real, different track, while no answer at
   * all only loses the choice. A film resolves against `detail` and is
   * untouched.
   */
  const playSource = toPlay ? [playTarget, focused, firstChild, detail].find((x) => x?.id === toPlay.id) : undefined;
  const playTracks = playSource?.versions[version];

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
  /**
   * Which list `v` is, for the id branch alone.
   *
   * Item AND version, because a track id is only unique within one file: on
   * Jellyfin it is the stream's index within its media source, so the versions
   * of one item repeat it - and the version chips change the version while the
   * item stays put.
   */
  const listKey = (ownerId: string): string => `${ownerId}:${version}`;
  const pick = (v: MediaVersion | undefined, ownerId: string): { audio?: number; subtitle?: number | "none" } => ({
    audio: resolveTrack(v?.audio, audioChoice, listKey(ownerId)),
    subtitle: subChoice === "none" ? "none" : resolveTrack(v?.subtitles, subChoice, listKey(ownerId)),
  });

  /**
   * The actions that are not worth a button of their own.
   *
   * Audio and subtitles are chosen once for a film if at all, and a whole
   * season is marked by hand only when it was watched somewhere else. Each had
   * a line of the header to itself, and on a season screen those lines are paid
   * for by the synopsis - which is read on every episode.
   */
  const overflow: MoreItem[] = [];
  if (tracksFrom && (tracksFrom.audio.length > 1 || tracksFrom.subtitles.length > 0))
    overflow.push({
      key: "lang",
      label: t("tracks.title"),
      onEnter: () => {
        setMore(false);
        setPicking(true);
      },
    });
  if (detail.kind === "season" && children.length > 0)
    overflow.push({
      key: "watched-season",
      // It stays reachable: a season watched on somebody else's television is
      // otherwise sixteen trips into the row and back. What it is not is a
      // button beside the one that marks a single episode, where the two read
      // alike and one of them moves twenty items.
      label: t(seasonWatched ? "detail.markSeasonUnwatched" : "detail.markSeasonWatched"),
      onEnter: () => {
        setMore(false);
        setConfirming(true);
      },
    });

  const actions: Action[] = [];
  if (playable)
    actions.push({
      key: "detail-play",
      label: [
        resumable ? t("detail.resume") : t("detail.play"),
        // Which episode, on a season. Play there starts the one in progress or
        // else the first unwatched, and that is not the one the cursor is on -
        // so without this the button is the only control on the screen whose
        // target nothing names.
        detail.kind === "season" && toPlay ? episodeNumber(toPlay) : "",
        // Naming the version answers "does this chip start playback or
        // configure it?" without anyone having to try.
        detail.versions.length > 1 ? (detail.versions[version]?.label ?? "") : "",
      ]
        .filter(Boolean)
        .join(" \u00b7 "),
      icon: <PlayIcon className="h-[2.4vh] w-[2.4vh]" />,
      primary: true,
      // The first focusable on the page, so reaching it means going back to the
      // top - the title art and synopsis above it can be reached no other way.
      onFocused: toTop,
      onEnter: () =>
        backend &&
        toPlay &&
        void usePlayer.getState().play(backend, toPlay, { version, ...pick(playTracks, toPlay.id), queue: order }),
    });
  if (playable && resumable)
    actions.push({
      key: "detail-restart",
      label: t("detail.fromStart"),
      onEnter: () =>
        backend &&
        toPlay &&
        void usePlayer
          .getState()
          .play(backend, toPlay, { resume: false, version, ...pick(playTracks, toPlay.id), queue: order }),
    });
  // Marking by hand is what a shared server needs: a film watched somewhere
  // else, or abandoned twenty minutes in and not worth resuming, has no other
  // way to be put right - and the carry-on row is built from exactly this state.
  if (playable && watchTarget)
    actions.push({
      key: "detail-watched",
      // Named, because on a season this is about ONE episode and nothing
      // around it says which: the largest text on the screen is the series, the
      // episode's own name is a guest's name at 2vh, and no tile is highlighted
      // while the cursor is up here. The designation is what the tile captions
      // carry, and it is why the label survives the button becoming a glyph.
      label: [episodeNumber(watchTarget), t(watched ? "detail.markUnwatched" : "detail.markWatched")]
        .filter(Boolean)
        .join(" \u00b7 "),
      icon: <WatchedIcon on={watched} />,
      iconOnly: true,
      onEnter: () => {
        if (!bounced()) void setWatchedOn(watchTarget, !watched);
      },
    });
  if (overflow.length > 0)
    actions.push({
      key: "detail-more",
      label: t("detail.more"),
      icon: <MoreIcon />,
      iconOnly: true,
      // The items behind this are NOT guarded, deliberately. A repeat of the
      // press that opens the menu lands on its first item, and the guard that
      // would refuse it also refuses a real press for 400 ms - silently, which
      // on a television reads as a broken remote. What the repeat can reach is
      // a panel that closes with Back, or a confirmation that opens on
      // "Cancel"; neither does anything that has to be undone, and the audio
      // button this replaced had no guard at all.
      onEnter: () => setMore(true),
    });

  return (
    <FocusContext.Provider value={focusKey}>
      <Backdrop item={shown} />
      {confirming && (
        <Confirm
          title={t(seasonWatched ? "detail.markSeasonUnconfirm" : "detail.markSeasonConfirm")}
          detail={t("detail.markSeasonCount", { n: String(children.length) })}
          confirmLabel={t("detail.markSeasonYes")}
          onConfirm={() => {
            setConfirming(false);
            void setWatchedOn(detail, !seasonWatched, children);
            // Back to the button the chain started at, which is the only one of
            // the three still on screen: the menu that asked closed behind it.
            setRestore("detail-more");
          }}
          onClose={() => {
            setConfirming(false);
            setRestore("detail-more");
          }}
        />
      )}
      {more && (
        <MoreMenu
          items={overflow}
          onClose={() => {
            setMore(false);
            // Back to the button that opened it, the way the two panels below do.
            setRestore("detail-more");
          }}
        />
      )}
      {picking && (
        <LanguagePicker
          version={tracksFrom}
          // Which episode these tracks are, because on a season they are the
          // HIGHLIGHTED one's while Play starts another - the panel and the
          // button beside it authoritatively describe different episodes.
          designation={tracksOwner ? episodeNumber(tracksOwner) : undefined}
          audio={pick(tracksFrom, tracksOwner?.id ?? "").audio}
          subtitle={pick(tracksFrom, tracksOwner?.id ?? "").subtitle}
          onAudio={(ordinal) =>
            tracksOwner && setAudioChoice(rememberTrack(tracksFrom?.audio, ordinal, listKey(tracksOwner.id)))
          }
          // "Off" is the one choice that needs no track list, so it is not
          // gated on having one.
          onSubtitle={(ordinal) =>
            setSubChoice(
              ordinal === "none"
                ? "none"
                : tracksOwner
                  ? rememberTrack(tracksFrom?.subtitles, ordinal, listKey(tracksOwner.id))
                  : undefined,
            )
          }
          onClose={() => {
            setPicking(false);
            // Back to the button the chain started at, the way the confirm above
            // does. Without it the panel closes onto a cursor that is nowhere,
            // and whatever puts one back lands on Play - so Back out of the
            // audio menu moved the highlight to a different button entirely.
            setRestore("detail-more");
          }}
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
          {/* Wrapped only to be measured: this is what the episode row keeps
              on screen when it takes the cursor. */}
          <div ref={summary}>
            <Summary key={shown.id} text={shown.summary ?? ""} />
          </div>

          {/* Not on a collection or a playlist: measured, resolveStream answers
              400 for both, so the button accepted OK and did nothing - and it
              was the initial focus on 461 collection screens. Their first
              child is what plays, and it is one row down. */}
          <Actions actions={actions} />

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

        {/* Only where there is a choice: one season is not a switcher, it is a
            row of one chip that says nothing and answers OK with nothing. */}
        {detail.kind === "season" && seasons.length > 1 && (
          <SeasonStrip
            seasons={seasons}
            currentId={detail.id}
            title={t("detail.seasons")}
            onPick={(season) => {
              // The season being shown is not a destination: pressing it would
              // rebuild this screen and lose where the cursor was in it.
              if (season.id === detail.id) return;
              // Replaced, not pushed: Back belongs to whatever opened the
              // series, not to a trail of every season that was looked at.
              replace({ name: "item", itemId: season.id, focusSeasons: true });
            }}
            onLeave={(dir) => (dir === "up" ? focusFirstOf(ABOVE_ROWS) : focusFirstOf([`row-children-${itemId}`]))}
          />
        )}

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
            // Only on a season, which is the one screen whose synopsis follows
            // the cursor. Everywhere else it describes the page itself and has
            // no claim on the room the row needs.
            keepAbove={detail.kind === "season" ? summary : undefined}
            // And the same screen is the one that has to say which episode it
            // is describing once the cursor is up on the buttons. `shown` is
            // the season itself until something is highlighted, which is the
            // state where there is nothing to mark.
            describing={shown !== detail ? shown.id : undefined}
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
              // The season strip first where there is one: it sits between the
              // buttons and this row, and Up should reach the thing directly
              // above rather than skip it.
              return !focusFirstOf([SEASONS_KEY, ...ABOVE_ROWS]);
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
                  usePlayer
                    .getState()
                    .play(backend, item, { version, ...pick(d.versions[version], d.id), queue: children }),
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

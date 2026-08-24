// Driving the box's shared player, and knowing what it is doing.
//
// The video is not rendered by this app: a URL is handed to the box, which plays
// it behind this page while the page draws the overlay on top. So everything
// here is bookkeeping - what is playing, where it is, and what to do when it
// ends - and the one thing that needs care is that the box's own events are the
// truth, not what this app asked for.

import { create } from "zustand";
import type { ItemDetail, MediaBackend, Marker, MediaItem, PlaybackState, StreamDecision } from "../backends/types";
import { PlaybackScheduler, type NowPlayingReport } from "./scheduler";
import { onRelease, onResume } from "../lifecycle";
import { claimPlayer, heldByAnother, ownsPlayer, releasePlayer, whenPlayerLost } from "./owner";
import { log } from "../redact";

/** Auto-advance starts the next episode this long before the file truly ends. */
const NEAR_END_MS = 15_000;

function bridge(): NonNullable<Window["tvbox"]> | undefined {
  return typeof window === "undefined" ? undefined : window.tvbox;
}

function postNowPlaying(r: NowPlayingReport): void {
  try {
    void fetch("/tvbox/api/nowplaying", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "mediaclient", ...r }),
    }).catch(() => {});
  } catch {
    /* no shell (dev, tests) */
  }
}

export interface PlayingItem {
  item: MediaItem;
  decision: StreamDecision;
  markers: Marker[];
  /** Every file the library holds for this title, with their tracks. */
  detail?: ItemDetail;
  /** What is currently chosen. Undefined means "whatever the server picked". */
  choice: { version: number; audio?: number; subtitle?: number | "none"; maxBitrateKbps?: number };
}

interface PlayerState {
  current: PlayingItem | null;
  state: PlaybackState;
  positionMs: number;
  durationMs: number;
  buffering: boolean;
  /** Set while a seek is in flight, so the bar shows where it is going. */
  seekTargetMs: number | null;
  /** Where the film was when the seek was sent, so its direction is known. */
  seekFromMs: number | null;
  /**
   * Where the scrub cursor sits, or null when nobody is scrubbing.
   *
   * Deliberately NOT a seek. Left and Right move this and the overlay shows the
   * frame there; the film keeps playing until OK commits it. Seeking on every
   * press means each one costs a fresh transcode segment and a rebuffer, so
   * finding a place in a two-hour film by eye used to mean paying for a dozen
   * seeks to reach one.
   */
  scrubMs: number | null;
  overlay: boolean;
  error: string | null;

  play(
    backend: MediaBackend,
    item: MediaItem,
    opts?: {
      resume?: boolean;
      /**
       * Start here, in ms, whatever the server remembers.
       *
       * A controller's offset is an instruction, not a hint: using `resume` as
       * well started the film at the item's own view offset and only then
       * seeked, which begins a transcode in the wrong place.
       */
      startMs?: number;
      version?: number;
      /** That file's own id, when the caller knows it. See resolveStream. */
      partId?: string;
      audio?: number;
      subtitle?: number | "none";
      maxBitrateKbps?: number;
      /**
       * The list this was started FROM, if any.
       *
       * A playlist is a running order, and it wins over what an item happens to
       * belong to: an episode played from a playlist is followed by the next
       * thing in the PLAYLIST, not by the next episode of its series - and a
       * film, which belongs to nothing, gets a next at all.
       */
      queue?: MediaItem[];
    },
  ): Promise<void>;
  /** Switch version, audio or subtitles without losing the place. */
  changeTracks(choice: {
    version: number;
    audio?: number;
    subtitle?: number | "none";
    maxBitrateKbps?: number;
  }): Promise<void>;
  togglePause(): void;
  seekBy(deltaMs: number): void;
  /** Move the cursor without seeking. Starts at the current position. */
  scrubBy(deltaMs: number): void;
  /** Go where the cursor is. */
  commitScrub(): void;
  /** Leave the cursor where the film actually is. */
  cancelScrub(): void;
  seekTo(ms: number): void;
  /**
   * End what is playing.
   *
   * `handOver` is for the one caller that is about to give the box a new file:
   * it does the bookkeeping - the last progress report, the server session, the
   * event subscription - and leaves the box, the claim and `current` alone. See
   * the note in `play`.
   */
  stop(opts?: { handOver?: boolean }): Promise<void>;
  showOverlay(on: boolean): void;
  /**
   * How far the subtitles are shifted, in seconds.
   *
   * Not a saved preference, unlike the subtitle's size and colour: an offset
   * corrects one badly timed FILE, so carrying it to the next film would break
   * subtitles that were right. It resets with every start.
   */
  subDelaySec: number;
  nudgeSubDelay(deltaSec: number): void;
  /** The marker covering the current position, when there is one. */
  activeMarker(): Marker | null;
  skipMarker(): void;
  /**
   * The episodes either side of this one, and how to start them.
   *
   * Kept here rather than looked up by the overlay: the overlay is drawn over a
   * film and has no idea what it is part of, and the player already holds the
   * season it was started from.
   */
  siblings: { prev?: MediaItem; next?: MediaItem };
  /** The list playback is following, when it was started from one. */
  queue?: MediaItem[];
  /**
   * Start the episode before or after this one.
   *
   * Resolves when the move has been attempted, so a caller that has to answer
   * for it - the remote control protocol has to - can check what happened
   * instead of reporting success before anything was tried. It answers with the
   * item it actually started, because `siblings` can be replaced while the
   * previous item is still being torn down: a caller holding its own snapshot
   * would then check the wrong episode and report a failure that never
   * happened.
   */
  playSibling(which: "prev" | "next"): Promise<MediaItem | undefined>;
  /**
   * The episode a prev/next press is moving to, while the move is in flight.
   *
   * A move is a stop and a start - five round trips - and `current` is null for
   * all of them, so without this the overlay came down, the browsing screen
   * behind it stopped being hidden, and the press had nothing left to act on:
   * pressing again in that window started ANOTHER episode, so one button could
   * step several at once.
   */
  moving: MediaItem | null;
  /**
   * A step somebody asked for that could not be started, for as long as saying so
   * is still an answer to their press.
   *
   * Not `error`: that field is also set by the box's own non-fatal playback
   * event, it is written by whichever attempt failed last whether or not it was
   * about the film on screen, and nothing clears it - so the line it drew came up
   * beside a film that was playing perfectly well, ten minutes later, and once
   * next to "Pufferelés…" at the same time.
   */
  stepFailed: string | null;
  /**
   * Give up a move in flight.
   *
   * For Back, which is the only key left during one: the step holds the screen
   * for as long as the server takes, and eating that press is a dead remote.
   *
   * `force` is for an explicit STOP - the remote's stop key, or a phone's, or a
   * spoken one. A plain cancel is ignored once the hand-over has begun, so that
   * one press has one outcome; an instruction to stop cannot be, or the box was
   * told to stop, answered ok, and started the next episode anyway.
   */
  cancelMove(force?: boolean): void;
  /**
   * The episode that will start by itself, and when.
   *
   * Set when one runs out with another behind it. The screen underneath shows a
   * countdown on that episode; any press cancels it, because a countdown that
   * cannot be stopped is a countdown people fight.
   */
  upNext: { item: MediaItem; at: number } | null;
  cancelUpNext(): void;
}

let scheduler: PlaybackScheduler | null = null;
/** "S2E7" where the server numbers it, the title where it does not. */
function episodeLabel(item: MediaItem): string | null {
  // The same test the tile's own label uses: a season 0 special and an episode 0
  // are numbered, and truthiness called them unnumbered - so the two lines of one
  // overlay named the same episode two different ways.
  return item.parentIndex !== undefined && item.index !== undefined ? `S${item.parentIndex}E${item.index}` : null;
}

/** What the store says when the box is showing nothing. */
const STOPPED = {
  current: null,
  state: "stopped",
  positionMs: 0,
  seekTargetMs: null,
  seekFromMs: null,
  scrubMs: null,
  overlay: false,
  buffering: false,
} as const satisfies Partial<PlayerState>;

/**
 * Which step a claim belongs to.
 *
 * Not the item: with the outgoing film left on screen, a step that was given up
 * and the step after it are both aimed at the SAME episode object - so comparing
 * items let an abandoned call's cleanup clear a live claim, which is the failure
 * this guard exists for.
 */
let moveSeq = 0;

/**
 * The outgoing film's last word is being said.
 *
 * Past this there is nothing to go back to - its progress has been reported and
 * its session ended - so a cancel arriving here is ignored and the swap is
 * allowed to finish. Measured before: the same Back gave two opposite results
 * depending on a window nobody can see, and the destructive one was the wrong
 * one - it stopped the film the press was trying to keep.
 */
let handingOver = 0;

/** A restart is in flight. See changeTracks. */
let restarting = false;
let upNextTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Which play() call is current.
 *
 * The sibling lookup races the decision, and `current` cannot be the referee:
 * it is set after three round trips while children() takes one, so checking
 * against it rejected the legitimate answer nearly every time - and the routes
 * that rely on the lookup lost their prev/next buttons entirely.
 */
let playToken = 0;
/**
 * Which `play` last wrote the running order and the neighbours.
 *
 * `forThis !== playToken` cannot tell a CANCEL from a later play, and a later
 * play has already written its own by then - so an abandoned call's cleanup
 * cleared the state of the film that really was playing: no prev/next buttons, no
 * auto-advance at the end, and a spoken "next episode" answered "nothing follows
 * this". Tokens only rise, so a bigger one here means somebody newer owns it.
 */
let orderToken = 0;
/** Long enough to read the title, short enough not to be a wait. */
const UP_NEXT_MS = 5_000;
/**
 * How long a prev/next step may hold the screen before it gives up the claim.
 *
 * Not a cancel - nothing here can take back a request already in flight - it
 * only stops the CLAIM outliving the move. The Plex request layer has no timeout
 * of its own, so a server that accepts the connection and never answers would
 * otherwise leave this set for good: one line on screen, the browsing screen
 * hidden behind it and Back swallowed, which is a worse remote than the one this
 * fixes. Past it the screen does what it did before, and a second press is
 * somebody who has waited long enough to mean it.
 */
const MOVE_GIVE_UP_MS = 12_000;
/**
 * How long after a start `buffering` still means "it is coming".
 *
 * `buffering` is cleared by an event from the box, and the box does not always
 * send one: `tvbox.play()` confirms nothing, and a refused play produces no
 * events at all - measured 2 attempts in 5 when the app is not the foreground
 * one. So the flag can stay true for ever, and anything that refuses on it
 * refuses for ever with it. This is what keeps the prev/next buttons from dying
 * on a box that is showing nothing, and it is generous: the shell's own note
 * puts a Plex film at well over five seconds to appear.
 */
const SETTLE_MAX_MS = 10_000;
/** How long "that could not be started" is still an answer to the press. */
const STEP_FAILED_MS = 8_000;
let stepFailedTimer: ReturnType<typeof setTimeout> | null = null;

/** When the box was last asked to show something. See `stillSettling`. */
let startedAt = 0;
/** Whether it has said it did. Set by the box's own event, never by asking it. */
let shownYet = false;
let unsubscribePlayer: (() => void) | null = null;
let currentBackend: MediaBackend | null = null;
let lifecycleWired = false;

export const usePlayer = create<PlayerState>((set, get) => ({
  current: null,
  state: "stopped",
  positionMs: 0,
  durationMs: 0,
  buffering: false,
  seekTargetMs: null,
  seekFromMs: null,
  scrubMs: null,
  siblings: {},
  moving: null,
  stepFailed: null,
  upNext: null,
  subDelaySec: 0,
  overlay: false,
  error: null,

  cancelUpNext() {
    if (upNextTimer) clearTimeout(upNextTimer);
    upNextTimer = null;
    set({ upNext: null });
  },

  cancelMove(force) {
    if (!get().moving) return;
    // Only the newest play's hand-over may refuse a cancel. An older call can be
    // in one while somebody starts a step of their own - measured, and the cancel
    // for THAT step was then eaten by a window belonging to another call.
    if (handingOver === playToken && force !== true) return;
    // The sequence moves as well, so the cancelled step's own cleanup cannot
    // reach a claim taken after it.
    moveSeq += 1;
    // The request cannot be unsent, so what is cancelled is the CLAIM: the token
    // moves, and `play` checks it before it tells the box anything. Without that
    // the episode somebody had just pressed out of arrived on screen seconds
    // later, over whatever they had gone to instead.
    playToken += 1;
    set({ moving: null });
  },

  async playSibling(which) {
    const item = get().siblings[which];
    if (!item || !currentBackend) return undefined;
    // One move at a time, and the flag is set before the first await so a second
    // press cannot get past this line. Each press used to start its own episode
    // from whatever `siblings` held by then, which is how pressing the button
    // three times stepped three episodes.
    if (get().moving) return undefined;
    // Nor while the box has not shown the LAST one yet. `play` sets `current`
    // before the file has started - the box is told after it - so the overlay
    // comes back over a black screen with the buttons focusable again, and a
    // press there stepped another episode.
    if (stillSettling()) return undefined;
    const mine = ++moveSeq;
    set({ moving: item, stepFailed: null });
    const giveUp = setTimeout(() => {
      if (moveSeq === mine) set({ moving: null });
    }, MOVE_GIVE_UP_MS);
    try {
      // The queue travels with the move, or stepping once through a playlist
      // would land on an item that no longer knows it is in one.
      await get().play(currentBackend, item, { resume: false, queue: get().queue });
    } finally {
      // In a finally, because a stream that cannot be resolved leaves `current`
      // null - and a flag stuck on would leave the player showing a move that
      // is not happening, with the browsing screen hidden behind it.
      //
      // Only its OWN claim, on the same test the timer uses. A request the timer
      // gave up on can still land, minutes later: unguarded, its `finally`
      // cleared the claim of the move somebody had started in the meantime, so
      // the screens came back over a stopped player and that episode arrived
      // underneath them.
      clearTimeout(giveUp);
      if (moveSeq === mine) {
        // What the person asked for, and whether it happened - the only thing the
        // overlay is entitled to say a press failed about. Cleared by the next
        // step, by anything that starts, and by its own timer, because a line
        // about a press should not outlive the press by much.
        const failed = get().current?.item.id !== item.id;
        set({ moving: null, stepFailed: failed ? (episodeLabel(item) ?? item.title) : null });
        if (failed) {
          if (stepFailedTimer) clearTimeout(stepFailedTimer);
          stepFailedTimer = setTimeout(() => set({ stepFailed: null }), STEP_FAILED_MS);
        }
      }
    }
    return item;
  },

  async play(backend, item, opts) {
    const tv = bridge();
    if (!tv?.play) {
      set({ error: "no player on this box" });
      return;
    }

    // This call's own number, taken BEFORE anything is awaited. Everything below
    // is on the far side of five round trips, and by then a later play - or a
    // Back out of a step - may have moved it on; what lands then is an answer to
    // a question nobody is asking any more.
    //
    // Before the teardown, not after it, and that is the whole point: the last
    // word for the previous episode is two server round trips, which on a slow
    // server is most of the step. Taken afterwards, this bump OVERWROTE a cancel
    // that arrived during them - so Back was eaten, the screens came back, and
    // the episode landed on top of them anyway.
    playToken += 1;
    const forThis = playToken;
    // Before the resolve, not after it. The auto-advance timer is five seconds
    // and the resolve is three round trips, so left armed it fired first, bumped
    // the token and abandoned the call it raced: measured, a film asked for by
    // voice during the countdown was replaced by the next episode.
    get().cancelUpNext();
    // Last time's failure is not this attempt's. `error` had no owner and no
    // clear except a successful start, so the line it draws came back beside the
    // title of a film that was playing perfectly well.
    if (get().error) set({ error: null });
    if (get().stepFailed) {
      if (stepFailedTimer) clearTimeout(stepFailedTimer);
      set({ stepFailed: null });
    }

    // THE NEW FILE IS RESOLVED BEFORE THE OLD ONE IS TOUCHED, and that ordering
    // is the whole of a fix rather than a tidy-up.
    //
    // The box keeps its display mode for as long as something is claiming it, and
    // the shell's own `launchMpv` relies on that: it stops the running mpv with
    // `keepMode` set, because "releasing in between would blank the TV twice".
    // Telling the box to stop FIRST threw that away - the mode went back to the
    // UI's, then the new file claimed it again, and a mode switch blanks HDMI for
    // one to three seconds. Measured on a box's own compositor log: 1920x1080@24
    // on play, 1360x768@60 on stop, and back. Two blanks per episode change, and
    // the second one is where the new episode's first seconds went.
    //
    // Resolving first buys the other half too: a stream that cannot be resolved
    // now leaves the film that is playing alone, where before the box had already
    // been stopped by the time the request failed.
    const session = randomSession();
    const choice = {
      version: opts?.version ?? 0,
      audio: opts?.audio,
      subtitle: opts?.subtitle,
      maxBitrateKbps: opts?.maxBitrateKbps,
    };
    let decision: StreamDecision;
    let markers: Marker[] = [];
    let detail: ItemDetail | undefined;
    try {
      [decision, markers, detail] = await Promise.all([
        backend.resolveStream(item.id, {
          session,
          panel: tv.panel ?? null,
          version: choice.version,
          // Named by the caller or not at all. `changeTracks` reads it off the
          // item that is playing and passes it in, which is the only case there
          // is - a version SWITCH. Reading it here from `current` would now be
          // reading the OUTGOING film, because it is still on screen.
          partId: opts?.partId,
          audio: choice.audio,
          subtitle: choice.subtitle,
          maxBitrateKbps: choice.maxBitrateKbps,
        }),
        backend.markers(item.id).catch(() => []),
        // Needed for the track menu, and cheap: the same document the decision
        // path already fetched is still cached.
        backend.item(item.id).catch(() => undefined),
      ]);
    } catch (e) {
      log.warn("could not resolve a stream", e);
      // Nobody is waiting for this one, so its failure is not news about whatever
      // is playing now: an abandoned call's late failure used to write the line
      // onto the film that had replaced it.
      if (forThis === playToken) set({ error: "unplayable" });
      return;
    }

    // Nobody is waiting for this any more. Nothing has been torn down yet, so
    // there is nothing to put back - only the session to close, or it sits on the
    // server as a transcode nothing will ever stop. `abandoned` must NOT run
    // here: the film still playing owns the running order.
    if (forThis !== playToken) {
      if (decision.session) void backend.endSession(decision.session).catch(() => {});
      return;
    }

    // Now the outgoing film's last word - its progress and its session - without
    // telling the box anything. The picture stays up until `tv.play` below
    // replaces it, so there is no gap to look at and no second mode change.
    //
    // Which film that is, remembered for the abandon below: the last word is two
    // server round trips and anything can have taken the box by the time it
    // returns. The STREAM, because `play` resolves a fresh one each time: an id
    // cannot tell two plays of the same film apart - a subtitle change during a
    // step restarts the same episode, and comparing ids tore it off the screen -
    // while the wrapper object is replaced by a track switch that started no new
    // play at all.
    const outgoing = get().current?.decision;
    handingOver = forThis;
    try {
      await get().stop({ handOver: true });
    } finally {
      if (handingOver === forThis) handingOver = 0;
    }

    // Somebody gave this up while that was in flight. Here `abandoned` IS right:
    // the outgoing film has been closed off, and what is left in the store is a
    // plan nobody is following.
    if (forThis !== playToken) {
      if (decision.session) void backend.endSession(decision.session).catch(() => {});
      // The hand-over deliberately left the box playing and the store saying so,
      // because something was about to replace it. Nothing will now, so this is
      // where it really stops - and the store has to say that too, or the page
      // goes on drawing an overlay for a film the box is no longer showing.
      //
      // Only what this call was holding, and that is not a formality: these two
      // lines used to run at the top of `stop`, before any await, where nothing
      // could have overtaken them. They now land two round trips later. Measured
      // both ways - a newer film that had really started was torn off the screen,
      // and a song that had taken the player was silenced while the music store
      // went on saying it was playing.
      if (ownsPlayer("video") && get().current?.decision === outgoing) {
        releasePlayer("video");
        bridge()?.stop?.();
        startedAt = 0;
        set(STOPPED);
      }
      return abandoned(forThis, set, get);
    }
    currentBackend = backend;
    // The episodes either side, worked out HERE rather than by whoever pressed
    // play. A film can be started from a season screen, a carry-on-watching
    // row, a search result or a person's credits, and only one of those knew
    // what the episode was part of - so the buttons appeared on one route and
    // not the others.
    orderToken = forThis;
    set({ siblings: {}, subDelaySec: 0 });

    const queue = opts?.queue;
    const inQueue = queue ? queue.findIndex((q) => q.id === item.id) : -1;
    set({ queue });
    if (inQueue >= 0 && queue) {
      set({ siblings: { prev: queue[inQueue - 1], next: queue[inQueue + 1] } });
    } else if (item.kind === "episode" && item.parentId) {
      // No list to follow, so the series is the list: this is the carry-on
      // watching route, and a search result, and a person's credits.
      const mine = playToken;
      const started = item.id;
      void backend
        .children(item.parentId)
        .then((kids) => {
          // The answer can land after somebody has moved on.
          if (mine !== playToken) return;
          const at = kids.findIndex((k) => k.id === started);
          if (at >= 0) set({ siblings: { prev: kids[at - 1], next: kids[at + 1] } });
        })
        .catch(() => {
          /* no neighbours is the same as not knowing them */
        });
    }

    // An explicit start wins over both: a controller that names an offset has
    // said where to begin, and the server's own resume point is then simply a
    // different answer to a question nobody asked.
    const named = opts?.startMs;
    const resumeFrom = named !== undefined ? named : opts?.resume === false ? 0 : (item.viewOffsetMs ?? 0);
    // Seconds, and for a RESUME point only when it is worth it: resuming a film
    // four seconds in is more surprising than starting it. An offset somebody
    // named is not a resume point and is honoured whatever its size - the
    // threshold used to swallow it, so a controller asking for five seconds in
    // got the beginning while the bar said five seconds.
    const startSec =
      named !== undefined
        ? Math.floor(Math.max(0, named) / 1000)
        : resumeFrom > 10_000
          ? Math.floor(resumeFrom / 1000)
          : 0;

    startedAt = Date.now();
    shownYet = false;
    set({
      current: { item, decision, markers, detail, choice },
      state: "playing",
      positionMs: resumeFrom,
      durationMs: item.durationMs ?? 0,
      buffering: true,
      seekTargetMs: null,
      seekFromMs: null,
      scrubMs: null,
      overlay: true,
      error: null,
    });

    wirePlayerEvents(set, get);
    wireLifecycle();

    // Immediately before the URL goes out, so a film started over music silences
    // the queue rather than leaving it advancing into the film's own audio.
    claimPlayer("video");

    tv.play(
      decision.url,
      {
        // The tri-state matters: leaving subtitles unset lets the player honour
        // whatever the container marks as default, which is not the same as off.
        sub: decision.sub === "no" ? -1 : typeof decision.sub === "number" ? decision.sub : undefined,
        audio: decision.audio === "no" ? -1 : typeof decision.audio === "number" ? decision.audio : undefined,
        subFile: decision.subFile,
      },
      startSec,
    );

    scheduler?.stopTimer();
    scheduler = new PlaybackScheduler({
      backend,
      position: () => get().positionMs,
      state: () => get().state,
      nowPlaying: () => nowPlayingFor(get()),
      postNowPlaying,
    });
    scheduler.start({ itemId: item.id, durationMs: item.durationMs ?? 0, session: decision.session });
  },

  /**
   * Switch what is playing without losing the place.
   *
   * A subtitle or audio change on a file the box is playing as-is is a local
   * switch: the player already has every track, so nothing has to be fetched
   * and the picture does not blink. Anything else - a different file, or a
   * stream the server is converting - has to be rebuilt, because the tracks
   * were baked into it when it started.
   *
   * Either way the server is told, so the choice survives into the next episode
   * and onto whatever plays it next.
   */
  async changeTracks(choice) {
    const s = get();
    const cur = s.current;
    if (!cur) return;
    // A restart is a stop, a network round trip and a start. A second press
    // during that window started its own, and the first one's transcode was
    // left running on the server with nothing left to stop it.
    if (restarting) return;

    const sameVersion = choice.version === cur.choice.version;
    // A ceiling is decided when the stream is built, so changing it means
    // building a new one - the running stream cannot be re-rated. Anything that
    // changes it therefore takes the restart path, even when the tracks did not
    // move.
    const sameQuality = choice.maxBitrateKbps === cur.choice.maxBitrateKbps;
    const localSwitch = sameVersion && sameQuality && !cur.decision.transcoded;
    // seekTargetMs first: a committed scrub is where the film is GOING, and the
    // bridge has not reported back yet when a restart follows straight after -
    // so restarting on positionMs threw the jump away and resumed where the
    // person had just left.
    const at = s.seekTargetMs ?? s.positionMs;

    if (localSwitch) {
      set({ current: { ...cur, choice } });
      const v = cur.detail?.versions[choice.version];
      // BY ORDINAL, not by array position. They agree for embedded tracks and
      // they do not for a sidecar, whose ordinal is negative - so indexing with
      // one read off the end and the choice was written nowhere.
      const subTrack =
        typeof choice.subtitle === "number" ? v?.subtitles.find((x) => x.ordinal === choice.subtitle) : undefined;
      const subFile = subTrack ? currentBackend?.subtitleFileUrl(subTrack) : undefined;

      // A sidecar is added to the running file by NAME, and the shell answers a
      // selection carrying one with that alone - so an audio change made in the
      // same press would be dropped. Sent as its own call ahead of it.
      const tv = bridge();
      if (subFile) {
        if (choice.audio !== undefined) void tv?.selectStreams?.({ audio: choice.audio });
        void tv?.selectStreams?.({ subFile });
      } else {
        void tv?.selectStreams?.({
          audio: choice.audio,
          // A sidecar we could not turn into a file must not travel as its
          // ordinal: negative means "off" to the player, and the second sidecar
          // of an item meant nothing at all - no command, while the menu showed
          // the row as chosen.
          sub: choice.subtitle === "none" || subTrack?.external ? -1 : choice.subtitle,
        });
      }
      if (currentBackend) {
        const subtitleId =
          choice.subtitle === "none" ? "none" : choice.subtitle !== undefined ? subTrack?.id : undefined;
        if (choice.subtitle !== undefined && choice.subtitle !== "none" && !subtitleId)
          log.warn(`no subtitle track ${choice.subtitle} on version ${choice.version}`);
        void currentBackend
          .setTracks(cur.item.id, choice.version, {
            audioId: choice.audio !== undefined ? v?.audio[choice.audio]?.id : undefined,
            subtitleId,
          })
          .catch((e: unknown) => log.warn("could not remember track choice", e));
      }
      return;
    }

    if (!currentBackend) return;
    // Restart where it was, not where the item was left last time - the resume
    // point on the server is behind by up to the report interval.
    // The choice has to travel with the restart. Without it the new stream
    // carries the OLD tracks while the menu shows the new ones selected - and on
    // a converted stream that is the only path there is, because the tracks were
    // baked in when it started.
    restarting = true;
    try {
      await get().play(
        currentBackend,
        { ...cur.item, viewOffsetMs: at },
        {
          version: choice.version,
          // Known only once this title's files have been listed, which is the
          // second play onwards - a version SWITCH. The first play has nothing
          // to name yet, and asks for the position it was given.
          partId: get().current?.detail?.versions[choice.version]?.partId,
          audio: choice.audio,
          maxBitrateKbps: choice.maxBitrateKbps,
          subtitle: choice.subtitle,
          // `play` sets the running order from what it is handed, so a restart
          // that omits it clears it: changing quality or audio part-way through
          // a playlist took the next and previous buttons away, and on an
          // episode replaced the playlist's order with the series' own.
          queue: get().queue,
        },
      );
    } finally {
      restarting = false;
    }
  },

  togglePause() {
    const tv = bridge();
    const paused = get().state === "paused";
    if (paused) tv?.resume?.();
    else tv?.pause?.();
    set({ state: paused ? "playing" : "paused", overlay: true });
    void scheduler?.flush(paused ? "resume" : "pause");
  },

  seekBy(deltaMs) {
    const { positionMs, durationMs, seekTargetMs } = get();
    const from = seekTargetMs ?? positionMs;
    get().seekTo(Math.max(0, Math.min(durationMs || Number.MAX_SAFE_INTEGER, from + deltaMs)));
  },

  scrubBy(deltaMs) {
    const { positionMs, durationMs, seekTargetMs, scrubMs } = get();
    const from = scrubMs ?? seekTargetMs ?? positionMs;
    const to = Math.max(0, Math.min(durationMs || Number.MAX_SAFE_INTEGER, from + deltaMs));
    set({ scrubMs: to, overlay: true });
  },

  commitScrub() {
    const { scrubMs } = get();
    if (scrubMs === null) return;
    set({ scrubMs: null });
    get().seekTo(scrubMs);
  },

  cancelScrub() {
    set({ scrubMs: null });
  },

  seekTo(ms) {
    // Shown immediately and reconciled when the player reports back, so the bar
    // never appears to jump backwards after a press.
    set({ seekTargetMs: ms, seekFromMs: get().positionMs, overlay: true });
    bridge()?.seek?.(Math.floor(ms / 1000));
    void scheduler?.flush("seek");
  },

  async stop(opts) {
    if (!get().current) return;
    const handOver = opts?.handOver === true;
    // Nothing was asked for, so nothing is settling. Without this a film that
    // never appeared left the window open with the box showing nothing. A
    // hand-over is the opposite - something WAS asked for - and the window is
    // stamped again when the new file's `current` goes in.
    if (!handOver) startedAt = 0;
    // Before the bridge call, so an event racing the stop is already ignored.
    // Neither happens on a hand-over: the box is about to be given a new file,
    // and telling it to stop first is what makes the television blank twice.
    if (!handOver) {
      releasePlayer("video");
      bridge()?.stop?.();
    }
    unsubscribePlayer?.();
    unsubscribePlayer = null;
    // Compared after the await, because ending one is two server round trips and
    // a newer film can have installed its own in the meantime: nulling that one
    // left its progress unreported, its transcode un-pinged and nothing able to
    // reach the timer still running behind it.
    const mine = scheduler;
    // The stream, not the wrapper. `changeTracks`' local switch and a subtitle
    // download both replace `current` with a re-wrap of the same play, and an
    // object comparison read that as "somebody else took the box" - so the reset
    // was skipped after the release and the bridge stop had already gone out,
    // leaving the store saying a film was playing over a stopped box.
    const was = get().current?.decision;
    await mine?.end();
    if (scheduler === mine) scheduler = null;
    // The picture stays until the new one replaces it, so the store keeps saying
    // what the box is really showing. Clearing it here left the page with nothing
    // on it for the length of the swap.
    if (handOver) return;
    // Same window as the scheduler pointer above, and the same test: a film that
    // started while this was saying the last one's goodbye is on the box, and
    // saying "stopped" over it unhid the browsing screens, painted the portalled
    // backdrop over the picture and took the overlay and its keys away.
    if (get().current?.decision !== was) return;
    set(STOPPED);
  },

  showOverlay(on) {
    set({ overlay: on });
  },

  nudgeSubDelay(deltaSec) {
    // Clamped to what the shell will accept. Out of range it refuses the value
    // outright, which would leave the number on screen disagreeing with the
    // subtitles - the shell's own note says a refusal must not read as success.
    const next = Math.min(120, Math.max(-120, Math.round((get().subDelaySec + deltaSec) * 100) / 100));
    set({ subDelaySec: next });
    const tv = bridge();
    void Promise.resolve(tv?.setPlayerProp?.("sub-delay", next)).then((r) => {
      if (r && typeof r === "object" && "ok" in r && !r.ok) log.warn("player refused sub-delay");
    });
  },

  activeMarker() {
    const { current, positionMs } = get();
    if (!current) return null;
    return current.markers.find((m) => positionMs >= m.startMs && positionMs < m.endMs) ?? null;
  },

  skipMarker() {
    const marker = get().activeMarker();
    if (marker) get().seekTo(marker.endMs);
  },
}));

/**
 * Whether the box is showing a film.
 *
 * One expression in one place because two things have to agree about it: the
 * browsing screens are hidden on this, and the home screen's backdrop - which is
 * portalled OUT of the hidden page, so nothing the page does to itself reaches
 * it - is dropped on this. A backdrop that outlives the hiding paints four
 * full-screen layers over the picture; one that goes early leaves the rows on a
 * black page.
 *
 * `current` alone, and a step in flight is deliberately NOT counted. It was, for
 * as long as a step tore the picture down: the screens had to stay hidden over
 * the gap. A step keeps the outgoing picture up now, so `current` covers that -
 * and where a step really does run with nothing playing, which is a spoken "next
 * episode" during the end-of-episode countdown, the right thing is the opposite.
 * Hiding then left the television black with the countdown behind it, where
 * leaving the season list up shows exactly what is happening.
 *
 * `useTheme` asks the same question for consistency rather than for a hole of
 * its own - what keeps a theme out of a gap is that playback already silenced it.
 */
export function useShowingPlayer(): boolean {
  return usePlayer((s) => s.current !== null);
}

/**
 * The box has not shown what it was last asked to play, and it still might.
 *
 * Keyed on the box's own first-frame event rather than on `buffering`, which is
 * the same question asked worse: the flag is also set by an ordinary stall on a
 * transcoded stream, so a rebuffer eight seconds into a film was treated as a
 * start - the one case the callers all say they exclude.
 *
 * Bounded in time as well, because the event may never come: `tvbox.play()`
 * confirms nothing and a refused play produces no events at all - measured 2
 * attempts in 5 when the app is not the foreground one. Anything that refuses on
 * this would otherwise refuse for ever, which killed the prev/next buttons on a
 * box showing nothing and had the assistant answer for it.
 */
export function stillSettling(): boolean {
  return !shownYet && Date.now() - startedAt < SETTLE_MAX_MS;
}

/** How much of that window is left, for a caller that has to wait it out. */
export function settleRemainingMs(): number {
  return stillSettling() ? Math.max(0, SETTLE_MAX_MS - (Date.now() - startedAt)) : 0;
}

function randomSession(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `s${Math.floor(Math.random() * 1e12).toString(36)}`;
}

function nowPlayingFor(s: PlayerState): NowPlayingReport {
  const item = s.current?.item;
  if (!item) return { state: "idle" };
  return {
    state: s.state === "paused" ? "paused" : "playing",
    title: item.title,
    // The series and episode number is what makes the card readable elsewhere.
    artist:
      item.grandparentTitle && item.parentIndex !== undefined && item.index !== undefined
        ? `${item.grandparentTitle} — S${item.parentIndex}E${item.index}`
        : item.grandparentTitle,
  };
}

/**
 * Music took the player.
 *
 * The film is already gone - the shell replaced what it was playing - so this
 * tidies up after it rather than stopping anything: the server session is ended,
 * the overlay comes down, and an armed "next episode" countdown is cancelled.
 * That countdown is the one that would otherwise bite: five seconds after
 * somebody put music on, it would start an episode over it.
 */
whenPlayerLost("video", () => {
  const s = usePlayer.getState();
  usePlayer.getState().cancelUpNext();
  if (!s.current) return;
  void scheduler?.end();
  scheduler = null;
  const session = s.current.decision.session;
  if (session && currentBackend) void currentBackend.endSession(session).catch(() => {});
  postNowPlaying({ state: "idle" });
  // Nothing was asked for any more, so nothing is settling - the same reason
  // `stop` does this.
  startedAt = 0;
  usePlayer.setState(STOPPED);
});

type Setter = (partial: Partial<PlayerState>) => void;

function wirePlayerEvents(set: Setter, get: () => PlayerState): void {
  const tv = bridge();
  if (!tv?.onPlayer) return;
  unsubscribePlayer?.();

  unsubscribePlayer = tv.onPlayer((ev) => {
    // Every listener hears every event, and music drives the same player. Without
    // this, a song ending arrives here as a film that finished nowhere near its
    // end - which is the one case that calls stop(), so the next track would be
    // silenced a moment after it started.
    if (heldByAnother("video")) return;
    switch (ev.type) {
      case "position": {
        const ms = ev.ms ?? 0;
        const target = get().seekTargetMs;
        // A seek is settled once the player reports where it was sent - within
        // a window, or anywhere PAST the target in the direction it was sent.
        // Until then its own position is still the old one, so the bar would
        // jump backwards without this.
        //
        // The direction is the half a window alone missed. A forward seek that
        // lands a few seconds beyond the target, on the next keyframe, never
        // reports inside the window again - so the target stuck forever and the
        // bar and the clock froze at it while the film played on. Testing
        // "past" without the direction is just as wrong the other way: on a
        // backward seek every stale position is already past it, so the target
        // would clear on the first report and the bar would snap back.
        const from = get().seekFromMs;
        // Settled once the report is nearer where it was SENT than where it came
        // from. Direction alone was not enough: a backward seek lands on the
        // first keyframe AFTER its target and then plays away from it, so
        // "ms <= target" was never satisfied and the bar and clock froze at the
        // target for the rest of the film - and every later jump and scrub takes
        // seekTargetMs as its origin, so they were all measured from a stale
        // number. Comparing the two distances handles a late landing in either
        // direction and still holds every stale report.
        const settled =
          target === null ||
          Math.abs(ms - target) < 2_000 ||
          from === null ||
          // A seek to where the film already is has nothing to wait for, and the
          // distance test degenerates to "x < x" there - so it could only ever
          // settle inside the window, and a rebuffer or an inexact landing left
          // the bar and clock frozen for the rest of the film. Rewind at 0
          // reaches this every time, because the clamp puts the target on the
          // origin.
          from === target ||
          Math.abs(ms - target) < Math.abs(ms - from);
        set({ positionMs: ms, seekTargetMs: settled ? null : target, seekFromMs: settled ? null : from });
        break;
      }
      case "duration":
        if (ev.ms) set({ durationMs: ev.ms });
        break;
      case "playing":
        // The box's own first-frame reveal, which is the only honest answer to
        // "has it shown this yet". Everything that waits for a start waits for
        // this rather than for time to pass.
        shownYet = true;
        set({ state: "playing", buffering: false });
        break;
      case "buffering":
        set({ buffering: ev.on !== false });
        break;
      case "error":
        // Not fatal by itself: the box follows an error with `finished`, and
        // that is where the two cases are told apart.
        set({ error: "playback" });
        break;
      case "finished":
        void handleFinished(ev.reason, get);
        break;
    }
  });
}

/**
 * Nothing is playing and nothing is coming: leave the store saying so.
 *
 * By the second check the hand-over has said the outgoing film's last word, and
 * the neighbours and the running order in the store are still ITS - a plan for a
 * film the box is no longer going to be given. Anything that reads them
 * afterwards is reading something nobody is following.
 */
function abandoned(forThis: number, set: Setter, get: () => PlayerState): void {
  // Not if somebody newer owns the running order: measured, an abandoned call
  // landing after a legitimate one had started took that film's prev/next
  // buttons, its auto-advance and its honest answer to "next episode" with it.
  if (orderToken > forThis) return;
  set({ siblings: {}, queue: undefined, subDelaySec: 0 });
  get().cancelUpNext();
}

/**
 * What to do when playback ends.
 *
 * The hard part is that a file running out and the network dropping look the
 * same: both arrive as `finished` with no reason given. So auto-advance also
 * requires the position to have reached the end - otherwise a lost connection
 * halfway through a film would start the next episode in an empty room.
 *
 * A reason IS given when the box stopped it deliberately - someone pressed stop
 * on a phone, or the television went into standby - and neither of those wants
 * the next episode either.
 */
async function handleFinished(reason: string | undefined, get: () => PlayerState): Promise<void> {
  const s = get();
  const nearEnd = s.durationMs > 0 && s.positionMs >= s.durationMs - NEAR_END_MS;
  const ranOut = !reason && nearEnd;

  const next = s.siblings.next;
  // Whose ending this is. stop() below waits on two round trips, and the
  // overlay is still up meanwhile - so "next episode" pressed over the closing
  // credits starts something, and the countdown armed afterwards replaced it.
  const mine = playToken;
  await get().stop();

  if (!ranOut) {
    if (reason) log.info(`playback ended: ${reason}`);
    else log.warn("playback ended early with no reason - not advancing");
    return;
  }
  // An episode that ran out with another behind it starts the next one by
  // itself, after a countdown anyone can stop. The screen underneath is the
  // season, so the countdown is drawn on the episode it is about to play -
  // there is nothing to invent, only something to point at.
  if (!next || mine !== playToken) return;
  const backend = currentBackend;
  usePlayer.setState({ upNext: { item: next, at: Date.now() + UP_NEXT_MS } });
  if (upNextTimer) clearTimeout(upNextTimer);
  upNextTimer = setTimeout(() => {
    upNextTimer = null;
    const still = usePlayer.getState().upNext;
    usePlayer.setState({ upNext: null });
    // The running order travels with the auto-advance too. Without it a
    // playlist advanced exactly once and then stopped, because the item it
    // landed on had no queue to find a next in; on an episode it was worse than
    // stopping, because the fallback re-derives the order from the SERIES and
    // the playlist's order was silently replaced by it.
    if (still && backend)
      void usePlayer.getState().play(backend, still.item, { resume: false, queue: usePlayer.getState().queue });
  }, UP_NEXT_MS);
}

/** Release server-side state when the app stops being visible (see lifecycle). */
function wireLifecycle(): void {
  if (lifecycleWired) return;
  lifecycleWired = true;

  onRelease(() => {
    // Before anything else: the shell HIDES the window rather than destroying
    // it, and no keypress reaches a hidden app - so a countdown armed when
    // somebody pressed Home would start a film over the launcher five seconds
    // later, with nothing able to cancel it.
    usePlayer.getState().cancelUpNext();
    const s = usePlayer.getState();
    if (!s.current) return;
    // Synchronous-ish and best effort: the page may be frozen immediately after,
    // so this fires the requests and does not wait for them.
    void scheduler?.flush("hidden");
    postNowPlaying({ state: "idle" });
    const session = s.current.decision.session;
    if (session && currentBackend) void currentBackend.endSession(session).catch(() => {});
  });

  onResume(() => {
    // Anything that leaked while hidden is cleaned up by the backend's own
    // startup reconciliation; nothing to do here but note it.
    log.info("visible again");
  });
}

/** Wire the bridge's player events without starting playback. Tests only. */
export function __wirePlayerEventsForTest(): void {
  wirePlayerEvents(
    (partial) => usePlayer.setState(partial),
    () => usePlayer.getState(),
  );
}

/**
 * Forget everything about playback.
 *
 * Called when the identity behind it changes. The backend the countdown
 * captured is module state and outlives a sign-out, so without this a timer
 * armed by one person could start a film as - and for - the next.
 */
export function resetPlayer(): void {
  usePlayer.getState().cancelUpNext();
  void usePlayer.getState().stop();
  currentBackend = null;
  // The token, so a play still in flight does not land. This is called on a
  // sign-out and on a profile switch, and `play` holds its backend as an
  // argument - so clearing `currentBackend` does not reach it. Measured: a cast
  // whose stream resolved after a PIN'd switch started the film anyway and wrote
  // its first progress report with the NEW profile's token, because
  // `switchProfile` rewrites the session in place. After a sign-out it played on
  // over the sign-in screen with a revoked credential.
  playToken += 1;
  usePlayer.setState({ siblings: {}, moving: null, stepFailed: null, queue: undefined, upNext: null, subDelaySec: 0 });
}

// A queue of songs, and the box playing it.
//
// Separate from `player.ts` rather than folded into it, because almost nothing
// they do is the same. A film is one item with versions, subtitle tracks, a
// transcode decision and a resume point; a song is a file and the next file. The
// one thing they share is the box's single player, and that is handled by
// `owner.ts` rather than by making one store serve both.
//
// The shell has no queue: `play(url)` takes one file, so the next track is
// started by this module when the box says the last one finished. That leaves a
// gap between tracks - accepted deliberately, and measured rather than assumed.

import { create } from "zustand";
import type { MediaBackend, MediaItem, PlaybackState } from "../backends/types";
import { PlaybackScheduler, type NowPlayingReport } from "./scheduler";
import { claimPlayer, ownsPlayer, releasePlayer, whenPlayerLost } from "./owner";
import { onRelease } from "../lifecycle";
import { log } from "../redact";

export type RepeatMode = "off" | "all" | "one";

/**
 * How close to the end counts as "it ran out".
 *
 * The film player allows fifteen seconds, which is a rounding error in a
 * two-hour film and a fifth of a short song. A dropped stream and a file running
 * out both arrive as `finished` with no reason, so this is the only thing
 * telling them apart - too generous and a lost connection walks the whole queue.
 */
const NEAR_END_MS = 4_000;

/**
 * How long a start may take before it is treated as one that never happened.
 *
 * `window.tvbox.play()` returns nothing and reports nothing: the shell answers
 * its own IPC with `{ok:false}` when the calling app is not the foreground one,
 * and the preload discards that answer. Measured on the box - twice in five
 * attempts the shell refused, no mpv started, and the screen sat at 0:00 reading
 * "pause" for ever, while the scheduler told Plex and the household's
 * now-playing topic that a silent track was playing. The shell's auto-update
 * idle gate reads that topic, so the box also stops applying OTA updates.
 *
 * The film path learned this already and checks that playback really started.
 * Generous, because a cold network start on this library was measured just under
 * a second and a slow one is not a failure.
 */
const START_TIMEOUT_MS = 12_000;

/**
 * How far into a track counts as a place worth going back to.
 *
 * The film player allows ten seconds, and a song is a fortieth of a film - but
 * the direction that costs something is the other one: resuming a three-minute
 * song fifteen seconds in is a verse missed, while restarting an hour-long set
 * is the whole thing again. So this is generous where the film's is cautious,
 * and the near-end test below is what keeps the last few seconds of a track from
 * becoming a resume point that plays nothing.
 */
const RESUME_MIN_MS = 15_000;

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

/**
 * Fisher-Yates over a copy.
 *
 * A sort with a random comparator is the common shortcut and is not a shuffle:
 * it is biased, and worse, an inconsistent comparator is undefined behaviour in
 * a sort - V8 is entitled to do anything with it.
 */
function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface MusicState {
  /** The running order, which is the shuffled one while shuffle is on. */
  queue: MediaItem[];
  /**
   * The order as it was handed over, kept so shuffle can be switched OFF.
   * Without it, turning shuffle off would leave the shuffled order in place and
   * the switch would appear to do nothing.
   */
  source: MediaItem[];
  index: number;
  state: PlaybackState;
  positionMs: number;
  durationMs: number;
  buffering: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Set when a track could not be started; cleared by the next one that can. */
  error: string | null;
  /**
   * Where the track at `index` was left, when it was left part-way through.
   *
   * The server's own offset covers a queue built after the app was restarted;
   * this covers the same evening, where it is both fresher and the only thing
   * there is - a stop reports the position to the server, but the queue survives
   * a stop and reading it back would cost a round trip on a press that is meant
   * to be instant. Cleared by the start that consumes it.
   */
  resume: { index: number; ms: number } | null;
  /**
   * Browsing to ADD rather than to play.
   *
   * A mode rather than a second action on every row: what somebody is doing when
   * they build a queue is adding one song after another, and a per-row menu makes
   * that two presses each. It lives in the store because the point of it is to
   * survive walking from one album to the next, which unmounts every screen it
   * was turned on from.
   *
   * Nothing about it may be invisible - a mode where OK does something other than
   * what it usually does is the classic remote trap - so the banner it draws is
   * part of the feature rather than decoration.
   */
  adding: boolean;
  /** Songs added since the mode was turned on, which is what the banner counts. */
  added: number;

  /**
   * Where the scrub cursor points, while it is out.
   *
   * Null means there is no cursor and the bar simply shows the song. Held here
   * rather than in the screen because the screen unmounts - browsing away and
   * coming back must not leave a cursor nobody can see pointing at a seek that
   * was never asked for.
   */
  scrubMs: number | null;

  /**
   * A spoken request to show or hide the lyrics.
   *
   * Here rather than in the screen that draws them, for the reason the whole
   * module is: music plays while the box is somewhere else entirely, so the
   * screen holding the lyrics panel is usually not mounted when the request
   * arrives. `at` is what makes the same request twice fire twice - somebody
   * asking again because the television was showing something else.
   */
  lyricsAsk: { state: string; at: number } | null;

  playQueue(
    backend: MediaBackend,
    tracks: MediaItem[],
    opts?: { startIndex?: number; shuffle?: boolean },
  ): Promise<void>;
  /** `fromStart` is the advance's own decision: reaching the next track, or
   *  pressing Previous over one already playing, means its beginning. */
  playAt(index: number, opts?: { fromStart?: boolean }): Promise<void>;
  /** `auto` marks the advance the box asked for, which is the only one that
   *  honours repeat-one - pressing Next over a repeating song means the next. */
  next(auto?: boolean): Promise<void>;
  previous(): Promise<void>;
  toggle(): void;
  seek(ms: number): void;
  /** Move the cursor without moving the music. */
  scrubBy(deltaMs: number): void;
  /** Go where the cursor points. */
  commitScrub(): void;
  cancelScrub(): void;
  stop(): Promise<void>;
  /**
   * Add songs without starting anything.
   *
   * Takes the backend for the same reason `playQueue` does: the module keeps ONE
   * of them, and it is what turns a track into a URL. A queue built only by
   * adding used to leave it unset, so Play on that queue reached `playAt`, found
   * no backend and returned - no sound, no error, nothing on screen. Measured on
   * the box, and invisible in any session where something had been played first.
   */
  enqueue(be: MediaBackend, tracks: MediaItem[], where: "next" | "end"): void;
  setAdding(on: boolean): void;
  removeAt(index: number): void;
  setShuffle(on: boolean): void;
  setRepeat(mode: RepeatMode): void;
  askLyrics(state: string): void;
}

let backend: MediaBackend | null = null;
let scheduler: PlaybackScheduler | null = null;
let unsubscribe: (() => void) | null = null;
let lifecycleWired = false;
/** Which start is current, so a slow one cannot report over a newer one. */
let token = 0;
/** Armed at every start, disarmed by the first sign of life from the box. */
let startWatchdog: ReturnType<typeof setTimeout> | null = null;

function disarmWatchdog(): void {
  if (startWatchdog) clearTimeout(startWatchdog);
  startWatchdog = null;
}

export const useMusic = create<MusicState>((set, get) => ({
  queue: [],
  source: [],
  index: -1,
  state: "stopped",
  positionMs: 0,
  durationMs: 0,
  buffering: false,
  shuffle: false,
  repeat: "off",
  error: null,
  resume: null,
  adding: false,
  added: 0,
  scrubMs: null,
  lyricsAsk: null,

  async playQueue(be, tracks, opts) {
    if (!tracks.length) return;
    backend = be;
    const shuffle = opts?.shuffle ?? get().shuffle;
    const start = Math.max(0, Math.min(opts?.startIndex ?? 0, tracks.length - 1));

    // Shuffling puts the chosen track first rather than shuffling it away. The
    // press said "play this one"; a shuffle that starts somewhere else reads as
    // the press having missed.
    const chosen = tracks[start];
    const queue = shuffle ? [chosen, ...shuffled(tracks.filter((_, i) => i !== start))] : tracks;

    set({ source: tracks, queue, index: shuffle ? 0 : start, shuffle });
    await get().playAt(shuffle ? 0 : start);
  },

  async playAt(index, opts) {
    const { queue, resume } = get();
    const item = queue[index];
    const be = backend;
    if (!item || !be) return;

    const url = be.trackUrl(item);
    if (!url) {
      // Skipped rather than stalled: one unplayable file in a queue of hundreds
      // must not end the evening. The message is kept so the screen can say
      // which one, and the advance is not automatic past the end.
      log.warn("no file for track", item.title);
      set({ error: item.title, index });
      if (index + 1 < queue.length) return get().playAt(index + 1);
      // Nowhere left to step to. Without this the store stayed "playing" on a
      // track that never started: the previous track's scheduler kept reporting
      // progress at a frozen position, the household's now-playing topic kept
      // naming a silent song, and the shell's auto-update idle gate reads that
      // topic - so the box would never look idle and OTA updates would stop.
      await get().stop();
      return;
    }

    const tv = bridge();
    wireEvents();
    wireLifecycle();
    const mine = ++token;

    // Where this track is picked up. What this store remembers wins over what the
    // server does: both are the same track, and ours is this evening's.
    const from = opts?.fromStart ? 0 : resume && resume.index === index ? resume.ms : (item.viewOffsetMs ?? 0);
    // Not the last few seconds. A track left there is one that finished, and
    // starting it at its own end plays nothing and advances the queue - the one
    // resume that looks like a broken file.
    const length = item.durationMs ?? 0;
    const startMs = from > RESUME_MIN_MS && (length <= 0 || from < length - NEAR_END_MS) ? from : 0;

    set({
      index,
      state: "playing",
      positionMs: startMs,
      // Seeded from the library rather than waited for: the box reports a
      // duration a moment later, and until then the end-of-track test would have
      // nothing to compare against.
      durationMs: item.durationMs ?? 0,
      buffering: true,
      error: null,
      // Consumed. Leaving it set would make every later press on this index
      // resume to the same second, whatever has happened in between.
      resume: null,
      // A cursor belongs to the song it was opened on. Carried into the next
      // track it would point at a second somewhere in the previous one's length.
      scrubMs: null,
    });

    claimPlayer("music");
    // `kind: "audio"` is the whole difference between a song and a film here.
    // Without it the shell takes the video path: mpv maps a window over this
    // page, "first frame -> reveal video" makes the page transparent, and the
    // occluded window reports itself HIDDEN - which a cast then reads as the app
    // having gone off screen. Measured on the box: a cast started, revealed
    // video, and stopped itself two seconds later.
    tv?.play?.(url, null, Math.floor(startMs / 1000), { kind: "audio" });

    // Nothing above answers, so this is the only thing that can notice a start
    // that did not happen. Disarmed by the first position or playing event.
    disarmWatchdog();
    startWatchdog = setTimeout(() => {
      startWatchdog = null;
      if (mine !== token) return;
      const s = get();
      if (s.state !== "playing" || s.positionMs !== startMs) return;
      log.warn("the box never started this track", item.title);
      set({ error: item.title });
      void get().stop();
    }, START_TIMEOUT_MS);

    scheduler?.stopTimer();
    scheduler = new PlaybackScheduler({
      backend: be,
      position: () => get().positionMs,
      state: () => get().state,
      nowPlaying: () => nowPlayingFor(get()),
      postNowPlaying,
    });
    if (mine === token) scheduler.start({ itemId: item.id, durationMs: item.durationMs ?? 0 });
  },

  async next(auto) {
    const { index, queue, repeat } = get();
    // Reaching a track is not the same as choosing it: an album played from the
    // top must not drop into the middle of a song somebody once left there.
    if (auto && repeat === "one") return get().playAt(index, { fromStart: true });
    const at = index + 1;
    if (at < queue.length) return get().playAt(at, { fromStart: true });
    if (repeat === "all" && queue.length) return get().playAt(0, { fromStart: true });
    await get().stop();
  },

  async previous() {
    const { index, positionMs } = get();
    // Past the first few seconds, Previous restarts the song - which is what the
    // button means everywhere else, and what stops a mis-press losing your place
    // in a queue you cannot see the top of.
    if (positionMs > 3_000 || index <= 0) return get().playAt(Math.max(0, index), { fromStart: true });
    await get().playAt(index - 1, { fromStart: true });
  },

  toggle() {
    const tv = bridge();
    const { state, index, queue } = get();
    if (state === "playing") {
      tv?.pause?.();
      set({ state: "paused" });
    } else if (state === "paused") {
      tv?.resume?.();
      set({ state: "playing" });
    } else if (queue[index]) {
      // Stopped with a queue still in hand - which is what a film taking the
      // player leaves behind, and what the end of a list leaves behind. There is
      // nothing to un-pause, so the button has to START it again. Without this
      // the chip read "Folytatás" and did nothing at all.
      void get().playAt(index);
      return;
    }
    void scheduler?.flush("toggle");
  },

  seek(ms) {
    const at = Math.max(0, Math.min(ms, get().durationMs || ms));
    bridge()?.seek?.(Math.floor(at / 1000));
    set({ positionMs: at, scrubMs: null });
    void scheduler?.flush("seek");
  },

  scrubBy(deltaMs) {
    const { positionMs, durationMs, scrubMs } = get();
    // A cursor that cannot be DRAWN must not move. With no length yet - the
    // library carried none and the box has not read the header - the bar has no
    // scale, so the mark would sit at 0% while the clock beside it ran away, and
    // committing would seek to a time the song does not have. The film player
    // falls back to MAX_SAFE_INTEGER here, which it can afford because a film
    // always arrives with a duration; a track does not.
    if (durationMs <= 0) return;
    // From where the cursor already is, so holding an arrow accelerates through
    // the song rather than fighting the position the box keeps reporting.
    const from = scrubMs ?? positionMs;
    set({ scrubMs: Math.max(0, Math.min(durationMs, from + deltaMs)) });
  },

  commitScrub() {
    const { scrubMs } = get();
    if (scrubMs === null) return;
    get().seek(scrubMs);
  },

  cancelScrub() {
    set({ scrubMs: null });
  },

  async stop() {
    if (get().index < 0 && get().state === "stopped") return;
    disarmWatchdog();
    // Before the position is cleared below. This is what Play means on a queue
    // that is still in hand: carry on, not start again.
    const { index: stoppedAt, positionMs: stoppedMs, durationMs: stoppedOf } = get();
    // A track that ran out leaves its position at the end, and the end is not a
    // place to come back to - the last thing a queue does before stopping is
    // finish its last song.
    const partWay = stoppedMs > RESUME_MIN_MS && (stoppedOf <= 0 || stoppedMs < stoppedOf - NEAR_END_MS);
    // Only OUR player. The queue survives a stop now, so the old guard - index
    // below zero and already stopped - no longer fires, and a second stop while
    // a film holds the box would otherwise reach the shared mpv and stop the
    // film. Ownership is asked before the bridge is touched, not after.
    if (ownsPlayer("music")) bridge()?.stop?.();
    releasePlayer("music");
    unsubscribe?.();
    unsubscribe = null;
    await scheduler?.end();
    scheduler = null;
    // The QUEUE survives a stop. Wiping it turned the end of a list into a dead
    // end: the player screen fell back to "nothing is playing", which draws no
    // focusable at all, and the only way out was Back. Keeping it means the
    // screen still shows what was on and Play starts it again - the same
    // decision already made for a film taking the player away.
    // The LENGTH is kept with the queue. Zeroing it left the player screen
    // showing the track it still names at 0:00 / 0:00, which reads as a broken
    // item rather than a stopped one.
    set({
      state: "stopped",
      positionMs: 0,
      buffering: false,
      scrubMs: null,
      resume: stoppedAt >= 0 && partWay ? { index: stoppedAt, ms: stoppedMs } : null,
    });
  },

  enqueue(be, tracks, where) {
    if (!tracks.length) return;
    backend = be;
    const { queue, index, source, added } = get();
    const at = where === "next" ? Math.max(0, index) + 1 : queue.length;
    set({
      queue: [...queue.slice(0, at), ...tracks, ...queue.slice(at)],
      // The unshuffled order gains them too, or switching shuffle off would
      // silently drop everything that had been queued while it was on.
      source: [...source, ...tracks],
      // A queue built from nothing has to point AT something, or the player
      // screen reads "nothing is playing" over a list it is holding, the bar
      // along the bottom stays away, and Play has no index to start. Nothing is
      // started here: the whole point of adding is that it does not play.
      index: index < 0 ? 0 : index,
      added: added + tracks.length,
    });
  },

  setAdding(on) {
    // The count belongs to one run of the mode, so it starts again each time
    // rather than counting the evening.
    set({ adding: on, added: 0 });
  },

  removeAt(at) {
    const { queue, index } = get();
    if (at < 0 || at >= queue.length || at === index) return;
    set({
      queue: queue.filter((_, i) => i !== at),
      // The playing track keeps its position under it.
      index: at < index ? index - 1 : index,
    });
  },

  setShuffle(on) {
    const { queue, index, source } = get();
    const playing = queue[index];
    if (!playing) {
      set({ shuffle: on });
      return;
    }
    const next = on ? [playing, ...shuffled(source.filter((t) => t.id !== playing.id))] : source;
    set({
      shuffle: on,
      queue: next,
      // Found rather than assumed: switching shuffle off puts the playing track
      // back wherever it sits in the original order, which is not index 0.
      index: on
        ? 0
        : Math.max(
            0,
            next.findIndex((t) => t.id === playing.id),
          ),
    });
  },

  setRepeat(mode) {
    set({ repeat: mode });
  },

  askLyrics(state) {
    set({ lyricsAsk: { state, at: Date.now() } });
  },
}));

function nowPlayingFor(s: MusicState): NowPlayingReport {
  const item = s.queue[s.index];
  return {
    state: s.state === "playing" ? "playing" : s.state === "paused" ? "paused" : "idle",
    title: item?.title,
    artist: item?.grandparentTitle ?? item?.parentTitle,
    // No artwork, matching the film path. This report is republished as a
    // RETAINED MQTT message on a broker with no ACL, and a poster URL carries the
    // server's LAN address and its certificate hash - which is more than the
    // topic said before, for a picture on a card. The title and artist are what
    // the household actually reads there.
    image: undefined,
  };
}

function wireEvents(): void {
  const tv = bridge();
  if (!tv?.onPlayer) return;
  unsubscribe?.();

  unsubscribe = tv.onPlayer((ev) => {
    // The film store listens to the same stream; this is the half of that guard
    // that keeps a film's events out of the queue.
    if (!ownsPlayer("music")) return;
    switch (ev.type) {
      case "position":
        disarmWatchdog();
        useMusic.setState({ positionMs: ev.ms ?? 0 });
        break;
      case "duration":
        // Only when the box knows better. It reports 0 for a stream it has not
        // read the header of yet, and taking that would clear the length seeded
        // from the library - which is what the end-of-track test needs.
        if (ev.ms) useMusic.setState({ durationMs: ev.ms });
        break;
      case "playing":
        useMusic.setState({ state: "playing", buffering: false });
        break;
      case "buffering":
        useMusic.setState({ buffering: ev.on !== false });
        break;
      case "error":
        // Not acted on here: the box follows an error with `finished`, and that
        // is where a file that ran out is told from one that failed.
        useMusic.setState({ error: "playback" });
        break;
      case "finished":
        void handleFinished(ev.reason);
        break;
    }
  });
}

async function handleFinished(reason: string | undefined): Promise<void> {
  const s = useMusic.getState();
  const nearEnd = s.durationMs > 0 && s.positionMs >= s.durationMs - NEAR_END_MS;

  // A reason means the box stopped it on purpose - a phone pressed stop, or the
  // television went to standby. Neither wants the next track.
  if (reason) {
    log.info(`music ended: ${reason}`);
    await useMusic.getState().stop();
    return;
  }
  if (!nearEnd) {
    // The stream dropped. Advancing here would walk the whole queue in seconds,
    // reporting each one played.
    log.warn("music ended early with no reason - not advancing");
    await useMusic.getState().stop();
    return;
  }
  await scheduler?.flush("track end");
  await useMusic.getState().next(true);
}

function wireLifecycle(): void {
  if (lifecycleWired) return;
  lifecycleWired = true;
  onRelease(() => {
    // Music keeps playing when the app is hidden - that is the point of it - so
    // this reports rather than stops. The box owns the audio either way.
    void scheduler?.flush("hidden");
  });
}

/**
 * A film took the player.
 *
 * Nothing is stopped: the shell has already replaced what was playing. The queue
 * is kept so it is still there afterwards, but the clock and the reporting are
 * ended, because the songs are no longer playing.
 */
whenPlayerLost("music", () => {
  void scheduler?.end();
  scheduler = null;
  unsubscribe?.();
  unsubscribe = null;
  // The queue is kept, so where the song had got to is kept with it - this is
  // the case somebody comes back to most: a film over the music, and Play on the
  // player screen afterwards.
  const { index, positionMs, durationMs } = useMusic.getState();
  const partWay = positionMs > RESUME_MIN_MS && (durationMs <= 0 || positionMs < durationMs - NEAR_END_MS);
  useMusic.setState({
    state: "stopped",
    buffering: false,
    positionMs: 0,
    scrubMs: null,
    resume: index >= 0 && partWay ? { index, ms: positionMs } : null,
  });
});

/** Forget everything. Called when the identity behind the queue changes. */
export function resetMusic(): void {
  const clear = (): void => {
    useMusic.setState({
      queue: [],
      source: [],
      index: -1,
      shuffle: false,
      repeat: "off",
      error: null,
      resume: null,
      adding: false,
      added: 0,
      scrubMs: null,
      // A spoken request belongs to the queue it was asked about. Left behind,
      // it re-opens the lyrics panel on the next person's first song - this runs
      // when the account changes.
      lyricsAsk: null,
    });
  };
  backend = null;
  // Twice, and the second one is the point: `stop` awaits the server before it
  // writes its own state, so a single clear here lands FIRST and the stop then
  // puts a resume point back - the previous account's place in a track it can no
  // longer see. Clearing now as well keeps this synchronous for its callers.
  clear();
  void useMusic.getState().stop().then(clear);
}

/** Wire the bridge's events without starting playback. Tests only. */
export function __wireMusicEventsForTest(): void {
  wireEvents();
}

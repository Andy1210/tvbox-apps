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

  playQueue(
    backend: MediaBackend,
    tracks: MediaItem[],
    opts?: { startIndex?: number; shuffle?: boolean },
  ): Promise<void>;
  playAt(index: number): Promise<void>;
  /** `auto` marks the advance the box asked for, which is the only one that
   *  honours repeat-one - pressing Next over a repeating song means the next. */
  next(auto?: boolean): Promise<void>;
  previous(): Promise<void>;
  toggle(): void;
  seek(ms: number): void;
  stop(): Promise<void>;
  enqueue(tracks: MediaItem[], where: "next" | "end"): void;
  removeAt(index: number): void;
  setShuffle(on: boolean): void;
  setRepeat(mode: RepeatMode): void;
}

let backend: MediaBackend | null = null;
let scheduler: PlaybackScheduler | null = null;
let unsubscribe: (() => void) | null = null;
let lifecycleWired = false;
/** Which start is current, so a slow one cannot report over a newer one. */
let token = 0;

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

  async playAt(index) {
    const { queue } = get();
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
      if (index + 1 < queue.length) await get().playAt(index + 1);
      return;
    }

    const tv = bridge();
    wireEvents();
    wireLifecycle();
    const mine = ++token;

    set({
      index,
      state: "playing",
      positionMs: 0,
      // Seeded from the library rather than waited for: the box reports a
      // duration a moment later, and until then the end-of-track test would have
      // nothing to compare against.
      durationMs: item.durationMs ?? 0,
      buffering: true,
      error: null,
    });

    claimPlayer("music");
    tv?.play?.(url);

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
    if (auto && repeat === "one") return get().playAt(index);
    const at = index + 1;
    if (at < queue.length) return get().playAt(at);
    if (repeat === "all" && queue.length) return get().playAt(0);
    await get().stop();
  },

  async previous() {
    const { index, positionMs } = get();
    // Past the first few seconds, Previous restarts the song - which is what the
    // button means everywhere else, and what stops a mis-press losing your place
    // in a queue you cannot see the top of.
    if (positionMs > 3_000 || index <= 0) return get().playAt(Math.max(0, index));
    await get().playAt(index - 1);
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
    set({ positionMs: at });
    void scheduler?.flush("seek");
  },

  async stop() {
    if (get().index < 0 && get().state === "stopped") return;
    releasePlayer("music");
    bridge()?.stop?.();
    unsubscribe?.();
    unsubscribe = null;
    await scheduler?.end();
    scheduler = null;
    // The QUEUE survives a stop. Wiping it turned the end of a list into a dead
    // end: the player screen fell back to "nothing is playing", which draws no
    // focusable at all, and the only way out was Back. Keeping it means the
    // screen still shows what was on and Play starts it again - the same
    // decision already made for a film taking the player away.
    set({ state: "stopped", positionMs: 0, durationMs: 0, buffering: false });
  },

  enqueue(tracks, where) {
    if (!tracks.length) return;
    const { queue, index, source } = get();
    const at = where === "next" ? Math.max(0, index) + 1 : queue.length;
    set({
      queue: [...queue.slice(0, at), ...tracks, ...queue.slice(at)],
      // The unshuffled order gains them too, or switching shuffle off would
      // silently drop everything that had been queued while it was on.
      source: [...source, ...tracks],
    });
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
  useMusic.setState({ state: "stopped", buffering: false, positionMs: 0 });
});

/** Forget everything. Called when the identity behind the queue changes. */
export function resetMusic(): void {
  void useMusic.getState().stop();
  backend = null;
  useMusic.setState({ queue: [], source: [], index: -1, shuffle: false, repeat: "off", error: null });
}

/** Wire the bridge's events without starting playback. Tests only. */
export function __wireMusicEventsForTest(): void {
  wireEvents();
}

// Everything that has to happen on a clock while something is playing.
//
// ONE scheduler, not four. Progress has to be reported to the server, a
// transcode session has to be kept alive or the server tears it down, the box
// has to be told what is playing so the house sees it, and the on-screen
// position has to move. Four separate timers drift apart, fire in an order
// nobody chose, and each one has to be remembered separately at every exit -
// and the exits are the part that already has no signal from the shell.
//
// So there is one tick, and `flush` is what every exit calls.

import type { MediaBackend, PlaybackState } from "../backends/types";
import { log } from "../redact";

/** How often position is reported. Often enough that a crash loses little. */
const PROGRESS_MS = 5_000;
/** A transcode session the server stops hearing from is reclaimed. */
const KEEPALIVE_MS = 10_000;
/** What the rest of the house sees. */
const NOWPLAYING_MS = 10_000;
/** The on-screen clock. Cheap, and only while the overlay is up. */
const TICK_MS = 500;

export interface SchedulerTarget {
  itemId: string;
  durationMs: number;
  /** Transcode session, when the server started one. */
  session?: string;
}

export interface NowPlayingReport {
  state: "playing" | "paused" | "idle";
  title?: string;
  artist?: string;
  image?: string;
}

export interface SchedulerDeps {
  backend: MediaBackend;
  /** Current position in ms, read from the player rather than counted here. */
  position: () => number;
  state: () => PlaybackState;
  nowPlaying: () => NowPlayingReport;
  postNowPlaying: (r: NowPlayingReport) => void;
  /** Called on every tick so the overlay can redraw without its own timer. */
  onTick?: () => void;
}

export class PlaybackScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private target: SchedulerTarget | null = null;
  private lastProgress = 0;
  private lastKeepalive = 0;
  private lastNowPlaying = 0;
  /** Guards against two flushes overlapping on a slow network. */
  private flushing: Promise<void> | null = null;

  constructor(private deps: SchedulerDeps) {}

  start(target: SchedulerTarget): void {
    this.target = target;
    const now = Date.now();
    // Report immediately: a server that has not heard a start does not show the
    // item as playing, and the house reads that.
    this.lastProgress = 0;
    this.lastKeepalive = now;
    this.lastNowPlaying = 0;
    if (!this.timer) this.timer = setInterval(() => this.onTick(), TICK_MS);
    void this.flush("start");
  }

  /** Stop the clock. Does NOT report - callers decide what the last word is. */
  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private onTick(): void {
    this.deps.onTick?.();
    if (!this.target) return;
    const now = Date.now();

    if (now - this.lastProgress >= PROGRESS_MS) {
      this.lastProgress = now;
      void this.reportProgress();
    }
    if (this.target.session && now - this.lastKeepalive >= KEEPALIVE_MS) {
      this.lastKeepalive = now;
      void this.deps.backend.keepAlive(this.target.session).catch(() => {});
    }
    if (now - this.lastNowPlaying >= NOWPLAYING_MS) {
      this.lastNowPlaying = now;
      this.deps.postNowPlaying(this.deps.nowPlaying());
    }
  }

  private async reportProgress(): Promise<void> {
    const t = this.target;
    if (!t) return;
    try {
      await this.deps.backend.reportProgress(t.itemId, this.deps.position(), t.durationMs, this.deps.state());
    } catch (e) {
      // A lost report costs a resume point, not the film. Retrying immediately
      // would only pile up against a server that is already refusing.
      log.warn("progress report failed", e);
    }
  }

  /**
   * Report everything now.
   *
   * Called on pause, on seek, on stop, on the app being hidden and on a profile
   * switch. `reason` is only for the log - what it does is the same every time,
   * because the one thing that must not happen is a state where some of it was
   * reported and the rest was not.
   */
  async flush(reason: string): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = (async () => {
      const now = Date.now();
      this.lastProgress = now;
      this.lastNowPlaying = now;
      await this.reportProgress();
      // Re-read, because `end()` may have run while that report was in flight:
      // it nulls the target before its first await and posts `idle`, and that
      // has to be the LAST word on the topic. The payload is retained, so a
      // now-playing sent after it goes on announcing a film that has stopped -
      // until something else plays. That window used to be three presses wide
      // (Back paused, closed the controls, then stopped); it is now one press,
      // and pressing Back and then an arrow is an ordinary way to leave.
      if (this.target) this.deps.postNowPlaying(this.deps.nowPlaying());
      log.info(`flushed (${reason})`);
    })();
    this.flushing = run;
    try {
      await run;
    } finally {
      this.flushing = null;
    }
  }

  /**
   * Last word for this item: a final report, an idle now-playing, and the
   * transcode session released.
   */
  async end(): Promise<void> {
    const t = this.target;
    this.stopTimer();
    if (!t) return;
    this.target = null;

    try {
      await this.deps.backend.reportProgress(t.itemId, this.deps.position(), t.durationMs, "stopped");
    } catch (e) {
      log.warn("final progress report failed", e);
    }
    // Idle, always: a stale "playing" is retained by the box and read by the
    // house, and it also holds the box's own idle gate open.
    this.deps.postNowPlaying({ state: "idle" });
    if (t.session) await this.deps.backend.endSession(t.session).catch(() => {});
  }

  get active(): boolean {
    return this.target !== null;
  }
}

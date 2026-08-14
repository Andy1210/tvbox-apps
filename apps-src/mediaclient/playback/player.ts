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
      version?: number;
      audio?: number;
      subtitle?: number | "none";
      maxBitrateKbps?: number;
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
  stop(): Promise<void>;
  showOverlay(on: boolean): void;
  /** The marker covering the current position, when there is one. */
  activeMarker(): Marker | null;
  skipMarker(): void;
}

let scheduler: PlaybackScheduler | null = null;
/** A restart is in flight. See changeTracks. */
let restarting = false;
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
  overlay: false,
  error: null,

  async play(backend, item, opts) {
    const tv = bridge();
    if (!tv?.play) {
      set({ error: "no player on this box" });
      return;
    }

    // Whatever was playing gets its last word before anything else starts.
    await get().stop();

    currentBackend = backend;
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
      set({ error: "unplayable" });
      return;
    }

    const resumeFrom = opts?.resume === false ? 0 : (item.viewOffsetMs ?? 0);
    // Seconds, and only when it is worth it: resuming a film four seconds in is
    // more surprising than starting it.
    const startSec = resumeFrom > 10_000 ? Math.floor(resumeFrom / 1000) : 0;

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
      void bridge()?.selectStreams?.({
        audio: choice.audio,
        sub: choice.subtitle === "none" ? -1 : choice.subtitle,
      });
      if (currentBackend) {
        const v = cur.detail?.versions[choice.version];
        void currentBackend
          .setTracks(cur.item.id, choice.version, {
            audioId: choice.audio !== undefined ? v?.audio[choice.audio]?.id : undefined,
            subtitleId:
              choice.subtitle === "none"
                ? "none"
                : choice.subtitle !== undefined
                  ? v?.subtitles[choice.subtitle]?.id
                  : undefined,
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
          audio: choice.audio,
          maxBitrateKbps: choice.maxBitrateKbps,
          subtitle: choice.subtitle,
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

  async stop() {
    if (!get().current) return;
    bridge()?.stop?.();
    unsubscribePlayer?.();
    unsubscribePlayer = null;
    await scheduler?.end();
    scheduler = null;
    set({
      current: null,
      state: "stopped",
      positionMs: 0,
      seekTargetMs: null,
      seekFromMs: null,
      scrubMs: null,
      overlay: false,
      buffering: false,
    });
  },

  showOverlay(on) {
    set({ overlay: on });
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
      item.seriesTitle && item.parentIndex !== undefined && item.index !== undefined
        ? `${item.seriesTitle} — S${item.parentIndex}E${item.index}`
        : item.seriesTitle,
  };
}

type Setter = (partial: Partial<PlayerState>) => void;

function wirePlayerEvents(set: Setter, get: () => PlayerState): void {
  const tv = bridge();
  if (!tv?.onPlayer) return;
  unsubscribePlayer?.();

  unsubscribePlayer = tv.onPlayer((ev) => {
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

  await get().stop();

  if (!ranOut) {
    if (reason) log.info(`playback ended: ${reason}`);
    else log.warn("playback ended early with no reason - not advancing");
    return;
  }
  // Auto-advance lands in the next step; ending cleanly is what matters here.
}

/** Release server-side state when the app stops being visible (see lifecycle). */
function wireLifecycle(): void {
  if (lifecycleWired) return;
  lifecycleWired = true;

  onRelease(() => {
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

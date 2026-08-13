// Driving the box's shared player, and knowing what it is doing.
//
// The video is not rendered by this app: a URL is handed to the box, which plays
// it behind this page while the page draws the overlay on top. So everything
// here is bookkeeping - what is playing, where it is, and what to do when it
// ends - and the one thing that needs care is that the box's own events are the
// truth, not what this app asked for.

import { create } from "zustand";
import type { MediaBackend, Marker, MediaItem, PlaybackState, StreamDecision } from "../backends/types";
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
}

interface PlayerState {
  current: PlayingItem | null;
  state: PlaybackState;
  positionMs: number;
  durationMs: number;
  buffering: boolean;
  /** Set while a seek is in flight, so the bar shows where it is going. */
  seekTargetMs: number | null;
  overlay: boolean;
  error: string | null;

  play(backend: MediaBackend, item: MediaItem, opts?: { resume?: boolean }): Promise<void>;
  togglePause(): void;
  seekBy(deltaMs: number): void;
  seekTo(ms: number): void;
  stop(): Promise<void>;
  showOverlay(on: boolean): void;
  /** The marker covering the current position, when there is one. */
  activeMarker(): Marker | null;
  skipMarker(): void;
}

let scheduler: PlaybackScheduler | null = null;
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
    let decision: StreamDecision;
    let markers: Marker[] = [];
    try {
      [decision, markers] = await Promise.all([
        backend.resolveStream(item.id, { session, panel: tv.panel ?? null }),
        backend.markers(item.id).catch(() => []),
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
      current: { item, decision, markers },
      state: "playing",
      positionMs: resumeFrom,
      durationMs: item.durationMs ?? 0,
      buffering: true,
      seekTargetMs: null,
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
        sub: decision.sub === "no" ? -1 : undefined,
        audio: decision.audio === "no" ? -1 : undefined,
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

  seekTo(ms) {
    // Shown immediately and reconciled when the player reports back, so the bar
    // never appears to jump backwards after a press.
    set({ seekTargetMs: ms, overlay: true });
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
    set({ current: null, state: "stopped", positionMs: 0, seekTargetMs: null, overlay: false, buffering: false });
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
        // A seek is settled once the player reports somewhere near where it was
        // sent; until then its own position is still the old one.
        const settled = target === null || Math.abs(ms - target) < 2_000;
        set({ positionMs: ms, seekTargetMs: settled ? null : target });
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

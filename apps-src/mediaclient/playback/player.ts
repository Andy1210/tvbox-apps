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
      /**
       * Start here, in ms, whatever the server remembers.
       *
       * A controller's offset is an instruction, not a hint: using `resume` as
       * well started the film at the item's own view offset and only then
       * seeked, which begins a transcode in the wrong place.
       */
      startMs?: number;
      version?: number;
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
  stop(): Promise<void>;
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
   * instead of reporting success before anything was tried.
   */
  playSibling(which: "prev" | "next"): Promise<void>;
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
/** Long enough to read the title, short enough not to be a wait. */
const UP_NEXT_MS = 5_000;
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
  upNext: null,
  subDelaySec: 0,
  overlay: false,
  error: null,

  cancelUpNext() {
    if (upNextTimer) clearTimeout(upNextTimer);
    upNextTimer = null;
    set({ upNext: null });
  },

  async playSibling(which) {
    const item = get().siblings[which];
    if (!item || !currentBackend) return;
    // The queue travels with the move, or stepping once through a playlist
    // would land on an item that no longer knows it is in one.
    await get().play(currentBackend, item, { resume: false, queue: get().queue });
  },

  async play(backend, item, opts) {
    const tv = bridge();
    if (!tv?.play) {
      set({ error: "no player on this box" });
      return;
    }

    // Whatever was playing gets its last word before anything else starts.
    await get().stop();

    currentBackend = backend;
    playToken += 1;
    // The episodes either side, worked out HERE rather than by whoever pressed
    // play. A film can be started from a season screen, a carry-on-watching
    // row, a search result or a person's credits, and only one of those knew
    // what the episode was part of - so the buttons appeared on one route and
    // not the others.
    set({ siblings: {}, subDelaySec: 0 });
    get().cancelUpNext();

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
  usePlayer.setState({ siblings: {}, queue: undefined, upNext: null, subDelaySec: 0 });
}

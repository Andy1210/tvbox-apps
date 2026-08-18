// What this box tells a controller it is doing.
//
// A phone that casts does not stop at sending the command: it subscribes, and
// then it waits to be told what is playing, where the position is, and which
// buttons to draw. Until that arrives it shows the box as connecting and never
// finishes - which is exactly what this app did, because it answered the
// subscribe with "ok" and then said nothing ever again.
//
// The shape is not ours to choose. It is read off Plex's own 10-foot client,
// which is on one of the boxes and which a phone controls without trouble:
//
//     POST /player/proxy/timeline?commandID=<the last command answered>
//     <MediaContainer location="navigation">
//       <Timeline type="video" state="stopped" />
//       <Timeline type="music" state="playing" time="…" duration="…" … />
//       <Timeline type="photo" state="stopped" />
//     </MediaContainer>
//
// Three of them every time, one per kind, whether or not that kind is playing:
// a controller decides which player it is holding from the one that is not
// stopped, and a report that omits the others never lets it change its mind.

import type { MediaItem } from "../backends/types";

export type TimelineKind = "video" | "music" | "photo";
export type TimelineState = "stopped" | "playing" | "paused" | "buffering";

export interface Timeline {
  type: TimelineKind;
  state: TimelineState;
  /** Which of the controls to draw. Empty while stopped. */
  controllable?: string;
  key?: string;
  ratingKey?: string;
  /** The play queue this came from, so the phone can show the running order. */
  containerKey?: string;
  playQueueID?: string;
  /**
   * WHICH entry of the queue is playing, by the queue's own id for it.
   *
   * A controller matches this against the queue it built. Without it, one that
   * has subscribed knows a queue is playing and not which row - measured
   * against Plex's own client, which sends it and whose remote a phone draws in
   * full; this app sent neither and a phone offered no controls at all.
   */
  playQueueItemID?: string;
  /** Whether the controller's view of that queue is still the current one. */
  playQueueVersion?: string;
  /** Milliseconds, both of them. */
  time?: number;
  duration?: number;
  /** Which server holds the item, and how to reach it. */
  machineIdentifier?: string;
  protocol?: string;
  address?: string;
  port?: string;
  repeat?: 0 | 1 | 2;
  shuffle?: 0 | 1;
  volume?: number;
}

/**
 * The controls a controller may draw for something that is playing.
 *
 * Sent as a list rather than inferred: a phone greys out what is missing, so
 * claiming a control this app does not implement is worse than omitting it -
 * the button is drawn, pressed, and nothing happens.
 *
 * Which is what four of them were doing. `shuffle` and `repeat` arrive as
 * `setParameters`, and the two stream pickers as `setStreams`; neither path is
 * handled, so both fell through to the refusal at the end of the switch. They
 * are off this list until they are, and `volume` was never on it - the box's own
 * mixer is the wrong thing to move (it would stay where a phone left it, with
 * only Settings to put it back), and the right one is the television's, over the
 * IR blaster, which is a different feature.
 */
const MUSIC_CONTROLS = "playPause,stop,skipPrevious,skipNext,seekTo,stepBack,stepForward";
const VIDEO_CONTROLS = "playPause,stop,seekTo,stepBack,stepForward";

/**
 * The play queue a cast arrived with.
 *
 * Held here rather than in either player store because it belongs to neither:
 * it is what the CONTROLLER built, and the two stores are handed plain lists of
 * items. Without it the timeline names no queue, and a phone that cast an album
 * shows one track with no running order behind it.
 *
 * Cleared when playback of that kind stops, so a queue does not outlive the
 * music it described and get reported against the next thing started from the
 * television.
 */
interface CastQueue {
  containerKey: string;
  /**
   * The queue's own id for each row, keyed by the ITEM's id rather than by
   * position.
   *
   * Position looked obvious and was wrong: the music store's index walks the
   * SHUFFLED order while the server handed these over in its own, so turning
   * shuffle on after a cast made the box name a row the phone was not
   * highlighting. Keyed this way, a track that appears twice in a queue reports
   * the first of its entries - which is wrong in a way nobody can see, rather
   * than wrong by however far the shuffle moved it.
   */
  entryIds?: Record<string, string>;
  version?: string;
}

const queues: Partial<Record<TimelineKind, CastQueue>> = {};

export function rememberCastQueue(kind: TimelineKind, containerKey: string, q?: Omit<CastQueue, "containerKey">): void {
  queues[kind] = { containerKey, ...(q || {}) };
}

export function forgetCastQueue(kind: TimelineKind): void {
  delete queues[kind];
}

/** `/playQueues/1234` -> `1234`, and nothing for anything else. */
function queueIdOf(containerKey: string | undefined): string | undefined {
  const m = /^\/playQueues\/(\d+)/.exec(containerKey || "");
  return m ? m[1] : undefined;
}

export interface ServerAddress {
  machineIdentifier?: string;
  /** The server's base url, as the app talks to it. */
  baseUrl?: string;
}

/** A stopped line, which is what most of a report is most of the time. */
export function stopped(type: TimelineKind): Timeline {
  return { type, state: "stopped" };
}

export interface PlayingSnapshot {
  item: MediaItem | null;
  state: TimelineState;
  positionMs: number;
  durationMs: number;
  shuffle?: boolean;
  /** 0 none, 1 one, 2 all - the numbers Plex's protocol uses. */
  repeat?: 0 | 1 | 2;
}

/**
 * One line of the report.
 *
 * A snapshot with no item is stopped whatever its state says: the two stores
 * clear their item on the way out and the state a moment later, and a line that
 * claims to be playing nothing makes a phone draw a scrubber over an empty
 * title.
 */
export function timelineFor(type: TimelineKind, snap: PlayingSnapshot, server: ServerAddress): Timeline {
  if (!snap.item || snap.state === "stopped") {
    forgetCastQueue(type);
    return stopped(type);
  }
  const queue = queues[type];
  const line: Timeline = {
    type,
    state: snap.state,
    controllable: type === "music" ? MUSIC_CONTROLS : VIDEO_CONTROLS,
    key: `/library/metadata/${snap.item.id}`,
    ratingKey: snap.item.id,
    time: Math.max(0, Math.round(snap.positionMs)),
    duration: Math.max(0, Math.round(snap.durationMs)),
  };
  if (queue) {
    line.containerKey = queue.containerKey;
    line.playQueueID = queueIdOf(queue.containerKey);
    if (queue.version) line.playQueueVersion = queue.version;
    const entry = queue.entryIds?.[snap.item.id];
    if (entry) line.playQueueItemID = entry;
  }
  if (snap.shuffle !== undefined) line.shuffle = snap.shuffle ? 1 : 0;
  if (snap.repeat !== undefined) line.repeat = snap.repeat;
  if (server.machineIdentifier) line.machineIdentifier = server.machineIdentifier;
  if (server.baseUrl) {
    try {
      const u = new URL(server.baseUrl);
      line.protocol = u.protocol.replace(":", "");
      line.address = u.hostname;
      // Explicit, because a url that leaves the port out means the scheme's
      // default and a controller reading an empty attribute reaches nothing.
      line.port = u.port || (u.protocol === "https:" ? "443" : "80");
    } catch (e) {
      /* an unparseable base url costs the address, not the report */
    }
  }
  return line;
}

/** The document a controller reads. Attributes only, like the reference. */
export function timelineXml(lines: Timeline[], location = "navigation"): string {
  const attr = (v: string): string =>
    v
      // A control character makes the whole document unparseable and the server
      // drops it, which silently ends this box's status reporting - the reason
      // the command-response path strips them too. These strings come from the
      // SERVER now (the queue's own ids), and this app signs into servers it
      // does not own.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const one = (t: Timeline): string => {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(t)) {
      if (v === undefined || v === null || v === "") continue;
      parts.push(`${k}="${attr(String(v))}"`);
    }
    return `<Timeline ${parts.join(" ")} />`;
  };
  return `<MediaContainer location="${attr(location)}">${lines.map(one).join("")}</MediaContainer>`;
}

/** Whether a report is worth sending again on its own, i.e. something moves. */
export function isActive(lines: Timeline[]): boolean {
  return lines.some((l) => l.state === "playing" || l.state === "buffering");
}

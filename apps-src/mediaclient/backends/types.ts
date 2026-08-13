// The one interface every media server is reached through. Nothing above this
// file knows whether it is talking to Plex or Jellyfin.
//
// The abstraction is here from the first backend rather than retrofitted after
// the second, because retrofitting means touching every call site - and because
// it is what lets the UI survive a server the household no longer wants.

/** A library section: films, series, music, … */
export interface Library {
  id: string;
  title: string;
  /** Normalised across backends; anything we do not model is "other". */
  kind: "movie" | "show" | "music" | "photo" | "other";
}

export type ItemKind = "movie" | "show" | "season" | "episode";

export interface MediaItem {
  id: string;
  kind: ItemKind;
  title: string;
  /** Series title for an episode, show title for a season. */
  parentTitle?: string;
  /** Series title for an episode (its grandparent). */
  seriesTitle?: string;
  year?: number;
  /** Backend-relative art paths; resolve with `posterUrl` / `artUrl`. */
  thumb?: string;
  art?: string;
  durationMs?: number;
  /** Seconds into the item, when it was left partway. */
  viewOffsetMs?: number;
  /** How many times it has been watched through. 0 or absent = unwatched. */
  viewCount?: number;
  /** Epoch seconds. Absent for something never watched. */
  lastViewedAt?: number;
  /** Epoch seconds. */
  addedAt?: number;
  index?: number;
  parentIndex?: number;
  summary?: string;
  /** Unwatched leaves below this item (a series or season). */
  unwatchedCount?: number;
}

export interface PageQuery {
  offset: number;
  limit: number;
  sort?: "titleSort" | "addedAt" | "lastViewedAt";
}

export interface Page<T> {
  items: T[];
  /** Absent when the backend did not say - the caller must not infer "no more". */
  total?: number;
}

/** One cast member as an item lists them. */
export interface Role {
  /** Backend id used to query this person's credits. Server-global on Plex. */
  id: string;
  /** Plex GUID for the same person. Two ids can share one - see personCredits. */
  guid?: string;
  name: string;
  character?: string;
  thumb?: string;
}

export interface ItemDetail extends MediaItem {
  roles: Role[];
  directors?: string[];
  writers?: string[];
  genres?: string[];
  rating?: number;
  contentRating?: string;
}

export interface PersonRef {
  id: string;
  guid?: string;
  name: string;
}

export interface CreditSet {
  person: PersonRef;
  /** Films and series, already rolled up: an actor's episodes become their series. */
  items: MediaItem[];
  /** True when the backend did not report a total, so completeness is unknown. */
  truncated: boolean;
}

/** Intro/credits marker. `final` marks a credits run that reaches the end. */
export interface Marker {
  type: "intro" | "credits" | "commercial";
  startMs: number;
  endMs: number;
  final: boolean;
}

export type TrackChoice = number | "no" | "auto";

export interface StreamDecision {
  url: string;
  /** 0-based ordinals within their type, or "no"/"auto". */
  audio: TrackChoice;
  sub: TrackChoice;
  /** http(s) only - the shell rejects anything else. */
  subFile?: string;
  /** When the server burns subtitles in, `sub` must be "no". */
  subtitlesBurnedIn: boolean;
  /** Transcode session id, when one was started. */
  session?: string;
  /** How the server classified this connection; "wan" is bandwidth-capped. */
  location: "lan" | "wan";
  /** Whether the server chose to transcode; useful for the OSD and for logs. */
  transcoded: boolean;
}

export type PlaybackState = "playing" | "paused" | "stopped";

export interface HistoryRow {
  itemId: string;
  title: string;
  /** Epoch seconds. */
  viewedAt: number;
  accountId?: string;
}

/** Plex ships BIF (an offset table + concatenated JPEGs); Jellyfin ships tiles. */
export type TrickplayIndex =
  | { kind: "bif"; url: string; intervalMs: number; frames: { timestampMs: number; offset: number }[] }
  | { kind: "tiles"; urlFor: (index: number) => string; intervalMs: number; cols: number; rows: number };

export interface Profile {
  id: string;
  name: string;
  thumb?: string;
  /** Whether switching to this profile needs a PIN the backend will verify. */
  pinRequired: boolean;
}

export interface Session {
  profileId: string;
  profileName: string;
  token: string;
  serverId: string;
  serverName: string;
  baseUrl: string;
  location: "lan" | "wan";
}

export interface DeviceLogin {
  /** What the user types on the other device. */
  code: string;
  /** Where they type it. */
  url: string;
  /** Resolves with a session once linked, or null when the code expired. */
  poll(signal?: AbortSignal): Promise<Session | null>;
}

export interface MediaBackend {
  readonly kind: "plex" | "jellyfin";

  // --- auth ---
  beginDeviceLogin(): Promise<DeviceLogin>;
  listProfiles(): Promise<Profile[]>;
  switchProfile(id: string, pin?: string): Promise<Session>;

  // --- browse ---
  libraries(): Promise<Library[]>;
  onDeck(): Promise<MediaItem[]>;
  recentlyAdded(libraryId?: string): Promise<MediaItem[]>;
  libraryPage(libraryId: string, q: PageQuery): Promise<Page<MediaItem>>;
  /** Buckets for the A-Z strip, in the backend's own order. */
  letters(libraryId: string): Promise<{ key: string; title: string; size: number }[]>;
  /** The items under one letter. Used instead of offset arithmetic - see design §4.1. */
  letterPage(libraryId: string, letterKey: string, q: PageQuery): Promise<Page<MediaItem>>;
  item(id: string): Promise<ItemDetail>;
  children(id: string): Promise<MediaItem[]>;
  search(query: string): Promise<MediaItem[]>;
  personCredits(person: PersonRef): Promise<CreditSet>;

  // --- art ---
  /** A server-scaled poster URL that carries NO credential; pair it with
   *  `imageHeaders()`. Keeping the token out means the URL is safe to put in the
   *  DOM, in a log, or in a now-playing report. */
  posterUrl(item: MediaItem, w: number, h: number): string | undefined;
  /** Auth headers for fetching artwork. */
  imageHeaders(): Record<string, string>;

  // --- playback ---
  resolveStream(id: string, opts: { session: string; panel?: { width: number; height: number } | null }): Promise<StreamDecision>;
  markers(id: string): Promise<Marker[]>;
  trickplay(id: string): Promise<TrickplayIndex | null>;
  keepAlive(session: string): Promise<void>;
  endSession(session: string): Promise<void>;
  /** Stop any session this client left behind. Called at startup, not only on exit. */
  reapOwnSessions(): Promise<number>;

  // --- state ---
  reportProgress(id: string, positionMs: number, durationMs: number, state: PlaybackState): Promise<void>;
  setWatched(id: string, watched: boolean): Promise<void>;
  history(limit: number): Promise<HistoryRow[]>;
}

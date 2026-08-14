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

export type ItemKind = "movie" | "show" | "season" | "episode" | "collection" | "playlist";

export interface MediaItem {
  id: string;
  kind: ItemKind;
  title: string;
  /** Series title for an episode, show title for a season. */
  parentTitle?: string;
  /** Series title for an episode (its grandparent). */
  seriesTitle?: string;
  /** The season this episode belongs to. */
  parentId?: string;
  /** The series an episode belongs to. Needed because an episode's own id opens
   *  an episode, and a credit list wants the series. */
  seriesId?: string;
  /** The series' own poster, as opposed to the episode still. */
  seriesThumb?: string;
  /** What the server sorts by, which is not always the title ("A" articles). */
  sortTitle?: string;
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
  /** A key from `sortOptions`. Backend-defined, not a fixed set. */
  sort?: string;
  desc?: boolean;
  /** Filter key to chosen value, from `filterOptions` / `filterValues`. */
  filters?: Record<string, string>;
  /**
   * What to list. Absent means the library's own items.
   *
   * "collections" is the same list under a different lens, which is why it
   * pages, sorts, filters and buckets by letter exactly as the items do.
   */
  of?: "collections";
}

/** One way to order a library, as the server itself describes it. */
export interface SortOption {
  key: string;
  title: string;
}

/**
 * One way to narrow a library.
 *
 * `kind` decides how it is chosen: `list` needs its values fetched (genres,
 * years, actors), `flag` is on or off (unwatched, HDR).
 */
export interface FilterOption {
  key: string;
  title: string;
  kind: "list" | "flag";
  /** The backend's own route to this filter's values, when it gave one. */
  path?: string;
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

/** A score from one source, with which way round its scale runs. */
export interface Score {
  /** "imdb", "rottentomatoes", "themoviedb", … derived from the server's icon. */
  source: string;
  /** "critic" or "audience". */
  kind: "critic" | "audience";
  /** 0-10 as the server reports it. */
  value: number;
  /** Rotten Tomatoes' verdict, when the icon carries one. */
  sentiment?: "fresh" | "rotten" | "upright" | "spilled";
}

/** One published review. */
export interface Review {
  id: string;
  author: string;
  text: string;
  source?: string;
  link?: string;
  sentiment?: "fresh" | "rotten";
}

/** A trailer, featurette or other clip attached to an item. */
export interface Extra {
  id: string;
  title: string;
  /** "trailer", "clip", "featurette", … as the server labels it. */
  subtype: string;
  durationMs?: number;
  thumb?: string;
}

/** One selectable audio or subtitle track of a version. */
export interface Track {
  /** 0-based ordinal WITHIN its type - what the box's player speaks. */
  ordinal: number;
  /** The backend's own id, for telling the server which one was chosen. */
  id: string;
  kind: "audio" | "subtitle";
  /** ISO-ish language name as the server gives it, when it gives one. */
  language?: string;
  /** What to show: the server's own label, or something composed from the codec. */
  label: string;
  /** Burned into the picture; cannot be turned off. */
  forced?: boolean;
  /** The server's current choice. */
  selected?: boolean;
  /** A subtitle that lives beside the file rather than inside it. Its `ordinal`
   *  is -1, because it has no position among the file's own tracks. */
  external?: boolean;
  /** Server path for an external subtitle, handed to the player as a file. */
  key?: string;
}

/**
 * One of several files the library holds for the same title.
 *
 * Not a quality ladder: a household's second copy is as often a different
 * language as it is a different resolution - the same film in Hungarian and in
 * English as two whole files rather than two tracks. So the label carries
 * language first when the versions differ in it.
 */
export interface MediaVersion {
  index: number;
  /** Which part of that media entry, when a film is split across two files. */
  partIndex: number;
  /** How many parts that media entry has. More than one means the title is
   *  split across files, which the label has to say. */
  parts: number;
  /** The file itself; the server addresses track changes by this. */
  partId?: string;
  /** Composed here: servers leave their own version title empty in practice. */
  label: string;
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  bitrateKbps?: number;
  sizeBytes?: number;
  durationMs?: number;
  audio: Track[];
  subtitles: Track[];
}

/** A chapter, with the still the server generated for it. */
export interface Chapter {
  index: number;
  title?: string;
  startMs: number;
  endMs: number;
  thumb?: string;
}

export interface ItemDetail extends MediaItem {
  roles: Role[];
  directors?: string[];
  writers?: string[];
  genres?: string[];
  studio?: string;
  tagline?: string;
  rating?: number;
  contentRating?: string;
  /** Every score the server holds, not just the one it puts on the tile. */
  scores: Score[];
  reviews: Review[];
  extras: Extra[];
  chapters: Chapter[];
  /** The film's own title artwork, when the server has it. Shown INSTEAD of the
   *  title text, which is what it is for. */
  logo?: string;
  /** External ids, e.g. { imdb: "tt3165612" }. */
  guids?: Record<string, string>;
  /** Every file the library holds for this title. At least one. */
  versions: MediaVersion[];
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
  /** Which version this decision is for. */
  version: number;
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
  /** The token in use, which after a profile switch belongs to that profile. */
  token: string;
  /** The ACCOUNT's own token. Kept apart because the household user list and
   *  every later switch are asked with it - after one switch the token above is
   *  a profile's and can no longer enumerate the household. */
  accountToken: string;
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
  /**
   * `kind` is the library's own kind, and it decides how wide to ask. A show
   * library answers with EPISODES which then roll up to series, so a full row
   * needs more rows than it shows; a film library does not, and asking wide
   * there costs 2.5x the payload for an identical answer.
   */
  recentlyAdded(libraryId?: string, kind?: string): Promise<MediaItem[]>;
  libraryPage(libraryId: string, q: PageQuery): Promise<Page<MediaItem>>;
  /** Buckets for the A-Z strip, in the backend's own order. */
  letters(
    libraryId: string,
    filters?: Record<string, string>,
    of?: "collections",
  ): Promise<{ key: string; title: string; size: number }[]>;

  /**
   * How this library can be ordered and narrowed.
   *
   * Asked of the server rather than hardcoded: the sets differ by library type
   * - a series library orders by unwatched episode count, a film library by
   * resolution - and a fixed list would offer orders the server rejects.
   */
  sortOptions(libraryId: string): Promise<SortOption[]>;

  /**
   * The library's collections, as items in their own right.
   *
   * Paged like the library itself: this server holds 461 of them, which is a
   * grid rather than a row.
   */
  collections(libraryId: string, q: PageQuery): Promise<Page<MediaItem>>;
  /** Every playlist on the account. Few enough to be one request. */
  playlists(): Promise<MediaItem[]>;
  /** A playlist's items. Not `children` - the metadata path answers nothing. */
  playlistItems(id: string): Promise<MediaItem[]>;
  filterOptions(libraryId: string): Promise<FilterOption[]>;
  /** The values a `list` filter can take. */
  filterValues(libraryId: string, filter: string, path?: string): Promise<SortOption[]>;

  /**
   * Where a letter's items begin in the ordered list.
   *
   * The A-Z strip scrolls rather than filters, so it needs a position rather
   * than a page. Summing the bucket sizes is the obvious way and is wrong:
   * measured on this server, 14 of 29 buckets landed on the previous letter,
   * because the strip and the sort disagree about where accented initials go.
   */
  letterOffset(libraryId: string, letterKey: string, q: Omit<PageQuery, "offset" | "limit">): Promise<number>;
  /** The items under one letter. Used instead of offset arithmetic - see design §4.1. */
  letterPage(libraryId: string, letterKey: string, q: PageQuery): Promise<Page<MediaItem>>;
  item(id: string): Promise<ItemDetail>;
  children(id: string): Promise<MediaItem[]>;
  /** Music heard in a film, when the server knows any. Empty is the normal case. */
  soundtrack(id: string): Promise<MediaItem[]>;
  search(query: string): Promise<MediaItem[]>;
  personCredits(person: PersonRef): Promise<CreditSet>;

  // --- art ---
  /** A server-scaled poster URL that carries NO credential; pair it with
   *  `imageHeaders()`. Keeping the token out means the URL is safe to put in the
   *  DOM, in a log, or in a now-playing report. */
  posterUrl(item: MediaItem, w: number, h: number): string | undefined;
  /** Auth headers for fetching artwork. */
  imageHeaders(): Record<string, string>;

  /**
   * A frame from the film at `timeMs`, for scrubbing.
   *
   * Undefined when the file has no preview index - the server generates those
   * per library, and a title added since the last pass has none. The scrub bar
   * has to work without it, so this is a nicety rather than a dependency.
   */
  previewUrl(partId: string, timeMs: number, w: number, h: number): string | undefined;
  /** Absolutise a server-relative art path. Returns an absolute URL unchanged,
   *  since some artwork is hosted by the metadata provider rather than by the
   *  server. */
  /**
   * Absolute URL for a server-supplied artwork path.
   *
   * Undefined when the value points off the server: the caller pairs this with
   * `imageHeaders()`, which carries an admin-level credential.
   */
  artUrl(path: string): string | undefined;

  // --- playback ---
  resolveStream(
    id: string,
    opts: {
      session: string;
      panel?: { width: number; height: number } | null;
      /** Which file to play, when the library holds more than one. */
      version?: number;
      /** 0-based ordinals within their type. */
      audio?: number;
      subtitle?: number | "none";
      /**
       * Ceiling for the stream, in kbps. Undefined means the original file.
       *
       * Worth having on a box that is sometimes on wifi: a 4K remux is not
       * watchable over a link that cannot carry it, and the alternative to
       * naming a ceiling is a film that rebuffers every minute.
       */
      maxBitrateKbps?: number;
    },
  ): Promise<StreamDecision>;
  /** Tell the server which tracks were chosen, so it remembers next time. */
  setTracks(itemId: string, version: number, choice: { audioId?: string; subtitleId?: string | "none" }): Promise<void>;
  /** Subtitles the server can fetch for this item, if it has a provider set up. */
  searchSubtitles(itemId: string, language: string): Promise<Track[]>;
  /** Download one of them onto the item. */
  addSubtitle(itemId: string, subtitleId: string): Promise<void>;
  markers(id: string): Promise<Marker[]>;
  keepAlive(session: string): Promise<void>;
  endSession(session: string): Promise<void>;
  /** Stop any session this client left behind. Called at startup, not only on exit. */
  reapOwnSessions(): Promise<number>;

  // --- state ---
  reportProgress(id: string, positionMs: number, durationMs: number, state: PlaybackState): Promise<void>;
  setWatched(id: string, watched: boolean): Promise<void>;
  history(limit: number): Promise<HistoryRow[]>;
}

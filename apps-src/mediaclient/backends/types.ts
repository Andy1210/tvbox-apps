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

export type ItemKind =
  "movie" | "show" | "season" | "episode" | "collection" | "playlist" | "artist" | "album" | "track";

/**
 * A play queue as the server hands it over.
 *
 * `entryIds` are the queue's OWN per-entry ids, in the order of `items` - a
 * controller identifies what is playing by one of these rather than by the
 * metadata id, because the same track can sit in a queue twice, and its remote
 * stays blank without one. `version` is how it knows its view of the queue is
 * still the current one. Both are absent from a backend that has no play
 * queues, and the report simply leaves them out.
 */
export interface QueueRead {
  items: MediaItem[];
  startIndex: number;
  entryIds?: string[];
  version?: string;
}

export interface MediaItem {
  id: string;
  kind: ItemKind;
  title: string;
  /** The parent's title: the series for an episode, the show for a season, the
   *  album for a track, the artist for an album. */
  parentTitle?: string;
  /**
   * The grandparent's title: the series for an episode, the ARTIST for a track.
   *
   * Named for the relationship rather than for television because both servers
   * name it that way and both use the one slot for both domains - Plex calls a
   * track's artist `grandparentTitle`, the same field an episode's series
   * arrives in.
   */
  grandparentTitle?: string;
  /** The season this episode belongs to; the album a track sits on. */
  parentId?: string;
  /** The grandparent's id: the series for an episode, the artist for a track.
   *  Needed because an episode's own id opens an episode, and a credit list
   *  wants the series. */
  grandparentId?: string;
  /** The grandparent's own poster, as opposed to the episode still. */
  grandparentThumb?: string;
  /** Theme music, where the server has any. Series mostly; films rarely. */
  theme?: string;
  /**
   * The four corner colours the server derived from the artwork.
   *
   * Present on 1,668 of this library's 1,693 films. Worth taking over anything
   * computed here: it is free, it needs no second decode, and four corners make
   * a gradient where one average makes a wash.
   */
  colors?: { topLeft: string; topRight: string; bottomRight: string; bottomLeft: string };
  /** What the server sorts by, which is not always the title ("A" articles). */
  sortTitle?: string;
  year?: number;
  /** Backend-relative art paths; resolve with `posterUrl` / `artUrl`. */
  thumb?: string;
  art?: string;
  durationMs?: number;
  /**
   * The file behind a playable leaf, as the server keys it. Tracks only.
   *
   * Carried on the list item rather than fetched, because a queue is built from
   * a list: asking the server for each track's file would turn "shuffle the
   * library" into one request per track. Measured on this server, the track
   * listing already returns it, so it costs nothing to keep.
   */
  mediaKey?: string;
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
  /**
   * How many leaves this item holds: a playlist's items, an album's tracks.
   *
   * Worth carrying because it is the only honest answer to "what did the server
   * actually save". A playlist write drops ids it cannot resolve and duplicates
   * it already has - measured, five ids became three tracks and two unresolvable
   * ones became an EMPTY playlist under a 200 - so a screen that reports what it
   * asked for reports a number that is not on the other device.
   */
  childCount?: number;
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
   * Every value here is the same list under a different lens, which is why they
   * page, sort, filter and bucket by letter exactly as the items do - one lens
   * rather than one implementation each. A music library's own items are its
   * artists, so "albums" and "tracks" are the two other depths of the same
   * section.
   */
  of?: "collections" | "albums" | "tracks";
}

/**
 * Which lens a list is being viewed through.
 *
 * Named so the set widens in one place: every signature that takes a lens takes
 * this, and adding a depth (music did) then cannot leave one of them behind
 * accepting only the old values.
 */
export type ListLens = NonNullable<PageQuery["of"]>;

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
  /** Signs and foreign dialogue only, rather than the whole of it. */
  forced?: boolean;
  /**
   * Written for a viewer who cannot hear it: the dialogue plus the sounds.
   *
   * A THIRD kind, not a variant of `forced`. Measured on this server, 577
   * episode and 226 film subtitles carry it, and a file routinely holds the
   * full track and the SDH one in the same language with the same forced flag -
   * so without it a remembered choice cannot tell those two apart.
   */
  hearingImpaired?: boolean;
  /** The server's current choice. */
  selected?: boolean;
  /**
   * A subtitle that lives beside the file rather than inside it.
   *
   * Its `ordinal` is NEGATIVE, because it has no position among the file's own
   * tracks - and each sidecar gets its own: -1, -2, -3. Not a shared -1, which
   * is what this said until a review read it and reported a bug that does not
   * exist. The ordinal is how a choice is named on the way back down, and 9
   * films in 200 here carry more than one sidecar, which one shared number
   * could not tell apart. Both mappers number them this way.
   */
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
  /**
   * Plex's own index for the MEDIA entry this row came from - NOT the position
   * of this row in `versions`.
   *
   * They differ whenever one media entry holds several parts: a film on two
   * discs is one media and two rows, so the array runs 0,1 while this reads
   * 0,0. The decision endpoint wants this one; everything that looks a row up
   * wants the array position, and the two were the same field until a title
   * held that way showed they are not - both chips claimed one focus key, so
   * the second disc could not be reached with the remote at all.
   */
  mediaIndex: number;
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
  /**
   * Which server this session belongs to.
   *
   * Optional because a session stored before there was a second backend does
   * not carry it, and those are all Plex - see `backendFor`.
   */
  kind?: "plex" | "jellyfin";
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
    of?: ListLens,
  ): Promise<{ key: string; title: string; size: number }[]>;

  /**
   * How this library can be ordered and narrowed.
   *
   * Asked of the server rather than hardcoded: the sets differ by library type
   * - a series library orders by unwatched episode count, a film library by
   * resolution - and a fixed list would offer orders the server rejects.
   */
  sortOptions(libraryId: string, of?: ListLens): Promise<SortOption[]>;

  /**
   * The library's collections, as items in their own right.
   *
   * Paged like the library itself: this server holds 461 of them, which is a
   * grid rather than a row.
   */
  collections(libraryId: string, q: PageQuery): Promise<Page<MediaItem>>;
  /**
   * Every playlist on the account, or only the audio or video ones.
   *
   * The filter is the server's, not ours: a music screen offering to add a song
   * to a film playlist is an offer the server would take and nobody wants.
   */
  playlists(kind?: "audio" | "video"): Promise<MediaItem[]>;
  /** A playlist's items. Not `children` - the metadata path answers nothing. */
  playlistItems(id: string): Promise<MediaItem[]>;
  /**
   * The items of a PLAY QUEUE, and which of them was chosen.
   *
   * A controller that casts - Plexamp, the phone app - does not send a list. It
   * builds a play queue on the server and sends its key, so the running order
   * exists only there: without reading it back, a cast of an album plays one
   * track and stops.
   */
  queueItems(queueId: string): Promise<QueueRead>;
  /**
   * Make a playlist holding these items, and answer with it.
   *
   * Separate from `addToPlaylist` because the server's create and append are
   * different calls. `kind` is asked for rather than inferred: the caller knows
   * which screen it is on, while inferring would mean a lookup per id for an
   * answer that is never in doubt.
   */
  createPlaylist(title: string, itemIds: string[], kind: "audio" | "video"): Promise<MediaItem>;
  /** Append to an existing playlist. */
  addToPlaylist(playlistId: string, itemIds: string[]): Promise<void>;
  /**
   * A playable URL for one track, or undefined when the item carries no file.
   *
   * Synchronous and credential-bearing, unlike `resolveStream`: the player is
   * another process that cannot set a header, and a queue cannot afford a round
   * trip per track. Nothing is decided here - an audio file plays directly, so
   * there is no transcode to negotiate.
   */
  trackUrl(item: MediaItem): string | undefined;
  /**
   * How this list can be narrowed.
   *
   * `of` matters for the same reason it matters to `sortOptions`, and more:
   * measured against this server, a collection answers a genre, a year, a
   * decade, a content rating, HDR or "in progress" with NOTHING - so a panel
   * that offers them turns 461 collections into "this library has no
   * collections", which is a sentence about the library.
   */
  filterOptions(libraryId: string, of?: ListLens): Promise<FilterOption[]>;
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
  /** A scaled backdrop, or undefined when the item has none. */
  backdropUrl(item: MediaItem, w: number, h: number): string | undefined;
  /** The theme's audio, or undefined. Credentials travel as headers. */
  themeUrl(item: MediaItem): string | undefined;
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
  /**
   * A sidecar subtitle as a FILE the player can open, or undefined.
   *
   * A sidecar has no position among the container's tracks, so it cannot be
   * selected by index the way an embedded one is - the player has to be handed
   * the file. Undefined when the track is embedded or its path is not one this
   * backend will vouch for; the URL carries the credential and reaches another
   * process, so it is bounded rather than passed through.
   */
  subtitleFileUrl(track: Track): string | undefined;
  /** A chapter still at the size it will be drawn, or undefined. */
  chapterThumbUrl(thumb: string, w: number, h: number): string | undefined;

  // --- playback ---
  resolveStream(
    id: string,
    opts: {
      session: string;
      panel?: { width: number; height: number } | null;
      /** Which file to play, when the library holds more than one. */
      version?: number;
      /**
       * That file's own id, when the caller has it.
       *
       * The position and the identity are not the same answer: a backend whose
       * decision endpoint RANKS the files it returns hands them back in an
       * order of its own, and picking by position then plays one file while
       * reporting another - which leaves everything downstream indexing the
       * versions array with a number that means nothing.
       */
      partId?: string;
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
  /**
   * Give up the credential this session holds, where the server can be told.
   *
   * Optional because it is not a thing every server does. Plex hands out a
   * token tied to the account and expects the client to forget it; Jellyfin
   * mints one per device that stays valid and listed as an active device until
   * somebody revokes it - and the box has just thrown away its only copy, so
   * after a sign-out nothing on the television can revoke it any more.
   */
  revokeSession?(): Promise<void>;
  reportProgress(id: string, positionMs: number, durationMs: number, state: PlaybackState): Promise<void>;
  setWatched(id: string, watched: boolean): Promise<void>;
  history(limit: number): Promise<HistoryRow[]>;
}

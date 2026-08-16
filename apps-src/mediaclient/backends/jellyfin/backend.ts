// A Jellyfin server, behind the one interface every screen reads.
//
// The shape of this file follows the Plex one deliberately, but three things
// about Jellyfin change what the methods can promise, and they are worth having
// in one place rather than repeated as surprises:
//
//  1. A user IS an account. There is no household under one credential, so the
//     profile picker offers the person who signed in and nothing else.
//  2. Artwork needs no credential - measured, an image URL answers 200 with no
//     Authorization header at all. So `posterUrl` carries no token and
//     `imageHeaders` is empty, which is the property the interface asks for
//     rather than a compromise. (It also means anyone on this network who knows
//     an item id can read its poster; that is Jellyfin's design, not ours.)
//  3. Time is counted in ticks of 100 ns. Everything crossing this boundary is
//     converted in `map.ts` - see `ticksToMs`.
//
// Every path here was called against a real server before it was written down.

import { request, buildUrl, type JellyfinIdentity } from "./http";
import {
  msToTicks,
  toChapters,
  toDetail,
  toItem,
  toLibrary,
  toTracks,
  type JellyfinItem,
  type JellyfinMediaSource,
} from "./map";
import { translate, useLocaleStore } from "@sdk";
import { listUsers } from "./auth";
import type {
  CreditSet,
  FilterOption,
  HistoryRow,
  ItemDetail,
  Library,
  Marker,
  MediaBackend,
  MediaItem,
  Page,
  PageQuery,
  PersonRef,
  PlaybackState,
  Profile,
  Session,
  SortOption,
  StreamDecision,
  Track,
  DeviceLogin,
} from "../types";
import { beginQuickConnect } from "./auth";
import { log } from "../../redact";

/**
 * What to ask for on every item request.
 *
 * Asked once and wide rather than per screen: Jellyfin omits everything not
 * named, and a second round trip to fill in an overview costs more than the
 * fields do. `MediaSources` is deliberately NOT here - it is per-file detail
 * that a grid never draws, and on a 60-item page it is most of the payload.
 */
// Every name here is an `ItemFields` member the server declares. A name it does
// not know is DROPPED rather than refused, so a typo reads exactly like a
// working field until something is missing on screen - `ProductionYear` and
// `UserData` were both in these lists and are neither members nor needed: they
// are top-level on every item answer already.
const LIST_FIELDS = "Overview,SortName,DateCreated,ParentId,PrimaryImageAspectRatio";

/**
 * What to call a sort or a filter on screen.
 *
 * Translated HERE, unlike the sibling backend, because there is nothing to ask:
 * Plex names its own sorts in the language the request carries, and Jellyfin has
 * no endpoint that names them at all. Hardcoding one language would have shown
 * Hungarian to an English screen, which is the half of this the server cannot
 * cover for us.
 */
function label(key: string): string {
  return translate(useLocaleStore.getState().locale || "en", key);
}

/** Jellyfin's own sort keys, paired with the name to show. */
const SORTS: { key: string; title: () => string }[] = [
  { key: "SortName", title: () => label("jellyfin.name") },
  { key: "DateCreated", title: () => label("jellyfin.added") },
  { key: "PremiereDate", title: () => label("jellyfin.premiere") },
  { key: "CommunityRating", title: () => label("jellyfin.rating") },
  { key: "Runtime", title: () => label("jellyfin.runtime") },
  { key: "DatePlayed", title: () => label("jellyfin.played") },
  { key: "Random", title: () => label("jellyfin.random") },
];

/**
 * A sort key this server will accept.
 *
 * The screens seed the OTHER backend's default (`titleSort`) and pass it on
 * every page, and `sortBy` here is an array of a closed enum that does not
 * contain it - verified against the server's own OpenAPI, where 30 members are
 * declared and that is not one. Unknown keys therefore become the default
 * rather than travelling: at best the server would ignore it and order the grid
 * its own way while the button says nothing is chosen, at worst it refuses the
 * request and every library opens onto "Try again".
 */
function sortKey(key: string | undefined): string {
  return key && SORTS.some((s) => s.key === key) ? key : "SortName";
}

/** The letters a strip is built from. Latin only: the server buckets by the
 *  first character of the sort name, and an accented initial sorts under its
 *  base letter here. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type Letter = { key: string; title: string; size: number };

/**
 * Orders that mean nothing for a box set.
 *
 * `Random` for the reason the sibling backend gives - a virtualised grid asks
 * for a page at a time and the server reshuffles between them - and the two
 * that describe a FILE rather than a collection of them. Not measured against
 * this server the way the Plex list was; it is a narrowing of what is offered,
 * so the cost of being wrong is an order somebody cannot choose rather than a
 * grid that empties.
 */
const COLLECTION_UNFIT = new Set(["Random", "Runtime", "DatePlayed"]);

interface PlaybackInfoResponse {
  MediaSources?: JellyfinMediaSource[];
  PlaySessionId?: string;
}

/**
 * What this box can play, and what it will accept instead.
 *
 * mpv on the Pi plays everything this library holds, so the profile says so
 * rather than describing codecs one by one - and a server that decides to
 * transcode anyway still answers with a URL.
 */
function deviceProfileBody(maxBitrateKbps?: number): Record<string, unknown> {
  return {
    DeviceProfile: {
      MaxStreamingBitrate: maxBitrateKbps ? maxBitrateKbps * 1000 : 200_000_000,
      DirectPlayProfiles: [{ Type: "Video" }, { Type: "Audio" }],
      TranscodingProfiles: [
        { Type: "Video", Container: "ts", VideoCodec: "h264", AudioCodec: "aac", Protocol: "hls" },
      ],
      SubtitleProfiles: [
        { Format: "srt", Method: "External" },
        { Format: "subrip", Method: "External" },
      ],
    },
    MaxStreamingBitrate: maxBitrateKbps ? maxBitrateKbps * 1000 : undefined,
  };
}

interface ItemsResponse {
  Items?: JellyfinItem[];
  TotalRecordCount?: number;
}

export class JellyfinBackend implements MediaBackend {
  readonly kind = "jellyfin" as const;

  constructor(
    private session: Session,
    private id: JellyfinIdentity,
  ) {}

  private get base(): string {
    return this.session.baseUrl;
  }

  private get userId(): string {
    return this.session.profileId;
  }

  private req<T>(path: string, opts: Parameters<typeof request>[3] = {}): Promise<T> {
    return request<T>(this.base, path, this.id, { token: this.session.token, ...opts });
  }

  // --- auth ---

  beginDeviceLogin(): Promise<DeviceLogin> {
    return beginQuickConnect(this.base, this.id);
  }

  async listProfiles(): Promise<Profile[]> {
    return listUsers(this.session);
  }

  async switchProfile(id: string): Promise<Session> {
    // Signing in as somebody else needs their own credential, which this box
    // does not hold - see the note in auth.ts. Refusing here is what sends the
    // screen back to the sign-in rather than leaving it on a picker that cannot
    // do anything.
    if (id === this.session.profileId) return this.session;
    throw new Error("another Jellyfin user has to sign in for themselves");
  }

  // --- browse ---

  async libraries(): Promise<Library[]> {
    const res = await this.req<ItemsResponse>("UserViews", { query: { userId: this.userId } });
    return (res.Items || []).map(toLibrary).filter((l) => l.kind !== "music" && l.kind !== "photo");
  }

  /**
   * What to carry on with.
   *
   * Two lists, because Jellyfin keeps them apart and a television wants one row:
   * what was left partway (`Resume`), then the next unwatched episode of a
   * series already started (`NextUp`). A series appears in only one of them, so
   * the join is an append rather than a merge - but an id is checked anyway,
   * because an episode left partway is in both when its series has more.
   */
  async onDeck(): Promise<MediaItem[]> {
    const [resume, next] = await Promise.all([
      this.req<ItemsResponse>("UserItems/Resume", {
        query: { userId: this.userId, limit: 24, fields: LIST_FIELDS, enableTotalRecordCount: false },
      }).catch(() => ({}) as ItemsResponse),
      this.req<ItemsResponse>("Shows/NextUp", {
        query: { userId: this.userId, limit: 24, fields: LIST_FIELDS, enableTotalRecordCount: false },
      }).catch(() => ({}) as ItemsResponse),
    ]);
    const seen = new Set<string>();
    const out: MediaItem[] = [];
    for (const it of [...(resume.Items || []), ...(next.Items || [])]) {
      if (seen.has(it.Id)) continue;
      seen.add(it.Id);
      out.push(toItem(it));
    }
    return out;
  }

  async recentlyAdded(libraryId?: string): Promise<MediaItem[]> {
    const res = await this.req<JellyfinItem[]>("Items/Latest", {
      query: { userId: this.userId, parentId: libraryId, limit: 24, fields: LIST_FIELDS },
    });
    // This endpoint answers with a bare array rather than the usual envelope.
    return (Array.isArray(res) ? res : []).map(toItem);
  }

  /**
   * One page of a library.
   *
   * `recursive` is what makes a series library answer with SERIES rather than
   * with the folders under it, and it is also what a film library needs when
   * the files sit in per-title directories - which is how this household's are
   * arranged.
   */
  async libraryPage(libraryId: string, q: PageQuery): Promise<Page<MediaItem>> {
    const res = await this.req<ItemsResponse>("Items", { query: this.itemsQuery(libraryId, q) });
    return { items: (res.Items || []).map(toItem), total: res.TotalRecordCount };
  }

  /** One page of a library, as query parameters. Shared so a letter page and an
   *  ordinary page cannot drift apart in what they ask for. */
  private itemsQuery(libraryId: string, q: PageQuery): Record<string, string | number | boolean | undefined> {
    return {
      userId: this.userId,
      // Box sets live in a folder of their own, so a query for them scoped to a
      // film library answers with nothing - and nothing is what an empty grid
      // looks like when it is working. The rule belongs here rather than in
      // `collections()` alone, or the A-Z strip and every page after the first
      // ask the wrong question.
      parentId: q.of === "collections" ? undefined : libraryId,
      recursive: true,
      includeItemTypes: q.of === "collections" ? "BoxSet" : "Movie,Series",
      startIndex: q.offset,
      limit: q.limit,
      sortBy: sortKey(q.sort),
      sortOrder: q.desc ? "Descending" : "Ascending",
      fields: LIST_FIELDS,
      ...this.filterQuery(q.filters),
    };
  }

  /** The app's filter keys, in the query parameters Jellyfin names them with. */
  private filterQuery(filters?: Record<string, string>): Record<string, string | boolean | undefined> {
    const f = filters || {};
    return {
      genres: f.genre,
      years: f.year,
      officialRatings: f.contentRating,
      filters: f.unwatched === "1" ? "IsUnplayed" : undefined,
    };
  }

  async sortOptions(_libraryId?: string, of?: "collections"): Promise<SortOption[]> {
    // A fixed list rather than an asked one: Jellyfin has no endpoint that
    // names its sorts, so unlike the Plex side there is nothing to ask. The
    // keys are the server's own; only the labels are ours. Read at call time,
    // so a change of language reaches a screen that is already open.
    return SORTS.filter((s) => !(of === "collections" && COLLECTION_UNFIT.has(s.key))).map((s) => ({
      key: s.key,
      title: s.title(),
    }));
  }

  /**
   * The collections a library's titles belong to.
   *
   * NOT asked under the library's own id: Jellyfin keeps box sets in a folder
   * of their own, so a query with `parentId` set to a film library answers with
   * nothing at all - and nothing is what an empty grid looks like when it is
   * working. Asked across the server instead.
   */
  async collections(_libraryId: string, q: PageQuery): Promise<Page<MediaItem>> {
    const res = await this.req<ItemsResponse>("Items", {
      query: {
        userId: this.userId,
        recursive: true,
        includeItemTypes: "BoxSet",
        startIndex: q.offset,
        limit: q.limit,
        sortBy: sortKey(q.sort),
        sortOrder: q.desc ? "Descending" : "Ascending",
        fields: LIST_FIELDS,
        // The A-Z strip counts this list through `count()`, which applies these.
        // Left out here, the strip and the grid describe two different lists and
        // a letter press jumps to an offset in the one you cannot see.
        ...this.filterQuery(q.filters),
      },
    });
    return { items: (res.Items || []).map(toItem), total: res.TotalRecordCount };
  }

  async playlists(): Promise<MediaItem[]> {
    const res = await this.req<ItemsResponse>("Items", {
      query: {
        userId: this.userId,
        recursive: true,
        includeItemTypes: "Playlist",
        sortBy: "SortName",
        fields: LIST_FIELDS,
      },
    });
    return (res.Items || []).map(toItem);
  }

  async playlistItems(id: string): Promise<MediaItem[]> {
    const res = await this.req<ItemsResponse>(`Playlists/${encodeURIComponent(id)}/Items`, {
      query: { userId: this.userId, fields: LIST_FIELDS },
    });
    return (res.Items || []).map(toItem);
  }

  async filterOptions(_libraryId?: string, of?: "collections"): Promise<FilterOption[]> {
    // Nothing for a collection list, because nothing here is measured. Which
    // filters a BoxSet honours on this server is unknown - and the A-Z strip
    // counts through a different query than the grid pages through, so a filter
    // that only one of them applies puts a letter jump on the wrong list.
    if (of === "collections") return [];
    return [
      { key: "genre", title: label("jellyfin.genre"), kind: "list" },
      { key: "unwatched", title: label("jellyfin.unwatched"), kind: "flag" },
    ];
  }

  async filterValues(libraryId: string, filter: string, _path?: string): Promise<SortOption[]> {
    if (filter !== "genre") return [];
    const res = await this.req<{ Genres?: { Name?: string; Id?: string }[] }>("Items/Filters2", {
      query: { userId: this.userId, parentId: libraryId, includeItemTypes: "Movie,Series" },
    });
    // Keyed by NAME, because that is what the item query filters on - the id is
    // the genre's own item, which `genres=` does not accept.
    return (res.Genres || []).map((g) => ({ key: g.Name || "", title: g.Name || "" })).filter((g) => g.key);
  }

  /**
   * The A-Z strip.
   *
   * Jellyfin has no endpoint that answers with the buckets and their sizes, so
   * they are counted: one request per letter, each asking for NO items and only
   * the total. Twenty-six tiny requests is a lot for one screen, so the answer
   * is kept for as long as the library and its filters are the same - opening a
   * library twice costs it once.
   *
   * A letter with nothing under it is dropped rather than shown greyed: a strip
   * on a television is a column of targets, and one that cannot be pressed is a
   * press that appears to do nothing.
   */
  async letters(libraryId: string, filters?: Record<string, string>, of?: "collections"): Promise<Letter[]> {
    const key = JSON.stringify([libraryId, filters ?? {}, of ?? ""]);
    const cached = this.letterCache.get(key);
    if (cached) return cached;
    const counts = await Promise.all(
      ALPHABET.map((letter) =>
        this.count(libraryId, of, filters, { nameStartsWith: letter }).then((size) => ({
          key: letter,
          title: letter,
          size,
        })),
      ),
    );
    const out = counts.filter((l) => l.size > 0);
    // Only worth keeping when it worked: a strip counted during an outage is a
    // strip with nothing in it, and it would then be remembered as empty.
    if (out.length) this.letterCache.set(key, out);
    return out;
  }

  /**
   * Where a letter's items begin.
   *
   * Counted rather than summed from the bucket sizes, which is the mistake the
   * sibling backend records: the strip and the sort have to agree about where
   * an accented initial goes, and only the server can say. `nameLessThan` asks
   * exactly that question - how many titles sort before this letter.
   */
  async letterOffset(
    libraryId: string,
    letterKey: string,
    q: Omit<PageQuery, "offset" | "limit">,
  ): Promise<number> {
    return this.count(libraryId, q.of, q.filters, { nameLessThan: letterKey });
  }

  async letterPage(libraryId: string, letterKey: string, q: PageQuery): Promise<Page<MediaItem>> {
    const res = await this.req<ItemsResponse>("Items", {
      query: {
        ...this.itemsQuery(libraryId, q),
        nameStartsWith: letterKey,
      },
    });
    return { items: (res.Items || []).map(toItem), total: res.TotalRecordCount };
  }

  /** How many items match, without fetching any of them. */
  private async count(
    libraryId: string,
    of: "collections" | undefined,
    filters: Record<string, string> | undefined,
    extra: Record<string, string>,
  ): Promise<number> {
    const res = await this.req<ItemsResponse>("Items", {
      query: {
        userId: this.userId,
        parentId: of === "collections" ? undefined : libraryId,
        recursive: true,
        includeItemTypes: of === "collections" ? "BoxSet" : "Movie,Series",
        limit: 0,
        enableTotalRecordCount: true,
        ...this.filterQuery(filters),
        ...extra,
      },
    }).catch(() => ({}) as ItemsResponse);
    return res.TotalRecordCount ?? 0;
  }

  async item(id: string): Promise<ItemDetail> {
    // No `fields` here: this route declares none and answers with the lot
    // anyway - people, chapters and media sources included, verified against
    // the live server. A name it does not know would be dropped in silence, so
    // sending a list would read as working while doing nothing.
    const it = await this.req<JellyfinItem>(`Items/${encodeURIComponent(id)}`, {
      query: { userId: this.userId },
    });
    return toDetail(it);
  }

  async children(id: string): Promise<MediaItem[]> {
    const res = await this.req<ItemsResponse>("Items", {
      query: { userId: this.userId, parentId: id, sortBy: "SortName", fields: LIST_FIELDS },
    });
    return (res.Items || []).map(toItem);
  }

  /** Jellyfin holds no soundtrack listing; the screen draws nothing for empty. */
  async soundtrack(): Promise<MediaItem[]> {
    return [];
  }

  async search(query: string): Promise<MediaItem[]> {
    const res = await this.req<ItemsResponse>("Items", {
      query: {
        userId: this.userId,
        searchTerm: query,
        recursive: true,
        includeItemTypes: "Movie,Series,Episode",
        limit: 60,
        fields: LIST_FIELDS,
      },
    });
    return (res.Items || []).map(toItem);
  }

  async personCredits(person: PersonRef): Promise<CreditSet> {
    const res = await this.req<ItemsResponse>("Items", {
      query: {
        userId: this.userId,
        personIds: person.id,
        recursive: true,
        includeItemTypes: "Movie,Series",
        sortBy: "PremiereDate",
        sortOrder: "Descending",
        limit: 60,
        fields: LIST_FIELDS,
      },
    });
    return { person, items: (res.Items || []).map(toItem), truncated: (res.TotalRecordCount || 0) > 60 };
  }

  // --- art ---

  /**
   * A poster at the size it will be drawn.
   *
   * No credential in it, because none is needed - measured against the server.
   * `fillWidth`/`fillHeight` rather than `maxWidth`: the tile is a fixed box and
   * a poster that keeps its own aspect leaves a stripe of background down one
   * side of every third tile.
   */
  posterUrl(item: MediaItem, w: number, h: number): string | undefined {
    return this.sized(item.thumb, w, h);
  }

  /**
   * Resolve a server-supplied path against this server, or drop it.
   *
   * The origin is read off the RESOLVED url, never off the string. Deciding
   * "is this absolute?" with a pattern and then resolving with `new URL` is two
   * parsers reading one value, and they disagree: the URL parser strips leading
   * and trailing spaces and every tab, CR and LF anywhere in the input before it
   * parses, so "\thttp://elsewhere/x" is not absolute to a pattern and is
   * absolute to the parser. Resolving first collapses the two readings into one
   * and covers the case-, protocol-relative- and scheme- variants without a rule
   * for each.
   *
   * Every string this is given comes from the server: an image tag, a subtitle's
   * delivery path, a transcoding URL. Same origin also means same SCHEME, which
   * is what keeps `file://` and `smb://` out of something handed to mpv.
   */
  private onServer(path: string): URL | undefined {
    let base: URL;
    try {
      base = new URL(this.base);
    } catch {
      return undefined;
    }
    const root = this.base.endsWith("/") ? this.base : this.base + "/";
    let url: URL;
    let raw: URL;
    try {
      // Twice, and both have to land on this server. The first strips the
      // leading slash so a base that carries a path - a server behind a proxy -
      // keeps it. The second reads the value as written, which is what catches
      // the protocol-relative form: "//elsewhere/x" loses one slash in the
      // first reading and becomes an innocent path on our own host, so it would
      // pass while plainly meaning another host. Refusing it is a decision;
      // surviving it by accident is not.
      url = new URL(path.replace(/^\//, ""), root);
      raw = new URL(path, root);
    } catch {
      return undefined;
    }
    if (url.origin !== base.origin || raw.origin !== base.origin) {
      log.warn("a server-supplied URL points off the server; dropped");
      return undefined;
    }
    return url;
  }

  private sized(path: string | undefined, w: number, h: number): string | undefined {
    if (!path) return undefined;
    const url = this.onServer(path);
    if (!url) return undefined;
    url.searchParams.set("fillWidth", String(Math.round(w)));
    url.searchParams.set("fillHeight", String(Math.round(h)));
    url.searchParams.set("quality", "90");
    return url.toString();
  }

  imageHeaders(): Record<string, string> {
    return {};
  }

  backdropUrl(item: MediaItem, w: number, h: number): string | undefined {
    return this.sized(item.art, w, h);
  }

  artUrl(path: string): string | undefined {
    return this.onServer(path)?.toString();
  }

  chapterThumbUrl(thumb: string, w: number, h: number): string | undefined {
    return this.sized(thumb, w, h);
  }

  /**
   * A frame from the film, for scrubbing.
   *
   * Jellyfin ships trickplay as TILES - one image holding a grid of frames -
   * which cannot be handed to an <img> as a single frame. Until the tile
   * arithmetic is written, the scrub bar does without, which it is built to do.
   */
  previewUrl(): string | undefined {
    return undefined;
  }

  /** Theme music: Jellyfin has it per item, but not as a plain URL. Not yet. */
  themeUrl(): string | undefined {
    return undefined;
  }

  subtitleFileUrl(track: Track): string | undefined {
    if (!track.external || !track.key) return undefined;
    // The player is another process and cannot send a header, so this one URL
    // carries the token - the same trade the Plex side makes for the stream
    // itself, and the reason `redact.ts` exists.
    const url = this.onServer(track.key);
    // Dropped rather than fetched without the credential: this URL reaches
    // ANOTHER PROCESS with the token on it, and a server that names another
    // host is naming somewhere to send the token to. Measured on the sibling
    // backend and stated there: the rule is not "bound these three functions",
    // it is "bound everything the token is attached to".
    if (!url) return undefined;
    url.searchParams.set("api_key", this.session.token);
    return url.toString();
  }

  // --- playback ---

  async resolveStream(
    id: string,
    opts: {
      session: string;
      version?: number;
      partId?: string;
      audio?: number;
      subtitle?: number | "none";
      maxBitrateKbps?: number;
    },
  ): Promise<StreamDecision> {
    const ask = (extra: Record<string, unknown> = {}): Promise<PlaybackInfoResponse> =>
      this.req<PlaybackInfoResponse>(`Items/${encodeURIComponent(id)}/PlaybackInfo`, {
        method: "POST",
        query: { userId: this.userId },
        body: { ...deviceProfileBody(opts.maxBitrateKbps), ...extra },
      });

    // Named on the way IN when the caller knows which file it wants, so the
    // server ranks nothing and answers about that one.
    let info = await ask(opts.partId ? { MediaSourceId: opts.partId } : {});
    const sources = info.MediaSources || [];
    // By identity when the caller has one, by position only when it does not.
    // This endpoint RANKS the files it returns, so its order is its own: picking
    // by position played one file while reporting another, and everything
    // downstream indexes the versions array with that number - the scrub
    // thumbnails and the mid-playback track menu both read a version that was
    // never playing.
    let source = opts.partId ? sources.find((s) => s.Id === opts.partId) : sources[opts.version ?? 0];
    if (!source) {
      // Refused rather than quietly played as file 0: a person who chose the
      // Hungarian copy would otherwise get the English one with nothing said.
      throw new Error("the server does not have the file that was asked for");
    }

    // A transcode is BUILT by the server, so the tracks have to be named before
    // it builds one - the URL carries the audio it chose, and returning the
    // caller's choice beside a stream that ignores it is a report of something
    // that is not happening. Asked again only when there is a transcode AND a
    // choice to honour, which is the uncommon case.
    const chosen = source;
    const audioTracks = toTracks(chosen.MediaStreams, "Audio");
    const subTracksFirst = toTracks(chosen.MediaStreams, "Subtitle");
    const audioIndex = typeof opts.audio === "number" ? audioTracks.find((t) => t.ordinal === opts.audio)?.id : undefined;
    const subInside =
      typeof opts.subtitle === "number" ? subTracksFirst.find((t) => t.ordinal === opts.subtitle && !t.external) : undefined;
    if (chosen.TranscodingUrl && (audioIndex !== undefined || subInside)) {
      const again = await ask({
        MediaSourceId: chosen.Id,
        ...(audioIndex !== undefined ? { AudioStreamIndex: Number(audioIndex) } : {}),
        ...(subInside ? { SubtitleStreamIndex: Number(subInside.id) } : {}),
      }).catch(() => undefined);
      const rebuilt = again?.MediaSources?.find((s2) => s2.Id === chosen.Id);
      if (rebuilt) {
        info = again!;
        source = rebuilt;
      }
    }

    const transcoded = !!source.TranscodingUrl;
    let url: string;
    if (transcoded) {
      // The server chose this string, and the box is about to hand it to mpv
      // with the token on it - so where it points is the server's decision
      // unless it is bounded here. Off-origin is refused rather than played:
      // an unplayable film is a bad evening, a token posted to somebody else's
      // host is worse and silent.
      const resolved = this.onServer(source.TranscodingUrl!);
      if (!resolved) throw new Error("the server pointed the stream somewhere else");
      resolved.searchParams.set("api_key", this.session.token);
      url = resolved.toString();
    } else {
      url = buildUrl(this.base, `Videos/${encodeURIComponent(id)}/stream`, {
        static: true,
        mediaSourceId: source.Id,
        api_key: this.session.token,
      });
    }

    const subs = toTracks(source.MediaStreams, "Subtitle");
    // BY ORDINAL, not by array position. They agree for embedded tracks and
    // they do not for a sidecar, whose ordinal is negative - so indexing with
    // one read off the end of the array, the choice became "auto", and a
    // subtitle the person had just turned on never appeared. This library holds
    // sidecars beside 487 films, and for a film whose only subtitle is one of
    // them the row was simply a lie.
    const chosenSub =
      typeof opts.subtitle === "number" ? subs.find((t) => t.ordinal === opts.subtitle) : undefined;
    if (info.PlaySessionId) this.stoppedItems.set(info.PlaySessionId, id);
    this.playing = { session: info.PlaySessionId, itemId: id, started: false, stopped: false };
    return {
      url,
      audio: typeof opts.audio === "number" ? opts.audio : "auto",
      sub: opts.subtitle === "none" ? "no" : chosenSub && !chosenSub.external ? chosenSub.ordinal : "auto",
      subFile: chosenSub?.external ? this.subtitleFileUrl(chosenSub) : undefined,
      subtitlesBurnedIn: false,
      // The position of the file that IS playing, so the versions array can be
      // indexed with it.
      // Found by id rather than by object: after a transcode is asked for a
      // second time the source is a NEW object from that answer, so looking it
      // up in the first answer's array returned -1 and the version reported as
      // 0 - a file chosen deliberately, reported as the default one.
      version: opts.partId ? Math.max(0, sources.findIndex((s3) => s3.Id === chosen.Id)) : (opts.version ?? 0),
      session: info.PlaySessionId,
      location: this.session.location,
      transcoded,
    };
  }

  /** Jellyfin remembers a choice per playback rather than per item; nothing to send. */
  async setTracks(): Promise<void> {}

  /**
   * Subtitles the server can fetch. Refused rather than answered empty.
   *
   * An empty list means "searched, found nothing", and the screen says exactly
   * that - so somebody tries Hungarian, then English, then German, per film,
   * against a search that never ran. A rejection is what reaches the honest
   * string the locale already carries: this server has no subtitle service.
   */
  async searchSubtitles(): Promise<Track[]> {
    throw new Error("this server has no subtitle provider");
  }

  async addSubtitle(): Promise<void> {}

  /**
   * Intro and credits, from the server's own media segments.
   *
   * 10.10 and later hold these; older servers answer 404, which becomes an empty
   * list rather than an error - a film without markers is the ordinary case.
   */
  async markers(id: string, durationMs?: number): Promise<Marker[]> {
    interface Segment {
      Type?: string;
      StartTicks?: number;
      EndTicks?: number;
    }
    const res = await this.req<{ Items?: Segment[] }>(`MediaSegments/${encodeURIComponent(id)}`).catch(
      () => ({}) as { Items?: Segment[] },
    );
    const map: Record<string, Marker["type"]> = {
      Intro: "intro",
      Outro: "credits",
      Commercial: "commercial",
      Preview: "commercial",
      Recap: "intro",
    };
    return (res.Items || [])
      .map((s) => {
        const endMs = Math.round((s.EndTicks || 0) / 10_000);
        return {
          type: map[s.Type || ""] || ("intro" as const),
          startMs: Math.round((s.StartTicks || 0) / 10_000),
          endMs,
          // "Runs to the end" is what turns a credits marker into the up-next
          // countdown rather than a skip button. Jellyfin does not say it, so
          // this is decided from the duration when the caller knows one - within
          // ten seconds, because a segment rarely ends on the last frame - and
          // otherwise from the type: an Outro IS the closing credits, and the
          // caller currently passes no duration.
          final: durationMs ? endMs >= durationMs - 10_000 : s.Type === "Outro",
        };
      })
      .filter((m) => m.endMs > m.startMs);
  }

  /**
   * The session the server built for what is playing, and what is playing in it.
   *
   * Held because the progress reports do not carry them: the interface passes
   * an item and a position, and Jellyfin wants both of those PLUS the session
   * it issued - a stop with no item is a stop it cannot attribute, and its own
   * log says so ("PlaybackStopped reported with null media info").
   */
  /** Sessions already stopped, so a late teardown says nothing twice. */
  private stoppedSessions = new Set<string>();
  /** What each session was playing, for a stop that arrives after the next
   *  film has been set up. */
  private stoppedItems = new Map<string, string>();
  /** Counted strips, per library and filter set. See `letters`. */
  private letterCache = new Map<string, Letter[]>();
  private playing: { session?: string; itemId?: string; started: boolean; stopped: boolean } = {
    started: false,
    stopped: false,
  };

  async keepAlive(): Promise<void> {
    // Progress reports are what keep a session alive here; there is no separate
    // ping, and sending one would open a second session against the same file.
  }

  /**
   * Close a session the scheduler has not already closed.
   *
   * It carries the ITEM as well as the session id. Without one the server
   * accepts the stop and logs `PlaybackStopped reported with null media info` -
   * seen in this server's own log, from this app - and a stop it cannot
   * attribute cannot clear what the session was holding.
   *
   * Skipped entirely when a stop has already gone out for this session, which
   * is the ordinary path: the scheduler reports `stopped` and then teardown
   * calls this, and the second one was the line in the log.
   */
  async endSession(session: string): Promise<void> {
    // Per SESSION, not per backend: a stop for the film that just ended can
    // arrive after `resolveStream` has already set up the next one, and a flag
    // shared between them marked the NEW session stopped while sending the old
    // one with the new film's id.
    if (this.stoppedSessions.has(session)) return;
    this.stoppedSessions.add(session);
    if (this.playing.session === session) this.playing.stopped = true;
    const itemId = this.playing.session === session ? this.playing.itemId : this.stoppedItems.get(session);
    // Without an item the server accepts the stop and cannot attribute it - its
    // own log says so - and an `undefined` here is dropped by JSON entirely,
    // which is the same thing said more quietly.
    await this.req("Sessions/Playing/Stopped", {
      method: "POST",
      body: itemId ? { PlaySessionId: session, ItemId: itemId } : { PlaySessionId: session },
    }).catch((e) => log.warn("could not end the session", e));
  }

  /**
   * Anything this box left playing.
   *
   * Jellyfin ties a session to the device id rather than to a token, so its own
   * `/Sessions` list is the place to look - but stopping another device's
   * session is an administrator's right, and this token may not have it. So the
   * reap is best effort and reports what it managed.
   */
  async reapOwnSessions(): Promise<number> {
    try {
      const sessions = await this.req<{ Id: string; DeviceId?: string; NowPlayingItem?: { Id?: string } }[]>("Sessions");
      const mine = (sessions || []).filter((s) => s.DeviceId === this.id.deviceId && s.NowPlayingItem);
      let stopped = 0;
      for (const s of mine) {
        // Counted after the attempt rather than before it: this token may not
        // be allowed to stop a session at all, and reporting a number that only
        // says how many were FOUND is how a reaper looks like it works.
        const ok = await this.req("Sessions/Playing/Stopped", {
          method: "POST",
          body: { PlaySessionId: s.Id, ItemId: (s.NowPlayingItem as { Id?: string } | undefined)?.Id },
        })
          .then(() => true)
          .catch(() => false);
        if (ok) stopped += 1;
      }
      return stopped;
    } catch {
      return 0;
    }
  }

  // --- state ---

  /**
   * Tell the server this token is finished with.
   *
   * A Quick Connect token does not expire, so without this a sign-out leaves it
   * valid on the server and listed as an active device - while the box has just
   * deleted its only copy of it, which is what makes it unrevocable from here.
   * Best effort: a sign-out must not be blocked by a server that is off.
   */
  async revokeSession(): Promise<void> {
    await this.req("Sessions/Logout", { method: "POST" }).catch((e) =>
      log.warn("the server was not told this session ended", e),
    );
  }

  async reportProgress(id: string, positionMs: number, _durationMs: number, state: PlaybackState): Promise<void> {
    // The START is decided by whether one has been sent for this session, not
    // by the position being zero. A film RESUMED begins at its own offset, so
    // keying on the position meant a resumed film never reported a start at all
    // - and a session that never started is not in the server's list, which is
    // what `reapOwnSessions` looks in for its own leftovers.
    const body = {
      ItemId: id,
      PlaySessionId: this.playing.session,
      PositionTicks: msToTicks(positionMs),
      IsPaused: state === "paused",
      PlayMethod: "DirectStream",
    };
    let path: string;
    if (state === "stopped") {
      if (this.playing.stopped) return;
      this.playing.stopped = true;
      path = "Sessions/Playing/Stopped";
    } else if (!this.playing.started) {
      this.playing.started = true;
      this.playing.itemId = id;
      path = "Sessions/Playing";
    } else {
      path = "Sessions/Playing/Progress";
    }
    await this.req(path, { method: "POST", body }).catch((e) => log.warn("could not report progress", e));
  }

  async setWatched(id: string, watched: boolean): Promise<void> {
    await this.req(`UserPlayedItems/${encodeURIComponent(id)}`, {
      method: watched ? "POST" : "DELETE",
      query: { userId: this.userId },
    });
  }

  async history(limit: number): Promise<HistoryRow[]> {
    const res = await this.req<ItemsResponse>("Items", {
      query: {
        userId: this.userId,
        recursive: true,
        includeItemTypes: "Movie,Episode",
        filters: "IsPlayed",
        sortBy: "DatePlayed",
        sortOrder: "Descending",
        limit,
      },
    });
    return (res.Items || []).map((it) => ({
      itemId: it.Id,
      title: it.Name || "",
      viewedAt: Math.round(Date.parse(it.UserData?.LastPlayedDate || "") / 1000) || 0,
      accountId: this.userId,
    }));
  }
}

/** Chapters are mapped in `map.ts`; re-exported so the tests can reach them. */
export { toChapters };

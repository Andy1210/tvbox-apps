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
const LIST_FIELDS = "Overview,SortName,DateCreated,ParentId,PrimaryImageAspectRatio,ProductionYear";
/** What a detail screen needs, which is everything a grid does not. */
const DETAIL_FIELDS =
  "Overview,SortName,DateCreated,Genres,Studios,Taglines,People,ProviderIds,Chapters,MediaSources,MediaStreams,ParentId,ProductionYear";

/** Jellyfin's own sort keys, with what to call them on screen. */
const SORTS: { key: string; title: string }[] = [
  { key: "SortName", title: "Név" },
  { key: "DateCreated", title: "Hozzáadva" },
  { key: "PremiereDate", title: "Megjelenés" },
  { key: "CommunityRating", title: "Értékelés" },
  { key: "Runtime", title: "Hossz" },
  { key: "DatePlayed", title: "Utoljára nézve" },
  { key: "Random", title: "Véletlen" },
];

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
    const res = await this.req<ItemsResponse>("Items", {
      query: {
        userId: this.userId,
        parentId: libraryId,
        recursive: true,
        includeItemTypes: q.of === "collections" ? "BoxSet" : "Movie,Series",
        startIndex: q.offset,
        limit: q.limit,
        sortBy: q.sort || "SortName",
        sortOrder: q.desc ? "Descending" : "Ascending",
        fields: LIST_FIELDS,
        ...this.filterQuery(q.filters),
      },
    });
    return { items: (res.Items || []).map(toItem), total: res.TotalRecordCount };
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

  async sortOptions(): Promise<SortOption[]> {
    // A fixed list rather than an asked one: Jellyfin has no endpoint that
    // names its sorts, so unlike the Plex side there is nothing to ask. The
    // keys are the server's own; only the labels are ours.
    return SORTS;
  }

  async collections(libraryId: string, q: PageQuery): Promise<Page<MediaItem>> {
    return this.libraryPage(libraryId, { ...q, of: "collections" });
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

  async filterOptions(): Promise<FilterOption[]> {
    return [
      { key: "genre", title: "Műfaj", kind: "list" },
      { key: "unwatched", title: "Amit még nem láttam", kind: "flag" },
    ];
  }

  async filterValues(libraryId: string, filter: string): Promise<SortOption[]> {
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
   * Not implemented against this server yet: Jellyfin has no endpoint that
   * answers with the buckets and their sizes, so the strip would have to be
   * derived by counting - one request per letter. Returning nothing hides the
   * strip, which is the honest state until that is measured rather than a
   * broken strip that scrolls to the wrong place.
   */
  async letters(): Promise<{ key: string; title: string; size: number }[]> {
    return [];
  }

  async letterOffset(): Promise<number> {
    return 0;
  }

  async letterPage(libraryId: string, _letterKey: string, q: PageQuery): Promise<Page<MediaItem>> {
    return this.libraryPage(libraryId, q);
  }

  async item(id: string): Promise<ItemDetail> {
    const it = await this.req<JellyfinItem>(`Items/${encodeURIComponent(id)}`, {
      query: { userId: this.userId, fields: DETAIL_FIELDS },
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

  private sized(path: string | undefined, w: number, h: number): string | undefined {
    if (!path) return undefined;
    const url = new URL(path, this.base.endsWith("/") ? this.base : this.base + "/");
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
    if (/^https?:\/\//i.test(path)) return undefined;
    return buildUrl(this.base, path);
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
    const url = new URL(track.key.replace(/^\//, ""), this.base.endsWith("/") ? this.base : this.base + "/");
    url.searchParams.set("api_key", this.session.token);
    return url.toString();
  }

  // --- playback ---

  async resolveStream(
    id: string,
    opts: { session: string; version?: number; audio?: number; subtitle?: number | "none"; maxBitrateKbps?: number },
  ): Promise<StreamDecision> {
    const info = await this.req<{ MediaSources?: JellyfinMediaSource[]; PlaySessionId?: string }>(
      `Items/${encodeURIComponent(id)}/PlaybackInfo`,
      {
        method: "POST",
        query: { userId: this.userId },
        body: {
          // What this box can play without help. mpv on the Pi plays everything
          // the library holds, so the profile says so rather than describing
          // codecs one by one - and a server that decides to transcode anyway
          // still answers with a URL, which is the case below.
          DeviceProfile: {
            MaxStreamingBitrate: opts.maxBitrateKbps ? opts.maxBitrateKbps * 1000 : 200_000_000,
            DirectPlayProfiles: [{ Type: "Video" }, { Type: "Audio" }],
            TranscodingProfiles: [
              { Type: "Video", Container: "ts", VideoCodec: "h264", AudioCodec: "aac", Protocol: "hls" },
            ],
            SubtitleProfiles: [{ Format: "srt", Method: "External" }, { Format: "subrip", Method: "External" }],
          },
          MaxStreamingBitrate: opts.maxBitrateKbps ? opts.maxBitrateKbps * 1000 : undefined,
        },
      },
    );
    const sources = info.MediaSources || [];
    const source = sources[opts.version ?? 0] || sources[0];
    if (!source) throw new Error("the server offered no file for this");

    const transcoded = !!source.TranscodingUrl;
    const url = transcoded
      ? buildUrl(this.base, source.TranscodingUrl!.replace(/^\//, ""), { api_key: this.session.token })
      : buildUrl(this.base, `Videos/${encodeURIComponent(id)}/stream`, {
          static: true,
          mediaSourceId: source.Id,
          api_key: this.session.token,
        });

    const subs = toTracks(source.MediaStreams, "Subtitle");
    const chosenSub = typeof opts.subtitle === "number" ? subs[opts.subtitle] : undefined;
    return {
      url,
      audio: typeof opts.audio === "number" ? opts.audio : "auto",
      sub: opts.subtitle === "none" ? "no" : chosenSub && !chosenSub.external ? chosenSub.ordinal : "auto",
      subFile: chosenSub?.external ? this.subtitleFileUrl(chosenSub) : undefined,
      subtitlesBurnedIn: false,
      version: opts.version ?? 0,
      session: info.PlaySessionId,
      location: this.session.location,
      transcoded,
    };
  }

  /** Jellyfin remembers a choice per playback rather than per item; nothing to send. */
  async setTracks(): Promise<void> {}

  /** Subtitle search needs a provider plugin; none is configured on this server. */
  async searchSubtitles(): Promise<Track[]> {
    return [];
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

  async keepAlive(): Promise<void> {
    // Progress reports are what keep a session alive here; there is no separate
    // ping, and sending one would open a second session against the same file.
  }

  async endSession(session: string): Promise<void> {
    await this.req("Sessions/Playing/Stopped", {
      method: "POST",
      body: { PlaySessionId: session },
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
      const sessions = await this.req<{ Id: string; DeviceId?: string; NowPlayingItem?: unknown }[]>("Sessions");
      const mine = (sessions || []).filter((s) => s.DeviceId === this.id.deviceId && s.NowPlayingItem);
      for (const s of mine) {
        await this.req("Sessions/Playing/Stopped", { method: "POST", body: { PlaySessionId: s.Id } }).catch(() => {});
      }
      return mine.length;
    } catch {
      return 0;
    }
  }

  // --- state ---

  async reportProgress(id: string, positionMs: number, _durationMs: number, state: PlaybackState): Promise<void> {
    const path =
      state === "stopped" ? "Sessions/Playing/Stopped" : positionMs > 0 ? "Sessions/Playing/Progress" : "Sessions/Playing";
    await this.req(path, {
      method: "POST",
      body: {
        ItemId: id,
        PositionTicks: msToTicks(positionMs),
        IsPaused: state === "paused",
        PlayMethod: "DirectStream",
      },
    }).catch((e) => log.warn("could not report progress", e));
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
        fields: "UserData",
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

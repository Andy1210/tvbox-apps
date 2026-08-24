// Jellyfin's own shapes, turned into the ones the screens read.
//
// Every field name here was read off this household's server rather than out of
// the API documentation, because the two disagree about what is present: a
// documented field that the server omits is indistinguishable from a mapping
// bug until something is missing on the television.
//
// The unit trap worth naming once: Jellyfin counts time in TICKS of 100
// nanoseconds, so a two-hour film is 72,000,000,000 of them. Everything above
// this file is in milliseconds.

import type { Chapter, ItemDetail, ItemKind, Library, MediaItem, MediaVersion, Role, Track } from "../types";

/** 100-nanosecond ticks to milliseconds. */
export function ticksToMs(ticks: number | undefined | null): number | undefined {
  if (typeof ticks !== "number" || !Number.isFinite(ticks)) return undefined;
  return Math.round(ticks / 10_000);
}

/** Milliseconds to ticks, for the values that go back the other way. */
export function msToTicks(ms: number): number {
  return Math.max(0, Math.round(ms)) * 10_000;
}

/** An ISO date to epoch SECONDS, which is what the item type carries. */
export function epochSeconds(iso: string | undefined | null): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round(t / 1000) : undefined;
}

export interface JellyfinUserData {
  PlaybackPositionTicks?: number;
  PlayCount?: number;
  Played?: boolean;
  IsFavorite?: boolean;
  LastPlayedDate?: string;
  UnplayedItemCount?: number;
}

export interface JellyfinItem {
  Id: string;
  Name?: string;
  Type?: string;
  SortName?: string;
  Overview?: string;
  ProductionYear?: number;
  PremiereDate?: string;
  DateCreated?: string;
  RunTimeTicks?: number;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ParentId?: string;
  SeriesId?: string;
  SeriesName?: string;
  SeasonName?: string;
  SeriesPrimaryImageTag?: string;
  CollectionType?: string;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  UserData?: JellyfinUserData;
  ChildCount?: number;
  RecursiveItemCount?: number;
  MediaSources?: JellyfinMediaSource[];
  MediaStreams?: JellyfinStream[];
}

export interface JellyfinStream {
  Index: number;
  Type?: string;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  Title?: string;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
  IsHearingImpaired?: boolean;
  Height?: number;
  Width?: number;
  Channels?: number;
  DeliveryUrl?: string;
}

export interface JellyfinMediaSource {
  Id: string;
  Name?: string;
  Path?: string;
  Container?: string;
  Size?: number;
  Bitrate?: number;
  RunTimeTicks?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  TranscodingUrl?: string;
  DirectStreamUrl?: string;
  MediaStreams?: JellyfinStream[];
  DefaultAudioStreamIndex?: number;
  DefaultSubtitleStreamIndex?: number;
}

/**
 * What kind of thing this is, in the app's vocabulary.
 *
 * Anything not modelled becomes a movie rather than being dropped: an unknown
 * type still has a title and a poster, and a row with a hole in it is worse than
 * a row with something slightly mislabelled in it.
 */
export function itemKind(type: string | undefined): ItemKind {
  switch (type) {
    case "Series":
      return "show";
    case "Season":
      return "season";
    case "Episode":
      return "episode";
    case "BoxSet":
      return "collection";
    case "Playlist":
      return "playlist";
    default:
      return "movie";
  }
}

/**
 * A library, from the user's own view list.
 *
 * `CollectionType` is absent on a mixed library, which is a real configuration
 * rather than an error - it becomes "other", and the screens treat it as a plain
 * grid.
 */
export function toLibrary(v: JellyfinItem): Library {
  const map: Record<string, Library["kind"]> = {
    movies: "movie",
    tvshows: "show",
    music: "music",
    homevideos: "other",
    photos: "photo",
    boxsets: "other",
  };
  return { id: v.Id, title: v.Name || "", kind: map[v.CollectionType || ""] || "other" };
}

/**
 * An image path, as the app's art fields carry it.
 *
 * The tag is part of it on purpose: it is the server's own cache key, so a
 * changed poster changes the URL and nothing has to be invalidated by hand.
 * Absent tag means the item has no image of that kind - and asking for one
 * anyway answers 404 with a placeholder, which is worse than drawing nothing.
 */
export function imagePath(id: string, tag: string | undefined, kind = "Primary"): string | undefined {
  if (!tag) return undefined;
  return `Items/${encodeURIComponent(id)}/Images/${kind}?tag=${encodeURIComponent(tag)}`;
}

export function toItem(it: JellyfinItem): MediaItem {
  const user = it.UserData || {};
  const kind = itemKind(it.Type);
  return {
    id: it.Id,
    kind,
    title: it.Name || "",
    sortTitle: it.SortName,
    year: it.ProductionYear,
    summary: it.Overview,
    durationMs: ticksToMs(it.RunTimeTicks),
    // Only when something was actually left partway: Jellyfin sends 0 for
    // everything untouched, and a 0 here would make every poster carry an empty
    // progress bar.
    viewOffsetMs: user.PlaybackPositionTicks ? ticksToMs(user.PlaybackPositionTicks) : undefined,
    viewCount: user.PlayCount,
    lastViewedAt: epochSeconds(user.LastPlayedDate),
    addedAt: epochSeconds(it.DateCreated),
    index: it.IndexNumber,
    parentIndex: it.ParentIndexNumber,
    parentId: it.ParentId,
    // An episode's "parent" reads as its series on screen even though its parent
    // in the tree is the season, which is what the season name is for.
    parentTitle: kind === "episode" ? it.SeasonName : undefined,
    grandparentTitle: it.SeriesName,
    grandparentId: it.SeriesId,
    grandparentThumb: imagePath(it.SeriesId || "", it.SeriesPrimaryImageTag),
    // An episode with no still of its own borrows the series' poster rather
    // than leaving a hole: the home screen's hero panel and its tint are drawn
    // from this, and a "carry on watching" row is mostly episodes.
    thumb: imagePath(it.Id, it.ImageTags?.Primary) ?? imagePath(it.SeriesId || "", it.SeriesPrimaryImageTag),
    art: imagePath(it.Id, it.BackdropImageTags?.[0], "Backdrop"),
    // Series and seasons only, which is where the Plex mapper below has always
    // drawn the line and why: a count of "unplayed children" is a fact about a
    // series, and painting it on a list said "278 unwatched" on 252 items. It
    // matters more now that a tile reads a zero here as FINISHED, so any other
    // kind Jellyfin chooses to count children for - a boxset, a playlist -
    // would carry a tick nobody defined. `viewCount` decides for those, as
    // before. Not measured against a live Jellyfin: this server has no
    // credential to hand, so the guard is the cautious shape rather than a
    // record of what it answers.
    unwatchedCount: kind === "show" || kind === "season" ? user.UnplayedItemCount : undefined,
  };
}

/**
 * The tracks of one media source, in the app's shape.
 *
 * The ordinals matter more than they look. The app selects an audio or subtitle
 * track by its position AMONG ITS OWN TYPE, because that is what mpv is handed;
 * Jellyfin numbers every stream in one sequence, video included. Both numbers
 * are kept: `id` is the server's index, which is what a playback request needs,
 * and the order of the array is what the player counts.
 */
export function toTracks(streams: JellyfinStream[] | undefined, type: "Audio" | "Subtitle"): Track[] {
  const kind = type === "Audio" ? ("audio" as const) : ("subtitle" as const);
  // The ordinal counts only what is INSIDE the file, because that is what the
  // player counts: an external subtitle has no position among the container's
  // tracks and is handed over as a file instead.
  //
  // Each sidecar gets its OWN negative ordinal rather than a shared -1. The
  // ordinal is how a choice is named on the way back down AND what the track
  // menu builds its focus keys from, so one value for all of them makes every
  // sidecar after the first unreachable with a remote and unselectable in code.
  // The sibling backend carries the same rule with the count that forced it.
  let inside = 0;
  let outside = 0;
  return (streams || [])
    .filter((s) => s.Type === type)
    .map((s) => ({
      ordinal: s.IsExternal ? -++outside : inside++,
      id: String(s.Index),
      kind,
      language: s.Language,
      label: s.DisplayTitle || s.Title || s.Language || (type === "Audio" ? "Audio" : "Subtitle"),
      forced: !!s.IsForced,
      external: !!s.IsExternal,
      key: s.DeliveryUrl,
    }));
}

export interface JellyfinPerson {
  Id?: string;
  Name?: string;
  Role?: string;
  Type?: string;
  PrimaryImageTag?: string;
}

export interface JellyfinChapter {
  StartPositionTicks?: number;
  Name?: string;
  ImageTag?: string;
}

/**
 * One file the library holds for this title.
 *
 * Jellyfin has no notion of a media entry split across parts - a two-disc film
 * is two sources, not one source with two parts - so `partIndex` is always 0 and
 * `parts` always 1. The fields stay because the interface is shared with Plex,
 * where a split title is real and the two numbers differ.
 */
/** Flag the track the server says is current. */
function mark(tracks: Track[], index: number | undefined | null): Track[] {
  if (typeof index !== "number") return tracks;
  return tracks.map((t) => (t.id === String(index) ? { ...t, selected: true } : t));
}

export function toVersion(src: JellyfinMediaSource, index: number): MediaVersion {
  const video = (src.MediaStreams || []).find((s) => s.Type === "Video");
  const audio = (src.MediaStreams || []).find((s) => s.Type === "Audio");
  const height = video?.Height;
  const resolution = height ? (height >= 2000 ? "4K" : `${height}p`) : undefined;
  const parts = [resolution, video?.Codec?.toUpperCase(), audio?.Language].filter(Boolean);
  return {
    mediaIndex: index,
    partIndex: 0,
    parts: 1,
    partId: src.Id,
    // The server's own name is the file name here, which on this library is
    // the release string - unreadable across a room. Composed instead, and the
    // file name only when there is nothing else to say.
    label: parts.length ? parts.join(" · ") : src.Name || `#${index + 1}`,
    resolution,
    videoCodec: video?.Codec,
    audioCodec: audio?.Codec,
    audioChannels: audio?.Channels,
    bitrateKbps: src.Bitrate ? Math.round(src.Bitrate / 1000) : undefined,
    sizeBytes: src.Size,
    durationMs: ticksToMs(src.RunTimeTicks),
    // Marked with the server's own choice, which is what the track menu draws
    // its tick from: without it no row is ticked mid-film and "Off" is unticked
    // even when the subtitles are off - the one thing that panel exists to say.
    audio: mark(toTracks(src.MediaStreams, "Audio"), src.DefaultAudioStreamIndex),
    subtitles: mark(toTracks(src.MediaStreams, "Subtitle"), src.DefaultSubtitleStreamIndex),
  };
}

/**
 * Chapters, with the end of each one filled in.
 *
 * Jellyfin gives a start and nothing else, so the end is the next start - and
 * the last one runs to the end of the film. The screen draws a band per chapter,
 * which cannot be done from starts alone.
 */
export function toChapters(list: JellyfinChapter[] | undefined, itemId: string, durationMs?: number): Chapter[] {
  const src = list || [];
  return src.map((c, i) => {
    const startMs = ticksToMs(c.StartPositionTicks) ?? 0;
    const next = ticksToMs(src[i + 1]?.StartPositionTicks);
    return {
      index: i,
      title: c.Name,
      startMs,
      endMs: next ?? durationMs ?? startMs,
      thumb: c.ImageTag
        ? `Items/${encodeURIComponent(itemId)}/Images/Chapter/${i}?tag=${encodeURIComponent(c.ImageTag)}`
        : undefined,
    };
  });
}

function people(list: JellyfinPerson[] | undefined, type: string): JellyfinPerson[] {
  return (list || []).filter((p) => p.Type === type);
}

export function toRole(p: JellyfinPerson): Role {
  return {
    id: p.Id || "",
    name: p.Name || "",
    character: p.Role || undefined,
    thumb: imagePath(p.Id || "", p.PrimaryImageTag),
  };
}

export function toDetail(
  it: JellyfinItem & {
    People?: JellyfinPerson[];
    Genres?: string[];
    Studios?: { Name?: string }[];
    Taglines?: string[];
    CommunityRating?: number;
    CriticRating?: number;
    OfficialRating?: string;
    ProviderIds?: Record<string, string>;
    Chapters?: JellyfinChapter[];
  },
): ItemDetail {
  const base = toItem(it);
  const durationMs = base.durationMs;
  return {
    ...base,
    roles: people(it.People, "Actor").map(toRole),
    directors: people(it.People, "Director").map((p) => p.Name || ""),
    writers: people(it.People, "Writer").map((p) => p.Name || ""),
    genres: it.Genres,
    studio: it.Studios?.[0]?.Name,
    tagline: it.Taglines?.[0],
    rating: it.CommunityRating,
    contentRating: it.OfficialRating,
    // Both on the 0-10 scale this interface uses. Jellyfin reports the community
    // score that way already and the critic score out of a hundred, so one of
    // the two has to be divided - and it is the critic one, which is Rotten
    // Tomatoes' percentage under another name.
    scores: [
      ...(typeof it.CommunityRating === "number"
        ? [{ source: "jellyfin", kind: "audience" as const, value: it.CommunityRating }]
        : []),
      ...(typeof it.CriticRating === "number"
        ? [{ source: "rottentomatoes", kind: "critic" as const, value: it.CriticRating / 10 }]
        : []),
    ],
    // Jellyfin holds no written reviews at all; the screen already draws nothing
    // for an empty list.
    reviews: [],
    extras: [],
    chapters: toChapters(it.Chapters, it.Id, durationMs),
    logo: imagePath(it.Id, it.ImageTags?.Logo, "Logo"),
    guids: it.ProviderIds,
    versions: (it.MediaSources || []).map(toVersion),
  };
}

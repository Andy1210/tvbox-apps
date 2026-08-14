// Plex's wire shapes, and the mapping into this app's own model.
//
// Kept apart from the request code so it can be tested against recorded
// responses with no network: the watch-state fields in here feed the household's
// on-deck list and the assistant's recommendations, so getting one wrong is a
// data bug rather than a display bug.

import type {
  Chapter,
  Extra,
  ItemDetail,
  ItemKind,
  Library,
  MediaItem,
  MediaVersion,
  Marker,
  Review,
  Role,
  Score,
  Track,
} from "../types";

export interface PlexMetadata {
  ratingKey?: string | number;
  key?: string;
  type?: string;
  title?: string;
  parentTitle?: string;
  grandparentTitle?: string;
  parentRatingKey?: string | number;
  grandparentRatingKey?: string | number;
  studio?: string;
  tagline?: string;
  Image?: PlexImage[];
  Rating?: PlexRating[];
  Review?: PlexReview[];
  Chapter?: PlexChapter[];
  Guid?: { id?: string }[];
  Extras?: { Metadata?: PlexMetadata[]; size?: number };
  subtype?: string;
  year?: number;
  thumb?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  art?: string;
  duration?: number;
  viewOffset?: number;
  viewCount?: number;
  lastViewedAt?: number;
  addedAt?: number;
  index?: number;
  parentIndex?: number;
  summary?: string;
  leafCount?: number;
  viewedLeafCount?: number;
  contentRating?: string;
  rating?: number;
  Role?: PlexTag[];
  Director?: PlexTag[];
  Writer?: PlexTag[];
  Genre?: PlexTag[];
  Marker?: PlexMarker[];
}

export interface PlexTag {
  id?: number | string;
  tag?: string;
  tagKey?: string;
  role?: string;
  thumb?: string;
  filter?: string;
}

export interface PlexMarker {
  type?: string;
  startTimeOffset?: number;
  endTimeOffset?: number;
  final?: boolean;
}

export interface PlexImage {
  type?: string;
  url?: string;
  alt?: string;
}

/** The scale a score runs on is carried in the icon name, not in a field. */
export interface PlexRating {
  image?: string;
  value?: number;
  type?: string;
}

export interface PlexReview {
  id?: number | string;
  tag?: string;
  text?: string;
  image?: string;
  link?: string;
  source?: string;
}

export interface PlexChapter {
  index?: number;
  tag?: string;
  startTimeOffset?: number;
  endTimeOffset?: number;
  thumb?: string;
}

export interface PlexDirectory {
  key?: string;
  type?: string;
  title?: string;
  size?: number;
}

const KINDS: Record<string, ItemKind> = { movie: "movie", show: "show", season: "season", episode: "episode" };

export function toKind(t: string | undefined): ItemKind {
  return KINDS[t || ""] ?? "movie";
}

export function toLibrary(d: PlexDirectory): Library {
  const kind = d.type === "movie" || d.type === "show" || d.type === "artist" || d.type === "photo";
  return {
    id: String(d.key ?? ""),
    title: d.title ?? "",
    kind: !kind ? "other" : d.type === "artist" ? "music" : (d.type as Library["kind"]),
  };
}

export function toItem(m: PlexMetadata): MediaItem {
  // An episode's own thumb is a still from the episode; a season's is the show's
  // art. Falling back up the chain keeps a poster grid from showing holes.
  const thumb = m.thumb || m.parentThumb || m.grandparentThumb;
  const leaf = m.leafCount;
  const viewedLeaf = m.viewedLeafCount;
  return {
    id: String(m.ratingKey ?? ""),
    kind: toKind(m.type),
    title: m.title ?? "",
    parentTitle: m.parentTitle,
    seriesTitle: m.grandparentTitle,
    parentId: m.parentRatingKey !== undefined ? String(m.parentRatingKey) : undefined,
    seriesId: m.grandparentRatingKey !== undefined ? String(m.grandparentRatingKey) : undefined,
    seriesThumb: m.grandparentThumb,
    year: m.year,
    thumb,
    art: m.art,
    durationMs: m.duration,
    viewOffsetMs: m.viewOffset,
    viewCount: m.viewCount,
    lastViewedAt: m.lastViewedAt,
    addedAt: m.addedAt,
    index: m.index,
    parentIndex: m.parentIndex,
    summary: m.summary,
    unwatchedCount: typeof leaf === "number" ? leaf - (viewedLeaf ?? 0) : undefined,
  };
}

export function toRole(t: PlexTag): Role {
  return {
    // The per-item `filter` attribute already spells the query for this person
    // ("actor=88488"); its number is what other libraries use for the same
    // person, so it is the id worth keeping.
    id: String(t.id ?? ""),
    guid: t.tagKey,
    name: t.tag ?? "",
    character: t.role,
    thumb: t.thumb,
  };
}

/**
 * Which service a score came from, and which way its scale runs.
 *
 * Neither is a field: both are encoded in the icon reference, e.g.
 * "rottentomatoes://image.rating.ripe". Reading the icon is the only way to tell
 * an IMDb score from a Rotten Tomatoes one, or a fresh verdict from a rotten
 * one - and showing a critic score under an audience label is worse than showing
 * no score.
 */
export function toScore(r: PlexRating): Score | null {
  if (typeof r.value !== "number") return null;
  const image = r.image ?? "";
  const source = image.split("://")[0] || "unknown";
  const leaf = image.split(".").pop() ?? "";
  const sentiment =
    leaf === "ripe" || leaf === "fresh"
      ? ("fresh" as const)
      : leaf === "rotten"
        ? ("rotten" as const)
        : leaf === "upright"
          ? ("upright" as const)
          : leaf === "spilled"
            ? ("spilled" as const)
            : undefined;
  return { source, kind: r.type === "critic" ? "critic" : "audience", value: r.value, sentiment };
}

export function toReview(r: PlexReview): Review | null {
  if (!r.text || !r.tag) return null;
  const leaf = (r.image ?? "").split(".").pop() ?? "";
  return {
    id: String(r.id ?? r.tag),
    author: r.tag,
    text: r.text,
    source: r.source,
    link: r.link,
    sentiment: leaf === "fresh" ? "fresh" : leaf === "rotten" ? "rotten" : undefined,
  };
}

export function toChapter(c: PlexChapter): Chapter {
  return {
    index: c.index ?? 0,
    title: c.tag,
    startMs: c.startTimeOffset ?? 0,
    endMs: c.endTimeOffset ?? 0,
    thumb: c.thumb,
  };
}

export function toExtra(m: PlexMetadata): Extra {
  return {
    id: String(m.ratingKey ?? ""),
    title: m.title ?? "",
    // The server labels a trailer with `subtype`; `type` is always "clip".
    subtype: m.subtype ?? m.type ?? "clip",
    durationMs: m.duration,
    thumb: m.thumb,
  };
}

export function toDetail(m: PlexMetadata): ItemDetail {
  const images = m.Image ?? [];
  const logo = images.find((i) => i.type === "clearLogo")?.url;
  const guids: Record<string, string> = {};
  for (const g of m.Guid ?? []) {
    const [scheme, value] = (g.id ?? "").split("://");
    if (scheme && value) guids[scheme] = value;
  }

  return {
    ...toItem(m),
    roles: (m.Role ?? []).map(toRole).filter((r) => r.id && r.name),
    directors: (m.Director ?? []).map((d) => d.tag ?? "").filter(Boolean),
    writers: (m.Writer ?? []).map((d) => d.tag ?? "").filter(Boolean),
    genres: (m.Genre ?? []).map((d) => d.tag ?? "").filter(Boolean),
    studio: m.studio,
    tagline: m.tagline,
    rating: m.rating,
    contentRating: m.contentRating,
    scores: (m.Rating ?? []).map(toScore).filter((s): s is Score => s !== null),
    reviews: (m.Review ?? []).map(toReview).filter((r): r is Review => r !== null),
    extras: (m.Extras?.Metadata ?? []).map(toExtra).filter((e) => e.id),
    chapters: (m.Chapter ?? []).map(toChapter).filter((c) => c.endMs > c.startMs),
    logo,
    guids: Object.keys(guids).length ? guids : undefined,
    versions: toVersions(m),
  };
}

const MARKER_TYPES = new Set(["intro", "credits", "commercial"]);

export function toMarkers(m: PlexMetadata): Marker[] {
  return (m.Marker ?? [])
    .filter((k) => MARKER_TYPES.has(k.type ?? ""))
    .map((k) => ({
      type: k.type as Marker["type"],
      startMs: k.startTimeOffset ?? 0,
      endMs: k.endTimeOffset ?? 0,
      // The attribute is only ever present-and-true; a credits run that does not
      // reach the end simply omits it. Comparing against false would match
      // nothing and let auto-advance fire on a mid-credits scene.
      final: k.final === true,
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * On-deck order.
 *
 * Sorting on last-viewed alone looks right and is wrong: the next unwatched
 * episode of a series has never been viewed, so it carries no such timestamp and
 * sinks below films abandoned years ago. Falling back to when it was added is
 * what puts last night's episode at the front.
 */
export function onDeckOrder(items: MediaItem[]): MediaItem[] {
  return [...items].sort((a, b) => (b.lastViewedAt ?? b.addedAt ?? 0) - (a.lastViewedAt ?? a.addedAt ?? 0));
}

/**
 * Roll an actor's credits up for display: every episode of one series collapses
 * into that series, so a guest star shows "this series" rather than nine
 * episodes of it. Films and series pass through untouched.
 */
export function rollUpEpisodes(items: MediaItem[]): MediaItem[] {
  const out: MediaItem[] = [];
  const seenSeries = new Set<string>();

  // Two passes so input order does not matter: every series listed in its own
  // right is recorded before any episode is considered for promotion.
  for (const it of items) {
    if (it.kind !== "episode") {
      if (it.kind === "show") seenSeries.add(it.id);
      out.push(it);
    }
  }
  for (const it of items) {
    if (it.kind !== "episode") continue;
    // The SERIES id, not the episode's. An episode id opens an episode page
    // under a series title, and asking a server for an episode's children is an
    // error rather than an empty list. Dedupe on it too - two distinct series
    // can share a name, and titles would collapse them into one.
    const seriesId = it.seriesId;
    if (!seriesId || !it.seriesTitle || seenSeries.has(seriesId)) continue;
    seenSeries.add(seriesId);
    out.push({
      id: seriesId,
      kind: "show",
      title: it.seriesTitle,
      // The series' own poster; an episode's thumb is a still from that episode.
      thumb: it.seriesThumb,
      // The episode's dates are not the series', and carrying them would sort a
      // series by whichever episode happened to come back first.
    });
  }
  return out;
}

// ---- versions and tracks ----------------------------------------------

export interface PlexStream {
  id?: number | string;
  streamType?: number;
  index?: number;
  language?: string;
  languageTag?: string;
  languageCode?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
  title?: string;
  codec?: string;
  channels?: number;
  forced?: boolean;
  selected?: boolean;
  key?: string;
}

export interface PlexPart {
  id?: number | string;
  key?: string;
  file?: string;
  size?: number;
  duration?: number;
  Stream?: PlexStream[];
}

export interface PlexMediaEntry {
  id?: number | string;
  title?: string;
  videoResolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  bitrate?: number;
  duration?: number;
  Part?: PlexPart[];
}

const AUDIO = 2;
const SUBTITLE = 3;

/** "2.0", "5.1", … from a channel count, which is how people read audio. */
function channelLabel(n: number | undefined): string {
  if (!n) return "";
  if (n === 1) return "mono";
  if (n === 2) return "2.0";
  if (n === 6) return "5.1";
  if (n === 8) return "7.1";
  return `${n}ch`;
}

export function toTrack(s: PlexStream, ordinal: number, kind: "audio" | "subtitle"): Track {
  const language = s.language || s.languageTag || undefined;
  // The server's own label first: it already reads well ("Magyar (AC3 5.1)"),
  // and composing one from the codec is the fallback, not the preference.
  const composed = [language, kind === "audio" ? channelLabel(s.channels) : "", s.codec?.toUpperCase()]
    .filter(Boolean)
    .join(" · ");
  return {
    ordinal,
    id: String(s.id ?? ordinal),
    kind,
    language,
    label: s.extendedDisplayTitle || s.displayTitle || s.title || composed || `#${ordinal + 1}`,
    forced: s.forced === true,
    selected: s.selected === true,
    // An external subtitle has its own key; an embedded one is inside the file.
    external: kind === "subtitle" && Boolean(s.key),
  };
}

/**
 * Compose a version's label.
 *
 * Servers leave `Media.title` empty in practice, so there is nothing to show
 * unless one is built. What distinguishes two copies of the same film in a real
 * library is, in order: the LANGUAGE (a household keeps the same film dubbed and
 * original as two whole files, not two tracks), then the resolution, then how
 * big it is. Codec is last because it is the least useful thing to choose on.
 */
export function versionLabel(m: PlexMediaEntry, audio: Track[], distinguishBy: Set<string>): string {
  const bits: string[] = [];

  if (distinguishBy.has("language")) {
    const langs = [...new Set(audio.map((a) => a.language).filter(Boolean))];
    bits.push(langs.length ? langs.join("/") : "?");
  }
  if (distinguishBy.has("resolution")) {
    const r = m.videoResolution;
    // "sdp" and "sd" are the server's way of saying it does not know; a number
    // is a resolution and reads better with a p after it.
    bits.push(!r || r === "sd" || r === "sdp" ? "SD" : /^\d+$/.test(r) ? `${r}p` : r.toUpperCase());
  }
  if (distinguishBy.has("size")) {
    const size = (m.Part ?? [])[0]?.size;
    if (size) bits.push(`${(size / 1e9).toFixed(1)} GB`);
  }
  if (distinguishBy.has("codec") && m.videoCodec) bits.push(m.videoCodec.toUpperCase());

  return m.title || bits.join(" · ") || "?";
}

/**
 * Every file the library holds for a title.
 *
 * The labels only mention what actually differs between them: naming the
 * resolution on two versions that share one is noise, and the thing a person is
 * choosing between should be the thing the label says.
 */
export function toVersions(m: PlexMetadata & { Media?: PlexMediaEntry[] }): MediaVersion[] {
  const media = m.Media ?? [];
  if (media.length === 0) return [];

  const tracksFor = (entry: PlexMediaEntry): { audio: Track[]; subtitles: Track[] } => {
    const streams = (entry.Part ?? [])[0]?.Stream ?? [];
    const audio: Track[] = [];
    const subtitles: Track[] = [];
    for (const s of streams) {
      if (s.streamType === AUDIO) audio.push(toTrack(s, audio.length, "audio"));
      else if (s.streamType === SUBTITLE) subtitles.push(toTrack(s, subtitles.length, "subtitle"));
    }
    return { audio, subtitles };
  };

  const parsed = media.map(tracksFor);

  // Which fields actually differ. With one version nothing does, so its label
  // stays short.
  const distinguishBy = new Set<string>();
  if (media.length > 1) {
    const key = (fn: (i: number) => string): boolean => new Set(media.map((_, i) => fn(i))).size > 1;
    if (key((i) => parsed[i].audio.map((a) => a.language ?? "?").join(","))) distinguishBy.add("language");
    if (key((i) => media[i].videoResolution ?? "")) distinguishBy.add("resolution");
    if (key((i) => String(media[i].videoCodec ?? ""))) distinguishBy.add("codec");
    // Size is the tiebreaker when nothing else separates them, so two copies are
    // never both labelled the same thing.
    if (distinguishBy.size === 0) distinguishBy.add("size");
  }

  return media.map((entry, index) => ({
    index,
    partId: (entry.Part ?? [])[0]?.id !== undefined ? String((entry.Part ?? [])[0]?.id) : undefined,
    label: versionLabel(entry, parsed[index].audio, distinguishBy),
    resolution: entry.videoResolution,
    videoCodec: entry.videoCodec,
    audioCodec: entry.audioCodec,
    audioChannels: entry.audioChannels,
    bitrateKbps: entry.bitrate,
    sizeBytes: (entry.Part ?? [])[0]?.size,
    durationMs: entry.duration,
    audio: parsed[index].audio,
    subtitles: parsed[index].subtitles,
  }));
}

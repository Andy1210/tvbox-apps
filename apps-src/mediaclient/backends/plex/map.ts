// Plex's wire shapes, and the mapping into this app's own model.
//
// Kept apart from the request code so it can be tested against recorded
// responses with no network: the watch-state fields in here feed the household's
// on-deck list and the assistant's recommendations, so getting one wrong is a
// data bug rather than a display bug.

import type { ItemDetail, ItemKind, Library, MediaItem, Marker, Role } from "../types";

export interface PlexMetadata {
  ratingKey?: string | number;
  key?: string;
  type?: string;
  title?: string;
  parentTitle?: string;
  grandparentTitle?: string;
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

export function toDetail(m: PlexMetadata): ItemDetail {
  return {
    ...toItem(m),
    roles: (m.Role ?? []).map(toRole).filter((r) => r.id && r.name),
    directors: (m.Director ?? []).map((d) => d.tag ?? "").filter(Boolean),
    writers: (m.Writer ?? []).map((d) => d.tag ?? "").filter(Boolean),
    genres: (m.Genre ?? []).map((d) => d.tag ?? "").filter(Boolean),
    rating: m.rating,
    contentRating: m.contentRating,
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

  for (const it of items) {
    if (it.kind !== "episode") {
      if (it.kind === "show") seenSeries.add(it.title);
      out.push(it);
    }
  }
  for (const it of items) {
    if (it.kind !== "episode") continue;
    const series = it.seriesTitle;
    if (!series || seenSeries.has(series)) continue;
    seenSeries.add(series);
    out.push({
      id: it.id,
      kind: "show",
      title: series,
      thumb: it.thumb,
      year: it.year,
      // The episode's own dates are not the series', and showing them would sort
      // a series by one arbitrary episode of it.
    });
  }
  return out;
}

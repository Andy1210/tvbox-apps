import type {
  CreditSet,
  HistoryRow,
  ItemDetail,
  Library,
  MediaBackend,
  MediaItem,
  Marker,
  Page,
  PageQuery,
  PersonRef,
  PlaybackState,
  Profile,
  Session,
  StreamDecision,
  TrickplayIndex,
  DeviceLogin,
} from "../types";
import { buildUrl, container, request, type PlexIdentityHeaders } from "./http";
import { beginDeviceLogin, listHomeUsers, switchHomeUser } from "./auth";
import { onDeckOrder, rollUpEpisodes, toDetail, toItem, toLibrary, toMarkers, type PlexDirectory, type PlexMetadata } from "./map";
import { log } from "../../redact";

interface MetadataContainer {
  Metadata?: PlexMetadata[];
  Directory?: PlexDirectory[];
  totalSize?: number;
  size?: number;
}

/** Plex's numeric library types, used by the server-wide filter. */
const TYPE_MOVIE = 1;
const TYPE_SHOW = 2;
const TYPE_EPISODE = 4;

/**
 * Percent-encode a letter bucket key exactly once.
 *
 * The bucket list hands back keys that are ALREADY encoded - the
 * non-alphabetic bucket arrives as "%23", not "#". Encoding that again asks the
 * server for a bucket named "%23", which it answers with an empty list rather
 * than an error, so the strip silently shows nothing under that letter.
 * Decoding first makes the step idempotent, and a key that was never encoded
 * still comes out right.
 */
function encodeLetterKey(key: string): string {
  let decoded = key;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    // Malformed escapes are not ours to repair; use the key as it arrived.
  }
  return encodeURIComponent(decoded);
}

export class PlexBackend implements MediaBackend {
  readonly kind = "plex" as const;

  constructor(
    private session: Session,
    private id: PlexIdentityHeaders,
    /** The account token, when it differs from the server token (home switching). */
    private accountToken: string = session.token,
  ) {}

  private get base(): string {
    return this.session.baseUrl;
  }

  private req<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return request<T>(this.base, path, this.id, { token: this.session.token, query });
  }

  // ---- auth -------------------------------------------------------------

  beginDeviceLogin(): Promise<DeviceLogin> {
    return beginDeviceLogin({ id: this.id });
  }

  async listProfiles(): Promise<Profile[]> {
    const users = await listHomeUsers(this.id, this.accountToken);
    return users.map((u) => ({ id: u.id, name: u.name, thumb: u.thumb, pinRequired: u.pinRequired }));
  }

  async switchProfile(id: string, pin?: string): Promise<Session> {
    const token = await switchHomeUser(this.id, this.accountToken, id, pin);
    this.session = { ...this.session, token, profileId: id };
    return this.session;
  }

  // ---- browse -----------------------------------------------------------

  async libraries(): Promise<Library[]> {
    const c = container<MetadataContainer>(await this.req("library/sections"));
    return (c.Directory ?? []).map(toLibrary).filter((l) => l.kind === "movie" || l.kind === "show");
  }

  async onDeck(): Promise<MediaItem[]> {
    const c = container<MetadataContainer>(await this.req("library/onDeck"));
    return onDeckOrder((c.Metadata ?? []).map(toItem));
  }

  async recentlyAdded(libraryId?: string): Promise<MediaItem[]> {
    const path = libraryId ? `library/sections/${libraryId}/recentlyAdded` : "library/recentlyAdded";
    const c = container<MetadataContainer>(await this.req(path, { "X-Plex-Container-Size": 24 }));
    return (c.Metadata ?? []).map(toItem);
  }

  async libraryPage(libraryId: string, q: PageQuery): Promise<Page<MediaItem>> {
    const c = container<MetadataContainer>(
      await this.req(`library/sections/${libraryId}/all`, {
        sort: q.sort ?? "titleSort",
        "X-Plex-Container-Start": q.offset,
        "X-Plex-Container-Size": q.limit,
      }),
    );
    return { items: (c.Metadata ?? []).map(toItem), total: c.totalSize };
  }

  async letters(libraryId: string): Promise<{ key: string; title: string; size: number }[]> {
    const c = container<MetadataContainer>(await this.req(`library/sections/${libraryId}/firstCharacter`));
    return (c.Directory ?? []).map((d) => ({ key: String(d.key ?? ""), title: d.title ?? "", size: d.size ?? 0 }));
  }

  /**
   * The items under one letter.
   *
   * This exists instead of computing an offset from the letter counts, which
   * would be the obvious optimisation and is wrong here: the bucket list and the
   * sorted grid do not agree on where accented initials belong, so a running sum
   * drifts by several items partway through the alphabet and lands the viewer on
   * the wrong title. Asking the server for the letter cannot drift.
   */
  async letterPage(libraryId: string, letterKey: string, q: PageQuery): Promise<Page<MediaItem>> {
    const c = container<MetadataContainer>(
      await this.req(`library/sections/${libraryId}/firstCharacter/${encodeLetterKey(letterKey)}`, {
        "X-Plex-Container-Start": q.offset,
        "X-Plex-Container-Size": q.limit,
      }),
    );
    return { items: (c.Metadata ?? []).map(toItem), total: c.totalSize };
  }

  async item(id: string): Promise<ItemDetail> {
    const c = container<MetadataContainer>(await this.req(`library/metadata/${id}`, { includeMarkers: 1 }));
    const m = (c.Metadata ?? [])[0];
    if (!m) throw new Error(`no such item: ${id}`);
    return toDetail(m);
  }

  async children(id: string): Promise<MediaItem[]> {
    const c = container<MetadataContainer>(await this.req(`library/metadata/${id}/children`));
    return (c.Metadata ?? []).map(toItem);
  }

  async search(query: string): Promise<MediaItem[]> {
    const c = container<MetadataContainer>(await this.req("search", { query, limit: 40 }));
    return (c.Metadata ?? []).map(toItem);
  }

  /**
   * Everything one person appears in, across every library.
   *
   * The library filter a server's own client uses is per-section, which is why
   * opening an actor from a film there never shows their series. The same filter
   * applied server-wide does, because the person's id is the same number in
   * every section.
   *
   * Two calls rather than one: films and series come back directly, while a
   * guest star is tagged on the episode instead of the series, so episodes are
   * fetched separately and rolled up. Both are paged explicitly - the
   * unpaginated form reports no total, so a caller cannot tell a short answer
   * from a complete one.
   */
  async personCredits(person: PersonRef): Promise<CreditSet> {
    const PAGE = 200;

    const fetchAll = async (types: string): Promise<{ items: MediaItem[]; truncated: boolean }> => {
      const items: MediaItem[] = [];
      let offset = 0;
      let total: number | undefined;
      for (;;) {
        const c = container<MetadataContainer>(
          await this.req("library/all", {
            actor: person.id,
            type: types,
            "X-Plex-Container-Start": offset,
            "X-Plex-Container-Size": PAGE,
          }),
        );
        const batch = (c.Metadata ?? []).map(toItem);
        items.push(...batch);
        total = c.totalSize ?? total;
        offset += batch.length;
        if (batch.length < PAGE) break;
        if (total !== undefined && offset >= total) break;
        // Guard against a server that keeps answering: an actor with more than
        // this many credits is not a case worth paging forever for.
        if (offset >= 2000) return { items, truncated: true };
      }
      return { items, truncated: total === undefined };
    };

    const [top, episodes] = await Promise.all([
      fetchAll(`${TYPE_MOVIE},${TYPE_SHOW}`),
      fetchAll(String(TYPE_EPISODE)),
    ]);

    return {
      person,
      items: rollUpEpisodes([...top.items, ...episodes.items]),
      truncated: top.truncated || episodes.truncated,
    };
  }

  // ---- art --------------------------------------------------------------

  /**
   * A poster scaled by the server.
   *
   * The `url` parameter is not optional - without it the transcoder answers 400
   * - and the saving is the point: a full-size poster is an order of magnitude
   * more bytes and costs a large decode each, which a grid of them turns into
   * visible stutter on this hardware.
   *
   * No token here. It goes in a header at fetch time instead, so this string can
   * safely appear in the DOM, a log line, or a now-playing report.
   */
  posterUrl(item: MediaItem, w: number, h: number): string | undefined {
    if (!item.thumb) return undefined;
    return buildUrl(this.base, "photo/:/transcode", {
      width: Math.round(w),
      height: Math.round(h),
      minSize: 1,
      upscale: 0,
      url: item.thumb,
    });
  }

  imageHeaders(): Record<string, string> {
    return { "X-Plex-Token": this.session.token };
  }

  // ---- playback ---------------------------------------------------------

  async markers(id: string): Promise<Marker[]> {
    const c = container<MetadataContainer>(await this.req(`library/metadata/${id}`, { includeMarkers: 1 }));
    const m = (c.Metadata ?? [])[0];
    return m ? toMarkers(m) : [];
  }

  async resolveStream(): Promise<StreamDecision> {
    throw new Error("not implemented yet");
  }

  async trickplay(): Promise<TrickplayIndex | null> {
    return null;
  }

  async keepAlive(session: string): Promise<void> {
    await this.req("video/:/transcode/universal/ping", { session }).catch((e) => log.warn("keepalive failed", e));
  }

  async endSession(session: string): Promise<void> {
    await this.req("video/:/transcode/universal/stop", { session }).catch((e) => log.warn("stop failed", e));
  }

  /**
   * Stop transcode sessions this client left behind.
   *
   * Needed because leaving the app produces no event the page can act on, and a
   * hidden window can be killed outright - measured, an abandoned session does
   * not expire on its own. So the release path is best-effort and this is the
   * backstop, run at startup.
   */
  async reapOwnSessions(): Promise<number> {
    try {
      const c = container<{ Metadata?: { Session?: { id?: string }; Player?: { machineIdentifier?: string } }[] }>(
        await this.req("transcode/sessions"),
      );
      const mine = (c.Metadata ?? []).filter((s) => s.Player?.machineIdentifier === this.id.clientId);
      for (const s of mine) {
        const sid = s.Session?.id;
        if (sid) await this.endSession(sid);
      }
      if (mine.length) log.info(`reaped ${mine.length} orphaned session(s)`);
      return mine.length;
    } catch (e) {
      log.warn("could not reap sessions", e);
      return 0;
    }
  }

  // ---- state ------------------------------------------------------------

  /**
   * Report where playback is.
   *
   * Note the two key parameters disagree on purpose: `ratingKey` is the number
   * and `key` is the metadata path. Sending the same value for both is accepted
   * and silently records nothing.
   */
  async reportProgress(id: string, positionMs: number, durationMs: number, state: PlaybackState): Promise<void> {
    await this.req(":/timeline", {
      ratingKey: id,
      key: `/library/metadata/${id}`,
      identifier: "com.plexapp.plugins.library",
      state,
      time: Math.max(0, Math.round(positionMs)),
      duration: Math.max(0, Math.round(durationMs)),
    });
  }

  /** Here `key` is the number, the opposite convention from the timeline above. */
  async setWatched(id: string, watched: boolean): Promise<void> {
    await this.req(watched ? ":/scrobble" : ":/unscrobble", {
      key: id,
      identifier: "com.plexapp.plugins.library",
    });
  }

  async history(limit: number): Promise<HistoryRow[]> {
    const c = container<{ Metadata?: (PlexMetadata & { viewedAt?: number; accountID?: number })[] }>(
      await this.req("status/sessions/history/all", {
        sort: "viewedAt:desc",
        "X-Plex-Container-Size": limit,
      }),
    );
    return (c.Metadata ?? []).map((m) => ({
      itemId: String(m.ratingKey ?? ""),
      title: m.title ?? "",
      viewedAt: m.viewedAt ?? 0,
      accountId: m.accountID !== undefined ? String(m.accountID) : undefined,
    }));
  }
}

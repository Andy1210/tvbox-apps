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
import { readJson, writeJson } from "../../storage";
import { log } from "../../redact";

/** Session ids this client minted, so an abandoned one can be stopped later. */
const SESSIONS_KEY = "plex-sessions";

/**
 * The profile the server should decide against.
 *
 * Naming one is not optional: without it the transcode endpoints answer 400
 * outright, because the server looks for a profile matching the client's
 * platform and has none for ours. Naming a profile it does know sidesteps that
 * without pretending to be another client - the product and device name we
 * report stay our own, which is what the account's device list shows.
 */
const CLIENT_PROFILE = "Chrome";

/**
 * What this player can take. mpv on this hardware plays essentially anything, so
 * the profile is wide on purpose: every codec the server would otherwise
 * transcode is one it does not need to.
 */
const PROFILE_EXTRA = [
  "add-direct-play-profile(type=videoProfile&container=*&videoCodec=*&audioCodec=*)",
  "add-direct-play-profile(type=musicProfile&container=*&audioCodec=*)",
].join("+");

interface MetadataContainer {
  Metadata?: PlexMetadata[];
  Directory?: PlexDirectory[];
  totalSize?: number;
  size?: number;
}

/** The playable versions of an item, as the decision endpoint returns them. */
interface PlexMedia {
  Part?: {
    key?: string;
    /** What the server decided for this part: directplay | copy | transcode. */
    decision?: string;
    Stream?: { streamType?: number; decision?: string }[];
  }[];
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

/**
 * Paging parameters.
 *
 * BOTH are required. A size on its own is silently ignored, and the server sends
 * the whole collection instead - measured, asking for five history rows that way
 * returns eighteen thousand of them and nine megabytes. There is no error to
 * notice; it just arrives.
 */
function page(offset: number, limit: number): Record<string, number> {
  return { "X-Plex-Container-Start": offset, "X-Plex-Container-Size": limit };
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
    const c = container<MetadataContainer>(await this.req(path, page(0, 24)));
    return (c.Metadata ?? []).map(toItem);
  }

  async libraryPage(libraryId: string, q: PageQuery): Promise<Page<MediaItem>> {
    const c = container<MetadataContainer>(
      await this.req(`library/sections/${libraryId}/all`, { sort: q.sort ?? "titleSort", ...page(q.offset, q.limit) }),
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
      await this.req(`library/sections/${libraryId}/firstCharacter/${encodeLetterKey(letterKey)}`, page(q.offset, q.limit)),
    );
    return { items: (c.Metadata ?? []).map(toItem), total: c.totalSize };
  }

  /**
   * One item, with everything the detail screen shows.
   *
   * All of it in a single request: scores, reviews, trailers, chapters and
   * markers each have their own include flag, and asking separately turns
   * opening a film into five round trips on a screen that is already waiting.
   * The response is cached briefly so the player can read markers without
   * fetching the same document again.
   */
  async item(id: string): Promise<ItemDetail> {
    const m = await this.metadata(id);
    return toDetail(m);
  }

  private metaCache = new Map<string, { at: number; value: PlexMetadata }>();

  private async metadata(id: string): Promise<PlexMetadata> {
    const hit = this.metaCache.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;

    const c = container<MetadataContainer>(
      await this.req(`library/metadata/${id}`, {
        includeMarkers: 1,
        includeChapters: 1,
        includeReviews: 1,
        includeExtras: 1,
      }),
    );
    const m = (c.Metadata ?? [])[0];
    if (!m) throw new Error(`no such item: ${id}`);

    // Bounded: this holds whole metadata documents, and a long browse would
    // otherwise accumulate every item visited.
    if (this.metaCache.size > 40) this.metaCache.clear();
    this.metaCache.set(id, { at: Date.now(), value: m });
    return m;
  }

  async children(id: string): Promise<MediaItem[]> {
    const c = container<MetadataContainer>(await this.req(`library/metadata/${id}/children`));
    return (c.Metadata ?? []).map(toItem);
  }

  /**
   * Music heard in a film.
   *
   * Not something this server holds: it carries no track list for a film, and
   * the related hubs it does return are similar films and other work by the
   * cast. Answering with nothing is the honest result, and the screen simply
   * shows no such section - which is also what happens on a server that gains
   * the data later, without a code change here.
   */
  async soundtrack(): Promise<MediaItem[]> {
    return [];
  }

  /**
   * Search.
   *
   * No limit parameter: this endpoint ignores `limit` and the container size
   * alike - measured, asking for one result and for a hundred both return the
   * same forty-odd. Passing one would only document a cap that does not exist.
   */
  async search(query: string): Promise<MediaItem[]> {
    const q = query.trim();
    // An empty query is a 400 rather than an empty list, and an empty search box
    // is an ordinary state.
    if (!q) return [];
    const c = container<MetadataContainer>(await this.req("search", { query: q }));
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
          await this.req("library/all", { actor: person.id, type: types, ...page(offset, PAGE) }),
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

  /**
   * Turn a server-relative art path into a URL.
   *
   * Artwork arrives as a path like "/library/metadata/1/clearLogo/2". Handing
   * that to fetch resolves it against the APP's origin - the box's own shell -
   * which answers with its web page rather than a 404, so the failure is an
   * image that will not decode rather than an error anyone can see.
   */
  artUrl(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    return buildUrl(this.base, path.replace(/^\//, ""));
  }

  // ---- playback ---------------------------------------------------------

  /** Reads the same document the detail screen just fetched, not a second copy. */
  async markers(id: string): Promise<Marker[]> {
    return toMarkers(await this.metadata(id));
  }

  /**
   * Decide how to play an item, and hand back a URL the box's player can take.
   *
   * The server does the deciding - that is what `hasMDE` asks for - and answers
   * with `decision` on the chosen part: play the file as it is, repackage it, or
   * transcode. `directPlay=1` in the request is a preference, not the answer;
   * reading it back as one gets this exactly wrong.
   *
   * The screen resolution reported here is the PANEL's, not the window's. The UI
   * runs at 1080p while a 4K panel is attached and the output mode only changes
   * once video starts, so reporting what the window measures asks for a 1080p
   * transcode of a 4K file - decided before anything could have switched.
   */
  async resolveStream(
    id: string,
    opts: { session: string; panel?: { width: number; height: number } | null },
  ): Promise<StreamDecision> {
    const screen = opts.panel ? `${opts.panel.width}x${opts.panel.height}` : undefined;
    const common = {
      hasMDE: 1,
      path: `/library/metadata/${id}`,
      mediaIndex: 0,
      partIndex: 0,
      protocol: "hls",
      directPlay: 1,
      directStream: 1,
      fastSeek: 1,
      copyts: 1,
      // Not optional, and its absence is not a default. Asking for a media
      // decision while the server has auto-selected a subtitle for the item is
      // refused outright - measured, seven of the first twelve films on this
      // server, because a subtitle track is the ordinary case here. Naming a
      // setting avoids it; "none" is the one that matches handing the player
      // its own track choice.
      subtitles: "none",
      session: opts.session,
      "X-Plex-Client-Profile-Name": CLIENT_PROFILE,
      "X-Plex-Client-Profile-Extra": PROFILE_EXTRA,
      "X-Plex-Device-Screen-Resolution": screen,
    };

    await this.rememberSession(opts.session);

    const body = await this.req<unknown>("video/:/transcode/universal/decision", common);
    const c = container<MetadataContainer & { mdeDecisionCode?: number }>(body);
    const md = (c.Metadata ?? [])[0] as (PlexMetadata & { Media?: PlexMedia[] }) | undefined;
    const media = md?.Media?.[0];
    const part = media?.Part?.[0];

    const decision = part?.decision ?? "transcode";
    const burned = (media?.Part?.[0]?.Stream ?? []).some((s) => s.streamType === 3 && s.decision === "burn");

    if (decision === "directplay" && part?.key) {
      // The part key is used exactly as given: it carries a timestamp segment
      // between the id and the filename, and a reconstructed path without it is
      // a 404. The token has to be in the URL here because the player is a
      // separate process that cannot send headers.
      return {
        url: buildUrl(this.base, part.key.replace(/^\//, ""), { "X-Plex-Token": this.session.token }),
        audio: "auto",
        sub: burned ? "no" : "auto",
        subtitlesBurnedIn: burned,
        session: opts.session,
        location: this.session.location,
        transcoded: false,
      };
    }

    // Anything the server would not play as-is goes through its transcoder. An
    // unrecognised decision lands here too: treating an unknown answer as
    // "transcode" plays the film, treating it as direct play does not.
    return {
      url: buildUrl(this.base, "video/:/transcode/universal/start.m3u8", {
        ...common,
        directPlay: 0,
        offset: 0,
        "X-Plex-Token": this.session.token,
      }),
      audio: "auto",
      sub: burned ? "no" : "auto",
      subtitlesBurnedIn: burned,
      session: opts.session,
      location: this.session.location,
      transcoded: true,
    };
  }

  async trickplay(): Promise<TrickplayIndex | null> {
    return null;
  }

  async keepAlive(session: string): Promise<void> {
    await this.req("video/:/transcode/universal/ping", { session }).catch((e) => log.warn("keepalive failed", e));
  }

  async endSession(session: string): Promise<void> {
    await this.req("video/:/transcode/universal/stop", { session }).catch((e) => log.warn("stop failed", e));
    await this.forgetSession(session);
  }

  /**
   * Stop transcode sessions this client left behind.
   *
   * Needed because leaving the app produces no event the page can act on, and a
   * hidden window can be killed outright - measured, an abandoned session stays
   * open indefinitely and only an explicit stop clears it.
   *
   * Ownership cannot be read off the server. `/transcode/sessions` lists live
   * sessions with no client field at all, and the id under which one appears in
   * `/status/sessions` is the CLIENT identifier, not the transcode session -
   * stopping with that answers 404 and leaves the session running. So the ids we
   * mint are remembered locally and that list is what gets stopped here.
   */
  async reapOwnSessions(): Promise<number> {
    const remembered = (await readJson<string[]>(SESSIONS_KEY)) ?? [];
    if (remembered.length === 0) return 0;

    let live = new Set<string>();
    try {
      const c = container<{ TranscodeSession?: { key?: string }[] }>(await this.req("transcode/sessions"));
      live = new Set((c.TranscodeSession ?? []).map((s) => String(s.key ?? "").split("/").pop() ?? "").filter(Boolean));
    } catch (e) {
      // Without the list, stop everything remembered: a stop for a session that
      // already ended is a harmless 404, an unreaped session is not.
      log.warn("could not list sessions; stopping remembered ones blind", e);
      live = new Set(remembered);
    }

    let stopped = 0;
    for (const id of remembered) {
      if (!live.has(id)) continue;
      await this.endSession(id);
      stopped += 1;
    }
    await writeJson(SESSIONS_KEY, []);
    if (stopped) log.info(`stopped ${stopped} session(s) left behind by an earlier run`);
    return stopped;
  }

  /** Remember a session id so it can be stopped even if this window never gets
   *  the chance to do it itself. */
  private async rememberSession(id: string): Promise<void> {
    const current = (await readJson<string[]>(SESSIONS_KEY)) ?? [];
    if (current.includes(id)) return;
    // Bounded: a runaway would otherwise grow this without limit, and the store
    // is 256 KB for the whole app.
    await writeJson(SESSIONS_KEY, [...current.slice(-8), id]);
  }

  private async forgetSession(id: string): Promise<void> {
    const current = (await readJson<string[]>(SESSIONS_KEY)) ?? [];
    await writeJson(
      SESSIONS_KEY,
      current.filter((s) => s !== id),
    );
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
    const duration = Math.max(0, Math.round(durationMs));
    // Clamped to the duration, not just to zero. A player routinely reports a
    // position a few milliseconds past the end of the container at the end of a
    // file, and the server rejects that outright - which loses the very report
    // that marks a film finished.
    const time = duration > 0 ? Math.min(duration, Math.max(0, Math.round(positionMs))) : Math.max(0, Math.round(positionMs));

    await this.req(":/timeline", {
      ratingKey: id,
      key: `/library/metadata/${id}`,
      identifier: "com.plexapp.plugins.library",
      state,
      time,
      duration,
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
      await this.req("status/sessions/history/all", { sort: "viewedAt:desc", ...page(0, limit) }),
    );
    return (c.Metadata ?? []).map((m) => ({
      itemId: String(m.ratingKey ?? ""),
      title: m.title ?? "",
      viewedAt: m.viewedAt ?? 0,
      accountId: m.accountID !== undefined ? String(m.accountID) : undefined,
    }));
  }
}
